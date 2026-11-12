'use strict';

// Gera o pacote de instalação: <saída>/mercadinho.zip com a pasta mercadinho/ pronta para enviar ao servidor
// (código, dependências de produção já instaladas, .env com segredos novos e LEIA-ME).
// Uso: node scripts/empacotar.js [pasta de saída]   (padrão: dist)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const saida = path.resolve(process.argv[2] || path.join(raiz, 'dist'));
const pasta = path.join(saida, 'mercadinho');

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(pasta, { recursive: true });
for (const item of ['server', 'public', 'package.json', 'package-lock.json', 'Dockerfile', 'README.md']) {
  fs.cpSync(path.join(raiz, item), path.join(pasta, item), { recursive: true });
}
fs.mkdirSync(path.join(pasta, 'scripts'), { recursive: true });
for (const script of ['ponte-maquininha.js', 'importar-fotos.js']) {
  fs.copyFileSync(path.join(raiz, 'scripts', script), path.join(pasta, 'scripts', script));
}

// Dependências só de produção (todas em JavaScript: o mesmo pacote serve para Linux e Windows).
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: pasta, stdio: 'inherit' });

const senhaAdmin = crypto.randomBytes(12).toString('base64url');
const env = `# Mercadinho do Condomínio — configuração do servidor
NODE_ENV=production
PORT=3300
# Endereço do sistema: https://SEU-DOMINIO/mercadinho/
MERCADO_BASE_PATH=/mercadinho
# Segredo das sessões (gerado agora). Não compartilhe e não troque depois de instalado.
MERCADO_SECRET=${crypto.randomBytes(32).toString('hex')}
# Administrador criado no primeiro acesso.
MERCADO_ADMIN_EMAIL=admin@mercadinho.com.br
MERCADO_ADMIN_SENHA=${senhaAdmin}
MERCADO_ADMIN_NOME=Administração do Mercadinho
# Atrás de Nginx/Apache: confia no proxy para obter o IP real dos acessos.
MERCADO_TRUST_PROXY=1
# Banco de dados em ./data (faça cópia desta pasta todo dia).
# MERCADO_DB=/caminho/para/mercadinho.db
`;
fs.writeFileSync(path.join(pasta, '.env'), env, { mode: 0o600 });
fs.copyFileSync(path.join(raiz, 'scripts', 'LEIA-ME.txt'), path.join(pasta, 'LEIA-ME.txt'));
fs.mkdirSync(path.join(pasta, 'data', 'fotos'), { recursive: true });

const zip = path.join(saida, 'mercadinho.zip');
execFileSync('zip', ['-qr', zip, 'mercadinho'], { cwd: saida });
console.log(`Pacote: ${zip}`);
console.log(`Senha inicial do administrador (admin@mercadinho.com.br): ${senhaAdmin}`);
