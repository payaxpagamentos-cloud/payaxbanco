# APP Táxi

Aplicativo de táxi com três partes num só servidor: **app do passageiro**, **app do motorista** e **painel da central**,
com **pagamento sempre antes da viagem** (PIX, cartão ou empresa faturada), **preço fechado** e o **PIX do saldo** pedido pelo motorista. Funciona no navegador do
celular (não precisa instalar nada da loja) e não depende do Ativa BPO: tem banco, usuários e login próprios.

| Endereço | Para quem |
|---|---|
| `/passageiro/` | Passageiro: pede a corrida, vê o preço antes, acompanha o motorista e paga |
| `/motorista/` | Motorista: fica online, recebe e aceita corridas, acompanha ganhos e pede o PIX do saldo |
| `/central/` | Equipe da central: mapa ao vivo, aprovações, corridas, empresas, pagamentos, PIX dos motoristas, tarifas e relatórios |

## O que cada parte faz

### App do passageiro
- Cadastro com nome, celular, e-mail e senha.
- Origem pela localização do aparelho; destino pela **busca de endereço** ou tocando no mapa.
- **Estimativa de preço** para Táxi comum e Executivo, com distância, tempo e aviso de bandeira 2.
- Forma de pagamento, escolhida **antes** e paga **antes**: **PIX** ou **cartão** (a chamada só vai para os taxistas depois que o
  pagamento é confirmado) ou **Empresa** (faturado), que só aparece para quem a gestão autorizou naquela empresa, com o saldo disponível do mês.
  Nada é pago ao taxista na hora. Vê os táxis livres por perto (posição aproximada).
- Acompanha a corrida: procurando motorista → a caminho (com tempo de chegada) → chegou → em viagem → finalizada.
  Vê nome, nota, carro, cor e **placa** do motorista, com botão para ligar.
- No PIX, o **QR Code e o "copia e cola"** já com o valor. O valor pago é o valor final (preço fechado). No fim, a confirmação, as devoluções (se houver) e a avaliação do motorista
  (1 a 5 estrelas e comentário).
- Pode cancelar antes de a viagem começar: **o que já pagou é estornado**. Histórico de corridas.

### App do motorista
- Cadastro com **CPF e CNH validados** (dígitos verificadores), validade da CNH, chave PIX e o veículo (placa antiga ou Mercosul,
  modelo, cor, ano, categoria). Fica **em análise** até a central aprovar.
- Fica online escolhendo um veículo aprovado. A posição vem do GPS; sem GPS (ou no computador), toca no mapa para marcar.
- **Ofertas de corrida** dentro do raio configurado, da mais próxima para a mais distante, mostrando em destaque **quanto ele recebe, já sem a
  taxa da plataforma**, a distância até o passageiro e o destino. Só chegam corridas já pagas (ou de empresa). Aceita ou recusa; o primeiro que aceita leva (dois motoristas não pegam a mesma corrida).
  Veículo executivo atende as duas categorias; o comum, só a comum.
- Botões **Navegar** (Google Maps), **Cheguei**, **Iniciar** e **Finalizar**. Pode desistir antes de iniciar: a corrida volta para os outros.
- Não recebe nem confirma pagamento: no fim aparece **"Você recebe R$ …"**, que já entra no saldo. Avalia o passageiro.
- **Ganhos** de hoje, 7 ou 30 dias (valor recebido já sem a taxa, valor das corridas, taxa, km rodados), **saldo disponível** e extrato.
- **Pede o PIX** do saldo (todo ou parte) para a chave PIX cadastrada, **no máximo um por dia**, e acompanha cada pedido (aguardando, pago com o identificador, ou cancelado com o motivo).
- Cadastra outros veículos (passam pela aprovação) e atualiza a chave PIX.

### Painel da central
- **Painel**: motoristas online, pedidos na fila, corridas em atendimento, faturamento e taxa do dia, valores a repassar e a cobrar, pendências.
- **Mapa ao vivo**: táxis livres e ocupados, pedidos aguardando motorista e a lista de corridas em curso.
- **Corridas**: filtro por período, status e pagamento pendente; detalhe completo (horários, estimativa, valor final, taxímetro de conferência, valor pago,
  pagamentos e estornos, divisão, avaliação); cancelar corrida (com estorno).
- **Empresas**: cadastro (CNPJ, e-mail do financeiro, limite mensal, vencimento), **autorização de passageiros** pelo e-mail da conta no app
  (com centro de custo e limite mensal por pessoa, bloquear e liberar), **faturas** do mês (gerar, CSV com as corridas, marcar paga, cancelar).
- **Pagamentos**: PIX a confirmar e **estornos a devolver**, com o identificador de cada operação.
- **Motoristas**: análise do cadastro (aprovar, recusar com motivo, bloquear, liberar), aprovação de novos veículos, extrato e ajuste na conta.
- **Passageiros**: busca, número de corridas, nota dada pelos motoristas, desativar e reativar conta.
- **PIX dos motoristas**: fila dos pedidos de PIX feitos pelos motoristas; marcar como pago (com o identificador da transferência) ou cancelar
  com motivo (o valor volta ao saldo e o motorista pode pedir de novo no mesmo dia). Saldos de todos os motoristas.
