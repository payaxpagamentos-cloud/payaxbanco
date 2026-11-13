# ZOE Atende

Plataforma de atendimento ao cliente por **WhatsApp**, publicada em `/atendimento`.

A **atendente virtual faz o primeiro atendimento, de imediato, em todas as conversas**. Ela resolve o que
dá para resolver na hora — dúvida de horário, segunda via, prazo, status — e **só o que ela não consegue
resolver vai para a equipe humana**, já com um resumo pronto do caso, na fila certa e com o motivo
registrado.

| Perfil | O que vê |
|---|---|
| **Master** | A plataforma inteira: empresas, usuários, segurança, relatórios, diagnóstico e configurações. Entra no painel de qualquer empresa pela lista de Empresas. |
| **Suporte** | Como o master, sem usuários, segurança e configurações da plataforma. |
| **Cliente** (administrador da empresa) | Todo o painel da própria empresa: atendimentos, atendente virtual, filas, equipe, contatos, chamados, relatórios, configurações e integrações. Também atende. |
| **Supervisor** | O painel da empresa só para consulta (não altera nada e não vê segredos). |
| **Atendente** | A caixa de entrada: as conversas das filas que ele atende e as que assumiu. Não administra a empresa. |

Servidor próprio (Node.js 22 + SQLite), sem depender do Ativa BPO, do APP Táxi nem do PABX.
Tema claro e escuro no botão do topo.

## Como funciona o atendimento

```
mensagem do cliente no WhatsApp
          │
          ▼
┌───────────────────────────────────────────────┐
│ 1. REGRAS (instantâneas, sem custo)           │
│    • pediu uma pessoa  → transfere na hora    │
│    • intenção cadastrada → responde ou        │
│      transfere direto para a fila             │
│    • escolheu no menu  → transfere            │
│    • se despediu       → encerra              │
└───────────────┬───────────────────────────────┘
                │ não resolveu
                ▼
┌───────────────────────────────────────────────┐
│ 2. IA (Claude API, com ferramentas)           │
│    • busca na base de conhecimento            │
│    • consulta o sistema da empresa (HTTP)     │
│    • registra dados do cliente                │
│    • abre chamado com protocolo               │
│    • decide: resolver ou chamar a equipe      │
└───────┬───────────────────────────┬───────────┘
        │ resolveu                  │ não resolveu, ou o
        ▼                           │ assunto exige decisão
   ENCERRA e pede                   ▼
   avaliação (1 a 5)        TRANSFERE para a fila,
                            com resumo para o atendente
```

A IA **nunca fica sozinha com o problema**: erro da API, recusa de política, resposta vazia, limite de
mensagens ou limite do plano — tudo vira transferência para a equipe, com o motivo registrado. O cliente
nunca fica sem resposta.

## Telas

### Empresa

- **Atendimentos**: a caixa de entrada. Abas `Minhas conversas`, `Na fila`, `Com a atendente virtual`,
  `Todas em aberto` e `Encerradas`; busca por nome, telefone ou documento; filtro por fila.
  Na conversa: histórico completo (incluindo o que a atendente virtual falou), áudio, foto e documento
  do cliente, **respostas rápidas** (`/atalho`), envio de **template**, notas internas, etiquetas,
  prioridade, **assumir**, **transferir** (para fila ou direto para um colega), **devolver para a fila**,
  **devolver para a atendente virtual** e **encerrar** (com assunto, resumo e pedido de avaliação).
  À direita, em destaque, **o resumo que a atendente virtual deixou** e os passos que ela deu.
  A lista e a conversa se atualizam sozinhas.
- **Dashboard**: quantas conversas estão com a IA, na fila e com a equipe agora; filas com espera;
  resolução da IA, tempos médios e custo da IA hoje e no mês.
- **Atendente virtual**: seis abas —
  - *Desempenho*: quanto ela resolveu sozinha, ferramentas e intenções mais usadas, artigos que mais
    puxam atendimento, falhas e **por que ela transferiu** (a lista que mostra onde falta conteúdo).
  - *Base de conhecimento*: os artigos que ela usa para responder, com perguntas de exemplo e um
    **testador da busca** que mostra o que ela encontraria e com que pontuação.
  - *Intenções*: palavras-chave que resolvem **antes** de chamar a IA (barato, instantâneo e previsível).
  - *Ferramentas*: as consultas ao sistema da empresa por HTTP, com teste de chamada.
  - *Como ela atende*: nome, saudação, tom de voz, regras da empresa, quando transferir, mensagens
    automáticas, modelo e esforço — e o botão **Ver o prompt que ela recebe**, exatamente como vai ao modelo.
  - *Testar*: conversa de teste com a atendente de verdade, sem enviar nada para o WhatsApp.
