'use strict';

const { agora, transacao, lerConfig } = require('../db');
const { hoje, mes, somarMeses, diasNoMes, diasNaCompetencia, inicioMes, fimMes } = require('./datas');
const { porCampanha, periodoMes } = require('./relatorios');
const { ErroNegocio } = require('./erros');
const pix = require('./pix');

/**
 * Faturamento do mês e repasse aos lojistas.
 *
 *  - cobrança 'mensal': o valor contratado, proporcional aos dias em que a campanha esteve no ar dentro do mês;
 *  - cobrança 'cpm': impactos do mês ÷ 1.000 × o CPM contratado;
 *  - cobrança 'cortesia': entra na fatura com valor zero, só para constar o que foi exibido.
 *
 * Campanha sem nenhuma exibição no mês não é cobrada (o valor sai zero e o item diz o motivo).
 *
 * Repasse: a receita de cada campanha é dividida entre os pontos na proporção do tempo de tela que ela ocupou
 * em cada um; sobre a parte de cada ponto aplica-se a comissão combinada com o lojista.
 */

const SQL_CAMPANHAS_DO_MES = `SELECT c.*, a.nome AS anunciante_nome, a.status AS anunciante_status FROM campanhas c JOIN anunciantes a ON a.id = c.anunciante_id
  WHERE c.status <> 'rascunho' AND c.inicio <= ? AND (c.fim IS NULL OR c.fim >= ?)`;

/** Prévia da fatura de cada anunciante na competência (não grava nada). */
function calcular(db, competencia) {
  const { de, ate } = periodoMes(competencia);
  const desempenho = new Map(porCampanha(db, { de, ate }).map((c) => [c.campanha_id, c]));
  const dias = diasNoMes(competencia);
  const porAnunciante = new Map();

  for (const c of db.prepare(SQL_CAMPANHAS_DO_MES).all(ate, de)) {
    const d = desempenho.get(c.id) ?? { insercoes: 0, impactos: 0, telas: 0, segundos: 0 };
    const diasNoAr = diasNaCompetencia(competencia, c.inicio, c.fim);
    let valor = 0;
    let nota = '';
    if (!d.insercoes) {
      nota = 'sem exibições no mês';
    } else if (c.cobranca === 'mensal') {
      valor = Math.round((c.valor_centavos * diasNoAr) / dias);
      nota = diasNoAr < dias ? `${diasNoAr} de ${dias} dias` : 'mês cheio';
    } else if (c.cobranca === 'cpm') {
      valor = Math.round((d.impactos / 1000) * c.cpm_centavos);
      nota = `${d.impactos.toLocaleString('pt-BR')} impactos × CPM`;
    } else {
      nota = 'cortesia';
    }
    if (!porAnunciante.has(c.anunciante_id)) {
      porAnunciante.set(c.anunciante_id, { anunciante_id: c.anunciante_id, anunciante: c.anunciante_nome, competencia, valor_centavos: 0, itens: [] });
    }
    const f = porAnunciante.get(c.anunciante_id);
    f.itens.push({
      campanha_id: c.id,
      descricao: `${c.nome} (${c.cobranca === 'cpm' ? 'CPM' : c.cobranca === 'mensal' ? 'mensal' : 'cortesia'}${nota ? `, ${nota}` : ''})`,
      insercoes: d.insercoes ?? 0,
      impactos: d.impactos ?? 0,
      telas: d.telas ?? 0,
      segundos: d.segundos ?? 0,
      valor_centavos: valor,
    });
    f.valor_centavos += valor;
  }
  return [...porAnunciante.values()].sort((a, b) => b.valor_centavos - a.valor_centavos);
}

/** Quanto cada ponto gerou de receita na competência e quanto vira repasse ao lojista. */
function calcularRepasses(db, competencia, faturas = calcular(db, competencia)) {
  const { de, ate } = periodoMes(competencia);
  const receitaCampanha = new Map();
  for (const f of faturas) for (const i of f.itens) receitaCampanha.set(i.campanha_id, (receitaCampanha.get(i.campanha_id) ?? 0) + i.valor_centavos);

  const segmentos = db.prepare(`SELECT campanha_id, local_id, SUM(segundos) AS segundos FROM resumo_dia
    WHERE data BETWEEN ? AND ? AND campanha_id <> 0 GROUP BY campanha_id, local_id`).all(de, ate);
  const totalCampanha = new Map();
  for (const s of segmentos) totalCampanha.set(s.campanha_id, (totalCampanha.get(s.campanha_id) ?? 0) + s.segundos);

  const base = new Map();
  for (const s of segmentos) {
    const receita = receitaCampanha.get(s.campanha_id) ?? 0;
    const total = totalCampanha.get(s.campanha_id) ?? 0;
    if (!receita || !total) continue;
    base.set(s.local_id, (base.get(s.local_id) ?? 0) + (receita * s.segundos) / total);
  }

  const locais = db.prepare('SELECT id, nome, comissao_percentual FROM locais').all();
  return locais.filter((l) => base.has(l.id)).map((l) => {
    const baseCent = Math.round(base.get(l.id));
    return {
      local_id: l.id,
      local: l.nome,
      competencia,
      base_centavos: baseCent,
      comissao_percentual: l.comissao_percentual,
      valor_centavos: Math.round((baseCent * l.comissao_percentual) / 10_000),
    };
  }).sort((a, b) => b.valor_centavos - a.valor_centavos);
}

