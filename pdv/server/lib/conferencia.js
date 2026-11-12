'use strict';

const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hoje } = require('./datas');
const { clienteIxc } = require('./ixcEmpresa');
const { detalhe } = require('./recebimentos');
const v = require('./validacao');

const TIPOS = {
  nao_baixado: 'A fatura continua em aberto no IXC',
  valor_diferente: 'O valor baixado no IXC é diferente do recebido no PDV',
  baixa_nao_confirmada: 'O IXC não confirmou a baixa enviada pelo PDV',
  fatura_sumiu: 'A fatura não foi encontrada no IXC',
  caixa_diferenca: 'Fechamento de caixa com diferença',
  cancelado_com_baixa: 'Recebimento cancelado depois da baixa no IXC',
};

function abrirDivergencia(db, empresaId, { recebimentoId = null, tituloId = null, data, tipo, detalhes, valorPdv = null, valorIxc = null }) {
  db.prepare(`INSERT INTO divergencias (empresa_id, recebimento_id, titulo_id, data, tipo, detalhes, valor_pdv_centavos, valor_ixc_centavos, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (empresa_id, tipo, recebimento_id, titulo_id) DO UPDATE SET detalhes = excluded.detalhes,
      valor_pdv_centavos = excluded.valor_pdv_centavos, valor_ixc_centavos = excluded.valor_ixc_centavos,
      status = CASE WHEN divergencias.status = 'resolvida' THEN 'aberta' ELSE divergencias.status END`)
    .run(empresaId, recebimentoId, tituloId, data, tipo, String(detalhes ?? '').slice(0, 500), valorPdv, valorIxc, agora());
}

const fecharDivergencias = (db, empresaId, tituloId, resolucao) =>
  db.prepare(`UPDATE divergencias SET status = 'resolvida', resolucao = ?, resolvido_em = ?
    WHERE empresa_id = ? AND titulo_id = ? AND status = 'aberta' AND tipo IN ('nao_baixado','valor_diferente','fatura_sumiu','baixa_nao_confirmada')`)
    .run(resolucao, agora(), empresaId, tituloId);

/**
 * Confere no IXC os títulos de um recebimento: lê cada fatura e compara a situação e o valor com o que o PDV recebeu.
 * Guarda no título o que o IXC devolveu e abre (ou fecha) as divergências.
 */
