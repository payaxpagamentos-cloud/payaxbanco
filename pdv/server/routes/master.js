'use strict';

const { Router } = require('express');
const { agora, lerConfig, CONFIG_PADRAO } = require('../db');
const { criarUsuario, alterarUsuario } = require('../lib/contas');
const { permitir, PLATAFORMA } = require('../auth');
const { registrar } = require('../lib/auditoria');
const { naoEncontrado, ErroNegocio } = require('../lib/erros');
const { processarFila } = require('../lib/baixas');
const { hoje, somarDias } = require('../lib/datas');
const v = require('../lib/validacao');

const PERFIS = ['master', 'suporte', 'admin', 'supervisor', 'operador'];

/** Área da plataforma (/api/master): empresas atendidas, usuários, visão geral e auditoria. */
module.exports = (db) => {
  const r = Router();
  r.use(permitir(...PLATAFORMA));
  const soMaster = permitir('master');

  // Visão geral: o que cada empresa recebeu hoje e o que está pendente de baixa no IXC.
  r.get('/painel', (req, res) => {
    const empresas = db.prepare(`SELECT e.id, e.nome, e.status,
        (SELECT COUNT(*) FROM recebimentos r WHERE r.empresa_id = e.id AND r.data = ? AND r.status = 'confirmado') AS recebimentos_hoje,
        (SELECT COALESCE(SUM(r.valor_centavos), 0) FROM recebimentos r WHERE r.empresa_id = e.id AND r.data = ? AND r.status = 'confirmado') AS total_hoje,
        (SELECT COUNT(*) FROM recebimentos r WHERE r.empresa_id = e.id AND r.status = 'confirmado' AND r.ixc_status IN ('pendente','enviando','erro','parcial')) AS baixas_pendentes,
        (SELECT COUNT(*) FROM divergencias d WHERE d.empresa_id = e.id AND d.status = 'aberta') AS divergencias,
        (SELECT COUNT(*) FROM caixas c WHERE c.empresa_id = e.id AND c.status = 'aberto') AS caixas_abertos,
        (SELECT COUNT(*) FROM terminais t WHERE t.empresa_id = e.id AND t.ativo = 1) AS maquininhas
      FROM empresas e WHERE e.status <> 'excluida' ORDER BY e.nome`).all(hoje(), hoje());
    const serie = db.prepare(`SELECT data, COALESCE(SUM(valor_centavos), 0) AS total_centavos, COUNT(*) AS quantidade
      FROM recebimentos WHERE status = 'confirmado' AND data >= ? GROUP BY data ORDER BY data`).all(somarDias(hoje(), -29));
    res.json({ empresas, serie, hoje: hoje() });
  });

  // ----- Empresas -----
  r.get('/empresas', (req, res) => res.json({ itens: db.prepare("SELECT * FROM empresas WHERE status <> 'excluida' ORDER BY nome").all() }));

  r.post('/empresas', soMaster, (req, res) => {
    const nome = v.texto(req.body.nome, 'o nome da empresa', 120);
    const documento = req.body.documento ? v.documento(req.body.documento) : null;
    const x = db.prepare('INSERT INTO empresas (nome, documento, email, telefone, criada_em) VALUES (?, ?, ?, ?, ?)')
      .run(nome, documento, req.body.email ? v.email(req.body.email) : null, req.body.telefone ? v.telefone(req.body.telefone) : null, agora());
    const id = Number(x.lastInsertRowid);
    // Toda empresa começa com uma loja e um PDV, para o balcão poder abrir o caixa no primeiro dia.
    const loja = db.prepare('INSERT INTO lojas (empresa_id, nome, criada_em) VALUES (?, ?, ?)').run(id, 'Matriz', agora());
    db.prepare('INSERT INTO pdvs (empresa_id, loja_id, nome, criado_em) VALUES (?, ?, ?, ?)').run(id, Number(loja.lastInsertRowid), 'Caixa 1', agora());
    db.prepare('INSERT INTO config_empresa (empresa_id, atualizado_em) VALUES (?, ?)').run(id, agora());
    registrar(db, req, 'empresa_criada', { empresa: id, nome }, id);
    res.status(201).json(db.prepare('SELECT * FROM empresas WHERE id = ?').get(id));
  });

  r.patch('/empresas/:id', soMaster, (req, res) => {
    const e = db.prepare("SELECT * FROM empresas WHERE id = ? AND status <> 'excluida'").get(Number(req.params.id));
    if (!e) throw naoEncontrado('Empresa');
    const d = req.body;
    const status = d.status === undefined ? e.status : v.opcao(d.status, 'a situação', ['ativa', 'bloqueada', 'excluida']);
    if (status === 'excluida' && db.prepare("SELECT 1 FROM caixas WHERE empresa_id = ? AND status = 'aberto'").get(e.id)) {
      throw new ErroNegocio('Há caixa aberto nesta empresa.', 409);
    }
    db.prepare('UPDATE empresas SET nome = ?, documento = ?, email = ?, telefone = ?, status = ?, motivo_bloqueio = ? WHERE id = ?').run(
      d.nome === undefined ? e.nome : v.texto(d.nome, 'o nome da empresa', 120),
      d.documento === undefined ? e.documento : (d.documento ? v.documento(d.documento) : null),
      d.email === undefined ? e.email : (d.email ? v.email(d.email) : null),
      d.telefone === undefined ? e.telefone : (d.telefone ? v.telefone(d.telefone) : null),
      status, status === 'bloqueada' ? v.texto(d.motivo_bloqueio ?? e.motivo_bloqueio, 'o motivo do bloqueio', 300) : null, e.id);
    registrar(db, req, 'empresa_alterada', { empresa: e.id, status }, e.id);
    res.json(db.prepare('SELECT * FROM empresas WHERE id = ?').get(e.id));
  });

  // ----- Usuários (plataforma e empresas) -----
  r.get('/usuarios', (req, res) => res.json({
    itens: db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.empresa_id, u.loja_id, u.ativo, u.ultimo_acesso, e.nome AS empresa_nome
      FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id ORDER BY u.nome`).all(),
    perfis: PERFIS,
  }));

  r.post('/usuarios', soMaster, (req, res) => {
    const empresaId = req.body.empresa_id ? Number(req.body.empresa_id) : null;
    if (empresaId && !db.prepare("SELECT 1 FROM empresas WHERE id = ? AND status <> 'excluida'").get(empresaId)) throw naoEncontrado('Empresa');
    const id = criarUsuario(db, req.body, { perfis: PERFIS, empresaId });
    registrar(db, req, 'usuario_criado', { usuario: id, perfil: req.body.perfil }, empresaId);
    res.status(201).json(db.prepare('SELECT id, nome, email, perfil, empresa_id, ativo FROM usuarios WHERE id = ?').get(id));
  });

  r.patch('/usuarios/:id', soMaster, (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(req.params.id));
    if (!u) throw naoEncontrado('Usuário');
    if (u.id === req.usuario.id && req.body.ativo !== undefined && !v.booleano(req.body.ativo)) throw new ErroNegocio('Você não pode desativar a própria conta.', 422);
    alterarUsuario(db, u, req.body, { perfis: PERFIS });
    registrar(db, req, 'usuario_alterado', { usuario: u.id }, u.empresa_id);
    res.json(db.prepare('SELECT id, nome, email, perfil, empresa_id, ativo FROM usuarios WHERE id = ?').get(u.id));
  });

  // ----- Configurações da plataforma e manutenção -----
  r.get('/configuracoes', (req, res) => res.json(lerConfig(db)));

  r.patch('/configuracoes', soMaster, (req, res) => {
    const grava = db.prepare('UPDATE configuracoes SET valor = ? WHERE chave = ?');
    for (const [k, valor] of Object.entries(req.body ?? {})) {
      if (!(k in CONFIG_PADRAO)) continue;
      grava.run(k === 'nome_plataforma' ? v.texto(valor, 'o nome da plataforma', 60) : String(v.inteiro(valor, k, { min: 1, max: 100000 })), k);
    }
    registrar(db, req, 'plataforma_configurada', req.body);
    res.json(lerConfig(db));
  });

  r.post('/fila', async (req, res) => {
    const resultado = await processarFila(db, { limite: 100 });
    registrar(db, req, 'fila_baixas_plataforma', resultado);
    res.json(resultado);
  });

  r.get('/auditoria', (req, res) => {
    const itens = db.prepare(`SELECT a.*, u.nome AS usuario_nome, e.nome AS empresa_nome FROM auditoria a
      LEFT JOIN usuarios u ON u.id = a.usuario_id LEFT JOIN empresas e ON e.id = a.empresa_id
      ORDER BY a.id DESC LIMIT ?`).all(Math.min(300, Number(req.query.limite) || 100));
    res.json({ itens: itens.map((x) => ({ ...x, detalhes: x.detalhes ? JSON.parse(x.detalhes) : null })) });
  });

  return r;
};
