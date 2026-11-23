#!/usr/bin/env bash
#
# Instala a PLAY TECH VIP num servidor Ubuntu/Debian limpo, do zero ao ar.
#
# Rode DENTRO do servidor, como root (ou com sudo):
#
#   sudo bash instalar-servidor.sh play.seudominio.com.br
#   sudo bash instalar-servidor.sh --sem-dominio      # sobe num endereço de teste, no próprio IP
#   sudo bash instalar-servidor.sh --simular          # mostra o que faria, sem mexer em nada
#   sudo bash instalar-servidor.sh --sem-demo         # sem o catálogo de demonstração
#
# O que ele faz, nesta ordem:
#   1. confere o sistema e instala o Docker, se faltar;
#   2. prepara /opt/playtechvip com o código que veio junto;
#   3. gera o .env com segredo e senha novos (mostrados uma vez só, no fim);
#   4. sobe a plataforma com HTTPS automático;
#   5. agenda o backup diário;
#   6. roda a conferência de instalação e mostra os endereços de acesso.
#
# É seguro rodar de novo: não apaga dados e não troca segredo que já existe.

set -euo pipefail

DESTINO=${DESTINO:-/opt/playtechvip}
PORTA_SSH=${PORTA_SSH:-22}
SIMULAR=0
DOMINIO=""
TESTE=0
SEM_DEMO=0

for arg in "$@"; do
  case "$arg" in
    --simular) SIMULAR=1 ;;
    --teste|--sem-dominio) TESTE=1 ;;
    --sem-demo) SEM_DEMO=1 ;;
    --ajuda|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Opção desconhecida: $arg"; exit 1 ;;
    *) DOMINIO="$arg" ;;
  esac
done

azul()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }
erro()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
rodar() { if [ "$SIMULAR" = 1 ]; then printf '  \033[90m› %s\033[0m\n' "$*"; else eval "$@"; fi; }

# ---------------------------------------------------------------- 1. o sistema

azul "1. Conferindo o servidor"

if [ "$SIMULAR" = 0 ] && [ "$(id -u)" != "0" ]; then
  erro "Rode como root: sudo bash $0 $*"
  exit 1
fi

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  ok "sistema: ${PRETTY_NAME:-desconhecido}"
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) aviso "feito para Ubuntu ou Debian; em ${ID:-outro sistema} pode falhar" ;;
  esac
else
  aviso "não consegui identificar o sistema"
fi

ARQ=$(uname -m)
[ "$ARQ" = "x86_64" ] && ok "arquitetura: x86_64" || aviso "arquitetura $ARQ (homologado em x86_64)"

MEM=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)
[ "$MEM" -ge 7 ] && ok "memória: ${MEM} GB" || aviso "memória: ${MEM} GB (o mínimo recomendado é 8 GB)"

LIVRE=$(df -BG --output=avail "$(dirname "$DESTINO")" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)
[ "${LIVRE:-0}" -ge 100 ] && ok "disco livre: ${LIVRE} GB" || aviso "disco livre: ${LIVRE} GB (vídeo ocupa muito: veja o documento de requisitos)"

# ---------------------------------------------------------------- 2. o domínio

azul "2. Endereço da plataforma"

IP_PUBLICO=$(curl -s --max-time 10 https://api.ipify.org || true)
[ -n "$IP_PUBLICO" ] && ok "IP público: $IP_PUBLICO" || aviso "não consegui descobrir o IP público"

if [ "$TESTE" = 1 ]; then
  if [ -z "$IP_PUBLICO" ]; then erro "o modo sem domínio precisa descobrir o IP público"; exit 1; fi
  DOMINIO="${IP_PUBLICO//./-}.sslip.io"
  aviso "sem domínio: usando $DOMINIO (DNS público que aponta para o próprio IP)"
  aviso "o HTTPS é real; quando o domínio definitivo chegar, troque em duas linhas (veja o fim)"
fi

# O e-mail da operação não acompanha endereço provisório: senão, ao trocar de domínio,
# o login continuaria sendo o do sslip.io, o que confunde quem opera.
case "$DOMINIO" in
  *.sslip.io|*.nip.io) EMAIL_ADMIN="admin@playtechvip.com.br" ;;
  *) EMAIL_ADMIN="admin@$DOMINIO" ;;
esac

if [ -z "$DOMINIO" ]; then
  erro "Informe o domínio: sudo bash $0 play.seudominio.com.br"
  erro "Ou use --teste para subir num domínio de teste apontado para este IP."
  exit 1
fi

