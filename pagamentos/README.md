# PAY AX Pagamentos

Sistema de meios de pagamento da PAY AX: **emissão de boletos e Bolepix pelo Bradesco**, **split de pagamento**,
**conta gráfica por cliente** e **repasse automático por PIX**, com integração ao **IXC Provedor**.

Dois acessos, com servidores de sessão separados:

| Área | Endereço | Para quem |
|---|---|---|
| **Backoffice** | `/` (ou `/pagamentos`) | Nossa equipe: todos os clientes, todo o movimento, a receita e a margem. |
| **Internet Bank** | `/cliente` (ou `/payax-cliente`) | O cliente final: os boletos dele, o saldo, o extrato e os repasses. |

> O token de uma área **não vale** na outra (audiências diferentes), e o cliente nunca enxerga o nosso custo com o
> banco nem a nossa margem.

## Como o dinheiro se move

O modelo é de **conta gráfica**: todos os boletos são registrados no **nosso convênio Bradesco**. O dinheiro cai na
nossa conta e o sistema mantém uma conta corrente interna por cliente.

```
Boleto de R$ 268,12 pago
        │
        ├─ (−) tarifa bancária ............ R$ 2,50   → repassada ao cliente
        ├─ (−) tarifa PAY AX 2,35% ......... R$ 6,30   → nossa receita
        └─ (=) líquido do cliente ......... R$ 259,32 → entra "a liberar" e vira saldo em D+N dias úteis
```

- A soma das três partes é **sempre exatamente** o valor pago: tudo em centavos inteiros, sem ponto flutuante.
- Se o título for menor que a tarifa, o líquido vai a zero — **o cliente nunca fica devendo** por uma liquidação.
- O preço fica **congelado no boleto** no momento da emissão: mudar a tabela não altera títulos já emitidos.
- O **saldo nunca é um campo guardado**: é sempre a soma dos lançamentos. Nada é apagado; correções entram como
  estorno ou ajuste, com motivo e auditoria.

Em D+N (dias úteis, pulando feriados nacionais bancários) o líquido vira **saldo disponível**. Uma rotina diária
transforma esse saldo em **PIX para a conta do cliente**; acima do limite configurado, o repasse para e espera a
conferência da nossa equipe.

## Módulos

| # | Módulo | O que tem |
|---|---|---|
| 1 | **Clientes** | Número de conta PAY AX sequencial (agência 001 · conta 0001-3) com dígito verificador. Cadastro com CNPJ validado, endereço do beneficiário, situação, chave PIX de repasse, janela de retenção (D+N), repasse automático, valor mínimo, limite sem aprovação e teto por boleto. Ficha com resumo, boletos, conta gráfica, repasses, preços e acessos. |
| 2 | **Preços** | Tabela padrão da plataforma e tabela por cliente, **com vigência**: tarifa de emissão, tarifa de liquidação (repassada), tarifa PAY AX percentual com piso e teto, e tarifa do repasse. O histórico fica guardado. |
| 3 | **Boletos** | Emissão avulsa, por importação do IXC ou por API. **Boleto** e **Bolepix** (mesmo título com QR Code PIX). Nosso número reservado de forma atômica, código de barras e linha digitável no padrão FEBRABAN com o campo livre do Bradesco. Juros ao mês (pro rata die), multa, desconto por antecipação e prazo de baixa. Baixa, estorno e consulta ao banco. |
| 4 | **Ficha de compensação** | Recibo do pagador + ficha, em HTML pronto para imprimir ou salvar em PDF pelo navegador, com código de barras Interleaved 2 of 5 nas medidas do padrão (103 × 13 mm) e QR Code do Bolepix. **Link público assinado** para enviar ao pagador, sem login. |
| 5 | **Split e conta gráfica** | Razão de lançamentos por cliente com saldo acumulado, disponível × a liberar, agenda de liberação dos próximos dias, extrato em tela e em CSV, e ajuste manual com motivo. |
| 6 | **Repasses** | Saque pelo Internet Bank ou pela nossa equipe, rotina automática diária, limite de aprovação por cliente, envio por PIX com end-to-end guardado, cancelamento e estorno automático em caso de falha. |
| 7 | **Conciliação** | Cada aviso do banco é **guardado antes de ser processado** (corpo inteiro), com o resultado de cada um: liquidado, repetido, ignorado ou erro. Liquidação idempotente: o mesmo aviso duas vezes não credita em dobro. Baixa manual e consulta ao banco para o que não chegou. |
| 8 | **CNAB 400 automático** | Remessa gerada sozinha com os títulos emitidos e escrita na pasta de saída; pasta de entrada varrida de tempos em tempos e cada retorno aplicado na hora — entrada confirmada, liquidação com split, baixa ou rejeição com o motivo traduzido. Pedido de baixa vai como ocorrência 02 na remessa seguinte. Ninguém gera nem importa arquivo na mão. |
| 9 | **Integrações** | **Bradesco** (Cobrança Registrada, Boleto Híbrido e PIX de repasse) com credenciais cifradas em AES-256-GCM, e **um IXC por cliente**, nos dois sentidos: importa os títulos em aberto, emite o boleto, grava a linha digitável de volta no título e dá baixa quando o boleto é pago. |
| 10 | **Relatórios** | Faturamento por período e por cliente: emitido, recebido, tarifa PAY AX, tarifas bancárias, receita, **margem** (receita − custo do banco) e repassado, com CSV e impressão. Taxa de conversão emitido → pago. |
| 11 | **Segurança e histórico** | Perfis por função, **autenticação em duas etapas** por aplicativo (opcionalmente obrigatória para a equipe), senha provisória trocada no primeiro acesso, idempotência nos comandos POST, controle de versão otimista nos cadastros e auditoria com valor antes e depois. |
| 12 | **Backup conferido** | Cópia do banco a cada N horas e sob demanda, com **conferência automática**: integridade do arquivo e se o total do razão bate com o banco em uso. Histórico, download registrado na auditoria e alerta no painel quando atrasa ou não confere. |

