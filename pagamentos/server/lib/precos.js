'use strict';

/*
 * Tabela de preços e cálculo do split.
 *
 * Em cada título LIQUIDADO o valor pago é dividido assim:
 *   valor pago  −  tarifa bancária (repassada ao cliente)  −  nossa comissão  =  líquido do cliente
 *
 * A comissão é um percentual do valor pago (ppm: 1% = 10.000) com piso e teto opcionais, somado a nada mais:
 * a tarifa de emissão, quando existe, é cobrada no registro do boleto, não na liquidação.
 *
 * O preço é congelado no boleto no momento da emissão: mudar a tabela não altera títulos já emitidos.
 */
const { ErroNegocio } = require('./erros');

const PADRAO = {
  id: null,
  tarifa_emissao_centavos: 0,
  tarifa_liquidacao_centavos: 0,
  percentual_ppm: 0,
  comissao_minima_centavos: 0,
  comissao_maxima_centavos: null,
  tarifa_repasse_centavos: 0,
};

/** Preço vigente do cliente na data (cai para a tabela padrão da plataforma e, por fim, para zero). */
function vigente(db, clienteId, data) {
  const busca = `SELECT * FROM precos WHERE cliente_id IS ? AND vigencia_inicio <= ? AND (vigencia_fim IS NULL OR vigencia_fim >= ?)
    ORDER BY vigencia_inicio DESC, id DESC LIMIT 1`;
  return db.prepare(busca).get(clienteId, data, data)
    ?? db.prepare(busca).get(null, data, data)
    ?? { ...PADRAO };
}

/**
 * Divide o valor pago entre tarifa bancária, nossa comissão e o líquido do cliente.
 * Trabalha só com inteiros; a soma das partes é sempre exatamente o valor pago.
 */
function calcularSplit({ valorPagoCentavos, preco, custoLiquidacaoCentavos = 0 }) {
  const bruto = Number(valorPagoCentavos);
  if (!Number.isInteger(bruto) || bruto <= 0) throw new ErroNegocio('Valor pago inválido para o split.', 422);

  let tarifa = Math.max(0, Number(preco.tarifa_liquidacao_centavos) || 0);
  let comissao = Math.round((bruto * (Number(preco.percentual_ppm) || 0)) / 1_000_000);
  const minima = Math.max(0, Number(preco.comissao_minima_centavos) || 0);
  const maxima = preco.comissao_maxima_centavos === null || preco.comissao_maxima_centavos === undefined
    ? null : Math.max(0, Number(preco.comissao_maxima_centavos));
  if (comissao < minima) comissao = minima;
  if (maxima !== null && comissao > maxima) comissao = maxima;

  // Trava de segurança: o cliente nunca fica devendo por uma liquidação. A tarifa do banco tem prioridade
  // (nós já a pagamos), a comissão cede o que faltar.
  if (tarifa > bruto) tarifa = bruto;
  if (comissao > bruto - tarifa) comissao = bruto - tarifa;

  const liquido = bruto - tarifa - comissao;
  const custo = Math.max(0, Number(custoLiquidacaoCentavos) || 0);
  return {
    bruto_centavos: bruto,
    tarifa_banco_centavos: tarifa,
    comissao_centavos: comissao,
    liquido_centavos: liquido,
    // O que sobra para nós: a comissão mais a diferença entre a tarifa cobrada e o custo real do banco.
    custo_banco_centavos: custo,
    receita_centavos: comissao + tarifa,
    margem_centavos: comissao + tarifa - custo,
  };
}

/** Simula o split de um valor com o preço vigente do cliente (usado na tela antes de emitir). */
function simular(db, clienteId, valorCentavos, data) {
  const preco = vigente(db, clienteId, data);
  return { preco, ...calcularSplit({ valorPagoCentavos: valorCentavos, preco }) };
}

/** Copia para o boleto os campos de preço que ficam congelados. */
const congelar = (preco, conta) => ({
  preco_id: preco.id ?? null,
  tarifa_emissao_centavos: preco.tarifa_emissao_centavos ?? 0,
  tarifa_liquidacao_centavos: preco.tarifa_liquidacao_centavos ?? 0,
  percentual_ppm: preco.percentual_ppm ?? 0,
  comissao_minima_centavos: preco.comissao_minima_centavos ?? 0,
  comissao_maxima_centavos: preco.comissao_maxima_centavos ?? null,
  custo_liquidacao_centavos: conta?.custo_liquidacao_centavos ?? 0,
});

/** O preço congelado no boleto, no formato que `calcularSplit` espera. */
const doBoleto = (b) => ({
  id: b.preco_id,
  tarifa_emissao_centavos: b.tarifa_emissao_centavos,
  tarifa_liquidacao_centavos: b.tarifa_liquidacao_centavos,
  percentual_ppm: b.percentual_ppm,
  comissao_minima_centavos: b.comissao_minima_centavos,
  comissao_maxima_centavos: b.comissao_maxima_centavos,
});

/** Percentual em ppm para texto ("2,35%"). */
const percentualTexto = (ppm) => `${(Number(ppm || 0) / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`;

module.exports = { PADRAO, vigente, calcularSplit, simular, congelar, doBoleto, percentualTexto };