RESOLVIDO=$(getent hosts "$DOMINIO" 2>/dev/null | awk '{print $1}' | head -1 || true)
if [ -z "$RESOLVIDO" ]; then
  aviso "$DOMINIO ainda não resolve — o certificado HTTPS só é emitido quando o DNS apontar para cá"
elif [ -n "$IP_PUBLICO" ] && [ "$RESOLVIDO" != "$IP_PUBLICO" ]; then
  aviso "$DOMINIO aponta para $RESOLVIDO, e este servidor é $IP_PUBLICO"
else
  ok "$DOMINIO aponta para este servidor"
fi

# ---------------------------------------------------------------- 3. Docker

azul "3. Docker"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "já instalado: $(docker --version | cut -d, -f1)"
else
  aviso "instalando o Docker Engine pelo script oficial"
  rodar "curl -fsSL https://get.docker.com -o /tmp/get-docker.sh"
  rodar "sh /tmp/get-docker.sh"
  rodar "systemctl enable --now docker"
  ok "Docker instalado"
fi

# ---------------------------------------------------------------- 4. arquivos

azul "4. Arquivos da plataforma"

ORIGEM=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [ "$ORIGEM" != "$DESTINO" ]; then
  rodar "mkdir -p '$DESTINO'"
  # --update: não volta atrás em arquivo mais novo; data/ e dist/ ficam de fora.
  rodar "tar -C '$ORIGEM' --exclude=node_modules --exclude=data --exclude=dist --exclude=.git --exclude=build --exclude=.gradle -cf - . | tar -C '$DESTINO' -xf -"
  ok "código em $DESTINO"
else
  ok "já rodando de $DESTINO"
fi
rodar "mkdir -p '$DESTINO/data/midia'"

# ---------------------------------------------------------------- 5. configuração

azul "5. Configuração (.env)"

ENV="$DESTINO/.env"
SENHA_NOVA=""
if [ -f "$ENV" ]; then
  ok ".env já existe — mantido como está (segredo e senha preservados)"
  rodar "sed -i 's|^DOMINIO=.*|DOMINIO=$DOMINIO|' '$ENV'"
else
  SEGREDO=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 64)
  SENHA_NOVA=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  if [ "$SIMULAR" = 1 ]; then
    printf '  \033[90m› geraria %s com segredo e senha novos\033[0m\n' "$ENV"
  else
    cat > "$ENV" <<FIM
# PLAY TECH VIP — configuração deste servidor. Gerado em $(date +%d/%m/%Y' às '%H:%M).
# NÃO versione este arquivo e não compartilhe o conteúdo.

DOMINIO=$DOMINIO
PORT=3600

# Segredo das sessões e dos links de reprodução. Trocar derruba todas as sessões.
TV_SECRET=$SEGREDO

# Administrador da operação, criado no primeiro start.
TV_ADMIN_EMAIL=$EMAIL_ADMIN
TV_ADMIN_SENHA=$SENHA_NOVA
TV_ADMIN_NOME=Operação PLAY TECH VIP

# Quantos núcleos a conversão de vídeo pode usar.
CPUS_APP=2

# Cobrança: a baixa é feita pela operação em Faturas (ou pelo IXC, quando a integração entrar).
TV_PAGAMENTOS=manual

# Base de filmes (themoviedb.org), para trazer capa, sinopse e ficha dos títulos.
# TV_TMDB_TOKEN=
FIM
    chmod 600 "$ENV"
    ok "gerado com segredo e senha novos"
  fi
fi

# ---------------------------------------------------------------- 6. firewall

azul "6. Portas"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  rodar "ufw allow ${PORTA_SSH}/tcp"
  rodar "ufw allow 80/tcp"
  rodar "ufw allow 443/tcp"
  ok "liberadas no ufw: SSH ($PORTA_SSH), 80 e 443"
else
  aviso "ufw inativo — garanta que 80 e 443 estejam abertas no firewall do provedor"
fi

# ---------------------------------------------------------------- 7. subir

azul "7. Subindo a plataforma"

rodar "cd '$DESTINO' && docker compose up -d --build"

if [ "$SIMULAR" = 0 ]; then
  printf '  aguardando a plataforma responder'
  PRONTA=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 3 "http://127.0.0.1:3600/api/saude" >/dev/null 2>&1 \
      || docker compose -f "$DESTINO/docker-compose.yml" exec -T app node -e "fetch('http://127.0.0.1:3600/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      PRONTA=1; break
    fi
    printf '.'; sleep 5
  done
  printf '\n'
  [ "$PRONTA" = 1 ] && ok "no ar" || aviso "ainda não respondeu — veja: docker compose -f $DESTINO/docker-compose.yml logs -f app"
fi

