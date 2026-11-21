'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, csv, conferirVersao } = require('../lib/http');
const { dataLocal } = require('../lib/datas');
const contabil = require('../lib/contabil');
const contabilizacao = require('../lib/contabilizacao');
const v = require('../lib/validacao');

/*
 * Contabilidade.
 *
 * Toda consulta aqui devolve o período a que se refere e se a competência está fechada. Um balancete sem
 * período é um número solto; um balancete de mês aberto pode mudar amanhã, e quem vai usá-lo precisa saber.
 */
module.exports = (db) => {
  const r = Router();
  const hoje = (req) => dataLocal(req.usuario.fuso);
  const compAtual = (req) => hoje(req).slice(0, 7);
  const periodo = (req) => {
    const de = req.query.de ? v.texto(req.query.de, 'a competência inicial', 7) : compAtual(req);
    const ate = req.query.ate ? v.texto(req.query.ate, 'a competência final', 7) : de;
    v.exigir(contabil.competenciaValida(de) && contabil.competenciaValida(ate), 'Competência inválida (use AAAA-MM).');
    v.exigir(de <= ate, 'A competência inicial não pode ser depois da final.');
    return { de, ate };
  };

  // ---------------- Plano de contas ----------------
  r.get('/plano', exigir('contabil.ver'), (req, res) => {
    const contas = db.prepare('SELECT * FROM plano_contas WHERE organizacao_id = ? ORDER BY codigo').all(req.org);
    const comLancamento = new Set(db.prepare(`SELECT DISTINCT pa.conta_id AS id FROM partidas pa
      JOIN lancamentos l ON l.id = pa.lancamento_id WHERE l.organizacao_id = ?`).all(req.org).map((x) => x.id));
    const padrao = db.prepare('SELECT chave, conta_id FROM contas_padrao WHERE organizacao_id = ?').all(req.org);
    res.json({
      contas: contas.map((c) => ({ ...c, tem_lancamento: comLancamento.has(c.id) }))
        .sort((a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true })),
      mapa: Object.fromEntries(padrao.map((p) => [p.chave, p.conta_id])),
      chaves_obrigatorias: contabilizacao.OBRIGATORIAS,
      automatica: contabilizacao.ligada(db, req.org),
    });
  });

  r.post('/plano/padrao', exigir('contabil.plano'), (req, res) => {
    const r2 = contabil.criarPlanoPadrao(db, req.org, req.usuario.id);
    registrar(db, req, 'plano_contas_criado', { recurso: 'contabil', depois: r2 });
    res.status(201).json({ ...r2, aviso: 'Plano de contas padrão criado. Renomeie, desative ou crie contas antes do primeiro lançamento — '
      + 'conta que já recebeu lançamento não pode mais virar sintética.' });
  });

  r.post('/plano', exigir('contabil.plano'), (req, res) => {
    const b = req.body ?? {};
    const c = transacao(db, () => contabil.criarConta(db, {
      org: req.org,
      codigo: v.texto(b.codigo, 'o código', 20),
      nome: v.texto(b.nome, 'o nome', 120),
      tipo: v.opcao(b.tipo, 'o tipo', contabil.TIPOS),
      observacoes: v.opcional(b.observacoes, 'as observações', 300),
      usuarioId: req.usuario.id,
    }));
    registrar(db, req, 'conta_contabil_criada', { recurso: 'conta_contabil', recursoId: c.id, depois: c });
    res.status(201).json(c);
  });

  r.patch('/plano/:id', exigir('contabil.plano'), (req, res) => {
    const atual = contabil.conta(db, req.org, req.params.id);
    if (!atual) throw new ErroNegocio('Conta contábil não encontrada.', 404);
    conferirVersao(atual.versao, req.body?.versao);
    const nome = req.body?.nome !== undefined ? v.texto(req.body.nome, 'o nome', 120) : atual.nome;
    const ativa = req.body?.ativa !== undefined ? (v.booleano(req.body.ativa) ? 1 : 0) : atual.ativa;
    // Desativar conta com saldo esconderia valor do balancete: o saldo continuaria existindo sem aparecer.
    if (!ativa && atual.ativa) {
      const saldo = contabil.saldos(db, req.org, { de: '0000-01', ate: '9999-12' }).find((x) => x.id === atual.id);
      v.exigir(!saldo || saldo.saldo_centavos === 0, `A conta ${atual.codigo} tem saldo e não pode ser desativada: o valor sumiria do balancete.`);
    }
    db.prepare('UPDATE plano_contas SET nome = ?, ativa = ?, observacoes = ?, versao = versao + 1 WHERE id = ?')
      .run(nome, ativa, v.opcional(req.body?.observacoes, 'as observações', 300) ?? atual.observacoes, atual.id);
    registrar(db, req, 'conta_contabil_alterada', { recurso: 'conta_contabil', recursoId: atual.id, antes: atual, depois: { nome, ativa } });
    res.json(contabil.conta(db, req.org, atual.id));
  });

  /** Mapa que diz para onde cada fato do financeiro vai. */
  r.put('/plano/mapa', exigir('contabil.plano'), (req, res) => {
    const b = req.body ?? {};
    const t = agora();
    transacao(db, () => {
      for (const [chave, contaId] of Object.entries(b)) {
        if (!contabilizacao.OBRIGATORIAS.includes(chave) && !Object.keys(contabil.PADRAO_CONTAS).includes(chave)) continue;
        if (contaId === null || contaId === '') { db.prepare('DELETE FROM contas_padrao WHERE organizacao_id = ? AND chave = ?').run(req.org, chave); continue; }
        const c = contabil.conta(db, req.org, contaId);
        if (!c) throw new ErroNegocio(`Conta não encontrada para "${chave}".`, 422);
        if (!c.analitica) throw new ErroNegocio(`A conta ${c.codigo} é sintética e não pode receber lançamento automático.`, 422);
        db.prepare(`INSERT INTO contas_padrao (organizacao_id, chave, conta_id, definido_por, definido_em) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (organizacao_id, chave) DO UPDATE SET conta_id = excluded.conta_id, definido_por = excluded.definido_por, definido_em = excluded.definido_em`)
          .run(req.org, chave, c.id, req.usuario.id, t);
      }
    });
    registrar(db, req, 'mapa_contabil_definido', { recurso: 'contabil', depois: b });
    const faltando = contabilizacao.OBRIGATORIAS.filter((k) => !contabil.contaPadrao(db, req.org, k));
    res.json({ faltando, completo: faltando.length === 0 });
  });

  // ---------------- Lançamentos ----------------
  r.get('/lancamentos', exigir('contabil.ver'), (req, res) => {
    const f = ['l.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.competencia) { f.push('l.competencia = ?'); p.push(String(req.query.competencia)); }
    if (req.query.origem) { f.push('l.origem = ?'); p.push(String(req.query.origem)); }
    if (req.query.conta_id) { f.push('EXISTS (SELECT 1 FROM partidas pa WHERE pa.lancamento_id = l.id AND pa.conta_id = ?)'); p.push(Number(req.query.conta_id)); }
    if (req.query.busca) { f.push('l.historico LIKE ? ESCAPE \'\\\''); p.push(`%${String(req.query.busca).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    const lista = listaPaginada(db, `SELECT l.*, u.nome AS criado_por_nome FROM lancamentos l LEFT JOIN usuarios u ON u.id = l.criado_por
      WHERE ${f.join(' AND ')} ORDER BY l.data DESC, l.numero DESC`, p, req.query);
    lista.itens = lista.itens.map((x) => ({ ...x, partidas: contabil.partidasDe(db, x.id) }));
    res.json(lista);
  });

  r.get('/lancamentos/:id', exigir('contabil.ver'), (req, res) => {
    const l = db.prepare(`SELECT l.*, u.nome AS criado_por_nome FROM lancamentos l LEFT JOIN usuarios u ON u.id = l.criado_por
      WHERE l.id = ? AND l.organizacao_id = ?`).get(Number(req.params.id), req.org);
    if (!l) throw new ErroNegocio('Lançamento não encontrado.', 404);
    res.json({ ...l, partidas: contabil.partidasDe(db, l.id), fechada: Boolean(contabil.fechamentoDe(db, req.org, l.competencia)) });
  });

  r.post('/lancamentos', exigir('contabil.lancar'), (req, res) => {
    const b = req.body ?? {};
    const l = transacao(db, () => contabil.lancar(db, {
      org: req.org,
      data: v.data(b.data, 'a data'),
      competencia: b.competencia ? v.texto(b.competencia, 'a competência', 7) : null,
      historico: v.texto(b.historico, 'o histórico', 300),
      usuarioId: req.usuario.id,
      partidas: (Array.isArray(b.partidas) ? b.partidas : []).map((x) => ({
        conta_id: Number(x.conta_id),
        tipo: String(x.tipo ?? '').toUpperCase(),
        valor_centavos: v.centavos(x.valor, 'o valor da partida'),
        historico: v.opcional(x.historico, 'o histórico da partida', 200),
      })),
    }));
    registrar(db, req, 'lancamento_contabil', { recurso: 'lancamento', recursoId: l.id, depois: l });
    res.status(201).json({ ...l, partidas: contabil.partidasDe(db, l.id) });
  });

  r.post('/lancamentos/:id/estornar', exigir('contabil.lancar'), (req, res) => {
    const motivo = v.texto(req.body?.motivo, 'o motivo do estorno', 300);
    const e = contabil.estornar(db, { org: req.org, lancamentoId: req.params.id, motivo, usuarioId: req.usuario.id });
    registrar(db, req, 'lancamento_estornado', { recurso: 'lancamento', recursoId: Number(req.params.id), depois: { estorno_id: e.id, motivo } });
    res.status(201).json({ ...e, partidas: contabil.partidasDe(db, e.id),
      aviso: 'O lançamento original continua no histórico, marcado como estornado. Em contabilidade nada é apagado.' });
  });

  // ---------------- Relatórios ----------------
  r.get('/balancete', exigir('contabil.ver'), (req, res) => {
    const p = periodo(req);
    const b = contabil.balancete(db, req.org, { ...p, zerados: req.query.zerados === '1' });
    res.json({ ...b, fechada: Boolean(contabil.fechamentoDe(db, req.org, p.ate)) });
  });

  r.get('/balancete/csv', exigir('contabil.ver'), (req, res) => {
    const p = periodo(req);
    const b = contabil.balancete(db, req.org, { ...p, zerados: req.query.zerados === '1' });
    const linhas = [['Código', 'Conta', 'Tipo', 'Saldo anterior', 'Débito', 'Crédito', 'Saldo'],
      ...b.linhas.map((c) => [c.codigo, c.nome, c.tipo, (c.saldo_anterior_centavos / 100).toFixed(2),
        (c.debito / 100).toFixed(2), (c.credito / 100).toFixed(2), (c.saldo_centavos / 100).toFixed(2)])];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="balancete-${p.de}-a-${p.ate}.csv"` }).send(csv(linhas));
  });

  r.get('/dre', exigir('contabil.ver'), (req, res) => {
    const p = periodo(req);
    res.json({ ...contabil.dre(db, req.org, p), fechada: Boolean(contabil.fechamentoDe(db, req.org, p.ate)) });
  });

  r.get('/razao/:conta_id', exigir('contabil.ver'), (req, res) => {
    res.json(contabil.razao(db, req.org, req.params.conta_id, periodo(req)));
  });

  // ---------------- Planejamento ----------------
  r.get('/orcamento', exigir('contabil.ver'), (req, res) => res.json(contabil.orcadoRealizado(db, req.org, periodo(req))));

  r.put('/orcamento', exigir('contabil.lancar'), (req, res) => {
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
    v.exigir(itens.length, 'Informe pelo menos um item do orçamento.');
    const t = agora();
    const n = transacao(db, () => {
      let gravados = 0;
      for (const i of itens) {
        const competencia = v.texto(i.competencia, 'a competência', 7);
        v.exigir(contabil.competenciaValida(competencia), 'Competência inválida (use AAAA-MM).');
        const c = contabil.conta(db, req.org, i.conta_id);
        v.exigir(c, 'Conta contábil não encontrada.');
        v.exigir(c.resultado, `A conta ${c.codigo} é de balanço: orçamento é de receita e despesa.`);
        v.exigir(c.analitica, `A conta ${c.codigo} é sintética: orce nas contas filhas.`);
        const valor = v.centavos(i.valor, 'o valor orçado');
        db.prepare(`INSERT INTO orcamento (organizacao_id, conta_id, competencia, valor_centavos, observacoes, criado_por, criado_em)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (organizacao_id, conta_id, competencia) DO UPDATE SET valor_centavos = excluded.valor_centavos,
            observacoes = excluded.observacoes, versao = orcamento.versao + 1`)
          .run(req.org, c.id, competencia, valor, v.opcional(i.observacoes, 'as observações', 200), req.usuario.id, t);
        gravados += 1;
      }
      return gravados;
    });
    registrar(db, req, 'orcamento_definido', { recurso: 'contabil', depois: { itens: n } });
    res.json({ gravados: n });
  });

  // ---------------- Fechamento ----------------
  r.get('/fechamentos', exigir('contabil.ver'), (req, res) => {
    res.json(db.prepare(`SELECT f.*, u.nome AS fechado_por_nome FROM fechamentos f LEFT JOIN usuarios u ON u.id = f.fechado_por
      WHERE f.organizacao_id = ? ORDER BY f.competencia DESC`).all(req.org));
  });

  r.post('/fechamentos', exigir('contabil.fechar'), (req, res) => {
    const competencia = v.texto(req.body?.competencia, 'a competência', 7);
    const pend = contabilizacao.pendencias(db, req.org);
    const r2 = contabil.fechar(db, { org: req.org, competencia, observacoes: v.opcional(req.body?.observacoes, 'as observações', 300), usuarioId: req.usuario.id });
    registrar(db, req, 'competencia_fechada', { recurso: 'contabil', depois: r2 });
    res.status(201).json({
      ...r2,
      // Fechar com fato do financeiro sem contabilizar entrega um balancete incompleto como se estivesse pronto.
      aviso: pend.total ? `Atenção: ${pend.total} fato(s) do financeiro ainda não foram contabilizados. O balancete de ${competencia} pode estar incompleto.` : null,
    });
  });

  r.post('/fechamentos/:competencia/reabrir', exigir('contabil.reabrir'), (req, res) => {
    const motivo = v.texto(req.body?.motivo, 'o motivo da reabertura', 300);
    const r2 = contabil.reabrir(db, { org: req.org, competencia: req.params.competencia, motivo, usuarioId: req.usuario.id });
    registrar(db, req, 'competencia_reaberta', { recurso: 'contabil', depois: r2 });
    res.json({ ...r2, aviso: 'Competência reaberta. Se o balancete já foi entregue ao contador, avise-o: o que ele recebeu pode mudar.' });
  });

  // ---------------- Contabilização automática ----------------
  r.get('/pendencias', exigir('contabil.ver'), (req, res) => res.json(contabilizacao.pendencias(db, req.org)));

  r.post('/pendencias/contabilizar', exigir('contabil.lancar'), (req, res) => {
    const r2 = contabilizacao.contabilizarPendentes(db, req.org, { usuarioId: req.usuario.id });
    registrar(db, req, 'contabilizacao_executada', { recurso: 'contabil', depois: r2 });
    res.json({ ...r2, restantes: contabilizacao.pendencias(db, req.org).total });
  });

  r.put('/automatica', exigir('contabil.plano'), (req, res) => {
    const ligar = v.booleano(req.body?.ligada);
    const r2 = ligar ? contabilizacao.ligar(db, req.org, { usuarioId: req.usuario.id }) : contabilizacao.desligar(db, req.org);
    registrar(db, req, 'contabilidade_automatica', { recurso: 'contabil', depois: r2 });
    res.json({
      ...r2,
      aviso: ligar && r2.pendentes
        ? `${r2.pendentes} fato(s) anteriores continuam pendentes: use "Contabilizar pendentes" para trazer o histórico.`
        : null,
    });
  });

  // ---------------- Resumo ----------------
  r.get('/resumo', exigir('contabil.ver'), (req, res) => {
    const comp = req.query.competencia ? String(req.query.competencia) : compAtual(req);
    v.exigir(contabil.competenciaValida(comp), 'Competência inválida (use AAAA-MM).');
    const contas = db.prepare('SELECT COUNT(*) AS n FROM plano_contas WHERE organizacao_id = ?').get(req.org).n;
    const pend = contabilizacao.pendencias(db, req.org, { limite: 50 });
    res.json({
      competencia: comp,
      plano_criado: contas > 0,
      contas,
      automatica: pend.ligada,
      mapa_completo: pend.mapa_completo,
      contas_faltando: pend.contas_faltando,
      pendentes: pend.total,
      pode_haver_mais_pendentes: pend.pode_haver_mais,
      fechada: Boolean(contabil.fechamentoDe(db, req.org, comp)),
      lancamentos: db.prepare('SELECT COUNT(*) AS n FROM lancamentos WHERE organizacao_id = ? AND competencia = ?').get(req.org, comp).n,
      dre: contas ? contabil.dre(db, req.org, { de: comp, ate: comp }) : null,
      balancete_fecha: contas ? contabil.balancete(db, req.org, { de: comp, ate: comp }).fecha : null,
    });
  });

  return r;
};
