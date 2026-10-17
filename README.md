# Ativa BPO Financeiro

Sistema da equipe Ativa que cuida do financeiro das empresas clientes (BPO Financeiro): servidor, banco de dados,
usuários e login próprios, com o Portal do Cliente para as empresas atendidas.

## Módulos

| # | Módulo | O que tem |
|---|---|---|
| 1 | **Gestão de empresas** | Cadastro dos clientes do BPO com CNPJ validado, contrato (analista, plano, mensalidade, vigência, situação, escopo), contas bancárias e **responsáveis na empresa** (cargo, contato, quem recebe relatórios, quem acessa o Portal e quem aprova pagamentos, com limite). |
| 2 | **Painel financeiro** | Por empresa: saldos, a pagar e a receber (vencidos, hoje, 7 dias), resultado do mês, inadimplência de 90 dias, **alerta de falta de caixa** (saldo projetado dia a dia nos próximos 30 dias) e pagamentos aguardando aprovação. Na carteira: pendências de todas as empresas ordenadas por urgência, com alertas. |
| 3 | **Contas a pagar** | Despesas com fornecedor, categoria, centro de custo (ou rateio), competência e vencimento; **parcelamento** (divide o valor) e **recorrência mensal** (repete o valor); baixa com juros e desconto, baixa em lote, estorno; **comprovantes e notas anexados** ao lançamento. |
| 4 | **Contas a receber** | Cobranças com cliente e vencimento, recebimentos, **pagamentos parciais** (o saldo continua em aberto, ligado ao original), mensalidades recorrentes e valores em atraso. |
| 5 | **Conciliação bancária** | Extrato OFX (1.x e 2.x) ou CSV sem duplicar; sugestões; conciliação automática dos pares sem ambiguidade; baixar e conciliar; lançar direto do extrato as **movimentações sem classificação** (tarifas, rendimentos); diferença do período entre banco e sistema. |
| 6 | **Fluxo de caixa** | Realizado e previsto, diário (até 92 dias) ou mensal, consolidado ou por conta, saldo projetado, alerta de saldo negativo e quebra por categoria. |
| 7 | **Categorias e centros de custo** | Plano de contas ligado às linhas da DRE (com código contábil), centros de custo por departamento, unidade ou projeto e **rateio** de um lançamento entre vários centros (percentuais somando 100%). A DRE filtrada por centro e o **resultado por centro de custo** já aplicam o rateio. |
| 8 | **Aprovação de pagamentos** | Regra por empresa (liga e define o valor mínimo). Fluxo **solicitação → conferência pela equipe → autorização → pagamento**: a baixa fica bloqueada até a aprovação. **Alçada por usuário** (padrão do perfil, valor máximo ou sem limite) e limite por responsável no Portal. Quem lançou não aprova. Histórico com quem conferiu, aprovou ou recusou (recusa exige motivo). Valor aumentado depois de aprovado volta para conferência. |
| 9 | **Cobrança e inadimplência** | Aging por faixa (1-30, 31-60, 61-90, 90+), taxa de inadimplência, devedores com último contato e promessa; **lembretes de vencimento** com texto pronto (com a chave PIX da empresa) para abrir no WhatsApp ou no e-mail, com registro do envio; **histórico de contatos**; **promessas de pagamento** (cumpridas automaticamente quando o título é pago); **acordos** que substituem títulos vencidos por novas parcelas. |
| 10 | **Documentos** | Notas, boletos, contratos, comprovantes e extratos vinculados à empresa ou ao lançamento, enviados pela equipe ou pelo cliente. Ficam fora do banco, com nome aleatório e SHA-256 conferido no download (sempre como anexo). Até 10 MB, formatos de documento. |
| 11 | **Relatórios gerenciais** | DRE (competência ou caixa, análise vertical, margens, CSV), receitas e despesas por categoria, resultado por centro de custo, inadimplência e **orçamento × realizado** (orçamento mensal por categoria, sugestão pela média dos últimos meses com reajuste). |
| 12 | **Gestão da equipe do BPO** | Tarefas recorrentes com responsável e prazo, pendências por cliente, carteira por analista e **fechamento mensal**: checklist com verificações automáticas (extratos conciliados até o fim do mês, vencidos tratados, nada aguardando aprovação) e etapas manuais (revisão, DRE, envio ao cliente). Mês fechado **trava** lançamentos, baixas e ajustes com data nele; só supervisor reabre, com motivo. Painel do fechamento de toda a carteira. |
| 13 | **Portal do Cliente** | Em `/portal/`: posição financeira, contas em aberto, **aprovação de pagamentos** dentro do limite, **envio de documentos**, DRE e fluxo de caixa, e **conversa com a equipe** (a equipe responde no menu Mensagens). Senha provisória gerada pela equipe e trocada no primeiro acesso. |
| 14 | **Integrações** | **API para sistemas de gestão** (chave por empresa, só o hash gravado, revogável): envia lançamentos com categoria por nome e contato por CPF/CNPJ, consulta saldos e lançamentos. **Importação de lançamentos por CSV** do ERP. **Exportação contábil** em partidas dobradas (débito, crédito, valor, histórico) pelos códigos contábeis. Bancos por OFX/CSV; cobrança por WhatsApp e e-mail. |
| 15 | **Segurança e histórico** | Permissões por função (analista, supervisor, administrador) e por carteira; **autenticação em duas etapas** por aplicativo (TOTP) para equipe e Portal, opcionalmente **obrigatória** para a equipe; **backups** automáticos do banco (com download e retenção) e manuais; **registro de alterações** na auditoria com o valor antes e depois. |

