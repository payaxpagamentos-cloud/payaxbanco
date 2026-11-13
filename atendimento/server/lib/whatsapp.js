'use strict';

const config = require('../config');
const { decifrar } = require('./cifra');
const { ErroNegocio } = require('./erros');

/**
 * Cliente da WhatsApp Business Cloud API (Meta). Cada empresa tem o seu número, com o próprio
 * token e segredo do app guardados cifrados em `numeros`.
 *
 * Regras da plataforma da Meta que o código respeita:
 * - Mensagem livre só dentro da janela de 24 h desde a última mensagem do cliente; fora dela, só template aprovado.
 * - Toda mensagem recebida é marcada como lida (e mostra "digitando" enquanto a atendente pensa).
 * - A mídia do cliente é baixada com o token e guardada no disco: a URL da Meta expira em minutos.
 */

// Erros em que insistir não resolve: a mensagem é marcada como falha na hora.
const DEFINITIVOS = new Set([
  131047, // passaram-se mais de 24 h desde a última mensagem do cliente (precisa de template)
  131026, // número não existe no WhatsApp ou não pode receber
  131031, // conta bloqueada pela Meta
  131051, // tipo de mensagem não suportado
  132000, 132001, 132005, 132007, 132012, 132015, 132068, 132069, // problemas no template
  133010, // número não registrado
  131008, // parâmetro obrigatório ausente
]);

class ErroWhatsApp extends Error {
  constructor(mensagem, { codigo = null, subcodigo = null, status = null, definitivo = false } = {}) {
    super(mensagem);
    this.codigo = codigo;
    this.subcodigo = subcodigo;
    this.statusHttp = status;
    this.definitivo = definitivo;
  }
}

const base = () => `${config.whatsapp.graph}/${config.whatsapp.versao}`;

/** Token do número, decifrado. Sem token, o número não envia nem recebe mídia. */
function tokenDe(numero) {
  const t = decifrar(numero?.token_cifrado, 'whatsapp');
  if (!t) throw new ErroWhatsApp('Número sem token da Cloud API configurado.', { definitivo: true });
  return t;
}

const segredoApp = (numero) => decifrar(numero?.app_secret_cifrado, 'whatsapp');

/** A Meta às vezes devolve o token dentro da mensagem de erro: nunca guardamos isso no banco. */
const mascarar = (texto, token) => {
  const t = token ? String(texto ?? '').split(String(token)).join('***') : String(texto ?? '');
  // Qualquer coisa com cara de token de acesso da Meta também sai mascarada.
  return t.replace(/\bEAA[A-Za-z0-9_-]{10,}/g, '***');
};

async function chamar(url, { metodo = 'POST', token, corpo = null, aceitaBinario = false } = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(config.whatsapp.timeoutMs),
    });
  } catch (err) {
    // Rede: vale tentar de novo depois.
    throw new ErroWhatsApp(err.name === 'TimeoutError' ? 'A Meta não respondeu no tempo esperado.' : `Falha de rede ao falar com a Meta: ${err.message}`);
  }
  if (aceitaBinario && resp.ok) return resp;
  const texto = await resp.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { /* resposta sem JSON */ }
  if (!resp.ok) {
    const e = dados?.error ?? {};
    const codigo = Number(e.code) || null;
    throw new ErroWhatsApp(
      mascarar(e.error_user_msg || e.message || `A Meta respondeu ${resp.status}.`, token),
      { codigo, subcodigo: Number(e.error_subcode) || null, status: resp.status, definitivo: (codigo && DEFINITIVOS.has(codigo)) || (resp.status >= 400 && resp.status < 500 && resp.status !== 429) },
    );
  }
  return dados;
}

const endpointMensagens = (numero) => `${base()}/${encodeURIComponent(numero.phone_number_id)}/messages`;

/** Envia e devolve o id da mensagem na Meta (wa_id), usado para casar os avisos de entrega e leitura. */
async function enviar(numero, corpo) {
  const r = await chamar(endpointMensagens(numero), { token: tokenDe(numero), corpo: { messaging_product: 'whatsapp', ...corpo } });
  return r?.messages?.[0]?.id ?? null;
}

const texto = (para, corpo, { responde = null } = {}) => ({
  recipient_type: 'individual', to: para, type: 'text',
  text: { body: String(corpo).slice(0, 4096), preview_url: false },
  ...(responde ? { context: { message_id: responde } } : {}),
});

/** Mensagem com até 3 botões de resposta rápida (menu de atendimento). */
const botoes = (para, corpo, opcoes, { rodape = null } = {}) => ({
  recipient_type: 'individual', to: para, type: 'interactive',
  interactive: {
    type: 'button',
    body: { text: String(corpo).slice(0, 1024) },
    ...(rodape ? { footer: { text: String(rodape).slice(0, 60) } } : {}),
    action: { buttons: opcoes.slice(0, 3).map((o) => ({ type: 'reply', reply: { id: String(o.id).slice(0, 256), title: String(o.titulo).slice(0, 20) } })) },
  },
});

/** Lista de opções (até 10): usada no menu quando há mais de 3 caminhos. */
const listaOpcoes = (para, corpo, tituloBotao, itens) => ({
  recipient_type: 'individual', to: para, type: 'interactive',
  interactive: {
    type: 'list',
    body: { text: String(corpo).slice(0, 1024) },
    action: {
      button: String(tituloBotao).slice(0, 20),
      sections: [{ rows: itens.slice(0, 10).map((i) => ({ id: String(i.id).slice(0, 200), title: String(i.titulo).slice(0, 24), ...(i.descricao ? { description: String(i.descricao).slice(0, 72) } : {}) })) }],
    },
  },
});

