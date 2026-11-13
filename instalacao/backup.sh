#!/usr/bin/env bash
# Cópia diária dos bancos da ZOE (cópia consistente, com o sistema no ar) e dos arquivos recebidos.
# Guarda 14 dias em /var/backups/zoe. Rodado pelo cron às 03:17; pode rodar à mão: sudo zoe-backup
set -euo pipefail
DADOS=/var/lib/zoe
COPIAS=/var/backups/zoe
DIA=$(date +%F)
mkdir -p "$COPIAS/$DIA"
for db in "$DADOS"/atendimento/atendimento.db "$DADOS"/pabx/pabx.db "$DADOS"/network/network.db; do
  [ -f "$db" ] || continue
  sqlite3 "$db" ".backup '$COPIAS/$DIA/$(basename "$db")'"
done
# Arquivos recebidos (fotos, áudios, documentos, anexos): cópia incremental.
for pasta in "$DADOS"/atendimento/arquivos "$DADOS"/network/arquivos; do
  [ -d "$pasta" ] && rsync -a "$pasta/" "$COPIAS/arquivos-$(basename "$(dirname "$pasta")")/"
done
gzip -f "$COPIAS/$DIA"/*.db 2>/dev/null || true
chmod -R go-rwx "$COPIAS"
find "$COPIAS" -maxdepth 1 -type d -name '20*' -mtime +14 -exec rm -rf {} +
echo "Cópia em $COPIAS/$DIA"