### O que depende de terceiros (não incluído)

- **Leitura automática do extrato pelo banco** (API bancária ou Open Finance): exige credenciamento com cada banco ou contrato com um agregador. Hoje o extrato entra por arquivo.
- **Disparo automático** de cobrança por WhatsApp Business, SMS ou e-mail: exige um provedor de mensagens. Hoje a equipe envia pelo próprio WhatsApp ou e-mail, com o texto pronto e o registro do envio.
- **Emissão de boletos e PIX cobrança** para os clientes da empresa: depende da integração bancária da conta de cada empresa.
- **Leitura de NF-e** (XML da SEFAZ) para lançar automaticamente.

### Perfis

| Perfil | Acesso |
|---|---|
| **Analista** | Só as empresas da própria carteira: lançamentos, conciliação, cobrança, relatórios, cadastros, documentos, mensagens, fechamento e tarefas. Confere pagamentos; aprova só se o administrador der alçada. |
| **Supervisor** | Todas as empresas; cadastra empresas, contratos, responsáveis e acessos ao Portal; regras de aprovação; chaves de API; reabre mês fechado; auditoria. Aprova sem limite (padrão). |
| **Administrador** | Tudo, inclusive usuários, alçadas e Segurança e backups. |
| **Responsável (Portal)** | Só a própria empresa: consulta, envia documentos, conversa e, se tiver permissão, aprova pagamentos até o limite. |

As regras ficam no servidor: cada rota `/api/empresas/:id/...` confere se a empresa está na carteira do usuário, e todo
cadastro usado num lançamento (categoria, contato, conta, centro de custo) precisa ser da mesma empresa. Tokens da equipe,
do Portal e chaves de API têm audiências diferentes: um não vale no lugar do outro.

## Como executar

Requisitos: **Node.js 22.13+**.

```bash
npm install
npm run seed     # opcional: equipe, quatro empresas e cerca de quatro meses de movimento
npm start        # http://localhost:3100
```

Acesso inicial: `admin@ativabpo.com.br` / `admin123` (troque no primeiro acesso, clicando no avatar).
Com o seed: `supervisor@`, `rafael@` e `juliana@ativabpo.com.br`, senha `bpo2026` (Rafael e Juliana são analistas;
Juliana aprova até R$ 5.000,00). Portal do Cliente em `http://localhost:3100/portal/` (no servidor, `/bpo-cliente/`): `marta@paoquente.com.br`,
`paulo@clinicasorriso.com.br`, `renata@technova.com.br` ou `sergio@rota66.com.br`, senha `portal2026`.

