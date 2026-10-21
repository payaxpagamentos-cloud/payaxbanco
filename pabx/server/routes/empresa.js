'use strict';

const { Router } = require('express');
const { transacao, agora, lerConfig } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { dashboard, relatorio } = require('../lib/painel');
const { emCurso, discoUsado } = require('../lib/chamadas');
const { periodo, listarChamadas, csv, reais, enviarCsv, COLUNAS_CHAMADAS } = require('../lib/consultas');
const { criarUsuario, alterarUsuario, criarChave, senhaSip } = require('../lib/contas');
const { inicioMes, intervalo, hoje } = require('../lib/datas');
const v = require('../lib/validacao');

const DESTINOS = ['ramal', 'fila', 'ura'];
const TABELA_DESTINO = { ramal: 'ramais', fila: 'filas', ura: 'uras' };

/** Painel de uma empresa (/api/empresas/:eid/...). O acesso à empresa já foi conferido (req.empresa). */
module.exports = (db) => {
  const r = Router({ mergeParams: true });
  const eid = (req) => req.empresa.id;
  const nid = (req) => Number(req.params.id);
  // Usuários, chaves e dados da empresa: o administrador da empresa e a equipe da plataforma (não o supervisor, que só consulta).
  const administra = permitir('master', 'suporte', 'cliente');
  const doTipo = (tabela, req, nome) => {
    const x = db.prepare(`SELECT * FROM ${tabela} WHERE id = ? AND empresa_id = ?`).get(nid(req), eid(req));
    if (!x) throw naoEncontrado(nome);
    return x;
  };
  /** Destino (ramal, fila ou URA) que pertence à empresa. */
  const destino = (empresaId, tipo, id) => {
    v.opcao(tipo, 'o tipo de destino', DESTINOS);
    const x = db.prepare(`SELECT id FROM ${TABELA_DESTINO[tipo]} WHERE id = ? AND empresa_id = ?`).get(Number(id), empresaId);
    v.exigir(x, 'Destino não encontrado nesta empresa.');
    return x.id;
  };

  r.get('/', (req, res) => {
    const e = req.empresa;
    res.json({ id: e.id, nome: e.nome, tipo: e.tipo, status: e.status });
  });

  // ---------- Dashboard e supervisão ----------
  r.get('/dashboard', (req, res) => {
    const e = req.empresa;
    res.json({
      ...dashboard(db, e.id),
      empresa: { id: e.id, nome: e.nome, tipo: e.tipo, limite_ramais: e.limite_ramais, limite_canais: e.limite_canais },
      disco: { usado_bytes: discoUsado(db, e.id), limite_bytes: e.disco_mb * 1024 * 1024 },
    });
  });

  r.get('/supervisao', (req, res) => {
    const id = eid(req);
    const campanhas = db.prepare(`SELECT c.id, c.nome, c.modo, c.status, c.canais, f.nome AS fila,
        (SELECT COUNT(*) FROM campanha_contatos x WHERE x.campanha_id = c.id) AS contatos,
        (SELECT COUNT(*) FROM campanha_contatos x WHERE x.campanha_id = c.id AND x.status = 'pendente') AS pendentes,
        (SELECT COUNT(*) FROM campanha_contatos x WHERE x.campanha_id = c.id AND x.status = 'atendido') AS atendidos,
        (SELECT COUNT(*) FROM campanha_contatos x WHERE x.campanha_id = c.id AND x.status IN ('nao_atendido','ocupado','falha')) AS sem_sucesso,
        (SELECT COUNT(*) FROM chamadas ch WHERE ch.campanha_id = c.id AND ch.fim IS NULL) AS em_curso
      FROM campanhas c LEFT JOIN filas f ON f.id = c.fila_id WHERE c.empresa_id = ? AND c.status IN ('ativa','pausada') ORDER BY c.status, c.nome`).all(id);
    const agentes = db.prepare(`SELECT r.id, r.numero, r.nome, r.online,
        (SELECT ch.destino FROM chamadas ch WHERE ch.ramal_id = r.id AND ch.fim IS NULL ORDER BY ch.inicio DESC LIMIT 1) AS falando_com,
        (SELECT ch.inicio FROM chamadas ch WHERE ch.ramal_id = r.id AND ch.fim IS NULL ORDER BY ch.inicio DESC LIMIT 1) AS desde,
        (SELECT COUNT(*) FROM chamadas ch WHERE ch.ramal_id = r.id AND ch.inicio >= ?) AS chamadas_hoje
      FROM ramais r WHERE r.empresa_id = ? AND r.ativo = 1 ORDER BY r.numero`).all(intervalo(hoje(), hoje())[0], id);
    res.json({ campanhas, agentes, em_curso: emCurso(db, id) });
  });

  // ---------- Campanhas ----------
  const dadosCampanha = (empresaId, d, atual = {}) => ({
    nome: d.nome !== undefined ? v.texto(d.nome, 'o nome da campanha', 120) : atual.nome,
    modo: d.modo !== undefined ? v.opcao(d.modo, 'o modo', ['preditivo', 'progressivo', 'preview']) : (atual.modo ?? 'progressivo'),
    fila_id: d.fila_id !== undefined ? (d.fila_id ? destino(empresaId, 'fila', d.fila_id) : null) : (atual.fila_id ?? null),
    canais: d.canais !== undefined ? v.inteiro(d.canais, 'o número de canais', { min: 1, max: 500 }) : (atual.canais ?? 1),
    tentativas_max: d.tentativas_max !== undefined ? v.inteiro(d.tentativas_max, 'o número de tentativas', { min: 1, max: 10 }) : (atual.tentativas_max ?? 3),
  });

  r.get('/campanhas', (req, res) => res.json(db.prepare(`SELECT c.*, f.nome AS fila,
      (SELECT COUNT(*) FROM campanha_contatos x WHERE x.campanha_id = c.id) AS contatos,
      (SELECT COUNT(*) FROM campanha_contatos x WHERE x.campanha_id = c.id AND x.status = 'pendente') AS pendentes,
      (SELECT COUNT(*) FROM campanha_contatos x WHERE x.campanha_id = c.id AND x.status = 'atendido') AS atendidos
    FROM campanhas c LEFT JOIN filas f ON f.id = c.fila_id WHERE c.empresa_id = ? ORDER BY c.id DESC`).all(eid(req))));

  r.post('/campanhas', (req, res) => {
    const d = dadosCampanha(eid(req), req.body);
    v.exigir(d.nome, 'Informe o nome da campanha.');
    v.exigir(d.canais <= req.empresa.limite_canais, `A empresa tem até ${req.empresa.limite_canais} chamadas simultâneas.`);
    const x = db.prepare('INSERT INTO campanhas (empresa_id, nome, modo, fila_id, canais, tentativas_max, criada_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(eid(req), d.nome, d.modo, d.fila_id, d.canais, d.tentativas_max, agora());
    registrar(db, req, 'campanha_criada', { id: Number(x.lastInsertRowid), nome: d.nome });
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });

  r.patch('/campanhas/:id', (req, res) => {
    const c = doTipo('campanhas', req, 'Campanha');
    const d = dadosCampanha(eid(req), req.body, c);
    v.exigir(d.canais <= req.empresa.limite_canais, `A empresa tem até ${req.empresa.limite_canais} chamadas simultâneas.`);
    let status = c.status;
    if (req.body.status !== undefined) {
      status = v.opcao(req.body.status, 'o status', ['rascunho', 'ativa', 'pausada', 'encerrada']);
      v.exigir(c.status !== 'encerrada' || status === 'encerrada', 'Campanha encerrada não pode ser reaberta.');
      if (status === 'ativa') {
        v.exigir(d.fila_id, 'Escolha a fila que atende as chamadas da campanha antes de ativar.');
        v.exigir(db.prepare('SELECT 1 FROM campanha_contatos WHERE campanha_id = ?').get(c.id), 'Importe os contatos antes de ativar a campanha.');
      }
    }
    db.prepare('UPDATE campanhas SET nome = ?, modo = ?, fila_id = ?, canais = ?, tentativas_max = ?, status = ? WHERE id = ?')
      .run(d.nome, d.modo, d.fila_id, d.canais, d.tentativas_max, status, c.id);
    if (status !== c.status) registrar(db, req, 'campanha_status', { id: c.id, de: c.status, para: status });
    res.status(204).end();
  });

  r.delete('/campanhas/:id', (req, res) => {
    const c = doTipo('campanhas', req, 'Campanha');
    v.exigir(!db.prepare('SELECT 1 FROM chamadas WHERE campanha_id = ?').get(c.id), 'A campanha já tem chamadas: encerre em vez de excluir.');
    db.prepare('DELETE FROM campanhas WHERE id = ?').run(c.id);
    registrar(db, req, 'campanha_excluida', { id: c.id, nome: c.nome });
    res.status(204).end();
  });

  r.get('/campanhas/:id/contatos', (req, res) => {
    const c = doTipo('campanhas', req, 'Campanha');
    const filtro = req.query.status ? v.opcao(req.query.status, 'o status', ['pendente', 'discando', 'atendido', 'nao_atendido', 'ocupado', 'falha']) : null;
    res.json(db.prepare(`SELECT * FROM campanha_contatos WHERE campanha_id = ? ${filtro ? 'AND status = ?' : ''} ORDER BY id LIMIT 1000`)
      .all(...[c.id, filtro].filter(Boolean)));
  });

  /** Importa contatos: uma linha por contato, "nome;telefone" ou só o telefone. Repetidos são ignorados. */
  r.post('/campanhas/:id/contatos', (req, res) => {
    const c = doTipo('campanhas', req, 'Campanha');
    v.exigir(c.status !== 'encerrada', 'Campanha encerrada.');
    const linhas = String(req.body.linhas ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    v.exigir(linhas.length, 'Informe ao menos um contato.');
    v.exigir(linhas.length <= 20_000, 'Importe até 20.000 contatos por vez.');
    const ins = db.prepare('INSERT OR IGNORE INTO campanha_contatos (campanha_id, nome, telefone) VALUES (?, ?, ?)');
    const invalidos = [];
    const importados = transacao(db, () => {
      let n = 0;
      for (const [i, l] of linhas.entries()) {
        const partes = l.split(/[;,\t]/).map((x) => x.trim());
        const tel = v.digitos(partes.at(-1));
        if (tel.length < 8 || tel.length > 15) { invalidos.push(i + 1); continue; }
        n += Number(ins.run(c.id, partes.length > 1 ? partes[0].slice(0, 120) || null : null, tel).changes);
      }
      return n;
    });
    registrar(db, req, 'campanha_contatos', { id: c.id, importados });
    res.status(201).json({ importados, ignorados: linhas.length - importados - invalidos.length, linhas_invalidas: invalidos.slice(0, 50) });
  });

  // ---------- Pessoas / Ramais ----------
  const ramalPublico = (x) => {
    const { senha_sip: _s, ...resto } = x;
    return resto;
  };
  r.get('/ramais', (req, res) => res.json(db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM chamadas c WHERE c.ramal_id = r.id AND c.fim IS NULL) AS em_curso,
      (SELECT GROUP_CONCAT(f.nome, ', ') FROM fila_ramais fr JOIN filas f ON f.id = fr.fila_id WHERE fr.ramal_id = r.id) AS filas
    FROM ramais r WHERE r.empresa_id = ? ORDER BY r.ativo DESC, CAST(r.numero AS INTEGER)`).all(eid(req)).map(ramalPublico)));

  r.post('/ramais', administra, (req, res) => {
    const d = req.body;
    const numero = v.ramal(d.numero);
    const id = transacao(db, () => {
      const ativos = db.prepare('SELECT COUNT(*) AS n FROM ramais WHERE empresa_id = ? AND ativo = 1').get(eid(req)).n;
      if (ativos >= req.empresa.limite_ramais) throw new ErroNegocio(`Limite de ${req.empresa.limite_ramais} ramais atingido. Fale com o suporte para ampliar.`, 422);
      if (db.prepare('SELECT 1 FROM ramais WHERE empresa_id = ? AND numero = ?').get(eid(req), numero)) throw new ErroNegocio('Já existe um ramal com este número.', 409);
      return Number(db.prepare('INSERT INTO ramais (empresa_id, numero, nome, email, senha_sip, gravar, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(eid(req), numero, v.texto(d.nome, 'o nome da pessoa', 120), d.email ? v.email(d.email) : null, senhaSip(), d.gravar === undefined ? 1 : (v.booleano(d.gravar) ? 1 : 0), agora())
        .lastInsertRowid);
    });
    registrar(db, req, 'ramal_criado', { id, numero });
    res.status(201).json({ id });
  });

  r.patch('/ramais/:id', administra, (req, res) => {
    const x = doTipo('ramais', req, 'Ramal');
    const d = req.body;
    transacao(db, () => {
      if (d.nome !== undefined) db.prepare('UPDATE ramais SET nome = ? WHERE id = ?').run(v.texto(d.nome, 'o nome da pessoa', 120), x.id);
      if (d.email !== undefined) db.prepare('UPDATE ramais SET email = ? WHERE id = ?').run(d.email ? v.email(d.email) : null, x.id);
      if (d.gravar !== undefined) db.prepare('UPDATE ramais SET gravar = ? WHERE id = ?').run(v.booleano(d.gravar) ? 1 : 0, x.id);
      if (d.ativo !== undefined) {
        const ativo = v.booleano(d.ativo);
        if (ativo && !x.ativo) {
          const n = db.prepare('SELECT COUNT(*) AS n FROM ramais WHERE empresa_id = ? AND ativo = 1').get(eid(req)).n;
          v.exigir(n < req.empresa.limite_ramais, `Limite de ${req.empresa.limite_ramais} ramais atingido.`);
        }
        db.prepare('UPDATE ramais SET ativo = ?, online = CASE WHEN ? THEN online ELSE 0 END WHERE id = ?').run(ativo ? 1 : 0, ativo ? 1 : 0, x.id);
      }
      if (d.nova_senha_sip) db.prepare('UPDATE ramais SET senha_sip = ? WHERE id = ?').run(senhaSip(), x.id);
    });
    registrar(db, req, 'ramal_alterado', { id: x.id, numero: x.numero, campos: Object.keys(d) });
    res.status(204).end();
  });

  /** Dados para configurar o telefone (usuário e senha SIP). O supervisor não vê a senha. */
  r.get('/ramais/:id/sip', administra, (req, res) => {
    const x = doTipo('ramais', req, 'Ramal');
    registrar(db, req, 'ramal_senha_vista', { id: x.id, numero: x.numero });
    res.json({ usuario: `${req.empresa.id}_${x.numero}`, ramal: x.numero, senha: x.senha_sip });
  });

  r.delete('/ramais/:id', administra, (req, res) => {
    const x = doTipo('ramais', req, 'Ramal');
    // Com chamadas no histórico o ramal só é desativado, para não perder a informação de quem falou.
    if (db.prepare('SELECT 1 FROM chamadas WHERE ramal_id = ?').get(x.id)) {
      db.prepare('UPDATE ramais SET ativo = 0, online = 0 WHERE id = ?').run(x.id);
      registrar(db, req, 'ramal_desativado', { id: x.id, numero: x.numero });
      return res.json({ desativado: true });
    }
    transacao(db, () => {
      soltarDestino(eid(req), 'ramal', x.id);
      db.prepare('DELETE FROM ramais WHERE id = ?').run(x.id);
    });
    registrar(db, req, 'ramal_excluido', { id: x.id, numero: x.numero });
    res.json({ excluido: true });
  });

  // ---------- Chamadas ----------
  r.get('/chamadas', (req, res) => res.json(listarChamadas(db, eid(req), req.query)));
  r.get('/chamadas.csv', (req, res) => {
    const l = listarChamadas(db, eid(req), req.query, { limite: 50_000 });
    enviarCsv(res, `chamadas-${l.de}-a-${l.ate}.csv`, csv(COLUNAS_CHAMADAS.filter(([k]) => k !== 'empresa_nome'), l.itens));
  });

  // ---------- CRM ----------
  const dadosContato = (d) => ({
    nome: v.texto(d.nome, 'o nome', 120),
    telefone: v.numeroTelefone(d.telefone, 'o telefone'),
    email: d.email ? v.email(d.email) : null,
    organizacao: v.opcional(d.organizacao, 'a empresa do contato', 120),
    observacoes: v.opcional(d.observacoes, 'as observações', 2000),
  });
  r.get('/contatos', (req, res) => {
    const b = String(req.query.busca ?? '').trim();
    const like = `%${b}%`;
    res.json(db.prepare(`SELECT ct.*, (SELECT COUNT(*) FROM chamadas c WHERE c.empresa_id = ct.empresa_id AND (c.origem = ct.telefone OR c.destino = ct.telefone)) AS chamadas,
        (SELECT MAX(c.inicio) FROM chamadas c WHERE c.empresa_id = ct.empresa_id AND (c.origem = ct.telefone OR c.destino = ct.telefone)) AS ultima_chamada
      FROM contatos ct WHERE ct.empresa_id = ? ${b ? 'AND (ct.nome LIKE ? OR ct.telefone LIKE ? OR ct.organizacao LIKE ? OR ct.email LIKE ?)' : ''}
      ORDER BY ct.nome LIMIT 500`).all(eid(req), ...(b ? [like, `%${v.digitos(b) || b}%`, like, like] : [])));
  });
  r.get('/contatos/:id', (req, res) => {
    const ct = doTipo('contatos', req, 'Contato');
    const chamadas = db.prepare(`SELECT c.id, c.direcao, c.origem, c.destino, c.status, c.inicio, c.duracao_s, c.custo_centavos, r.numero AS ramal, r.nome AS ramal_nome
      FROM chamadas c LEFT JOIN ramais r ON r.id = c.ramal_id WHERE c.empresa_id = ? AND (c.origem = ? OR c.destino = ?) ORDER BY c.inicio DESC LIMIT 100`)
      .all(eid(req), ct.telefone, ct.telefone);
    res.json({ ...ct, chamadas });
  });
  r.post('/contatos', (req, res) => {
    const d = dadosContato(req.body);
    const x = db.prepare('INSERT INTO contatos (empresa_id, nome, telefone, email, organizacao, observacoes, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(eid(req), d.nome, d.telefone, d.email, d.organizacao, d.observacoes, agora());
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.put('/contatos/:id', (req, res) => {
    const ct = doTipo('contatos', req, 'Contato');
    const d = dadosContato(req.body);
    db.prepare('UPDATE contatos SET nome = ?, telefone = ?, email = ?, organizacao = ?, observacoes = ? WHERE id = ?')
      .run(d.nome, d.telefone, d.email, d.organizacao, d.observacoes, ct.id);
    res.status(204).end();
  });
  r.delete('/contatos/:id', (req, res) => {
    const ct = doTipo('contatos', req, 'Contato');
    db.prepare('DELETE FROM contatos WHERE id = ?').run(ct.id);
    res.status(204).end();
  });

  // ---------- Terminação ----------
  r.get('/terminacao', (req, res) => {
    const e = req.empresa;
    const cfg = lerConfig(db);
    const tronco = e.tronco_id ? db.prepare('SELECT nome, ativo FROM troncos WHERE id = ?').get(e.tronco_id) : null;
    const [ini, fim] = intervalo(inicioMes(), hoje());
    res.json({
      rota: tronco ? { nome: tronco.nome, ativa: Boolean(tronco.ativo) } : null,
      cadencia: { inicial_s: cfg.cadencia_inicial_s, passo_s: cfg.cadencia_s },
      tarifas: { fixo: e.tarifa_fixo_centavos, movel: e.tarifa_movel_centavos, internacional: e.tarifa_internacional_centavos },
      limite_canais: e.limite_canais,
      mes: db.prepare(`SELECT tipo_destino, COUNT(*) AS chamadas, COALESCE(SUM(tarifado_s),0) AS tarifado_s, COALESCE(SUM(custo_centavos),0) AS custo_centavos
        FROM chamadas WHERE empresa_id = ? AND direcao = 'saida' AND inicio >= ? AND inicio < ? GROUP BY tipo_destino`).all(e.id, ini, fim),
    });
  });

  // ---------- Números entrantes ----------
  r.get('/numeros', (req, res) => res.json(db.prepare(`SELECT n.id, n.numero, n.descricao, n.destino_tipo, n.destino_id,
      CASE n.destino_tipo WHEN 'ramal' THEN (SELECT numero || ' · ' || nome FROM ramais WHERE id = n.destino_id)
        WHEN 'fila' THEN (SELECT nome FROM filas WHERE id = n.destino_id) WHEN 'ura' THEN (SELECT nome FROM uras WHERE id = n.destino_id) END AS destino_nome,
      (SELECT COUNT(*) FROM chamadas c WHERE c.numero_id = n.id) AS chamadas
    FROM numeros n WHERE n.empresa_id = ? ORDER BY n.numero`).all(eid(req))));

  r.patch('/numeros/:id', administra, (req, res) => {
    const n = doTipo('numeros', req, 'Número');
    const d = req.body;
    const tipo = d.destino_tipo || null;
    const destId = tipo ? destino(eid(req), tipo, d.destino_id) : null;
    db.prepare('UPDATE numeros SET destino_tipo = ?, destino_id = ?, descricao = ? WHERE id = ?')
      .run(tipo, destId, d.descricao !== undefined ? v.opcional(d.descricao, 'a descrição', 120) : n.descricao, n.id);
    registrar(db, req, 'numero_destino', { numero: n.numero, destino_tipo: tipo, destino_id: destId });
    res.status(204).end();
  });

  // ---------- Recursos PABX: filas e URAs ----------
  const membros = (empresaId, ids) => {
    v.exigir(Array.isArray(ids ?? []), 'Ramais inválidos.');
    return [...new Set((ids ?? []).map(Number))].map((id) => destino(empresaId, 'ramal', id));
  };
  r.get('/filas', (req, res) => {
    const filas = db.prepare('SELECT * FROM filas WHERE empresa_id = ? ORDER BY nome').all(eid(req));
    const m = db.prepare('SELECT r.id, r.numero, r.nome FROM fila_ramais fr JOIN ramais r ON r.id = fr.ramal_id WHERE fr.fila_id = ? ORDER BY r.numero');
    res.json(filas.map((f) => ({ ...f, ramais: m.all(f.id) })));
  });
  const salvarFila = (req, atual) => {
    const d = req.body;
    const dados = [
      v.texto(d.nome ?? atual?.nome, 'o nome da fila', 80),
      v.opcao(d.estrategia ?? atual?.estrategia ?? 'todos', 'a estratégia', ['todos', 'sequencial', 'aleatorio', 'menos_chamadas']),
      v.inteiro(d.espera_maxima_s ?? atual?.espera_maxima_s ?? 120, 'a espera máxima', { min: 10, max: 3600 }),
    ];
    const ramais = d.ramais !== undefined ? membros(eid(req), d.ramais) : null;
    return transacao(db, () => {
      let id = atual?.id;
      if (id) db.prepare('UPDATE filas SET nome = ?, estrategia = ?, espera_maxima_s = ? WHERE id = ?').run(...dados, id);
      else id = Number(db.prepare('INSERT INTO filas (empresa_id, nome, estrategia, espera_maxima_s, criada_em) VALUES (?, ?, ?, ?, ?)').run(eid(req), ...dados, agora()).lastInsertRowid);
      if (ramais) {
        db.prepare('DELETE FROM fila_ramais WHERE fila_id = ?').run(id);
        const ins = db.prepare('INSERT INTO fila_ramais (fila_id, ramal_id) VALUES (?, ?)');
        for (const rid of ramais) ins.run(id, rid);
      }
      return id;
    });
  };
  r.post('/filas', administra, (req, res) => {
    const id = salvarFila(req);
    registrar(db, req, 'fila_criada', { id });
    res.status(201).json({ id });
  });
  r.put('/filas/:id', administra, (req, res) => {
    salvarFila(req, doTipo('filas', req, 'Fila'));
    res.status(204).end();
  });
  /** Tira o destino excluído dos números e das opções de URA que apontavam para ele. */
  const soltarDestino = (empresaId, tipo, id) => {
    db.prepare('UPDATE numeros SET destino_tipo = NULL, destino_id = NULL WHERE empresa_id = ? AND destino_tipo = ? AND destino_id = ?').run(empresaId, tipo, id);
    for (const u of db.prepare('SELECT id, opcoes FROM uras WHERE empresa_id = ?').all(empresaId)) {
      const ops = JSON.parse(u.opcoes);
      const novas = ops.filter((o) => !(o.destino_tipo === tipo && o.destino_id === id));
      if (novas.length !== ops.length) db.prepare('UPDATE uras SET opcoes = ? WHERE id = ?').run(JSON.stringify(novas), u.id);
    }
  };
  r.delete('/filas/:id', administra, (req, res) => {
    const f = doTipo('filas', req, 'Fila');
    v.exigir(!db.prepare("SELECT 1 FROM campanhas WHERE fila_id = ? AND status IN ('ativa','pausada')").get(f.id), 'A fila atende uma campanha ativa ou pausada.');
    transacao(db, () => {
      soltarDestino(eid(req), 'fila', f.id);
      db.prepare('UPDATE campanhas SET fila_id = NULL WHERE fila_id = ?').run(f.id);
      db.prepare('DELETE FROM filas WHERE id = ?').run(f.id);
    });
    registrar(db, req, 'fila_excluida', { id: f.id, nome: f.nome });
    res.status(204).end();
  });

  r.get('/uras', (req, res) => res.json(db.prepare('SELECT * FROM uras WHERE empresa_id = ? ORDER BY nome').all(eid(req))
    .map((u) => ({ ...u, opcoes: JSON.parse(u.opcoes) }))));
  const salvarUra = (req, atual) => {
    const d = req.body;
    const nome = v.texto(d.nome ?? atual?.nome, 'o nome da URA', 80);
    const mensagem = v.texto(d.mensagem ?? atual?.mensagem, 'a mensagem', 1000);
    const lista = d.opcoes ?? (atual ? JSON.parse(atual.opcoes) : []);
    v.exigir(Array.isArray(lista) && lista.length <= 12, 'Opções inválidas (até 12).');
    const vistos = new Set();
    const opcoes = lista.map((o) => {
      const digito = String(o?.digito ?? '');
      v.exigir(/^[0-9*#]$/.test(digito), 'Cada opção usa uma tecla: 0 a 9, * ou #.');
      v.exigir(!vistos.has(digito), `A tecla ${digito} está repetida.`);
      vistos.add(digito);
      v.exigir(!(o.destino_tipo === 'ura' && atual && Number(o.destino_id) === atual.id), 'A URA não pode apontar para ela mesma.');
      return { digito, destino_tipo: o.destino_tipo, destino_id: destino(eid(req), o.destino_tipo, o.destino_id) };
    });
    if (atual) {
      db.prepare('UPDATE uras SET nome = ?, mensagem = ?, opcoes = ? WHERE id = ?').run(nome, mensagem, JSON.stringify(opcoes), atual.id);
      return atual.id;
    }
    return Number(db.prepare('INSERT INTO uras (empresa_id, nome, mensagem, opcoes, criada_em) VALUES (?, ?, ?, ?, ?)')
      .run(eid(req), nome, mensagem, JSON.stringify(opcoes), agora()).lastInsertRowid);
  };
  r.post('/uras', administra, (req, res) => {
    const id = salvarUra(req);
    registrar(db, req, 'ura_criada', { id });
    res.status(201).json({ id });
  });
  r.put('/uras/:id', administra, (req, res) => {
    salvarUra(req, doTipo('uras', req, 'URA'));
    res.status(204).end();
  });
  r.delete('/uras/:id', administra, (req, res) => {
    const u = doTipo('uras', req, 'URA');
    transacao(db, () => {
      soltarDestino(eid(req), 'ura', u.id);
      db.prepare('DELETE FROM uras WHERE id = ?').run(u.id);
    });
    registrar(db, req, 'ura_excluida', { id: u.id, nome: u.nome });
    res.status(204).end();
  });

  // ---------- Relatórios ----------
  r.get('/relatorios', (req, res) => {
    const [de, ate] = periodo(req.query, 29);
    res.json(relatorio(db, eid(req), de, ate));
  });
  r.get('/relatorios.csv', (req, res) => {
    const [de, ate] = periodo(req.query, 29);
    const rel = relatorio(db, eid(req), de, ate);
    enviarCsv(res, `relatorio-${de}-a-${ate}.csv`, csv([['dia', 'Dia'], ['chamadas', 'Chamadas'], ['recebidas', 'Recebidas'], ['realizadas', 'Realizadas'],
      ['atendidas', 'Atendidas'], ['perdidas', 'Não atendidas'], ['duracao_s', 'Duração (s)'], ['tarifado_s', 'Tarifado (s)'], [(l) => reais(l.custo_centavos), 'Custo (R$)']], rel.por_dia));
  });

  // ---------- Configurações da empresa e usuários ----------
  r.get('/configuracoes', (req, res) => {
    const e = req.empresa;
    res.json({
      empresa: { nome: e.nome, documento: e.documento, tipo: e.tipo, email: e.email, telefone: e.telefone, gravar_chamadas: Boolean(e.gravar_chamadas) },
      limites: { ramais: e.limite_ramais, canais: e.limite_canais, disco_mb: e.disco_mb, tts: e.tts_limite, stt: e.stt_limite },
    });
  });
  r.patch('/configuracoes', administra, (req, res) => {
    const d = req.body;
    const e = req.empresa;
    db.prepare('UPDATE empresas SET email = ?, telefone = ?, gravar_chamadas = ? WHERE id = ?').run(
      d.email !== undefined ? (d.email ? v.email(d.email) : null) : e.email,
      d.telefone !== undefined ? (d.telefone ? v.telefone(d.telefone) : null) : e.telefone,
      d.gravar_chamadas !== undefined ? (v.booleano(d.gravar_chamadas) ? 1 : 0) : e.gravar_chamadas, e.id);
    registrar(db, req, 'empresa_configuracoes', { campos: Object.keys(d) });
    res.status(204).end();
  });

  r.get('/usuarios', administra, (req, res) => res.json(db.prepare(`SELECT id, nome, email, perfil, ativo, ultimo_acesso, criado_em FROM usuarios
    WHERE empresa_id = ? ORDER BY nome`).all(eid(req))));
  r.post('/usuarios', administra, (req, res) => {
    const id = criarUsuario(db, req.body, { perfis: ['cliente', 'supervisor'], empresaId: eid(req) });
    registrar(db, req, 'usuario_criado', { id, perfil: req.body.perfil });
    res.status(201).json({ id });
  });
  r.patch('/usuarios/:id', administra, (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND empresa_id = ?').get(nid(req), eid(req));
    if (!u) throw naoEncontrado('Usuário');
    v.exigir(!(u.id === req.usuario.id && (req.body.ativo !== undefined && !v.booleano(req.body.ativo))), 'Você não pode desativar o seu próprio usuário.');
    alterarUsuario(db, u, req.body, { perfis: ['cliente', 'supervisor'] });
    registrar(db, req, 'usuario_alterado', { id: u.id, campos: Object.keys(req.body).filter((k) => k !== 'senha') });
    res.status(204).end();
  });

  // ---------- Integrações (chaves da API) ----------
  r.get('/chaves', administra, (req, res) => res.json(db.prepare(`SELECT k.id, k.nome, k.prefixo, k.criada_em, k.ultimo_uso, k.revogada_em, u.nome AS criada_por
    FROM chaves_api k LEFT JOIN usuarios u ON u.id = k.criada_por WHERE k.empresa_id = ? ORDER BY k.id DESC`).all(eid(req))));
  r.post('/chaves', administra, (req, res) => {
    const k = criarChave(db, eid(req), req.body.nome, req.usuario.id);
    registrar(db, req, 'chave_criada', { id: k.id, prefixo: k.prefixo });
    res.status(201).json(k);
  });
  r.delete('/chaves/:id', administra, (req, res) => {
    const k = doTipo('chaves_api', req, 'Chave');
    db.prepare('UPDATE chaves_api SET revogada_em = COALESCE(revogada_em, ?) WHERE id = ?').run(agora(), k.id);
    registrar(db, req, 'chave_revogada', { id: k.id, prefixo: k.prefixo });
    res.status(204).end();
  });

  return r;
};
