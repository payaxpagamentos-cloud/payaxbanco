'use strict';

const { GRUPOS_DRE, GRUPO } = require('./plano-contas');
const { meses, hoje, mes, somarDias } = require('./datas');
const v = require('./validacao');

function periodo(de, ate) {
  v.data(de, 'a data inicial');
  v.data(ate, 'a data final');
  v.exigir(de <= ate, 'A data inicial deve ser anterior à final.');
  v.exigir(meses(de, ate).length <= 36, 'Período máximo de 36 meses.');
}

const zeros = (chaves) => Object.fromEntries(chaves.map((k) => [k, 0]));
const total = (valores) => Object.values(valores).reduce((a, n) => a + n, 0);

/** Lista de períodos (dias ou meses) e a função que leva uma data ao seu período. */
function eixo(de, ate, agrupar) {
  if (agrupar === 'dia') {
    const dias = [];
    for (let d = de; d <= ate; d = somarDias(d, 1)) dias.push(d);
    v.exigir(dias.length <= 92, 'No fluxo diário, o período máximo é de 92 dias.');
    return { chaves: dias, chave: (d) => d };
  }
  return { chaves: meses(de, ate), chave: mes };
}

/**
 * Fluxo de caixa: realizado (movimentos das contas) e previsto (contas em aberto pelo vencimento).
 * Contas vencidas e não pagas entram como previstas para hoje. Transferências entre contas da empresa
 * só aparecem quando o fluxo é de uma conta específica.
 */
function fluxoCaixa(db, empresaId, { de, ate, agrupar = 'mes', conta_bancaria_id: contaId } = {}) {
  periodo(de, ate);
  const { chaves, chave } = eixo(de, ate, agrupar);
  const dia = hoje();
  const filtroConta = contaId ? 'AND m.conta_bancaria_id = ?' : "AND m.origem <> 'transferencia'";
  const pConta = contaId ? [Number(contaId)] : [];

  const saldoInicial = db.prepare(`SELECT COALESCE(SUM(saldo_inicial_centavos), 0) AS s FROM contas_bancarias WHERE empresa_id = ? ${contaId ? 'AND id = ?' : ''}`).get(empresaId, ...pConta).s
    + db.prepare(`SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM movimentos m WHERE m.empresa_id = ? AND m.data < ? ${contaId ? 'AND m.conta_bancaria_id = ?' : ''}`).get(empresaId, de, ...pConta).s;

  const realizados = db.prepare(`SELECT m.data, m.valor_centavos, m.origem, c.id AS categoria_id, c.nome AS categoria, c.tipo AS categoria_tipo
    FROM movimentos m LEFT JOIN lancamentos l ON l.id = m.lancamento_id LEFT JOIN categorias c ON c.id = l.categoria_id
    WHERE m.empresa_id = ? AND m.data BETWEEN ? AND ? ${filtroConta}`).all(empresaId, de, ate, ...pConta);

  // Em aberto: o vencido conta para hoje (se hoje está no período); o resto, pelo vencimento.
  const abertos = db.prepare(`SELECT l.tipo, l.valor_centavos, l.vencimento, c.id AS categoria_id, c.nome AS categoria, c.tipo AS categoria_tipo
    FROM lancamentos l LEFT JOIN categorias c ON c.id = l.categoria_id
    WHERE l.empresa_id = ? AND l.status = 'aberto' AND l.vencimento <= ? ${contaId ? 'AND (l.conta_bancaria_id = ? OR l.conta_bancaria_id IS NULL)' : ''}`)
    .all(empresaId, ate, ...pConta)
    .map((l) => ({ ...l, data: l.vencimento < dia ? dia : l.vencimento, atrasado: l.vencimento < dia }))
    .filter((l) => l.data >= de && l.data <= ate);

  const linhas = chaves.map((k) => ({ periodo: k, entradas_realizadas: 0, saidas_realizadas: 0, entradas_previstas: 0, saidas_previstas: 0, atrasados: 0 }));
  const idx = Object.fromEntries(chaves.map((k, i) => [k, i]));
  const categorias = new Map();
  const somarCategoria = (id, nome, tipo, k, valor) => {
    const chaveCat = id ?? `sem:${nome}`;
    if (!categorias.has(chaveCat)) categorias.set(chaveCat, { categoria_id: id, nome, tipo, valores: zeros(chaves) });
    categorias.get(chaveCat).valores[k] += valor;
  };

  for (const m of realizados) {
    const k = chave(m.data);
    const linha = linhas[idx[k]];
    if (m.valor_centavos > 0) linha.entradas_realizadas += m.valor_centavos; else linha.saidas_realizadas -= m.valor_centavos;
    const nome = m.categoria ?? (m.origem === 'transferencia' ? 'Transferências entre contas' : 'Ajustes de saldo');
    somarCategoria(m.categoria_id, nome, m.categoria_tipo ?? (m.valor_centavos > 0 ? 'receita' : 'despesa'), k, m.valor_centavos);
  }
  for (const l of abertos) {
    const k = chave(l.data);
    const linha = linhas[idx[k]];
    if (l.tipo === 'receber') linha.entradas_previstas += l.valor_centavos; else linha.saidas_previstas += l.valor_centavos;
    if (l.atrasado) linha.atrasados += l.tipo === 'receber' ? l.valor_centavos : -l.valor_centavos;
    somarCategoria(l.categoria_id, l.categoria ?? 'Sem categoria', l.categoria_tipo, k, l.tipo === 'receber' ? l.valor_centavos : -l.valor_centavos);
  }

  let saldo = saldoInicial;
  for (const l of linhas) {
    l.saldo_inicial = saldo;
    l.resultado = l.entradas_realizadas - l.saidas_realizadas + l.entradas_previstas - l.saidas_previstas;
    saldo += l.resultado;
    l.saldo_final = saldo;
  }
  const porCategoria = [...categorias.values()]
    .map((c) => ({ ...c, total: total(c.valores) }))
    .sort((a, b) => (a.tipo === b.tipo ? Math.abs(b.total) - Math.abs(a.total) : a.tipo === 'receita' ? -1 : 1));
  return { de, ate, agrupar, hoje: dia, saldo_inicial: saldoInicial, saldo_final: saldo, periodos: linhas, categorias: porCategoria };
}

