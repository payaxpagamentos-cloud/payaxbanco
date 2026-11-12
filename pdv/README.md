# Payax PDV

Ponto de venda do balcão para **receber as faturas do IXC Provedor**, com as **maquininhas de cartão** integradas e
um acompanhamento de tudo o que entrou — para **conferir, no fim do dia, o que o PDV recebeu com o que o IXC
registrou**.

O IXC continua sendo o dono das faturas: o PDV consulta o cliente e os títulos em aberto, recebe no balcão
(dinheiro, PIX, cartão, transferência) e devolve a **baixa de cada título** ao IXC. O que não conseguir baixar na
hora fica numa fila e aparece na conferência até alguém resolver — o balcão nunca para por causa do IXC.

## Módulos

| # | Módulo | O que tem |
|---|---|---|
| 1 | **Balcão (PDV)** | Busca do cliente no IXC por CPF/CNPJ, nome, telefone ou código; faturas em aberto já com **multa e juros** calculados pelas regras da empresa; várias faturas no mesmo atendimento; **desconto** dentro do limite; **recebimento sem fatura** (avulso); **várias formas de pagamento** no mesmo recebimento; troco; comprovante na bobina (58 mm ou 80 mm). Atalhos: F2 dinheiro, F3 PIX, F4 débito, F5 crédito, F8 finalizar. |
| 2 | **Tela do cliente (autoatendimento)** | A tela virada para quem vai pagar, em `/pdv/cliente/`: o cliente **digita o CPF/CNPJ** num teclado grande, vê as próprias faturas (já com multa e juros), escolhe quais pagar, passa o cartão na maquininha do PDV e leva o comprovante. Com o **logo do provedor** no topo. Não recebe dinheiro, não dá desconto e não cancela nada: isso é do balcão. |
| 3 | **Maquininhas de cartão** | Cobrança enviada ao aparelho e acompanhada na tela até aprovar, negar ou expirar. Três modos por maquininha: **aplicativo na maquininha** (busca a cobrança no PDV), **adquirente/webhook** (o PDV chama o endereço do intermediador) e **digitado pelo operador** (NSU lido no comprovante). Guarda NSU, autorização, bandeira, final do cartão e parcelas em cada pagamento. |
| 4 | **Caixa** | Abertura com fundo de troco (um caixa aberto por PDV), **sangria** e **suprimento**, fechamento com **contagem por forma de pagamento** e a diferença apontada, reabertura com motivo e conferência pela supervisão. Diferença de caixa vira divergência na conferência. |
| 5 | **Baixa no IXC** | Baixa automática ao confirmar o recebimento, com **fila e novas tentativas** quando o IXC não responde; "tentar agora" no painel; **marcar baixa manual** (quando alguém baixou direto no IXC); **estorno** das faturas quando o recebimento é cancelado. Tipo de recebimento e conta do IXC configuráveis por forma de pagamento. |
| 6 | **Conferência IXC** | Confronto **fatura a fatura** com o IXC: situação e valor que o IXC devolveu. Totais do período: recebido no PDV, baixado no IXC, **falta confirmar**, cancelados, multa e juros, descontos; quebra por **forma de pagamento, operador, maquininha e dia**. |
| 7 | **Divergências** | Fatura **não baixada**, **valor diferente**, **fatura que sumiu** do IXC, **cancelado com baixa** e **diferença de caixa**. Cada uma é resolvida ou ignorada com explicação, quem resolveu e quando. |
| 8 | **Recebimentos** | Tudo o que passou pelo PDV, com filtros por período, cliente, situação e baixa. No detalhe: títulos, pagamentos, erros do IXC, reimpressão do comprovante, cancelamento com motivo (supervisão) e conferência individual. |
| 9 | **Cadastros e segurança** | Lojas, estações de caixa (PDVs), maquininhas (com chave própria, mostrada uma única vez) e usuários por perfil. Token do IXC e tokens das maquininhas **cifrados** no banco. Auditoria de tudo: quem recebeu, cancelou, conferiu, mexeu na configuração e de qual IP. |
| 10 | **Plataforma (master)** | Várias empresas atendidas no mesmo servidor: visão geral do que cada uma recebeu hoje, baixas pendentes, divergências, caixas abertos e maquininhas; usuários; auditoria geral; fila de baixas. |
| 11 | **Exportações** | CSV dos recebimentos, dos caixas e da conferência (uma linha por fatura, com o valor do PDV, o valor do IXC e a diferença) — pronto para abrir na planilha do financeiro. |

