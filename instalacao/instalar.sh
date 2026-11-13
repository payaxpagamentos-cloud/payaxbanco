#!/usr/bin/env bash
# =============================================================================================
#  ZOE — instalação (e atualização) no servidor
#
#  A ZOE é um sistema só: WhatsApp, telefone (ramais, filas, URA, números, discador), a
#  atendente virtual, a Ouvidoria e os relatórios — um painel, um login, um banco.
#  Endereço: https://<domínio>/atendimento/   (serviço "zoe", porta interna 3600)
#
#  Uso (como root, de dentro da pasta extraída do pacote):
#     sudo ./instalacao/instalar.sh --dominio atende.seuprovedor.com.br --email voce@seuprovedor.com.br
#
#  Opções:
#     --dominio D        domínio público (obrigatório na primeira instalação com Nginx)
#     --email E          e-mail do usuário master (padrão: master@<domínio>)
#     --sem-nginx        não mexe no Nginx (use se o proxy for outro: Apache, Caddy, balanceador)
#     --com-whisper      compila e liga a transcrição de áudio local (whisper.cpp, ~1 GB de RAM)
#     --pasta P          onde tudo fica no servidor (padrão: /zoe)
#
#  Tudo fica numa pasta só (padrão /zoe):
#     /zoe/atendimento   o código e o .env
#     /zoe/dados         o banco e os arquivos recebidos
#     /zoe/copias        a cópia diária do banco (14 dias)
#
#  Rodar de novo ATUALIZA: troca o código e mantém .env, banco, arquivos e senha.
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
PORTA=3600

while [ $# -gt 0 ]; do
  case "$1" in
    --dominio) DOMINIO="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --sem-nginx) NGINX=0; shift ;;
    --com-whisper) WHISPER=1; shift ;;
    --pasta) DESTINO="${2%/}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1 (use --help)"; exit 1 ;;
  esac
done

CODIGO="$DESTINO/atendimento"
DADOS="$DESTINO/dados"
COPIAS="$DESTINO/copias"

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
aviso() { printf '\033[1;33m[aviso]\033[0m %s\n' "$*"; }
falha() { printf '\033[1;31m[erro]\033[0m %s\n' "$*"; exit 1; }
aleatorio() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('$2'))"; }

[ "$(id -u)" -eq 0 ] || falha "Rode como root (sudo)."
command -v apt-get >/dev/null || falha "Este instalador é para Ubuntu/Debian (apt). Em outro sistema, siga o LEIA-ME manualmente."
[ -d "$ORIGEM/atendimento/server" ] || falha "Não achei $ORIGEM/atendimento — rode de dentro da pasta extraída do pacote."
PRIMEIRA=1; [ -f "$CODIGO/.env" ] && PRIMEIRA=0
# Atualização sem --dominio: o domínio é o que já está no .env.
if [ -z "$DOMINIO" ] && [ -f "$CODIGO/.env" ]; then
  DOMINIO="$(sed -n 's|^ATEND_URL_PUBLICA=https\?://||p' "$CODIGO/.env" | head -1)"
  [ "$DOMINIO" = SEU-DOMINIO ] && DOMINIO=""
fi
if [ "$NGINX" = 1 ] && [ -z "$DOMINIO" ] && [ ! -f /etc/nginx/sites-available/zoe.conf ]; then
  falha "Informe o domínio: --dominio atende.seuprovedor.com.br (ou --sem-nginx)."
fi
[ -n "$EMAIL" ] || EMAIL="master@${DOMINIO:-zoe.local}"

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
mkdir -p "$CODIGO" "$DADOS/atendimento" "$COPIAS"
# A pasta é do root; o usuário zoe só atravessa até o código e os dados.
chown root:"$USUARIO" "$DESTINO" "$DADOS"
chmod 750 "$DESTINO" "$DADOS"
chown root:root "$COPIAS"
chmod 700 "$COPIAS"
# Os scripts de cópia e de verificação leem daqui onde a ZOE está.
printf 'ZOE_PASTA=%s\n' "$DESTINO" > /etc/zoe.conf

# Instalação antiga com o PABX à parte: ele agora é a Telefonia dentro da ZOE.
if [ -f /etc/systemd/system/zoe-pabx.service ]; then
  aviso "Achei o PABX antigo (zoe-pabx) instalado à parte: ele foi desligado — a telefonia agora fica dentro da ZOE."
  aviso "Os dados dele continuam em $DADOS/pabx (nada foi apagado)."
  systemctl disable --now zoe-pabx >/dev/null 2>&1 || true
fi
# O serviço antigo se chamava zoe-atendimento: agora é só "zoe".
if [ -f /etc/systemd/system/zoe-atendimento.service ]; then
  systemctl disable --now zoe-atendimento >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/zoe-atendimento.service
fi

# ---------------------------------------------------------------------------------------------
passo "ZOE (/atendimento, porta $PORTA)"
# Código novo; .env, dados e dependências já instaladas ficam.
rsync -a --delete --exclude '.env' --exclude 'data/' --exclude 'node_modules/' --exclude 'test/' "$ORIGEM/atendimento/" "$CODIGO/"
if [ -d "$ORIGEM/atendimento/node_modules" ]; then
  rsync -a --delete "$ORIGEM/atendimento/node_modules/" "$CODIGO/node_modules/"
