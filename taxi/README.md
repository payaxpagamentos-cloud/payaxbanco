# APP Táxi

Aplicativo de táxi com três partes num só servidor: **app do passageiro**, **app do motorista** e **painel da central**,
com tarifa por taxímetro, pagamento por PIX, cartão ou dinheiro e **repasses** aos motoristas. Funciona no navegador do
celular (não precisa instalar nada da loja) e não depende do Ativa BPO: tem banco, usuários e login próprios.

| Endereço | Para quem |
|---|---|
| `/passageiro/` | Passageiro: pede a corrida, vê o preço antes, acompanha o motorista e paga |
| `/motorista/` | Motorista: fica online, recebe e aceita corridas, acompanha ganhos e repasses |
| `/central/` | Equipe da central: mapa ao vivo, aprovações, corridas, repasses, tarifas e relatórios |

## O que cada parte faz

### App do passageiro
- Cadastro com nome, celular, e-mail e senha.
- Origem pela localização do aparelho; destino pela **busca de endereço** ou tocando no mapa.
- **Estimativa de preço** para Táxi comum e Executivo, com distância, tempo e aviso de bandeira 2.
- Forma de pagamento: **PIX**, **cartão** ou **dinheiro**. Vê os táxis livres por perto (posição aproximada).
- Acompanha a corrida: procurando motorista → a caminho (com tempo de chegada) → chegou → em viagem → finalizada.
  Vê nome, nota, carro, cor e **placa** do motorista, com botão para ligar.
- No fim, o valor pelo taxímetro; se for PIX, o **QR Code e o "copia e cola"** já com o valor. Avalia o motorista (1 a 5 estrelas e comentário).
- Pode cancelar antes de a viagem começar. Histórico de corridas.

### App do motorista
- Cadastro com **CPF e CNH validados** (dígitos verificadores), validade da CNH, chave PIX e o veículo (placa antiga ou Mercosul,
  modelo, cor, ano, categoria). Fica **em análise** até a central aprovar.
- Fica online escolhendo um veículo aprovado. A posição vem do GPS; sem GPS (ou no computador), toca no mapa para marcar.
- **Ofertas de corrida** dentro do raio configurado, da mais próxima para a mais distante, com quanto ele ganha, distância até o passageiro,
  destino e forma de pagamento. Aceita ou recusa; o primeiro que aceita leva (dois motoristas não pegam a mesma corrida).
  Veículo executivo atende as duas categorias; o comum, só a comum.
- Botões **Navegar** (Google Maps), **Cheguei**, **Iniciar** e **Finalizar**. Pode desistir antes de iniciar: a corrida volta para os outros.
- Confirma o pagamento recebido e avalia o passageiro.
- **Ganhos** de hoje, 7 ou 30 dias (bruto, taxa, líquido, recebido em mãos, km rodados), **saldo**, extrato e repasses.
- Cadastra outros veículos (passam pela aprovação) e atualiza a chave PIX.

### Painel da central
- **Painel**: motoristas online, pedidos na fila, corridas em atendimento, faturamento e taxa do dia, valores a repassar e a cobrar, pendências.
- **Mapa ao vivo**: táxis livres e ocupados, pedidos aguardando motorista e a lista de corridas em curso.
- **Corridas**: filtro por período, status e pagamento pendente; detalhe completo (horários, estimativa × valor final, divisão, avaliação);
  cancelar corrida e confirmar pagamento.
- **Motoristas**: análise do cadastro (aprovar, recusar com motivo, bloquear, liberar), aprovação de novos veículos, extrato e ajuste na conta.
- **Passageiros**: busca, número de corridas, nota dada pelos motoristas, desativar e reativar conta.
- **Repasses**: saldos de todos os motoristas, gerar repasses, marcar como pago (com o identificador do PIX) ou cancelar.
- **Relatórios**: corridas, faturamento, receita da plataforma, ticket médio, gráfico por dia, por forma de pagamento,
  ranking de motoristas, impressão/PDF e **exportação para o Ativa BPO Financeiro**.
