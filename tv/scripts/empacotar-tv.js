'use strict';

/**
 * Monta os apps de TV da Samsung e da LG com a interface **dentro do aparelho**.
 *
 * É esse empacotamento que deixa o app usar o player nativo da TV: na Samsung, o AVPlay só
 * responde quando a página roda local, com o webapis.js do sistema carregado.
 *
 * Uso:
 *   node scripts/empacotar-tv.js https://seu-dominio/tv
 *
 * Depois, com as ferramentas de cada fabricante:
 *   Samsung: tizen build-web -- tv-apps/samsung-tizen/dist && tizen package -t wgt -s <perfil> -- tv-apps/samsung-tizen/dist/.buildResult
 *   LG:      ares-package tv-apps/lg-webos/dist
 */

const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const servidor = String(process.argv[2] || '').replace(/\/+$/, '');

if (!servidor || !/^https?:\/\//.test(servidor)) {
  console.error('Informe o endereço do servidor. Exemplo:\n  node scripts/empacotar-tv.js https://seu-dominio/tv');
  process.exit(1);
}
if (servidor.startsWith('http://')) {
  console.warn('Atenção: as Smart TVs bloqueiam conteúdo sem HTTPS. Use https em produção.');
}

/** Copia a interface do assinante (sem o painel da operação, que não vai para a TV). */
function copiarInterface(destino) {
  fs.rmSync(destino, { recursive: true, force: true });
  fs.mkdirSync(destino, { recursive: true });
  for (const item of ['index.html', 'css', 'js', 'img', 'fonts']) {
    fs.cpSync(path.join(raiz, 'public', item), path.join(destino, item), { recursive: true });
  }
  // hls.js entra junto: na TV não dá para buscar de CDN.
  const hls = path.join(path.dirname(require.resolve('hls.js/package.json')), 'dist');
  fs.mkdirSync(path.join(destino, 'vendor', 'hls'), { recursive: true });
  for (const arquivo of ['hls.mjs', 'hls.min.js']) {
    fs.copyFileSync(path.join(hls, arquivo), path.join(destino, 'vendor', 'hls', arquivo));
  }
}

/** Escreve o config.js e pendura os scripts certos no index.html. */
function ajustarPagina(destino, { comWebapis }) {
  fs.writeFileSync(path.join(destino, 'config.js'),
    `/* Endereço do servidor da PLAY TV (gerado por scripts/empacotar-tv.js). */\nwindow.PLAYTV_API = '${servidor}';\n`);

  const pagina = path.join(destino, 'index.html');
  let html = fs.readFileSync(pagina, 'utf8');
  const antes = [
    comWebapis ? '  <script src="$WEBAPIS/webapis/webapis.js"></script>' : null,
    '  <script src="config.js"></script>',
  ].filter(Boolean).join('\n');
  html = html.replace('  <script type="module" src="js/app.js"></script>', `${antes}\n  <script type="module" src="js/app.js"></script>`);
  // Na TV o app já entra em modo TV, sem depender do reconhecimento pelo user agent.
  html = html.replace('<body>', '<body>\n  <script>try { localStorage.setItem("playtv.modo", "tv"); } catch (e) {}</script>');
  fs.writeFileSync(pagina, html);
}

const apps = [
  { nome: 'Samsung (Tizen)', pasta: path.join(raiz, 'tv-apps', 'samsung-tizen'), comWebapis: true, extras: ['config.xml', 'icon.png'] },
  { nome: 'LG (webOS)', pasta: path.join(raiz, 'tv-apps', 'lg-webos'), comWebapis: false, extras: ['appinfo.json', 'icon.png', 'largeIcon.png'] },
];

for (const app of apps) {
  const destino = path.join(app.pasta, 'dist');
  copiarInterface(destino);
  ajustarPagina(destino, { comWebapis: app.comWebapis });
  for (const extra of app.extras) fs.copyFileSync(path.join(app.pasta, extra), path.join(destino, extra));
  const arquivos = fs.readdirSync(destino).length;
  console.log(`${app.nome}: ${path.relative(raiz, destino)} pronto (${arquivos} itens na raiz do pacote)`);
}

console.log(`\nServidor configurado: ${servidor}`);
console.log('Agora empacote com as ferramentas de cada fabricante:');
console.log('  Samsung: tizen build-web -- tv-apps/samsung-tizen/dist');
console.log('           tizen package -t wgt -s <seu-perfil> -- tv-apps/samsung-tizen/dist/.buildResult');
console.log('  LG:      ares-package tv-apps/lg-webos/dist');
console.log('\nO app da TCL/Android TV não usa este empacotador: abra tv-apps/android-tv no Android Studio.');
