'use strict';

const { Router } = require('express');
const { permitir } = require('../auth');
const { transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const v = require('../lib/validacao');
const { registrar } = require('../lib/auditoria');
const { buscarConta, exigirContaOperavel, novoGrupo, lancar, exigirAlcada } = require('../lib/conta');

const fmt = (c) => `${c.agencia}/${c.numero}-${c.digito}`;

module.exports = (db) => {
  const r = Router();
  const operadores = permitir('admin', 'gerente', 'operador');

  function localizarDestino(body) {
    if (body.destino_conta_id) return buscarConta(db, body.destino_conta_id);
    const numero = String(body.destino_numero ?? '').replace(/[^\dXx]/g, '');
    const agencia = v.digitos(body.destino_agencia) || require('../config').agenciaPadrao;
    const semDigito = numero.length > 6 ? numero.slice(0, 6) : numero;
    const linha = db.prepare('SELECT id FROM contas WHERE agencia = ? AND numero = ?').get(agencia, semDigito);
    if (!linha) throw naoEncontrado('Conta de destino');
    return buscarConta(db, linha.id);
  }

  function transferir(req, origem, destino, valor, descricao, tipoSaida, tipoEntrada) {
    if (origem.id === destino.id) throw new ErroNegocio('Origem e destino devem ser contas diferentes.', 422);
    exigirContaOperavel(origem);
    exigirContaOperavel(destino);
    exigirAlcada(req, valor);
    return transacao(db, () => {
      const grupo = novoGrupo();
      const saida = lancar(db, { contaId: origem.id, tipo: tipoSaida, valor: -valor, descricao, contraparteId: destino.id, grupo, usuarioId: req.usuario.id });
      lancar(db, { contaId: destino.id, tipo: tipoEntrada, valor, descricao, contraparteId: origem.id, grupo, usuarioId: req.usuario.id });
      registrar(db, req, tipoSaida, 'conta', origem.id, { destino: fmt(destino), valor_centavos: valor, grupo });
      return { grupo, transacao_id: saida.id, saldo_origem_centavos: saida.saldo_apos_centavos };
    });
  }

  r.post('/deposito', operadores, (req, res) => {
    const conta = buscarConta(db, req.body?.conta_id);
    const valor = v.valorCentavos(req.body?.valor_centavos);
    exigirContaOperavel(conta);
    exigirAlcada(req, valor);
    const descricao = v.texto(req.body?.descricao, 140) || 'Depósito em espécie';
    const out = transacao(db, () => {
      const grupo = novoGrupo();
      const t = lancar(db, { contaId: conta.id, tipo: 'deposito', valor, descricao, grupo, usuarioId: req.usuario.id });
      registrar(db, req, 'deposito', 'conta', conta.id, { valor_centavos: valor });
      return { grupo, transacao_id: t.id, saldo_centavos: t.saldo_apos_centavos };
    });
    res.status(201).json(out);
  });

  r.post('/saque', operadores, (req, res) => {
    const conta = buscarConta(db, req.body?.conta_id);
    const valor = v.valorCentavos(req.body?.valor_centavos);
    exigirContaOperavel(conta);
    exigirAlcada(req, valor);
    const descricao = v.texto(req.body?.descricao, 140) || 'Saque em espécie';
    const out = transacao(db, () => {
      const grupo = novoGrupo();
      const t = lancar(db, { contaId: conta.id, tipo: 'saque', valor: -valor, descricao, grupo, usuarioId: req.usuario.id });
      registrar(db, req, 'saque', 'conta', conta.id, { valor_centavos: valor });
      return { grupo, transacao_id: t.id, saldo_centavos: t.saldo_apos_centavos };
    });
    res.status(201).json(out);
  });

  r.post('/transferencia', operadores, (req, res) => {
    const origem = buscarConta(db, req.body?.origem_conta_id);
    const destino = localizarDestino(req.body ?? {});
    const valor = v.valorCentavos(req.body?.valor_centavos);
    const descricao = v.texto(req.body?.descricao, 140) || `Transferência ${fmt(origem)} → ${fmt(destino)}`;
    res.status(201).json(transferir(req, origem, destino, valor, descricao, 'transferencia_enviada', 'transferencia_recebida'));
  });

  r.post('/pix', operadores, (req, res) => {
    const origem = buscarConta(db, req.body?.origem_conta_id);
    const chave = String(req.body?.chave ?? '').trim();
    v.exigir(chave, 'Informe a chave PIX de destino.');
    const registro = db.prepare('SELECT * FROM chaves_pix WHERE chave = ? OR chave = ?').get(chave, chave.toLowerCase())
      || (/^[\d.\-/()\s+]+$/.test(chave) ? db.prepare('SELECT * FROM chaves_pix WHERE chave = ?').get(v.digitos(chave)) : null);
    if (!registro) throw naoEncontrado('Chave PIX');
    const destino = buscarConta(db, registro.conta_id);
    const valor = v.valorCentavos(req.body?.valor_centavos);
    const descricao = v.texto(req.body?.descricao, 140) || `PIX para ${destino.cliente_nome}`;
    res.status(201).json({ ...transferir(req, origem, destino, valor, descricao, 'pix_enviado', 'pix_recebido'), destino: { nome: destino.cliente_nome, conta: fmt(destino) } });
  });

  r.post('/estorno', permitir('admin', 'gerente'), (req, res) => {
    const original = db.prepare('SELECT * FROM transacoes WHERE id = ?').get(req.body?.transacao_id);
    if (!original) throw naoEncontrado('Transação');
    const motivo = v.texto(req.body?.motivo, 200);
    v.exigir(motivo, 'Informe o motivo do estorno.');
    const grupoOriginal = db.prepare('SELECT * FROM transacoes WHERE grupo = ? ORDER BY id').all(original.grupo);
    if (grupoOriginal.some((t) => t.estornada_em)) throw new ErroNegocio('Esta transação já foi estornada.', 409);
    if (grupoOriginal.some((t) => t.tipo === 'estorno')) throw new ErroNegocio('Não é possível estornar um estorno.', 409);
    if (grupoOriginal.some((t) => t.tipo.startsWith('emprestimo'))) throw new ErroNegocio('Movimentos de empréstimo não podem ser estornados por aqui.', 409);
    const out = transacao(db, () => {
      const grupo = novoGrupo();
      for (const t of grupoOriginal) {
        lancar(db, { contaId: t.conta_id, tipo: 'estorno', valor: -t.valor_centavos, descricao: `Estorno #${t.id}: ${motivo}`, contraparteId: t.contraparte_conta_id, grupo, usuarioId: req.usuario.id, ignorarLimite: true });
      }
      db.prepare("UPDATE transacoes SET estornada_em = datetime('now') WHERE grupo = ?").run(original.grupo);
      registrar(db, req, 'estorno', 'transacao', original.id, { grupo_original: original.grupo, motivo });
      return { grupo, estornadas: grupoOriginal.length };
    });
    res.status(201).json(out);
  });

  return r;
};
