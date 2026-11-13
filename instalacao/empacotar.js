'use strict';

// Gera o pacote de instalação da ZOE: dist/zoe-instalacao.tar.gz com o sistema (WhatsApp, telefonia,
// atendente virtual, Ouvidoria), as dependências de produção já instaladas e o instalador.
// Uso (na raiz do repositório):  node instalacao/empacotar.js [pasta de saída]
// No servidor:  tar xzf zoe-instalacao.tar.gz && cd zoe && sudo ./instalacao/instalar.sh --dominio ...
//
// Não leva .env, banco nem dados de teste: cada servidor gera os próprios segredos na instalação.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const saida = path.resolve(process.argv[2] || path.join(raiz, 'dist'));
const pasta = path.join(saida, 'zoe');
const MODULOS = ['atendimento'];
const LEVAR = ['server', 'public', 'scripts', 'package.json', 'package-lock.json', 'README.md', 'Dockerfile', '.env.exemplo'];

fs.rmSync(pasta, { recursive: true, force: true });
fs.mkdirSync(pasta, { recursive: true });
for (const m of MODULOS) {
  const alvo = path.join(pasta, m);
  fs.mkdirSync(alvo, { recursive: true });
  for (const item of LEVAR) {
    const de = path.join(raiz, m, item);
    if (fs.existsSync(de)) fs.cpSync(de, path.join(alvo, item), { recursive: true });
  }
  // Só dependências de produção (todas em JavaScript: o mesmo pacote serve para qualquer Linux).
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: alvo, stdio: 'inherit' });
}
fs.cpSync(path.join(raiz, 'instalacao'), path.join(pasta, 'instalacao'), {
  recursive: true, filter: (f) => !f.endsWith('empacotar.js'),
});
for (const s of ['instalar.sh', 'backup.sh', 'verificar.sh', 'checar-servidor.sh']) fs.chmodSync(path.join(pasta, 'instalacao', s), 0o755);
fs.chmodSync(path.join(pasta, 'atendimento', 'scripts', 'instalar-whisper.sh'), 0o755);
fs.chmodSync(path.join(pasta, 'atendimento', 'scripts', 'zoe-agi.js'), 0o755);

let versao = 'local';
try { versao = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: raiz }).toString().trim(); } catch { /* fora do git */ }
fs.writeFileSync(path.join(pasta, 'VERSAO'), `${versao}\n${new Date().toISOString()}\n`);

const arquivo = path.join(saida, 'zoe-instalacao.tar.gz');
execFileSync('tar', ['czf', arquivo, '-C', saida, 'zoe']);
fs.rmSync(pasta, { recursive: true, force: true });
console.log(`Pacote: ${arquivo} (${(fs.statSync(arquivo).size / 1024 / 1024).toFixed(1)} MB, versão ${versao})`);
