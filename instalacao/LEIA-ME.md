# ZOE — instalação no servidor

Um pacote, um comando. A ZOE é **um sistema só**: WhatsApp, telefonia (ramais, filas, URA, números, discador,
telefone no navegador), a atendente virtual, Ouvidoria e retenção, Centro de Custo e relatórios. Tudo fica em
um painel, com um login e um banco de dados.

| | |
|---|---|
| Endereço | `https://SEU-DOMINIO/atendimento/` (a raiz do domínio leva para lá) |
| Serviço | `zoe` (porta interna 3600) |

A integração com o **Manager** que vocês já usam vem depois. Este pacote não instala nada dele.

## 1. Antes de começar

- **Servidor**: Ubuntu 22.04/24.04 ou Debian 12, com 2 vCPU, 4 GB de RAM e 40 GB de disco.
  Com a transcrição de áudio local (whisper), use 4 vCPU e 8 GB.
- **Domínio** apontando para o servidor (registro A), por exemplo `atende.seuprovedor.com.br`.
- **Portas 80 e 443** abertas para a internet. A Meta precisa chamar o webhook por **https**.
- **Saída para a internet** liberada para:

  | Destino | Para quê |
  |---|---|
  | `graph.facebook.com` | WhatsApp |
  | `olinda.bcb.gov.br` | dólar do dia |
  | `api.anthropic.com` | inteligência da ZOE |
  | o endereço do IXC | dados dos clientes |

## 2. Instalar

```bash
# no seu computador: gerar o pacote (na raiz do repositório)
node instalacao/empacotar.js            # → dist/zoe-instalacao.tar.gz

# no servidor
scp dist/zoe-instalacao.tar.gz root@SERVIDOR:/root/
ssh root@SERVIDOR
tar xzf zoe-instalacao.tar.gz && cd zoe
sudo ./instalacao/instalar.sh --dominio atende.seuprovedor.com.br --email voce@seuprovedor.com.br
# com transcrição de áudio local:  ... --com-whisper
```

O instalador faz o seguinte:

- instala o Node 22, o ffmpeg e o Nginx;
- cria o usuário de sistema `zoe` e põe **tudo na pasta `/zoe`**:

  | Pasta | Conteúdo |
  |---|---|
  | `/zoe/atendimento` | o código e o `.env` |
  | `/zoe/dados` | o banco e os arquivos recebidos |
  | `/zoe/copias` | a cópia diária do banco |

  Para outra pasta, use `--pasta /outro/lugar`;
- gera o `.env` com **segredos novos** e **a senha do master**, que aparece **uma vez** no final (anote);
- cria o serviço `zoe`, que sobe sozinho com o servidor;
- configura o Nginx e a cópia diária do banco;
- confere se tudo respondeu.

