'use strict';

/*
 * Contagem do tráfego em memória, segundo a segundo, para a detecção (janelas de 5, 10 e 60 s), e somas por minuto e hora
 * que vão para o banco.
 *
 * Cada fluxo é classificado pelos grupos de IPs da organização do exportador:
 *   destino num grupo e origem fora → entrada;  origem num grupo e destino fora → saída;  os dois dentro → interno.
 * Só exportadores de borda alimentam entrada/saída (o tráfego interno vem do BRAS/core e é tratado no módulo de ataques internos).
 *
 * Por IP protegido e por grupo, guardamos os últimos 60 segundos em anéis (Float64Array) com as métricas abaixo.
 * IPs sem tráfego por 3 minutos (e sem ataque em andamento) saem da memória.
 */

const { TabelaPrefixos, ipTexto } = require('../ip');

const M = { bytes: 0, pkts: 1, fluxos: 2, bytes_tcp: 3, bytes_udp: 4, pkts_icmp: 5, pkts_syn: 6 };
const K = 7;
const SEG = 60;
const MAX_CAPTURA = 20_000;
const OCIOSO_S = 180;

/** Métricas dos limites → como calcular a partir das somas de uma janela. */
const METRICAS = {
  bps: { rotulo: 'bits/s', idx: M.bytes, fator: 8 },
  pps: { rotulo: 'pacotes/s', idx: M.pkts, fator: 1 },
  fps: { rotulo: 'fluxos/s', idx: M.fluxos, fator: 1 },
  tcp_bps: { rotulo: 'bits/s TCP', idx: M.bytes_tcp, fator: 8 },
  udp_bps: { rotulo: 'bits/s UDP', idx: M.bytes_udp, fator: 8 },
  syn_pps: { rotulo: 'SYN/s', idx: M.pkts_syn, fator: 1 },
  icmp_pps: { rotulo: 'ICMP pacotes/s', idx: M.pkts_icmp, fator: 1 },
};

class Contador {
  constructor({ org, grupoId, dir, v = null, n = null, escopo }) {
    Object.assign(this, { org, grupoId, dir, v, n, escopo });
    this.texto = escopo === 'ip' ? ipTexto(v, n) : `grupo:${grupoId}`;
    this.slots = new Float64Array(SEG * K);
    this.segs = new Float64Array(SEG).fill(-1);
    this.ultimoSeg = 0;
    this.hora = [0, 0, 0]; // bytes, pacotes, fluxos acumulados desde a última gravação
    this.captura = null;
    // Estado da detecção
    this.violacoes = 0;
    this.okDesde = null;
    this.ataqueId = null;
    this.ultimaSerie = 0;
  }

  somar(seg, f, flagsSyn) {
    const i = seg % SEG;
    const b = i * K;
    if (this.segs[i] !== seg) { this.slots.fill(0, b, b + K); this.segs[i] = seg; }
    const s = this.slots;
    s[b] += f.bytes;
    s[b + 1] += f.pkts;
    s[b + 2] += 1;
    if (f.proto === 6) { s[b + 3] += f.bytes; if (flagsSyn) s[b + 6] += f.pkts; }
    else if (f.proto === 17) s[b + 4] += f.bytes;
    else if (f.proto === 1 || f.proto === 58) s[b + 5] += f.pkts;
    if (seg > this.ultimoSeg) this.ultimoSeg = seg;
    this.hora[0] += f.bytes;
    this.hora[1] += f.pkts;
    this.hora[2] += 1;
  }

  /** Taxa média de uma métrica nos `janela` segundos completos que terminam em `fimSeg` (inclusive). */
  taxa(metrica, janela, fimSeg) {
    const { idx, fator } = METRICAS[metrica];
    let soma = 0;
    for (let seg = fimSeg - janela + 1; seg <= fimSeg; seg++) {
      const i = ((seg % SEG) + SEG) % SEG;
      if (this.segs[i] === seg) soma += this.slots[i * K + idx];
    }
    return (soma * fator) / janela;
  }

  /** Guarda origens, portas e protocolos do tráfego (ligada durante a suspeita e o ataque). */
  capturar(f, outroV, outroN) {
    const c = this.captura;
    const add = (mapa, chave) => {
      const x = mapa.get(chave);
      if (x) { x[0] += f.bytes; x[1] += f.pkts; } else if (mapa.size < MAX_CAPTURA) mapa.set(chave, [f.bytes, f.pkts]);
      else c.descartados += f.bytes;
    };
    add(c.origens, ipTexto(outroV, outroN));
    add(c.protocolos, f.proto);
    if (f.proto === 6 || f.proto === 17) {
      add(c.portasOrigem, `${f.proto}/${f.sport}`);
      add(c.portasDestino, `${f.proto}/${f.dport}`);
    }
    if (f.proto === 6 && (f.flags & 0x12) === 0x02) c.syn += f.pkts;
    c.bytes += f.bytes;
    c.pkts += f.pkts;
  }
}

const novaCaptura = () => ({ origens: new Map(), portasOrigem: new Map(), portasDestino: new Map(), protocolos: new Map(), bytes: 0, pkts: 0, syn: 0, descartados: 0 });

class Agregador {
  constructor() {
    this.orgs = new Map(); // org → { tabela, grupos: Map(id → grupo) }
    this.contadores = new Map(); // chave → Contador
    this.minuto = new Map(); // 'org|grupo|dir' → [bytes, pkts, fluxos, tcp, udp]
    this.minutoAtual = null;
    this.estatisticas = { fluxos: 0, ignorados: 0, internos: 0 };
  }

