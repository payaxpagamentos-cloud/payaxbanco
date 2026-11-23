# PLAY TECH VIP

> Resumo para o cliente, com acessos, passo a passo da operação e o que falta: [ENTREGA.md](ENTREGA.md).

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
| 2 | **TV aberta já cadastrada** | Globo, SBT, Record, Band, RedeTV!, Cultura, Gazeta, TV Brasil, Rede Brasil, Aparecida, Rede Vida e os canais de notícias entram com um clique em **Canais → Importar TV aberta** (número, categoria, logo e onde fica o sinal de cada um). Além disso, **Buscar canais (lista pública)** traz o catálogo aberto do projeto iptv-org, com o melhor sinal de cada canal brasileiro, para importar em lote. Cada canal aceita **sinal .m3u8** (próprio, contratado ou público) ou o **player oficial da emissora**, que abre o player dela com os anúncios dela. |
| 3 | **Grade de programação (EPG)** | Programação por canal, cadastrada na mão (com recusa de sobreposição) ou importada em **XMLTV** — o formato que emissoras e agregadores publicam. O app mostra "no ar agora" com barra de andamento, o que vem depois e um **guia de 7 dias** que já abre no programa do momento. |
| 4 | **Catálogo sob demanda** | Filmes e séries com temporadas, episódios, trailer, elenco, direção, gêneros, classificação indicativa e selo de original. **Envio do vídeo pelo painel em pedaços** (retomável, até 8 GB por arquivo), formato reconhecido pelo conteúdo do arquivo (MP4, WebM, MKV) e entrega com **HTTP Range**. Legendas em WebVTT. Publicar confere se há vídeo e capa. |
| 5 | **Player** | Tela cheia com controles próprios: HLS pelo **hls.js** (com o HLS nativo do Safari como reserva), MP4 com Range, **troca de qualidade entre 4K, Full HD, HD e SD** continuando de onde parou (limitada pelo plano), velocidade, legendas, janela flutuante, tela cheia, atalhos de teclado, **retomada de onde parou**, **próximo episódio** e aviso de telas simultâneas com a opção de encerrar as outras. |
| 5.1 | **Conversão automática** | A operação envia **um** arquivo e o servidor gera as qualidades menores com o ffmpeg, uma de cada vez, em fila no banco (sobrevive a reinício). O painel acompanha o progresso de cada conversão. |
| 6 | **Assinaturas e cobrança** | Planos com preço, telas simultâneas, perfis, qualidade máxima (SD, HD, Full HD ou 4K), downloads e **nível** (libera conteúdo exclusivo). Fatura mensal com **PIX copia e cola e QR Code**, carência, **suspensão automática** de quem não pagou, troca de plano, cancelamento que vale até o fim do período pago e reativação. Todo o conteúdo exige assinatura ativa. |
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
- **Transcodificação em HLS com faixas (ABR)**: a plataforma converte sozinha as versões menores de um arquivo
  enviado (Full HD, HD e SD, com o ffmpeg da máquina) e troca de qualidade no player sem perder a cena, mas cada
  versão é um arquivo próprio — não há uma faixa HLS única que troque de bitrate no meio do pedaço.
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

## Aplicativos (celular, tablet e Smart TV)

Seis formas de assistir, todas no mesmo servidor e no mesmo catálogo. O guia completo, com o
passo a passo de cada loja, está em [`APPS.md`](APPS.md).

| Onde | O que é | Player |
|---|---|---|
| Celular e tablet, sem loja | **App instalável (PWA)**: o assinante abre no navegador e escolhe "Instalar" | player da plataforma |
| Android (celular e tablet) | App nativo em `celular-apps/android/` | ExoPlayer do aparelho |
| iPhone e iPad | App nativo em `celular-apps/ios/` | AVPlayer do iOS |
| Samsung, LG, TCL/Google TV | Apps em `tv-apps/` | player nativo de cada TV |

Um comando aponta todos para o servidor de vocês:

```bash
npm run empacotar-apps https://play.seudominio.com.br
```

O app instalável não depende de loja nem de conta de desenvolvedor: ele é servido pelo próprio
servidor (precisa de HTTPS), ganha ícone na tela inicial, abre em tela cheia e guarda os arquivos
do app para abrir rápido e aguentar a rede oscilar. Vídeo e catálogo nunca ficam guardados.

## Smart TVs (Samsung, LG e TCL)

A interface entra sozinha em **modo TV** quando reconhece o aparelho (Tizen, webOS, Android TV, Fire TV, VIDAA):
fontes maiores, margens de 10 pés, foco bem visível e navegação inteira pelo controle remoto — setas, OK, Voltar
e as teclas de mídia. Dá para ver no computador abrindo `/?tv=1`.

