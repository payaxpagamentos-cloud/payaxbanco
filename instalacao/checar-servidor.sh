#!/usr/bin/env bash
# =============================================================================================
#  ZOE — checagem do servidor ANTES de instalar. Só lê: não instala, não altera, não reinicia nada.
#  Mostra o que já existe (sistema, Node, servidor web, portas, sites, Asterisk) para a instalação
#  da ZOE conviver com o que está lá.
#
#     sudo ./instalacao/checar-servidor.sh
#  Mande o resultado inteiro para quem vai acompanhar a instalação.
# =============================================================================================
set -u
PORTA="${1:-3600}"
t() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
at() { printf '  \033[33m!\033[0m %s\n' "$*"; }
ru() { printf '  \033[31m✘\033[0m %s\n' "$*"; }
dono() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2; }

t "Sistema"
. /etc/os-release 2>/dev/null
echo "  ${PRETTY_NAME:-desconhecido} · $(uname -m) · kernel $(uname -r)"
case "${ID:-}" in ubuntu|debian) ok "Ubuntu/Debian" ;; *) ru "o instalador é para Ubuntu/Debian" ;; esac
[ "$(id -u)" -eq 0 ] && ok "rodando como root" || at "rode com sudo para ver os donos das portas"
echo "  CPU: $(nproc) · RAM: $(free -m | awk '/^Mem:/{print $2" MB (livre: "$7" MB)"}')"
echo "  Disco em /: $(df -h / | awk 'NR==2{print $4" livres de "$2}')"
[ "$(free -m | awk '/^Mem:/{print $7}')" -ge 1024 ] && ok "memória livre suficiente" || at "menos de 1 GB de memória livre"
[ "$(df -Pm / | awk 'NR==2{print $4}')" -ge 10240 ] && ok "disco livre suficiente" || at "menos de 10 GB livres em /"

t "Node.js"
if command -v node >/dev/null; then
  V="$(node -v)"; echo "  Node do servidor: $V ($(command -v node))"
  node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)" \
    && ok "serve para a ZOE (será usado, sem mudança)" \
    || at "outra versão: a ZOE vai usar um Node 22 próprio em /usr/local/lib/zoe/node, sem trocar este"
else
  at "sem Node: a ZOE vai usar um Node 22 próprio em /usr/local/lib/zoe/node"
fi
command -v pm2 >/dev/null && echo "  pm2 presente (outro sistema em Node?)"

t "Portas"
for p in 80 443 "$PORTA"; do
  d="$(dono "$p")"
  if [ -z "$d" ]; then ok "porta $p livre"
  elif [ "$p" = "$PORTA" ]; then ru "porta $p em uso por \"$d\": instale com --porta 3610 (ou outra livre)"
  else echo "  porta $p: $d"; fi
done
echo "  Outras portas em uso (TCP):"
ss -ltnpH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -n | uniq | tr '\n' ' ' | sed 's/^/    /'; echo

t "Servidor web"
D80="$(dono 80)"
case "$D80" in
  nginx) ok "Nginx na porta 80: a ZOE entra como um site a mais (/etc/nginx/sites-available/zoe.conf), sem mexer nos outros" ;;
  apache2|httpd) at "Apache na porta 80: a ZOE não instala o Nginx; deixa um site do Apache pronto para ligar" ;;
  "") ok "nada na porta 80: a ZOE instala o Nginx" ;;
  *) at "porta 80 de \"$D80\": a ZOE não instala o Nginx; aponte o domínio para ela à mão" ;;
esac
if [ -d /etc/nginx ]; then
  echo "  Sites do Nginx (server_name):"
  grep -rhoE 'server_name[^;]+' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sort -u | sed 's/^/    /'
  grep -rlE 'default_server' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sed 's/^/    default_server em: /'
fi
if [ -d /etc/apache2 ]; then
  echo "  Sites do Apache (ServerName):"
  grep -rhoiE '^\s*Server(Name|Alias)\s+\S+.*' /etc/apache2/sites-enabled 2>/dev/null | sed 's/^\s*/    /' | sort -u
fi
[ -d /etc/letsencrypt/live ] && echo "  Certificados existentes: $(ls /etc/letsencrypt/live 2>/dev/null | grep -v README | tr '\n' ' ')"

t "O que já está instalado"
[ -e /zoe ] && at "/zoe já existe (conteúdo: $(ls /zoe 2>/dev/null | tr '\n' ' '))" || ok "/zoe não existe"
id zoe >/dev/null 2>&1 && at "usuário zoe já existe" || ok "usuário zoe livre"
systemctl list-unit-files 2>/dev/null | grep -E '^zoe' | sed 's/^/  serviço: /'
for s in asterisk freeswitch mysql mariadb postgresql docker redis-server php*-fpm; do
  systemctl list-unit-files 2>/dev/null | grep -qE "^${s}\.service" && echo "  $s: $(systemctl is-active "$s" 2>/dev/null)"
done
command -v asterisk >/dev/null && echo "  Asterisk: $(asterisk -V 2>/dev/null)"
[ -d /etc/issabel ] || [ -f /etc/issabel.conf ] && echo "  Issabel detectado"
[ -f /etc/freepbx.conf ] && echo "  FreePBX detectado"

t "Internet (o que a ZOE precisa alcançar)"
for alvo in graph.facebook.com olinda.bcb.gov.br api.anthropic.com nodejs.org; do
  curl -s -o /dev/null -m 8 "https://$alvo" && ok "$alvo" || ru "$alvo inacessível"
done
echo "  IP público: $(curl -s -m 5 https://api.ipify.org || echo '?')"

echo
echo "Fim da checagem. Nada foi alterado."