/**
 * DRE gerencial. Competência: pela data de competência dos lançamentos não cancelados. Caixa: pela
 * data da baixa. Juros e descontos das baixas entram no resultado financeiro, pela data da baixa.
 */
function dre(db, empresaId, { de, ate, regime = 'competencia', centro_custo_id: centro } = {}) {
  periodo(de, ate);
  v.exigir(['competencia', 'caixa'].includes(regime), 'Regime deve ser competência ou caixa.');
  const colunas = meses(de, ate);
  // Com filtro de centro de custo, um lançamento rateado entra só com o percentual daquele centro.
  const peso = centro ? 'COALESCE(r.percentual, 10000)' : '10000';
  const juntarRateio = centro ? 'LEFT JOIN rateios r ON r.lancamento_id = l.id AND r.centro_custo_id = ?' : '';
  const filtroCentro = centro ? 'AND (l.centro_custo_id = ? OR r.percentual IS NOT NULL)' : '';
  const pJunta = centro ? [Number(centro)] : [];
  const pCentro = centro ? [Number(centro)] : [];
  const campoData = regime === 'caixa' ? 'l.pago_em' : 'l.competencia';
  const condicao = regime === 'caixa' ? "l.status = 'pago'" : "l.status <> 'cancelado'";
  const ponderar = (x, campos) => (centro ? { ...x, ...Object.fromEntries(campos.map((c) => [c, Math.round((x[c] * x.peso) / 10000)])) } : x);

  const principais = db.prepare(`SELECT ${campoData} AS data, l.valor_centavos, ${peso} AS peso, c.id AS categoria_id, c.nome AS categoria, c.tipo AS categoria_tipo, c.grupo_dre
    FROM lancamentos l JOIN categorias c ON c.id = l.categoria_id ${juntarRateio}
    WHERE l.empresa_id = ? AND ${condicao} AND ${campoData} BETWEEN ? AND ? ${filtroCentro}`).all(...pJunta, empresaId, de, ate, ...pCentro)
    .map((x) => ponderar(x, ['valor_centavos']));
  const baixas = db.prepare(`SELECT l.pago_em AS data, l.tipo, l.juros_centavos, l.desconto_centavos, ${peso} AS peso FROM lancamentos l ${juntarRateio}
    WHERE l.empresa_id = ? AND l.status = 'pago' AND l.pago_em BETWEEN ? AND ? AND (l.juros_centavos > 0 OR l.desconto_centavos > 0) ${filtroCentro}`)
    .all(...pJunta, empresaId, de, ate, ...pCentro).map((x) => ponderar(x, ['juros_centavos', 'desconto_centavos']));

  const grupos = Object.fromEntries(GRUPOS_DRE.map((g) => [g.chave, { ...g, valores: zeros(colunas), categorias: new Map() }]));
  const somar = (grupo, nomeCat, idCat, data, valor) => {
    const g = grupos[grupo];
    const k = mes(data);
    g.valores[k] += valor;
    const ch = idCat ?? `v:${nomeCat}`;
    if (!g.categorias.has(ch)) g.categorias.set(ch, { categoria_id: idCat, nome: nomeCat, valores: zeros(colunas) });
    g.categorias.get(ch).valores[k] += valor;
  };
  for (const p of principais) {
    // Fora da DRE: entradas positivas e saídas negativas, para mostrar o efeito no caixa.
    const valor = p.grupo_dre === 'fora_dre' && p.categoria_tipo === 'despesa' ? -p.valor_centavos : p.valor_centavos;
    somar(GRUPO[p.grupo_dre] ? p.grupo_dre : 'outras_despesas', p.categoria, p.categoria_id, p.data, valor);
  }
  for (const b of baixas) {
    if (b.tipo === 'pagar') {
      if (b.juros_centavos) somar('despesas_financeiras', 'Juros e multas pagos (baixas)', null, b.data, b.juros_centavos);
      if (b.desconto_centavos) somar('receitas_financeiras', 'Descontos obtidos (baixas)', null, b.data, b.desconto_centavos);
    } else {
      if (b.juros_centavos) somar('receitas_financeiras', 'Juros recebidos (baixas)', null, b.data, b.juros_centavos);
      if (b.desconto_centavos) somar('despesas_financeiras', 'Descontos concedidos (baixas)', null, b.data, b.desconto_centavos);
    }
  }

  const val = (chave) => grupos[chave].valores;
  const combinar = (...partes) => Object.fromEntries(colunas.map((k) => [k, partes.reduce((a, [s, vals]) => a + s * vals[k], 0)]));
  const receitaLiquida = combinar([1, val('receita_bruta')], [-1, val('deducoes')]);
  const lucroBruto = combinar([1, receitaLiquida], [-1, val('custos')]);
  const operacional = combinar([1, lucroBruto], [-1, val('despesas_operacionais')]);
  const antesIr = combinar([1, operacional], [1, val('receitas_financeiras')], [-1, val('despesas_financeiras')], [1, val('outras_receitas')], [-1, val('outras_despesas')]);
  const liquido = combinar([1, antesIr], [-1, val('impostos_lucro')]);

  const grupo = (chave) => {
    const g = grupos[chave];
    return {
      tipo: 'grupo', chave, rotulo: g.rotulo, sinal: g.sinal, valores: g.valores, total: total(g.valores),
      categorias: [...g.categorias.values()].map((c) => ({ ...c, total: total(c.valores) })).sort((a, b) => b.total - a.total),
    };
  };
  const subtotal = (rotulo, valores, destaque = false) => ({ tipo: 'subtotal', rotulo, valores, total: total(valores), destaque });
  const linhas = [
    grupo('receita_bruta'), grupo('deducoes'), subtotal('Receita líquida', receitaLiquida),
    grupo('custos'), subtotal('Lucro bruto', lucroBruto),
    grupo('despesas_operacionais'), subtotal('Resultado operacional', operacional),
    grupo('receitas_financeiras'), grupo('despesas_financeiras'), grupo('outras_receitas'), grupo('outras_despesas'),
    subtotal('Resultado antes do IRPJ/CSLL', antesIr),
    grupo('impostos_lucro'), subtotal('Lucro líquido', liquido, true),
  ];
  const receitaBruta = total(val('receita_bruta'));
  const pct = (n) => (receitaBruta ? n / receitaBruta : null);
  return {
    de, ate, regime, meses: colunas, linhas,
    fora_dre: grupo('fora_dre'),
    indicadores: {
      receita_bruta: receitaBruta,
      margem_bruta: pct(total(lucroBruto)),
      margem_operacional: pct(total(operacional)),
      margem_liquida: pct(total(liquido)),
      lucro_liquido: total(liquido),
    },
  };
}

