'use strict';

/*
 * SMS: avisos curtos ao cliente (ex.: o protocolo do pedido de abertura de conta, no celular do responsável
 * financeiro). A operadora é contratada pela PAY AX e configurada em Integrações → SMS; o token fica cifrado.
 *
 * Operadoras aceitas:
 *   - API Brasil (padrão): POST /api/v2/sms/send/credits com o mesmo Bearer Token da consulta de CNPJ.
 *     O erro pode vir com HTTP 200 (campo "error" do corpo); 402 é saldo insuficiente;
 *   - Zenvia (API v2): POST /v2/channels/sms/messages, cabeçalho X-API-TOKEN;
 *   - Twilio: POST /2010-04-01/Accounts/{SID}/Messages.json, autenticação básica (SID e token).
 *
 * Enviar SMS nunca derruba a operação que o pediu: o resultado (enviado, falha ou sem configuração) fica
 * registrado em sms_mensagens e pode ser reenviado pela tela.
 */
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const { decifrar } = require('./cripto');

const PROVEDORES = Object.freeze({ apibrasil: 'API Brasil', zenvia: 'Zenvia', twilio: 'Twilio' });

/** Celular brasileiro no formato +55DD9NNNNNNNN, ou null se não for celular. */
function celular(tel) {
  let d = String(tel ?? '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 11 && d[2] === '9' && d[0] !== '0' ? `+55${d}` : null;
}

/** "(11) 9****-7777": para tela e histórico, sem expor o número inteiro. */
const mascarar = (e164) => { const d = String(e164 ?? '').replace(/\D/g, '').slice(-11); return d.length === 11 ? `(${d.slice(0, 2)}) 9****-${d.slice(7)}` : '—'; };

/** Texto sem acento (cabe nos 160 caracteres de um SMS em qualquer operadora). */
const semAcento = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Operadora em uso. Sem configuração própria de SMS, usa a API Brasil com o token que já está em
 * Integrações → API Brasil (o mesmo token vale para toda a plataforma).
 */
function configuracao(db) {
  const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'sms' ORDER BY id LIMIT 1").get();
  if (i?.estado === 'desabilitada') return null;
  const cfg = i ? JSON.parse(i.config || '{}') : {};
  let cred = {};
  try { cred = i?.credenciais ? JSON.parse(decifrar(i.credenciais)) : {}; } catch { cred = {}; }
  const provedor = cfg.provedor || 'apibrasil';
  if (provedor === 'apibrasil') {
    const token = cred.token || require('./consultaDados').tokenApiBrasil(db);
    return token ? { id: i?.id ?? null, provedor, token } : null;
  }
  return cred.token ? { id: i.id, ...cfg, ...cred, conta_sid: cfg.conta_sid ?? cred.conta_sid } : null;
}

async function chamar(url, opcoes) {
  let r;
  try {
    r = await fetch(url, { ...opcoes, signal: AbortSignal.timeout(config.sms.timeoutMs) });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? 'a operadora de SMS não respondeu a tempo' : `sem conexão com a operadora de SMS (${err.message})`);
  }
  const texto = await r.text();
  let corpo = {};
  try { corpo = JSON.parse(texto); } catch { /* resposta sem JSON */ }
  if (!r.ok) {
    const motivo = corpo.message || corpo.error?.message || corpo.details?.[0]?.message || texto.slice(0, 160) || `erro ${r.status}`;
    throw new Error(`a operadora recusou (${r.status}): ${motivo}`);
  }
  return corpo;
}

