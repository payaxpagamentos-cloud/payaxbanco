'use strict';

// Gera o pacote de instalação: <saída>/ativa-bpo.zip com a pasta bpo/ pronta para enviar ao servidor
// (código, dependências de produção já instaladas, .env com segredos novos e LEIA-ME).
// Uso: node scripts/empacotar.js [pasta de saída]   (padrão: ../dist-bpo)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const saida = path.resolve(process.argv[2] || path.join(raiz, '..', 'dist-bpo'));
const pasta = path.join(saida, 'bpo');

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(pasta, { recursive: true });
for (const item of ['server', 'public', 'package.json', 'package-lock.json', 'Dockerfile', 'README.md']) {
  fs.cpSync(path.join(raiz, item), path.join(pasta, item), { recursive: true });
}
// Dependências só de produção (todas em JavaScript: o mesmo pacote serve para Linux e Windows).
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: pasta, stdio: 'inherit' });

const senhaAdmin = crypto.randomBytes(12).toString('base64url');
const env = `# Ativa BPO Financeiro — configuração do servidor
NODE_ENV=production
PORT=3100
# Endereço do sistema da equipe: https://SEU-DOMINIO/bpo/
BPO_BASE_PATH=/bpo
# Endereço do Portal do Cliente: https://SEU-DOMINIO/bpo-cliente/
BPO_PORTAL_PATH=/bpo-cliente
# Segredo das sessões (gerado agora). Não compartilhe e não troque depois de instalado.
BPO_SECRET=${crypto.randomBytes(32).toString('hex')}
# Administrador criado no primeiro acesso. Troque a senha depois de entrar.
BPO_ADMIN_EMAIL=admin@ativabpo.com.br
BPO_ADMIN_SENHA=${senhaAdmin}
BPO_ADMIN_NOME=Administrador Ativa
# Atrás de Nginx/Apache/cPanel: confia no proxy para obter o IP real dos acessos.
BPO_TRUST_PROXY=1
# Banco, documentos e backups ficam em ./data (faça cópia desta pasta).
# BPO_DB=/caminho/para/bpo.db
`;
fs.writeFileSync(path.join(pasta, '.env'), env, { mode: 0o600 });
fs.copyFileSync(path.join(raiz, 'scripts', 'LEIA-ME.txt'), path.join(pasta, 'LEIA-ME.txt'));
fs.mkdirSync(path.join(pasta, 'data'), { recursive: true });

const zip = path.join(saida, 'ativa-bpo.zip');
execFileSync('zip', ['-qr', zip, 'bpo'], { cwd: saida });
console.log(`Pacote: ${zip}`);
console.log(`Senha inicial do administrador (admin@ativabpo.com.br): ${senhaAdmin}`);