# ---------------------------------------------------------------- 8. dados de demonstração

azul "8. Dados de demonstração"

# Quem sabe se já existe conteúdo é o próprio contêiner: os dados moram no volume do Docker,
# não numa pasta do servidor. Perguntar pelo caminho de fora dava "vazio" sempre.
TEM_CONTEUDO=1
if [ "$SIMULAR" = 0 ]; then
  (cd "$DESTINO" && docker compose exec -T app node --disable-warning=ExperimentalWarning \
    -e "const {abrir}=require('./server/db'); process.exit(abrir().prepare('SELECT COUNT(*) n FROM canais').get().n > 0 ? 0 : 1)") >/dev/null 2>&1 || TEM_CONTEUDO=0
fi

if [ "$SEM_DEMO" = 1 ]; then
  ok "pulando os dados de demonstração (--sem-demo)"
elif [ "$SIMULAR" = 1 ]; then
  printf '  \033[90m› criaria canais, planos e catálogo de exemplo, se o banco estivesse vazio\033[0m\n'
elif [ "$TEM_CONTEUDO" = 1 ]; then
  ok "já existe conteúdo cadastrado — nada a criar"
else
  aviso "banco vazio: criando canais, planos e catálogo de exemplo"
  aviso "os filmes são baixados e convertidos: leva de 20 a 40 minutos nesta máquina"
  # Roda solto dentro do contêiner: se o SSH cair, a criação continua do mesmo jeito.
  (cd "$DESTINO" && docker compose exec -d app sh -c \
    'node --disable-warning=ExperimentalWarning server/seed.js > /app/data/seed.log 2>&1') || true
  ok "iniciado em segundo plano"
  echo "  acompanhe com: cd $DESTINO && sudo docker compose exec -T app tail -f /app/data/seed.log"
  echo "  (pode fechar o terminal: a criação segue no servidor)"
fi

# ---------------------------------------------------------------- 9. backup

azul "9. Backup diário"

CRON="/etc/cron.d/playtechvip-backup"
BACKUP_DIR=${BACKUP_DIR:-/var/backups/playtechvip}
if [ "$SIMULAR" = 1 ]; then
  printf '  \033[90m› criaria %s (03:20 todo dia), gravando em %s\033[0m\n' "$CRON" "$BACKUP_DIR"
else
  mkdir -p "$BACKUP_DIR"
  # O contêiner roda como o usuário 'node' (uid 1000): sem isto, ele não escreve na pasta.
  chown -R 1000:1000 "$BACKUP_DIR"
  cat > "$CRON" <<FIM
# Backup diário da PLAY TECH VIP (banco + mídia), guardando as 7 cópias mais recentes.
# Grava em $BACKUP_DIR, no disco do servidor — a pasta /backup dentro do contêiner é ela.
20 3 * * * root cd $DESTINO && docker compose exec -T app node --disable-warning=ExperimentalWarning scripts/backup.js /backup >> /var/log/playtechvip-backup.log 2>&1
FIM
  chmod 644 "$CRON"
  ok "agendado para as 03:20, em $BACKUP_DIR"
fi

# ---------------------------------------------------------------- 10. conferência

azul "10. Conferência"

if [ "$SIMULAR" = 0 ] && [ -x "$DESTINO/scripts/conferir-instalacao.sh" ]; then
  BASE="https://$DOMINIO" bash "$DESTINO/scripts/conferir-instalacao.sh" || true
fi

echo
azul "Pronto."
echo "  App do assinante : https://$DOMINIO/"
echo "  Painel da operação: https://$DOMINIO/admin/"
if [ -n "$SENHA_NOVA" ]; then
  echo
  echo "  Entre no painel com:"
  echo "    usuário: $EMAIL_ADMIN"
  echo "    senha  : $SENHA_NOVA"
  echo
  echo "  ANOTE A SENHA AGORA: ela não é mostrada de novo (fica cifrada no banco)."
  echo "  Troque-a no painel, em Equipe, depois do primeiro acesso."
fi
echo
echo "  Logs            : cd $DESTINO && docker compose logs -f app"
echo "  Parar / subir   : docker compose down  ·  docker compose up -d"
echo "  Conferir de novo: BASE=https://$DOMINIO bash $DESTINO/scripts/conferir-instalacao.sh"
if [ "$TESTE" = 1 ]; then
  echo
  azul "Quando o domínio definitivo chegar:"
  echo "  cd $DESTINO"
  echo "  sudo sed -i 's|^DOMINIO=.*|DOMINIO=play.seudominio.com.br|' .env"
  echo "  sudo docker compose up -d        # o certificado novo sai em segundos; os dados ficam"
fi
