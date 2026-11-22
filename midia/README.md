# Vai Mídia

Plataforma de **mídia digital em telas** (mídia indoor / DOOH), publicada em `/midia`.

Você instala telas onde passa gente todo dia — condomínios, prédios comerciais, mercados, academias, clínicas,
padarias, lojas; o aparelho ligado em cada uma abre o
player e passa a exibir, em carrossel, os anúncios das campanhas vendidas — troca a cada poucos segundos, da
construtora para a loja de calçados, e assim por diante. O painel cuida do resto: cadastro dos pontos, aprovação dos
criativos, montagem automática da programação de cada tela, **prova de exibição**, faturamento dos anunciantes (direto
ou por agência) e a contrapartida de cada ponto.

A contrapartida muda conforme o ponto. Em **condomínio**, normalmente não é dinheiro: é o espaço para os
**comunicados do prédio** na própria tela — assembleia, manutenção do elevador, encomendas na portaria —, escritos
pelo síndico. Na tela de elevador eles
ficam **parados de um lado enquanto a publicidade gira do outro**, com a logo da administradora e a assinatura do
síndico. Em comércio, a contrapartida costuma ser comissão sobre a receita das telas daquele ponto. As duas formas
convivem, e ainda há a de valor fixo por mês.

Servidor próprio (Node.js + SQLite), sem depender dos outros sistemas do repositório. Tema claro por padrão, com o escuro no botão do topo.

| Perfil | O que vê |
|---|---|
| **Master** | Tudo: pontos, TVs, anunciantes, campanhas, criativos, programação, relatórios, faturamento, repasses, usuários, configurações e histórico. |
| **Operador** | O dia a dia: cadastros, campanhas, aprovação de criativos, pareamento de TVs, relatórios, faturamento e repasses. Não mexe em usuários, configurações nem exclui cadastros. |
| **Anunciante** (portal) | Só as campanhas dele: onde passaram, quantas inserções, quantas pessoas alcançou, a prova de exibição em CSV, os criativos e as faturas com PIX. |
| **Responsável pelo ponto** (portal) | Síndico, administradora ou lojista: só o ponto dele — se a tela está no ar, o que está passando, os **comunicados** do prédio ou da loja, o conteúdo próprio e o repasse a receber. |

## Como funciona, do começo ao fim

1. **Cadastre o ponto**: ambiente (condomínio residencial ou comercial, prédio corporativo, academia, mercado, padaria,
   clínica, shopping, painel de rua…), endereço, unidades (apartamentos ou salas), passagens de pessoas por dia,
   horário de funcionamento e a **contrapartida combinada** — comissão sobre a receita, valor fixo por mês ou nenhuma
   (o caso do condomínio que recebe os comunicados em troca).
2. **Instale a tela** e abra `/midia/tv/` no aparelho. Ele mostra um código de 6 caracteres na tela. Diga também **onde
   ela fica** dentro do ponto (elevador social, hall, portaria, recepção, fila do caixa) e o **layout**: dividida,
   com o comunicado do prédio parado ao lado da publicidade, ou tela cheia.
3. **Pareie** em *TVs › Parear aparelho*: digite o código e escolha o ponto. Pronto — o aparelho já começa a exibir.
4. **Monte os circuitos** (*Inventário*): o pacote que o comercial vende, como "Residencial Campinas" ou "Corporativo",
   com a audiência somada e o preço de tabela. O circuito se atualiza sozinho quando entra um ponto novo que bate na regra.
5. **Cadastre o anunciante** (e a **agência**, quando a compra vem por ela), envie os criativos e **aprove** cada um.
   Nada vai ao ar sem aprovação.
6. **Crie a campanha**: circuito (ou alvos manuais), período, dias da semana, faixa de horário, inserções por hora,
   prioridade, número do **PI** e como cobra. Envie para aprovação e aprove.
7. As telas **baixam a programação sozinhas** em segundos e começam a exibir. Cada exibição é registrada.
8. No fim do mês, *Faturamento* fecha a competência: faturas dos anunciantes (bruto, comissão de agência e líquido,
   com PIX) e os repasses dos pontos.

## Telas

### A entrada no sistema

A tela de login é a página mais aberta do sistema e a primeira coisa que o cliente vê do produto: ela
mostra a fotografia de uma tela da rede ocupando a janela inteira, com o formulário num cartão de vidro
por cima — o visual aprovado no atendimento, no mesmo padrão do site.

- **Olho na senha**: dá para conferir o que foi digitado antes de errar pela terceira vez.
- **Lembrar de mim**: marcado, a sessão sobrevive a fechar o navegador e o e-mail volta preenchido;
  **desmarcado, a sessão morre junto com a aba** — que é o certo no computador da portaria ou da
  recepção, onde a próxima pessoa não pode cair dentro do painel de quem usou antes. A senha nunca é
  guardada no navegador.
- **Acessar player** leva ao endereço que se abre no aparelho ligado à TV, e *Voltar ao site* volta
  para a vitrine.

A criação de senha nova (o link que chega por e-mail) usa a mesma tela.

### Painel da equipe
- **Visão geral**: TVs no ar, inserções de hoje, campanhas ativas, receita prevista do mês, inserções por dia,
  publicidade × institucional, campanhas e pontos que mais exibiram, e o que precisa de atenção.
- **TVs**: um cartão por tela com o estado (no ar, sem contato, aguardando pareamento), onde ela fica no ponto, o que
  está no ar agora, pareamento, aviso na faixa e o detalhe de cada aparelho (programação atual, quedas, números do dia).
