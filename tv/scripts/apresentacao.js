/**
 * Grava a navegação da PLAY TECH VIP em vídeo, sem voz — para mandar ao cliente.
 *
 *   npx playwright@1.48.2 install chromium     (uma vez, se o Playwright não estiver por perto)
 *   node scripts/apresentacao.js /tmp/gravacao
 *
 * Depois, junte com abertura e encerramento num MP4:
 *   ffmpeg -loop 1 -t 3 -i abertura.png -i app.webm -i painel.webm -loop 1 -t 4 -i fim.png \
 *     -filter_complex "[0:v]scale=1920:1080,fps=25,format=yuv420p,setsar=1[v0];[1:v]...[v1];
 *      [2:v]...[v2];[3:v]...[v3];[v0][v1][v2][v3]concat=n=4:v=1:a=0[v]" \
 *     -map "[v]" -c:v libx264 -crf 21 -movflags +faststart apresentacao.mp4
 *
 * O Playwright não grava o ponteiro do mouse: o cursor e as legendas são desenhados na página.
 * Cursor desenhado na página (o Playwright não grava o ponteiro de verdade) e legendas curtas.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const SAIDA = process.argv[2] || '/tmp/gravacao';
const BASE = 'http://localhost:3600';
fs.mkdirSync(SAIDA, { recursive: true });

const CURSOR = `
  (() => {
    const pont = document.createElement('div');
    pont.id = '__cursor';
    pont.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;border-radius:50%;' +
      'background:rgba(255,255,255,.92);box-shadow:0 0 0 2px rgba(0,0,0,.45),0 4px 14px rgba(0,0,0,.5);' +
      'z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);transition:width .12s,height .12s;';
    const leg = document.createElement('div');
    leg.id = '__legenda';
    leg.style.cssText = 'position:fixed;left:48px;bottom:48px;z-index:2147483646;pointer-events:none;' +
      'font:600 22px/1.3 Manrope,system-ui,sans-serif;color:#fff;background:rgba(10,10,10,.82);' +
      'border-left:4px solid #E50914;padding:12px 20px;border-radius:6px;opacity:0;transition:opacity .4s;' +
      'backdrop-filter:blur(6px);max-width:46vw;';
    const pronto = () => { document.body.append(pont, leg); };
    if (document.body) pronto(); else document.addEventListener('DOMContentLoaded', pronto);
    window.__moverCursor = (x, y) => { pont.style.left = x + 'px'; pont.style.top = y + 'px'; };
    window.__clicarCursor = () => {
      pont.style.width = '13px'; pont.style.height = '13px';
      setTimeout(() => { pont.style.width = '22px'; pont.style.height = '22px'; }, 140);
    };
    window.__legenda = (t) => { leg.textContent = t || ''; leg.style.opacity = t ? '1' : '0'; };
  })();
`;

const dormir = (ms) => new Promise((r) => { setTimeout(r, ms); });

function tela(pg) {
  let x = 960;
  let y = 540;
  const api = {
    async legenda(texto, espera = 0) {
      await pg.evaluate((t) => window.__legenda?.(t), texto).catch(() => {});
      if (espera) await dormir(espera);
    },
    /** Move o cursor desenhado em passos, como uma mão faria. */
    async mover(destinoX, destinoY, passos = 26) {
      const dx = (destinoX - x) / passos;
      const dy = (destinoY - y) / passos;
      for (let i = 0; i < passos; i += 1) {
        x += dx; y += dy;
        await pg.evaluate(([a, b]) => window.__moverCursor?.(a, b), [x, y]).catch(() => {});
        await dormir(14);
      }
      x = destinoX; y = destinoY;
      await pg.mouse.move(x, y).catch(() => {});
    },
    async apontar(alvo) {
      const el = typeof alvo === 'string' ? pg.locator(alvo).first() : alvo;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await dormir(300);
      const c = await el.boundingBox();
      if (!c) return null;
      await api.mover(Math.round(c.x + c.width / 2), Math.round(c.y + Math.min(c.height / 2, 40)));
      return el;
    },
    async clicar(alvo, espera = 1400) {
      const el = await api.apontar(alvo);
      if (!el) return;
      await pg.evaluate(() => window.__clicarCursor?.()).catch(() => {});
      await dormir(220);
      await el.click({ timeout: 15000 }).catch(() => {});
      await dormir(espera);
    },
    async digitar(seletor, texto) {
      const el = await api.apontar(seletor);
      if (!el) return;
      await pg.evaluate(() => window.__clicarCursor?.()).catch(() => {});
      await el.click().catch(() => {});
      for (const letra of texto) {
        await el.type(letra, { delay: 0 }).catch(() => {});
        await dormir(55);
      }
      await dormir(400);
    },
    async rolar(ate, duracao = 1400) {
      await pg.evaluate(([alvo, d]) => new Promise((pronto) => {
        const inicio = window.scrollY;
        const dist = alvo - inicio;
        const t0 = performance.now();
        const passo = (t) => {
          const p = Math.min(1, (t - t0) / d);
          const suave = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
          window.scrollTo(0, inicio + dist * suave);
          if (p < 1) requestAnimationFrame(passo); else pronto();
        };
        requestAnimationFrame(passo);
      }), [ate, duracao]);
      await dormir(400);
    },
    dormir,
  };
  return api;
}

async function entrar(pg, t, email, senha) {
  await t.legenda('Entrada do assinante', 1200);
  await t.digitar('input[type=email]', email);
  await t.digitar('input[type=password]', senha);
  await t.clicar('button[type=submit], button.primario', 3000);
  const perfil = pg.locator('.perfil-cartao, .perfis button').first();
  if (await perfil.count()) {
    await t.legenda('Perfis da casa, com classificação por idade', 900);
    await t.clicar(perfil, 3000);
  }
}

