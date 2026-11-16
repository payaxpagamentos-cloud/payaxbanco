#!/usr/bin/env bash
# =============================================================================
#  ZOE 360° — ativação em um comando: diagnóstico, portas, instalação no domínio,
#  cadeado (certificado) e conferência final.
#
#  Uso (no servidor, dentro da pasta do pacote extraído):
#    sudo bash instalacao/ativar.sh --email voce@empresa.com.br \
#         --dominio app.zoe360.com.br --empresas connectlink
#
#  --email      seu e-mail (master e aviso do certificado)
#  --dominio    o endereço da plataforma (app.<domínio>)
#  --empresas   subdomínios das empresas, separados por vírgula (ex.: connectlink,outra)
#  --sem-cadeado  pula o certificado (rode de novo depois que o DNS responder)
#
#  Não mexe em outros sistemas do servidor: o site do Opa, o Docker e o PostgreSQL
#  ficam como estão. O instalador só cria o site da ZOE no Nginx e desfaz se der erro.
# =============================================================================
set -uo pipefail

EMAIL=""; DOMINIO=""; EMPRESAS=""; CADEADO=1
while [ $# -gt 0 ]; do
  case "$1" in
    --email) EMAIL="${2:-}"; shift 2 ;;
    --dominio) DOMINIO="${2:-}"; shift 2 ;;
    --empresas) EMPRESAS="${2:-}"; shift 2 ;;
    --sem-cadeado) CADEADO=0; shift ;;
    *) echo "Opção desconhecida: $1"; exit 1 ;;
  esac
done

AQUI="$(cd "$(dirname "$0")/.." && pwd)"
ok()    { printf '  \033[32m✔\033[0m %s\n' "$*"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }
erro()  { printf '  \033[31m✘\033[0m %s\n' "$*"; }
titulo(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { erro "Rode com sudo (ou como root)."; exit 1; }
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { erro "Informe seu e-mail de verdade em --email."; exit 1; }
[[ "$DOMINIO" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { erro "Informe o endereço em --dominio (ex.: app.zoe360.com.br)."; exit 1; }
BASE="${DOMINIO#app.}"
NOMES=("$DOMINIO")
IFS=',' read -ra LISTA <<< "$EMPRESAS"
for e in "${LISTA[@]}"; do e="$(echo "$e" | tr -d ' ' | tr 'A-Z' 'a-z')"; [ -n "$e" ] && NOMES+=("$e.$BASE"); done

titulo "1. Diagnóstico antes de mexer"
echo "  Versão do pacote: $(head -1 "$AQUI/VERSAO" 2>/dev/null || echo '?')"
for s in zoe nginx; do
  if systemctl is-active --quiet "$s"; then ok "serviço $s ativo"; else aviso "serviço $s parado"; fi
done
if ss -ltn 2>/dev/null | grep -qE ':443 '; then ok "porta 443 em uso (esperado)"; else aviso "nada escutando na porta 443"; fi
if ss -ltn 2>/dev/null | grep -qE ':80 '; then ok "porta 80 em uso (esperado)"; else aviso "nada escutando na porta 80"; fi
IP_PUBLICO="$(curl -s --max-time 6 https://api.ipify.org || true)"
IPS_LOCAIS="$(hostname -I 2>/dev/null || true)"
echo "  IP público: ${IP_PUBLICO:-desconhecido} · IPs da máquina: ${IPS_LOCAIS:-?}"

titulo "2. Firewall"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ok "portas 80 e 443 liberadas no ufw"
  ufw status | grep -E '^(22|80|443)[/ ]' | sed 's/^/    /'
else
  ok "ufw desligado: nada a liberar aqui (confira também o firewall do provedor do servidor)"
fi

titulo "3. DNS"
DNS_OK=1
for n in "${NOMES[@]}"; do
  r="$(getent ahostsv4 "$n" 2>/dev/null | awk 'NR==1{print $1}')"
  if [ -z "$r" ]; then erro "$n ainda não responde no DNS (a propagação pode levar até 2 h)"; DNS_OK=0
  elif [ "$r" = "$IP_PUBLICO" ] || echo " $IPS_LOCAIS " | grep -q " $r "; then ok "$n → $r"
  else erro "$n aponta para $r, não para este servidor"; DNS_OK=0; fi
done

titulo "4. Instalação da ZOE"
# Com o DNS pronto, instala no domínio. Sem ele, instala pelo IP: assim ninguém perde o acesso
# enquanto o DNS propaga. Depois é só rodar este mesmo comando de novo.
if [ "$DNS_OK" = 1 ]; then
  MODO=(--dominio "$DOMINIO"); echo "  Modo: domínio ($DOMINIO)"
else
  [ -n "$IP_PUBLICO" ] || { erro "Não descobri o IP público do servidor. Rode de novo quando o DNS responder."; exit 1; }
  MODO=(--ip "$IP_PUBLICO"); aviso "Modo: IP ($IP_PUBLICO), porque o DNS ainda não está pronto. Rode de novo depois."
fi
if ! bash "$AQUI/instalacao/instalar.sh" "${MODO[@]}" --email "$EMAIL"; then
  erro "O instalador parou. As últimas linhas acima mostram o motivo. Nada do Opa foi alterado."
  exit 1
fi
ok "ZOE instalada"

titulo "5. Cadeado (certificado)"
if [ "$CADEADO" = 0 ]; then
  aviso "pulado (--sem-cadeado)"
elif [ "$DNS_OK" = 0 ]; then
  aviso "o DNS ainda não está pronto: a ZOE ficou pelo IP (https://$IP_PUBLICO/atendimento/). Quando o DNS responder, rode de novo este comando."
else
  if ! command -v certbot >/dev/null; then apt-get install -y -qq certbot python3-certbot-nginx >/dev/null 2>&1; fi
  ARGS=(); for n in "${NOMES[@]}"; do ARGS+=(-d "$n"); done
  if certbot --nginx --non-interactive --agree-tos -m "$EMAIL" --redirect --expand "${ARGS[@]}"; then
    ok "cadeado emitido para: ${NOMES[*]}"
  else
    erro "o certbot não conseguiu. Confira se a porta 80 está aberta para a internet (firewall do provedor) e rode de novo."
  fi
fi

titulo "6. Conferência"
[ "$DNS_OK" = 1 ] || NOMES=()
for n in "${NOMES[@]}"; do
  c="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$n:443:127.0.0.1" "https://$n/atendimento/" || true)"
  if [ "$c" = 200 ]; then ok "https://$n/atendimento/ responde (200)"; else aviso "https://$n/atendimento/ respondeu ${c:-nada} aqui dentro"; fi
done
echo
if [ "$DNS_OK" = 1 ]; then
  echo "  Agora abra no navegador: https://$DOMINIO/atendimento/"
  [ "${#NOMES[@]}" -gt 1 ] && echo "  E o endereço da empresa: https://${NOMES[1]}/atendimento/"
else
  echo "  Por enquanto, abra pelo IP: https://$IP_PUBLICO/atendimento/ (aviso de \"não seguro\": Avançado › Continuar)"
fi
echo "  Se o e-mail do master ainda for SEU-EMAIL: sudo zoe-senha SEU-EMAIL --novo-email $EMAIL"
echo
