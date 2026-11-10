'use strict';

/*
 * Endereços e prefixos IPv4/IPv6.
 * IPv4 é um Number sem sinal (0 a 2^32-1), para o caminho rápido do coletor; IPv6 é um BigInt de 128 bits.
 * Um endereço é { v: 4|6, n }. Um prefixo é { v, rede, len, texto }, com os bits de host zerados.
 */

const net = require('node:net');

const MAX6 = (1n << 128n) - 1n;

function v4ParaNumero(t) {
  const p = t.split('.');
  return ((Number(p[0]) << 24) >>> 0) + (Number(p[1]) << 16) + (Number(p[2]) << 8) + Number(p[3]);
}

function v6ParaBigInt(t) {
  let s = t.toLowerCase();
  // IPv4 embutido no fim (ex.: ::ffff:192.0.2.1)
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const n = v4ParaNumero(m[1]);
    s = `${s.slice(0, m.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [cab, cauda] = s.split('::');
  const a = cab ? cab.split(':') : [];
  const b = cauda !== undefined && cauda !== '' ? cauda.split(':') : [];
  const grupos = cauda === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  let n = 0n;
  for (const g of grupos) n = (n << 16n) | BigInt(Number.parseInt(g || '0', 16));
  return n;
}

/** Lê um endereço em texto. Devolve null se não for um IP válido. */
function lerIp(texto) {
  const t = String(texto ?? '').trim();
  const v = net.isIP(t);
  if (v === 4) return { v: 4, n: v4ParaNumero(t) };
  if (v === 6) return { v: 6, n: v6ParaBigInt(t) };
  return null;
}

function v4Texto(n) {
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/** Forma canônica e curta do IPv6 (RFC 5952). */
function v6Texto(n) {
  const g = [];
  for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  let melhor = { i: -1, t: 0 };
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > melhor.t && j - i > 1) melhor = { i, t: j - i };
    i = j;
  }
  const h = g.map((x) => x.toString(16));
  if (melhor.i < 0) return h.join(':');
  return `${h.slice(0, melhor.i).join(':')}::${h.slice(melhor.i + melhor.t).join(':')}`;
}

const ipTexto = (v, n) => (v === 4 ? v4Texto(n) : v6Texto(n));
const textoDe = (ip) => ipTexto(ip.v, ip.n);

function mascara4(len) { return len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0; }
function mascara6(len) { return len === 0 ? 0n : (MAX6 << BigInt(128 - len)) & MAX6; }

/** Rede de um endereço num prefixo de tamanho len (bits de host zerados). */
function redeDe(v, n, len) {
  return v === 4 ? (n & mascara4(len)) >>> 0 : n & mascara6(len);
}

/**
 * Lê um prefixo "endereço/tamanho" (sem tamanho = host /32 ou /128).
 * estrito: recusa bits de host ligados (ex.: 192.0.2.1/24). Sem estrito, normaliza para a rede.
 */
function lerPrefixo(texto, { estrito = false } = {}) {
  const [end, tam, extra] = String(texto ?? '').trim().split('/');
  if (extra !== undefined) return null;
  const ip = lerIp(end);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const len = tam === undefined ? max : /^\d{1,3}$/.test(tam) ? Number(tam) : NaN;
  if (!Number.isInteger(len) || len < 0 || len > max) return null;
  const rede = redeDe(ip.v, ip.n, len);
  if (estrito && rede !== ip.n) return null;
  return { v: ip.v, rede, len, texto: `${ipTexto(ip.v, rede)}/${len}` };
}

/** O prefixo contém o endereço? */
const contem = (p, ip) => p.v === ip.v && redeDe(ip.v, ip.n, p.len) === p.rede;
/** O prefixo a contém (ou é igual a) o prefixo b? */
const contemPrefixo = (a, b) => a.v === b.v && a.len <= b.len && redeDe(b.v, b.rede, a.len) === a.rede;
/** Quantidade de endereços do prefixo (BigInt). */
const tamanho = (p) => 1n << BigInt((p.v === 4 ? 32 : 128) - p.len);

/** Endereço a partir dos bytes do pacote (4 bytes IPv4 ou 16 bytes IPv6). */
function ipDoBuffer(buf, pos, v) {
  if (v === 4) return buf.readUInt32BE(pos);
  return (buf.readBigUInt64BE(pos) << 64n) | buf.readBigUInt64BE(pos + 8);
}

/**
 * Tabela de prefixos com busca pelo prefixo mais específico (longest match).
 * Guarda um Map por tamanho de prefixo; a busca testa do mais longo ao mais curto (são poucos tamanhos na prática).
 */
class TabelaPrefixos {
  constructor() { this.limpar(); }

  limpar() {
    this.mapas = { 4: new Map(), 6: new Map() };
    this.tamanhos = { 4: [], 6: [] };
    this.total = 0;
  }

  adicionar(prefixo, valor) {
    const p = typeof prefixo === 'string' ? lerPrefixo(prefixo) : prefixo;
    if (!p) throw new Error(`Prefixo inválido: ${prefixo}`);
    let m = this.mapas[p.v].get(p.len);
    if (!m) {
      m = new Map();
      this.mapas[p.v].set(p.len, m);
      this.tamanhos[p.v] = [...this.mapas[p.v].keys()].sort((a, b) => b - a);
    }
    if (!m.has(p.rede)) this.total++;
    m.set(p.rede, valor);
  }

  /** Valor do prefixo mais específico que contém o endereço (v, n), ou undefined. */
  buscar(v, n) {
    const mapas = this.mapas[v];
    for (const len of this.tamanhos[v]) {
      const x = mapas.get(len).get(redeDe(v, n, len));
      if (x !== undefined) return x;
    }
    return undefined;
  }
}

module.exports = { lerIp, lerPrefixo, ipTexto, textoDe, redeDe, contem, contemPrefixo, tamanho, ipDoBuffer, TabelaPrefixos, v4Texto, v6Texto };
