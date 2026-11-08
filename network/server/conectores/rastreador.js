'use strict';

/*
 * Adaptador do Rastreador de Veículos deste repositório (pasta rastreador/), pela API de integração documentada em
 * rastreador/README.md e implementada em rastreador/server/routes/integracao.js:
 *   GET <base>/api/integracao/veiculos                      (X-Api-Key: chave da empresa no rastreador)
 *   GET <base>/api/integracao/veiculos/:placa/posicoes?de=&ate=
 * O dispositivo é identificado pelo IMEI (estável); a placa serve para conciliar e para consultar o trajeto.
 */

const { agora, transacao } = require('../db');
const base = require('./base');

const TIPO = 'rastreador';
const INTERVALO_PADRAO_S = 60;

const urlBase = (cfg) => String(cfg.url_base ?? '').replace(/\/+$/, '');
const intervalo = (cfg) => Math.max(30, Number(cfg.intervalo_s) || INTERVALO_PADRAO_S);

function exigirConfigurado(x) {
  if (!x || !x.config.url_base) throw new base.ErroConector('Informe o endereço do rastreador.', 'nao_configurada', { permanente: true });
  const chave = base.segredoDe(x);
  if (!chave) throw new base.ErroConector('Informe a chave de API da empresa no rastreador.', 'nao_configurada', { permanente: true });
  return chave;
}