### Perfis

| Perfil | Acesso |
|---|---|
| **Administrador** (equipe) | Tudo, inclusive usuários, contas bancárias e credenciais do banco. |
| **Financeiro** (equipe) | Opera o dinheiro: aprova e envia repasses, ajusta a conta gráfica, concilia e vê a margem. |
| **Operação** (equipe) | Clientes, boletos, baixas, IXC e acessos dos clientes. Não movimenta dinheiro. |
| **Consulta** (equipe) | Só leitura, sem margem. |
| **Administrador** (cliente) | O próprio painel: emite, saca, gerencia os usuários da empresa e o IXC. |
| **Operador** (cliente) | Emite boletos e consulta; não solicita repasse. |
| **Consulta** (cliente) | Só leitura. |

A chave PIX de destino do repasse **só a equipe PAY AX altera** — o cliente consulta, mas não muda sozinho.

## Como executar

Requisitos: **Node.js 22.13+**.

```bash
npm install
npm run demo     # opcional: equipe, três clientes e ~90 boletos com liquidações e repasses
npm start        # http://localhost:3600
```

Acesso inicial do Backoffice: `admin@payax.local` / `admin12345` (trocado no primeiro acesso).
Com a demonstração, o Internet Bank fica em `http://localhost:3600/cliente/` com
`financeiro@alfanet.com.br` / `cliente2026`.

```bash
npm test          # 130 testes
npm run migrar    # aplica as migrações sem subir o servidor
```

## A conta do cliente na PAY AX

Cada cliente recebe, no cadastro, um número de conta **sequencial**: agência `001` com contas `0001`, `0002`,
`0003`… Ao chegar em `9999`, a agência `002` abre sozinha e a numeração continua. O número é atribuído uma vez e
**nunca muda**, nem quando o cadastro é alterado.

```
Agência 001 · Conta 0001-3
                       └── dígito verificador (módulo 11 sobre agência + conta)
```

O dígito existe para pegar erro de digitação quando alguém informa a conta — inclusive a troca de dois dígitos de
lugar, o engano mais comum ao ditar um número. O cliente vê a conta no alto do Internet Bank e em Cadastro; a
equipe vê na lista, na ficha, e **busca por ela** (`0002` ou `001/0003` encontram o cliente).

> **Não confundir com a agência e a conta do Bradesco.** Aquelas são do convênio, vão dentro do código de barras
> (posições 20-23 e 37-43) e é por elas que o banco identifica para onde o dinheiro vai. Esta é nossa, identifica a
> conta gráfica do cliente e **não entra no boleto**. Um teste garante que a conta interna nunca aparece no código
> de barras.

Clientes cadastrados antes desta numeração recebem o número no primeiro start, na ordem de cadastro — não é preciso
fazer nada.

## O banco por arquivo (CNAB 400)

Quando o convênio é por arquivo em vez de API, o ciclo roda sozinho:

