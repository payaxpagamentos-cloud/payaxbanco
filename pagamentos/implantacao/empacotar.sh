#!/usr/bin/env bash
# Gera o pacote de instalação: dist/payax-pagamentos-<data>.tar.gz (código + implantação, sem dados nem testes).
# Uso: npm run empacotar
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p dist
nome="payax-pagamentos-$(date +%Y%m%d-%H%M)"
tar --exclude=./node_modules --exclude=./data --exclude=./test --exclude=./dist --exclude=./.env \
  --transform "s,^\.,$nome," -czf "dist/$nome.tar.gz" .
echo "dist/$nome.tar.gz"
