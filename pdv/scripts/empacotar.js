'use strict';

// Gera o pacote de instalação: <saída>/pdv.zip com a pasta pdv/ pronta para enviar ao servidor
// (código, dependências de produção já instaladas, .env com segredos novos e LEIA-ME).
// Uso: node scripts/empacotar.js [pasta de saída]   (padrão: dist)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const saida = path.resolve(process.argv[2] || path.join(raiz, 'dist'));
const pasta = path.join(saida, 'pdv');

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(pasta, { recursive: true });
for (const item of ['server', 'public', 'package.json', 'package-lock.json', 'Dockerfile', 'README.md']) {
  fs.cpSync(path.join(raiz, item), path.join(pasta, item), { recursive: true });
}
// Dependências só de produção (todas em JavaScript: o mesmo pacote serve para Linux e Windows).
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: pasta, stdio: 'inherit' });

// Master: PDV_ADMIN_EMAIL / PDV_ADMIN_SENHA / PDV_ADMIN_NOME no ambiente de quem empacota; sem eles, master@pdv.com.br com senha nova.
const emailAdmin = process.env.PDV_ADMIN_EMAIL || 'master@pdv.com.br';
const senhaAdmin = process.env.PDV_ADMIN_SENHA || crypto.randomBytes(12).toString('base64url');
const nomeAdmin = process.env.PDV_ADMIN_NOME || 'Master';
if (senhaAdmin.length < 12) throw new Error('PDV_ADMIN_SENHA deve ter pelo menos 12 caracteres (o servidor recusa senha menor em produção).');
const env = `# Payax PDV — configuração do servidor
NODE_ENV=production
PORT=3600
# Endereço do painel: https://SEU-DOMINIO/pdv/
PDV_BASE_PATH=/pdv
# Segredo das sessões (gerado agora). Não compartilhe e não troque depois de instalado.
PDV_SECRET=${crypto.randomBytes(32).toString('hex')}
# Master, criado no primeiro acesso.
PDV_ADMIN_EMAIL=${emailAdmin}
PDV_ADMIN_SENHA=${senhaAdmin}
PDV_ADMIN_NOME=${nomeAdmin}
# Atrás de Nginx/Apache: confia no proxy para obter o IP real dos acessos (usado na auditoria).
PDV_TRUST_PROXY=1
# Fuso do caixa, dos relatórios e da conferência.
# PDV_FUSO=America/Sao_Paulo
# IXC na rede interna, só em http:// (o padrão exige https://)
# PDV_HTTP=1
# Banco de dados em ./data (faça cópia desta pasta).
# PDV_DB=/caminho/para/pdv.db
`;
fs.writeFileSync(path.join(pasta, '.env'), env, { mode: 0o600 });
fs.copyFileSync(path.join(raiz, 'scripts', 'LEIA-ME.txt'), path.join(pasta, 'LEIA-ME.txt'));
// Exemplo do aplicativo da maquininha, para quem for integrar o aparelho.
fs.mkdirSync(path.join(pasta, 'maquininha'), { recursive: true });
fs.copyFileSync(path.join(raiz, 'scripts', 'maquininha-exemplo.js'), path.join(pasta, 'maquininha', 'maquininha-exemplo.js'));
fs.mkdirSync(path.join(pasta, 'data'), { recursive: true });

const zip = path.join(saida, 'pdv.zip');
execFileSync('zip', ['-qr', zip, 'pdv'], { cwd: saida });
console.log(`Pacote: ${zip}`);
console.log(`Master: ${emailAdmin}${process.env.PDV_ADMIN_SENHA ? '' : ` · senha inicial: ${senhaAdmin}`}`);
