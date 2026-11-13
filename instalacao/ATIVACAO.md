# ZOE — ativação passo a passo

Siga em ordem. O que estiver em **MAIÚSCULAS** troque pelo dado de vocês:

| No texto | Troque por | Exemplo |
|---|---|---|
| `IP-DO-SERVIDOR` | o IP do servidor | `200.150.10.20` |
| `DOMINIO` | o endereço da ZOE | `atende.connectlink.com.br` |
| `EMAIL` | o e-mail de quem vai ser o master | `ti@connectlink.com.br` |

Tempo estimado: 15 a 20 minutos, sem contar a configuração da Meta e do Asterisk.

---

## 0. Antes (uma vez)

- O servidor precisa ter **Ubuntu 22.04/24.04 ou Debian 12**, pelo menos 2 vCPU, 4 GB de RAM e 40 GB de disco, e você precisa de acesso **root**.
- No DNS, crie um **registro A** de `DOMINIO` apontando para `IP-DO-SERVIDOR`. Ele leva alguns minutos para valer.
- No firewall, deixe as **portas 80 e 443** abertas para a internet.

Para conferir o DNS, rode isto no seu computador. A resposta tem de ser o `IP-DO-SERVIDOR`:

```bash
nslookup DOMINIO
```

---

## 1. Enviar o pacote para o servidor

Rode no seu computador, na pasta onde salvou o `zoe-instalacao.tar.gz`. O comando é o mesmo no Windows (PowerShell), no Mac e no Linux:

```bash
scp zoe-instalacao.tar.gz root@IP-DO-SERVIDOR:/root/
```

## 2. Entrar no servidor e instalar

```bash
ssh root@IP-DO-SERVIDOR
cd /root
tar xzf zoe-instalacao.tar.gz
cd zoe
sudo ./instalacao/instalar.sh --dominio DOMINIO --email EMAIL
```

Para a transcrição de áudio local (whisper), acrescente `--com-whisper` no fim do último comando. Ela precisa de 4 vCPU e 8 GB de RAM.

No fim, o instalador mostra o **e-mail e a senha do master**. **Anote na hora, porque a senha não aparece de novo.**

## 3. Ligar o HTTPS

Ele é obrigatório para a Meta e para o telefone no navegador:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d DOMINIO
```

Quando ele perguntar, escolha redirecionar HTTP para HTTPS.

## 4. Colocar a chave de IA

```bash
sudo nano /zoe/atendimento/.env
```

Ache a linha `# ATEND_IA_CHAVE=`, apague o `#` e cole a chave depois do `=`. Salve com Ctrl+O e Enter, e saia com Ctrl+X. Depois:

```bash
sudo systemctl restart zoe
```

## 5. Conferir

```bash
sudo zoe-verificar
```

Tudo tem de aparecer com ✔. Se algo der ✘, rode o comando abaixo e me mande o que aparecer:

```bash
journalctl -u zoe -n 80 --no-pager
```

## 6. Primeiro acesso

1. Abra `https://DOMINIO/` e entre com o e-mail e a senha do passo 2.
2. **Troque a senha**: clique no seu nome, no canto de cima, e depois em *Alterar senha*.
3. Em **Diagnóstico**, confira se aparece "Inteligência da ZOE: configurada".

---

## 7. Validar o mundo real (nesta ordem)

| # | O quê | Onde | Deu certo quando |
|---|---|---|---|
| 1 | Criar a empresa | **Empresas › Nova empresa** | a empresa aparece na lista |
| 2 | WhatsApp | na empresa, **Configurações › Número de WhatsApp**: Phone number ID, token permanente e App Secret | o painel mostra a URL do webhook e o token de verificação |
| 3 | Webhook na Meta | no app da Meta, **WhatsApp › Configuração › Webhook**: cole a URL e o token do painel e assine `messages` | a Meta mostra o webhook verificado |
| 4 | Teste | mande "oi" de um celular para o número | a ZOE responde |
| 5 | Transferência | peça "quero falar com um atendente" duas vezes | a conversa chega na fila |
| 6 | Custo | **Centro de Custo** | a conversa entra sem custo (dentro da janela de 24 h) |
| 7 | IXC | **ZOE › Provedor (IXC)**: endereço e token | o botão de teste mostra o que está liberado |
| 8 | Equipe | **Usuários**: cada pessoa com permissões e **ramal** | todos conseguem entrar |
| 9 | Fatura da Meta | separe as linhas de outubro (o PDF ou o extrato do Gerenciador de Negócios) | analisamos juntos os US$ 655 |

