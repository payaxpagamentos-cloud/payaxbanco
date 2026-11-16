'use strict';

/*
 * Tabela de preços e cálculo do split.
 *
 * Em cada título LIQUIDADO o valor pago é dividido assim:
 *   valor pago  −  tarifa bancária (repassada ao cliente)  −  tarifa PAY AX  =  líquido do cliente
 *
 * A tarifa PAY AX é um VALOR FIXO por boleto pago, um PERCENTUAL do valor pago (ppm: 1% = 10.000), ou os
 * dois somados — com piso e teto opcionais sobre o total. Exemplo da Connect: R$ 1,99 fixo, sem percentual:
 *   boleto de R$ 100,00 pago  →  tarifa PAY AX R$ 1,99  →  R$ 98,01 para o cliente.
 * A tarifa de emissão, quando existe, é cobrada no registro do boleto, não na liquidação.
 *
 * Nos campos e no banco ela continua se chamando `comissao` (comissao_centavos, comissao_minima_centavos…):
 * é só o nome interno, que ficou de antes da troca do vocabulário do produto. Na tela, é "Tarifa PAY AX".
 *
 * O preço é congelado no boleto no momento da emissão: mudar a tabela não altera títulos já emitidos.
 */
const { ErroNegocio } = require('./erros');
const v = require('./validacao');

const PADRAO = {
  id: null,
  tarifa_emissao_centavos: 0,
  tarifa_liquidacao_centavos: 0,
  tarifa_fixa_centavos: 0,
  percentual_ppm: 0,
  comissao_minima_centavos: 0,
  comissao_maxima_centavos: null,
  tarifa_repasse_centavos: 0,
};

/** Campos que o Bolepix pode ter diferentes do boleto comum (a tarifa do repasse é uma só). */
const CAMPOS_BOLEPIX = ['tarifa_emissao_centavos', 'tarifa_liquidacao_centavos', 'tarifa_fixa_centavos', 'percentual_ppm',
  'comissao_minima_centavos', 'comissao_maxima_centavos'];

/** Os preços próprios do Bolepix da tabela (objeto), ou null se o Bolepix segue o preço do boleto. */
function bolepixDe(preco) {
  if (!preco?.bolepix) return null;
  try {
    const o = typeof preco.bolepix === 'string' ? JSON.parse(preco.bolepix) : preco.bolepix;
    return o && typeof o === 'object' ? Object.fromEntries(CAMPOS_BOLEPIX.filter((k) => k in o).map((k) => [k, o[k]])) : null;
  } catch {
    return null;
  }
}

/** O preço que vale para o tipo do título: no Bolepix, os campos próprios dele substituem os do boleto. */
const paraTipo = (preco, tipo) => (tipo === 'bolepix' && bolepixDe(preco) ? { ...preco, ...bolepixDe(preco) } : preco);

/** Preço vigente do cliente na data (cai para a tabela padrão da plataforma e, por fim, para zero). */
function vigente(db, clienteId, data) {
  const busca = `SELECT * FROM precos WHERE cliente_id IS ? AND vigencia_inicio <= ? AND (vigencia_fim IS NULL OR vigencia_fim >= ?)
    ORDER BY vigencia_inicio DESC, id DESC LIMIT 1`;
  return db.prepare(busca).get(clienteId, data, data)
    ?? db.prepare(busca).get(null, data, data)
    ?? { ...PADRAO };
}

/**
 * Divide o valor pago entre tarifa bancária, tarifa PAY AX e o líquido do cliente.
 * Trabalha só com inteiros; a soma das partes é sempre exatamente o valor pago.
 */