- **Pontos**: condomínios, prédios comerciais, mercados, academias, clínicas e lojas, com telas no ar, unidades, passagens por dia, contrapartida combinada,
  horário de funcionamento, comunicados, repasses, o acesso do responsável e a **identidade que vai no comunicado**
  (logo da administradora e assinatura).
- **Comunicados**: a fila dos recados dos pontos (vindos do portal do síndico ou do lojista) para a equipe aprovar,
  recusar com motivo ou escrever direto.
- **Anunciantes e agências**: cadastro dos dois e o acesso ao portal (com senha provisória). A agência carrega a
  comissão padrão, que entra nas campanhas dela. A ficha do cliente é onde fica o que se procura quando ele liga:
  **o financeiro dele** (em aberto, vencido, próximo vencimento, já recebido), os **contratos**, o **histórico de
  pagamentos**, as campanhas e as faturas.
- **Campanhas**: lista com situação e entrega de hoje; no detalhe, criativos, onde passa, desempenho e as ações de
  situação (enviar, aprovar, recusar, pausar, retomar, encerrar).
- **Criativos**: grade com prévia de cada imagem/vídeo, fila de aprovação, validade e em quantas campanhas está.
- **Programação**: o loop de uma TV (linha do tempo proporcional, fatia de cada anunciante e inserções por hora),
  com simulação de **qualquer dia e hora**, mais a **ocupação de todas as TVs** — onde ainda cabe campanha.
- **Inventário (mídia kit)**: o que a rede tem para vender — circuitos com telas, pontos, formatos, audiência e preço,
  e a lista de pontos com ambiente, unidades, onde as telas ficam e a tabela. Exporta em CSV, e cada circuito gera a
  **proposta comercial** pronta para imprimir ou salvar em PDF: a marca, a rede alcançada, as inserções e pessoas
  alcançadas estimadas, onde o anúncio passa ponto a ponto, o investimento (com desconto e CPM) e a validade.
- **CRM**, em três telas no menu lateral:
  - **Funil**: o quadro de quem ainda não é cliente — os dois lados do negócio, quem quer **anunciar** e o
    ponto que quer **tela** (condomínio, loja, academia, clínica, prédio comercial — o lead nasce sem ambiente
    definido, porque quem sabe qual é é a equipe). Cada lead tem etapa, valor estimado, responsável, o histórico das conversas e,
    acima de tudo, **o próximo passo e a data**: lead sem próximo passo marcado é lead que morre numa coluna, e por
    isso ele aparece em destaque. No alto, *o que está combinado para hoje* e o que já passou da data.
    Ganhar o lead **cria o cliente** (ou o ponto) a partir dele, e o lead continua apontando para o cadastro que
    nasceu dali — é assim que se sabe de onde veio cada contrato.
  - **Propostas**: o papel que sai do funil — com **link próprio para mandar no WhatsApp**. Cada proposta fica guardada com a **folha do dia em que foi feita** —
    a rede muda toda semana, e reimprimir uma proposta de dois meses atrás tem de mostrar o que foi oferecido, não o
    inventário de hoje. Quando o cliente aceita, **nascem o cliente, o contrato e a campanha** (em rascunho,
    esperando o criativo) com as telas do circuito, sem ninguém redigitar o que já foi combinado.
  - **E-mail**: a caixa de entrada da empresa dentro do sistema — o que chega pelo servidor de e-mail da
    plataforma cai aqui **ligado ao lead de quem escreveu**, a resposta sai daqui e as duas coisas entram no
    histórico do funil. Mensagem de desconhecido fica marcada como "sem lead" e vira lead com um botão.
    Detalhes e o que o domínio precisa ter: *Caixa de entrada do CRM*, mais abaixo.
- **Relatórios**: por campanha, por TV, por ponto e a **prova de exibição** linha por linha; tudo com CSV. Cada
  campanha gera ainda o **relatório de veiculação** (o *checking* que a agência pede): o que foi ao ar no mês, por
  ponto, por criativo e as últimas linhas da prova, na mesma folha impressa da proposta — com o CSV completo em anexo.
- **Financeiro**, com quatro telas:
  - **Fluxo de caixa**: o que entrou e o que saiu no período (pela data do pagamento), o que ainda está previsto
    (pela data do vencimento), o saldo projetado do mês, a série **mês a mês**, para onde foi o dinheiro e os
    lançamentos um a um. É a visão que contas a receber e contas a pagar só dão separadas.
  - **Contas a receber**: as faturas dos anunciantes, com o que vence nos próximos 7 dias, o que já atrasou (e há
    quantos dias), o **atraso por faixa** (até 30, 31–60, 61–90, mais de 90), a baixa do pagamento e o **controle de
    nota fiscal** (quais faturas já têm NFS-e emitida e quais não).
  - **Contas a pagar**: numa lista só, os **repasses aos pontos** (que nascem do fechamento) e as **despesas da
    operação** — internet do prédio, aparelho, instalação, manutenção, comissão de venda, aluguel de espaço.
    O lançamento aceita **repetição mensal** (a internet que chega todo mês vira 12 contas de uma vez) e tem baixa e estorno.
  - **Faturamento**: a prévia do mês calculada do que foi exibido, o fechamento (que gera faturas e repasses) e as
    faturas da competência, com PIX copia e cola e QR Code.
  As três primeiras exportam em **CSV**, e a planilha *notas a emitir* sai com tomador, CNPJ, discriminação do serviço
  e valor — o que o contador precisa para emitir.
- **Diagnóstico**: TVs offline ou sem parear, campanhas sem criativo aprovado, criativos vencendo, pontos sem TV,
  faturas vencidas e PIX não configurado.
