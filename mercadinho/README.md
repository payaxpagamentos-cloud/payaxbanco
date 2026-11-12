# Mercadinho do Condomínio

Sistema completo para o mercadinho (ou mercado autônomo) de um condomínio: **terminal de autoatendimento (PDV)**,
**estoque**, **compras**, **financeiro**, **conta dos moradores** e **conexão com a maquininha de cartão**.

O PDV é a tela do balcão que **o próprio cliente usa**: ele passa os produtos no leitor, confere a compra e paga.
Não há operador, não há login e não há como chegar ao resto do sistema por ali. A equipe trabalha no painel
administrativo, em outro endereço.

Roda num único processo Node.js, guarda tudo num arquivo SQLite e não precisa de build: o navegador
recebe as páginas prontas. A interface usa efeito de vidro (*glassmorphism*), com tema claro e escuro.

```
npm install
npm run seed     # dados de demonstração (opcional, mas recomendado para conhecer o sistema)
npm start        # http://localhost:3300
```

Com `npm run seed`, entre com **gerente@mercadinho.com.br**, **caixa@mercadinho.com.br**,
**estoque@mercadinho.com.br** ou **moradora@demo.com** — senha `demo12345`.
Sem o seed, use o administrador definido em `MERCADO_ADMIN_EMAIL` / `MERCADO_ADMIN_SENHA`.

O terminal do cliente fica em **http://localhost:3300/pdv/** — o `seed` imprime um código de pareamento para
usar na primeira vez, e a senha de terminal dos moradores da demonstração é `4703`.

---

## Quem usa e o que cada um vê

| Perfil | Para quê |
|---|---|
| **Administrador** | Tudo, incluindo os usuários do sistema |
| **Gerente** | Operação inteira: PDV, estoque, compras, financeiro, relatórios e configurações |
| **Operador de caixa** | Acompanha as vendas do terminal e consulta produtos e moradores |
| **Estoquista** | Produtos, estoque, fornecedores e compras |
| **Morador** | Só a própria conta: o que consumiu, o extrato e as faturas |
| **Cliente no balcão** | O terminal (`/pdv/`): passa os produtos e paga. Nenhum acesso ao resto |

---

## PDV — o terminal do cliente

Endereço do terminal: o do sistema com **`/pdv/`** no fim (por exemplo, `https://seu-dominio/mercadinho/pdv/`).
Abra num tablet ou num computador com leitor de código de barras, em tela cheia, e deixe ali.

**Como o aparelho entra no ar.** Em *Configurações › Terminais*, cadastre o terminal e anote o **código de
pareamento** (aparece uma única vez). No aparelho, abra o endereço e digite o código: ele troca o código por um
token próprio, que vale por um ano e fica só naquele aparelho. Nenhuma senha de funcionário passa pelo balcão.
A administração pode desativar o terminal ou gerar um código novo a qualquer momento — o aparelho antigo para na hora.

**O que o cliente faz, do começo ao fim:**

1. A tela de espera pede para passar o primeiro produto no leitor. Quem leva hortifrúti, pão ou granel toca em
   **Produto sem código** e escolhe na tela; se for vendido por peso, digita o peso da balança num teclado grande.
2. Cada item aparece na lista, com o total crescendo ao lado. Dá para **tirar um item** ou cancelar tudo.
3. Em **Pagar**, escolhe como quer pagar:
   * **PIX** — o QR Code aparece na tela com o valor certo; depois de pagar no banco, toca em "Já paguei".
   * **Cartão** — débito, crédito à vista ou em 2x/3x. A cobrança vai para a maquininha e a tela acompanha até aprovar.
   * **Minha conta** — digita o número do apartamento, escolhe o nome e confirma com uma **senha de 4 números**.
     O sistema mostra quanto ainda cabe no limite e lança a compra na fatura do mês.
4. A tela de fim mostra o resumo, oferece o cupom e volta sozinha ao início para o próximo cliente.

**Dinheiro não entra no terminal**: não há quem dê troco. Quais formas aparecem fica em *Configurações › Loja*.

**Cuidados que já estão no sistema**

* Carrinho esquecido no balcão: a tela avisa e cancela a compra sozinha depois de 90 segundos sem ninguém mexer
  (e o servidor limpa o que tiver ficado para trás).
