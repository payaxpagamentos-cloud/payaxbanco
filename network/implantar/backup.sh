#!/usr/bin/env bash
#
# Backup do Manager Provedor.
#
# Copia o banco com a API de backup do SQLite, não com `cp`: copiar o arquivo enquanto o sistema
# escreve produz um banco corrompido que só se descobre no dia em que ele é necessário.
#
# Guarda, no mesmo pacote:
#   - o banco (banco.db)
#   - os arquivos privados (anexos, comprovantes, fotos de chamado, retornos do banco)
#   - o .env, porque sem NETWORK_CHAVE_CREDENCIAIS as senhas de equipamento guardadas no banco
#     ficam ilegíveis — o backup do banco sozinho não restaura a operação.
#
set -euo pipefail

DESTINO="${DESTINO:-__DESTINO__}"
PASTA="${PASTA:-/var/backups/manager-provedor}"
GUARDAR_DIAS="${GUARDAR_DIAS:-30}"

mkdir -p "$PASTA"
CARIMBO="$(date +%Y-%m-%d-%H%M)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Cópia consistente mesmo com o sistema no ar, já conferida (ver implantar/copiar-banco.js).
node --disable-warning=ExperimentalWarning "$DESTINO/implantar/copiar-banco.js" \
  "$DESTINO/dados/network.db" "$TMP/banco.db"

cp -a "$DESTINO/.env" "$TMP/env" 2>/dev/null || true
if [ -d "$DESTINO/dados/arquivos" ]; then
  cp -a "$DESTINO/dados/arquivos" "$TMP/arquivos"
fi

PACOTE="$PASTA/manager-provedor-$CARIMBO.tar.gz"
tar -czf "$PACOTE" -C "$TMP" .
chmod 600 "$PACOTE"

# Limpeza do que passou do prazo.
find "$PASTA" -name 'manager-provedor-*.tar.gz' -mtime "+$GUARDAR_DIAS" -delete

TAM="$(du -h "$PACOTE" | cut -f1)"
echo "$(date -Is) backup ok: $PACOTE ($TAM)"

# Backup que nunca saiu do servidor não é backup: mande-o para fora daqui.
# Exemplo, se houver rclone configurado:
#   rclone copy "$PACOTE" remoto:manager-provedor/