- **Usuários**, **Configurações** e **Histórico** (auditoria de quem fez o quê).

### Portal do anunciante
Campanhas no ar, inserções e pessoas alcançadas no mês, desempenho por campanha, onde cada anúncio passou,
**prova de exibição com CSV**, envio de criativos (que a equipe aprova) e, em *Faturas*, o **contrato dele**
(vigência, cobrança, valor, dia do vencimento, reajuste e renovação — só para ler) junto das faturas, com o PIX
para pagar e o número da nota fiscal quando já emitida.

### Portal do responsável pelo ponto (síndico, administradora ou lojista)
As telas do ponto (no ar ou não, e o que está passando agora), os **comunicados** do prédio ou da loja
("Assembleia dia 12", "Elevador 2 em manutenção") — que a TV desenha entre os anúncios —, o **aviso na faixa**
("Pão quentinho às 17h"), envio de conteúdo próprio e o repasse a receber, mês a mês.

## Como a programação de cada TV é montada

O servidor monta a grade **na hora**, para cada tela, e o player só baixa de novo quando ela muda:

1. Entram as campanhas **ativas** cujo período, dias da semana e faixa de horário batem com o momento, que têm alvo
   compatível com aquela tela (sem alvo = toda a rede) e ao menos um criativo **aprovado e no prazo**.
2. Cada campanha recebe inserções no loop **proporcionais às inserções por hora contratadas**, sempre com pelo menos
   uma por criativo (todos vão ao ar). Campanha com teto diário sai da grade daquela TV quando bate a meta.
3. Se o loop passar do **tempo máximo**, as campanhas de **menor prioridade** perdem inserções primeiro.
   Entre os anúncios entram **todos os comunicados aprovados daquele ponto** (pelo menos uma vez cada) e, se o loop
   ainda ficar abaixo do **tempo mínimo**, o conteúdo institucional (da rede e do próprio ponto) completa.
4. As inserções são **espalhadas** pelo loop e, sempre que possível, dois anúncios do mesmo anunciante não ficam em sequência.
5. Tela em retrato prefere criativo em retrato; em paisagem, o contrário.

A tela *Programação* mostra exatamente esse resultado, inclusive simulando outro dia e horário.

## A marca na tela

**O padrão é o do site.** O visual aprovado no atendimento (`site/`) manda em tudo: painel, portais, player das
TVs, as folhas que o cliente recebe em PDF e os e-mails automáticos. Quem sai de vaimidia.com.br e entra no
painel tem de sentir que é a mesma casa.

| | |
|---|---|
| Tinta | `#18232A` — menu lateral, botão principal, títulos, fundo dos comunicados na TV |
| Lima | `#C8FF31` — destaques: item ativo do menu, tracinho das seções, relógio da TV e o símbolo |
| Papel | `#F5F7FA` — fundo do painel no tema claro, do site e dos e-mails |
| Linha | `#D9DFE5` — borda de cartão e de tabela |
| Tipografia | **Open Sans**, a mesma do site, em `woff2` recortado (cada peso em torno de 15 kB) |

Três regras que vêm do site e valem em todo lugar: **o botão principal é da cor da tinta com texto branco**
(o lima é destaque, não preenchimento de bloco); **título é pesado e apertado** (800, `letter-spacing` negativo);
e **cartão é branco com linha fina e canto de 18px**. No tema escuro a tinta sumiria no fundo, então lá o botão
principal é o próprio lima com texto na tinta — é a única inversão.

O símbolo (o "V") está em [`public/img/marca.svg`](public/img/marca.svg), em vetor e herdando a cor de onde está
(`currentColor`), e é o mesmo desenho usado no favicon, no menu do painel, na tela de pareamento e no rodapé das telas.
Sobre o lima, o texto é sempre a tinta da marca — em fundo claro, o lima puro não tem contraste para ler, então
textos e traços de gráfico usam a versão escurecida (`--cor-tinta`).

O teste *Padrão visual: o sistema inteiro segue o site* lê as cores direto de `site/css/styles.css` e cobra
painel, TV e e-mail: se alguém reintroduzir o preto antigo ou outra fonte, o teste quebra.

O **nome e a frase da marca** ficam em *Configurações › Marca* e valem para o painel inteiro e para as telas: quem
revende a plataforma com outro nome troca ali, sem mexer no código.

### A tela da marca

Quando sobra espaço no loop — ou quando a tela acabou de ser instalada e ainda não tem campanha — **a própria tela
desenha a peça da marca**: logotipo, frase e o símbolo grande sangrando no canto, ajustado a telas deitadas e em pé.
Ninguém precisa produzir nem subir arte, e uma tela nova nunca aparece preta num hall.

Esse tempo é **não vendido**, e é anotado na prova de exibição como tal: ele entra no denominador da ocupação e da
divisão dos impactos, então o anunciante nunca recebe o público que passou enquanto a tela mostrava a marca da rede.
Em *Configurações › Tela da marca* dá para desligar ou mudar quanto tempo ela fica no ar. Conteúdo institucional que
a equipe tenha enviado tem preferência: a peça da marca só completa o que faltar.

## Contratos

O contrato é o acordo comercial que sustenta as campanhas de um cliente, e por isso mora **na ficha dele**:
número, objeto, vigência, forma de cobrança (mensal, CPM, pacote ou cortesia), valor, dia de vencimento, reajuste,
renovação automática e situação (rascunho, ativo, suspenso, encerrado).

As campanhas se ligam ao contrato, e a fatura nasce carregando de qual contrato ela veio — então, olhando uma conta
a receber, dá para saber na hora qual acordo ela está cumprindo. Contrato que já gerou fatura não é excluído: encerra.