* A senha do morador trava por 10 minutos depois de 5 erros seguidos, para ninguém ficar testando senha no balcão.
* A lista de moradores não é pública: o cliente digita a unidade e só vê quem mora nela.
* Um terminal nunca enxerga a compra de outro, e a venda só fecha com o pagamento conferido pelo servidor.

### Conferência dos PIX

No PIX é o próprio cliente quem confirma que pagou — é assim que funciona um mercadinho de condomínio sem
ninguém no caixa. Por isso a tela **Vendas do terminal › Conferência de PIX** lista cada um desses pagamentos
para a gestão bater com o extrato da conta e marcar como conferido. O que ficar pendente continua aparecendo.

### Vendas do terminal (equipe)

A equipe acompanha tudo em **Vendas do terminal**: o que foi vendido no período, por qual forma, qual morador
comprou na conta, o cupom de cada compra e o **cancelamento** (devolve o estoque, estorna o fiado e cancela a
cobrança no cartão). O painel mostra o terminal ativo, o último uso e quanto ele vendeu hoje.

### Caixa com atendente

O sistema nasceu com um caixa atendido (abertura com troco, sangria, suprimento e fechamento com conferência) e
essas rotas continuam no servidor, com testes. Como o mercadinho é de autoatendimento, elas não aparecem no
menu — é só reativar as telas se um dia houver alguém no balcão.

## Maquininha de cartão

A compra no cartão **nunca** é fechada sem uma cobrança aprovada e registrada. Cada tentativa vira uma
transação no banco (pendente → aprovada / negada / cancelada / expirada), com NSU, autorização e bandeira.

Quando aprova, o sistema calcula a **taxa da adquirente** e o **prazo de crédito** cadastrados e lança o
valor **líquido** no contas a receber, na data em que o dinheiro realmente cai. É assim que o fluxo de
caixa e o DRE ficam honestos: a venda é hoje, o dinheiro do crédito é em D+30.

Três tipos de maquininha, em **Configurações › Maquininhas**:

| Tipo | Quando usar |
|---|---|
| **Simulada** | Treinar a equipe e testar o fluxo. Aprova tudo na hora, sem maquininha de verdade. |
| **Ponte TEF** | Pinpad ligado ao computador do caixa (PayGo/Elgin, Stone SDK, etc.). O sistema fala HTTP com um agente local. |
| **Mercado Pago Point** | Maquininha inteligente pela internet (API de *payment intents*), com número de série e token da conta. |

### Protocolo da Ponte TEF

O agente roda **no computador do caixa**, junto da maquininha, e responde:

```
POST /pagamento                { valor_centavos, forma, parcelas, referencia }
     -> { id, status: "pendente" }
GET  /pagamento/{id}           -> { id, status, nsu, autorizacao, bandeira, mensagem }
POST /pagamento/{id}/cancelar  -> { status: "cancelada" }
GET  /status                   -> { status: "ok", mensagem }
```

`status`: `pendente`, `aprovada`, `negada` ou `cancelada`. Se houver token cadastrado, ele vai em
`Authorization: Bearer <token>`.

Um agente de exemplo, pronto para receber as chamadas do SDK da adquirente, está em
[`scripts/ponte-maquininha.js`](scripts/ponte-maquininha.js):

```
node scripts/ponte-maquininha.js          # http://127.0.0.1:9090
PORTA=9100 TOKEN=segredo node scripts/ponte-maquininha.js
```

O botão **Testar** na tela de maquininhas conversa com o agente (ou com a API do provedor) sem cobrar nada.
Cobranças esquecidas na maquininha viram `expirada` sozinhas depois de alguns minutos, para o caixa nunca
ficar em dúvida sobre o que foi cobrado.

---

## Estoque

* Saldo por produto em **milésimos** — a mesma conta serve para o que é vendido por unidade e por peso.
* **Custo médio ponderado**: cada entrada ajusta o custo do produto, e é esse custo que vira o CMV da venda.
* **Lotes com validade** (opcional por produto): a saída puxa sempre do lote que vence primeiro (PEPS),
  e a tela de alertas mostra o que venceu e o que está para vencer.
