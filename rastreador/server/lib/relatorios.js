'use strict';

const { lerConfig } = require('../db');
const { distancia } = require('./geo');
const { situacao } = require('./posicoes');
const { hoje, somarDias, intervalo } = require('./datas');
const v = require('./validacao');

// Abaixo disso o veículo conta como parado (o GPS parado marca alguns km/h).
const LIMIAR_MOVIMENTO_KMH = 5;
// Viagens menores que isso são manobras ou oscilação do GPS.
const VIAGEM_MINIMA_M = 100;
const MAX_PONTOS = 50_000;

/** Período de..até (datas locais 'AAAA-MM-DD'), com o padrão de N dias até hoje e o máximo de dias. */
function periodo(q, { padraoDias = 0, maxDias = 366 } = {}) {
  const ate = q.ate ? v.data(q.ate, 'a data final') : hoje();
  const de = q.de ? v.data(q.de, 'a data inicial') : somarDias(ate, -padraoDias);
  v.exigir(de <= ate && de >= somarDias(ate, -(maxDias - 1)), `Período inválido (até ${maxDias} dias).`);
  return [de, ate];
}

function csv(colunas, linhas) {
  const esc = (x) => {
    const s = x === null || x === undefined ? '' : String(x);
    // Evita que o Excel interprete o conteúdo como fórmula.
    const seguro = /^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s;
    return /[;"\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
  };
  return `﻿${[colunas.map(([, t]) => t), ...linhas.map((l) => colunas.map(([k]) => (typeof k === 'function' ? k(l) : l[k])))].map((l) => l.map(esc).join(';')).join('\r\n')}\r\n`;
}

const km = (m) => ((m ?? 0) / 1000).toFixed(1).replace('.', ',');
const horas = (s) => `${Math.floor((s ?? 0) / 3600)}:${String(Math.floor(((s ?? 0) % 3600) / 60)).padStart(2, '0')}`;
const reais = (c) => ((c ?? 0) / 100).toFixed(2).replace('.', ',');

function enviarCsv(res, nome, conteudo) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nome}"` });
  res.send(conteudo);
}

/**
 * Viagens a partir das posições em ordem: começa quando o veículo anda e termina quando a ignição desliga
 * ou ele fica parado por `paradaMin` minutos. A viagem ainda aberta no fim das posições sai com em_andamento.
 */
function viagens(pontos, paradaMin) {
  const paradaMs = paradaMin * 60_000;
  const lista = [];
  let atual = null;
  let ultimoMov = null;
  let anterior = null;
  const fechar = (fim, distanciaM, emAndamento = false) => {
    const duracao = Math.max(0, (Date.parse(fim.gps_em) - Date.parse(atual.inicio.gps_em)) / 1000);
    if (distanciaM >= VIAGEM_MINIMA_M) {
      lista.push({
        inicio: atual.inicio.gps_em, fim: fim.gps_em, duracao_s: Math.round(duracao), distancia_m: Math.round(distanciaM),
        velocidade_max_kmh: Math.round(atual.max), velocidade_media_kmh: duracao > 0 ? Math.round((distanciaM / duracao) * 3.6) : 0,
        origem: { lat: atual.inicio.lat, lng: atual.inicio.lng }, destino: { lat: fim.lat, lng: fim.lng }, em_andamento: emAndamento,
      });
    }
    atual = null;
  };
  for (const p of pontos) {
    const movendo = p.velocidade_kmh >= LIMIAR_MOVIMENTO_KMH && p.ignicao !== 0;
    if (atual) {
      atual.distancia += distancia(anterior, p);
      atual.max = Math.max(atual.max, p.velocidade_kmh);
      if (movendo) {
        ultimoMov = p;
        atual.distanciaMov = atual.distancia;
      } else if (p.ignicao === 0) {
        fechar(p, atual.distancia);
      } else if (Date.parse(p.gps_em) - Date.parse(ultimoMov.gps_em) >= paradaMs) {
        fechar(ultimoMov, atual.distanciaMov);
      }
    } else if (movendo) {
      // A viagem começa na última posição parada (a saída), quando houver.
      const inicio = anterior ?? p;
      const d = anterior ? distancia(anterior, p) : 0;
      atual = { inicio, distancia: d, distanciaMov: d, max: p.velocidade_kmh };
      ultimoMov = p;
    }
    anterior = p;
  }
  if (atual) fechar(ultimoMov, atual.distanciaMov, true);
  return lista;
}

/** Paradas entre as viagens (e depois da última), de pelo menos `paradaMin` minutos. */
function paradas(lista, pontos, paradaMin) {
  const r = [];
  const add = (inicio, fim, local) => {
    const s = (Date.parse(fim) - Date.parse(inicio)) / 1000;
    if (s >= paradaMin * 60) r.push({ inicio, fim, duracao_s: Math.round(s), lat: local.lat, lng: local.lng });
  };
  lista.forEach((x, i) => {
    if (i + 1 < lista.length) add(x.fim, lista[i + 1].inicio, x.destino);
    else if (!x.em_andamento && pontos.length) add(x.fim, pontos.at(-1).gps_em, x.destino);
  });
  return r;
}

