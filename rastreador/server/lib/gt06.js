'use strict';

const net = require('node:net');

/**
 * Protocolo GT06 (Concox e compatíveis: GT06, GT06N, J16, ST-901 e muitos outros), por TCP.
 * Quadro: 78 78 | tamanho (1) | protocolo (1) | conteúdo | serial (2) | CRC-ITU (2) | 0D 0A  (ou 79 79 com o tamanho em 2 bytes).
 * Os modelos 4G (como o J16 4G) usam também a posição 0xA0, os alarmes 0xA4/0xA5 e a informação 0x94 (tensão externa),
 * com a célula da rede 4G (LAC de 4 bytes e célula de 8).
 */
const P = {
  LOGIN: 0x01, GPS: 0x12, STATUS: 0x13, RESPOSTA: 0x15, ALARME: 0x16, RESPOSTA2: 0x21, GPS2: 0x22, HEARTBEAT: 0x23, ALARME2: 0x26, COMANDO: 0x80, HORA: 0x8a,
  INFO: 0x94, GPS_4G: 0xa0, LBS_4G: 0xa1, ALARME_4G: 0xa4, ALARME_LBS_4G: 0xa5,
};
// Alarmes do quadro de alarme que viram alerta.
const ALARMES = { 0x01: 'panico', 0x02: 'bateria_desconectada', 0x0e: 'bateria_baixa', 0x0f: 'bateria_baixa', 0x19: 'bateria_baixa', 0x13: 'violacao' };
// Alarme do byte de estado (bits 3 a 5).
const ALARMES_ESTADO = { 4: 'panico', 3: 'bateria_baixa', 2: 'bateria_desconectada' };
// Tensão aproximada de cada nível de bateria informado (1 a 6), em volts da bateria interna (0: sem bateria interna, como o J16).
const NIVEL_TENSAO = [null, 3.4, 3.6, 3.7, 3.8, 3.9, 4.1];
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

/**
 * Data e posição GPS (18 bytes a partir de `o`). A hora vem no fuso informado pelo equipamento no login (`fusoMin`, em minutos;
 * 0 quando ele manda em UTC, o padrão). Nos flags, o bit 14 diz que o bit 15 traz a ignição.
 */
function lerGps(c, o = 0, fusoMin = 0) {
  const gpsEm = new Date(Date.UTC(2000 + c[o], c[o + 1] - 1, c[o + 2], c[o + 3], c[o + 4], c[o + 5]) - fusoMin * 60_000).toISOString();
  let lat = c.readUInt32BE(o + 7) / 1_800_000;
  let lng = c.readUInt32BE(o + 11) / 1_800_000;
  const flags = c.readUInt16BE(o + 16);
  if (!(flags & 0x0400)) lat = -lat;
  if (flags & 0x0800) lng = -lng;
  return {
    gps_em: gpsEm, satelites: c[o + 6] & 0x0f, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), velocidade_kmh: c[o + 15],
    curso: flags & 0x03ff, valido: Boolean(flags & 0x1000), ...(flags & 0x4000 ? { ignicao: Boolean(flags & 0x8000) } : {}),
  };
}

/** Tamanho da célula da rede depois do GPS na posição 4G (0xA0): MCC (2), MNC (1, ou 2 se o bit 15 do MCC vier ligado), LAC (4) e célula (8). */
const tamanhoCelula4g = (c, o) => 2 + (c.readUInt16BE(o) & 0x8000 ? 2 : 1) + 4 + 8;

/** Fuso do login (2 bytes depois do IMEI e do tipo): horas×100 + minutos nos 12 bits altos; o bit 3 ligado é oeste (negativo). */
function lerFuso(c) {
  if (c.length < 12) return 0;
  const x = c.readUInt16BE(10);
  const v = x >> 4;
  return (x & 0x08 ? -1 : 1) * (Math.floor(v / 100) * 60 + (v % 100));
}

/**
 * Fim do quadro de alarme: estado do terminal, nível da bateria, sinal GSM, alarme e idioma (mais a cerca, no 0xA4).
 * Lido a partir do fim, porque o tamanho do LBS no meio muda entre os modelos 2G e 4G.
 */
function lerFimAlarme(c, extra = 0) {
  const o = c.length - 5 - extra;
  if (o < 0) return {};
  const e = lerEstado(c[o]);
  return { ignicao: e.ignicao, bloqueado: e.bloqueado, tensao: NIVEL_TENSAO[c[o + 1]] ?? null, evento: ALARMES[c[o + 3]] ?? e.evento };
}

/** Byte de estado do terminal: ignição (ACC), corte de combustível e alarme. */
function lerEstado(info) {
  return { ignicao: Boolean(info & 0x02), bloqueado: Boolean(info & 0x80), evento: ALARMES_ESTADO[(info >> 3) & 0x07] ?? null };
}

/**
 * Traduz um quadro em { tipo, ... }: login (imei), posicao (mensagem para receber()), estado, resposta (de comando) ou hora.
 * Devolve também se o quadro pede confirmação (ack).
 */
function decodificar(q, { fusoMin = 0 } = {}) {
  const c = q.conteudo;
  switch (q.protocolo) {
    case P.LOGIN: {
      const hex = c.subarray(0, 8).toString('hex');
      return { tipo: 'login', imei: hex.replace(/^0/, ''), fusoMin: lerFuso(c), ack: true };
    }
    case P.GPS_4G: {
      const m = lerGps(c, 0, fusoMin);
      // Depois da célula 4G: ignição (ACC), modo de envio e se é reenvio da memória.
      const o = 18 + tamanhoCelula4g(c, 18);
      if (c.length > o) m.ignicao = c[o] === 1;
      return { tipo: 'posicao', mensagem: m, ack: false };
    }
    case P.GPS:
    case P.GPS2: {
      const m = lerGps(c, 0, fusoMin);
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
    case P.ALARME2:
    case P.ALARME_4G:
      return { tipo: 'posicao', mensagem: { ...lerGps(c, 0, fusoMin), ...lerFimAlarme(c, q.protocolo === P.ALARME_4G ? 1 : 0) }, ack: true };
    // Alarme sem GPS (só a célula 4G): vale o estado e o alarme, na última posição conhecida.
    case P.ALARME_LBS_4G:
      return { tipo: 'estado', mensagem: lerFimAlarme(c), ack: true };
    // Informação: o tipo 0x00 traz a tensão externa (bateria do veículo) em centésimos de volt.
    case P.INFO:
      return c[0] === 0x00 && c.length >= 3 ? { tipo: 'estado', mensagem: { tensao: c.readUInt16BE(1) / 100 }, ack: false } : { tipo: 'outro', ack: false };
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
  // Só o servidor usa o banco: a montagem e a leitura dos quadros (acima) servem também ao simulador, sem configuração.
  const { receber } = require('./posicoes');
  const com = require('./comandos');
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
    const cx = { socket, imei: null, serial: 0, fusoMin: 0 };
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
      const d = decodificar(q, { fusoMin: cx.fusoMin });
      if (d.ack) socket.write(quadro(q.protocolo, Buffer.alloc(0), q.serial));
      if (d.tipo === 'login') {
        cx.imei = d.imei;
        cx.fusoMin = d.fusoMin;
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