### O ciclo do contrato: vencer, reajustar e renovar

Contrato que acaba sem ninguém ver é receita que cai sozinha, e reajuste esquecido é desconto que o cliente nem
pediu. O sistema cuida dos três:

- **Avisa**: contratos que vencem nos próximos dias (padrão 30, configurável), os que já passaram da data e
  continuam ativos, e os que chegaram na data do reajuste. Sai por e-mail uma vez por dia e aparece no *Diagnóstico*
  e na ficha do cliente, na coluna **Ciclo**.
- **Reajusta**: na data combinada, pelo percentual. O reajuste vale também para **as campanhas do contrato** — é da
  campanha que a fatura nasce, então reajustar só o papel não mudaria a cobrança. Cada reajuste fica no histórico
  (de quanto para quanto, em que data, por qual índice e quem aplicou), e o anunciante vê a data do último no portal.
- **Renova**: onde foi combinada renovação automática, o contrato se estende sozinho pelo mesmo período, **estendendo
  junto as campanhas que terminavam com ele** — senão a veiculação pararia no dia seguinte ao contrato renovado.

O que o sistema **não** faz: inventar o índice. Ele não sabe o IPCA do mês. Com um **percentual fixo** guardado no
contrato, o reajuste sai sozinho na data; **sem** percentual, o contrato entra na lista de pendências e a equipe
informa quanto aplicar. Ninguém quer um sistema decidindo aumento por conta própria.

## Comunicados do ponto e o layout da tela

O recado do próprio ponto — a assembleia no prédio, o horário das aulas na academia, o aviso da recepção na
clínica. Em condomínio, costuma ser a moeda de troca pelo espaço.

- O **síndico (ou lojista) escreve no portal**: título, texto, tipo (aviso, manutenção, assembleia, entrega, urgente)
  e por quantos dias fica no ar. A equipe aprova em *Comunicados* — ou a plataforma pode ser configurada para que
  entrem direto (*Configurações › comunicado do ponto entra no ar direto*).
- A **tela desenha o comunicado na hora**: logo da administradora, tipo em destaque, nome do prédio, título em letras
  grandes, o texto, a data e a assinatura ("Administração / Síndico — …"). Não existe arte para produzir nem arquivo
  para baixar, e o mesmo texto se ajusta a tela deitada ou em pé.
- Cada exibição entra na prova de exibição como tempo **não vendido**, então a ocupação da grade continua honesta.
- Alterar um comunicado que já está no ar manda ele de volta para a conferência da equipe.

Cada tela escolhe como mostra isso (*TVs › Editar › Layout da tela*):

| Layout | Como fica |
|---|---|
| **Dividida** | O padrão de elevador: o comunicado fica **parado** numa parte da tela (44% deitada, 46% em pé) enquanto a **publicidade gira** na outra. Com vários comunicados no ar, eles se revezam nessa zona, no ritmo de cada um (no mínimo 15 segundos, para dar tempo de ler). |
| **Tela cheia** | O anúncio ocupa a tela inteira e o comunicado entra **no meio do carrossel**, como mais um item. É o normal em comércio, onde quase não há recado do ponto. |

Na tela dividida, o anúncio que não tem a proporção exata da zona é exibido **inteiro** (nada é cortado) sobre um
fundo com a própria peça desfocada — em vez de barras pretas no meio do hall.

## O que o morador olha por vontade própria

Tela que só passa anúncio vira papel de parede. Ao lado dos comunicados, a zona do ponto mostra mais duas coisas
— e é isso que faz a pessoa olhar de novo amanhã, seja o morador no elevador, o aluno na academia ou quem espera
na recepção da clínica:

- **A agenda do ponto** ("O que vem por aí"): todo comunicado pode ter **data e hora do evento**. Os próximos
  quatro entram num quadro em ordem de data — a assembleia e a dedetização no prédio, a aula especial na academia,
  o fim da promoção na loja. Sem data preenchida, o recado
  continua girando normalmente como comunicado — a agenda é um extra, não uma obrigação.
- **O clima do dia**: temperatura, descrição, máxima e mínima, no quadro e também na faixa de baixo (em telas
  em pé, só a temperatura, que é o que cabe). Os dados vêm do **Open-Meteo** (gratuito, sem cadastro), buscados
  pelo servidor **uma vez por cidade a cada 30 minutos** — dez prédios na mesma cidade usam uma consulta só.

A TV nunca espera por uma API de terceiro: o servidor busca em segundo plano e guarda. Se a internet do servidor
cair ou o serviço recusar, a tela deixa de mostrar o clima e **nada mais muda** — nenhum anúncio deixa de passar.
Por depender de acesso à internet, vem **desligado** de fábrica (*Configurações → Conteúdo útil na tela*).

## Circuitos e inventário

**Circuito** é o pacote que o comercial vende: um conjunto de telas definido por regra (ambiente, cidade, pontos ou
telas específicas), com a audiência somada, as inserções por hora e o preço de tabela. Exemplos: "Residencial
Campinas", "Corporativo", "Comércio e academia".

- A campanha pode ser criada **escolhendo o circuito**: os alvos e as inserções já vêm dele.
- O circuito **cresce sozinho**: um condomínio novo que bate na regra entra no pacote sem ninguém mexer nas campanhas.
- O **Inventário** mostra a rede inteira para a proposta — telas por formato, onde ficam, unidades atendidas,
  passagens por dia e por mês, preço de tabela — e exporta em CSV.

## Prova visual: a foto do que está na tela