function calcularSplit({ valorPagoCentavos, preco, custoLiquidacaoCentavos = 0 }) {
  const bruto = Number(valorPagoCentavos);
  if (!Number.isInteger(bruto) || bruto <= 0) throw new ErroNegocio('Valor pago inválido para o split.', 422);

  let tarifa = Math.max(0, Number(preco.tarifa_liquidacao_centavos) || 0);
  let comissao = Math.max(0, Number(preco.tarifa_fixa_centavos) || 0)
    + Math.round((bruto * (Number(preco.percentual_ppm) || 0)) / 1_000_000);
  const minima = Math.max(0, Number(preco.comissao_minima_centavos) || 0);
  const maxima = preco.comissao_maxima_centavos === null || preco.comissao_maxima_centavos === undefined
    ? null : Math.max(0, Number(preco.comissao_maxima_centavos));
  if (comissao < minima) comissao = minima;
  if (maxima !== null && comissao > maxima) comissao = maxima;

  // Trava de segurança: o cliente nunca fica devendo por uma liquidação. A tarifa do banco tem prioridade
  // (nós já a pagamos), a tarifa PAY AX cede o que faltar.
  if (tarifa > bruto) tarifa = bruto;
  if (comissao > bruto - tarifa) comissao = bruto - tarifa;

  const liquido = bruto - tarifa - comissao;
  const custo = Math.max(0, Number(custoLiquidacaoCentavos) || 0);
  return {
    bruto_centavos: bruto,
    tarifa_banco_centavos: tarifa,
    comissao_centavos: comissao,
    liquido_centavos: liquido,
    // O que sobra para nós: a tarifa PAY AX mais a diferença entre a tarifa bancária cobrada e o custo real.
    custo_banco_centavos: custo,
    receita_centavos: comissao + tarifa,
    margem_centavos: comissao + tarifa - custo,
  };
}

/** Simula o split de um valor com o preço vigente do cliente (usado na tela antes de emitir). */
function simular(db, clienteId, valorCentavos, data, tipo = 'boleto') {
  const preco = paraTipo(vigente(db, clienteId, data), tipo);
  return { preco, ...calcularSplit({ valorPagoCentavos: valorCentavos, preco }) };
}

/** Copia para o boleto os campos de preço que ficam congelados. */
const congelar = (precoTabela, conta, tipo = 'boleto') => {
  const preco = paraTipo(precoTabela, tipo);
  return {
  preco_id: preco.id ?? null,
  tarifa_emissao_centavos: preco.tarifa_emissao_centavos ?? 0,
  tarifa_liquidacao_centavos: preco.tarifa_liquidacao_centavos ?? 0,
  comissao_fixa_centavos: preco.tarifa_fixa_centavos ?? 0,
  percentual_ppm: preco.percentual_ppm ?? 0,
  comissao_minima_centavos: preco.comissao_minima_centavos ?? 0,
  comissao_maxima_centavos: preco.comissao_maxima_centavos ?? null,
  // Tarifa que o banco cobra da PAY AX por título pago: a do Bolepix, se a conta tiver uma própria.
  custo_liquidacao_centavos: (tipo === 'bolepix' ? conta?.custo_bolepix_centavos : null) ?? conta?.custo_liquidacao_centavos ?? 0,
  };
};

/** O preço congelado no boleto, no formato que `calcularSplit` espera. */
const doBoleto = (b) => ({
  id: b.preco_id,
  tarifa_emissao_centavos: b.tarifa_emissao_centavos,
  tarifa_liquidacao_centavos: b.tarifa_liquidacao_centavos,
  tarifa_fixa_centavos: b.comissao_fixa_centavos ?? 0,
  percentual_ppm: b.percentual_ppm,
  comissao_minima_centavos: b.comissao_minima_centavos,
  comissao_maxima_centavos: b.comissao_maxima_centavos,
});

/** Percentual em ppm para texto ("2,35%"). */
const percentualTexto = (ppm) => `${(Number(ppm || 0) / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`;

const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** A tarifa PAY AX em uma frase: "R$ 1,99 por boleto pago", "2,35% do valor pago (mínimo R$ 1,50)"… */
function tarifaTexto(p) {
  const partes = [];
  if (p.tarifa_fixa_centavos) partes.push(`${brl(p.tarifa_fixa_centavos)} por boleto pago`);
  if (p.percentual_ppm) partes.push(`${percentualTexto(p.percentual_ppm)} do valor pago`);
  if (!partes.length) return 'sem tarifa PAY AX';
  const limites = [p.comissao_minima_centavos ? `mínimo ${brl(p.comissao_minima_centavos)}` : null,
    p.comissao_maxima_centavos ? `máximo ${brl(p.comissao_maxima_centavos)}` : null].filter(Boolean);
  return `${partes.join(' + ')}${limites.length ? ` (${limites.join(', ')})` : ''}`;
}

