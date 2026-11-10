'use strict';

/*
 * Contabilidade RADIUS (RFC 2866) e sessões dos assinantes.
 *
 * O BRAS envia uma CÓPIA do accounting para o Manager Network (servidor de accounting adicional). Cada pacote é conferido
 * pelo segredo do NAS (Request Authenticator) e respondido com Accounting-Response, como exige o protocolo; nada é enviado
 * ao BRAS além dessa confirmação. Quem não puder apontar o BRAS pode mandar os eventos pela API (POST /api/coletor/sessoes).
 *
 * bytes_entrada = download do assinante (Acct-Output-Octets); bytes_saida = upload (Acct-Input-Octets).
 */

const crypto = require('node:crypto');
const { agora } = require('../db');
const { lerIp, lerPrefixo, ipTexto } = require('./ip');

const ATR = { USER_NAME: 1, NAS_IP: 4, NAS_PORT: 5, FRAMED_IP: 8, CALLING_STATION: 31, NAS_IDENTIFIER: 32, STATUS_TYPE: 40, INPUT_OCTETS: 42,
  OUTPUT_OCTETS: 43, SESSION_ID: 44, SESSION_TIME: 46, TERMINATE_CAUSE: 49, INPUT_GIGA: 52, OUTPUT_GIGA: 53, NAS_PORT_ID: 87, FRAMED_IPV6_PREFIX: 97,
  DELEGATED_IPV6_PREFIX: 123 };
const STATUS = { 1: 'inicio', 2: 'fim', 3: 'atualizacao', 7: 'accounting_on', 8: 'accounting_off' };
const CAUSAS = { 1: 'Pedido do usuário', 2: 'Perda de portadora', 3: 'Perda de serviço', 4: 'Tempo ocioso', 5: 'Tempo de sessão', 6: 'Reset pelo administrador',
  7: 'Reboot pelo administrador', 8: 'Erro de porta', 9: 'Erro do NAS', 10: 'Pedido do NAS', 11: 'Reboot do NAS', 12: 'Porta desnecessária', 15: 'Serviço indisponível',
  17: 'Usuário erro', 18: 'Host request' };

function prefixoV6(v) {
  if (v.length < 2) return null;
  const len = v[1];
  const b = Buffer.alloc(16);
  v.copy(b, 0, 2, Math.min(v.length, 18));
  const n = (b.readBigUInt64BE(0) << 64n) | b.readBigUInt64BE(8);
  return `${ipTexto(6, n)}/${len}`;
}

/** Lê o pacote. Devolve { codigo, id, autenticador, atributos: Map(tipo → [Buffer]) } ou lança erro. */
function lerPacote(buf) {
  if (buf.length < 20) throw new Error('pacote RADIUS curto');
  const tam = buf.readUInt16BE(2);
  if (tam < 20 || tam > buf.length) throw new Error('tamanho RADIUS inválido');
  const atributos = new Map();
  let p = 20;
  while (p + 2 <= tam) {
    const t = buf[p];
    const l = buf[p + 1];
    if (l < 2 || p + l > tam) throw new Error('atributo RADIUS inválido');
    if (!atributos.has(t)) atributos.set(t, []);
    atributos.get(t).push(buf.subarray(p + 2, p + l));
    p += l;
  }
  return { codigo: buf[0], id: buf[1], tam, autenticador: buf.subarray(4, 20), atributos };
}

/** Confere o Request Authenticator do Accounting-Request: MD5(código+id+tamanho+16 zeros+atributos+segredo). */
function conferir(buf, segredo) {
  const tam = buf.readUInt16BE(2);
  const copia = Buffer.from(buf.subarray(0, tam));
  copia.fill(0, 4, 20);
  const esperado = crypto.createHash('md5').update(copia).update(segredo).digest();
  return crypto.timingSafeEqual(esperado, buf.subarray(4, 20));
}

/** Accounting-Response (código 5) para o pedido. */
function resposta(pedido, segredo) {
  const r = Buffer.alloc(20);
  r[0] = 5;
  r[1] = pedido[1];
  r.writeUInt16BE(20, 2);
  pedido.copy(r, 4, 4, 20);
  const aut = crypto.createHash('md5').update(r).update(segredo).digest();
  aut.copy(r, 4);
  return r;
}