A prova de exibição diz o que a TV *registrou*; a prova visual mostra o que ela está **exibindo**. De tempos em
tempos (padrão: 30 minutos, configurável, 0 desliga) o player desenha num canvas o conteúdo que está no ar e envia
a imagem ao servidor. O painel guarda **só a última de cada TV** — a anterior sai do disco — e a mostra na lista de
TVs e no detalhe de cada aparelho, com a hora e o nome do que estava passando.

É a diferença entre "a TV respondeu" e "a TV está mesmo mostrando o anúncio certo", sem ninguém ir até o prédio.
Não há câmera nem leitura do ambiente: é uma cópia do que o próprio player está desenhando.

## Prova de exibição, impactos e faturamento

- **Prova de exibição**: o player envia em lote tudo o que foi ao ar (mídia, campanha, instante e duração). Reenvio
  depois de uma queda de internet **não duplica**. O painel e o portal do anunciante mostram linha por linha, com CSV.
- **Impactos** (pessoas alcançadas, estimativa): fluxo de pessoas do ponto no dia × a fatia do tempo de tela que a
  campanha ocupou naquele dia. Uma campanha com 20% do loop de uma padaria de 500 pessoas/dia recebe 100 impactos.
- **Faturamento** do mês, por campanha:
  - **mensal**: o valor contratado, proporcional aos dias em que a campanha esteve no ar dentro do mês;
  - **CPM**: impactos do mês ÷ 1.000 × o CPM contratado;
  - **cortesia**: entra na fatura com valor zero, só para constar o que foi exibido.
  Campanha **sem nenhuma exibição no mês não é cobrada**. Fechar o mês de novo **não altera** fatura paga ou cancelada.
- **Agência**: quando a campanha vem por agência, a comissão dela (padrão da agência, ajustável por campanha) sai do
  bruto. A fatura mostra **bruto, comissão e líquido**, e o número do **PI** fica em cada item.
- **Contrapartida ao ponto**, conforme o combinado em cada um:
  - **comissão**: a receita líquida de cada campanha é dividida entre os pontos na proporção do tempo que ela ocupou
    em cada um; sobre a parte do ponto aplica-se o percentual combinado;
  - **valor fixo por mês**: pago enquanto as telas do ponto exibiram (o aluguel do espaço, comum em prédios);
  - **nenhuma**: sem repasse em dinheiro — o caso do condomínio cuja contrapartida são os comunicados na tela.
- A fatura sai com **PIX copia e cola** (BR Code do Banco Central) e QR Code, com a chave configurada em *Configurações*.
- **Nota fiscal**: cada fatura guarda o **número, a data e o link** da NFS-e, e o painel mostra quais ainda estão sem.
  A **emissão** em si é feita no sistema da prefeitura — veja *O que depende de terceiros*.

## O player (o que roda na TV)

Abra `https://vaimidia.com.br/midia/tv/` no aparelho ligado à TV e deixe em tela cheia. Funciona em **TV box Android,
Fire TV Stick, Chromecast com Google TV, mini PC, Raspberry Pi** ou no navegador da própria smart TV.

- **Pareamento por código**: o aparelho não tem usuário nem senha. Mostra um código (sem letras parecidas, tipo `DT6KZ7`),
  a equipe confirma no painel e o aparelho guarda um token próprio. *Desparear* no painel invalida o token na hora.
- **Funciona sem internet**: os arquivos ficam no cache do navegador e a programação fica guardada. Caindo a internet,
  a TV continua exibindo o que tem e mostra um aviso discreto; a fila de exibições é enviada quando a conexão volta.
- **Imagem e vídeo** em tela cheia, com a próxima peça pré-carregada e transição suave. Vídeo roda até o fim; imagem,
  pelo tempo contratado. Vídeo entra sem som, a menos que a tela esteja configurada com som.
- **Comunicados do ponto** desenhados pela própria TV (sem arquivo), em tela cheia ou na zona fixa ao lado da
  publicidade, com a logo da administradora e a assinatura do síndico.
- **Faixa de baixo** com relógio, a legenda fixa da tela e o aviso do lojista (quando houver).
- **Troca de programação na virada do loop**, para nunca cortar um anúncio no meio.
- Atalhos para quem instala: **i** mostra o diagnóstico do aparelho (TV, ponto, versão da grade, fila, conexão),
  **f** entra em tela cheia e **r** recarrega.

### API das TVs (para outro player)

Quem quiser usar outro aparelho ou software pode falar direto com a API (`<endereço>/api/player`):

| Rota | O que faz |
|---|---|
| `POST /registrar` | Gera o código de pareamento (manda aparelho, resolução e versão). |
| `GET /pareamento?codigo=` | Consulta até a equipe confirmar; devolve o **token do aparelho**. |
| `GET /programacao` | A grade atual: itens em ordem, duração, versão e a configuração da tela. |
| `POST /batida` | Diz que está vivo e o que está no ar; a resposta avisa se a grade mudou. |
| `POST /exibicoes` | Prova de exibição em lote (até 500 por vez, sem duplicar): `midia_id` ou `comunicado_id`. |
| `GET /midia/:id` | O arquivo, com cache longo e download parcial (vídeo). |
| `GET /logo` | A logo da administradora do ponto, para o cabeçalho do comunicado. |

As rotas usam `Authorization: Bearer <token do aparelho>`.

## WhatsApp ao lado do e-mail

No Brasil, cobrança e proposta se resolvem no WhatsApp — então, onde o sistema já falava por e-mail, agora fala
pelos dois. Em um clique, o painel **abre a conversa certa com o texto já escrito**:

