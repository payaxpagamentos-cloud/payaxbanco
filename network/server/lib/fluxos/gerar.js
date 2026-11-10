'use strict';

/*
 * Geração de pacotes NetFlow v5, NetFlow v9, IPFIX e sFlow v5 a partir de fluxos simples.
 * Usado pelo simulador (scripts/simulador-fluxos.js) e pelos testes; não faz parte da coleta.
 * Fluxo de entrada: { src: '203.0.113.1', dst: '198.51.100.7', sport, dport, proto, bytes, pkts, flags? } (IPv4 ou IPv6).
 */

const { lerIp } = require('../ip');

function ipBuf(texto) {
  const ip = lerIp(texto);
  if (!ip) throw new Error(`IP inválido: ${texto}`);
  if (ip.v === 4) { const b = Buffer.alloc(4); b.writeUInt32BE(ip.n); return b; }
  const b = Buffer.alloc(16);
  b.writeBigUInt64BE(ip.n >> 64n, 0);
  b.writeBigUInt64BE(ip.n & 0xffffffffffffffffn, 8);
  return b;
}

const v6 = (f) => lerIp(f.src).v === 6;

function netflow5(fluxos, { amostragem = 0 } = {}) {
  const h = Buffer.alloc(24);
  h.writeUInt16BE(5, 0);
  h.writeUInt16BE(fluxos.length, 2);
  h.writeUInt32BE(Math.floor(Date.now() / 1000), 8);
  if (amostragem) h.writeUInt16BE(0x4000 | amostragem, 22);
  const regs = fluxos.map((f) => {
    const r = Buffer.alloc(48);
    ipBuf(f.src).copy(r, 0);
    ipBuf(f.dst).copy(r, 4);
    r.writeUInt32BE(f.pkts, 16);
    r.writeUInt32BE(f.bytes, 20);
    r.writeUInt16BE(f.sport ?? 0, 32);
    r.writeUInt16BE(f.dport ?? 0, 34);
    r[37] = f.flags ?? 0;
    r[38] = f.proto;
    return r;
  });
  return Buffer.concat([h, ...regs]);
}

// Template: src, dst, sport, dport, proto, flags, bytes(8), pkts(8)
const CAMPOS4 = [[8, 4], [12, 4], [7, 2], [11, 2], [4, 1], [6, 1], [1, 8], [2, 8]];
const CAMPOS6 = [[27, 16], [28, 16], [7, 2], [11, 2], [4, 1], [6, 1], [1, 8], [2, 8]];

function registro(f) {
  const r = Buffer.alloc(v6(f) ? 54 : 30);
  let p = 0;
  for (const b of [ipBuf(f.src), ipBuf(f.dst)]) { b.copy(r, p); p += b.length; }
  r.writeUInt16BE(f.sport ?? 0, p); r.writeUInt16BE(f.dport ?? 0, p + 2);
  r[p + 4] = f.proto; r[p + 5] = f.flags ?? 0;
  r.writeBigUInt64BE(BigInt(f.bytes), p + 6); r.writeBigUInt64BE(BigInt(f.pkts), p + 14);
  return r;
}

function set(id, corpo) {
  const pad = (4 - ((corpo.length + 4) % 4)) % 4;
  const h = Buffer.alloc(4);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(corpo.length + 4 + pad, 2);
  return Buffer.concat([h, corpo, Buffer.alloc(pad)]);
}

function templates(ipfix) {
  const partes = [];
  for (const [tid, campos] of [[256, CAMPOS4], [257, CAMPOS6]]) {
    const b = Buffer.alloc(4 + campos.length * 4);
    b.writeUInt16BE(tid, 0); b.writeUInt16BE(campos.length, 2);
    campos.forEach(([t, l], i) => { b.writeUInt16BE(t, 4 + i * 4); b.writeUInt16BE(l, 6 + i * 4); });
    partes.push(b);
  }
  return set(ipfix ? 2 : 0, Buffer.concat(partes));
}

/** Template de opções com o intervalo de amostragem (campo 34) e o registro com o valor. */
function opcoesAmostragem(ipfix, taxa) {
  let tpl;
  if (ipfix) {
    tpl = Buffer.alloc(14);
    tpl.writeUInt16BE(258, 0); tpl.writeUInt16BE(2, 2); tpl.writeUInt16BE(1, 4);
    tpl.writeUInt16BE(149, 6); tpl.writeUInt16BE(4, 8); // escopo: observationDomainId
    tpl.writeUInt16BE(34, 10); tpl.writeUInt16BE(4, 12);
  } else {
    tpl = Buffer.alloc(14);
    tpl.writeUInt16BE(258, 0); tpl.writeUInt16BE(4, 2); tpl.writeUInt16BE(4, 4);
    tpl.writeUInt16BE(1, 6); tpl.writeUInt16BE(4, 8); // escopo: sistema
    tpl.writeUInt16BE(34, 10); tpl.writeUInt16BE(4, 12);
  }
  const dado = Buffer.alloc(8);
  dado.writeUInt32BE(taxa, 4);
  return [set(ipfix ? 3 : 1, tpl), set(258, dado)];
}

