#!/usr/bin/env bash
#
# Vai Mídia — instalação no servidor (Ubuntu 24.04 LTS).
#
# Põe no ar, de uma vez: o site, o painel da equipe, os portais, o player das TVs e o servidor de
# e-mail da caixa do CRM. Tudo atrás do nginx, com HTTPS do Let's Encrypt e o serviço subindo sozinho
# quando a máquina reinicia.
#
#   sudo ./instalar.sh --dominio vaimidia.com.br --email voce@vaimidia.com.br
#
# Rodar de novo é seguro: o que já existe é respeitado (o arquivo de configuração, as senhas e a chave
# DKIM não são sobrescritos). Para ver o que ele faria sem mexer em nada, use --simular.
#
set -Eeuo pipefail

DOMINIO=""
EMAIL_ADMIN=""
SIMULAR=0
COM_TLS=1
COM_EMAIL=1
COM_FIREWALL=1
SO_ARQUIVOS=0
# Os caminhos podem ser trocados por variáveis de ambiente — serve para testar a instalação
# numa pasta qualquer, sem mexer na máquina de verdade.
DESTINO="${VAIMIDIA_DESTINO:-/opt/vaimidia}"
DADOS="${VAIMIDIA_DADOS:-/var/lib/vaimidia}"
CONFIG="${VAIMIDIA_CONFIG:-/etc/vaimidia}"
USUARIO="${VAIMIDIA_USUARIO:-vaimidia}"
PORTA_APP="${VAIMIDIA_PORTA:-3600}"

cor() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
titulo() { echo; cor '1;32' "==> $1"; }
aviso()  { cor '1;33' "    $1"; }
erro()   { cor '1;31' "ERRO: $1" >&2; }

ajuda() {
  cat <<'TXT'
Uso: sudo ./instalar.sh --dominio SEU.DOMINIO [opções]

  --dominio DOMINIO     Domínio onde o sistema vai responder (obrigatório).
  --email  ENDERECO     E-mail para o certificado HTTPS e para o acesso master.
  --sem-tls             Não emitir certificado agora (fica só em HTTP, na porta 80).
  --sem-email           Não ligar o servidor de e-mail (a caixa do CRM só mostra o que sai).
  --sem-firewall        Não mexer no ufw.
  --so-arquivos         Só gera a configuração e copia o sistema (sem apt, serviço, nginx nem
                        firewall). Útil para preparar a pasta antes, ou para testar.
  --simular             Mostra o que seria feito, sem alterar nada na máquina.
  --ajuda               Esta mensagem.
TXT
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dominio) DOMINIO="${2:-}"; shift 2 ;;
    --email) EMAIL_ADMIN="${2:-}"; shift 2 ;;
    --sem-tls) COM_TLS=0; shift ;;
    --sem-email) COM_EMAIL=0; shift ;;
    --sem-firewall) COM_FIREWALL=0; shift ;;
    --so-arquivos) SO_ARQUIVOS=1; COM_TLS=0; COM_FIREWALL=0; shift ;;
    --simular) SIMULAR=1; shift ;;
    --ajuda|-h|--help) ajuda; exit 0 ;;
    *) erro "opção desconhecida: $1"; ajuda; exit 2 ;;
  esac
done

# executar: tudo que mexe na máquina passa por aqui, para o --simular ser de verdade.
executar() {
  if [[ $SIMULAR -eq 1 ]]; then
    echo "    [simulação] $*"
  else
    "$@"
  fi
}
escrever() { # escrever <arquivo> <<<conteúdo lido da entrada padrão
  local arquivo="$1" conteudo
  conteudo="$(cat)"
  if [[ $SIMULAR -eq 1 ]]; then
    echo "    [simulação] escreveria $arquivo ($(wc -l <<<"$conteudo") linhas)"
  else
    printf '%s\n' "$conteudo" > "$arquivo"
  fi
}

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Copiar o sistema: com rsync quando existe (apaga o que saiu da versão nova); sem ele, tar.
copiar_sistema() {
  if command -v rsync >/dev/null 2>&1; then
    executar rsync -a --delete \
      --exclude node_modules --exclude data --exclude .git \
      "$RAIZ"/ "$DESTINO"/
  else
    aviso "rsync não está instalado: copiando com tar (arquivo removido na versão nova continua lá)."
    executar bash -c "cd '$RAIZ' && tar --exclude=./node_modules --exclude=./data --exclude=./.git -cf - . | tar -xf - -C '$DESTINO'"
  fi
}


