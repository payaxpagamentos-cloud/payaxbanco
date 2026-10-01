'use strict';

const { Router } = require('express');
const { permitir } = require('../auth');
const { transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const v = require('../lib/validacao');
const { registrar } = require('../lib/auditoria');
const { buscarConta, exigirContaOperavel, novoGrupo, lancar, exigirAlcada } = require('../lib/conta');
const { fmt, localizarConta, transferir, enviarPix } = require('../lib/movimentos');

module.exports = (db, bradesco) => {
  const r = Router();
  const operadores = permitir('admin', 'gerente', 'operador');

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
    const destino = localizarConta(db, { contaId: req.body?.destino_conta_id, agencia: req.body?.destino_agencia, numero: req.body?.destino_numero });
    const valor = v.valorCentavos(req.body?.valor_centavos);
    const descricao = v.texto(req.body?.descricao, 140) || `Transferência ${fmt(origem)} → ${fmt(destino)}`;
    res.status(201).json(transferir(db, req, origem, destino, valor, descricao, 'transferencia_enviada', 'transferencia_recebida'));
  });

  r.post('/pix', operadores, async (req, res) => {
    const origem = buscarConta(db, req.body?.origem_conta_id);
    const valor = v.valorCentavos(req.body?.valor_centavos);
    res.status(201).json(await enviarPix(db, bradesco, req, origem, req.body?.chave, valor, v.texto(req.body?.descricao, 140)));
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
    if (grupoOriginal.some((t) => (t.tipo.startsWith('pix_') && !t.contraparte_conta_id) || t.tipo === 'pagamento')) {
      throw new ErroNegocio('Operação com outro banco já liquidada no Bradesco: não pode ser estornada aqui.', 409);
    }
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