```
emitiu o boleto  →  entra na próxima REMESSA  →  pasta de saída  →  o banco registra
                                                                          ↓
conta gráfica ← split ← liquidação ← RETORNO aplicado ← pasta de entrada ←┘
```

- A remessa sai sozinha em dia útil com os títulos que estão esperando (ou na hora, pelo botão).
- A pasta de entrada é varrida a cada ciclo. Cada retorno novo é lido e aplicado: **entrada confirmada**
  (o título sai de "registrando"), **liquidação** (com o split na conta gráfica e a baixa no IXC do cliente),
  **baixa** ou **rejeição**, com o motivo do banco traduzido (`16 Data de vencimento inválida`, e assim por diante).
- Arquivo processado sai da pasta de entrada. O **mesmo arquivo duas vezes não credita em dobro**: ele é
  reconhecido pelo conteúdo (SHA-256), e a liquidação em si já é idempotente.
- Pedido de baixa vira ocorrência 02 na remessa seguinte — ninguém precisa lembrar de mandar nada.
- Retorno que não bate com nenhum título é contado e registrado, sem quebrar o resto do arquivo.

Quem leva e traz os arquivos é o agente de transferência do banco, apontado para as pastas de
`PAYAX_CNAB_REMESSA` e `PAYAX_CNAB_RETORNO`. Se um dia for por SFTP, só o transporte muda.

Para emergência (rede fora, arquivo que chegou por e-mail, reprocesso) a tela de Conciliação aceita o envio
manual de um retorno e o download de qualquer remessa.

> **No modo arquivo o PIX do repasse continua pela API.** O CNAB cobre a cobrança, não o pagamento: sem as
> credenciais da API do Bradesco, o repasse falha com essa mensagem em vez de fingir que saiu.

> **Confira o layout antes de produção.** As posições de cada campo estão declaradas em
> [`server/lib/cnab400.js`](server/lib/cnab400.js), em um lugar só. O layout do Bradesco é estável, mas cada
> convênio tem particularidades: gere uma remessa de teste, mande homologar e ajuste ali — nenhuma outra parte
> do sistema precisa mudar. O sistema recusa qualquer registro que não tenha exatamente 400 posições, porque um
> byte fora faz o banco rejeitar o arquivo inteiro.

## Vocabulário

O que cobramos do cliente a cada título pago chama-se **tarifa PAY AX** em toda a interface, nos relatórios e no
extrato. No banco de dados e nos campos da API o nome antigo continua: `comissao`, `comissao_centavos`,
`comissao_minima_centavos`. É só a chave interna — renomear a coluna exigiria reconstruir a tabela que guarda o
razão do dinheiro dos clientes, sem mudar nada do que se vê na tela.

As quatro cobranças do produto, para não confundir:

| Nome na tela | O que é | Quando |
|---|---|---|
| **Tarifa PAY AX** | o nosso percentual sobre o valor pago, com piso e teto | em cada título liquidado |
| **Tarifa bancária** | o que o banco cobra, repassado ao cliente | em cada título liquidado |
| **Tarifa de emissão** | cobrada por boleto registrado, pago ou não | no registro |
| **Tarifa do repasse** | custo do PIX que leva o dinheiro ao cliente | em cada transferência |

## O beneficiário do boleto

A razão social, o CNPJ e o endereço impressos no campo **Beneficiário** vêm do cadastro da conta bancária, em
**Contas e preços → conta**. O cliente que originou a cobrança abre o boleto em destaque ("Cobrança de Connect Link") e vai no
campo **Sacador/Avalista** das duas vias — e também é registrado assim no banco, na remessa CNAB e na API.

Os rótulos seguem os termos do layout do Bradesco: **Beneficiário** (a PAY AX, dona do convênio),
**Pagador** e **Sacador/Avalista**. "Beneficiário final" é um nome popular para o sacador/avalista, mas
não é o termo do banco. Quem decide o rótulo é o modelo de ficha que o Bradesco aprovar na homologação;
para trocar, basta mudar a constante `ROTULO_SACADOR` em `server/lib/impressao.js`.

A demonstração já vem com **PAY AX Brasil Ltda**, mas com um **CNPJ fictício** (12.345.678/0001-95) e uma agência e
conta de exemplo: troque pelos dados reais do convênio antes de emitir qualquer boleto de verdade. O mesmo nome é o
que aparece no QR Code do Bolepix, abreviado para os 25 caracteres que o padrão EMV permite.

