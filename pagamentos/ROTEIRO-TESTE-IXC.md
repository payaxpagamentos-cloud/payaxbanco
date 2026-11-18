# Roteiro do teste: boleto PAY AX com a fatura no IXC

O que vamos confirmar: o IXC continua gerando a fatura e cobrando; o boleto é o da PAY AX (registrado no
convênio da PAY AX, com a PAY AX como beneficiário e o provedor como beneficiário final), e chega ao
atendimento e ao assinante em PDF.

Use sempre o cliente de teste (B4 VOIP – TESTE PAY AX). Nenhum assinante de verdade entra neste teste.
A carteira da Efí e os contratos não são tocados.

Em cada passo marcado com **(print)**, mande um print: é por ele que conferimos o que o IXC fez.

---

## 1. Atualizar o servidor

Confirme que o terminal mostra `root@srv1`, envie o pacote para `/root` e rode (troque o nome do arquivo
pelo do pacote recebido):

```
cd /root && tar xzf payax-pagamentos-AAAAMMDD-HHMM.tar.gz && cd payax-pagamentos-AAAAMMDD-HHMM/
./implantacao/instalar.sh --dominio pagamentos.payax.com.br --site payax.com.br --acesso acesso.payax.com.br --email-admin ti@payax.com.br --hestia auto --sem-copia-externa
```

Depois: `./implantacao/verificar.sh` (tudo verde).

## 2. Preparar o IXC

1. **Usuário do token.** O usuário técnico da PAY AX no IXC precisa de permissão em: Contas a receber
   (ler, alterar e receber), Clientes (ler e arquivos) e Carteira de cobrança (ler).
2. **Carteira de teste.** Cadastros → Financeiro → Carteira de cobrança → Novo:
   - Descrição: `PAY AX – boleto externo`
   - Conta: a conta "PAY AX" já criada (filial do provedor)
   - Tipo de recebimento: **Gateway**
   - Aba Configurações gateway: **Importado gateway = Sim**. Sem credenciais de nenhum gateway.
     Se o IXC obrigar a escolher um gateway, **pare e mande o print** (não escolha a Efí).
   - Juros 1% ao mês e multa 2%, como na PAY AX.
   - **(print)** de cada aba, e anote o **ID** da carteira.
3. **Fatura de teste.** Gere uma fatura de R$ 10,00 para o B4 VOIP nessa carteira, com vencimento daqui a
   alguns dias. Anote o **ID do título** (Contas a receber). **(print)** do título.
4. Veja nos registros do IXC se ele tentou falar com algum gateway ao gerar a fatura. **(print)** se
   aparecer erro.

## 3. Preparar a PAY AX

Clientes → o cliente de teste → aba **Acessos e sistema** → **Configurar**:

- Endereço e token do IXC.
- **Quem monta e envia o boleto:** A PAY AX.
- **Carteira de cobrança PAY AX no sistema (ID):** o ID anotado no passo 2.
- Multa 2, juros 1.
- **Importação automática:** Desligada (no teste, importamos na mão).
- Em "Entrega do boleto": **tudo em "Não"** por enquanto. Só "Acompanhar a fatura" fica em Sim.
- Salvar e clicar em **Testar** (tem que conectar).

## 4. O teste, passo a passo

### 4.1 Leitura (não muda nada)
**Diagnóstico** → informe o ID do título → deixe tudo em "Não testar" → **Rodar o diagnóstico**.
**(print)** do resultado. Ele mostra como o IXC guarda o título e a carteira (tipo, gateway, importado).

### 4.2 Emitir o boleto
**Importar títulos** → período que inclua o vencimento da fatura → **Importar e emitir**.
Deve dizer "1 boleto emitido". Abra o boleto em Boletos e clique em **Baixar PDF**. **(print)** do PDF.

No modo arquivo (CNAB), o boleto fica "em registro" até o banco confirmar: é normal. O PDF mostra esse aviso.

### 4.3 Nosso número no título
Diagnóstico → **Gravar o nosso número = Testar** → rodar. **(print)**.
No IXC, abra o título: ele tem que **continuar aparecendo** na lista e mostrar o nosso número. **(print)**.