/** Gera (ou refaz) as faturas abertas e os repasses a pagar da competência. Faturas pagas ou canceladas não são tocadas. */
function gerar(db, competencia, { vencimento } = {}) {
  const cfg = lerConfig(db);
  const venc = vencimento || `${somarMeses(competencia, 1)}-${String(cfg.vencimento_dia).padStart(2, '0')}`;
  const faturas = calcular(db, competencia);
  const repasses = calcularRepasses(db, competencia, faturas);

  return transacao(db, () => {
    let geradas = 0;
    let mantidas = 0;
    for (const f of faturas) {
      const atual = db.prepare('SELECT * FROM faturas WHERE anunciante_id = ? AND competencia = ?').get(f.anunciante_id, competencia);
      if (atual && atual.status !== 'aberta') { mantidas++; continue; }
      let id = atual?.id;
      if (id) {
        db.prepare('UPDATE faturas SET valor_centavos = ?, vencimento = ? WHERE id = ?').run(f.valor_centavos, venc, id);
        db.prepare('DELETE FROM fatura_itens WHERE fatura_id = ?').run(id);
      } else {
        id = Number(db.prepare('INSERT INTO faturas (anunciante_id, competencia, vencimento, valor_centavos, criado_em) VALUES (?, ?, ?, ?, ?)')
          .run(f.anunciante_id, competencia, venc, f.valor_centavos, agora()).lastInsertRowid);
      }
      for (const i of f.itens) {
        db.prepare('INSERT INTO fatura_itens (fatura_id, campanha_id, descricao, insercoes, impactos, telas, valor_centavos) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, i.campanha_id, i.descricao, i.insercoes, i.impactos, i.telas, i.valor_centavos);
      }
      geradas++;
    }

    let repassesGerados = 0;
    for (const r of repasses) {
      const atual = db.prepare('SELECT * FROM repasses WHERE local_id = ? AND competencia = ?').get(r.local_id, competencia);
      if (atual && atual.status !== 'a_pagar') continue;
      if (atual) {
        db.prepare('UPDATE repasses SET base_centavos = ?, comissao_percentual = ?, valor_centavos = ? WHERE id = ?')
          .run(r.base_centavos, r.comissao_percentual, r.valor_centavos, atual.id);
      } else {
        db.prepare('INSERT INTO repasses (local_id, competencia, base_centavos, comissao_percentual, valor_centavos, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
          .run(r.local_id, competencia, r.base_centavos, r.comissao_percentual, r.valor_centavos, agora());
      }
      repassesGerados++;
    }
    return { competencia, vencimento: venc, geradas, mantidas, repasses: repassesGerados };
  });
}

/** Na virada do mês, fecha a competência anterior (se ainda não foi fechada). */
function faturarAutomatico(db) {
  const anterior = somarMeses(mes(hoje()), -1);
  const existe = db.prepare('SELECT 1 FROM faturas WHERE competencia = ? LIMIT 1').get(anterior);
  if (existe) return { competencia: anterior, geradas: 0, repasses: 0, mantidas: 0 };
  return gerar(db, anterior);
}

/** Fatura com itens, PIX copia e cola e situação. */
function detalhe(db, faturaId) {
  const f = db.prepare(`SELECT f.*, a.nome AS anunciante, a.documento, a.email FROM faturas f JOIN anunciantes a ON a.id = f.anunciante_id WHERE f.id = ?`).get(faturaId);
  if (!f) throw new ErroNegocio('Fatura não encontrada.', 404);
  const cfg = lerConfig(db);
  const itens = db.prepare('SELECT * FROM fatura_itens WHERE fatura_id = ? ORDER BY valor_centavos DESC, id').all(f.id);
  const atrasada = f.status === 'aberta' && f.vencimento < hoje();
  const txid = `MID${String(f.id).padStart(6, '0')}${f.competencia.replace('-', '')}`;
  return {
    ...f,
    itens,
    atrasada,
    periodo: { de: inicioMes(f.competencia), ate: fimMes(f.competencia) },
    pix: cfg.pix_chave && f.status === 'aberta' && f.valor_centavos > 0
      ? { codigo: pix.copiaECola({ chave: cfg.pix_chave, nome: cfg.pix_nome || cfg.nome_plataforma, cidade: cfg.pix_cidade, valorCentavos: f.valor_centavos, txid }), txid }
      : null,
  };
}

module.exports = { calcular, calcularRepasses, gerar, faturarAutomatico, detalhe };
