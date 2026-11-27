#!/usr/bin/env bash
# Instalação do site LK TECH em um VPS novo (Ubuntu 24.04), por exemplo na Hostinger.
#
# Uso (como root, de dentro da pasta do projeto enviada ao VPS):
#   bash implantacao/instalar.sh
#
# O que faz:
#   - instala Node.js 24, Caddy (HTTPS automático) e o firewall
#   - copia o site para /opt/lktech e guarda os dados em /var/lib/lktech
#   - cria o serviço "lktech", que liga sozinho e reinicia se cair
#   - agenda backup diário em /var/backups/lktech (guarda 30 dias)
#   - cria a conta de administrador do painel
#
# Para ATUALIZAR o site, envie a pasta nova e rode o mesmo comando: os dados (banco, imagens,
# configuração) são mantidos, é feito um backup antes e, se a versão nova não ligar, a anterior volta.
set -euo pipefail

DOMINIO="${DOMINIO:-lktechprovedor.com.br}"
APP=/opt/lktech
DADOS=/var/lib/lktech
BACKUPS=/var/backups/lktech
CONFIG=/etc/lktech.env
ORIGEM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

passo() { printf '\n\033[1;33m==> %s\033[0m\n' "$1"; }
erro() { printf '\n\033[1;31mERRO: %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || erro "Execute como root (ou com sudo)."
[ -f "$ORIGEM/server/index.mjs" ] || erro "Não encontrei o projeto em $ORIGEM. Rode o script de dentro da pasta lktech."
grep -q 'VERSION_ID="24.04"' /etc/os-release 2>/dev/null || echo "Aviso: este script foi feito para Ubuntu 24.04. Continuando mesmo assim."

passo "Atualizando o sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades

passo "Instalando Node.js 24"
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node --version

passo "Instalando Caddy (HTTPS automático)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

passo "Criando usuário e pastas"
id lktech >/dev/null 2>&1 || useradd --system --home "$DADOS" --shell /usr/sbin/nologin lktech
install -d -o lktech -g lktech -m 750 "$DADOS"
install -d -o lktech -g lktech -m 700 "$BACKUPS"

passo "Copiando o site para $APP"
rm -rf "$APP.novo"
mkdir -p "$APP.novo"
tar -C "$ORIGEM" --exclude=./data --exclude=./backups --exclude=./.env --exclude=./node_modules --exclude=./.git -cf - . | tar -C "$APP.novo" -xf -
chown -R root:root "$APP.novo"
chmod -R a+rX,go-w "$APP.novo"

passo "Conferindo o código e rodando os testes da versão nova"
(cd "$APP.novo" && node scripts/check.mjs && node --test tests/*.test.mjs) || erro "Os testes falharam. A versão que está no ar não foi alterada."

if [ -f /etc/systemd/system/lktech-backup.service ] && [ -f "$CONFIG" ]; then
  passo "Backup antes de atualizar"
  systemctl start lktech-backup.service || erro "O backup falhou. A atualização foi cancelada."
fi
rm -rf "$APP.anterior"
if [ -d "$APP" ]; then mv "$APP" "$APP.anterior"; fi
mv "$APP.novo" "$APP"

passo "Configuração ($CONFIG)"
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=https://$DOMINIO
TRUST_PROXY=true
DATA_DIR=$DADOS
BACKUP_DIR=$BACKUPS
SESSION_HOURS=8
EOF
fi
chown root:lktech "$CONFIG"
chmod 640 "$CONFIG"

passo "Serviço do site (liga sozinho e reinicia se cair)"
cat > /etc/systemd/system/lktech.service <<EOF
[Unit]
Description=Site LK TECH
After=network-online.target
Wants=network-online.target

[Service]
User=lktech
Group=lktech
WorkingDirectory=$APP
EnvironmentFile=$CONFIG
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DADOS $BACKUPS
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

passo "Backup diário (03h30, guarda 30 dias)"
cat > /etc/systemd/system/lktech-backup.service <<EOF
[Unit]
Description=Backup do site LK TECH

[Service]
Type=oneshot
User=lktech
Group=lktech
WorkingDirectory=$APP
EnvironmentFile=$CONFIG
ExecStart=/usr/bin/node scripts/backup.mjs
ExecStartPost=/usr/bin/find $BACKUPS -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
EOF
cat > /etc/systemd/system/lktech-backup.timer <<EOF
[Unit]
Description=Backup diário do site LK TECH

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

passo "Comando para criar ou redefinir administrador: lktech-admin"
cat > /usr/local/bin/lktech-admin <<EOF
#!/usr/bin/env bash
# Uso: lktech-admin email@empresa.com.br          (cria a conta)
#      lktech-admin email@empresa.com.br --reset  (troca a senha)
set -e
[ -n "\${1:-}" ] || { echo "Uso: lktech-admin email@empresa.com.br [--reset]"; exit 1; }
cd $APP
exec runuser -u lktech -- /usr/bin/node --env-file=$CONFIG scripts/create-admin.mjs --email "\$@"
EOF
chmod 755 /usr/local/bin/lktech-admin

passo "HTTPS com Caddy para $DOMINIO e www.$DOMINIO"
cat > /etc/caddy/Caddyfile <<EOF
# Site LK TECH. O certificado HTTPS é emitido e renovado automaticamente.
$DOMINIO, www.$DOMINIO {
	encode zstd gzip
	request_body {
		max_size 9MB
	}
	reverse_proxy 127.0.0.1:3000
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

passo "Firewall: só SSH, HTTP e HTTPS"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

passo "Ligando tudo"
systemctl daemon-reload
systemctl enable --now lktech.service lktech-backup.timer
systemctl restart lktech.service
systemctl enable caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 1; done
if ! curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
  journalctl -u lktech -n 30 --no-pager
  if [ -d "$APP.anterior" ]; then
    rm -rf "$APP" && mv "$APP.anterior" "$APP" && systemctl restart lktech.service
    erro "A versão nova não iniciou. A versão anterior foi restaurada."
  fi
  erro "O site não iniciou. Veja as mensagens acima."
fi
echo "Site respondendo em 127.0.0.1:3000."

passo "Administrador do painel"
if runuser -u lktech -- /usr/bin/node --env-file="$CONFIG" -e "import('$APP/server/store.mjs').then(m=>{const s=m.openStore();const n=s.db.prepare('SELECT COUNT(*) n FROM admins').get().n;s.db.close();process.exit(n?0:1)})" 2>/dev/null; then
  echo "Já existe administrador. Para criar outro: lktech-admin email@empresa.com.br"
else
  read -r -p "E-mail do administrador do painel: " EMAIL
  lktech-admin "$EMAIL"
fi

IP="$(curl -fsS -4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
passo "Pronto"
cat <<EOF
Site instalado e ligado.

Próximo passo: apontar o domínio para este VPS.
  No registro do domínio (registro.br ou Editor de Zona da HostGator), registro A:
    $DOMINIO       ->  $IP
    www.$DOMINIO   ->  $IP
Quando o domínio apontar para cá, o HTTPS é ativado sozinho em alguns minutos.

Endereços:   https://$DOMINIO   e   https://$DOMINIO/admin
Situação:    systemctl status lktech
Mensagens:   journalctl -u lktech -f
Backup já:   systemctl start lktech-backup   (fica em $BACKUPS)
EOF