- **Relatórios**: corridas, faturamento, receita da plataforma, ticket médio, gráfico por dia, por forma de pagamento,
  ranking de motoristas, impressão/PDF e **exportação para o Ativa BPO Financeiro**.
- **Tarifas e regras** (só administrador): bandeirada, km nas bandeiras 1 e 2, minuto, tarifa mínima; taxa da plataforma, raio de busca,
  espera máxima, prazo para pagar, valor mínimo do PIX do motorista (padrão: sem mínimo), horário da bandeira 2, domingos e feriados,
  chave PIX da plataforma.
- **Equipe** (só administrador): usuários **administrador** e **operador** e o registro de auditoria.

## Como o dinheiro funciona

**Tudo é pago antes, nunca na hora.**

| Forma | Quando paga | O que acontece |
|---|---|---|
| **PIX** | antes de chamar o táxi | A corrida fica "aguardando pagamento"; com o PIX confirmado, a chamada vai para os taxistas. Sem pagamento no prazo (padrão 15 min), é cancelada. |
| **Cartão** | antes de chamar o táxi | Igual ao PIX (exige o intermediador de pagamentos; veja abaixo). |
| **Empresa** | na fatura do mês | Só para passageiros autorizados pela gestão, dentro dos limites mensais da empresa e da pessoa. A chamada sai na hora. |

**Preço fechado.** O passageiro paga antes a estimativa (bandeirada + km × distância estimada + minuto × tempo estimado, nunca abaixo da
mínima), e esse é o valor final da corrida, sem acerto no fim. O taxímetro da viagem real fica registrado na corrida só para conferência.

No taxímetro de conferência, a distância percorrida soma as posições de GPS do motorista durante a viagem (saltos de sinal acima de 150 km/h são descartados);
sem GPS, vale a distância estimada. A bandeira 2 vale à noite (padrão 20h às 6h), aos domingos e nos feriados nacionais, e é definida no pedido.

**Cancelamento**: o que o passageiro pagou é **estornado** (pelo passageiro antes do início, pela central, ou pelo sistema quando nenhum
taxista aceita a tempo). Se o motorista desiste, a corrida volta para os outros, sem estorno.

**Motorista**: a **taxa da plataforma** (padrão 15%) sai do valor da corrida; o restante entra no saldo do motorista ao finalizar e fica
**disponível na hora**. Como o dinheiro passa sempre pela plataforma, o motorista só tem valores a receber. Ele **pede o PIX** pelo app (todo o
saldo ou parte, um pedido por dia, para a chave cadastrada); o valor sai do saldo no pedido. A plataforma faz a transferência e registra o
identificador; se cancelar o pedido, o valor volta ao saldo.

### Modo de pagamento (`TAXI_PAGAMENTOS`)
- `simulado` (padrão fora de produção): para testes; o passageiro aprova o PIX ou o cartão por um botão na tela e os estornos saem na hora.
- `manual` (padrão em produção): o PIX vai para a chave da plataforma e a central confirma o recebimento em *Pagamentos*; os estornos
  ficam lá para a central devolver. Cartão fica indisponível.
- Para confirmar PIX e cobrar cartão **automaticamente**, é preciso contratar um intermediador de pagamentos e ligá-lo em
  `server/lib/pagamentos.js` (criar a cobrança nele e receber a confirmação por webhook).

### Integração com o Ativa BPO Financeiro
Em **Relatórios → Exportar para o BPO**, sai o CSV no formato do importador do BPO (*Integrações → Importar lançamentos por CSV*):
as taxas da plataforma das corridas finalizadas entram como **contas a receber** e os PIX pagos aos motoristas como **contas a pagar**, com o motorista
como contato (pelo CPF). As categorias padrão são as do plano de contas inicial do BPO (*Prestação de serviços* e *Serviços terceirizados*);
outras podem ser escolhidas com `?categoria_receita=` e `?categoria_despesa=`.

### O que depende de terceiros (não incluído)
- **Confirmação automática do PIX**, **cartão de crédito** e **estorno automático**: exigem contrato com um banco ou intermediador de pagamentos
  (PSP), que avisa o pagamento por webhook. Sem ele, o sistema gera o QR Code PIX e a central confirma e devolve pela tela *Pagamentos*.
- **Transferência automática do PIX pedido pelo motorista**: exige ligar a API PIX da conta da plataforma. Hoje a central transfere e registra o identificador.
- **Rota pelas ruas e tempo com trânsito**: exige um serviço de rotas (Google, Mapbox, OSRM próprio). A estimativa usa a distância em
  linha reta × fator de rota e a velocidade média configurada; o valor cobrado usa o GPS real.
