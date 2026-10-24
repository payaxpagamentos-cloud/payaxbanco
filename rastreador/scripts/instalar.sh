#!/usr/bin/env bash
# Instalação do Rastreador de Veículos em /rastreador, sem mexer nos outros sistemas do servidor.
#
# O que este script FAZ:
#   - confere o Node.js e se as portas do rastreador (PORT e RASTREADOR_GT06_PORTA do .env) estão livres;
#   - inicia o rastreador no PM2 com o nome "rastreador" (só esse processo);
#   - cria UM arquivo novo de configuração do servidor web, só com o endereço /rastreador.
# O que ele NÃO faz:
#   - não altera, não reinicia e não para nenhum outro processo, site ou configuração existente
#     (Discador, /manager, Asterisk, banco de dados...);
#   - não sobrescreve arquivos que já existem;
#   - não recarrega o Nginx/Apache sozinho: mostra o comando para você rodar depois de conferir.
#
# Uso (dentro da pasta rastreador):   bash instalar.sh

set -euo pipefail
cd "$(dirname "$0")"
PASTA="$(pwd)"

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
aviso(){ printf '\033[33m!\033[0m %s\n' "$*"; }
erro() { printf '\033[31m✖ %s\033[0m\n' "$*"; exit 1; }

[ -f .env ] || erro "Arquivo .env não encontrado nesta pasta ($PASTA). Envie a pasta inteira, com o .env."
[ -f server/index.js ] || erro "Rode este script de dentro da pasta rastreador."
valor() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '\r'; }
PORTA="$(valor PORT)"; PORTA="${PORTA:-3400}"
GT06="$(valor RASTREADOR_GT06_PORTA)"; GT06="${GT06:-5023}"
BASE="$(valor RASTREADOR_BASE_PATH)"; BASE="${BASE:-/rastreador}"

echo "Rastreador de Veículos — instalação em $PASTA"
echo "  painel: porta $PORTA (endereço $BASE)   rastreadores GT06: porta $GT06"
echo

# 1) Node.js 22.13 ou mais novo
command -v node >/dev/null || erro "Node.js não instalado. Instale o Node.js 22 (https://nodejs.org) ou use o Docker (LEIA-ME, item 5b)."
NODE_V="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || erro "Node.js $NODE_V é antigo: precisa do 22.13 ou mais novo. Em servidores antigos (CentOS 7), use o Docker (LEIA-ME, item 5b)."
ok "Node.js $NODE_V"

# 2) Portas livres (se outro sistema já usa, para aqui sem mexer em nada)
# Tenta abrir a porta com o próprio Node.js: se outro programa já usa, a abertura falha (e nada é alterado).
porta_ocupada() {
  node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(0));s.once("listening",()=>s.close(()=>process.exit(1)));s.listen(Number(process.argv[1]))' "$1"
}
JA_RODANDO=0
if command -v pm2 >/dev/null && pm2 describe rastreador >/dev/null 2>&1; then JA_RODANDO=1; fi
if [ "$JA_RODANDO" = 0 ]; then
  for p in "$PORTA" "$GT06"; do
    porta_ocupada "$p" && erro "A porta $p já está em uso por outro sistema. Troque no .env (PORT ou RASTREADOR_GT06_PORTA) e rode de novo."
  done
  ok "Portas $PORTA e $GT06 livres"
else
  ok "Rastreador já instalado no PM2: será atualizado (só o processo \"rastreador\")"
fi

# 3) PM2 e o processo "rastreador"
if ! command -v pm2 >/dev/null; then
  echo "Instalando o PM2 (gerenciador de processos do Node.js)..."
  npm install -g pm2 >/dev/null
fi
mkdir -p data
if [ "$JA_RODANDO" = 1 ]; then pm2 restart rastreador --update-env >/dev/null; else pm2 start "npm start" --name rastreador --cwd "$PASTA" >/dev/null; fi
pm2 save >/dev/null
sleep 2
if command -v curl >/dev/null && curl -fsS "http://127.0.0.1:$PORTA$BASE/api/saude" >/dev/null; then ok "Rastreador no ar (http://127.0.0.1:$PORTA$BASE/)"
else aviso "O rastreador não respondeu ainda. Veja o log: pm2 logs rastreador"; fi
aviso "Para iniciar sozinho depois de reiniciar o servidor, rode uma vez: pm2 startup  (e o comando que ele mostrar)"

# 4) Servidor web: cria só um arquivo NOVO com o /rastreador (os sites e endereços existentes não são tocados)
echo
CONF_NGINX="location $BASE/ {
    proxy_pass http://127.0.0.1:$PORTA;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}
location = $BASE { return 301 $BASE/; }"
CONF_APACHE="ProxyPreserveHost On
ProxyPass        $BASE http://127.0.0.1:$PORTA$BASE
ProxyPassReverse $BASE http://127.0.0.1:$PORTA$BASE"

escrever() { # escreve só se o arquivo não existir
  if [ -e "$1" ]; then aviso "$1 já existe: não foi alterado."; return 1; fi
  if ! printf '%s\n' "$2" 2>/dev/null > "$1"; then
    aviso "Sem permissão para criar $1 (rode com sudo). Crie esse arquivo com o conteúdo:"; printf '%s\n' "$2"; return 1
  fi
  ok "Criado $1"
}

if command -v nginx >/dev/null && pgrep -x nginx >/dev/null; then
  mkdir -p /etc/nginx/snippets 2>/dev/null || true
  if escrever /etc/nginx/snippets/rastreador.conf "$CONF_NGINX"; then :; fi
  echo
  echo "Falta 1 linha no Nginx (feito por você, para não mexer sem conferir):"
  echo "  no arquivo do seu domínio, DENTRO do bloco server { ... } que atende o site (o mesmo do /manager), acrescente:"
  echo "      include /etc/nginx/snippets/rastreador.conf;"
  echo "  depois confira e recarregue (não derruba os outros sistemas):"
  echo "      nginx -t && systemctl reload nginx"
elif command -v httpd >/dev/null || command -v apache2 >/dev/null; then
  if [ -d /etc/httpd/conf.d ]; then ARQ=/etc/httpd/conf.d/rastreador.conf; TESTE="httpd -t"; RELOAD="systemctl reload httpd"
  else ARQ=/etc/apache2/conf-available/rastreador.conf; TESTE="apache2ctl -t"; RELOAD="a2enmod proxy proxy_http && a2enconf rastreador && systemctl reload apache2"; fi
  escrever "$ARQ" "$CONF_APACHE" || true
  echo
  echo "Confira e recarregue o Apache (não derruba os outros sistemas):"
  echo "      $TESTE && $RELOAD"
  echo "  (precisa dos módulos proxy e proxy_http; em CentOS/Issabel/VICIdial já vêm ativos)"
else
  aviso "Não encontrei Nginx nem Apache rodando. Configure o endereço $BASE no servidor web (LEIA-ME, item 6)."
fi

# 5) Firewall: a porta do GT06 precisa estar aberta para os rastreadores
echo
echo "Libere a porta $GT06/TCP para os rastreadores se conectarem (só essa porta, nada mais muda):"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then echo "      ufw allow $GT06/tcp"
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then echo "      firewall-cmd --permanent --add-port=$GT06/tcp && firewall-cmd --reload"
else echo "      (no painel da hospedagem/nuvem, libere a entrada TCP $GT06)"; fi
echo
ok "Pronto. Depois do servidor web: https://SEU-DOMINIO$BASE/  (master e senha no .env: RASTREADOR_ADMIN_EMAIL / RASTREADOR_ADMIN_SENHA)"
