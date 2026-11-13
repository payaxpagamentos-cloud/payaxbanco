'use strict';

const { agora } = require('../db');
const wa = require('./whatsapp');
const { ErroNegocio } = require('./erros');

/**
 * Fila de saída. Quem escreve uma mensagem (a ZOE, um atendente humano ou a API da empresa)
 * só grava a linha em `mensagens` com status 'fila' — dentro da transação do atendimento. O envio pela rede
 * acontece depois, fora da transação, com novas tentativas. Assim uma falha da Meta nunca perde a conversa.
 */

// Espera antes de cada nova tentativa (minutos). Depois da última, a mensagem fica como 'falhou'.
const ESPERAS_MIN = [1, 2, 5, 15, 30, 60];

const LIVRES = new Set(['texto', 'imagem', 'audio', 'video', 'documento', 'figurinha', 'botao']);

/**
 * Põe uma mensagem na fila da conversa. Devolve o id.
 * `tipo` 'texto' usa `texto`; os outros usam `payload` (corpo pronto da Cloud API, sem o `to`).
 */
function enfileirar(db, conversa, { autor, usuarioId = null, tipo = 'texto', texto = null, payload = null, respondeWaId = null,
  midiaArquivo = null, midiaNome = null, midiaMime = null, midiaBytes = null } = {}) {
  const id = Number(db.prepare(`INSERT INTO mensagens
      (conversa_id, empresa_id, direcao, autor, usuario_id, tipo, texto, payload, responde_wa_id, midia_arquivo, midia_nome, midia_mime, midia_bytes, status, proxima_em, criada_em)
    VALUES (?, ?, 'saida', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fila', ?, ?)`)
    .run(conversa.id, conversa.empresa_id, autor, usuarioId, tipo, texto === null ? null : String(texto).slice(0, 4096),
      payload === null ? null : JSON.stringify(payload), respondeWaId, midiaArquivo, midiaNome, midiaMime, midiaBytes, agora(), agora()).lastInsertRowid);
  db.prepare('UPDATE conversas SET ultima_mensagem_em = ? WHERE id = ?').run(agora(), conversa.id);
  return id;
}

/** Mensagem do sistema: só aparece no histórico do painel, nunca vai para o cliente. */
function registrarSistema(db, conversa, texto, { usuarioId = null } = {}) {
  return Number(db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, usuario_id, tipo, texto, status, criada_em)
    VALUES (?, ?, 'saida', 'sistema', ?, 'sistema', ?, 'enviada', ?)`)
    .run(conversa.id, conversa.empresa_id, usuarioId, String(texto).slice(0, 4096), agora()).lastInsertRowid);
}

/** Monta o corpo da Cloud API a partir da linha gravada. */
function corpoDe(m, telefone) {
  if (m.payload) {
    const p = JSON.parse(m.payload);
    return { recipient_type: 'individual', to: telefone, ...p, ...(m.responde_wa_id ? { context: { message_id: m.responde_wa_id } } : {}) };
  }
  return wa.corpos.texto(telefone, m.texto ?? '', { responde: m.responde_wa_id });
}

let processando = false;

/**
 * Envia as mensagens da fila cuja hora chegou, uma por vez e em ordem (a ordem importa numa conversa).
 * Devolve quantas saíram.
 */
async function processarFila(db, { limite = 50 } = {}) {
  if (processando) return 0;
  processando = true;
  let enviadas = 0;
  try {
    const fila = db.prepare(`SELECT m.*, c.estado, c.janela_expira_em, ct.telefone, n.id AS numero_id, n.phone_number_id, n.token_cifrado, n.app_secret_cifrado, n.ativo AS numero_ativo
      FROM mensagens m
      JOIN conversas c ON c.id = m.conversa_id
      JOIN contatos ct ON ct.id = c.contato_id
      JOIN numeros n ON n.id = c.numero_id
      WHERE m.status = 'fila' AND m.proxima_em <= ?
      ORDER BY m.id LIMIT ?`).all(agora(), limite);

    for (const m of fila) {
      const numero = { id: m.numero_id, phone_number_id: m.phone_number_id, token_cifrado: m.token_cifrado, app_secret_cifrado: m.app_secret_cifrado };
      try {
        if (!m.numero_ativo) throw new wa.ErroWhatsApp('O número de WhatsApp desta empresa está desativado.', { definitivo: true });
        // Fora da janela de 24 h a Meta recusa qualquer mensagem livre: só template passa.
        if (LIVRES.has(m.tipo) && !wa.janelaAberta(m)) {
          throw new wa.ErroWhatsApp('Passaram-se mais de 24 horas desde a última mensagem do cliente: só um template aprovado pode ser enviado agora.', { definitivo: true });
        }
        const waId = await wa.enviar(numero, corpoDe(m, m.telefone));
        db.prepare("UPDATE mensagens SET status = 'enviada', wa_id = ?, enviada_em = ?, erro = NULL, tentativas = tentativas + 1 WHERE id = ?")
          .run(waId, agora(), m.id);
        enviadas++;
      } catch (err) {
        const n = m.tentativas + 1;
        const espera = err.definitivo ? undefined : ESPERAS_MIN[n - 1];
        const motivo = String(err.message).slice(0, 300);
        if (espera === undefined) {
          db.prepare("UPDATE mensagens SET status = 'falhou', tentativas = ?, erro = ? WHERE id = ?").run(n, motivo, m.id);
        } else {
          db.prepare('UPDATE mensagens SET tentativas = ?, erro = ?, proxima_em = ? WHERE id = ?')
            .run(n, motivo, new Date(Date.now() + espera * 60_000).toISOString(), m.id);
        }
      }
    }
  } finally {
    processando = false;
  }
  return enviadas;
}

/** Dispara a fila sem travar quem chamou (usado logo depois de gravar uma mensagem). */
const girar = (db) => { setImmediate(() => { processarFila(db).catch(() => {}); }); };

/** Reenvia uma mensagem que falhou (botão no painel). */
function reenviar(db, mensagemId, empresaId) {
  const m = db.prepare("SELECT * FROM mensagens WHERE id = ? AND empresa_id = ?").get(mensagemId, empresaId);
  if (!m) throw new ErroNegocio('Mensagem não encontrada.', 404);
  if (m.status !== 'falhou') throw new ErroNegocio('Só uma mensagem que falhou pode ser reenviada.');
  db.prepare("UPDATE mensagens SET status = 'fila', tentativas = 0, erro = NULL, proxima_em = ? WHERE id = ?").run(agora(), m.id);
  girar(db);
  return { id: m.id };
}

module.exports = { enfileirar, registrarSistema, processarFila, girar, reenviar, ESPERAS_MIN };
