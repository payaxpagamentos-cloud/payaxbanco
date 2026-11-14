#!/usr/bin/env bash
# PAY AX Pagamentos — o servidor RESERVA assume o lugar do principal (etapa 2).
#
# Antes de rodar: o principal tem que estar DESLIGADO (parado no console do AWS) ou fora do ar de vez.
# Dois servidores ativos pagariam o cliente duas vezes e estragariam a cópia contínua do banco.
#
# Uso: sudo /opt/payax/pagamentos/implantacao/assumir.sh
set -euo pipefail
DADOS=/var/lib/payax
ETC=/etc/payax
[[ $EUID -eq 0 ]] || { echo "Rode como root (sudo)." >&2; exit 1; }
[[ -f "$ETC/pagamentos.env" && -f /etc/litestream.yml ]] || { echo "Este servidor não foi preparado como reserva (instalar.sh --reserva)." >&2; exit 1; }
BUCKET="$(awk '/bucket:/ {print $2; exit}' /etc/litestream.yml)"
REGIAO="$(awk '/region:/ {print $2; exit}' /etc/litestream.yml)"

echo "Este servidor vai virar o PRINCIPAL. O principal antigo está DESLIGADO?"
read -r -p "Digite ASSUMIR para continuar: " resposta
[[ "$resposta" == "ASSUMIR" ]] || { echo "Nada foi feito."; exit 1; }

echo "== Restaurando o banco da cópia contínua (o estado de segundos atrás)"
systemctl stop payax-pagamentos litestream 2>/dev/null || true
if [[ -f "$DADOS/payax.db" ]]; then mv "$DADOS/payax.db" "$DADOS/payax.db.reserva-$(date +%Y%m%d%H%M%S)"; rm -f "$DADOS/payax.db-wal" "$DADOS/payax.db-shm"; fi
litestream restore -config /etc/litestream.yml "$DADOS/payax.db" \
  || { echo "Falha ao restaurar. Nada foi iniciado: confira o acesso ao bucket $BUCKET." >&2; exit 1; }
aws s3 sync "s3://$BUCKET/pagamentos/pastas" "$DADOS" --region "$REGIAO" --only-show-errors
chown -R payax:payax "$DADOS"
sqlite3 "$DADOS/payax.db" 'PRAGMA integrity_check;' | grep -qx ok || { echo "O banco restaurado não passou na conferência de integridade. Nada foi iniciado." >&2; exit 1; }

echo "== Ligando as rotinas e subindo"
sed -i 's/^PAYAX_ROTINAS=.*/PAYAX_ROTINAS=1/' "$ETC/pagamentos.env"
systemctl enable --now payax-pagamentos
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:3600/api/saude >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3600/api/saude && echo
systemctl enable --now litestream payax-copia-pastas.timer caddy
systemctl restart caddy

echo
echo "Falta UM passo no console do AWS: EC2 → IPs elásticos → associar o IP da PAY AX a ESTE servidor."
echo "Sem isso, o endereço continua apontando para o servidor antigo (guia, seção 'Se o servidor principal cair')."