Os apps estão em [`tv-apps/`](tv-apps/README.md) e cada um usa o **player nativo do aparelho**: **AVPlay** na
Samsung (Tizen), o pipeline de mídia do **webOS** na LG e o **ExoPlayer (Media3)** no Android TV da TCL. Na Samsung
e na LG a interface vai empacotada dentro da TV (`npm run empacotar-tv https://seu-dominio/tv`) e conversa com a
API do servidor; no Android TV, a interface roda em WebView e a reprodução é entregue ao player nativo, que devolve
a posição para "continuar assistindo", audiência e limite de telas continuarem valendo.

## De onde vem o sinal de cada canal

A PLAY TECH VIP aceita as três formas que existem hoje, e o painel tem um botão para cada uma:

| Forma | Como entra | Quem paga a banda | Onde isso aparece |
|---|---|---|---|
| **Player oficial da emissora** (embed) | cole o endereço da transmissão aberta da emissora (o YouTube verificado dela, o portal) | a emissora | Canais → fonte "player oficial da emissora" |
| **Sinal .m3u8** (próprio, contratado ou público) | cole o endereço HLS | nós | Canais → fonte "sinal .m3u8" |
| **Lista pública de canais** | busque pelo nome e importe em lote | nós | Canais → **Buscar canais (lista pública)** |

A busca em lista pública usa o catálogo aberto do projeto **iptv-org**: ele traz nome, categoria e o
melhor sinal de cada canal do país. Os canais entram **desligados e numerados a partir do 200** —
a operação testa o sinal e decide o que vai ao ar.

Onde mais procurar o player oficial de uma emissora: **CXTv** e **Guia TV** reúnem os players de
dezenas de emissoras abertas e regionais brasileiras; **Pluto TV**, **Samsung TV Plus** e
**LG Channels** mostram quais canais já são distribuídos abertamente pela internet (os canais FAST).

Dois detalhes práticos que a plataforma já resolve:

- **CORS**: muitos servidores de emissora recusam que um site de terceiros puxe o `.m3u8` pelo
  navegador. Como **quem busca o sinal é o nosso servidor**, e não o navegador do assinante, isso
  deixa de ser problema — inclusive no app web.
- **Endereço com token que expira**: emissoras grandes entregam `.m3u8` com senha temporária
  amarrada ao IP, que morre em algumas horas. A verificação automática a cada 15 minutos marca o
  canal como **sinal com falha** no painel assim que isso acontece, e o campo de endereço é editável
  para a troca. Quando o sinal exige cabeçalho próprio (`User-Agent` ou `Referer`), a plataforma
  guarda e reenvia esse cabeçalho a cada pedaço.

## Fichas e artes dos filmes (base TMDB)