* **Perdas** (vencido, quebrado, consumido na loja) com motivo obrigatório, e **acertos** de saldo.
* **Inventário**: abre a contagem com o saldo esperado de cada produto (ou de uma categoria), você lança o
  que encontrou na prateleira e aplica — cada diferença vira um movimento, com o valor total da sobra/falta.
* Alertas de reposição por estoque mínimo, com o valor do estoque a custo e a preço de venda.

## Compras

Pedido ao fornecedor (rascunho → enviado → recebido), com **sugestão de reposição** pronta por fornecedor
a partir dos produtos no mínimo — um clique transforma a sugestão em pedido.

No **recebimento** você confere quantidade e custo item a item. O sistema então dá entrada no estoque,
recalcula o custo médio, grava a validade do lote, atualiza o preço de venda (com sugestão a partir da
margem padrão da loja) e abre as **contas a pagar** da nota, já parceladas no prazo do fornecedor.

## Financeiro

* **Contas a pagar e a receber** com baixa, estorno e cancelamento; as compras recebidas, as faturas dos
  moradores e as vendas no cartão geram lançamentos sozinhas.
* **Fluxo de caixa diário**: entram as vendas recebidas na hora (dinheiro e PIX) e as contas recebidas;
  saem as contas pagas. O cartão e o fiado entram no dia em que o dinheiro cai de verdade.
* **DRE do mês**: receita, descontos, CMV, lucro bruto e margem, taxas da maquininha, perdas e despesas
  por categoria. As compras não entram como despesa (viram estoque): o que pesa é o custo do que foi vendido.

## Conta dos moradores (o "fiado" do mercadinho)

Cada morador tem bloco, unidade e **limite** (próprio ou o padrão da loja). A venda na conta confere o
limite na hora. No fim do mês, **Fechar o mês** gera uma fatura por morador com as compras do período,
com vencimento no dia configurado, e abre a cobrança no financeiro. Receber o valor quita as faturas mais
antigas e abate o saldo. Também há ajuste manual (crédito ou débito) com motivo.

O morador pode receber um **acesso ao portal** e acompanhar pelo celular o que consumiu, o extrato e as faturas.

## Relatórios

Vendas por dia e por hora, formas de pagamento, ticket médio e margem; mais vendidos; **curva ABC**;
participação por categoria; consumo por morador; produtos **sem giro** (dinheiro parado); e perdas.
Todos exportam **CSV** (separador `;`, abre direto no Excel).

---

## Configuração

Tudo em `.env` (veja [`.env.exemplo`](.env.exemplo)):

| Variável | Para quê |
|---|---|
| `PORT` | Porta do servidor (padrão `3300`) |
| `MERCADO_SECRET` | Segredo que assina as sessões — obrigatório em produção |
| `MERCADO_ADMIN_EMAIL` / `MERCADO_ADMIN_SENHA` / `MERCADO_ADMIN_NOME` | Administrador criado na primeira vez |
| `MERCADO_DB` | Arquivo do banco (padrão `./data/mercadinho.db`) |
| `MERCADO_BASE_PATH` | Caminho em que o sistema é publicado (ex.: `/mercadinho`) |
| `MERCADO_FUSO` | Fuso dos fechamentos e relatórios (padrão `America/Sao_Paulo`) |
| `MERCADO_TRUST_PROXY` | `1` atrás de Nginx/Apache |
| `MERCADO_LIMITE_LOGIN` | Tentativas de login por minuto, por IP |
| `MERCADO_MAQUININHA_TIMEOUT_MS` / `MERCADO_MAQUININHA_EXPIRAR_MIN` | Espera e expiração das cobranças no cartão |
| `MERCADO_TERMINAL_TTL_DIAS` | Dias de validade do pareamento do terminal (padrão 365) |

Dentro do sistema (**Configurações › Loja**): nome e endereço do mercadinho, chave PIX, limite padrão da
conta dos moradores, dia de vencimento da fatura, aviso de validade, margem sugerida nas compras, a opção de
deixar vender sem saldo em estoque e **as formas que o terminal aceita**. Em **Configurações › Terminais**
ficam os aparelhos do balcão.

### Em produção

```
npm run empacotar      # gera dist/mercadinho.zip com tudo pronto e um .env com segredos novos
```

