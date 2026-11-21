# Vai Mídia

Plataforma de **mídia digital em telas** (mídia indoor / DOOH), publicada em `/midia`.

Você instala telas em condomínios, prédios comerciais, academias e no comércio; o aparelho ligado em cada uma abre o
player e passa a exibir, em carrossel, os anúncios das campanhas vendidas — troca a cada poucos segundos, da
construtora para a loja de calçados, e assim por diante. O painel cuida do resto: cadastro dos pontos, aprovação dos
criativos, montagem automática da programação de cada tela, **prova de exibição**, faturamento dos anunciantes (direto
ou por agência) e a contrapartida de cada ponto.

Em **condomínio**, a contrapartida normalmente não é dinheiro: é o espaço para os **comunicados do prédio** na própria
tela — assembleia, manutenção do elevador, encomendas na portaria —, escritos pelo síndico. Na tela de elevador eles
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

### Painel da equipe
- **Visão geral**: TVs no ar, inserções de hoje, campanhas ativas, receita prevista do mês, inserções por dia,
  publicidade × institucional, campanhas e pontos que mais exibiram, e o que precisa de atenção.
- **TVs**: um cartão por tela com o estado (no ar, sem contato, aguardando pareamento), onde ela fica no ponto, o que
  está no ar agora, pareamento, aviso na faixa e o detalhe de cada aparelho (programação atual, quedas, números do dia).
- **Pontos**: condomínios, prédios e comércios, com telas no ar, unidades, passagens por dia, contrapartida combinada,
  horário de funcionamento, comunicados, repasses, o acesso do responsável e a **identidade que vai no comunicado**
  (logo da administradora e assinatura).
- **Comunicados**: a fila dos recados dos pontos (vindos do portal do síndico ou do lojista) para a equipe aprovar,
  recusar com motivo ou escrever direto.
- **Anunciantes e agências**: cadastro dos dois, campanhas, faturas e o acesso ao portal (com senha provisória).
  A agência carrega a comissão padrão, que entra nas campanhas dela.
- **Campanhas**: lista com situação e entrega de hoje; no detalhe, criativos, onde passa, desempenho e as ações de
  situação (enviar, aprovar, recusar, pausar, retomar, encerrar).
- **Criativos**: grade com prévia de cada imagem/vídeo, fila de aprovação, validade e em quantas campanhas está.
- **Programação**: o loop de uma TV (linha do tempo proporcional, fatia de cada anunciante e inserções por hora),
  com simulação de **qualquer dia e hora**, mais a **ocupação de todas as TVs** — onde ainda cabe campanha.
- **Inventário (mídia kit)**: o que a rede tem para vender — circuitos com telas, pontos, formatos, audiência e preço,
  e a lista de pontos com ambiente, unidades, onde as telas ficam e a tabela. Exporta em CSV para montar a proposta.
- **Relatórios**: por campanha, por TV, por ponto e a **prova de exibição** linha por linha; tudo com CSV.
- **Faturamento**: prévia do mês (calculada do que foi exibido), fechamento, faturas com PIX copia e cola e QR Code.
- **Repasses aos pontos**: comissão de cada lojista sobre a receita das telas dele, com baixa de pagamento.
- **Diagnóstico**: TVs offline ou sem parear, campanhas sem criativo aprovado, criativos vencendo, pontos sem TV,
  faturas vencidas e PIX não configurado.
- **Usuários**, **Configurações** e **Histórico** (auditoria de quem fez o quê).

### Portal do anunciante
Campanhas no ar, inserções e pessoas alcançadas no mês, desempenho por campanha, onde cada anúncio passou,
**prova de exibição com CSV**, envio de criativos (que a equipe aprova) e faturas com o PIX para pagar.

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

A identidade **Vai Mídia** está aplicada no painel, no player e nas telas dos pontos:

| | |
|---|---|
| Preto | `#111417` — menu, rodapé das telas e fundo dos comunicados |
| Lime | `#C8FF31` — destaques, botão principal, relógio e o símbolo |
| Off-white | `#F7F8FA` — fundo do painel no tema claro |

O símbolo (o "V") está em [`public/img/marca.svg`](public/img/marca.svg), em vetor e herdando a cor de onde está
(`currentColor`), e é o mesmo desenho usado no favicon, no menu do painel, na tela de pareamento e no rodapé das telas.
Sobre o lime, o texto é sempre o preto da marca — em fundo claro, o lime puro não tem contraste para ler, então
textos e traços de gráfico usam a versão escurecida (`--cor-tinta`).

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

## Comunicados do ponto e o layout da tela

O recado do próprio ponto. Em condomínio, é a moeda de troca pelo espaço.

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

## Circuitos e inventário

**Circuito** é o pacote que o comercial vende: um conjunto de telas definido por regra (ambiente, cidade, pontos ou
telas específicas), com a audiência somada, as inserções por hora e o preço de tabela. Exemplos: "Residencial
Campinas", "Corporativo", "Comércio e academia".

- A campanha pode ser criada **escolhendo o circuito**: os alvos e as inserções já vêm dele.
- O circuito **cresce sozinho**: um condomínio novo que bate na regra entra no pacote sem ninguém mexer nas campanhas.
- O **Inventário** mostra a rede inteira para a proposta — telas por formato, onde ficam, unidades atendidas,
  passagens por dia e por mês, preço de tabela — e exporta em CSV.

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

## O player (o que roda na TV)

Abra `https://SEU-DOMINIO/midia/tv/` no aparelho ligado à TV e deixe em tela cheia. Funciona em **TV box Android,
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

## Como executar

Requisitos: **Node.js 22.13+**.

```bash
npm install
npm run demo      # opcional: 6 pontos, 9 TVs, 5 anunciantes, campanhas e 31 dias de exibições
npm start         # painel em http://localhost:3600/midia/ e player em http://localhost:3600/midia/tv/
npm test          # 55 testes de aceite
```

A demonstração monta uma rede com 3 condomínios residenciais, um condomínio comercial, academia, mercado, padaria e
clínica — 15 telas entre elevadores, halls, portarias e áreas de atendimento, sendo as dos prédios no layout dividido
—, 3 circuitos, 2 agências, campanhas com PI e comunicados de condomínio. Acessos: `operador@midia.com.br` / `operador-demo-2026`,
`anunciante@midia.com.br` / `anunciante-demo-2026`, `sindico@midia.com.br` e `lojista@midia.com.br` / `lojista-demo-2026`.
O master é o configurado em `MIDIA_ADMIN_EMAIL` (padrão `master@midia.com.br` / `master123`).
As TVs da demonstração aparecem como *sem contato* até um player de verdade se parear.

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
- **WhatsApp**: exige contratar um provedor de mensagens. Por e-mail os avisos já saem automaticamente (com SMTP configurado).
- **Baixa automática do PIX**: depende de integração com o banco. Hoje a fatura é marcada como paga no painel.
- **Medição real de público** (câmera com contagem de pessoas, dados de operadora): os impactos usam o fluxo estimado
  cadastrado no ponto. Onde houver medição externa, basta atualizar o campo de passagens por dia.
- **Integração com sistemas de agência** (envio automático de PI, checking eletrônico por padrão de mercado): o PI é
  registrado na campanha e a prova de exibição sai em CSV para anexar ao relatório de veiculação.
