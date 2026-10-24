'use strict';

// Gera o pacote de instalação: <saída>/rastreador.zip com a pasta rastreador/ pronta para enviar ao servidor
// (código, dependências de produção já instaladas, .env com segredos novos e LEIA-ME).
// Uso: node scripts/empacotar.js [pasta de saída]   (padrão: dist)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const saida = path.resolve(process.argv[2] || path.join(raiz, 'dist'));
const pasta = path.join(saida, 'rastreador');

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(pasta, { recursive: true });
for (const item of ['server', 'public', 'package.json', 'package-lock.json', 'Dockerfile', 'README.md']) {
  fs.cpSync(path.join(raiz, item), path.join(pasta, item), { recursive: true });
}
// Dependências só de produção (todas em JavaScript: o mesmo pacote serve para Linux e Windows).
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: pasta, stdio: 'inherit' });

const senhaAdmin = crypto.randomBytes(12).toString('base64url');
const env = `# Rastreador de Veículos — configuração do servidor
NODE_ENV=production
PORT=3400
# Endereço do painel: https://SEU-DOMINIO/rastreador/
RASTREADOR_BASE_PATH=/rastreador
# Segredo das sessões (gerado agora). Não compartilhe e não troque depois de instalado.
RASTREADOR_SECRET=${crypto.randomBytes(32).toString('hex')}
# Master, criado no primeiro acesso.
RASTREADOR_ADMIN_EMAIL=master@rastreador.com.br
RASTREADOR_ADMIN_SENHA=${senhaAdmin}
RASTREADOR_ADMIN_NOME=Master
# Porta TCP em que os rastreadores GT06 se conectam (libere no firewall do servidor). 0 desliga.
RASTREADOR_GT06_PORTA=5023
# Atrás de Nginx/Apache: confia no proxy para obter o IP real dos acessos.
RASTREADOR_TRUST_PROXY=1
# Fuso das datas do dashboard e dos relatórios.
# RASTREADOR_FUSO=America/Sao_Paulo
# Banco de dados em ./data (faça cópia desta pasta).
# RASTREADOR_DB=/caminho/para/rastreador.db
`;
fs.writeFileSync(path.join(pasta, '.env'), env, { mode: 0o600 });
fs.copyFileSync(path.join(raiz, 'scripts', 'LEIA-ME.txt'), path.join(pasta, 'LEIA-ME.txt'));
fs.copyFileSync(path.join(raiz, 'scripts', 'instalar.sh'), path.join(pasta, 'instalar.sh'));
fs.chmodSync(path.join(pasta, 'instalar.sh'), 0o755);
fs.mkdirSync(path.join(pasta, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(raiz, 'scripts', 'simular-j16.js'), path.join(pasta, 'scripts', 'simular-j16.js'));
fs.mkdirSync(path.join(pasta, 'data'), { recursive: true });

const zip = path.join(saida, 'rastreador.zip');
execFileSync('zip', ['-qr', zip, 'rastreador'], { cwd: saida });
console.log(`Pacote: ${zip}`);
console.log(`Senha inicial do master (master@rastreador.com.br): ${senhaAdmin}`);