- **Cobrança da fatura** (em *Contas a receber* e na própria fatura): competência, valor, vencimento e, quando há,
  o **PIX copia e cola** junto — que é o que resolve o pagamento na hora.
- **Lead do CRM**: chama no WhatsApp e já anota a conversa no histórico do lead.
- **Ficha do cliente e do ponto**: WhatsApp e e-mail lado a lado, ali onde o telefone está.
- **Proposta**: abre o WhatsApp do cliente com a mensagem e o link da proposta (veja a seção seguinte).

Do outro lado, quem é cliente também ganha o caminho de volta: configurando o **WhatsApp da empresa**
(*Configurações → WhatsApp da empresa*), aparece um botão **Falar com a equipe** nos portais do anunciante e do
ponto, um botão no site e outro na proposta que o cliente abre pelo link.

O que o sistema **não** faz é disparar sozinho: quem aperta "enviar" é a pessoa, do próprio número. Disparo
automático exige contratar um provedor oficial da Meta — veja *O que depende de terceiros*. O e-mail automático
(fatura vencida, tela fora do ar, contrato vencendo) continua como está.

## Caixa de entrada do CRM (servidor de e-mail próprio)

Em **CRM › E-mail** fica a caixa de entrada da empresa, dentro do sistema. O que chega entra ligado ao lead
de quem escreveu, a resposta sai daqui e **as duas coisas entram no histórico do funil**, junto com as
ligações e as visitas. A razão é prática: a conversa que decide a venda estava espalhada na caixa pessoal de
cada atendente; quem pegasse o cliente no dia seguinte não sabia o que tinha sido combinado.

O que já funciona:

- **Receber**: o sistema tem o próprio servidor SMTP (`server/lib/smtp-servidor.js`). Com
  `MIDIA_EMAIL_DOMINIOS` preenchido, ele ouve na porta 25 e aceita o que for endereçado aos seus domínios.
- **Ler**: assunto e corpo saem legíveis mesmo com acento, codificação antiga ou mensagem só em HTML.
  O painel mostra **texto**, nunca o HTML de quem mandou — e-mail de desconhecido não executa nada aqui
  dentro. A mensagem original fica guardada em `.eml` e pode ser baixada; os anexos saem dela na hora.
- **Responder**: sai pelo servidor de envio configurado (`MIDIA_SMTP_*`), amarrado à mesma conversa
  (quem recebe vê a resposta embaixo da pergunta) e vira anotação no lead.
- **Ligar ao funil**: mensagem de desconhecido fica marcada como "sem lead" e vira lead com um botão.
  A caixa **não** cria lead sozinha de propósito: caixa de e-mail recebe spam, e lead automático entope o funil.
- **Não retransmite**: mensagem para domínio que não é seu é recusada na porta (`550`). Sem isso, o endereço
  vira "relay aberto", serve de trampolim para spam e entra em lista negra na mesma semana.

### O que o domínio precisa ter (e o que ainda depende de terceiros)

Receber e-mail não é só ligar o programa. Para o mundo entregar mensagem aqui:

| | |
|---|---|
| **A** | `mail.vaimidia.com.br` → o IP fixo da máquina |
| **MX** | `vaimidia.com.br` → `mail.vaimidia.com.br`, prioridade 10 (o MX aponta para um nome, nunca para um IP) |
| **Porta 25 aberta** | de entrada, liberada pelo provedor de hospedagem |
| **DNS reverso (PTR)** | o IP respondendo `mail.vaimidia.com.br` — o mesmo nome do MX |
| **SPF** | `v=spf1 ip4:SEU.IP -all`, para o que sai |
| **DKIM** | `MIDIA_DKIM_*` com a chave privada aqui e a pública no TXT `<seletor>._domainkey` |
| **DMARC** | `v=DMARC1; p=none; rua=mailto:...`, para acompanhar |

Três avisos honestos, antes de apontar o MX:

1. **Porta 25 costuma ser bloqueada.** Quase toda nuvem (AWS, Google Cloud, Azure, Oracle) bloqueia a porta 25
   por padrão, e muitas só liberam mediante pedido. Em Linux, porta abaixo de 1024 também exige permissão:
   `setcap 'cap_net_bind_service=+ep' $(which node)`, ou ouvir numa porta alta com um redirecionamento.
2. **Enviar pelo servidor próprio é o pedaço difícil.** Receber é tranquilo; mandar e *chegar na caixa de
   entrada* depende de reputação de IP, que leva meses. A recomendação é a que já está no código:
   **receber aqui e enviar por um provedor** (Google Workspace, Zoho, Amazon SES, Mailgun) em `MIDIA_SMTP_*`.
   Assim a resposta ao cliente não cai no spam.
3. **Não há filtro de spam nem antivírus.** Tudo que for endereçado aos seus domínios é guardado. Os anexos
   ficam em disco e nunca são abertos pelo sistema, mas quem clicar baixa o que veio. Se a caixa for muito
   divulgada, o caminho é um provedor na frente, filtrando, e o encaminhamento para cá.
   A conexão na porta 25 também é **sem TLS** (o servidor recusa `STARTTLS`): entre servidores, a mensagem
   trafega aberta. Para exigir sigilo no transporte, use um provedor na frente.

O *Diagnóstico* mostra o estado do servidor de e-mail e quantas mensagens estão esperando resposta.

## A proposta no WhatsApp

