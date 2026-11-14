#!/usr/bin/env bash
# =============================================================================================
#  ZOE — Asterisk na mesma máquina da ZOE (chamado pelo instalar.sh --com-asterisk; pode rodar sozinho)
#
#  Instala o Asterisk (pacote do Ubuntu/Debian), a voz em português (espeak-ng) e a ponte zoe-central,
#  que escreve ramais, filas, URAs e números a partir do painel e manda as ligações para a ZOE.
#  Não mexe em configuração do Asterisk que já existia além de três linhas #include (marcadas "ZOE").
#
#     sudo bash ./instalacao/asterisk.sh [--porta 3600] [--node /caminho/do/node] [--sem-apt]
#
#  Depois: crie a chave da central no painel (master › Telefonia › Chave da central), cole em
#  /etc/asterisk/zoe.conf (ZOE_CHAVE=) e pronto — a ponte percebe sozinha em até 30 s.
# =============================================================================================
set -euo pipefail

ORIGEM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORTA=3600
NODE="$(command -v node || true)"
APT=1
LIB=/usr/local/lib/zoe
AST=/etc/asterisk
while [ $# -gt 0 ]; do
  case "$1" in
    --porta) PORTA="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --sem-apt) APT=0; shift ;;
    *) echo "Opção desconhecida: $1"; exit 1 ;;
  esac
done
passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
aviso() { printf '\033[1;33m[aviso]\033[0m %s\n' "$*"; }
falha() { printf '\033[1;31m[erro]\033[0m %s\n' "$*"; exit 1; }
[ "$(id -u)" -eq 0 ] || falha "Rode como root (sudo)."
[ -x "$NODE" ] || falha "Node não encontrado (use --node)."

if [ "$APT" = 1 ]; then
  passo "Asterisk, voz em português e conversão de áudio"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq asterisk espeak-ng sox >/dev/null
fi
command -v asterisk >/dev/null || falha "Asterisk não instalado."
echo "$(asterisk -V)"

passo "Configuração do Asterisk para a ZOE"
# Acesso local ao AMI só para a ponte (o manager.conf do pacote já inclui manager.d/*.conf e escuta só em 127.0.0.1).
mkdir -p "$AST/manager.d"
if [ ! -f "$AST/manager.d/zoe.conf" ]; then
  AMI_SENHA="$("$NODE" -e "process.stdout.write(require('crypto').randomBytes(18).toString('base64url'))")"
  cat > "$AST/manager.d/zoe.conf" <<CONF
; ZOE — usuário do AMI da ponte zoe-central (só de dentro do servidor)
[zoe]
secret = $AMI_SENHA
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = system,call,user,agent,reporting
write = system,command,reporting
CONF
else
  AMI_SENHA="$(sed -n 's/^secret *= *//p' "$AST/manager.d/zoe.conf" | head -1)"
fi
grep -q 'manager.d' "$AST/manager.conf" || printf '\n; ZOE\n#include "manager.d/*.conf"\n' >> "$AST/manager.conf"
grep -qE '^\s*enabled\s*=\s*yes' "$AST/manager.conf" || aviso "o AMI está desligado em manager.conf: ponha enabled = yes em [general]"

