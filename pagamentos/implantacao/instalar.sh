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
#   ./implantacao/instalar.sh ... --sem-copia-externa   (só testes: sem cópia fora do servidor; ligar depois
#                                                        rodando de novo com --bucket/--endpoint, sem reinstalar)
#   ./implantacao/instalar.sh ... --site payax.com.br   (site público com o acesso da Área do Cliente, e o www)
#   ./implantacao/instalar.sh ... --hestia auto    (servidor que já tem HestiaCP: publica como domínio do Hestia,
#                                                    "auto" = o usuário dono do domínio; ou o nome do usuário;
#                                                    sem Caddy e sem mexer no firewall, nos sites ou no e-mail)
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

SITE="" SEM_COPIA=0 REGIAO_INFORMADA=0 HESTIA_USUARIO="" ENDPOINT="" DOMINIO="" BUCKET="" EMAIL_ADMIN="" RESERVA=0 SOMENTE_GERAR="" ANTERIOR_DESLIGADO=0 AWS_BIN=/snap/bin/aws
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dominio) DOMINIO="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --email-admin) EMAIL_ADMIN="$2"; shift 2 ;;
    --regiao) REGIAO="$2"; REGIAO_INFORMADA=1; shift 2 ;;
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --reserva) RESERVA=1; shift ;;
    --anterior-desligado) ANTERIOR_DESLIGADO=1; shift ;;
    --somente-gerar) SOMENTE_GERAR="$2"; shift 2 ;;
    --hestia) HESTIA_USUARIO="${2:-admin}"; shift 2 ;;
    --sem-copia-externa) SEM_COPIA=1; shift ;;
    --site) SITE="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