É por WhatsApp que a proposta chega ao cliente, então ela tem endereço próprio: cada proposta nasce com um
**link aleatório** (`/midia/proposta/?p=…`) que abre a folha inteira no celular, **sem login e sem app**, e com
o botão *Salvar em PDF* — o PDF sai do próprio navegador, pelo imprimir. No painel, um botão abre o WhatsApp do
cliente com a mensagem já escrita e o link dentro; mandar a proposta é o que a tira do rascunho e a move para
*na mesa do cliente*.

Dois cuidados que valem explicação:

- **A folha é a do dia em que a proposta foi feita.** Se a rede crescer amanhã, o link continua mostrando o que
  foi oferecido — e não um inventário que o cliente nunca viu.
- **A equipe sabe quando o cliente abriu** (quantas vezes e a última delas). É o que permite dar o retorno na
  hora certa, em vez de ligar no escuro. Proposta recusada sai do ar; proposta vencida continua abrindo, mas
  com o aviso de que o prazo terminou.

O que **não** é feito automaticamente: o disparo. Quem aperta "enviar" no WhatsApp é a pessoa, com o próprio
número — envio automático exige contratar um provedor oficial da Meta (veja *O que depende de terceiros*).

## O site do Vai Mídia

A pasta `site/` traz o site institucional aprovado no atendimento: fundo claro, cabeçalho flutuante com efeito
vidro, fotografias das telas **em uso** (shopping, elevador, TV indoor e recepção) e o planejador de campanha.
Continua sem framework e sem compilação — HTML, CSS e JS editáveis —, com a fonte e o símbolo locais.

As fotografias são recortes, feitos no navegador por `data-crop`, da arte aprovada
(`assets/layout-aprovado.webp`). São **aplicações ilustrativas**, e o site diz isso no rodapé: não são fotos de
pontos ou clientes reais da rede.

Três coisas ligam o site ao sistema:

- **O planejador vira lead no CRM.** Além de montar o briefing para baixar, copiar ou mandar no WhatsApp, o
  pedido é enviado para `/api/contato` e entra no funil com origem "site" — quem quer anunciar como lead de
  anunciante, quem oferece o espaço como lead de ponto. A mensagem de recebimento só aparece depois que o
  servidor confirma. Por isso o formulário pede **nome, e-mail e WhatsApp**: pedido sem caminho de volta não
  vira negócio.
- **O WhatsApp sai do painel.** O número cadastrado em *Configurações → WhatsApp da empresa* aparece no
  resultado do briefing, sem ninguém editar arquivo.
- **O rodapé leva ao painel**, para quem já é cliente entrar no portal.

O endereço oficial é **https://vaimidia.com.br**: o site fica na raiz, o painel em `/midia/` e o player das TVs
em `/midia/tv/`. O domínio está escrito no `canonical`, nas meta tags de prévia de link, no `sitemap.xml` e no
`robots.txt` — que deixa o site ser indexado e **mantém o painel e os links de proposta fora do buscador**.

O servidor publica o site na **raiz do domínio** e também em `<base>/site/`; o painel segue em `<base>/`
(padrão `/midia/`). Para hospedar o site separado (Vercel, Netlify, nginx), basta subir a pasta e desligar aqui
com `MIDIA_SITE=0` — nesse caso ele descobre a API sozinho, ou você fixa o endereço com
`<body data-api="https://vaimidia.com.br/midia/api/">`. Sem API por perto, o site funciona como pacote estático.

Quando o link do site é colado no WhatsApp, no Instagram ou em qualquer lugar que mostre prévia, aparece
`site/assets/og-capa.jpg` (1200×630), a marca e o endereço. Trocar a imagem é trocar esse arquivo.

O portfólio comercial em PDF fica em `site/assets/` e é baixado pelo próprio site.

## Como executar

Requisitos: **Node.js 22.13+**.

```bash
npm install
npm run demo      # opcional: 6 pontos, 9 TVs, 5 anunciantes, campanhas e 31 dias de exibições
npm start         # painel em http://localhost:3600/midia/ e player em http://localhost:3600/midia/tv/
npm test          # 115 testes de aceite
```

A demonstração monta uma rede com 3 condomínios residenciais, um condomínio comercial, academia, mercado, padaria e
clínica — 15 telas entre elevadores, halls, portarias e áreas de atendimento, sendo as dos prédios no layout dividido
—, 3 circuitos, 2 agências, campanhas com PI e contrato, comunicados de condomínio e contas a pagar da operação. Acessos: `operador@midia.com.br` / `operador-demo-2026`,
`anunciante@midia.com.br` / `anunciante-demo-2026`, `sindico@midia.com.br` e `lojista@midia.com.br` / `lojista-demo-2026`.
O master é o configurado em `MIDIA_ADMIN_EMAIL` (padrão `master@midia.com.br` / `master123`).
As TVs da demonstração aparecem como *sem contato* até um player de verdade se parear.

### No servidor (Ubuntu 24.04 LTS)

A instalação inteira numa máquina limpa — site, painel, portais, player, servidor de e-mail, nginx,
HTTPS e o serviço subindo sozinho no reinício — está em [`instalacao/`](instalacao/LEIA-ME.md):

```bash
cd midia/instalacao
./conferir.sh --dominio vaimidia.com.br     # antes: a máquina tem o que precisa?
sudo ./instalar.sh --dominio vaimidia.com.br --email voce@vaimidia.com.br
```

No fim ele imprime a senha do master e os registros que faltam no DNS (A, MX, SPF, a chave DKIM já
gerada e DMARC). `--simular` mostra tudo o que seria feito sem tocar na máquina; rodar de novo não
sobrescreve configuração, senha nem chave. Para atualizar depois: `sudo ./atualizar.sh`.

