'use strict';

/* Gera a demonstração online (dist-demo/) com o backend empacotado para o navegador. */
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const raiz = path.join(__dirname, '..');
const saida = path.join(raiz, 'dist-demo');
const shim = (n) => path.join(__dirname, 'shims', n);

const substituir = {
  name: 'substituir-node',
  setup(b) {
    b.onResolve({ filter: /^(node:)?sqlite$/ }, () => ({ path: shim('sqlite.js') }));
    b.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: shim('crypto.js') }));
    b.onResolve({ filter: /^(node:)?(fs|path|https?)$/ }, () => ({ path: shim('vazio.js') }));
    b.onResolve({ filter: /^express$/ }, () => ({ path: shim('express.js') }));
    b.onResolve({ filter: /^\.\.?\/auth$/ }, (a) => (a.importer.includes(`${path.sep}server${path.sep}`) ? { path: shim('auth.js') } : undefined));
    b.onResolve({ filter: /(^|\/)lib\/senha$|^\.\/senha$/ }, (a) => (a.importer.includes(`${path.sep}server${path.sep}`) ? { path: shim('senha.js') } : undefined));
  },
};

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(path.join(saida, 'img'), { recursive: true });
fs.mkdirSync(path.join(saida, 'ib'), { recursive: true });

(async () => {
  const opcoes = {
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    charset: 'ascii',
    define: { 'process.env.NODE_ENV': '"test"', 'process.env': JSON.stringify({ NODE_ENV: 'test', PAYAX_SECRET: 'demo', PAYAX_DB: ':memory:' }) },
    plugins: [substituir],
    logLevel: 'warning',
  };
  await esbuild.build({ ...opcoes, entryPoints: [path.join(__dirname, 'entrada.js')], outfile: path.join(saida, 'banqueiro-demo.js') });
  await esbuild.build({ ...opcoes, entryPoints: [path.join(__dirname, 'entrada-ib.js')], outfile: path.join(saida, 'ib', 'banqueiro-ib.js') });

  // Escapa caracteres não ASCII que o esbuild mantém em template literals (o tag html usa as strings processadas).
  for (const bundle of [path.join(saida, 'banqueiro-demo.js'), path.join(saida, 'ib', 'banqueiro-ib.js')]) {
    fs.writeFileSync(bundle, fs.readFileSync(bundle, 'utf8').replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
  }

  const css = fs.readFileSync(path.join(raiz, 'public/css/style.css'), 'utf8');
  const pagina = fs.readFileSync(path.join(__dirname, 'pagina.html'), 'utf8').replace('/*CSS*/', () => css);
  fs.writeFileSync(path.join(saida, 'index.html'), pagina);
  const cssIb = css + fs.readFileSync(path.join(raiz, 'public/ib/ib.css'), 'utf8');
  fs.writeFileSync(path.join(saida, 'ib', 'index.html'), fs.readFileSync(path.join(__dirname, 'pagina-ib.html'), 'utf8').replace('/*CSS*/', () => cssIb));
  for (const f of fs.readdirSync(path.join(raiz, 'public/img'))) fs.copyFileSync(path.join(raiz, 'public/img', f), path.join(saida, 'img', f));
  fs.copyFileSync(path.join(raiz, 'public/favicon.svg'), path.join(saida, 'favicon.svg'));
  console.log('Demonstração gerada em dist-demo/');
})().catch((e) => { console.error(e); process.exit(1); });
