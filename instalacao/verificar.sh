#!/usr/bin/env bash
# Confere se a ZOE está no ar: o serviço, a resposta do painel e o que o servidor precisa alcançar.
#   sudo zoe-verificar
set -u
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
ruim() { printf '  \033[31m✘\033[0m %s\n' "$*"; FALHOU=1; }
FALHOU=0
ZOE_PORTA=3600
# shellcheck disable=SC1091
[ -f /etc/zoe.conf ] && . /etc/zoe.conf
echo "Serviço:"
if systemctl is-active --quiet zoe; then
  if curl -fsS -m 5 "http://127.0.0.1:$ZOE_PORTA/atendimento/api/saude" >/dev/null; then ok "zoe no ar (porta $ZOE_PORTA)"
  else ruim "zoe ativo, mas /atendimento/api/saude não respondeu — journalctl -u zoe -n 50"; fi
else
  ruim "zoe parado — journalctl -u zoe -n 50"
fi
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
