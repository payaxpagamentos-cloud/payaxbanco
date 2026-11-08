'use strict';

const { Router } = require('express');
const { transacao, agora } = require('../db');
const { emitirToken } = require('../auth');
const { hashSenha, verificarSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const { hoje } = require('../lib/datas');
const v = require('../lib/validacao');

const publico = (u) => ({ id: u.id, nome: u.nome, email: u.email, telefone: u.telefone, perfil: u.perfil });

function dadosVeiculo(d) {
  v.exigir(d && typeof d === 'object', 'Informe o veículo.');
  const ano = v.inteiro(d.ano, 'o ano do veículo', { min: 1990, max: new Date().getFullYear() + 1 });
  return {
    placa: v.placa(d.placa),
    marca_modelo: v.texto(d.marca_modelo, 'a marca e o modelo', 80),
    cor: v.texto(d.cor, 'a cor', 30),
    ano,
    categoria: v.opcao(d.categoria ?? 'comum', 'a categoria', ['comum', 'executivo']),
  };
}

/** Rotas públicas (cadastro e login) e da própria conta. */
module.exports = (db, autenticado) => {
  const r = Router();

  const criarUsuario = (d, perfil) => {
    const email = v.email(d.email);
    if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Já existe uma conta com este e-mail.', 409);
    const res = db.prepare('INSERT INTO usuarios (nome, email, telefone, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(v.texto(d.nome, 'o nome', 120), email, v.telefone(d.telefone), hashSenha(v.senha(d.senha)), perfil, agora());
    return Number(res.lastInsertRowid);
  };
  const entrar = (id) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    db.prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?').run(agora(), id);
    return { token: emitirToken(u), usuario: publico(u) };
  };

  r.post('/cadastro', (req, res) => {
    const id = criarUsuario(req.body, 'passageiro');
    res.status(201).json(entrar(id));
  });

  /** Motorista se cadastra com CPF, CNH e o primeiro veículo; fica pendente até a central aprovar. */
  r.post('/cadastro-motorista', (req, res) => {
    const d = req.body;
    v.exigir(v.cpfValido(d.cpf), 'CPF inválido.');
    v.exigir(v.cnhValida(d.cnh), 'Número de CNH inválido.');
    const validade = v.data(d.cnh_validade, 'a validade da CNH');
    v.exigir(validade >= hoje(), 'A CNH está vencida.');
    const veiculo = dadosVeiculo(d.veiculo);
    const id = transacao(db, () => {
      const cpf = v.digitos(d.cpf);
      const cnh = v.digitos(d.cnh);
      if (db.prepare('SELECT 1 FROM motoristas WHERE cpf = ? OR cnh = ?').get(cpf, cnh)) throw new ErroNegocio('CPF ou CNH já cadastrados.', 409);
      if (db.prepare('SELECT 1 FROM veiculos WHERE placa = ?').get(veiculo.placa)) throw new ErroNegocio('Placa já cadastrada.', 409);
      const uid = criarUsuario(d, 'motorista');
      db.prepare('INSERT INTO motoristas (usuario_id, cpf, cnh, cnh_validade, chave_pix) VALUES (?, ?, ?, ?, ?)')
        .run(uid, cpf, cnh, validade, v.opcional(d.chave_pix, 'a chave PIX', 120));
      const vr = db.prepare('INSERT INTO veiculos (motorista_id, placa, marca_modelo, cor, ano, categoria, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uid, veiculo.placa, veiculo.marca_modelo, veiculo.cor, veiculo.ano, veiculo.categoria, agora());
      db.prepare('UPDATE motoristas SET veiculo_id = ? WHERE usuario_id = ?').run(Number(vr.lastInsertRowid), uid);
      return uid;
    });
    res.status(201).json(entrar(id));
  });

  r.post('/login', (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(String(req.body.email ?? '').trim());
    if (!u || !verificarSenha(String(req.body.senha ?? ''), u.senha_hash)) throw new ErroNegocio('E-mail ou senha incorretos.', 401);
    if (!u.ativo) throw new ErroNegocio('Conta desativada. Fale com a central.', 403);
    res.json(entrar(u.id));
  });

  r.get('/me', autenticado, (req, res) => res.json({ usuario: publico(req.usuario) }));

  r.patch('/me', autenticado, (req, res) => {
    const d = req.body;
    if (d.nome !== undefined) db.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').run(v.texto(d.nome, 'o nome', 120), req.usuario.id);
    if (d.telefone !== undefined) db.prepare('UPDATE usuarios SET telefone = ? WHERE id = ?').run(v.telefone(d.telefone), req.usuario.id);
    res.status(204).end();
  });

  r.post('/senha', autenticado, (req, res) => {
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body.atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 422);
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(req.body.nova)), req.usuario.id);
    res.status(204).end();
  });

  return r;
};

module.exports.dadosVeiculo = dadosVeiculo;