No cadastro de um título, **Buscar ficha e artes na base de filmes** procura o nome na base do
[TMDB](https://www.themoviedb.org) — a mesma que os aplicativos de streaming usam — e traz tudo
pronto: nome em português e original, sinopse, ano, país, duração, classificação indicativa
brasileira, gêneros, elenco, direção e as **artes oficiais** (cartaz e banner), que entram no
acervo como qualquer outra imagem.

Precisa de uma credencial gratuita da conta do cliente em `TV_TMDB_TOKEN`: serve a *API Read
Access Token* (a longa, enviada no cabeçalho) ou a *API Key* de 32 caracteres (enviada na URL) —
a plataforma reconhece as duas. Sem credencial, o botão explica o que falta e o cadastro segue
manual, como antes.

> O TMDB é gratuito para uso não comercial e exige atribuição; para uso comercial, a conta do
> cliente precisa do acordo comercial deles. As artes continuam sendo do estúdio: a base entrega
> o endereço, e quem licencia o filme licencia também o material de divulgação.

### Encher o catálogo de uma vez

```bash
npm run catalogo-demo                                   # lista de demonstração (12 filmes + 6 séries)
npm run catalogo-demo -- "Duna: Parte Dois" "Wicked"    # títulos escolhidos
npm run catalogo-demo -- --serie "Round 6"              # séries
npm run catalogo-demo -- --rascunho                     # sem publicar
```

Traz a ficha e as artes de cada título e põe os três últimos como destaque da home. **O vídeo é o
mesmo arquivo de demonstração para todos**: serve para a vitrine ter o que tocar numa
apresentação. O conteúdo licenciado entra depois pelo painel, um arquivo por título.

### Grade de verdade das emissoras

```bash
npm run epg -- https://provedor/grade.xml.gz             # casa os canais e importa
npm run epg -- https://provedor/grade.xml.gz --listar    # só mostra o que o arquivo tem
npm run epg -- https://provedor/grade.xml.gz --so-mapear # casa sem importar
```

O comando casa cada canal cadastrado com o do arquivo (pelo nome, com a mesma regra que não
deixa "Rede Brasil" virar "TV Brasil"), guarda o identificador em cada canal e importa a
programação. O endereço fica salvo em Configurações, e a plataforma reimporta **uma vez por dia**
sozinha. Um canal que não casar recebe o identificador à mão, no cadastro do canal.

O provedor é escolha da operação: o arquivo que a emissora fornece, um serviço de EPG contratado
ou um público. A plataforma não vem com nenhum endereço embutido.

## Logos das emissoras

Em Canais, **Buscar logos das emissoras** traz o logo oficial de cada canal da lista pública
(iptv-org) e guarda no acervo — é o mesmo uso que qualquer guia de programação faz. A operação
escolhe entre completar só quem não tem ou substituir todos.

Quem não aparece na lista (ou tem material oficial da emissora) recebe a imagem pelo cadastro do
canal, no campo do logo. Os canais importados da lista pública guardam o identificador de origem,
então o logo vem do canal certo, sem adivinhação por nome parecido.

> Se o servidor fica atrás de um proxy de saída, ligue `NODE_USE_ENV_PROXY=1` no `.env`: sem isso o
> Node não usa o proxy e a busca de logos, a lista pública e a grade XMLTV não saem.

## Catálogo de acervo público (filmes livres)

Filmes em domínio público ou Creative Commons entram no catálogo por um comando — com capa,
banner, ficha e a escada de qualidade geradas na importação:

```bash
npm run catalogo-publico -- --listar      # o que está conferido e pronto
npm run catalogo-publico                  # traz para o catálogo
npm run catalogo-publico -- --buscar "nasa" --colecao nasa --importar --quantos 3
```

A lista curada traz obras **atuais e coloridas, em Full HD ou mais** (Sintel, Lágrimas de Aço,
Sita Canta o Blues, Big Buck Bunny), porque a busca aberta do acervo devolve principalmente
clássicos em preto e branco. O script só importa sozinho o que tem licença livre confirmada.

O detalhe — fontes, o que é legal, o que não é e por que listas de IPTV "VOD" ficam de fora —
está em [`ACERVO.md`](ACERVO.md).

## Publicação nas lojas

Os apps saem prontos para enviar: pacote assinado (`.aab`), capturas no tamanho exato de cada
loja, gráfico de destaque, textos da ficha e as respostas dos formulários de privacidade. O guia
é o [`LOJAS.md`](LOJAS.md); as capturas se refazem com o catálogo definitivo em um comando:

```bash
node scripts/capturas-lojas.js https://play.seudominio.com.br
```

Duas páginas públicas acompanham a plataforma, porque as duas lojas exigem:
`/privacidade.html` e `/termos.html` — com os dados da empresa entre colchetes, para preencher.
E o assinante apaga a própria conta em **Minha conta → Excluir minha conta**, como a App Store
exige de todo app com cadastro.

## Grade dos canais abertos

Em **Configurações → Grade dos canais abertos (EPG)**, a operação cadastra o endereço de um arquivo **XMLTV**
(aceita `.xml` e `.xml.gz`) e a plataforma importa sozinha, uma vez por dia — é assim que a programação da TV
aberta se mantém em dia. O provedor da grade é escolhido por vocês: a própria emissora, a afiliada ou um serviço
de guia. Também dá para enviar o arquivo na mão em **Grade (EPG) → Importar XMLTV**.

A atualização roda de 24 em 24 horas e, **ao subir o servidor**, se a última importação já passou de 12 horas —
assim um servidor que reinicia todo dia não fica com a grade parada. Na mesma rotina, a plataforma apaga os
programas que já passaram há mais de 7 dias, para a tabela da grade não crescer para sempre.

## Como executar

Requisitos: **Node.js 22.13+**. O `ffmpeg` é opcional (só para os vídeos de demonstração do seed).

```bash
npm install
npm run seed     # opcional: 8 canais com grade, catálogo de exemplo, assinantes e 30 dias de audiência
npm start        # http://localhost:3600
```

Acesso inicial da operação: `admin@playtechvip.com.br` / `admin123` (troque em produção pelo `.env`).
Com o seed: `curadoria@playtechvip.com.br` / `play2026` e assinantes `marina@`, `rogerio@`, `andrade@` e
`juliana@exemplo.com.br`, senha `cliente2026` (ativo, ativo, suspenso e aguardando pagamento).

```bash
npm test
```

O seed cadastra os canais com **sinais públicos de teste de HLS** só para a demonstração: troque pelo sinal da
emissora em **Canais**.

## Instalação no servidor (/tv)

```bash
npm run empacotar   # gera dist/play-tech-vip.zip
```

O pacote traz a pasta `tv/` pronta para enviar ao servidor: código, dependências de produção já instaladas, `.env`
com segredo e senha inicial da operação gerados na hora (a senha aparece no terminal) e `LEIA-ME.txt` com o passo a
passo (cPanel, PM2, Docker, Nginx e Apache), incluindo os ajustes de proxy que o vídeo exige.

No Nginx, o `location /tv/` precisa de `proxy_buffering off` (entrega em fluxo do vídeo e dos canais) e de
`client_max_body_size 16m` com `proxy_request_buffering off` (envio do catálogo em pedaços de 8 MB).

## No ar com um domínio (docker compose + HTTPS)

> Para instalar num servidor do zero, há um caminho mais curto: o
> [`INSTALACAO.md`](INSTALACAO.md) e o comando `npm run enviar`, que leva o código, instala o
> Docker, sobe a plataforma, emite o HTTPS, agenda o backup e confere tudo.


Para subir num servidor próprio (VPS, nuvem ou máquina na empresa), com HTTPS automático:

```bash
cp .env.exemplo .env     # preencha TV_SECRET, TV_ADMIN_SENHA e DOMINIO
docker compose up -d     # sobe o app e o proxy
docker compose logs -f app
```

O `docker-compose.yml` sobe dois contêineres:

| Serviço | O que faz |
|---|---|
| `app` | A plataforma. A imagem já traz o **ffmpeg**, então a conversão automática das versões funciona. O banco e os vídeos ficam no volume `dados` (`/app/data`). |
| `proxy` | **Caddy**: emite e renova o certificado HTTPS sozinho pelo Let's Encrypt, entrega o vídeo em fluxo (sem buffer) e aceita envios de até 16 GB. |

Antes de subir: aponte o domínio do `.env` para o IP do servidor e deixe as portas **80 e 443** abertas — o
Let's Encrypt precisa das duas para emitir o certificado.

Converter vídeo é o que mais consome CPU. `CPUS_APP` no `.env` limita quanto o app pode usar, para uma conversão
longa não derrubar o resto do servidor.

Em produção o servidor **recusa subir** sem `TV_SECRET` e `TV_ADMIN_SENHA`, com valores curtos ou **ainda com os
valores de exemplo do `.env.exemplo`** (os que têm "troque"): é a checagem que impede abrir ao público com a senha
que veio no pacote.

Ao receber `SIGTERM` (o que o `docker compose down`, o `restart` e o `systemctl stop` mandam), a plataforma **para
de aceitar conexões, deixa as que estão em curso terminarem e fecha o banco** antes de sair, com 15 segundos de
prazo. Envio de vídeo e canal ao vivo não são cortados no meio por um reinício planejado.

### Conferir a instalação

Depois de subir (e sempre que mexer no servidor), uma conferência de ponta a ponta pela API:

```bash
BASE=https://play.seudominio.com.br ADMIN=admin@provedor.com.br SENHA='a senha da operação' npm run conferir
```

Confere se a API responde, se o ffmpeg está disponível, se o app e o painel abrem, se o certificado
HTTPS é válido e o http redireciona, se a operação entra, se o que é privado pede sessão e se há canal
ligado e título publicado. Sai com erro se algo falhar — serve para o cron ou para o checklist de entrega.

### Backup

```bash
npm run backup /var/backups/playtechvip              # guarda as 7 cópias mais recentes
npm run backup /var/backups/playtechvip -- --manter 14
npm run backup /var/backups/playtechvip -- --sem-midia
```

O banco sai por `VACUUM INTO` (cópia consistente, com o servidor no ar) e a mídia é espelhada com `rsync`. Numa
rotina diária, basta o cron:

```
20 3 * * * cd /caminho/do/tv && npm run backup /var/backups/playtechvip >> /var/log/playtechvip-backup.log 2>&1
```

Para restaurar: pare o servidor, ponha `tv.db` e a pasta `midia` no lugar de `data/` e suba de novo.

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3600` | Porta HTTP. |
| `TV_BASE_PATH` | (raiz) | Endereço da plataforma, ex.: `/tv`. O painel fica em `<endereço>/admin/`. |
| `TV_MARCA` | `PLAY TECH VIP` | Nome da plataforma nas telas e no PIX. |
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

Produção com Docker: `docker build -t play-tech-vip tv/` e rode com um volume em `/app/data` (banco **e** vídeos).

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
