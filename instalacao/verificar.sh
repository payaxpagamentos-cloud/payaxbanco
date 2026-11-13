#!/usr/bin/env bash
# Confere se a ZOE está no ar: serviços, resposta de cada painel e o que o servidor precisa alcançar.
#   sudo zoe-verificar
set -u
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
ruim() { printf '  \033[31m✘\033[0m %s\n' "$*"; FALHOU=1; }
FALHOU=0
declare -A PORTA=([atendimento]=3600 [pabx]=3300 [network]=3500)
echo "Serviços:"
for m in atendimento pabx network; do
  systemctl list-unit-files "zoe-$m.service" >/dev/null 2>&1 || continue
  [ -f "/etc/systemd/system/zoe-$m.service" ] || continue
  if systemctl is-active --quiet "zoe-$m"; then
    if curl -fsS -m 5 "http://127.0.0.1:${PORTA[$m]}/$m/api/saude" >/dev/null; then ok "zoe-$m no ar (porta ${PORTA[$m]})"
    else ruim "zoe-$m ativo, mas /$m/api/saude não respondeu — journalctl -u zoe-$m -n 50"; fi
  else
    ruim "zoe-$m parado — journalctl -u zoe-$m -n 50"
  fi
done
if [ -f /etc/systemd/system/zoe-whisper.service ]; then
  systemctl is-active --quiet zoe-whisper && ok "transcrição de áudio (whisper) no ar" || ruim "zoe-whisper parado"
fi
echo "Saída para a internet (o que o servidor precisa alcançar):"
for alvo in "graph.facebook.com|Meta (WhatsApp)" "olinda.bcb.gov.br|Banco Central (dólar do dia)" "api.anthropic.com|inteligência da ZOE"; do
  host="${alvo%%|*}"; nome="${alvo##*|}"
  if curl -s -o /dev/null -m 8 "https://$host"; then ok "$nome ($host)"; else ruim "$nome ($host) inacessível — confira firewall/proxy"; fi
done
[ "$FALHOU" = 0 ] && echo "Tudo certo." || echo "Há itens para resolver acima."
exit "$FALHOU"
