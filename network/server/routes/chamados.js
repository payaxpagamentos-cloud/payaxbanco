'use strict';

const { Router } = require('express');
const { agora, transacao, proximoNumero } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, like, conferirVersao } = require('../lib/http');
const { pode } = require('../lib/permissoes');
const { gerarComissoes } = require('../lib/comissoes');
const frota = require('../lib/frota');
const v = require('../lib/validacao');

const TIPOS = ['instalacao', 'reparo', 'fusao', 'manutencao_rede', 'vistoria', 'retirada', 'outro'];
const PRIORIDADES = ['baixa', 'media', 'alta', 'critica'];
const TIPOS_ITEM = ['confirmacao', 'numero', 'texto', 'foto'];

module.exports = (db) => {
  const r = Router();
  const ehTecnico = (req) => req.usuario.perfil === 'tecnico';
  const daEquipe = db.prepare('SELECT 1 FROM chamado_equipe WHERE chamado_id = ? AND tecnico_id = ?');
  const doTecnico = (req, c) => c.tecnico_id === req.usuario.tecnico_id || Boolean(daEquipe.get(c.id, req.usuario.tecnico_id ?? -1));

  const buscar = (req, id) => {
    const c = db.prepare('SELECT * FROM chamados WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!c || (ehTecnico(req) && !doTecnico(req, c))) throw new ErroNegocio('Chamado não encontrado.', 404);
    return c;
  };
  const evento = (req, c, acao, para, observacao = null) => db.prepare('INSERT INTO chamado_eventos (chamado_id, acao, de, para, observacao, usuario_id, em) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, acao, c.status, para, observacao, req.usuario.id, agora());

  /** Muda o status (com versão otimista e condição sobre o status atual) e registra o evento e a auditoria. */
  function mudar(req, c, para, { acao, observacao = null, sets = {}, extra } = {}) {
    transacao(db, () => {
      const cols = Object.keys(sets);
      const ok = db.prepare(`UPDATE chamados SET status = ?, atualizado_em = ?, versao = versao + 1${cols.map((k) => `, ${k} = ?`).join('')}
        WHERE id = ? AND versao = ? AND status = ?`).run(para, agora(), ...cols.map((k) => sets[k]), c.id, c.versao, c.status).changes;
      if (!ok) throw new ErroNegocio('O chamado foi alterado por outra pessoa. Recarregue.', 409);
      evento(req, c, acao, para, observacao);
      extra?.();
    });
    registrar(db, req, `chamado_${acao}`, { recurso: 'chamado', recursoId: c.id, antes: { status: c.status }, depois: { status: para, ...sets, observacao } });
  }

  const checklistDe = (c) => {
    const modelo = c.checklist_id ? db.prepare('SELECT * FROM checklist_modelos WHERE id = ?').get(c.checklist_id) : null;
    const itens = modelo ? JSON.parse(modelo.itens) : [];
    const resp = new Map(db.prepare('SELECT * FROM chamado_respostas WHERE chamado_id = ?').all(c.id).map((x) => [x.chave, x]));
    return { modelo: modelo ? { id: modelo.id, tipo_servico: modelo.tipo_servico, versao: modelo.versao } : null,
      itens: itens.map((i) => ({ ...i, resposta: resp.get(i.chave) ?? null })) };
  };
  const pendentes = (c) => checklistDe(c).itens.filter((i) => i.obrigatorio && (!i.resposta || (i.tipo === 'foto' ? !i.resposta.anexo_id
    : i.tipo === 'confirmacao' ? i.resposta.valor !== 'sim' : String(i.resposta.valor ?? '').trim() === '')));

  const detalhe = (req, id) => {
    const c = db.prepare(`SELECT c.*, t.nome AS tecnico_nome, v.placa AS veiculo_placa, v.modelo AS veiculo_modelo, a.codigo AS ativo_codigo, a.tipo AS ativo_tipo,
      i.titulo AS incidente_titulo, i.status AS incidente_status FROM chamados c LEFT JOIN tecnicos t ON t.id = c.tecnico_id LEFT JOIN veiculos v ON v.id = c.veiculo_id
      LEFT JOIN ativos_rede a ON a.id = c.ativo_id LEFT JOIN incidentes i ON i.id = c.incidente_id WHERE c.id = ?`).get(Number(id));
    const podeComissoes = pode(req.usuario.perfil, 'comissoes.ver');
    return {
      ...c,
      checklist: checklistDe(c),
      pendencias: pendentes(c).map((i) => i.rotulo),
      equipe: db.prepare('SELECT e.*, t.nome FROM chamado_equipe e JOIN tecnicos t ON t.id = e.tecnico_id WHERE chamado_id = ?').all(c.id),
      eventos: db.prepare('SELECT e.*, u.nome AS usuario_nome FROM chamado_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE chamado_id = ? ORDER BY e.id').all(c.id),
      anexos: db.prepare("SELECT id, nome, mime, tamanho, criado_em FROM anexos WHERE recurso = 'chamado' AND recurso_id = ? ORDER BY id").all(c.id),
      comissoes: podeComissoes ? db.prepare(`SELECT co.id, co.tecnico_id, t.nome AS tecnico_nome, co.valor_centavos, co.status, co.base FROM comissoes co
        JOIN tecnicos t ON t.id = co.tecnico_id WHERE co.chamado_id = ?${ehTecnico(req) ? ' AND co.tecnico_id = ?' : ''}`)
        .all(...[c.id, ...(ehTecnico(req) ? [req.usuario.tecnico_id] : [])]) : [],
    };
  };

  // ---------------- Fila ----------------
  r.get('/', exigir('chamados.ver'), (req, res) => {
    const f = ['c.organizacao_id = ?'];
    const p = [req.org];
    if (ehTecnico(req)) { f.push('(c.tecnico_id = ? OR c.id IN (SELECT chamado_id FROM chamado_equipe WHERE tecnico_id = ?))'); p.push(req.usuario.tecnico_id ?? -1, req.usuario.tecnico_id ?? -1); }
    if (req.query.status) { const s = String(req.query.status).split(','); f.push(`c.status IN (${s.map(() => '?').join(',')})`); p.push(...s); }
    for (const k of ['prioridade', 'tipo', 'bairro']) if (req.query[k]) { f.push(`c.${k} = ?`); p.push(String(req.query[k])); }
    if (req.query.tecnico_id) { f.push('c.tecnico_id = ?'); p.push(Number(req.query.tecnico_id)); }
    if (req.query.abertos === '1') f.push("c.status NOT IN ('aprovado','cancelado')");
    if (req.query.busca) {
      const n = Number(String(req.query.busca).replace(/\D/g, ''));
      f.push("(c.titulo LIKE ? ESCAPE '\\' OR c.endereco LIKE ? ESCAPE '\\' OR c.cliente_ref LIKE ? ESCAPE '\\' OR c.numero = ?)");
      p.push(like(req.query.busca), like(req.query.busca), like(req.query.busca), Number.isFinite(n) ? n : -1);
    }
    if (req.query.de) { f.push('c.agendado_para >= ?'); p.push(String(req.query.de)); }
    if (req.query.ate) { f.push('c.agendado_para < ?'); p.push(String(req.query.ate)); }
    res.json(listaPaginada(db, `SELECT c.*, t.nome AS tecnico_nome, v.placa AS veiculo_placa, a.codigo AS ativo_codigo FROM chamados c
      LEFT JOIN tecnicos t ON t.id = c.tecnico_id LEFT JOIN veiculos v ON v.id = c.veiculo_id LEFT JOIN ativos_rede a ON a.id = c.ativo_id
      WHERE ${f.join(' AND ')} ORDER BY CASE c.prioridade WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, COALESCE(c.prazo, c.agendado_para, c.criado_em)`,
    p, req.query, { padrao: 100 }));
  });

  r.post('/', exigir('chamados.criar'), (req, res) => {
    const b = req.body ?? {};
    const tipo = v.opcao(b.tipo, 'o tipo', TIPOS);
    const temCoord = b.lat !== undefined && b.lat !== '' && b.lat !== null;
    const [lat, lng] = temCoord ? v.coordenadas(b.lat, b.lng) : [null, null];
    const d = {
      tipo, titulo: v.texto(b.titulo, 'o título', 160), descricao: v.opcional(b.descricao, 'a descrição', 2000), prioridade: v.opcao(b.prioridade ?? 'media', 'a prioridade', PRIORIDADES),
      bairro: v.opcional(b.bairro, 'o bairro', 80), cliente_ref: v.opcional(b.cliente_ref, 'a referência do cliente', 80), endereco: v.opcional(b.endereco, 'o endereço', 200),
      lat, lng, agendado_para: v.instanteOpcional(b.agendado_para, 'o agendamento'), prazo: v.instanteOpcional(b.prazo, 'o prazo'),
      ativo_id: null, incidente_id: null,
    };
    if (b.ativo_id) {
      const a = db.prepare('SELECT id, lat, lng, endereco, bairro FROM ativos_rede WHERE id = ? AND organizacao_id = ?').get(Number(b.ativo_id), req.org);
      if (!a) throw new ErroNegocio('Ativo não encontrado.', 422);
      d.ativo_id = a.id;
      d.lat ??= a.lat; d.lng ??= a.lng; d.endereco ??= a.endereco; d.bairro ??= a.bairro;
    }
    if (b.incidente_id) {
      const i = db.prepare('SELECT id FROM incidentes WHERE id = ? AND organizacao_id = ?').get(Number(b.incidente_id), req.org);
      if (!i) throw new ErroNegocio('Incidente não encontrado.', 422);
      d.incidente_id = i.id;
    }
    const modelo = db.prepare('SELECT id FROM checklist_modelos WHERE organizacao_id = ? AND tipo_servico = ? AND ativo = 1 ORDER BY versao DESC LIMIT 1').get(req.org, tipo);
    const id = transacao(db, () => {
      const numero = proximoNumero(db, req.org, 'chamado');
      const t = agora();
      const nid = Number(db.prepare(`INSERT INTO chamados (organizacao_id, numero, tipo, titulo, descricao, prioridade, bairro, cliente_ref, endereco, lat, lng, ativo_id, incidente_id,
        agendado_para, prazo, checklist_id, criado_por, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, numero, d.tipo, d.titulo,
        d.descricao, d.prioridade, d.bairro, d.cliente_ref, d.endereco, d.lat, d.lng, d.ativo_id, d.incidente_id, d.agendado_para, d.prazo, modelo?.id ?? null, req.usuario.id, t, t).lastInsertRowid);
      db.prepare("INSERT INTO chamado_eventos (chamado_id, acao, para, usuario_id, em) VALUES (?, 'criado', 'aberto', ?, ?)").run(nid, req.usuario.id, t);
      if (d.incidente_id) db.prepare("INSERT INTO incidente_eventos (incidente_id, tipo, detalhes, usuario_id, em) VALUES (?, 'chamado_associado', ?, ?, ?)").run(d.incidente_id, `Chamado #${numero}`, req.usuario.id, t);
      return nid;
    });
    registrar(db, req, 'chamado_criado', { recurso: 'chamado', recursoId: id, depois: d });
    res.status(201).json(detalhe(req, id));
  });

  r.get('/:id', exigir('chamados.ver'), (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    buscar(req, req.params.id);
    res.json(detalhe(req, req.params.id));
  });

  // ---------------- Distribuição ----------------
  /** Atribui técnico e veículo. Recusa veículo indisponível (com o motivo) e sinaliza conflitos de agenda. */
  r.post('/:id/atribuir', exigir('chamados.atribuir'), (req, res) => {
    const c = buscar(req, req.params.id);
    conferirVersao(c.versao, req.body?.versao);
    v.exigir(['aberto', 'atribuido', 'retornado'].includes(c.status), `Chamado ${c.status}: não pode ser redistribuído.`);
    const b = req.body ?? {};
    const tec = db.prepare("SELECT * FROM tecnicos WHERE id = ? AND organizacao_id = ? AND status = 'ativo'").get(Number(b.tecnico_id), req.org);
    if (!tec) throw new ErroNegocio('Técnico não encontrado ou não ativo.', 422);
    let veic = null;
    if (b.veiculo_id) {
      veic = db.prepare('SELECT * FROM veiculos WHERE id = ? AND organizacao_id = ?').get(Number(b.veiculo_id), req.org);
      if (!veic) throw new ErroNegocio('Veículo não encontrado.', 422);
      frota.exigirDisponivel(db, veic);
    }
    const agendado = b.agendado_para !== undefined ? v.instanteOpcional(b.agendado_para, 'o agendamento') : c.agendado_para;
    const equipe = Array.isArray(b.equipe) && b.equipe.length ? b.equipe.map((e) => ({ tecnico_id: Number(e.tecnico_id), percentual: v.inteiro(e.percentual, 'o percentual', { min: 1, max: 100 }) })) : [];
    if (equipe.length) {
      v.exigir(equipe.some((e) => e.tecnico_id === tec.id), 'O técnico principal precisa estar no rateio da equipe.');
      v.exigir(new Set(equipe.map((e) => e.tecnico_id)).size === equipe.length, 'Técnico repetido na equipe.');
      v.exigir(equipe.reduce((a, e) => a + e.percentual, 0) === 100, 'Os percentuais da equipe precisam somar 100.');
      for (const e of equipe) if (!db.prepare("SELECT 1 FROM tecnicos WHERE id = ? AND organizacao_id = ? AND status = 'ativo'").get(e.tecnico_id, req.org)) throw new ErroNegocio('Técnico da equipe não encontrado.', 422);
    }
    const dia = agendado ? agendado.slice(0, 10) : null;
    const conflitos = frota.conflitosAgenda(db, req.org, { veiculoId: veic?.id, tecnicoId: tec.id, dia, ignorarChamado: c.id });
    if (conflitos.length && b.aceitar_conflito !== true) {
      throw new ErroNegocio('Conflito de agenda: técnico ou veículo já tem chamado ativo neste dia. Confirme para manter.', 409, { conflitos });
    }
    mudar(req, c, 'atribuido', {
      acao: 'atribuido', observacao: `${tec.nome}${veic ? ` · ${veic.placa}` : ''}${conflitos.length ? ' (conflito de agenda aceito)' : ''}`,
      sets: { tecnico_id: tec.id, veiculo_id: veic?.id ?? null, agendado_para: agendado },
      extra: () => {
        db.prepare('DELETE FROM chamado_equipe WHERE chamado_id = ?').run(c.id);
        for (const e of equipe) db.prepare('INSERT INTO chamado_equipe (chamado_id, tecnico_id, percentual) VALUES (?, ?, ?)').run(c.id, e.tecnico_id, e.percentual);
      },
    });
    res.json(detalhe(req, c.id));
  });

  r.post('/:id/reagendar', exigir('chamados.atribuir'), (req, res) => {
    const c = buscar(req, req.params.id);
    conferirVersao(c.versao, req.body?.versao);
    v.exigir(['aberto', 'atribuido', 'em_rota', 'retornado'].includes(c.status), 'Chamado em execução ou encerrado não pode ser reagendado.');
    const agendado = v.instante(req.body?.agendado_para, 'o novo agendamento');
    const motivo = v.texto(req.body?.motivo, 'o motivo do reagendamento', 300);
    const para = c.status === 'em_rota' ? 'atribuido' : c.status;
    mudar(req, c, para, { acao: 'reagendado', observacao: `${motivo} (de ${c.agendado_para ?? 'sem data'} para ${agendado})`, sets: { agendado_para: agendado } });
    res.json(detalhe(req, c.id));
  });

  r.post('/:id/cancelar', exigir('chamados.atribuir'), (req, res) => {
    const c = buscar(req, req.params.id);
    conferirVersao(c.versao, req.body?.versao);
    v.exigir(!['aprovado', 'cancelado'].includes(c.status), 'Chamado já encerrado.');
    mudar(req, c, 'cancelado', { acao: 'cancelado', observacao: v.texto(req.body?.motivo, 'o motivo do cancelamento', 300) });
    res.json(detalhe(req, c.id));
  });

  // ---------------- Execução (técnico) ----------------
  const executor = (req, c) => {
    if (ehTecnico(req) && !doTecnico(req, c)) throw new ErroNegocio('Chamado não encontrado.', 404);
  };

  r.post('/:id/iniciar-rota', exigir('chamados.executar'), (req, res) => {
    const c = buscar(req, req.params.id);
    executor(req, c);
    conferirVersao(c.versao, req.body?.versao);
    v.exigir(c.status === 'atribuido', 'O deslocamento começa depois da atribuição.');
    if (c.veiculo_id) frota.exigirDisponivel(db, db.prepare('SELECT * FROM veiculos WHERE id = ?').get(c.veiculo_id));
    mudar(req, c, 'em_rota', { acao: 'em_rota' });
    res.json(detalhe(req, c.id));
  });

  r.post('/:id/iniciar', exigir('chamados.executar'), (req, res) => {
    const c = buscar(req, req.params.id);
    executor(req, c);
    conferirVersao(c.versao, req.body?.versao);
    v.exigir(['atribuido', 'em_rota', 'retornado'].includes(c.status) && c.tecnico_id, 'O chamado precisa estar atribuído para iniciar a execução.');
    mudar(req, c, 'em_execucao', { acao: c.status === 'retornado' ? 'execucao_retomada' : 'em_execucao', sets: { iniciado_em: c.iniciado_em ?? agora() } });
    res.json(detalhe(req, c.id));
  });

  /** Resposta de um item do checklist. Foto exige um anexo deste chamado. */
  r.put('/:id/checklist/:chave', exigir('chamados.executar'), (req, res) => {
    const c = buscar(req, req.params.id);
    executor(req, c);
    v.exigir(c.status === 'em_execucao', 'O checklist é preenchido durante a execução.');
    const item = checklistDe(c).itens.find((i) => i.chave === req.params.chave);
    if (!item) throw new ErroNegocio('Item do checklist não encontrado.', 404);
    const b = req.body ?? {};
    let valor = null;
    let anexoId = null;
    if (item.tipo === 'numero') valor = String(v.numero(b.valor, item.rotulo.toLowerCase(), { min: -1e6, max: 1e6 }));
    if (item.tipo === 'texto') valor = v.texto(b.valor, item.rotulo.toLowerCase(), 1000);
    if (item.tipo === 'confirmacao') valor = v.booleano(b.valor) ? 'sim' : 'nao';
    if (item.tipo === 'foto') {
      const a = db.prepare("SELECT id FROM anexos WHERE id = ? AND organizacao_id = ? AND recurso = 'chamado' AND recurso_id = ? AND mime LIKE 'image/%'").get(Number(b.anexo_id), req.org, c.id);
      if (!a) throw new ErroNegocio('Envie a foto como anexo deste chamado antes de marcar o item.', 422);
      anexoId = a.id;
      valor = v.opcional(b.valor, 'a legenda', 200);
    }
    db.prepare(`INSERT INTO chamado_respostas (chamado_id, chave, valor, anexo_id, usuario_id, em) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (chamado_id, chave) DO UPDATE SET valor = excluded.valor, anexo_id = excluded.anexo_id, usuario_id = excluded.usuario_id, em = excluded.em`)
      .run(c.id, item.chave, valor, anexoId, req.usuario.id, agora());
    registrar(db, req, 'checklist_respondido', { recurso: 'chamado', recursoId: c.id, depois: { chave: item.chave, valor, anexo_id: anexoId } });
    res.json(detalhe(req, c.id));
  });

  /** Conclusão técnica: exige o checklist obrigatório completo. Não resolve incidente associado. */
  r.post('/:id/concluir', exigir('chamados.executar'), (req, res) => {
    const c = buscar(req, req.params.id);
    executor(req, c);
    conferirVersao(c.versao, req.body?.versao);
    v.exigir(c.status === 'em_execucao', 'Só um chamado em execução pode ser concluído.');
    const falta = pendentes(c);
    if (falta.length) throw new ErroNegocio(`Checklist incompleto: ${falta.map((i) => i.rotulo).join('; ')}.`, 422, { pendencias: falta.map((i) => i.chave) });
    mudar(req, c, 'em_validacao', { acao: 'concluido_tecnicamente', observacao: v.opcional(req.body?.observacao, 'a observação', 1000), sets: { concluido_em: agora() } });
    res.json(detalhe(req, c.id));
  });

  // ---------------- Validação (gestor) ----------------
  /** Aprovar gera as comissões (versão da regra vigente); retornar exige motivo e mantém a execução anterior no histórico. */
  r.post('/:id/validar', exigir('chamados.validar'), (req, res) => {
    const c = buscar(req, req.params.id);
    conferirVersao(c.versao, req.body?.versao);
    v.exigir(c.status === 'em_validacao', 'O chamado não está aguardando validação.');
    const decisao = v.opcao(req.body?.decisao, 'a decisão', ['aprovar', 'retornar']);
    if (decisao === 'retornar') {
      mudar(req, c, 'retornado', { acao: 'retornado', observacao: v.texto(req.body?.motivo, 'o motivo da devolução', 500), sets: { retrabalho: c.retrabalho + 1 } });
      return res.json(detalhe(req, c.id));
    }
    let resultado;
    mudar(req, c, 'aprovado', { acao: 'aprovado', observacao: v.opcional(req.body?.observacao, 'a observação', 500), sets: { aprovado_em: agora(), aprovado_por: req.usuario.id },
      extra: () => { resultado = gerarComissoes(db, req, { ...c, status: 'aprovado' }); } });
    if (resultado.aviso) evento(req, { ...c, status: 'aprovado' }, 'comissao_nao_gerada', 'aprovado', resultado.aviso);
    res.json({ ...detalhe(req, c.id), comissoes_geradas: resultado.geradas, aviso_comissao: resultado.aviso });
  });

  /** Reabertura de chamado aprovado: não apaga histórico; comissões ainda não pagas ficam suspensas; pagas exigem ajuste explícito. */
  r.post('/:id/reabrir', exigir('chamados.validar'), (req, res) => {
    const c = buscar(req, req.params.id);
    conferirVersao(c.versao, req.body?.versao);
    v.exigir(c.status === 'aprovado', 'Só um chamado aprovado pode ser reaberto.');
    const motivo = v.texto(req.body?.motivo, 'o motivo da reabertura', 500);
    const pagas = db.prepare("SELECT id FROM comissoes WHERE chamado_id = ? AND status = 'paga'").all(c.id).map((x) => x.id);
    mudar(req, c, 'retornado', { acao: 'reaberto', observacao: motivo, sets: { retrabalho: c.retrabalho + 1 }, extra: () => {
      for (const co of db.prepare("SELECT id, status FROM comissoes WHERE chamado_id = ? AND status IN ('aguardando_aprovacao','aprovada')").all(c.id)) {
        db.prepare("UPDATE comissoes SET status = 'suspensa' WHERE id = ?").run(co.id);
        db.prepare("INSERT INTO comissao_eventos (comissao_id, de, para, motivo, usuario_id, em) VALUES (?, ?, 'suspensa', ?, ?, ?)").run(co.id, co.status, `Chamado reaberto: ${motivo}`, req.usuario.id, agora());
      }
    } });
    res.json({ ...detalhe(req, c.id), comissoes_pagas: pagas, aviso: pagas.length ? 'Há comissão com pagamento registrado: use um ajuste (estorno ou complemento) com motivo.' : null });
  });

  // ---------------- Checklists por tipo (versões) ----------------
  r.get('/checklists', exigir('chamados.ver'), (req, res) => {
    res.json(db.prepare('SELECT * FROM checklist_modelos WHERE organizacao_id = ? AND ativo = 1 ORDER BY tipo_servico').all(req.org).map((m) => ({ ...m, itens: JSON.parse(m.itens) })));
  });

  /** Nova versão do checklist de um tipo. Chamados já criados mantêm a versão com que nasceram. */
  r.post('/checklists', exigir('chamados.checklists'), (req, res) => {
    const tipo = v.opcao(req.body?.tipo_servico, 'o tipo de serviço', TIPOS);
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
    v.exigir(itens.length >= 1 && itens.length <= 30, 'Informe de 1 a 30 itens.');
    const limpos = itens.map((i, n) => ({
      chave: String(i.chave || `item_${n + 1}`).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40), rotulo: v.texto(i.rotulo, 'o rótulo do item', 120),
      tipo: v.opcao(i.tipo, 'o tipo do item', TIPOS_ITEM), obrigatorio: v.booleano(i.obrigatorio), ...(i.unidade ? { unidade: v.texto(i.unidade, 'a unidade', 20) } : {}),
    }));
    v.exigir(new Set(limpos.map((i) => i.chave)).size === limpos.length, 'Chaves dos itens repetidas.');
    const id = transacao(db, () => {
      const ultima = db.prepare('SELECT COALESCE(MAX(versao), 0) AS n FROM checklist_modelos WHERE organizacao_id = ? AND tipo_servico = ?').get(req.org, tipo).n;
      db.prepare('UPDATE checklist_modelos SET ativo = 0 WHERE organizacao_id = ? AND tipo_servico = ?').run(req.org, tipo);
      return Number(db.prepare('INSERT INTO checklist_modelos (organizacao_id, tipo_servico, versao, itens, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.org, tipo, ultima + 1, JSON.stringify(limpos), req.usuario.id, agora()).lastInsertRowid);
    });
    registrar(db, req, 'checklist_versionado', { recurso: 'checklist', recursoId: id, depois: { tipo, itens: limpos } });
    res.status(201).json({ id, tipo_servico: tipo, itens: limpos });
  });

  return r;
};