- **Contatos**: quem já falou com a empresa, com CPF/CNPJ, código no sistema, observações, bloqueio,
  opt-out de mensagens ativas e o botão de iniciar conversa.
- **Chamados**: o que a atendente virtual registrou quando não havia solução na hora, com protocolo.
- **Filas**: os departamentos, com horário por dia da semana, equipe e **"quando a atendente virtual
  deve mandar para cá"** — esse texto entra no prompt e é o que faz ela escolher a fila certa.
- **Equipe**: quem atende, perfil, disponibilidade, conversas ao mesmo tempo e último acesso.
- **Relatórios**: resolução pela IA, desfechos, tempos, volume por dia e por hora, custo da IA,
  desempenho por fila e por atendente, motivos de transferência e **exportação em CSV**.
- **Configurações**: número de WhatsApp (com o callback pronto para colar na Meta), respostas rápidas e etiquetas.
- **Integrações**: chaves de API para o sistema da empresa.

### Master

- **Dashboard**: empresas ativas, conversas em aberto, conversas do mês, custo da IA e a lista de empresas.
- **Empresas**: cadastro, limites de atendentes e de mensagens da IA por mês, bloqueio (com motivo) e exclusão.
- **Relatórios**: os mesmos indicadores, de toda a plataforma ou de uma empresa, com quebra por empresa.
- **Usuários**: quem acessa a plataforma e as empresas.
- **Segurança**: acessos recusados nas últimas 24 h (incluindo **webhooks com assinatura inválida**),
  bloqueio de IP e o registro de atividades.
- **Diagnóstico**: verificações da plataforma (banco, chave da IA, App secret dos números, filas,
  fila de envio, envios com falha, clientes esperando) e a **conexão de cada número com a Meta**.
- **Configurações**: nome da plataforma, padrões das empresas novas, retenção e os **preços da IA**
  usados no custo estimado dos relatórios.

## Como executar

Requisitos: **Node.js 22.13+**.

```bash
npm install
npm run seed     # opcional: uma empresa com equipe, base de conhecimento e ~2 meses de atendimentos
npm start        # http://localhost:3600
```

Acesso inicial: `master@atendimento.com.br` / `master123` (troque no primeiro acesso).
Com o seed, a empresa **Fibra Mais**, senha `atende2026` para todos:
`carlos@` (administrador), `marina@`, `rafael@`, `juliana@` (atendentes) e `bia@fibramais.com.br` (supervisora).

```bash
npm test
```

## Ligar o WhatsApp (Cloud API da Meta)

1. Tenha uma conta no WhatsApp Business Platform com número verificado (developers.facebook.com).
2. No painel, entre na empresa e vá em **Configurações > Cadastrar número**. Informe:
   - **Phone number ID** e **token de acesso** (use um token **permanente**, de usuário do sistema) —
     em *WhatsApp > Configuração da API*;
   - **App secret** — em *Configurações do app > Básico*.
3. No app da Meta, em *WhatsApp > Configuração > Webhook*, informe o **endereço de callback** que a
   própria tela mostra (`https://SEU-DOMINIO/atendimento/api/webhook`), o **token de verificação** que
   aparece no número, e assine o campo **messages**.
4. Confira com **Testar a conexão com a Meta** e em **Diagnóstico**.

O token e o App secret são guardados **cifrados** (AES-256-GCM a partir de `ATEND_SECRET`) e nunca
voltam para o painel. O webhook só aceita evento com assinatura `X-Hub-Signature-256` válida; número sem
App secret cadastrado recusa tudo, e a recusa aparece em Segurança.

**A regra das 24 horas é da Meta**: fora das 24 h desde a última mensagem do cliente, só um template
aprovado por ela pode ser enviado. A plataforma respeita isso em todos os caminhos (painel, atendente
virtual e API) e explica o motivo quando recusa.

## Ligar a atendente virtual

