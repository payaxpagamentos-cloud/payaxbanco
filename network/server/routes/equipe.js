'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada } = require('../lib/http');
const { saldo, versaoVigente } = require('../lib/comissoes');
const { vincular } = require('../lib/anexos');
const v = require('../lib/validacao');

const TIPOS_SERVICO = ['instalacao', 'reparo', 'fusao', 'manutencao_rede', 'vistoria', 'retirada', 'outro'];

module.exports = (db) => {
  const r = Router();
  const ehTecnico = (req) => req.usuario.perfil === 'tecnico';

  // ---------------- Técnicos ----------------
  r.get('/tecnicos', exigir('equipe.ver', 'chamados.atribuir', 'combustivel.lancar'), (req, res) => {
    const f = ['t.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.ativos === '1') f.push("t.status = 'ativo'");
    res.json(db.prepare(`SELECT t.*, u.email AS usuario_email, (SELECT v.placa FROM veiculo_responsaveis vr JOIN veiculos v ON v.id = vr.veiculo_id
      WHERE vr.tecnico_id = t.id AND vr.fim IS NULL) AS veiculo_placa,
      (SELECT COUNT(*) FROM chamados c WHERE c.tecnico_id = t.id AND c.status IN ('atribuido','em_rota','em_execucao')) AS chamados_ativos
      FROM tecnicos t LEFT JOIN usuarios u ON u.id = t.usuario_id WHERE ${f.join(' AND ')} ORDER BY t.nome`).all(...p));
  });

  const dadosTecnico = (req, b, a = {}) => {
    const val = (k, fn) => (b[k] !== undefined ? fn(b[k]) : a[k] ?? null);
    const usuarioId = val('usuario_id', (x) => {
      if (!x) return null;
      const u = db.prepare("SELECT id FROM usuarios WHERE id = ? AND organizacao_id = ? AND perfil = 'tecnico'").get(Number(x), req.org);
      if (!u) throw new ErroNegocio('Usuário com perfil Técnico não encontrado.', 422);
      return u.id;
    });
    return { usuario_id: usuarioId, nome: val('nome', (x) => v.texto(x, 'o nome', 120)),
      status: val('status', (x) => v.opcao(x, 'a situação', ['ativo', 'afastado', 'inativo'])) ?? 'ativo',
      especialidades: val('especialidades', (x) => v.opcional(x, 'as especialidades', 300)), regioes: val('regioes', (x) => v.opcional(x, 'as regiões', 300)),
      equipe: val('equipe', (x) => v.opcional(x, 'a equipe', 80)), telefone: val('telefone', (x) => (x ? v.telefone(x) : null)) };
  };

  r.post('/tecnicos', exigir('equipe.editar'), (req, res) => {
    const d = dadosTecnico(req, req.body ?? {});
    v.exigir(d.nome, 'Informe o nome.');
    const id = Number(db.prepare(`INSERT INTO tecnicos (organizacao_id, usuario_id, nome, status, especialidades, regioes, equipe, telefone, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.org, d.usuario_id, d.nome, d.status, d.especialidades, d.regioes, d.equipe, d.telefone, agora()).lastInsertRowid);
    registrar(db, req, 'tecnico_criado', { recurso: 'tecnico', recursoId: id, depois: d });
    res.status(201).json({ id, ...d });
  });

  r.patch('/tecnicos/:id', exigir('equipe.editar'), (req, res) => {
    const a = db.prepare('SELECT * FROM tecnicos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!a) throw new ErroNegocio('Técnico não encontrado.', 404);
    const d = dadosTecnico(req, req.body ?? {}, a);
    db.prepare('UPDATE tecnicos SET usuario_id = ?, nome = ?, status = ?, especialidades = ?, regioes = ?, equipe = ?, telefone = ? WHERE id = ?')
      .run(d.usuario_id, d.nome, d.status, d.especialidades, d.regioes, d.equipe, d.telefone, a.id);
    registrar(db, req, 'tecnico_alterado', { recurso: 'tecnico', recursoId: a.id, antes: a, depois: d });
    res.json({ id: a.id, ...d });
  });

  /** Produtividade no período: concluídos, aprovados, tempo médio de atendimento, prazo cumprido e retrabalho. */
  r.get('/produtividade', exigir('equipe.ver'), (req, res) => {
    const de = v.dataOpcional(req.query.de, 'a data inicial') ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const ate = v.dataOpcional(req.query.ate, 'a data final') ?? new Date().toISOString().slice(0, 10);
    const fimExclusivo = new Date(Date.parse(`${ate}T00:00:00Z`) + 86400_000).toISOString();
    const linhas = db.prepare(`SELECT t.id, t.nome, t.status,
      SUM(CASE WHEN c.concluido_em >= ? AND c.concluido_em < ? THEN 1 ELSE 0 END) AS concluidos,
      SUM(CASE WHEN c.status = 'aprovado' AND c.aprovado_em >= ? AND c.aprovado_em < ? THEN 1 ELSE 0 END) AS aprovados,
      AVG(CASE WHEN c.concluido_em >= ? AND c.concluido_em < ? AND c.iniciado_em IS NOT NULL THEN (julianday(c.concluido_em) - julianday(c.iniciado_em)) * 1440 END) AS minutos_medios,
      SUM(CASE WHEN c.concluido_em >= ? AND c.concluido_em < ? AND c.prazo IS NOT NULL THEN 1 ELSE 0 END) AS com_prazo,
      SUM(CASE WHEN c.concluido_em >= ? AND c.concluido_em < ? AND c.prazo IS NOT NULL AND c.concluido_em <= c.prazo THEN 1 ELSE 0 END) AS no_prazo,
      SUM(CASE WHEN c.concluido_em >= ? AND c.concluido_em < ? AND c.retrabalho > 0 THEN 1 ELSE 0 END) AS retrabalho
      FROM tecnicos t LEFT JOIN chamados c ON c.tecnico_id = t.id WHERE t.organizacao_id = ? GROUP BY t.id ORDER BY t.nome`)
      .all(...Array(6).fill([`${de}T00:00:00.000Z`, fimExclusivo]).flat(), req.org);
    res.json({ de, ate, fonte: 'Chamados técnicos (concluído = conclusão técnica; aprovado = validação do gestor)', tecnicos: linhas.map((l) => ({
      ...l, minutos_medios: l.minutos_medios === null ? null : Math.round(l.minutos_medios), cumprimento_prazo: l.com_prazo ? Math.round((l.no_prazo / l.com_prazo) * 1000) / 10 : null,
    })) });
  });

  // ---------------- Regras de comissão (versionadas) ----------------
  r.get('/regras', exigir('comissoes.ver'), (req, res) => {
    const regras = db.prepare('SELECT * FROM comissao_regras WHERE organizacao_id = ? ORDER BY tipo_servico').all(req.org);
    res.json(regras.map((x) => ({ ...x, vigente: versaoVigente(db, req.org, x.tipo_servico),
      versoes: db.prepare('SELECT v.*, u.nome AS criado_por_nome FROM comissao_versoes v LEFT JOIN usuarios u ON u.id = v.criado_por WHERE regra_id = ? ORDER BY versao DESC').all(x.id) })));
  });

  const dadosVersao = (b) => {
    const modo = v.opcao(b.modo ?? 'fixo', 'o modo', ['fixo', 'por_unidade']);
    return { modo, valor_centavos: v.centavos(b.valor, 'o valor'), campo_unidade: modo === 'por_unidade' ? v.texto(b.campo_unidade, 'o item do checklist com a quantidade', 40) : null };
  };

  /** Cria a regra do tipo de serviço, ou uma nova versão se ela já existe. A versão nova vale só para aprovações futuras. */
  r.post('/regras', exigir('comissoes.regras'), (req, res) => {
    const b = req.body ?? {};
    const tipo = v.opcao(b.tipo_servico, 'o tipo de serviço', TIPOS_SERVICO);
    const d = dadosVersao(b);
    const resultado = transacao(db, () => {
      let regra = db.prepare('SELECT * FROM comissao_regras WHERE organizacao_id = ? AND tipo_servico = ?').get(req.org, tipo);
      if (!regra) {
        const id = Number(db.prepare('INSERT INTO comissao_regras (organizacao_id, tipo_servico, nome, criado_em) VALUES (?, ?, ?, ?)')
          .run(req.org, tipo, v.texto(b.nome ?? tipo, 'o nome', 80), agora()).lastInsertRowid);
        regra = db.prepare('SELECT * FROM comissao_regras WHERE id = ?').get(id);
      } else if (b.nome) {
        db.prepare('UPDATE comissao_regras SET nome = ?, ativa = 1 WHERE id = ?').run(v.texto(b.nome, 'o nome', 80), regra.id);
      }
      const versao = db.prepare('SELECT COALESCE(MAX(versao), 0) AS n FROM comissao_versoes WHERE regra_id = ?').get(regra.id).n + 1;
      db.prepare('INSERT INTO comissao_versoes (regra_id, versao, modo, valor_centavos, campo_unidade, vigente_desde, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(regra.id, versao, d.modo, d.valor_centavos, d.campo_unidade, agora(), req.usuario.id);
      return { regra_id: regra.id, versao };
    });
    registrar(db, req, 'regra_comissao_versionada', { recurso: 'comissao_regra', recursoId: resultado.regra_id, depois: { tipo, ...d, versao: resultado.versao } });
    res.status(201).json({ ...resultado, tipo_servico: tipo, ...d });
  });

  r.post('/regras/:id/desativar', exigir('comissoes.regras'), (req, res) => {
    const x = db.prepare('SELECT * FROM comissao_regras WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!x) throw new ErroNegocio('Regra não encontrada.', 404);
    db.prepare('UPDATE comissao_regras SET ativa = 0 WHERE id = ?').run(x.id);
    registrar(db, req, 'regra_comissao_desativada', { recurso: 'comissao_regra', recursoId: x.id });
    res.json({ ok: true });
  });

  // ---------------- Comissões ----------------
  const comissao = (req, id) => {
    const c = db.prepare(`SELECT co.*, t.usuario_id AS tecnico_usuario_id FROM comissoes co JOIN tecnicos t ON t.id = co.tecnico_id
      WHERE co.id = ? AND co.organizacao_id = ?`).get(Number(id), req.org);
    if (!c || (ehTecnico(req) && c.tecnico_id !== req.usuario.tecnico_id)) throw new ErroNegocio('Comissão não encontrada.', 404);
    return c;
  };
  /** Ninguém aprova, ajusta ou registra pagamento da própria comissão. */
  const naoPropria = (req, c) => {
    if (c.tecnico_usuario_id === req.usuario.id || c.tecnico_id === req.usuario.tecnico_id) throw new ErroNegocio('Você não pode aprovar ou alterar a própria comissão.', 403);
  };
  const eventoComissao = (req, id, de, para, motivo) => db.prepare('INSERT INTO comissao_eventos (comissao_id, de, para, motivo, usuario_id, em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, de, para, motivo, req.usuario.id, agora());

  r.get('/comissoes', exigir('comissoes.ver'), (req, res) => {
    const base = ['co.organizacao_id = ?'];
    const pBase = [req.org];
    if (ehTecnico(req)) { base.push('co.tecnico_id = ?'); pBase.push(req.usuario.tecnico_id ?? -1); }
    if (req.query.tecnico_id) { base.push('co.tecnico_id = ?'); pBase.push(Number(req.query.tecnico_id)); }
    const f = [...base];
    const p = [...pBase];
    if (req.query.status) { f.push('co.status = ?'); p.push(String(req.query.status)); }
    const SALDO = 'co.valor_centavos + COALESCE((SELECT SUM(a.valor_centavos) FROM comissao_ajustes a WHERE a.comissao_id = co.id), 0)';
    const lista = listaPaginada(db, `SELECT co.*, t.nome AS tecnico_nome, c.numero AS chamado_numero, c.titulo AS chamado_titulo, c.tipo AS chamado_tipo,
      cv.versao AS regra_versao, u.nome AS aprovado_por_nome, ${SALDO} AS saldo_centavos
      FROM comissoes co JOIN tecnicos t ON t.id = co.tecnico_id JOIN chamados c ON c.id = co.chamado_id JOIN comissao_versoes cv ON cv.id = co.versao_id
      LEFT JOIN usuarios u ON u.id = co.aprovado_por WHERE ${f.join(' AND ')} ORDER BY co.id DESC`, p, req.query);
    const totais = db.prepare(`SELECT co.status, SUM(${SALDO}) AS total_centavos, COUNT(*) AS quantidade FROM comissoes co WHERE ${base.join(' AND ')} GROUP BY co.status`).all(...pBase);
    res.json({ ...lista, totais });
  });

  r.get('/comissoes/:id', exigir('comissoes.ver'), (req, res) => {
    const c = comissao(req, req.params.id);
    res.json({ ...c, saldo_centavos: saldo(db, c),
      versao: db.prepare('SELECT * FROM comissao_versoes WHERE id = ?').get(c.versao_id),
      ajustes: db.prepare('SELECT a.*, u.nome AS criado_por_nome FROM comissao_ajustes a LEFT JOIN usuarios u ON u.id = a.criado_por WHERE comissao_id = ? ORDER BY a.id').all(c.id),
      eventos: db.prepare('SELECT e.*, u.nome AS usuario_nome FROM comissao_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE comissao_id = ? ORDER BY e.id').all(c.id),
      pagamento: db.prepare(`SELECT p.*, i.valor_centavos AS valor_item FROM comissao_pagamento_itens i JOIN comissao_pagamentos p ON p.id = i.pagamento_id WHERE i.comissao_id = ?`).get(c.id) ?? null });
  });

  /** Aprovação: só de comissões aguardando, nunca da própria; repetir a chamada não muda nada (condição sobre o status). */
  r.post('/comissoes/:id/aprovar', exigir('comissoes.aprovar'), (req, res) => {
    const c = comissao(req, req.params.id);
    naoPropria(req, c);
    if (c.status === 'aprovada') return res.json({ id: c.id, status: 'aprovada', ja_aprovada: true });
    v.exigir(c.status === 'aguardando_aprovacao', `Comissão ${c.status}: não pode ser aprovada.`);
    transacao(db, () => {
      const ok = db.prepare("UPDATE comissoes SET status = 'aprovada', aprovado_por = ?, aprovado_em = ? WHERE id = ? AND status = 'aguardando_aprovacao'")
        .run(req.usuario.id, agora(), c.id).changes;
      if (ok) eventoComissao(req, c.id, c.status, 'aprovada', v.opcional(req.body?.observacao, 'a observação', 300));
    });
    registrar(db, req, 'comissao_aprovada', { recurso: 'comissao', recursoId: c.id, antes: { status: c.status }, depois: { status: 'aprovada', valor_centavos: c.valor_centavos } });
    res.json({ id: c.id, status: 'aprovada' });
  });

  r.post('/comissoes/:id/rejeitar', exigir('comissoes.aprovar'), (req, res) => {
    const c = comissao(req, req.params.id);
    naoPropria(req, c);
    v.exigir(['aguardando_aprovacao', 'suspensa'].includes(c.status), `Comissão ${c.status}: não pode ser rejeitada.`);
    const motivo = v.texto(req.body?.motivo, 'o motivo', 300);
    transacao(db, () => {
      db.prepare("UPDATE comissoes SET status = 'rejeitada', motivo = ? WHERE id = ?").run(motivo, c.id);
      eventoComissao(req, c.id, c.status, 'rejeitada', motivo);
    });
    registrar(db, req, 'comissao_rejeitada', { recurso: 'comissao', recursoId: c.id, antes: { status: c.status }, depois: { status: 'rejeitada', motivo } });
    res.json({ id: c.id, status: 'rejeitada' });
  });

  /** Ajuste (complemento ou estorno): novo registro com motivo; o valor original fica preservado. */
  r.post('/comissoes/:id/ajustes', exigir('comissoes.aprovar'), (req, res) => {
    const c = comissao(req, req.params.id);
    naoPropria(req, c);
    v.exigir(['aprovada', 'paga', 'suspensa'].includes(c.status), 'Ajustes valem para comissões aprovadas, pagas ou suspensas.');
    const valor = v.centavos(req.body?.valor, 'o valor do ajuste', { min: -1e9 });
    v.exigir(valor !== 0, 'O ajuste não pode ser zero.');
    const motivo = v.texto(req.body?.motivo, 'o motivo do ajuste', 300);
    v.exigir(saldo(db, c) + valor >= 0, 'O ajuste deixaria a comissão com saldo negativo.');
    const id = transacao(db, () => {
      const nid = Number(db.prepare('INSERT INTO comissao_ajustes (comissao_id, valor_centavos, motivo, criado_por, criado_em) VALUES (?, ?, ?, ?, ?)')
        .run(c.id, valor, motivo, req.usuario.id, agora()).lastInsertRowid);
      eventoComissao(req, c.id, c.status, c.status, `Ajuste de ${valor} centavos: ${motivo}`);
      return nid;
    });
    registrar(db, req, 'comissao_ajustada', { recurso: 'comissao', recursoId: c.id, depois: { ajuste_id: id, valor_centavos: valor, motivo } });
    res.status(201).json({ id, comissao_id: c.id, valor_centavos: valor, saldo_centavos: saldo(db, c) });
  });

  // ---------------- Pagamentos registrados ----------------
  r.get('/pagamentos', exigir('comissoes.pagar'), (req, res) => {
    const lista = listaPaginada(db, `SELECT p.*, u.nome AS registrado_por_nome, (SELECT COUNT(*) FROM comissao_pagamento_itens i WHERE i.pagamento_id = p.id) AS comissoes,
      (SELECT COUNT(*) FROM anexos a WHERE a.recurso = 'comissao_pagamento' AND a.recurso_id = p.id) AS comprovantes
      FROM comissao_pagamentos p LEFT JOIN usuarios u ON u.id = p.registrado_por WHERE p.organizacao_id = ? ORDER BY p.id DESC`, [req.org], req.query);
    res.json(lista);
  });

  /**
   * Registro ADMINISTRATIVO de pagamento de comissões aprovadas: data, referência, comprovante e responsável.
   * Não inicia transferência bancária. O valor registrado é o saldo aprovado de cada comissão (nunca maior).
   */
  r.post('/pagamentos', exigir('comissoes.pagar'), (req, res) => {
    const b = req.body ?? {};
    const ids = [...new Set((Array.isArray(b.comissao_ids) ? b.comissao_ids : []).map(Number))];
    v.exigir(ids.length >= 1 && ids.length <= 500, 'Selecione de 1 a 500 comissões aprovadas.');
    const d = { data_pagamento: v.data(b.data_pagamento, 'a data do pagamento'), referencia: v.texto(b.referencia, 'a referência (ex.: número do comprovante)', 120),
      observacoes: v.opcional(b.observacoes, 'as observações', 500) };
    const resultado = transacao(db, () => {
      const itens = ids.map((id) => {
        const c = comissao(req, id);
        naoPropria(req, c);
        if (c.status !== 'aprovada') throw new ErroNegocio(`A comissão #${c.id} está ${c.status}: só comissões aprovadas entram no pagamento.`, 409);
        const valor = saldo(db, c);
        v.exigir(valor > 0, `A comissão #${c.id} não tem saldo a pagar.`);
        return { c, valor };
      });
      const total = itens.reduce((a, x) => a + x.valor, 0);
      const pid = Number(db.prepare(`INSERT INTO comissao_pagamentos (organizacao_id, data_pagamento, referencia, valor_centavos, observacoes, registrado_por, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.org, d.data_pagamento, d.referencia, total, d.observacoes, req.usuario.id, agora()).lastInsertRowid);
      for (const { c, valor } of itens) {
        db.prepare('INSERT INTO comissao_pagamento_itens (pagamento_id, comissao_id, valor_centavos) VALUES (?, ?, ?)').run(pid, c.id, valor);
        const ok = db.prepare("UPDATE comissoes SET status = 'paga' WHERE id = ? AND status = 'aprovada'").run(c.id).changes;
        if (!ok) throw new ErroNegocio(`A comissão #${c.id} foi alterada durante o registro.`, 409);
        eventoComissao(req, c.id, 'aprovada', 'paga', `Pagamento registrado #${pid} (${d.referencia})`);
      }
      vincular(db, req, 'comissao_pagamento', pid, b.comprovante_id);
      return { id: pid, total };
    });
    registrar(db, req, 'pagamento_comissao_registrado', { recurso: 'comissao_pagamento', recursoId: resultado.id, depois: { ...d, comissoes: ids, valor_centavos: resultado.total } });
    res.status(201).json({ id: resultado.id, valor_centavos: resultado.total, comissoes: ids, ...d, transferencia_bancaria: false,
      aviso: 'Registro administrativo: nenhuma transferência bancária foi executada pelo sistema.' });
  });

  return r;
};
