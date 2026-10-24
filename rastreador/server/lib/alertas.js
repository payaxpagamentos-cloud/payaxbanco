'use strict';

const { agora } = require('../db');

// Rótulos dos tipos de alerta (telas, relatórios e API).
const TIPOS = {
  velocidade: 'Excesso de velocidade',
  cerca_entrada: 'Entrada na cerca',
  cerca_saida: 'Saída da cerca',
  ignicao_ligada: 'Ignição ligada',
  ignicao_desligada: 'Ignição desligada',
  fora_horario: 'Uso fora do horário',
  panico: 'Botão de pânico',
  bateria_desconectada: 'Bateria desconectada',
  bateria_baixa: 'Bateria baixa',
  sem_comunicacao: 'Sem comunicação',
  violacao: 'Violação do equipamento',
};

/** Registra um alerta do veículo, na posição informada (ou na última conhecida). */
function alertar(db, veiculo, tipo, mensagem, pos = {}) {
  const r = db.prepare(`INSERT INTO alertas (empresa_id, veiculo_id, tipo, mensagem, lat, lng, velocidade_kmh, ocorrido_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(veiculo.empresa_id, veiculo.id, tipo, mensagem, pos.lat ?? veiculo.lat ?? null, pos.lng ?? veiculo.lng ?? null,
    pos.velocidade_kmh ?? null, pos.gps_em ?? agora());
  return Number(r.lastInsertRowid);
}

module.exports = { TIPOS, alertar };
