#!/usr/bin/env bash
#
# Confere uma instalação da PLAY TECH VIP de ponta a ponta, pela API.
# Roda depois de subir o servidor, antes de abrir para os assinantes.
#
#   bash scripts/conferir-instalacao.sh
#   BASE=https://play.seudominio.com.br bash scripts/conferir-instalacao.sh
#   BASE=https://play.seudominio.com.br ADMIN=admin@provedor.com.br SENHA='...' bash scripts/conferir-instalacao.sh
#
# Precisa só de bash e curl. Sai com 0 se tudo passou, 1 se algo falhou.

set -u
BASE=${BASE:-http://localhost:3600}
API="${BASE%/}/api"
ADMIN=${ADMIN:-admin@playtechvip.com.br}
SENHA=${SENHA:-admin123}

falhas=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
nok()  { printf '  \033[31m✗\033[0m %s\n' "$1"; falhas=$((falhas + 1)); }

# Resposta de um caminho, com ou sem token.
codigo() {
  local met=$1 cam=$2 tk=${3:-} corpo=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' --max-time 20 -X "$met" "$API$cam")
  [ -n "$tk" ] && args+=(-H "authorization: Bearer $tk")
  [ -n "$corpo" ] && args+=(-H 'content-type: application/json' -d "$corpo")
  curl "${args[@]}"
}

esperar() { # descrição esperado método caminho [token] [corpo]
  local desc=$1 esp=$2; shift 2
  local got; got=$(codigo "$@")
  if [ "$got" = "$esp" ]; then ok "$desc"; else nok "$desc (esperado $esp, veio $got)"; fi
}

echo "PLAY TECH VIP — conferência da instalação em $BASE"
echo

echo "1. O servidor está no ar"
saude=$(curl -s --max-time 20 "$API/saude")
case "$saude" in
  *'"ok":true'*) ok "a API responde" ;;
  *) nok "a API não respondeu ($API/saude)"; echo; echo "=== $falhas falha(s). Verifique se o serviço subiu e se o endereço está certo."; exit 1 ;;
esac
case "$saude" in
  *'"ffmpeg":true'*) ok "o ffmpeg está disponível (conversão automática das qualidades)" ;;
  *) nok "ffmpeg ausente: o servidor não vai gerar Full HD, HD e SD dos vídeos enviados" ;;
esac

echo
echo "2. Páginas e HTTPS"
raiz=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${BASE%/}/")
[ "$raiz" = "200" ] && ok "a página inicial abre" || nok "a página inicial respondeu $raiz"
painel=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${BASE%/}/admin/")
[ "$painel" = "200" ] && ok "o painel da operação abre" || nok "o painel respondeu $painel"
case "$BASE" in
  https://*)
    cert=$(curl -s -o /dev/null -w '%{ssl_verify_result}' --max-time 20 "${BASE%/}/")
    [ "$cert" = "0" ] && ok "certificado HTTPS válido" || nok "certificado HTTPS com problema (código $cert)"
    redir=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://${BASE#https://}")
    case "$redir" in 30*) ok "http redireciona para https" ;; *) nok "http não redirecionou (respondeu $redir)" ;; esac
    ;;
  *) echo "  · em http: HTTPS não conferido (em produção use o domínio com https)" ;;
esac

echo
echo "3. Entrada da operação"
token=$(curl -s --max-time 20 -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN\",\"senha\":\"$SENHA\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -z "$token" ]; then
  nok "não entrou com $ADMIN (confira ADMIN e SENHA)"
else
  ok "entrou como $ADMIN"
  esperar "o painel responde"            200 GET /admin/painel     "$token"
  esperar "catálogo"                     200 GET /admin/titulos    "$token"
  esperar "canais"                       200 GET /admin/canais     "$token"
  esperar "assinantes"                   200 GET /admin/assinantes "$token"
  esperar "configurações"                200 GET /admin/config     "$token"
fi

echo
echo "4. Portas fechadas para quem não entrou"
esperar "catálogo do assinante pede sessão"  401 GET /tv/home
esperar "painel pede sessão"                 401 GET /admin/painel
esperar "senha errada é recusada"            401 POST /auth/login "" '{"email":"'"$ADMIN"'","senha":"senha-errada-de-proposito"}'
esperar "rota inexistente"                   404 GET /nao-existe

echo
echo "5. Conteúdo no ar"
if [ -n "$token" ]; then
  canais=$(curl -s --max-time 20 "$API/admin/canais" -H "authorization: Bearer $token")
  no_ar=$(printf '%s' "$canais" | grep -o '"ativo":true' | wc -l | tr -d ' ')
  [ "$no_ar" -gt 0 ] && ok "$no_ar canal(is) ligado(s)" || nok "nenhum canal ligado (cadastre o sinal das emissoras em Canais)"
  titulos=$(curl -s --max-time 20 "$API/admin/titulos" -H "authorization: Bearer $token")
  publicados=$(printf '%s' "$titulos" | grep -o '"situacao":"publicado"' | wc -l | tr -d ' ')
  [ "$publicados" -gt 0 ] && ok "$publicados título(s) publicado(s)" || nok "nenhum título publicado"
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "Tudo certo: a instalação respondeu a todas as conferências."
else
  echo "$falhas conferência(s) falharam. Resolva antes de abrir para os assinantes."
fi
exit $((falhas > 0))
