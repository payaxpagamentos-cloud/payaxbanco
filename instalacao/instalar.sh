#!/usr/bin/env bash
# =============================================================================================
#  ZOE — instalação (e atualização) no servidor
#
#  Instala, no mesmo servidor, os três sistemas da ZOE:
#     ZOE Atende ...... /atendimento   (porta 3600)  WhatsApp + telefone, atendente virtual
#     ZOE PABX ........ /pabx          (porta 3300)  ramais, filas, URA e a ligação com o Asterisk
#     Manager Network . /network       (porta 3500)  rede, NOC, chamados técnicos, frota
#
#  Uso (como root, de dentro da pasta extraída do pacote):
#     sudo ./instalacao/instalar.sh --dominio atende.seuprovedor.com.br --email voce@seuprovedor.com.br
#
#  Opções:
#     --dominio D        domínio público (obrigatório na primeira instalação com Nginx)
#     --email E          e-mail do usuário master dos três sistemas (padrão: master@<domínio>)
#     --sem-nginx        não mexe no Nginx (use se o proxy for outro: Apache, Caddy, balanceador)
#     --com-whisper      compila e liga a transcrição de áudio local (whisper.cpp, ~1 GB de RAM)
#     --modulos "a b"    só alguns: atendimento pabx network (padrão: os três)
#     --pasta P          onde tudo fica no servidor (padrão: /zoe)
#
#  Tudo fica numa pasta só (padrão /zoe):
#     /zoe/atendimento  /zoe/pabx  /zoe/network   o código e o .env de cada sistema
#     /zoe/dados                                  os bancos e os arquivos recebidos
#     /zoe/copias                                 a cópia diária do banco (14 dias)
#
#  Rodar de novo ATUALIZA: troca o código e mantém .env, banco, arquivos e senhas.
#  Nada aqui apaga dados.
# =============================================================================================
set -euo pipefail

ORIGEM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINO=/zoe
USUARIO=zoe
DOMINIO=""
EMAIL=""
NGINX=1
WHISPER=0
MODULOS="atendimento pabx network"

while [ $# -gt 0 ]; do
  case "$1" in
    --dominio) DOMINIO="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --sem-nginx) NGINX=0; shift ;;
    --com-whisper) WHISPER=1; shift ;;
    --modulos) MODULOS="$2"; shift 2 ;;
    --pasta) DESTINO="${2%/}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1 (use --help)"; exit 1 ;;
  esac
done

DADOS="$DESTINO/dados"
COPIAS="$DESTINO/copias"

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
aviso() { printf '\033[1;33m[aviso]\033[0m %s\n' "$*"; }
falha() { printf '\033[1;31m[erro]\033[0m %s\n' "$*"; exit 1; }
aleatorio() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('$2'))"; }

[ "$(id -u)" -eq 0 ] || falha "Rode como root (sudo)."
command -v apt-get >/dev/null || falha "Este instalador é para Ubuntu/Debian (apt). Em outro sistema, siga o LEIA-ME manualmente."
for m in $MODULOS; do [ -d "$ORIGEM/$m/server" ] || falha "Não achei $ORIGEM/$m — rode de dentro da pasta extraída do pacote."; done
PRIMEIRA=1; [ -d "$DESTINO/atendimento" ] || [ -d "$DESTINO/pabx" ] || [ -d "$DESTINO/network" ] && PRIMEIRA=0
if [ "$NGINX" = 1 ] && [ -z "$DOMINIO" ] && [ ! -f /etc/nginx/sites-available/zoe.conf ]; then
  falha "Informe o domínio: --dominio atende.seuprovedor.com.br (ou --sem-nginx)."
fi
[ -n "$EMAIL" ] || EMAIL="master@${DOMINIO:-zoe.local}"

declare -A PORTA=([atendimento]=3600 [pabx]=3300 [network]=3500)
declare -A NOME=([atendimento]="ZOE Atende" [pabx]="ZOE PABX" [network]="Manager Network")

