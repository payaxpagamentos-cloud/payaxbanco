#!/usr/bin/env bash
# PAY AX — confere se os endereços estão no ar e corrige o que for possível (servidor com HestiaCP).
#
# Para cada endereço (o sistema, o site e o www e a ativação de acesso) confere, em ordem:
#   1. o sistema responde aquele endereço aqui dentro;
#   2. o domínio existe no Hestia e usa o modelo "payax" (que encaminha para o sistema);
#   3. o nginx do servidor entrega o sistema (e não a página padrão "Sucesso!");
#   4. o DNS aponta para este servidor;
#   5. o HTTPS está ativo;
#   6. quem entra por http:// é mandado para o https://;
#   7. o certificado não está perto de vencer (o Hestia renova sozinho; aqui conferimos que renovou);
#   8. só protocolos seguros: TLS 1.3 aceito, TLS 1.0 e 1.1 recusados.
# No fim, confere o registro CAA do domínio (diz quem pode emitir certificado para ele).
# O que estiver errado e der para corrigir, corrige (refaz o domínio no Hestia, emite o certificado).
#
# Uso (como root):  bash implantacao/verificar.sh          — o instalador também roda no final.
set -uo pipefail
ENV="${PAYAX_ENV:-/etc/payax/pagamentos.env}"
[[ -r "$ENV" ]] || { echo "Sistema não instalado ($ENV não existe)." >&2; exit 1; }
export HESTIA=/usr/local/hestia PATH="$PATH:/usr/local/hestia/bin"
PORTA="$(grep -E '^PORT=' "$ENV" | cut -d= -f2)"; PORTA="${PORTA:-3600}"
DOMINIO="$(grep -E '^PAYAX_URL_PUBLICA=' "$ENV" | cut -d= -f2- | sed 's#^https\?://##; s#/.*##')"
SITE_HOSTS="$(grep -E '^PAYAX_SITE_HOSTS=' "$ENV" | cut -d= -f2- || true)"
SITE="${SITE_HOSTS%%,*}"
ACESSO_HOSTS="$(grep -E '^PAYAX_ACESSO_HOSTS=' "$ENV" | cut -d= -f2- || true)"
ACESSO="${ACESSO_HOSTS%%,*}"
TEM_HESTIA=0; [[ -x /usr/local/hestia/bin/v-list-users ]] && TEM_HESTIA=1
IP_SERVIDOR="$(curl -s -4 --max-time 8 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
# IP em que o nginx do Hestia escuta (o da interface do servidor); é por ele que testamos "por fora".
IP_NGINX="$(v-list-sys-ips plain 2>/dev/null | awk '{print $1}' | head -1)"; IP_NGINX="${IP_NGINX:-$(hostname -I | awk '{print $1}')}"

ok()    { printf '  \033[1;32mOK\033[0m     %s\n' "$*"; }
falha() { printf '  \033[1;31mFALHA\033[0m  %s\n' "$*"; PROBLEMAS=$((PROBLEMAS + 1)); }
aviso() { printf '  \033[1;33mAVISO\033[0m  %s\n' "$*"; }
PROBLEMAS=0

# O que o sistema entrega em cada endereço: o site tem "Uma nova perspectiva"; o sistema, o Backoffice.
marca_de() {
  if [[ -n "$SITE" && ( "$1" == "$SITE" || "$1" == "www.$SITE" ) ]]; then echo 'Uma nova perspectiva'
  elif [[ -n "$ACESSO" && "$1" == "$ACESSO" ]]; then echo 'Ative seu acesso'
  else echo 'PAY AX'; fi
}

dono_de() { v-search-domain-owner "$1" web 2>/dev/null || true; }

# Refaz o domínio no Hestia: cria se faltar, põe o modelo payax, o www (site) e reconstrói o nginx.
# Deixa o usuário dono em REFEITO.
REFEITO=""
refazer() {
  local dom="$1" www="${2:-}" u; u="$(dono_de "$dom")"
  if [[ -z "$u" ]]; then
    # Sem site no Hestia: cria com o dono que o domínio já tiver (e-mail ou DNS) ou, se não tiver, o do sistema.
    u="$(v-search-domain-owner "$dom" 2>/dev/null || true)"; [[ -n "$u" ]] || u="$(dono_de "$DOMINIO")"
    [[ -n "$u" ]] || { falha "não achei o usuário do Hestia para criar $dom"; return 1; }
    local erro; erro="$(v-add-web-domain "$u" "$dom" "" no 2>&1)" || { falha "o Hestia não criou $dom: $erro"; return 1; }
    [[ "$www" == www ]] || v-delete-web-domain-alias "$u" "$dom" "www.$dom" no >/dev/null 2>&1 || true
  fi
  [[ "$www" == www ]] && { v-add-web-domain-alias "$u" "$dom" "www.$dom" no >/dev/null 2>&1 || true; }
  v-change-web-domain-proxy-tpl "$u" "$dom" payax "" no >/dev/null 2>&1 || { falha "não consegui aplicar o modelo payax em $dom"; return 1; }
  v-rebuild-web-domain "$u" "$dom" yes >/dev/null 2>&1 || v-rebuild-web-domains "$u" yes >/dev/null 2>&1 || true
  systemctl reload nginx 2>/dev/null || true
  REFEITO="$u"
}

