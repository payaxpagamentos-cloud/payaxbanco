'use strict';

/*
 * Demonstração em um único arquivo HTML (site institucional + Internet Banking + Banqueiro), para enviar por e-mail
 * ou WhatsApp e abrir com dois cliques, sem internet e sem hospedagem. Cada sistema roda num quadro (iframe srcdoc)
 * com scripts, fontes e imagens embutidos; os quadros compartilham o mesmo banco de demonstração (localStorage).
 * Gerado por demo/build.js a partir de dist-site/ e dist-demo/.
 */

const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const ler = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');
const dataUri = (arquivo, tipo) => `data:${tipo};base64,${fs.readFileSync(arquivo).toString('base64')}`;

/** Conteúdo seguro dentro de <script>...</script>. */
const emScript = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

function embutirFontes(html) {
  return html.replace(/url\((["']?)(?:\.\.\/)*fonts\/([\w.-]+\.woff2)\1\)/g, (_m, _q, nome) => `url("${dataUri(path.join(raiz, 'public/fonts', nome), 'font/woff2')}")`);
}

function embutirScript(html, nome, js) {
  const tag = `<script src="${nome}"></script>`;
  if (!html.includes(tag)) throw new Error(`Script não encontrado na página: ${nome}`);
  return html.replace(tag, () => `<script>${emScript(js)}</script>`);
}

function embutirIcone(html) {
  const icone = dataUri(path.join(raiz, 'public/favicon.svg'), 'image/svg+xml');
  return html.replace(/href="(?:\.\.\/)?favicon\.svg"/g, `href="${icone}"`);
}

/*
 * Páginas em srcdoc resolvem links relativos pelo endereço do arquivo (e não pelo da própria página): um link "#/contas"
 * recarregaria o arquivo dentro do quadro. Este trecho, colocado no início de cada página, troca a navegação desses
 * links por mudança de âncora. Roda depois dos tratadores da própria página (que podem ter cancelado o clique).
 */
const ADAPTADOR = `<script>window.addEventListener('click', function (e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  var a = e.target && e.target.closest && e.target.closest('a[href^="#"]');
  if (!a || a.target) return;
  e.preventDefault();
  var alvo = a.getAttribute('href');
  if (alvo === '#') return;
  if (location.hash === alvo) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = alvo;
});</script>`;
const comAdaptador = (html) => {
  if (!html.includes('<head>')) throw new Error('Página sem <head>.');
  return html.replace('<head>', () => `<head>\n${ADAPTADOR}`);
};

function gerar() {
  // Site institucional: o Internet Banking abre por cima, vindo do próprio arquivo.
  let site = ler('dist-site/index.html')
    .replace("<script>window.PAYAX_IB = 'ib/index.html';</script>", '<script>window.PAYAX_IB_CONTEUDO = (rota) => parent.PAYAX_ARQUIVO.ib(rota);</script>');
  site = comAdaptador(embutirIcone(embutirFontes(embutirScript(site, 'js/site.js', ler('dist-site/js/site.js')))));

  const ib = comAdaptador(embutirIcone(embutirFontes(embutirScript(ler('dist-site/ib/index.html'), 'banqueiro-ib.js', ler('dist-site/ib/banqueiro-ib.js')))));

  // Banqueiro: imagens da vitrine do login embutidas (só as usadas no formato cartão).
  const pasta = path.join(raiz, 'public/img/propagandas');
  const imagens = {};
  for (const nome of fs.readdirSync(pasta).filter((n) => /\.jpg$/.test(n) && !/-largo\.jpg$/.test(n))) {
    imagens[`propagandas/${nome}`] = dataUri(path.join(pasta, nome), 'image/jpeg');
  }
  let banqueiro = embutirScript(ler('dist-demo/index.html'), 'banqueiro-demo.js', ler('dist-demo/banqueiro-demo.js'));
  banqueiro = banqueiro.replace('<script>', () => `<script>window.PAYAX_IMAGENS = ${JSON.stringify(imagens)};</script>\n<script>`);
  banqueiro = comAdaptador(embutirIcone(embutirFontes(`<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n${banqueiro}`)));

  const apps = `window.PAYAX_ARQUIVO_APPS = ${emScript(JSON.stringify({ site, ib, banqueiro }))};`;
  const fonte = (nome) => dataUri(path.join(raiz, 'public/fonts', nome), 'font/woff2');
  const casca = ler('demo/pagina-arquivo-unico.html')
    .replace('/*FONTE_MANROPE*/', () => fonte('manrope.woff2'))
    .replace('/*FONTE_UNBOUNDED*/', () => fonte('unbounded.woff2'))
    .replace('/*ICONE*/', () => dataUri(path.join(raiz, 'public/favicon.svg'), 'image/svg+xml'))
    .replace('/*APPS*/', () => apps);
  const saida = path.join(raiz, 'dist-arquivo');
  fs.rmSync(saida, { recursive: true, force: true });
  fs.mkdirSync(saida, { recursive: true });
  const arquivo = path.join(saida, 'payax-demonstracao.html');
  fs.writeFileSync(arquivo, casca);
  return { arquivo, tamanho: fs.statSync(arquivo).size };
}

module.exports = { gerar };
