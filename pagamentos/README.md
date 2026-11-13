# PayAx Pagamentos

Sistema de meios de pagamento da PayAx: **emissão de boletos e Bolepix pelo Bradesco**, **split de pagamento**,
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
        ├─ (−) comissão PayAx 2,35% ....... R$ 6,30   → nossa receita
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
| 1 | **Clientes** | Cadastro com CNPJ validado, endereço do beneficiário, situação, chave PIX de repasse, janela de retenção (D+N), repasse automático, valor mínimo, limite sem aprovação e teto por boleto. Ficha com resumo, boletos, conta gráfica, repasses, preços e acessos. |
| 2 | **Preços** | Tabela padrão da plataforma e tabela por cliente, **com vigência**: tarifa de emissão, tarifa de liquidação (repassada), comissão percentual com piso e teto, e tarifa do repasse. O histórico fica guardado. |
| 3 | **Boletos** | Emissão avulsa, por importação do IXC ou por API. **Boleto** e **Bolepix** (mesmo título com QR Code PIX). Nosso número reservado de forma atômica, código de barras e linha digitável no padrão FEBRABAN com o campo livre do Bradesco. Juros ao mês (pro rata die), multa, desconto por antecipação e prazo de baixa. Baixa, estorno e consulta ao banco. |
| 4 | **Ficha de compensação** | Recibo do pagador + ficha, em HTML pronto para imprimir ou salvar em PDF pelo navegador, com código de barras Interleaved 2 of 5 nas medidas do padrão (103 × 13 mm) e QR Code do Bolepix. **Link público assinado** para enviar ao pagador, sem login. |
| 5 | **Split e conta gráfica** | Razão de lançamentos por cliente com saldo acumulado, disponível × a liberar, agenda de liberação dos próximos dias, extrato em tela e em CSV, e ajuste manual com motivo. |
| 6 | **Repasses** | Saque pelo Internet Bank ou pela nossa equipe, rotina automática diária, limite de aprovação por cliente, envio por PIX com end-to-end guardado, cancelamento e estorno automático em caso de falha. |
| 7 | **Conciliação** | Cada aviso do banco é **guardado antes de ser processado** (corpo inteiro), com o resultado de cada um: liquidado, repetido, ignorado ou erro. Liquidação idempotente: o mesmo aviso duas vezes não credita em dobro. Baixa manual e consulta ao banco para o que não chegou. |
| 8 | **Integrações** | **Bradesco** (Cobrança Registrada, Boleto Híbrido e PIX de repasse) com credenciais cifradas em AES-256-GCM, e **um IXC por cliente**, nos dois sentidos: importa os títulos em aberto, emite o boleto, grava a linha digitável de volta no título e dá baixa quando o boleto é pago. |
| 9 | **Relatórios** | Faturamento por período e por cliente: emitido, recebido, comissão, tarifas, receita, **margem** (receita − custo do banco) e repassado, com CSV e impressão. Taxa de conversão emitido → pago. |
| 10 | **Segurança e histórico** | Perfis por função, senha provisória trocada no primeiro acesso, idempotência nos comandos POST, controle de versão otimista nos cadastros e auditoria com valor antes e depois. |

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

A chave PIX de destino do repasse **só a equipe PayAx altera** — o cliente consulta, mas não muda sozinho.

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
npm test          # 58 testes
npm run migrar    # aplica as migrações sem subir o servidor
```

## O banco (Bradesco)

O conector fica inteiro em [`server/lib/bradesco.js`](server/lib/bradesco.js), com dois modos:

| Modo | O que faz |
|---|---|
| `simulador` (padrão fora de produção) | Registra o título **localmente**: calcula o código de barras pelo padrão FEBRABAN e o BR Code pelo padrão EMV do Banco Central. Nada sai do servidor. É o modo para desenvolver e homologar internamente. |
| `bradesco` | Fala com a API do banco: OAuth2 com JWT assinado pelo certificado + mTLS. |

Ao receber as credenciais, cadastre-as em **Integrações → Bradesco** (certificado e chave privada são cifrados antes
de serem gravados e nunca voltam para a tela) e suba o servidor com `PAYAX_BANCO_MODO=bradesco`.

> **Confira antes de ligar em produção:** os caminhos e os nomes de campo da API estão reunidos em `ENDPOINTS` e nas
> funções `paraApi` / `daApi` do mesmo arquivo, porque variam por contrato e por versão. O resto do sistema não
> precisa mudar.

O **aviso de liquidação** chega em `POST /api/publico/webhook/<token>`; o endereço completo aparece na tela de
Integrações quando as credenciais são salvas. O corpo inteiro é guardado em `eventos_banco` antes de qualquer
processamento, então nada se perde se algo falhar — e reprocessar não duplica crédito.

## O IXC (um por cliente)

Cada cliente cadastra o endereço e o token (`id:hash`, de um usuário técnico só da PayAx) em **Integrações → IXC**.
O conector fica em [`server/lib/ixc.js`](server/lib/ixc.js) e os nomes de recurso e campo estão reunidos em
`RECURSOS` e `CAMPOS`, para ajustar à versão de cada provedor em um lugar só.

- **Importar**: lê `fn_areceber` em aberto no período, busca o pagador em `cliente` e emite um boleto para cada
  título. Títulos já importados são ignorados, então pode rodar quantas vezes quiser.
- **Anotar**: grava a linha digitável e o nosso número de volta no título de origem.
- **Baixar**: quando o boleto é liquidado, marca o título como recebido no IXC, com data e valor.

Endereços de rede interna são recusados por padrão (proteção contra SSRF); libere com `PAYAX_IXC_REDE_INTERNA=1`
apenas se o IXC estiver no mesmo servidor.

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
| `PAYAX_ROTINA_MIN` | `15` | Intervalo das rotinas, em minutos. |
| `PAYAX_FUSO` | `America/Sao_Paulo` | Fuso usado nas datas de negócio. |
| `PAYAX_SESSAO_HORAS` | `8` | Validade da sessão. |
| `PAYAX_URL_PUBLICA` | — | Endereço público, usado no link do boleto enviado ao pagador. |
| `PAYAX_TRUST_PROXY` | `loopback` | Proxies confiáveis para obter o IP real. |
| `PAYAX_LIMITE_LOGIN` | `10` | Tentativas de login por IP por minuto. |
| `PAYAX_IXC_REDE_INTERNA` | desligado | Permite que o IXC aponte para a rede interna. |

## O que depende de terceiros (não incluído)

- **Credenciamento no Bradesco**: convênio de cobrança registrada, faixa de nosso número, certificado da API e
  contrato de PIX para pagamento (o repasse). Sem isso, o sistema roda no modo simulador.
- **Envio do boleto por e-mail ou WhatsApp ao pagador**: hoje o sistema gera o link e a ficha; o disparo em massa
  exige um provedor de mensagens.
- **Débito automático, cartão e PIX cobrança com vencimento**: fora do escopo desta etapa, que é só boleto e Bolepix.

## Estrutura

```
pagamentos/
  comum/        base.css, ui.js, api.js e graficos.js — compartilhados pelas duas áreas
  public/       Backoffice (telas em js/telas/)
  cliente/      Internet Bank (telas em js/telas/)
  server/
    lib/        febraban, pix, codigobarras, impressao, precos (split), razao (conta gráfica),
                boletos, repasses, bradesco, ixc, sincronismo, rotinas
    routes/     backoffice, cliente (Internet Bank) e publico (webhook + link do boleto)
  test/         58 testes, com IXC falso
```
