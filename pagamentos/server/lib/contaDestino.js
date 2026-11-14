'use strict';

/*
 * Conta de destino do cliente: para onde vai o valor de cada boleto pago, informada pela PAY AX no
 * cadastro (o cliente não altera sozinho — é o destino do dinheiro).
 *
 * Regra de segurança: a conta é da PRÓPRIA empresa cliente (mesmo CNPJ). Pagar a terceiros a partir
 * da cobrança de outro abriria caminho para desvio e para lavagem de dinheiro.
 *
 * Como o dinheiro chega lá:
 *   - conta no Bradesco e convênio com rateio de crédito contratado → o PRÓPRIO BANCO credita a
 *     parte do cliente na liquidação (CNAB 400, registro tipo 3). O dinheiro não passa pela PAY AX;
 *   - qualquer outro banco → PIX pelos dados da conta (agência e conta, sem precisar de chave),
 *     assim que o crédito cai. PIX é instantâneo, funciona 24 horas e custa menos que TED.
 *   - sem conta cadastrada, mas com chave PIX → PIX pela chave (cadastros antigos).
 */
const v = require('./validacao');
const { ErroNegocio } = require('./erros');

/** Bancos mais comuns: código COMPE, nome e ISPB (identificação do banco no PIX). Outros: informar o ISPB. */
const BANCOS = Object.freeze({
  '001': { nome: 'Banco do Brasil', ispb: '00000000' },
  '033': { nome: 'Santander', ispb: '90400888' },
  '077': { nome: 'Banco Inter', ispb: '00416968' },
  '104': { nome: 'Caixa Econômica Federal', ispb: '00360305' },
  '237': { nome: 'Bradesco', ispb: '60746948' },
  '260': { nome: 'Nu Pagamentos (Nubank)', ispb: '18236120' },
  '336': { nome: 'C6 Bank', ispb: '31872495' },
  '341': { nome: 'Itaú Unibanco', ispb: '60701190' },
  '748': { nome: 'Sicredi', ispb: '01181521' },
  '756': { nome: 'Sicoob', ispb: '02038232' },
});
const BRADESCO = '237';

const so = (x) => String(x ?? '').replace(/\D/g, '');

/**
 * Lê a conta de destino do corpo do cadastro. Devolve só os campos que vieram (para PATCH).
 * `cnpjCliente` é o CNPJ do cliente: a conta tem que ser dele.
 */
function ler(body, cnpjCliente) {
  if (body.destino_conta === undefined && body.destino_banco === undefined) return {};
  // Conta apagada de propósito.
  if (!body.destino_conta && !body.destino_banco) {
    return { destino_banco: null, destino_ispb: null, destino_agencia: null, destino_agencia_dv: null, destino_conta: null,
      destino_conta_dv: null, destino_tipo: null, destino_titular: null, destino_documento: null };
  }
  const banco = so(body.destino_banco).padStart(3, '0');
  if (banco.length !== 3 || banco === '000') throw new ErroNegocio('Informe o código do banco da conta de destino (3 dígitos, ex.: 237).', 422);
  const ispb = so(body.destino_ispb) || BANCOS[banco]?.ispb;
  if (!ispb || ispb.length !== 8) throw new ErroNegocio(`Informe o ISPB do banco ${banco} (8 dígitos): é como o PIX identifica o banco.`, 422);
  const agencia = so(body.destino_agencia);
  if (!agencia || agencia.length > 5) throw new ErroNegocio('Agência de destino inválida.', 422);
  const conta = so(body.destino_conta);
  if (!conta || conta.length > 20) throw new ErroNegocio('Conta de destino inválida.', 422);
  const documento = v.documento(body.destino_documento || cnpjCliente, 'o CNPJ do titular da conta');
  if (cnpjCliente && documento !== so(cnpjCliente)) {
    throw new ErroNegocio('A conta de destino tem que ser da própria empresa (mesmo CNPJ do cliente).', 422);
  }
  return {
    destino_banco: banco,
    destino_ispb: ispb,
    destino_agencia: agencia,
    destino_agencia_dv: String(body.destino_agencia_dv ?? '').trim().slice(0, 1) || null,
    destino_conta: conta,
    destino_conta_dv: String(body.destino_conta_dv ?? '').trim().slice(0, 2).toUpperCase() || null,
    destino_tipo: v.opcao(body.destino_tipo || 'corrente', 'o tipo da conta', ['corrente', 'pagamento', 'poupanca']),
    destino_titular: v.texto(body.destino_titular, 'o titular da conta de destino', 120),
    destino_documento: documento,
  };
}

const temConta = (c) => Boolean(c?.destino_banco && c?.destino_agencia && c?.destino_conta);
const temDestino = (c) => temConta(c) || Boolean(c?.pix_chave);

/** "Bradesco · ag. 1234-5 · c/c 12345-6", para tela e registro. */
function descrever(c) {
  if (temConta(c)) {
    const banco = BANCOS[c.destino_banco]?.nome ?? `banco ${c.destino_banco}`;
    const tipo = { corrente: 'c/c', pagamento: 'conta pgto.', poupanca: 'poupança' }[c.destino_tipo] ?? 'c/c';
    return `${banco} · ag. ${c.destino_agencia}${c.destino_agencia_dv ? `-${c.destino_agencia_dv}` : ''} · ${tipo} ${c.destino_conta}${c.destino_conta_dv ? `-${c.destino_conta_dv}` : ''}`;
  }
  if (c?.pix_chave) return `chave PIX ${c.pix_chave}`;
  return null;
}

/** Como o dinheiro chega ao cliente, dado o convênio usado: 'rateio' (pelo banco) ou 'pix'. */
function meioDeEntrega(cliente, conta) {
  if (conta?.rateio_contratado && temConta(cliente) && cliente.destino_banco === BRADESCO) return 'rateio';
  return 'pix';
}

module.exports = { BANCOS, BRADESCO, ler, temConta, temDestino, descrever, meioDeEntrega };
