#!/usr/bin/env bash
#
# Vai Mídia — atualização pedida pelo painel (Configurações › Sistema › Atualizar sistema).
#
# Quem chama é o systemd (vaimidia-atualizar.service), como root, quando o painel deixa um pedido.
# O passo a passo:
#   1. confere o pacote (é um zip inteiro? tem o sistema dentro?);
#   2. guarda uma cópia da versão que está no ar;
#   3. instala a nova com o atualizar.sh que veio NO PACOTE (é ele que sabe instalar aquela versão);
#   4. confere se o sistema voltou a responder;
#   5. se não voltou, põe a cópia de volta e reinicia — o sistema nunca fica fora do ar por causa disso.
# O andamento vai para estado.json (o painel mostra) e o detalhe para ultima.log.
#
set -Euo pipefail

DADOS="${VAIMIDIA_DADOS:-/var/lib/vaimidia}"
PASTA="$DADOS/atualizacao"
DESTINO="${VAIMIDIA_DESTINO:-/opt/vaimidia}"
ANTERIOR="$DESTINO.anterior"
ENV="${VAIMIDIA_ENV:-/etc/vaimidia/vaimidia.env}"
LOG="$PASTA/ultima.log"

# O atualizar.sh troca o conteúdo de /opt/vaimidia, inclusive este arquivo. O bash lê o script aos
# pedaços enquanto roda, então trocar o arquivo no meio quebraria a execução: roda-se de uma cópia.
if [[ "${VAIMIDIA_COPIA:-}" != "1" ]]; then
  COPIA="$(mktemp /run/vaimidia-atualizar.XXXXXX)"
  cp "$0" "$COPIA"
  VAIMIDIA_COPIA=1 exec bash "$COPIA" "$@"
fi
trap 'rm -f "$0"' EXIT

PEDIDO="$(cat "$PASTA/pedido" 2>/dev/null || true)"
[[ "$PEDIDO" == \{* ]] || PEDIDO='{}'
# Primeira coisa: tira o pedido, senão o systemd chamaria de novo enquanto ele existir.
rm -f "$PASTA/pedido"

estado() { # estado <etapa> <mensagem>
  local tmp="$PASTA/estado.json.parcial"
  local msg="${2//\\/\\\\}"; msg="${msg//\"/\\\"}"
  printf '{"etapa":"%s","mensagem":"%s","atualizado_em":"%s","pedido":%s}\n' \
    "$1" "$msg" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PEDIDO" > "$tmp"
  chown vaimidia:vaimidia "$tmp"; chmod 640 "$tmp"
  mv -f "$tmp" "$PASTA/estado.json"
  echo "[$(date '+%H:%M:%S')] $1: $2" >> "$LOG"
}

: > "$LOG"; chown vaimidia:vaimidia "$LOG"; chmod 640 "$LOG"
exec >> "$LOG" 2>&1

TEMP="$(mktemp -d /var/tmp/vaimidia-pacote.XXXXXX)"
limpar() { rm -rf "$TEMP"; rm -f "$PASTA/pacote.zip"; }

responde() { # o sistema está de pé? (a página do player é servida sem login)
  local porta base
  porta="$(sed -n 's/^PORT=//p' "$ENV" 2>/dev/null | tail -1)"; porta="${porta:-3600}"
  base="$(sed -n 's/^MIDIA_BASE_PATH=//p' "$ENV" 2>/dev/null | tail -1)"; base="${base:-/midia}"
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$porta${base%/}/tv/" && return 0
    sleep 2
  done
  return 1
}

estado conferindo "Conferindo o pacote enviado"
if [[ ! -f "$PASTA/pacote.zip" ]]; then estado falhou "O pacote não chegou ao servidor. Envie de novo."; limpar; exit 1; fi
command -v unzip >/dev/null 2>&1 || { apt-get install -y unzip >/dev/null 2>&1 || true; }
if ! unzip -tq "$PASTA/pacote.zip" >/dev/null 2>&1; then
  estado falhou "O arquivo está corrompido ou incompleto. Baixe o vaimidia.zip de novo e envie."; limpar; exit 1
fi
unzip -q "$PASTA/pacote.zip" -d "$TEMP"
NOVO=""
for c in "$TEMP/vaimidia" "$TEMP"; do
  [[ -f "$c/package.json" && -f "$c/server/index.js" && -f "$c/instalacao/atualizar.sh" ]] && { NOVO="$c"; break; }
done
if [[ -z "$NOVO" ]] || ! grep -q '"name": "payax-midia"' "$NOVO/package.json"; then
  estado falhou "Este zip não é o pacote do sistema (vaimidia.zip). Nada foi mudado."; limpar; exit 1
fi

# Só entra pacote assinado por nós. A chave pública usada é a que JÁ ESTÁ no servidor, nunca a do pacote.
CHAVE_PUB="/etc/vaimidia/assinatura-publica.pem"
[[ -f "$CHAVE_PUB" ]] || CHAVE_PUB="$DESTINO/instalacao/assinatura-publica.pem"
if ! node "$DESTINO/instalacao/conferir-assinatura.js" "$NOVO" "$CHAVE_PUB"; then
  estado falhou "Este pacote não tem a assinatura do Vai Mídia. Nada foi mudado."; limpar; exit 1
fi

estado guardando "Guardando uma cópia da versão que está no ar"
rm -rf "$ANTERIOR"
cp -a "$DESTINO" "$ANTERIOR"

estado instalando "Instalando a versão nova (leva cerca de 1 minuto)"
chmod +x "$NOVO"/instalacao/*.sh
if bash "$NOVO/instalacao/atualizar.sh" && estado testando "Conferindo se o sistema voltou" && responde; then
  estado concluida "Sistema atualizado. Recarregue a página."
  limpar
  exit 0
fi

estado revertendo "A versão nova não subiu. Voltando para a anterior"
rm -rf "$DESTINO"
cp -a "$ANTERIOR" "$DESTINO"
systemctl restart vaimidia
if responde; then
  estado revertida "A versão nova não subiu e o sistema voltou para a anterior. Nada mudou no ar. Veja o registro abaixo."
else
  estado falhou "A versão nova não subiu e a anterior também não respondeu. Rode no servidor: sudo journalctl -u vaimidia -n 80"
fi
limpar
exit 1