/** Entrega o texto pela operadora configurada. Devolve o identificador da mensagem na operadora. */
async function entregar(cfg, destino, texto) {
  if (cfg.provedor === 'apibrasil') {
    let r;
    try {
      r = await chamar(config.sms.urlApiBrasil, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ number: destino.replace('+', ''), message: texto }),
      });
    } catch (err) {
      if (/\(402\)/.test(err.message)) throw new Error('saldo insuficiente na API Brasil: recarregue os créditos');
      throw err;
    }
    // A API Brasil pode responder erro com HTTP 200: vale o campo "error" e a situação da mensagem.
    const situacao = r.response?.data?.status ?? r.response?.status;
    if (r.error || (situacao && !['processed', 'success', 'sent', 'queued'].includes(String(situacao).toLowerCase()))) {
      throw new Error(`a API Brasil não enviou: ${r.message || r.response?.message || situacao || 'erro sem detalhe'}`);
    }
    return r.response?.data?.id ?? null;
  }
  if (cfg.provedor === 'zenvia') {
    const r = await chamar(config.sms.urlZenvia, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-TOKEN': cfg.token },
      body: JSON.stringify({ from: cfg.remetente, to: destino.replace('+', ''), contents: [{ type: 'text', text: texto }] }),
    });
    return r.id ?? null;
  }
  if (cfg.provedor === 'twilio') {
    const corpo = new URLSearchParams({ To: destino, Body: texto });
    if (/^MG[0-9a-f]{32}$/i.test(cfg.remetente)) corpo.set('MessagingServiceSid', cfg.remetente);
    else corpo.set('From', cfg.remetente);
    const r = await chamar(`${config.sms.urlTwilio}/Accounts/${encodeURIComponent(cfg.conta_sid)}/Messages.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${cfg.conta_sid}:${cfg.token}`).toString('base64')}` },
      body: corpo.toString(),
    });
    return r.sid ?? null;
  }
  throw new Error(`operadora de SMS desconhecida: ${cfg.provedor}`);
}

/**
 * Envia um SMS e registra o resultado. Nunca lança erro (devolve o registro): quem chama decide o que fazer.
 * `telefone` pode vir com máscara; se não for celular, nem tenta.
 */
async function enviar(db, { telefone, texto, finalidade, referenciaTipo = null, referenciaId = null }) {
  const destino = celular(telefone);
  const msg = semAcento(texto).slice(0, 160);
  const cfg = configuracao(db);
  let situacao = 'enviado';
  let erro = null;
  let idProvedor = null;
  if (!destino) { situacao = 'falha'; erro = 'o telefone informado não é um celular (DDD + 9 dígitos)'; }
  else if (!cfg) { situacao = 'nao_configurado'; erro = 'SMS não configurado (Integrações → SMS)'; }
  else {
    try { idProvedor = await entregar(cfg, destino, msg); } catch (err) { situacao = 'falha'; erro = err.message; }
  }
  const id = db.prepare(`INSERT INTO sms_mensagens (destino, texto, finalidade, referencia_tipo, referencia_id, provedor, situacao, id_provedor, erro, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(destino ?? String(telefone ?? ''), msg, finalidade, referenciaTipo, referenciaId, cfg?.provedor ?? null, situacao, idProvedor, erro, agora()).id;
  if (cfg?.id && destino) {
    db.prepare('UPDATE integracoes SET estado = ?, ultimo_teste = ?, ultimo_erro = ? WHERE id = ?')
      .run(situacao === 'enviado' ? 'conectada' : 'falha', agora(), erro, cfg.id);
  }
  return { id, situacao, erro, destino_mascarado: mascarar(destino), id_provedor: idProvedor };
}

/** Lê a configuração vinda da tela (operadora, token, SID e remetente). */
function lerConfiguracao(b = {}) {
  const provedor = String(b.provedor ?? '');
  if (!PROVEDORES[provedor]) throw new ErroNegocio('Escolha a operadora de SMS (API Brasil, Zenvia ou Twilio).', 422);
  // API Brasil: sem remetente; o token é opcional (sem ele, usa o da consulta de CNPJ).
  if (provedor === 'apibrasil') {
    const token = String(b.token ?? '').trim();
    return { cfg: { provedor }, credenciais: token ? { token } : null, limpar: !token };
  }
  const remetente = String(b.remetente ?? '').trim();
  if (!remetente || remetente.length > 40) throw new ErroNegocio(provedor === 'zenvia'
    ? 'Informe o remetente cadastrado na Zenvia (o "from" do canal de SMS).'
    : 'Informe o número de envio da Twilio (+55...) ou o Messaging Service SID (MG...).', 422);
  const token = String(b.token ?? '').trim();
  const contaSid = String(b.conta_sid ?? '').trim();
  if (provedor === 'twilio' && !/^AC[0-9a-f]{32}$/i.test(contaSid)) throw new ErroNegocio('Informe o Account SID da Twilio (começa com AC).', 422);
  // O Account SID não é segredo: fica na configuração (trocar só o SID não exige redigitar o token).
  return { cfg: { provedor, remetente, ...(provedor === 'twilio' ? { conta_sid: contaSid } : {}) }, credenciais: token ? { token } : null };
}

module.exports = { PROVEDORES, celular, mascarar, semAcento, configuracao, enviar, lerConfiguracao };
