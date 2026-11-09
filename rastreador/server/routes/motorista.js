'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const { Router } = require('express');
const { agora } = require('../db');
const { emitirTokenMotorista, autenticarMotorista } = require('../auth');
const { verificarSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const agenda = require('../lib/agenda');
const v = require('../lib/validacao');
const condutores = require('../lib/condutores');
const diario = require('../lib/diario');
const push = require('../lib/push');
const desempenho = require('../lib/desempenho');
const { hoje, somarDias } = require('../lib/datas');

/**
 * App do motorista: entrar com CPF e senha numérica, assumir o veículo pelo QR code, pedir a liberação fora do horário (código
 * para o gestor), SOS, checklist de saída, abastecimento, avaria, a própria nota e os avisos no celular.
 */
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

  const resumoVeiculo = (x, m) => {
    const ag = db.prepare('SELECT dias, inicio, fim, ativo FROM bloqueio_agendas WHERE veiculo_id = ?').get(x.id);
    const lib = db.prepare("SELECT libera_ate FROM liberacoes WHERE veiculo_id = ? AND status = 'ativa' AND libera_ate > ?").get(x.id, agora());
    const pedido = db.prepare("SELECT expira_em, horas_pedidas FROM liberacoes WHERE veiculo_id = ? AND motorista_id = ? AND status = 'aguardando' AND expira_em > ?").get(x.id, m.id, agora());
    return {
      id: x.id, placa: x.placa, descricao: x.descricao, tipo: x.tipo, bloqueado: x.bloqueado, assumido_em: x.assumido_em ?? null, hodometro_km: Math.floor((x.hodometro_m ?? 0) / 1000),
      agenda: ag && ag.ativo ? { ...ag, em_horario: Boolean(agenda.janela(ag)) } : null, liberado_ate: lib?.libera_ate ?? null, pedido_aberto: pedido ?? null,
    };
  };

  r.get('/eu', autenticado, (req, res) => {
    const m = req.motorista;
    const veiculos = condutores.veiculosDo(db, m).map((x) => resumoVeiculo(x, m));
    const pedidos = db.prepare(`SELECT l.status, l.horas_pedidas, l.horas, l.criado_em, l.libera_ate, v.placa, u.nome AS aplicada_por
      FROM liberacoes l JOIN veiculos v ON v.id = l.veiculo_id LEFT JOIN usuarios u ON u.id = l.aplicada_por WHERE l.motorista_id = ? ORDER BY l.id DESC LIMIT 20`).all(m.id);
    res.json({
      motorista: { nome: m.nome, empresa: m.empresa_nome }, veiculos, pedidos, checklist_itens: diario.ITENS_CHECKLIST,
      avisos: { chave: push.chavePublica(db), inscrito: push.inscrito(db, m.id) },
    });
  });

  r.post('/liberacoes', autenticado, (req, res) => {
    const x = condutores.doMotorista(db, req.motorista, req.body.veiculo_id);
    res.status(201).json(agenda.pedirLiberacao(db, req.motorista, x, req.body.horas));
  });

  // ---------- QR code do veículo: assumir e devolver ----------
  r.get('/qr/:codigo', autenticado, (req, res) => {
    const x = condutores.veiculoPorCodigo(db, req.motorista.empresa_id, req.params.codigo);
    const c = condutores.atual(db, x.id);
    res.json({ id: x.id, placa: x.placa, descricao: x.descricao, com_voce: c?.motorista_id === req.motorista.id, com: c && c.motorista_id !== req.motorista.id ? c.nome : null });
  });
  r.post('/assumir', autenticado, (req, res) => {
    const x = condutores.veiculoPorCodigo(db, req.motorista.empresa_id, req.body.codigo);
    condutores.assumir(db, req.motorista, x);
    res.status(201).json({ placa: x.placa });
  });
  r.post('/devolver', autenticado, (req, res) => {
    condutores.devolver(db, req.motorista);
    res.status(204).end();
  });

  // ---------- SOS: alerta de pânico com a localização do celular ----------
  r.post('/sos', autenticado, (req, res) => {
    res.status(201).json(diario.sos(db, req.motorista, req.body));
  });

  // ---------- Checklist de saída, abastecimento e avaria ----------
  r.post('/checklists', autenticado, (req, res) => {
    const x = condutores.doMotorista(db, req.motorista, req.body.veiculo_id);
    res.status(201).json(diario.checklist(db, req.motorista, x, req.body));
  });
  r.post('/abastecimentos', autenticado, (req, res) => {
    const x = condutores.doMotorista(db, req.motorista, req.body.veiculo_id);
    res.status(201).json(diario.abastecimento(db, req.motorista, x, req.body));
  });
  r.post('/avarias', autenticado, (req, res) => {
    const x = condutores.doMotorista(db, req.motorista, req.body.veiculo_id);
    res.status(201).json(diario.avaria(db, req.motorista, x, req.body));
  });
  r.get('/historico', autenticado, (req, res) => res.json(diario.historicoMotorista(db, req.motorista)));

  // ---------- Minha nota (com as dicas do que mais pesou) ----------
  r.get('/nota', autenticado, (req, res) => {
    const m = req.motorista;
    const hojeL = hoje();
    const semana = somarDias(hojeL, -((new Date(`${hojeL}T12:00:00Z`).getUTCDay() + 6) % 7));
    const de = req.query.periodo === 'mes' ? `${hojeL.slice(0, 7)}-01` : semana;
    const d = desempenho.calcular(db, m.empresa_id, de, hojeL);
    const i = d.ranking.findIndex((x) => x.motorista_id === m.id);
    const eu = i >= 0 ? d.ranking[i] : null;
    const mostrarRanking = Boolean(db.prepare('SELECT app_ranking FROM empresas WHERE id = ?').get(m.empresa_id)?.app_ranking);
    res.json({
      de, ate: hojeL, periodo: req.query.periodo === 'mes' ? 'mes' : 'semana',
      nota: eu?.nota ?? null, descontos: eu?.descontos ?? null, km: eu?.km ?? 0, excessos: eu?.excessos ?? 0, fora_horario: eu?.fora_horario ?? 0,
      ocioso_s: eu?.ocioso_s ?? 0, bruscos: eu?.bruscos ?? 0, dicas: eu ? desempenho.dicas(eu) : [],
      ocorrencias: (eu?.ocorrencias ?? []).map((o) => ({ tipo: o.tipo, mensagem: o.mensagem, em: o.ocorrido_em, placa: o.placa })),
      posicao: mostrarRanking && eu ? { lugar: i + 1, de: d.ranking.length } : null,
    });
  });

  // ---------- Avisos no celular ----------
  r.post('/avisos', autenticado, (req, res) => {
    if (!push.inscrever(db, req.motorista.id, req.body)) throw new ErroNegocio('Não foi possível ativar os avisos neste aparelho.', 422);
    res.status(201).json({ ok: true });
  });
  r.delete('/avisos', autenticado, (req, res) => {
    push.cancelar(db, req.motorista.id, req.body?.endpoint);
    res.status(204).end();
  });

  return r;
};