else
  (cd "$CODIGO" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
fi

SENHA_NOVA=""
if [ -f "$CODIGO/.env" ]; then
  echo ".env mantido (segredos e senha não mudam)"
else
  SENHA_NOVA="$(aleatorio 12 base64url)"
  cat > "$CODIGO/.env" <<ENV
# ZOE — gerado pelo instalador em $(date '+%d/%m/%Y %H:%M'). NÃO troque o ATEND_SECRET depois de instalado:
# ele cifra os tokens do WhatsApp e os segredos das ferramentas.
NODE_ENV=production
PORT=$PORTA
ATEND_BASE_PATH=/atendimento
ATEND_URL_PUBLICA=https://${DOMINIO:-SEU-DOMINIO}
ATEND_SECRET=$(aleatorio 32 hex)
ATEND_ADMIN_EMAIL=$EMAIL
ATEND_ADMIN_SENHA=$SENHA_NOVA
ATEND_ADMIN_NOME=Master
ATEND_DB=$DADOS/atendimento/atendimento.db
ATEND_ARQUIVOS=$DADOS/atendimento/arquivos
ATEND_FUSO=America/Sao_Paulo
# Inteligência da ZOE: cole a chave de IA e reinicie (systemctl restart zoe).
# Sem ela, a ZOE atende só com intenções e base de conhecimento.
# ATEND_IA_CHAVE=
# O IXC (ou uma ferramenta da empresa) fica na rede interna do provedor (10.x, 192.168.x)? Libere com:
# ATEND_REDE_INTERNA=1
# Transcrição de áudio (whisper.cpp local, sem custo por áudio):
# ATEND_WHISPER_URL=http://127.0.0.1:8178
# Telefone no navegador (ramal WebRTC): o endereço wss:// do Asterisk e o domínio SIP.
# ATEND_WEBRTC_WSS=wss://central.seuprovedor.com.br:8089/ws
# ATEND_SIP_DOMINIO=central.seuprovedor.com.br
ENV
  echo ".env novo gerado"
fi
# O código é do root e só é lido pelo serviço; o serviço escreve apenas nos próprios dados.
chown -R root:"$USUARIO" "$CODIGO"
chmod -R u=rwX,g=rX,o= "$CODIGO"
chmod 640 "$CODIGO/.env"
chmod 755 "$CODIGO/scripts/zoe-agi.js"
chown -R "$USUARIO:$USUARIO" "$DADOS/atendimento"

cat > /etc/systemd/system/zoe.service <<UNIT
[Unit]
Description=ZOE — atendimento por WhatsApp e telefone
After=network-online.target
Wants=network-online.target

[Service]
User=$USUARIO
Group=$USUARIO
WorkingDirectory=$CODIGO
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning --env-file=$CODIGO/.env server/index.js
Restart=always
RestartSec=3
# Proteções: o processo só escreve nos próprios dados.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DADOS/atendimento

[Install]
WantedBy=multi-user.target
UNIT

if [ "$WHISPER" = 1 ]; then
  passo "Transcrição de áudio (whisper.cpp)"
  bash "$CODIGO/scripts/instalar-whisper.sh" "$DESTINO/whisper"
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
  sed -i 's|^# ATEND_WHISPER_URL=|ATEND_WHISPER_URL=|' "$CODIGO/.env"
  systemctl daemon-reload
  systemctl enable --now zoe-whisper >/dev/null
fi

passo "Serviço"
systemctl daemon-reload
systemctl enable zoe >/dev/null 2>&1
systemctl restart zoe

if [ "$NGINX" = 1 ]; then
  passo "Nginx"
  SITE=/etc/nginx/sites-available/zoe.conf
  ALVO="$SITE"
  # Configuração que alguém já ajustou (certificado, outros sites) não é sobrescrita.
  [ -f "$SITE" ] && ALVO="$SITE.novo"
  cat > "$ALVO" <<NGINX
# ZOE — gerado pelo instalador. HTTPS: certbot --nginx -d ${DOMINIO}
server {
  listen 80;
  server_name ${DOMINIO};
  client_max_body_size 20m;
  location /atendimento/ {
    proxy_pass http://127.0.0.1:${PORTA};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;
  }
  location = /atendimento { return 301 /atendimento/; }
  location = / { return 302 /atendimento/; }
}
NGINX
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
/usr/local/sbin/zoe-verificar || aviso "Algo não respondeu: veja acima e em  journalctl -u zoe -n 50"

echo
echo "============================================================================"
[ "$PRIMEIRA" = 1 ] && echo " Instalação concluída." || echo " Atualização concluída (dados, .env e senha mantidos)."
echo "   ZOE: https://${DOMINIO:-SEU-DOMINIO}/atendimento/"
if [ -n "$SENHA_NOVA" ]; then
  echo
  echo " Acesso master (anote agora — a senha não aparece de novo; troque no primeiro acesso):"
  echo "   E-mail: $EMAIL"
  echo "   Senha:  $SENHA_NOVA"
fi
echo
echo " Próximos passos: instalacao/LEIA-ME.md (HTTPS, chave de IA, Meta, IXC, telefonia/Asterisk)."
echo "============================================================================"
