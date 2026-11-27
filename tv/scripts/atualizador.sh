#!/usr/bin/env bash
#
# Agente de atualização da PLAY TECH VIP.
#
# Roda NO SERVIDOR (cron, a cada minuto), fora do contêiner. O painel só deposita o pacote numa
# pasta compartilhada; quem extrai e reconstrói é este script. É essa separação que evita dar ao
# contêiner acesso ao Docker do servidor — com ele, quem invadisse o app viraria root na máquina.
#
#   sudo bash scripts/atualizador.sh            # aplica se houver pedido
#   sudo bash scripts/atualizador.sh --instalar # instala no cron (o instalador já faz isso)
#   sudo bash scripts/atualizador.sh --senha    # cria ou troca a senha de atualização
#   sudo bash scripts/atualizador.sh --sem-senha # volta a aceitar pacote sem senha
#
# SENHA DE ATUALIZAÇÃO. Este script roda como root e executa o que vier no pacote: quem consegue
# pôr um pacote na pasta compartilhada manda no servidor. Sem a senha, isso é qualquer pessoa
# com a senha do painel — ou qualquer falha que deixe gravar arquivo de dentro do app. Com ela,
# o pacote só é aplicado se vier acompanhado de uma senha que o APP NÃO CONHECE: o resumo dela
# fica em /etc/playtechvip, fora do contêiner e fora da pasta compartilhada. O painel só repassa
# o que a pessoa digitou na hora; quem confere é este script.
#
# Pasta compartilhada (montada no contêiner como /atualizacao):
#   pacote.tar.gz   enviado pelo painel
#   pedido.json     existe = há o que aplicar
#   estado.json     resultado da última tentativa, lido pelo painel
#   registro.log    saída da última atualização, mostrada no painel

set -uo pipefail

DESTINO=${DESTINO:-/opt/playtechvip}
PASTA=${TV_ATUALIZACAO_HOST:-/var/lib/playtechvip/atualizacao}
PACOTE_TGZ="$PASTA/pacote.tar.gz"
PACOTE_ZIP="$PASTA/pacote.zip"
PEDIDO="$PASTA/pedido.json"
ESTADO="$PASTA/estado.json"
REGISTRO="$PASTA/registro.log"
TRAVA="$PASTA/.trava"

# Resumo (PBKDF2) da senha de atualização. Só root lê; o contêiner não enxerga este caminho.
CHAVE=${TV_ATUALIZACAO_CHAVE:-/etc/playtechvip/atualizacao.chave}
# Só avisa o painel de que deve pedir a senha. Não decide nada: apagar este arquivo de dentro
# do app não libera coisa alguma, porque quem manda é a existência de $CHAVE.
BANDEIRA="$PASTA/exige-senha"

mkdir -p "$PASTA"

if [ "${1:-}" = "--senha" ]; then
  # A senha é lida do terminal, sem eco, e nunca passa por argumento (apareceria no `ps` e no
  # histórico). TV_NOVA_SENHA existe só para a instalação automática e para os testes.
  if [ -n "${TV_NOVA_SENHA:-}" ]; then
    senha1="$TV_NOVA_SENHA"; senha2="$TV_NOVA_SENHA"
  else
    read -r -s -p "Senha de atualização (mínimo 10 caracteres): " senha1; echo
    read -r -s -p "Repita a senha: " senha2; echo
  fi
  if [ "$senha1" != "$senha2" ]; then echo "As duas senhas não são iguais. Nada foi alterado." >&2; exit 1; fi
  if [ "${#senha1}" -lt 10 ]; then echo "A senha precisa de pelo menos 10 caracteres. Nada foi alterado." >&2; exit 1; fi
  mkdir -p "$(dirname "$CHAVE")"
  chmod 700 "$(dirname "$CHAVE")"
  # Grava ao lado e renomeia: uma queda no meio não deixa a chave pela metade (o que travaria
  # toda atualização pelo painel até alguém entrar por SSH).
  if ! SENHA="$senha1" python3 - "$CHAVE.novo" <<'PYEOF'
