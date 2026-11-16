'use strict';

/**
 * Bancos com que a PAY AX opera a cobrança — o único lugar do sistema que sabe qual conector usar.
 *
 * Cada conta bancária nossa (contas_bancarias.banco) aponta para um banco desta lista. Tudo o que fala com
 * o banco passa por aqui: registrar o título, consultar, baixar, pagar o PIX do repasse e calcular o código
 * de barras e a linha digitável. Para operar com um banco novo:
 *   1. escrever o conector dele (lib/bancos/<banco>.js) com as mesmas funções do conector do Bradesco
 *      (testar, registrar, consultar, baixar, pagarPix) e o cálculo do código de barras do banco;
 *   2. ligar aqui em `conector` e `calcular` e marcar `homologado: true` — só depois de homologar com o banco;
 *   3. se houver troca de arquivos, o layout CNAB do banco em `cnab`.
 * Enquanto não estiver homologado, o banco aparece na tela como "em homologação" e o sistema recusa usar
 * conta dele — nunca registra boleto num banco que não foi testado.
 */
const { ErroNegocio } = require('./erros');
const bradesco = require('./bradesco');
const febraban = require('./febraban');

const BANCOS = Object.freeze({
  237: {
    codigo: '237', nome: 'Bradesco', homologado: true,
    conector: (...a) => bradesco.criarBanco(...a),
    calcular: ({ conta, nossoNumero, valorCentavos, vencimento }) => febraban.boletoBradesco({
      agencia: conta.agencia, conta: conta.conta, carteira: conta.carteira, nossoNumero, valorCentavos, vencimento,
    }),
    carteiraPadrao: '09',
    rateio: true,           // rateio de crédito no convênio (o banco credita o cliente direto)
    cnab: 'cnab400-bradesco',
  },
  '001': { codigo: '001', nome: 'Banco do Brasil', homologado: false },
  104: { codigo: '104', nome: 'Caixa Econômica Federal', homologado: false },
  341: { codigo: '341', nome: 'Itaú Unibanco', homologado: false },
  '033': { codigo: '033', nome: 'Santander', homologado: false },
  756: { codigo: '756', nome: 'Sicoob', homologado: false },
  748: { codigo: '748', nome: 'Sicredi', homologado: false },
  '077': { codigo: '077', nome: 'Banco Inter', homologado: false },
  336: { codigo: '336', nome: 'C6 Bank', homologado: false },
});

const codigo = (c) => String(c ?? '').replace(/\D/g, '').padStart(3, '0');
const doBanco = (c) => BANCOS[codigo(c)] ?? BANCOS[Number(codigo(c))] ?? null;

/** O banco da conta, já conferido: existe e está homologado. */
function exigirHomologado(c) {
  const b = doBanco(c);
  if (!b) throw new ErroNegocio(`O banco ${codigo(c)} não está na lista de bancos da PAY AX.`, 422);
  if (!b.homologado) throw new ErroNegocio(`O ${b.nome} ainda está em homologação na PAY AX: não é possível operar com conta dele.`, 422);
  return b;
}

/** Conector do banco da conta (registrar, consultar, baixar, pagarPix). */
const criarBanco = (conta, credenciais = null, opcoes = {}) => exigirHomologado(conta.banco ?? '237').conector(conta, credenciais, opcoes);

/** Código de barras e linha digitável do título, pela regra do banco da conta. */
const calcularBoleto = (conta, dados) => exigirHomologado(conta.banco ?? '237').calcular({ conta, ...dados });

/** Lista para as telas. */
const listar = () => Object.values(BANCOS).map(({ codigo: c, nome, homologado, rateio = false }) => ({ codigo: c, nome, homologado, rateio }))
  .sort((a, b) => Number(b.homologado) - Number(a.homologado) || a.nome.localeCompare(b.nome));

module.exports = { BANCOS, doBanco, exigirHomologado, criarBanco, calcularBoleto, listar, codigo };