**HTTPS** (obrigatório para a Meta e para o telefone no navegador):

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d atende.seuprovedor.com.br
```

## 3. Depois de instalar: validar

`sudo zoe-verificar` mostra o serviço e se o servidor alcança a Meta, o Banco Central e a IA.

Valide nesta ordem:

1. **Entrar** com o e-mail e a senha do master e **trocar a senha**.
2. **Inteligência da ZOE**: ponha a chave de IA em `ATEND_IA_CHAVE` no arquivo `/zoe/atendimento/.env` e rode
   `sudo systemctl restart zoe`. Em *Diagnóstico* deve aparecer "Inteligência da ZOE: configurada".
3. **Empresa e WhatsApp (API oficial da Meta)**: crie a empresa e, em *Configurações › Número de WhatsApp*, cadastre o
   Phone number ID, o token permanente e o App Secret. O painel mostra a **URL do webhook** e o
   **token de verificação** para colar no app da Meta (*WhatsApp › Configuração › Webhook*). Assine o campo
   `messages`.
4. **Teste de ponta a ponta**:
   - mande "oi" de um celular para o número e veja a ZOE responder;
   - em seguida peça "quero falar com um atendente" duas vezes e veja a conversa chegar na fila;
   - confira em *Centro de Custo* que a conversa entrou **sem custo** (resposta dentro da janela de 24 h).
5. **Dólar do dia**: em *Centro de Custo › Orçamento e fechamento*, a moeda em dólar mostra a PTAX do Banco Central.
6. **IXC**: em *ZOE › Provedor (IXC)*, cadastre o endereço e o token (de preferência um usuário só de leitura,
   mais as permissões de segunda via e desbloqueio, se for usar). O botão de teste mostra o que está liberado.
7. **Usuários e ramais**: em *Usuários*, cadastre a equipe, as permissões e o **ramal** de cada atendente.

## 4. Telefonia (Asterisk)

A telefonia é ligada **por empresa** pelo master. As **filas são as mesmas do WhatsApp**: a ligação que a ZOE
transfere cai na mesma fila e na mesma equipe.

1. **Master › Telefonia**:
   - *Rotas de saída*: cadastre a operadora (host, usuário, custo por minuto);
   - *Números*: cadastre os números (DIDs) e entregue-os à empresa;
   - *Empresas*: ligue a telefonia da empresa (limites, tarifas e rota de saída);
   - *Chave da central*: crie a chave da empresa (`cen_…`). Ela aparece **uma vez**.
2. **Na empresa › Telefonia**, cadastre os ramais com o **mesmo número** do campo *Ramal* em *Usuários*. Escolha
   os ramais de cada fila, monte a URA e diga para onde vai cada número.
3. **No Asterisk**, use o script `/zoe/atendimento/scripts/zoe-agi.js`. Se o Asterisk estiver em outra máquina,
   copie o script para lá (ele precisa de Node 22). Depois crie o arquivo `/etc/asterisk/zoe-agi.conf`:

   ```
   ZOE_URL=https://atende.seuprovedor.com.br/atendimento
   ZOE_CHAVE=cen_...            # a chave da central do passo 1
   ZOE_TTS_APP=...              # a aplicação de voz instalada no Asterisk (ex.: Flite)
   # ZOE_SUSSURRO=0             # desliga o resumo sussurrado ao atendente
   ```

   O plano de discagem completo está no topo do `zoe-agi.js`. Ele cobre a conversa com a ZOE, a fila, a
   passagem para o atendente e o fecho da ligação. Os **nomes das filas** têm de ser iguais na ZOE e no Asterisk.

   Se a ZOE estiver fora do ar, a ligação vai **direto para a fila**. Nenhuma ligação fica no silêncio.
4. **Telefone no navegador (opcional)**: no `/zoe/atendimento/.env`, preencha `ATEND_WEBRTC_WSS`, que é o
   endereço `wss://` do Asterisk, e `ATEND_SIP_DOMINIO`. Depois rode `sudo systemctl restart zoe`. O botão de telefone
   aparece no canto do painel de quem tem ramal.

## 5. Dia a dia

| Tarefa | Comando |
|---|---|
| Ver se está tudo no ar | `sudo zoe-verificar` |
| Ver o log | `journalctl -u zoe -n 100 -f` |
| Reiniciar depois de mudar o `.env` | `sudo systemctl restart zoe` |
| **Atualizar** para uma versão nova | extrair o pacote novo e rodar o mesmo `instalar.sh`. Código novo; `.env`, banco e senha ficam. O banco se atualiza sozinho ao subir. |
| Cópia do banco | automática, todo dia às 03:17, em `/zoe/copias` (14 dias). À mão: `sudo zoe-backup` |
| Restaurar uma cópia | `systemctl stop zoe`, depois `gunzip -c /zoe/copias/DIA/atendimento.db.gz > /zoe/dados/atendimento/atendimento.db`, depois `chown zoe: /zoe/dados/atendimento/atendimento.db` e por fim `systemctl start zoe` |

**Não troque** o `ATEND_SECRET` depois de instalado. Ele cifra os tokens do WhatsApp e as credenciais guardadas,
e trocar torna esses dados ilegíveis. Guarde uma cópia do `.env` fora do servidor.

## 6. Se algo não funcionar

| Sintoma | Onde olhar |
|---|---|
| Painel não abre | `sudo zoe-verificar`, depois `journalctl -u zoe -n 50`, depois `sudo nginx -t` |
| WhatsApp não chega | *Diagnóstico* no painel do master; na Meta, o webhook tem de estar verificado e com `messages` assinado |
| ZOE só responde com menu | falta a chave de IA (item 3.2) ou a empresa passou do limite de IA do mês |
| Áudio não vira texto | `systemctl status zoe-whisper` e `ATEND_WHISPER_URL` no `.env` |
| Ligação não chega à ZOE | *Master › Telefonia › Situação*; a chave da central no `zoe-agi.conf`; `asterisk -rx "agi set debug on"` |
| Ligação não abre a passagem no painel | o ramal está em *Usuários* e em *Telefonia › Ramais* com o mesmo número? O `zoe-atendeu` está no plano de discagem? |
| Telefone do navegador "desconectado" | `ATEND_WEBRTC_WSS` no `.env`, o certificado do `wss://` e o ramal cadastrado em *Telefonia › Ramais* |