/** Template aprovado: o único jeito de falar com o cliente fora da janela de 24 h. */
const template = (para, nome, idioma = 'pt_BR', parametros = []) => ({
  recipient_type: 'individual', to: para, type: 'template',
  template: {
    name: nome,
    language: { code: idioma },
    ...(parametros.length ? { components: [{ type: 'body', parameters: parametros.map((p) => ({ type: 'text', text: String(p) })) }] } : {}),
  },
});

const TIPOS_MIDIA = { imagem: 'image', audio: 'audio', video: 'video', documento: 'document', figurinha: 'sticker' };
/** Mídia por link público ou por id já enviado à Meta. */
function midia(para, tipo, { link = null, id = null, legenda = null, nome = null }) {
  const t = TIPOS_MIDIA[tipo];
  if (!t) throw new ErroWhatsApp(`Tipo de mídia não suportado: ${tipo}.`, { definitivo: true });
  const corpo = { ...(link ? { link } : { id }) };
  if (legenda && t !== 'audio' && t !== 'sticker') corpo.caption = String(legenda).slice(0, 1024);
  if (nome && t === 'document') corpo.filename = String(nome).slice(0, 240);
  return { recipient_type: 'individual', to: para, type: t, [t]: corpo };
}

/**
 * Marca a mensagem do cliente como lida e, se pedido, mostra "digitando…" (vale ~25 s na Meta).
 * Não é crítico: uma falha aqui não impede a resposta.
 */
async function marcarLida(numero, waId, { digitando = false } = {}) {
  try {
    await chamar(endpointMensagens(numero), {
      token: tokenDe(numero),
      corpo: { messaging_product: 'whatsapp', status: 'read', message_id: waId, ...(digitando ? { typing_indicator: { type: 'text' } } : {}) },
    });
    return true;
  } catch {
    return false;
  }
}

/** Dados da mídia (URL temporária, mime e tamanho). */
const infoMidia = (numero, midiaId) => chamar(`${base()}/${encodeURIComponent(midiaId)}`, { metodo: 'GET', token: tokenDe(numero) });

/** Baixa a mídia do cliente. Devolve { buffer, mime, bytes }. Recusa acima do limite configurado. */
async function baixarMidia(numero, midiaId) {
  const info = await infoMidia(numero, midiaId);
  if (!info?.url) throw new ErroWhatsApp('A Meta não informou o endereço da mídia.', { definitivo: true });
  const limite = config.arquivoMaxMb * 1024 * 1024;
  if (Number(info.file_size) > limite) throw new ErroWhatsApp(`Arquivo acima de ${config.arquivoMaxMb} MB.`, { definitivo: true });
  const resp = await chamar(info.url, { metodo: 'GET', token: tokenDe(numero), aceitaBinario: true });
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > limite) throw new ErroWhatsApp(`Arquivo acima de ${config.arquivoMaxMb} MB.`, { definitivo: true });
  return { buffer, mime: info.mime_type || resp.headers.get('content-type') || 'application/octet-stream', bytes: buffer.length };
}

/** Situação do número na Meta: confirma que o token e o phone_number_id funcionam. */
async function situacao(numero) {
  if (!numero) return { configurado: false, ok: false, estado: 'sem número cadastrado' };
  if (!decifrar(numero.token_cifrado, 'whatsapp')) return { configurado: false, ok: false, estado: 'sem token' };
  try {
    const r = await chamar(`${base()}/${encodeURIComponent(numero.phone_number_id)}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`,
      { metodo: 'GET', token: tokenDe(numero) });
    return {
      configurado: true, ok: true, estado: 'conectado',
      telefone: r?.display_phone_number ?? null, nome_verificado: r?.verified_name ?? null,
      qualidade: r?.quality_rating ?? null, verificacao: r?.code_verification_status ?? null,
    };
  } catch (err) {
    return { configurado: true, ok: false, estado: 'erro', erro: err.message, codigo: err.codigo ?? null };
  }
}

/** A janela de 24 h está aberta? Fora dela só vai template. */
const janelaAberta = (conversa) => Boolean(conversa?.janela_expira_em && Date.parse(conversa.janela_expira_em) > Date.now());

/** Valida a assinatura do webhook (X-Hub-Signature-256) sobre o corpo cru, com o segredo do app. */
function assinaturaValida(numero, cabecalho, corpoCru) {
  const segredo = segredoApp(numero);
  // Sem segredo cadastrado não há o que conferir: o número fica recusando até alguém configurar.
  if (!segredo) return false;
  const recebida = String(cabecalho ?? '');
  if (!recebida.startsWith('sha256=')) return false;
  const crypto = require('node:crypto');
  const esperada = `sha256=${crypto.createHmac('sha256', segredo).update(corpoCru).digest('hex')}`;
  const a = Buffer.from(esperada);
  const b = Buffer.from(recebida);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Erro de negócio pronto para a API do painel (mantém a mensagem da Meta, que costuma ser clara). */
const comoErroNegocio = (err) => new ErroNegocio(err instanceof ErroWhatsApp ? err.message : 'Falha ao falar com o WhatsApp.', 502);

module.exports = {
  ErroWhatsApp, enviar, marcarLida, baixarMidia, infoMidia, situacao, janelaAberta, assinaturaValida, segredoApp, tokenDe, comoErroNegocio, mascarar,
  corpos: { texto, botoes, listaOpcoes, template, midia }, TIPOS_MIDIA,
};
