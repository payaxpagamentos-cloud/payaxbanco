#!/usr/bin/env bash
#
# Vai Mídia — conferência do servidor.
#
# Roda NA MÁQUINA onde o sistema vai ficar (ou já está) e responde, em português, se ela tem o que é
# preciso: o domínio apontando para cá, o nome reverso do IP, os registros de e-mail no DNS, as portas
# certas abertas e os serviços no ar.
#
#   ./conferir.sh --dominio vaimidia.com.br
#
# Não altera nada. Serve antes de instalar (para saber se vale a pena) e depois (para achar o que falta).
#
set -uo pipefail

DOMINIO=""
SELETOR="vaimidia"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dominio) DOMINIO="${2:-}"; shift 2 ;;
    --seletor) SELETOR="${2:-}"; shift 2 ;;
    *) echo "Uso: ./conferir.sh --dominio SEU.DOMINIO [--seletor vaimidia]"; exit 2 ;;
  esac
done
[[ -n "$DOMINIO" ]] || { echo "Uso: ./conferir.sh --dominio SEU.DOMINIO"; exit 2; }

verde()    { printf '\033[1;32m  OK   \033[0m %s\n' "$1"; }
vermelho() { printf '\033[1;31m FALTA \033[0m %s\n' "$1"; }
amarelo()  { printf '\033[1;33m ATENÇÃO \033[0m %s\n' "$1"; }
titulo()   { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

tem() { command -v "$1" >/dev/null 2>&1; }
consulta() { # consulta <tipo> <nome>
  if tem dig; then dig +short "$1" "$2" 2>/dev/null
  elif tem host; then host -t "$1" "$2" 2>/dev/null | sed -n 's/.*has address //p;s/.*descriptive text //p'
  fi
}
porta_local() { # alguém está ouvindo nesta porta aqui dentro?
  if tem ss; then ss -lnt 2>/dev/null | grep -qE "[:.]$1 "; else netstat -lnt 2>/dev/null | grep -qE "[:.]$1 "; fi
}

echo "Conferindo $DOMINIO — $(date '+%d/%m/%Y %H:%M')"
tem dig || amarelo "dnsutils não está instalado (sudo apt install dnsutils): as checagens de DNS vão falhar."

# ------------------------------------------------------------------ endereço
titulo "Endereço desta máquina"
IP_PUBLICO="$(curl -s --max-time 6 https://api.ipify.org || true)"
if [[ -n "$IP_PUBLICO" ]]; then
  echo "       IP público: $IP_PUBLICO"
else
  amarelo "Não consegui descobrir o IP público (sem saída para a internet?)."
fi

A_DOMINIO="$(consulta A "$DOMINIO" | head -1)"
if [[ -z "$A_DOMINIO" ]]; then
  vermelho "$DOMINIO não resolve para endereço nenhum: falta o registro A."
elif [[ "$A_DOMINIO" == "$IP_PUBLICO" ]]; then
  verde "$DOMINIO aponta para esta máquina ($A_DOMINIO)."
else
  vermelho "$DOMINIO aponta para $A_DOMINIO, e esta máquina é $IP_PUBLICO."
fi

# ------------------------------------------------------------------ nome reverso
titulo "Nome reverso do IP (PTR)"
PTR=""
[[ -n "$IP_PUBLICO" ]] && PTR="$(consulta -x "$IP_PUBLICO" | head -1)"
if [[ -z "$PTR" ]]; then
  vermelho "O IP não tem nome reverso. Sem PTR, provedor grande recusa ou joga no spam o que sai daqui."
  echo "       Quem configura é o dono do IP (o provedor da máquina), não o DNS do domínio."
else
  echo "       $IP_PUBLICO -> $PTR"
  if [[ "${PTR%.}" == "$DOMINIO" ]]; then verde "O reverso bate com o domínio."
  else amarelo "O reverso existe, mas não é $DOMINIO. Funciona, mas o ideal é bater."; fi
  case "${PTR,,}" in
    *dynamic*|*dinamic*|*dsl*|*broadband*|*cable*|*pppoe*|*dial*|*client*|*user*)
      vermelho "O nome reverso tem cara de conexão residencial. Faixa residencial costuma estar em lista"
      echo "       de bloqueio (PBL) e com a porta 25 fechada — e-mail dali não chega a lugar nenhum." ;;
  esac
fi

# ------------------------------------------------------------------ e-mail no DNS
titulo "Registros de e-mail no DNS"
MX="$(consulta MX "$DOMINIO" | head -3)"
if [[ -z "$MX" ]]; then
  vermelho "Sem registro MX: ninguém sabe para onde mandar e-mail deste domínio."