/** Monta um Accounting-Request (usado pelos testes e pelo simulador). */
function montarPedido({ id = 1, atributos }, segredo) {
  const partes = [];
  const add = (t, v) => { partes.push(Buffer.concat([Buffer.from([t, v.length + 2]), v])); };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
  for (const [t, v] of atributos) {
    if (typeof v === 'number') add(t, u32(v));
    else if (Buffer.isBuffer(v)) add(t, v);
    else if (t === ATR.FRAMED_IP || t === ATR.NAS_IP) add(t, u32(lerIp(v).n));
    else if (t === ATR.FRAMED_IPV6_PREFIX || t === ATR.DELEGATED_IPV6_PREFIX) {
      const p = lerPrefixo(v);
      const b = Buffer.alloc(18);
      b[1] = p.len;
      b.writeBigUInt64BE(p.rede >> 64n, 2);
      b.writeBigUInt64BE(p.rede & 0xffffffffffffffffn, 10);
      add(t, b);
    } else add(t, Buffer.from(String(v)));
  }
  const corpo = Buffer.concat(partes);
  const h = Buffer.alloc(20);
  h[0] = 4;
  h[1] = id;
  h.writeUInt16BE(20 + corpo.length, 2);
  const pacote = Buffer.concat([h, corpo]);
  crypto.createHash('md5').update(pacote).update(segredo).digest().copy(pacote, 4);
  return pacote;
}

/** Pacote → evento de sessão no formato da API. */
function evento(pkt, nasIpOrigem) {
  const a = pkt.atributos;
  const txt = (t) => (a.get(t)?.[0] ? a.get(t)[0].toString('utf8') : null);
  const u32 = (t) => (a.get(t)?.[0]?.length === 4 ? a.get(t)[0].readUInt32BE(0) : null);
  const tipo = STATUS[u32(ATR.STATUS_TYPE)];
  const giga = (t) => (u32(t) ?? 0) * 2 ** 32;
  const tempo = u32(ATR.SESSION_TIME);
  const ip = u32(ATR.FRAMED_IP);
  return {
    tipo,
    login: txt(ATR.USER_NAME),
    sessao_id: txt(ATR.SESSION_ID),
    ip: ip !== null ? ipTexto(4, ip) : null,
    ipv6_prefixo: a.get(ATR.FRAMED_IPV6_PREFIX)?.[0] ? prefixoV6(a.get(ATR.FRAMED_IPV6_PREFIX)[0]) : null,
    ipv6_delegado: a.get(ATR.DELEGATED_IPV6_PREFIX)?.[0] ? prefixoV6(a.get(ATR.DELEGATED_IPV6_PREFIX)[0]) : null,
    nas_ip: u32(ATR.NAS_IP) !== null ? ipTexto(4, u32(ATR.NAS_IP)) : nasIpOrigem,
    mac: txt(ATR.CALLING_STATION),
    nas_porta: txt(ATR.NAS_PORT_ID) ?? (u32(ATR.NAS_PORT) !== null ? String(u32(ATR.NAS_PORT)) : null),
    bytes_saida: (u32(ATR.INPUT_OCTETS) ?? 0) + giga(ATR.INPUT_GIGA),
    bytes_entrada: (u32(ATR.OUTPUT_OCTETS) ?? 0) + giga(ATR.OUTPUT_GIGA),
    tempo_s: tempo,
    motivo_fim: CAUSAS[u32(ATR.TERMINATE_CAUSE)] ?? (u32(ATR.TERMINATE_CAUSE) !== null ? `Causa ${u32(ATR.TERMINATE_CAUSE)}` : null),
  };
}

/**
 * Aplica um evento de sessão (do RADIUS ou da API). tipo: inicio | atualizacao | fim | accounting_on | accounting_off.
 * Accounting-On/Off (NAS reiniciou) encerra as sessões abertas daquele NAS. Um IP entregue a outra sessão encerra a anterior
 * que ficou sem Stop, para que o histórico "quem usou este IP" não tenha duas sessões ao mesmo tempo.
 */
