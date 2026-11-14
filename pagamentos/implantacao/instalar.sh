#!/usr/bin/env bash
# PAY AX Pagamentos — instalação do servidor (Ubuntu 24.04 LTS).
#
# Dois jeitos de guardar as cópias e os segredos:
#   AWS ............ servidor EC2 com papel (IAM role); cópias no S3, segredos no Parameter Store.
#   Qualquer VPS ... (Hostinger, Magalu Cloud, Vultr...) com --endpoint: cópias num armazenamento compatível com
#                    S3 (ex.: Cloudflare R2), segredos cifrados com uma FRASE DE RECUPERAÇÃO que só a PAY AX sabe.
#
# O mesmo script serve para os três casos:
#   1. primeiro servidor ............ gera os segredos, guarda cifrados e sobe o sistema;
#   2. servidor novo substituindo ... encontra os segredos e a cópia contínua do banco, restaura e sobe;
#   3. servidor reserva (etapa 2) ... instala tudo e deixa PARADO, pronto para o assumir.sh.
#
# Uso (como root, de dentro da pasta do pacote):
#   ./implantacao/instalar.sh --dominio pagamentos.payax.com.br --bucket payax-pagamentos --email-admin ti@payax.com.br
#   ./implantacao/instalar.sh ... --endpoint https://ID-DA-CONTA.r2.cloudflarestorage.com   (VPS + Cloudflare R2)
#   ./implantacao/instalar.sh ... --reserva
#   ./implantacao/instalar.sh ... --anterior-desligado   (servidor novo no lugar de um que caiu)
#   ./implantacao/instalar.sh ... --somente-gerar /tmp/conferir   (só escreve as configurações numa pasta, sem instalar)
#
# Regra de ouro: só UM servidor ativo por vez. As rotinas (PIX a cada 15 min, remessa e retorno) rodando
# em dois servidores pagariam o cliente duas vezes, e duas cópias contínuas no mesmo destino estragam a cópia.
set -euo pipefail

VERSAO_LITESTREAM="0.3.13"
REGIAO="sa-east-1"                       # São Paulo
PARAMETRO="/payax/pagamentos/env"        # onde os segredos ficam guardados (AWS Systems Manager, cifrado)
APP=/opt/payax/pagamentos
DADOS=/var/lib/payax
ETC=/etc/payax
USUARIO=payax
PORTA=3600

ENDPOINT="" DOMINIO="" BUCKET="" EMAIL_ADMIN="" RESERVA=0 SOMENTE_GERAR="" ANTERIOR_DESLIGADO=0 AWS_BIN=/snap/bin/aws
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dominio) DOMINIO="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --email-admin) EMAIL_ADMIN="$2"; shift 2 ;;
    --regiao) REGIAO="$2"; shift 2 ;;
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --reserva) RESERVA=1; shift ;;
    --anterior-desligado) ANTERIOR_DESLIGADO=1; shift ;;
    --somente-gerar) SOMENTE_GERAR="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$DOMINIO" && -n "$BUCKET" && -n "$EMAIL_ADMIN" ]] || { echo "Informe --dominio, --bucket e --email-admin (veja --help)." >&2; exit 2; }
