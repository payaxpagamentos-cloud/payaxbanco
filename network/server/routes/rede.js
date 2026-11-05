'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, like, conferirVersao } = require('../lib/http');
const rede = require('../lib/rede');
const v = require('../lib/validacao');

const TIPOS = ['pop', 'ceo', 'cto'];
const STATUS = ['operacional', 'atencao', 'indisponivel', 'nao_avaliado'];
const TIPOS_EQUIP = ['olt', 'switch', 'roteador', 'servidor', 'outro'];
// Quem pode alimentar quem (origem → destino): CTO recebe de CEO, CTO (cascata) ou POP; CEO de CEO ou POP; POP de POP.
const LIGACOES = { cto: ['ceo', 'cto', 'pop'], ceo: ['ceo', 'pop'], pop: ['pop'] };

module.exports = (db) => {
  const r = Router();

  const ativo = (req, id) => {
    const x = db.prepare('SELECT * FROM ativos_rede WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Ativo não encontrado.', 404);
    return x;
  };
  const ocupacao = db.prepare(`SELECT COUNT(*) AS total, SUM(situacao = 'ocupada') AS ocupadas, SUM(situacao = 'reservada') AS reservadas,
    SUM(situacao = 'defeito') AS defeito, SUM(situacao = 'livre') AS livres FROM portas_rede WHERE ativo_id = ? AND em_uso = 1`);
  const comOcupacao = (x) => {
    if (x.tipo !== 'cto') return x;
    rede.expirarReservas(db, x.id);
    const o = ocupacao.get(x.id);
    return { ...x, portas: { total: o.total, ocupadas: o.ocupadas ?? 0, reservadas: o.reservadas ?? 0, defeito: o.defeito ?? 0, livres: o.livres ?? 0 } };
  };

  const coordenadas = (b, a = {}) => {
    const temLat = b.lat !== undefined && b.lat !== '' && b.lat !== null;
    const temLng = b.lng !== undefined && b.lng !== '' && b.lng !== null;
    if (!temLat && !temLng) return b.lat === undefined && b.lng === undefined ? [a.lat ?? null, a.lng ?? null] : [null, null];
    v.exigir(temLat && temLng, 'Informe latitude e longitude juntas.');
    return v.coordenadas(b.lat, b.lng);
  };

  const equipamentoDaOrg = (req, id) => {
    if (!id) return null;
    const e = db.prepare('SELECT id FROM equipamentos WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!e) throw new ErroNegocio('Equipamento não encontrado.', 422);
    return e.id;
  };

  // ---------------- Ativos ----------------
  r.get('/ativos', exigir('rede.ver'), (req, res) => {
    const f = ['a.organizacao_id = ?'];
    const p = [req.org];
    f.push(req.query.inativos === '1' ? '1 = 1' : 'a.ativo = 1');
    for (const k of ['tipo', 'bairro', 'status_operacional']) if (req.query[k]) { f.push(`a.${k} = ?`); p.push(String(req.query[k])); }
    if (req.query.busca) { f.push("(a.codigo LIKE ? ESCAPE '\\' OR a.nome LIKE ? ESCAPE '\\' OR a.endereco LIKE ? ESCAPE '\\')"); p.push(like(req.query.busca), like(req.query.busca), like(req.query.busca)); }
    const lista = listaPaginada(db, `SELECT a.*, e.nome AS equipamento_nome, (SELECT d.codigo FROM enlaces l JOIN ativos_rede d ON d.id = l.destino_id
      WHERE l.origem_id = a.id AND l.fim IS NULL) AS alimentado_por FROM ativos_rede a LEFT JOIN equipamentos e ON e.id = a.equipamento_id
      WHERE ${f.join(' AND ')} ORDER BY a.tipo, a.codigo`, p, req.query, { padrao: 100 });
    lista.itens = lista.itens.map(comOcupacao);
    res.json(lista);
  });

  r.get('/bairros', exigir('rede.ver'), (req, res) => {
    res.json(db.prepare("SELECT DISTINCT bairro FROM ativos_rede WHERE organizacao_id = ? AND bairro IS NOT NULL AND ativo = 1 ORDER BY bairro").all(req.org).map((x) => x.bairro));
  });

  r.post('/ativos', exigir('rede.editar'), (req, res) => {
    const b = req.body ?? {};
    const tipo = v.opcao(b.tipo, 'o tipo', TIPOS);
    const [lat, lng] = coordenadas(b);
    const d = {
      tipo, codigo: v.texto(b.codigo, 'o código', 40).toUpperCase(), nome: v.opcional(b.nome, 'o nome', 120), endereco: v.opcional(b.endereco, 'o endereço', 200),
      bairro: v.opcional(b.bairro, 'o bairro', 80), lat, lng, referencia_acesso: v.opcional(b.referencia_acesso, 'a referência de acesso', 300),
      capacidade: tipo === 'pop' ? null : v.inteiro(b.capacidade, 'a capacidade', { min: 1, max: tipo === 'cto' ? 128 : 576 }),
      splitter: tipo === 'cto' ? v.opcional(b.splitter, 'o splitter', 20) : null,
      equipamento_id: tipo === 'cto' ? equipamentoDaOrg(req, b.equipamento_id) : null, pon: tipo === 'cto' ? v.opcional(b.pon, 'a PON', 40) : null,
      observacoes: v.opcional(b.observacoes, 'as observações', 1000),
    };
    if (db.prepare('SELECT 1 FROM ativos_rede WHERE organizacao_id = ? AND codigo = ?').get(req.org, d.codigo)) throw new ErroNegocio(`O código ${d.codigo} já existe.`, 409);
    const id = transacao(db, () => {
      const nid = Number(db.prepare(`INSERT INTO ativos_rede (organizacao_id, codigo, tipo, nome, endereco, bairro, lat, lng, referencia_acesso, capacidade, splitter, equipamento_id,
        pon, observacoes, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, d.codigo, d.tipo, d.nome, d.endereco, d.bairro, d.lat, d.lng,
        d.referencia_acesso, d.capacidade, d.splitter, d.equipamento_id, d.pon, d.observacoes, agora()).lastInsertRowid);
      if (tipo === 'cto') {
        const ins = db.prepare('INSERT INTO portas_rede (ativo_id, numero, desde) VALUES (?, ?, ?)');
        for (let i = 1; i <= d.capacidade; i++) ins.run(nid, i, agora());
      }
      if (tipo === 'ceo') {
        const n = v.inteiroOpcional(b.bandejas, 'o número de bandejas', { max: 48 }) ?? 0;
        for (let i = 1; i <= n; i++) db.prepare('INSERT INTO bandejas (ceo_id, numero, capacidade) VALUES (?, ?, ?)').run(nid, i, 12);
      }
      return nid;
    });
    registrar(db, req, 'ativo_criado', { recurso: 'ativo', recursoId: id, depois: d });
    res.status(201).json(comOcupacao(ativo(req, id)));
  });

  r.get('/ativos/:id', exigir('rede.ver'), (req, res) => {
    const a = comOcupacao(ativo(req, req.params.id));
    const filhos = db.prepare(`SELECT e.id AS enlace_id, e.inicio, e.fibras, c.codigo AS cabo, x.id, x.codigo, x.tipo, x.status_operacional FROM enlaces e
      JOIN ativos_rede x ON x.id = e.origem_id LEFT JOIN cabos c ON c.id = e.cabo_id WHERE e.destino_id = ? AND e.fim IS NULL ORDER BY x.codigo`).all(a.id);
    const r2 = {
      ...a,
      equipamento: a.equipamento_id ? db.prepare('SELECT id, nome, tipo, monitoramento_id FROM equipamentos WHERE id = ?').get(a.equipamento_id) : null,
      acima: rede.acima(db, a.id) ?? null,
      alimenta: filhos,
      percurso: rede.percurso(db, a.id),
      impacto: rede.impacto(db, [a.id, ...rede.descendentes(db, a.id)]),
      historico_ligacoes: db.prepare(`SELECT e.*, o.codigo AS origem_codigo, d.codigo AS destino_codigo FROM enlaces e JOIN ativos_rede o ON o.id = e.origem_id
        JOIN ativos_rede d ON d.id = e.destino_id WHERE (e.origem_id = ? OR e.destino_id = ?) AND e.fim IS NOT NULL ORDER BY e.fim DESC LIMIT 30`).all(a.id, a.id),
      historico: db.prepare(`SELECT a.id, a.acao, a.depois, a.criado_em, u.nome AS usuario_nome FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
        WHERE a.organizacao_id = ? AND a.recurso = 'ativo' AND a.recurso_id = ? ORDER BY a.id DESC LIMIT 50`).all(req.org, a.id),
      anexos: db.prepare("SELECT id, nome, mime FROM anexos WHERE recurso = 'ativo' AND recurso_id = ?").all(a.id),
      incidentes: db.prepare(`SELECT id, titulo, severidade, status, inicio FROM incidentes WHERE organizacao_id = ? AND status <> 'resolvido'
        AND (ativo_id = ? OR (equipamento_id IS NOT NULL AND equipamento_id = ?)) ORDER BY inicio DESC`).all(req.org, a.id, a.equipamento_id ?? -1),
    };
    if (a.tipo === 'cto') {
      r2.lista_portas = db.prepare(`SELECT p.*, u.nome AS reservado_por_nome FROM portas_rede p LEFT JOIN usuarios u ON u.id = p.reservado_por
        WHERE p.ativo_id = ? AND p.em_uso = 1 ORDER BY p.numero`).all(a.id);
    }
    if (a.tipo === 'ceo') {
      r2.bandejas = db.prepare('SELECT * FROM bandejas WHERE ceo_id = ? ORDER BY numero').all(a.id);
      r2.fusoes = db.prepare(`SELECT f.*, ca.codigo AS a_cabo, cb.codigo AS b_cabo, b.numero AS bandeja FROM fusoes f JOIN cabos ca ON ca.id = f.a_cabo_id
        JOIN cabos cb ON cb.id = f.b_cabo_id JOIN bandejas b ON b.id = f.bandeja_id WHERE f.ceo_id = ? ORDER BY f.ativa DESC, b.numero, f.id`).all(a.id);
    }
    if (a.tipo === 'pop') r2.equipamentos = db.prepare('SELECT * FROM equipamentos WHERE ativo_id = ? ORDER BY nome').all(a.id);
    res.json(r2);
  });

  r.patch('/ativos/:id', exigir('rede.editar'), (req, res) => {
    const a = ativo(req, req.params.id);
    conferirVersao(a.versao, req.body?.versao);
    const b = req.body ?? {};
    const [lat, lng] = coordenadas(b, a);
    const val = (k, fn) => (b[k] !== undefined ? fn(b[k]) : a[k]);
    const d = {
      nome: val('nome', (x) => v.opcional(x, 'o nome', 120)), endereco: val('endereco', (x) => v.opcional(x, 'o endereço', 200)),
      bairro: val('bairro', (x) => v.opcional(x, 'o bairro', 80)), lat, lng,
      referencia_acesso: val('referencia_acesso', (x) => v.opcional(x, 'a referência de acesso', 300)),
      splitter: val('splitter', (x) => v.opcional(x, 'o splitter', 20)), equipamento_id: val('equipamento_id', (x) => equipamentoDaOrg(req, x)),
      pon: val('pon', (x) => v.opcional(x, 'a PON', 40)), observacoes: val('observacoes', (x) => v.opcional(x, 'as observações', 1000)),
      capacidade: a.capacidade,
    };
    transacao(db, () => {
      // Capacidade: aumentar cria portas; reduzir só se as portas removidas estiverem livres ou com defeito (nunca abaixo da ocupação ativa).
      if (b.capacidade !== undefined && a.tipo !== 'pop') {
        const nova = v.inteiro(b.capacidade, 'a capacidade', { min: 1, max: a.tipo === 'cto' ? 128 : 576 });
        if (a.tipo === 'cto' && nova !== a.capacidade) {
          if (nova < a.capacidade) {
            const presas = db.prepare("SELECT numero, situacao FROM portas_rede WHERE ativo_id = ? AND numero > ? AND em_uso = 1 AND situacao IN ('ocupada','reservada') ORDER BY numero").all(a.id, nova);
            if (presas.length) {
              throw new ErroNegocio(`Não é possível reduzir para ${nova} portas: ${presas.map((x) => `porta ${x.numero} (${x.situacao})`).join(', ')} em uso. Remaneje antes.`, 409, { portas: presas });
            }
            db.prepare('UPDATE portas_rede SET em_uso = 0, versao = versao + 1 WHERE ativo_id = ? AND numero > ?').run(a.id, nova);
          } else {
            db.prepare('UPDATE portas_rede SET em_uso = 1, versao = versao + 1 WHERE ativo_id = ? AND numero <= ?').run(a.id, nova);
            const ins = db.prepare('INSERT OR IGNORE INTO portas_rede (ativo_id, numero, desde) VALUES (?, ?, ?)');
            for (let i = a.capacidade + 1; i <= nova; i++) ins.run(a.id, i, agora());
          }
        }
        d.capacidade = nova;
      }
      db.prepare(`UPDATE ativos_rede SET nome = ?, endereco = ?, bairro = ?, lat = ?, lng = ?, referencia_acesso = ?, splitter = ?, equipamento_id = ?, pon = ?, observacoes = ?,
        capacidade = ?, versao = versao + 1 WHERE id = ?`).run(d.nome, d.endereco, d.bairro, d.lat, d.lng, d.referencia_acesso, d.splitter, d.equipamento_id, d.pon,
        d.observacoes, d.capacidade, a.id);
    });
    registrar(db, req, 'ativo_alterado', { recurso: 'ativo', recursoId: a.id, antes: a, depois: d });
    res.json(comOcupacao(ativo(req, a.id)));
  });

  /** Inspeção de campo: a situação passa a ter origem "inspeção manual", com a evidência e quem registrou. */
  r.post('/ativos/:id/inspecao', exigir('rede.editar', 'rede.portas'), (req, res) => {
    const a = ativo(req, req.params.id);
    const status = v.opcao(req.body?.status_operacional, 'a situação', STATUS.filter((s) => s !== 'nao_avaliado'));
    const evidencia = v.texto(req.body?.evidencia, 'a evidência da inspeção', 1000);
    db.prepare("UPDATE ativos_rede SET status_operacional = ?, status_origem = 'inspecao_manual', status_evidencia = ?, status_em = ?, status_por = ?, versao = versao + 1 WHERE id = ?")
      .run(status, evidencia, agora(), req.usuario.id, a.id);
    registrar(db, req, 'ativo_inspecionado', { recurso: 'ativo', recursoId: a.id, antes: { status: a.status_operacional, origem: a.status_origem }, depois: { status, evidencia } });
    res.json(comOcupacao(ativo(req, a.id)));
  });

  r.post('/ativos/:id/desativar', exigir('rede.editar'), (req, res) => {
    const a = ativo(req, req.params.id);
    const motivo = v.texto(req.body?.motivo, 'o motivo', 300);
    const filhos = db.prepare('SELECT COUNT(*) AS n FROM enlaces WHERE destino_id = ? AND fim IS NULL').get(a.id).n;
    if (filhos) throw new ErroNegocio(`Este ativo alimenta ${filhos} outro(s). Encerre ou remaneje as ligações antes de desativar.`, 409);
    if (db.prepare("SELECT 1 FROM portas_rede WHERE ativo_id = ? AND situacao IN ('ocupada','reservada')").get(a.id)) {
      throw new ErroNegocio('Há portas ocupadas ou reservadas nesta CTO.', 409);
    }
    if (db.prepare('SELECT 1 FROM fusoes WHERE ceo_id = ? AND ativa = 1').get(a.id)) throw new ErroNegocio('Há fusões ativas nesta caixa.', 409);
    transacao(db, () => {
      db.prepare('UPDATE enlaces SET fim = ?, motivo_fim = ?, encerrado_por = ? WHERE origem_id = ? AND fim IS NULL').run(agora(), `Ativo desativado: ${motivo}`, req.usuario.id, a.id);
      db.prepare('UPDATE ativos_rede SET ativo = 0, versao = versao + 1 WHERE id = ?').run(a.id);
    });
    registrar(db, req, 'ativo_desativado', { recurso: 'ativo', recursoId: a.id, depois: { motivo } });
    res.json({ ok: true });
  });

  // ---------------- Portas ----------------
  const porta = (req, id) => {
    const p = db.prepare(`SELECT p.*, a.organizacao_id, a.codigo FROM portas_rede p JOIN ativos_rede a ON a.id = p.ativo_id WHERE p.id = ? AND a.organizacao_id = ? AND a.ativo = 1 AND p.em_uso = 1`)
      .get(Number(id), req.org);
    if (!p) throw new ErroNegocio('Porta não encontrada.', 404);
    rede.expirarReservas(db, p.ativo_id);
    return db.prepare('SELECT p.*, a.codigo FROM portas_rede p JOIN ativos_rede a ON a.id = p.ativo_id WHERE p.id = ?').get(p.id);
  };

  /** Troca de situação condicional: só vale se a porta ainda está na situação esperada (duas sessões não reservam a mesma porta). */
  function mudarPorta(req, p, { de, para, campos, motivo }) {
    if (!de.includes(p.situacao)) throw new ErroNegocio(`A porta ${p.numero} de ${p.codigo} está ${p.situacao}.`, 409);
    if (req.body?.versao !== undefined && Number(req.body.versao) !== p.versao) throw new ErroNegocio('A porta foi alterada por outra pessoa. Recarregue.', 409);
    const t = agora();
    const ok = transacao(db, () => {
      const r2 = db.prepare(`UPDATE portas_rede SET situacao = ?, cliente_ref = ?, onu_ref = ?, reservado_por = ?, reserva_expira_em = ?, observacao = ?, desde = ?, versao = versao + 1
        WHERE id = ? AND versao = ? AND situacao = ?`).run(para, campos.cliente_ref ?? null, campos.onu_ref ?? null, campos.reservado_por ?? null,
        campos.reserva_expira_em ?? null, campos.observacao ?? null, t, p.id, p.versao, p.situacao);
      if (r2.changes === 0) return false;
      db.prepare('INSERT INTO porta_historico (porta_id, situacao_anterior, situacao, cliente_ref, onu_ref, motivo, usuario_id, em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(p.id, p.situacao, para, campos.cliente_ref ?? null, campos.onu_ref ?? null, motivo ?? null, req.usuario.id, t);
      return true;
    });
    if (!ok) throw new ErroNegocio('A porta acabou de ser alterada por outra sessão. Recarregue e escolha outra.', 409);
    registrar(db, req, `porta_${para}`, { recurso: 'ativo', recursoId: p.ativo_id, antes: { porta: p.numero, situacao: p.situacao, cliente_ref: p.cliente_ref },
      depois: { porta: p.numero, situacao: para, ...campos, motivo } });
    return db.prepare('SELECT * FROM portas_rede WHERE id = ?').get(p.id);
  }

  r.post('/portas/:id/reservar', exigir('rede.portas'), (req, res) => {
    const p = porta(req, req.params.id);
    const horas = db.prepare('SELECT reserva_porta_horas FROM organizacoes WHERE id = ?').get(req.org).reserva_porta_horas;
    res.json(mudarPorta(req, p, { de: ['livre'], para: 'reservada', motivo: v.opcional(req.body?.motivo, 'o motivo', 300),
      campos: { cliente_ref: v.opcional(req.body?.cliente_ref, 'a referência do cliente', 80), reservado_por: req.usuario.id,
        reserva_expira_em: new Date(Date.now() + horas * 3600_000).toISOString(), observacao: v.opcional(req.body?.observacao, 'a observação', 300) } }));
  });

  r.post('/portas/:id/ocupar', exigir('rede.portas'), (req, res) => {
    const p = porta(req, req.params.id);
    res.json(mudarPorta(req, p, { de: ['livre', 'reservada'], para: 'ocupada', motivo: v.opcional(req.body?.motivo, 'o motivo', 300),
      campos: { cliente_ref: v.texto(req.body?.cliente_ref ?? p.cliente_ref, 'a referência do cliente', 80), onu_ref: v.opcional(req.body?.onu_ref, 'a ONU', 80),
        observacao: v.opcional(req.body?.observacao, 'a observação', 300) } }));
  });

  r.post('/portas/:id/liberar', exigir('rede.portas'), (req, res) => {
    const p = porta(req, req.params.id);
    res.json(mudarPorta(req, p, { de: ['reservada', 'ocupada', 'defeito'], para: 'livre', motivo: v.texto(req.body?.motivo, 'o motivo', 300), campos: {} }));
  });

  r.post('/portas/:id/defeito', exigir('rede.portas'), (req, res) => {
    const p = porta(req, req.params.id);
    res.json(mudarPorta(req, p, { de: ['livre', 'reservada'], para: 'defeito', motivo: v.texto(req.body?.motivo, 'o motivo', 300), campos: { observacao: req.body?.motivo } }));
  });

  r.get('/portas/:id/historico', exigir('rede.ver'), (req, res) => {
    const p = porta(req, req.params.id);
    res.json(db.prepare(`SELECT h.*, u.nome AS usuario_nome FROM porta_historico h LEFT JOIN usuarios u ON u.id = h.usuario_id WHERE h.porta_id = ? ORDER BY h.id DESC`).all(p.id));
  });

  // ---------------- Ligações (enlaces) ----------------
  r.post('/enlaces', exigir('rede.editar'), (req, res) => {
    const b = req.body ?? {};
    const origem = ativo(req, b.origem_id);
    const destino = ativo(req, b.destino_id);
    v.exigir(origem.ativo && destino.ativo, 'Os dois ativos precisam estar ativos.');
    v.exigir(LIGACOES[origem.tipo].includes(destino.tipo), `Um(a) ${origem.tipo.toUpperCase()} não pode ser alimentado(a) por um(a) ${destino.tipo.toUpperCase()}.`);
    if (rede.descendentes(db, origem.id).includes(destino.id) || origem.id === destino.id) throw new ErroNegocio('A ligação criaria um ciclo na topologia.', 422);
    const existente = rede.acima(db, origem.id);
    if (existente) throw new ErroNegocio(`${origem.codigo} já é alimentado por ${existente.destino_codigo}. Encerre a ligação atual antes.`, 409);
    let caboId = null;
    if (b.cabo_id) {
      const c = db.prepare('SELECT id FROM cabos WHERE id = ? AND organizacao_id = ?').get(Number(b.cabo_id), req.org);
      if (!c) throw new ErroNegocio('Cabo não encontrado.', 422);
      caboId = c.id;
    }
    const fibras = v.opcional(b.fibras, 'as fibras', 80);
    const id = Number(db.prepare('INSERT INTO enlaces (organizacao_id, origem_id, destino_id, cabo_id, fibras, inicio, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.org, origem.id, destino.id, caboId, fibras, agora(), req.usuario.id).lastInsertRowid);
    registrar(db, req, 'ligacao_criada', { recurso: 'ativo', recursoId: origem.id, depois: { enlace_id: id, alimentado_por: destino.codigo, cabo_id: caboId, fibras } });
    registrar(db, req, 'ligacao_criada', { recurso: 'ativo', recursoId: destino.id, depois: { enlace_id: id, alimenta: origem.codigo, cabo_id: caboId, fibras } });
    res.status(201).json({ id, origem: origem.codigo, destino: destino.codigo });
  });

  /**
   * Encerra uma ligação. Se o ativo de origem alimenta outros (dependentes), exige confirmação explícita: os dependentes
   * ficam com o percurso desconhecido até uma nova ligação. Nada é apagado: a ligação ganha fim e motivo.
   */
  r.post('/enlaces/:id/encerrar', exigir('rede.editar'), (req, res) => {
    const e = db.prepare('SELECT * FROM enlaces WHERE id = ? AND organizacao_id = ? AND fim IS NULL').get(Number(req.params.id), req.org);
    if (!e) throw new ErroNegocio('Ligação não encontrada ou já encerrada.', 404);
    const motivo = v.texto(req.body?.motivo, 'o motivo', 300);
    const dep = rede.descendentes(db, e.origem_id);
    if (dep.length && req.body?.confirmar_dependentes !== true) {
      const lista = db.prepare(`SELECT id, codigo, tipo FROM ativos_rede WHERE id IN (${dep.map(() => '?').join(',')})`).all(...dep);
      throw new ErroNegocio(`Esta ligação tem ${dep.length} ativo(s) dependente(s), que ficarão sem percurso até o POP. Confirme o tratamento.`, 409,
        { dependentes: lista, impacto: rede.impacto(db, [e.origem_id, ...dep]) });
    }
    db.prepare('UPDATE enlaces SET fim = ?, motivo_fim = ?, encerrado_por = ? WHERE id = ?').run(agora(), motivo, req.usuario.id, e.id);
    for (const id of [e.origem_id, e.destino_id]) {
      registrar(db, req, 'ligacao_encerrada', { recurso: 'ativo', recursoId: id, antes: e, depois: { motivo, dependentes: dep.length } });
    }
    res.json({ ok: true, dependentes_sem_percurso: dep.length });
  });

  r.get('/ativos/:id/percurso', exigir('rede.ver'), (req, res) => res.json(rede.percurso(db, ativo(req, req.params.id).id)));

  // ---------------- Cabos ----------------
  r.get('/cabos', exigir('rede.ver'), (req, res) => res.json(db.prepare('SELECT * FROM cabos WHERE organizacao_id = ? ORDER BY codigo').all(req.org)));
  r.post('/cabos', exigir('rede.editar'), (req, res) => {
    const b = req.body ?? {};
    const d = { codigo: v.texto(b.codigo, 'o código', 40).toUpperCase(), fibras: v.inteiro(b.fibras, 'a quantidade de fibras', { min: 1, max: 576 }),
      tipo: v.opcional(b.tipo, 'o tipo', 60), comprimento_m: v.inteiroOpcional(b.comprimento_m, 'o comprimento', { max: 500_000 }), observacoes: v.opcional(b.observacoes, 'as observações', 500) };
    if (db.prepare('SELECT 1 FROM cabos WHERE organizacao_id = ? AND codigo = ?').get(req.org, d.codigo)) throw new ErroNegocio(`O cabo ${d.codigo} já existe.`, 409);
    const id = Number(db.prepare('INSERT INTO cabos (organizacao_id, codigo, fibras, tipo, comprimento_m, observacoes, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.org, d.codigo, d.fibras, d.tipo, d.comprimento_m, d.observacoes, agora()).lastInsertRowid);
    registrar(db, req, 'cabo_criado', { recurso: 'cabo', recursoId: id, depois: d });
    res.status(201).json({ id, ...d });
  });

  // ---------------- Caixas de emenda: bandejas e fusões ----------------
  r.post('/ativos/:id/bandejas', exigir('rede.editar'), (req, res) => {
    const a = ativo(req, req.params.id);
    v.exigir(a.tipo === 'ceo', 'Bandejas são da caixa de emenda.');
    const numero = v.inteiro(req.body?.numero, 'o número da bandeja', { min: 1, max: 99 });
    const capacidade = v.inteiro(req.body?.capacidade ?? 12, 'a capacidade', { min: 1, max: 144 });
    const id = Number(db.prepare('INSERT INTO bandejas (ceo_id, numero, capacidade) VALUES (?, ?, ?)').run(a.id, numero, capacidade).lastInsertRowid);
    registrar(db, req, 'bandeja_criada', { recurso: 'ativo', recursoId: a.id, depois: { numero, capacidade } });
    res.status(201).json({ id, numero, capacidade });
  });

  r.post('/ativos/:id/fusoes', exigir('rede.editar'), (req, res) => {
    const a = ativo(req, req.params.id);
    v.exigir(a.tipo === 'ceo', 'Fusões são registradas na caixa de emenda.');
    const b = req.body ?? {};
    const bandeja = db.prepare('SELECT * FROM bandejas WHERE id = ? AND ceo_id = ?').get(Number(b.bandeja_id), a.id);
    if (!bandeja) throw new ErroNegocio('Bandeja não encontrada nesta caixa.', 422);
    const ponta = (x, nome) => {
      const cabo = db.prepare('SELECT * FROM cabos WHERE id = ? AND organizacao_id = ?').get(Number(x?.cabo_id), req.org);
      if (!cabo) throw new ErroNegocio(`Cabo da extremidade ${nome} não encontrado.`, 422);
      const tubo = v.inteiro(x.tubo ?? 1, `o tubo da extremidade ${nome}`, { min: 1, max: 48 });
      const fibra = v.inteiro(x.fibra, `a fibra da extremidade ${nome}`, { min: 1, max: 576 });
      v.exigir(fibra <= cabo.fibras, `O cabo ${cabo.codigo} tem ${cabo.fibras} fibras.`);
      return { cabo_id: cabo.id, codigo: cabo.codigo, tubo, fibra, cor: v.opcional(x.cor, 'a cor', 30) };
    };
    const pa = ponta(b.a, 'A');
    const pb = ponta(b.b, 'B');
    v.exigir(!(pa.cabo_id === pb.cabo_id && pa.tubo === pb.tubo && pa.fibra === pb.fibra), 'As duas extremidades são a mesma fibra.');
    const ocupadas = db.prepare('SELECT COUNT(*) AS n FROM fusoes WHERE bandeja_id = ? AND ativa = 1').get(bandeja.id).n;
    if (ocupadas >= bandeja.capacidade) throw new ErroNegocio(`A bandeja ${bandeja.numero} está cheia (${bandeja.capacidade} fusões).`, 409);
    const conflito = db.prepare(`SELECT f.id FROM fusao_extremidades x JOIN fusoes f ON f.id = x.fusao_id WHERE x.ceo_id = ? AND x.cabo_id = ? AND x.tubo = ? AND x.fibra = ? AND x.ativa = 1`);
    for (const [p, nome] of [[pa, 'A'], [pb, 'B']]) {
      const c = conflito.get(a.id, p.cabo_id, p.tubo, p.fibra);
      if (c) throw new ErroNegocio(`A extremidade ${nome} (${p.codigo} tubo ${p.tubo} fibra ${p.fibra}) já está na fusão #${c.id} ativa.`, 409);
    }
    const id = transacao(db, () => {
      const nid = Number(db.prepare(`INSERT INTO fusoes (organizacao_id, ceo_id, bandeja_id, a_cabo_id, a_tubo, a_fibra, a_cor, b_cabo_id, b_tubo, b_fibra, b_cor, observacao, inicio, criado_por)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, a.id, bandeja.id, pa.cabo_id, pa.tubo, pa.fibra, pa.cor, pb.cabo_id, pb.tubo, pb.fibra, pb.cor,
        v.opcional(b.observacao, 'a observação', 300), agora(), req.usuario.id).lastInsertRowid);
      const ins = db.prepare('INSERT INTO fusao_extremidades (fusao_id, ceo_id, cabo_id, tubo, fibra) VALUES (?, ?, ?, ?, ?)');
      ins.run(nid, a.id, pa.cabo_id, pa.tubo, pa.fibra);
      ins.run(nid, a.id, pb.cabo_id, pb.tubo, pb.fibra);
      return nid;
    });
    registrar(db, req, 'fusao_registrada', { recurso: 'ativo', recursoId: a.id, depois: { fusao_id: id, bandeja: bandeja.numero, a: pa, b: pb } });
    res.status(201).json({ id });
  });

  r.post('/fusoes/:id/desfazer', exigir('rede.editar'), (req, res) => {
    const f = db.prepare('SELECT * FROM fusoes WHERE id = ? AND organizacao_id = ? AND ativa = 1').get(Number(req.params.id), req.org);
    if (!f) throw new ErroNegocio('Fusão não encontrada ou já desfeita.', 404);
    const motivo = v.texto(req.body?.motivo, 'o motivo', 300);
    transacao(db, () => {
      db.prepare('UPDATE fusoes SET ativa = 0, fim = ?, motivo_fim = ? WHERE id = ?').run(agora(), motivo, f.id);
      db.prepare('UPDATE fusao_extremidades SET ativa = 0 WHERE fusao_id = ?').run(f.id);
    });
    registrar(db, req, 'fusao_desfeita', { recurso: 'ativo', recursoId: f.ceo_id, antes: f, depois: { motivo } });
    res.json({ ok: true });
  });

  // ---------------- Equipamentos ativos ----------------
  r.get('/equipamentos', exigir('rede.ver', 'noc.ver'), (req, res) => {
    res.json(db.prepare(`SELECT e.*, a.codigo AS pop_codigo FROM equipamentos e LEFT JOIN ativos_rede a ON a.id = e.ativo_id WHERE e.organizacao_id = ? ORDER BY e.nome`).all(req.org));
  });

  const dadosEquip = (req, b, a = {}) => {
    const val = (k, fn) => (b[k] !== undefined ? fn(b[k]) : a[k] ?? null);
    const popId = val('ativo_id', (x) => {
      if (!x) return null;
      const p = db.prepare("SELECT id FROM ativos_rede WHERE id = ? AND organizacao_id = ? AND tipo = 'pop'").get(Number(x), req.org);
      if (!p) throw new ErroNegocio('POP não encontrado.', 422);
      return p.id;
    });
    return { ativo_id: popId, tipo: val('tipo', (x) => v.opcao(x, 'o tipo', TIPOS_EQUIP)), nome: val('nome', (x) => v.texto(x, 'o nome', 120)),
      fabricante: val('fabricante', (x) => v.opcional(x, 'o fabricante', 60)), modelo: val('modelo', (x) => v.opcional(x, 'o modelo', 60)),
      monitoramento_id: val('monitoramento_id', (x) => v.opcional(x, 'o identificador do monitoramento', 120)), ip_gerencia: val('ip_gerencia', (x) => v.opcional(x, 'o IP de gerência', 60)) };
  };

  r.post('/equipamentos', exigir('rede.editar'), (req, res) => {
    const d = dadosEquip(req, req.body ?? {});
    v.exigir(d.tipo && d.nome, 'Informe tipo e nome.');
    const id = Number(db.prepare(`INSERT INTO equipamentos (organizacao_id, ativo_id, tipo, nome, fabricante, modelo, monitoramento_id, ip_gerencia, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, d.ativo_id, d.tipo, d.nome, d.fabricante, d.modelo, d.monitoramento_id, d.ip_gerencia, agora()).lastInsertRowid);
    registrar(db, req, 'equipamento_criado', { recurso: 'equipamento', recursoId: id, depois: d });
    res.status(201).json({ id, ...d });
  });

  r.patch('/equipamentos/:id', exigir('rede.editar'), (req, res) => {
    const a = db.prepare('SELECT * FROM equipamentos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!a) throw new ErroNegocio('Equipamento não encontrado.', 404);
    const d = dadosEquip(req, req.body ?? {}, a);
    db.prepare('UPDATE equipamentos SET ativo_id = ?, tipo = ?, nome = ?, fabricante = ?, modelo = ?, monitoramento_id = ?, ip_gerencia = ? WHERE id = ?')
      .run(d.ativo_id, d.tipo, d.nome, d.fabricante, d.modelo, d.monitoramento_id, d.ip_gerencia, a.id);
    registrar(db, req, 'equipamento_alterado', { recurso: 'equipamento', recursoId: a.id, antes: a, depois: d });
    res.json({ id: a.id, ...d });
  });

  /** Ativos com coordenadas e as ligações ativas entre eles, para o mapa. */
  r.get('/mapa', exigir('rede.ver'), (req, res) => {
    const ativos = db.prepare(`SELECT id, codigo, tipo, nome, bairro, lat, lng, status_operacional, status_origem, capacidade FROM ativos_rede
      WHERE organizacao_id = ? AND ativo = 1`).all(req.org).map(comOcupacao);
    const ligacoes = db.prepare(`SELECT e.id, o.id AS origem_id, o.lat AS origem_lat, o.lng AS origem_lng, d.id AS destino_id, d.lat AS destino_lat, d.lng AS destino_lng
      FROM enlaces e JOIN ativos_rede o ON o.id = e.origem_id JOIN ativos_rede d ON d.id = e.destino_id WHERE e.organizacao_id = ? AND e.fim IS NULL`).all(req.org);
    res.json({ ativos: ativos.filter((a) => a.lat !== null), sem_coordenadas: ativos.filter((a) => a.lat === null).map((a) => ({ id: a.id, codigo: a.codigo, tipo: a.tipo })),
      ligacoes: ligacoes.filter((l) => l.origem_lat !== null && l.destino_lat !== null) });
  });

  return r;
};