/**
 * Resultado por centro de custo (departamento, unidade, projeto): receitas, despesas e resultado do
 * período, já com os rateios aplicados. Itens fora da DRE não entram.
 */
function porCentro(db, empresaId, { de, ate, regime = 'competencia' } = {}) {
  periodo(de, ate);
  const campoData = regime === 'caixa' ? 'l.pago_em' : 'l.competencia';
  const condicao = regime === 'caixa' ? "l.status = 'pago'" : "l.status <> 'cancelado'";
  const linhas = db.prepare(`
    WITH base AS (
      SELECT l.id, l.valor_centavos, c.tipo, l.centro_custo_id FROM lancamentos l JOIN categorias c ON c.id = l.categoria_id
      WHERE l.empresa_id = ? AND ${condicao} AND ${campoData} BETWEEN ? AND ? AND c.grupo_dre <> 'fora_dre'
    ),
    partes AS (
      SELECT r.centro_custo_id AS centro, b.tipo, b.valor_centavos * r.percentual / 10000.0 AS valor FROM base b JOIN rateios r ON r.lancamento_id = b.id
      UNION ALL
      SELECT b.centro_custo_id, b.tipo, b.valor_centavos FROM base b WHERE NOT EXISTS (SELECT 1 FROM rateios r WHERE r.lancamento_id = b.id)
    )
    SELECT p.centro AS centro_custo_id, COALESCE(cc.nome, 'Sem centro de custo') AS nome,
      ROUND(SUM(CASE WHEN p.tipo = 'receita' THEN p.valor ELSE 0 END)) AS receitas_centavos,
      ROUND(SUM(CASE WHEN p.tipo = 'despesa' THEN p.valor ELSE 0 END)) AS despesas_centavos
    FROM partes p LEFT JOIN centros_custo cc ON cc.id = p.centro GROUP BY p.centro ORDER BY cc.nome IS NULL, cc.nome`).all(empresaId, de, ate)
    .map((l) => ({ ...l, resultado_centavos: l.receitas_centavos - l.despesas_centavos }));
  return { de, ate, regime, linhas };
}

module.exports = { fluxoCaixa, dre, porCentro };
