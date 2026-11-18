# Pendências

## Entrou neste pacote (para o teste no IXC)

- Boleto em PDF de verdade (arquivo), no painel, na Área do Cliente e no link do pagador (`...pdf`).
  O PDF mostra sempre a situação do momento: pago ou cancelado vira um aviso, sem código de barras.
- Entrega do boleto no sistema do cliente: link no campo "Link gateway" do título, PDF nos arquivos do
  cliente (ou da fatura) e e-mail com o PDF anexado pelo servidor de e-mail do próprio cliente.
- Baixa no IXC pela rota oficial (`fn_areceber_recebimentos_baixas_novo`), com conferência depois.
- Acompanhamento da fatura: cancelada, recebida por outro meio ou alterada no IXC → o boleto é baixado no
  banco e, se mudou valor ou vencimento, reemitido.
- Diagnóstico do sistema do cliente num título de teste (o que o IXC aceita gravar).
- Alterar título no IXC sem esconder a fatura (`liberado = S` e os valores atuais dos outros campos).
- Consulta de CNPJ: tenta a fonte pública quando a API Brasil não acha; mensagem clara para empresa
  aberta há pouco tempo; o campo mostra o CNPJ e o CEP no formato de sempre.
- Complemento do endereço; logo da PAY AX menor no boleto; nome do banco em preto; site sem o nome do
  banco parceiro; mesmo IXC atendendo duas empresas (uma carteira para cada).

Roteiro do teste: `ROTEIRO-TESTE-IXC.md`.

## Depende do teste no IXC

- A carteira "Importado gateway" funciona sem gateway por trás? O que faz o botão "Imprimir boleto"?
- A edição completa do título (PUT `fn_areceber`) guarda o link sem mexer em valor, vencimento e situação?
- A rota de arquivos da fatura (`fn_areceber_arquivos`) existe? Senão, o PDF fica nos arquivos do cliente.
- Conta e planejamento da baixa: os padrões (conta da carteira e planejamento do título) servem?

## Ainda não feito

- WhatsApp com o PDF anexado (depende da ferramenta do provedor: Opa! Suite ou API oficial).
- Página de 2ª via para o assinante (CPF + código por SMS) e API de 2ª via para robôs de atendimento.
- Registro pela API do banco (o sistema tem o modo pronto; falta o banco liberar as credenciais).
- Acompanhamento em volume grande: hoje confere até 200 faturas por cliente a cada ciclo.

## Esperando resposta de fora

- Banco: liberação das APIs de Cobrança e Pix; homologação do arquivo CNAB 400; rateio na liquidação;
  contrato de terceiro habilitador (Resolução BCB 443, art. 14).
- Advogado regulatório: enquadramento do recebimento e repasse (Resolução BCB 494/2025).
- IXC: versão dos provedores (trava de vencimentos a partir de 01/01/2027); parceria de gateway.
- Dados de contato para os botões "Atendimento" do site.
