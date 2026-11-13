'use strict';

const { agora, transacao } = require('../db');
const conversas = require('./conversas');
const envio = require('./envio');
const midia = require('./midia');
const wa = require('./whatsapp');
const { atender } = require('../ia/atendente');

/**
 * Tradução dos eventos do webhook da Meta para o modelo da plataforma, e o gatilho da ZOE.
 *
 * A Meta reenvia o mesmo evento quando não recebe 200 rápido, então tudo aqui é idempotente: o id da
 * mensagem (wa_id) é único em `mensagens` e fica registrado em `webhook_vistos`. O webhook responde 200
 * antes de a atendente pensar — a resposta ao cliente sai pela fila, não pela resposta HTTP.
 */

const TIPOS_MIDIA = { image: 'imagem', audio: 'audio', video: 'video', document: 'documento', sticker: 'figurinha' };

/** Converte a mensagem da Meta para os campos da plataforma. */
function interpretar(m) {
  const comum = { waId: m.id, respondeWaId: m.context?.id ?? null, criadaEm: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : agora() };
  switch (m.type) {
    case 'text':
      return { ...comum, tipo: 'texto', texto: m.text?.body ?? '' };
    case 'interactive': {
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply ?? null;
      return { ...comum, tipo: 'botao', texto: r?.title ?? '', idResposta: r?.id ?? null };
    }
    case 'button':
      return { ...comum, tipo: 'botao', texto: m.button?.text ?? '', idResposta: m.button?.payload ?? null };
    case 'image': case 'audio': case 'video': case 'document': case 'sticker': {
      const dados = m[m.type] ?? {};
      return {
        ...comum, tipo: TIPOS_MIDIA[m.type], texto: dados.caption ?? null,
        midiaId: dados.id ?? null, midiaNome: dados.filename ?? null, midiaMime: dados.mime_type ?? null,
      };
    }
    case 'location': {
      const l = m.location ?? {};
      return { ...comum, tipo: 'localizacao', texto: [l.name, l.address, `${l.latitude}, ${l.longitude}`].filter(Boolean).join(' — ') };
    }
    case 'contacts':
      return { ...comum, tipo: 'contato', texto: (m.contacts ?? []).map((c) => c.name?.formatted_name).filter(Boolean).join(', ') || '[contato]' };
    case 'reaction':
      return { ...comum, tipo: 'nao_suportado', texto: `[o cliente reagiu com ${m.reaction?.emoji ?? '…'}]`, semResposta: true };
    case 'order':
      return { ...comum, tipo: 'nao_suportado', texto: '[o cliente enviou um pedido do catálogo]' };
    case 'unsupported': default:
      return { ...comum, tipo: 'nao_suportado', texto: `[mensagem do tipo "${m.type}" que não conseguimos abrir]` };
  }
}

/** Baixa a mídia do cliente e guarda no disco. Falhar aqui não derruba o atendimento. */
async function guardarMidia(db, numero, mensagemId, midiaId) {
  try {
    const { buffer, mime, bytes } = await wa.baixarMidia(numero, midiaId);
    const arquivo = midia.guardar(buffer, mime);
    db.prepare('UPDATE mensagens SET midia_arquivo = ?, midia_mime = COALESCE(midia_mime, ?), midia_bytes = ? WHERE id = ?').run(arquivo, mime, bytes, mensagemId);
    return { arquivo, mime, bytes };
  } catch (err) {
    db.prepare('UPDATE mensagens SET erro = ? WHERE id = ?').run(`Falha ao baixar a mídia: ${String(err.message).slice(0, 200)}`, mensagemId);
    return null;
  }
}

