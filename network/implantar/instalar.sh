#!/usr/bin/env bash
#
# Manager Provedor — instalação no servidor.
#
#   Destino:  /provedor
#   Endereço: https://provedor.meumanager.com.br
#
# Roda como root, numa máquina Debian 12 ou Ubuntu 22.04/24.04 limpa. Pode ser rodado de novo quantas
# vezes quiser: só faz o que ainda falta. Nenhum dado é apagado — se já houver banco em /provedor/dados,
# ele é mantido e só as migrações pendentes são aplicadas.
#
#   bash instalar.sh
#
set -euo pipefail

DESTINO="${DESTINO:-/provedor}"
DOMINIO="${DOMINIO:-provedor.meumanager.com.br}"
PORTA="${PORTA:-3500}"
USUARIO="${USUARIO:-provedor}"
REPO="${REPO:-}"            # opcional: URL do git. Em branco, espera o código já em $DESTINO
RAMO="${RAMO:-main}"
EMAIL_TLS="${EMAIL_TLS:-}"  # e-mail para o aviso de vencimento do certificado (Let's Encrypt)

msg() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
erro() { printf '\n\033[1;31mErro:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || erro "Rode como root (sudo bash instalar.sh)."

# ---------------------------------------------------------------- pacotes
msg "Pacotes do sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git nginx openssl ufw >/dev/null

# ---------------------------------------------------------------- Node 22
# O sistema usa o SQLite embutido do Node (node:sqlite), que só existe da 22.13 em diante.
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".").slice(0,2).map(Number).join("")*1' 2>/dev/null || echo 0)" -lt 2213 ]; then
  msg "Instalando Node.js 22 (o sistema exige 22.13 ou mais novo)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v | grep -qE '^v2[2-9]|^v[3-9][0-9]' || erro "Node 22.13+ é obrigatório; encontrei $(node -v)."
msg "Node $(node -v)"

# ---------------------------------------------------------------- usuário e pastas
id -u "$USUARIO" >/dev/null 2>&1 || useradd --system --home-dir "$DESTINO" --shell /usr/sbin/nologin "$USUARIO"
mkdir -p "$DESTINO" "$DESTINO/dados"

# ---------------------------------------------------------------- código
if [ -n "$REPO" ]; then
  if [ -d "$DESTINO/.git" ]; then
    msg "Atualizando o código"
    git -C "$DESTINO" fetch --depth 1 origin "$RAMO"
    git -C "$DESTINO" reset --hard "origin/$RAMO"
  else
    msg "Baixando o código"
    git clone --depth 1 --branch "$RAMO" "$REPO" "$DESTINO.tmp"
    cp -a "$DESTINO.tmp/." "$DESTINO/"
    rm -rf "$DESTINO.tmp"
  fi
fi
[ -f "$DESTINO/package.json" ] || erro "Não achei package.json em $DESTINO. Copie o código para lá, ou rode com REPO=<url do git>."

msg "Dependências da aplicação"
cd "$DESTINO"
npm ci --omit=dev --silent

# ---------------------------------------------------------------- segredos
#
# Gerados UMA vez e guardados em $DESTINO/.env. Se o arquivo já existe, nada é trocado: trocar
# NETWORK_CHAVE_CREDENCIAIS depois de o sistema estar em uso torna ilegíveis as senhas de equipamento
# já guardadas, e trocar NETWORK_SECRET derruba todas as sessões abertas.
if [ ! -f "$DESTINO/.env" ]; then
  msg "Gerando os segredos (uma vez só)"
  SENHA_ADMIN="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  cat > "$DESTINO/.env" <<EOF
# Manager Provedor — configuração deste servidor.
# ATENÇÃO: este arquivo guarda segredos. Não o versione e inclua-o no backup.
NODE_ENV=production
PORT=$PORTA
NETWORK_DADOS=$DESTINO/dados

# Assina as sessões. Trocar derruba todo mundo que estiver logado.
NETWORK_SECRET=$(openssl rand -hex 32)
# Cifra as senhas de equipamento e as credenciais das integrações guardadas no banco.
# TROCAR ESTA CHAVE TORNA ILEGÍVEL O QUE JÁ ESTÁ GUARDADO. Guarde-a junto do backup.
NETWORK_CHAVE_CREDENCIAIS=$(openssl rand -hex 32)

# Primeiro acesso. Troque a senha ao entrar.
NETWORK_ORGANIZACAO=Provedor
NETWORK_ADMIN_NOME=Administrador
NETWORK_ADMIN_EMAIL=admin@$DOMINIO
NETWORK_ADMIN_SENHA=$SENHA_ADMIN

# Atrás do nginx, no mesmo servidor.
NETWORK_TRUST_PROXY=loopback