- **Notificação com o app fechado** (push) e **apps nas lojas** (Android/iOS): a versão atual roda no navegador, com o app aberto.
- **Mapa e busca de endereços**: por padrão usam os serviços públicos do OpenStreetMap, que têm limite de uso. Para muitos acessos,
  contrate um provedor de mapas e configure `TAXI_MAPA_TILES` e `TAXI_GEOCODER_URL`.

## Instalação

Requer **Node.js 22.13 ou mais novo** (o banco é SQLite embutido no Node, sem instalar nada além).

```bash
cd taxi
npm install
cp .env.exemplo .env   # ajuste o segredo e a senha do administrador
npm start              # http://localhost:3200
```

Primeiro acesso à central: o e-mail e a senha de `TAXI_ADMIN_EMAIL` / `TAXI_ADMIN_SENHA` (padrão em desenvolvimento:
`admin@apptaxi.com.br` / `admin123`). Cadastre a **chave PIX da plataforma** em *Tarifas e regras* antes de aceitar corridas por PIX.

Dados de demonstração (um passageiro autorizado a pedir pela empresa de exemplo e três motoristas online no centro de São Paulo, senha `demo12345`):

```bash
npm run seed
```

### Produção
- Rode atrás de HTTPS (nginx, Caddy ou o balanceador do provedor): a **localização do celular só funciona em HTTPS**.
- Defina `NODE_ENV=production`, `TAXI_SECRET` (32+ caracteres) e `TAXI_ADMIN_SENHA` (12+ caracteres); o servidor recusa iniciar sem eles.
- Com proxy reverso, ajuste `TAXI_TRUST_PROXY`. O banco fica em `TAXI_DB` (padrão `data/taxi.db`): faça backup dessa pasta.
- Docker: `docker build -t app-taxi . && docker run -p 3200:3200 -v taxi-dados:/app/data -e TAXI_SECRET=... -e TAXI_ADMIN_SENHA=... app-taxi`

### Configuração

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3200` | Porta do servidor |
| `TAXI_SECRET` | aleatório | Assina as sessões (sem ele, todos saem ao reiniciar) |
| `TAXI_ADMIN_NOME` / `_EMAIL` / `_SENHA` | — | Administrador criado no primeiro início |
| `TAXI_DB` | `data/taxi.db` | Arquivo do banco |
| `TAXI_FUSO` | `America/Sao_Paulo` | Fuso dos relatórios e da bandeira 2 |
| `TAXI_MAPA_CENTRO` | `-23.5505,-46.6333` | Centro inicial do mapa |
| `TAXI_MAPA_TILES` / `TAXI_MAPA_ATRIBUICAO` | OpenStreetMap | Camada do mapa |
| `TAXI_GEOCODER_URL` | Nominatim (OSM) | Busca de endereços; vazio desliga |
| `TAXI_GEOCODER_CONTATO` / `TAXI_GEOCODER_PAISES` | — / `br` | Identificação exigida pelo Nominatim e países da busca |
| `TAXI_TRUST_PROXY` | `loopback` | Proxies confiáveis (IP real no limite de login) |
| `TAXI_LIMITE_LOGIN` | `10` | Tentativas de login/cadastro por minuto por IP |
| `TAXI_PAGAMENTOS` | `simulado` (`manual` em produção) | Modo de pagamento (veja acima) |

## Segurança
- Senhas com scrypt; sessão por token assinado (HMAC) de 12 horas; o perfil é sempre lido do banco a cada requisição.
- Cada perfil só alcança as próprias rotas; passageiro e motorista só veem as próprias corridas; o passageiro vê os táxis próximos com posição arredondada.
- Limite de tentativas de login e cadastro por IP; cabeçalhos de segurança (CSP sem scripts externos, sem iframes).
- Ações da central (aprovações, cancelamentos, pagamentos, PIX dos motoristas, tarifas, regras, equipe) ficam na auditoria.

## Testes

```bash
npm test
```

Cobrem o fluxo inteiro pela API: cadastros e validações, aprovação, pagamento antes (a chamada só sai depois), PIX copia e cola (com CRC),
oferta com o valor do motorista sem a taxa e aceite (inclusive disputa entre dois motoristas), trajeto por GPS com descarte de saltos,
preço fechado (taxímetro só registrado), empresa (autorização, limites, fatura), cancelamentos e expirações com estorno,
redistribuição, avaliações, PIX pedido pelo motorista (um por dia, cancelamento devolve o saldo), relatório, a exportação lida pelo importador do Ativa BPO e as permissões.

## Estrutura

```
taxi/
├── server/
│   ├── index.js, app.js, api.js, auth.js, config.js, db.js, seed.js
│   ├── lib/      corridas, financeiro, tarifa, pix, geo, datas, validacao, ...
│   └── routes/   auth, passageiro, motorista, central, geo
├── public/       páginas /passageiro, /motorista e /central (JavaScript sem build; Leaflet para o mapa)
└── test/
```
