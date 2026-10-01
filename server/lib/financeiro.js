'use strict';

/** Valor da parcela pela Tabela Price, em centavos. */
function parcelaPrice(valorCentavos, taxaMensal, parcelas) {
  if (taxaMensal === 0) return Math.ceil(valorCentavos / parcelas);
  const fator = taxaMensal / (1 - (1 + taxaMensal) ** -parcelas);
  return Math.round(valorCentavos * fator);
}

function simular(valorCentavos, taxaMensal, parcelas, inicio = new Date()) {
  const valorParcela = parcelaPrice(valorCentavos, taxaMensal, parcelas);
  let saldo = valorCentavos;
  const cronograma = [];
  for (let n = 1; n <= parcelas; n++) {
    const juros = Math.round(saldo * taxaMensal);
    let valor = valorParcela;
    let amortizacao = valor - juros;
    if (n === parcelas) { amortizacao = saldo; valor = amortizacao + juros; }
    saldo -= amortizacao;
    cronograma.push({ numero: n, vencimento: somarMeses(inicio, n), valor_centavos: valor, juros_centavos: juros, amortizacao_centavos: amortizacao, saldo_devedor_centavos: saldo });
  }
  const total = cronograma.reduce((a, p) => a + p.valor_centavos, 0);
  return { valor_parcela_centavos: valorParcela, total_centavos: total, juros_total_centavos: total - valorCentavos, cronograma };
}

function somarMeses(data, meses) {
  const d = new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() + meses);
  const ultimoDia = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(data.getUTCDate(), ultimoDia));
  return d.toISOString().slice(0, 10);
}

module.exports = { parcelaPrice, simular, somarMeses };