function registrarSessao(db, org, e, fonte, em = agora()) {
  if (e.tipo === 'accounting_on' || e.tipo === 'accounting_off') {
    return { fechadas: db.prepare("UPDATE sessoes_assinantes SET fim = ?, motivo_fim = 'NAS reiniciado (Accounting-On/Off)' WHERE organizacao_id = ? AND nas_ip = ? AND fim IS NULL")
      .run(em, org, e.nas_ip).changes };
  }
  if (!e.login || !e.sessao_id || !e.nas_ip) throw new Error('evento sem login, sessão ou NAS');
  const inicio = e.tempo_s !== null && e.tempo_s !== undefined ? new Date(Date.parse(em) - e.tempo_s * 1000).toISOString() : em;
  const atual = db.prepare('SELECT * FROM sessoes_assinantes WHERE organizacao_id = ? AND nas_ip = ? AND sessao_id = ?').get(org, e.nas_ip, e.sessao_id);
  if (e.ip && (!atual || atual.ip !== e.ip)) {
    db.prepare(`UPDATE sessoes_assinantes SET fim = ?, motivo_fim = 'IP entregue a outra sessão (sem Stop)' WHERE organizacao_id = ? AND ip = ? AND fim IS NULL
      AND NOT (nas_ip = ? AND sessao_id = ?)`).run(inicio, org, e.ip, e.nas_ip, e.sessao_id);
  }
  if (!atual) {
    db.prepare(`INSERT INTO sessoes_assinantes (organizacao_id, login, ip, ipv6_prefixo, ipv6_delegado, nas_ip, sessao_id, mac, nas_porta, inicio, fim, ultima_atualizacao,
      bytes_entrada, bytes_saida, motivo_fim, fonte) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(org, e.login, e.ip ?? null, e.ipv6_prefixo ?? null,
      e.ipv6_delegado ?? null, e.nas_ip, e.sessao_id, e.mac ?? null, e.nas_porta ?? null, inicio, e.tipo === 'fim' ? em : null, em, e.bytes_entrada ?? 0, e.bytes_saida ?? 0,
      e.tipo === 'fim' ? e.motivo_fim ?? null : null, fonte);
    return { acao: 'criada' };
  }
  if (atual.fim && e.tipo !== 'fim') return { acao: 'ignorada' }; // evento atrasado de sessão já encerrada
  db.prepare(`UPDATE sessoes_assinantes SET login = ?, ip = COALESCE(?, ip), ipv6_prefixo = COALESCE(?, ipv6_prefixo), ipv6_delegado = COALESCE(?, ipv6_delegado),
    mac = COALESCE(?, mac), nas_porta = COALESCE(?, nas_porta), ultima_atualizacao = ?, bytes_entrada = MAX(bytes_entrada, ?), bytes_saida = MAX(bytes_saida, ?),
    fim = CASE WHEN ? THEN COALESCE(fim, ?) ELSE fim END, motivo_fim = CASE WHEN ? THEN COALESCE(?, motivo_fim) ELSE motivo_fim END WHERE id = ?`)
    .run(e.login, e.ip ?? null, e.ipv6_prefixo ?? null, e.ipv6_delegado ?? null, e.mac ?? null, e.nas_porta ?? null, em, e.bytes_entrada ?? 0, e.bytes_saida ?? 0,
      e.tipo === 'fim' ? 1 : 0, em, e.tipo === 'fim' ? 1 : 0, e.motivo_fim ?? null, atual.id);
  return { acao: e.tipo === 'fim' ? 'encerrada' : 'atualizada' };
}

/** Quem estava com o IP no instante (sessão que começou antes e não tinha terminado). */
function loginNoInstante(db, org, ip, instante = agora()) {
  return db.prepare(`SELECT login, nas_ip, inicio, fim, mac FROM sessoes_assinantes WHERE organizacao_id = ? AND ip = ? AND inicio <= ? AND (fim IS NULL OR fim >= ?)
    ORDER BY inicio DESC LIMIT 1`).get(org, ip, instante, instante) ?? null;
}

module.exports = { ATR, STATUS, lerPacote, conferir, resposta, montarPedido, evento, registrarSessao, loginNoInstante };