### 4.4 Link no título
Diagnóstico → **Gravar o link do PDF = Testar** → rodar. **(print)**.
O diagnóstico confere sozinho se o valor, o vencimento e a situação do título ficaram iguais. Se ele
disser que "outros campos mudaram", **pare e mande o print**.
No IXC: título → Editar → aba Informações → campo **Link gateway**. **(print)**. Abra o link: tem que
abrir o PDF do boleto.

### 4.5 O botão "Imprimir boleto" do IXC
No IXC, no título, clique em **Imprimir boleto**. **(print)** do que acontecer (erro, o boleto do IXC ou
o link). Faça o mesmo na **Central do Assinante**, entrando como o cliente de teste. **(print)**.

### 4.6 PDF guardado no IXC
Diagnóstico → **Anexar PDF no cliente = Testar** e **Anexar PDF na fatura = Testar** → rodar. **(print)**.
No IXC, confira: cadastro do cliente → aba Arquivos; e Contas a receber → o título → aba Arquivos. **(print)**.
É esperado que "na fatura" possa falhar: a IXC não documenta essa rota. Se falhar, usamos "no cliente".

### 4.7 Ligar a entrega automática
Volte em **Configurar** e ligue só o que passou no diagnóstico:
- "Gravar o link do PDF no título" = Sim (se o 4.4 passou);
- "Guardar o PDF" = Nos arquivos do cliente, ou da fatura (o que passou no 4.6).

No boleto, clique em **Entregar no sistema do cliente**: ele mostra o que foi feito.

O PDF guardado e o e-mail só saem **depois de o banco confirmar o registro**. No modo arquivo, isso é no
dia seguinte, com o arquivo de retorno. O link sai na hora.

### 4.8 E-mail com o PDF anexado (opcional neste teste)
Em Configurar → "E-mail com o boleto em PDF anexado": servidor, porta, remetente, usuário e senha do
e-mail do provedor. A senha é digitada só nessa tela. Com o boleto registrado, o e-mail sai sozinho para
o e-mail do assinante no IXC. Para o teste, ponha um e-mail seu no cadastro do B4 VOIP.

### 4.9 Pagamento e baixa no IXC
No boleto da PAY AX: **Registrar pagamento** (data de hoje, valor cheio).
No IXC: o título tem que ficar **Recebido**, com o recebimento lançado na conta "PAY AX".
**(print)** do título e do recebimento. Confira em que conta e em que filial o recebimento caiu.

Se a baixa falhar, o motivo aparece em Clientes → o cliente → Acessos e sistema: na lista do fim da tela,
clique na linha "Baixa no sistema". O mais comum é faltar a "Conta para a baixa" ou o "Planejamento
analítico": preencha em Configurar. A rotina tenta a baixa de novo sozinha a cada 15 minutos.

Depois, **estorne** o recebimento no IXC e o pagamento na PAY AX (botão Estornar), para repetir se for preciso.

### 4.10 Fatura alterada ou cancelada no IXC
Gere outra fatura de teste e importe (4.2). Depois:
1. No IXC, mude o vencimento ou o valor da fatura. Na PAY AX, clique em **Conferir faturas** (na aba
   Acessos e sistema). O boleto antigo tem que ser baixado e um novo emitido; o link do título passa a
   apontar para o novo. **(print)**.
2. No IXC, cancele a fatura. Clique em **Conferir faturas**. O boleto tem que ficar baixado. **(print)**.

Em produção isso roda sozinho, a cada 15 minutos.

## 5. O que cada resultado decide

| Resultado | Decisão |
|---|---|
| 4.4 e 4.5: link gravado e "Imprimir boleto" não solta boleto do IXC | Caminho principal: carteira "Importado gateway" |
| A carteira não aceita ficar sem gateway, ou o IXC imprime um boleto dele | Plano B: carteira interna (sem boleto bancário), com o mesmo PDF da PAY AX |
| 4.6: anexo na fatura falha | Guardar o PDF nos arquivos do cliente |
| 4.9: baixa cai na filial ou conta errada | Ajustar "Conta para a baixa" e "Planejamento analítico" |

## 6. O que ainda não está neste pacote

- Envio por WhatsApp com o PDF (depende da ferramenta que o provedor usa).
- Página de 2ª via para o assinante, com CPF e código por SMS.
- Registro pela API do banco (o sistema está pronto; falta o banco liberar as credenciais).