import hashlib, os, sys
sal = os.urandom(16)
voltas = 600000
resumo = hashlib.pbkdf2_hmac('sha256', os.environ['SENHA'].encode('utf-8'), sal, voltas)
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write('pbkdf2$%d$%s$%s\n' % (voltas, sal.hex(), resumo.hex()))
PYEOF
  then echo "Não foi possível gravar a senha." >&2; rm -f "$CHAVE.novo"; exit 1; fi
  mv -f "$CHAVE.novo" "$CHAVE"
  chmod 600 "$CHAVE"
  : > "$BANDEIRA"; chown 1000:1000 "$BANDEIRA" 2>/dev/null || true
  echo "Senha de atualização gravada. O painel passa a pedi-la a cada envio de pacote."
  exit 0
fi

if [ "${1:-}" = "--sem-senha" ]; then
  rm -f "$CHAVE" "$BANDEIRA"
  echo "Senha de atualização removida: o painel volta a aplicar pacote só com o login do administrador."
  exit 0
fi

if [ "${1:-}" = "--instalar" ]; then
  linha="* * * * * root DESTINO=$DESTINO bash $DESTINO/scripts/atualizador.sh >> $PASTA/cron.log 2>&1"
  echo "$linha" > /etc/cron.d/playtechvip-atualizador
  chmod 644 /etc/cron.d/playtechvip-atualizador
  # O contêiner roda como uid 1000 e precisa escrever o pedido aqui.
  chown -R 1000:1000 "$PASTA"
  echo "Agente de atualização instalado (verifica a cada minuto)."
  exit 0
fi

# Mantém a bandeira igual à realidade a cada passada (ela mora na pasta que o app escreve, então
# pode ter sido apagada; a chave, não).
if [ -s "$CHAVE" ]; then
  [ -f "$BANDEIRA" ] || { : > "$BANDEIRA"; chown 1000:1000 "$BANDEIRA" 2>/dev/null || true; }
else
  rm -f "$BANDEIRA"
fi

[ -f "$PEDIDO" ] || exit 0

# Duas execuções ao mesmo tempo derrubariam a plataforma no meio da reconstrução.
exec 9>"$TRAVA"
flock -n 9 || exit 0