# ---------------------------------------------------------------------------------------------
passo "Pacotes do sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
PACOTES="curl ca-certificates rsync sqlite3 ffmpeg"
[ "$NGINX" = 1 ] && PACOTES="$PACOTES nginx"
[ "$WHISPER" = 1 ] && PACOTES="$PACOTES git cmake g++ make"
# shellcheck disable=SC2086
apt-get install -y -qq $PACOTES >/dev/null

passo "Node.js 22"
precisa_node=1
if command -v node >/dev/null; then
  node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)" && precisa_node=0
fi
if [ "$precisa_node" = 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v)"

passo "Usuário e pastas"
id "$USUARIO" >/dev/null 2>&1 || useradd --system --home-dir "$DESTINO" --shell /usr/sbin/nologin "$USUARIO"
mkdir -p "$DESTINO" "$DADOS" "$COPIAS"
# A pasta é do root; o usuário zoe só atravessa até o código e os dados de cada sistema.
chown root:"$USUARIO" "$DESTINO" "$DADOS"
chmod 750 "$DESTINO" "$DADOS"
chown root:root "$COPIAS"
chmod 700 "$COPIAS"
# Os scripts de cópia e de verificação leem daqui onde a ZOE está.
printf 'ZOE_PASTA=%s\nZOE_MODULOS="%s"\n' "$DESTINO" "$MODULOS" > /etc/zoe.conf

# ---------------------------------------------------------------------------------------------
gerar_env() {
  local m="$1" arq="$DESTINO/$1/.env" senha
  if [ -f "$arq" ]; then echo "$m: .env mantido (segredos e senha não mudam)"; return; fi
  # Uma senha de master só para os três sistemas, gerada uma vez.
  senha="$SENHA_MASTER"
  SENHAS+=("${NOME[$m]}")
  case "$m" in
    atendimento) cat > "$arq" <<ENV
# ZOE Atende — gerado pelo instalador em $(date '+%d/%m/%Y %H:%M'). NÃO troque o ATEND_SECRET depois de instalado:
# ele cifra os tokens do WhatsApp e os segredos das ferramentas.
NODE_ENV=production
PORT=${PORTA[atendimento]}
ATEND_BASE_PATH=/atendimento
ATEND_URL_PUBLICA=https://${DOMINIO:-SEU-DOMINIO}
ATEND_SECRET=$(aleatorio 32 hex)
ATEND_ADMIN_EMAIL=$EMAIL
ATEND_ADMIN_SENHA=$senha
ATEND_ADMIN_NOME=Master
ATEND_DB=$DADOS/atendimento/atendimento.db
ATEND_ARQUIVOS=$DADOS/atendimento/arquivos
ATEND_FUSO=America/Sao_Paulo
# Inteligência da ZOE: cole a chave de IA e reinicie (systemctl restart zoe-atendimento).
# Sem ela, a ZOE atende só com intenções e base de conhecimento.
# ATEND_IA_CHAVE=
# O IXC (ou uma ferramenta da empresa) fica na rede interna do provedor (10.x, 192.168.x)? Libere com:
# ATEND_REDE_INTERNA=1
# Transcrição de áudio (whisper.cpp local, sem custo por áudio):
# ATEND_WHISPER_URL=http://127.0.0.1:8178
ENV
    ;;
    pabx) cat > "$arq" <<ENV
# ZOE PABX — gerado pelo instalador em $(date '+%d/%m/%Y %H:%M'). NÃO troque o PABX_SECRET depois de instalado.
NODE_ENV=production
PORT=${PORTA[pabx]}
PABX_BASE_PATH=/pabx
PABX_SECRET=$(aleatorio 32 hex)
PABX_ADMIN_EMAIL=$EMAIL
PABX_ADMIN_SENHA=$senha
PABX_ADMIN_NOME=Master
PABX_DB=$DADOS/pabx/pabx.db
PABX_FUSO=America/Sao_Paulo
# Ramal no navegador (WebRTC): o endereço wss:// da central e o domínio SIP.
# PABX_WEBRTC_WSS=wss://central.seuprovedor.com.br:8089/ws
# PABX_SIP_DOMINIO=central.seuprovedor.com.br
ENV
    ;;
    network) cat > "$arq" <<ENV
