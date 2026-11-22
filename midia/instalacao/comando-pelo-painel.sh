#!/usr/bin/env bash
#
# Vai Mídia — comandos do servidor pedidos pelo painel (Configurações › Sistema › Comandos).
#
# Quem chama é o systemd (vaimidia-comando.service), como root, quando o painel deixa um pedido.
# O painel NÃO manda texto de comando: manda só o NOME de um item da lista abaixo. Nome que não
# está na lista é recusado. Assim, mesmo que alguém entre no painel, não roda o que quiser na máquina.
# A resposta vai para saida.log e o andamento para estado.json, que o painel mostra.
#
set -uo pipefail

DADOS="${VAIMIDIA_DADOS:-/var/lib/vaimidia}"
PASTA="$DADOS/comandos"
DESTINO="${VAIMIDIA_DESTINO:-/opt/vaimidia}"
ENV="${VAIMIDIA_ENV:-/etc/vaimidia/vaimidia.env}"
# Root nunca escreve direto na pasta do sistema (ela é do usuário do serviço): escreve em /run e move.
TMP="$(mktemp -d /run/vaimidia-comando.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
SAIDA="$TMP/saida.log"
entregar() { chown vaimidia:vaimidia "$1"; chmod 640 "$1"; mv -f "$1" "$PASTA/$2"; }

PEDIDO="$(cat "$PASTA/pedido" 2>/dev/null || true)"
rm -f "$PASTA/pedido"
# Só o nome do comando, em letras minúsculas e hífen. Qualquer outra coisa vira vazio.
ID="$(printf '%s' "$PEDIDO" | sed -n 's/.*"id":"\([a-z-]\{1,40\}\)".*/\1/p')"

estado() { # estado <etapa>
  local tmp="$TMP/estado.json"
  printf '{"id":"%s","etapa":"%s","atualizado_em":"%s"}\n' "$ID" "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  entregar "$tmp" estado.json
}

: > "$SAIDA"
estado rodando

ler_env() { sed -n "s/^$1=//p" "$ENV" 2>/dev/null | tail -1; }
DOMINIO="$(ler_env MIDIA_DKIM_DOMINIO)"
[[ -n "$DOMINIO" ]] || DOMINIO="$(ler_env MIDIA_URL | sed -E 's#^https?://([^/]+).*#\1#')"

# Tira as cores do terminal, que no painel virariam sujeira.
sem_cor() { sed -u 's/\x1b\[[0-9;]*m//g'; }

