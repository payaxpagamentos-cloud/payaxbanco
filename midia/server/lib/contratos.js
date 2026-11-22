'use strict';

const { agora, lerConfig, transacao } = require('../db');
const { hoje, somarDias, somarMesesData, diasEntre } = require('./datas');
const { ErroNegocio } = require('./erros');

/**
 * O ciclo de vida do contrato: vencer, reajustar e renovar.
 *
 * Até aqui o contrato era um papel guardado — "IPCA a cada 12 meses" ficava escrito e ninguém agia.
 * Contrato que vence sem ninguém ver é receita que cai sozinha, e reajuste esquecido é desconto
 * que o cliente nem pediu. Este módulo faz o sistema cuidar disso:
 *
 *  - avisa quando o fim está chegando;
 *  - aplica o reajuste na data combinada — e aplica também nas campanhas do contrato, porque a fatura
 *    nasce da campanha, não do contrato: reajustar só o papel não mudaria nada no que se cobra;
 *  - renova sozinho onde foi combinada a renovação automática, estendendo as campanhas junto para que
 *    a veiculação não pare no meio do caminho.
 *
 * O que o sistema NÃO faz: inventar o índice. Ele não sabe o IPCA do mês. Quando o contrato tem um
 * percentual fixo guardado, o reajuste sai sozinho; sem percentual, o contrato entra na lista de
 * pendências e a equipe informa quanto aplicar.
 */

/** Data do próximo reajuste (null quando o contrato não tem periodicidade). */
function proximoReajuste(c) {
  if (!c.reajuste_meses || c.cobranca === 'cortesia') return null;
  return somarMesesData(c.ultimo_reajuste ?? c.inicio, c.reajuste_meses);
}

/** O contrato com as datas calculadas — é o que o painel mostra em cada linha. */
function comCiclo(c, data = hoje()) {
  const reajusteEm = proximoReajuste(c);
  return {
    ...c,
    reajuste_em: reajusteEm,
    reajuste_vencido: Boolean(reajusteEm && c.status === 'ativo' && reajusteEm <= data),
    dias_para_fim: c.fim ? diasEntre(data, c.fim) : null,
    vencido: Boolean(c.status === 'ativo' && c.fim && c.fim < data),
  };
}

/**
 * Meses de duração do contrato, usados para saber por quanto tempo renovar.
 * Conta pelo mês médio (30,44 dias) para que uma vigência de 1º de janeiro a 31 de dezembro dê
 * 12 meses, e não 11 — o jeito de contratar mais comum por aqui.
 */
function duracaoMeses(c) {
  if (!c.fim) return 12;
  const meses = Math.round(diasEntre(c.inicio, c.fim) / 30.44);
  return Math.max(1, Math.min(60, meses || 12));
}

/** O que precisa de atenção hoje: contratos vencendo, vencidos e com reajuste na hora. */
function pendencias(db, dias = null, empresaId = null) {
  const data = hoje();
  const aviso = dias ?? Number(lerConfig(db).contrato_aviso_dias) ?? 30;
  const ativos = db.prepare(`SELECT c.*, a.nome AS anunciante FROM contratos c JOIN anunciantes a ON a.id = c.anunciante_id
    WHERE c.status = 'ativo'${empresaId === null ? '' : ' AND a.empresa_id = ?'}`).all(...(empresaId === null ? [] : [empresaId])).map((c) => comCiclo(c, data));
  return {
    aviso_dias: aviso,
    vencendo: ativos.filter((c) => c.dias_para_fim !== null && c.dias_para_fim >= 0 && c.dias_para_fim <= aviso),
    vencidos: ativos.filter((c) => c.vencido),
    reajustar: ativos.filter((c) => c.reajuste_vencido),
  };
}

/**
 * Aplica o reajuste no contrato e nas campanhas dele.
 * O percentual vem em centésimos (450 = 4,5%). Campanha mensal tem o valor reajustado; campanha por
 * CPM, o CPM. Campanha encerrada ou cortesia fica como está.
 */
