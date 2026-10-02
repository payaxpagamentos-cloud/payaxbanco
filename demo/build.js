'use strict';

/* Gera a demonstração online (dist-demo/) com o backend empacotado para o navegador. */
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const raiz = path.join(__dirname, '..');
const saida = path.join(raiz, 'dist-demo');
const saidaIb = path.join(raiz, 'dist-ib'); // publicação só do Internet Banking (link direto para clientes testarem)
const saidaSite = path.join(raiz, 'dist-site'); // site institucional com o Internet Banking por cima (ib/)
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
fs.rmSync(saidaIb, { recursive: true, force: true });
fs.rmSync(saidaSite, { recursive: true, force: true });
fs.mkdirSync(path.join(saidaSite, 'ib'), { recursive: true });
fs.mkdirSync(path.join(saidaSite, 'js'), { recursive: true });
fs.mkdirSync(path.join(saidaIb, 'img'), { recursive: true });
fs.mkdirSync(path.join(saida, 'img'), { recursive: true });
fs.mkdirSync(path.join(saida, 'ib'), { recursive: true });

/**
 * Fotografia do código para o monitoramento de segurança da demonstração (o navegador não lê os arquivos):
 * "atual" é o código deste build; "anterior" é a versão anterior no git. A demonstração começa com a
 * versão anterior aprovada, então a primeira verificação mostra o que mudou na última atualização.
 */
function gerarManifestoIntegridade() {
  const { execFileSync } = require('node:child_process');
  const crypto = require('node:crypto');
  const { listarArquivos, PASTAS, ARQUIVOS, TEXTO } = require('../server/lib/integridade-fs');
  const atual = listarArquivos(raiz);
  let anterior = atual.map((f) => ({ ...f }));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: raiz, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const sujo = git('status', '--porcelain', '--', ...PASTAS, ...ARQUIVOS).trim() !== '';
    const rev = sujo ? 'HEAD' : 'HEAD~1';
    const caminhos = git('ls-tree', '-r', '--name-only', rev, '--', ...PASTAS, ...ARQUIVOS).split('\n').filter(Boolean);
    anterior = caminhos.map((c) => {
      const buf = execFileSync('git', ['show', `${rev}:${c}`], { cwd: raiz, maxBuffer: 64 * 1024 * 1024 });
      return { caminho: c, hash: crypto.createHash('sha256').update(buf).digest('hex'), tamanho: buf.length, conteudo: TEXTO.test(c) && buf.length <= 400 * 1024 ? buf.toString('utf8') : null };
    });
  } catch { /* sem git: a demonstração começa sem alterações */ }
  // Conteúdo só dos arquivos que mudaram (para mostrar as linhas); os demais vão só com a impressão digital.
  const mapaAnt = new Map(anterior.map((f) => [f.caminho, f]));
  const mapaAt = new Map(atual.map((f) => [f.caminho, f]));
  const mudou = (c) => mapaAnt.get(c)?.hash !== mapaAt.get(c)?.hash;
  const enxugar = (lista) => lista.map((f) => ({ caminho: f.caminho, hash: f.hash, tamanho: f.tamanho, conteudo: mudou(f.caminho) ? f.conteudo : null }));
  fs.mkdirSync(path.join(__dirname, 'gerado'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'gerado', 'integridade.json'), JSON.stringify({ gerado_em: new Date().toISOString(), atual: enxugar(atual), anterior: enxugar(anterior) }));
}

