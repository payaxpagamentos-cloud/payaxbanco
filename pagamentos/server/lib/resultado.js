'use strict';

/*
 * Resultado da PAY AX (lucro real) por mês:
 *
 *   receita das tarifas cobradas dos clientes (já descontados os estornos)
 * − impostos sobre a receita (alíquota informada pela contabilidade)
 * − custos do banco (registro, liquidação/rateio e PIX de repasse, pelas tarifas congeladas em cada operação)
 * = margem de contribuição
 * − despesas da operação (servidor, equipe, contador, sistemas...)
 * = lucro do mês
 *
 * Os custos do banco são os contratados (Contas e preços), não o débito do extrato: a tela avisa que é
 * preciso conferir com o extrato do Bradesco no fechamento.
 */
const { ErroNegocio } = require('./erros');

const CATEGORIAS = {
  infraestrutura: 'Servidores e infraestrutura',
  pessoal: 'Equipe e pró-labore',
  servicos: 'Contabilidade e serviços',
  software: 'Sistemas e licenças',
  impostos: 'Impostos e taxas fixas',
  bancario: 'Banco (mensalidades e pacotes)',
  marketing: 'Comercial e marketing',
  outros: 'Outros',
};

const PARAM_IMPOSTO = 'resultado_imposto_ppm';

const mesValido = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m ?? ''));

function limitesDoMes(mes) {
  if (!mesValido(mes)) throw new ErroNegocio('Mês inválido (use AAAA-MM).', 422);
  const [a, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return { de: `${mes}-01`, ate: `${mes}-${String(ultimo).padStart(2, '0')}` };
}

/** Mês anterior/seguinte em AAAA-MM. */
function somarMeses(mes, n) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const impostoPpm = (db) => Number(db.prepare('SELECT valor FROM parametros WHERE chave = ?').get(PARAM_IMPOSTO)?.valor ?? 0);

function gravarImposto(db, ppm) {
  db.prepare(`INSERT INTO parametros (chave, valor, atualizado_em) VALUES (?, ?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`)
    .run(PARAM_IMPOSTO, String(ppm), new Date().toISOString());
}

/** Despesas que valem no mês: as mensais em vigor e as únicas daquele mês. */
const despesasDoMes = (db, mes) => db.prepare(`SELECT * FROM despesas
  WHERE (recorrencia = 'mensal' AND inicio <= ?1 AND (fim IS NULL OR fim >= ?1))
     OR (recorrencia = 'unica' AND inicio = ?1)
  ORDER BY categoria, descricao`).all(mes);

/** Demonstrativo de um mês (AAAA-MM). */
function doMes(db, mes) {
  const { de, ate } = limitesDoMes(mes);

  // Receita: o que os clientes pagaram de tarifa, já com os estornos somados ao tipo de origem.
  const r = db.prepare(`SELECT
      IFNULL(SUM(CASE WHEN IFNULL(estorno_de, tipo) = 'comissao' THEN -valor_centavos END), 0) AS tarifa_payax,
      IFNULL(SUM(CASE WHEN IFNULL(estorno_de, tipo) = 'tarifa_emissao' THEN -valor_centavos END), 0) AS tarifa_emissao,
      IFNULL(SUM(CASE WHEN IFNULL(estorno_de, tipo) = 'tarifa_banco' THEN -valor_centavos END), 0) AS tarifa_banco,
      IFNULL(SUM(CASE WHEN IFNULL(estorno_de, tipo) = 'taxa_repasse' THEN -valor_centavos END), 0) AS tarifa_repasse
    FROM lancamentos WHERE data_competencia BETWEEN ? AND ?`).get(de, ate);
  const receita = r.tarifa_payax + r.tarifa_emissao + r.tarifa_banco + r.tarifa_repasse;

  // Custos do banco, pelas tarifas congeladas em cada operação.
  const reg = db.prepare(`SELECT COUNT(*) AS n, IFNULL(SUM(custo_emissao_centavos), 0) AS v FROM boletos
    WHERE emissao BETWEEN ? AND ? AND situacao <> 'falha'`).get(de, ate);
  const liq = db.prepare(`SELECT COUNT(*) AS n, IFNULL(SUM(custo_liquidacao_centavos), 0) AS v FROM boletos
    WHERE situacao = 'liquidado' AND pago_em BETWEEN ? AND ?`).get(de, ate);
  const pix = db.prepare(`SELECT COUNT(*) AS n, IFNULL(SUM(custo_banco_centavos), 0) AS v FROM repasses
    WHERE situacao IN ('enviado','confirmado') AND date(criado_em, '-3 hours') BETWEEN ? AND ?`).get(de, ate);
  const custoBanco = reg.v + liq.v + pix.v;

  const ppm = impostoPpm(db);
  const impostos = Math.round((Math.max(0, receita) * ppm) / 1_000_000);
  const margem = receita - impostos - custoBanco;

  const despesas = despesasDoMes(db, mes);
  const porCategoria = Object.entries(CATEGORIAS)
    .map(([id, rotulo]) => ({ id, rotulo, valor_centavos: despesas.filter((d) => d.categoria === id).reduce((s, d) => s + d.valor_centavos, 0) }))
    .filter((c) => c.valor_centavos > 0);
  const totalDespesas = porCategoria.reduce((s, c) => s + c.valor_centavos, 0);
  const lucro = margem - totalDespesas;

  // Ponto de equilíbrio: quantos boletos pagos no mês cobrem as despesas, pela margem média de cada um.
  const margemPorBoleto = liq.n ? Math.round(margem / liq.n) : null;
  const boletosNecessarios = margemPorBoleto && margemPorBoleto > 0 ? Math.ceil(totalDespesas / margemPorBoleto) : null;

  return {
    mes, de, ate,
    receita: { ...r, total: receita },
    impostos: { ppm, valor: impostos },
    custo_banco: {
      registro: { quantidade: reg.n, valor: reg.v },
      liquidacao: { quantidade: liq.n, valor: liq.v },
      pix: { quantidade: pix.n, valor: pix.v },
      total: custoBanco,
    },
    margem_contribuicao: margem,
    despesas: { por_categoria: porCategoria, total: totalDespesas },
    lucro,
    margem_lucro_ppm: receita > 0 ? Math.round((lucro / receita) * 1_000_000) : null,
    equilibrio: { boletos_liquidados: liq.n, margem_por_boleto: margemPorBoleto, boletos_necessarios: boletosNecessarios },
  };
}

/** Os últimos `n` meses até `mes`, do mais antigo ao mais recente. */
function historico(db, mes, n = 6) {
  return Array.from({ length: n }, (_, i) => somarMeses(mes, i - n + 1)).map((m) => {
    const d = doMes(db, m);
    return { mes: m, receita: d.receita.total, custos: d.impostos.valor + d.custo_banco.total, despesas: d.despesas.total, lucro: d.lucro };
  });
}

module.exports = { CATEGORIAS, doMes, historico, despesasDoMes, impostoPpm, gravarImposto, mesValido, somarMeses };
