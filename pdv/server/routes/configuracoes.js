'use strict';

const { Router } = require('express');
const { configPublica, salvarConfig, clienteIxc } = require('../lib/ixcEmpresa');
const { permitir } = require('../auth');
const { registrar } = require('../lib/auditoria');
const { ErroNegocio } = require('../lib/erros');

const ADMINISTRA = ['master', 'suporte', 'admin'];

/** Configurações da empresa (/api/empresas/:eid/configuracoes): IXC, regras de cobrança e comprovante. */
module.exports = (db) => {
  const r = Router({ mergeParams: true });

  r.get('/', (req, res) => res.json(configPublica(db, req.empresa.id)));

  r.patch('/', permitir(...ADMINISTRA), (req, res) => {
    const c = salvarConfig(db, req.empresa.id, req.body);
    registrar(db, req, 'config_alterada', { campos: Object.keys(req.body ?? {}).filter((k) => k !== 'ixc_token') });
    res.json(c);
  });

  // Confere endereço e token do IXC antes de ligar a integração.
  r.post('/ixc/testar', permitir(...ADMINISTRA), async (req, res) => {
    const { ixc } = clienteIxc(db, req.empresa.id, { exigirAtivo: false });
    try {
      await ixc.testar();
    } catch (err) {
      throw new ErroNegocio(`Não foi possível falar com o IXC: ${err.message}`, 502);
    }
    registrar(db, req, 'ixc_testado', undefined);
    res.json({ ok: true, mensagem: 'Conexão com o IXC funcionando.' });
  });

  r.get('/auditoria', permitir(...ADMINISTRA, 'supervisor'), (req, res) => {
    const itens = db.prepare(`SELECT a.*, u.nome AS usuario_nome FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.empresa_id = ? ORDER BY a.id DESC LIMIT ?`).all(req.empresa.id, Math.min(300, Number(req.query.limite) || 100));
    res.json({ itens: itens.map((x) => ({ ...x, detalhes: x.detalhes ? JSON.parse(x.detalhes) : null })) });
  });

  return r;
};
