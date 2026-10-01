<p align="center"><img src="public/img/logo-payax.svg" alt="PAY AX" height="64"></p>

# Banqueiro · PAY AX

Sistema de gestão bancária da **PAY AX**: administração de clientes, contas, operações de caixa,
transferências, PIX, empréstimos, usuários, relatórios e trilha de auditoria — com a identidade visual PAY AX.

![Painel](docs/telas/painel-escuro.png)

## Funcionalidades

| Módulo | O que faz |
|---|---|
| **Painel** | Saldo sob custódia, clientes, movimentação do dia, carteira de crédito, fluxo de 14 dias, saldo por tipo de conta, últimas transações e maiores clientes. |
| **Clientes** | Cadastro PF/PJ com validação de CPF/CNPJ, contato, endereço, renda/faturamento, status (ativo, inativo, bloqueado) e ficha com contas e empréstimos. |
| **Contas** | Abertura de conta corrente, poupança, pagamento ou salário com número sequencial e dígito verificador (módulo 11); limite de cheque especial; bloqueio, desbloqueio e encerramento; extrato com filtro por período. |
| **Operações** | Depósito, saque, transferência entre contas e PIX por chave, sempre em transação atômica e respeitando saldo + limite. |
| **Chaves PIX** | CPF, CNPJ, e-mail, telefone ou chave aleatória (até 5 por conta). |
| **Transações** | Consulta geral de lançamentos com filtros e **estorno** (reverte origem e destino). |
| **Empréstimos** | Simulação e contratação pela Tabela Price, crédito automático em conta, cronograma de parcelas e pagamento em ordem com débito em conta; quitação automática. |
| **Relatórios** | Exportação CSV (compatível com Excel) de clientes, contas, transações por período e carteira de crédito. |
| **Auditoria** | Registro de todas as ações (login, cadastros, operações, estornos, alterações de limite/status) com usuário, data e IP. |
| **Usuários** | Gestão de colaboradores e perfis de acesso. |

### Perfis de acesso

| Perfil | Permissões |
|---|---|
| **Administrador** | Tudo, incluindo usuários e exclusão de clientes sem contas. |
| **Gerente** | Concede/altera limites, contrata empréstimos, bloqueia/encerra contas, estorna, altera status de clientes, relatórios e auditoria. |
| **Operador** | Cadastra clientes e contas, chaves PIX, operações de caixa até a alçada (padrão R$ 50.000,00) e pagamento de parcelas. |

## Demonstração online

Há uma versão de demonstração que roda inteira no navegador: o mesmo backend (rotas e regras de negócio)
é empacotado com SQLite em JavaScript, e os dados ficam salvos só no navegador de quem abre.

```bash
npm run build:demo   # gera dist-demo/ (index.html + banqueiro-demo.js + imagens)
```

Na demo, as senhas usam um hash simplificado e a exportação de CSV fica desativada. Use a versão instalada em produção.

## Como executar

Requisitos: **Node.js 22.13+** (usa o SQLite nativo `node:sqlite`, sem dependências nativas).

```bash
npm install
npm run seed     # opcional: dados de demonstração
npm start        # http://localhost:3000
```

Acesso inicial: `admin@payax.com.br` / `admin123` — **altere a senha no primeiro acesso** (clique no avatar).
Com o seed também existem `gerente@payax.com.br` e `operador@payax.com.br` (senha `payax2026`).

### Configuração (variáveis de ambiente)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP. |
| `PAYAX_SECRET` | aleatório | Segredo de assinatura das sessões. **Defina em produção** (senão as sessões caem a cada reinício). |
| `PAYAX_DB` | `data/banqueiro.db` | Arquivo do banco SQLite. |
| `PAYAX_AGENCIA` | `0001` | Agência das novas contas. |
| `PAYAX_LIMITE_OPERADOR` | `5000000` | Alçada do operador, em centavos. |
| `PAYAX_FUSO` | `-3 hours` | Deslocamento para agrupar dados por dia (horário de Brasília). |
| `PAYAX_ADMIN_EMAIL` / `PAYAX_ADMIN_SENHA` / `PAYAX_ADMIN_NOME` | — | Administrador criado no primeiro start. |

### Testes

```bash
npm test
```

Cobrem validação de CPF/CNPJ, Tabela Price, cadastro, abertura de contas, depósito/saque com limite,
transferência atômica, PIX, estorno, empréstimo, permissões por perfil, bloqueio/encerramento, relatórios e auditoria.

## Arquitetura

```
server/
  index.js          # inicialização
  app.js            # Express, cabeçalhos de segurança, rotas /api
  db.js             # esquema SQLite e transações
  auth.js           # tokens HMAC, autenticação e perfis
  seed.js           # dados de demonstração
  lib/              # validação, regras de conta, cálculo financeiro, auditoria
  routes/           # auth, clientes, contas, operacoes, pix, emprestimos, transacoes, dashboard, relatorios, usuarios, auditoria
public/
  index.html        # SPA sem build
  css/style.css     # identidade visual PAY AX (tokens de cor no :root)
  img/              # logo PAY AX (logo-payax.svg, logo-payax-branco.svg, payax-simbolo.svg)
  js/               # app, api, componentes de UI e páginas
test/               # node:test
```

- Valores monetários são armazenados em **centavos (inteiros)**, nunca em ponto flutuante.
- Toda movimentação ocorre dentro de `BEGIN IMMEDIATE … COMMIT`; cada lançamento grava o saldo após a operação.
- Senhas com `scrypt`; sessões assinadas com HMAC-SHA256 (8 h); CSP restritiva; CSV protegido contra injeção de fórmulas.

## Identidade visual

O logo fica em `public/img/` e as cores em `public/css/style.css` (`--payax-azul`, `--payax-ouro`…).
Para usar a arte oficial da PAY AX, basta substituir os arquivos SVG mantendo os mesmos nomes.
Tema claro e escuro e layout responsivo (celular/tablet) incluídos.

| Login | Clientes | Celular |
|---|---|---|
| ![](docs/telas/login.png) | ![](docs/telas/clientes.png) | ![](docs/telas/mobile.png) |
