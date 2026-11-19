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

## API do banco (em andamento desde 18/11/2026)

- Portal de desenvolvedores do banco: cadastro feito; assinaturas pedidas para "Cobrança" e "Cobrança com
  QR Code", em Sandbox (aprovadas) e Produção (pendentes de aprovação do banco). E-mail enviado ao contato.
- Falta: registrar a aplicação e gerar as credenciais (Client ID e Client Secret entram só em
  Integrações → Banco), e o certificado (seguir o anexo do banco).
- Falta: receber o manual/especificação dos dois produtos (versões 1.7.2 e 1.8.3 no portal) e ajustar o
  modo API do sistema, escrito antes da documentação oficial: as rotas e os nomes de campos do produto com
  QR Code são outros. Testar no Sandbox antes de ligar em produção.
- Autenticação (visto na documentação do portal em 19/11/2026, "Autenticação – Gerar Bearer Token", manual
  "Desenvolvedor mTLS" versão 1.0.0 de 06/07/2026): o token agora é por mTLS, em
  `/auth/server-mtls/v2/token`; produção em `https://openapi.bradesco.com.br`, sandbox em
  `https://openapisandbox.prebanco.com.br`. O sistema ainda usa `/auth/server/v1.1/token` e o endereço
  antigo de homologação: trocar quando o manual chegar.
- Webhook (aviso de pagamento): o banco exige SSL OV ou EV no domínio da notificação, com validade acima
  de 4 meses. Pedido feito em 19/11/2026: Sectigo InstantSSL (OV) para pagamentos.payax.com.br. Falta gerar
  o CSR no servidor (/root/ssl-ov), validar o domínio por DNS, a validação da empresa, instalar o
  certificado e pedir o cadastro do webhook ao banco.

## Do relatório "Terceiro habilitador no convênio" (para o próximo pacote)

- Remessa: incluir o registro Tipo 7 (endereço do beneficiário final) e alertas para as rejeições 53, 54
  e A3 no retorno. Antes, confirmar com o banco se o convênio está habilitado para beneficiário final por
  arquivo (condição de aceite "S" ou "A"; o manual pede pedido prévio na agência).
- PDF: endereço da PAY AX e do provedor; nome e CNPJ da PAY AX exatamente como o banco imprime; mais
  destaque para o beneficiário final; linha "Boleto emitido por ordem de [provedor]". Sem trocar rótulos.
- Conferir no extrato a tarifa "TAR MAN SAC AVA" (R$ 97,55 por título numa tabela de 2021; não confirmado).

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
