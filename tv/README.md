# PLAY TV

Plataforma de streaming: **canais de TV ao vivo** nossa transmissãos pelos nossos servidores e **catálogo sob demanda**
com conteúdo próprio (filmes, séries e episódios), vendido por **assinatura**. App do assinante e painel da operação,
com servidor, banco de dados e login próprios.

> Faz parte do repositório do **Ativa BPO Financeiro** (raiz), ao lado do [APP Táxi](../taxi/README.md),
> do [PABX](../pabx/README.md), do [Manager Network](../network/README.md) e do [Rastreador](../rastreador/README.md).
> Roda na porta **3600** e é publicado em `/tv`.

## Módulos

| # | Módulo | O que tem |
|---|---|---|
| 1 | **Canais ao vivo** | Cadastro do canal (número, categoria, região, logo, classificação, plano mínimo) com o endereço HLS (`.m3u8`) da emissora ou do encoder próprio. **Transmissão pelos nossos servidores**: a lista é reescrita e cada pedaço do sinal passa por aqui, então a origem não aparece para o assinante, o CORS deixa de ser problema e a política de segurança das páginas continua fechada em `'self'`. Teste do sinal em um clique, prévia dentro do painel e verificação automática a cada 15 minutos (o painel mostra quem está fora do ar). |
| 2 | **TV aberta já cadastrada** | Globo, SBT, Record, Band, RedeTV!, Cultura, Gazeta, TV Brasil, Rede Brasil, Aparecida, Rede Vida e os canais de notícias entram com um clique em **Canais → Importar TV aberta** (número, categoria, logo e o lembrete de onde pedir o sinal de cada um). Cada canal aceita **sinal próprio ou contratado** (.m3u8) ou o **player oficial da emissora** — neste caso a PLAY TV não transmite nada: abre o player público da emissora, com os anúncios dela. |
| 3 | **Grade de programação (EPG)** | Programação por canal, cadastrada na mão (com recusa de sobreposição) ou importada em **XMLTV** — o formato que emissoras e agregadores publicam. O app mostra "no ar agora" com barra de andamento, o que vem depois e um **guia de 7 dias** que já abre no programa do momento. |
| 4 | **Catálogo sob demanda** | Filmes e séries com temporadas, episódios, trailer, elenco, direção, gêneros, classificação indicativa e selo de original. **Envio do vídeo pelo painel em pedaços** (retomável, até 8 GB por arquivo), formato reconhecido pelo conteúdo do arquivo (MP4, WebM, MKV) e entrega com **HTTP Range**. Legendas em WebVTT. Publicar confere se há vídeo e capa. |
| 5 | **Player** | Tela cheia com controles próprios: HLS pelo **hls.js** (com o HLS nativo do Safari como reserva), MP4 com Range, troca de qualidade e velocidade, legendas, janela flutuante, tela cheia, atalhos de teclado, **retomada de onde parou**, **próximo episódio** e aviso de telas simultâneas com a opção de encerrar as outras. |
| 6 | **Assinaturas e cobrança** | Planos com preço, telas simultâneas, perfis, qualidade (SD/Full HD/4K), downloads e **nível** (libera conteúdo exclusivo). Fatura mensal com **PIX copia e cola e QR Code**, carência, **suspensão automática** de quem não pagou, troca de plano, cancelamento que vale até o fim do período pago e reativação. Todo o conteúdo exige assinatura ativa. |
| 7 | **Perfis de visualização** | Vários perfis por conta (até o limite do plano), cada um com sua lista, seu progresso e sua **classificação indicativa**. Perfil infantil nasce limitado a 10 anos. **PIN** opcional: o perfil protegido só abre com a chave assinada que o aparelho recebe ao digitar o PIN. |
| 8 | **Home e curadoria** | Destaques do topo (que passam sozinhos) e fileiras montadas pela curadoria: continuar assistindo, minha lista, em alta (audiência real), novidades, originais, por gênero, canais ao vivo ou **escolha manual** dos títulos. |
| 9 | **Telas simultâneas** | Cada tela aberta é uma sessão com sinal de vida. O plano define quantas cabem ao mesmo tempo; quem bate no limite vê onde está assistindo e pode encerrar as outras. A tela que para de dar sinal libera a vaga sozinha. |
| 10 | **Audiência e relatórios** | Quem está assistindo neste instante, minutos assistidos por dia e por hora (no fuso da operação), por aparelho, títulos e canais mais vistos, com CSV. Financeiro por competência, receita recorrente (MRR), recebido no mês e inadimplência. |
| 11 | **Apps de Smart TV** | Modo TV automático (foco visível, interface de 10 pés e navegação só pelo controle remoto: setas, OK, Voltar e teclas de mídia) e projetos prontos de empacotamento para **Samsung (Tizen)**, **LG (webOS)** e **Android TV / TCL**, em [`tv-apps/`](tv-apps/README.md). |
| 12 | **Operação** | Painel com assinantes (plano, cortesia, senha provisória, desativação), faturas com baixa do PIX, planos, equipe com dois perfis de acesso, configurações e **auditoria** de tudo que a equipe faz. |

