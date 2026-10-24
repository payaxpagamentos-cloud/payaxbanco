'use strict';

const net = require('node:net');
const { receber } = require('./posicoes');
const com = require('./comandos');

/**
 * Protocolo GT06 (Concox e compatíveis: GT06, GT06N, J16, ST-901 e muitos outros), por TCP.
 * Quadro: 78 78 | tamanho (1) | protocolo (1) | conteúdo | serial (2) | CRC-ITU (2) | 0D 0A  (ou 79 79 com o tamanho em 2 bytes).
 */
const P = { LOGIN: 0x01, GPS: 0x12, STATUS: 0x13, RESPOSTA: 0x15, ALARME: 0x16, RESPOSTA2: 0x21, GPS2: 0x22, HEARTBEAT: 0x23, ALARME2: 0x26, COMANDO: 0x80, HORA: 0x8a };
// Alarmes do quadro de alarme que viram alerta.
const ALARMES = { 0x01: 'panico', 0x02: 'bateria_desconectada', 0x0e: 'bateria_baixa', 0x0f: 'bateria_baixa', 0x19: 'bateria_baixa', 0x13: 'violacao' };
// Alarme do byte de estado (bits 3 a 5).
const ALARMES_ESTADO = { 4: 'panico', 3: 'bateria_baixa', 2: 'bateria_desconectada' };
// Tensão aproximada de cada nível de bateria informado (0 a 6), em volts da bateria interna.
const NIVEL_TENSAO = [0, 3.4, 3.6, 3.7, 3.8, 3.9, 4.1];
const TAMANHO_MAX_BUFFER = 64 * 1024;

/** CRC-ITU (CRC-16/X-25), como o protocolo especifica. */
function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return ~crc & 0xffff;
}

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };

/** Monta um quadro 78 78 com o conteúdo e o serial informados. */
function quadro(protocolo, conteudo, serial) {
  const corpo = Buffer.concat([Buffer.from([conteudo.length + 5, protocolo]), conteudo, u16(serial)]);
  return Buffer.concat([Buffer.from([0x78, 0x78]), corpo, u16(crc16(corpo)), Buffer.from([0x0d, 0x0a])]);
}

/** Separa os quadros completos do que chegou pela conexão. Bytes inválidos são pulados até o próximo início de quadro. */
function extrair(buf) {
  const quadros = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const longo = buf[i] === 0x79 && buf[i + 1] === 0x79;
    if (!longo && !(buf[i] === 0x78 && buf[i + 1] === 0x78)) { i++; continue; }
    const tamanho = longo ? buf.readUInt16BE(i + 2) : buf[i + 2];
    const cab = longo ? 4 : 3;
    const total = cab + tamanho + 2;
    if (tamanho < 5) { i++; continue; }
    if (i + total > buf.length) break;
    const fimOk = buf[i + total - 2] === 0x0d && buf[i + total - 1] === 0x0a;
    const corpo = buf.subarray(i + 2, i + cab + tamanho - 2);
    if (!fimOk || crc16(corpo) !== buf.readUInt16BE(i + cab + tamanho - 2)) { i++; continue; }
    quadros.push({
      protocolo: buf[i + cab],
      conteudo: buf.subarray(i + cab + 1, i + cab + tamanho - 4),
      serial: buf.readUInt16BE(i + cab + tamanho - 4),
    });
    i += total;
  }
  return { quadros, resto: buf.subarray(i) };
}

/** Data e posição GPS (18 bytes a partir de `o`). */
function lerGps(c, o = 0) {
  const gpsEm = new Date(Date.UTC(2000 + c[o], c[o + 1] - 1, c[o + 2], c[o + 3], c[o + 4], c[o + 5])).toISOString();
  let lat = c.readUInt32BE(o + 7) / 1_800_000;
  let lng = c.readUInt32BE(o + 11) / 1_800_000;
  const flags = c.readUInt16BE(o + 16);
  if (!(flags & 0x0400)) lat = -lat;
  if (flags & 0x0800) lng = -lng;
  return {
    gps_em: gpsEm, satelites: c[o + 6] & 0x0f, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), velocidade_kmh: c[o + 15],
    curso: flags & 0x03ff, valido: Boolean(flags & 0x1000),
  };
}

/** Byte de estado do terminal: ignição (ACC), corte de combustível e alarme. */
function lerEstado(info) {
  return { ignicao: Boolean(info & 0x02), bloqueado: Boolean(info & 0x80), evento: ALARMES_ESTADO[(info >> 3) & 0x07] ?? null };
}

/**
 * Traduz um quadro em { tipo, ... }: login (imei), posicao (mensagem para receber()), estado, resposta (de comando) ou hora.
 * Devolve também se o quadro pede confirmação (ack).
 */
