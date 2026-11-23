#!/usr/bin/env bash
#
# Envia a plataforma para o servidor e instala lá, de uma vez.
#
# Rode na SUA máquina (onde está este código), não no servidor:
#
#   bash scripts/enviar-servidor.sh playtv@45.190.156.250 --porta 62052 --sem-dominio
#   bash scripts/enviar-servidor.sh playtv@45.190.156.250 --porta 62052 play.seudominio.com.br
#   bash scripts/enviar-servidor.sh playtv@45.190.156.250 --porta 62052 --so-enviar
#
# O que acontece:
#   1. confere se o SSH responde;
#   2. copia o código (sem node_modules, sem data, sem dist) para o servidor;
#   3. instala em /opt/playtechvip e roda o instalador, que cuida de Docker, .env, HTTPS,
#      backup e conferência.
#
# Precisa de: ssh e tar na sua máquina, e um usuário com sudo no servidor (não precisa ser
# root: o sudo é pedido na hora, e a senha pode ser digitada normalmente).

set -euo pipefail

ALVO=""
PORTA=22
DOMINIO=""
SO_ENVIAR=0
DESTINO=${DESTINO:-/opt/playtechvip}

while [ $# -gt 0 ]; do
  case "$1" in
    --porta|-p) PORTA="$2"; shift 2 ;;
    --teste|--sem-dominio) DOMINIO="--sem-dominio"; shift ;;
    --so-enviar) SO_ENVIAR=1; shift ;;
    --ajuda|-h) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Opção desconhecida: $1"; exit 1 ;;
    *) if [ -z "$ALVO" ]; then ALVO="$1"; else DOMINIO="$1"; fi; shift ;;
  esac
done

azul() { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
erro() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }

if [ -z "$ALVO" ]; then
  erro "Informe o servidor. Exemplo:"
  erro "  bash $0 playtv@45.190.156.250 --porta 62052 --sem-dominio"
  exit 1
fi
if [ -z "$DOMINIO" ] && [ "$SO_ENVIAR" = 0 ]; then
  erro "Informe o domínio (ou --sem-dominio para subir num endereço de teste, no próprio IP)."
  exit 1
fi

RAIZ=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SSH=(ssh -p "$PORTA" -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$ALVO")

azul "1. Conexão com $ALVO (porta $PORTA)"
if ! "${SSH[@]}" "echo conectado" >/dev/null 2>&1; then
  erro "não consegui entrar por SSH."
  erro "Confira o usuário, a porta e se a sua chave está no servidor:"
  erro "  ssh-copy-id -p $PORTA $ALVO"
  exit 1
fi
ok "SSH respondendo"
ok "servidor: $("${SSH[@]}" '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -a')"

azul "2. Enviando os arquivos"
EXCLUIR=(--exclude=node_modules --exclude=data --exclude=dist --exclude=.git --exclude=build
         --exclude=.gradle --exclude='*.jks' --exclude=key.properties)
TAMANHO=$(tar -C "$RAIZ" "${EXCLUIR[@]}" -czf - . | wc -c)
printf '  %s MB compactados\n' "$((TAMANHO / 1024 / 1024 + 1))"
# Vai primeiro para /tmp, que não precisa de sudo; a instalação em /opt vem no passo seguinte,
# num terminal de verdade, onde o sudo pode pedir a senha.
tar -C "$RAIZ" "${EXCLUIR[@]}" -czf - . | "${SSH[@]}" "cat > /tmp/playtechvip.tar.gz"
ok "pacote no servidor, em /tmp/playtechvip.tar.gz"

ABRIR="sudo mkdir -p '$DESTINO' && sudo tar -C '$DESTINO' -xzf /tmp/playtechvip.tar.gz && sudo chmod +x '$DESTINO'/scripts/*.sh"

if [ "$SO_ENVIAR" = 1 ]; then
  echo
  azul "Enviado. Para instalar, entre no servidor e rode:"
  echo "  ssh -p $PORTA $ALVO"
  echo "  $ABRIR"
  echo "  sudo bash $DESTINO/scripts/instalar-servidor.sh --sem-dominio"
  exit 0
fi

azul "3. Instalando em $DESTINO"
echo "  (o sudo do servidor pode pedir a senha de $ALVO)"
"${SSH[@]}" -t "$ABRIR && sudo PORTA_SSH=$PORTA bash '$DESTINO/scripts/instalar-servidor.sh' '$DOMINIO'"
