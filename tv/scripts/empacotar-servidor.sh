#!/usr/bin/env bash
#
# Monta o pacote da plataforma para enviar ao servidor, em .zip e .tar.gz.
#
#   bash scripts/empacotar-servidor.sh            # carimba a versão e gera os dois
#   bash scripts/empacotar-servidor.sh 2026.12.01 # com uma versão escolhida
#
# Existe para a lista de exclusões ficar num lugar só. Montar à mão é onde o erro acontece: o
# "-x" do zip casa com o caminho inteiro, então 'key.properties' sozinho NÃO pega
# 'celular-apps/android/key.properties' — e a senha da chave de assinatura dos apps iria junto.
# No fim o script confere o que entrou e se recusa a entregar um pacote com segredo dentro.

set -euo pipefail

RAIZ=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$RAIZ"
mkdir -p dist

node scripts/versao.js "${1:-}"
VERSAO=$(node -p "require('./versao.json').versao")

# Fora do pacote: dependências (recriadas no build), dados do servidor, saídas de compilação,
# e TUDO que é chave ou segredo.
EXCLUIR_TAR=(--exclude=node_modules --exclude=data --exclude=dist --exclude=.git
  --exclude=build --exclude=.gradle --exclude='*.jks' --exclude='*.keystore'
  --exclude='key.properties' --exclude='.env' --exclude='*.p8' --exclude='*.p12'
  --exclude='*.mobileprovision')
# No zip o padrão precisa do '*' na frente para valer em qualquer nível.
EXCLUIR_ZIP=('node_modules/*' 'data/*' 'dist/*' '.git/*' '*/build/*' 'build/*'
  '*/.gradle/*' '.gradle/*' '*.jks' '*.keystore' '*key.properties' '.env'
  '*.p8' '*.p12' '*.mobileprovision')

TGZ="dist/PLAYTECHVIP-servidor.tar.gz"
ZIP="dist/PLAYTECHVIP-servidor.zip"
rm -f "$TGZ" "$ZIP"

tar "${EXCLUIR_TAR[@]}" -czf "$TGZ" .
zip -qr "$ZIP" . -x "${EXCLUIR_ZIP[@]}"

# ---- conferência: o que não pode sair daqui ----
PROIBIDO='(^|/)(key\.properties|\.env)$|\.(jks|keystore|p8|p12|mobileprovision)$|(^|/)node_modules/|(^|/)data/'
falhou=0
conferir() {
  local nome="$1" lista="$2"
  local achados
  achados=$(printf '%s\n' "$lista" | grep -nE "$PROIBIDO" || true)
  if [ -n "$achados" ]; then
    printf '\033[31m✗ %s contém o que não devia sair:\033[0m\n' "$nome"
    printf '%s\n' "$achados" | head -10 | sed 's/^/    /'
    falhou=1
  else
    printf '\033[32m✓\033[0m %s: %s arquivos, %s\n' "$nome" "$(printf '%s\n' "$lista" | grep -c .)" "$(du -h "$nome" | cut -f1)"
  fi
}
# Lista cada pacote UMA vez. Nada de "| grep -q" aqui: com pipefail ligado, o grep sai ao
# primeiro acerto, o tar leva SIGPIPE e o pipeline inteiro passa por falho mesmo dando certo.
LISTA_TGZ=$(tar -tzf "$TGZ" | sed 's|^\./||')
LISTA_ZIP=$(unzip -Z1 "$ZIP")
conferir "$TGZ" "$LISTA_TGZ"
conferir "$ZIP" "$LISTA_ZIP"

# O pacote precisa ser reconhecível pelo painel e pelo agente.
for par in "$TGZ|$LISTA_TGZ" "$ZIP|$LISTA_ZIP"; do
  nome=${par%%|*}
  if ! printf '%s\n' "${par#*|}" | grep -E '(^|/)server/index\.js$' > /dev/null; then
    printf '\033[31m✗ %s não tem server/index.js\033[0m\n' "$nome"
    falhou=1
  fi
done

if [ "$falhou" = 1 ]; then
  rm -f "$TGZ" "$ZIP"
  echo "Pacotes apagados. Corrija as exclusões antes de enviar."
  exit 1
fi

printf '\nPacote %s pronto:\n  %s\n  %s\n' "$VERSAO" "$ZIP" "$TGZ"