### Tela do cliente, passo a passo

1. **Ligue a tela** no PDV onde ela vai ficar: *Lojas, PDVs e usuários › Tela do cliente › Ligar e gerar a chave*.
   A chave (`pdv_<prefixo>_<segredo>`) aparece **uma única vez**.
2. No aparelho da tela (um monitor com toque, um tablet ou um segundo monitor do caixa), abra
   `https://SEU-DOMINIO/pdv/cliente/` e cole a chave. O botão *Copiar endereço + chave* do painel gera um
   link que já ativa a tela sozinho (`…/cliente/#pdv_...`).
3. Em *Configurações › Tela do cliente* você **envia a arte do provedor** (PNG, JPEG ou WebP, até 5 MB): a
   **imagem de fundo** — a propaganda que ocupa a tela inteira atrás do painel — e o **logo**. Quando a arte já
   traz a marca, marque *"A arte de fundo já tem a marca"* e a tela não repete o logo. Sem imagem, vale o fundo
   azul do sistema com a chamada ("Sua casa mais conectada.") e a frase, também configuráveis aqui.
   Tamanho sugerido da arte: **1080×1920** no totem em pé e **1920×1080** no monitor deitado.
4. O painel por cima da propaganda é de **vidro fosco** (`backdrop-filter`): a arte aparece desfocada por trás,
   com os passos **CPF → Fatura → Pagamento**, o teclado grande e a ação em laranja. Em navegador sem suporte ao
   desfoque, o painel fica sólido para não perder leitura.
4. A tela cobra na **maquininha ligada àquele PDV** (ou à loja). Sem maquininha, ela só consulta as faturas.

No totem (monitor vertical com toque), a tela abre numa **tela de espera** com o logo e o convite "toque para
começar", entra em **tela cheia** no primeiro toque, **segura o monitor aceso** (Wake Lock) e se ajusta sozinha a
telas em pé — 1080×1920 e parecidas — com teclado, botões e valores maiores. Deitada (monitor do balcão virado
para o cliente) ela continua igual, só mais compacta. Depois de cada atendimento, e sempre que fica parada, volta
à tela de espera: ninguém encontra a fatura de outra pessoa aberta.

Cuidados que já vêm prontos: a consulta exige o CPF/CNPJ **completo e válido** e é limitada a 20 por minuto por
aparelho; o nome do cliente aparece **parcialmente escondido** (`MARIA D****`); a tela volta sozinha ao início
depois de parada e ao fim de cada atendimento; fatura já recebida no PDV não aparece de novo; e o recebimento
entra com origem **"tela do cliente"**, em nome do usuário `Autoatendimento · <PDV>`, **fora do caixa do balcão**
(não tem gaveta), mas dentro da mesma conferência com o IXC.

### O que depende de terceiros (não incluído)

- **Passar o cartão** é da maquininha/adquirente: o PDV manda a cobrança e recebe o resultado. O aplicativo que
  roda no aparelho (ou o middleware TEF) usa a API de integração — veja `scripts/maquininha-exemplo.js`.
- **Estorno do cartão** é feito no aparelho ou no portal do adquirente. Ao cancelar o recebimento, o PDV marca a
  cobrança como estornada e reabre as faturas no IXC, mas não desfaz a transação na operadora.
- **PIX automático (cobrança com QR Code)** depende da conta/PSP do provedor. Hoje o PIX entra como forma de
  pagamento (com a identificação digitada) ou pela maquininha, que já aceita PIX.
- **Emissão de faturas, contratos e bloqueio de acesso** continuam no IXC.

### Perfis

| Perfil | Acesso |
|---|---|
| **Operador de caixa** | Balcão, o próprio caixa (abrir, sangria, suprimento, fechar) e os recebimentos. Não cancela recebimento nem mexe em cadastros. |
| **Tela do cliente** | Não é login: é a chave de um PDV. Só consulta faturas pelo CPF/CNPJ completo e cobra no cartão/PIX daquele PDV. |
| **Supervisor** | Tudo o que o operador vê, de todos os operadores, mais: cancelar recebimento, conferir com o IXC, resolver divergências, fechar e reabrir caixa, marcar baixa manual. Não altera cadastros. |
| **Administrador** | Tudo na empresa, incluindo IXC, maquininhas, lojas, PDVs e usuários. |
| **Master / Suporte** | A plataforma: empresas atendidas, usuários, auditoria e fila de baixas. O master também cria empresas e usuários. |

