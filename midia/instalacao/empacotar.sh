#!/usr/bin/env bash
#
# Vai Mídia — gera o vaimidia.zip ASSINADO, a partir do que está gravado no git (HEAD).
#
#   midia/instalacao/empacotar.sh /caminho/de/saida/vaimidia.zip
#
# A chave privada fica em midia-chaves/ (fora de midia/, nunca entra no pacote). O servidor confere a
# assinatura com instalacao/assinatura-publica.pem antes de instalar pelo painel.
#
set -Eeuo pipefail
SAIDA="$(realpath -m "${1:?informe o caminho do vaimidia.zip}")"
RAIZ="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
CHAVE="${VAIMIDIA_CHAVE:-$RAIZ/midia-chaves/assinatura-privada.pem}"
[[ -f "$CHAVE" ]] || { echo "ERRO: não achei a chave privada em $CHAVE"; exit 1; }

TEMP="$(mktemp -d)"; trap 'rm -rf "$TEMP"' EXIT
git -C "$RAIZ" archive --prefix=vaimidia/ HEAD:midia | tar -x -C "$TEMP"
cd "$TEMP/vaimidia"
find . -type f ! -path './instalacao/MANIFESTO' ! -path './instalacao/MANIFESTO.sig' -printf '%P\n' | LC_ALL=C sort \
  | while IFS= read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done > instalacao/MANIFESTO
node -e "
const c=require('crypto'),fs=require('fs');
fs.writeFileSync('instalacao/MANIFESTO.sig', c.sign(null, fs.readFileSync('instalacao/MANIFESTO'), c.createPrivateKey(fs.readFileSync(process.argv[1]))).toString('base64')+'\n');
" "$CHAVE"
node instalacao/conferir-assinatura.js . instalacao/assinatura-publica.pem
rm -f "$SAIDA"; cd "$TEMP" && zip -qr "$SAIDA" vaimidia
echo "Pacote assinado: $SAIDA ($(du -h "$SAIDA" | cut -f1))"
