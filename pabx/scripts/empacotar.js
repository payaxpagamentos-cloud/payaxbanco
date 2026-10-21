'use strict';

// Gera o pacote de instalação: <saída>/pabx.zip com a pasta pabx/ pronta para enviar ao servidor
// (código, dependências de produção já instaladas, .env com segredos novos e LEIA-ME).
// Uso: node scripts/empacotar.js [pasta de saída]   (padrão: dist)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const saida = path.resolve(process.argv[2] || path.join(raiz, 'dist'));
const pasta = path.join(saida, 'pabx');

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(pasta, { recursive: true });
for (const item of ['server', 'public', 'package.json', 'package-lock.json', 'Dockerfile', 'README.md']) {
  fs.cpSync(path.join(raiz, item), path.join(pasta, item), { recursive: true });
}
// Dependências só de produção (todas em JavaScript: o mesmo pacote serve para Linux e Windows).
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: pasta, stdio: 'inherit' });

const senhaAdmin = crypto.randomBytes(12).toString('base64url');
const env = `# PABX — configuração do servidor
NODE_ENV=production
PORT=3300
# Endereço do painel: https://SEU-DOMINIO/pabx/
PABX_BASE_PATH=/pabx
# Segredo das sessões (gerado agora). Não compartilhe e não troque depois de instalado.
PABX_SECRET=${crypto.randomBytes(32).toString('hex')}
# Master, criado no primeiro acesso.
PABX_ADMIN_EMAIL=master@pabx.com.br
PABX_ADMIN_SENHA=${senhaAdmin}
PABX_ADMIN_NOME=Master
# Atrás de Nginx/Apache: confia no proxy para obter o IP real dos acessos (usado na Segurança e no bloqueio de IP).
PABX_TRUST_PROXY=1
# Fuso das datas do dashboard e dos relatórios.
# PABX_FUSO=America/Sao_Paulo
# Banco de dados em ./data (faça cópia desta pasta).
# PABX_DB=/caminho/para/pabx.db
`;
fs.writeFileSync(path.join(pasta, '.env'), env, { mode: 0o600 });
fs.copyFileSync(path.join(raiz, 'scripts', 'LEIA-ME.txt'), path.join(pasta, 'LEIA-ME.txt'));
fs.mkdirSync(path.join(pasta, 'data'), { recursive: true });

const zip = path.join(saida, 'pabx.zip');
execFileSync('zip', ['-qr', zip, 'pabx'], { cwd: saida });
console.log(`Pacote: ${zip}`);
console.log(`Senha inicial do master (master@pabx.com.br): ${senhaAdmin}`);
