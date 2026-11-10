'use strict';

/*
 * Leitura dos pacotes de flow: NetFlow v5, NetFlow v9 (RFC 3954), IPFIX (RFC 7011) e sFlow v5.
 *
 * Cada pacote vira uma lista de fluxos normalizados:
 *   { v: 4|6, src, dst, sport, dport, proto, bytes, pkts, flags, entrada, saida, srcAs, dstAs, natSrc?, natSport? }
 * src/dst seguem lib/ip.js (Number no IPv4, BigInt no IPv6). bytes e pkts JÁ estão multiplicados pela taxa de amostragem
 * (a informada no pacote/template de opções ou, sem ela, a cadastrada no exportador).
 *
 * NetFlow v9 e IPFIX dependem de templates enviados pelo próprio roteador: até o template chegar, os registros de dados
 * daquele template são contados como "sem template" e descartados (o roteador reenvia o template periodicamente).
 */

const { ipDoBuffer } = require('../ip');

// Campos IANA (iguais no v9 e no IPFIX para os números abaixo de 128 e nos IPFIX usados aqui).
const F = {
  IN_BYTES: 1, IN_PKTS: 2, PROTOCOL: 4, TCP_FLAGS: 6, L4_SRC_PORT: 7, IPV4_SRC: 8, INPUT_SNMP: 10, L4_DST_PORT: 11, IPV4_DST: 12,
  OUTPUT_SNMP: 14, SRC_AS: 16, DST_AS: 17, OUT_BYTES: 23, OUT_PKTS: 24, IPV6_SRC: 27, IPV6_DST: 28, SAMPLING_INTERVAL: 34,
  SAMPLER_RANDOM_INTERVAL: 50, OCTET_TOTAL: 85, PACKET_TOTAL: 86, POST_NAT_SRC4: 225, POST_NAPT_SPORT: 227, SAMPLING_PACKET_INTERVAL: 305,
  SAMPLING_PACKET_SPACE: 306, SAMPLING_SIZE: 309, SAMPLING_POPULATION: 310, SAMPLING_PROBABILITY: 311,
};

/** Inteiro sem sinal big-endian de 1 a 8 bytes (como Number; contadores acima de 2^53 perdem precisão, irrelevante aqui). */
function uint(buf, pos, len) {
  if (len === 1) return buf[pos];
  if (len === 2) return buf.readUInt16BE(pos);
  if (len === 4) return buf.readUInt32BE(pos);
  if (len === 8) return Number(buf.readBigUInt64BE(pos));
  let n = 0;
  for (let i = 0; i < len; i++) n = n * 256 + buf[pos + i];
  return n;
}

/**
 * Estado por exportador: templates de v9/IPFIX e taxa de amostragem informada pelos templates de opções.
 * A chave inclui o endereço do exportador e o source_id / observation domain.
 */
class EstadoTemplates {
  constructor() {
    this.templates = new Map();
    this.amostragem = new Map();
  }
}

// ---------------------------------------------------------------- NetFlow v5
function netflow5(buf, ctx) {
  const n = buf.readUInt16BE(2);
  if (buf.length < 24 + n * 48) throw new Error('NetFlow v5 truncado');
  const s = buf.readUInt16BE(22);
  const taxaPacote = s & 0x3fff;
  const taxa = taxaPacote > 1 ? taxaPacote : ctx.taxaPadrao;
  const fluxos = [];
  for (let i = 0; i < n; i++) {
    const p = 24 + i * 48;
    fluxos.push({ v: 4, src: buf.readUInt32BE(p), dst: buf.readUInt32BE(p + 4), entrada: buf.readUInt16BE(p + 12), saida: buf.readUInt16BE(p + 14),
      pkts: buf.readUInt32BE(p + 16) * taxa, bytes: buf.readUInt32BE(p + 20) * taxa, sport: buf.readUInt16BE(p + 32), dport: buf.readUInt16BE(p + 34),
      flags: buf[p + 37], proto: buf[p + 38], srcAs: buf.readUInt16BE(p + 40), dstAs: buf.readUInt16BE(p + 42) });
  }
  return { versao: 5, fluxos, semTemplate: 0 };
}

