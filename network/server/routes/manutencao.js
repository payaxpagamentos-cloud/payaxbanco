'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, conferirVersao } = require('../lib/http');
const { situacaoPlano, transicoes } = require('../lib/manutencao');
const { dataLocal } = require('../lib/datas');
const frota = require('../lib/frota');
const v = require('../lib/validacao');

const ITENS = ['oleo', 'filtros', 'pneus', 'freios', 'revisao', 'correia', 'bateria', 'outro'];
const TIPOS = ['preventiva', 'corretiva', 'lavagem'];

module.exports = (db) => {
  const r = Router();
  const fuso = (req) => req.usuario.fuso;
  const veiculo = (req, id) => {
    const x = db.prepare('SELECT * FROM veiculos WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Veículo não encontrado.', 404);
    return x;
  };
  const ordem = (req, id) => {
    const x = db.prepare('SELECT * FROM manutencoes WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Ordem não encontrada.', 404);
    return x;
  };
  const fornecedor = (req, id) => {
    if (!id) return null;
    const f = db.prepare('SELECT id FROM fornecedores WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!f) throw new ErroNegocio('Fornecedor não encontrado.', 422);
    return f.id;
  };
  const detalhe = (req, id) => {
    const o = db.prepare(`SELECT m.*, v.placa, v.modelo, f.nome AS fornecedor_nome, p.item AS plano_item FROM manutencoes m JOIN veiculos v ON v.id = m.veiculo_id
      LEFT JOIN fornecedores f ON f.id = m.fornecedor_id LEFT JOIN planos_preventivos p ON p.id = m.plano_id WHERE m.id = ? AND m.organizacao_id = ?`).get(Number(id), req.org);
    return {
      ...o,
      proximos: transicoes(o),
      itens: db.prepare('SELECT * FROM manutencao_itens WHERE manutencao_id = ? ORDER BY id').all(o.id),
      eventos: db.prepare('SELECT e.*, u.nome AS usuario_nome FROM manutencao_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE manutencao_id = ? ORDER BY e.id').all(o.id),
      anexos: db.prepare("SELECT id, nome, mime FROM anexos WHERE recurso = 'manutencao' AND recurso_id = ?").all(o.id),
    };
  };

  // ---------------- Planos preventivos ----------------
  r.get('/planos', exigir('manutencao.ver'), (req, res) => {
    const hoje = dataLocal(fuso(req));
    const p = [req.org];
    let f = 'p.organizacao_id = ? AND p.ativo = 1';
    if (req.query.veiculo_id) { f += ' AND p.veiculo_id = ?'; p.push(Number(req.query.veiculo_id)); }
    const lista = db.prepare(`SELECT p.*, v.placa, v.modelo, v.odometro_km, v.odometro_em, v.odometro_fonte FROM planos_preventivos p JOIN veiculos v ON v.id = p.veiculo_id
      WHERE ${f} ORDER BY v.placa, p.item`).all(...p).map((x) => ({ ...x, ...situacaoPlano(x, x, hoje) }));
    res.json(req.query.situacao ? lista.filter((x) => x.situacao === req.query.situacao) : lista);
  });

  const dadosPlano = (b, a = {}) => {
    const val = (k, fn) => (b[k] !== undefined ? fn(b[k]) : a[k] ?? null);
    const d = {
      item: val('item', (x) => v.opcao(x, 'o item', ITENS)), descricao: val('descricao', (x) => v.opcional(x, 'a descrição', 200)),
      intervalo_dias: val('intervalo_dias', (x) => v.inteiroOpcional(x, 'o intervalo em dias', { min: 1, max: 3650 })),
      intervalo_km: val('intervalo_km', (x) => v.inteiroOpcional(x, 'o intervalo em km', { min: 1, max: 1_000_000 })),
      antecedencia_dias: val('antecedencia_dias', (x) => v.inteiroOpcional(x, 'a antecedência em dias', { max: 365 })) ?? 15,
      antecedencia_km: val('antecedencia_km', (x) => v.inteiroOpcional(x, 'a antecedência em km', { max: 100_000 })) ?? 500,
      tolerancia_dias: val('tolerancia_dias', (x) => v.inteiroOpcional(x, 'a tolerância em dias', { max: 365 })) ?? 0,
      tolerancia_km: val('tolerancia_km', (x) => v.inteiroOpcional(x, 'a tolerância em km', { max: 100_000 })) ?? 0,
      ultima_data: val('ultima_data', (x) => v.data(x, 'a data do último serviço')),
      ultimo_km: val('ultimo_km', (x) => v.inteiroOpcional(x, 'o km do último serviço', { max: 5_000_000 })),
    };
    v.exigir(d.item && d.ultima_data, 'Informe o item e a data do último serviço válido.');
    v.exigir(d.intervalo_dias || d.intervalo_km, 'Informe a periodicidade em dias e/ou em km.');
    return d;
  };

  r.post('/planos', exigir('manutencao.editar'), (req, res) => {
    const x = veiculo(req, req.body?.veiculo_id);
    const d = dadosPlano(req.body ?? {});
    const id = Number(db.prepare(`INSERT INTO planos_preventivos (organizacao_id, veiculo_id, item, descricao, intervalo_dias, intervalo_km, antecedencia_dias, antecedencia_km,
      tolerancia_dias, tolerancia_km, ultima_data, ultimo_km, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, x.id, d.item, d.descricao,
      d.intervalo_dias, d.intervalo_km, d.antecedencia_dias, d.antecedencia_km, d.tolerancia_dias, d.tolerancia_km, d.ultima_data, d.ultimo_km, agora()).lastInsertRowid);
    registrar(db, req, 'plano_criado', { recurso: 'veiculo', recursoId: x.id, depois: { plano_id: id, ...d } });
    res.status(201).json({ id, veiculo_id: x.id, ...d, ...situacaoPlano(d, x, dataLocal(fuso(req))) });
  });

  r.patch('/planos/:id', exigir('manutencao.editar'), (req, res) => {
    const a = db.prepare('SELECT * FROM planos_preventivos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!a) throw new ErroNegocio('Plano não encontrado.', 404);
    if (req.body?.ativo === false) {
      db.prepare('UPDATE planos_preventivos SET ativo = 0 WHERE id = ?').run(a.id);
      registrar(db, req, 'plano_desativado', { recurso: 'veiculo', recursoId: a.veiculo_id, antes: a });
      return res.json({ id: a.id, ativo: 0 });
    }
    const d = dadosPlano(req.body ?? {}, a);
    db.prepare(`UPDATE planos_preventivos SET item = ?, descricao = ?, intervalo_dias = ?, intervalo_km = ?, antecedencia_dias = ?, antecedencia_km = ?, tolerancia_dias = ?,
      tolerancia_km = ?, ultima_data = ?, ultimo_km = ? WHERE id = ?`).run(d.item, d.descricao, d.intervalo_dias, d.intervalo_km, d.antecedencia_dias, d.antecedencia_km,
      d.tolerancia_dias, d.tolerancia_km, d.ultima_data, d.ultimo_km, a.id);
    registrar(db, req, 'plano_alterado', { recurso: 'veiculo', recursoId: a.veiculo_id, antes: a, depois: d });
    res.json({ id: a.id, ...d });
  });

  // ---------------- Ordens (manutenção, mecânico e lavagem) ----------------
  r.get('/ordens', exigir('manutencao.ver'), (req, res) => {
    const f = ['m.organizacao_id = ?'];
    const p = [req.org];
    for (const k of ['status', 'tipo']) if (req.query[k]) { f.push(`m.${k} = ?`); p.push(String(req.query[k])); }
    if (req.query.veiculo_id) { f.push('m.veiculo_id = ?'); p.push(Number(req.query.veiculo_id)); }
    if (req.query.abertas === '1') f.push("m.status NOT IN ('concluido','cancelado')");
    res.json(listaPaginada(db, `SELECT m.*, v.placa, v.modelo, f.nome AS fornecedor_nome FROM manutencoes m JOIN veiculos v ON v.id = m.veiculo_id
      LEFT JOIN fornecedores f ON f.id = m.fornecedor_id WHERE ${f.join(' AND ')}
      ORDER BY CASE WHEN m.status IN ('concluido','cancelado') THEN 1 ELSE 0 END, COALESCE(m.data_planejada, m.criado_em) DESC`, p, req.query));
  });

  r.get('/ordens/:id', exigir('manutencao.ver'), (req, res) => { ordem(req, req.params.id); res.json(detalhe(req, req.params.id)); });

  r.post('/ordens', exigir('manutencao.editar'), (req, res) => {
    const b = req.body ?? {};
    const x = veiculo(req, b.veiculo_id);
    const tipo = v.opcao(b.tipo, 'o tipo', TIPOS);
    let planoId = null;
    if (b.plano_id) {
      const pl = db.prepare('SELECT * FROM planos_preventivos WHERE id = ? AND veiculo_id = ? AND ativo = 1').get(Number(b.plano_id), x.id);
      if (!pl) throw new ErroNegocio('Plano preventivo não encontrado para este veículo.', 422);
      v.exigir(tipo === 'preventiva', 'Só a ordem preventiva se liga a um plano.');
      planoId = pl.id;
    }
    const d = {
      tipo, plano_id: planoId, lavagem_tipo: tipo === 'lavagem' ? v.texto(b.lavagem_tipo || 'simples', 'o tipo de lavagem', 40) : null,
      fornecedor_id: fornecedor(req, b.fornecedor_id), descricao: v.texto(b.descricao, 'a descrição', 500),
      data_planejada: v.dataOpcional(b.data_planejada, 'a data planejada'), km_planejado: v.inteiroOpcional(b.km_planejado, 'o km planejado', { max: 5_000_000 }),
      indisponivel_inicio: v.dataOpcional(b.indisponivel_inicio, 'o início da indisponibilidade'), indisponivel_fim: v.dataOpcional(b.indisponivel_fim, 'o fim da indisponibilidade'),
      custo_previsto_centavos: v.centavosOpcional(b.custo_previsto, 'o custo previsto'), observacoes: v.opcional(b.observacoes, 'as observações', 1000),
    };
    const status = d.custo_previsto_centavos !== null && tipo !== 'lavagem' ? 'orcado' : 'solicitado';
    const id = transacao(db, () => {
      const nid = Number(db.prepare(`INSERT INTO manutencoes (organizacao_id, veiculo_id, tipo, plano_id, lavagem_tipo, fornecedor_id, descricao, data_planejada, km_planejado,
        indisponivel_inicio, indisponivel_fim, custo_previsto_centavos, status, observacoes, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.org, x.id, d.tipo, d.plano_id, d.lavagem_tipo, d.fornecedor_id, d.descricao, d.data_planejada, d.km_planejado, d.indisponivel_inicio, d.indisponivel_fim,
          d.custo_previsto_centavos, status, d.observacoes, req.usuario.id, agora()).lastInsertRowid);
      for (const it of Array.isArray(b.itens) ? b.itens.slice(0, 50) : []) {
        db.prepare('INSERT INTO manutencao_itens (manutencao_id, tipo, descricao, previsto_centavos) VALUES (?, ?, ?, ?)')
          .run(nid, v.opcao(it.tipo, 'o tipo do item', ['peca', 'servico']), v.texto(it.descricao, 'a descrição do item', 200), v.centavosOpcional(it.previsto, 'o valor do item'));
      }
      db.prepare('INSERT INTO manutencao_eventos (manutencao_id, de, para, usuario_id, em) VALUES (?, NULL, ?, ?, ?)').run(nid, status, req.usuario.id, agora());
      return nid;
    });
    registrar(db, req, 'manutencao_criada', { recurso: 'manutencao', recursoId: id, depois: { veiculo_id: x.id, ...d, status } });
    res.status(201).json(detalhe(req, id));
  });

  /**
   * Avança a ordem: orcar (custo previsto), aprovar (alçada por valor), agendar, iniciar (bloqueia o veículo), concluir (custo realizado;
   * reinicia só o plano ligado à ordem) ou cancelar. Concluir/cancelar libera só a restrição desta ordem.
   */
  r.post('/ordens/:id/status', exigir('manutencao.editar'), (req, res) => {
    const o = ordem(req, req.params.id);
    conferirVersao(o.versao, req.body?.versao);
    const b = req.body ?? {};
    const para = String(b.status ?? '');
    if (!transicoes(o).includes(para)) throw new ErroNegocio(`Não é possível passar de "${o.status}" para "${para}".`, 422);
    const org = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org);
    const x = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(o.veiculo_id);
    const sets = {};
    if (para === 'orcado') {
      sets.custo_previsto_centavos = v.centavos(b.custo_previsto, 'o custo previsto');
      if (b.fornecedor_id) sets.fornecedor_id = fornecedor(req, b.fornecedor_id);
    }
    if (para === 'aprovado') {
      if (o.custo_previsto_centavos === null) throw new ErroNegocio('Registre o orçamento antes de aprovar.', 422);
      if (o.custo_previsto_centavos > org.aprovacao_manutencao_centavos && req.usuario.perfil !== 'admin') {
        throw new ErroNegocio('Orçamento acima da alçada: somente o administrador aprova.', 403);
      }
      sets.aprovado_por = req.usuario.id;
      sets.aprovado_em = agora();
    }
    if (para === 'agendado') sets.data_planejada = v.data(b.data_planejada ?? o.data_planejada, 'a data agendada');
    let km = null;
    if (para === 'concluido') {
      sets.custo_realizado_centavos = v.centavos(b.custo_realizado ?? 0, 'o custo realizado');
      km = v.inteiroOpcional(b.km_execucao, 'o km na execução', { max: 5_000_000 });
      if (km !== null && x.odometro_km !== null) v.exigir(km >= x.odometro_km || String(b.motivo_km ?? '').trim(), `O km informado é menor que o odômetro atual (${x.odometro_km} km). Confira ou informe o motivo.`);
      sets.km_execucao = km;
      sets.concluido_em = agora();
    }
    const obs = v.opcional(b.observacao, 'a observação', 500);
    if (para === 'cancelado') v.exigir(obs, 'Informe o motivo do cancelamento.');
    transacao(db, () => {
      const cols = Object.keys(sets);
      db.prepare(`UPDATE manutencoes SET status = ?, versao = versao + 1${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`).run(para, ...cols.map((c) => sets[c]), o.id);
      db.prepare('INSERT INTO manutencao_eventos (manutencao_id, de, para, observacao, usuario_id, em) VALUES (?, ?, ?, ?, ?, ?)').run(o.id, o.status, para, obs, req.usuario.id, agora());
      if (para === 'em_execucao' && !db.prepare('SELECT 1 FROM veiculo_restricoes WHERE ordem_id = ? AND fim IS NULL').get(o.id)) {
        frota.abrirRestricao(db, req, o.veiculo_id, { tipo: 'manutencao', motivo: `${o.tipo === 'lavagem' ? 'Lavagem' : 'Manutenção'} em andamento: ${o.descricao}`, ordemId: o.id });
      }
      if (para === 'concluido' || para === 'cancelado') {
        for (const rs of db.prepare('SELECT id FROM veiculo_restricoes WHERE ordem_id = ? AND fim IS NULL').all(o.id)) {
          frota.liberarRestricao(db, req, rs.id, para === 'concluido' ? 'Ordem concluída' : 'Ordem cancelada');
        }
      }
      if (para === 'concluido') {
        if (km !== null) frota.atualizarOdometro(db, o.veiculo_id, km, 'manutencao');
        // Só o plano desta ordem é reiniciado (lavagem e outros itens mantêm seus contadores).
        if (o.plano_id) {
          const kmPlano = km ?? db.prepare('SELECT odometro_km FROM veiculos WHERE id = ?').get(o.veiculo_id).odometro_km;
          db.prepare('UPDATE planos_preventivos SET ultima_data = ?, ultimo_km = ? WHERE id = ?').run(dataLocal(fuso(req)), kmPlano, o.plano_id);
        }
      }
    });
    registrar(db, req, `manutencao_${para}`, { recurso: 'manutencao', recursoId: o.id, antes: { status: o.status }, depois: { status: para, ...sets, observacao: obs } });
    res.json(detalhe(req, o.id));
  });

  /** Agenda: ordens abertas e planos próximos/vencidos. */
  r.get('/agenda', exigir('manutencao.ver'), (req, res) => {
    const hoje = dataLocal(fuso(req));
    const ordens = db.prepare(`SELECT m.id, m.tipo, m.descricao, m.status, m.data_planejada, m.km_planejado, m.indisponivel_inicio, m.indisponivel_fim, v.placa, v.modelo,
      f.nome AS fornecedor_nome FROM manutencoes m JOIN veiculos v ON v.id = m.veiculo_id LEFT JOIN fornecedores f ON f.id = m.fornecedor_id
      WHERE m.organizacao_id = ? AND m.status NOT IN ('concluido','cancelado') ORDER BY COALESCE(m.data_planejada, '9999'), m.id`).all(req.org);
    const planos = db.prepare(`SELECT p.*, v.placa, v.modelo, v.odometro_km FROM planos_preventivos p JOIN veiculos v ON v.id = p.veiculo_id
      WHERE p.organizacao_id = ? AND p.ativo = 1 AND v.status_base <> 'inativo'`).all(req.org)
      .map((x) => ({ ...x, ...situacaoPlano(x, x, hoje) })).filter((x) => x.situacao !== 'em_dia');
    res.json({ hoje, ordens, planos });
  });

  /** Custos: orçado e realizado em colunas separadas (nunca somados). */
  r.get('/custos', exigir('manutencao.ver'), (req, res) => {
    const de = v.dataOpcional(req.query.de, 'a data inicial') ?? '0000-01-01';
    const ate = v.dataOpcional(req.query.ate, 'a data final') ?? '9999-12-31';
    const porVeiculo = db.prepare(`SELECT v.id AS veiculo_id, v.placa, v.modelo,
      SUM(CASE WHEN m.status <> 'cancelado' AND substr(COALESCE(m.data_planejada, m.criado_em), 1, 10) BETWEEN ? AND ? THEN COALESCE(m.custo_previsto_centavos, 0) ELSE 0 END) AS orcado_centavos,
      SUM(CASE WHEN m.status = 'concluido' AND substr(m.concluido_em, 1, 10) BETWEEN ? AND ? THEN COALESCE(m.custo_realizado_centavos, 0) ELSE 0 END) AS realizado_centavos,
      SUM(CASE WHEN m.status = 'concluido' AND m.tipo = 'lavagem' AND substr(m.concluido_em, 1, 10) BETWEEN ? AND ? THEN COALESCE(m.custo_realizado_centavos, 0) ELSE 0 END) AS lavagem_centavos,
      SUM(CASE WHEN m.status = 'concluido' AND substr(m.concluido_em, 1, 10) BETWEEN ? AND ? THEN 1 ELSE 0 END) AS concluidas
      FROM veiculos v LEFT JOIN manutencoes m ON m.veiculo_id = v.id WHERE v.organizacao_id = ? GROUP BY v.id ORDER BY v.placa`)
      .all(de, ate, de, ate, de, ate, de, ate, req.org);
    const total = porVeiculo.reduce((a, x) => ({ orcado_centavos: a.orcado_centavos + x.orcado_centavos, realizado_centavos: a.realizado_centavos + x.realizado_centavos }),
      { orcado_centavos: 0, realizado_centavos: 0 });
    res.json({ de, ate, por_veiculo: porVeiculo, total, observacao: 'Orçado e realizado são grandezas distintas: não some as colunas.' });
  });

  return r;
};
