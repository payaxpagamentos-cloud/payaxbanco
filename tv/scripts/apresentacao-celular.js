/**
 * Apresentação vertical (celular) da PLAY TECH VIP, sem voz.
 *
 *   node scripts/apresentacao-celular.js /tmp/gravacao
 *
 * Grava o app no layout e na resolução de um celular (390x844 em 3x = 1170x2532), que é o
 * que o cliente vai abrir no telefone dele. Duas armadilhas que custaram caro aqui:
 *
 *  - o `deviceScaleFactor` do contexto NÃO muda o que o Playwright grava; quem muda é o
 *    `--force-device-scale-factor` do navegador;
 *  - `recordVideo.size` precisa bater com viewport x escala, senão a página fica num canto
 *    do quadro, com o resto preto.
 *
 * Depois, junte com abertura e encerramento num MP4 de 1080x2340 (ffmpeg scale + concat).
 */
const { chromium } = require('playwright');
const fs = require('node:fs');

const SAIDA = process.argv[2] || '/tmp/vertical';
const BASE = 'http://localhost:3600';
fs.mkdirSync(SAIDA, { recursive: true });

const CURSOR = `
  (() => {
    const pont = document.createElement('div');
    pont.style.cssText = 'position:fixed;left:0;top:0;width:12px;height:12px;border-radius:50%;' +
      'background:rgba(255,255,255,.95);box-shadow:0 0 0 2px rgba(0,0,0,.5),0 3px 10px rgba(0,0,0,.6);' +
      'z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);transition:width .12s,height .12s;';
    const leg = document.createElement('div');
    leg.style.cssText = 'position:fixed;left:14px;right:14px;bottom:74px;z-index:2147483646;pointer-events:none;' +
      'font:700 14px/1.35 Manrope,system-ui,sans-serif;color:#fff;background:rgba(8,8,8,.9);' +
      'border-left:3px solid #E50914;padding:9px 13px;border-radius:5px;opacity:0;transition:opacity .35s;text-align:left;';
    const pronto = () => document.body.append(pont, leg);
    if (document.body) pronto(); else document.addEventListener('DOMContentLoaded', pronto);
    window.__moverCursor = (x, y) => { pont.style.left = x + 'px'; pont.style.top = y + 'px'; };
    window.__clicarCursor = () => {
      pont.style.width = '8px'; pont.style.height = '8px';
      setTimeout(() => { pont.style.width = '12px'; pont.style.height = '12px'; }, 140);
    };
    window.__legenda = (t) => { leg.textContent = t || ''; leg.style.opacity = t ? '1' : '0'; };
  })();
`;

const dormir = (ms) => new Promise((r) => { setTimeout(r, ms); });

function tela(pg) {
  let x = 195;
  let y = 420;
  const api = {
    async legenda(texto, espera = 0) {
      await pg.evaluate((t) => window.__legenda?.(t), texto).catch(() => {});
      if (espera) await dormir(espera);
    },
    async mover(dx, dy, passos = 20) {
      const px = (dx - x) / passos;
      const py = (dy - y) / passos;
      for (let i = 0; i < passos; i += 1) {
        x += px; y += py;
        await pg.evaluate(([a, b]) => window.__moverCursor?.(a, b), [x, y]).catch(() => {});
        await dormir(16);
      }
      x = dx; y = dy;
      await pg.mouse.move(x, y).catch(() => {});
    },
    async clicar(alvo, espera = 1400) {
      const el = typeof alvo === 'string' ? pg.locator(alvo).first() : alvo;
      try {
        await el.waitFor({ state: 'visible', timeout: 8000 });
      } catch {
        console.log('pulou (não apareceu):', String(alvo).slice(0, 50));
        return;
      }
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await dormir(300);
      const c = await el.boundingBox().catch(() => null);
      if (!c) return;
      await api.mover(Math.round(c.x + c.width / 2), Math.round(c.y + Math.min(c.height / 2, 30)));
      await pg.evaluate(() => window.__clicarCursor?.()).catch(() => {});
      await dormir(200);
      await el.click({ timeout: 15000 }).catch(() => {});
      await dormir(espera);
    },
    async digitar(seletor, texto) {
      const el = pg.locator(seletor).first();
      const c = await el.boundingBox();
      if (c) await api.mover(Math.round(c.x + c.width / 2), Math.round(c.y + c.height / 2));
      await pg.evaluate(() => window.__clicarCursor?.()).catch(() => {});
      await el.click().catch(() => {});
      for (const letra of texto) { await el.type(letra, { delay: 0 }).catch(() => {}); await dormir(50); }
      await dormir(350);
    },
    async rolar(ate, duracao = 1300) {
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
      await dormir(350);
    },
  };
  return api;
}