# O módulo SIP antigo (chan_sip) disputa a porta 5060 com o PJSIP: a ZOE usa só o PJSIP.
if [ -f /usr/lib/x86_64-linux-gnu/asterisk/modules/chan_sip.so ] || ls /usr/lib/*/asterisk/modules/chan_sip.so >/dev/null 2>&1; then
  # Tem de ficar na seção [modules] (o arquivo do pacote termina com outra seção).
  grep -qE '^\s*noload\s*=>\s*chan_sip.so' "$AST/modules.conf" || sed -i '/^\[modules\]/a noload => chan_sip.so   ; ZOE: só PJSIP (o chan_sip disputaria a porta 5060)' "$AST/modules.conf"
fi

# Transporte SIP (UDP 5060) só se o pjsip.conf ainda não tiver nenhum.
if ! grep -qE '^\s*type\s*=\s*transport' "$AST/pjsip.conf" "$AST"/pjsip_*.conf 2>/dev/null; then
  cat > "$AST/pjsip_zoe_transportes.conf" <<CONF
; ZOE — transporte SIP padrão (criado porque o pjsip.conf não tinha nenhum)
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
CONF
  grep -q 'pjsip_zoe_transportes.conf' "$AST/pjsip.conf" || printf '\n; ZOE\n#include pjsip_zoe_transportes.conf\n' >> "$AST/pjsip.conf"
fi
# Os três arquivos que a ponte escreve (vazios até a primeira sincronia).
for arq in pjsip_zoe.conf extensions_zoe.conf queues_zoe.conf; do
  [ -f "$AST/$arq" ] || printf '; Gerado pela ZOE (zoe-central). Ainda vazio: aguardando a primeira sincronia.\n' > "$AST/$arq"
  chown root:asterisk "$AST/$arq"; chmod 640 "$AST/$arq"
done
grep -q 'pjsip_zoe.conf' "$AST/pjsip.conf" || printf '\n; ZOE\n#include pjsip_zoe.conf\n' >> "$AST/pjsip.conf"
grep -q 'extensions_zoe.conf' "$AST/extensions.conf" || printf '\n; ZOE\n#include extensions_zoe.conf\n' >> "$AST/extensions.conf"
grep -q 'queues_zoe.conf' "$AST/queues.conf" || printf '\n; ZOE\n#include queues_zoe.conf\n' >> "$AST/queues.conf"

# Gravações das chamadas e falas geradas.
install -d -o asterisk -g asterisk -m 750 /var/spool/asterisk/monitor/zoe
install -d -o asterisk -g asterisk -m 755 /var/lib/asterisk/sounds/zoe-fala
install -d -o asterisk -g asterisk -m 750 /var/spool/asterisk/zoe-falas

# Configuração da ponte e do AGI (mantida numa atualização).
if [ ! -f "$AST/zoe.conf" ]; then
  cat > "$AST/zoe.conf" <<CONF
# ZOE — configuração da central (ponte zoe-central e AGI). Gerado pelo instalador.
# A ZOE nesta mesma máquina:
ZOE_URL=http://127.0.0.1:$PORTA/atendimento
# Cole aqui a chave da central (master › Telefonia › Chave da central). A ponte percebe sozinha.
ZOE_CHAVE=
# Várias empresas nesta central: uma chave por empresa (ZOE_CHAVE_<id da empresa>=cen_…)
AMI_USUARIO=zoe
AMI_SENHA=$AMI_SENHA
# Voz da ZOE e da URA (português do Brasil, gerada aqui mesmo):
ZOE_TTS_CMD=espeak-ng -v pt-br -s 160 --stdin -w "\$ZOE_SAIDA"
# Onde a fala do cliente fica enquanto é transcrita (apagada logo depois):
ZOE_GRAVACOES=/var/spool/asterisk/zoe-falas
# Conta da operadora da rota de saída N (o número da rota está em master › Telefonia › Rotas):
# TRONCO_1_USUARIO=
# TRONCO_1_SENHA=
# TRONCO_1_REGISTRO=1
# Telefone no navegador (precisa de HTTPS/WSS no Asterisk): ZOE_WEBRTC=1
CONF
fi
chown root:asterisk "$AST/zoe.conf"; chmod 640 "$AST/zoe.conf"

passo "Ponte zoe-central"
mkdir -p "$LIB/central"
install -m 755 "$ORIGEM/atendimento/scripts/zoe-agi.js" "$LIB/zoe-agi.js"
install -m 755 "$ORIGEM/atendimento/scripts/zoe-central.js" "$LIB/zoe-central.js"
install -m 644 "$ORIGEM/atendimento/scripts/central/gerar.js" "$ORIGEM/atendimento/scripts/central/ami.js" "$LIB/central/"
printf '#!/bin/sh\nexec %s %s/zoe-agi.js "$@"\n' "$NODE" "$LIB" > /usr/local/bin/zoe-agi
printf '#!/bin/sh\nexec %s %s/zoe-central.js "$@"\n' "$NODE" "$LIB" > /usr/local/bin/zoe-central
chmod 755 /usr/local/bin/zoe-agi /usr/local/bin/zoe-central
cat > /etc/systemd/system/zoe-central.service <<UNIT
[Unit]
Description=ZOE — ponte com o Asterisk (configuração e ligações)
After=asterisk.service network-online.target
Wants=asterisk.service

[Service]
ExecStart=/usr/local/bin/zoe-central
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

passo "Ligando o Asterisk e a ponte"
systemctl daemon-reload
systemctl enable asterisk zoe-central >/dev/null 2>&1 || true
systemctl restart asterisk
sleep 3
systemctl restart zoe-central
echo "Asterisk e ponte no ar. Falta só a chave da central em $AST/zoe.conf (ZOE_CHAVE=)."