// ---------------------------------------------------------------- NetFlow v9 / IPFIX
/** Lê um registro de dados conforme o template. Devolve [fluxo|null, bytesLidos]. */
function lerRegistro(buf, pos, campos, ipfix) {
  const r = {};
  let p = pos;
  for (const c of campos) {
    let len = c.len;
    if (len === 0xffff) { // tamanho variável (só IPFIX)
      len = buf[p]; p += 1;
      if (len === 255) { len = buf.readUInt16BE(p); p += 2; }
    }
    if (p + len > buf.length) return [null, buf.length - pos];
    if (c.pen) { p += len; continue; } // campo de empresa: ignorado
    switch (c.tipo) {
      case F.IPV4_SRC: if (len === 4) { r.v = 4; r.src = buf.readUInt32BE(p); } break;
      case F.IPV4_DST: if (len === 4) { r.v = 4; r.dst = buf.readUInt32BE(p); } break;
      case F.IPV6_SRC: if (len === 16) { r.v = 6; r.src = ipDoBuffer(buf, p, 6); } break;
      case F.IPV6_DST: if (len === 16) { r.v = 6; r.dst = ipDoBuffer(buf, p, 6); } break;
      case F.IN_BYTES: case F.OCTET_TOTAL: r.bytes = (r.bytes ?? 0) + uint(buf, p, len); break;
      case F.IN_PKTS: case F.PACKET_TOTAL: r.pkts = (r.pkts ?? 0) + uint(buf, p, len); break;
      case F.OUT_BYTES: r.bytesSaida = uint(buf, p, len); break;
      case F.OUT_PKTS: r.pktsSaida = uint(buf, p, len); break;
      case F.PROTOCOL: r.proto = buf[p]; break;
      case F.TCP_FLAGS: r.flags = buf[p + len - 1]; break;
      case F.L4_SRC_PORT: r.sport = uint(buf, p, len); break;
      case F.L4_DST_PORT: r.dport = uint(buf, p, len); break;
      case F.INPUT_SNMP: r.entrada = uint(buf, p, len); break;
      case F.OUTPUT_SNMP: r.saida = uint(buf, p, len); break;
      case F.SRC_AS: r.srcAs = uint(buf, p, len); break;
      case F.DST_AS: r.dstAs = uint(buf, p, len); break;
      case F.POST_NAT_SRC4: if (len === 4) r.natSrc = buf.readUInt32BE(p); break;
      case F.POST_NAPT_SPORT: r.natSport = uint(buf, p, len); break;
      case F.SAMPLING_INTERVAL: case F.SAMPLER_RANDOM_INTERVAL: case F.SAMPLING_PACKET_INTERVAL: case F.SAMPLING_POPULATION: r.amostragem = uint(buf, p, len); break;
      case F.SAMPLING_PACKET_SPACE: r.espaco = uint(buf, p, len); break;
      default: break;
    }
    p += len;
  }
  // IPFIX: intervalo + espaço = 1 a cada (intervalo + espaço) pacotes
  if (r.espaco !== undefined && r.amostragem !== undefined) r.amostragem = (r.amostragem + r.espaco) / Math.max(1, r.amostragem);
  if (r.bytes === undefined && r.bytesSaida !== undefined) { r.bytes = r.bytesSaida; r.pkts = r.pktsSaida; }
  return [r, p - pos];
}

function lerCampos(buf, pos, n, ipfix) {
  const campos = [];
  let p = pos;
  for (let i = 0; i < n; i++) {
    let tipo = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    p += 4;
    let pen = false;
    if (ipfix && tipo & 0x8000) { tipo &= 0x7fff; pen = true; p += 4; }
    campos.push({ tipo, len, pen });
  }
  return [campos, p];
}