(async () => {
  const navegador = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ---------------------------------------------------- 1) App do assinante
  const ctxApp = await navegador.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: SAIDA, size: { width: 1920, height: 1080 } },
  });
  await ctxApp.addInitScript(CURSOR);
  const pg = await ctxApp.newPage();
  const t = tela(pg);

  await pg.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dormir(1500);
  await entrar(pg, t, 'rogerio@exemplo.com.br', 'cliente2026');

  await t.legenda('Início: destaque, fileiras e continuar assistindo', 2600);
  await t.rolar(700, 1600);
  await dormir(1200);
  await t.rolar(1500, 1600);
  await dormir(1400);
  await t.rolar(0, 1200);

  await t.legenda('', 200);
  await t.clicar('nav button:has-text("Filmes")', 1800);
  await t.legenda('Catálogo de filmes, com capas e fichas oficiais', 1200);
  await t.rolar(600, 1500);
  await dormir(1500);
  await t.rolar(0, 1000);

  await t.legenda('', 200);
  await t.clicar('.cartaz:has-text("Duna")', 2200);
  await t.legenda('Ficha do título: sinopse, elenco e direção', 1200);
  await dormir(2500);
  await t.rolar(400, 1200);
  await dormir(1500);
  await t.rolar(0, 900);

  await t.legenda('', 200);
  await t.clicar('button:has-text("Assistir")', 5000);
  await t.legenda('Reprodução em tela cheia', 1500);
  await pg.mouse.move(960, 900);
  await dormir(1200);
  await t.clicar('button[title="Qualidade"]', 1500);
  await t.legenda('Troca de qualidade: 4K, Full HD, HD e SD', 3200);
  await pg.keyboard.press('Escape');
  await dormir(600);
  await pg.keyboard.press('Escape');
  await dormir(2000);
  await t.legenda('', 300);

  await t.clicar('nav button:has-text("Séries")', 1800);
  await t.legenda('Séries, com temporadas e episódios', 2600);

  await t.legenda('', 200);
  await t.clicar('nav button:has-text("Canais ao vivo")', 1800);
  await t.legenda('Canais de TV ao vivo', 2200);
  await t.legenda('', 200);
  await t.clicar('.canal-cartao, .cartaz', 4000);
  await t.legenda('Ao vivo pelos nossos servidores', 4000);
  await pg.keyboard.press('Escape');
  await dormir(2000);
  await t.legenda('', 200);

  await t.legenda('', 200);
  await t.clicar('nav button:has-text("Guia")', 2000);
  await t.legenda('Guia de programação dos canais', 2600);

  await t.legenda('', 200);
  const avatar = pg.locator('.topo .acoes button, .avatar').last();
  if (await avatar.count()) {
    await t.clicar(avatar, 1200);
    const conta = pg.locator('button:has-text("Minha conta"), a:has-text("Minha conta")').first();
    if (await conta.count()) await t.clicar(conta, 2200);
  }
  await t.legenda('Minha conta: plano, telas e faturas', 1200);
  await t.rolar(600, 1400);
  await dormir(1800);
  await t.legenda('', 300);
  await dormir(800);

  await ctxApp.close();

  // ---------------------------------------------------- 2) Painel da operação
  const ctxAdmin = await navegador.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: SAIDA, size: { width: 1920, height: 1080 } },
  });
  await ctxAdmin.addInitScript(CURSOR);
  const ad = await ctxAdmin.newPage();
  const ta = tela(ad);

  await ad.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await dormir(1200);
  await ta.legenda('Painel da operação', 1000);
  await ta.digitar('input[type=email]', 'admin@playtechvip.com.br');
  await ta.digitar('input[type=password]', 'admin123');
  await ta.clicar('button[type=submit], button.primario', 3500);

  const telas = [
    ['Painel', 'Visão do dia: audiência, assinantes e receita', 3200],
    ['Canais', 'Canais com o logo oficial de cada emissora', 3400],
    ['Grade (EPG)', 'Grade de programação por canal', 3000],
    ['Catálogo', 'Catálogo: publicar, despublicar e editar', 3400],
    ['Assinantes', 'Assinantes, planos e situação de cada um', 3000],
    ['Faturas', 'Faturas com PIX e baixa de pagamento', 3000],
    ['Relatórios', 'Relatórios de audiência e receita', 3600],
    ['Auditoria', 'Auditoria: tudo que a equipe faz fica registrado', 2800],
  ];
  for (const [nome, legenda, espera] of telas) {
    await ta.legenda('', 150);
    await ta.clicar(`nav.menu button:has-text("${nome}")`, 1200);
    await ta.legenda(legenda, espera - 1200);
    if (nome === 'Relatórios') { await ta.rolar(600, 1500); await dormir(2000); await ta.rolar(0, 900); }
  }

  await ta.legenda('', 200);
  await ta.clicar('nav.menu button:has-text("Catálogo")', 1800);
  await ta.clicar('tr:has-text("Wing It!") button:has-text("Abrir")', 2200);
  await ta.clicar('button:has-text("Arquivos")', 1800);
  await ta.rolar(900, 1600);
  await ta.legenda('Um arquivo enviado vira 4K, Full HD, HD e SD', 4000);
  await ta.legenda('', 400);
  await dormir(1000);

  await ctxAdmin.close();
  await navegador.close();

  const videos = fs.readdirSync(SAIDA).filter((n) => n.endsWith('.webm')).sort();
  console.log('gravações:', videos.map((n) => `${n} (${(fs.statSync(path.join(SAIDA, n)).size / 1048576).toFixed(1)} MB)`).join(' · '));
})();
