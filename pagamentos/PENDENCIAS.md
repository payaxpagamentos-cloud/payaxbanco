# Pendências para a próxima atualização

Lista do que ficou combinado para fazer junto com a próxima atualização do servidor (um pacote único).

## Para corrigir

1. **Consulta de CNPJ não preenche os dados** (visto em 16/11/2026, CNPJ 69.360.078/0001-13).
   A tela mostra "CNPJ não encontrado — preencha à mão." Essa mensagem aparece quando a consulta
   devolve 404 (`comum/ui.js`, autopreenchimento; servidor em `server/routes/consultas.js` →
   `consultaDados.consultarCnpj`). Conferir no servidor:
   - se o token da API Brasil está configurado e com saldo (Integrações → API Brasil);
   - se a API Brasil devolve "não encontrado" para CNPJ aberto recentemente (as bases públicas demoram a
     ter CNPJ novo) e, nesse caso, mostrar uma mensagem clara em vez de só "não encontrado";
   - se a consulta pública de reserva está respondendo;
   - a máscara do campo: o print mostrou "69.360.078/000113" (sem o hífen), conferir a formatação.

## Já feito no código, entra no próximo pacote

- Complemento do endereço (pagador e cliente).
- Logo da PAY AX menor no topo do boleto; nome do banco em preto.
- Boleto em modo arquivo (CNAB) não imprime prazo de baixa que não vai no arquivo.
- IXC: grava só o nosso número no título (`nn_boleto` via `fn_areceber_altera`), lê `nn_boleto`.
- Mesmo IXC atendendo duas empresas: cada uma exige a sua carteira, sem repetir.
- Site sem o nome do banco parceiro.

## Esperando resposta

- IXC: filial só para impressão do boleto afeta contabilidade, DRE ou SPED? (ou teste controlado no IXC).
- IXC: rota correta de baixa de título pela API.
- Banco: liberação das APIs de Cobrança e Pix; homologação do arquivo CNAB 400 do convênio.
- Propostas de gateways com subcontas (Asaas, Iugu, Celcash) — só para comparação de custo.
