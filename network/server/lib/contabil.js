'use strict';

const { agora, transacao, proximoNumero } = require('../db');
const { ErroNegocio } = require('./erros');

/*
 * Contabilidade em partidas dobradas.
 *
 * Três regras valem para tudo aqui, e nenhuma é negociável:
 *
 * 1. TODO lançamento fecha. A soma dos débitos é igual à soma dos créditos, conferida antes de gravar.
 *    Um lançamento desbalanceado não é "quase certo": é um balancete que nunca mais vai fechar, e o erro
 *    só aparece meses depois, quando ninguém lembra de onde veio.
 *
 * 2. NADA é apagado. Errou, estorna — e o estorno é outro lançamento, que aponta para o original e é
 *    apontado por ele. O histórico da contabilidade é a prova do que aconteceu; apagar linha é destruir
 *    a prova.
 *
 * 3. Competência FECHADA não muda. Depois de fechado o mês, nem lançamento novo nem estorno entram nele.
 *    O que precisa ser corrigido entra na competência aberta, como todo ajuste contábil de verdade.
 */

const TIPOS = ['ativo', 'passivo', 'patrimonio', 'receita', 'despesa'];
// A natureza decide o sinal do saldo: devedora soma débito e abate crédito; credora, o contrário.
const NATUREZA = { ativo: 'devedora', despesa: 'devedora', passivo: 'credora', patrimonio: 'credora', receita: 'credora' };
const DE_RESULTADO = new Set(['receita', 'despesa']);

const competenciaValida = (c) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c ?? ''));
const competenciaDe = (data) => String(data ?? '').slice(0, 7);

/* ---------------- Plano de contas ---------------- */

const conta = (db, org, id) => db.prepare('SELECT * FROM plano_contas WHERE id = ? AND organizacao_id = ?').get(Number(id), org);

/** O código manda na hierarquia: "1.1.01" é filha de "1.1", que é filha de "1". */
function paiDoCodigo(db, org, codigo) {
  const partes = String(codigo).split('.');
  if (partes.length < 2) return null;
  const pai = db.prepare('SELECT * FROM plano_contas WHERE organizacao_id = ? AND codigo = ?').get(org, partes.slice(0, -1).join('.'));
  if (!pai) throw new ErroNegocio(`Para criar a conta ${codigo}, a conta ${partes.slice(0, -1).join('.')} precisa existir antes.`, 422);
  return pai;
}

