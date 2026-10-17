'use strict';

// Gera o pacote de instalação: <saída>/app-taxi.zip com a pasta taxi/ pronta para enviar ao servidor
// (código, dependências de produção já instaladas, .env com segredos novos e LEIA-ME).
// Uso: node scripts/empacotar.js [pasta de saída]   (padrão: dist)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const saida = path.resolve(process.argv[2] || path.join(raiz, 'dist'));
const pasta = path.join(saida, 'taxi');

fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(pasta, { recursive: true });
for (const item of ['server', 'public', 'package.json', 'package-lock.json', 'Dockerfile', 'README.md']) {
  fs.cpSync(path.join(raiz, item), path.join(pasta, item), { recursive: true });
}
// Dependências só de produção (todas em JavaScript: o mesmo pacote serve para Linux e Windows).
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: pasta, stdio: 'inherit' });

const senhaAdmin = crypto.randomBytes(12).toString('base64url');
const env = `# APP Táxi — configuração do servidor (fase de testes)
NODE_ENV=production
PORT=3200
# Endereço do app: https://SEU-DOMINIO/taxi/  (passageiro, motorista e gestão ficam dentro dele)
TAXI_BASE_PATH=/taxi
# Segredo das sessões (gerado agora). Não compartilhe e não troque depois de instalado.
TAXI_SECRET=${crypto.randomBytes(32).toString('hex')}
# Administrador da gestão, criado no primeiro acesso.
TAXI_ADMIN_EMAIL=admin@apptaxi.com.br
TAXI_ADMIN_SENHA=${senhaAdmin}
TAXI_ADMIN_NOME=Gestão APP Táxi
# Atrás de Nginx/Apache: confia no proxy para obter o IP real dos acessos.
TAXI_TRUST_PROXY=1
# Pagamentos na fase de testes: "simulado" (o passageiro aprova o PIX/cartão por um botão de teste).
# Para valer de verdade, troque para "manual" (PIX na chave da plataforma, confirmado pela gestão).
TAXI_PAGAMENTOS=simulado
# Google Maps (opcional): com a chave, o mapa e a busca de endereços passam a ser do Google. Vazio = OpenStreetMap.
TAXI_GOOGLE_MAPS_CHAVE=
TAXI_GOOGLE_MAP_ID=
# Rotas do navegador e do preço fechado. Vazio usa o servidor público do OSRM (só para testes).
# TAXI_ROTAS_URL=http://127.0.0.1:5000
# Contato exigido pela busca de endereços do OpenStreetMap (use um e-mail de vocês).
TAXI_GEOCODER_CONTATO=contato@apptaxi.com.br
# Centro inicial do mapa (latitude,longitude). Padrão: centro de São Paulo.
# TAXI_MAPA_CENTRO=-23.5505,-46.6333
# Banco de dados em ./data (faça cópia desta pasta).
# TAXI_DB=/caminho/para/taxi.db
`;
fs.writeFileSync(path.join(pasta, '.env'), env, { mode: 0o600 });
fs.copyFileSync(path.join(raiz, 'scripts', 'LEIA-ME.txt'), path.join(pasta, 'LEIA-ME.txt'));
fs.mkdirSync(path.join(pasta, 'data'), { recursive: true });

const zip = path.join(saida, 'app-taxi.zip');
execFileSync('zip', ['-qr', zip, 'taxi'], { cwd: saida });
console.log(`Pacote: ${zip}`);
console.log(`Senha inicial da gestão (admin@apptaxi.com.br): ${senhaAdmin}`);
