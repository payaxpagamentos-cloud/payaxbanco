'use strict';

/*
 * Avisos por Telegram, WhatsApp e webhook ("Manager Network Alertas").
 * Os eventos entram numa fila (avisos_envios) e são enviados por um laço com novas tentativas (até 5, com espera crescente).
 * Credenciais (token do bot, token da API do WhatsApp, segredo do webhook) ficam cifradas e nunca voltam para a tela.
 */

const crypto = require('node:crypto');
const { agora } = require('../db');
const { cifrar, decifrar } = require('./cripto');
const base = require('../conectores/base');

const TITULO = 'Manager Network Alertas';
const MAX_TENTATIVAS = 5;
const PESO = { baixa: 0, media: 1, alta: 2, critica: 3 };

/** Eventos que um canal pode assinar. Os módulos seguintes acrescentam os seus (chamados, IPAM, ataques internos...). */
const EVENTOS = {
  ataque_inicio: 'Ataque detectado',
  ataque_fim: 'Ataque encerrado',
  mitigacao_pendente: 'Bloqueio aguardando aprovação',
  mitigacao_ativa: 'Bloqueio ativado',
  mitigacao_retirada: 'Bloqueio retirado',
  mitigacao_bloqueada: 'Bloqueio impedido pelas proteções',
  exportador_parado: 'Roteador parou de enviar flows',
  teste: 'Mensagem de teste',
};

const URL_PADRAO = { telegram: 'https://api.telegram.org', whatsapp: 'https://graph.facebook.com/v21.0' };

/** Coloca o aviso na fila de cada canal ativo da organização que assina o evento e aceita a severidade. */
function enfileirar(db, org, evento, { texto, severidade = 'media', recurso = null, recursoId = null }) {
  const canais = db.prepare('SELECT * FROM avisos_canais WHERE organizacao_id = ? AND ativo = 1').all(org);
  const ins = db.prepare(`INSERT INTO avisos_envios (organizacao_id, canal_id, evento, recurso, recurso_id, texto, proxima_tentativa, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  const t = agora();
  for (const c of canais) {
    const eventos = JSON.parse(c.eventos);
    if (evento !== 'teste' && !eventos.includes(evento)) continue;
    if (evento !== 'teste' && (PESO[severidade] ?? 1) < PESO[c.severidade_min]) continue;
    ins.run(org, c.id, evento, recurso, recursoId, `${TITULO}\n${texto}`, t, t);
    n++;
  }
  return n;
}

/** Envia por um canal. Lança ErroConector em falha. */
async function enviar(canal, texto) {
  const cfg = JSON.parse(canal.config);
  const segredo = canal.segredo_cifrado ? decifrar(canal.segredo_cifrado) : null;
  if (canal.tipo === 'telegram') {
    if (!segredo) throw new base.ErroConector('Token do bot não configurado.', 'falha', { permanente: true });
    const url = `${(cfg.url_api || URL_PADRAO.telegram).replace(/\/+$/, '')}/bot${segredo}/sendMessage`;
    for (const chat of cfg.chats ?? []) await base.enviarJson(url, { chat_id: chat, text: texto, disable_web_page_preview: true });
    return;
  }
  if (canal.tipo === 'whatsapp') {
    if (!segredo) throw new base.ErroConector('Token da API do WhatsApp não configurado.', 'falha', { permanente: true });
    const url = `${(cfg.url_api || URL_PADRAO.whatsapp).replace(/\/+$/, '')}/${encodeURIComponent(cfg.numero_id)}/messages`;
    for (const para of cfg.destinatarios ?? []) {
      // Fora da janela de 24 h de conversa, a Meta só entrega mensagens de modelo aprovado: o texto vai como parâmetro do modelo.
      const corpo = cfg.modelo
        ? { messaging_product: 'whatsapp', to: para, type: 'template', template: { name: cfg.modelo, language: { code: cfg.idioma || 'pt_BR' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: texto.replace(/\n+/g, ' · ').slice(0, 1000) }] }] } }
        : { messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto.slice(0, 4000) } };
      await base.enviarJson(url, corpo, { Authorization: `Bearer ${segredo}` });
    }
    return;
  }
  // Webhook genérico (gateways de WhatsApp como Evolution/Z-API, chat interno etc.): POST JSON com assinatura HMAC opcional.
  const corpo = { origem: 'manager-network', titulo: TITULO, texto, enviado_em: agora() };
  const cab = {};
  if (segredo) cab['X-Assinatura'] = `sha256=${crypto.createHmac('sha256', segredo).update(JSON.stringify(corpo)).digest('hex')}`;
  await base.enviarJson(cfg.url, corpo, cab);
}

/** Processa a fila: envia o que está pendente e no horário; falha temporária volta com espera crescente. */
async function processar(db, limite = 20) {
  const fila = db.prepare(`SELECT e.*, c.tipo, c.config, c.segredo_cifrado, c.ativo FROM avisos_envios e JOIN avisos_canais c ON c.id = e.canal_id
    WHERE e.status = 'pendente' AND e.proxima_tentativa <= ? ORDER BY e.id LIMIT ?`).all(agora(), limite);
  let enviados = 0;
  for (const e of fila) {
    if (!e.ativo) { db.prepare("UPDATE avisos_envios SET status = 'falha', erro = 'Canal desativado' WHERE id = ?").run(e.id); continue; }
    try {
      await enviar(e, e.texto);
      db.prepare("UPDATE avisos_envios SET status = 'enviado', tentativas = tentativas + 1, enviado_em = ?, erro = NULL WHERE id = ?").run(agora(), e.id);
      db.prepare('UPDATE avisos_canais SET ultimo_envio = ?, ultimo_erro = NULL WHERE id = ?').run(agora(), e.canal_id);
      enviados++;
    } catch (err) {
      const tentativas = e.tentativas + 1;
      const erroId = crypto.randomBytes(5).toString('hex');
      const final = err.permanente || tentativas >= MAX_TENTATIVAS;
      const espera = err.retryAfterS ? err.retryAfterS * 1000 : 30_000 * 2 ** (tentativas - 1);
      const msg = String(err.message).slice(0, 300);
      db.prepare('UPDATE avisos_envios SET status = ?, tentativas = ?, proxima_tentativa = ?, erro = ?, erro_id = ? WHERE id = ?')
        .run(final ? 'falha' : 'pendente', tentativas, new Date(Date.now() + espera).toISOString(), msg, erroId, e.id);
      db.prepare('UPDATE avisos_canais SET ultimo_erro = ? WHERE id = ?').run(`${msg} (ID ${erroId})`, e.canal_id);
      if (!(err instanceof base.ErroConector)) console.error(`[Network] Aviso ${e.id} erro ${erroId}:`, err);
    }
  }
  return enviados;
}

/** Versão do canal para a tela: sem a credencial. */
function publico(c) {
  const { segredo_cifrado: s, ...resto } = c;
  return { ...resto, config: JSON.parse(c.config), eventos: JSON.parse(c.eventos), ativo: Boolean(c.ativo), credencial_configurada: Boolean(s) };
}

const cifrarSegredo = (s) => (s ? cifrar(s) : null);

module.exports = { EVENTOS, TITULO, URL_PADRAO, enfileirar, enviar, processar, publico, cifrarSegredo };
