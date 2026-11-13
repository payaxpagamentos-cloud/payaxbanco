# ZOE — instalação no servidor

Um pacote, um comando: instala no mesmo servidor os três sistemas da ZOE.

| Sistema | Endereço | Porta interna |
|---|---|---|
| **ZOE Atende**: WhatsApp e telefone, a atendente virtual, Ouvidoria, Centro de Custo | `https://SEU-DOMINIO/atendimento/` | 3600 |
| **ZOE PABX**: ramais, filas, URA e a ligação com o Asterisk | `https://SEU-DOMINIO/pabx/` | 3300 |
| **Manager Network**: rede, NOC, chamados técnicos, equipe, frota | `https://SEU-DOMINIO/network/` | 3500 |

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
  | `/zoe/atendimento`, `/zoe/pabx`, `/zoe/network` | o código e o `.env` de cada sistema |
  | `/zoe/dados` | os bancos e os arquivos recebidos |
  | `/zoe/copias` | a cópia diária do banco |

  Para outra pasta, use `--pasta /outro/lugar`;
- gera um `.env` para cada sistema, com **segredos novos** e **uma senha de master, a mesma nos três sistemas**, que aparece **uma vez** no final (anote);
- cria os serviços `zoe-atendimento`, `zoe-pabx` e `zoe-network`, que sobem sozinhos com o servidor;
- configura o Nginx e a cópia diária do banco;
- confere se tudo respondeu.

**HTTPS** (obrigatório para a Meta):

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d atende.seuprovedor.com.br
```

## 3. Depois de instalar: validar

`sudo zoe-verificar` mostra os serviços e se o servidor alcança a Meta, o Banco Central e a IA.

Valide nesta ordem:

1. **Entrar** nos três painéis com o e-mail e a senha do master e **trocar a senha**.
2. **Inteligência da ZOE**: ponha a chave de IA em `ATEND_IA_CHAVE` no arquivo `/zoe/atendimento/.env` e rode
   `sudo systemctl restart zoe-atendimento`. Em *Diagnóstico* deve aparecer "Inteligência da ZOE: configurada".
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

## 4. Telefone (Asterisk)

O script da central é `/zoe/pabx/scripts/zoe-agi.js`. Se o Asterisk estiver em outra máquina, copie
para lá (precisa de Node 22). No Asterisk, configure estas variáveis de ambiente:

```
ZOE_CEREBRO=https://atende.seuprovedor.com.br/atendimento
ZOE_CEREBRO_CHAVE=atd_...        # ZOE Atende › Integrações › Nova chave
ZOE_TTS_APP=...                  # a aplicação de voz instalada no Asterisk
```

O plano de discagem completo, com a passagem para o atendente e o fecho da ligação, está no topo do
`zoe-agi.js` e no README do PABX. Os **nomes das filas** têm de ser iguais no ZOE Atende e no Asterisk.

## 5. Dia a dia

| Tarefa | Comando |
|---|---|
| Ver se está tudo no ar | `sudo zoe-verificar` |
| Ver o log de um sistema | `journalctl -u zoe-atendimento -n 100 -f` |
| Reiniciar depois de mudar o `.env` | `sudo systemctl restart zoe-atendimento` |
| **Atualizar** para uma versão nova | extrair o pacote novo e rodar o mesmo `instalar.sh`. Código novo; `.env`, banco e senhas ficam. O banco se atualiza sozinho ao subir. |
| Cópia do banco | automática, todo dia às 03:17, em `/zoe/copias` (14 dias). À mão: `sudo zoe-backup` |
| Restaurar uma cópia | `systemctl stop zoe-atendimento`, depois `gunzip -c /zoe/copias/DIA/atendimento.db.gz > /zoe/dados/atendimento/atendimento.db`, depois `chown zoe: /zoe/dados/atendimento/atendimento.db` e por fim `systemctl start zoe-atendimento` |

**Não troque** `ATEND_SECRET`, `PABX_SECRET`, `NETWORK_SECRET` nem `NETWORK_CHAVE_CREDENCIAIS` depois de
instalado. Eles cifram os tokens do WhatsApp e as credenciais guardadas, e trocar torna esses dados ilegíveis.
Guarde uma cópia dos arquivos `.env` fora do servidor.

## 6. Se algo não funcionar

| Sintoma | Onde olhar |
|---|---|
| Painel não abre | `sudo zoe-verificar`, depois `journalctl -u zoe-<sistema> -n 50`, depois `sudo nginx -t` |
| WhatsApp não chega | *Diagnóstico* no painel do master; na Meta, o webhook tem de estar verificado e com `messages` assinado |
| ZOE só responde com menu | falta a chave de IA (item 3.2) ou a empresa passou do limite de IA do mês |
| Áudio não vira texto | `systemctl status zoe-whisper` e `ATEND_WHISPER_URL` no `.env` |
| Ligação não abre a passagem no painel | ramal cadastrado em *Usuários*? `zoe-atendeu` no plano de discagem? |