# O que o nginx do servidor entrega no endereço (segue o redirecionamento para o HTTPS, se houver).
entrega_de() {
  curl -s -k -L --max-redirs 3 --max-time 10 --resolve "$1:80:$IP_NGINX" --resolve "$1:443:$IP_NGINX" "http://$1/" 2>/dev/null
}

conferir() {
  local dom="$1" www="${2:-}" marca u
  marca="$(marca_de "$dom")"
  printf '\n\033[1m%s\033[0m\n' "$dom"

  # 1. O sistema, aqui dentro.
  # Sem "curl | grep -q": o grep sai na primeira linha, o curl leva SIGPIPE e o pipefail acusa falha.
  if grep -q "$marca" <<<"$(curl -s --max-time 10 -H "Host: $dom" "http://127.0.0.1:$PORTA/")"; then ok "o sistema responde $dom"
  else
    falha "o sistema não responde $dom (confira: systemctl status payax-pagamentos; PAYAX_SITE_HOSTS no $ENV)"
    return
  fi

  [[ $TEM_HESTIA -eq 1 ]] || return 0

  # 2 e 3. Hestia e nginx: pelo próprio servidor, sem depender do DNS.
  u="$(dono_de "$dom")"
  if [[ -n "$u" ]] && grep -q "$marca" <<<"$(entrega_de "$dom")"; then
    ok "o Hestia (usuário $u) entrega o sistema em $dom"
  else
    if [[ -z "$u" ]]; then aviso "$dom não existe no Hestia: criando"; else aviso "$dom está no Hestia (usuário $u), mas sem o encaminhamento: refazendo"; fi
    refazer "$dom" "$www" || return
    u="$REFEITO"
    if grep -q "$marca" <<<"$(entrega_de "$dom")"; then ok "corrigido: o Hestia (usuário $u) agora entrega o sistema em $dom"
    else falha "o nginx ainda não entrega o sistema em $dom (veja: v-list-web-domain $u $dom)"; return; fi
  fi

  # 4. DNS (resolvedor público, não o do servidor).
  local ips; ips="$(dig +short A "$dom" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' | sort -u | tr '\n' ' ')"
  local ips_www=""; [[ "$www" == www ]] && ips_www="$(dig +short A "www.$dom" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' | sort -u | tr '\n' ' ')"
  if [[ " $ips " == *" $IP_SERVIDOR "* ]]; then ok "DNS de $dom aponta para este servidor ($IP_SERVIDOR)"
  else falha "DNS de $dom aponta para '${ips:-nada}', e este servidor é $IP_SERVIDOR: corrija o registro A no Registro.br"; fi
  if [[ "$www" == www ]]; then
    if [[ " $ips_www " == *" $IP_SERVIDOR "* ]]; then ok "DNS de www.$dom aponta para este servidor"
    else aviso "DNS de www.$dom aponta para '${ips_www:-nada}' (crie um registro A do www para $IP_SERVIDOR)"; fi
  fi

  # 5. HTTPS: emite o certificado se faltar (só funciona com o DNS certo).
  if [[ "$(curl -s --max-time 10 -o /dev/null -w '%{ssl_verify_result}' --resolve "$dom:443:$IP_NGINX" "https://$dom/" 2>/dev/null)" == 0 ]]; then
    ok "HTTPS ativo em $dom"
  else
    local apelido=""; [[ "$www" == www && " $ips_www " == *" $IP_SERVIDOR "* ]] && apelido="www.$dom"
    if [[ " $ips " == *" $IP_SERVIDOR "* ]] && v-add-letsencrypt-domain "$u" "$dom" "$apelido" >/dev/null 2>&1; then
      v-add-web-domain-ssl-force "$u" "$dom" >/dev/null 2>&1 || true
      ok "HTTPS emitido agora em $dom${apelido:+ e $apelido}"
    else
      falha "sem HTTPS em $dom (o certificado só sai com o DNS apontando para cá; depois rode este script de novo)"
      return
    fi
  fi

  # 6. http:// vai para https:// (ninguém digita senha sem cadeado).
  local destino; destino="$(curl -s --max-time 10 -o /dev/null -w '%{redirect_url}' --resolve "$dom:80:$IP_NGINX" "http://$dom/" 2>/dev/null)"
  if [[ "$destino" == https://* ]]; then ok "http://$dom vai para o HTTPS"
  else
    v-add-web-domain-ssl-force "$u" "$dom" >/dev/null 2>&1 || true
    destino="$(curl -s --max-time 10 -o /dev/null -w '%{redirect_url}' --resolve "$dom:80:$IP_NGINX" "http://$dom/" 2>/dev/null)"
    if [[ "$destino" == https://* ]]; then ok "corrigido: http://$dom agora vai para o HTTPS"
    else aviso "http://$dom não redireciona para o HTTPS (rode: v-add-web-domain-ssl-force $u $dom)"; fi
  fi

  # 7. Validade do certificado (Let's Encrypt dura 90 dias; o Hestia renova uns 30 dias antes).
  local fim dias
  fim="$(echo | openssl s_client -servername "$dom" -connect "$IP_NGINX:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [[ -n "$fim" ]]; then
    dias=$(( ( $(date -d "$fim" +%s) - $(date +%s) ) / 86400 ))
    if (( dias >= 15 )); then ok "certificado de $dom vale até $(date -d "$fim" +%d/%m/%Y) ($dias dias; o Hestia renova sozinho)"
    elif (( dias >= 0 )); then
      aviso "certificado de $dom vence em $dias dias: pedindo a renovação agora"
      v-add-letsencrypt-domain "$u" "$dom" "$( [[ "$www" == www ]] && echo "www.$dom" )" >/dev/null 2>&1 && ok "certificado de $dom renovado" \
        || falha "não consegui renovar o certificado de $dom (veja: v-list-web-domain-ssl $u $dom)"
    else falha "certificado de $dom VENCIDO desde $(date -d "$fim" +%d/%m/%Y)"; fi
  else
    aviso "não consegui ler a validade do certificado de $dom"
  fi

  # 8. Protocolos: TLS 1.3 aceito; TLS 1.0 e 1.1 (quebrados) recusados.
  local t13=0 antigo=0
  echo | openssl s_client -tls1_3 -servername "$dom" -connect "$IP_NGINX:443" >/dev/null 2>&1 && t13=1
  # O openssl do Ubuntu, por padrão, nem tenta TLS 1.0/1.1 (SECLEVEL 2): sem baixar o nível, o teste daria "recusado" sempre.
  for p in -tls1 -tls1_1; do echo | openssl s_client "$p" -cipher 'DEFAULT:@SECLEVEL=0' -servername "$dom" -connect "$IP_NGINX:443" >/dev/null 2>&1 && antigo=1; done
  if (( t13 == 1 && antigo == 0 )); then ok "só TLS 1.2 e 1.3 em $dom (TLS 1.0 e 1.1 recusados)"
  elif (( antigo == 1 )); then falha "$dom ainda aceita TLS 1.0/1.1: rode o instalador de novo (o modelo payax desliga)"
  else aviso "$dom não negociou TLS 1.3 (confira a versão do OpenSSL/nginx do servidor)"; fi
}

command -v dig >/dev/null || apt-get install -y -q dnsutils >/dev/null 2>&1 || true
# Logo depois de um reinício o sistema leva alguns segundos para subir.
for _ in $(seq 1 30); do curl -s --max-time 2 "http://127.0.0.1:$PORTA/api/saude" >/dev/null && break; sleep 1; done
printf '\033[1;34m== Conferindo os endereços (servidor %s)\033[0m\n' "$IP_SERVIDOR"
conferir "$DOMINIO" ""
[[ -n "$SITE" ]] && conferir "$SITE" www
[[ -n "$ACESSO" ]] && conferir "$ACESSO" ""

# CAA: diz no DNS que só a Let's Encrypt (a autoridade usada pelo Hestia) pode emitir certificado para o domínio.
RAIZ="${SITE:-${DOMINIO#*.}}"
printf '\n\033[1m%s (DNS)\033[0m\n' "$RAIZ"
if dig +short CAA "$RAIZ" @8.8.8.8 2>/dev/null | grep -qi 'letsencrypt.org'; then ok "registro CAA de $RAIZ autoriza a Let's Encrypt"
elif [[ -n "$(dig +short CAA "$RAIZ" @8.8.8.8 2>/dev/null)" ]]; then falha "o registro CAA de $RAIZ não autoriza a Let's Encrypt: o certificado não vai renovar"
else aviso "sem registro CAA em $RAIZ (recomendado: CAA 0 issue \"letsencrypt.org\" no painel do DNS)"; fi
echo
if [[ $PROBLEMAS -eq 0 ]]; then printf '\033[1;32mTudo no ar.\033[0m\n'
else printf '\033[1;31m%s problema(s) acima.\033[0m Mande um print desta tela para o suporte.\n' "$PROBLEMAS"; fi
exit 0