### O que depende de terceiros (não incluído)

- **Baixa automática do PIX**: exige contratar um intermediador de pagamentos (PSP) ou a API PIX do banco. Hoje a
  operação confirma a fatura em um clique (e, em modo de testes, o próprio assinante confirma).
- **Sinal das emissoras abertas**: Globo, SBT, Record, Band e RedeTV! **não publicam endereço livre** para
  transmissão — o sinal ao vivo delas é distribuído por contrato (Globoplay, UOL Play e afins). Os canais já vêm
  cadastrados na plataforma, mas cada um só entra no ar quando a operação colocar ali uma destas três coisas:
  (a) o **.m3u8 que a emissora ou a afiliada fornece por contrato** (ou o encoder próprio de quem é afiliado);
  (b) o **endereço do player oficial e público da emissora** (fonte "embed"), em que abrimos o player dela e nada é
  nossa transmissão; ou (c) nada — e o canal fica cadastrado e desligado. A plataforma está pronta para os três casos;
  o que ela não faz é inventar um sinal que a emissora não liberou.
- **DRM (Widevine/FairPlay/PlayReady)**: estúdios costumam exigir DRM para conteúdo licenciado. A plataforma entrega
  o vídeo por link assinado de curta duração, que resolve o acesso indevido casual, mas não é DRM.
- **Transcodificação para várias qualidades (ABR)**: o vídeo enviado é entregue como está. Para gerar 1080p/720p/480p
  do mesmo filme, rode um transcodificador (ffmpeg) antes do envio ou um encoder que já publique em HLS.
- **Aplicativos de loja (iOS, Android, Smart TV)**: o app é web e abre em qualquer navegador, inclusive das TVs.
  Publicar nas lojas exige empacotamento e as regras de cada loja.

### Perfis de acesso

| Perfil | Acesso |
|---|---|
| **Assinante** | App: catálogo, canais, guia, player, minha lista, perfis de visualização, faturas e plano. |
| **Curadoria** | Painel: canais, grade, catálogo, arquivos, destaques e fileiras. Vê o painel sem os números de receita. |
| **Administrador** | Tudo, inclusive assinantes, faturas, planos, relatórios financeiros, equipe, configurações e auditoria. |

As regras ficam no servidor: toda rota do assinante confere a assinatura ativa (`402` quando falta), a classificação
do perfil (`403`) e o nível do plano (`403`); o painel confere o perfil de acesso em cada rota.

## Smart TVs (Samsung, LG e TCL)

A interface entra sozinha em **modo TV** quando reconhece o aparelho (Tizen, webOS, Android TV, Fire TV, VIDAA):
fontes maiores, margens de 10 pés, foco bem visível e navegação inteira pelo controle remoto — setas, OK, Voltar
e as teclas de mídia. Dá para ver no computador abrindo `/?tv=1`.

Os apps estão em [`tv-apps/`](tv-apps/README.md) e cada um usa o **player nativo do aparelho**: **AVPlay** na
Samsung (Tizen), o pipeline de mídia do **webOS** na LG e o **ExoPlayer (Media3)** no Android TV da TCL. Na Samsung
e na LG a interface vai empacotada dentro da TV (`npm run empacotar-tv https://seu-dominio/tv`) e conversa com a
API do servidor; no Android TV, a interface roda em WebView e a reprodução é entregue ao player nativo, que devolve
a posição para "continuar assistindo", audiência e limite de telas continuarem valendo.

