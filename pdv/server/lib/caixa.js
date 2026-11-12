'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hoje } = require('./datas');
const { FORMAS } = require('./ixcEmpresa');
const { SUPERVISAO } = require('../auth');
const v = require('./validacao');

/** Caixa aberto do operador (um operador só tem um caixa aberto por vez). */
const caixaDoOperador = (db, empresaId, operadorId) =>
  db.prepare("SELECT * FROM caixas WHERE empresa_id = ? AND operador_id = ? AND status = 'aberto'").get(empresaId, operadorId) ?? null;

const buscar = (db, empresaId, id) => {
  const c = db.prepare('SELECT * FROM caixas WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!c) throw naoEncontrado('Caixa');
  return c;
};

/** O operador só mexe no próprio caixa; supervisão vê e fecha qualquer um. */
function exigirAcesso(usuario, caixa) {
  if (!SUPERVISAO.includes(usuario.perfil) && caixa.operador_id !== usuario.id) throw new ErroNegocio('Este caixa é de outro operador.', 403);
}

/** Abre o caixa do operador num PDV, com o fundo de troco. */
function abrir(db, { empresa, usuario, pdvId, fundoCentavos = 0, observacao }) {
  return transacao(db, () => {
    if (caixaDoOperador(db, empresa.id, usuario.id)) throw new ErroNegocio('Você já tem um caixa aberto. Feche-o antes de abrir outro.', 409);
    const pdv = db.prepare('SELECT * FROM pdvs WHERE id = ? AND empresa_id = ?').get(Number(pdvId), empresa.id);
    if (!pdv) throw naoEncontrado('PDV');
    if (!pdv.ativo) throw new ErroNegocio('Este PDV está desativado.', 409);
    if (usuario.loja_id && usuario.loja_id !== pdv.loja_id) throw new ErroNegocio('Este PDV é de outra loja.', 403);
    if (db.prepare("SELECT 1 FROM caixas WHERE pdv_id = ? AND status = 'aberto'").get(pdv.id)) {
      throw new ErroNegocio('Já existe um caixa aberto neste PDV.', 409);
    }
    const r = db.prepare(`INSERT INTO caixas (empresa_id, loja_id, pdv_id, operador_id, status, data, fundo_centavos, aberto_em, observacao)
      VALUES (?, ?, ?, ?, 'aberto', ?, ?, ?, ?)`)
      .run(empresa.id, pdv.loja_id, pdv.id, usuario.id, hoje(), v.centavos(fundoCentavos, 'o fundo de troco', { min: 0 }), agora(), v.opcional(observacao, 'a observação', 300));
    return detalhe(db, empresa.id, Number(r.lastInsertRowid));
  });
}

/** Sangria (retirada) ou suprimento (reforço) do caixa aberto. */
function movimentar(db, { empresa, usuario, caixaId, tipo, valorCentavos, motivo }) {
  const caixa = buscar(db, empresa.id, caixaId);
  exigirAcesso(usuario, caixa);
  if (caixa.status !== 'aberto') throw new ErroNegocio('O caixa já foi fechado.', 409);
  v.opcao(tipo, 'o tipo', ['sangria', 'suprimento']);
  const valor = v.centavos(valorCentavos, 'o valor');
  if (tipo === 'sangria') {
    const r = resumo(db, caixa);
    if (valor > r.dinheiro_em_caixa_centavos) throw new ErroNegocio('A sangria é maior que o dinheiro em caixa.', 422);
  }
  db.prepare('INSERT INTO movimentos_caixa (caixa_id, tipo, valor_centavos, motivo, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(caixa.id, tipo, valor, v.opcional(motivo, 'o motivo', 200), usuario.id, agora());
  return detalhe(db, empresa.id, caixa.id);
}

/** Totais do caixa: recebido por forma de pagamento, sangrias, suprimentos e dinheiro esperado na gaveta. */
function resumo(db, caixa) {
  const porForma = Object.fromEntries(FORMAS.map((f) => [f, 0]));
  const linhas = db.prepare(`SELECT p.forma, COALESCE(SUM(p.valor_centavos), 0) AS total, COUNT(*) AS qtd
    FROM pagamentos p JOIN recebimentos r ON r.id = p.recebimento_id
    WHERE r.caixa_id = ? AND r.status = 'confirmado' GROUP BY p.forma`).all(caixa.id);
  for (const l of linhas) porForma[l.forma] = l.total;
  const m = db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo = 'sangria' THEN valor_centavos END), 0) AS sangrias,
      COALESCE(SUM(CASE WHEN tipo = 'suprimento' THEN valor_centavos END), 0) AS suprimentos FROM movimentos_caixa WHERE caixa_id = ?`).get(caixa.id);
  const totais = db.prepare(`SELECT COUNT(*) AS recebimentos, COALESCE(SUM(valor_centavos), 0) AS total,
      COALESCE(SUM(status = 'cancelado'), 0) AS cancelados FROM recebimentos WHERE caixa_id = ?`).get(caixa.id);
  const recebido = Object.values(porForma).reduce((a, b) => a + b, 0);
  return {
    por_forma: porForma,
    recebido_centavos: recebido,
    sangrias_centavos: m.sangrias,
    suprimentos_centavos: m.suprimentos,
    dinheiro_em_caixa_centavos: caixa.fundo_centavos + porForma.dinheiro + m.suprimentos - m.sangrias,
    esperado_centavos: caixa.fundo_centavos + recebido + m.suprimentos - m.sangrias,
    recebimentos: totais.recebimentos - totais.cancelados,
    cancelados: totais.cancelados,
  };
}

/** Caixa com o resumo, os movimentos e os recebimentos. */
function detalhe(db, empresaId, id) {
  const caixa = buscar(db, empresaId, id);
  const extra = db.prepare(`SELECT p.nome AS pdv_nome, l.nome AS loja_nome, u.nome AS operador_nome, f.nome AS fechado_por_nome
    FROM caixas c JOIN pdvs p ON p.id = c.pdv_id JOIN lojas l ON l.id = c.loja_id JOIN usuarios u ON u.id = c.operador_id
    LEFT JOIN usuarios f ON f.id = c.fechado_por WHERE c.id = ?`).get(id);
  const movimentos = db.prepare(`SELECT m.*, u.nome AS usuario_nome FROM movimentos_caixa m LEFT JOIN usuarios u ON u.id = m.usuario_id
    WHERE m.caixa_id = ? ORDER BY m.id`).all(id);
  const recebimentos = db.prepare(`SELECT id, numero, cliente_nome, valor_centavos, status, ixc_status, conferencia, criado_em
    FROM recebimentos WHERE caixa_id = ? ORDER BY id DESC`).all(id);
  return {
    ...caixa,
    ...extra,
    contagem: caixa.contagem ? JSON.parse(caixa.contagem) : null,
    resumo: resumo(db, caixa),
    movimentos,
    recebimentos,
  };
}

/**
 * Fecha o caixa com a contagem informada pelo operador (por forma de pagamento).
 * A diferença entre o contado e o esperado fica registrada e, quando existe, vira uma divergência para a conferência.
 */
function fechar(db, { empresa, usuario, caixaId, contagem = {}, observacao }) {
  return transacao(db, () => {
    const caixa = buscar(db, empresa.id, caixaId);
    exigirAcesso(usuario, caixa);
    if (caixa.status !== 'aberto') throw new ErroNegocio('Este caixa já foi fechado.', 409);
    const abertas = db.prepare("SELECT COUNT(*) AS n FROM transacoes_cartao WHERE caixa_id = ? AND status IN ('pendente','enviada')").get(caixa.id).n;
    if (abertas) throw new ErroNegocio('Há cobrança no cartão esperando a maquininha. Conclua ou cancele antes de fechar o caixa.', 409);

    const r = resumo(db, caixa);
    const contado = {};
    for (const f of FORMAS) contado[f] = contagem[f] === undefined || contagem[f] === null || contagem[f] === '' ? r.por_forma[f] : v.centavos(contagem[f], `o valor contado em ${f}`, { min: 0 });
    // Dinheiro é contado na gaveta (inclui fundo, suprimentos e sangrias); as demais formas são conferidas pelo total recebido.
    const esperado = { ...r.por_forma, dinheiro: r.dinheiro_em_caixa_centavos };
    const diferenca = FORMAS.reduce((soma, f) => soma + (contado[f] - esperado[f]), 0);
    const momento = agora();
    db.prepare(`UPDATE caixas SET status = 'fechado', fechado_em = ?, fechado_por = ?, contagem = ?, diferenca_centavos = ?, observacao = COALESCE(?, observacao)
      WHERE id = ?`).run(momento, usuario.id, JSON.stringify({ contado, esperado }), diferenca, v.opcional(observacao, 'a observação', 300), caixa.id);

    // Um caixa reaberto e fechado de novo substitui a divergência anterior, em vez de abrir outra.
    db.prepare("DELETE FROM divergencias WHERE caixa_id = ? AND tipo = 'caixa_diferenca' AND status = 'aberta'").run(caixa.id);
    if (diferenca !== 0) {
      db.prepare(`INSERT INTO divergencias (empresa_id, caixa_id, data, tipo, detalhes, valor_pdv_centavos, valor_ixc_centavos, criado_em)
        VALUES (?, ?, ?, 'caixa_diferenca', ?, ?, ?, ?)`)
        .run(empresa.id, caixa.id, caixa.data,
          `Caixa ${caixa.id} (${nomeDoPdv(db, caixa)}) fechado por ${usuario.nome} com diferença de ${(diferenca / 100).toFixed(2)}.`,
          Object.values(contado).reduce((a, b) => a + b, 0), Object.values(esperado).reduce((a, b) => a + b, 0), momento);
    }
    return detalhe(db, empresa.id, caixa.id);
  });
}

const nomeDoPdv = (db, caixa) => db.prepare('SELECT nome FROM pdvs WHERE id = ?').get(caixa.pdv_id)?.nome ?? `PDV ${caixa.pdv_id}`;

/** Supervisão marca o caixa como conferido (dinheiro recolhido e valores batidos). */
function conferir(db, { empresa, usuario, caixaId, observacao }) {
  const caixa = buscar(db, empresa.id, caixaId);
  if (caixa.status === 'aberto') throw new ErroNegocio('Feche o caixa antes de conferir.', 409);
  db.prepare("UPDATE caixas SET status = 'conferido', conferido_em = ?, conferido_por = ?, observacao = COALESCE(?, observacao) WHERE id = ?")
    .run(agora(), usuario.id, v.opcional(observacao, 'a observação', 300), caixa.id);
  return detalhe(db, empresa.id, caixa.id);
}

/** Lista de caixas com filtros (data, loja, operador, situação). */
function listar(db, empresaId, { de, ate, loja_id: lojaId, operador_id: operadorId, status, limite = 100 } = {}) {
  const where = ['c.empresa_id = ?'];
  const params = [empresaId];
  if (de) { where.push('c.data >= ?'); params.push(v.data(de, 'a data inicial')); }
  if (ate) { where.push('c.data <= ?'); params.push(v.data(ate, 'a data final')); }
  if (lojaId) { where.push('c.loja_id = ?'); params.push(Number(lojaId)); }
  if (operadorId) { where.push('c.operador_id = ?'); params.push(Number(operadorId)); }
  if (status) { where.push('c.status = ?'); params.push(v.opcao(status, 'a situação', ['aberto', 'fechado', 'conferido'])); }
  const caixas = db.prepare(`SELECT c.*, p.nome AS pdv_nome, l.nome AS loja_nome, u.nome AS operador_nome
    FROM caixas c JOIN pdvs p ON p.id = c.pdv_id JOIN lojas l ON l.id = c.loja_id JOIN usuarios u ON u.id = c.operador_id
    WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ?`).all(...params, Math.min(500, Number(limite) || 100));
  return caixas.map((c) => ({ ...c, contagem: undefined, resumo: resumo(db, c) }));
}

module.exports = { abrir, movimentar, fechar, conferir, listar, detalhe, resumo, buscar, caixaDoOperador, exigirAcesso };
