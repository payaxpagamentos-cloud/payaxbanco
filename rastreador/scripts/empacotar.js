'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

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
fs.copyFileSync(path.join(raiz, 'LICENSE'), path.join(pasta, 'LICENSE'));
fs.mkdirSync(path.join(pasta, 'scripts'), { recursive: true });
// Scripts úteis no servidor: simulador, criptografia do banco e verificação da licença.
for (const s of ['simular-j16.js', 'cifrar-banco.js']) fs.copyFileSync(path.join(raiz, 'scripts', s), path.join(pasta, 'scripts', s));

// Ofusca o JavaScript que roda no navegador (dificulta ler e copiar). Só no pacote; o código-fonte continua legível.
// Os módulos mantêm import/export e os nomes exportados (renameGlobals desligado), para não quebrar o carregamento.
const obf = require('javascript-obfuscator');
const opcoesObf = {
  compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.6,
  deadCodeInjection: true, deadCodeInjectionThreshold: 0.2, simplify: true,
  renameGlobals: false, identifierNamesGenerator: 'mangled',
  stringArray: true, stringArrayThreshold: 0.75, stringArrayEncoding: ['base64'],
  splitStrings: true, splitStringsChunkLength: 10, selfDefending: false, target: 'browser',
};
let ofuscados = 0;
for (const sub of ['js', 'motorista']) {
  const dir = path.join(pasta, 'public', sub);
  for (const nome of fs.readdirSync(dir)) {
    if (!nome.endsWith('.js') || nome === 'sw.js') continue; // o service worker fica como está (registrado por caminho fixo)
    const alvo = path.join(dir, nome);
    const fonte = fs.readFileSync(alvo, 'utf8');
    fs.writeFileSync(alvo, obf.obfuscate(fonte, opcoesObf).getObfuscatedCode());
    ofuscados++;
  }
}
console.log(`JavaScript do navegador ofuscado: ${ofuscados} arquivo(s).`);
fs.mkdirSync(path.join(pasta, 'data'), { recursive: true });
// Versão do pacote (data e hora de Brasília): aparece no menu do painel, para conferir se a atualização entrou.
const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
const versao = `${p.year}.${p.month}.${p.day}-${p.hour}${p.minute}`;
fs.writeFileSync(path.join(pasta, 'server', 'versao.json'), `${JSON.stringify({ versao })}\n`);

// O nome do arquivo leva a versão, para não confundir com um pacote antigo na pasta de Downloads.
const zip = path.join(saida, `rastreador-${versao}.zip`);
execFileSync('zip', ['-qr', zip, 'rastreador'], { cwd: saida });
console.log(`Pacote: ${zip} (versão ${versao})`);
console.log(`Senha inicial do master (master@rastreador.com.br): ${senhaAdmin}`);
