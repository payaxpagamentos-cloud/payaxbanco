'use strict';

// Gera o pacote de instalação: <saída>/play-tv.zip com a pasta tv/ pronta para enviar ao servidor
// (código, dependências de produção já instaladas, .env com segredos novos e LEIA-ME).
// Uso: node scripts/empacotar.js [pasta de saída]   (padrão: dist)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const saida = path.resolve(process.argv[2] || path.join(raiz, 'dist'));
const pasta = path.join(saida, 'tv');

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(pasta, { recursive: true });
for (const item of ['server', 'public', 'package.json', 'package-lock.json', 'Dockerfile', 'README.md']) {
  fs.cpSync(path.join(raiz, item), path.join(pasta, item), { recursive: true });
}
// Dependências só de produção (todas em JavaScript: o mesmo pacote serve para Linux e Windows).
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: pasta, stdio: 'inherit' });

const senhaAdmin = crypto.randomBytes(12).toString('base64url');
const env = `# PLAY TV — configuração do servidor (fase de testes)
NODE_ENV=production
PORT=3600
# Endereço da plataforma: https://SEU-DOMINIO/tv/  (app do assinante) e /tv/admin/ (operação)
TV_BASE_PATH=/tv
# Segredo das sessões (gerado agora). Não compartilhe e não troque depois de instalado:
# trocar derruba todas as sessões e invalida os links de reprodução.
TV_SECRET=${crypto.randomBytes(32).toString('hex')}
# Administrador da operação, criado no primeiro acesso.
TV_ADMIN_EMAIL=admin@playtv.com.br
TV_ADMIN_SENHA=${senhaAdmin}
TV_ADMIN_NOME=Operação PLAY TV
# Atrás de Nginx/Apache: confia no proxy para obter o IP real dos acessos.
TV_TRUST_PROXY=1
# Cobrança na fase de testes: "simulado" (o assinante confirma o PIX por um botão de teste).
# Para valer de verdade, troque para "manual" (PIX na chave da plataforma, confirmado pela operação).
TV_PAGAMENTOS=simulado
# Transmissão dos canais pelo nosso servidor (protege a origem e resolve CORS).
TV_RELAY=1
# Canais que tocam direto na origem: libere aqui o domínio da emissora (separado por vírgula).
# TV_ORIGENS_MIDIA=cdn.emissora.com.br
# Banco e arquivos de vídeo ficam em ./data (faça cópia desta pasta: os vídeos estão nela).
# TV_DB=/caminho/para/tv.db
# TV_MIDIA=/caminho/para/midia
# Tamanho máximo de cada vídeo enviado pelo painel.
TV_VIDEO_MAX_MB=8192
`;
fs.writeFileSync(path.join(pasta, '.env'), env, { mode: 0o600 });
fs.copyFileSync(path.join(raiz, 'scripts', 'LEIA-ME.txt'), path.join(pasta, 'LEIA-ME.txt'));
fs.mkdirSync(path.join(pasta, 'data', 'midia'), { recursive: true });

const zip = path.join(saida, 'play-tv.zip');
execFileSync('zip', ['-qr', zip, 'tv'], { cwd: saida });
console.log(`Pacote: ${zip}`);
console.log(`Senha inicial da operação (admin@playtv.com.br): ${senhaAdmin}`);