Se o IXC estiver na rede interna (10.x, 192.168.x), acrescente `ATEND_REDE_INTERNA=1` no `.env` e rode `sudo systemctl restart zoe`.

---

## 8. Telefonia (quando for ligar o telefone)

**No painel da ZOE, como master, em Telefonia:**

1. *Rotas de saída*: cadastre a operadora.
2. *Números*: cadastre os números e escolha a empresa.
3. *Empresas*: clique no lápis da empresa, marque "Telefonia ligada" e salve.
4. *Chave da central*: clique em Nova chave e **copie a chave `cen_…`**, porque ela aparece uma vez só.

**No painel da empresa, em Telefonia › Ramais:** crie os ramais com o mesmo número que está em *Usuários › Ramal*.

**No servidor do Asterisk:**

```bash
# Node 22 (se o Asterisk estiver em outra máquina)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs

# o script da ZOE (se o Asterisk estiver em outra máquina)
sudo mkdir -p /zoe/atendimento/scripts
sudo scp root@IP-DO-SERVIDOR:/zoe/atendimento/scripts/zoe-agi.js /zoe/atendimento/scripts/
sudo chmod 755 /zoe/atendimento/scripts/zoe-agi.js

# configuração
sudo tee /etc/asterisk/zoe-agi.conf >/dev/null <<'CONF'
ZOE_URL=https://DOMINIO/atendimento
ZOE_CHAVE=COLE-AQUI-A-CHAVE-cen
ZOE_TTS_APP=Flite
CONF
sudo chmod 640 /etc/asterisk/zoe-agi.conf
sudo chown root:asterisk /etc/asterisk/zoe-agi.conf
```

Ainda no Asterisk, acrescente isto ao `extensions.conf` e aponte o número de entrada para o contexto `zoe-entrada`:

```
[zoe-entrada]
exten => s,1,Answer()
 same => n,AGI(/zoe/atendimento/scripts/zoe-agi.js)
 same => n,GotoIf($["${ZOE_STATUS}" = "transferir" | "${ZOE_STATUS}" = "indisponivel"]?fila)
 same => n,Hangup()
 same => n(fila),Queue(${IF($["${ZOE_FILA_NOME}" = ""]?Atendimento:${ZOE_FILA_NOME})},,,,,,,zoe-atendeu^s^1)
exten => h,1,AGI(/zoe/atendimento/scripts/zoe-agi.js,fim)

[zoe-atendeu]
exten => s,1,AGI(/zoe/atendimento/scripts/zoe-agi.js,atendeu)
 same => n,Return()
```

Depois recarregue o plano de discagem:

```bash
sudo asterisk -rx "dialplan reload"
```

As filas do Asterisk precisam ter **o mesmo nome** das filas da ZOE (Atendimento, Financeiro, Suporte técnico…).

Para ver a ligação passando pela ZOE: `sudo asterisk -rx "agi set debug on"`.

**Telefone no navegador (opcional):** no `/zoe/atendimento/.env`, preencha `ATEND_WEBRTC_WSS=wss://...` e `ATEND_SIP_DOMINIO=...` e rode `sudo systemctl restart zoe`.

> Falta uma peça que ainda vou fazer: a ponte que cria no Asterisk os ramais e filas cadastrados no painel e
> envia à ZOE o histórico das ligações (tarifação e relatórios). Até ela ficar pronta, a conversa com a ZOE e a
> transferência funcionam, mas ramais e filas são configurados à mão no Asterisk e as telas de chamadas ficam vazias.

---

## Comandos do dia a dia

| Para quê | Comando |
|---|---|
| Está tudo no ar? | `sudo zoe-verificar` |
| Ver o que está acontecendo | `journalctl -u zoe -f` |
| Reiniciar depois de mexer no `.env` | `sudo systemctl restart zoe` |
| Fazer a cópia do banco agora | `sudo zoe-backup` |
| Atualizar para um pacote novo | extrair o pacote novo e rodar o mesmo `instalar.sh`. Dados, `.env` e senha ficam. |

**Guarde uma cópia do `/zoe/atendimento/.env` fora do servidor.** Sem ele, os tokens guardados não podem ser lidos.
