#!/usr/bin/env bash
# Instalação do site LK TECH em um VPS novo com Ubuntu 22.04 ou 24.04 (HostGator, Hostinger ou outro), sem cPanel.
#
# Uso (de dentro da pasta do projeto enviada ao VPS):
#   sudo bash implantacao/instalar.sh
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
set -Eeuo pipefail

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
command -v apt-get >/dev/null || erro "Este instalador é para Ubuntu (22.04 ou 24.04). No painel da HostGator, reinstale o VPS com Ubuntu, sem cPanel."
grep -qE 'VERSION_ID="(22|24)\.04"' /etc/os-release 2>/dev/null || echo "Aviso: feito para Ubuntu 22.04 ou 24.04. Continuando mesmo assim."
if [ -d /usr/local/cpanel ] || command -v whmapi1 >/dev/null; then erro "Este VPS tem cPanel, que ocupa as portas do site. Reinstale o VPS com Ubuntu puro, sem cPanel."; fi
for porta in 80 443; do
  if ss -ltnH "sport = :$porta" 2>/dev/null | grep -q . && ! ss -ltnpH "sport = :$porta" 2>/dev/null | grep -q caddy; then
    erro "A porta $porta já está em uso por outro programa (ex.: Apache ou Nginx). Use um VPS limpo, só para este site."
  fi
done