function decodificar(q) {
  const c = q.conteudo;
  switch (q.protocolo) {
    case P.LOGIN: {
      const hex = c.subarray(0, 8).toString('hex');
      return { tipo: 'login', imei: hex.replace(/^0/, ''), ack: true };
    }
    case P.GPS:
    case P.GPS2: {
      const m = lerGps(c);
      // GT06 de modelo mais novo (0x22): depois do LBS (8 bytes) vem a ignição (ACC).
      if (q.protocolo === P.GPS2 && c.length > 26) m.ignicao = c[26] === 1;
      return { tipo: 'posicao', mensagem: m, ack: false };
    }
    case P.STATUS:
    case P.HEARTBEAT: {
      const e = lerEstado(c[0]);
      return { tipo: 'estado', mensagem: { ...e, tensao: NIVEL_TENSAO[c[1]] ?? null }, ack: true };
    }
    case P.ALARME:
    case P.ALARME2: {
      const m = lerGps(c);
      // Depois do GPS: o LBS (o primeiro byte é o tamanho dele, com o próprio byte), estado do terminal, nível da bateria, sinal GSM e o alarme.
      const o = 18 + (c[18] || 9);
      if (c.length > o + 3) {
        const e = lerEstado(c[o]);
        Object.assign(m, { ignicao: e.ignicao, bloqueado: e.bloqueado, tensao: NIVEL_TENSAO[c[o + 1]] ?? null, evento: ALARMES[c[o + 3]] ?? e.evento });
      }
      return { tipo: 'posicao', mensagem: m, ack: true };
    }
    case P.RESPOSTA: {
      const n = c[0];
      return { tipo: 'resposta', comando: c.readUInt32BE(1), texto: c.subarray(5, 1 + n).toString('latin1').trim(), ack: false };
    }
    case P.RESPOSTA2:
      return { tipo: 'resposta', comando: c.readUInt32BE(0), texto: c.subarray(5).toString(c[4] === 1 ? 'utf16le' : 'latin1').trim(), ack: false };
    case P.HORA:
      return { tipo: 'hora', ack: false };
    default:
      return { tipo: 'outro', ack: false };
  }
}

/** Quadro de comando (0x80): tamanho, identificador do comando (para casar com a resposta), texto e idioma (inglês). */
function quadroComando(id, texto, serial) {
  const t = Buffer.from(texto, 'latin1');
  const flag = Buffer.alloc(4);
  flag.writeUInt32BE(id >>> 0);
  return quadro(P.COMANDO, Buffer.concat([Buffer.from([4 + t.length]), flag, t, Buffer.from([0x00, 0x02])]), serial);
}

function quadroHora(serial) {
  const d = new Date();
  return quadro(P.HORA, Buffer.from([d.getUTCFullYear() - 2000, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]), serial);
}

/**
 * Servidor TCP dos rastreadores GT06. Cada conexão se identifica pelo login (IMEI); as posições, estados e alarmes vão para receber().
 * Comandos pendentes são entregues no login e assim que são criados, se o equipamento estiver conectado.
 */
function iniciarGt06(db, porta, { host } = {}) {
  const conexoes = new Map();

  function entregar(imei) {
    const cx = conexoes.get(imei);
    if (!cx) return;
    const r = db.prepare('SELECT id FROM rastreadores WHERE imei = ?').get(imei);
    if (!r) return;
    for (const c of com.pendentes(db, r.id)) {
      cx.serial = (cx.serial + 1) & 0xffff;
      cx.socket.write(quadroComando(c.id, c.texto, cx.serial));
      com.marcarEnviado(db, c.id);
    }
  }

  const servidor = net.createServer((socket) => {
    const cx = { socket, imei: null, serial: 0 };
    let buf = Buffer.alloc(0);
    // Sem login em 1 minuto, ou sem mensagem por 15 minutos, a conexão cai (o equipamento reconecta sozinho).
    const semLogin = setTimeout(() => { if (!cx.imei) socket.destroy(); }, 60_000);
    socket.setTimeout(15 * 60_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(semLogin);
      if (cx.imei && conexoes.get(cx.imei) === cx) conexoes.delete(cx.imei);
    });
    socket.on('data', (dados) => {
      buf = Buffer.concat([buf, dados]);
      if (buf.length > TAMANHO_MAX_BUFFER) return socket.destroy();
      const { quadros, resto } = extrair(buf);
      buf = Buffer.from(resto);
      for (const q of quadros) {
        try {
          tratar(q);
        } catch (err) {
          console.error('[Rastreador] GT06:', err.message);
        }
      }
    });

    function tratar(q) {
      const d = decodificar(q);
      if (d.ack) socket.write(quadro(q.protocolo, Buffer.alloc(0), q.serial));
      if (d.tipo === 'login') {
        cx.imei = d.imei;
        const anterior = conexoes.get(d.imei);
        if (anterior && anterior !== cx) anterior.socket.destroy();
        conexoes.set(d.imei, cx);
        receber(db, { imei: d.imei, protocolo: 'gt06', ip: socket.remoteAddress });
        entregar(d.imei);
        return;
      }
      if (d.tipo === 'hora') return socket.write(quadroHora(q.serial));
      if (!cx.imei) return; // antes do login, nada é aceito
      if (d.tipo === 'posicao' || d.tipo === 'estado') receber(db, { ...d.mensagem, imei: cx.imei, protocolo: 'gt06', ip: socket.remoteAddress });
      if (d.tipo === 'resposta') {
        const c = db.prepare('SELECT c.id FROM comandos c JOIN rastreadores r ON r.id = c.rastreador_id WHERE c.id = ? AND r.imei = ?').get(d.comando, cx.imei);
        if (c) com.responder(db, c.id, { sucesso: com.respostaSucesso(d.texto), resposta: d.texto });
      }
    }
  });

  const novoComando = ({ imei, protocolo }) => { if (protocolo === 'gt06') entregar(imei); };
  com.canal.on('comando', novoComando);
  servidor.on('close', () => com.canal.off('comando', novoComando));
  servidor.listen(porta, host);
  return {
    servidor,
    conectados: () => conexoes.size,
    conectado: (imei) => conexoes.has(imei),
    fechar: () => new Promise((r) => { for (const cx of conexoes.values()) cx.socket.destroy(); servidor.close(r); }),
  };
}

module.exports = { crc16, quadro, extrair, decodificar, quadroComando, iniciarGt06, P };