rodar() {
  case "$ID" in
    conferir)
      bash "$DESTINO/instalacao/conferir.sh" --dominio "$DOMINIO" ;;
    dns)
      bash "$DESTINO/instalacao/dns-registrobr.sh" --dominio "$DOMINIO" ;;
    erros)
      journalctl -u vaimidia -n 80 --no-pager ;;
    seguranca)
      echo "== Acesso remoto (SSH)"
      sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|pubkeyauthentication|port) ' || echo "não consegui ler a configuração do SSH"
      echo; echo "== Firewall (ufw)"
      (command -v ufw >/dev/null && ufw status verbose) || echo "ufw não está instalado"
      echo; echo "== Bloqueio de tentativas (fail2ban)"
      (command -v fail2ban-client >/dev/null && fail2ban-client status) || echo "fail2ban não está instalado"
      echo; echo "== Portas abertas para a internet"
      ss -tlnH 2>/dev/null | awk '{print $4}' | sort -u
      echo; echo "== Atualizações de segurança pendentes"
      (apt-get -s upgrade 2>/dev/null | grep -ci '^inst.*security' | sed 's/$/ pacote(s)/') || true ;;
    reforcar)
      echo "== Bloqueio de tentativas de senha no acesso remoto (fail2ban)"
      export DEBIAN_FRONTEND=noninteractive
      if ! command -v fail2ban-client >/dev/null; then apt-get install -y fail2ban >/dev/null 2>&1 || echo "não consegui instalar o fail2ban"; fi
      if command -v fail2ban-client >/dev/null; then
        printf '[sshd]\nenabled = true\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' > /etc/fail2ban/jail.d/vaimidia.local
        systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban; sleep 2
        fail2ban-client status sshd 2>&1 | head -6
      fi
      echo; echo "== Porta 8080 (aberta no firewall sem uso)"
      if ss -tlnH 2>/dev/null | grep -q ':8080 '; then echo "Tem um programa usando a 8080: deixei como está."
      else ufw delete allow 8080/tcp 2>&1 | tail -2; fi
      echo; echo "== Sistema atendendo só por dentro da máquina"
      if grep -q '^MIDIA_HOST=' "$ENV"; then echo "Já está: $(grep '^MIDIA_HOST=' "$ENV")"
      else echo "MIDIA_HOST=127.0.0.1" >> "$ENV"; echo "Acrescentado MIDIA_HOST=127.0.0.1"; systemctl restart vaimidia; sleep 3; systemctl is-active vaimidia; fi ;;
    email-web)
      # mail.DOMINIO no navegador: em vez de cair em outra página do servidor, abre a caixa de e-mail do sistema.
      ARQ=/etc/nginx/sites-available/vaimidia-mail
      IPV6=""; grep -q 'listen \[::\]:80' /etc/nginx/sites-available/vaimidia 2>/dev/null && IPV6="    listen [::]:80;"
      printf 'server {\n    listen 80;\n%s\n    server_name mail.%s;\n    location / { return 302 https://%s/midia/#/emails; }\n}\n' "$IPV6" "$DOMINIO" "$DOMINIO" > "$ARQ"
      ln -sf "$ARQ" /etc/nginx/sites-enabled/vaimidia-mail
      if nginx -t 2>&1; then systemctl reload nginx; echo "Endereço mail.$DOMINIO ligado."
      else rm -f /etc/nginx/sites-enabled/vaimidia-mail; echo "A configuração não passou no teste: desfiz e nada mudou."; return 1; fi
      echo; echo "== Cadeado (HTTPS) para mail.$DOMINIO"
      certbot --nginx -d "mail.$DOMINIO" --redirect --non-interactive --agree-tos --register-unsafely-without-email 2>&1 | tail -6 \
        || echo "O cadeado não saiu agora; o endereço funciona sem ele e dá para tentar de novo depois." ;;
    reiniciar)
      systemctl restart vaimidia && sleep 3 && systemctl is-active vaimidia && echo "Sistema reiniciado." ;;
    email-nome)
      if grep -q '^MIDIA_EMAIL_NOME=' "$ENV"; then
        echo "Já está configurado: $(grep '^MIDIA_EMAIL_NOME=' "$ENV")"
      else
        echo "MIDIA_EMAIL_NOME=mail.$DOMINIO" >> "$ENV"
        echo "Acrescentado: MIDIA_EMAIL_NOME=mail.$DOMINIO"
        systemctl restart vaimidia && echo "Sistema reiniciado."
      fi ;;
    certificado)
      NOMES=(-d "$DOMINIO")
      for extra in "www.$DOMINIO" "midia.$DOMINIO" "tv.$DOMINIO"; do
        if getent hosts "$extra" >/dev/null 2>&1; then NOMES+=(-d "$extra"); else echo "Pulei $extra: ainda não aponta para este servidor."; fi
      done
      certbot --nginx "${NOMES[@]}" --expand --redirect --non-interactive --agree-tos --register-unsafely-without-email ;;
    *)
      echo "Comando desconhecido. Nada foi feito."; return 2 ;;
  esac
}

if timeout 300 bash -c "$(declare -f rodar); ID='$ID' DOMINIO='$DOMINIO' DESTINO='$DESTINO' ENV='$ENV' rodar" 2>&1 | sem_cor | tail -c 60000 >> "$SAIDA"; then
  FIM=concluido
else
  FIM=falhou
fi
entregar "$SAIDA" saida.log
estado "$FIM"
