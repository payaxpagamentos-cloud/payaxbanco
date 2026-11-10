'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada } = require('../lib/http');
const noc = require('../lib/noc');
const base = require('../conectores/base');
const rastreador = require('../conectores/rastreador');
const downdetector = require('../conectores/downdetector');
const { criarToken, ESCOPOS } = require('./coletor');
const v = require('../lib/validacao');

const SEV = ['critica', 'alta', 'media', 'baixa'];

module.exports = (db) => {
  const r = Router();
  const incidente = (req, id) => {
    const x = db.prepare('SELECT * FROM incidentes WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Incidente não encontrado.', 404);
    return x;
  };
  const org = (req) => db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org);

  /** Estado das fontes: rastreador, Downdetector e coletores de monitoramento (última amostra por fonte). */
  function fontes(req) {
    const o = org(req);
    const ra = base.ler(db, req.org, 'rastreador');
    const dd = base.ler(db, req.org, 'downdetector');
    const coletas = db.prepare('SELECT fonte, MAX(observado_em) AS ultima, MAX(recebido_em) AS recebida, COUNT(*) AS n FROM amostras WHERE organizacao_id = ? AND recebido_em >= ? GROUP BY fonte')
      .all(req.org, new Date(Date.now() - 24 * 3600_000).toISOString());
    const coletores = db.prepare('SELECT nome, ultimo_uso FROM coletores WHERE organizacao_id = ? AND revogado_em IS NULL').all(req.org);
    // Último recebimento: o uso mais recente de um token ou a última amostra gravada (o que for mais novo).
    const ultimoColetor = [...coletores.map((c) => c.ultimo_uso), ...coletas.map((c) => c.recebida)].filter(Boolean).sort().at(-1) ?? null;
    return {
      monitoramento: { estado: !coletores.length && !coletas.length ? 'nao_configurada' : !ultimoColetor ? 'testando'
        : Date.now() - Date.parse(ultimoColetor) > o.desatualizado_min * 60_000 ? 'desatualizada' : 'conectada', ultimo_recebimento: ultimoColetor, fontes: coletas },
      rastreador: { estado: base.estadoAtual(ra, o.desatualizado_min, rastreador.intervalo(ra?.config ?? {})), ultimo_sucesso: ra?.ultimo_sucesso ?? null, ultimo_erro: ra?.ultimo_erro ?? null },
      downdetector: { estado: base.estadoAtual(dd, o.desatualizado_min, downdetector.intervalo(dd?.config ?? {})), ultimo_sucesso: dd?.ultimo_sucesso ?? null, ultimo_erro: dd?.ultimo_erro ?? null },
    };
  }

  r.get('/resumo', exigir('noc.ver'), (req, res) => {
    const abertos = db.prepare(`SELECT severidade, status, incidente_pai_id FROM incidentes WHERE organizacao_id = ? AND status <> 'resolvido'`).all(req.org);
    const porSev = Object.fromEntries(SEV.map((s) => [s, abertos.filter((i) => i.severidade === s && !i.incidente_pai_id).length]));
    res.json({
      gerado_em: agora(),
      incidentes: { abertos: abertos.length, principais: abertos.filter((i) => !i.incidente_pai_id).length, por_severidade: porSev,
        sem_reconhecimento: abertos.filter((i) => i.status === 'aberto').length },
      disponibilidade: noc.disponibilidadeMedida(db, req.org),
      fontes: fontes(req),
      resolvidos_24h: db.prepare("SELECT COUNT(*) AS n FROM incidentes WHERE organizacao_id = ? AND status = 'resolvido' AND resolvido_em >= ?")
        .get(req.org, new Date(Date.now() - 24 * 3600_000).toISOString()).n,
    });
  });

  r.get('/incidentes', exigir('noc.ver'), (req, res) => {
    const f = ['i.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.status === 'abertos' || !req.query.status) f.push("i.status <> 'resolvido'");
    else if (req.query.status !== 'todos') { f.push('i.status = ?'); p.push(String(req.query.status)); }
    if (req.query.severidade) { f.push('i.severidade = ?'); p.push(String(req.query.severidade)); }
    if (req.query.principais === '1') f.push('i.incidente_pai_id IS NULL');
    const lista = listaPaginada(db, `SELECT i.*, e.nome AS equipamento_nome, a.codigo AS ativo_codigo, u.nome AS responsavel_nome,
      (SELECT COUNT(*) FROM incidentes f WHERE f.incidente_pai_id = i.id AND f.status <> 'resolvido') AS relacionados,
      (SELECT COUNT(*) FROM chamados c WHERE c.incidente_id = i.id) AS chamados
      FROM incidentes i LEFT JOIN equipamentos e ON e.id = i.equipamento_id LEFT JOIN ativos_rede a ON a.id = i.ativo_id LEFT JOIN usuarios u ON u.id = i.responsavel_id
      WHERE ${f.join(' AND ')} ORDER BY CASE i.status WHEN 'resolvido' THEN 1 ELSE 0 END, CASE i.severidade WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
      i.inicio DESC`, p, req.query);
    // Impacto só para a página exibida, dos incidentes principais abertos (consulta pela topologia).
    lista.itens = lista.itens.map((i) => ({ ...i, evidencias: i.evidencias ? JSON.parse(i.evidencias) : null,
      impacto: i.status !== 'resolvido' && !i.incidente_pai_id && req.usuario.perfil !== 'consulta' ? noc.impacto(db, i) : null }));
    res.json(lista);
  });

  r.get('/incidentes/:id', exigir('noc.ver'), (req, res) => {
    const i = incidente(req, req.params.id);
    res.json({
      ...i, evidencias: i.evidencias ? JSON.parse(i.evidencias) : null,
      equipamento: i.equipamento_id ? db.prepare('SELECT id, nome, tipo, monitoramento_id FROM equipamentos WHERE id = ?').get(i.equipamento_id) : null,
      ativo: i.ativo_id ? db.prepare('SELECT id, codigo, tipo, bairro FROM ativos_rede WHERE id = ?').get(i.ativo_id) : null,
      pai: i.incidente_pai_id ? db.prepare('SELECT id, titulo, status FROM incidentes WHERE id = ?').get(i.incidente_pai_id) : null,
      relacionados: db.prepare('SELECT id, titulo, severidade, status, inicio, ponto FROM incidentes WHERE incidente_pai_id = ? ORDER BY inicio').all(i.id),
      impacto: noc.impacto(db, i),
      afetados: db.prepare(`SELECT id, codigo, tipo, bairro, status_operacional, status_origem, status_evidencia FROM ativos_rede WHERE id IN (${noc.ativosAfetados(db, i).map(() => '?').join(',') || 'NULL'})`)
        .all(...noc.ativosAfetados(db, i)),
      chamados: db.prepare('SELECT id, numero, titulo, status FROM chamados WHERE incidente_id = ? ORDER BY id').all(i.id),
      eventos: db.prepare('SELECT e.*, u.nome AS usuario_nome FROM incidente_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE incidente_id = ? ORDER BY e.em, e.id').all(i.id),
      duracao_min: Math.round(((i.resolvido_em ? Date.parse(i.resolvido_em) : Date.now()) - Date.parse(i.inicio)) / 60_000),
    });
  });

  /** Incidente registrado pelo operador (ex.: rompimento informado por campo). */
  r.post('/incidentes', exigir('noc.operar'), (req, res) => {
    const b = req.body ?? {};
    const d = { titulo: v.texto(b.titulo, 'o título', 160), severidade: v.opcao(b.severidade, 'a severidade', SEV), causa_provavel: v.opcional(b.causa_provavel, 'a causa provável', 500),
      ativo_id: null, equipamento_id: null };
    if (b.ativo_id) d.ativo_id = db.prepare('SELECT id FROM ativos_rede WHERE id = ? AND organizacao_id = ?').get(Number(b.ativo_id), req.org)?.id ?? (() => { throw new ErroNegocio('Ativo não encontrado.', 422); })();
    if (b.equipamento_id) {
      const e = db.prepare('SELECT id, ativo_id FROM equipamentos WHERE id = ? AND organizacao_id = ?').get(Number(b.equipamento_id), req.org);
      if (!e) throw new ErroNegocio('Equipamento não encontrado.', 422);
      d.equipamento_id = e.id;
      d.ativo_id ??= e.ativo_id;
    }
    const t = agora();
    const id = transacao(db, () => {
      const nid = Number(db.prepare(`INSERT INTO incidentes (organizacao_id, chave_dedup, origem, equipamento_id, ativo_id, titulo, severidade, primeira_observacao, ultima_observacao, inicio,
        causa_provavel, responsavel_id, evidencias, criado_em, atualizado_em) VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, `manual:${t}:${Math.random()}`,
        d.equipamento_id, d.ativo_id, d.titulo, d.severidade, t, t, t, d.causa_provavel, req.usuario.id, JSON.stringify({ registro: v.opcional(b.descricao, 'a descrição', 1000) }), t, t).lastInsertRowid);
      noc.evento(db, nid, 'aberto', `Registrado manualmente por ${req.usuario.nome}.`, req.usuario.id);
      noc.correlacionar(db, db.prepare('SELECT * FROM incidentes WHERE id = ?').get(nid));
      return nid;
    });
    registrar(db, req, 'incidente_criado', { recurso: 'incidente', recursoId: id, depois: d });
    res.status(201).json({ id });
  });

  const acaoIncidente = (nome, fn) => r.post(`/incidentes/:id/${nome}`, exigir('noc.operar'), (req, res) => {
    const i = incidente(req, req.params.id);
    const antes = { status: i.status, responsavel_id: i.responsavel_id, causa_provavel: i.causa_provavel, incidente_pai_id: i.incidente_pai_id };
    const detalhes = transacao(db, () => fn(req, i));
    registrar(db, req, `incidente_${nome}`, { recurso: 'incidente', recursoId: i.id, antes, depois: detalhes });
    res.json(db.prepare('SELECT * FROM incidentes WHERE id = ?').get(i.id));
  });

  acaoIncidente('reconhecer', (req, i) => {
    v.exigir(i.status === 'aberto', 'Só incidentes abertos são reconhecidos.');
    db.prepare("UPDATE incidentes SET status = 'reconhecido', reconhecido_em = ?, reconhecido_por = ?, responsavel_id = COALESCE(responsavel_id, ?), atualizado_em = ? WHERE id = ?")
      .run(agora(), req.usuario.id, req.usuario.id, agora(), i.id);
    noc.evento(db, i.id, 'reconhecido', null, req.usuario.id);
    return { status: 'reconhecido' };
  });

  acaoIncidente('atender', (req, i) => {
    v.exigir(['aberto', 'reconhecido'].includes(i.status), 'O incidente já está em atendimento ou resolvido.');
    db.prepare("UPDATE incidentes SET status = 'em_atendimento', reconhecido_em = COALESCE(reconhecido_em, ?), reconhecido_por = COALESCE(reconhecido_por, ?), atualizado_em = ? WHERE id = ?")
      .run(agora(), req.usuario.id, agora(), i.id);
    noc.evento(db, i.id, 'em_atendimento', v.opcional(req.body?.observacao, 'a observação', 500), req.usuario.id);
    return { status: 'em_atendimento' };
  });

  acaoIncidente('responsavel', (req, i) => {
    const u = db.prepare("SELECT id, nome FROM usuarios WHERE id = ? AND organizacao_id = ? AND ativo = 1").get(Number(req.body?.usuario_id), req.org);
    if (!u) throw new ErroNegocio('Usuário não encontrado.', 422);
    db.prepare('UPDATE incidentes SET responsavel_id = ?, atualizado_em = ? WHERE id = ?').run(u.id, agora(), i.id);
    noc.evento(db, i.id, 'responsavel', u.nome, req.usuario.id);
    return { responsavel_id: u.id };
  });

  /** Causa: provável até ser confirmada com validação explícita. */
  acaoIncidente('causa', (req, i) => {
    const causa = v.texto(req.body?.causa, 'a causa', 500);
    const confirmada = v.booleano(req.body?.confirmada);
    if (confirmada) v.texto(req.body?.validacao, 'a validação que confirma a causa', 500);
    db.prepare('UPDATE incidentes SET causa_provavel = ?, causa_confirmada = ?, atualizado_em = ? WHERE id = ?').run(causa, confirmada ? 1 : 0, agora(), i.id);
    noc.evento(db, i.id, confirmada ? 'causa_confirmada' : 'causa_provavel', confirmada ? `${causa} — ${req.body.validacao}` : causa, req.usuario.id);
    return { causa, confirmada };
  });

  /** Correção da correlação pelo operador, com motivo (pai_id nulo desvincula). */
  acaoIncidente('correlacao', (req, i) => {
    const motivo = v.texto(req.body?.motivo, 'o motivo', 300);
    let pai = null;
    if (req.body?.pai_id) {
      pai = incidente(req, req.body.pai_id);
      v.exigir(pai.id !== i.id && pai.incidente_pai_id !== i.id, 'Correlação circular.');
    }
    db.prepare('UPDATE incidentes SET incidente_pai_id = ?, confianca_correlacao = ?, atualizado_em = ? WHERE id = ?').run(pai?.id ?? null, pai ? 'confirmada' : null, agora(), i.id);
    noc.evento(db, i.id, 'correlacao_corrigida', `${pai ? `Vinculado ao #${pai.id}` : 'Desvinculado'}: ${motivo}`, req.usuario.id);
    return { incidente_pai_id: pai?.id ?? null, motivo };
  });

  /**
   * Resolução manual: exige a evidência da recuperação (concluir uma OS não resolve o incidente).
   * Incidente de monitoramento ainda em violação continua sendo atualizado pelas próximas amostras.
   */
  acaoIncidente('resolver', (req, i) => {
    v.exigir(i.status !== 'resolvido', 'Incidente já resolvido.');
    const evidencia = v.texto(req.body?.evidencia, 'a evidência da recuperação', 1000);
    db.prepare("UPDATE incidentes SET status = 'resolvido', resolvido_em = ?, resolvido_por = ?, resolucao = 'manual', atualizado_em = ? WHERE id = ?").run(agora(), req.usuario.id, agora(), i.id);
    noc.evento(db, i.id, 'resolvido', `Resolução manual: ${evidencia}`, req.usuario.id);
    if (i.regra_id) db.prepare('UPDATE alvo_estado SET violacoes = 0, recuperacoes = 0 WHERE regra_id = ? AND equipamento_id = ? AND ponto = ?').run(i.regra_id, i.equipamento_id, i.ponto ?? '');
    return { status: 'resolvido', evidencia };
  });

  /** Histórico: incidentes resolvidos com início, reconhecimento, fim e duração. */
  r.get('/historico', exigir('noc.ver'), (req, res) => {
    const lista = listaPaginada(db, `SELECT i.id, i.titulo, i.severidade, i.origem, i.inicio, i.reconhecido_em, i.resolvido_em, i.resolucao, i.recorrencias, i.causa_provavel, i.causa_confirmada,
      ROUND((julianday(i.resolvido_em) - julianday(i.inicio)) * 1440) AS duracao_min, ROUND((julianday(i.reconhecido_em) - julianday(i.inicio)) * 1440) AS reconhecimento_min
      FROM incidentes i WHERE i.organizacao_id = ? AND i.status = 'resolvido' ORDER BY i.resolvido_em DESC`, [req.org], req.query);
    res.json(lista);
  });

  // ---------------- Regras de monitoramento (versionadas) ----------------
  r.get('/regras', exigir('noc.ver'), (req, res) => {
    res.json(db.prepare(`SELECT r.*, e.nome AS equipamento_nome FROM regras_monitoramento r LEFT JOIN equipamentos e ON e.id = r.equipamento_id
      WHERE r.organizacao_id = ? ORDER BY r.ativa DESC, r.metrica, r.nome`).all(req.org));
  });

  const dadosRegra = (req, b, a = {}) => {
    const val = (k, fn) => (b[k] !== undefined ? fn(b[k]) : a[k] ?? null);
    const d = {
      nome: val('nome', (x) => v.texto(x, 'o nome', 120)), metrica: val('metrica', (x) => { const m = String(x ?? ''); v.exigir(/^[a-z0-9_]{2,40}$/.test(m), 'Métrica inválida (letras minúsculas, números e _).'); return m; }),
      comparacao: val('comparacao', (x) => v.opcao(x, 'a comparação', ['menor', 'maior'])), limiar: val('limiar', (x) => v.numero(x, 'o limiar')),
      limiar_recuperacao: val('limiar_recuperacao', (x) => v.numero(x, 'o limiar de recuperação')), confirmacoes: val('confirmacoes', (x) => v.inteiro(x, 'as confirmações', { min: 1, max: 20 })) ?? 2,
      severidade: val('severidade', (x) => v.opcao(x, 'a severidade', SEV)),
      equipamento_id: val('equipamento_id', (x) => (x ? db.prepare('SELECT id FROM equipamentos WHERE id = ? AND organizacao_id = ?').get(Number(x), req.org)?.id ?? (() => { throw new ErroNegocio('Equipamento não encontrado.', 422); })() : null)),
    };
    v.exigir(d.nome && d.metrica && d.comparacao && d.limiar !== null && d.limiar_recuperacao !== null && d.severidade, 'Preencha nome, métrica, comparação, limiares e severidade.');
    v.exigir(d.comparacao === 'menor' ? d.limiar_recuperacao >= d.limiar : d.limiar_recuperacao <= d.limiar,
      'O limiar de recuperação precisa ficar do lado saudável do limiar (histerese).');
    return d;
  };

  r.post('/regras', exigir('noc.regras'), (req, res) => {
    const d = dadosRegra(req, req.body ?? {});
    const id = Number(db.prepare(`INSERT INTO regras_monitoramento (organizacao_id, nome, metrica, comparacao, limiar, limiar_recuperacao, confirmacoes, severidade, equipamento_id, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, d.nome, d.metrica, d.comparacao, d.limiar, d.limiar_recuperacao, d.confirmacoes, d.severidade, d.equipamento_id, agora(), agora()).lastInsertRowid);
    registrar(db, req, 'regra_monitoramento_criada', { recurso: 'regra_monitoramento', recursoId: id, depois: d });
    res.status(201).json({ id, ...d, versao: 1 });
  });

  /** Alterar a regra cria uma nova versão; os incidentes guardam a versão e os valores que os dispararam. */
  r.patch('/regras/:id', exigir('noc.regras'), (req, res) => {
    const a = db.prepare('SELECT * FROM regras_monitoramento WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!a) throw new ErroNegocio('Regra não encontrada.', 404);
    const d = dadosRegra(req, req.body ?? {}, a);
    const ativa = req.body?.ativa !== undefined ? (v.booleano(req.body.ativa) ? 1 : 0) : a.ativa;
    db.prepare(`UPDATE regras_monitoramento SET nome = ?, metrica = ?, comparacao = ?, limiar = ?, limiar_recuperacao = ?, confirmacoes = ?, severidade = ?, equipamento_id = ?, ativa = ?,
      versao = versao + 1, atualizado_em = ? WHERE id = ?`).run(d.nome, d.metrica, d.comparacao, d.limiar, d.limiar_recuperacao, d.confirmacoes, d.severidade, d.equipamento_id, ativa, agora(), a.id);
    registrar(db, req, 'regra_monitoramento_versionada', { recurso: 'regra_monitoramento', recursoId: a.id, antes: a, depois: { ...d, ativa, versao: a.versao + 1 } });
    res.json(db.prepare('SELECT * FROM regras_monitoramento WHERE id = ?').get(a.id));
  });

  // ---------------- Coletores (tokens) ----------------
  r.get('/coletores', exigir('integracoes.ver'), (req, res) => {
    res.json(db.prepare('SELECT id, nome, prefixo, escopos, criado_em, ultimo_uso, revogado_em FROM coletores WHERE organizacao_id = ? ORDER BY id DESC').all(req.org));
  });
  r.post('/coletores', exigir('integracoes.editar'), (req, res) => {
    const escopos = [].concat(req.body?.escopos ?? ['amostras']).map(String);
    if (!escopos.length || escopos.some((e) => !ESCOPOS.includes(e))) throw new ErroNegocio(`Escopos válidos: ${ESCOPOS.join(', ')}.`, 422);
    const t = criarToken(db, req.org, v.texto(req.body?.nome, 'o nome do coletor', 80), req.usuario.id, [...new Set(escopos)]);
    registrar(db, req, 'coletor_criado', { recurso: 'coletor', recursoId: t.id, depois: { prefixo: t.prefixo, escopos } });
    res.status(201).json({ ...t, aviso: 'Copie o token agora: ele não será mostrado de novo.' });
  });
  r.post('/coletores/:id/revogar', exigir('integracoes.editar'), (req, res) => {
    const ok = db.prepare('UPDATE coletores SET revogado_em = ? WHERE id = ? AND organizacao_id = ? AND revogado_em IS NULL').run(agora(), Number(req.params.id), req.org).changes;
    if (!ok) throw new ErroNegocio('Coletor não encontrado ou já revogado.', 404);
    registrar(db, req, 'coletor_revogado', { recurso: 'coletor', recursoId: Number(req.params.id) });
    res.json({ ok: true });
  });

  // ---------------- Serviços externos (Downdetector) ----------------
  r.get('/servicos-externos', exigir('noc.ver'), (req, res) => {
    const o = org(req);
    const dd = base.ler(db, req.org, 'downdetector');
    const estado = base.estadoAtual(dd, o.desatualizado_min, downdetector.intervalo(dd?.config ?? {}));
    const servicos = db.prepare('SELECT * FROM servicos_externos WHERE organizacao_id = ? AND ativo = 1 ORDER BY nome').all(req.org).map((s) => {
      const ultima = db.prepare('SELECT * FROM amostras_servico_externo WHERE servico_id = ? ORDER BY id DESC LIMIT 1').get(s.id) ?? null;
      return { ...s, ultima, desatualizada: ultima ? Date.now() - Date.parse(ultima.coletado_em) > o.desatualizado_min * 60_000 : null };
    });
    res.json({ estado, ultimo_sucesso: dd?.ultimo_sucesso ?? null, ultimo_erro: dd?.ultimo_erro ?? null, erro_id: dd?.erro_id ?? null, site_oficial: downdetector.SITE_OFICIAL, servicos,
      observacao: 'Relatos externos orientam a investigação; não confirmam a causa de uma falha no provedor. Sem dados não significa normal.' });
  });
  r.post('/servicos-externos', exigir('integracoes.editar'), (req, res) => {
    const d = { nome: v.texto(req.body?.nome, 'o nome', 80), referencia: v.texto(req.body?.referencia, 'o identificador do serviço na fonte', 120), regiao: v.opcional(req.body?.regiao, 'a região', 60) };
    const id = Number(db.prepare('INSERT INTO servicos_externos (organizacao_id, nome, referencia, regiao, criado_em) VALUES (?, ?, ?, ?, ?)').run(req.org, d.nome, d.referencia, d.regiao, agora()).lastInsertRowid);
    registrar(db, req, 'servico_externo_criado', { recurso: 'servico_externo', recursoId: id, depois: d });
    res.status(201).json({ id, ...d });
  });
  r.post('/servicos-externos/:id/remover', exigir('integracoes.editar'), (req, res) => {
    db.prepare('UPDATE servicos_externos SET ativo = 0 WHERE id = ? AND organizacao_id = ?').run(Number(req.params.id), req.org);
    registrar(db, req, 'servico_externo_removido', { recurso: 'servico_externo', recursoId: Number(req.params.id) });
    res.json({ ok: true });
  });

  /** Painel TV: números agregados, fontes e horários. Sem nomes de clientes nem endereços. */
  r.get('/tv', exigir('noc.ver'), (req, res) => {
    const principais = db.prepare(`SELECT i.id, i.titulo, i.severidade, i.status, i.inicio, i.ultima_observacao, a.bairro,
      (SELECT COUNT(*) FROM incidentes f WHERE f.incidente_pai_id = i.id AND f.status <> 'resolvido') AS relacionados
      FROM incidentes i LEFT JOIN ativos_rede a ON a.id = i.ativo_id WHERE i.organizacao_id = ? AND i.status <> 'resolvido' AND i.incidente_pai_id IS NULL
      ORDER BY CASE i.severidade WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, i.inicio LIMIT 12`).all(req.org)
      .map((i) => ({ ...i, portas_ocupadas: noc.impacto(db, i).portas_ocupadas }));
    res.json({ gerado_em: agora(), disponibilidade: noc.disponibilidadeMedida(db, req.org), incidentes: principais, fontes: fontes(req),
      chamados_criticos: db.prepare("SELECT COUNT(*) AS n FROM chamados WHERE organizacao_id = ? AND prioridade = 'critica' AND status NOT IN ('aprovado','cancelado')").get(req.org).n });
  });

  return r;
};
