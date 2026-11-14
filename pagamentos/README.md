# PAY AX Pagamentos

Sistema de meios de pagamento da PAY AX: **emissão de boletos e Bolepix pelo Bradesco**, **split de pagamento**
e **repasse imediato por PIX** — a PAY AX não guarda dinheiro de cliente —, com integração ao **IXC Provedor**.

Dois acessos, com servidores de sessão separados:

| Área | Endereço | Para quem |
|---|---|---|
| **Backoffice** | `/` (ou `/pagamentos`) | Nossa equipe: todos os clientes, todo o movimento, a receita e a margem. |
| **Área do Cliente** | `/cliente` (ou `/payax-cliente`) | O cliente final: os boletos dele, o extrato e as transferências para a conta dele. |

> O token de uma área **não vale** na outra (audiências diferentes), e o cliente nunca enxerga o nosso custo com o
> banco nem a nossa margem.

## Como o dinheiro se move

Todos os boletos são registrados no **nosso convênio Bradesco**. **A PAY AX não guarda dinheiro de cliente:** quando o
banco credita um pagamento na nossa conta, as tarifas saem e o resto vai **na hora**, por PIX, para a conta do cliente.

```
Boleto de R$ 268,12 pago
        │
        ├─ (−) tarifa bancária ............ R$ 2,50   → repassada ao cliente
        ├─ (−) tarifa PAY AX 2,35% ......... R$ 6,30   → nossa receita
        └─ (=) líquido do cliente ......... R$ 259,32 → PIX para o cliente assim que o banco credita
```

- A soma das três partes é **sempre exatamente** o valor pago: tudo em centavos inteiros, sem ponto flutuante.
- Se o título for menor que a tarifa, o líquido vai a zero — **o cliente nunca fica devendo** por uma liquidação.
- O preço fica **congelado no boleto** no momento da emissão: mudar a tabela não altera títulos já emitidos.
- Cada movimento fica registrado por cliente (crédito, tarifas, repasse): é o **registro de controle**, não uma
  conta com saldo. A soma é sempre calculada, nunca guardada. Nada é apagado; correções entram como estorno ou
  ajuste, com motivo e auditoria.

**O exemplo da Connect** (tarifa PAY AX fixa de R$ 1,99 por boleto pago, sem percentual nem tarifa bancária
repassada):

```
Boleto de R$ 100,00 pago
        ├─ (−) tarifa PAY AX ............ R$  1,99 → fica com a PAY AX
        └─ (=) Connect .................. R$ 98,01 → conta da Connect
```

**Como o dinheiro chega ao cliente** — a conta de destino é cadastrada pela PAY AX e tem que ser da própria empresa
(mesmo CNPJ):

| Conta do cliente | Como chega | Passa pela PAY AX? |
|---|---|---|
| **Bradesco**, com rateio de crédito contratado no convênio | **Rateio de crédito**: o título vai ao banco dizendo a parte do cliente (CNAB 400, registro tipo 3); na liquidação o **próprio Bradesco** credita a conta do cliente | **Não** |
| Qualquer outro banco | **PIX pelos dados da conta** (agência e conta, sem precisar de chave), assim que o crédito cai | Por minutos, ou até o crédito do dia útil seguinte |

O rateio é o caminho preferido para uma empresa de tecnologia: o dinheiro do cliente não entra na conta da PAY AX.
Ele vai em **percentual sobre o valor cobrado** (o manual exige isso para esse cálculo), calculado para que, no valor
de face, a PAY AX fique exatamente com a tarifa — com juros ou desconto, os dois lados variam na mesma proporção, e o
sistema registra o valor que o banco informa no retorno. O rateio do Bradesco só credita **conta Bradesco**, e por
enquanto só pelo **arquivo CNAB**: pela API, os campos de rateio dependem da documentação que chega na homologação.