inicio=$(date -Is)
registrar() { printf '%s\n' "$*" | tee -a "$REGISTRO" >&2; }
gravar_estado() {
  cat > "$ESTADO" <<FIM
{
  "situacao": "$1",
  "detalhe": $(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""'),
  "inicio": "$inicio",
  "fim": "$(date -Is)"
}
FIM
  chown 1000:1000 "$ESTADO" 2>/dev/null || true
}

: > "$REGISTRO"
registrar "[$(date -Is)] atualização pedida, começando"

# Senha de atualização: conferida ANTES de qualquer coisa do pacote ser lida ou extraída.
if [ -s "$CHAVE" ]; then
  if python3 - "$CHAVE" "$PEDIDO" <<'PYEOF'
import hashlib, hmac, json, sys
try:
    alg, voltas, sal, esperado = open(sys.argv[1]).read().strip().split('$')
    senha = json.load(open(sys.argv[2])).get('senha') or ''
    feito = hashlib.pbkdf2_hmac('sha256', str(senha).encode('utf-8'), bytes.fromhex(sal), int(voltas)).hex()
    ok = alg == 'pbkdf2' and bool(senha) and hmac.compare_digest(feito, esperado)
except Exception:
    ok = False
sys.exit(0 if ok else 1)
PYEOF
  then
    registrar "senha de atualização conferida"
  else
    # Uma tentativa por minuto é o teto natural (o cron): não há como testar senhas em massa.
    registrar "senha de atualização ausente ou incorreta — pacote descartado sem ser aberto"
    gravar_estado erro "Senha de atualização incorreta. O pacote não foi aplicado."
    rm -f "$PEDIDO" "$PACOTE_TGZ" "$PACOTE_ZIP"
    exit 1
  fi
fi
# A senha não fica em disco depois de conferida: o pedido segue sem ela.
python3 - "$PEDIDO" <<'PYEOF' 2>/dev/null || true
import json, sys
d = json.load(open(sys.argv[1]))
if 'senha' in d:
    d.pop('senha')
    json.dump(d, open(sys.argv[1], 'w'), indent=2)
PYEOF

# O painel manda .tar.gz ou .zip — o que a pessoa tiver em mãos.
if [ -s "$PACOTE_TGZ" ]; then
  PACOTE="$PACOTE_TGZ"; FORMATO=tar.gz
elif [ -s "$PACOTE_ZIP" ]; then
  PACOTE="$PACOTE_ZIP"; FORMATO=zip
else
  registrar "pacote não encontrado em $PASTA"
  gravar_estado erro "O pacote não chegou ao servidor."
  rm -f "$PEDIDO"
  exit 1
fi
registrar "formato: $FORMATO"

# Confere o pacote ANTES de mexer na instalação: um arquivo corrompido não pode deixar a
# plataforma pela metade. O teste abaixo lê o tar inteiro sem gravar nada.
listar() {
  if [ "$FORMATO" = zip ]; then
    python3 -c "import sys,zipfile;[print(n) for n in zipfile.ZipFile(sys.argv[1]).namelist()]" "$PACOTE"
  else
    tar -tzf "$PACOTE"
  fi
}

if ! listar > /dev/null 2>>"$REGISTRO"; then
  registrar "pacote corrompido ou ilegível"
  gravar_estado erro "O pacote está corrompido. Envie de novo."
  rm -f "$PEDIDO" "$PACOTE"
  exit 1
fi
# Aceita "./server/index.js" e "server/index.js": muda conforme como o pacote foi montado.
if ! listar | grep -qE '(^|/)server/index\.js$'; then
  registrar "o pacote não tem server/index.js — não é a plataforma. O que veio dentro:"
  listar | head -15 | sed 's/^/    /' >> "$REGISTRO"
  gravar_estado erro "Este arquivo não é o pacote da plataforma."
  rm -f "$PEDIDO" "$PACOTE"
  exit 1
fi

# Guarda o .env e os dados: eles não vêm no pacote e não podem ser tocados.
registrar "extraindo em $DESTINO"
extrair() {
  if [ "$FORMATO" = zip ]; then
    # unzip pode não estar instalado; o zipfile do Python vem com o sistema.
    python3 -c "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$PACOTE" "$DESTINO"
  else
    tar -C "$DESTINO" -xzf "$PACOTE"
  fi
}
if ! extrair >>"$REGISTRO" 2>&1; then
  registrar "falha ao extrair"
  gravar_estado erro "Não foi possível extrair o pacote no servidor."
  rm -f "$PEDIDO"
  exit 1
fi
chmod +x "$DESTINO"/scripts/*.sh 2>/dev/null || true

registrar "reconstruindo a imagem e subindo"
if ! (cd "$DESTINO" && docker compose up -d --build >>"$REGISTRO" 2>&1); then
  registrar "falha ao subir os contêineres"
  gravar_estado erro "A extração funcionou, mas a plataforma não subiu. Veja o registro."
  rm -f "$PEDIDO"
  exit 1
fi

# Espera a plataforma responder antes de dizer que deu certo.
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 4 "http://127.0.0.1:${PORTA_LOCAL:-3600}/api/saude" > /dev/null 2>&1; then ok=1; break; fi
  sleep 2
done

versao=$(python3 -c "import json;print(json.load(open('$DESTINO/versao.json'))['versao'])" 2>/dev/null || echo 'desconhecida')
if [ "$ok" = 1 ]; then
  registrar "[$(date -Is)] atualizada para $versao"
  gravar_estado concluida "Atualizada para $versao."
else
  registrar "[$(date -Is)] subiu, mas a plataforma não respondeu a tempo"
  gravar_estado erro "Os contêineres subiram, mas a plataforma não respondeu. Veja o registro."
fi

rm -f "$PEDIDO" "$PACOTE_TGZ" "$PACOTE_ZIP"
chown 1000:1000 "$REGISTRO" 2>/dev/null || true