function netflow9ouIpfix(buf, ctx, ipfix) {
  const estado = ctx.estado;
  let pos;
  let fim;
  let dominio;
  if (ipfix) {
    fim = Math.min(buf.length, buf.readUInt16BE(2));
    dominio = buf.readUInt32BE(12);
    pos = 16;
  } else {
    fim = buf.length;
    dominio = buf.readUInt32BE(16);
    pos = 20;
  }
  const prefixoChave = `${ctx.exportador}|${ipfix ? 'x' : '9'}|${dominio}`;
  const fluxos = [];
  let semTemplate = 0;
  while (pos + 4 <= fim) {
    const id = buf.readUInt16BE(pos);
    const len = buf.readUInt16BE(pos + 2);
    if (len < 4 || pos + len > fim) break;
    const fimSet = pos + len;
    let p = pos + 4;
    const tpl = ipfix ? 2 : 0;
    const opc = ipfix ? 3 : 1;
    if (id === tpl) {
      while (p + 4 <= fimSet) {
        const tid = buf.readUInt16BE(p);
        const n = buf.readUInt16BE(p + 2);
        if (n === 0) { p += 4; continue; } // retirada de template (IPFIX)
        const [campos, prox] = lerCampos(buf, p + 4, n, ipfix);
        if (prox > fimSet) break;
        estado.templates.set(`${prefixoChave}|${tid}`, { campos, opcoes: false });
        p = prox;
      }
    } else if (id === opc) {
      while (p + 6 <= fimSet) {
        const tid = buf.readUInt16BE(p);
        let campos;
        let prox;
        if (ipfix) {
          const n = buf.readUInt16BE(p + 2);
          if (n === 0) { p += 6; continue; }
          [campos, prox] = lerCampos(buf, p + 6, n, true);
        } else {
          const escopoLen = buf.readUInt16BE(p + 2);
          const opcLen = buf.readUInt16BE(p + 4);
          [campos, prox] = lerCampos(buf, p + 6, (escopoLen + opcLen) / 4, false);
        }
        if (prox > fimSet) break;
        estado.templates.set(`${prefixoChave}|${tid}`, { campos, opcoes: true });
        p = prox;
        if (!ipfix) break; // v9: um template de opções por set (o resto é preenchimento)
      }
    } else if (id >= 256) {
      const t = estado.templates.get(`${prefixoChave}|${id}`);
      if (!t) {
        semTemplate++;
      } else {
        const minimo = t.campos.reduce((s, c) => s + (c.len === 0xffff ? 1 : c.len), 0);
        while (p + minimo <= fimSet && minimo > 0) {
          const [r, lidos] = lerRegistro(buf, p, t.campos, ipfix);
          if (!r || !lidos) break;
          p += lidos;
          if (t.opcoes) {
            if (r.amostragem > 0) estado.amostragem.set(prefixoChave, r.amostragem);
            continue;
          }
          if (r.v === undefined || r.src === undefined || r.dst === undefined) continue;
          const taxa = r.amostragem > 0 ? r.amostragem : estado.amostragem.get(prefixoChave) ?? ctx.taxaPadrao;
          fluxos.push({ v: r.v, src: r.src, dst: r.dst, sport: r.sport ?? 0, dport: r.dport ?? 0, proto: r.proto ?? 0, flags: r.flags ?? 0,
            bytes: (r.bytes ?? 0) * taxa, pkts: (r.pkts ?? 0) * taxa, entrada: r.entrada ?? 0, saida: r.saida ?? 0, srcAs: r.srcAs ?? 0, dstAs: r.dstAs ?? 0,
            ...(r.natSrc !== undefined ? { natSrc: r.natSrc, natSport: r.natSport ?? 0 } : {}) });
        }
      }
    }
    pos = fimSet;
  }
  return { versao: ipfix ? 10 : 9, fluxos, semTemplate };
}