/** Posições do veículo no intervalo [ini, fim) em ISO, com as viagens, as paradas e os alertas. */
function percurso(db, veiculo, ini, fim) {
  const cfg = lerConfig(db);
  const pontos = db.prepare(`SELECT lat, lng, velocidade_kmh, curso, ignicao, evento, gps_em FROM posicoes
    WHERE veiculo_id = ? AND gps_em >= ? AND gps_em < ? ORDER BY gps_em LIMIT ${MAX_PONTOS}`).all(veiculo.id, ini, fim);
  const lista = viagens(pontos, cfg.parada_min);
  return {
    pontos,
    limitado: pontos.length === MAX_PONTOS,
    viagens: lista,
    paradas: paradas(lista, pontos, cfg.parada_min),
    alertas: db.prepare('SELECT id, tipo, mensagem, lat, lng, ocorrido_em FROM alertas WHERE veiculo_id = ? AND ocorrido_em >= ? AND ocorrido_em < ? ORDER BY ocorrido_em')
      .all(veiculo.id, ini, fim),
    distancia_m: Math.round(lista.reduce((s, x) => s + x.distancia_m, 0)),
    velocidade_max_kmh: Math.round(pontos.reduce((m, p) => Math.max(m, p.velocidade_kmh), 0)),
  };
}

/** Resumo de cada veículo da empresa no período: km, tempo ligado, velocidade máxima, excessos e alertas. */
function resumo(db, empresaId, de, ate) {
  const [ini, fim] = intervalo(de, ate);
  return db.prepare(`SELECT v.id, v.placa, v.descricao, m.nome AS motorista,
      COALESCE(SUM(u.distancia_m),0) AS distancia_m, COALESCE(SUM(u.ligado_s),0) AS ligado_s, COALESCE(MAX(u.velocidade_max_kmh),0) AS velocidade_max_kmh,
      COUNT(CASE WHEN u.distancia_m > 0 THEN 1 END) AS dias_uso,
      (SELECT COUNT(*) FROM alertas a WHERE a.veiculo_id = v.id AND a.tipo = 'velocidade' AND a.ocorrido_em >= ? AND a.ocorrido_em < ?) AS excessos,
      (SELECT COUNT(*) FROM alertas a WHERE a.veiculo_id = v.id AND a.ocorrido_em >= ? AND a.ocorrido_em < ?) AS alertas
    FROM veiculos v LEFT JOIN motoristas m ON m.id = v.motorista_id
    LEFT JOIN uso_diario u ON u.veiculo_id = v.id AND u.data >= ? AND u.data <= ?
    WHERE v.empresa_id = ? GROUP BY v.id ORDER BY distancia_m DESC, v.placa`).all(ini, fim, ini, fim, de, ate, empresaId);
}

/** Veículos para o mapa (com a situação: movimento, ligado, parado, sem sinal, sem posição). `onde` filtra pela empresa ou não. */
function veiculosMapa(db, empresaId = null) {
  const cfg = lerConfig(db);
  const agoraMs = Date.now();
  return db.prepare(`SELECT v.id, v.empresa_id, e.nome AS empresa, v.placa, v.descricao, v.tipo, v.lat, v.lng, v.velocidade_kmh, v.curso, v.ignicao, v.tensao,
      v.bloqueado, v.posicao_em, v.comunicacao_em, v.limite_velocidade_kmh, v.hodometro_m, m.nome AS motorista, m.telefone AS motorista_telefone,
      r.imei, r.protocolo, (SELECT COUNT(*) FROM alertas a WHERE a.veiculo_id = v.id AND a.tratado_em IS NULL) AS alertas_pendentes
    FROM veiculos v JOIN empresas e ON e.id = v.empresa_id LEFT JOIN motoristas m ON m.id = v.motorista_id LEFT JOIN rastreadores r ON r.id = v.rastreador_id
    WHERE v.ativo = 1 AND e.status <> 'excluida' ${empresaId ? 'AND v.empresa_id = ?' : ''} ORDER BY v.placa`)
    .all(...(empresaId ? [empresaId] : []))
    .map((x) => ({ ...x, situacao: x.imei ? situacao(x, cfg.online_min, agoraMs) : 'sem_rastreador' }));
}

/** Situação de um plano de manutenção: em dia, próxima (faltando 10% do intervalo ou 15 dias) ou vencida. */
function situacaoManutencao(m, kmAtual, dataHoje = hoje()) {
  const proxKm = m.intervalo_km ? m.ultima_km + m.intervalo_km : null;
  const proxData = m.intervalo_dias ? somarDias(m.ultima_data, m.intervalo_dias) : null;
  const vencida = (proxKm !== null && kmAtual >= proxKm) || (proxData !== null && dataHoje >= proxData);
  const proxima = !vencida && ((proxKm !== null && kmAtual >= proxKm - m.intervalo_km * 0.1) || (proxData !== null && dataHoje >= somarDias(proxData, -15)));
  return { proxima_km: proxKm, proxima_data: proxData, faltam_km: proxKm === null ? null : proxKm - kmAtual, situacao: vencida ? 'vencida' : proxima ? 'proxima' : 'em_dia' };
}

/** Planos de manutenção da empresa (ou de um veículo) com a situação calculada pelo hodômetro atual. */
function manutencoes(db, empresaId, veiculoId = null) {
  return db.prepare(`SELECT m.*, v.placa, v.descricao AS veiculo, v.hodometro_m FROM manutencoes m JOIN veiculos v ON v.id = m.veiculo_id
    WHERE m.empresa_id = ? ${veiculoId ? 'AND m.veiculo_id = ?' : ''} ORDER BY v.placa, m.descricao`).all(...(veiculoId ? [empresaId, veiculoId] : [empresaId]))
    .map((m) => {
      const kmAtual = Math.floor(m.hodometro_m / 1000);
      return { ...m, km_atual: kmAtual, ...situacaoManutencao(m, kmAtual) };
    });
}

module.exports = { periodo, csv, km, horas, reais, enviarCsv, viagens, paradas, percurso, resumo, veiculosMapa, situacaoManutencao, manutencoes, MAX_PONTOS };
