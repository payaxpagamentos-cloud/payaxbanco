'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, conferirVersao } = require('../lib/http');
const { lerPrefixo, lerIp, contemPrefixo } = require('../lib/ip');
const mitigacao = require('../lib/mitigacao');
const radius = require('../lib/radius');
const { gerarRelatorioAtaque } = require('../lib/relatorio-ataque');
const { METRICAS } = require('../lib/fluxos/agregador');
const v = require('../lib/validacao');

const SEV = ['critica', 'alta', 'media', 'baixa'];
const MODOS = ['desligada', 'manual', 'automatica'];
const TIPOS = Object.keys(mitigacao.TIPOS);

/** Limites sugeridos para clientes residenciais (ponto de partida: cada rede tem o seu normal). */
const SUGERIDOS = [
  { escopo: 'ip', direcao: 'entrada', metrica: 'bps', limite: 1e9, janela_s: 10, severidade: 'alta' },
  { escopo: 'ip', direcao: 'entrada', metrica: 'pps', limite: 300_000, janela_s: 5, severidade: 'alta' },
  { escopo: 'ip', direcao: 'entrada', metrica: 'udp_bps', limite: 700e6, janela_s: 10, severidade: 'alta' },
  { escopo: 'ip', direcao: 'entrada', metrica: 'syn_pps', limite: 50_000, janela_s: 5, severidade: 'alta' },
  { escopo: 'ip', direcao: 'entrada', metrica: 'icmp_pps', limite: 20_000, janela_s: 10, severidade: 'media' },
  { escopo: 'ip', direcao: 'saida', metrica: 'pps', limite: 100_000, janela_s: 10, severidade: 'alta' },
  { escopo: 'ip', direcao: 'saida', metrica: 'syn_pps', limite: 10_000, janela_s: 10, severidade: 'alta' },
  { escopo: 'grupo', direcao: 'entrada', metrica: 'bps', limite: 8e9, janela_s: 60, severidade: 'critica' },
];

const json = (s, padrao = []) => { try { return JSON.parse(s ?? 'null') ?? padrao; } catch { return padrao; } };