Formato do CSV de extrato: `data;histórico;valor[;documento]`, com data `DD/MM/AAAA` ou `AAAA-MM-DD`, valor negativo
para saídas e vírgula ou ponto decimal. Cabeçalho e linhas de saldo sem data são ignorados.

```bash
npm test
```

## Instalação no servidor (/bpo e /bpo-cliente)

```bash
npm run empacotar   # gera dist/ativa-bpo.zip
```

O pacote traz a pasta `bpo/` pronta para enviar ao servidor: código, dependências de produção já instaladas, `.env` com
segredo e senha inicial do administrador gerados na hora (a senha aparece no terminal) e `LEIA-ME.txt` com o passo a
passo (cPanel, PM2, Docker, Nginx e Apache). O sistema da equipe fica em `/bpo/` e o Portal do Cliente em `/bpo-cliente/`.

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3100` | Porta HTTP. |
| `BPO_BASE_PATH` | (raiz) | Endereço do sistema da equipe, ex.: `/bpo`. |
| `BPO_PORTAL_PATH` | `<BPO_BASE_PATH>/portal` | Endereço do Portal do Cliente, ex.: `/bpo-cliente`. |
| `BPO_DB` | `data/bpo.db` | Arquivo do banco SQLite. |
| `BPO_SECRET` | aleatório | Segredo das sessões (mín. 32 caracteres). **Obrigatório em produção.** |
| `BPO_ADMIN_EMAIL` / `BPO_ADMIN_SENHA` / `BPO_ADMIN_NOME` | — | Administrador criado no primeiro start. Senha obrigatória em produção (mín. 12). |
| `BPO_TRUST_PROXY` | `loopback` | Proxies confiáveis para obter o IP real. |
| `BPO_LIMITE_LOGIN` | `10` | Tentativas de login por IP por minuto. |
| `BPO_TOLERANCIA_DIAS` | `3` | Diferença de datas aceita para sugerir conciliação com um movimento já lançado. |
| `BPO_ARQUIVOS` | `data/arquivos` | Pasta dos documentos enviados. **Inclua no backup do servidor** (o backup automático cobre só o banco). |
| `BPO_ARQUIVO_MAX_MB` | `10` | Tamanho máximo de cada documento. |
| `BPO_BACKUPS` | `data/backups` | Pasta dos backups do banco. Copie para outro local. |
| `BPO_BACKUP_HORAS` / `BPO_BACKUP_MANTER` | `24` / `30` | Intervalo do backup automático e quantos manter. |

Produção com Docker: `docker build -t ativa-bpo bpo/` e rode com um volume em `/app/data`.

## Tecnologia e arquitetura

Node.js 22 + Express, SQLite nativo (`node:sqlite`), telas em HTML/CSS/JS puros sem
build, testes com `node:test`. Valores em centavos (inteiros); movimentações em transação.

```
bpo/
  server/
    db.js              # esquema: empresas, tarefas, categorias, contatos, contas, lançamentos, movimentos, extrato, auditoria
    lib/lancamentos.js # criar/parcelar, baixa, estorno, transferências, saldos
    lib/conciliacao.js # importação, sugestões, conciliação manual e automática
    lib/extrato.js     # leitura de OFX e CSV
    lib/relatorios.js  # fluxo de caixa, DRE e resultado por centro de custo
    lib/aprovacao.js   # conferência, alçada e autorização de pagamentos
    lib/cobranca.js    # inadimplência, lembretes, promessas e acordos
    lib/fechamento.js  # checklist e travamento do mês
    lib/documentos.js  # armazenamento de arquivos
    lib/orcamento.js   # orçado × realizado
    lib/integracoes.js # chaves de API, CSV de lançamentos, exportação contábil
    lib/totp.js        # autenticação em duas etapas (RFC 6238)
    lib/backup.js      # backups do banco
    routes/            # equipe (por empresa e carteira), portal, api-externa (ERP), seguranca
  public/              # telas da equipe (SPA)
  public/portal/       # Portal do Cliente
  test/
```