O sistema fica em `/opt/vaimidia`, a configuração em `/etc/vaimidia/vaimidia.env` e os dados (banco,
criativos, e-mails, backups) em `/var/lib/vaimidia`.

Configuração: veja [`.env.exemplo`](.env.exemplo). Em produção com Docker:

```bash
docker build -t midia-indoor midia/
docker run -p 3600:3600 -v midia-dados:/app/data \
  -e NODE_ENV=production -e MIDIA_SECRET=... -e MIDIA_ADMIN_SENHA=... midia-indoor
```

O banco e os arquivos das mídias ficam em `/app/data` — monte um volume persistente aí.

## Configurações da plataforma

Nome que aparece no painel e nas TVs; duração padrão de imagem; inserções por hora sugeridas; tempo **mínimo** e
**máximo** do loop; intervalo da batida das TVs e quanto tempo sem contato conta como offline; se o lojista pode
escrever o aviso da própria TV; se o comunicado publicado pelo ponto entra no ar direto ou passa pela equipe;
preços de tabela (mensalidade por tela e CPM); comissão sugerida ao ponto; dia de vencimento das faturas; por quantos
dias a prova de exibição detalhada é guardada (o resumo por dia, que alimenta relatórios e faturamento, **nunca** é
apagado); e os dados do PIX.

## Operação do dia a dia

| | |
|---|---|
| **Comando remoto** | Em *TVs*, dá para mandar uma tela (ou todas de um ponto) **recarregar o player** ou **limpar o cache e recarregar**. O comando viaja na batida que já acontece de minuto em minuto — é assim que uma versão nova do player entra nas telas já instaladas, sem ninguém ir ao prédio. O botão **Atualizar players** pega de uma vez só as telas que ficaram numa versão anterior, e o Diagnóstico aponta quais são. |
| **Backup** | O banco é copiado sozinho a cada 24 h (configurável), guardando as 30 cópias mais recentes; em *Configurações* dá para gerar na hora e baixar. Os arquivos das mídias são grandes e nunca mudam depois de enviados, então em vez de entrar em toda cópia eles são **espelhados** para a pasta de `MIDIA_ESPELHO` — e, enquanto isso não estiver configurado, o painel e o Diagnóstico dizem com todas as letras que as peças não têm cópia. |
| **Avisos por e-mail** | **Tela fora do ar** (um aviso por queda, para quem opera), **fatura vencida** (uma vez por dia, para o anunciante e um resumo para a equipe) e **fila de aprovação parada** há mais de um dia. Tudo desligável, e sem SMTP configurado nada quebra — o Diagnóstico só avisa que ninguém está sendo alertado. |
| **Esqueci minha senha** | O síndico ou o anunciante pede o link na tela de entrada e recebe por e-mail um endereço que vale **uma hora e serve uma vez só**. Pedir de novo derruba o link anterior, e a resposta é a mesma exista ou não a conta — ninguém descobre quem tem acesso. Sem SMTP, a tela manda falar com a equipe (que troca a senha no painel). |

## Segurança

- Senhas com **scrypt**; sessões do painel por token assinado (HMAC), com validade de 12 horas.
- Cada perfil só enxerga o que é dele: o anunciante nunca vê dados de outro anunciante, o responsável pelo ponto nunca
  vê outro ponto (nem de quem é cada anúncio que passa na tela dele), e o token de uma TV não abre o painel (nem o contrário).
- Arquivos das mídias ficam **fora da pasta pública**, com nome aleatório, e o tipo é reconhecido pelo conteúdo do
  arquivo — não pelo nome nem pelo cabeçalho enviado.
- Limite de tentativas de login por IP, cabeçalhos de segurança e CSP restrita.
- **Histórico** registra quem criou, alterou, aprovou, pareou, faturou e pagou.
- Do link de nova senha guardamos só o resumo (SHA-256), nunca o código; ele expira em uma hora, serve uma vez e
  o limite de tentativas por IP vale também para o pedido.

## O que depende de terceiros (não incluído)

- **Compra do aparelho e da TV** e a internet do ponto. O player roda no navegador; não há instalação de app.
- **Ligar e desligar a TV sozinha** (CEC/RS-232) depende do modelo do aparelho; o normal é configurar o próprio
  aparelho para ligar com a energia e nunca descansar a tela.
- **WhatsApp automático**: disparar mensagem sozinho (aviso de fatura vencida, confirmação de proposta) exige
  contratar um provedor oficial da Meta — a API de Negócios tem custo por conversa e precisa de número e modelos
  de mensagem aprovados. O que o sistema faz sem isso: abre a conversa com o texto pronto, para a pessoa enviar
  do próprio WhatsApp. Por e-mail, os avisos já saem automaticamente (com SMTP configurado).
- **Baixa automática do PIX**: depende de integração com o banco. Hoje a fatura é marcada como paga no painel.
- **Emissão automática da NFS-e**: depende de **certificado digital A1/A3** da empresa e da integração com o sistema
  do município, que muda de cidade para cidade. O painel faz a parte que não depende disso: monta a planilha com
  tomador, CNPJ, discriminação do serviço e valor, e guarda o número da nota emitida em cada fatura, para o financeiro
  saber o que já foi e o que falta.
- **Medição real de público** (câmera com contagem de pessoas, dados de operadora): os impactos usam o fluxo estimado
  cadastrado no ponto. Onde houver medição externa, basta atualizar o campo de passagens por dia.
- **Integração com sistemas de agência** (envio automático de PI, checking eletrônico por padrão de mercado): o PI é
  registrado na campanha e a prova de exibição sai em CSV para anexar ao relatório de veiculação.
