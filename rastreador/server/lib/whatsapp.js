'use strict';

const config = require('../config');
const { agora } = require('../db');

/**
 * WhatsApp pela Evolution API: a fila de mensagens (tabela `mensagens`) e o envio, com novas tentativas.
 * A mensagem entra na fila dentro da transação de quem a criou e sai depois, fora dela (o envio é pela rede).
 */
const configurado = () => Boolean(config.whatsapp.url && config.whatsapp.instancia && config.whatsapp.chave);
// Espera antes de cada nova tentativa (minutos); depois da última, a mensagem fica como "falhou".
const ESPERAS_MIN = [1, 2, 5, 15, 30, 60];

/** Número no formato da Evolution: só dígitos, com o 55 do Brasil quando vier com DDD e número (10 ou 11 dígitos). */
function normalizarNumero(n) {
  const d = String(n ?? '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d;
}

/** Põe a mensagem na fila. `arquivo`: Buffer ou base64 de um PDF (opcional). Devolve o id. */
function enfileirar(db, { empresaId = null, numero, texto, arquivo = null, arquivoNome = null, origem = null }) {
  const num = normalizarNumero(numero);
  const base64 = arquivo ? (Buffer.isBuffer(arquivo) ? arquivo.toString('base64') : String(arquivo)) : null;
  const semConfig = !configurado();
  const id = Number(db.prepare(`INSERT INTO mensagens (empresa_id, numero, texto, arquivo, arquivo_nome, origem, status, proxima_em, erro, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId, num, String(texto).slice(0, 4000), base64, arquivoNome, origem,
    semConfig ? 'falhou' : 'pendente', agora(), semConfig ? 'WhatsApp não configurado no servidor (Evolution).' : null, agora()).lastInsertRowid);
  if (!semConfig) setImmediate(() => processarFila(db).catch(() => {}));
  return id;
}

async function chamar(caminho, corpo, metodo = 'POST') {
  const resp = await fetch(`${config.whatsapp.url}${caminho}`, {
    method: metodo,
    headers: { apikey: config.whatsapp.chave, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const texto = await resp.text();
  let dados = null;
  try { dados = JSON.parse(texto); } catch { /* resposta sem JSON */ }
  if (!resp.ok) throw new Error(dados?.response?.message?.toString() || dados?.message?.toString() || `Evolution respondeu ${resp.status}`);
  return dados;
}

/** Envia uma mensagem (texto ou PDF com legenda). Aceita a Evolution v2 e a v1 (os campos das duas vão juntos). */
async function enviar(m) {
  const inst = encodeURIComponent(config.whatsapp.instancia);
  if (m.arquivo) {
    return chamar(`/message/sendMedia/${inst}`, {
      number: m.numero, mediatype: 'document', mimetype: 'application/pdf', fileName: m.arquivo_nome || 'relatorio.pdf', caption: m.texto, media: m.arquivo,
      mediaMessage: { mediatype: 'document', fileName: m.arquivo_nome || 'relatorio.pdf', caption: m.texto, media: m.arquivo },
    });
  }
  return chamar(`/message/sendText/${inst}`, { number: m.numero, text: m.texto, textMessage: { text: m.texto } });
}

let processando = false;
/** Envia as mensagens pendentes cuja hora chegou (uma por vez, em ordem). */
async function processarFila(db) {
  if (processando || !configurado()) return 0;
  processando = true;
  let enviadas = 0;
  try {
    const fila = db.prepare("SELECT * FROM mensagens WHERE status = 'pendente' AND proxima_em <= ? ORDER BY id LIMIT 30").all(agora());
    for (const m of fila) {
      try {
        await enviar(m);
        db.prepare("UPDATE mensagens SET status = 'enviada', enviado_em = ?, erro = NULL, tentativas = tentativas + 1, arquivo = NULL WHERE id = ?").run(agora(), m.id);
        enviadas++;
      } catch (err) {
        const n = m.tentativas + 1;
        const espera = ESPERAS_MIN[n - 1];
        if (espera === undefined) {
          db.prepare("UPDATE mensagens SET status = 'falhou', tentativas = ?, erro = ? WHERE id = ?").run(n, String(err.message).slice(0, 300), m.id);
        } else {
          db.prepare('UPDATE mensagens SET tentativas = ?, erro = ?, proxima_em = ? WHERE id = ?')
            .run(n, String(err.message).slice(0, 300), new Date(Date.now() + espera * 60_000).toISOString(), m.id);
        }
      }
    }
  } finally {
    processando = false;
  }
  return enviadas;
}

/** Situação da conexão (instância conectada ao número?). */
async function situacao() {
  if (!configurado()) return { configurado: false, conectado: false, estado: 'não configurado' };
  try {
    const r = await chamar(`/instance/connectionState/${encodeURIComponent(config.whatsapp.instancia)}`, null, 'GET');
    const estado = r?.instance?.state ?? r?.state ?? 'desconhecido';
    return { configurado: true, conectado: estado === 'open', estado, instancia: config.whatsapp.instancia };
  } catch (err) {
    return { configurado: true, conectado: false, estado: 'erro', erro: err.message, instancia: config.whatsapp.instancia };
  }
}

module.exports = { configurado, normalizarNumero, enfileirar, processarFila, situacao, enviar };
