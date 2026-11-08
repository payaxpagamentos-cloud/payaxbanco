'use strict';

const { agora, lerConfig, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const { digitos } = require('./validacao');

/**
 * Tipo do destino para a tarifação: ramal (até 6 dígitos), internacional (00…), móvel (9 dígitos começando com 9) ou fixo.
 * Aceita o número com 55, com 0 + DDD ou com 0 + operadora + DDD.
 */
function classificar(destino) {
  let d = digitos(destino);
  if (d.length <= 6) return 'interno';
  if (d.startsWith('00')) return 'internacional';
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  else if (d.startsWith('0')) d = d.length >= 13 ? d.slice(3) : d.slice(1);
  const assinante = d.length >= 10 ? d.slice(2) : d;
  return assinante.length === 9 && assinante[0] === '9' ? 'movel' : 'fixo';
}

/** Segundos cobrados: no mínimo a cadência inicial e depois em blocos (ex.: 30/6). */
function tarifar(duracaoS, inicial, cadencia) {
  if (duracaoS <= 0) return 0;
  if (duracaoS <= inicial) return inicial;
  return inicial + Math.ceil((duracaoS - inicial) / cadencia) * cadencia;
}

const TARIFA = { fixo: 'tarifa_fixo_centavos', movel: 'tarifa_movel_centavos', internacional: 'tarifa_internacional_centavos' };
const custo = (empresa, tipo, tarifadoS) => (TARIFA[tipo] ? Math.round((tarifadoS * empresa[TARIFA[tipo]]) / 60) : 0);

const emCurso = (db, empresaId) => db.prepare('SELECT COUNT(*) AS n FROM chamadas WHERE empresa_id = ? AND fim IS NULL').get(empresaId).n;
const discoUsado = (db, empresaId) => db.prepare('SELECT COALESCE(SUM(gravacao_bytes),0) AS b FROM chamadas WHERE empresa_id = ?').get(empresaId).b;

/** Instante informado pela central telefônica (ISO) ou agora. */
function instante(v, nome) {
  if (v === undefined || v === null || v === '') return agora();
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new ErroNegocio(`Data/hora inválida em ${nome}.`, 422);
  return new Date(t).toISOString();
}

/**
 * Início de uma chamada. Recusa empresa bloqueada e chamada acima do limite de simultâneas.
 * Responde também se a chamada deve ser gravada (gravação ligada na empresa e no ramal, com espaço em disco).
 */
function iniciar(db, empresa, d) {
  if (empresa.status !== 'ativa') throw new ErroNegocio('Empresa bloqueada.', 403);
  const uid = String(d.uid ?? '').trim();
  if (!uid || uid.length > 120) throw new ErroNegocio('Informe o uid da chamada (até 120 caracteres).', 422);
  const direcao = ['entrada', 'saida', 'interna'].includes(d.direcao) ? d.direcao : null;
  if (!direcao) throw new ErroNegocio('Direção inválida (entrada, saida ou interna).', 422);
  const origem = String(d.origem ?? '').trim().slice(0, 40);
  const destino = String(d.destino ?? '').trim().slice(0, 40);
  if (!origem || !destino) throw new ErroNegocio('Informe a origem e o destino.', 422);

  return transacao(db, () => {
    const existente = db.prepare('SELECT * FROM chamadas WHERE empresa_id = ? AND uid = ?').get(empresa.id, uid);
    if (existente) return { id: existente.id, gravar: false, repetida: true };
    if (emCurso(db, empresa.id) >= empresa.limite_canais) throw new ErroNegocio('Limite de chamadas simultâneas da empresa atingido.', 429);

    // O ramal envolvido: quem liga (saída/interna) ou quem atende (entrada).
    const numeroRamal = String(d.ramal ?? (direcao === 'entrada' ? destino : origem));
    const ramal = db.prepare('SELECT * FROM ramais WHERE empresa_id = ? AND numero = ?').get(empresa.id, numeroRamal);
    const did = direcao === 'entrada' ? db.prepare('SELECT id FROM numeros WHERE empresa_id = ? AND numero = ?').get(empresa.id, digitos(d.numero ?? destino)) : null;
    let campanhaId = null, contatoId = null;
    if (d.campanha_contato_id) {
      const cc = db.prepare(`SELECT cc.id, cc.campanha_id FROM campanha_contatos cc JOIN campanhas c ON c.id = cc.campanha_id
        WHERE cc.id = ? AND c.empresa_id = ?`).get(Number(d.campanha_contato_id), empresa.id);
      if (!cc) throw new ErroNegocio('Contato de campanha não encontrado.', 422);
      [campanhaId, contatoId] = [cc.campanha_id, cc.id];
    }
    const tipo = direcao === 'saida' ? classificar(destino) : 'interno';
    const r = db.prepare(`INSERT INTO chamadas (empresa_id, uid, direcao, origem, destino, tipo_destino, ramal_id, numero_id, campanha_id, campanha_contato_id,
        tronco_id, inicio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(empresa.id, uid, direcao, origem, destino, tipo, ramal?.id ?? null, did?.id ?? null, campanhaId, contatoId,
        direcao === 'saida' && tipo !== 'interno' ? empresa.tronco_id : null, instante(d.inicio, 'inicio'));
    const gravar = Boolean(empresa.gravar_chamadas && (!ramal || ramal.gravar) && discoUsado(db, empresa.id) < empresa.disco_mb * 1024 * 1024);
    return { id: Number(r.lastInsertRowid), gravar };
  });
}

const buscar = (db, empresa, uid) => {
  const c = db.prepare('SELECT * FROM chamadas WHERE empresa_id = ? AND uid = ?').get(empresa.id, String(uid));
  if (!c) throw new ErroNegocio('Chamada não encontrada.', 404);
  return c;
};

function atender(db, empresa, uid, d = {}) {
  const c = buscar(db, empresa, uid);
  if (c.fim) throw new ErroNegocio('A chamada já terminou.', 409);
  if (!c.atendida_em) db.prepare('UPDATE chamadas SET atendida_em = ? WHERE id = ?').run(instante(d.em, 'em'), c.id);
  return { id: c.id };
}

const RESULTADO_CONTATO = { atendida: 'atendido', nao_atendida: 'nao_atendido', ocupado: 'ocupado', falha: 'falha' };

/** Fim da chamada: duração falada (do atendimento ao fim), segundos tarifados, custo e o resultado do contato da campanha. */
function encerrar(db, empresa, uid, d = {}) {
  return transacao(db, () => {
    const c = buscar(db, empresa, uid);
    if (c.fim) return { id: c.id, repetida: true };
    const fim = instante(d.fim, 'fim');
    const status = d.status && RESULTADO_CONTATO[d.status] ? d.status : (c.atendida_em ? 'atendida' : 'nao_atendida');
    const atendida = status === 'atendida' ? (c.atendida_em ?? c.inicio) : null;
    const duracao = atendida ? Math.max(0, Math.round((Date.parse(fim) - Date.parse(atendida)) / 1000)) : 0;
    const cfg = lerConfig(db);
    const tarifado = c.direcao === 'saida' && c.tipo_destino !== 'interno' ? tarifar(duracao, cfg.cadencia_inicial_s, cfg.cadencia_s) : 0;
    const bytes = Math.max(0, Math.round(Number(d.gravacao_bytes) || 0));
    db.prepare(`UPDATE chamadas SET status = ?, atendida_em = ?, fim = ?, duracao_s = ?, tarifado_s = ?, custo_centavos = ?, gravacao_bytes = ? WHERE id = ?`)
      .run(status, atendida, fim, duracao, tarifado, custo(empresa, c.tipo_destino, tarifado), bytes, c.id);
    if (c.campanha_contato_id) db.prepare('UPDATE campanha_contatos SET status = ? WHERE id = ?').run(RESULTADO_CONTATO[status], c.campanha_contato_id);
    return { id: c.id, status, duracao_s: duracao, custo_centavos: custo(empresa, c.tipo_destino, tarifado) };
  });
}

/**
 * Manutenção: encerra como falha as chamadas que ficaram "em curso" além do limite (a central não avisou o fim)
 * e marca offline os ramais sem registro recente.
 */
function manutencao(db) {
  const cfg = lerConfig(db);
  const corte = new Date(Date.now() - cfg.chamada_max_horas * 3600_000).toISOString();
  db.prepare("UPDATE chamadas SET status = 'falha', fim = ? WHERE fim IS NULL AND inicio < ?").run(agora(), corte);
  db.prepare("UPDATE campanha_contatos SET status = 'falha' WHERE status = 'discando' AND ultima_tentativa < ?").run(corte);
  const expira = new Date(Date.now() - cfg.registro_expira_min * 60_000).toISOString();
  db.prepare('UPDATE ramais SET online = 0 WHERE online = 1 AND (registro_em IS NULL OR registro_em < ?)').run(expira);
}

/**
 * Pico de chamadas simultâneas em cada intervalo de `passoMs` entre ini e fim (ms). Intervalos no futuro ficam nulos.
 * `chamadas`: [{ inicio, fim }] (fim nulo = em curso).
 */
function simultaneas(chamadas, ini, fim, passoMs) {
  const agoraMs = Date.now();
  const n = Math.ceil((fim - ini) / passoMs);
  const pico = Array(n).fill(0);
  const eventos = [];
  for (const c of chamadas) {
    const s = Math.max(ini, Date.parse(c.inicio));
    const e = Math.min(fim, c.fim ? Date.parse(c.fim) : agoraMs);
    if (e < s) continue;
    eventos.push([s, 1], [Math.max(e, s + 1), -1]);
  }
  eventos.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let atual = 0;
  let k = 0;
  for (const [t, delta] of eventos) {
    const balde = Math.min(n - 1, Math.floor((t - ini) / passoMs));
    // Os intervalos sem eventos mantêm o número de chamadas que vinha do anterior.
    for (; k < balde; k++) pico[k] = Math.max(pico[k], atual);
    // Quem já estava em chamada no começo deste intervalo também conta nele.
    pico[balde] = Math.max(pico[balde], atual);
    atual += delta;
    pico[balde] = Math.max(pico[balde], atual);
  }
  for (; k < n; k++) pico[k] = Math.max(pico[k], atual);
  return pico.map((v, i) => (ini + i * passoMs > agoraMs ? null : v));
}

module.exports = { classificar, tarifar, custo, iniciar, atender, encerrar, manutencao, simultaneas, emCurso, discoUsado };