# Manager Network — gerado pelo instalador em $(date '+%d/%m/%Y %H:%M').
# NÃO troque NETWORK_SECRET nem NETWORK_CHAVE_CREDENCIAIS depois de instalado (cifram as credenciais dos conectores).
NODE_ENV=production
PORT=${PORTA[network]}
NETWORK_BASE_PATH=/network
NETWORK_SECRET=$(aleatorio 32 hex)
NETWORK_CHAVE_CREDENCIAIS=$(aleatorio 32 hex)
NETWORK_ADMIN_EMAIL=$EMAIL
NETWORK_ADMIN_SENHA=$senha
NETWORK_ADMIN_NOME=Master
NETWORK_DADOS=$DADOS/network
NETWORK_FUSO=America/Sao_Paulo
# O custo do WhatsApp vindo do ZOE Atende fica DESLIGADO até ser ligado no Manager certo.
# NETWORK_CUSTO_WHATSAPP=
ENV
    ;;
  esac
  echo "$m: .env novo gerado"
}

SENHAS=()
# A mesma senha de master nos três sistemas. Se algum já estiver instalado (ex.: --modulos para
# acrescentar um sistema depois), reaproveita a dele; senão, gera uma nova.
SENHA_MASTER="$(grep -h -m1 -E '^(ATEND|PABX|NETWORK)_ADMIN_SENHA=' "$DESTINO"/atendimento/.env "$DESTINO"/pabx/.env "$DESTINO"/network/.env 2>/dev/null | head -1 | cut -d= -f2- || true)"
[ -n "$SENHA_MASTER" ] || SENHA_MASTER="$(aleatorio 12 base64url)"
for m in $MODULOS; do
  passo "${NOME[$m]} (/$m, porta ${PORTA[$m]})"
  mkdir -p "$DESTINO/$m" "$DADOS/$m"
  # Código novo; .env, dados e dependências já instaladas ficam.
  rsync -a --delete --exclude '.env' --exclude 'data/' --exclude 'node_modules/' --exclude 'test/' "$ORIGEM/$m/" "$DESTINO/$m/"
  if [ -d "$ORIGEM/$m/node_modules" ]; then
    rsync -a --delete "$ORIGEM/$m/node_modules/" "$DESTINO/$m/node_modules/"
  else
    (cd "$DESTINO/$m" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  fi
  gerar_env "$m"
  # O código é do root e só é lido pelo serviço; o serviço escreve apenas nos próprios dados.
  chown -R root:"$USUARIO" "$DESTINO/$m"
  chmod -R u=rwX,g=rX,o= "$DESTINO/$m"
  chmod 640 "$DESTINO/$m/.env"
  chown -R "$USUARIO:$USUARIO" "$DADOS/$m"
  if [ "$m" = network ]; then
    (cd "$DESTINO/network" && runuser -u "$USUARIO" -- node --disable-warning=ExperimentalWarning --env-file=.env server/migrar.js)
  fi

  cat > "/etc/systemd/system/zoe-$m.service" <<UNIT
[Unit]
Description=${NOME[$m]}
After=network-online.target
Wants=network-online.target

[Service]
User=$USUARIO
Group=$USUARIO
WorkingDirectory=$DESTINO/$m
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning --env-file=$DESTINO/$m/.env server/index.js
Restart=always
RestartSec=3
# Proteções: o processo só escreve nos próprios dados.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DADOS/$m

[Install]
WantedBy=multi-user.target
UNIT
done

if [ "$WHISPER" = 1 ] && [[ " $MODULOS " == *" atendimento "* ]]; then
  passo "Transcrição de áudio (whisper.cpp)"
  bash "$DESTINO/atendimento/scripts/instalar-whisper.sh" "$DESTINO/whisper"
  cat > /etc/systemd/system/zoe-whisper.service <<UNIT
[Unit]
Description=ZOE — transcrição de áudio (whisper.cpp)
After=network.target

[Service]
User=$USUARIO
ExecStart=$DESTINO/whisper/src/build/bin/whisper-server -m $DESTINO/whisper/ggml-small.bin -l pt -t $(nproc) --host 127.0.0.1 --port 8178
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
  sed -i 's|^# ATEND_WHISPER_URL=|ATEND_WHISPER_URL=|' "$DESTINO/atendimento/.env"
  systemctl daemon-reload
  systemctl enable --now zoe-whisper >/dev/null
fi

passo "Serviços"
systemctl daemon-reload
for m in $MODULOS; do
  systemctl enable "zoe-$m" >/dev/null 2>&1
  systemctl restart "zoe-$m"
done

if [ "$NGINX" = 1 ]; then
  passo "Nginx"
  SITE=/etc/nginx/sites-available/zoe.conf
  ALVO="$SITE"
  # Configuração que alguém já ajustou (certificado, outros sites) não é sobrescrita.
  [ -f "$SITE" ] && ALVO="$SITE.novo"
  {
    echo "# ZOE — gerado pelo instalador. HTTPS: certbot --nginx -d ${DOMINIO}"
    echo "server {"
    echo "  listen 80;"
    echo "  server_name ${DOMINIO};"
    echo "  client_max_body_size 20m;"
    for m in $MODULOS; do
      echo "  location /$m/ {"
      echo "    proxy_pass http://127.0.0.1:${PORTA[$m]};"
      echo "    proxy_http_version 1.1;"
      echo "    proxy_set_header Host \$host;"
      echo "    proxy_set_header X-Real-IP \$remote_addr;"
      echo "    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
      echo "    proxy_set_header X-Forwarded-Proto \$scheme;"
      echo "    proxy_read_timeout 120s;"
      echo "  }"
      echo "  location = /$m { return 301 /$m/; }"
    done
    echo "}"
  } > "$ALVO"
  if [ "$ALVO" = "$SITE" ]; then
    ln -sf "$SITE" /etc/nginx/sites-enabled/zoe.conf
    nginx -t && systemctl reload nginx
  else
    aviso "Já existia $SITE: a versão nova ficou em $ALVO para você comparar."
  fi
fi

passo "Cópia diária do banco"
install -m 755 "$ORIGEM/instalacao/backup.sh" /usr/local/sbin/zoe-backup
install -m 755 "$ORIGEM/instalacao/verificar.sh" /usr/local/sbin/zoe-verificar
echo "17 3 * * * root /usr/local/sbin/zoe-backup >/dev/null 2>&1" > /etc/cron.d/zoe-backup
echo "Todo dia às 03:17 em $COPIAS (14 dias guardados)."

passo "Conferindo"
sleep 3
/usr/local/sbin/zoe-verificar || aviso "Algo não respondeu: veja acima e em  journalctl -u zoe-<sistema> -n 50"

echo
echo "============================================================================"
[ "$PRIMEIRA" = 1 ] && echo " Instalação concluída." || echo " Atualização concluída (dados, .env e senhas mantidos)."
for m in $MODULOS; do echo "   ${NOME[$m]}: https://${DOMINIO:-SEU-DOMINIO}/$m/"; done
if [ ${#SENHAS[@]} -gt 0 ]; then
  echo
  echo " Acesso master — o mesmo em: $(printf '%s, ' "${SENHAS[@]}" | sed 's/, $//')"
  echo "   E-mail: $EMAIL"
  echo "   Senha:  $SENHA_MASTER"
  echo " Anote agora: a senha não aparece de novo. Ao trocar, troque nos três painéis."
fi
echo
echo " Próximos passos: instalacao/LEIA-ME.md (HTTPS, chave de IA, Meta, IXC, Asterisk)."
echo "============================================================================"