/** Pacote NetFlow v9 (ipfix=false) ou IPFIX (ipfix=true). comTemplate=false simula o roteador antes de enviar os templates. */
function netflow9(fluxos, { ipfix = false, comTemplate = true, amostragem = 0, dominio = 1 } = {}) {
  const sets = [];
  if (comTemplate) sets.push(templates(ipfix));
  if (comTemplate && amostragem) sets.push(...opcoesAmostragem(ipfix, amostragem));
  const g4 = fluxos.filter((f) => !v6(f));
  const g6 = fluxos.filter(v6);
  if (g4.length) sets.push(set(256, Buffer.concat(g4.map(registro))));
  if (g6.length) sets.push(set(257, Buffer.concat(g6.map(registro))));
  const corpo = Buffer.concat(sets);
  const h = Buffer.alloc(ipfix ? 16 : 20);
  h.writeUInt16BE(ipfix ? 10 : 9, 0);
  if (ipfix) {
    h.writeUInt16BE(16 + corpo.length, 2);
    h.writeUInt32BE(Math.floor(Date.now() / 1000), 4);
    h.writeUInt32BE(dominio, 12);
  } else {
    h.writeUInt16BE(sets.length, 2);
    h.writeUInt32BE(Math.floor(Date.now() / 1000), 8);
    h.writeUInt32BE(dominio, 16);
  }
  return Buffer.concat([h, corpo]);
}

/** Cabeçalho Ethernet + IP + L4 de um pacote amostrado (com PPPoE opcional, como no BRAS). */
function cabecalhoEthernet(f, { pppoe = false, vlan = 0 } = {}) {
  const seis = v6(f);
  const ip = Buffer.alloc(seis ? 40 : 20);
  if (seis) {
    ip[0] = 0x60; ip[6] = f.proto; ip[7] = 64;
    ipBuf(f.src).copy(ip, 8); ipBuf(f.dst).copy(ip, 24);
  } else {
    ip[0] = 0x45; ip[8] = 64; ip[9] = f.proto;
    ipBuf(f.src).copy(ip, 12); ipBuf(f.dst).copy(ip, 16);
  }
  const l4 = Buffer.alloc(f.proto === 6 ? 20 : 8);
  if (f.proto === 6 || f.proto === 17) { l4.writeUInt16BE(f.sport ?? 0, 0); l4.writeUInt16BE(f.dport ?? 0, 2); }
  if (f.proto === 6) l4[13] = f.flags ?? 0;
  const partes = [Buffer.alloc(12)];
  if (vlan) { const v = Buffer.alloc(4); v.writeUInt16BE(0x8100, 0); v.writeUInt16BE(vlan, 2); partes.push(v); }
  if (pppoe) {
    const e = Buffer.alloc(10);
    e.writeUInt16BE(0x8864, 0); e[2] = 0x11; e.writeUInt16BE(0x1234, 4); e.writeUInt16BE(ip.length + l4.length + 2, 6); e.writeUInt16BE(seis ? 0x0057 : 0x0021, 8);
    partes.push(e);
  } else {
    const e = Buffer.alloc(2);
    e.writeUInt16BE(seis ? 0x86dd : 0x0800, 0);
    partes.push(e);
  }
  return Buffer.concat([...partes, ip, l4]);
}

/** Datagrama sFlow v5 com uma amostra de fluxo (cabeçalho bruto) por fluxo. tamanho = bytes/pkts. */
function sflow(fluxos, { taxa = 1000, agente = '192.0.2.1', pppoe = false } = {}) {
  const amostras = fluxos.map((f, i) => {
    const cab = cabecalhoEthernet(f, { pppoe });
    const pad = (4 - (cab.length % 4)) % 4;
    const reg = Buffer.alloc(16 + cab.length + pad);
    reg.writeUInt32BE(1, 0); // ethernet
    reg.writeUInt32BE(Math.max(64, Math.round(f.bytes / Math.max(1, f.pkts))), 4);
    reg.writeUInt32BE(cab.length, 12);
    cab.copy(reg, 16);
    const regCab = Buffer.alloc(8);
    regCab.writeUInt32BE(1, 0); regCab.writeUInt32BE(reg.length, 4);
    const corpo = Buffer.alloc(32);
    corpo.writeUInt32BE(i + 1, 0); corpo.writeUInt32BE(1, 4); corpo.writeUInt32BE(taxa, 8); corpo.writeUInt32BE(taxa * (i + 1), 12);
    corpo.writeUInt32BE(1, 20); corpo.writeUInt32BE(2, 24); corpo.writeUInt32BE(1, 28);
    const dado = Buffer.concat([corpo, regCab, reg]);
    const h = Buffer.alloc(8);
    h.writeUInt32BE(1, 0); h.writeUInt32BE(dado.length, 4);
    return Buffer.concat([h, dado]);
  });
  const h = Buffer.alloc(28);
  h.writeUInt32BE(5, 0); h.writeUInt32BE(1, 4); ipBuf(agente).copy(h, 8);
  h.writeUInt32BE(amostras.length, 24);
  return Buffer.concat([h, ...amostras]);
}

module.exports = { netflow5, netflow9, sflow, cabecalhoEthernet };
