#!/usr/bin/env bash
#
# Vai Mídia — atualizar a versão que está no ar.
#
# Copia o código novo por cima, reinstala as dependências e reinicia o serviço. Não toca na
# configuração (/etc/vaimidia/vaimidia.env), no banco, nos criativos nem na chave DKIM.
#
#   sudo ./atualizar.sh
#
# Antes de trocar o código, guarda uma cópia do banco — se algo der errado, o caminho de volta existe.
#
set -Eeuo pipefail

DESTINO="/opt/vaimidia"
DADOS="/var/lib/vaimidia"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cor() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
titulo() { echo; cor '1;32' "==> $1"; }

[[ "$(id -u)" -eq 0 ]] || { cor '1;31' "ERRO: rode com sudo."; exit 1; }
[[ -d "$DESTINO" ]] || { cor '1;31' "ERRO: não achei a instalação em $DESTINO. Use instalar.sh."; exit 1; }
[[ -f "$RAIZ/package.json" ]] || { cor '1;31' "ERRO: não achei o código novo em $RAIZ."; exit 1; }

titulo "Guardando uma cópia do banco antes de mexer"
if [[ -f "$DADOS/midia.db" ]]; then
  COPIA="$DADOS/backups/antes-da-atualizacao-$(date +%Y%m%d-%H%M%S).db"
  install -d -o vaimidia -g vaimidia -m 750 "$DADOS/backups"
  # O .backup do sqlite3 copia com o banco em uso; sem ele, o cp simples já resolve com o serviço parado.
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DADOS/midia.db" ".backup '$COPIA'"
  else
    systemctl stop vaimidia
    cp -a "$DADOS/midia.db" "$COPIA"
  fi
  chown vaimidia:vaimidia "$COPIA"
  echo "    $COPIA"
fi

titulo "Copiando a versão nova"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude node_modules --exclude data --exclude .git \
    "$RAIZ"/ "$DESTINO"/
else
  (cd "$RAIZ" && tar --exclude=./node_modules --exclude=./data --exclude=./.git -cf - .) | tar -xf - -C "$DESTINO"
fi
chown -R root:root "$DESTINO"

titulo "Dependências"
if [[ -f "$RAIZ/package-lock.json" ]]; then
  npm ci --omit=dev --prefix "$DESTINO"
else
  npm install --omit=dev --prefix "$DESTINO"
fi

titulo "Reiniciando"
systemctl restart vaimidia
sleep 2
systemctl --no-pager --lines=10 status vaimidia || true

echo
cor '1;32' "Pronto. Se algo saiu errado: sudo journalctl -u vaimidia -n 80"