function criarConta(db, { org, codigo, nome, tipo, analitica = true, observacoes = null, usuarioId = null }) {
  if (!/^\d+(\.\d+)*$/.test(String(codigo ?? ''))) throw new ErroNegocio('Código de conta inválido: use números separados por ponto, como 1.1.01.', 422);
  if (!TIPOS.includes(tipo)) throw new ErroNegocio(`Tipo de conta inválido: ${tipo}.`, 422);
  const pai = paiDoCodigo(db, org, codigo);
  if (pai && pai.tipo !== tipo) throw new ErroNegocio(`A conta ${codigo} é ${tipo}, mas a conta mãe ${pai.codigo} é ${pai.tipo}.`, 422);
  if (pai && pai.analitica) {
    // Conta que já recebeu lançamento não pode virar sintética: os valores dela ficariam órfãos no balancete.
    const usada = db.prepare('SELECT 1 FROM partidas WHERE conta_id = ? LIMIT 1').get(pai.id);
    if (usada) throw new ErroNegocio(`A conta ${pai.codigo} já tem lançamentos e por isso não pode ganhar contas filhas.`, 422);
    db.prepare('UPDATE plano_contas SET analitica = 0, versao = versao + 1 WHERE id = ?').run(pai.id);
  }
  const id = Number(db.prepare(`INSERT INTO plano_contas (organizacao_id, codigo, nome, tipo, natureza, pai_id, nivel, analitica, resultado, observacoes, criado_por, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(org, String(codigo), nome, tipo, NATUREZA[tipo], pai?.id ?? null, String(codigo).split('.').length,
      analitica ? 1 : 0, DE_RESULTADO.has(tipo) ? 1 : 0, observacoes, usuarioId, agora()).lastInsertRowid);
  return db.prepare('SELECT * FROM plano_contas WHERE id = ?').get(id);
}

/**
 * Plano de contas padrão para provedor de internet.
 *
 * É um ponto de partida, não uma verdade: cada contador tem o seu, e o regime tributário muda o que faz
 * sentido. Serve para a operação não começar de uma tela em branco — e cada conta pode ser renomeada,
 * desativada ou ter filhas antes do primeiro lançamento.
 */
const PLANO_PADRAO = [
  ['1', 'ATIVO', 'ativo'],
  ['1.1', 'Ativo circulante', 'ativo'],
  ['1.1.01', 'Caixa', 'ativo'],
  ['1.1.02', 'Bancos conta movimento', 'ativo'],
  ['1.1.03', 'Clientes a receber', 'ativo'],
  ['1.1.04', 'Adiantamentos a fornecedores', 'ativo'],
  ['1.1.05', 'Tributos a recuperar', 'ativo'],
  ['1.2', 'Ativo não circulante', 'ativo'],
  ['1.2.01', 'Rede óptica e equipamentos', 'ativo'],
  ['1.2.02', 'Veículos', 'ativo'],
  ['1.2.03', 'Depreciação acumulada', 'ativo'],
  ['2', 'PASSIVO', 'passivo'],
  ['2.1', 'Passivo circulante', 'passivo'],
  ['2.1.01', 'Fornecedores', 'passivo'],
  ['2.1.02', 'Salários e encargos a pagar', 'passivo'],
  ['2.1.03', 'FGTS a recolher', 'passivo'],
  ['2.1.04', 'INSS a recolher', 'passivo'],
  ['2.1.05', 'Tributos sobre o faturamento a recolher', 'passivo'],
  ['2.1.06', 'Empréstimos e financiamentos', 'passivo'],
  ['3', 'PATRIMÔNIO LÍQUIDO', 'patrimonio'],
  ['3.1', 'Capital social', 'patrimonio'],
  ['3.2', 'Lucros ou prejuízos acumulados', 'patrimonio'],
  ['4', 'RECEITAS', 'receita'],
  ['4.1', 'Receita de serviços', 'receita'],
  ['4.1.01', 'Mensalidades de internet', 'receita'],
  ['4.1.02', 'Instalação e ativação', 'receita'],
  ['4.1.03', 'Serviços adicionais (SVA)', 'receita'],
  ['4.1.04', 'Aluguel de equipamento', 'receita'],
  ['4.1.05', 'Outros serviços', 'receita'],
  ['4.2', 'Outras receitas', 'receita'],
  ['4.2.01', 'Juros e multas recebidos', 'receita'],
  ['4.3', 'Deduções da receita', 'receita'],
  ['4.3.01', 'Descontos concedidos', 'receita'],
  ['4.3.02', 'Cancelamentos', 'receita'],
  ['5', 'DESPESAS', 'despesa'],
  ['5.1', 'Custo do serviço prestado', 'despesa'],
  ['5.1.01', 'Link de internet (trânsito IP)', 'despesa'],
  ['5.1.02', 'Manutenção de rede', 'despesa'],
  ['5.1.03', 'Materiais de instalação', 'despesa'],
  ['5.2', 'Despesas com pessoal', 'despesa'],
  ['5.2.01', 'Salários', 'despesa'],
  ['5.2.02', 'FGTS', 'despesa'],
  ['5.2.03', 'INSS patronal', 'despesa'],
  ['5.2.04', 'Benefícios', 'despesa'],
  ['5.3', 'Despesas administrativas', 'despesa'],
  ['5.3.01', 'Aluguel e condomínio', 'despesa'],
  ['5.3.02', 'Energia elétrica', 'despesa'],
  ['5.3.03', 'Software e licenças', 'despesa'],
  ['5.3.04', 'Honorários contábeis', 'despesa'],
  ['5.4', 'Despesas com frota', 'despesa'],
  ['5.4.01', 'Combustível', 'despesa'],
  ['5.4.02', 'Manutenção de veículos', 'despesa'],
  ['5.5', 'Despesas tributárias', 'despesa'],
  ['5.5.01', 'Tributos sobre o faturamento', 'despesa'],
  ['5.6', 'Despesas financeiras', 'despesa'],
  ['5.6.01', 'Tarifas bancárias', 'despesa'],
  ['5.6.02', 'Juros pagos', 'despesa'],
];

/** Chaves que a contabilização automática procura, e a conta do plano padrão que serve para cada uma. */
const PADRAO_CONTAS = {
  clientes: '1.1.03',
  caixa: '1.1.01',
  banco: '1.1.02',
  receita_mensalidade: '4.1.01',
  receita_instalacao: '4.1.02',
  receita_sva: '4.1.03',
  receita_equipamento: '4.1.04',
  receita_outros: '4.1.05',
  juros_recebidos: '4.2.01',
  descontos_concedidos: '4.3.01',
  cancelamentos: '4.3.02',
};

function criarPlanoPadrao(db, org, usuarioId = null) {
  const existe = db.prepare('SELECT COUNT(*) AS n FROM plano_contas WHERE organizacao_id = ?').get(org).n;
  if (existe) throw new ErroNegocio('Esta organização já tem plano de contas. O padrão só serve para começar do zero.', 422);
  return transacao(db, () => {
    for (const [codigo, nome, tipo] of PLANO_PADRAO) {
      criarConta(db, { org, codigo, nome, tipo: tipo ?? 'despesa', usuarioId });
    }
    const t = agora();
    for (const [chave, codigo] of Object.entries(PADRAO_CONTAS)) {
      const c = db.prepare('SELECT id FROM plano_contas WHERE organizacao_id = ? AND codigo = ?').get(org, codigo);
      if (c) db.prepare('INSERT INTO contas_padrao (organizacao_id, chave, conta_id, definido_por, definido_em) VALUES (?, ?, ?, ?, ?)').run(org, chave, c.id, usuarioId, t);
    }
    return { contas: PLANO_PADRAO.length, mapeadas: Object.keys(PADRAO_CONTAS).length };
  });
}

const contaPadrao = (db, org, chave) => db.prepare(`SELECT p.* FROM contas_padrao cp JOIN plano_contas p ON p.id = cp.conta_id
  WHERE cp.organizacao_id = ? AND cp.chave = ?`).get(org, chave) ?? null;

/* ---------------- Fechamento ---------------- */

const fechamentoDe = (db, org, competencia) =>
  db.prepare('SELECT * FROM fechamentos WHERE organizacao_id = ? AND competencia = ?').get(org, competencia) ?? null;

function exigirAberta(db, org, competencia) {
  const f = fechamentoDe(db, org, competencia);
  if (f) {
    throw new ErroNegocio(`A competência ${competencia} está fechada desde ${f.fechado_em.slice(0, 10)}. `
      + 'Lance a correção na competência aberta, como ajuste — mexer em mês fechado invalidaria o que já foi entregue.', 422);
  }
}

/* ---------------- Lançamento ---------------- */

/**
 * Grava um lançamento. `partidas` é uma lista de { conta_id, tipo: 'D'|'C', valor_centavos, historico }.
 * Devolve o lançamento gravado, ou o que já existia quando `chave` repete (contabilização idempotente).
 */
function lancar(db, { org, data, competencia = null, historico, partidas, origem = 'manual', origemTipo = null, origemId = null, chave = null, usuarioId = null }) {
  const comp = competencia ?? competenciaDe(data);
  if (!competenciaValida(comp)) throw new ErroNegocio('Competência inválida (use AAAA-MM).', 422);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data ?? ''))) throw new ErroNegocio('Data do lançamento inválida (use AAAA-MM-DD).', 422);
  if (!historico || !String(historico).trim()) throw new ErroNegocio('Todo lançamento precisa de histórico: é por ele que alguém entende o que aconteceu.', 422);

  if (chave) {
    const jaFeito = db.prepare('SELECT * FROM lancamentos WHERE organizacao_id = ? AND chave = ?').get(org, chave);
    if (jaFeito) return { ...jaFeito, ja_existia: true };
  }
  exigirAberta(db, org, comp);

  const linhas = (Array.isArray(partidas) ? partidas : []).map((p) => ({
    conta_id: Number(p.conta_id),
    tipo: String(p.tipo ?? '').toUpperCase(),
    valor_centavos: Number(p.valor_centavos),
    historico: p.historico ?? null,
  }));
  if (linhas.length < 2) throw new ErroNegocio('Um lançamento precisa de pelo menos duas partidas: uma a débito e outra a crédito.', 422);

  let debito = 0;
  let credito = 0;
  for (const l of linhas) {
    if (!['D', 'C'].includes(l.tipo)) throw new ErroNegocio('Cada partida é débito (D) ou crédito (C).', 422);
    if (!Number.isSafeInteger(l.valor_centavos) || l.valor_centavos <= 0) throw new ErroNegocio('Valor de partida inválido: use centavos inteiros maiores que zero.', 422);
    const c = conta(db, org, l.conta_id);
    if (!c) throw new ErroNegocio('Conta contábil não encontrada.', 422);
    if (!c.ativa) throw new ErroNegocio(`A conta ${c.codigo} está desativada.`, 422);
    if (!c.analitica) throw new ErroNegocio(`A conta ${c.codigo} é sintética: ela totaliza as filhas e não recebe lançamento.`, 422);
    if (l.tipo === 'D') debito += l.valor_centavos;
    else credito += l.valor_centavos;
  }
  // A regra que sustenta tudo: se não fecha, não entra.
  if (debito !== credito) {
    throw new ErroNegocio(`O lançamento não fecha: débitos somam ${(debito / 100).toFixed(2)} e créditos somam ${(credito / 100).toFixed(2)}.`, 422);
  }

  const numero = proximoNumero(db, org, 'lancamento');
  const id = Number(db.prepare(`INSERT INTO lancamentos (organizacao_id, numero, data, competencia, historico, origem, origem_tipo, origem_id, chave, valor_centavos, criado_por, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(org, numero, data, comp, String(historico).trim(), origem, origemTipo, origemId, chave, debito, usuarioId, agora()).lastInsertRowid);
  const inserir = db.prepare('INSERT INTO partidas (lancamento_id, conta_id, tipo, valor_centavos, historico) VALUES (?, ?, ?, ?, ?)');
  for (const l of linhas) inserir.run(id, l.conta_id, l.tipo, l.valor_centavos, l.historico);
  return db.prepare('SELECT * FROM lancamentos WHERE id = ?').get(id);
}

/** Estorna invertendo as partidas. O original continua lá, apontando para o estorno e vice-versa. */
function estornar(db, { org, lancamentoId, motivo, data = null, usuarioId = null }) {
  const alvo = db.prepare('SELECT * FROM lancamentos WHERE id = ? AND organizacao_id = ?').get(Number(lancamentoId), org);
  if (!alvo) throw new ErroNegocio('Lançamento não encontrado.', 404);
  if (alvo.estornado_por_id) throw new ErroNegocio(`Este lançamento já foi estornado pelo lançamento ${alvo.estornado_por_id}.`, 422);
  if (alvo.estorna_id) throw new ErroNegocio('Este lançamento é um estorno: estornar o estorno só confundiria o histórico. Lance o ajuste que falta.', 422);
  if (!motivo || !String(motivo).trim()) throw new ErroNegocio('Informe o motivo do estorno.', 422);

  const quando = data ?? alvo.data;
  const comp = competenciaDe(quando);
  exigirAberta(db, org, comp);
  const partidas = db.prepare('SELECT * FROM partidas WHERE lancamento_id = ? ORDER BY id').all(alvo.id);

  return transacao(db, () => {
    const estorno = lancar(db, {
      org,
      data: quando,
      competencia: comp,
      historico: `Estorno do lançamento ${alvo.numero}: ${String(motivo).trim()}`,
      origem: 'estorno',
      origemTipo: 'lancamento',
      origemId: alvo.id,
      usuarioId,
      partidas: partidas.map((p) => ({ conta_id: p.conta_id, tipo: p.tipo === 'D' ? 'C' : 'D', valor_centavos: p.valor_centavos, historico: p.historico })),
    });
    db.prepare('UPDATE lancamentos SET estorna_id = ? WHERE id = ?').run(alvo.id, estorno.id);
    db.prepare('UPDATE lancamentos SET estornado_por_id = ?, motivo_estorno = ? WHERE id = ?').run(estorno.id, String(motivo).trim(), alvo.id);
    return db.prepare('SELECT * FROM lancamentos WHERE id = ?').get(estorno.id);
  });
}

const partidasDe = (db, lancamentoId) => db.prepare(`SELECT pa.*, p.codigo, p.nome AS conta_nome
  FROM partidas pa JOIN plano_contas p ON p.id = pa.conta_id WHERE pa.lancamento_id = ? ORDER BY pa.tipo DESC, pa.id`).all(lancamentoId);

/* ---------------- Saldos e relatórios ---------------- */

const sinal = (natureza, debito, credito) => (natureza === 'devedora' ? debito - credito : credito - debito);

/**
 * Movimento por conta num intervalo de competências, com o saldo anterior.
 * Conta sintética recebe a soma das filhas: o lançamento só entra na analítica, mas o balancete totaliza.
 */
function saldos(db, org, { de, ate }) {
  const contas = db.prepare('SELECT * FROM plano_contas WHERE organizacao_id = ? ORDER BY codigo').all(org);
  const movimento = db.prepare(`SELECT pa.conta_id,
      SUM(CASE WHEN pa.tipo = 'D' THEN pa.valor_centavos ELSE 0 END) AS d,
      SUM(CASE WHEN pa.tipo = 'C' THEN pa.valor_centavos ELSE 0 END) AS c
    FROM partidas pa JOIN lancamentos l ON l.id = pa.lancamento_id
    WHERE l.organizacao_id = ? AND l.competencia >= ? AND l.competencia <= ? GROUP BY pa.conta_id`).all(org, de, ate);
  const anterior = db.prepare(`SELECT pa.conta_id,
      SUM(CASE WHEN pa.tipo = 'D' THEN pa.valor_centavos ELSE 0 END) AS d,
      SUM(CASE WHEN pa.tipo = 'C' THEN pa.valor_centavos ELSE 0 END) AS c
    FROM partidas pa JOIN lancamentos l ON l.id = pa.lancamento_id
    WHERE l.organizacao_id = ? AND l.competencia < ? GROUP BY pa.conta_id`).all(org, de);

  const mapa = new Map(contas.map((c) => [c.id, {
    ...c, debito: 0, credito: 0, debito_anterior: 0, credito_anterior: 0,
  }]));
  for (const m of movimento) { const x = mapa.get(m.conta_id); if (x) { x.debito = m.d; x.credito = m.c; } }
  for (const m of anterior) { const x = mapa.get(m.conta_id); if (x) { x.debito_anterior = m.d; x.credito_anterior = m.c; } }

  // Soma de baixo para cima: a filha some na mãe, e o código mais longo é sempre o mais fundo.
  const porNivel = [...mapa.values()].sort((a, b) => b.nivel - a.nivel);
  for (const c of porNivel) {
    if (!c.pai_id) continue;
    const pai = mapa.get(c.pai_id);
    if (!pai) continue;
    pai.debito += c.debito;
    pai.credito += c.credito;
    pai.debito_anterior += c.debito_anterior;
    pai.credito_anterior += c.credito_anterior;
  }
  for (const c of mapa.values()) {
    c.saldo_anterior_centavos = sinal(c.natureza, c.debito_anterior, c.credito_anterior);
    c.movimento_centavos = sinal(c.natureza, c.debito, c.credito);
    c.saldo_centavos = c.saldo_anterior_centavos + c.movimento_centavos;
  }
  return [...mapa.values()].sort((a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true }));
}

/** Balancete: toda conta com movimento ou saldo, mais a conferência de que débitos e créditos batem. */
function balancete(db, org, { de, ate, zerados = false }) {
  const linhas = saldos(db, org, { de, ate }).filter((c) => zerados || c.debito || c.credito || c.saldo_anterior_centavos);
  const analiticas = linhas.filter((c) => c.analitica);
  const totalD = analiticas.reduce((s, c) => s + c.debito, 0);
  const totalC = analiticas.reduce((s, c) => s + c.credito, 0);
  return {
    periodo: { de, ate },
    linhas,
    total_debito_centavos: totalD,
    total_credito_centavos: totalC,
    // Se isto não for zero, há lançamento desbalanceado no banco — o que "lancar" impede, mas o balancete confere de novo.
    diferenca_centavos: totalD - totalC,
    fecha: totalD === totalC,
  };
}

/**
 * DRE do período. Despesa aparece com sinal positivo (é despesa, não receita negativa) e o resultado é
 * receita líquida menos despesa.
 */
function dre(db, org, { de, ate }) {
  const linhas = saldos(db, org, { de, ate }).filter((c) => c.resultado);
  const movimento = (codigo) => linhas.find((c) => c.codigo === codigo)?.movimento_centavos ?? 0;
  const grupo = (prefixo) => linhas.filter((c) => c.codigo.startsWith(prefixo) && c.analitica && c.movimento_centavos !== 0)
    .map((c) => ({ codigo: c.codigo, nome: c.nome, valor_centavos: c.movimento_centavos }));

  const receitaServicos = movimento('4.1');
  const outrasReceitas = movimento('4.2');
  /*
   * Deduções (descontos concedidos, cancelamentos) ficam sob "receita" no plano, de natureza credora,
   * mas são lançadas a DÉBITO — o movimento sai negativo. Sem inverter aqui, subtrair um número negativo
   * AUMENTARIA a receita líquida: o desconto dado ao assinante viraria receita a mais.
   */
  const deducoes = -movimento('4.3');
  const receitaLiquida = receitaServicos + outrasReceitas - deducoes;
  const custo = movimento('5.1');
  const despesas = movimento('5') - custo;
  const resultado = receitaLiquida - custo - despesas;

  return {
    periodo: { de, ate },
    receita_servicos_centavos: receitaServicos,
    outras_receitas_centavos: outrasReceitas,
    deducoes_centavos: deducoes,
    receita_liquida_centavos: receitaLiquida,
    custo_servico_centavos: custo,
    lucro_bruto_centavos: receitaLiquida - custo,
    despesas_centavos: despesas,
    resultado_centavos: resultado,
    // A margem só existe se houve receita: dividir por zero daria um número que não quer dizer nada.
    margem_pct: receitaLiquida > 0 ? Math.round((resultado / receitaLiquida) * 10000) / 100 : null,
    detalhe: {
      receitas: grupo('4'),
      custos: grupo('5.1'),
      despesas: grupo('5').filter((x) => !x.codigo.startsWith('5.1')),
    },
  };
}

/** Razão de uma conta: lançamento a lançamento, com o saldo correndo. */
function razao(db, org, contaId, { de, ate }) {
  const c = conta(db, org, contaId);
  if (!c) throw new ErroNegocio('Conta contábil não encontrada.', 404);
  const antes = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN pa.tipo = 'D' THEN pa.valor_centavos ELSE 0 END), 0) AS d,
      COALESCE(SUM(CASE WHEN pa.tipo = 'C' THEN pa.valor_centavos ELSE 0 END), 0) AS c
    FROM partidas pa JOIN lancamentos l ON l.id = pa.lancamento_id
    WHERE pa.conta_id = ? AND l.competencia < ?`).get(c.id, de);
  let saldo = sinal(c.natureza, antes.d, antes.c);
  const abertura = saldo;

  const linhas = db.prepare(`SELECT pa.tipo, pa.valor_centavos, pa.historico AS partida_historico,
      l.id AS lancamento_id, l.numero, l.data, l.competencia, l.historico, l.origem, l.estorna_id, l.estornado_por_id
    FROM partidas pa JOIN lancamentos l ON l.id = pa.lancamento_id
    WHERE pa.conta_id = ? AND l.competencia >= ? AND l.competencia <= ?
    ORDER BY l.data, l.numero, pa.id`).all(c.id, de, ate).map((x) => {
    saldo += sinal(c.natureza, x.tipo === 'D' ? x.valor_centavos : 0, x.tipo === 'C' ? x.valor_centavos : 0);
    return { ...x, saldo_centavos: saldo };
  });
  return { conta: c, periodo: { de, ate }, saldo_anterior_centavos: abertura, linhas, saldo_centavos: saldo };
}

/* ---------------- Planejamento (orçado × realizado) ---------------- */

function orcadoRealizado(db, org, { de, ate }) {
  const linhas = saldos(db, org, { de, ate });
  const orcado = db.prepare(`SELECT conta_id, SUM(valor_centavos) AS v FROM orcamento
    WHERE organizacao_id = ? AND competencia >= ? AND competencia <= ? GROUP BY conta_id`).all(org, de, ate);
  const mapa = new Map(orcado.map((o) => [o.conta_id, o.v]));
  const itens = linhas
    .filter((c) => c.resultado && (mapa.has(c.id) || c.movimento_centavos))
    .map((c) => {
      const prev = mapa.get(c.id) ?? 0;
      const real = c.movimento_centavos;
      return {
        conta_id: c.id, codigo: c.codigo, nome: c.nome, tipo: c.tipo, analitica: Boolean(c.analitica),
        orcado_centavos: prev,
        realizado_centavos: real,
        diferenca_centavos: real - prev,
        // Receita abaixo do previsto e despesa acima do previsto são os dois casos ruins.
        desfavoravel: c.tipo === 'receita' ? real < prev : real > prev,
        pct: prev ? Math.round((real / prev) * 10000) / 100 : null,
      };
    });
  return {
    periodo: { de, ate },
    itens,
    sem_orcamento: itens.filter((x) => x.analitica && !x.orcado_centavos).length,
    orcado_centavos: itens.filter((x) => x.analitica).reduce((s, x) => s + x.orcado_centavos, 0),
    realizado_centavos: itens.filter((x) => x.analitica).reduce((s, x) => s + x.realizado_centavos, 0),
  };
}

/* ---------------- Fechamento de competência ---------------- */

function fechar(db, { org, competencia, observacoes = null, usuarioId = null }) {
  if (!competenciaValida(competencia)) throw new ErroNegocio('Competência inválida (use AAAA-MM).', 422);
  if (fechamentoDe(db, org, competencia)) throw new ErroNegocio(`A competência ${competencia} já está fechada.`, 422);
  const conf = balancete(db, org, { de: competencia, ate: competencia });
  if (!conf.fecha) {
    throw new ErroNegocio(`Não dá para fechar ${competencia}: o balancete tem diferença de ${(conf.diferenca_centavos / 100).toFixed(2)}. `
      + 'Fechar com diferença seria carimbar um erro.', 422);
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM lancamentos WHERE organizacao_id = ? AND competencia = ?').get(org, competencia).n;
  db.prepare('INSERT INTO fechamentos (organizacao_id, competencia, fechado_em, fechado_por, lancamentos, observacoes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(org, competencia, agora(), usuarioId, n, observacoes);
  return { competencia, lancamentos: n };
}

function reabrir(db, { org, competencia, motivo, usuarioId = null }) {
  const f = fechamentoDe(db, org, competencia);
  if (!f) throw new ErroNegocio(`A competência ${competencia} não está fechada.`, 422);
  if (!motivo || !String(motivo).trim()) throw new ErroNegocio('Informe o motivo da reabertura.', 422);
  db.prepare('DELETE FROM fechamentos WHERE id = ?').run(f.id);
  return { competencia, fechado_em: f.fechado_em, motivo: String(motivo).trim(), usuarioId };
}

module.exports = {
  TIPOS, NATUREZA, PLANO_PADRAO, PADRAO_CONTAS, competenciaValida, competenciaDe,
  conta, criarConta, criarPlanoPadrao, contaPadrao, lancar, estornar, partidasDe,
  saldos, balancete, dre, razao, orcadoRealizado, fechar, reabrir, fechamentoDe, exigirAberta,
};