**Plano B — se o rateio não der certo, a PAY AX faz por PIX.** O banco diz, no registro 3 do retorno
(posições 159-160), o que aconteceu com o rateio de cada título, e o sistema age sozinho:

| O banco disse | O que o sistema faz |
|---|---|
| Rateio aceito no registro (motivo 00) e, no pagamento, feito (38 ou 39) | Nada: o Bradesco creditou o cliente |
| Recusou o rateio no registro (conta inválida, serviço não contratado, …) | O boleto vale; quando for pago, o valor do cliente vai por PIX |
| No pagamento, não fez o rateio (40 a 43: conta bloqueada, encerrada, …) | O valor inteiro caiu na PAY AX: vai por PIX na hora |
| **Não disse nada** (retorno sem o registro 3) | **Não presume.** Fica "a confirmar", com alerta no painel; a equipe confere no extrato e informa no boleto: "creditou" ou "não creditou — enviar por PIX". Mandar PIX de algo que o banco já pagou seria pagar duas vezes |

A regra **Rateio que não deu certo** da Conformidade mostra as falhas dos últimos 30 dias e fica fora da norma se
um "a confirmar" passar de um dia sem conferência.

**Como a PAY AX enxerga o rateio, se o dinheiro não passa por ela.** O banco conta tudo no arquivo de retorno:
para cada boleto, o registro 3 traz **quanto** creditou ao cliente (posições 66-80), **em que dia** (151-158) e a
**situação** (38 = aguardando crédito, 39 = já creditado). No fim do arquivo, o trailer declara o **total de rateios**
feitos (363-385). O sistema guarda os três e mostra em **Repasses → Creditado pelo banco**: o creditado hoje e no
mês, o que aguarda o crédito, cada boleto com pago / tarifa PAY AX / creditado ao cliente, e a conferência de cada
arquivo (soma lida contra o total declarado — se não bater, a Conformidade acusa). O cliente vê o mesmo crédito,
com a data, em Transferências. A única coisa que a PAY AX **não** vê é o extrato da conta do cliente, que é dele.

**Quando o repasse por PIX sai:**

| Como o pagador pagou | Quando o banco credita na nossa conta | Quando o cliente recebe |
|---|---|---|
| PIX (QR do Bolepix) | na hora | logo após a baixa, no mesmo minuto |
| Código de barras | no dia de crédito que o banco informa no retorno (normalmente o dia útil seguinte) | na primeira rodada desse dia |

- A **rodada de repasse** roda a cada ciclo da rotina (15 minutos), **todos os dias** — PIX não fecha no fim de semana.
- **Não existe saque, valor mínimo, retenção nem fila de aprovação.** Tudo isso deixaria dinheiro parado.
- **Cliente sem chave PIX não emite boleto:** o dinheiro não teria para onde ir.
- PIX recusado pelo banco é estornado, aparece no painel e **sai de novo na rodada seguinte**.
- Sem a data de crédito no aviso, vale o prazo de compensação do contrato: `PAYAX_DIAS_CREDITO_BOLETO` (padrão 1
  dia útil). Conferir esse prazo no contrato de cobrança.
- **Backoffice → Conformidade** vigia isso sozinho: crédito de ontem ainda na nossa conta aparece como fora da norma.

## Módulos