async function conferirRecebimento(db, empresa, recebimentoId, { usuarioId = null } = {}) {
  const r = db.prepare('SELECT * FROM recebimentos WHERE id = ? AND empresa_id = ?').get(Number(recebimentoId), empresa.id);
  if (!r) throw naoEncontrado('Recebimento');
  const titulos = db.prepare('SELECT * FROM recebimento_titulos WHERE recebimento_id = ? AND fatura_ixc_id IS NOT NULL').all(r.id);
  if (!titulos.length) {
    db.prepare("UPDATE recebimentos SET conferencia = 'conferido', conferido_em = ?, conferido_por = ? WHERE id = ?").run(agora(), usuarioId, r.id);
    return detalhe(db, empresa.id, r.id);
  }
  const { ixc } = clienteIxc(db, empresa.id);
  let divergente = false;
  for (const t of titulos) {
    const f = await ixc.fatura(t.fatura_ixc_id);
    const momento = agora();
    if (!f) {
      db.prepare("UPDATE recebimento_titulos SET conferido_em = ?, ixc_situacao = 'nao_encontrada', ixc_valor_centavos = NULL, ixc_data_pagamento = NULL WHERE id = ?").run(momento, t.id);
      abrirDivergencia(db, empresa.id, { recebimentoId: r.id, tituloId: t.id, data: r.data, tipo: 'fatura_sumiu',
        detalhes: `Fatura ${t.fatura_ixc_id} não foi encontrada no IXC.`, valorPdv: t.total_centavos });
      divergente = true;
      continue;
    }
    db.prepare('UPDATE recebimento_titulos SET conferido_em = ?, ixc_situacao = ?, ixc_valor_centavos = ?, ixc_data_pagamento = ? WHERE id = ?')
      .run(momento, f.situacao, f.recebido_centavos || (f.situacao === 'recebido' ? f.valor_centavos : 0), f.pagamento, t.id);

    if (r.status === 'cancelado') {
      // Recebimento cancelado: o certo é a fatura estar aberta de novo.
      if (f.situacao === 'recebido') {
        abrirDivergencia(db, empresa.id, { recebimentoId: r.id, tituloId: t.id, data: r.data, tipo: 'cancelado_com_baixa',
          detalhes: `Recebimento ${r.numero} foi cancelado, mas a fatura ${t.fatura_ixc_id} continua baixada no IXC.`, valorPdv: t.total_centavos, valorIxc: f.recebido_centavos });
        divergente = true;
      } else fecharDivergencias(db, empresa.id, t.id, 'Fatura reaberta no IXC.');
      continue;
    }
    if (f.situacao !== 'recebido') {
      abrirDivergencia(db, empresa.id, { recebimentoId: r.id, tituloId: t.id, data: r.data, tipo: 'nao_baixado',
        detalhes: `Fatura ${t.fatura_ixc_id} está como "${f.situacao}" no IXC, mas foi recebida no PDV em ${r.data}.`,
        valorPdv: t.total_centavos, valorIxc: f.recebido_centavos });
      divergente = true;
      continue;
    }
    const valorIxc = f.recebido_centavos || f.valor_centavos;
    // Tolerância de um centavo (arredondamento de juros entre os dois sistemas).
    if (Math.abs(valorIxc - t.total_centavos) > 1) {
      abrirDivergencia(db, empresa.id, { recebimentoId: r.id, tituloId: t.id, data: r.data, tipo: 'valor_diferente',
        detalhes: `Fatura ${t.fatura_ixc_id}: PDV recebeu ${(t.total_centavos / 100).toFixed(2)} e o IXC registrou ${(valorIxc / 100).toFixed(2)}.`,
        valorPdv: t.total_centavos, valorIxc });
      divergente = true;
      continue;
    }
    fecharDivergencias(db, empresa.id, t.id, 'Conferida: baixa e valor conferem com o IXC.');
    if (t.ixc_status === 'pendente' || t.ixc_status === 'erro') {
      db.prepare("UPDATE recebimento_titulos SET ixc_status = 'baixado', ixc_baixado_em = COALESCE(ixc_baixado_em, ?), ixc_erro = NULL WHERE id = ?").run(momento, t.id);
    }
  }
  const pendentesNoIxc = db.prepare("SELECT COUNT(*) AS n FROM recebimento_titulos WHERE recebimento_id = ? AND fatura_ixc_id IS NOT NULL AND ixc_status NOT IN ('baixado','manual','estornado')").get(r.id).n;
  if (r.status === 'confirmado' && !pendentesNoIxc && r.ixc_status !== 'manual') {
    db.prepare("UPDATE recebimentos SET ixc_status = 'baixado', ixc_erro = NULL WHERE id = ?").run(r.id);
  }
  db.prepare('UPDATE recebimentos SET conferencia = ?, conferido_em = ?, conferido_por = ? WHERE id = ?')
    .run(divergente ? 'divergente' : 'conferido', agora(), usuarioId, r.id);
  return detalhe(db, empresa.id, r.id);
}

/** Confere no IXC todos os recebimentos de um período (o botão "conferir com o IXC" da tela de conferência). */
async function conferirPeriodo(db, empresa, { de, ate, usuarioId = null, limite = 200, somentePendentes = true } = {}) {
  const inicio = v.data(de ?? hoje(), 'a data inicial');
  const fim = v.data(ate ?? inicio, 'a data final');
  const where = ["r.empresa_id = ?", 'r.data >= ?', 'r.data <= ?'];
  const params = [empresa.id, inicio, fim];
  if (somentePendentes) where.push("r.conferencia <> 'conferido'");
  const lista = db.prepare(`SELECT r.id FROM recebimentos r WHERE ${where.join(' AND ')} ORDER BY r.id LIMIT ?`).all(...params, Math.min(500, Number(limite) || 200));
  const resultado = { conferidos: 0, divergentes: 0, falhas: 0, periodo: { de: inicio, ate: fim } };
  for (const item of lista) {
    try {
      const r = await conferirRecebimento(db, empresa, item.id, { usuarioId });
      if (r.conferencia === 'divergente') resultado.divergentes += 1; else resultado.conferidos += 1;
    } catch (err) {
      resultado.falhas += 1;
      resultado.erro = err.message;
    }
  }
  return resultado;
}

