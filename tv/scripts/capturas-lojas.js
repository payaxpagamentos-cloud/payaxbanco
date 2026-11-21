'use strict';

/**
 * Capturas de tela para as lojas, tiradas do app rodando de verdade — sem moldura e sem
 * montagem: é a tela que o assinante vê.
 *
 *   node scripts/capturas-lojas.js https://play.seudominio.com.br
 *   ASSINANTE=cliente@provedor.com.br SENHA=... node scripts/capturas-lojas.js https://...
 *
 * Gera, em dist/lojas/, cada conjunto no tamanho que a loja exige:
 *   Google Play (celular)    1080 × 1920
 *   App Store (iPhone 6,9")  1320 × 2868
 *   App Store (iPad 13")     2064 × 2752
 *   Google Play (TV)         1920 × 1080
 *
 * Precisa do Playwright instalado (npm i -D playwright) e de um assinante com assinatura
 * ativa e catálogo publicado — a loja deve mostrar o que o assinante realmente encontra.
 */

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const BASE = String(process.argv[2] || process.env.BASE || '').replace(/\/+$/, '');
const EMAIL = process.env.ASSINANTE || 'rogerio@exemplo.com.br';
const SENHA = process.env.SENHA || 'cliente2026';
const SAIDA = path.join(__dirname, '..', 'dist', 'lojas');

if (!BASE || !/^https?:\/\//.test(BASE)) {
  console.error('Informe o endereço do servidor. Exemplo:\n  node scripts/capturas-lojas.js https://play.seudominio.com.br');
  process.exit(1);
}

const dormir = (ms) => new Promise((r) => { setTimeout(r, ms); });

const FORMATOS = [
  { nome: 'play-celular', largura: 360, altura: 640, escala: 3, tv: false },      // 1080 × 1920
  { nome: 'apple-iphone', largura: 440, altura: 956, escala: 3, tv: false },      // 1320 × 2868
  { nome: 'apple-ipad', largura: 1032, altura: 1376, escala: 2, tv: false },      // 2064 × 2752
  { nome: 'play-tv', largura: 1920, altura: 1080, escala: 1, tv: true },          // 1920 × 1080
];

async function entrar(pg, { tv }) {
  await pg.goto(`${BASE}/${tv ? '?tv=1' : ''}`, { waitUntil: 'networkidle' });
  await pg.fill('input[type=email]', EMAIL);
  await pg.fill('input[type=password]', SENHA);
  await pg.click('button[type=submit], button.primario');
  await dormir(3200);
  const perfil = pg.locator('.perfil-cartao, .perfis button').first();
  if (await perfil.count()) { await perfil.click(); await dormir(3000); }
}

async function capturar(nav, formato) {
  const pasta = path.join(SAIDA, formato.nome);
  fs.mkdirSync(pasta, { recursive: true });
  const ctx = await nav.newContext({
    viewport: { width: formato.largura, height: formato.altura },
    deviceScaleFactor: formato.escala,
    isMobile: !formato.tv && formato.largura < 700,
    hasTouch: !formato.tv,
  });
  const pg = await ctx.newPage();
  await entrar(pg, formato);

  const tirar = async (arquivo) => {
    await pg.screenshot({ path: path.join(pasta, `${arquivo}.png`) });
    console.log(`  ${formato.nome}/${arquivo}.png`);
  };

  // 1. Início, com o destaque
  await dormir(1500);
  await tirar('1-inicio');

  // 2. Canais ao vivo
  await pg.evaluate(() => { window.location.hash = '#/canais'; });
  await dormir(2600);
  await tirar('2-canais');

  // 3. Guia de programação
  await pg.evaluate(() => { window.location.hash = '#/guia'; });
  await dormir(2600);
  await tirar('3-guia');

  // 4. Catálogo de filmes
  await pg.evaluate(() => { window.location.hash = '#/filmes'; });
  await dormir(2600);
  await tirar('4-filmes');

  // 5. Ficha do título
  const cartaz = pg.locator('.cartaz').first();
  if (await cartaz.count()) {
    await cartaz.click();
    await dormir(2800);
    await tirar('5-ficha');
    await pg.keyboard.press('Escape');
    await dormir(1200);
  }

  // 6. Player com as qualidades abertas
  await pg.evaluate(() => { window.location.hash = '#/filmes'; });
  await dormir(2200);
  const outro = pg.locator('.cartaz').first();
  if (await outro.count()) {
    await outro.click();
    await dormir(2500);
    const assistir = pg.locator('button:has-text("Assistir"), button:has-text("Continuar")').first();
    if (await assistir.count()) {
      await assistir.click();
      await dormir(7000);
      await pg.mouse.move(formato.largura / 2, formato.altura / 2);
      await dormir(600);
      await tirar('6-player');
      const q = pg.locator('button[title="Qualidade"]').first();
      if (await q.count()) {
        await q.click();
        await dormir(1200);
        await tirar('7-qualidades');
      }
    }
  }

  await ctx.close();
}

(async () => {
  fs.mkdirSync(SAIDA, { recursive: true });
  const nav = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const f of FORMATOS) {
    console.log(`\n== ${f.nome} (${f.largura * f.escala} × ${f.altura * f.escala})`);
    await capturar(nav, f);
  }
  await nav.close();
  console.log(`\nPronto. As capturas estão em ${SAIDA}.`);
})().catch((err) => {
  console.error('Falhou:', err.message);
  process.exit(1);
});