Ou com Docker (o banco fica em `/app/data`, monte um volume):

```
docker build -t mercadinho .
docker run -p 3300:3300 -v mercadinho-dados:/app/data \
  -e MERCADO_SECRET=... -e MERCADO_ADMIN_SENHA=... mercadinho
```

O passo a passo para quem vai instalar no servidor está em [`scripts/LEIA-ME.txt`](scripts/LEIA-ME.txt).

---

## Como o código está organizado

```
server/
  index.js        sobe o servidor e expira cobranças pendentes na maquininha
  app.js          Express, cabeçalhos de segurança e arquivos estáticos
  api.js          monta as rotas e decide o perfil que entra em cada uma
  auth.js         token assinado (HMAC) e controle de perfil
  db.js           schema SQLite, configurações e transações
  lib/            as regras: estoque, vendas, terminal, caixa, compras, financeiro, moradores, maquininha, pix, relatórios
  routes/         as rotas HTTP, uma por assunto
public/
  css/vidro.css   o tema de vidro (claro e escuro)
  js/app.js       navegação, layout e login do painel da equipe
  js/pages/       uma tela por arquivo
  pdv/            o terminal do cliente: página própria, sem menu e sem login
test/             testes de ponta a ponta, com uma ponte TEF falsa
```

**Convenções do banco**: dinheiro em centavos, quantidade em milésimos (1 unidade = 1000, 350 g = 350),
percentuais em pontos-base (349 = 3,49%), datas em `AAAA-MM-DD` e carimbos de tempo em ISO 8601 (UTC).

### API

Tudo sob `/api`, com `Authorization: Bearer <token>` obtido em `POST /api/auth/login`:

| Caminho | Assunto |
|---|---|
| `/api/painel` | A tela inicial inteira numa chamada |
| `/api/produtos`, `/api/produtos/categorias`, `/api/produtos/fornecedores` | Cadastros e busca do PDV |
| `/api/estoque` | Movimentos, entradas, perdas, acertos, alertas e inventários |
| `/api/terminal` | **O terminal do cliente**: pareamento, carrinho, conta do morador, PIX, maquininha e cupom (token próprio) |
| `/api/pdv` | Vendas para a equipe: consulta, cancelamento e conferência dos PIX |
| `/api/caixa` | Caixa atendido: abertura, sangria, suprimento e fechamento (sem tela no menu) |
| `/api/compras` | Pedidos, sugestão de reposição e recebimento |
| `/api/financeiro` | Lançamentos, baixas, fluxo de caixa e DRE |
| `/api/moradores` | Moradores, conta, faturas e portal do morador |
| `/api/relatorios` | Relatórios e exportação em CSV |
| `/api/admin` | Configurações, terminais, maquininhas, usuários e auditoria |

### Testes

```
npm test
```

Cobrem os caminhos que doem se quebrarem: permissões por perfil, custo médio, venda com troco, venda no
cartão (inclusive a ponte TEF, com um agente falso), limite e fatura do morador, recebimento de compra com
contas a pagar, inventário, DRE e PIX. E o terminal inteiro: pareamento, separação entre o token do aparelho e
a sessão da equipe, carrinho, senha do morador (com o bloqueio depois de cinco erros), cartão, carrinho
abandonado e a conferência dos PIX.

---

## O que este sistema **não** faz

* **Não emite documento fiscal** (NFC-e, SAT ou CF-e). O cupom é de controle interno — o que é o normal em
  mercadinho de condomínio sem inscrição estadual própria. Para emitir fiscal, é preciso contratar um
  emissor e ligá-lo ao fechamento da venda.
* **Não confirma o PIX sozinho**: quem avisa que pagou é o cliente, na tela. Para conferir automaticamente seria
  preciso ligar o sistema à API do banco (PIX recebidos) ou a um intermediador de pagamentos. Até lá, a tela de
  conferência existe justamente para a gestão bater com o extrato.
* **Não faz conciliação automática com a adquirente**: o recebível é calculado pela taxa e pelo prazo que
  você cadastra na maquininha. Se a adquirente mudar a taxa, atualize o cadastro.
* O limite de requisições e as sessões ficam na memória do processo: para rodar em mais de uma instância,
  troque por um armazenamento compartilhado.
