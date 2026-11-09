'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const crypto = require('node:crypto');
const { agora, lerConfig, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const { local, somarDias } = require('./datas');
const roubo = require('./roubo');
const com = require('./comandos');
const notif = require('./notificacoes');
const zap = require('./whatsapp');
const push = require('./push');
const condutores = require('./condutores');

/**
 * Bloqueio programado (ex.: 23:00 às 06:00) e liberações por código.
 * No início do horário, o corte usa o bloqueio inteligente (ocorrência do tipo "agenda"); no fim, o veículo é desbloqueado.
 * Fora do horário, o motorista gera um código no app; o gestor aplica e o veículo fica liberado por N horas, depois volta.
 */
const exigir = (c, msg) => { if (!c) throw new ErroNegocio(msg, 422); };
const hhmm = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const horaCurta = (iso) => { const l = local(iso); return `${String(l.hora).padStart(2, '0')}:${String(l.minuto).padStart(2, '0')}`; };
const hashCodigo = (empresaId, codigo) => crypto.createHash('sha256').update(`${empresaId}:${String(codigo).replace(/\D/g, '')}`).digest('hex');

/** A janela de bloqueio em que `instante` está (com a chave do dia em que ela começou), ou null. Pode virar a noite. */
function janela(agenda, instante = new Date()) {
  const l = local(instante);
  const m = l.hora * 60 + l.minuto;
  const a = hhmm(agenda.inicio);
  const b = hhmm(agenda.fim);
  const dia = (data) => new Date(`${data}T12:00:00Z`).getUTCDay();
  if (a < b) return agenda.dias.includes(String(l.diaSemana)) && m >= a && m < b ? `${l.data} ${agenda.inicio}` : null;
  if (m >= a) return agenda.dias.includes(String(l.diaSemana)) ? `${l.data} ${agenda.inicio}` : null;
  if (m < b) { const ontem = somarDias(l.data, -1); return agenda.dias.includes(String(dia(ontem))) ? `${ontem} ${agenda.inicio}` : null; }
  return null;
}

const liberacaoAtiva = (db, veiculoId) => db.prepare("SELECT * FROM liberacoes WHERE veiculo_id = ? AND status = 'ativa' AND libera_ate > ?").get(veiculoId, agora());

function salvarAgenda(db, veiculo, d) {
  const hora = (x, nome) => { exigir(typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x), `Informe ${nome} (HH:MM).`); return x; };
  const inicio = hora(d.inicio, 'o início');
  const fim = hora(d.fim, 'o fim');
  exigir(inicio !== fim, 'O início e o fim não podem ser iguais.');
  const dias = String(d.dias ?? '').replace(/[^0-6]/g, '');
  exigir(dias.length, 'Escolha pelo menos um dia.');
  exigir(veiculo.rastreador_id, 'O veículo não tem rastreador instalado.');
  db.prepare(`INSERT INTO bloqueio_agendas (empresa_id, veiculo_id, dias, inicio, fim, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (veiculo_id) DO UPDATE SET dias = excluded.dias, inicio = excluded.inicio, fim = excluded.fim, ativo = excluded.ativo, janela_bloqueada = NULL`)
    .run(veiculo.empresa_id, veiculo.id, [...new Set(dias)].sort().join(''), inicio, fim, d.ativo === false ? 0 : 1, agora());
}

function removerAgenda(db, veiculo) {
  transacao(db, () => {
    db.prepare('DELETE FROM bloqueio_agendas WHERE veiculo_id = ?').run(veiculo.id);
    const oc = db.prepare("SELECT * FROM ocorrencias WHERE veiculo_id = ? AND tipo = 'agenda' AND status <> 'encerrada'").get(veiculo.id);
    if (oc) roubo.encerrar(db, oc, { desbloquear: oc.status !== 'aguardando', texto: 'Bloqueio programado removido: veículo liberado.' }, null);
  });
}

