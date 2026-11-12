'use strict';

const { Router } = require('express');
const moradores = require('../lib/moradores');
const { hashSenha } = require('../lib/senha');
const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { competencia: competenciaDe, somarMeses } = require('../lib/datas');
const v = require('../lib/validacao');

/** Cadastro dos moradores, conta do mês (fiado), faturas e o portal do próprio morador. */
module.exports = (db, { equipe, gestao }) => {
  const r = Router();

  /** Portal do morador: o que ele mesmo vê das próprias compras. */
  r.get('/minha-conta', (req, res) => {
    if (!req.usuario.morador_id) throw new ErroNegocio('Sua conta de acesso não está ligada a um morador.', 403);
    const id = req.usuario.morador_id;
    res.json({
      morador: moradores.obter(db, id),
      consumo_do_mes: moradores.consumoDoMes(db, id),
      extrato: moradores.extrato(db, id, { limite: 60 }),
      faturas: moradores.faturas(db, { morador_id: id }),
      compras: db.prepare(`SELECT v.id, v.total_centavos, v.fechada_em FROM vendas v WHERE v.morador_id = ? AND v.status = 'paga' ORDER BY v.id DESC LIMIT 20`).all(id),
    });
  });

  r.get('/minha-conta/compras/:id', (req, res) => {
    const venda = db.prepare('SELECT * FROM vendas WHERE id = ? AND morador_id = ?').get(req.params.id, req.usuario.morador_id ?? -1);
    if (!venda) throw naoEncontrado('Compra');
    res.json(require('../lib/vendas').obter(db, venda.id));
  });

  // Daqui para baixo, só quem trabalha no mercadinho.
  r.use(equipe);

  r.get('/', (req, res) => res.json(moradores.listar(db, {
    busca: req.query.busca, situacao: req.query.situacao ?? 'ativos', devedores: req.query.devedores === '1',
  })));

  r.get('/faturas', (req, res) => res.json(moradores.faturas(db, {
    status: req.query.status || null, competencia: req.query.competencia ? v.competencia(req.query.competencia) : null,
  })));

  /** Fecha o mês e gera as faturas de quem comprou na conta. */
  r.post('/faturas/fechar', gestao, (req, res) => {
    const comp = req.body.competencia ? v.competencia(req.body.competencia) : somarMeses(competenciaDe(), -1);
    const resultado = moradores.fecharCompetencia(db, comp, req.usuario.id);
    registrar(db, req, 'faturas_fechadas', `${comp}: ${resultado.faturas} faturas`);
    res.json(resultado);
  });

  r.get('/:id', (req, res) => {
    const m = moradores.obter(db, Number(req.params.id));
    if (!m) throw naoEncontrado('Morador');
    res.json({
      ...m,
      consumo_do_mes: moradores.consumoDoMes(db, m.id),
      extrato: moradores.extrato(db, m.id),
      faturas: moradores.faturas(db, { morador_id: m.id }),
      acesso: db.prepare('SELECT id, email, ativo, ultimo_acesso FROM usuarios WHERE morador_id = ?').get(m.id) ?? null,
    });
  });

  const dados = (d, novo) => {
    const campos = {};
    if (novo || d.nome !== undefined) campos.nome = v.texto(d.nome, 'o nome', 120);
    if (novo || d.bloco !== undefined) campos.bloco = v.opcional(d.bloco, 'o bloco', 20) ?? '-';
    if (novo || d.unidade !== undefined) campos.unidade = v.texto(d.unidade, 'a unidade (apartamento)', 20);
    if (novo || d.telefone !== undefined) campos.telefone = v.telefoneOpcional(d.telefone);
    if (novo || d.email !== undefined) campos.email = v.emailOpcional(d.email);
    if (novo || d.documento !== undefined) {
      const doc = v.opcional(d.documento, 'o CPF', 14);
      if (doc) v.exigir(v.cpfValido(doc), 'CPF inválido.');
      campos.documento = doc ? v.digitos(doc) : null;
    }
    if (novo || d.limite !== undefined) campos.limite_centavos = v.centavosOpcional(d.limite, 'o limite');
    if (novo || d.fiado_liberado !== undefined) campos.fiado_liberado = d.fiado_liberado === undefined || d.fiado_liberado ? 1 : 0;
    if (novo || d.observacao !== undefined) campos.observacao = v.opcional(d.observacao, 'a observação', 400);
    if (d.ativo !== undefined) campos.ativo = d.ativo ? 1 : 0;
    return campos;
  };

  r.post('/', (req, res) => {
    const m = moradores.criar(db, dados(req.body, true));
    registrar(db, req, 'morador_criado', m.nome);
    res.status(201).json(m);
  });

  r.patch('/:id', (req, res) => res.json(moradores.atualizar(db, Number(req.params.id), dados(req.body, false))));

  /** Recebe do morador (dinheiro, PIX ou cartão) e quita as faturas mais antigas. */
  r.post('/:id/receber', (req, res) => {
    const m = moradores.receber(db, Number(req.params.id), {
      valor_centavos: v.centavos(req.body.valor, 'o valor', { min: 0.01 }),
      forma: v.opcao(req.body.forma ?? 'dinheiro', 'a forma', ['dinheiro', 'pix', 'debito', 'credito']),
      observacao: v.opcional(req.body.observacao, 'a observação', 200),
      usuario_id: req.usuario.id,
    });
    registrar(db, req, 'morador_pagamento', `#${req.params.id} ${req.body.valor}`);
    res.json(m);
  });

  /** Ajuste manual da conta (crédito ou débito), sempre com justificativa. */
  r.post('/:id/ajuste', gestao, (req, res) => {
    const valor = v.centavos(req.body.valor, 'o valor', { min: -100000, max: 100000 });
    const sinal = v.opcao(req.body.sinal ?? 'debito', 'o tipo', ['debito', 'credito']);
    moradores.lancar(db, {
      morador_id: Number(req.params.id), tipo: 'ajuste', descricao: v.texto(req.body.motivo, 'o motivo', 200),
      valor_centavos: sinal === 'credito' ? -Math.abs(valor) : Math.abs(valor), usuario_id: req.usuario.id,
    });
    registrar(db, req, 'morador_ajuste', `#${req.params.id} ${sinal} ${req.body.valor}`);
    res.json(moradores.obter(db, Number(req.params.id)));
  });

  /** Cria (ou atualiza) o acesso do morador ao portal. */
  r.post('/:id/acesso', gestao, (req, res) => {
    const id = Number(req.params.id);
    const m = moradores.obter(db, id);
    if (!m) throw naoEncontrado('Morador');
    const email = v.email(req.body.email);
    const senha = v.senha(req.body.senha);
    const existente = db.prepare('SELECT id FROM usuarios WHERE morador_id = ?').get(id);
    if (existente) {
      db.prepare('UPDATE usuarios SET email = ?, senha_hash = ?, ativo = 1 WHERE id = ?').run(email, hashSenha(senha), existente.id);
    } else {
      if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Já existe um acesso com este e-mail.', 409);
      db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, morador_id, criado_em) VALUES (?, ?, ?, 'morador', ?, ?)")
        .run(m.nome, email, hashSenha(senha), id, agora());
    }
    registrar(db, req, 'morador_acesso', `#${id} ${email}`);
    res.status(201).json({ ok: true, email });
  });

  return r;
};
