'use strict';

/* Movimentações entre contas PAY AX, usadas pela agência (Banqueiro) e pelo Internet Banking. */
const config = require('../config');
const { transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');
const { registrar } = require('./auditoria');
const { buscarConta, exigirContaOperavel, novoGrupo, lancar, exigirAlcada } = require('./conta');

const fmt = (c) => `${c.agencia}/${c.numero}-${c.digito}`;
const canalDe = (req) => (req.cliente ? 'internet_banking' : 'agencia');

function localizarConta(db, { contaId, agencia, numero }) {
  if (contaId) return buscarConta(db, contaId);
  const n = String(numero ?? '').replace(/[^\dXx]/g, '');
  const ag = v.digitos(agencia) || config.agenciaPadrao;
  const linha = db.prepare('SELECT id FROM contas WHERE agencia = ? AND numero = ?').get(ag, n.length > 6 ? n.slice(0, 6) : n);
  if (!linha) throw naoEncontrado('Conta de destino');
  return buscarConta(db, linha.id);
}

/** Procura a chave no diretório PIX interno da PAY AX. */
function buscarChaveInterna(db, chave) {
  const c = String(chave ?? '').trim();
  return db.prepare('SELECT * FROM chaves_pix WHERE chave = ? OR chave = ?').get(c, c.toLowerCase())
    || (/^[\d.\-/()\s+]+$/.test(c) ? db.prepare('SELECT * FROM chaves_pix WHERE chave = ?').get(v.digitos(c)) : null);
}

function transferir(db, req, origem, destino, valor, descricao, tipoSaida, tipoEntrada) {
  if (origem.id === destino.id) throw new ErroNegocio('Origem e destino devem ser contas diferentes.', 422);
  exigirContaOperavel(origem);
  exigirContaOperavel(destino);
  exigirAlcada(req, valor);
  const canal = canalDe(req);
  return transacao(db, () => {
    const grupo = novoGrupo();
    const base = { grupo, usuarioId: req.usuario?.id ?? null, canal, descricao };
    const saida = lancar(db, { ...base, contaId: origem.id, tipo: tipoSaida, valor: -valor, contraparteId: destino.id });
    lancar(db, { ...base, contaId: destino.id, tipo: tipoEntrada, valor, contraparteId: origem.id });
    registrar(db, req, tipoSaida, 'conta', origem.id, { destino: fmt(destino), valor_centavos: valor, grupo });
    return { grupo, transacao_id: saida.id, saldo_origem_centavos: saida.saldo_apos_centavos };
  });
}

/** PIX: chave PAY AX liquida internamente; chave de outro banco sai pelo Bradesco. */
async function enviarPix(db, bradesco, req, origem, chave, valor, descricao) {
  v.exigir(String(chave ?? '').trim(), 'Informe a chave PIX de destino.');
  const registro = buscarChaveInterna(db, chave);
  if (!registro) return bradesco.enviarPixExterno(req, origem, chave, valor, descricao);
  const destino = buscarConta(db, registro.conta_id);
  const r = transferir(db, req, origem, destino, valor, descricao || `PIX para ${destino.cliente_nome}`, 'pix_enviado', 'pix_recebido');
  return { ...r, destino: { nome: destino.cliente_nome, conta: fmt(destino) } };
}

module.exports = { fmt, canalDe, localizarConta, buscarChaveInterna, transferir, enviarPix };
