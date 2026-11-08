'use strict';

const webpush = require('web-push');
const config = require('../config');
const { agora } = require('../db');

/**
 * Avisos no celular do motorista (notificação do navegador, pelo app instalado). As chaves que assinam os avisos são
 * criadas na primeira vez e ficam no banco, fora das configurações que o painel mostra.
 */
let enviarFn = (inscricao, corpo, opcoes) => webpush.sendNotification(inscricao, corpo, opcoes);
/** Para os testes: troca o envio por um falso. */
function definirEnvio(fn) { enviarFn = fn ?? ((inscricao, corpo, opcoes) => webpush.sendNotification(inscricao, corpo, opcoes)); }

function chaves(db) {
  const r = db.prepare("SELECT valor FROM chaves_servidor WHERE nome = 'vapid'").get();
  if (r) return JSON.parse(r.valor);
  const k = webpush.generateVAPIDKeys();
  db.prepare("INSERT OR IGNORE INTO chaves_servidor (nome, valor) VALUES ('vapid', ?)").run(JSON.stringify(k));
  return JSON.parse(db.prepare("SELECT valor FROM chaves_servidor WHERE nome = 'vapid'").get().valor);
}
const chavePublica = (db) => chaves(db).publicKey;

function inscrever(db, motoristaId, s) {
  const endpoint = String(s?.endpoint ?? '');
  const p256dh = String(s?.keys?.p256dh ?? '');
  const auth = String(s?.keys?.auth ?? '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) return false;
  db.prepare(`INSERT INTO push_inscricoes (motorista_id, endpoint, p256dh, auth, criado_em) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET motorista_id = excluded.motorista_id, p256dh = excluded.p256dh, auth = excluded.auth`).run(motoristaId, endpoint, p256dh, auth, agora());
  return true;
}
const cancelar = (db, motoristaId, endpoint) => db.prepare('DELETE FROM push_inscricoes WHERE motorista_id = ? AND endpoint = ?').run(motoristaId, String(endpoint ?? '')).changes > 0;
const inscrito = (db, motoristaId) => Boolean(db.prepare('SELECT 1 FROM push_inscricoes WHERE motorista_id = ?').get(motoristaId));

/** Envia a todos os aparelhos do motorista. Aparelho que não existe mais (404/410) sai da lista. */
async function enviar(db, motoristaId, { titulo, texto, caminho = '' }) {
  if (!motoristaId) return 0;
  const lista = db.prepare('SELECT * FROM push_inscricoes WHERE motorista_id = ?').all(motoristaId);
  if (!lista.length) return 0;
  const k = chaves(db);
  const vapidDetails = { subject: /^https:\/\//.test(config.urlPublica) ? config.urlPublica : 'mailto:suporte@rastreador.app', publicKey: k.publicKey, privateKey: k.privateKey };
  const corpo = JSON.stringify({ titulo, texto, caminho });
  let ok = 0;
  for (const i of lista) {
    try {
      await enviarFn({ endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } }, corpo, { vapidDetails, TTL: 6 * 3600, urgency: 'high' });
      ok++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_inscricoes WHERE id = ?').run(i.id);
      else console.error('[Rastreador] Aviso no celular falhou:', err.statusCode ?? '', String(err.message).slice(0, 160));
    }
  }
  return ok;
}

/** Envia sem esperar (dentro das tarefas e das rotas). */
function avisar(db, motoristaId, dados) {
  enviar(db, motoristaId, dados).catch((err) => console.error('[Rastreador] Aviso no celular:', err.message));
}

/** true na primeira vez que a chave aparece (o mesmo aviso não se repete). */
function umaVez(db, chave) {
  return db.prepare('INSERT OR IGNORE INTO avisos_motorista (chave, criado_em) VALUES (?, ?)').run(chave, agora()).changes > 0;
}

module.exports = { chavePublica, inscrever, cancelar, inscrito, enviar, avisar, umaVez, definirEnvio };