## O banco (Bradesco)

O conector fica inteiro em [`server/lib/bradesco.js`](server/lib/bradesco.js), com dois modos:

| Modo | O que faz |
|---|---|
| `simulador` (padrão fora de produção) | Registra o título **localmente**: calcula o código de barras pelo padrão FEBRABAN e o BR Code pelo padrão EMV do Banco Central. Nada sai do servidor. É o modo para desenvolver e homologar internamente. |
| `bradesco` | Fala com a API do banco: OAuth2 com JWT assinado pelo certificado + mTLS. |
| `cnab` | Registra por **arquivo de remessa** e concilia pelo **retorno** (CNAB 400), tudo automático. Veja a seção do CNAB. |

Ao receber as credenciais, cadastre-as em **Integrações → Bradesco** (certificado e chave privada são cifrados antes
de serem gravados e nunca voltam para a tela) e suba o servidor com `PAYAX_BANCO_MODO=bradesco`.

> **Confira antes de ligar em produção:** os caminhos e os nomes de campo da API estão reunidos em `ENDPOINTS` e nas
> funções `paraApi` / `daApi` do mesmo arquivo, porque variam por contrato e por versão. O resto do sistema não
> precisa mudar.

O **aviso de liquidação** chega em `POST /api/publico/webhook/<token>`; o endereço completo aparece na tela de
Integrações quando as credenciais são salvas. O corpo inteiro é guardado em `eventos_banco` antes de qualquer
processamento, então nada se perde se algo falhar — e reprocessar não duplica crédito.

## O IXC (um por cliente)

Cada cliente cadastra o endereço e o token (`id:hash`, de um usuário técnico só da PAY AX) em **Integrações → IXC**.
O conector fica em [`server/lib/ixc.js`](server/lib/ixc.js) e os nomes de recurso e campo estão reunidos em
`RECURSOS` e `CAMPOS`, para ajustar à versão de cada provedor em um lugar só.

- **Importar**: lê `fn_areceber` em aberto no período, busca o pagador em `cliente` e emite um boleto para cada
  título. Títulos já importados são ignorados, então pode rodar quantas vezes quiser.
- **Anotar**: grava a linha digitável e o nosso número de volta no título de origem.
- **Baixar**: quando o boleto é liquidado, marca o título como recebido no IXC, com data e valor.

Endereços de rede interna são recusados por padrão (proteção contra SSRF); libere com `PAYAX_IXC_REDE_INTERNA=1`
apenas se o IXC estiver no mesmo servidor.

## Consulta de CEP e CNPJ

Os formulários se preenchem sozinhos: digitou o CEP, vem o endereço; digitou o CNPJ, vem razão social, nome
fantasia e endereço completo. Vale no cadastro de clientes (Backoffice) e nos dados do pagador, nas duas áreas.

Duas fontes, escolhidas **por tipo de consulta**, porque o custo é bem diferente:

| Consulta | Quando acontece | Padrão | Por quê |
|---|---|---|---|
| **CEP** | em **toda** emissão de boleto | `publica` (ViaCEP) | volume alto; a fonte pública responde em ~0,4 s e não consome crédito |
| **CNPJ** | só ao cadastrar um cliente ou um pagador PJ | `apibrasil` | volume baixo e o dado da API Brasil é mais completo |

Trocar é um parâmetro: `PAYAX_CEP_FONTE` e `PAYAX_CNPJ_FONTE` aceitam `publica` ou `apibrasil`.

O token da API Brasil é cadastrado em **Integrações → API Brasil** (cifrado antes de gravar, nunca volta para a
tela). Sem token, a escolha `apibrasil` **cai automaticamente para a fonte pública** — e, se a API Brasil falhar no
meio (saldo, token, instabilidade), a consulta também cai para a pública e avisa na tela. Nada trava o cadastro:
a consulta é conveniência, e quem digita sempre pode preencher à mão.

Toda resposta fica em `consultas_cache` (CEP por 180 dias, CNPJ por 30, configuráveis): o mesmo CEP ou CNPJ não é
perguntado duas vezes, o que economiza crédito e responde na hora. O que a pessoa digitou à mão nunca é
sobrescrito por uma consulta; o que veio de uma consulta anterior, sim.

> Só os campos do cadastro são guardados. O **quadro societário** que a fonte devolve é descartado — não é dado
> que o sistema precisa. As consultas saem com um nome genérico de cliente, sem identificar a operação.

