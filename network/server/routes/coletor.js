'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { agora, transacao } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const { sha256 } = require('../lib/cripto');
const { processarAmostra } = require('../lib/noc');

const MAX_LOTE = 1000;

/** Token do coletor: mnc_<prefixo>_<segredo>. Só o hash fica guardado. */
function lerToken(db, token) {
  const m = /^mnc_([0-9a-f]{8})_([A-Za-z0-9_-]{20,64})$/.exec(String(token ?? ''));
  if (!m) return null;
  const k = db.prepare('SELECT * FROM coletores WHERE prefixo = ? AND revogado_em IS NULL').get(m[1]);
  if (!k || !crypto.timingSafeEqual(Buffer.from(k.hash, 'hex'), Buffer.from(sha256(m[2]), 'hex'))) return null;
  db.prepare('UPDATE coletores SET ultimo_uso = ? WHERE id = ?').run(agora(), k.id);
  return k;
}

function criarToken(db, org, nome, usuarioId) {
  const prefixo = crypto.randomBytes(4).toString('hex');
  const segredo = crypto.randomBytes(24).toString('base64url');
  const id = Number(db.prepare('INSERT INTO coletores (organizacao_id, nome, prefixo, hash, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(org, nome, prefixo, sha256(segredo), usuarioId, agora()).lastInsertRowid);
  return { id, prefixo, token: `mnc_${prefixo}_${segredo}` };
}

/**
 * Entrada das amostras da plataforma de monitoramento ou do agente na rede do provedor (Authorization: Bearer mnc_...).
 * Corpo: uma amostra ou { amostras: [...] } no formato interno (schema_version 1):
 *   { source_event_id, source?, target_id, ponto?, metric, value, unit?, observed_at }
 * A organização vem do token, nunca do corpo. Cada amostra é gravada antes de ser processada; repetir o mesmo source_event_id não duplica.
 */
module.exports = (db) => {
  const r = Router();
  r.use((req, _res, next) => {
    const c = req.get('authorization') || '';
    const k = lerToken(db, c.startsWith('Bearer ') ? c.slice(7) : req.get('x-coletor-token'));
    if (!k) return next(new ErroNegocio('Token do coletor inválido ou revogado.', 401));
    req.coletor = k;
    next();
  });

  r.post('/amostras', (req, res) => {
    const lista = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.amostras) ? req.body.amostras : [req.body];
    if (!lista.length || lista.length > MAX_LOTE) throw new ErroNegocio(`Envie de 1 a ${MAX_LOTE} amostras.`, 422);
    const org = req.coletor.organizacao_id;
    const equip = db.prepare('SELECT * FROM equipamentos WHERE organizacao_id = ? AND monitoramento_id = ? AND ativo = 1');
    const resultado = [];
    // Ordem cronológica dentro do lote, para a histerese funcionar como no tempo real.
    const ordenada = lista.map((a, i) => ({ a, i })).sort((x, y) => String(x.a?.observed_at ?? '').localeCompare(String(y.a?.observed_at ?? '')));
    for (const { a, i } of ordenada) {
      const erro = (e) => resultado.push({ indice: i, status: 'invalida', erro: e });
      if (!a || typeof a !== 'object') { erro('amostra inválida'); continue; }
      if (a.schema_version !== undefined && Number(a.schema_version) !== 1) { erro('schema_version não suportada'); continue; }
      const id = String(a.source_event_id ?? '').slice(0, 120);
      const valor = Number(a.value);
      const em = Date.parse(a.observed_at);
      if (!id || !a.target_id || !/^[a-z0-9_]{2,40}$/.test(String(a.metric ?? '')) || !Number.isFinite(valor) || !Number.isFinite(em)) { erro('campos obrigatórios: source_event_id, target_id, metric, value, observed_at'); continue; }
      if (em > Date.now() + 5 * 60_000) { erro('observed_at no futuro'); continue; }
      const eq = equip.get(org, String(a.target_id));
      if (!eq) { resultado.push({ indice: i, status: 'alvo_desconhecido', erro: 'target_id não corresponde ao identificador de monitoramento de um equipamento' }); continue; }
      const amostra = { origem_evento_id: id, fonte: String(a.source ?? req.coletor.nome).slice(0, 60), alvo_id: String(a.target_id), ponto: a.ponto ? String(a.ponto).slice(0, 60) : null,
        metrica: String(a.metric), valor, unidade: a.unit ? String(a.unit).slice(0, 20) : null, observado_em: new Date(em).toISOString() };
      const r2 = transacao(db, () => {
        const ins = db.prepare(`INSERT OR IGNORE INTO amostras (organizacao_id, fonte, origem_evento_id, equipamento_id, alvo_id, ponto, metrica, valor, unidade, observado_em, recebido_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(org, amostra.fonte, id, eq.id, amostra.alvo_id, amostra.ponto, amostra.metrica, valor, amostra.unidade, amostra.observado_em, agora());
        if (!ins.changes) return { indice: i, status: 'duplicada' };
        return { indice: i, status: 'gravada', regras: processarAmostra(db, org, amostra, eq) };
      });
      resultado.push(r2);
    }
    resultado.sort((x, y) => x.indice - y.indice);
    res.json({ recebidas: resultado.filter((x) => x.status === 'gravada').length, resultado });
  });

  return r;
};
module.exports.criarToken = criarToken;