else
  verde "MX: $(echo "$MX" | tr '\n' ' ')"
  # O MX aponta para um NOME, e esse nome precisa existir no DNS e levar a esta máquina.
  ALVO_MX="$(echo "$MX" | head -1 | awk '{print $NF}' | sed 's/\.$//')"
  IP_MX="$(consulta A "$ALVO_MX" | head -1)"
  if [[ -z "$IP_MX" ]]; then
    vermelho "O MX aponta para $ALVO_MX, que não tem endereço no DNS: o e-mail volta para quem mandou."
    echo "       Crie um registro A de $ALVO_MX apontando para ${IP_PUBLICO:-o IP desta máquina}."
  elif [[ "$IP_MX" == "$IP_PUBLICO" ]]; then
    verde "$ALVO_MX leva a esta máquina ($IP_MX)."
  else
    amarelo "$ALVO_MX leva a $IP_MX, e esta máquina é $IP_PUBLICO. O e-mail vai cair em outro lugar."
  fi
fi

SPF="$(consulta TXT "$DOMINIO" | grep -i 'v=spf1' | head -1)"
if [[ -z "$SPF" ]]; then vermelho "Sem SPF."; else verde "SPF: $SPF"; fi

DKIM="$(consulta TXT "${SELETOR}._domainkey.$DOMINIO" | head -1)"
if [[ -z "$DKIM" ]]; then vermelho "Sem DKIM em ${SELETOR}._domainkey.$DOMINIO."
else verde "DKIM publicado em ${SELETOR}._domainkey.$DOMINIO."; fi

DMARC="$(consulta TXT "_dmarc.$DOMINIO" | head -1)"
if [[ -z "$DMARC" ]]; then amarelo "Sem DMARC (não impede nada, mas ajuda a reputação)."
else verde "DMARC: $DMARC"; fi

# ------------------------------------------------------------------ portas
titulo "Portas"
for p in 80 443 3600 25; do
  if porta_local "$p"; then verde "Alguém está ouvindo na porta $p aqui dentro."
  else
    case $p in
      80|443) vermelho "Nada ouvindo na porta $p (o nginx não subiu?)." ;;
      3600)   vermelho "Nada ouvindo na porta 3600 (o serviço vaimidia não subiu?)." ;;
      25)     amarelo "Nada ouvindo na porta 25 (o servidor de e-mail está desligado ou não subiu)." ;;
    esac
  fi
done

# Saída na 25: é o teste que diz se o provedor deixa esta máquina CONVERSAR com outros servidores de e-mail.
if timeout 8 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then
  verde "A porta 25 de saída está liberada (dá para falar com outros servidores de e-mail)."
else
  amarelo "A porta 25 de SAÍDA parece bloqueada pelo provedor. Receber ainda funciona; mandar, não —"
  echo "       o caminho é enviar por um provedor (MIDIA_SMTP_*), que é a recomendação de qualquer jeito."
fi

# ------------------------------------------------------------------ serviços
titulo "Serviços"
if tem systemctl; then
  if systemctl is-active --quiet vaimidia 2>/dev/null; then verde "O serviço vaimidia está no ar."
  else vermelho "O serviço vaimidia não está no ar (sudo systemctl status vaimidia)."; fi
  if systemctl is-active --quiet nginx 2>/dev/null; then verde "O nginx está no ar."
  else vermelho "O nginx não está no ar."; fi
else
  amarelo "Sem systemd nesta máquina: pulei a checagem dos serviços."
fi

# ------------------------------------------------------------------ certificado
titulo "Certificado HTTPS"
if tem openssl && [[ -n "$A_DOMINIO" ]]; then
  FIM="$(echo | timeout 10 openssl s_client -servername "$DOMINIO" -connect "$DOMINIO:443" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [[ -n "$FIM" ]]; then verde "Certificado válido até $FIM."
  else vermelho "Não consegui ler um certificado em https://$DOMINIO (ainda não emitido?)."; fi
else
  amarelo "Pulei (sem openssl ou sem registro A)."
fi

titulo "Resumo"
cat <<TXT
  O que é obrigatório para o SITE e o PAINEL funcionarem:
    registro A apontando para esta máquina, portas 80 e 443 abertas, nginx e serviço no ar.

  O que é obrigatório para RECEBER e-mail no CRM:
    registro MX, porta 25 aberta na ENTRADA (o provedor da máquina precisa liberar)
    e o servidor de e-mail ouvindo na 25.

  O que é obrigatório para o que SAI não cair no spam:
    nome reverso (PTR) no IP, SPF, DKIM — ou, mais simples e mais seguro:
    enviar por um provedor, preenchendo MIDIA_SMTP_* em /etc/vaimidia/vaimidia.env.
TXT