// ---------------------------------------------------------------- sFlow v5
/**
 * Cabeçalho de pacote amostrado (Ethernet, com VLAN 802.1Q/QinQ, PPPoE de sessão e MPLS) até a camada 4.
 * Devolve null se não for IP.
 */
function lerCabecalhoPacote(h) {
  let p = 12;
  if (h.length < 14) return null;
  let tipo = h.readUInt16BE(p);
  p += 2;
  while ((tipo === 0x8100 || tipo === 0x88a8 || tipo === 0x9100) && p + 4 <= h.length) { tipo = h.readUInt16BE(p + 2); p += 4; }
  if (tipo === 0x8864) { // PPPoE sessão: 6 bytes de PPPoE + 2 de protocolo PPP
    if (p + 8 > h.length) return null;
    const ppp = h.readUInt16BE(p + 6);
    p += 8;
    tipo = ppp === 0x0021 ? 0x0800 : ppp === 0x0057 ? 0x86dd : 0;
  }
  if (tipo === 0x8847 || tipo === 0x8848) { // MPLS: pula rótulos até o fim da pilha e olha a versão IP
    while (p + 4 <= h.length) { const fimPilha = h[p + 2] & 1; p += 4; if (fimPilha) break; }
    if (p >= h.length) return null;
    tipo = h[p] >> 4 === 4 ? 0x0800 : h[p] >> 4 === 6 ? 0x86dd : 0;
  }
  return lerIpCamada3(h, p, tipo);
}

function lerIpCamada3(h, p, tipo) {
  const r = { sport: 0, dport: 0, flags: 0 };
  let l4;
  if (tipo === 0x0800) {
    if (p + 20 > h.length) return null;
    const ihl = (h[p] & 0x0f) * 4;
    r.v = 4;
    r.proto = h[p + 9];
    r.src = h.readUInt32BE(p + 12);
    r.dst = h.readUInt32BE(p + 16);
    const frag = h.readUInt16BE(p + 6) & 0x1fff;
    r.fragmento = frag !== 0;
    l4 = frag ? -1 : p + ihl;
  } else if (tipo === 0x86dd) {
    if (p + 40 > h.length) return null;
    r.v = 6;
    let prox = h[p + 6];
    r.src = ipDoBuffer(h, p + 8, 6);
    r.dst = ipDoBuffer(h, p + 24, 6);
    l4 = p + 40;
    for (let i = 0; i < 6 && [0, 43, 60, 44].includes(prox) && l4 + 8 <= h.length; i++) {
      if (prox === 44) { r.fragmento = (h.readUInt16BE(l4 + 2) & 0xfff8) !== 0; const n = h[l4]; l4 = r.fragmento ? -1 : l4 + 8; prox = n; if (l4 < 0) break; continue; }
      const n = h[l4];
      l4 += (h[l4 + 1] + 1) * 8;
      prox = n;
    }
    r.proto = prox;
  } else {
    return null;
  }
  if (l4 > 0 && (r.proto === 6 || r.proto === 17) && l4 + 4 <= h.length) {
    r.sport = h.readUInt16BE(l4);
    r.dport = h.readUInt16BE(l4 + 2);
    if (r.proto === 6 && l4 + 14 <= h.length) r.flags = h[l4 + 13];
  }
  return r;
}

