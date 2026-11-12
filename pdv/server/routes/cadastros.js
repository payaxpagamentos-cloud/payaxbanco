'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { criarUsuario, alterarUsuario, lojaDaEmpresa, gerarChaveTerminal } = require('../lib/contas');
const { cifrar } = require('../lib/cripto');
const { permitir } = require('../auth');
const { registrar } = require('../lib/auditoria');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const config = require('../config');
const v = require('../lib/validacao');

const ADMINISTRA = ['master', 'suporte', 'admin'];
const PERFIS_EMPRESA = ['admin', 'supervisor', 'operador'];
const ADQUIRENTES = ['stone', 'cielo', 'rede', 'getnet', 'pagbank', 'mercadopago', 'sipag', 'safrapay', 'outro'];

/** Cadastros da empresa (/api/empresas/:eid/cadastros): lojas, PDVs, maquininhas e usuários. */
module.exports = (db) => {
  const r = Router({ mergeParams: true });
  const administra = permitir(...ADMINISTRA);

  // ----- Lojas -----
  r.get('/lojas', (req, res) => res.json({ itens: db.prepare('SELECT * FROM lojas WHERE empresa_id = ? ORDER BY nome').all(req.empresa.id) }));

  r.post('/lojas', administra, (req, res) => {
    const x = db.prepare('INSERT INTO lojas (empresa_id, nome, endereco, ixc_filial_id, criada_em) VALUES (?, ?, ?, ?, ?)')
      .run(req.empresa.id, v.texto(req.body.nome, 'o nome da loja', 120), v.opcional(req.body.endereco, 'o endereço', 200),
        v.opcional(req.body.ixc_filial_id, 'a filial do IXC', 20), agora());
    registrar(db, req, 'loja_criada', { loja: Number(x.lastInsertRowid) });
    res.status(201).json(db.prepare('SELECT * FROM lojas WHERE id = ?').get(Number(x.lastInsertRowid)));
  });

  r.patch('/lojas/:id', administra, (req, res) => {
    const loja = db.prepare('SELECT * FROM lojas WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
    if (!loja) throw naoEncontrado('Loja');
    const d = req.body;
    db.prepare('UPDATE lojas SET nome = ?, endereco = ?, ixc_filial_id = ?, ativa = ? WHERE id = ?').run(
      d.nome === undefined ? loja.nome : v.texto(d.nome, 'o nome da loja', 120),
      d.endereco === undefined ? loja.endereco : v.opcional(d.endereco, 'o endereço', 200),
      d.ixc_filial_id === undefined ? loja.ixc_filial_id : v.opcional(d.ixc_filial_id, 'a filial do IXC', 20),
      d.ativa === undefined ? loja.ativa : (v.booleano(d.ativa) ? 1 : 0), loja.id);
    registrar(db, req, 'loja_alterada', { loja: loja.id });
    res.json(db.prepare('SELECT * FROM lojas WHERE id = ?').get(loja.id));
  });

  // ----- PDVs (estações de caixa) -----
  r.get('/pdvs', (req, res) => res.json({
    itens: db.prepare(`SELECT p.*, l.nome AS loja_nome, (SELECT c.id FROM caixas c WHERE c.pdv_id = p.id AND c.status = 'aberto') AS caixa_aberto_id
      FROM pdvs p JOIN lojas l ON l.id = p.loja_id WHERE p.empresa_id = ? ORDER BY l.nome, p.nome`).all(req.empresa.id),
  }));

  r.post('/pdvs', administra, (req, res) => {
    const lojaId = lojaDaEmpresa(db, req.empresa.id, req.body.loja_id);
    if (!lojaId) throw new ErroNegocio('Escolha a loja do PDV.', 422);
    const x = db.prepare('INSERT INTO pdvs (empresa_id, loja_id, nome, criado_em) VALUES (?, ?, ?, ?)')
      .run(req.empresa.id, lojaId, v.texto(req.body.nome, 'o nome do PDV', 80), agora());
    registrar(db, req, 'pdv_criado', { pdv: Number(x.lastInsertRowid) });
    res.status(201).json(db.prepare('SELECT * FROM pdvs WHERE id = ?').get(Number(x.lastInsertRowid)));
  });

  r.patch('/pdvs/:id', administra, (req, res) => {
    const pdv = db.prepare('SELECT * FROM pdvs WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
    if (!pdv) throw naoEncontrado('PDV');
    if (req.body.ativo !== undefined && !v.booleano(req.body.ativo) && db.prepare("SELECT 1 FROM caixas WHERE pdv_id = ? AND status = 'aberto'").get(pdv.id)) {
      throw new ErroNegocio('Há um caixa aberto neste PDV. Feche-o antes de desativar.', 409);
    }
    db.prepare('UPDATE pdvs SET nome = ?, ativo = ? WHERE id = ?').run(
      req.body.nome === undefined ? pdv.nome : v.texto(req.body.nome, 'o nome do PDV', 80),
      req.body.ativo === undefined ? pdv.ativo : (v.booleano(req.body.ativo) ? 1 : 0), pdv.id);
    registrar(db, req, 'pdv_alterado', { pdv: pdv.id });
    res.json(db.prepare('SELECT * FROM pdvs WHERE id = ?').get(pdv.id));
  });

  // ----- Maquininhas -----
  const terminalPublico = (t) => ({ ...t, token_cifrado: undefined, chave_hash: undefined, chave_definida: !!t.chave_hash, token_definido: !!t.token_cifrado });

  r.get('/terminais', (req, res) => res.json({
    itens: db.prepare(`SELECT t.*, l.nome AS loja_nome, p.nome AS pdv_nome FROM terminais t JOIN lojas l ON l.id = t.loja_id
      LEFT JOIN pdvs p ON p.id = t.pdv_id WHERE t.empresa_id = ? ORDER BY t.nome`).all(req.empresa.id).map(terminalPublico),
    adquirentes: ADQUIRENTES,
  }));

  r.post('/terminais', administra, (req, res) => {
    const d = req.body;
    const lojaId = lojaDaEmpresa(db, req.empresa.id, d.loja_id);
    if (!lojaId) throw new ErroNegocio('Escolha a loja da maquininha.', 422);
    const modo = v.opcao(d.modo ?? 'agente', 'o modo de integração', ['agente', 'webhook', 'manual']);
    const endereco = modo === 'webhook' ? v.url(d.endereco, 'o endereço do adquirente', { permitirHttp: config.permitirHttp }) : null;
    const x = db.prepare(`INSERT INTO terminais (empresa_id, loja_id, pdv_id, nome, adquirente, modelo, serial, modo, endereco, token_cifrado, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.empresa.id, lojaId, pdvDaEmpresa(db, req.empresa.id, d.pdv_id),
      v.texto(d.nome, 'o nome da maquininha', 80), v.opcao(d.adquirente ?? 'outro', 'o adquirente', ADQUIRENTES),
      v.opcional(d.modelo, 'o modelo', 60), v.opcional(d.serial, 'o número de série', 60), modo, endereco,
      d.token ? cifrar(v.texto(d.token, 'o token do adquirente', 300)) : null, agora());
    const id = Number(x.lastInsertRowid);
    const chave = modo === 'manual' ? null : gerarChaveTerminal(db, id);
    registrar(db, req, 'terminal_criado', { terminal: id, modo });
    res.status(201).json({ ...terminalPublico(db.prepare('SELECT * FROM terminais WHERE id = ?').get(id)), chave: chave?.chave ?? null });
  });

  r.patch('/terminais/:id', administra, (req, res) => {
    const t = lerTerminal(db, req.empresa.id, req.params.id);
    const d = req.body;
    const modo = d.modo === undefined ? t.modo : v.opcao(d.modo, 'o modo de integração', ['agente', 'webhook', 'manual']);
    const endereco = d.endereco === undefined ? t.endereco : (d.endereco ? v.url(d.endereco, 'o endereço do adquirente', { permitirHttp: config.permitirHttp }) : null);
    if (modo === 'webhook' && !endereco) throw new ErroNegocio('Informe o endereço do adquirente para o modo webhook.', 422);
    db.prepare(`UPDATE terminais SET nome = ?, adquirente = ?, modelo = ?, serial = ?, modo = ?, endereco = ?, pdv_id = ?, loja_id = ?, ativo = ?
      ${d.token ? ', token_cifrado = ?' : ''} WHERE id = ?`).run(
      d.nome === undefined ? t.nome : v.texto(d.nome, 'o nome da maquininha', 80),
      d.adquirente === undefined ? t.adquirente : v.opcao(d.adquirente, 'o adquirente', ADQUIRENTES),
      d.modelo === undefined ? t.modelo : v.opcional(d.modelo, 'o modelo', 60),
      d.serial === undefined ? t.serial : v.opcional(d.serial, 'o número de série', 60),
      modo, endereco,
      d.pdv_id === undefined ? t.pdv_id : pdvDaEmpresa(db, req.empresa.id, d.pdv_id),
      d.loja_id === undefined ? t.loja_id : lojaDaEmpresa(db, req.empresa.id, d.loja_id) ?? t.loja_id,
      d.ativo === undefined ? t.ativo : (v.booleano(d.ativo) ? 1 : 0),
      ...(d.token ? [cifrar(v.texto(d.token, 'o token do adquirente', 300))] : []), t.id);
    registrar(db, req, 'terminal_alterado', { terminal: t.id });
    res.json(terminalPublico(db.prepare('SELECT * FROM terminais WHERE id = ?').get(t.id)));
  });

  // Gera (ou troca) a chave da maquininha. A chave aparece uma única vez.
  r.post('/terminais/:id/chave', administra, (req, res) => {
    const t = lerTerminal(db, req.empresa.id, req.params.id);
    const chave = gerarChaveTerminal(db, t.id);
    registrar(db, req, 'terminal_chave', { terminal: t.id });
    res.json({ chave: chave.chave, prefixo: chave.prefixo });
  });

  // ----- Usuários da empresa -----
  r.get('/usuarios', (req, res) => res.json({
    itens: db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.loja_id, u.ativo, u.ultimo_acesso, u.criado_em, l.nome AS loja_nome
      FROM usuarios u LEFT JOIN lojas l ON l.id = u.loja_id WHERE u.empresa_id = ? ORDER BY u.nome`).all(req.empresa.id),
    perfis: PERFIS_EMPRESA,
  }));

  r.post('/usuarios', administra, (req, res) => {
    const id = criarUsuario(db, req.body, { perfis: PERFIS_EMPRESA, empresaId: req.empresa.id });
    registrar(db, req, 'usuario_criado', { usuario: id, perfil: req.body.perfil });
    res.status(201).json(db.prepare('SELECT id, nome, email, perfil, loja_id, ativo FROM usuarios WHERE id = ?').get(id));
  });

  r.patch('/usuarios/:id', administra, (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
    if (!u) throw naoEncontrado('Usuário');
    if (u.id === req.usuario.id && req.body.ativo !== undefined && !v.booleano(req.body.ativo)) throw new ErroNegocio('Você não pode desativar a própria conta.', 422);
    alterarUsuario(db, u, req.body, { perfis: PERFIS_EMPRESA });
    registrar(db, req, 'usuario_alterado', { usuario: u.id });
    res.json(db.prepare('SELECT id, nome, email, perfil, loja_id, ativo FROM usuarios WHERE id = ?').get(u.id));
  });

  return r;
};

function lerTerminal(db, empresaId, id) {
  const t = db.prepare('SELECT * FROM terminais WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!t) throw naoEncontrado('Maquininha');
  return t;
}

function pdvDaEmpresa(db, empresaId, pdvId) {
  if (pdvId === undefined || pdvId === null || pdvId === '') return null;
  const p = db.prepare('SELECT id FROM pdvs WHERE id = ? AND empresa_id = ?').get(Number(pdvId), empresaId);
  if (!p) throw new ErroNegocio('PDV não encontrado nesta empresa.', 422);
  return p.id;
}