/** Painel da conferência: o que o PDV recebeu no período, como está a baixa no IXC e o que está divergente. */
function resumo(db, empresaId, { de, ate, loja_id: lojaId } = {}) {
  const inicio = v.data(de ?? hoje(), 'a data inicial');
  const fim = v.data(ate ?? inicio, 'a data final');
  const filtroLoja = lojaId ? ' AND r.loja_id = ?' : '';
  const p = lojaId ? [empresaId, inicio, fim, Number(lojaId)] : [empresaId, inicio, fim];
  const base = `FROM recebimentos r WHERE r.empresa_id = ? AND r.data >= ? AND r.data <= ?${filtroLoja}`;

  const totais = db.prepare(`SELECT
      COALESCE(SUM(r.status = 'confirmado'), 0) AS recebimentos,
      COALESCE(SUM(CASE WHEN r.status = 'confirmado' THEN r.valor_centavos END), 0) AS total_centavos,
      COALESCE(SUM(CASE WHEN r.status = 'confirmado' THEN r.acrescimo_centavos END), 0) AS acrescimos_centavos,
      COALESCE(SUM(CASE WHEN r.status = 'confirmado' THEN r.desconto_centavos END), 0) AS descontos_centavos,
      COALESCE(SUM(r.status = 'cancelado'), 0) AS cancelados,
      COALESCE(SUM(CASE WHEN r.status = 'cancelado' THEN r.valor_centavos END), 0) AS cancelados_centavos,
      COALESCE(SUM(r.status = 'confirmado' AND r.ixc_status IN ('baixado','manual')), 0) AS baixados,
      COALESCE(SUM(CASE WHEN r.status = 'confirmado' AND r.ixc_status IN ('baixado','manual') THEN r.valor_centavos END), 0) AS baixados_centavos,
      COALESCE(SUM(r.status = 'confirmado' AND r.ixc_status IN ('pendente','enviando')), 0) AS pendentes,
      COALESCE(SUM(CASE WHEN r.status = 'confirmado' AND r.ixc_status IN ('pendente','enviando') THEN r.valor_centavos END), 0) AS pendentes_centavos,
      COALESCE(SUM(r.status = 'confirmado' AND r.ixc_status IN ('erro','parcial')), 0) AS com_erro,
      COALESCE(SUM(CASE WHEN r.status = 'confirmado' AND r.ixc_status IN ('erro','parcial') THEN r.valor_centavos END), 0) AS com_erro_centavos,
      COALESCE(SUM(r.status = 'confirmado' AND r.ixc_status = 'avulso'), 0) AS avulsos,
      COALESCE(SUM(r.status = 'confirmado' AND r.conferencia = 'conferido'), 0) AS conferidos,
      COALESCE(SUM(r.status = 'confirmado' AND r.conferencia = 'divergente'), 0) AS divergentes,
      COALESCE(SUM(r.status = 'confirmado' AND r.conferencia = 'pendente'), 0) AS nao_conferidos
    ${base}`).get(...p);

  const porForma = db.prepare(`SELECT g.forma, COUNT(*) AS quantidade, COALESCE(SUM(g.valor_centavos), 0) AS total_centavos FROM pagamentos g
    JOIN recebimentos r ON r.id = g.recebimento_id WHERE r.empresa_id = ? AND r.data >= ? AND r.data <= ?${filtroLoja} AND r.status = 'confirmado'
    GROUP BY g.forma ORDER BY total_centavos DESC`).all(...p);

  const porDia = db.prepare(`SELECT r.data, COUNT(*) AS quantidade, COALESCE(SUM(r.valor_centavos), 0) AS total_centavos,
      COALESCE(SUM(CASE WHEN r.ixc_status IN ('baixado','manual') THEN r.valor_centavos END), 0) AS baixado_centavos
    ${base} AND r.status = 'confirmado' GROUP BY r.data ORDER BY r.data`).all(...p);

  const porOperador = db.prepare(`SELECT u.id, u.nome, COUNT(*) AS quantidade, COALESCE(SUM(r.valor_centavos), 0) AS total_centavos
    FROM recebimentos r JOIN usuarios u ON u.id = r.operador_id
    WHERE r.empresa_id = ? AND r.data >= ? AND r.data <= ?${filtroLoja} AND r.status = 'confirmado'
    GROUP BY u.id ORDER BY total_centavos DESC`).all(...p);

  const porTerminal = db.prepare(`SELECT t.id, t.nome, t.adquirente, COUNT(*) AS quantidade, COALESCE(SUM(g.valor_centavos), 0) AS total_centavos
    FROM pagamentos g JOIN recebimentos r ON r.id = g.recebimento_id JOIN terminais t ON t.id = g.terminal_id
    WHERE r.empresa_id = ? AND r.data >= ? AND r.data <= ?${filtroLoja} AND r.status = 'confirmado'
    GROUP BY t.id ORDER BY total_centavos DESC`).all(...p);

  const divergenciasAbertas = db.prepare(`SELECT tipo, COUNT(*) AS quantidade FROM divergencias
    WHERE empresa_id = ? AND data >= ? AND data <= ? AND status = 'aberta' GROUP BY tipo`).all(empresaId, inicio, fim);

  return {
    periodo: { de: inicio, ate: fim },
    totais: {
      ...totais,
      // O que falta bater com o IXC: pendentes + erros (não entra o avulso, que não tem fatura).
      a_confirmar_centavos: totais.pendentes_centavos + totais.com_erro_centavos,
    },
    por_forma: porForma,
    por_dia: porDia,
    por_operador: porOperador,
    por_terminal: porTerminal,
    divergencias: divergenciasAbertas,
    divergencias_abertas: divergenciasAbertas.reduce((s, d) => s + d.quantidade, 0),
  };
}

