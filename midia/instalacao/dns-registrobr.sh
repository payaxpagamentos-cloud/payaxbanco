#!/usr/bin/env bash
#
# Vai Mídia — os registros de DNS prontos para colar no Registro.br.
#
# Roda no servidor, depois da instalação, e imprime cada registro no formato que o Registro.br aceita,
# já com o IP desta máquina e com a chave DKIM dividida em pedaços (um registro TXT não aceita mais de
# 255 letras de uma vez — é o erro que mais trava gente nessa tela).
#
#   ./dns-registrobr.sh --dominio vaimidia.com.br
#
# Não altera nada: só mostra o que colar.
#
set -uo pipefail

DOMINIO=""
SELETOR="vaimidia"
CHAVE="/etc/vaimidia/dkim.pem"
IP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dominio) DOMINIO="${2:-}"; shift 2 ;;
    --ip) IP="${2:-}"; shift 2 ;;
    --seletor) SELETOR="${2:-}"; shift 2 ;;
    --chave) CHAVE="${2:-}"; shift 2 ;;
    *) echo "Uso: ./dns-registrobr.sh --dominio SEU.DOMINIO [--ip IP] [--seletor vaimidia] [--chave /etc/vaimidia/dkim.pem]"; exit 2 ;;
  esac
done
[[ -n "$DOMINIO" ]] || { echo "Uso: ./dns-registrobr.sh --dominio SEU.DOMINIO"; exit 2; }
[[ -n "$IP" ]] || IP="$(curl -s --max-time 6 https://api.ipify.org || echo 'SEU.IP')"

# A chave pública do DKIM sai da privada; em pedaços de 255, porque é o limite de cada trecho de TXT.
DKIM_PUB=""
if [[ -r "$CHAVE" ]]; then
  DKIM_PUB="$(openssl rsa -in "$CHAVE" -pubout 2>/dev/null | grep -v 'PUBLIC KEY' | tr -d '\n')"
elif [[ -f "$CHAVE" ]]; then
  echo "AVISO: sem permissão para ler $CHAVE. Rode com sudo para sair a linha do DKIM." >&2
fi

dkim_em_partes() {
  local valor="v=DKIM1; k=rsa; p=$DKIM_PUB" saida="" pedaco
  while [[ -n "$valor" ]]; do
    pedaco="${valor:0:255}"
    valor="${valor:255}"
    saida+="\"$pedaco\" "
  done
  echo "${saida% }"
}

echo
echo "==================================================================="
echo " REGISTRO.BR — $DOMINIO"
echo " Painel: registro.br › Meus domínios › $DOMINIO › DNS › Editar zona"
echo "==================================================================="
echo
echo "A tela tem três campos por linha. Preencha assim:"
echo
printf ' %-22s | %-5s | %s\n' "NOME (campo 1)" "TIPO" "DADOS (campo 3)"
printf ' %-22s-+-%-5s-+-%s\n' "----------------------" "-----" "------------------------------------------"
printf ' %-22s | %-5s | %s\n' "(deixe em branco)" "A" "$IP"
printf ' %-22s | %-5s | %s\n' "www" "A" "$IP"
printf ' %-22s | %-5s | %s\n' "midia" "A" "$IP"
printf ' %-22s | %-5s | %s\n' "mail" "A" "$IP"
printf ' %-22s | %-5s | %s\n' "(deixe em branco)" "MX" "10 mail.$DOMINIO."
printf ' %-22s | %-5s | %s\n' "(deixe em branco)" "TXT" "\"v=spf1 ip4:$IP -all\""
if [[ -n "$DKIM_PUB" ]]; then
  printf ' %-22s | %-5s | %s\n' "${SELETOR}._domainkey" "TXT" "$(dkim_em_partes)"
else
  printf ' %-22s | %-5s | %s\n' "${SELETOR}._domainkey" "TXT" "(rode com sudo para sair a chave)"
fi
printf ' %-22s | %-5s | %s\n' "_dmarc" "TXT" "\"v=DMARC1; p=none; rua=mailto:postmaster@$DOMINIO\""
echo
echo "-------------------------------------------------------------------"
echo " Se preferir colar a zona inteira (botão de edição avançada):"
echo "-------------------------------------------------------------------"
echo
zona() { printf '%-22s IN %-4s %s\n' "$1" "$2" "$3"; }
zona "@" A "$IP"
zona "www" A "$IP"
zona "midia" A "$IP"
zona "mail" A "$IP"
zona "@" MX "10 mail.$DOMINIO."
zona "@" TXT "\"v=spf1 ip4:$IP -all\""
[[ -n "$DKIM_PUB" ]] && zona "${SELETOR}._domainkey" TXT "$(dkim_em_partes)"
zona "_dmarc" TXT "\"v=DMARC1; p=none; rua=mailto:postmaster@$DOMINIO\""
echo
cat <<TXT
-------------------------------------------------------------------
 Três detalhes que fazem o Registro.br recusar a linha
-------------------------------------------------------------------

 1. O ponto final no MX. É "10 mail.$DOMINIO." com ponto no fim — sem ele,
    o Registro.br entende "mail.$DOMINIO.$DOMINIO". E o nome do servidor
    (mail.$DOMINIO) precisa do registro A acima: MX apontando para nome que
    não existe no DNS faz o e-mail voltar para quem mandou.

 2. O DKIM vem em pedaços entre aspas, um ao lado do outro. Cole tudo,
    com as aspas, na mesma linha. Quem junta de volta é quem lê.

 3. O campo NOME é relativo ao domínio: fica VAZIO para o próprio
    domínio, e só "www", "_dmarc" ou "${SELETOR}._domainkey" nos outros.
    Escrever o domínio inteiro ali duplica o nome.

 Depois de salvar, a mudança leva de alguns minutos a algumas horas para
 valer no mundo todo. Para acompanhar, aqui mesmo:

   ./conferir.sh --dominio $DOMINIO

 O que o Registro.br NÃO resolve: o nome reverso (PTR) do IP $IP.
 Esse é o provedor do servidor que configura, apontando para mail.$DOMINIO
 — o mesmo nome que está no MX.
TXT
echo
