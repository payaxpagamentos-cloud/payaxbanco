'use strict';

const { agora, lerConfig, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const com = require('./comandos');

/**
 * Módulo de roubo com bloqueio inteligente: o cliente aciona o modo roubo e o sistema só manda o corte quando o veículo estiver
 * abaixo da velocidade segura (parâmetro `bloqueio_velocidade_segura_kmh`, padrão 20 km/h), para não cortar o motor em movimento.
 *
 * Situações da ocorrência: aguardando (esperando a velocidade segura) → bloqueio_enviado (corte enviado ao equipamento) →
 * bloqueado (o equipamento confirmou) → encerrada. Cada passo vira um evento na linha do tempo.
 */
// Posição mais velha que isso não serve para decidir: espera a próxima (com a ignição desligada, o veículo está parado).
const POSICAO_RECENTE_MS = 3 * 60_000;
// Enquanto espera, registra a velocidade na linha do tempo no máximo uma vez por minuto.
const AVISO_MS = 60_000;

const kmh = (x) => `${Math.round(Number(x) || 0)} km/h`;

function evento(db, ocorrenciaId, texto, pos = {}) {
  db.prepare('INSERT INTO ocorrencia_eventos (ocorrencia_id, em, texto, lat, lng, velocidade_kmh) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ocorrenciaId, agora(), texto, pos.lat ?? null, pos.lng ?? null, pos.velocidade_kmh ?? null);
}

const limiteSeguro = (db) => lerConfig(db).bloqueio_velocidade_segura_kmh || 20;

/** Manda o corte (o comando de bloqueio do modelo do rastreador) e passa a ocorrência para "bloqueio_enviado". */
function enviarCorte(db, oc, veiculo, motivo, pos) {
  const comandoId = com.criar(db, veiculo, { tipo: 'bloquear', confirmacao: veiculo.placa }, oc.criada_por);
  db.prepare("UPDATE ocorrencias SET status = 'bloqueio_enviado', comando_id = ? WHERE id = ?").run(comandoId, oc.id);
  evento(db, oc.id, motivo, pos);
  return comandoId;
}

/**
 * Decide se dá para cortar agora: com uma posição recente abaixo da velocidade segura, ou com a ignição desligada
 * (parado). Senão, continua esperando.
 */
function seguroAgora(v, limite) {
  const recente = v.posicao_em && Date.now() - Date.parse(v.posicao_em) <= POSICAO_RECENTE_MS;
  if (recente && (v.velocidade_kmh ?? 0) < limite) return `Velocidade de ${kmh(v.velocidade_kmh)}, abaixo de ${kmh(limite)}: corte enviado.`;
  if (v.ignicao === 0) return 'Ignição desligada (veículo parado): corte enviado.';
  return null;
}

/** Aciona o modo roubo no veículo. Exige a placa digitada, como o bloqueio comum. */
function abrir(db, veiculo, d, usuarioId) {
  v_exigir(veiculo.rastreador_id, 'O veículo não tem rastreador instalado.');
  const r = db.prepare('SELECT protocolo FROM rastreadores WHERE id = ?').get(veiculo.rastreador_id);
  v_exigir(r && r.protocolo !== 'osmand', 'Este rastreador (aplicativo no celular) não recebe o comando de bloqueio.');
  const digitada = String(d.confirmacao ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (digitada !== veiculo.placa) throw new ErroNegocio('Para acionar o modo roubo, digite a placa do veículo para confirmar.', 422);
  v_exigir(!db.prepare("SELECT 1 FROM ocorrencias WHERE veiculo_id = ? AND status <> 'encerrada'").get(veiculo.id), 'Este veículo já está em modo roubo.');
  const limite = limiteSeguro(db);
  return transacao(db, () => {
    const id = Number(db.prepare(`INSERT INTO ocorrencias (empresa_id, veiculo_id, status, observacao, criada_por, criada_em)
      VALUES (?, ?, 'aguardando', ?, ?, ?)`).run(veiculo.empresa_id, veiculo.id, d.observacao ? String(d.observacao).slice(0, 500) : null, usuarioId ?? null, agora()).lastInsertRowid);
    const pos = { lat: veiculo.lat, lng: veiculo.lng, velocidade_kmh: veiculo.velocidade_kmh };
    evento(db, id, 'Modo roubo acionado.', pos);
    const oc = db.prepare('SELECT * FROM ocorrencias WHERE id = ?').get(id);
    if (veiculo.bloqueado) {
      db.prepare("UPDATE ocorrencias SET status = 'bloqueado' WHERE id = ?").run(id);
      evento(db, id, 'O veículo já estava bloqueado.', pos);
      return id;
    }
    const motivo = seguroAgora(veiculo, limite);
    if (motivo) enviarCorte(db, oc, veiculo, motivo, pos);
    else evento(db, id, `Bloqueio inteligente: aguardando a velocidade baixar de ${kmh(limite)} (agora ${kmh(veiculo.velocidade_kmh)}).`, pos);
    return id;
  });
}

function v_exigir(cond, msg) {
  if (!cond) throw new ErroNegocio(msg, 422);
}

/**
 * Chamado a cada mensagem do rastreador (dentro da transação da posição), com o veículo já atualizado: se há ocorrência
 * esperando e o veículo ficou seguro, manda o corte.
 */
function aoReceber(db, veiculoId) {
  const oc = db.prepare("SELECT * FROM ocorrencias WHERE veiculo_id = ? AND status = 'aguardando'").get(veiculoId);
  if (!oc) return;
  const veiculo = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(veiculoId);
  const pos = { lat: veiculo.lat, lng: veiculo.lng, velocidade_kmh: veiculo.velocidade_kmh };
  const limite = limiteSeguro(db);
  const motivo = seguroAgora(veiculo, limite);
  if (motivo) {
    enviarCorte(db, oc, veiculo, motivo, pos);
  } else if (!oc.aviso_em || Date.now() - Date.parse(oc.aviso_em) >= AVISO_MS) {
    db.prepare('UPDATE ocorrencias SET aviso_em = ? WHERE id = ?').run(agora(), oc.id);
    evento(db, oc.id, `Veículo a ${kmh(veiculo.velocidade_kmh)}: aguardando ficar abaixo de ${kmh(limite)} para cortar.`, pos);
  }
}

/** Resposta do equipamento ao corte: confirmado → bloqueado; recusado → volta a esperar e tenta de novo na próxima posição segura. */
function aoResponder(db, comando, sucesso, resposta) {
  if (comando.tipo !== 'bloquear') return;
  const oc = db.prepare("SELECT * FROM ocorrencias WHERE comando_id = ? AND status = 'bloqueio_enviado'").get(comando.id);
  if (!oc) return;
  if (sucesso) {
    db.prepare("UPDATE ocorrencias SET status = 'bloqueado' WHERE id = ?").run(oc.id);
    evento(db, oc.id, `O rastreador confirmou o bloqueio${resposta ? `: ${String(resposta).slice(0, 120)}` : '.'}`);
  } else {
    db.prepare("UPDATE ocorrencias SET status = 'aguardando', comando_id = NULL WHERE id = ?").run(oc.id);
    evento(db, oc.id, `O rastreador recusou o corte${resposta ? ` (${String(resposta).slice(0, 120)})` : ''}: tentando de novo na próxima posição segura.`);
  }
}

/** Corte imediato, sem esperar a velocidade (o cliente assume o risco; exige a placa digitada). */
function forcar(db, oc, d) {
  const veiculo = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(oc.veiculo_id);
  const digitada = String(d.confirmacao ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (digitada !== veiculo.placa) throw new ErroNegocio('Para forçar o corte, digite a placa do veículo para confirmar.', 422);
  v_exigir(oc.status === 'aguardando', 'O corte já foi enviado.');
  return transacao(db, () => enviarCorte(db, oc, veiculo, `Corte forçado pelo usuário com o veículo a ${kmh(veiculo.velocidade_kmh)}.`,
    { lat: veiculo.lat, lng: veiculo.lng, velocidade_kmh: veiculo.velocidade_kmh }));
}

/** Encerra a ocorrência; com `desbloquear`, manda o desbloqueio (o veículo volta a funcionar). */
function encerrar(db, oc, d, usuarioId) {
  v_exigir(oc.status !== 'encerrada', 'A ocorrência já foi encerrada.');
  return transacao(db, () => {
    const veiculo = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(oc.veiculo_id);
    if (oc.status === 'aguardando' || oc.status === 'bloqueio_enviado') {
      // Um corte ainda não entregue não sai mais.
      db.prepare("UPDATE comandos SET status = 'cancelado', respondido_em = ? WHERE veiculo_id = ? AND tipo = 'bloquear' AND status = 'pendente'").run(agora(), veiculo.id);
    }
    if (d.desbloquear && veiculo.rastreador_id) com.criar(db, veiculo, { tipo: 'desbloquear' }, usuarioId);
    db.prepare("UPDATE ocorrencias SET status = 'encerrada', encerrada_por = ?, encerrada_em = ? WHERE id = ?").run(usuarioId ?? null, agora(), oc.id);
    evento(db, oc.id, d.desbloquear ? 'Ocorrência encerrada e desbloqueio enviado.' : 'Ocorrência encerrada (o veículo continua como está).');
  });
}

/** Ocorrências da empresa: as em andamento (com o veículo e a linha do tempo) e as últimas encerradas. */
function listar(db, empresaId) {
  const lista = db.prepare(`SELECT o.*, v.placa, v.descricao, v.lat, v.lng, v.velocidade_kmh, v.ignicao, v.bloqueado, v.posicao_em, v.comunicacao_em,
      u.nome AS criada_por_nome, ue.nome AS encerrada_por_nome, c.status AS comando_status
    FROM ocorrencias o JOIN veiculos v ON v.id = o.veiculo_id LEFT JOIN usuarios u ON u.id = o.criada_por LEFT JOIN usuarios ue ON ue.id = o.encerrada_por
    LEFT JOIN comandos c ON c.id = o.comando_id
    WHERE o.empresa_id = ? AND (o.status <> 'encerrada' OR o.encerrada_em >= ?) ORDER BY o.status = 'encerrada', o.criada_em DESC LIMIT 100`)
    .all(empresaId, new Date(Date.now() - 90 * 24 * 3_600_000).toISOString());
  const eventos = db.prepare('SELECT em, texto, lat, lng, velocidade_kmh FROM ocorrencia_eventos WHERE ocorrencia_id = ? ORDER BY id DESC LIMIT 50');
  return lista.map((o) => ({ ...o, eventos: o.status === 'encerrada' ? [] : eventos.all(o.id) }));
}

module.exports = { abrir, aoReceber, aoResponder, forcar, encerrar, listar, limiteSeguro };