- **Tarifas e regras** (só administrador): bandeirada, km nas bandeiras 1 e 2, minuto, tarifa mínima; taxa da plataforma, raio de busca,
  espera máxima, repasse mínimo, horário da bandeira 2, domingos e feriados, chave PIX da plataforma.
- **Equipe** (só administrador): usuários **administrador** e **operador** e o registro de auditoria.

## Como o dinheiro funciona

**Valor da corrida** = bandeirada + km × distância percorrida + minuto × tempo de viagem, nunca abaixo da tarifa mínima.
A distância percorrida é a soma das posições de GPS enviadas pelo motorista durante a viagem (saltos de sinal acima de 150 km/h
são descartados); sem GPS, vale a distância estimada. A bandeira 2 vale à noite (padrão 20h às 6h), aos domingos e nos feriados nacionais,
e é definida no momento do pedido.

A **taxa da plataforma** (padrão 15%) é calculada sobre o valor final. Cada motorista tem uma **conta corrente** com a plataforma:

| Pagamento | Quem recebe o dinheiro | Lançamento na conta do motorista |
|---|---|---|
| **PIX** (chave da plataforma) | a plataforma | **crédito** da parte do motorista |
| **Cartão** (maquininha do motorista) | o motorista | **débito** da taxa da plataforma |
| **Dinheiro** | o motorista | **débito** da taxa da plataforma |

Saldo positivo é o que a plataforma deve repassar; negativo é taxa que o motorista deve e é descontada das próximas corridas por PIX.
**Gerar repasses** cria um repasse para cada motorista com saldo acima do mínimo e chave PIX cadastrada; o valor sai do saldo na hora
e volta se o repasse for cancelado. A central faz o PIX pelo banco e registra o identificador da transferência.

### Integração com o Ativa BPO Financeiro
Em **Relatórios → Exportar para o BPO**, sai o CSV no formato do importador do BPO (*Integrações → Importar lançamentos por CSV*):
as taxas da plataforma das corridas pagas entram como **contas a receber** e os repasses pagos como **contas a pagar**, com o motorista
como contato (pelo CPF). As categorias padrão são as do plano de contas inicial do BPO (*Prestação de serviços* e *Serviços terceirizados*);
outras podem ser escolhidas com `?categoria_receita=` e `?categoria_despesa=`.

### O que depende de terceiros (não incluído)
- **Confirmação automática do PIX** e **cartão de crédito no app**: exigem contrato com um banco ou intermediador de pagamentos (PSP),
  que avisa o pagamento por webhook. Hoje o QR Code PIX é gerado pelo sistema e a confirmação é feita pelo motorista ou pela central.
- **Transferência automática dos repasses**: exige a API PIX do banco da empresa. Hoje a central transfere e registra o identificador.
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

Dados de demonstração (um passageiro e três motoristas online no centro de São Paulo, senha `demo12345`):

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

## Segurança
- Senhas com scrypt; sessão por token assinado (HMAC) de 12 horas; o perfil é sempre lido do banco a cada requisição.
- Cada perfil só alcança as próprias rotas; passageiro e motorista só veem as próprias corridas; o passageiro vê os táxis próximos com posição arredondada.
- Limite de tentativas de login e cadastro por IP; cabeçalhos de segurança (CSP sem scripts externos, sem iframes).
- Ações da central (aprovações, cancelamentos, pagamentos, repasses, tarifas, regras, equipe) ficam na auditoria.

## Testes

```bash
npm test
```

Cobrem o fluxo inteiro pela API: cadastros e validações, aprovação, estimativa, oferta e aceite (inclusive disputa entre dois motoristas),
trajeto por GPS com descarte de saltos, valor final e divisão, PIX copia e cola (com CRC), pagamentos em PIX e dinheiro, avaliações,
cancelamentos, redistribuição, expiração, repasses, relatório, a exportação lida pelo importador do Ativa BPO e as permissões.

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