/** Motorista: gera o código (6 dígitos) para o gestor liberar o veículo. Cancela o pedido anterior do mesmo veículo. */
function pedirLiberacao(db, motorista, veiculo, horas) {
  exigir(condutores.veiculosDo(db, motorista).some((x) => x.id === veiculo.id), 'Este veículo não está com você.');
  const h = Math.max(1, Math.min(12, Number(horas) || 1));
  const cfg = lerConfig(db);
  const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const expira = new Date(Date.now() + (cfg.liberacao_codigo_min || 10) * 60_000).toISOString();
  transacao(db, () => {
    db.prepare("UPDATE liberacoes SET status = 'cancelada', encerrada_em = ? WHERE veiculo_id = ? AND status = 'aguardando'").run(agora(), veiculo.id);
    db.prepare(`INSERT INTO liberacoes (empresa_id, veiculo_id, motorista_id, codigo_hash, horas_pedidas, criado_em, expira_em) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(veiculo.empresa_id, veiculo.id, motorista.id, hashCodigo(veiculo.empresa_id, codigo), h, agora(), expira);
  });
  return { codigo, expira_em: expira, horas: h };
}

/** Gestor: confere o código (sem aplicar) e mostra quem pediu. */
function consultarCodigo(db, empresaId, codigo) {
  const l = db.prepare(`SELECT l.*, v.placa, v.descricao, m.nome AS motorista FROM liberacoes l JOIN veiculos v ON v.id = l.veiculo_id
    LEFT JOIN motoristas m ON m.id = l.motorista_id WHERE l.empresa_id = ? AND l.codigo_hash = ? AND l.status = 'aguardando'`).get(empresaId, hashCodigo(empresaId, codigo));
  exigir(l, 'Código não encontrado. Confira os 6 números com o motorista.');
  exigir(l.expira_em > agora(), 'Este código expirou. Peça ao motorista para gerar outro no app.');
  return l;
}

/** Gestor: aplica o código e libera por N horas (desbloqueio na hora; o bloqueio inteligente volta no fim). */
function aplicarCodigo(db, empresaId, codigo, horas, usuarioId) {
  const l = consultarCodigo(db, empresaId, codigo);
  const h = Math.max(1, Math.min(12, Number(horas) || l.horas_pedidas));
  const veiculo = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(l.veiculo_id);
  const oc = db.prepare("SELECT * FROM ocorrencias WHERE veiculo_id = ? AND status <> 'encerrada'").get(veiculo.id);
  exigir(!oc || oc.tipo !== 'roubo', 'Este veículo está em Modo Roubo: encerre a ocorrência antes de liberar.');
  const ate = new Date(Date.now() + h * 3_600_000).toISOString();
  transacao(db, () => {
    db.prepare("UPDATE liberacoes SET status = 'ativa', aplicada_em = ?, aplicada_por = ?, horas = ?, libera_ate = ? WHERE id = ?").run(agora(), usuarioId, h, ate, l.id);
    if (oc) roubo.encerrar(db, oc, { desbloquear: true, texto: `Liberado por código por ${h} h.` }, usuarioId);
    else if (veiculo.bloqueado) com.criar(db, veiculo, { tipo: 'desbloquear' }, usuarioId);
    db.prepare('UPDATE estacionamentos SET desarmado_em = ?, desarmado_por = ? WHERE veiculo_id = ? AND desarmado_em IS NULL').run(agora(), usuarioId, veiculo.id);
    notif.avisar(db, empresaId, 'liberacao', { titulo: `Liberação aplicada · ${veiculo.placa}`, texto: `${l.motorista ?? 'Motorista'} liberado por ${h} h, até ${horaCurta(ate)}.`,
      caminho: `/empresa/${empresaId}/liberacoes` });
  });
  push.avisar(db, l.motorista_id, { titulo: `Liberado · ${veiculo.placa}`, texto: `O gestor liberou o veículo por ${h} h, até ${horaCurta(ate)}.` });
  return { veiculo: veiculo.placa, horas: h, libera_ate: ate, motorista: l.motorista };
}

function encerrarLiberacao(db, liberacao, usuarioId = null) {
  db.prepare("UPDATE liberacoes SET status = 'encerrada', encerrada_em = ? WHERE id = ? AND status = 'ativa'").run(agora(), liberacao.id);
  // Ainda no horário de bloqueio: o corte volta na próxima volta da tarefa.
  db.prepare('UPDATE bloqueio_agendas SET janela_bloqueada = NULL WHERE veiculo_id = ?').run(liberacao.veiculo_id);
}


/** Tarefa de cada minuto: começo e fim dos horários, fim das liberações (com aviso antes) e códigos vencidos. */
function verificar(db) {
  const cfg = lerConfig(db);
  const agoraIso = agora();
  db.prepare("UPDATE liberacoes SET status = 'expirada', encerrada_em = ? WHERE status = 'aguardando' AND expira_em <= ?").run(agoraIso, agoraIso);
  // Aviso antes de a liberação acabar (para o gestor e para o motorista).
  const avisoMs = (cfg.liberacao_aviso_min || 15) * 60_000;
  for (const l of db.prepare(`SELECT l.*, v.placa, m.telefone AS motorista_telefone, m.nome AS motorista FROM liberacoes l JOIN veiculos v ON v.id = l.veiculo_id
    LEFT JOIN motoristas m ON m.id = l.motorista_id WHERE l.status = 'ativa' AND l.aviso_enviado = 0 AND l.libera_ate <= ?`).all(new Date(Date.now() + avisoMs).toISOString())) {
    db.prepare('UPDATE liberacoes SET aviso_enviado = 1 WHERE id = ?').run(l.id);
    const texto = `A liberação do ${l.placa} termina às ${horaCurta(l.libera_ate)}. Depois disso o veículo volta a ser bloqueado (só com ele parado ou devagar).`;
    notif.avisar(db, l.empresa_id, 'liberacao', { titulo: `Liberação acabando · ${l.placa}`, texto, caminho: `/empresa/${l.empresa_id}/liberacoes` });
    if (l.motorista_telefone) zap.enfileirar(db, { empresaId: l.empresa_id, numero: l.motorista_telefone, texto: `*Rastreador*\n${texto}`, origem: 'liberacao' });
    push.avisar(db, l.motorista_id, { titulo: `Liberação acabando · ${l.placa}`, texto });
  }
  for (const l of db.prepare(`SELECT l.*, v.placa FROM liberacoes l JOIN veiculos v ON v.id = l.veiculo_id WHERE l.status = 'ativa' AND l.libera_ate <= ?`).all(agoraIso)) {
    transacao(db, () => encerrarLiberacao(db, l));
    push.avisar(db, l.motorista_id, { titulo: `Liberação encerrada · ${l.placa}`, texto: 'O prazo acabou. O veículo volta a ser bloqueado assim que estiver parado ou devagar.' });
  }
  // Aviso no celular 15 minutos antes de o bloqueio programado começar (para quem está com o veículo).
  const daqui15 = new Date(Date.now() + 15 * 60_000);
  for (const a of db.prepare(`SELECT a.*, v.placa, v.motorista_id FROM bloqueio_agendas a JOIN veiculos v ON v.id = a.veiculo_id JOIN empresas e ON e.id = a.empresa_id
    WHERE a.ativo = 1 AND v.ativo = 1 AND e.status = 'ativa'`).all()) {
    const proxima = janela(a, daqui15);
    if (!proxima || janela(a) || liberacaoAtiva(db, a.veiculo_id)) continue;
    const motoristaId = condutores.atual(db, a.veiculo_id)?.motorista_id ?? a.motorista_id;
    if (motoristaId && push.umaVez(db, `bloqueio:${a.id}:${proxima}`)) {
      push.avisar(db, motoristaId, { titulo: `Bloqueio às ${a.inicio} · ${a.placa}`, texto: `O bloqueio programado começa às ${a.inicio}. Precisa usar depois? Peça a liberação no app.` });
    }
  }

  for (const a of db.prepare(`SELECT a.*, v.rastreador_id FROM bloqueio_agendas a JOIN veiculos v ON v.id = a.veiculo_id JOIN empresas e ON e.id = a.empresa_id
    WHERE a.ativo = 1 AND v.ativo = 1 AND e.status = 'ativa'`).all()) {
    const chave = janela(a);
    const aberta = db.prepare("SELECT * FROM ocorrencias WHERE veiculo_id = ? AND status <> 'encerrada'").get(a.veiculo_id);
    transacao(db, () => {
      if (chave) {
        if (a.janela_bloqueada === chave || aberta || liberacaoAtiva(db, a.veiculo_id)) return;
        const v = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(a.veiculo_id);
        db.prepare('UPDATE bloqueio_agendas SET janela_bloqueada = ? WHERE id = ?').run(chave, a.id);
        if (v.bloqueado) return;
        try { roubo.abrirInterno(db, v, { tipo: 'agenda' }); } catch { /* sem rastreador que receba comando: ignora */ }
      } else if (aberta && aberta.tipo === 'agenda') {
        roubo.encerrar(db, aberta, { desbloquear: aberta.status !== 'aguardando', texto: 'Fim do horário de bloqueio programado: veículo liberado.' }, null);
      }
    });
  }
}

function listar(db, empresaId) {
  const agendas = db.prepare(`SELECT a.*, v.placa, v.descricao, v.bloqueado, m.nome AS motorista,
      (SELECT o.status FROM ocorrencias o WHERE o.veiculo_id = a.veiculo_id AND o.status <> 'encerrada') AS ocorrencia
    FROM bloqueio_agendas a JOIN veiculos v ON v.id = a.veiculo_id LEFT JOIN motoristas m ON m.id = v.motorista_id WHERE a.empresa_id = ? ORDER BY v.placa`).all(empresaId)
    .map((a) => ({ ...a, em_horario: Boolean(janela(a)), liberacao: liberacaoAtiva(db, a.veiculo_id)?.libera_ate ?? null }));
  const liberacoes = db.prepare(`SELECT l.id, l.veiculo_id, l.status, l.horas_pedidas, l.horas, l.criado_em, l.expira_em, l.aplicada_em, l.libera_ate, l.encerrada_em,
      v.placa, m.nome AS motorista, u.nome AS aplicada_por_nome
    FROM liberacoes l JOIN veiculos v ON v.id = l.veiculo_id LEFT JOIN motoristas m ON m.id = l.motorista_id LEFT JOIN usuarios u ON u.id = l.aplicada_por
    WHERE l.empresa_id = ? AND l.criado_em >= ? ORDER BY l.id DESC LIMIT 100`).all(empresaId, new Date(Date.now() - 30 * 86_400_000).toISOString());
  return { agendas, liberacoes };
}

module.exports = { janela, salvarAgenda, removerAgenda, pedirLiberacao, consultarCodigo, aplicarCodigo, encerrarLiberacao, verificar, listar, hashCodigo };