## Grade dos canais abertos

Em **Configurações → Grade dos canais abertos (EPG)**, a operação cadastra o endereço de um arquivo **XMLTV**
(aceita `.xml` e `.xml.gz`) e a plataforma importa sozinha, uma vez por dia — é assim que a programação da TV
aberta se mantém em dia. O provedor da grade é escolhido por vocês: a própria emissora, a afiliada ou um serviço
de guia. Também dá para enviar o arquivo na mão em **Grade (EPG) → Importar XMLTV**.

## Como executar

Requisitos: **Node.js 22.13+**. O `ffmpeg` é opcional (só para os vídeos de demonstração do seed).

```bash
npm install
npm run seed     # opcional: 8 canais com grade, catálogo de exemplo, assinantes e 30 dias de audiência
npm start        # http://localhost:3600
```

Acesso inicial da operação: `admin@playtv.com.br` / `admin123` (troque em produção pelo `.env`).
Com o seed: `curadoria@playtv.com.br` / `play2026` e assinantes `marina@`, `rogerio@`, `andrade@` e
`juliana@exemplo.com.br`, senha `cliente2026` (ativo, ativo, suspenso e aguardando pagamento).

```bash
npm test
```

O seed cadastra os canais com **sinais públicos de teste de HLS** só para a demonstração: troque pelo sinal da
emissora em **Canais**.

## Instalação no servidor (/tv)

```bash
npm run empacotar   # gera dist/play-tv.zip
```

O pacote traz a pasta `tv/` pronta para enviar ao servidor: código, dependências de produção já instaladas, `.env`
com segredo e senha inicial da operação gerados na hora (a senha aparece no terminal) e `LEIA-ME.txt` com o passo a
passo (cPanel, PM2, Docker, Nginx e Apache), incluindo os ajustes de proxy que o vídeo exige.

