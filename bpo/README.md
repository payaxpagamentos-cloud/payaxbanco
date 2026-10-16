# BPO Financeiro · PAY AX

Sistema da equipe PAY AX que cuida do financeiro das empresas clientes (BPO Financeiro). É um sistema **separado** do
Banqueiro: tem servidor, banco de dados, usuários e login próprios, e não acessa as contas PAY AX.

## Funcionalidades

| Módulo | O que faz |
|---|---|
| **Painel da carteira** | Empresas atendidas, receita recorrente (mensalidades), tarefas atrasadas, contratos vencendo, pendências por empresa ordenadas por urgência (pagamentos do dia, vencidos, extrato a conciliar, tarefas) e carteira por analista. |
| **Empresas** | Cadastro com CNPJ validado e contrato de BPO: analista responsável, plano, mensalidade, vigência, situação (implantação, ativa, suspensa, encerrada) e escopo. Empresa nova já recebe plano de contas padrão, centro de custo "Geral" e três rotinas mensais. |
| **Tarefas** | Rotinas por empresa com responsável e prazo; as recorrentes (semanal ou mensal) criam a próxima ocorrência quando concluídas. |
| **Contas a pagar e a receber** | Lançamento com fornecedor/cliente, categoria, centro de custo, competência, vencimento e parcelamento (até 120x). Baixa com juros, multa e desconto; baixa em lote; estorno; cancelamento; filtros e exportação CSV. |
| **Conciliação bancária** | Importa extrato **OFX** (1.x e 2.x) ou **CSV** sem duplicar linhas. Para cada linha sugere movimentos já lançados e contas em aberto do mesmo valor. Concilia, baixa e concilia (diferença vira juros ou desconto), cria lançamento a partir do extrato (tarifas, rendimentos) ou ignora. Conciliação automática só para pares sem ambiguidade. |
| **Fluxo de caixa** | Mensal ou diário, consolidado ou por conta: realizado (baixas) e previsto (contas em aberto; vencidos entram em hoje), saldo projetado, gráfico, alerta de saldo negativo e quebra por categoria. |
| **DRE gerencial** | Por competência ou por caixa, mês a mês, com receita líquida, lucro bruto, resultado operacional, resultado antes do IR e lucro líquido, análise vertical, margens, filtro por centro de custo e CSV. Juros e descontos das baixas entram no resultado financeiro. Aportes, empréstimos, investimentos e distribuição de lucros ficam "fora da DRE". |
| **Cadastros** | Contas bancárias (saldo inicial, livro caixa com saldo linha a linha, transferências e ajustes), fornecedores e clientes, plano de contas (cada categoria aponta para uma linha da DRE) e centros de custo. |
| **Auditoria** | Todas as ações com usuário, empresa, data e IP. |

### Perfis

| Perfil | Acesso |
|---|---|
| **Analista** | Só as empresas da própria carteira: lançamentos, conciliação, relatórios, cadastros e tarefas. |
| **Supervisor** | Todas as empresas; cadastra empresas e altera contratos e analistas; vê a auditoria. |
| **Administrador** | Tudo, inclusive usuários. |

As regras ficam no servidor: cada rota `/api/empresas/:id/...` confere se a empresa está na carteira do usuário, e todo
cadastro usado num lançamento (categoria, contato, conta, centro de custo) precisa ser da mesma empresa.

## Como executar

Requisitos: **Node.js 22.13+**.

```bash
cd bpo
npm install
npm run seed     # opcional: equipe, quatro empresas e cerca de quatro meses de movimento
npm start        # http://localhost:3100
```

Acesso inicial: `admin@bpo.payax.com.br` / `admin123` (troque no primeiro acesso, clicando no avatar).
Com o seed: `supervisor@`, `rafael@` e `juliana@bpo.payax.com.br`, senha `bpo2026` (Rafael e Juliana são analistas).

Formato do CSV de extrato: `data;histórico;valor[;documento]`, com data `DD/MM/AAAA` ou `AAAA-MM-DD`, valor negativo
para saídas e vírgula ou ponto decimal. Cabeçalho e linhas de saldo sem data são ignorados.

```bash
npm test
```

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3100` | Porta HTTP. |
| `BPO_DB` | `data/bpo.db` | Arquivo do banco SQLite. |
| `BPO_SECRET` | aleatório | Segredo das sessões (mín. 32 caracteres). **Obrigatório em produção.** |
| `BPO_ADMIN_EMAIL` / `BPO_ADMIN_SENHA` / `BPO_ADMIN_NOME` | — | Administrador criado no primeiro start. Senha obrigatória em produção (mín. 12). |
| `BPO_TRUST_PROXY` | `loopback` | Proxies confiáveis para obter o IP real. |
| `BPO_LIMITE_LOGIN` | `10` | Tentativas de login por IP por minuto. |
| `BPO_TOLERANCIA_DIAS` | `3` | Diferença de datas aceita para sugerir conciliação com um movimento já lançado. |

Produção com Docker: `docker build -t payax-bpo bpo/` e rode com um volume em `/app/data`.

## Tecnologia e arquitetura

Mesmo stack e visual do Banqueiro: Node.js 22 + Express, SQLite nativo (`node:sqlite`), telas em HTML/CSS/JS puros sem
build, testes com `node:test`. Valores em centavos (inteiros); movimentações em transação.

```
bpo/
  server/
    db.js              # esquema: empresas, tarefas, categorias, contatos, contas, lançamentos, movimentos, extrato, auditoria
    lib/lancamentos.js # criar/parcelar, baixa, estorno, transferências, saldos
    lib/conciliacao.js # importação, sugestões, conciliação manual e automática
    lib/extrato.js     # leitura de OFX e CSV
    lib/relatorios.js  # fluxo de caixa e DRE
    routes/            # auth, painel, empresas, tarefas, usuarios, auditoria, financeiro (por empresa)
  public/              # telas (SPA)
  test/
```