# Mapa (Panorama, rede óptica, frota). Sem a chave, as telas de mapa dizem que falta configurar.
NETWORK_GOOGLE_MAPS_CHAVE=
NETWORK_GOOGLE_MAPS_ID=

# Cadeia ICP-Brasil, para falar com a SEFAZ (NFCom). Veja o LEIA-ME.
NETWORK_SEFAZ_CA=
EOF
  chmod 600 "$DESTINO/.env"
  echo "$SENHA_ADMIN" > "$DESTINO/.senha-inicial"
  chmod 600 "$DESTINO/.senha-inicial"
fi

chown -R "$USUARIO:$USUARIO" "$DESTINO"
chmod 750 "$DESTINO/dados"

# ---------------------------------------------------------------- banco
msg "Aplicando as migrações do banco"
# --env-file é do próprio Node: lê o arquivo como ele é, sem passar por expansão do shell (um valor
# com espaço, como o nome da organização, quebraria se fosse montado com xargs).
sudo -u "$USUARIO" node --env-file="$DESTINO/.env" --disable-warning=ExperimentalWarning "$DESTINO/server/migrar.js"

# ---------------------------------------------------------------- serviço
msg "Serviço do sistema"
install -m 644 "$DESTINO/implantar/manager-provedor.service" /etc/systemd/system/manager-provedor.service
sed -i "s|__DESTINO__|$DESTINO|g; s|__USUARIO__|$USUARIO|g" /etc/systemd/system/manager-provedor.service
systemctl daemon-reload
systemctl enable --now manager-provedor
sleep 2
systemctl is-active --quiet manager-provedor || { journalctl -u manager-provedor -n 30 --no-pager; erro "O serviço não subiu."; }

# ---------------------------------------------------------------- nginx
msg "nginx para $DOMINIO"
install -m 644 "$DESTINO/implantar/nginx-provedor.conf" "/etc/nginx/sites-available/$DOMINIO"
sed -i "s|__DOMINIO__|$DOMINIO|g; s|__PORTA__|$PORTA|g" "/etc/nginx/sites-available/$DOMINIO"
ln -sf "/etc/nginx/sites-available/$DOMINIO" "/etc/nginx/sites-enabled/$DOMINIO"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ---------------------------------------------------------------- firewall
msg "Firewall"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# ---------------------------------------------------------------- certificado
#
# O certificado só sai se o DNS de $DOMINIO já apontar para este servidor. Se ainda não apontar, o
# script NÃO falha: deixa o site no ar em HTTP e diz o comando para rodar depois.
msg "Certificado TLS"
if [ -n "$EMAIL_TLS" ]; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  if certbot --nginx -d "$DOMINIO" --non-interactive --agree-tos -m "$EMAIL_TLS" --redirect; then
    msg "HTTPS no ar"
  else
    echo "O certificado não saiu (o DNS de $DOMINIO já aponta para este servidor?)."
    echo "Quando apontar, rode: certbot --nginx -d $DOMINIO --redirect"
  fi
else
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  echo "Sem EMAIL_TLS: pulei o certificado."
  echo "Para emitir: certbot --nginx -d $DOMINIO --redirect -m seu@email.com --agree-tos"
fi

# ---------------------------------------------------------------- backup diário
msg "Backup diário do banco"
install -m 755 "$DESTINO/implantar/backup.sh" /usr/local/bin/manager-provedor-backup
sed -i "s|__DESTINO__|$DESTINO|g" /usr/local/bin/manager-provedor-backup
cat > /etc/cron.d/manager-provedor-backup <<EOF
# Backup do Manager Provedor, todo dia às 3h10.
10 3 * * * root /usr/local/bin/manager-provedor-backup >> /var/log/manager-provedor-backup.log 2>&1
EOF

# ---------------------------------------------------------------- fim
cat <<FIM

================================================================
 Manager Provedor instalado.

   Endereço : https://$DOMINIO
   Pasta    : $DESTINO
   Dados    : $DESTINO/dados   (banco, arquivos e anexos — é o que vai no backup)
   Serviço  : systemctl status manager-provedor
   Registro : journalctl -u manager-provedor -f

   Primeiro acesso:
     e-mail : admin@$DOMINIO
     senha  : $( [ -f "$DESTINO/.senha-inicial" ] && cat "$DESTINO/.senha-inicial" || echo '(já definida; veja o .env)' )

   TROQUE A SENHA ao entrar, e apague $DESTINO/.senha-inicial.

 Falta configurar (o sistema funciona sem, e diz na tela o que falta):
   - chave do Google Maps, em $DESTINO/.env
   - cadeia ICP-Brasil, para transmitir NFCom à SEFAZ
   - certificado digital A1 da empresa, pela própria tela do sistema
================================================================

FIM
