'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { emitirTokenMotorista, autenticarMotorista } = require('../auth');
const { verificarSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const agenda = require('../lib/agenda');
const v = require('../lib/validacao');

/** App do motorista: entrar com CPF e senha numérica, ver o veículo e pedir a liberação fora do horário (código para o gestor). */
module.exports = (db) => {
  const r = Router();
  const autenticado = autenticarMotorista(db);

  r.post('/login', (req, res) => {
    const cpf = v.digitos(req.body.cpf);
    const senha = String(req.body.senha ?? '');
    const lista = cpf ? db.prepare(`SELECT m.*, e.status AS empresa_status FROM motoristas m JOIN empresas e ON e.id = m.empresa_id
      WHERE m.cpf = ? AND m.ativo = 1 AND m.senha_hash IS NOT NULL`).all(cpf) : [];
    const m = lista.find((x) => x.empresa_status === 'ativa' && verificarSenha(senha, x.senha_hash));
    if (!m) throw new ErroNegocio('CPF ou senha incorretos. Peça ao gestor para conferir seu acesso.', 401);
    db.prepare('UPDATE motoristas SET app_ultimo_acesso = ? WHERE id = ?').run(agora(), m.id);
    res.json({ token: emitirTokenMotorista(m), motorista: { nome: m.nome } });
  });

  r.get('/eu', autenticado, (req, res) => {
    const m = req.motorista;
    const veiculos = db.prepare('SELECT id, placa, descricao, tipo, bloqueado FROM veiculos WHERE motorista_id = ? AND ativo = 1 ORDER BY placa').all(m.id).map((x) => {
      const ag = db.prepare('SELECT dias, inicio, fim, ativo FROM bloqueio_agendas WHERE veiculo_id = ?').get(x.id);
      const lib = db.prepare("SELECT libera_ate FROM liberacoes WHERE veiculo_id = ? AND status = 'ativa' AND libera_ate > ?").get(x.id, agora());
      const pedido = db.prepare("SELECT expira_em, horas_pedidas FROM liberacoes WHERE veiculo_id = ? AND motorista_id = ? AND status = 'aguardando' AND expira_em > ?").get(x.id, m.id, agora());
      return { ...x, agenda: ag && ag.ativo ? { ...ag, em_horario: Boolean(agenda.janela(ag)) } : null, liberado_ate: lib?.libera_ate ?? null, pedido_aberto: pedido ?? null };
    });
    const pedidos = db.prepare(`SELECT l.status, l.horas_pedidas, l.horas, l.criado_em, l.libera_ate, v.placa, u.nome AS aplicada_por
      FROM liberacoes l JOIN veiculos v ON v.id = l.veiculo_id LEFT JOIN usuarios u ON u.id = l.aplicada_por WHERE l.motorista_id = ? ORDER BY l.id DESC LIMIT 20`).all(m.id);
    res.json({ motorista: { nome: m.nome, empresa: m.empresa_nome }, veiculos, pedidos });
  });

  r.post('/liberacoes', autenticado, (req, res) => {
    const x = db.prepare('SELECT * FROM veiculos WHERE id = ? AND ativo = 1').get(Number(req.body.veiculo_id));
    if (!x || x.motorista_id !== req.motorista.id) throw new ErroNegocio('Veículo não encontrado.', 404);
    res.status(201).json(agenda.pedirLiberacao(db, req.motorista, x, req.body.horas));
  });

  return r;
};