## Backup e duas etapas

A tabela `lancamentos` é o livro-razão do dinheiro dos clientes: se o arquivo se perder, não existe como
reconstruir quanto cada um tem a receber. Por isso o backup aqui não é higiene de TI, é parte da operação.

- Uma cópia (`VACUUM INTO`, consistente mesmo com o sistema em uso) a cada **12 horas** e sempre que a equipe pedir.
- **Cada cópia é conferida logo depois de gerada**: integridade do arquivo e se o total do razão na cópia bate com
  o do banco em uso. O resultado fica no histórico — backup que ninguém conferiu não é backup.
- Guarda as 30 mais recentes. O painel avisa quando o último atrasou ou não conferiu.
- O download fica registrado na auditoria: é uma cópia do razão saindo do servidor.

> O backup cobre o banco. Se um dia o sistema passar a guardar arquivos enviados, a pasta deles entra no backup do
> servidor à parte.

**Autenticação em duas etapas** (TOTP, por aplicativo) vale para a equipe e para o Internet Bank. O administrador
pode **exigir** de toda a equipe — quem ainda não tem configura antes de trabalhar, e ninguém desliga o próprio
enquanto a exigência estiver ligada. Quem troca de celular pede ao administrador para redefinir; fica na auditoria.
Para ligar a exigência, o próprio administrador precisa ter 2FA ativo: não dá para trancar a porta com a chave dentro.

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3600` | Porta HTTP. |
| `PAYAX_BASE_PATH` | (raiz) | Endereço do Backoffice, ex.: `/pagamentos`. |
| `PAYAX_CLIENTE_PATH` | `<BASE_PATH>/cliente` | Endereço do Internet Bank, ex.: `/payax-cliente`. |
| `PAYAX_DB` | `data/payax.db` | Arquivo do banco SQLite. |
| `PAYAX_SECRET` | aleatório | Segredo das sessões (mín. 32 caracteres). **Obrigatório em produção.** |
| `PAYAX_CHAVE_CREDENCIAIS` | derivada do segredo | Chave AES-256 (64 hex) que cifra as credenciais do banco e dos IXC. **Obrigatória em produção.** |
| `PAYAX_ADMIN_EMAIL` / `PAYAX_ADMIN_SENHA` / `PAYAX_ADMIN_NOME` | — | Administrador criado no primeiro start. Senha obrigatória em produção (mín. 12). |
| `PAYAX_BANCO_MODO` | `simulador` (`bradesco` em produção) | Modo do conector do banco. |
| `PAYAX_BANCO_AMBIENTE` | `homologacao` | `homologacao` ou `producao`. |
| `PAYAX_ROTINAS` | ligado | Rotinas automáticas (repasses, baixas no IXC, importação). `0` desliga. |
| `PAYAX_BACKUP` | ligado | Backup automático do banco. `0` desliga (só manual). |
| `PAYAX_BACKUP_HORAS` | `12` | Intervalo entre backups automáticos. |
| `PAYAX_BACKUP_MANTER` | `30` | Quantas cópias manter na pasta. |
| `PAYAX_BACKUPS` | `data/backups` | Pasta das cópias. **Leve para fora do servidor** (o backup local não protege contra perda da máquina). |
| `PAYAX_CNAB_REMESSA` | `data/cnab/remessa` | Pasta onde a remessa é escrita (o agente do banco busca aqui). |
| `PAYAX_CNAB_RETORNO` | `data/cnab/retorno` | Pasta onde o banco deposita o retorno (varrida a cada ciclo). |
| `PAYAX_CNAB_PROCESSADOS` | `data/cnab/processados` | Para onde o retorno vai depois de aplicado. |
| `PAYAX_CNAB_REMESSA_AUTO` | ligado | Gera a remessa sozinho em dia útil. `0` deixa só o botão. |
| `PAYAX_CNAB_TITULOS` | `500` | Máximo de títulos por arquivo de remessa. |
| `PAYAX_ROTINA_MIN` | `15` | Intervalo das rotinas, em minutos. |
| `PAYAX_FUSO` | `America/Sao_Paulo` | Fuso usado nas datas de negócio. |
| `PAYAX_SESSAO_HORAS` | `8` | Validade da sessão. |
| `PAYAX_URL_PUBLICA` | — | Endereço público, usado no link do boleto enviado ao pagador. |
| `PAYAX_TRUST_PROXY` | `loopback` | Proxies confiáveis para obter o IP real. |
| `PAYAX_LIMITE_LOGIN` | `10` | Tentativas de login por IP por minuto. |
| `PAYAX_IXC_REDE_INTERNA` | desligado | Permite que o IXC aponte para a rede interna. |
| `PAYAX_CEP_FONTE` | `publica` | Fonte da consulta de CEP: `publica` (ViaCEP) ou `apibrasil`. |
| `PAYAX_CNPJ_FONTE` | `apibrasil` | Fonte da consulta de CNPJ: `apibrasil` ou `publica` (BrasilAPI). |
| `PAYAX_CACHE_CEP_DIAS` / `PAYAX_CACHE_CNPJ_DIAS` | `180` / `30` | Validade do cache das consultas. |
| `PAYAX_DADOS_TIMEOUT_MS` | `8000` | Tempo máximo de espera das consultas de CEP e CNPJ. |

## O que depende de terceiros (não incluído)

- **Saída de rede para as consultas**: `viacep.com.br`, `brasilapi.com.br` e `gateway.apibrasil.io` precisam estar
  liberados no servidor. Sem eles o sistema funciona igual, só sem o preenchimento automático.
- **Credenciamento no Bradesco**: convênio de cobrança registrada, faixa de nosso número, certificado da API e
  contrato de PIX para pagamento (o repasse). Sem isso, o sistema roda no modo simulador.
- **Envio do boleto por e-mail ou WhatsApp ao pagador**: hoje o sistema gera o link e a ficha; o disparo em massa
  exige um provedor de mensagens.
- **Débito automático, cartão e PIX cobrança com vencimento**: fora do escopo desta etapa, que é só boleto e Bolepix.

## A marca

O logotipo não é imagem: está desenhado em vetor em `comum/marca.js`, por isso fica nítido em qualquer
tamanho, acompanha a cor do tema e não depende de nenhum arquivo externo.

| Peça | Onde aparece |
|---|---|
| `letreiro()` | PAY em branco (ou marinho) e AX no degradê ciano→azul; com `tagline`, a frase "O FUTURO EM CADA TRANSAÇÃO." |
| `simbolo()` | o anel, quando não cabe o letreiro: menu, canto do cartão da conta, favicon |
| `marcaMenu()` / `marcaEntrada()` | as duas combinações prontas — menu lateral e tela de entrada |
| `faviconSvg()` | o desenho dos dois `img/favicon.svg` (a versão com fundo leva também as faixas diagonais) |

As cores e a régua (canto, sombra, espaçamento) vivem num lugar só: os tokens de `comum/base.css`
— `--marca` marinho `#0a1526`, `--azul` das ações, `--ciano` do anel, `--raio`, `--sombra`.
Mudar a marca é mudar esse arquivo; nenhuma tela tem cor escrita na mão.