/** Lê e valida uma tabela de preços vinda da tela (valores em reais). Usado na tabela padrão e na do cliente. */
function validarPreco(b = {}) {
  const d = {
    tarifa_emissao_centavos: v.centavos(b.tarifa_emissao ?? 0, 'a tarifa de emissão'),
    tarifa_liquidacao_centavos: v.centavos(b.tarifa_liquidacao ?? 0, 'a tarifa bancária repassada'),
    tarifa_fixa_centavos: v.centavos(b.tarifa_fixa ?? 0, 'a tarifa PAY AX fixa'),
    percentual_ppm: b.percentual === undefined || b.percentual === '' ? 0 : v.percentual(b.percentual, 'o percentual', { max: 50 }),
    comissao_minima_centavos: v.centavos(b.comissao_minima ?? 0, 'a tarifa mínima'),
    comissao_maxima_centavos: v.centavosOpcional(b.comissao_maxima, 'a tarifa máxima'),
    tarifa_repasse_centavos: v.centavos(b.tarifa_repasse ?? 0, 'a tarifa de repasse'),
    observacao: v.opcional(b.observacao, 'a observação', 200),
  };
  if (d.comissao_maxima_centavos !== null && d.comissao_maxima_centavos < d.comissao_minima_centavos) {
    throw new ErroNegocio('A tarifa máxima não pode ser menor que a mínima.', 422);
  }
  // Bolepix com preço próprio: os mesmos campos, com o prefixo bolepix_ na tela.
  d.bolepix = null;
  if (v.booleano(b.bolepix_proprio)) {
    const x = {
      tarifa_emissao_centavos: v.centavos(b.bolepix_tarifa_emissao ?? 0, 'a tarifa de emissão do Bolepix'),
      tarifa_liquidacao_centavos: v.centavos(b.bolepix_tarifa_liquidacao ?? 0, 'a tarifa bancária repassada do Bolepix'),
      tarifa_fixa_centavos: v.centavos(b.bolepix_tarifa_fixa ?? 0, 'a tarifa PAY AX fixa do Bolepix'),
      percentual_ppm: b.bolepix_percentual === undefined || b.bolepix_percentual === '' ? 0 : v.percentual(b.bolepix_percentual, 'o percentual do Bolepix', { max: 50 }),
      comissao_minima_centavos: v.centavos(b.bolepix_comissao_minima ?? 0, 'a tarifa mínima do Bolepix'),
      comissao_maxima_centavos: v.centavosOpcional(b.bolepix_comissao_maxima, 'a tarifa máxima do Bolepix'),
    };
    if (x.comissao_maxima_centavos !== null && x.comissao_maxima_centavos < x.comissao_minima_centavos) {
      throw new ErroNegocio('No Bolepix, a tarifa máxima não pode ser menor que a mínima.', 422);
    }
    d.bolepix = JSON.stringify(x);
  }
  return d;
}

/** Grava uma tabela nova (do cliente, ou a padrão com clienteId null), encerrando a anterior no dia de antes. */
function gravarPreco(db, clienteId, d, inicio, usuarioId, agora) {
  db.prepare(`UPDATE precos SET vigencia_fim = date(?, '-1 day') WHERE cliente_id IS ? AND vigencia_fim IS NULL AND vigencia_inicio < ?`)
    .run(inicio, clienteId, inicio);
  return db.prepare(`INSERT INTO precos (cliente_id, vigencia_inicio, tarifa_emissao_centavos, tarifa_liquidacao_centavos, tarifa_fixa_centavos,
      percentual_ppm, comissao_minima_centavos, comissao_maxima_centavos, tarifa_repasse_centavos, observacao, criado_em, criado_por, bolepix)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(clienteId, inicio, d.tarifa_emissao_centavos, d.tarifa_liquidacao_centavos, d.tarifa_fixa_centavos, d.percentual_ppm,
      d.comissao_minima_centavos, d.comissao_maxima_centavos, d.tarifa_repasse_centavos, d.observacao, agora, usuarioId, d.bolepix ?? null).id;
}

module.exports = { PADRAO, CAMPOS_BOLEPIX, bolepixDe, paraTipo, vigente, calcularSplit, simular, congelar, doBoleto, percentualTexto, tarifaTexto, validarPreco, gravarPreco };