(async () => {
  // --force-device-scale-factor é o que faz a gravação sair na resolução do celular:
  // o deviceScaleFactor do contexto sozinho não muda o que o Playwright grava.
  const navegador = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=3'] });
  const ctx = await navegador.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    recordVideo: { dir: SAIDA, size: { width: 1170, height: 2532 } },
  });
  await ctx.addInitScript(CURSOR);
  const pg = await ctx.newPage();
  const t = tela(pg);

  await pg.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dormir(1600);
  await t.legenda('Entrada do assinante', 1200);
  await t.digitar('input[type=email]', 'rogerio@exemplo.com.br');
  await t.digitar('input[type=password]', 'cliente2026');
  await t.clicar('button[type=submit], button.primario', 2800);
  const perfil = pg.locator('.perfil-cartao, .perfis button').first();
  if (await perfil.count()) {
    await t.legenda('Perfis da casa, com classificação por idade', 1200);
    await t.clicar(perfil, 3000);
  }
  await t.legenda('Início: destaque e fileiras', 2400);
  await t.rolar(600, 1400);
  await dormir(1200);
  await t.rolar(1300, 1400);
  await dormir(1400);
  await t.rolar(0, 1100);
  await t.legenda('', 200);

  // ---- Canais ao vivo (o coração da apresentação)
  await t.clicar('nav button:has-text("Canais ao vivo")', 2200);
  await t.legenda('Canais ao vivo, com logo e programa no ar', 3000);
  await t.rolar(500, 1300);
  await dormir(1800);
  await t.rolar(1100, 1300);
  await dormir(1800);
  await t.rolar(0, 1100);
  await t.legenda('', 200);
  await t.clicar('.canal-cartao:has-text("TV Globo"), .canal-cartao', 4500);
  await t.legenda('Ao vivo pelos nossos servidores (sinal de demonstração)', 3500);
  await pg.keyboard.press('Escape');
  await dormir(2000);
  await t.legenda('', 200);

  await t.clicar('nav button:has-text("Guia")', 2200);
  await t.legenda('Guia de programação de todos os canais', 3200);
  await t.rolar(500, 1300);
  await dormir(1800);
  await t.rolar(0, 1000);
  await t.legenda('', 200);

  // ---- Catálogo
  await t.clicar('nav button:has-text("Filmes")', 2000);
  await t.legenda('Catálogo de filmes', 2400);
  await t.rolar(700, 1400);
  await dormir(1600);
  await t.rolar(0, 1000);
  await t.legenda('', 200);
  await t.clicar('.cartaz:has-text("Duna") .nome', 2600);
  await t.legenda('Ficha completa: sinopse, elenco e qualidade', 3000);
  await t.rolar(400, 1200);
  await dormir(1600);
  await t.rolar(0, 900);
  await pg.keyboard.press('Escape');
  await dormir(1200);
  await t.legenda('', 200);

  await dormir(800);
  await t.clicar('.cartaz:has-text("Agente 327") .nome', 2600);
  await t.legenda('Produção própria, em 4K', 1800);
  await t.legenda('', 200);
  await t.clicar('button:has-text("Assistir"), button:has-text("Continuar")', 5000);
  await t.legenda('Reprodução em tela cheia', 2000);
  await pg.mouse.move(195, 760);
  await dormir(800);
  await t.clicar('button[title="Qualidade"]', 1500);
  await t.legenda('4K, Full HD, HD e SD', 3000);
  await pg.keyboard.press('Escape');
  await dormir(600);
  await pg.keyboard.press('Escape');
  await dormir(2000);
  await t.legenda('', 200);

  await t.clicar('nav button:has-text("Séries")', 2000);
  await t.legenda('Séries, com temporadas e episódios', 2600);
  await t.legenda('', 300);
  await dormir(800);

  await ctx.close();
  await navegador.close();
  const videos = fs.readdirSync(SAIDA).filter((n) => n.endsWith('.webm'));
  console.log('gravação:', videos.join(', '));
})();