done
[[ $SEM_COPIA -eq 1 && -z "$BUCKET" ]] && BUCKET="sem-copia-externa"
[[ -n "$DOMINIO" && -n "$BUCKET" && -n "$EMAIL_ADMIN" ]] || { echo "Informe --dominio, --bucket e --email-admin (veja --help)." >&2; exit 2; }
[[ "$DOMINIO" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "Domínio inválido: $DOMINIO" >&2; exit 2; }
[[ -z "$SITE" || "$SITE" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "Domínio do site inválido: $SITE" >&2; exit 2; }
[[ "$BUCKET" =~ ^[a-z0-9.-]{3,63}$ ]] || { echo "Nome de bucket inválido: $BUCKET" >&2; exit 2; }

if [[ -n "$ENDPOINT" ]]; then
  [[ "$ENDPOINT" =~ ^https://[a-z0-9.-]+$ ]] || { echo "Endpoint inválido (use https://...): $ENDPOINT" >&2; exit 2; }
  [[ $REGIAO_INFORMADA -eq 1 ]] || REGIAO=auto
fi
# aws = servidor EC2 com papel; s3 = armazenamento compatível (--endpoint); local = sem cópia externa (só testes)
MODO=aws; [[ -n "$ENDPOINT" ]] && MODO=s3; [[ $SEM_COPIA -eq 1 ]] && MODO=local
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
PAYAX_HOST=127.0.0.1
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
  [[ -n "$SITE" ]] && cat <<EOF

# Site público: $SITE (e www), com o acesso da Área do Cliente.
$SITE, www.$SITE {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:$PORTA
}
EOF
  return 0
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
$( [[ "$ENDPOINT" == *amazonaws.com* ]] || echo "        force-path-style: true" )
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

# Convivência: este servidor pode já ter outros serviços. Nada que esteja rodando é tocado sem aviso.
passo "Conferindo o que já roda neste servidor"
if [[ -n "$HESTIA_USUARIO" ]]; then
  export HESTIA=/usr/local/hestia PATH="$PATH:/usr/local/hestia/bin"
  [[ -x /usr/local/hestia/bin/v-list-users ]] || { echo "Este servidor não tem HestiaCP. Rode sem --hestia." >&2; exit 1; }
  # Usuário do Hestia: "auto" (ou um nome que não existe) usa o dono do domínio do sistema, se ele já estiver no Hestia.
  if [[ "$HESTIA_USUARIO" == auto ]] || ! v-list-user "$HESTIA_USUARIO" plain >/dev/null 2>&1; then
    dono="$(v-search-domain-owner "$DOMINIO" web 2>/dev/null || true)"
    if [[ -n "$dono" ]] && v-list-user "$dono" plain >/dev/null 2>&1; then
      [[ "$HESTIA_USUARIO" == auto ]] || echo "Usuário do Hestia '$HESTIA_USUARIO' não existe; usando '$dono', dono de $DOMINIO."
      HESTIA_USUARIO="$dono"
    else
      echo "Usuário do Hestia '$HESTIA_USUARIO' não existe. Usuários deste servidor:" >&2
      v-list-users plain 2>/dev/null | cut -f1 >&2 || true
      exit 1
    fi
  fi
  ss -Htlnp "( sport = :$PORTA )" | grep -qv node && { echo "A porta $PORTA já está em uso neste servidor." >&2; exit 1; } || true
  echo "HestiaCP encontrado: o sistema será publicado como o domínio $DOMINIO do usuário $HESTIA_USUARIO."
  echo "Sites, e-mail, firewall e painel do Hestia continuam como estão."
else
web="$(ss -Htlnp '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v caddy || true)"
if [[ -n "$web" ]]; then
  echo "As portas 80/443 já estão em uso por outro programa:" >&2; echo "$web" >&2
  echo "Nada foi instalado. Me mande esta saída: o sistema precisa ser publicado junto do que já existe (proxy atual)." >&2
  exit 1
fi
if [[ -f /etc/caddy/Caddyfile ]] && ! grep -q 'PAY AX\|/usr/share/caddy' /etc/caddy/Caddyfile; then
  echo "Já existe uma configuração própria do Caddy (/etc/caddy/Caddyfile). Nada foi instalado, para não sobrescrevê-la." >&2
  exit 1
fi
echo "Ok: portas 80 e 443 livres; os demais serviços continuam como estão."
fi

passo "Pacotes do sistema"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg openssl rsync sqlite3
[[ -n "$HESTIA_USUARIO" ]] || apt-get install -y -q ufw caddy   # com Hestia, o nginx e o firewall são dele

passo "Node.js 22"
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node -v

if [[ $MODO != local ]]; then
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
segredos_remotos_existem() {
  if [[ $MODO == aws ]]; then aws ssm get-parameter --name "$PARAMETRO" --region "$REGIAO" >/dev/null 2>&1
  else [[ -n "$(s3 ls "s3://$BUCKET/$SEGREDOS_OBJ" 2>/dev/null)" ]]; fi
}
if [[ -f "$ETC/pagamentos.env" ]]; then
  # Reinstalação ou atualização (ex.: ligando a cópia externa depois): os segredos deste servidor ficam.
  echo "Segredos deste servidor mantidos."
  cp "$ETC/pagamentos.env" "$ETC/pagamentos.env.tmp"
  NOVO=0
  if [[ $MODO != local ]] && ! segredos_remotos_existem; then
    echo "Guardando agora a cópia cifrada dos segredos junto das cópias."
    segredos_guardar
  fi
elif [[ $MODO == local ]]; then
  echo "Primeira instalação, sem cópia externa: segredos gerados e guardados só neste servidor."
  gerar_env principal > "$ETC/pagamentos.env.tmp"
  NOVO=1
elif segredos_ler; then
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
# Site público: os domínios dele mostram o site e a Área do Cliente (o Backoffice não aparece neles).
sed -i '/^PAYAX_SITE_HOSTS=/d' "$ETC/pagamentos.env.tmp"
[[ -n "$SITE" ]] && echo "PAYAX_SITE_HOSTS=$SITE,www.$SITE" >> "$ETC/pagamentos.env.tmp"
install -m 640 -o root -g "$USUARIO" "$ETC/pagamentos.env.tmp" "$ETC/pagamentos.env"
rm -f "$ETC/pagamentos.env.tmp"

passo "Serviços"
gerar_servico > /etc/systemd/system/payax-pagamentos.service
if [[ $MODO != local ]]; then
  gerar_copia_arquivos > /etc/systemd/system/payax-copia-pastas.service
  gerar_copia_arquivos_timer > /etc/systemd/system/payax-copia-pastas.timer
  gerar_litestream > /etc/litestream.yml
fi
[[ -n "$HESTIA_USUARIO" ]] || gerar_caddy > /etc/caddy/Caddyfile
systemctl daemon-reload

if [[ -n "$HESTIA_USUARIO" ]]; then
  passo "Firewall"
  echo "Mantido o firewall do Hestia. O sistema escuta só em 127.0.0.1:$PORTA — nenhuma porta nova aberta."
else
passo "Firewall"
if ! ufw status | grep -q "Status: active"; then
  # Firewall desligado e outros serviços no ar: libera antes as portas que eles já usam, para nada cair.
  while read -r proto porta; do
    [[ -n "$porta" && "$porta" != "$PORTA" ]] && ufw allow "$porta/$proto" >/dev/null && echo "Mantida aberta: $porta/$proto (serviço que já rodava)"
  done < <(ss -Htuln | awk '{split($5,a,":"); p=a[length(a)]; addr=$5; if (addr !~ /^(127\.|\[::1\]|::1)/) print $1, p}' | sort -u)
fi
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -12
fi

if [[ $RESERVA -eq 1 ]]; then
  systemctl disable --now payax-pagamentos litestream payax-copia-pastas.timer 2>/dev/null || true
  [[ -n "$HESTIA_USUARIO" ]] || systemctl stop caddy || true
  passo "Reserva pronta e PARADA"
  echo "Para este servidor assumir: sudo $APP/implantacao/assumir.sh  (guia, seção 'Se o servidor principal cair')."
  exit 0
fi

passo "Banco de dados"
if [[ -f "$DADOS/payax.db" ]]; then
  echo "Banco já existe neste servidor: mantido."
elif [[ $MODO == local ]]; then
  echo "Primeira instalação: o sistema cria o banco."
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
if [[ $MODO != local ]]; then
  systemctl enable --now litestream payax-copia-pastas.timer
  systemctl restart litestream
fi
if [[ -n "$HESTIA_USUARIO" ]]; then
  passo "Publicando pelo Hestia ($DOMINIO)"
  TPL=/usr/local/hestia/data/templates/web/nginx
  # Modelo de proxy do Hestia: o nginx dele encaminha o domínio para o sistema, com HTTPS do próprio Hestia.
  # Só usa o IP real do Cloudflare se o nginx tiver o módulo (senão a configuração inteira do servidor falharia).
  REALIP=0; nginx -V 2>&1 | grep -q http_realip_module && REALIP=1
  for ext in tpl stpl; do
    {
      echo "# PAY AX Pagamentos — modelo de proxy (gerado pelo instalador; não editar no painel)"
      echo "server {"
      if [[ $ext == tpl ]]; then
        echo "    listen      %ip%:%proxy_port%;"
        echo "    server_name %domain_idn% %alias_idn%;"
        echo "    include %home%/%user%/conf/web/%domain%/nginx.forcessl.conf*;"
      else
        echo "    listen      %ip%:%proxy_ssl_port% ssl;"
        echo "    server_name %domain_idn% %alias_idn%;"
        echo "    ssl_certificate      %ssl_pem%;"
        echo "    ssl_certificate_key  %ssl_key%;"
        echo "    include %home%/%user%/conf/web/%domain%/nginx.hsts.conf*;"
      fi
      echo "    client_max_body_size 20m;"
      # Atrás do Cloudflare (nuvem laranja), o IP de quem acessa vem no CF-Connecting-IP. Só é aceito quando a
      # conexão vem mesmo de um endereço do Cloudflare; sem Cloudflare, nada muda. Sem isso, a auditoria, o PLD e o
      # limite de tentativas de login veriam todo mundo com o mesmo IP (o do Cloudflare).
      [[ $REALIP -eq 1 ]] && for ip in 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 \
                190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 \
                104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 \
                2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32; do
        echo "    set_real_ip_from $ip;"
      done
      [[ $REALIP -eq 1 ]] && echo "    real_ip_header CF-Connecting-IP;"
      echo "    location ~ /\\.(?!well-known\\/) { deny all; return 404; }"
      echo "    location / {"
      echo "        proxy_pass http://127.0.0.1:$PORTA;"
      echo "        proxy_set_header Host \$host;"
      echo "        proxy_set_header X-Real-IP \$remote_addr;"
      echo "        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
      echo "        proxy_set_header X-Forwarded-Proto \$scheme;"
      echo "        proxy_read_timeout 120s;"
      echo "    }"
      [[ $ext == tpl ]] && echo "    include %home%/%user%/conf/web/%domain%/nginx.conf_*;" \
                        || echo "    include %home%/%user%/conf/web/%domain%/nginx.ssl.conf_*;"
      echo "}"
    } > "$TPL/payax.$ext"
  done
  # $1 = domínio; $2 = "www" para manter o www como apelido (site público).
  publicar() {
    local dom="$1" www="${2:-}"
    # Domínio que já existe no Hestia (site, e-mail ou DNS de outro usuário do painel): usa o dono dele,
    # porque o Hestia não deixa outro usuário criar o mesmo domínio.
    local u; u="$(v-search-domain-owner "$dom" web 2>/dev/null || true)"
    [[ -n "$u" ]] || u="$(v-search-domain-owner "$dom" 2>/dev/null || true)"
    [[ -n "$u" ]] || u="$HESTIA_USUARIO"
    if ! v-list-web-domain "$u" "$dom" plain >/dev/null 2>&1; then
      v-add-web-domain "$u" "$dom" "" no
      [[ "$www" == www ]] || v-delete-web-domain-alias "$u" "$dom" "www.$dom" no 2>/dev/null || true
    fi
    # Site: o www precisa estar como apelido (para o nginx atender e o certificado cobrir).
    [[ "$www" == www ]] && { v-add-web-domain-alias "$u" "$dom" "www.$dom" no 2>/dev/null || true; }
    v-change-web-domain-proxy-tpl "$u" "$dom" payax "" yes
    local apelidos=""; [[ "$www" == www ]] && apelidos="www.$dom"
    if v-add-letsencrypt-domain "$u" "$dom" "$apelidos" 2>/dev/null || v-list-web-domain-ssl "$u" "$dom" plain 2>/dev/null | grep -q .; then
      v-add-web-domain-ssl-force "$u" "$dom" 2>/dev/null || true
      echo "HTTPS ativo em $dom (Let's Encrypt, renovado pelo Hestia)."
    else
      printf '\033[1;33mHTTPS ainda não emitido: o DNS de %s%s precisa apontar para este servidor.\033[0m\n' "$dom" "${apelidos:+ e $apelidos}"
      echo "Quando apontar, rode: v-add-letsencrypt-domain $u $dom${apelidos:+ $apelidos} && v-add-web-domain-ssl-force $u $dom"
    fi
  }
  publicar "$DOMINIO"
  if [[ -n "$SITE" ]]; then passo "Publicando o site ($SITE e www.$SITE)"; publicar "$SITE" www || echo "O site não foi publicado agora: a conferência abaixo tenta de novo."; fi
else
  systemctl restart caddy
fi

if [[ $MODO == aws ]]; then
  # Vigilância de memória e disco (CloudWatch): os alarmes do guia avisam ANTES de faltar recurso.
  passo "Vigilância de memória e disco (CloudWatch)"
  if [[ ! -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl ]]; then
    curl -fsSL -o /tmp/cwagent.deb "https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/$(dpkg --print-architecture)/latest/amazon-cloudwatch-agent.deb" \
      && dpkg -i /tmp/cwagent.deb >/dev/null \
      || echo "Aviso: não foi possível instalar o agente do CloudWatch; os alarmes de memória e disco ficam sem dados." >&2
  fi
  [[ -d /opt/aws/amazon-cloudwatch-agent/etc ]] && cat > /opt/aws/amazon-cloudwatch-agent/etc/payax.json <<'JSON'
{
  "agent": { "metrics_collection_interval": 60 },
  "metrics": {
    "namespace": "PAYAX",
    "append_dimensions": { "InstanceId": "${aws:InstanceId}" },
    "aggregation_dimensions": [["InstanceId"]],
    "metrics_collected": {
      "mem": { "measurement": ["mem_used_percent"] },
      "disk": { "measurement": ["used_percent"], "resources": ["/"], "drop_device": true }
    }
  }
}
JSON
  [[ -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl ]] && /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/payax.json >/dev/null \
    || echo "Aviso: o agente do CloudWatch não iniciou (confira a política CloudWatchAgentServerPolicy do papel)." >&2
fi

passo "Atualizações de segurança automáticas"
apt-get install -y -q unattended-upgrades >/dev/null
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

if [[ $MODO == local ]]; then
  printf '\n\033[1;33mSEM CÓPIA EXTERNA: o banco só existe neste servidor (backup conferido a cada 12 h, no mesmo disco).\033[0m\n'
  echo "Use só para testes e homologação — nada de cliente real. Para ligar a cópia, rode de novo este instalador"
  echo "com --bucket/--endpoint/--regiao no lugar de --sem-copia-externa: banco e segredos são mantidos."
else
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
fi

# Confere cada endereço (sistema, site e www) e corrige o que der: domínio no Hestia, encaminhamento, HTTPS.
[[ -n "$HESTIA_USUARIO" ]] && bash "$(dirname "$0")/verificar.sh" || true

passo "Pronto"
echo "Endereço: https://$DOMINIO/   (Área do Cliente: https://$DOMINIO/cliente/)"
[[ -n "$SITE" ]] && echo "Site:     https://$SITE/   (com o acesso da Área do Cliente)"
echo "Saúde:    https://$DOMINIO/api/saude"
if [[ $NOVO -eq 1 ]]; then
  echo "Administrador: $EMAIL_ADMIN"
  echo "Senha inicial: $(grep ^PAYAX_ADMIN_SENHA= "$ETC/pagamentos.env" | cut -d= -f2-)   ← anote; o sistema pede a troca no primeiro acesso."
  if [[ $MODO == local ]]; then
    echo "IMPORTANTE: guarde uma cópia de $ETC/pagamentos.env num cofre da empresa (tem a chave que cifra as credenciais do banco)."
  fi
fi
