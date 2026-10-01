'use strict';

/*
 * Favorecidos do cliente: destinos frequentes de PIX ou de transferência entre contas PAY AX.
 * Cadastrados pela equipe (administrador, gerente ou operador) e usados pelo cliente no Internet Banking.
 * Cadastrar um favorecido não movimenta dinheiro: cada envio continua exigindo a senha de transação do cliente.
 */
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');
const { registrar } = require('./auditoria');
const { buscarChaveInterna, localizarConta, fmt } = require('./movimentos');
const { normalizarChaveExterna } = require('../integracoes/bradesco');

const LIMITE = 50;

function listar(db, clienteId) {
  return db.prepare(`SELECT f.*, c.agencia, c.numero, c.digito FROM favorecidos f LEFT JOIN contas c ON c.id = f.conta_id
    WHERE f.cliente_id = ? ORDER BY COALESCE(f.apelido, f.nome) COLLATE NOCASE`).all(clienteId)
    .map((f) => ({ ...f, conta: f.conta_id ? fmt(f) : null }));
}

function criar(db, req, clienteId, dados) {
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM favorecidos WHERE cliente_id = ?').get(clienteId);
  if (total >= LIMITE) throw new ErroNegocio(`Limite de ${LIMITE} favorecidos atingido.`, 409);
  const apelido = v.texto(dados?.apelido, 60);
  let registro;
  if (dados?.tipo === 'pix') {
    const chaveDigitada = String(dados.chave ?? '').trim();
    v.exigir(chaveDigitada, 'Informe a chave PIX do favorecido.');
    const interna = buscarChaveInterna(db, chaveDigitada);
    if (interna) {
      const c = db.prepare('SELECT cl.nome, cl.documento FROM contas ct JOIN clientes cl ON cl.id = ct.cliente_id WHERE ct.id = ?').get(interna.conta_id);
      registro = { tipo: 'pix', chave: interna.chave, nome: c.nome, documento: c.documento };
    } else {
      const chave = normalizarChaveExterna(chaveDigitada);
      if (!chave) throw new ErroNegocio('Chave PIX inválida. Use CPF/CNPJ, e-mail, celular ou chave aleatória.', 422);
      registro = { tipo: 'pix', chave, nome: v.texto(dados.nome, 120), documento: null };
    }
    if (db.prepare('SELECT 1 FROM favorecidos WHERE cliente_id = ? AND chave = ?').get(clienteId, registro.chave)) {
      throw new ErroNegocio('Esta chave já está entre os favorecidos do cliente.', 409);
    }
  } else if (dados?.tipo === 'conta') {
    const conta = localizarConta(db, { agencia: dados.agencia, numero: dados.numero });
    if (conta.status === 'encerrada') throw new ErroNegocio('Conta de destino encerrada.', 409);
    if (db.prepare('SELECT 1 FROM favorecidos WHERE cliente_id = ? AND conta_id = ?').get(clienteId, conta.id)) {
      throw new ErroNegocio('Esta conta já está entre os favorecidos do cliente.', 409);
    }
    registro = { tipo: 'conta', conta_id: conta.id, nome: conta.cliente_nome, documento: conta.cliente_documento };
  } else {
    throw new ErroNegocio('Tipo de favorecido inválido (pix ou conta).', 422);
  }
  const r = db.prepare(`INSERT INTO favorecidos (cliente_id, tipo, apelido, nome, documento, chave, conta_id, usuario_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(clienteId, registro.tipo, apelido, registro.nome ?? null, registro.documento ?? null,
    registro.chave ?? null, registro.conta_id ?? null, req.usuario?.id ?? null);
  const id = Number(r.lastInsertRowid);
  registrar(db, req, 'cadastrar_favorecido', 'cliente', clienteId, { favorecido_id: id, tipo: registro.tipo, nome: registro.nome, chave: registro.chave });
  return listar(db, clienteId).find((f) => f.id === id);
}

function excluir(db, req, clienteId, id) {
  const f = db.prepare('SELECT * FROM favorecidos WHERE id = ? AND cliente_id = ?').get(id, clienteId);
  if (!f) throw naoEncontrado('Favorecido');
  db.prepare('DELETE FROM favorecidos WHERE id = ?').run(f.id);
  registrar(db, req, 'excluir_favorecido', 'cliente', clienteId, { favorecido_id: f.id, nome: f.nome, chave: f.chave });
}

module.exports = { listar, criar, excluir };