passo "Atualizando o sistema"
export DEBIAN_FRONTEND=noninteractive
APT_OPCOES=(-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
apt-get update -y
apt-get upgrade "${APT_OPCOES[@]}"
apt-get install "${APT_OPCOES[@]}" curl ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades

passo "Instalando Node.js 24"
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install "${APT_OPCOES[@]}" nodejs
fi
node --version

passo "Instalando Caddy (HTTPS automático)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install "${APT_OPCOES[@]}" caddy
fi

passo "Criando usuário e pastas"
if ! id lktech >/dev/null 2>&1; then useradd --system --home "$DADOS" --shell /usr/sbin/nologin lktech; fi
install -d -o lktech -g lktech -m 750 "$DADOS"
install -d -o lktech -g lktech -m 700 "$BACKUPS"

passo "Copiando a versão nova"
rm -rf "$APP.novo"
mkdir -p "$APP.novo"
tar -C "$ORIGEM" --exclude=./data --exclude=./backups --exclude=./.env --exclude=./node_modules --exclude=./.git -cf - . | tar -C "$APP.novo" -xf -
chown -R root:root "$APP.novo"
chmod -R a+rX,go-w "$APP.novo"

passo "Conferindo o código e rodando os testes da versão nova"
(cd "$APP.novo" && node scripts/check.mjs && node --test tests/*.test.mjs) || erro "Os testes falharam. A versão que está no ar não foi alterada."

passo "Preparando a configuração"
TEMP="$(mktemp -d)"
# Arquivo de configuração do site. Se já existir, mantém tudo e só acerta o domínio.
if [ -f "$CONFIG" ]; then
  cp "$CONFIG" "$TEMP/lktech.env"
  for par in "PUBLIC_ORIGIN=https://$DOMINIO" "HOST=127.0.0.1" "TRUST_PROXY=true" "NODE_ENV=production"; do
    chave="${par%%=*}"
    if grep -q "^$chave=" "$TEMP/lktech.env"; then sed -i "s#^$chave=.*#$par#" "$TEMP/lktech.env"; else echo "$par" >> "$TEMP/lktech.env"; fi
  done
else
  cat > "$TEMP/lktech.env" <<EOF
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

cat > "$TEMP/lktech.service" <<EOF
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
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DADOS
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
CapabilityBoundingSet=
UMask=0077
ProtectClock=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectProc=invisible
RestrictNamespaces=true
RestrictRealtime=true
SystemCallArchitectures=native
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF

cat > "$TEMP/lktech-backup.service" <<EOF
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
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DADOS $BACKUPS
UMask=0077
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
CapabilityBoundingSet=
EOF

cat > "$TEMP/lktech-backup.timer" <<EOF
[Unit]
Description=Backup diário do site LK TECH

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > "$TEMP/Caddyfile" <<EOF
# Site LK TECH. O certificado HTTPS é emitido e renovado automaticamente.
$DOMINIO, www.$DOMINIO {
	encode zstd gzip
	request_body {
		max_size 9MB
	}
	reverse_proxy 127.0.0.1:3000
	handle_errors 502 503 504 {
		header Content-Type "text/html; charset=utf-8"
		header Cache-Control "no-store"
		respond "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>LK TECH</title></head><body style=\"margin:0;min-height:100vh;display:grid;place-items:center;background:#0a192c;color:#f5f7fb;font-family:system-ui,sans-serif;text-align:center;padding:24px\"><div><h1>Voltamos em instantes.</h1><p>O site da LK TECH está passando por uma atualização. Tente novamente em alguns minutos.</p></div></body></html>" 503
	}
}
EOF
caddy validate --config "$TEMP/Caddyfile" --adapter caddyfile >/dev/null || erro "Configuração do HTTPS inválida. Nada foi alterado."

passo "Backup antes de atualizar"
if [ -f /etc/systemd/system/lktech-backup.service ] && [ -f "$CONFIG" ]; then
  systemctl start lktech-backup.service || erro "O backup falhou. A atualização foi cancelada."
else
  echo "Primeira instalação: ainda não há dados para guardar."
fi

# Guarda a configuração atual para poder voltar atrás.
ANTERIOR="$TEMP/anterior"
mkdir -p "$ANTERIOR"
for f in "$CONFIG" /etc/systemd/system/lktech.service /etc/systemd/system/lktech-backup.service /etc/systemd/system/lktech-backup.timer /etc/caddy/Caddyfile; do
  if [ -f "$f" ]; then cp -p "$f" "$ANTERIOR/$(basename "$f")"; fi
done
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "Site LK TECH" /etc/caddy/Caddyfile; then
  cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.antes-lktech
  echo "Aviso: havia outra configuração no Caddy. Ela foi guardada em /etc/caddy/Caddyfile.antes-lktech."
fi

saude() {
  for _ in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# Se qualquer passo daqui em diante falhar, volta a versão e a configuração anteriores.
voltar() {
  trap - ERR INT HUP TERM
  set +e
  printf '\n\033[1;31mAlgo deu errado. Voltando para a versão anterior...\033[0m\n' >&2
  journalctl -u lktech -n 30 --no-pager 2>/dev/null
  if [ ! -d "$APP.anterior" ]; then
    erro "A instalação não terminou. Veja as mensagens acima e rode o comando de novo."
  fi
  rm -rf "$APP"
  mv "$APP.anterior" "$APP"
  if [ -f "$ANTERIOR/lktech.env" ]; then cp -p "$ANTERIOR/lktech.env" "$CONFIG"; fi
  for f in lktech.service lktech-backup.service lktech-backup.timer; do
    if [ -f "$ANTERIOR/$f" ]; then cp -p "$ANTERIOR/$f" "/etc/systemd/system/$f"; fi
  done
  if [ -f "$ANTERIOR/Caddyfile" ]; then cp -p "$ANTERIOR/Caddyfile" /etc/caddy/Caddyfile; fi
  systemctl daemon-reload
  systemctl restart lktech.service
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  if saude; then erro "A versão nova não funcionou. A versão anterior foi restaurada e está no ar."; fi
  erro "A versão anterior foi restaurada, mas não respondeu. Veja: journalctl -u lktech -n 50"
}

passo "Trocando para a versão nova"
rm -rf "$APP.anterior"
if [ -d "$APP" ]; then mv "$APP" "$APP.anterior"; fi
mv "$APP.novo" "$APP"
trap voltar ERR INT HUP TERM

install -o root -g lktech -m 640 "$TEMP/lktech.env" "$CONFIG"
install -m 644 "$TEMP/lktech.service" /etc/systemd/system/lktech.service
install -m 644 "$TEMP/lktech-backup.service" /etc/systemd/system/lktech-backup.service
install -m 644 "$TEMP/lktech-backup.timer" /etc/systemd/system/lktech-backup.timer
install -m 644 "$TEMP/Caddyfile" /etc/caddy/Caddyfile

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

passo "Firewall: só SSH, HTTP e HTTPS"
SSH_PORTA="$(sshd -T 2>/dev/null | awk '$1=="port"{print $2; exit}' || true)"
SSH_PORTA="${SSH_PORTA:-22}"
if command -v netfilter-persistent >/dev/null; then
  # Servidores na nuvem da Oracle (usada pelo VPS da HostGator) já vêm com um firewall próprio em
  # iptables que bloqueia tudo além do SSH. Nele o ufw não tem efeito, então liberamos as portas
  # direto no iptables e gravamos para valer depois de reiniciar. O ufw não é ligado aqui.
  for porta in "$SSH_PORTA" 80 443; do
    iptables -C INPUT -p tcp --dport "$porta" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$porta" -j ACCEPT
    ip6tables -C INPUT -p tcp --dport "$porta" -j ACCEPT 2>/dev/null || ip6tables -I INPUT 1 -p tcp --dport "$porta" -j ACCEPT 2>/dev/null || true
  done
  netfilter-persistent save >/dev/null 2>&1 || true
  echo "Portas $SSH_PORTA (SSH), 80 e 443 liberadas no firewall do servidor."
else
  ufw allow "$SSH_PORTA/tcp"
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  echo "Firewall ligado. SSH liberado na porta $SSH_PORTA."
fi

passo "Ligando tudo"
systemctl daemon-reload
systemctl enable lktech.service lktech-backup.timer caddy
systemctl restart lktech.service
systemctl start lktech-backup.timer
systemctl reload caddy 2>/dev/null || systemctl restart caddy
if ! saude; then voltar; fi
trap - ERR INT HUP TERM
rm -rf "$TEMP"
echo "Site respondendo em 127.0.0.1:3000."

passo "Administrador do painel"
if runuser -u lktech -- /usr/bin/node --env-file="$CONFIG" -e "import('$APP/server/store.mjs').then(m=>{const s=m.openStore();const n=s.db.prepare('SELECT COUNT(*) n FROM admins').get().n;s.db.close();process.exit(n?0:1)})" 2>/dev/null; then
  echo "Já existe administrador. Para criar outro: lktech-admin email@empresa.com.br"
else
  CRIADO=nao
  for _ in 1 2 3; do
    EMAIL=""
    read -r -p "E-mail do administrador do painel: " EMAIL || true
    if [ -n "$EMAIL" ] && lktech-admin "$EMAIL"; then CRIADO=sim; break; fi
  done
  if [ "$CRIADO" = nao ]; then echo "Administrador não criado. Crie depois com: lktech-admin email@empresa.com.br"; fi
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