(async () => {
  gerarManifestoIntegridade();
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
  await esbuild.build({ ...opcoes, entryPoints: [path.join(__dirname, 'entrada-ib-publico.js')], outfile: path.join(saidaIb, 'banqueiro-ib.js') });
  await esbuild.build({ ...opcoes, entryPoints: [path.join(__dirname, 'entrada-site-ib.js')], outfile: path.join(saidaSite, 'ib', 'banqueiro-ib.js') });

  // Escapa caracteres não ASCII que o esbuild mantém em template literals (o tag html usa as strings processadas).
  for (const bundle of [path.join(saida, 'banqueiro-demo.js'), path.join(saida, 'ib', 'banqueiro-ib.js'), path.join(saidaIb, 'banqueiro-ib.js'), path.join(saidaSite, 'ib', 'banqueiro-ib.js')]) {
    fs.writeFileSync(bundle, fs.readFileSync(bundle, 'utf8').replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
  }

  const css = fs.readFileSync(path.join(raiz, 'public/css/style.css'), 'utf8');
  const cssTema = fs.readFileSync(path.join(raiz, 'public/css/tema.css'), 'utf8');
  // O Banqueiro fica na raiz do dist-demo/: as fontes ficam em fonts/ (e não em ../fonts/).
  const pagina = fs.readFileSync(path.join(__dirname, 'pagina.html'), 'utf8').replace('/*CSS*/', () => (css + cssTema).replaceAll('../fonts/', 'fonts/'));
  fs.writeFileSync(path.join(saida, 'index.html'), pagina);
  const cssSite = fs.readFileSync(path.join(raiz, 'public/css/site.css'), 'utf8');
  const cssIb = css + cssSite + fs.readFileSync(path.join(raiz, 'public/ib/ib.css'), 'utf8') + cssTema;
  fs.writeFileSync(path.join(saida, 'ib', 'index.html'), fs.readFileSync(path.join(__dirname, 'pagina-ib.html'), 'utf8').replace('/*CSS*/', () => cssIb));
  fs.cpSync(path.join(raiz, 'public/img'), path.join(saida, 'img'), { recursive: true });
  fs.copyFileSync(path.join(raiz, 'public/favicon.svg'), path.join(saida, 'favicon.svg'));
  // No dist-ib/ a página fica na raiz: as fontes ficam em fonts/ (e não em ../fonts/).
  const paginaIb = fs.readFileSync(path.join(__dirname, 'pagina-ib.html'), 'utf8').replace('/*CSS*/', () => cssIb.replaceAll('../fonts/', 'fonts/')).replace('href="../favicon.svg"', 'href="favicon.svg"');
  fs.writeFileSync(path.join(saidaIb, 'index.html'), paginaIb);
  fs.cpSync(path.join(raiz, 'public/img'), path.join(saidaIb, 'img'), { recursive: true });
  fs.cpSync(path.join(raiz, 'public/fonts'), path.join(saidaIb, 'fonts'), { recursive: true });
  fs.cpSync(path.join(raiz, 'public/fonts'), path.join(saida, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(raiz, 'public/favicon.svg'), path.join(saidaIb, 'favicon.svg'));
  // Site institucional: página principal do dist-site/, com o Internet Banking em ib/.
  const paginaSite = fs.readFileSync(path.join(raiz, 'public/site/index.html'), 'utf8')
    .replaceAll('../fonts/', 'fonts/').replace('href="../favicon.svg"', 'href="favicon.svg"')
    .replace('<script src="js/site.js"></script>', '<script>window.PAYAX_IB = \'ib/index.html\';</script>\n<script src="js/site.js"></script>');
  fs.writeFileSync(path.join(saidaSite, 'index.html'), paginaSite);
  fs.copyFileSync(path.join(raiz, 'public/site/js/site.js'), path.join(saidaSite, 'js', 'site.js'));
  fs.writeFileSync(path.join(saidaSite, 'ib', 'index.html'), fs.readFileSync(path.join(__dirname, 'pagina-ib.html'), 'utf8').replace('/*CSS*/', () => cssIb));
  fs.cpSync(path.join(raiz, 'public/fonts'), path.join(saidaSite, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(raiz, 'public/favicon.svg'), path.join(saidaSite, 'favicon.svg'));
  // Pacote para hospedar em qualquer servidor de arquivos (ex.: Netlify, Cloudflare Pages, S3): site + Internet Banking na raiz
  // e o Banqueiro em banqueiro/. Páginas marcadas para não aparecer em buscadores.
  const saidaPacote = path.join(raiz, 'dist-apresentacao');
  fs.rmSync(saidaPacote, { recursive: true, force: true });
  fs.cpSync(saidaSite, saidaPacote, { recursive: true });
  fs.cpSync(saida, path.join(saidaPacote, 'banqueiro'), { recursive: true });
  for (const f of ['index.html', 'ib/index.html', 'banqueiro/index.html', 'banqueiro/ib/index.html']) {
    const arq = path.join(saidaPacote, f);
    const conteudo = fs.readFileSync(arq, 'utf8');
    const robots = '<meta name="robots" content="noindex, nofollow">';
    // A página do Banqueiro é publicada sem esqueleto HTML (o claude.ai adiciona); fora dele, precisa de doctype e viewport.
    fs.writeFileSync(arq, conteudo.includes('<head>') ? conteudo.replace('<head>', `<head>\n${robots}`)
      : `<!doctype html>\n<html lang="pt-BR">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${robots}\n${conteudo}`);
  }
  fs.writeFileSync(path.join(saidaPacote, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  console.log('Demonstração gerada em dist-demo/ (Banqueiro + Internet Banking), dist-ib/ (só Internet Banking), dist-site/ (site institucional + Internet Banking) e dist-apresentacao/ (tudo junto, para hospedar).');
})().catch((e) => { console.error(e); process.exit(1); });
