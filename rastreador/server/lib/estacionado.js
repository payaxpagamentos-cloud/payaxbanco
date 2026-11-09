'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const { agora, lerConfig, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const { distancia } = require('./geo');
const { alertar } = require('./alertas');
const { local } = require('./datas');
const com = require('./comandos');

/**
 * Modo Estacionado (âncora): guarda o ponto e dispara "estacionado violado" se o veículo sair do raio ou ligar a ignição.
 * No J16, o próprio aparelho também vigia (alarme de deslocamento MOVING), mesmo dormindo.
 */
const exigir = (c, msg) => { if (!c) throw new ErroNegocio(msg, 422); };
const ehGt06 = (db, veiculo) => veiculo.rastreador_id && db.prepare('SELECT protocolo FROM rastreadores WHERE id = ?').get(veiculo.rastreador_id)?.protocolo === 'gt06';

function armar(db, veiculo, { raio_m: raio, usuarioId = null, automatico = false } = {}) {
  exigir(veiculo.rastreador_id, 'O veículo não tem rastreador instalado.');
  exigir(veiculo.lat !== null && veiculo.lat !== undefined, 'O veículo ainda não mandou a primeira posição.');
  exigir(!db.prepare('SELECT 1 FROM estacionamentos WHERE veiculo_id = ? AND desarmado_em IS NULL').get(veiculo.id), 'O veículo já está estacionado (vigiando).');
  const r = Math.max(30, Math.min(2000, Number(raio) || lerConfig(db).estacionado_raio_m || 100));
  return transacao(db, () => {
    const id = Number(db.prepare(`INSERT INTO estacionamentos (empresa_id, veiculo_id, lat, lng, raio_m, armado_em, armado_por, automatico)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(veiculo.empresa_id, veiculo.id, veiculo.lat, veiculo.lng, r, agora(), usuarioId, automatico ? 1 : 0).lastInsertRowid);
    if (ehGt06(db, veiculo)) {
      com.criar(db, veiculo, { tipo: 'personalizado', texto: `MOVING,ON,${Math.max(100, Math.min(1000, r))},0#`, rotulo: 'Estacionado: alarme de deslocamento do aparelho' }, usuarioId);
    }
    return id;
  });
}

function desarmar(db, veiculo, usuarioId = null) {
  const e = db.prepare('SELECT * FROM estacionamentos WHERE veiculo_id = ? AND desarmado_em IS NULL').get(veiculo.id);
  if (!e) return false;
  transacao(db, () => {
    db.prepare('UPDATE estacionamentos SET desarmado_em = ?, desarmado_por = ? WHERE id = ?').run(agora(), usuarioId, e.id);
    if (ehGt06(db, veiculo)) com.criar(db, veiculo, { tipo: 'personalizado', texto: 'MOVING,OFF#', rotulo: 'Estacionado desarmado: alarme de deslocamento desligado' }, usuarioId);
  });
  return true;
}

/** Violação: avisa uma vez (com o atalho para o Modo Roubo) e continua armado até alguém desarmar. */
function violar(db, e, veiculo, motivo) {
  db.prepare('UPDATE estacionamentos SET violado_em = ?, motivo_violacao = ? WHERE id = ?').run(agora(), motivo, e.id);
  alertar(db, veiculo, 'estacionado_violado', `${veiculo.placa} estacionado: ${motivo}. Se não foi você, acione o Modo Roubo.`,
    { lat: veiculo.lat, lng: veiculo.lng, velocidade_kmh: veiculo.velocidade_kmh });
}

/** A cada mensagem do rastreador (com o veículo já atualizado). `evento`: alarme do aparelho (ex.: deslocamento). */
function aoReceber(db, veiculoId, { ignicaoAntes = null, evento = null } = {}) {
  const v = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(veiculoId);
  const e = db.prepare('SELECT * FROM estacionamentos WHERE veiculo_id = ? AND desarmado_em IS NULL').get(veiculoId);
  if (e && !e.violado_em) {
    const d = v.lat !== null ? distancia({ lat: e.lat, lng: e.lng }, { lat: v.lat, lng: v.lng }) : 0;
    if (v.ignicao === 1 && ignicaoAntes !== 1) violar(db, e, v, 'a ignição foi ligada');
    else if (d > e.raio_m) violar(db, e, v, `saiu ${Math.round(d)} m do ponto onde ficou`);
    else if (evento === 'deslocamento') violar(db, e, v, 'o aparelho detectou deslocamento');
    return;
  }
  // Estacionar sozinho à noite (22h às 6h) ao desligar a ignição, se o veículo pedir.
  if (!e && v.estacionado_auto && ignicaoAntes === 1 && v.ignicao === 0) {
    const h = local().hora;
    if (h >= 22 || h < 6) {
      try { armar(db, v, { automatico: true }); } catch { /* sem posição: tenta na próxima */ }
    }
  }
}

function listar(db, empresaId) {
  return db.prepare(`SELECT e.*, v.placa, v.descricao, v.lat AS v_lat, v.lng AS v_lng, v.ignicao, v.comunicacao_em, u.nome AS armado_por_nome
    FROM estacionamentos e JOIN veiculos v ON v.id = e.veiculo_id LEFT JOIN usuarios u ON u.id = e.armado_por
    WHERE e.empresa_id = ? AND (e.desarmado_em IS NULL OR e.desarmado_em >= ?) ORDER BY e.desarmado_em IS NOT NULL, e.armado_em DESC LIMIT 100`)
    .all(empresaId, new Date(Date.now() - 7 * 86_400_000).toISOString());
}

module.exports = { armar, desarmar, aoReceber, listar };
