'use strict';

// Gera o pacote de instalação: <saída>/zoe-atende.zip com a pasta atendimento/ pronta para enviar ao
// servidor (código, dependências de produção já instaladas, .env com segredos novos e LEIA-ME).
// Uso: node scripts/empacotar.js [pasta de saída]   (padrão: dist)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const saida = path.resolve(process.argv[2] || path.join(raiz, 'dist'));
const pasta = path.join(saida, 'atendimento');

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(pasta, { recursive: true });
for (const item of ['server', 'public', 'package.json', 'package-lock.json', 'Dockerfile', 'README.md']) {
  fs.cpSync(path.join(raiz, item), path.join(pasta, item), { recursive: true });
}
// Dependências só de produção (todas em JavaScript: o mesmo pacote serve para Linux e Windows).
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: pasta, stdio: 'inherit' });

// Master: ATEND_ADMIN_EMAIL / ATEND_ADMIN_SENHA / ATEND_ADMIN_NOME de quem empacota; sem eles, uma senha nova.
const emailAdmin = process.env.ATEND_ADMIN_EMAIL || 'master@atendimento.com.br';
const senhaAdmin = process.env.ATEND_ADMIN_SENHA || crypto.randomBytes(12).toString('base64url');
const nomeAdmin = process.env.ATEND_ADMIN_NOME || 'Master';
if (senhaAdmin.length < 12) throw new Error('ATEND_ADMIN_SENHA deve ter pelo menos 12 caracteres (o servidor recusa senha menor em produção).');

const env = `# ZOE Atende — configuração do servidor
NODE_ENV=production
PORT=3600
# Endereço do painel: https://SEU-DOMINIO/atendimento/
ATEND_BASE_PATH=/atendimento
# Endereço público, usado no callback que a empresa cola no app da Meta.
ATEND_URL_PUBLICA=https://SEU-DOMINIO
# Segredo das sessões (gerado agora). Não compartilhe e NÃO TROQUE depois de instalado:
# trocar invalida os tokens do WhatsApp e os cabeçalhos das ferramentas já cadastrados.
ATEND_SECRET=${crypto.randomBytes(32).toString('hex')}
# Master, criado no primeiro acesso.
ATEND_ADMIN_EMAIL=${emailAdmin}
ATEND_ADMIN_SENHA=${senhaAdmin}
ATEND_ADMIN_NOME=${nomeAdmin}
# Atrás de Nginx/Apache: confia no proxy para obter o IP real dos acessos.
ATEND_TRUST_PROXY=1
# Banco e arquivos recebidos ficam em ./data (faça cópia desta pasta inteira).
# ATEND_DB=/caminho/para/atendimento.db
# ATEND_ARQUIVOS=/caminho/para/arquivos
# Fuso do horário de atendimento e dos relatórios.
# ATEND_FUSO=America/Sao_Paulo

# Chave de IA: liga a inteligência da ZOE.
# Sem ela, a atendente usa só as intenções e a base de conhecimento, e oferece o menu de departamentos.
# ATEND_IA_CHAVE=sk-ant-...
# ATEND_IA_MODELO=   (vazio usa o padrão do servidor)
# ATEND_IA_ESFORCO=low
`;
fs.writeFileSync(path.join(pasta, '.env'), env, { mode: 0o600 });
fs.copyFileSync(path.join(raiz, 'scripts', 'LEIA-ME.txt'), path.join(pasta, 'LEIA-ME.txt'));
fs.mkdirSync(path.join(pasta, 'data', 'arquivos'), { recursive: true });

const zip = path.join(saida, 'zoe-atende.zip');
execFileSync('zip', ['-qr', zip, 'atendimento'], { cwd: saida });
console.log(`Pacote: ${zip}`);
console.log(`Master: ${emailAdmin}${process.env.ATEND_ADMIN_SENHA ? '' : ` · senha inicial: ${senhaAdmin}`}`);
console.log('Depois de instalar: cadastre o número de WhatsApp da empresa em Configurações e cole o callback no app da Meta.');