/** Grava a posição (deduplicada pela fonte, dispositivo e horário) e só avança a posição atual se ela for mais nova. */
function gravarPosicao(db, org, veiculoId, dispositivo, p) {
  const r = db.prepare(`INSERT OR IGNORE INTO posicoes (organizacao_id, veiculo_id, fonte, dispositivo_id, lat, lng, velocidade_kmh, ignicao, precisao_m, odometro_km, observado_em, recebido_em)
    VALUES (?, ?, 'rastreador', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(org, veiculoId, dispositivo, p.lat, p.lng, p.velocidade_kmh ?? null,
    p.ignicao === true ? 1 : p.ignicao === false ? 0 : null, p.precisao_m ?? null, p.odometro_km ?? null, p.observado_em, agora());
  if (!r.changes) return 'duplicada';
  const id = Number(r.lastInsertRowid);
  db.prepare(`INSERT INTO posicao_atual (veiculo_id, organizacao_id, posicao_id, observado_em, recebido_em) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (veiculo_id) DO UPDATE SET posicao_id = excluded.posicao_id, observado_em = excluded.observado_em, recebido_em = excluded.recebido_em
    WHERE excluded.observado_em > posicao_atual.observado_em`).run(veiculoId, org, id, p.observado_em, agora());
  return 'gravada';
}

const valido = (x) => Number.isFinite(x.lat) && Number.isFinite(x.lng) && Math.abs(x.lat) <= 90 && Math.abs(x.lng) <= 180 && !(x.lat === 0 && x.lng === 0);

/** Converte um item de GET /veiculos do rastreador no evento interno de posição (campos ausentes continuam nulos). */
function normalizarVeiculo(x) {
  return {
    dispositivo_id: x.imei ? String(x.imei) : null, placa: x.placa ? String(x.placa) : null, descricao: x.descricao ?? null,
    posicao: x.posicao_em && x.lat !== null && x.lat !== undefined ? {
      lat: Number(x.lat), lng: Number(x.lng), velocidade_kmh: typeof x.velocidade_kmh === 'number' ? x.velocidade_kmh : null,
      ignicao: typeof x.ignicao === 'boolean' ? x.ignicao : null, odometro_km: typeof x.hodometro_km === 'number' ? x.hodometro_km : null,
      observado_em: new Date(x.posicao_em).toISOString(),
    } : null,
    comunicacao_em: x.comunicacao_em ?? null,
  };
}

/** Uma coleta: lista a frota no rastreador, registra os dispositivos vistos e grava as posições dos vinculados. */
async function coletar(db, org) {
  const x = base.ler(db, org, TIPO);
  const inicio = Date.now();
  try {
    const chave = exigirConfigurado(x);
    const dados = await base.buscarJson(`${urlBase(x.config)}/api/integracao/veiculos`, { 'X-Api-Key': chave });
    if (!Array.isArray(dados)) throw new base.ErroConector('Formato inesperado da lista de veículos.');
    let gravadas = 0;
    let invalidas = 0;
    transacao(db, () => {
      for (const item of dados) {
        const n = normalizarVeiculo(item);
        if (!n.dispositivo_id) { invalidas++; continue; }
        db.prepare(`INSERT INTO dispositivos_externos (organizacao_id, fonte, dispositivo_id, placa, descricao, ultimo_visto) VALUES (?, 'rastreador', ?, ?, ?, ?)
          ON CONFLICT DO UPDATE SET placa = excluded.placa, descricao = excluded.descricao, ultimo_visto = excluded.ultimo_visto`).run(org, n.dispositivo_id, n.placa, n.descricao, agora());
        const lig = db.prepare("SELECT veiculo_id FROM dispositivos_vinculos WHERE organizacao_id = ? AND fonte = 'rastreador' AND dispositivo_id = ? AND fim IS NULL").get(org, n.dispositivo_id);
        if (!lig || !n.posicao) continue;
        if (!valido(n.posicao)) { invalidas++; continue; }
        if (gravarPosicao(db, org, lig.veiculo_id, n.dispositivo_id, n.posicao) === 'gravada') gravadas++;
      }
    });
    base.registrarResultado(db, org, TIPO, { inicio, itens: gravadas, parcial: invalidas ? `${invalidas} item(ns) sem identificador ou com posição inválida` : false, intervaloS: intervalo(x.config) });
    return { veiculos: dados.length, posicoes_novas: gravadas, invalidas };
  } catch (err) {
    base.registrarResultado(db, org, TIPO, { inicio, erro: err, intervaloS: intervalo(x?.config ?? {}) });
    throw err;
  }
}

/** Trajeto de um veículo vinculado no período (até 7 dias, limite da fonte). As posições recebidas também ficam gravadas. */
async function trajeto(db, org, veiculoId, de, ate) {
  const x = base.ler(db, org, TIPO);
  const chave = exigirConfigurado(x);
  const lig = db.prepare(`SELECT l.dispositivo_id, d.placa FROM dispositivos_vinculos l LEFT JOIN dispositivos_externos d ON d.organizacao_id = l.organizacao_id
    AND d.fonte = l.fonte AND d.dispositivo_id = l.dispositivo_id WHERE l.veiculo_id = ? AND l.fim IS NULL`).get(veiculoId);
  if (!lig?.placa) throw new base.ErroConector('Veículo sem dispositivo vinculado ou sem placa na fonte.', 'falha', { permanente: true });
  const q = new URLSearchParams({ de, ate });
  const pontos = await base.buscarJson(`${urlBase(x.config)}/api/integracao/veiculos/${encodeURIComponent(lig.placa)}/posicoes?${q}`, { 'X-Api-Key': chave });
  if (!Array.isArray(pontos)) throw new base.ErroConector('Formato inesperado das posições.');
  const lista = pontos.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), velocidade_kmh: typeof p.velocidade_kmh === 'number' ? p.velocidade_kmh : null,
    ignicao: p.ignicao === 1 || p.ignicao === true ? true : p.ignicao === 0 || p.ignicao === false ? false : null, observado_em: new Date(p.gps_em).toISOString() })).filter(valido);
  transacao(db, () => { for (const p of lista) gravarPosicao(db, org, veiculoId, lig.dispositivo_id, p); });
  return lista;
}

module.exports = { TIPO, coletar, trajeto, gravarPosicao, normalizarVeiculo, intervalo, INTERVALO_PADRAO_S };