As regras ficam no servidor: cada rota `/api/empresas/:id/...` confere a empresa do usuário, o operador só mexe no
próprio caixa, e uma cobrança no cartão só vira recebimento se estiver **aprovada**, for do mesmo operador e ainda
não tiver sido usada em outro recebimento.

## Como executar

Requisitos: **Node.js 22.13+**.

```bash
npm install
npm run seed     # opcional: empresa de exemplo com 4 dias de movimento
npm start        # http://localhost:3600
```

Acesso inicial: `master@pdv.com.br` / `master123` (troque no primeiro acesso, pelo menu do usuário).
Com o seed (senha `pdv2026`): `gerente@`, `supervisor@`, `caixa@` e `balcao@provedorexemplo.com.br`.

```bash
npm test
```

## Instalação no servidor (/pdv)

```bash
npm run empacotar   # gera dist/pdv.zip
```

O pacote traz a pasta `pdv/` pronta para enviar ao servidor: código, dependências de produção já instaladas,
`.env` com segredo e senha inicial do master gerados na hora (a senha aparece no terminal), o exemplo do
aplicativo da maquininha e `LEIA-ME.txt` com o passo a passo (cPanel, PM2, Docker, Nginx e Apache).

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3600` | Porta HTTP. |
| `PDV_BASE_PATH` | (raiz) | Endereço em que o PDV é publicado, ex.: `/pdv`. |
| `PDV_DB` | `data/pdv.db` | Arquivo do banco SQLite. |
| `PDV_SECRET` | aleatório | Segredo das sessões e **da cifra do token do IXC e das maquininhas** (mín. 32 caracteres). **Obrigatório em produção** — trocar depois exige cadastrar os tokens de novo. |
| `PDV_ADMIN_EMAIL` / `PDV_ADMIN_SENHA` / `PDV_ADMIN_NOME` | — | Master criado no primeiro start. Senha obrigatória em produção (mín. 12). |
| `PDV_FUSO` | `America/Sao_Paulo` | Fuso do dia do caixa, dos relatórios e da conferência (o painel segue esta data, não a do computador do balcão). |
| `PDV_TRUST_PROXY` | `loopback` | Proxies confiáveis para obter o IP real. |
| `PDV_LIMITE_LOGIN` | `10` | Tentativas de login por IP por minuto. |
| `PDV_ARQUIVOS` | `data/arquivos` | Pasta das imagens enviadas pelo painel (logo e propaganda da tela do cliente). **Inclua no backup.** |
| `PDV_ARQUIVO_MAX_MB` | `5` | Tamanho máximo de cada imagem enviada. |
| `PDV_HTTP` | — | `1` permite IXC e maquininha em `http://` (só para servidores na rede interna; o padrão exige `https://`). |
| `PDV_IXC_TIMEOUT` | `8000` | Tempo máximo (ms) de espera do IXC e do adquirente. |
| `PDV_CARTAO_EXPIRA_MIN` | `5` | Minutos até uma cobrança sem resposta da maquininha ser dada como expirada. |

Na empresa (menu Configurações): endereço e token do IXC, conta e **tipo de recebimento do IXC por forma de
pagamento**, baixa automática, multa (%), juros ao mês (%), desconto máximo (%), exigir caixa aberto, permitir
recebimento avulso, os textos do comprovante e, para a **tela do cliente**, o logo (arquivo publicado como
`img/logo-cliente.png` ou endereço `https://`) e o recado que aparece para quem está pagando.

## IXC: o que o PDV usa

Token de um usuário criado só para o PDV (no IXC: **Configurações › Usuários › Token**), no formato `id:hash`.

| Operação | Recurso do IXC |
|---|---|
| Buscar cliente (CPF/CNPJ, nome, telefone, código) | `cliente` (listar) |
| Contratos e situação do acesso | `cliente_contrato` (listar) |
| Faturas em aberto, consulta de uma fatura, baixas do dia | `fn_areceber` (listar) |
| Baixa (liquidação) e estorno do título | `fn_areceber/{id}` (PUT) |