function aplicarReajuste(db, contratoId, { percentual, indice = null, data = null, usuarioId = null, automatico = false } = {}) {
  const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(contratoId);
  if (!c) throw new ErroNegocio('Contrato não encontrado.', 404);
  if (c.status === 'encerrado') throw new ErroNegocio('Contrato encerrado não é reajustado.', 409);
  if (!Number.isInteger(percentual) || percentual <= 0 || percentual > 10_000) {
    throw new ErroNegocio('Informe o percentual do reajuste (entre 0,01% e 100%).', 422);
  }
  const quando = data ?? hoje();
  const fator = (valor) => Math.round((valor * (10_000 + percentual)) / 10_000);

  return transacao(db, () => {
    const de = c.valor_centavos;
    const para = fator(de);
    const campanhas = db.prepare("SELECT * FROM campanhas WHERE contrato_id = ? AND status IN ('rascunho','aguardando','ativa','pausada')").all(c.id);
    let mexidas = 0;
    for (const camp of campanhas) {
      if (camp.cobranca === 'cortesia') continue;
      const campo = camp.cobranca === 'cpm' ? 'cpm_centavos' : 'valor_centavos';
      const atual = camp[campo];
      if (!atual) continue;
      db.prepare(`UPDATE campanhas SET ${campo} = ? WHERE id = ?`).run(fator(atual), camp.id);
      mexidas++;
    }
    db.prepare('UPDATE contratos SET valor_centavos = ?, ultimo_reajuste = ? WHERE id = ?').run(para, quando, c.id);
    db.prepare(`INSERT INTO contrato_reajustes (contrato_id, data, percentual, indice, de_centavos, para_centavos, campanhas, automatico, aplicado_por, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.id, quando, percentual, indice ?? c.reajuste ?? null, de, para, mexidas, automatico ? 1 : 0, usuarioId, agora());
    return { contrato_id: c.id, numero: c.numero, data: quando, percentual, de_centavos: de, para_centavos: para, campanhas: mexidas };
  });
}

/**
 * Renova o contrato por mais N meses (padrão: a mesma duração do período que está acabando).
 * As campanhas que terminavam junto com o contrato são estendidas, senão a veiculação pararia
 * no dia seguinte com o contrato renovado — o erro clássico de renovar só no papel.
 */
function renovar(db, contratoId, { meses = null, usuarioId = null, automatica = false } = {}) {
  const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(contratoId);
  if (!c) throw new ErroNegocio('Contrato não encontrado.', 404);
  if (c.status === 'encerrado') throw new ErroNegocio('Contrato encerrado não é renovado. Faça um novo.', 409);
  if (!c.fim) throw new ErroNegocio('Este contrato não tem data de término: não há o que renovar.', 409);
  const porMeses = meses ?? duracaoMeses(c);
  if (!Number.isInteger(porMeses) || porMeses < 1 || porMeses > 60) throw new ErroNegocio('O período da renovação deve ser de 1 a 60 meses.', 422);

  return transacao(db, () => {
    const fimAntigo = c.fim;
    const fimNovo = somarMesesData(fimAntigo, porMeses);
    db.prepare('UPDATE contratos SET fim = ?, renovado_em = ?, renovacoes = renovacoes + 1 WHERE id = ?').run(fimNovo, hoje(), c.id);
    // Só as campanhas que acabavam com o contrato: as de prazo próprio seguem o prazo delas.
    const estendidas = db.prepare(`UPDATE campanhas SET fim = ? WHERE contrato_id = ? AND fim = ? AND status <> 'encerrada'`)
      .run(fimNovo, c.id, fimAntigo).changes;
    return { contrato_id: c.id, numero: c.numero, de: fimAntigo, ate: fimNovo, meses: porMeses, campanhas: estendidas, automatica };
  });
}

/**
 * O que roda sozinho, uma vez por dia:
 *  - renova os contratos de renovação automática que chegaram ao fim;
 *  - aplica o reajuste dos que têm percentual fixo e chegaram na data.
 * O resto vira pendência para a equipe — de propósito: ninguém quer um sistema inventando aumento.
 */
function rodarAutomatico(db) {
  const data = hoje();
  const renovados = [];
  const reajustados = [];

  for (const c of db.prepare("SELECT * FROM contratos WHERE status = 'ativo' AND renovacao_automatica = 1 AND fim IS NOT NULL AND fim <= ?").all(data)) {
    try {
      renovados.push(renovar(db, c.id, { automatica: true }));
    } catch { /* um contrato problemático não pode parar os outros */ }
  }

  for (const c of db.prepare("SELECT * FROM contratos WHERE status = 'ativo' AND reajuste_percentual > 0 AND reajuste_meses > 0").all()) {
    const quando = proximoReajuste(c);
    if (!quando || quando > data) continue;
    try {
      reajustados.push(aplicarReajuste(db, c.id, { percentual: c.reajuste_percentual, data: quando, automatico: true }));
    } catch { /* idem */ }
  }

  return { renovados, reajustados };
}

/** Próximos contratos a vencer, para o painel de diagnóstico e o aviso por e-mail. */
const vencendo = (db, dias = 30) => db.prepare(`SELECT c.*, a.nome AS anunciante FROM contratos c JOIN anunciantes a ON a.id = c.anunciante_id
  WHERE c.status = 'ativo' AND c.fim IS NOT NULL AND c.fim <= ? ORDER BY c.fim`).all(somarDias(hoje(), dias)).map((c) => comCiclo(c));

module.exports = { proximoReajuste, comCiclo, duracaoMeses, pendencias, aplicarReajuste, renovar, rodarAutomatico, vencendo };
