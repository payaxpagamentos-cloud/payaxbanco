'use strict';

const { Router } = require('express');
const zoe = require('./core');
const { permitir } = require('../auth');
const { registrar } = require('../lib/auditoria');
const { naoEncontrado } = require('../lib/erros');
const { inicioMes, intervalo, hoje } = require('../lib/datas');

/** Etapas da ligação, chamadas pela central telefônica (/api/integracao/zoe/...), com a chave da empresa. */
function rotasIntegracao(db) {
  const r = Router();
  r.post('/atendimentos', async (req, res) => {
    const x = await zoe.iniciar(db, req.empresa, req.body);
    res.status(x.repetida ? 200 : 201).json(x);
  });
  r.post('/atendimentos/:uid/documento', async (req, res) => res.json(await zoe.informarDocumento(db, req.empresa, req.params.uid, req.body)));
  r.post('/atendimentos/:uid/confirmar', async (req, res) => res.json(await zoe.confirmar(db, req.empresa, req.params.uid, req.body)));
  r.get('/atendimentos/:uid/faturas', async (req, res) => res.json(await zoe.faturas(db, req.empresa, req.params.uid)));
  r.post('/atendimentos/:uid/boleto', async (req, res) => res.json(await zoe.enviarBoleto(db, req.empresa, req.params.uid, req.body)));
  r.post('/atendimentos/:uid/desbloqueio', async (req, res) => res.json(await zoe.desbloquear(db, req.empresa, req.params.uid)));
  r.post('/atendimentos/:uid/transferir', async (req, res) => res.json(await zoe.transferir(db, req.empresa, req.params.uid, req.body)));
  r.post('/atendimentos/:uid/fim', (req, res) => res.json(zoe.encerrar(db, req.empresa, req.params.uid)));
  return r;
}

/** Tela ZOE do painel da empresa (/api/empresas/:eid/zoe). */
function rotasPainel(db) {
  const r = Router({ mergeParams: true });
  const administra = permitir('master', 'suporte', 'cliente');

  r.get('/', (req, res) => {
    const id = req.empresa.id;
    const [iniHoje] = intervalo(hoje(), hoje());
    const [iniMes] = intervalo(inicioMes(), hoje());
    const contar = (desde) => db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(resultado = 'resolvido'), 0) AS resolvidos, COALESCE(SUM(resultado = 'transferido'), 0) AS transferidos,
        COALESCE(SUM(resultado = 'em_curso'), 0) AS em_curso,
        COALESCE(SUM(motivo = 'financeiro'), 0) AS financeiro, COALESCE(SUM(motivo = 'suporte'), 0) AS suporte,
        COALESCE(SUM(motivo = 'comercial'), 0) AS comercial, COALESCE(SUM(motivo = 'outro' OR motivo IS NULL), 0) AS outro
      FROM zoe_atendimentos WHERE empresa_id = ? AND inicio >= ?`).get(id, desde);
    const acoesMes = Object.fromEntries(db.prepare(`SELECT tipo, COUNT(*) AS n FROM zoe_acoes WHERE empresa_id = ? AND sucesso = 1 AND criado_em >= ?
      AND tipo IN ('boleto','desbloqueio') GROUP BY tipo`).all(id, iniMes).map((x) => [x.tipo, x.n]));
    const ultimos = db.prepare(`SELECT a.id, a.uid, a.telefone, a.cliente_id, a.cliente_nome, a.etapa, a.motivo, a.resultado, a.inicio, a.fim, f.nome AS fila
      FROM zoe_atendimentos a LEFT JOIN filas f ON f.id = a.fila_id WHERE a.empresa_id = ? ORDER BY a.id DESC LIMIT 50`).all(id);
    res.json({
      config: zoe.configPublica(db, id),
      filas: db.prepare('SELECT id, nome FROM filas WHERE empresa_id = ? ORDER BY nome').all(id),
      hoje: contar(iniHoje),
      mes: { ...contar(iniMes), boletos: acoesMes.boleto ?? 0, desbloqueios: acoesMes.desbloqueio ?? 0 },
      ultimos,
    });
  });

  r.put('/', administra, (req, res) => {
    zoe.salvarConfig(db, req.empresa.id, req.body);
    registrar(db, req, 'zoe_configuracao', { campos: Object.keys(req.body).filter((k) => k !== 'ixc_token'), token_alterado: Boolean(req.body.ixc_token) });
    res.json(zoe.configPublica(db, req.empresa.id));
  });

  r.post('/testar', administra, async (req, res) => res.json(await zoe.testarIxc(db, req.empresa.id, req.body)));

  r.get('/atendimentos/:id', (req, res) => {
    const a = db.prepare(`SELECT a.*, f.nome AS fila FROM zoe_atendimentos a LEFT JOIN filas f ON f.id = a.fila_id
      WHERE a.id = ? AND a.empresa_id = ?`).get(Number(req.params.id), req.empresa.id);
    if (!a) throw naoEncontrado('Atendimento');
    const acoes = db.prepare('SELECT tipo, sucesso, detalhes, criado_em FROM zoe_acoes WHERE atendimento_id = ? ORDER BY id').all(a.id)
      .map((x) => ({ ...x, sucesso: Boolean(x.sucesso), detalhes: x.detalhes ? JSON.parse(x.detalhes) : null }));
    res.json({ ...a, acoes });
  });

  return r;
}

module.exports = { rotasIntegracao, rotasPainel };