# ---------------------------------------------------------------- conferências antes de começar
titulo "Conferindo a máquina"
[[ -n "$DOMINIO" ]] || { erro "informe o domínio: --dominio vaimidia.com.br"; exit 2; }
[[ "$DOMINIO" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || { erro "domínio inválido: $DOMINIO"; exit 2; }
if [[ $SIMULAR -eq 0 && "$(id -u)" -ne 0 ]]; then erro "rode com sudo."; exit 1; fi
[[ -f "$RAIZ/package.json" && -d "$RAIZ/server" ]] || { erro "não achei o sistema em $RAIZ."; exit 1; }

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  echo "    Sistema: ${PRETTY_NAME:-desconhecido}"
  [[ "${VERSION_ID:-}" == "24.04" ]] || aviso "feito para o Ubuntu 24.04 LTS; em outra versão pode faltar pacote."
fi
echo "    Domínio: $DOMINIO"
echo "    Sistema em: $DESTINO   ·   dados em: $DADOS"
[[ $SIMULAR -eq 1 ]] && aviso "MODO SIMULAÇÃO: nada será alterado."

# ---------------------------------------------------------------- pacotes
titulo "Instalando o que falta no sistema"
if [[ $SO_ARQUIVOS -eq 1 ]]; then
  echo "    (--so-arquivos: pulando os pacotes do sistema)"
fi
PACOTES=(curl ca-certificates gnupg rsync nginx)
[[ $COM_TLS -eq 1 ]] && PACOTES+=(certbot python3-certbot-nginx)
[[ $COM_FIREWALL -eq 1 ]] && PACOTES+=(ufw)
if [[ $SO_ARQUIVOS -eq 0 ]]; then
  executar env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  executar env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${PACOTES[@]}"
fi

# Node 22: o sistema usa o banco SQLite que vem dentro do próprio Node (precisa de 22.13 ou mais novo).
precisa_node=1
if command -v node >/dev/null 2>&1; then
  atual="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
  maior="$(printf '%s\n22.13.0\n' "$atual" | sort -V | tail -1)"
  [[ "$maior" == "$atual" ]] && precisa_node=0 && echo "    Node $atual já serve."
fi
if [[ $precisa_node -eq 1 && $SO_ARQUIVOS -eq 0 ]]; then
  echo "    Instalando o Node 22 (repositório oficial NodeSource)…"
  executar bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
  executar env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
fi

# ---------------------------------------------------------------- usuário e pastas
titulo "Criando o usuário e as pastas"
if ! id "$USUARIO" >/dev/null 2>&1; then
  if [[ $SO_ARQUIVOS -eq 1 ]]; then
    USUARIO="$(id -un)"
    aviso "--so-arquivos: usando o usuário atual ($USUARIO) no lugar de vaimidia."
  else
    executar useradd --system --home-dir "$DADOS" --shell /usr/sbin/nologin "$USUARIO"
  fi
fi
executar install -d -o "$USUARIO" -g "$USUARIO" -m 750 "$DADOS" "$DADOS/arquivos" "$DADOS/emails" "$DADOS/backups"
executar install -d -o root -g "$USUARIO" -m 750 "$CONFIG"
executar install -d -o root -g root -m 755 "$DESTINO"

# ---------------------------------------------------------------- aplicação
titulo "Copiando o sistema para $DESTINO"
copiar_sistema
[[ $SO_ARQUIVOS -eq 0 ]] && executar chown -R root:root "$DESTINO"

echo "    Instalando as dependências (express, nodemailer, qrcode)…"
if [[ -f "$RAIZ/package-lock.json" ]]; then
  executar npm ci --omit=dev --prefix "$DESTINO"
else
  executar npm install --omit=dev --prefix "$DESTINO"
fi

# ---------------------------------------------------------------- configuração e segredos
titulo "Configuração"
ENV_ARQ="$CONFIG/vaimidia.env"
SENHA_MASTER=""
if [[ -f "$ENV_ARQ" ]]; then
  echo "    $ENV_ARQ já existe: mantido como está."
else
  SEGREDO="$(openssl rand -hex 32)"
  SENHA_MASTER="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  EMAIL_MASTER="${EMAIL_ADMIN:-master@$DOMINIO}"
  escrever "$ENV_ARQ" <<TXT
# Vai Mídia — configuração do servidor. Gerado pela instalação em $(date '+%d/%m/%Y %H:%M').
# Depois de mudar qualquer coisa aqui: sudo systemctl restart vaimidia
NODE_ENV=production
PORT=$PORTA_APP
MIDIA_BASE_PATH=/midia
MIDIA_SITE=1
MIDIA_URL=https://$DOMINIO/midia
MIDIA_TRUST_PROXY=loopback

# Segredo das sessões e dos tokens das TVs. Trocar derruba todo mundo (e as TVs pareadas).
MIDIA_SECRET=$SEGREDO

# Acesso master criado no primeiro arranque.
MIDIA_ADMIN_NOME=Master
MIDIA_ADMIN_EMAIL=$EMAIL_MASTER
MIDIA_ADMIN_SENHA=$SENHA_MASTER

# Dados: banco, criativos, mensagens de e-mail e backups.
MIDIA_DB=$DADOS/midia.db
MIDIA_ARQUIVOS=$DADOS/arquivos
MIDIA_BACKUPS=$DADOS/backups
MIDIA_BACKUP_HORAS=24
MIDIA_BACKUP_MANTER=30
# Espelho dos criativos em outro disco (recomendado quando houver):
# MIDIA_ESPELHO=/mnt/backup/vaimidia

# Caixa de entrada do CRM: receber e-mail dos clientes neste domínio.
$( [[ $COM_EMAIL -eq 1 ]] && echo "MIDIA_EMAIL_DOMINIOS=$DOMINIO" || echo "# MIDIA_EMAIL_DOMINIOS=$DOMINIO" )
# Nome desta máquina como servidor de e-mail: é o que vai no MX e no DNS reverso do IP.
MIDIA_EMAIL_NOME=mail.$DOMINIO
MIDIA_EMAIL_PORTA=25
MIDIA_EMAIL_PASTA=$DADOS/emails
MIDIA_EMAIL_MAX_MB=10

# Assinatura DKIM do que sai (a chave pública vai no DNS; veja o fim da instalação).
MIDIA_DKIM_DOMINIO=$DOMINIO
MIDIA_DKIM_SELETOR=vaimidia
MIDIA_DKIM_CHAVE=$CONFIG/dkim.pem

# ENVIO de e-mail (avisos, recuperação de senha e as respostas do CRM).
# Recomendação: use um provedor (Google Workspace, Zoho, Amazon SES). Servidor novo mandando
# sozinho cai no spam até construir reputação. Preencha e reinicie o serviço.
#MIDIA_SMTP_HOST=smtp.seuprovedor.com.br
#MIDIA_SMTP_PORTA=587
#MIDIA_SMTP_SEGURO=0
#MIDIA_SMTP_USUARIO=comercial@$DOMINIO
#MIDIA_SMTP_SENHA=
MIDIA_SMTP_DE="Vai Mídia <comercial@$DOMINIO>"
TXT
  executar chown root:"$USUARIO" "$ENV_ARQ"
  executar chmod 640 "$ENV_ARQ"
fi

# Chave DKIM: só nasce uma vez. Trocar depois invalida a assinatura até atualizar o DNS.
if [[ -f "$CONFIG/dkim.pem" ]]; then
  echo "    Chave DKIM já existe: mantida."
else
  echo "    Gerando a chave DKIM…"
  executar openssl genrsa -out "$CONFIG/dkim.pem" 2048
  executar chown root:"$USUARIO" "$CONFIG/dkim.pem"
  executar chmod 640 "$CONFIG/dkim.pem"
fi

# ---------------------------------------------------------------- serviço
if [[ $SO_ARQUIVOS -eq 1 ]]; then
  titulo "Pronto (--so-arquivos)"
  echo "    Configuração: $ENV_ARQ"
  echo "    Sistema:      $DESTINO"
  echo "    Dados:        $DADOS"
  [[ -n "$SENHA_MASTER" ]] && { echo; cor '1;33' "  Senha do master: $SENHA_MASTER"; }
  exit 0
fi

titulo "Ligando o serviço"
# O caminho do node muda conforme a origem do pacote; o serviço aponta para o que existe nesta máquina.
NODE_BIN="$(command -v node || echo /usr/bin/node)"
if [[ $SIMULAR -eq 1 ]]; then
  echo "    [simulação] escreveria /etc/systemd/system/vaimidia.service (node em $NODE_BIN)"
else
  sed "s|/usr/bin/node|$NODE_BIN|" "$RAIZ/instalacao/vaimidia.service" > /etc/systemd/system/vaimidia.service
  chmod 644 /etc/systemd/system/vaimidia.service
fi
executar systemctl daemon-reload
executar systemctl enable vaimidia
executar systemctl restart vaimidia

# ---------------------------------------------------------------- nginx
titulo "Pondo o nginx na frente"
if [[ $SIMULAR -eq 1 ]]; then
  echo "    [simulação] escreveria /etc/nginx/sites-available/vaimidia para $DOMINIO"
else
  if [[ -f /proc/net/if_inet6 ]]; then
    sed -e "s/__DOMINIO__/$DOMINIO/g" -e "s/#IPV6#//" "$RAIZ/instalacao/nginx-vaimidia.conf" > /etc/nginx/sites-available/vaimidia
  else
    echo "    Esta máquina não tem IPv6: o nginx vai ouvir só em IPv4."
    sed -e "s/__DOMINIO__/$DOMINIO/g" -e "/#IPV6#/d" "$RAIZ/instalacao/nginx-vaimidia.conf" > /etc/nginx/sites-available/vaimidia
  fi
fi
executar ln -sf /etc/nginx/sites-available/vaimidia /etc/nginx/sites-enabled/vaimidia
[[ -e /etc/nginx/sites-enabled/default ]] && executar rm -f /etc/nginx/sites-enabled/default
executar nginx -t
executar systemctl reload nginx

# ---------------------------------------------------------------- firewall
if [[ $COM_FIREWALL -eq 1 ]]; then
  titulo "Firewall"
  executar ufw allow OpenSSH
  executar ufw allow 'Nginx Full'
  [[ $COM_EMAIL -eq 1 ]] && executar ufw allow 25/tcp
  executar ufw --force enable
  aviso "O acesso por SSH foi liberado antes de ligar o firewall — a sessão atual não cai."
fi

# ---------------------------------------------------------------- HTTPS
if [[ $COM_TLS -eq 1 ]]; then
  titulo "Certificado HTTPS (Let's Encrypt)"
  aviso "Isto só funciona se $DOMINIO já estiver apontando para o IP desta máquina."
  # Só entram no certificado os nomes que já existem no DNS: um nome que não resolve derruba a emissão inteira.
  NOMES=(-d "$DOMINIO")
  for extra in "www.$DOMINIO" "midia.$DOMINIO" "tv.$DOMINIO"; do
    if getent ahostsv4 "$extra" >/dev/null 2>&1; then NOMES+=(-d "$extra"); else aviso "$extra ainda não resolve: fica fora do certificado por enquanto."; fi
  done
  if [[ -n "$EMAIL_ADMIN" ]]; then
    executar certbot --nginx "${NOMES[@]}" --agree-tos -m "$EMAIL_ADMIN" --redirect --non-interactive || \
      aviso "O certificado não saiu agora. Confira o DNS e rode: sudo certbot --nginx -d $DOMINIO"
  else
    executar certbot --nginx "${NOMES[@]}" --agree-tos --register-unsafely-without-email --redirect --non-interactive || \
      aviso "O certificado não saiu agora. Confira o DNS e rode: sudo certbot --nginx -d $DOMINIO"
  fi
fi

# ---------------------------------------------------------------- o que ficou pronto
IP_PUBLICO="$(curl -s --max-time 5 https://api.ipify.org || echo 'SEU.IP')"
DKIM_PUB=""
if [[ -f "$CONFIG/dkim.pem" ]]; then
  DKIM_PUB="$(openssl rsa -in "$CONFIG/dkim.pem" -pubout 2>/dev/null | grep -v 'PUBLIC KEY' | tr -d '\n')"
fi

titulo "Pronto"
cat <<TXT

  Site .................. https://$DOMINIO
  Painel da equipe ...... https://$DOMINIO/p  (ou https://midia.$DOMINIO)
  Player das TVs ........ https://tv.$DOMINIO  (ou https://$DOMINIO/tv)

  Serviço ............... sudo systemctl status vaimidia
  Registro ao vivo ...... sudo journalctl -u vaimidia -f
  Configuração .......... $ENV_ARQ
  Dados e backups ....... $DADOS

TXT

if [[ -n "$SENHA_MASTER" ]]; then
  cor '1;33' "  ACESSO MASTER (anote agora, só aparece desta vez)"
  echo "    E-mail: ${EMAIL_ADMIN:-master@$DOMINIO}"
  echo "    Senha:  $SENHA_MASTER"
  echo
fi

cor '1;32' "  O QUE FALTA NO DNS DO DOMÍNIO"
cat <<TXT

  A       $DOMINIO                   ->  $IP_PUBLICO
  A       www.$DOMINIO               ->  $IP_PUBLICO
  A       midia.$DOMINIO             ->  $IP_PUBLICO   (atalho para o painel)
  A       tv.$DOMINIO                ->  $IP_PUBLICO   (atalho para o player das TVs)
TXT
if [[ $COM_EMAIL -eq 1 ]]; then
cat <<TXT
  A       mail.$DOMINIO              ->  $IP_PUBLICO
  MX      $DOMINIO                   ->  mail.$DOMINIO   (prioridade 10)
  TXT     $DOMINIO                   ->  "v=spf1 ip4:$IP_PUBLICO -all"
  TXT     vaimidia._domainkey.$DOMINIO ->  "v=DKIM1; k=rsa; p=$DKIM_PUB"
  TXT     _dmarc.$DOMINIO            ->  "v=DMARC1; p=none; rua=mailto:postmaster@$DOMINIO"

  E, no provedor da máquina: DNS reverso (PTR) do IP $IP_PUBLICO para mail.$DOMINIO, e a porta 25
  liberada na entrada. Quase toda nuvem bloqueia a 25 por padrão e só abre a pedido.
TXT
fi
cat <<TXT

  Para colar esses registros no Registro.br (com a chave DKIM já dividida em pedaços,
  que é o que a tela deles exige):

    sudo $DESTINO/instalacao/dns-registrobr.sh --dominio $DOMINIO

  Para o sistema RESPONDER e-mail, preencha MIDIA_SMTP_* em $ENV_ARQ
  e reinicie: sudo systemctl restart vaimidia

  Conferência rápida depois do DNS no ar:
    curl -I https://$DOMINIO
    sudo systemctl status vaimidia
TXT
[[ $COM_EMAIL -eq 1 ]] && echo "    nc -vz $DOMINIO 25     (de fora da máquina, para ver se a porta 25 entra)"
echo
