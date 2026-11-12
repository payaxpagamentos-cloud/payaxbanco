'use strict';

/**
 * Gera a apresentação do sistema em PDF, com as telas capturadas do sistema rodando de verdade —
 * assim ela nunca fica desatualizada em relação ao produto.
 *
 *   npm run seed && npm start          (noutro terminal, com os dados de demonstração)
 *   npm run apresentacao               (gera apresentacao/Mercado-Binho-apresentacao.pdf)
 *
 * Precisa do Chromium do Playwright instalado na máquina (npx playwright install chromium)
 * e do sistema no ar em http://localhost:3300.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const RAIZ = __dirname;
const IMG = path.join(RAIZ, 'img');
const BASE = process.env.APRESENTACAO_BASE || 'http://localhost:3300';
const PORTA_PONTE = 9399;
const PORTA_ARQUIVOS = 8899;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(caminho, { metodo = 'GET', corpo, token } = {}) {
  const resp = await fetch(`${BASE}/api${caminho}`, {
    method: metodo,
    headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (!resp.ok) throw new Error(`${caminho}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

/** Servidor de arquivos para o Chromium abrir o HTML com as fontes e as imagens. */
function servirPasta(pasta, porta) {
  const tipos = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
  const servidor = http.createServer((req, res) => {
    const arquivo = path.join(pasta, decodeURIComponent(req.url.split('?')[0]));
    if (!arquivo.startsWith(pasta) || !fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': tipos[path.extname(arquivo)] ?? 'application/octet-stream' });
    fs.createReadStream(arquivo).pipe(res);
  });
  return new Promise((resolve) => servidor.listen(porta, () => resolve(servidor)));
}

/** Reduz a captura: o PDF não precisa de imagem de retina, e o arquivo fica leve. */
async function guardarTela(alvo, nome, { largura = 1500 } = {}) {
  const bruto = path.join(IMG, `${nome}.png`);
  await alvo.screenshot({ path: bruto });
  const { chromium } = require('playwright');
  // reduz com o próprio navegador, para não depender de biblioteca de imagem
  const navegador = guardarTela.navegador;
  const pagina = await navegador.newPage();
  const dados = fs.readFileSync(bruto).toString('base64');
  await pagina.setContent(`<img id="i" src="data:image/png;base64,${dados}">`);
  const jpeg = await pagina.evaluate(async (larg) => {
    const img = document.getElementById('i');
    await img.decode();
    const tela = document.createElement('canvas');
    tela.width = larg;
    tela.height = Math.round((img.naturalHeight * larg) / img.naturalWidth);
    tela.getContext('2d').drawImage(img, 0, 0, tela.width, tela.height);
    return tela.toDataURL('image/jpeg', 0.84);
  }, largura);
  await pagina.close();
  fs.writeFileSync(path.join(IMG, `${nome}.jpg`), Buffer.from(jpeg.split(',')[1], 'base64'));
  fs.unlinkSync(bruto);
}

(async () => {
  const { chromium } = require('playwright');
  fs.rmSync(IMG, { recursive: true, force: true });
  fs.mkdirSync(IMG, { recursive: true });
  for (const arquivo of ['binho-logo.png', 'binho-simbolo.png']) {
    fs.copyFileSync(path.join(RAIZ, '..', 'public', 'img', arquivo), path.join(IMG, arquivo));
  }
  fs.mkdirSync(path.join(RAIZ, 'fontes'), { recursive: true });
  for (const fonte of ['manrope.woff2', 'unbounded.woff2']) {
    fs.copyFileSync(path.join(RAIZ, '..', 'public', 'fonts', fonte), path.join(RAIZ, 'fontes', fonte));
  }

  await api('/saude').catch(() => { throw new Error(`O sistema precisa estar no ar em ${BASE} (npm start).`); });
  const { token } = await api('/auth/login', { metodo: 'POST', corpo: { email: 'gerente@mercadinho.com.br', senha: 'demo12345' } });

  // Maquininha de balcão falsa, só para a tela de "passe o cartão" aparecer parada na captura.
  const ponte = spawn(process.execPath, [path.join(RAIZ, '..', 'scripts', 'ponte-maquininha.js')], { env: { ...process.env, PORTA: String(PORTA_PONTE) }, stdio: 'ignore' });
  await esperar(900);
  const maquininha = await api('/admin/maquininhas', { metodo: 'POST', token, corpo: { nome: 'Pinpad da apresentação', provedor: 'ponte', url: `http://127.0.0.1:${PORTA_PONTE}` } });
  const simuladas = (await api('/admin/maquininhas', { token })).filter((m) => m.provedor === 'simulado' && m.ativa);
  for (const m of simuladas) await api(`/admin/maquininhas/${m.id}`, { metodo: 'PATCH', token, corpo: { ativa: false } });
  const { codigo } = await api('/admin/terminais', { metodo: 'POST', token, corpo: { nome: 'Balcão do mercadinho' } });

  const navegador = await chromium.launch();
  guardarTela.navegador = navegador;

  /* ---- terminal do cliente ---- */
  const ctxT = await navegador.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  const t = await ctxT.newPage();
  const bipar = async (codigoBarras) => {
    for (const tecla of codigoBarras) await t.keyboard.press(tecla);
    await t.keyboard.press('Enter');
    await esperar(800);
  };
  await t.goto(`${BASE}/pdv/`, { waitUntil: 'networkidle' });
  await t.fill('input[name=codigo]', codigo);
  await t.click('button.primario');
  await esperar(1600);
  await guardarTela(t, '02-terminal-espera');
  await bipar('7891000053508');
  await bipar('7894900011517');
  await bipar('7891000315729');
  await guardarTela(t, '03-terminal-carrinho');
  await t.click('button:has-text("Produto sem código")');
  await esperar(1100);
  await guardarTela(t, '04-terminal-vitrine');
  await t.locator('.cartao-produto:has-text("Banana")').first().click();
  await esperar(700);
  for (const n of ['1', ',', '2']) await t.click(`.teclado-numerico button:text-is("${n}")`);
  await t.click('button:has-text("Confirmar")');
  await esperar(1100);
  await t.click('button:has-text("Pagar")');
  await esperar(800);
  await guardarTela(t, '06-terminal-pagamento');
  await t.click('.opcao-pagamento:has-text("PIX")');
  await t.waitForSelector('img.qr', { timeout: 9000 });
  await esperar(400);
  await guardarTela(t, '07-terminal-pix');
  await t.click('button:has-text("Escolher outra forma")');
  await esperar(600);
  await t.click('.opcao-pagamento:has-text("débito")');
  await esperar(2500);
  await guardarTela(t, '08-terminal-cartao');
  await t.waitForSelector('.selo-ok', { timeout: 20_000 });
  await guardarTela(t, '09-terminal-fim');

  /* ---- painel da equipe ---- */
  const ctxA = await navegador.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 });
  const a = await ctxA.newPage();
  await a.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await a.fill('input[name=email]', 'gerente@mercadinho.com.br');
  await a.fill('input[name=senha]', 'demo12345');
  await a.click('button.primario');
  await a.waitForSelector('.menu');
  await esperar(1600);
  const telaPainel = async (rota, nome, aba = null, espera = 1800) => {
    await a.goto(`${BASE}/#/${rota}`);
    await esperar(espera);
    if (aba) {
      await a.click(`.abas button:has-text("${aba}")`);
      await esperar(1400);
    }
    await guardarTela(a, nome);
  };
  await telaPainel('estoque', '16-painel-estoque');
  await telaPainel('compras', '18-painel-sugestao-compra', 'Sugestão');
  await telaPainel('financeiro', '20-painel-financeiro');
  await telaPainel('financeiro', '21-painel-dre', 'DRE do mês');
  await telaPainel('moradores', '19-painel-moradores');
  await telaPainel('relatorios', '22-painel-relatorios', null, 2300);

  await navegador.close();
  ponte.kill();

  /* ---- monta o PDF ---- */
  const navegador2 = await chromium.launch();
  const servidor = await servirPasta(RAIZ, PORTA_ARQUIVOS);
  const pagina = await navegador2.newPage({ viewport: { width: 1280, height: 720 } });
  const problemas = [];
  pagina.on('requestfailed', (r) => problemas.push(r.url()));
  await pagina.goto(`http://localhost:${PORTA_ARQUIVOS}/index.html`, { waitUntil: 'networkidle' });
  await pagina.evaluate(() => document.fonts.ready);
  await esperar(700);
  const saida = path.join(RAIZ, 'Mercado-Binho-apresentacao.pdf');
  await pagina.pdf({ path: saida, preferCSSPageSize: true, printBackground: true });
  const paginas = await pagina.locator('.slide').count();
  await navegador2.close();
  servidor.close();

  if (problemas.length) console.error(`Não carregou: ${problemas.join(', ')}`);
  console.log(`[Mercadinho] ${paginas} slides · ${(fs.statSync(saida).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Apresentação: ${saida}`);
})().catch((err) => {
  console.error(`Não deu para gerar: ${err.message}`);
  process.exit(1);
});