/** Avisos de entrega e leitura: atualizam a mensagem que saiu. */
function aplicarStatus(db, statuses) {
  const ORDEM = { enviada: 1, entregue: 2, lida: 3 };
  const MAPA = { sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou' };
  let aplicados = 0;
  for (const s of statuses ?? []) {
    const novo = MAPA[s.status];
    if (!novo || !s.id) continue;
    const m = db.prepare('SELECT id, status FROM mensagens WHERE wa_id = ?').get(s.id);
    if (!m) continue;
    if (novo === 'falhou') {
      const e = (s.errors ?? [])[0] ?? {};
      db.prepare("UPDATE mensagens SET status = 'falhou', erro = ? WHERE id = ?")
        .run(String(e.title ?? e.message ?? e.error_data?.details ?? 'A Meta recusou a mensagem.').slice(0, 300), m.id);
    } else if ((ORDEM[novo] ?? 0) > (ORDEM[m.status] ?? 0)) {
      // Nunca volta atrás: 'lida' não vira 'entregue' por causa de um evento fora de ordem.
      db.prepare('UPDATE mensagens SET status = ? WHERE id = ?').run(novo, m.id);
    }
    aplicados++;
  }
  return aplicados;
}

/** Já processamos este evento? Marca como visto e devolve false na segunda vez. */
function primeiraVez(db, waId) {
  if (!waId) return true;
  const r = db.prepare('INSERT OR IGNORE INTO webhook_vistos (wa_id, criado_em) VALUES (?, ?)').run(waId, agora());
  return Number(r.changes) > 0;
}

/**
 * Processa uma mensagem recebida: grava, marca como lida, baixa a mídia e chama a ZOE.
 * Devolve { conversa_id, acao } — o que o atendimento fez.
 */
async function receberMensagem(db, { numero, empresa, mensagem, perfil }) {
  const dados = interpretar(mensagem);
  if (!primeiraVez(db, dados.waId)) return { repetida: true };

  const telefone = String(mensagem.from ?? '').replace(/\D/g, '');
  if (!telefone) return { ignorada: 'mensagem sem remetente' };

  // Mostra "digitando…" e marca como lida antes de pensar: o cliente vê que chegou.
  wa.marcarLida(numero, dados.waId, { digitando: true }).catch(() => {});

  const preparo = transacao(db, () => {
    const contato = conversas.garantirContato(db, empresa.id, telefone, perfil?.profile?.name ?? null);

    // A mensagem é só a nota do CSAT da conversa que acabou de encerrar? Então não abre conversa nova.
    if (dados.tipo === 'texto' || dados.tipo === 'botao') {
      const csat = conversas.tentarCsat(db, contato, dados.texto);
      if (csat) {
        conversas.registrarEntrada(db, csat.conversa, dados);
        return { csat: csat.nota, conversa: csat.conversa, contato };
      }
    }

    const conversa = conversas.abrirOuRetomar(db, { empresa, numero, contato });
    conversas.tocarJanela(db, conversa, dados.criadaEm);
    const mensagemId = conversas.registrarEntrada(db, conversa, dados);
    // Comentário escrito depois da nota do CSAT.
    if (conversa.estado === 'encerrada') conversas.registrarComentarioCsat(db, conversa, dados.texto);
    return { conversa: db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id), contato, mensagemId };
  });

  if (preparo.csat) {
    envio.girar(db);
    return { conversa_id: preparo.conversa.id, acao: 'csat', detalhe: `nota ${preparo.csat}` };
  }
  if (!preparo.mensagemId) return { repetida: true, conversa_id: preparo.conversa.id };

  if (dados.midiaId) await guardarMidia(db, numero, preparo.mensagemId, dados.midiaId);

  let resultado = { acao: 'sem_resposta' };
  if (!dados.semResposta) {
    const mensagemGravada = db.prepare('SELECT * FROM mensagens WHERE id = ?').get(preparo.mensagemId);
    resultado = await atender(db, {
      empresa, numero, contato: preparo.contato,
      conversa: db.prepare('SELECT * FROM conversas WHERE id = ?').get(preparo.conversa.id),
      mensagem: mensagemGravada, idResposta: dados.idResposta ?? null,
    });
  }
  envio.girar(db);
  return { conversa_id: preparo.conversa.id, ...resultado };
}

/**
 * Trata o corpo inteiro do webhook. Devolve o relatório do que foi feito (útil nos testes e no diagnóstico).
 * Um erro numa mensagem não impede as outras.
 */
async function processar(db, corpo, { numeroPorPhoneId }) {
  const feitos = [];
  for (const entry of corpo?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const valor = change.value ?? {};
      const phoneId = valor.metadata?.phone_number_id;
      const alvo = phoneId ? numeroPorPhoneId(phoneId) : null;
      if (!alvo) { feitos.push({ erro: 'número não cadastrado nesta plataforma', phone_number_id: phoneId ?? null }); continue; }
      const { numero, empresa } = alvo;
      db.prepare('UPDATE numeros SET ultimo_evento_em = ? WHERE id = ?').run(agora(), numero.id);

      if (valor.statuses?.length) feitos.push({ statuses: aplicarStatus(db, valor.statuses) });

      for (const m of valor.messages ?? []) {
        const perfil = (valor.contacts ?? []).find((c) => c.wa_id === m.from) ?? null;
        try {
          feitos.push(await receberMensagem(db, { numero, empresa, mensagem: m, perfil }));
        } catch (err) {
          console.error('[ZOE Atende] Falha ao tratar a mensagem recebida:', err);
          feitos.push({ erro: err.message, wa_id: m.id ?? null });
        }
      }
    }
  }
  return feitos;
}

module.exports = { processar, receberMensagem, interpretar, aplicarStatus, primeiraVez, guardarMidia };
