#!/usr/bin/env bash
#
# Emite (ou refaz) o certificado HTTPS da plataforma.
#
# Rode no servidor, depois que as portas 80 e 443 estiverem chegando nele:
#
#   sudo bash scripts/certificado.sh                    # usa o domínio do .env
#   sudo bash scripts/certificado.sh play.dominio.com.br  # troca o domínio e emite
#
# O que ele faz:
#   1. confere se o mundo enxerga ESTE servidor no domínio (é o que a Let's Encrypt faz);
#   2. limpa a tentativa anterior presa no servidor de testes da Let's Encrypt;
#   3. reinicia o proxy e acompanha a emissão;
#   4. confirma pelo certificado que está no ar.

set -euo pipefail

DESTINO=${DESTINO:-/opt/playtechvip}
cd "$DESTINO"

azul()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }
erro()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }

NOVO=${1:-}
if [ -n "$NOVO" ]; then
  sed -i "s|^DOMINIO=.*|DOMINIO=$NOVO|" .env
  ok "domínio trocado para $NOVO no .env"
fi
DOMINIO=$(grep -E '^DOMINIO=' .env | cut -d= -f2-)
[ -n "$DOMINIO" ] || { erro "sem DOMINIO no .env"; exit 1; }

azul "1. O mundo chega neste servidor pelo domínio $DOMINIO?"

# A Let's Encrypt vai bater na porta 80 do domínio. Se quem responder não for a nossa
# plataforma, o certificado nunca sai — e é esse o erro mais comum (NAT, outro servidor no IP).
RESPOSTA=$(curl -s --max-time 15 "http://$DOMINIO/api/saude" || true)
case "$RESPOSTA" in
  *'"ok":true'*)
    ok "sim: quem responde em http://$DOMINIO é esta plataforma"
    ;;
  "")
    erro "ninguém respondeu em http://$DOMINIO (porta 80 fechada ou DNS sem apontar)"
    erro "Peça o encaminhamento das portas 80 e 443 para este servidor antes de seguir."
    exit 1
    ;;
  *)
    erro "quem responde em http://$DOMINIO NÃO é esta plataforma."
    erro "Resposta recebida: $(printf '%s' "$RESPOSTA" | head -c 120)"
    erro "O tráfego do domínio está indo para outra máquina (NAT do provedor ou DNS errado)."
    exit 1
    ;;
esac

azul "2. Limpando a tentativa anterior"

# Depois de várias falhas o Caddy cai no servidor de testes da Let's Encrypt, cujo certificado
# o navegador não aceita. Apagar esse estado faz ele tentar de novo no servidor de verdade.
docker compose exec -T proxy sh -c 'rm -rf /data/caddy/certificates/acme-staging-v02.api.letsencrypt.org-directory' 2>/dev/null \
  && ok "estado de teste removido" || aviso "nada a limpar"

azul "3. Emitindo o certificado"
docker compose restart proxy >/dev/null
printf '  aguardando'
EMITIDO=0
for _ in $(seq 1 40); do
  if docker compose logs --since 2m proxy 2>/dev/null | grep -q "certificate obtained successfully"; then EMITIDO=1; break; fi
  printf '.'; sleep 5
done
printf '\n'

if [ "$EMITIDO" = 1 ]; then
  ok "certificado emitido"
else
  aviso "ainda não apareceu a confirmação; veja o log:"
  docker compose logs --tail 15 proxy | sed 's/^/      /'
fi

azul "4. Conferindo de fora"
EMISSOR=$(echo | openssl s_client -connect "$DOMINIO:443" -servername "$DOMINIO" 2>/dev/null \
  | openssl x509 -noout -issuer 2>/dev/null || true)
NOME=$(echo | openssl s_client -connect "$DOMINIO:443" -servername "$DOMINIO" 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null || true)
[ -n "$EMISSOR" ] && echo "  $EMISSOR" || aviso "não consegui ler o certificado"
[ -n "$NOME" ] && echo "  $NOME" || true

case "$EMISSOR" in
  *"(STAGING)"*|*"Fake"*) erro "ainda é certificado de teste — rode este script de novo em alguns minutos" ;;
  *"Let's Encrypt"*|*"ZeroSSL"*) ok "certificado válido no ar" ;;
esac

echo
azul "Pronto."
echo "  App do assinante  : https://$DOMINIO/"
echo "  Painel da operação: https://$DOMINIO/admin/"
echo "  Conferência       : BASE=https://$DOMINIO bash $DESTINO/scripts/conferir-instalacao.sh"
