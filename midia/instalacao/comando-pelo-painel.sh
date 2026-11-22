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