function sflow5(buf, ctx) {
  let p = 4;
  const tipoAgente = buf.readUInt32BE(p);
  p += 4 + (tipoAgente === 2 ? 16 : 4);
  p += 12; // sub-agente, sequência, uptime
  const n = buf.readUInt32BE(p);
  p += 4;
  const fluxos = [];
  for (let i = 0; i < n && p + 8 <= buf.length; i++) {
    const formato = buf.readUInt32BE(p) & 0xfff;
    const empresa = buf.readUInt32BE(p) >>> 12;
    const len = buf.readUInt32BE(p + 4);
    const ini = p + 8;
    p = ini + len;
    if (p > buf.length) break;
    if (empresa !== 0 || (formato !== 1 && formato !== 3)) continue; // só amostras de fluxo (contadores são ignorados)
    let q = ini + 4; // sequência
    let entrada;
    let saida;
    let taxa;
    if (formato === 1) {
      q += 4; taxa = buf.readUInt32BE(q); q += 12; // source_id, taxa, pool, drops
      entrada = buf.readUInt32BE(q); saida = buf.readUInt32BE(q + 4) & 0x3fffffff; q += 8;
    } else {
      q += 8; taxa = buf.readUInt32BE(q); q += 12;
      entrada = buf.readUInt32BE(q + 4); saida = buf.readUInt32BE(q + 12); q += 16;
    }
    if (!taxa) taxa = ctx.taxaPadrao;
    const nreg = buf.readUInt32BE(q);
    q += 4;
    for (let j = 0; j < nreg && q + 8 <= p; j++) {
      const fr = buf.readUInt32BE(q);
      const fl = buf.readUInt32BE(q + 4);
      const d = q + 8;
      q = d + fl;
      if (q > p) break;
      let r = null;
      let tamanho = 0;
      if (fr === 1) { // cabeçalho bruto
        const protoCab = buf.readUInt32BE(d);
        tamanho = buf.readUInt32BE(d + 4);
        const hlen = buf.readUInt32BE(d + 12);
        const h = buf.subarray(d + 16, d + 16 + hlen);
        if (protoCab === 1) r = lerCabecalhoPacote(h);
        else if (protoCab === 11) r = lerIpCamada3(h, 0, 0x0800);
        else if (protoCab === 12) r = lerIpCamada3(h, 0, 0x86dd);
      } else if (fr === 3) { // IPv4 amostrado
        tamanho = buf.readUInt32BE(d);
        r = { v: 4, proto: buf.readUInt32BE(d + 4), src: buf.readUInt32BE(d + 8), dst: buf.readUInt32BE(d + 12), sport: buf.readUInt32BE(d + 16),
          dport: buf.readUInt32BE(d + 20), flags: buf.readUInt32BE(d + 24) & 0xff };
      } else if (fr === 4) { // IPv6 amostrado
        tamanho = buf.readUInt32BE(d);
        r = { v: 6, proto: buf.readUInt32BE(d + 4), src: ipDoBuffer(buf, d + 8, 6), dst: ipDoBuffer(buf, d + 24, 6), sport: buf.readUInt32BE(d + 40),
          dport: buf.readUInt32BE(d + 44), flags: buf.readUInt32BE(d + 48) & 0xff };
      }
      if (!r) continue;
      fluxos.push({ v: r.v, src: r.src, dst: r.dst, sport: r.sport, dport: r.dport, proto: r.proto, flags: r.flags, bytes: tamanho * taxa, pkts: taxa,
        entrada, saida, srcAs: 0, dstAs: 0 });
      break; // um registro de pacote por amostra basta (os outros são extensões: roteador, gateway, usuário)
    }
  }
  return { versao: 'sflow5', fluxos, semTemplate: 0 };
}

/**
 * Lê um datagrama UDP de flow. ctx = { exportador: 'ip', taxaPadrao: 1, estado: EstadoTemplates }.
 * Lança erro em pacote malformado (o coletor conta como erro do exportador).
 */
function decodificar(buf, ctx) {
  if (buf.length < 4) throw new Error('pacote curto demais');
  const versao16 = buf.readUInt16BE(0);
  if (versao16 === 5 && buf.length >= 24) return netflow5(buf, ctx);
  if (versao16 === 9 && buf.length >= 20) return netflow9ouIpfix(buf, ctx, false);
  if (versao16 === 10 && buf.length >= 16) return netflow9ouIpfix(buf, ctx, true);
  if (buf.length >= 28 && buf.readUInt32BE(0) === 5) return sflow5(buf, ctx);
  throw new Error(`formato desconhecido (versão ${versao16})`);
}

module.exports = { decodificar, EstadoTemplates, lerCabecalhoPacote, CAMPOS: F };