Com `ATEND_IA_CHAVE` (chave da Claude API) a atendente entende texto livre e usa ferramentas.
**Sem a chave ela continua funcionando**: resolve pelas intenções e pela base de conhecimento e
oferece o menu de departamentos para o que não casar.

Ferramentas nativas que ela pode usar:

| Ferramenta | O que faz |
|---|---|
| `buscar_conhecimento` | Procura a resposta na base da empresa. Ela é instruída a nunca responder sobre a empresa sem isso. |
| `dados_do_contato` | Lê o que já sabemos do cliente: nome, documento, atendimentos anteriores e chamados abertos. |
| `registrar_dados_do_contato` | Guarda nome, CPF/CNPJ e e-mail que o cliente informar (com validação). |
| `abrir_chamado` | Registra o pedido com protocolo quando não há solução imediata. |
| `consultar_chamado` | Consulta a situação de um chamado — só os do próprio cliente. |
| `transferir_para_humano` | Passa para a equipe, com fila, motivo e resumo. |
| `encerrar_atendimento` | Fecha quando resolveu, com resumo e despedida. |

Além dessas, cada empresa cadastra **ferramentas próprias**: uma URL HTTPS do sistema dela (fatura,
pedido, contrato, rastreio) com os parâmetros em JSON Schema e cabeçalhos cifrados. A plataforma chama
essa URL e **monta a identificação do cliente a partir do nosso banco** (telefone, nome, documento,
código no sistema) — ela nunca vem do modelo, mesmo que ele tente informar outra.

O que mais muda o resultado é a **base de conhecimento**. Em *Atendente virtual > Desempenho*, a lista
"Por que foi para a equipe" mostra onde falta conteúdo: cada motivo repetido vira um artigo novo e
deixa de ocupar a equipe.

## API para o sistema da empresa

Chave por empresa (só o hash é gravado; revogável), em `Integrações`.
Base: `https://SEU-DOMINIO/atendimento/api/integracao` · Cabeçalho: `Authorization: Bearer <chave>`

| Rota | O que faz |
|---|---|
| `GET /conversas` | Conversas abertas ou encerradas, com filtro por telefone. |
| `GET /conversas/:id` | A conversa com o histórico (sem as notas internas da equipe). |
| `POST /contatos` | Cria ou atualiza o contato (nome, documento, e-mail, código no sistema). |
| `POST /mensagens` | Envia mensagem. Dentro da janela de 24 h aceita texto; fora dela exige template. |
| `GET /chamados` | Os chamados, inclusive os que a atendente virtual abriu. |
| `PATCH /chamados/:protocolo` | Atualiza a situação e a resolução, e pode avisar o cliente pelo WhatsApp. |

```bash
curl -X POST https://SEU-DOMINIO/atendimento/api/integracao/mensagens \
  -H "Authorization: Bearer SUA_CHAVE" -H "Content-Type: application/json" \
  -d '{"telefone":"11988887777","template":"aviso_fatura","parametros":["João","10/12"]}'
```

A conversa aberta assim **não passa pela atendente virtual** (aviso automático não é atendimento): ela
entra direto na fila da equipe, a menos que você mande `"com_ia": true`.

## Instalação no servidor (/atendimento)

```bash
npm run empacotar   # gera dist/zoe-atende.zip
```

O pacote traz a pasta `atendimento/` pronta: código, dependências de produção instaladas, `.env` com
segredo e senha do master gerados na hora (a senha aparece no terminal) e `LEIA-ME.txt` com o passo a
passo (PM2, Docker, cPanel, Nginx e Apache).