## As duas áreas falam a mesma língua

Backoffice e Internet Bank usam as mesmas peças, de `comum/componentes.js`:

| Peça | No Internet Bank | No Backoffice |
|---|---|---|
| cartão de destaque | `cartaoConta()` — o saldo do cliente, com o botão de esconder | `cartaoPainel()` — a posição da plataforma no período |
| `acoesRapidas()` | emitir, transferir, extrato, relatórios | emitir, repasses, conciliação, relatórios |
| `linhaTempo()` + `agruparMovimentos()` | o extrato, com o split aberto em cada recebimento | — |

A diferença entre as duas áreas é de conteúdo, não de linguagem: o cliente vê a conta dele, a equipe vê
a plataforma inteira. Sobra em `cliente/css/banco.css` só a barra de navegação do celular, e em
`public/css/payax.css` só a lista de alertas do painel.

Em texto, o nome da empresa é **PAY AX**, com espaço. `payax` minúsculo continua sendo só identificador
interno (chaves de `localStorage`, variáveis `PAYAX_*`, nome de arquivo, prefixo de txid do PIX).

## Estrutura

```
pagamentos/
  comum/        base.css, ui.js, api.js, graficos.js, marca.js e componentes.js
                — tudo compartilhado pelas duas áreas
  public/       Backoffice (telas em js/telas/)
  cliente/      Internet Bank (telas em js/telas/)
  server/
    lib/        febraban, pix, codigobarras, impressao, precos (split), razao (conta gráfica),
                boletos, repasses, bradesco, ixc, sincronismo, rotinas
    routes/     backoffice, cliente (Internet Bank) e publico (webhook + link do boleto)
  test/         130 testes, com IXC falso
```
