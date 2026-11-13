'use strict';

const express = require('express');
const { agora } = require('../db');
const { iguais } = require('../lib/cifra');
const wa = require('../lib/whatsapp');
const recepcao = require('../lib/recepcao');

/**
 * Webhook da WhatsApp Cloud API. Dois endereços, os dois públicos (sem sessão):
 *
 *   GET  <base>/api/webhook  — verificação da Meta ao cadastrar o endereço (hub.challenge).
 *   POST <base>/api/webhook  — as mensagens e os avisos de entrega.
 *
 * Quem autentica o POST é a assinatura do app (X-Hub-Signature-256) sobre o corpo cru, com o segredo
 * do app cadastrado no número. Sem segredo cadastrado, o evento é recusado — nunca aceito "no escuro".
 *
 * A Meta reenvia o evento se não receber 200 em poucos segundos, e a atendente virtual pode levar
 * mais que isso para pensar. Por isso o 200 vai na hora e o atendimento roda em seguida; o que ele
 * responder sai pela fila de mensagens.
 */

module.exports = function rotasWebhook(db) {
  const r = express.Router();
  const pendentes = new Set();

  const numeroPorPhoneId = (phoneId) => {
    const numero = db.prepare('SELECT * FROM numeros WHERE phone_number_id = ?').get(String(phoneId));
    if (!numero) return null;
    const empresa = db.prepare("SELECT * FROM empresas WHERE id = ? AND status = 'ativa'").get(numero.empresa_id);
    return empresa && numero.ativo ? { numero, empresa } : null;
  };

  // ---------- Verificação do endereço (a Meta chama uma vez, ao cadastrar) ----------
  r.get('/', (req, res) => {
    const modo = req.query['hub.mode'];
    const token = String(req.query['hub.verify_token'] ?? '');
    const desafio = String(req.query['hub.challenge'] ?? '');
    if (modo !== 'subscribe' || !token) return res.sendStatus(400);
    // O token de verificação é escolhido pela empresa ao cadastrar o número; vale o de qualquer número ativo.
    const confere = db.prepare('SELECT verify_token FROM numeros WHERE ativo = 1').all().some((n) => iguais(n.verify_token, token));
    if (!confere) {
      db.prepare("INSERT INTO acessos_recusados (ip, motivo, criado_em) VALUES (?, 'webhook: token de verificação inválido', ?)").run(req.ip, agora());
      return res.sendStatus(403);
    }
    return res.type('text/plain').send(desafio);
  });

  // ---------- Eventos ----------
  r.post('/', (req, res) => {
    const corpo = req.body ?? {};
    const cru = req.corpoCru ?? Buffer.from(JSON.stringify(corpo));

    // Os números de um mesmo app compartilham o segredo, então basta uma assinatura válida entre os números do evento.
    const alvos = [...new Set((corpo.entry ?? []).flatMap((e) => (e.changes ?? []).map((c) => c.value?.metadata?.phone_number_id).filter(Boolean)))]
      .map((id) => numeroPorPhoneId(id)).filter(Boolean);

    if (!alvos.length) {
      // Número desconhecido: responde 200 para a Meta não ficar reenviando, mas registra.
      db.prepare("INSERT INTO acessos_recusados (ip, motivo, criado_em) VALUES (?, 'webhook: número não cadastrado', ?)").run(req.ip, agora());
      return res.json({ ok: true, ignorado: 'número não cadastrado' });
    }

    const assinatura = req.get('x-hub-signature-256');
    const valida = alvos.some(({ numero }) => wa.assinaturaValida(numero, assinatura, cru));
    if (!valida) {
      const semSegredo = alvos.every(({ numero }) => !wa.segredoApp(numero));
      db.prepare('INSERT INTO acessos_recusados (ip, motivo, criado_em) VALUES (?, ?, ?)')
        .run(req.ip, semSegredo ? 'webhook: número sem segredo do app cadastrado' : 'webhook: assinatura inválida', agora());
      return res.status(401).json({ erro: 'Assinatura inválida.' });
    }

    // 200 agora; o atendimento roda em seguida.
    res.json({ ok: true });
    const tarefa = recepcao.processar(db, corpo, { numeroPorPhoneId })
      .catch((err) => console.error('[ZOE Atende] Falha no webhook:', err))
      .finally(() => pendentes.delete(tarefa));
    pendentes.add(tarefa);
  });

  /** Espera o que o webhook disparou (usado nos testes e no encerramento do servidor). */
  r.aguardar = () => Promise.allSettled([...pendentes]);
  return r;
};