O servidor **precisa estar acessível por https:// pela internet** — é a Meta quem chama o webhook.

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3600` | Porta HTTP. |
| `ATEND_BASE_PATH` | (raiz) | Endereço do painel, ex.: `/atendimento`. |
| `ATEND_URL_PUBLICA` | — | Endereço público, usado no callback mostrado no painel. |
| `ATEND_SECRET` | aleatório | Segredo das sessões **e da cifra** dos tokens do WhatsApp (mín. 32 caracteres). **Obrigatório em produção. Trocar invalida os tokens guardados.** |
| `ATEND_DB` | `data/atendimento.db` | Arquivo do banco SQLite. |
| `ATEND_ARQUIVOS` | `data/arquivos` | Áudios, fotos e documentos recebidos. **Inclua no backup.** |
| `ATEND_ARQUIVO_MAX_MB` | `16` | Tamanho máximo de cada arquivo recebido. |
| `ATEND_ADMIN_EMAIL` / `ATEND_ADMIN_SENHA` / `ATEND_ADMIN_NOME` | — | Master criado no primeiro start. Senha obrigatória em produção (mín. 12). |
| `ATEND_TRUST_PROXY` | `loopback` | Proxies confiáveis para obter o IP real. |
| `ATEND_LIMITE_LOGIN` | `10` | Tentativas de login por IP por minuto. |
| `ATEND_FUSO` | `America/Sao_Paulo` | Fuso do horário de atendimento e dos relatórios. |
| `ATEND_IA_CHAVE` | — | Chave da Claude API. Sem ela, a atendente roda só com intenções e base de conhecimento. |
| `ATEND_IA_MODELO` | `claude-opus-5-5` | Modelo usado (ajustável por empresa no painel). |
| `ATEND_IA_ESFORCO` | `low` | Esforço de raciocínio: `low`…`max`. Atendimento curto vai bem com `low`. |
| `ATEND_IA_MAX_TOKENS` | `2048` | Teto da resposta. Mensagem de WhatsApp é curta de propósito. |
| `ATEND_IA_MAX_PASSOS` | `6` | Idas e voltas de ferramenta por mensagem. |
| `ATEND_GRAPH_VERSAO` | `v23.0` | Versão da Graph API da Meta. |
| `ATEND_HTTP` | — | `1` permite ferramentas da empresa em `http://` (só rede interna; o padrão exige `https://`). |

Produção com Docker: `docker build -t zoe-atende .` e rode com um volume em `/app/data`.

## Tecnologia e arquitetura

Node.js 22 + Express, SQLite nativo (`node:sqlite`), telas em HTML/CSS/JS puros sem build,
testes com `node:test`. Única dependência além do Express: o SDK oficial da Anthropic.
Mensagens de saída **sempre** passam pela fila em `mensagens` (gravadas dentro da transação do
atendimento e enviadas depois, com novas tentativas): uma falha da Meta nunca perde a conversa.

```
atendimento/
  server/
    db.js                # esquema: empresas, usuários, números, filas, contatos, conversas, mensagens,
                         #   conhecimento, intenções, ferramentas, chamados, ia_eventos, chaves, auditoria
    lib/whatsapp.js      # Cloud API: envio, template, mídia, "digitando", assinatura do webhook
    lib/recepcao.js      # traduz o evento da Meta, idempotência por wa_id, status de entrega
    lib/envio.js         # fila de saída com novas tentativas e a regra das 24 h
    lib/conversas.js     # ciclo bot → aguardando → humano → encerrada, transferência, CSAT
    lib/filas.js         # horário de atendimento e distribuição por carga
    lib/manutencao.js    # abandono, atendentes ausentes, entrega do que ficou na fila, limpeza
    lib/relatorios.js    # resolução da IA, tempos, CSAT, custo e CSV
    lib/empresas.js      # cadastro, equipe, números e chaves de API
    lib/cifra.js         # AES-256-GCM dos tokens e cabeçalhos
    ia/regras.js         # camada determinística (pedido de humano, intenções, menu)
    ia/conhecimento.js   # busca na base, sem serviço externo
    ia/ferramentas.js    # ferramentas nativas e as HTTP da empresa
    ia/prompt.js         # o prompt do sistema, montado da configuração da empresa
    ia/claude.js         # Claude API: laço de ferramentas, cache, fallback em recusa
    ia/atendente.js      # o orquestrador: regras → limites → IA → resolver ou transferir
    routes/              # auth, master, empresa, ia, cadastros, webhook, integracao
  public/                # painel (SPA)
  test/
```

### O que depende de terceiros (não incluído)

- **Conta no WhatsApp Business Platform** com número verificado e **templates aprovados** pela Meta:
  sem template não há mensagem fora da janela de 24 h.
- **Chave da Claude API** para a camada de IA. Sem ela a atendente funciona em modo reduzido
  (intenções, base de conhecimento e menu).
- **Integração com o sistema da empresa** (fatura, pedido, contrato): a plataforma chama a API do
  cliente; a API em si é de quem a mantém.
