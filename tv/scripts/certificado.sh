#!/usr/bin/env bash
#
# Emite (ou refaz) o certificado HTTPS da plataforma, e serve também para trocar o endereço.
#
# Rode no servidor, com as portas 80 e 443 já chegando nele:
#
#   sudo bash scripts/certificado.sh                        # usa o domínio do .env
#   sudo bash scripts/certificado.sh play.dominio.com.br    # troca o domínio e emite
#
# O que ele faz:
#   1. confere se o mundo, usando esse endereço, chega NESTE servidor;
#   2. grava o endereço novo, se foi informado;
#   3. limpa a tentativa presa no servidor de testes da Let's Encrypt;
#   4. sobe o proxy com o endereço novo e acompanha a emissão;
#   5. confirma pelo lado de fora que o certificado está valendo.

set -euo pipefail

DESTINO=${DESTINO:-/opt/playtechvip}
cd "$DESTINO"

azul()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }
erro()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }

VERSAO="2026-11-25"   # impresso no início: mostra de cara se o pacote no servidor é o atual
printf '\033[2mcertificado.sh %s\033[0m\n\n' "$VERSAO"

ATUAL=$(grep -E '^DOMINIO=' .env | cut -d= -f2-)
DOMINIO=${1:-$ATUAL}
[ -n "$DOMINIO" ] || { erro "informe o domínio: sudo bash $0 play.dominio.com.br"; exit 1; }

azul "1. O endereço $DOMINIO chega neste servidor?"

# A Let's Encrypt valida pela porta 80, e quem responde ali precisa ser o nosso proxy. Este teste
# sai de dentro do servidor em direção ao próprio IP público — muita rede não devolve esse
# caminho (NAT sem hairpin), então o silêncio não prova nada e só vira aviso. O que faz parar é
# OUTRA máquina respondendo: aí a validação iria para o lugar errado e queimaria tentativa.
CABECALHO=$(curl -sSi --max-time 15 "http://$DOMINIO/.well-known/acme-challenge/teste-playtechvip" 2>/dev/null || true)
if [ -z "$CABECALHO" ]; then
  aviso "daqui de dentro ninguém respondeu em http://$DOMINIO"
  aviso "Normal quando a rede não devolve o próprio IP público para dentro; de fora pode estar"
  aviso "chegando. Sigo em frente — a emissão no passo 4 é o teste de verdade."
elif printf '%s' "$CABECALHO" | grep -qi '^server: *Caddy'; then
  ok "sim: quem atende na porta 80 é o proxy desta instalação"
else
  erro "quem responde em http://$DOMINIO não é este servidor:"
  printf '%s\n' "$CABECALHO" | head -5 | sed 's/^/      /'
  erro "O tráfego está indo para outra máquina; a validação da Let's Encrypt cairia lá."
  erro "Fale com o provedor sobre o encaminhamento das portas 80 e 443 para esta máquina."
  exit 1
fi

azul "2. Endereço da plataforma"
if [ "$DOMINIO" != "$ATUAL" ]; then
  sed -i "s|^DOMINIO=.*|DOMINIO=$DOMINIO|" .env
  ok "trocado: $ATUAL → $DOMINIO"
else
  ok "mantido: $DOMINIO"
fi

azul "3. Limpando a tentativa anterior"
# Depois de várias falhas o Caddy passa a usar o servidor de testes da Let's Encrypt, cujo
# certificado o navegador recusa. Apagar esse estado faz ele tentar de novo no servidor real.
if docker compose exec -T proxy sh -c 'rm -rf /data/caddy/certificates/acme-staging-v02.api.letsencrypt.org-directory' 2>/dev/null; then
  ok "estado de teste removido"
else
  aviso "nada a limpar (ou o proxy está parado)"
fi

azul "4. Emitindo o certificado"
docker compose up -d >/dev/null
docker compose restart proxy >/dev/null
printf '  aguardando'
EMITIDO=0
for _ in $(seq 1 48); do
  if docker compose logs --since 3m proxy 2>/dev/null | grep -q "certificate obtained successfully"; then EMITIDO=1; break; fi
  printf '.'; sleep 5
done
printf '\n'
[ "$EMITIDO" = 1 ] && ok "certificado emitido" || aviso "sem confirmação ainda; o log vai abaixo"

azul "5. Conferindo pelo lado de fora"
RESPOSTA=$(curl -sS --max-time 20 "https://$DOMINIO/api/saude" 2>&1 || true)
case "$RESPOSTA" in
  *'"ok":true'*) ok "a plataforma responde em https://$DOMINIO (certificado aceito)" ;;
  *certificate*|*SSL*|*TLS*|*tls*)
    aviso "o HTTPS ainda não está valendo: $(printf '%s' "$RESPOSTA" | head -c 110)"
    docker compose logs --tail 12 proxy | sed 's/^/      /'
    ;;
  *) aviso "resposta inesperada: $(printf '%s' "$RESPOSTA" | head -c 110)" ;;
esac

echo
azul "Pronto."
echo "  App do assinante  : https://$DOMINIO/"
echo "  Painel da operação: https://$DOMINIO/admin/"
echo "  Conferência       : BASE=https://$DOMINIO bash $DESTINO/scripts/conferir-instalacao.sh"