module.exports = (db) => {
  const r = Router();
  const ataque = (req, id) => {
    const a = db.prepare('SELECT * FROM ataques WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!a) throw new ErroNegocio('Ataque não encontrado.', 404);
    return a;
  };
  const grupo = (req, id) => {
    const g = db.prepare('SELECT * FROM grupos_ip WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!g) throw new ErroNegocio('Grupo não encontrado.', 404);
    return g;
  };
  const comNomes = (m, cfg) => ({ ...m, regra: json(m.regra, null), descricao: mitigacao.descricao(m), comandos: mitigacao.comandos(m, cfg),
    solicitante: m.solicitada_por ? db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(m.solicitada_por)?.nome : null,
    aprovador: m.aprovada_por ? db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(m.aprovada_por)?.nome : null,
    retirado_por: m.retirada_por ? db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(m.retirada_por)?.nome : null });
  const ataquePublico = (a) => ({ ...a, origens: json(a.origens), portas_origem: json(a.portas_origem), portas_destino: json(a.portas_destino), protocolos: json(a.protocolos) });
  /** Login do assinante do IP no início do ataque (ataques saindo da rede), para quem pode ver dados de assinantes. */
  const assinante = (req, a) => (a.alvo_tipo === 'ip' && req.usuario.perfil !== 'consulta' ? radius.loginNoInstante(db, req.org, a.alvo, a.inicio) : null);

  // ---------------------------------------------------------------- Painel
  r.get('/resumo', exigir('ddos.ver'), (req, res) => {
    const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
    const minuto = new Date(Date.now() - 120_000).toISOString().slice(0, 16);
    const agoraTrafego = db.prepare(`SELECT direcao, SUM(bytes) * 8 / 60.0 AS bps, SUM(pacotes) / 60.0 AS pps FROM trafego_minuto WHERE organizacao_id = ?
      AND minuto = (SELECT MAX(minuto) FROM trafego_minuto WHERE organizacao_id = ? AND minuto <= ?) GROUP BY direcao`).all(req.org, req.org, minuto);
    const exps = db.prepare('SELECT id, nome, ip, papel, ativo, ultimo_pacote, formato FROM exportadores_fluxo WHERE organizacao_id = ?').all(req.org);
    res.json({
      gerado_em: agora(),
      ativos: db.prepare(`SELECT a.*, g.nome AS grupo_nome FROM ataques a LEFT JOIN grupos_ip g ON g.id = a.grupo_id WHERE a.organizacao_id = ? AND a.status = 'ativo'
        ORDER BY CASE a.severidade WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, a.inicio DESC`).all(req.org).map(ataquePublico),
      ultimas_24h: db.prepare(`SELECT direcao, COUNT(*) AS n, MAX(pico_bps) AS pico_bps FROM ataques WHERE organizacao_id = ? AND inicio >= ? GROUP BY direcao`).all(req.org, desde),
      mitigacoes: db.prepare(`SELECT status, COUNT(*) AS n FROM mitigacoes WHERE organizacao_id = ? AND status IN ('aguardando_aprovacao','ativa') GROUP BY status`).all(req.org),
      trafego: Object.fromEntries(agoraTrafego.map((t) => [t.direcao, { bps: t.bps, pps: t.pps }])),
      exportadores: exps.map((e) => ({ ...e, estado: estadoFonte(e) })),
      grupos: db.prepare('SELECT COUNT(*) AS n FROM grupos_ip WHERE organizacao_id = ? AND ativo = 1').get(req.org).n,
    });
  });

  // ---------------------------------------------------------------- Ataques
  r.get('/ataques', exigir('ddos.ver'), (req, res) => {
    const f = ['a.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.status === 'ativos') f.push("a.status = 'ativo'");
    else if (req.query.status === 'encerrados') f.push("a.status = 'encerrado'");
    if (['entrada', 'saida', 'interno'].includes(req.query.direcao)) { f.push('a.direcao = ?'); p.push(req.query.direcao); }
    if (req.query.grupo_id) { f.push('a.grupo_id = ?'); p.push(Number(req.query.grupo_id)); }
    if (req.query.alvo) { f.push('a.alvo = ?'); p.push(String(req.query.alvo)); }
    if (req.query.de) { f.push('a.inicio >= ?'); p.push(v.instante(req.query.de, 'o início do período')); }
    if (req.query.ate) { f.push('a.inicio <= ?'); p.push(v.instante(req.query.ate, 'o fim do período')); }
    const l = listaPaginada(db, `SELECT a.*, g.nome AS grupo_nome, (SELECT COUNT(*) FROM mitigacoes m WHERE m.ataque_id = a.id AND m.status = 'ativa') AS mitigacoes_ativas
      FROM ataques a LEFT JOIN grupos_ip g ON g.id = a.grupo_id WHERE ${f.join(' AND ')} ORDER BY a.inicio DESC`, p, req.query);
    l.itens = l.itens.map(ataquePublico);
    res.json(l);
  });

  r.get('/ataques/:id', exigir('ddos.ver'), (req, res) => {
    const a = ataque(req, req.params.id);
    const cfg = mitigacao.configDdos(db, req.org);
    res.json({
      ...ataquePublico(a),
      grupo: a.grupo_id ? db.prepare('SELECT id, nome, mitigacao_modo, mitigacao_tipo FROM grupos_ip WHERE id = ?').get(a.grupo_id) : null,
      serie: db.prepare('SELECT em, bps, pps FROM ataque_serie WHERE ataque_id = ? ORDER BY em').all(a.id),
      eventos: db.prepare('SELECT e.*, u.nome AS usuario_nome FROM ataque_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE ataque_id = ? ORDER BY e.em, e.id').all(a.id),
      mitigacoes: db.prepare('SELECT * FROM mitigacoes WHERE ataque_id = ? ORDER BY id').all(a.id).map((m) => comNomes(m, cfg)),
      assinante: assinante(req, a),
      anteriores: db.prepare("SELECT id, numero, inicio, vetor, pico_bps FROM ataques WHERE organizacao_id = ? AND alvo = ? AND id <> ? ORDER BY inicio DESC LIMIT 5").all(req.org, a.alvo, a.id),
    });
  });

  r.get('/ataques/:id/pdf', exigir('ddos.ver'), (req, res) => {
    const a = ataque(req, req.params.id);
    const cfg = mitigacao.configDdos(db, req.org);
    const pdf = gerarRelatorioAtaque({
      ataque: a, organizacao: db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org),
      grupo: a.grupo_id ? db.prepare('SELECT * FROM grupos_ip WHERE id = ?').get(a.grupo_id) : null,
      serie: db.prepare('SELECT em, bps, pps FROM ataque_serie WHERE ataque_id = ? ORDER BY em').all(a.id),
      mitigacoes: db.prepare('SELECT * FROM mitigacoes WHERE ataque_id = ? ORDER BY id').all(a.id).map((m) => comNomes(m, cfg)),
      eventos: db.prepare('SELECT e.*, u.nome AS usuario_nome FROM ataque_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE ataque_id = ? ORDER BY e.em, e.id').all(a.id),
      assinante: assinante(req, a),
    });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="ataque-${a.numero}.pdf"`, 'Cache-Control': 'private, no-store' });
    res.send(pdf);
  });

  r.post('/ataques/:id/encerrar', exigir('ddos.operar'), (req, res) => {
    const motivo = v.texto(req.body?.motivo, 'o motivo', 500);
    const a = ataque(req, req.params.id);
    if (a.status !== 'ativo') throw new ErroNegocio('O ataque já está encerrado.', 409);
    transacao(db, () => {
      db.prepare("UPDATE ataques SET status = 'encerrado', fim = ?, encerrado_por = ?, motivo_encerramento = ? WHERE id = ? AND status = 'ativo'").run(agora(), req.usuario.id, motivo, a.id);
      db.prepare('INSERT INTO ataque_eventos (ataque_id, tipo, detalhes, usuario_id, em) VALUES (?, ?, ?, ?, ?)').run(a.id, 'encerrado_manual', motivo, req.usuario.id, agora());
      registrar(db, req, 'ataque_encerrado', { recurso: 'ataque', recursoId: a.id, antes: { status: 'ativo' }, depois: { status: 'encerrado', motivo } });
    });
    res.json(ataque(req, a.id));
  });

  r.post('/ataques/:id/comentar', exigir('ddos.operar'), (req, res) => {
    const a = ataque(req, req.params.id);
    db.prepare('INSERT INTO ataque_eventos (ataque_id, tipo, detalhes, usuario_id, em) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, 'comentario', v.texto(req.body?.texto, 'o comentário', 2000), req.usuario.id, agora());
    res.status(201).json({ ok: true });
  });

  /** Bloqueio pedido pelo operador a partir do ataque: já sai aprovado por quem pediu, mas passa pelas proteções. */
  r.post('/ataques/:id/mitigar', exigir('ddos.operar'), (req, res) => {
    const a = ataque(req, req.params.id);
    if (a.alvo_tipo !== 'ip') throw new ErroNegocio('Bloqueio é por IP: abra o ataque de um IP do grupo.', 422);
    const tipo = v.opcao(req.body?.tipo, 'o tipo de bloqueio', TIPOS);
    const vetor = mitigacao.classificarVetor({ bytes: a.total_bytes || 1, pkts: 1, syn: 0, protocolos: json(a.protocolos), portasOrigem: json(a.portas_origem) });
    if (a.vetor === 'SYN flood') vetor.syn = true;
    const m = mitigacao.solicitar(db, req.org, { tipo, alvo: a.alvo, ataqueId: a.id, vetor, duracaoMin: v.inteiroOpcional(req.body?.duracao_min, 'a duração', { min: 1, max: 10080 }),
      origem: 'manual', usuarioId: req.usuario.id, aprovar: true, req });
    res.status(m.existente ? 200 : 201).json(comNomes(m, mitigacao.configDdos(db, req.org)));
  });

  // ---------------------------------------------------------------- Ações de bloqueio
  r.get('/mitigacoes', exigir('ddos.ver'), (req, res) => {
    const cfg = mitigacao.configDdos(db, req.org);
    const f = ['m.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.status === 'vigentes' || !req.query.status) f.push("m.status IN ('aguardando_aprovacao','ativa')");
    else if (req.query.status !== 'todas') { f.push('m.status = ?'); p.push(String(req.query.status)); }
    const l = listaPaginada(db, `SELECT m.*, a.numero AS ataque_numero FROM mitigacoes m LEFT JOIN ataques a ON a.id = m.ataque_id WHERE ${f.join(' AND ')}
      ORDER BY CASE m.status WHEN 'aguardando_aprovacao' THEN 0 WHEN 'ativa' THEN 1 ELSE 2 END, m.id DESC`, p, req.query);
    l.itens = l.itens.map((m) => comNomes(m, cfg));
    res.json(l);
  });

  r.post('/mitigacoes', exigir('ddos.operar'), (req, res) => {
    const tipo = v.opcao(req.body?.tipo, 'o tipo de bloqueio', TIPOS);
    const alvo = v.texto(req.body?.alvo, 'o IP ou prefixo', 60);
    const motivo = v.texto(req.body?.motivo, 'o motivo', 500);
    const vetor = {};
    if (tipo === 'flowspec') {
      if (req.body?.protocolo) vetor.proto = v.inteiro(req.body.protocolo, 'o protocolo', { min: 1, max: 255 });
      if (req.body?.porta_origem !== undefined && req.body?.porta_origem !== '') vetor.portaOrigem = v.inteiro(req.body.porta_origem, 'a porta de origem', { min: 0, max: 65535 });
    }
    const m = mitigacao.solicitar(db, req.org, { tipo, alvo, vetor, duracaoMin: v.inteiroOpcional(req.body?.duracao_min, 'a duração', { min: 1, max: 10080 }),
      origem: 'manual', usuarioId: req.usuario.id, aprovar: true, req, motivo });
    res.status(m.existente ? 200 : 201).json(comNomes(m, mitigacao.configDdos(db, req.org)));
  });

  const versaoMit = (req) => {
    const m = db.prepare('SELECT versao FROM mitigacoes WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!m) throw new ErroNegocio('Ação de bloqueio não encontrada.', 404);
    if (req.body?.versao !== undefined) conferirVersao(m.versao, req.body.versao);
  };
  r.post('/mitigacoes/:id/aprovar', exigir('ddos.operar'), (req, res) => { versaoMit(req); res.json(mitigacao.aprovar(db, req.org, req.params.id, req)); });
  r.post('/mitigacoes/:id/recusar', exigir('ddos.operar'), (req, res) => {
    versaoMit(req);
    res.json(mitigacao.recusar(db, req.org, req.params.id, v.texto(req.body?.motivo, 'o motivo', 500), req));
  });
  r.post('/mitigacoes/:id/retirar', exigir('ddos.operar'), (req, res) => {
    versaoMit(req);
    res.json(mitigacao.retirar(db, req.org, req.params.id, `Retirada manual: ${v.texto(req.body?.motivo, 'o motivo', 500)}`, req));
  });
  r.post('/mitigacoes/:id/prorrogar', exigir('ddos.operar'), (req, res) => {
    res.json(mitigacao.prorrogar(db, req.org, req.params.id, v.inteiro(req.body?.minutos, 'os minutos', { min: 1, max: 10080 }), req));
  });

  /** Anúncios ativos e os comandos para o ExaBGP (o mesmo que o script lê pelo token). */
  r.get('/bgp', exigir('ddos.ver'), (req, res) => {
    const cfg = mitigacao.configDdos(db, req.org);
    res.json({ anuncios: mitigacao.anunciosAtivos(db, req.org), next_hop_blackhole: cfg.bgp_next_hop_blackhole, community_blackhole: cfg.bgp_community_blackhole,
      next_hop_limpeza: cfg.bgp_next_hop_limpeza });
  });

  // ---------------------------------------------------------------- Grupos e limites
  r.get('/grupos', exigir('ddos.ver'), (req, res) => {
    const grupos = db.prepare('SELECT * FROM grupos_ip WHERE organizacao_id = ? ORDER BY nome').all(req.org);
    res.json(grupos.map((g) => ({ ...g,
      prefixos: db.prepare('SELECT id, prefixo, versao_ip FROM grupo_prefixos WHERE grupo_id = ? ORDER BY versao_ip, prefixo').all(g.id),
      limites: db.prepare('SELECT * FROM ddos_limites WHERE grupo_id = ? ORDER BY direcao, escopo, metrica').all(g.id) })));
  });

  const dadosGrupo = (b, atual = {}) => ({
    nome: b.nome !== undefined ? v.texto(b.nome, 'o nome', 80) : atual.nome,
    descricao: b.descricao !== undefined ? v.opcional(b.descricao, 'a descrição', 300) : atual.descricao ?? null,
    mitigacao_modo: b.mitigacao_modo !== undefined ? v.opcao(b.mitigacao_modo, 'o modo de mitigação', MODOS) : atual.mitigacao_modo ?? 'manual',
    mitigacao_tipo: b.mitigacao_tipo !== undefined ? v.opcao(b.mitigacao_tipo, 'o tipo de mitigação', TIPOS) : atual.mitigacao_tipo ?? 'flowspec',
    mitigacao_duracao_min: b.mitigacao_duracao_min !== undefined ? v.inteiroOpcional(b.mitigacao_duracao_min, 'a duração', { min: 1, max: 10080 }) : atual.mitigacao_duracao_min ?? null,
    ativo: b.ativo !== undefined ? (v.booleano(b.ativo) ? 1 : 0) : atual.ativo ?? 1,
  });

  r.post('/grupos', exigir('ddos.configurar'), (req, res) => {
    const d = dadosGrupo(req.body ?? {});
    if (!d.nome) throw new ErroNegocio('Informe o nome.', 422);
    const id = transacao(db, () => {
      const t = agora();
      const gid = Number(db.prepare(`INSERT INTO grupos_ip (organizacao_id, nome, descricao, mitigacao_modo, mitigacao_tipo, mitigacao_duracao_min, ativo, criado_em, atualizado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, d.nome, d.descricao, d.mitigacao_modo, d.mitigacao_tipo, d.mitigacao_duracao_min, d.ativo, t, t).lastInsertRowid);
      for (const p of [].concat(req.body?.prefixos ?? [])) adicionarPrefixo(req, gid, p);
      registrar(db, req, 'grupo_ip_criado', { recurso: 'grupo_ip', recursoId: gid, depois: d });
      return gid;
    });
    res.status(201).json(grupo(req, id));
  });

  r.patch('/grupos/:id', exigir('ddos.configurar'), (req, res) => {
    const g = grupo(req, req.params.id);
    conferirVersao(g.versao, req.body?.versao);
    const d = dadosGrupo(req.body ?? {}, g);
    db.prepare(`UPDATE grupos_ip SET nome = ?, descricao = ?, mitigacao_modo = ?, mitigacao_tipo = ?, mitigacao_duracao_min = ?, ativo = ?, versao = versao + 1, atualizado_em = ?
      WHERE id = ? AND versao = ?`).run(d.nome, d.descricao, d.mitigacao_modo, d.mitigacao_tipo, d.mitigacao_duracao_min, d.ativo, agora(), g.id, g.versao);
    registrar(db, req, 'grupo_ip_alterado', { recurso: 'grupo_ip', recursoId: g.id, antes: g, depois: d });
    res.json(grupo(req, g.id));
  });

  function adicionarPrefixo(req, grupoId, texto) {
    const p = lerPrefixo(texto, { estrito: true });
    if (!p) throw new ErroNegocio(`Prefixo inválido: ${texto}. Use a rede com os bits de host zerados (ex.: 203.0.113.0/24).`, 422);
    if ((p.v === 4 && p.len < 8) || (p.v === 6 && p.len < 16)) throw new ErroNegocio('Prefixo amplo demais para um grupo protegido.', 422);
    const ja = db.prepare('SELECT g.nome FROM grupo_prefixos p JOIN grupos_ip g ON g.id = p.grupo_id WHERE p.organizacao_id = ? AND p.prefixo = ?').get(req.org, p.texto);
    if (ja) throw new ErroNegocio(`${p.texto} já está no grupo ${ja.nome}.`, 409);
    db.prepare('INSERT INTO grupo_prefixos (organizacao_id, grupo_id, prefixo, versao_ip, criado_em) VALUES (?, ?, ?, ?, ?)').run(req.org, grupoId, p.texto, p.v, agora());
    return p.texto;
  }

  r.post('/grupos/:id/prefixos', exigir('ddos.configurar'), (req, res) => {
    const g = grupo(req, req.params.id);
    const texto = adicionarPrefixo(req, g.id, req.body?.prefixo);
    registrar(db, req, 'grupo_ip_prefixo_incluido', { recurso: 'grupo_ip', recursoId: g.id, depois: { prefixo: texto } });
    res.status(201).json({ prefixo: texto });
  });

  r.post('/grupos/:id/prefixos/:pid/remover', exigir('ddos.configurar'), (req, res) => {
    const g = grupo(req, req.params.id);
    const p = db.prepare('SELECT * FROM grupo_prefixos WHERE id = ? AND grupo_id = ?').get(Number(req.params.pid), g.id);
    if (!p) throw new ErroNegocio('Prefixo não encontrado.', 404);
    db.prepare('DELETE FROM grupo_prefixos WHERE id = ?').run(p.id);
    registrar(db, req, 'grupo_ip_prefixo_removido', { recurso: 'grupo_ip', recursoId: g.id, antes: { prefixo: p.prefixo } });
    res.json({ ok: true });
  });

  const dadosLimite = (b, atual = {}) => {
    const metrica = b.metrica !== undefined ? v.opcao(b.metrica, 'a métrica', Object.keys(METRICAS)) : atual.metrica;
    return {
      escopo: b.escopo !== undefined ? v.opcao(b.escopo, 'o escopo', ['ip', 'grupo']) : atual.escopo,
      direcao: b.direcao !== undefined ? v.opcao(b.direcao, 'a direção', ['entrada', 'saida']) : atual.direcao,
      metrica,
      limite: b.limite !== undefined ? v.numero(b.limite, 'o limite', { min: 1, max: 1e13 }) : atual.limite,
      janela_s: b.janela_s !== undefined ? v.opcao(Number(b.janela_s), 'a janela', [5, 10, 60]) : atual.janela_s,
      severidade: b.severidade !== undefined ? v.opcao(b.severidade, 'a severidade', SEV) : atual.severidade ?? 'alta',
      ativo: b.ativo !== undefined ? (v.booleano(b.ativo) ? 1 : 0) : atual.ativo ?? 1,
    };
  };

  r.post('/grupos/:id/limites', exigir('ddos.configurar'), (req, res) => {
    const g = grupo(req, req.params.id);
    const d = dadosLimite(req.body ?? {});
    for (const k of ['escopo', 'direcao', 'metrica', 'limite', 'janela_s']) if (d[k] === undefined) throw new ErroNegocio(`Informe ${k}.`, 422);
    const t = agora();
    const id = Number(db.prepare(`INSERT INTO ddos_limites (organizacao_id, grupo_id, escopo, direcao, metrica, limite, janela_s, severidade, ativo, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, g.id, d.escopo, d.direcao, d.metrica, d.limite, d.janela_s, d.severidade, d.ativo, t, t).lastInsertRowid);
    registrar(db, req, 'limite_ddos_criado', { recurso: 'limite_ddos', recursoId: id, depois: { grupo: g.nome, ...d } });
    res.status(201).json(db.prepare('SELECT * FROM ddos_limites WHERE id = ?').get(id));
  });

  r.post('/grupos/:id/limites-sugeridos', exigir('ddos.configurar'), (req, res) => {
    const g = grupo(req, req.params.id);
    const t = agora();
    const existentes = db.prepare('SELECT escopo, direcao, metrica FROM ddos_limites WHERE grupo_id = ?').all(g.id).map((l) => `${l.escopo}|${l.direcao}|${l.metrica}`);
    let n = 0;
    for (const l of SUGERIDOS) {
      if (existentes.includes(`${l.escopo}|${l.direcao}|${l.metrica}`)) continue;
      db.prepare(`INSERT INTO ddos_limites (organizacao_id, grupo_id, escopo, direcao, metrica, limite, janela_s, severidade, criado_em, atualizado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, g.id, l.escopo, l.direcao, l.metrica, l.limite, l.janela_s, l.severidade, t, t);
      n++;
    }
    registrar(db, req, 'limites_sugeridos_aplicados', { recurso: 'grupo_ip', recursoId: g.id, depois: { criados: n } });
    res.json({ criados: n });
  });

  r.patch('/limites/:id', exigir('ddos.configurar'), (req, res) => {
    const l = db.prepare('SELECT * FROM ddos_limites WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!l) throw new ErroNegocio('Limite não encontrado.', 404);
    const d = dadosLimite(req.body ?? {}, l);
    db.prepare('UPDATE ddos_limites SET escopo = ?, direcao = ?, metrica = ?, limite = ?, janela_s = ?, severidade = ?, ativo = ?, atualizado_em = ? WHERE id = ?')
      .run(d.escopo, d.direcao, d.metrica, d.limite, d.janela_s, d.severidade, d.ativo, agora(), l.id);
    registrar(db, req, 'limite_ddos_alterado', { recurso: 'limite_ddos', recursoId: l.id, antes: l, depois: d });
    res.json(db.prepare('SELECT * FROM ddos_limites WHERE id = ?').get(l.id));
  });

  // ---------------------------------------------------------------- Nunca bloquear
  r.get('/nunca-bloquear', exigir('ddos.ver'), (req, res) => {
    res.json(db.prepare('SELECT n.*, u.nome AS criado_por_nome FROM nunca_bloquear n LEFT JOIN usuarios u ON u.id = n.criado_por WHERE n.organizacao_id = ? ORDER BY n.versao_ip, n.prefixo')
      .all(req.org));
  });
  r.post('/nunca-bloquear', exigir('ddos.configurar'), (req, res) => {
    const p = lerPrefixo(req.body?.prefixo, { estrito: true });
    if (!p) throw new ErroNegocio('IP ou prefixo inválido (ex.: 203.0.113.53 ou 203.0.113.0/28).', 422);
    const motivo = v.texto(req.body?.motivo, 'o motivo', 200);
    const id = Number(db.prepare('INSERT INTO nunca_bloquear (organizacao_id, prefixo, versao_ip, motivo, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.org, p.texto, p.v, motivo, req.usuario.id, agora()).lastInsertRowid);
    registrar(db, req, 'nunca_bloquear_incluido', { recurso: 'nunca_bloquear', recursoId: id, depois: { prefixo: p.texto, motivo } });
    // Ações ativas que passam a atingir a lista são retiradas na hora; as pendentes não podem mais ser aprovadas (a aprovação confere a lista).
    const retiradas = [];
    for (const m of db.prepare("SELECT id, prefixo FROM mitigacoes WHERE organizacao_id = ? AND status = 'ativa'").all(req.org)) {
      const q = lerPrefixo(m.prefixo);
      if (q && (contemPrefixo(p, q) || contemPrefixo(q, p))) {
        mitigacao.retirar(db, req.org, m.id, `Retirada: ${p.texto} entrou na lista "nunca bloquear" (${motivo}).`, req);
        retiradas.push(m.id);
      }
    }
    res.status(201).json({ ...db.prepare('SELECT * FROM nunca_bloquear WHERE id = ?').get(id), acoes_retiradas: retiradas });
  });
  r.post('/nunca-bloquear/:id/remover', exigir('ddos.configurar'), (req, res) => {
    const n = db.prepare('SELECT * FROM nunca_bloquear WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!n) throw new ErroNegocio('Registro não encontrado.', 404);
    const motivo = v.texto(req.body?.motivo, 'o motivo da remoção', 300);
    db.prepare('DELETE FROM nunca_bloquear WHERE id = ?').run(n.id);
    registrar(db, req, 'nunca_bloquear_removido', { recurso: 'nunca_bloquear', recursoId: n.id, antes: n, depois: { motivo } });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- Configuração
  r.get('/config', exigir('ddos.ver'), (req, res) => res.json(mitigacao.configDdos(db, req.org)));
  r.put('/config', exigir('ddos.configurar'), (req, res) => {
    const atual = mitigacao.configDdos(db, req.org);
    conferirVersao(atual.versao, req.body?.versao);
    const b = req.body ?? {};
    const ip = (x, nome, obrigatorio) => {
      if (!obrigatorio && (x === null || x === '' || x === undefined)) return null;
      if (!lerIp(x)) throw new ErroNegocio(`${nome} inválido.`, 422);
      return lerIp(x) && String(x).trim();
    };
    const comunidade = (x, nome, obrigatorio) => {
      if (!obrigatorio && (x === null || x === '' || x === undefined)) return null;
      if (!/^\d{1,10}:\d{1,10}( \d{1,10}:\d{1,10})*$/.test(String(x ?? '').trim())) throw new ErroNegocio(`${nome} inválida (use ASN:valor, ex.: 65535:666).`, 422);
      return String(x).trim();
    };
    const d = {
      confirmacoes: v.inteiro(b.confirmacoes ?? atual.confirmacoes, 'as confirmações', { min: 1, max: 12 }),
      fator_recuperacao: v.numero(b.fator_recuperacao ?? atual.fator_recuperacao, 'o fator de recuperação', { min: 0.1, max: 1 }),
      encerrar_apos_s: v.inteiro(b.encerrar_apos_s ?? atual.encerrar_apos_s, 'o tempo para encerrar', { min: 10, max: 3600 }),
      max_acoes_simultaneas: v.inteiro(b.max_acoes_simultaneas ?? atual.max_acoes_simultaneas, 'o limite de ações simultâneas', { min: 1, max: 1000 }),
      duracao_padrao_min: v.inteiro(b.duracao_padrao_min ?? atual.duracao_padrao_min, 'a duração padrão', { min: 1, max: 10080 }),
      max_duracao_min: v.inteiro(b.max_duracao_min ?? atual.max_duracao_min, 'a duração máxima', { min: 1, max: 10080 }),
      bgp_next_hop_blackhole: ip(b.bgp_next_hop_blackhole ?? atual.bgp_next_hop_blackhole, 'O next-hop do blackhole', true),
      bgp_next_hop_blackhole_v6: ip(b.bgp_next_hop_blackhole_v6 ?? atual.bgp_next_hop_blackhole_v6, 'O next-hop IPv6 do blackhole', true),
      bgp_community_blackhole: comunidade(b.bgp_community_blackhole ?? atual.bgp_community_blackhole, 'A community do blackhole', true),
      bgp_next_hop_limpeza: ip(b.bgp_next_hop_limpeza !== undefined ? b.bgp_next_hop_limpeza : atual.bgp_next_hop_limpeza, 'O next-hop da limpeza', false),
      bgp_community_limpeza: comunidade(b.bgp_community_limpeza !== undefined ? b.bgp_community_limpeza : atual.bgp_community_limpeza, 'A community da limpeza', false),
      limpeza_prefixo_v4: v.inteiro(b.limpeza_prefixo_v4 ?? atual.limpeza_prefixo_v4, 'o prefixo de limpeza IPv4', { min: 8, max: 32 }),
      limpeza_prefixo_v6: v.inteiro(b.limpeza_prefixo_v6 ?? atual.limpeza_prefixo_v6, 'o prefixo de limpeza IPv6', { min: 16, max: 128 }),
      flowspec_acao: v.opcao(b.flowspec_acao ?? atual.flowspec_acao, 'a ação do FlowSpec', ['discard', 'rate-limit']),
      flowspec_taxa_bps: v.inteiroOpcional(b.flowspec_taxa_bps !== undefined ? b.flowspec_taxa_bps : atual.flowspec_taxa_bps, 'a taxa do FlowSpec', { min: 8000, max: 1e12 }),
      retencao_minuto_dias: v.inteiro(b.retencao_minuto_dias ?? atual.retencao_minuto_dias, 'a retenção por minuto', { min: 1, max: 90 }),
      retencao_hora_dias: v.inteiro(b.retencao_hora_dias ?? atual.retencao_hora_dias, 'a retenção por hora', { min: 30, max: 1100 }),
      retencao_sessoes_dias: v.inteiro(b.retencao_sessoes_dias ?? atual.retencao_sessoes_dias, 'a retenção das sessões', { min: 366, max: 3650 }),
      capacidade_bps: b.capacidade_bps !== undefined ? (b.capacidade_bps === null || b.capacidade_bps === '' ? null
        : v.numero(b.capacidade_bps, 'a capacidade dos links', { min: 1e6, max: 1e13 })) : atual.capacidade_bps,
    };
    if (d.duracao_padrao_min > d.max_duracao_min) throw new ErroNegocio('A duração padrão não pode passar da duração máxima.', 422);
    if (d.flowspec_acao === 'rate-limit' && !d.flowspec_taxa_bps) throw new ErroNegocio('Informe a taxa do FlowSpec para limitar em vez de descartar.', 422);
    db.prepare(`UPDATE ddos_config SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')}, versao = versao + 1, atualizado_em = ? WHERE organizacao_id = ?`)
      .run(...Object.values(d), agora(), req.org);
    registrar(db, req, 'ddos_config_alterada', { recurso: 'ddos_config', antes: atual, depois: d });
    res.json(mitigacao.configDdos(db, req.org));
  });

  return r;
};

/** Situação de um exportador pelo último pacote recebido. */
function estadoFonte(e) {
  if (!e.ativo) return 'desabilitada';
  if (!e.ultimo_pacote) return 'testando';
  return Date.now() - Date.parse(e.ultimo_pacote) > 5 * 60_000 ? 'desatualizada' : 'conectada';
}
module.exports.estadoFonte = estadoFonte;
module.exports.SUGERIDOS = SUGERIDOS;