Os nomes de recurso e de campo variam entre versões do IXC e estão todos em `server/lib/ixc.js`, num lugar só,
para ajustar sem mexer no resto do sistema.

## Maquininhas: API de integração

Autenticação pela chave da maquininha: `X-Api-Key: pdv_<prefixo>_<segredo>` (só o hash fica guardado; a chave
aparece uma única vez, ao cadastrar ou ao gerar outra).

| Rota | Para quê |
|---|---|
| `GET /api/integracao/terminal` | Confere a chave e devolve o aparelho e a empresa. |
| `GET /api/integracao/terminal/cobranca` | Próxima cobrança deste aparelho (204 quando não há nada). Cada cobrança é entregue uma vez só. |
| `POST /api/integracao/terminal/resultado` | `{ "referencia", "status": "aprovada\|negada\|cancelada", "nsu", "autorizacao", "bandeira", "cartao_final", "mensagem" }`. Reenviar o mesmo resultado não dá erro. |
| `GET /api/integracao/terminal/cobranca/:id` | Situação de uma cobrança. |

## Tela do cliente: API

Mesma ideia, com a chave do PDV (`X-Api-Key: pdv_<prefixo>_<segredo>`), usada só pela página `/pdv/cliente/`:

| Rota | Para quê |
|---|---|
| `GET /api/autoatendimento` | Marca, loja, logo, recado e formas de pagamento daquela tela. |
| `POST /api/autoatendimento/faturas` | `{ "documento": "529.982.247-25" }` → faturas em aberto, com o nome parcialmente escondido. |
| `POST /api/autoatendimento/cobrancas` | `{ "forma", "valor_centavos", "parcelas" }` → manda a maquininha do PDV cobrar. |
| `GET /api/autoatendimento/cobrancas/:id` | Situação da cobrança (a tela pergunta de 2 em 2 segundos). |
| `POST /api/autoatendimento/recebimentos` | `{ "transacao_id", "cliente_ixc_id", "faturas": [...] }` → grava o recebimento, baixa no IXC e devolve o comprovante. |

`scripts/maquininha-exemplo.js` é um aplicativo de exemplo completo (buscar → passar o cartão → devolver o
resultado), pronto para trocar a função `passarCartao` pelo SDK da adquirente.

## Tecnologia e arquitetura

Node.js 22 + Express, SQLite nativo (`node:sqlite`), telas em HTML/CSS/JS puros sem build, testes com
`node:test`. Valores em **centavos** (inteiros); o recebimento inteiro (títulos, pagamentos e vínculo com a
cobrança do cartão) entra numa transação só.

```
pdv/
  server/
    db.js                 # esquema: empresas, lojas, PDVs, caixas, recebimentos, títulos, pagamentos, cartão, divergências
    lib/ixc.js            # cliente da API do IXC (clientes, contratos, faturas, baixa e estorno)
    lib/ixcEmpresa.js     # configuração por empresa, token cifrado, tipos de recebimento
    lib/maquininha.js     # cobrança no cartão: agente, webhook, manual, expiração
    lib/caixa.js          # abertura, sangria/suprimento, resumo e fechamento com contagem
    lib/recebimentos.js   # multa e juros, montagem do recebimento, formas de pagamento, cancelamento
    lib/baixas.js         # baixa no IXC, fila de novas tentativas, baixa manual e estorno
    lib/conferencia.js    # confronto com o IXC, totais do período e divergências
    lib/comprovante.js    # comprovante em texto para a bobina
    routes/               # auth, master, empresa (clientes, caixa, recebimentos, cartão, conferência, cadastros, configurações) e integração
    lib/autoatendimento.js # tela do cliente: chave do PDV, consulta por CPF/CNPJ e recebimento sem caixa
  public/                 # painel: js/telas/pdv.js (balcão), caixa, recebimentos, conferência, maquininhas, cadastros, configurações
  public/cliente/         # tela do cliente (autoatendimento), com teclado grande e o logo do provedor
  scripts/maquininha-exemplo.js
  test/                   # fluxo do balcão, cartão, IXC fora do ar e isolamento entre empresas
```

O servidor roda a **fila de baixas** e a **expiração das cobranças** a cada `fila_intervalo_s` segundos
(Configurações da plataforma), de modo que as baixas se acertam sozinhas quando o IXC volta.