/** Divergências do período (abertas por padrão). */
function listarDivergencias(db, empresaId, { de, ate, status = 'aberta', tipo, limite = 200 } = {}) {
  const where = ['d.empresa_id = ?'];
  const params = [empresaId];
  if (de) { where.push('d.data >= ?'); params.push(v.data(de, 'a data inicial')); }
  if (ate) { where.push('d.data <= ?'); params.push(v.data(ate, 'a data final')); }
  if (status && status !== 'todas') { where.push('d.status = ?'); params.push(v.opcao(status, 'a situação', ['aberta', 'resolvida', 'ignorada'])); }
  if (tipo) { where.push('d.tipo = ?'); params.push(v.opcao(tipo, 'o tipo', Object.keys(TIPOS))); }
  return db.prepare(`SELECT d.*, r.numero AS recebimento_numero, r.cliente_nome, r.valor_centavos AS recebimento_valor_centavos,
      t.fatura_ixc_id, t.vencimento, u.nome AS resolvido_por_nome, p.nome AS pdv_nome
    FROM divergencias d LEFT JOIN recebimentos r ON r.id = d.recebimento_id LEFT JOIN recebimento_titulos t ON t.id = d.titulo_id
    LEFT JOIN usuarios u ON u.id = d.resolvido_por LEFT JOIN caixas c ON c.id = d.caixa_id LEFT JOIN pdvs p ON p.id = c.pdv_id
    WHERE ${where.join(' AND ')} ORDER BY d.status = 'aberta' DESC, d.data DESC, d.id DESC LIMIT ?`)
    .all(...params, Math.min(500, Number(limite) || 200));
}

/** Supervisão fecha a divergência (resolvida ou ignorada), sempre com a explicação. */
function resolverDivergencia(db, { empresa, usuario, id, status = 'resolvida', resolucao }) {
  const d = db.prepare('SELECT * FROM divergencias WHERE id = ? AND empresa_id = ?').get(Number(id), empresa.id);
  if (!d) throw naoEncontrado('Divergência');
  if (d.status !== 'aberta') throw new ErroNegocio('Esta divergência já foi encerrada.', 409);
  v.opcao(status, 'a situação', ['resolvida', 'ignorada']);
  db.prepare('UPDATE divergencias SET status = ?, resolucao = ?, resolvido_em = ?, resolvido_por = ? WHERE id = ?')
    .run(status, v.texto(resolucao, 'a explicação', 300), agora(), usuario.id, d.id);
  if (d.recebimento_id) {
    const restam = db.prepare("SELECT COUNT(*) AS n FROM divergencias WHERE recebimento_id = ? AND status = 'aberta'").get(d.recebimento_id).n;
    if (!restam) db.prepare("UPDATE recebimentos SET conferencia = 'conferido' WHERE id = ? AND conferencia = 'divergente'").run(d.recebimento_id);
  }
  return db.prepare('SELECT * FROM divergencias WHERE id = ?').get(d.id);
}

module.exports = { TIPOS, conferirRecebimento, conferirPeriodo, resumo, listarDivergencias, resolverDivergencia, abrirDivergencia };