  /** Recarrega os grupos de IPs (chamado no início e periodicamente). */
  carregarGrupos(db) {
    const orgs = new Map();
    const linhas = db.prepare(`SELECT p.organizacao_id AS org, p.prefixo, g.id AS grupo_id, g.nome FROM grupo_prefixos p JOIN grupos_ip g ON g.id = p.grupo_id
      WHERE g.ativo = 1`).all();
    for (const l of linhas) {
      let o = orgs.get(l.org);
      if (!o) { o = { tabela: new TabelaPrefixos(), grupos: new Map() }; orgs.set(l.org, o); }
      o.tabela.adicionar(l.prefixo, l.grupo_id);
      o.grupos.set(l.grupo_id, { id: l.grupo_id, nome: l.nome });
    }
    this.orgs = orgs;
  }

  contador(chave, dados) {
    let c = this.contadores.get(chave);
    if (!c) { c = new Contador(dados); this.contadores.set(chave, c); }
    return c;
  }

  /** Registra um fluxo de um exportador { org, papel }. agoraMs: horário de recebimento. */
  registrar(f, exp, agoraMs) {
    const o = this.orgs.get(exp.org);
    this.estatisticas.fluxos++;
    if (!o || exp.papel !== 'borda') { this.estatisticas.ignorados++; return null; }
    const gDst = o.tabela.buscar(f.v, f.dst);
    const gSrc = o.tabela.buscar(f.v, f.src);
    let dir;
    let grupo;
    let v;
    let n;
    let outro;
    if (gDst !== undefined && gSrc === undefined) { dir = 'entrada'; grupo = gDst; n = f.dst; outro = f.src; }
    else if (gSrc !== undefined && gDst === undefined) { dir = 'saida'; grupo = gSrc; n = f.src; outro = f.dst; }
    else { if (gDst !== undefined) this.estatisticas.internos++; else this.estatisticas.ignorados++; return null; }
    v = f.v;
    const seg = Math.floor(agoraMs / 1000);
    const syn = f.proto === 6 && (f.flags & 0x12) === 0x02;
    const cIp = this.contador(`${exp.org}|${dir}|${v}|${n}`, { org: exp.org, grupoId: grupo, dir, v, n, escopo: 'ip' });
    cIp.grupoId = grupo;
    cIp.somar(seg, f, syn);
    if (cIp.captura) cIp.capturar(f, v, outro);
    const cG = this.contador(`${exp.org}|${dir}|g${grupo}`, { org: exp.org, grupoId: grupo, dir, escopo: 'grupo' });
    cG.somar(seg, f, syn);
    if (cG.captura) cG.capturar(f, v, outro);
    // soma do minuto por grupo
    const km = `${exp.org}|${grupo}|${dir}`;
    let mm = this.minuto.get(km);
    if (!mm) { mm = [0, 0, 0, 0, 0]; this.minuto.set(km, mm); }
    mm[0] += f.bytes; mm[1] += f.pkts; mm[2] += 1;
    if (f.proto === 6) mm[3] += f.bytes; else if (f.proto === 17) mm[4] += f.bytes;
    return dir;
  }

  /** Grava as somas do minuto e as somas por IP/hora. Retorna o número de linhas gravadas. */
  gravar(db, agoraMs) {
    const minuto = new Date(Math.floor(agoraMs / 60_000) * 60_000 - 60_000).toISOString().slice(0, 16);
    const hora = `${minuto.slice(0, 13)}:00`;
    let n = 0;
    const insMin = db.prepare(`INSERT INTO trafego_minuto (organizacao_id, minuto, grupo_id, direcao, bytes, pacotes, fluxos, bytes_tcp, bytes_udp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET bytes = bytes + excluded.bytes, pacotes = pacotes + excluded.pacotes,
      fluxos = fluxos + excluded.fluxos, bytes_tcp = bytes_tcp + excluded.bytes_tcp, bytes_udp = bytes_udp + excluded.bytes_udp`);
    const insHora = db.prepare(`INSERT INTO trafego_ip_hora (organizacao_id, hora, ip, direcao, grupo_id, bytes, pacotes, fluxos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET bytes = bytes + excluded.bytes, pacotes = pacotes + excluded.pacotes, fluxos = fluxos + excluded.fluxos, grupo_id = excluded.grupo_id`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [k, x] of this.minuto) {
        const [org, grupo, dir] = k.split('|');
        insMin.run(Number(org), minuto, Number(grupo), dir, ...x);
        n++;
      }
      for (const c of this.contadores.values()) {
        if (c.escopo !== 'ip' || !c.hora[2]) continue;
        insHora.run(c.org, hora, c.texto, c.dir, c.grupoId, c.hora[0], c.hora[1], c.hora[2]);
        c.hora = [0, 0, 0];
        n++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.minuto.clear();
    return n;
  }

  /** Remove da memória quem não tem tráfego há 3 minutos e não está em suspeita nem em ataque. */
  limparOciosos(agoraMs) {
    const seg = Math.floor(agoraMs / 1000);
    for (const [k, c] of this.contadores) {
      if (seg - c.ultimoSeg > OCIOSO_S && !c.ataqueId && !c.violacoes && !c.hora[2]) this.contadores.delete(k);
    }
  }
}

/** Resumo da captura: top origens, portas e protocolos. */
function resumoCaptura(c, n = 10) {
  if (!c) return null;
  const top = (m) => [...m.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, n).map(([chave, [bytes, pkts]]) => ({ chave: String(chave), bytes, pkts }));
  return { origens: top(c.origens), portasOrigem: top(c.portasOrigem), portasDestino: top(c.portasDestino), protocolos: top(c.protocolos),
    bytes: c.bytes, pkts: c.pkts, syn: c.syn, origensDistintas: c.origens.size };
}

module.exports = { Agregador, Contador, METRICAS, novaCaptura, resumoCaptura };