| # | Módulo | O que tem |
|---|---|---|
| 1 | **Clientes** | Número de conta PAY AX sequencial (agência 001 · conta 0001-3) com dígito verificador. Cadastro com CNPJ validado, endereço do beneficiário, situação, chave PIX de repasse (obrigatória para emitir) e teto por boleto. Ficha com resumo, boletos, registro de movimentos, repasses, preços e acessos. |
| 2 | **Preços** | Tabela padrão da plataforma e tabela por cliente, **com vigência**: tarifa de emissão, tarifa de liquidação (repassada), tarifa PAY AX percentual com piso e teto, e tarifa do repasse. O histórico fica guardado. |
| 3 | **Boletos** | Emissão avulsa, por importação do IXC ou por API. **Boleto** e **Bolepix** (mesmo título com QR Code PIX). Nosso número reservado de forma atômica, código de barras e linha digitável no padrão FEBRABAN com o campo livre do Bradesco. Juros ao mês (pro rata die), multa, desconto por antecipação e prazo de baixa. Baixa, estorno e consulta ao banco. |
| 4 | **Ficha de compensação** | Recibo do pagador + ficha, em HTML pronto para imprimir ou salvar em PDF pelo navegador, com código de barras Interleaved 2 of 5 nas medidas do padrão (103 × 13 mm) e QR Code do Bolepix. **Link público assinado** para enviar ao pagador, sem login. |
| 5 | **Split** | Registro de movimentos por cliente (crédito, tarifas, repasse), em compensação × creditado, agenda dos próximos créditos do banco, extrato em tela e em CSV, e ajuste manual com motivo. |
| 6 | **Repasses** | Repasse imediato por PIX assim que o banco credita, a cada 15 minutos, sem saque nem aprovação. End-to-end guardado, estorno e nova tentativa automática em caso de falha. |
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
| **Financeiro** (equipe) | Opera o dinheiro: acompanha e reenvia repasses, ajusta o registro de movimentos, concilia e vê a margem. |
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
Com a demonstração, a Área do Cliente fica em `http://localhost:3600/cliente/` com
`financeiro@alfanet.com.br` / `cliente2026`.

```bash
npm test          # 130 testes
npm run migrar    # aplica as migrações sem subir o servidor
```

## O código do cliente

Cada cliente recebe, no cadastro, um **código de controle sequencial**: `0001`, `0002`, `0003`… com dígito
verificador. Depois de `9999` a sequência segue (`10000`, `10001`). O código é atribuído uma vez e **nunca muda**.

```
Código do cliente 0001-3
                       └── dígito verificador (módulo 11)
```

**Por que não é "agência e conta":** a PAY AX não é banco e não guarda saldo de cliente — o valor recebido vai na
hora para a conta dele. Apresentar agência e conta, ou usar "banco"/"bank" no nome, sugeriria uma atividade que
a PAY AX não exerce, e a Resolução Conjunta CMN/BCB nº 17/2025 veda termos que sugiram atividade sem autorização.
Pelo mesmo motivo, a área do cliente se chama **Área do Cliente**. A Conformidade confere isso sozinha.

O dígito existe para pegar erro de digitação quando alguém informa o código — inclusive a troca de dois dígitos de
lugar, o engano mais comum ao ditar um número. O cliente vê o código no cartão da Área do Cliente e em Cadastro; a
equipe vê na lista, na ficha, e **busca por ele** (`0002`, `2` ou `0002-8` encontram o cliente).

> **Não confundir com a agência e a conta do Bradesco.** Aquelas são do convênio, vão dentro do código de barras
> (posições 20-23 e 37-43) e é por elas que o banco identifica para onde o dinheiro vai. O código do cliente é
> nosso, só de controle, e **não entra no boleto**. Um teste garante isso.

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
campo **Beneficiário final** das duas vias — e também é registrado assim no banco, na remessa CNAB e na API.

Os rótulos seguem a nomenclatura das Circulares do Banco Central 3.598/2012, 3.656/2013 e 3.956/2019:

| Nome antigo | Nome atual | No nosso boleto |
|---|---|---|
| Cedente | **Beneficiário** | PAY AX, dona do convênio |
| Sacado | **Pagador** | quem paga a conta |
| Sacador/Avalista | **Beneficiário final** | o cliente (Connect Link, por exemplo) |

O próprio manual CNAB 400 do Bradesco (março de 2023) registra essa troca de nomes e chama as posições
335-394 de "Beneficiário Final ou 2ª Mensagem". Se o modelo de ficha aprovado na homologação vier
diferente, basta mudar a constante `ROTULO_BENEFICIARIO_FINAL` em `server/lib/impressao.js`.

