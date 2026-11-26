#!/usr/bin/env bash
#
# Agente de atualização da PLAY TECH VIP.
#
# Roda NO SERVIDOR (cron, a cada minuto), fora do contêiner. O painel só deposita o pacote numa
# pasta compartilhada; quem extrai e reconstrói é este script. É essa separação que evita dar ao
# contêiner acesso ao Docker do servidor — com ele, quem invadisse o app viraria root na máquina.
#
#   sudo bash scripts/atualizador.sh            # aplica se houver pedido
#   sudo bash scripts/atualizador.sh --instalar # instala no cron (o instalador já faz isso)
#
# Pasta compartilhada (montada no contêiner como /atualizacao):
#   pacote.tar.gz   enviado pelo painel
#   pedido.json     existe = há o que aplicar
#   estado.json     resultado da última tentativa, lido pelo painel
#   registro.log    saída da última atualização, mostrada no painel

set -uo pipefail

DESTINO=${DESTINO:-/opt/playtechvip}
PASTA=${TV_ATUALIZACAO_HOST:-/var/lib/playtechvip/atualizacao}
PACOTE="$PASTA/pacote.tar.gz"
PEDIDO="$PASTA/pedido.json"
ESTADO="$PASTA/estado.json"
REGISTRO="$PASTA/registro.log"
TRAVA="$PASTA/.trava"

mkdir -p "$PASTA"

if [ "${1:-}" = "--instalar" ]; then
  linha="* * * * * root DESTINO=$DESTINO bash $DESTINO/scripts/atualizador.sh >> $PASTA/cron.log 2>&1"
  echo "$linha" > /etc/cron.d/playtechvip-atualizador
  chmod 644 /etc/cron.d/playtechvip-atualizador
  # O contêiner roda como uid 1000 e precisa escrever o pedido aqui.
  chown -R 1000:1000 "$PASTA"
  echo "Agente de atualização instalado (verifica a cada minuto)."
  exit 0
fi

[ -f "$PEDIDO" ] || exit 0

# Duas execuções ao mesmo tempo derrubariam a plataforma no meio da reconstrução.
exec 9>"$TRAVA"
flock -n 9 || exit 0

inicio=$(date -Is)
registrar() { printf '%s\n' "$*" | tee -a "$REGISTRO" >&2; }
gravar_estado() {
  cat > "$ESTADO" <<FIM
{
  "situacao": "$1",
  "detalhe": $(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""'),
  "inicio": "$inicio",
  "fim": "$(date -Is)"
}
FIM
  chown 1000:1000 "$ESTADO" 2>/dev/null || true
}

: > "$REGISTRO"
registrar "[$(date -Is)] atualização pedida, começando"

if [ ! -s "$PACOTE" ]; then
  registrar "pacote não encontrado em $PACOTE"
  gravar_estado erro "O pacote não chegou ao servidor."
  rm -f "$PEDIDO"
  exit 1
fi

# Confere o pacote ANTES de mexer na instalação: um arquivo corrompido não pode deixar a
# plataforma pela metade. O teste abaixo lê o tar inteiro sem gravar nada.
if ! tar -tzf "$PACOTE" > /dev/null 2>>"$REGISTRO"; then
  registrar "pacote corrompido ou não é um .tar.gz"
  gravar_estado erro "O pacote está corrompido. Envie de novo."
  rm -f "$PEDIDO" "$PACOTE"
  exit 1
fi
# Aceita "./server/index.js" e "server/index.js": muda conforme como o tar foi montado.
if ! tar -tzf "$PACOTE" | grep -qE '(^|/)server/index\.js$'; then
  registrar "o pacote não tem server/index.js — não é a plataforma. O que veio dentro:"
  tar -tzf "$PACOTE" | head -15 | sed 's/^/    /' >> "$REGISTRO"
  gravar_estado erro "Este .tar.gz não é o pacote da plataforma."
  rm -f "$PEDIDO" "$PACOTE"
  exit 1
fi

# Guarda o .env e os dados: eles não vêm no pacote e não podem ser tocados.
registrar "extraindo em $DESTINO"
if ! tar -C "$DESTINO" -xzf "$PACOTE" >>"$REGISTRO" 2>&1; then
  registrar "falha ao extrair"
  gravar_estado erro "Não foi possível extrair o pacote no servidor."
  rm -f "$PEDIDO"
  exit 1
fi
chmod +x "$DESTINO"/scripts/*.sh 2>/dev/null || true

registrar "reconstruindo a imagem e subindo"
if ! (cd "$DESTINO" && docker compose up -d --build >>"$REGISTRO" 2>&1); then
  registrar "falha ao subir os contêineres"
  gravar_estado erro "A extração funcionou, mas a plataforma não subiu. Veja o registro."
  rm -f "$PEDIDO"
  exit 1
fi

# Espera a plataforma responder antes de dizer que deu certo.
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 4 "http://127.0.0.1:${PORTA_LOCAL:-3600}/api/saude" > /dev/null 2>&1; then ok=1; break; fi
  sleep 2
done

versao=$(python3 -c "import json;print(json.load(open('$DESTINO/versao.json'))['versao'])" 2>/dev/null || echo 'desconhecida')
if [ "$ok" = 1 ]; then
  registrar "[$(date -Is)] atualizada para $versao"
  gravar_estado concluida "Atualizada para $versao."
else
  registrar "[$(date -Is)] subiu, mas a plataforma não respondeu a tempo"
  gravar_estado erro "Os contêineres subiram, mas a plataforma não respondeu. Veja o registro."
fi

rm -f "$PEDIDO" "$PACOTE"
chown 1000:1000 "$REGISTRO" 2>/dev/null || true