No Nginx, o `location /tv/` precisa de `proxy_buffering off` (entrega em fluxo do vídeo e dos canais) e de
`client_max_body_size 16m` com `proxy_request_buffering off` (envio do catálogo em pedaços de 8 MB).

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3600` | Porta HTTP. |
| `TV_BASE_PATH` | (raiz) | Endereço da plataforma, ex.: `/tv`. O painel fica em `<endereço>/admin/`. |
| `TV_MARCA` | `PLAY TV` | Nome da plataforma nas telas e no PIX. |
| `TV_SECRET` | aleatório | Segredo das sessões e dos links de reprodução (mín. 32 caracteres). **Obrigatório em produção.** Trocar derruba as sessões e invalida os links. |
| `TV_ADMIN_EMAIL` / `TV_ADMIN_SENHA` / `TV_ADMIN_NOME` | — | Administrador criado no primeiro start. Senha obrigatória em produção (mín. 12). |
| `TV_DB` | `data/tv.db` | Arquivo do banco SQLite. |
| `TV_MIDIA` | `<pasta do banco>/midia` | Pasta dos vídeos, artes e legendas. **Inclua no backup** (o banco guarda só os registros). |
| `TV_VIDEO_MAX_MB` | `8192` | Tamanho máximo de cada vídeo enviado. |
| `TV_UPLOAD_PARTE_MB` | `8` | Tamanho de cada pedaço do envio (combine com o limite do proxy). |
| `TV_ARTE_MAX_MB` / `TV_LEGENDA_MAX_KB` | `8` / `512` | Tamanho máximo das artes e das legendas. |
| `TV_RELAY` | `1` | Transmissão dos canais pelo servidor. `0` faz o player ir direto na origem. |
| `TV_ORIGENS_MIDIA` | — | Domínios das emissoras liberados nas páginas, para canais que tocam direto na origem. |
| `TV_RELAY_TIMEOUT_MS` / `TV_RELAY_CACHE_MS` | `12000` / `2000` | Tempo limite da origem e cache do manifesto HLS. |
| `TV_RELAY_SEGMENTO_MAX_MB` | `32` | Tamanho máximo de cada pedaço do sinal repassado. |
| `TV_PAGAMENTOS` | `manual` em produção | `simulado` (o assinante confirma o PIX na tela, para testes) ou `manual` (a operação confirma). |
| `TV_SESSAO_PLAYER_S` | `120` | Tempo sem sinal de vida até a tela liberar a vaga do plano. |
| `TV_PLAY_TTL` | `21600` | Validade do link de reprodução (segundos). |
| `TV_SESSAO_HORAS` | `720` | Duração da sessão do assinante (a da operação é de 8 horas). |
| `TV_TRUST_PROXY` | `loopback` | Proxies confiáveis para obter o IP real. |
| `TV_LIMITE_LOGIN` | `10` | Tentativas de login por IP por minuto. |
| `TV_FUSO` | `America/Sao_Paulo` | Fuso da grade e dos relatórios. |

A API responde com liberação de origem (CORS) porque os apps de TV levam a interface dentro do aparelho e chamam o
servidor de outra origem. A autenticação é por token no cabeçalho, não por cookie: sem o token, nada responde.

Produção com Docker: `docker build -t play-tv tv/` e rode com um volume em `/app/data` (banco **e** vídeos).

## Tecnologia e arquitetura

Node.js 22 + Express 5, SQLite nativo (`node:sqlite`), telas em HTML/CSS/JS puros sem build, `hls.js` servido do
próprio pacote (sem CDN), testes com `node:test`. Valores em centavos (inteiros), durações em segundos,
classificação indicativa como número (0 = livre, 10, 12, 14, 16, 18).

```
tv/
  server/
    db.js                 # esquema: usuários, perfis, planos, assinaturas, faturas, mídias, canais,
                          #   programas, títulos, temporadas, episódios, legendas, destaques, fileiras,
                          #   favoritos, progresso, sessões do player, auditoria
    lib/assinaturas.js    # planos, contratação, faturas com PIX, ciclo, suspensão e cancelamento
    lib/catalogo.js       # home, fileiras, detalhe, busca, classificação e nível do plano
    lib/epg.js            # grade, "no ar agora" e importação XMLTV
    lib/player.js         # token de reprodução, telas simultâneas, progresso e sinal de vida
    lib/relay.js          # transmissão HLS: reescrita da lista, repasse dos pedaços e proteção contra SSRF
    lib/midia.js          # envio em pedaços, reconhecimento do formato e entrega com HTTP Range
    lib/audiencia.js      # painel, audiência por dia/hora/aparelho, top títulos e canais, financeiro
    routes/               # auth, conta (assinatura e perfis), app (catálogo), play, admin-conteudo, admin-negocio
  public/                 # app do assinante (SPA)
  public/admin/           # painel da operação
  test/
```

### Como o sinal ao vivo chega ao assinante

1. O assinante abre um canal: o servidor confere assinatura, classificação e plano, registra a tela e devolve um
   **token de reprodução assinado** (HMAC, validade curta) apontando para `/api/play/canal/:id/lista.m3u8`.
2. O servidor busca a lista HLS na origem e a **reescreve**: cada pedaço, cada lista filha, cada chave de
   criptografia e cada faixa de áudio ou legenda passa a apontar para o nosso endereço, com o endereço de origem
   **assinado** (ninguém usa o servidor como proxy livre).
3. O player pede os pedaços ao nosso servidor, que os repassa em fluxo, sem gravar em disco.
4. O relay recusa endereços de rede interna (loopback, redes privadas, link-local e metadados de nuvem) e limita o
   tamanho de cada pedaço.

### Como o conteúdo próprio entra

1. No painel, a operação cria o título e envia o vídeo: o navegador fatia o arquivo e manda pedaço por pedaço
   (dá para repetir o último pedaço se a rede cair).
2. No fim, o servidor confere o tamanho, reconhece o formato pelo conteúdo do arquivo, calcula o SHA-256 e marca
   o arquivo como pronto.
3. Publicar só é permitido com vídeo e capa. O vídeo sai apenas por link assinado, com suporte a Range; as artes
   são públicas e cacheáveis (é o que entra em `<img>`).