**Atenção:** o Bradesco só aceita o beneficiário final se o convênio estiver cadastrado para isso
(condição "S" ou "A"), por pedido na agência. Sem esse cadastro, o campo é ignorado ou recusado.

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

**Autenticação em duas etapas** (TOTP, por aplicativo) vale para a equipe e para a Área do Cliente. O administrador
pode **exigir** de toda a equipe — quem ainda não tem configura antes de trabalhar, e ninguém desliga o próprio
enquanto a exigência estiver ligada. Quem troca de celular pede ao administrador para redefinir; fica na auditoria.
Para ligar a exigência, o próprio administrador precisa ter 2FA ativo: não dá para trancar a porta com a chave dentro.

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3600` | Porta HTTP. |
| `PAYAX_BASE_PATH` | (raiz) | Endereço do Backoffice, ex.: `/pagamentos`. |
| `PAYAX_CLIENTE_PATH` | `<BASE_PATH>/cliente` | Endereço da Área do Cliente, ex.: `/payax-cliente`. |
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

## Proteção de dados (LGPD)

Tudo sai de um **inventário único** em `server/lib/lgpd.js` (registro das operações, art. 37): o que é tratado, de
quem, para quê, com que base legal, com quem é compartilhado e por quanto tempo fica guardado. O aviso público e a
tela interna leem dali — não há como um dizer uma coisa e o sistema fazer outra.

| O que a lei pede | Como o sistema atende |
|---|---|
| Informar o titular de forma clara (art. 9º) | **Aviso de privacidade público** em `/privacidade` (e `/cliente/privacidade`), sem login, ligado no boleto, na entrada e no menu da Área do Cliente e na entrada do Backoffice |
| Encarregado com identidade e contato públicos (art. 41) | **LGPD → Encarregado**; o nome e o e-mail vão para o aviso. Sem encarregado, a Conformidade acusa |
| Direitos do titular (art. 18) e prazo de resposta (art. 19, II: 15 dias) | **Formulário no aviso**, com protocolo e prazo. A equipe confere a identidade antes de responder (confirmar a um desconhecido que um CPF paga um provedor já seria vazar dado), gera o relatório dos dados do titular e registra a resposta. Recusa exige motivo (art. 18, § 4º). Atraso vira alerta no painel |
| Relatório de acesso sem violar sigilo de outra lei | O relatório **não traz** nada de PLD: a Lei 9.613/1998 (art. 11, II) proíbe dar ciência ao próprio titular |
| Eliminar quando acaba a finalidade, guardando o que a lei manda (arts. 15 e 16) | **Retenção automática diária**: registros financeiros por 5 anos depois de concluídos (Lei 9.613/1998, art. 10, § 2º, e prazos fiscais), depois o pagador é anonimizado — boleto, lançamentos, avisos do banco, alertas de PLD encerrados, pedidos respondidos — e os arquivos CNAB antigos são apagados. Título em aberto nunca é tocado. IP da auditoria: 6 meses (Marco Civil, art. 15) |
| Comunicar incidente à ANPD e aos titulares (art. 48; Resolução CD/ANPD nº 15/2024) | **LGPD → Incidentes**: o prazo de 3 dias úteis corre da descoberta; incidente de risco relevante só se encerra depois das duas comunicações |

O que fica com o jurídico (acompanhamento na Conformidade): revisar o texto do aviso — é minuta técnica fiel ao
sistema —, definir com cada provedor quem é controlador e quem é operador dos dados dos assinantes, contratos com
quem trata dados para a PAY AX (banco, hospedagem, consultas) e o relatório de impacto (art. 38).

## Prevenção à lavagem de dinheiro (PLD)

A PAY AX recebe na conta dela o dinheiro dos clientes e o repassa: é *"intermediação de recursos financeiros de
terceiros"* (Lei 9.613/1998, art. 9º, I). O sistema cumpre por padrão o que a lei pede a quem está nessa lista — o
jurídico confirma o enquadramento (acompanhamento na Conformidade).

| O que a lei pede | Como o sistema atende |
|---|---|
| Identificar o cliente e manter o cadastro atualizado; para empresa, quem a representa e os proprietários (art. 10, I e § 1º) | **PLD → Conheça seu cliente**: sócios (com busca na Receita), representantes, situação do CNPJ e revisão periódica |
| Registrar as transações e guardar por 5 anos (art. 10, II e § 2º) | Boletos, lançamentos e alertas nunca são apagados |
| Atenção especial às operações suspeitas (art. 11, I) | **Monitoramento** de hora em hora: valor alto, valor fora do padrão do cliente, fracionamento, volume do mês, cliente novo com volume alto, o cliente pagando a si mesmo, o mesmo pagador pagando vários clientes |
| Comunicar ao Coaf em 24 horas, **sem dar ciência ao cliente** (art. 11, II) | Decidir "comunicar" abre o prazo de 24 h; vencido, vira alerta no painel e fora da norma na Conformidade. Protocolo do SISCOAF registrado no alerta. Só o administrador vê o PLD; nada chega à Área do Cliente; a auditoria guarda só a situação, nunca o texto da análise |
| Comunicar a não ocorrência (art. 11, III) | Declaração anual registrada em PLD → Comunicações |

Fluxo de um alerta: **novo → em análise → arquivado** (com justificativa) **ou a comunicar → comunicado** (com
protocolo).

**A comunicação ao Coaf é manual, sempre depois da análise.** O monitoramento só levanta o alerta; quem decide é
uma pessoa, e o envio é feito por ela no SISCOAF. O sistema **nunca envia nada ao Coaf sozinho**: ele guarda a
análise e a decisão, conta as 24 horas, cobra no painel e registra o protocolo informado. Os limites das regras ficam em **PLD → Parâmetros** e devem sair da política de PLD da empresa.

**Suspensão de repasse por ordem legal** (decisão judicial, indisponibilidade de ativos): a única exceção ao repasse
imediato. Fica registrada com motivo e documento, e o valor aparece na Conformidade como "retido por ordem legal",
à parte do "dinheiro parado". A lei de lavagem pede **comunicar**, não bloquear — a suspensão é para ordem legal.

O que o sistema não faz sozinho, e está como acompanhamento na Conformidade: cadastro da PAY AX no Coaf, política de
PLD aprovada, e a conferência dos clientes contra a lista de sanções do Conselho de Segurança da ONU (Lei 13.810/2019).

## Conformidade

**Regra do projeto: nada no sistema fica fora das normas.** Toda regra legal implementada tem a fonte
citada ao lado no código e um teste que falha se alguém a quebrar. Quando a norma não é clara, vale o
limite mais conservador até o jurídico decidir.

**Backoffice → Conformidade** monitora tudo isso ao vivo (catálogo em `server/lib/conformidade.js`):

- **Verificação automática** — o sistema confere sozinho, a cada abertura da tela: tenta o que a regra
  proíbe (multa de 2,01%, por exemplo) e espera ser barrado, e varre os boletos em aberto atrás de algo
  que tenha escapado. Gera a remessa e a ficha de teste para conferir layout, nomes e expressões.
- **Acompanhamento** — o que depende do Bradesco, do jurídico ou do provedor. O administrador registra
  situação, responsável, prazo e observação; cada mudança vai para a auditoria.
- Regra automática fora da norma vira alerta no painel; prazo de acompanhamento vencido também.
- A equipe toda vê; só o administrador registra. Regra nova entra no catálogo, com teste em
  `test/conformidade.test.js`.

Legenda: ✅ atendido no sistema · 🏦 depende do Bradesco · ⚖️ depende de parecer jurídico · 🔧 falta construir

| Norma | O que exige | Como o sistema atende | Situação |
|---|---|---|---|
| Circulares BCB 3.598/2012, 3.656/2013 e 3.956/2019 | Identificação de beneficiário, pagador e beneficiário final, com a nomenclatura nova | Nomes e CNPJ/CPF das três partes impressos e registrados; CPF/CNPJ do pagador obrigatório | ✅ |
| Código de Defesa do Consumidor, art. 52, § 1º | Multa de mora de no máximo 2% | Emissão e configuração do IXC recusam acima de 2% | ✅ |
| Juros de mora | Teto usual de 1% ao mês em cobrança de consumidor | Emissão e configuração do IXC recusam acima de 1% ao mês | ✅ ⚖️ confirmar se pode ser outro entre empresas |
| Lei 5.474/1968 (duplicatas) | Duplicata de serviço para prestação de serviço | Espécie padrão DS (código 12 no CNAB 400) | ✅ 🏦 código da API a confirmar |
| FEBRABAN, Comunicado FB-170/2005 | Boleto sem "taxa bancária" ou "tarifa bancária" | O boleto não usa essas expressões | ✅ |
| Manual CNAB 400 do Bradesco (março de 2023) | Layout byte a byte; beneficiário final nas posições 335-394 | Posições conferidas contra o manual, com testes | ✅ 🏦 convênio precisa ser habilitado para beneficiário final |
| LGPD (Lei 13.709/2018) | Transparência, encarregado, direitos do titular em 15 dias, retenção, incidentes, segurança | Aviso público ligado ao boleto, formulário com protocolo, retenção automática, registro de incidentes com prazo, senhas com scrypt, credenciais cifradas, auditoria, duas etapas | ✅ ⚖️ revisão jurídica do aviso e papéis com os provedores |
| Arranjos e instituições de pagamento (Lei 12.865/2013 e regras do BCB) | Quem mantém saldo de terceiros (conta de pagamento) segue regras próprias | **Não há saldo guardado:** o valor vai ao cliente assim que o banco credita, e a Conformidade vigia isso sozinha | ✅ ⚖️ confirmar o enquadramento do recebimento em nome dos clientes e a contabilização com o contador |
| Resolução Conjunta CMN/BCB nº 17/2025 | Sem termos que sugiram atividade sem autorização ("banco", "bank") no nome, nome fantasia e marca | "Área do Cliente" no lugar de "Internet Bank"; código do cliente no lugar de agência e conta; a Conformidade confere as telas | ✅ ⚖️ confirmar com o jurídico se a norma alcança a PAY AX |
| Prevenção à lavagem de dinheiro (Lei 9.613/1998) | Conhecer o cliente, monitorar operações atípicas, comunicar ao Coaf em 24 h sem dar ciência ao cliente | Módulo PLD: conheça seu cliente, 7 regras de monitoramento, análise, comunicação com prazo e protocolo, declaração anual | ✅ ⚖️ confirmar o enquadramento; cadastro no Coaf, política e lista de sanções são acompanhamento |
| Regras da Anatel para cobrança de telecom | Documento de cobrança do provedor ao assinante | Responsabilidade do provedor; o boleto não substitui a fatura detalhada | ⚖️ do provedor |

## Hoje empresa de tecnologia; amanhã instituição autorizada

**Hoje**, a PAY AX é empresa de tecnologia: não pode manter saldo de cliente, não pode se chamar "banco" e não
pode oferecer conta. Por isso o sistema funciona assim, e a Conformidade vigia cada ponto:

| Regra de hoje | Onde está no sistema | Quem vigia |
|---|---|---|
| O dinheiro do cliente não fica com a PAY AX | rateio pelo banco ou PIX na hora em que o crédito cai; sem saque, mínimo nem aprovação | `repasse-imediato`, `split-pelo-banco` |
| Sem nome de banco | "Área do Cliente" e "Código do cliente" — a PAY AX não dá agência nem conta a ninguém | `termos-instituicao-financeira` |
| Cobrança registrada por banco autorizado | Bradesco é o beneficiário; o cliente, o beneficiário final | `beneficiario-final`, `registro` |

**O que já está pronto para o dia em que a PAY AX for autorizada pelo Banco Central** (instituição de pagamento,
Lei 12.865/2013 e Resolução BCB 80/2021; banco é outra autorização, bem mais exigente):

- **Razão por cliente.** Cada centavo já entra e sai por lançamento (`lancamentos`), com data de competência e de
  liberação, e o saldo de cada cliente fecha em zero. Uma conta de pagamento é exatamente esse razão, só que com
  saldo permitido.
- **Código do cliente.** É um número interno único, com dígito verificador, atribuído uma vez e que nunca muda:
  pode virar o número da conta de pagamento sem renumerar ninguém.
- **Separação do dinheiro.** O valor do cliente e a tarifa da PAY AX já são lançamentos distintos; numa
  instituição de pagamento, o dinheiro dos clientes é patrimônio separado e fica aplicado conforme a regra do
  Banco Central — o razão já sabe quanto é de cada um.
- **PLD, LGPD, trilha de auditoria, duas etapas e credenciais cifradas**, que uma instituição autorizada precisa
  ter desde o primeiro dia, já estão em funcionamento.
- **Saída por PIX pelos dados da conta**, que é a mesma operação de uma transferência feita pelo cliente.

**O que muda só depois da autorização** (e nunca antes — o sistema não tem chave para ligar isso hoje):

1. Saldo em conta de pagamento, com transferência e saque pedidos pelo cliente — a regra `repasse-imediato` muda
   de "nada parado" para "saldo conciliado com o patrimônio separado".
2. Participação direta no PIX (ISPB próprio) e liquidação no SPB, em vez de depender do PIX do convênio.
3. Agência e conta da PAY AX passam a existir, e a regra de nomenclatura troca a lista do que é proibido.
4. Relatórios ao Banco Central, ouvidoria e as demais exigências da autorização.

Antes de qualquer um desses passos: parecer jurídico e o pedido de autorização deferido.

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

Backoffice e Área do Cliente usam as mesmas peças, de `comum/componentes.js`:

| Peça | Na Área do Cliente | No Backoffice |
|---|---|---|
| cartão de destaque | `cartaoConta()` — o saldo do cliente, com o botão de esconder | `cartaoPainel()` — a posição da plataforma no período |
| `acoesRapidas()` | emitir, transferir, extrato, relatórios | emitir, repasses, conciliação, relatórios |
| `linhaTempo()` + `agruparMovimentos()` | o extrato, com o split aberto em cada recebimento | — |

A diferença entre as duas áreas é de conteúdo, não de linguagem: o cliente vê a conta dele, a equipe vê
a plataforma inteira. Sobra em `cliente/css/area-cliente.css` só a barra de navegação do celular, e em
`public/css/payax.css` só a lista de alertas do painel.

Em texto, o nome da empresa é **PAY AX**, com espaço. `payax` minúsculo continua sendo só identificador
interno (chaves de `localStorage`, variáveis `PAYAX_*`, nome de arquivo, prefixo de txid do PIX).

## Estrutura

```
pagamentos/
  comum/        base.css, ui.js, api.js, graficos.js, marca.js e componentes.js
                — tudo compartilhado pelas duas áreas
  public/       Backoffice (telas em js/telas/)
  cliente/      Área do Cliente (telas em js/telas/)
  server/
    lib/        febraban, pix, codigobarras, impressao, precos (split), razao (conta gráfica),
                boletos, repasses, bradesco, ixc, sincronismo, rotinas
    routes/     backoffice, cliente (Área do Cliente) e publico (webhook + link do boleto)
  test/         130 testes, com IXC falso
```