[[ "$DOMINIO" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "Domínio inválido: $DOMINIO" >&2; exit 2; }
[[ "$BUCKET" =~ ^[a-z0-9.-]{3,63}$ ]] || { echo "Nome de bucket inválido: $BUCKET" >&2; exit 2; }

if [[ -n "$ENDPOINT" ]]; then
  [[ "$ENDPOINT" =~ ^https://[a-z0-9.-]+$ ]] || { echo "Endpoint inválido (use https://...): $ENDPOINT" >&2; exit 2; }
  [[ "$REGIAO" == sa-east-1 ]] && REGIAO=auto
fi
COPIAS_ENV=$ETC/copias.env              # chaves do armazenamento das cópias (só no modo VPS)
SEGREDOS_OBJ="pagamentos/segredos/pagamentos.env.enc"

PACOTE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
passo() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
# aws s3 no destino certo (S3 do AWS, ou o endpoint do armazenamento compatível).
s3() { aws s3 "$@" --region "$REGIAO" ${ENDPOINT:+--endpoint-url "$ENDPOINT"}; }

# ---------------------------------------------------------------- configurações (texto)
gerar_env() { # $1 = papel (principal|reserva)
  local rotinas=1; [[ "$1" == reserva ]] && rotinas=0
  cat <<EOF
# PAY AX Pagamentos — configuração de produção. NÃO troque PAYAX_SECRET nem PAYAX_CHAVE_CREDENCIAIS depois de
# instalado: a chave cifra as credenciais do banco e dos IXC; trocada, elas ficam ilegíveis.
# Cópia cifrada: AWS Parameter Store ($PARAMETRO) ou, em VPS, s3://$BUCKET/$SEGREDOS_OBJ (frase de recuperação).
NODE_ENV=production
PORT=$PORTA
PAYAX_DADOS=$DADOS
PAYAX_URL_PUBLICA=https://$DOMINIO
PAYAX_TRUST_PROXY=loopback
PAYAX_FUSO=America/Sao_Paulo
PAYAX_SECRET=$(openssl rand -hex 32)
PAYAX_CHAVE_CREDENCIAIS=$(openssl rand -hex 32)
PAYAX_ADMIN_EMAIL=$EMAIL_ADMIN
PAYAX_ADMIN_SENHA=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
# Rotinas automáticas (PIX, remessa, retorno, backup): 1 só no servidor ATIVO.
PAYAX_ROTINAS=$rotinas
# Banco: comece em homologação. Depois da homologação com o Bradesco: PAYAX_BANCO_AMBIENTE=producao.
# Modo: bradesco (API) ou cnab (arquivo). Sem esta linha, produção usa a API.
PAYAX_BANCO_AMBIENTE=homologacao
# PAYAX_BANCO_MODO=cnab
EOF
}

gerar_servico() {
  cat <<EOF
[Unit]
Description=PAY AX Pagamentos
After=network-online.target
Wants=network-online.target

[Service]
User=$USUARIO
Group=$USUARIO
WorkingDirectory=$APP
EnvironmentFile=$ETC/pagamentos.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=5
# Proteções: o processo só escreve na pasta de dados.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DADOS
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
}

gerar_caddy() {
  cat <<EOF
# HTTPS automático (Let's Encrypt) para $DOMINIO. O sistema só escuta por trás deste proxy.
$DOMINIO {
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
	reverse_proxy 127.0.0.1:$PORTA
}
EOF
}

gerar_litestream() {
  if [[ -z "$ENDPOINT" ]]; then
    cat <<EOF
# Cópia contínua do banco (cada alteração vai para o S3 em ~1 segundo). Guarda 30 dias de histórico.
# Credenciais: o papel (IAM role) da máquina — nenhuma chave em disco.
dbs:
  - path: $DADOS/payax.db
    replicas:
      - type: s3
        bucket: $BUCKET
        path: pagamentos/banco
        region: $REGIAO
        retention: 720h
        snapshot-interval: 24h
EOF
  else
    cat <<EOF
# Cópia contínua do banco num armazenamento compatível com S3 (ex.: Cloudflare R2), a cada 10 segundos —
# intervalo que mantém o número de operações dentro da faixa gratuita. Guarda 30 dias de histórico.
# Credenciais: $COPIAS_ENV (só root lê).
dbs:
  - path: $DADOS/payax.db
    replicas:
      - type: s3
        bucket: $BUCKET
        path: pagamentos/banco
        endpoint: $ENDPOINT
        region: $REGIAO
        force-path-style: true
        sync-interval: 10s
        retention: 720h
        snapshot-interval: 24h
EOF
  fi
}

# Os arquivos do banco (CNAB), os backups conferidos e os enviados não estão dentro do banco de dados:
# vão para o S3 a cada 15 minutos.
gerar_copia_arquivos() {
  cat <<EOF
[Unit]
Description=PAY AX — cópia das pastas de dados para o S3

[Service]
Type=oneshot
EnvironmentFile=-$COPIAS_ENV
ExecStart=$AWS_BIN s3 sync $DADOS s3://$BUCKET/pagamentos/pastas --region $REGIAO ${ENDPOINT:+--endpoint-url $ENDPOINT }--exclude "payax.db*" --only-show-errors
EOF
}
gerar_copia_arquivos_timer() {
  cat <<EOF
[Unit]
Description=PAY AX — cópia das pastas a cada 15 minutos

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
EOF
}

if [[ -n "$SOMENTE_GERAR" ]]; then
  mkdir -p "$SOMENTE_GERAR"
  gerar_env principal > "$SOMENTE_GERAR/pagamentos.env"
  gerar_servico > "$SOMENTE_GERAR/payax-pagamentos.service"
  gerar_caddy > "$SOMENTE_GERAR/Caddyfile"
  gerar_litestream > "$SOMENTE_GERAR/litestream.yml"
  gerar_copia_arquivos > "$SOMENTE_GERAR/payax-copia-pastas.service"
  gerar_copia_arquivos_timer > "$SOMENTE_GERAR/payax-copia-pastas.timer"
  echo "Configurações escritas em $SOMENTE_GERAR (nada foi instalado)."
  exit 0
fi

# ---------------------------------------------------------------- instalação
[[ $EUID -eq 0 ]] || { echo "Rode como root (sudo)." >&2; exit 1; }
grep -q 'VERSION_ID="24.04"' /etc/os-release || echo "Aviso: testado para Ubuntu 24.04 LTS." >&2
export DEBIAN_FRONTEND=noninteractive

# Máquina pequena (2 GB): 2 GB de memória de troca evitam que a instalação das dependências falhe por falta de RAM.
if ! swapon --show | grep -q . && [[ $(awk '/MemTotal/ {print $2}' /proc/meminfo) -lt 3000000 ]]; then
  passo "Memória de troca (2 GB)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

passo "Pacotes do sistema"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg openssl rsync sqlite3 ufw caddy

passo "Node.js 22"
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node -v

passo "AWS CLI e Litestream"
command -v snap >/dev/null || apt-get install -y -q snapd
command -v aws >/dev/null || snap install aws-cli --classic
AWS_BIN="$(command -v aws)"
if ! command -v litestream >/dev/null; then
  arq="$(dpkg --print-architecture)"
  curl -fsSL -o /tmp/litestream.deb "https://github.com/benbjohnson/litestream/releases/download/v${VERSAO_LITESTREAM}/litestream-v${VERSAO_LITESTREAM}-linux-${arq}.deb"
  dpkg -i /tmp/litestream.deb
fi
install -d -m 750 "$ETC"
if [[ -n "$ENDPOINT" ]]; then
  if [[ ! -f "$COPIAS_ENV" ]]; then
    echo "Chave de acesso do armazenamento das cópias (no R2: R2 → Gerenciar tokens de API → 'Leitura e gravação de objetos')."
    read -r -p "  Access Key ID: " chave_id
    read -r -s -p "  Secret Access Key: " chave_segredo; echo
    umask 077
    printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$chave_id" "$chave_segredo" > "$COPIAS_ENV"
    umask 022
  fi
  set -a; . "$COPIAS_ENV"; set +a
  s3 ls "s3://$BUCKET/" >/dev/null \
    || { rm -f "$COPIAS_ENV"; echo "Sem acesso ao bucket $BUCKET em $ENDPOINT. Confira a chave e o nome do bucket." >&2; exit 1; }
  # O Litestream lê as mesmas chaves.
  install -d /etc/systemd/system/litestream.service.d
  printf '[Service]\nEnvironmentFile=%s\n' "$COPIAS_ENV" > /etc/systemd/system/litestream.service.d/payax.conf
else
  aws sts get-caller-identity --region "$REGIAO" >/dev/null \
    || { echo "A máquina não tem acesso ao AWS. Confira o papel (IAM role) PayaxPagamentosServidor (guia, passo 3)." >&2; exit 1; }
fi

passo "Usuário e pastas"
id "$USUARIO" >/dev/null 2>&1 || useradd --system --home "$DADOS" --shell /usr/sbin/nologin "$USUARIO"
install -d -o "$USUARIO" -g "$USUARIO" -m 750 "$DADOS"
install -d -m 755 "$APP"
install -d -m 750 "$ETC"

passo "Programa"
rsync -a --delete --exclude node_modules --exclude data --exclude test --exclude .env "$PACOTE"/ "$APP"/
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
chown -R root:root "$APP"

passo "Segredos"
# Lê os segredos guardados (0 = encontrou). Em VPS, pede a frase de recuperação para decifrar.
segredos_ler() {
  if [[ -z "$ENDPOINT" ]]; then
    aws ssm get-parameter --name "$PARAMETRO" --with-decryption --region "$REGIAO" --query Parameter.Value --output text > "$ETC/pagamentos.env.tmp" 2>/dev/null
    return
  fi
  s3 cp "s3://$BUCKET/$SEGREDOS_OBJ" "$ETC/segredos.enc" --only-show-errors 2>/dev/null || return 1
  read -r -s -p "Frase de recuperação da PAY AX: " FRASE; echo
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 300000 -in "$ETC/segredos.enc" -out "$ETC/pagamentos.env.tmp" -pass fd:3 3<<<"$FRASE" \
    || { rm -f "$ETC/segredos.enc" "$ETC/pagamentos.env.tmp"; echo "Frase de recuperação errada. Nada foi alterado." >&2; exit 1; }
  rm -f "$ETC/segredos.enc"
}
segredos_guardar() {
  if [[ -z "$ENDPOINT" ]]; then
    aws ssm put-parameter --name "$PARAMETRO" --type SecureString --value "file://$ETC/pagamentos.env.tmp" --region "$REGIAO" >/dev/null
    return
  fi
  if [[ -n "$(s3 ls "s3://$BUCKET/$SEGREDOS_OBJ" 2>/dev/null)" ]]; then
    echo "Já existem segredos guardados em s3://$BUCKET/$SEGREDOS_OBJ e não foi possível lê-los. Nada foi sobrescrito." >&2; exit 1
  fi
  echo "Crie a FRASE DE RECUPERAÇÃO (mín. 16 caracteres). Ela cifra os segredos do sistema guardados junto das cópias."
  echo "Guarde num cofre da empresa: sem ela, um servidor novo não consegue ler as credenciais do banco gravadas no sistema."
  while :; do
    read -r -s -p "  Frase: " FRASE; echo
    read -r -s -p "  Repita: " FRASE2; echo
    [[ "$FRASE" == "$FRASE2" && ${#FRASE} -ge 16 ]] && break
    echo "  As frases não conferem ou têm menos de 16 caracteres. De novo."
  done
  openssl enc -aes-256-cbc -pbkdf2 -iter 300000 -salt -in "$ETC/pagamentos.env.tmp" -out "$ETC/segredos.enc" -pass fd:3 3<<<"$FRASE"
  s3 cp "$ETC/segredos.enc" "s3://$BUCKET/$SEGREDOS_OBJ" --only-show-errors
  rm -f "$ETC/segredos.enc"
}
if segredos_ler; then
  echo "Segredos encontrados no AWS: este servidor usa os MESMOS do servidor anterior."
  NOVO=0
  if [[ $RESERVA -eq 0 && $ANTERIOR_DESLIGADO -eq 0 && ! -f "$DADOS/payax.db" ]]; then
    rm -f "$ETC/pagamentos.env.tmp"
    echo "Já existe (ou existiu) um servidor PAY AX ativo. Dois ativos pagariam o cliente duas vezes." >&2
    echo "Desligue o anterior (ou confirme que caiu) e rode de novo com --anterior-desligado." >&2
    exit 1
  fi
else
  echo "Primeira instalação: gerando os segredos e guardando cifrados."
  gerar_env principal > "$ETC/pagamentos.env.tmp"
  segredos_guardar
  NOVO=1
fi
if [[ $RESERVA -eq 1 ]]; then sed -i 's/^PAYAX_ROTINAS=.*/PAYAX_ROTINAS=0/' "$ETC/pagamentos.env.tmp"; else sed -i 's/^PAYAX_ROTINAS=.*/PAYAX_ROTINAS=1/' "$ETC/pagamentos.env.tmp"; fi
install -m 640 -o root -g "$USUARIO" "$ETC/pagamentos.env.tmp" "$ETC/pagamentos.env"
rm -f "$ETC/pagamentos.env.tmp"

passo "Serviços"
gerar_servico > /etc/systemd/system/payax-pagamentos.service
gerar_copia_arquivos > /etc/systemd/system/payax-copia-pastas.service
gerar_copia_arquivos_timer > /etc/systemd/system/payax-copia-pastas.timer
gerar_litestream > /etc/litestream.yml
gerar_caddy > /etc/caddy/Caddyfile
systemctl daemon-reload

passo "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -8

if [[ $RESERVA -eq 1 ]]; then
  systemctl disable --now payax-pagamentos litestream payax-copia-pastas.timer 2>/dev/null || true
  systemctl stop caddy || true
  passo "Reserva pronta e PARADA"
  echo "Para este servidor assumir: sudo $APP/implantacao/assumir.sh  (guia, seção 'Se o servidor principal cair')."
  exit 0
fi

passo "Banco de dados"
if [[ -f "$DADOS/payax.db" ]]; then
  echo "Banco já existe neste servidor: mantido."
else
  # Se a restauração falhar, PARA: subir com banco vazio apagaria, na prática, o razão dos clientes.
  litestream restore -if-replica-exists -config /etc/litestream.yml "$DADOS/payax.db" \
    || { echo "Falha ao restaurar a cópia do banco. Nada foi iniciado. Confira o acesso ao bucket $BUCKET." >&2; exit 1; }
  if [[ -f "$DADOS/payax.db" ]]; then
    echo "Banco restaurado da cópia contínua."
    s3 sync "s3://$BUCKET/pagamentos/pastas" "$DADOS" --only-show-errors
  elif [[ $NOVO -eq 0 ]]; then
    echo "Os segredos existem no AWS mas não há cópia do banco no S3. Nada foi iniciado: confira antes de criar um banco vazio." >&2
    exit 1
  else
    echo "Primeira instalação: o sistema cria o banco."
  fi
fi
chown -R "$USUARIO:$USUARIO" "$DADOS"

passo "Subindo"
systemctl enable payax-pagamentos && systemctl restart payax-pagamentos   # restart: na atualização, carrega o código novo
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORTA/api/saude" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORTA/api/saude" && echo
systemctl enable --now litestream payax-copia-pastas.timer
systemctl restart litestream
systemctl restart caddy

passo "Conferindo a cópia contínua"
copia_ok=0
for _ in $(seq 1 12); do
  if [[ -n "$(s3 ls "s3://$BUCKET/pagamentos/banco/" --recursive 2>/dev/null | head -1)" ]]; then copia_ok=1; break; fi
  sleep 10
done
if [[ $copia_ok -eq 1 ]]; then
  echo "Cópia contínua conferida: o banco já está no armazenamento."
else
  printf '\n\033[1;31mATENÇÃO: a cópia do banco ainda não apareceu em s3://%s/pagamentos/banco/.\033[0m\n' "$BUCKET"
  echo "O sistema está no ar, mas SEM cópia. Veja: journalctl -u litestream -n 50   — e não opere sem resolver."
fi

passo "Pronto"
echo "Endereço: https://$DOMINIO/   (Área do Cliente: https://$DOMINIO/cliente/)"
echo "Saúde:    https://$DOMINIO/api/saude"
if [[ $NOVO -eq 1 ]]; then
  echo "Administrador: $EMAIL_ADMIN"
  echo "Senha inicial: $(grep ^PAYAX_ADMIN_SENHA= "$ETC/pagamentos.env" | cut -d= -f2-)   ← anote; o sistema pede a troca no primeiro acesso."
fi
