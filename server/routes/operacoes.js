'use strict';

const { Router } = require('express');
const { permitir } = require('../auth');
const { transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const v = require('../lib/validacao');
const { registrar } = require('../lib/auditoria');
const { novoGrupo, lancar } = require('../lib/conta');

module.exports = (db) => {
  const r = Router();

  // Depósitos, saques, transferências e PIX não são feitos pela equipe: só o cliente autoriza
  // movimentações, pelo Internet Banking. A equipe mantém apenas o estorno (correção de lançamentos).

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
