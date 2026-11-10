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
const { Classificador } = require('../conteudo');

const M = { bytes: 0, pkts: 1, fluxos: 2, bytes_tcp: 3, bytes_udp: 4, pkts_icmp: 5, pkts_syn: 6 };
const K = 7;
const SEG = 60;
const MAX_CAPTURA = 20_000;
const OCIOSO_S = 180;
const BLOCO_MS = 5000;
const MAX_CONTEUDOS = 300;
const TOP = 20;

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
    this.tempoReal = new Map(); // 'bloco|org|grupo|dir' → [bytes, pkts, fluxos, tcp, udp, icmp]
    this.conteudo = new Map(); // 'org|chave|dir|grupo' → [bytes, pkts, fluxos]
    this.classificador = new Classificador();
    this.estatisticas = { fluxos: 0, ignorados: 0, internos: 0 };
  }

  /** Recarrega o catálogo de conteúdos e a base IP → ASN. */
  carregarConteudos(db) { this.classificador.carregar(db); }

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
    // soma de 5 s (painel em tempo real)
    const kt = `${Math.floor(agoraMs / BLOCO_MS) * BLOCO_MS}|${km}`;
    let tr = this.tempoReal.get(kt);
    if (!tr) { tr = [0, 0, 0, 0, 0, 0]; this.tempoReal.set(kt, tr); }
    tr[0] += f.bytes; tr[1] += f.pkts; tr[2] += 1;
    if (f.proto === 6) tr[3] += f.bytes; else if (f.proto === 17) tr[4] += f.bytes; else if (f.proto === 1 || f.proto === 58) tr[5] += f.bytes;
    // conteúdo do lado remoto
    const chave = this.classificador.classificar(exp.org, v, outro, dir === 'entrada' ? f.srcAs : f.dstAs);
    const kc = `${exp.org}|${chave}|${dir}|${grupo}`;
    let cc = this.conteudo.get(kc);
    if (!cc) { cc = [0, 0, 0]; this.conteudo.set(kc, cc); }
    cc[0] += f.bytes; cc[1] += f.pkts; cc[2] += 1;
    return dir;
  }

  /**
   * Grava os blocos de 5 s já fechados e o top 20 de IPs do momento (média de 10 s). Chamado a cada 5 s.
   */
  gravarTempoReal(db, agoraMs) {
    const atual = Math.floor(agoraMs / BLOCO_MS) * BLOCO_MS;
    const ins = db.prepare(`INSERT INTO trafego_tempo_real (organizacao_id, em, grupo_id, direcao, bytes, pacotes, fluxos, bytes_tcp, bytes_udp, bytes_icmp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET bytes = bytes + excluded.bytes, pacotes = pacotes + excluded.pacotes, fluxos = fluxos + excluded.fluxos,
      bytes_tcp = bytes_tcp + excluded.bytes_tcp, bytes_udp = bytes_udp + excluded.bytes_udp, bytes_icmp = bytes_icmp + excluded.bytes_icmp`);
    const fimSeg = Math.floor(agoraMs / 1000) - 1;
    const tops = new Map(); // 'org|dir' → [{ ip, grupo, bps, pps }]
    for (const c of this.contadores.values()) {
      if (c.escopo !== 'ip') continue;
      const bps = c.taxa('bps', 10, fimSeg);
      if (!bps) continue;
      const k = `${c.org}|${c.dir}`;
      if (!tops.has(k)) tops.set(k, []);
      tops.get(k).push({ ip: c.texto, grupo: c.grupoId, bps, pps: c.taxa('pps', 10, fimSeg) });
    }
    const orgs = new Set([...this.orgs.keys()]);
    let n = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [k, x] of this.tempoReal) {
        const [bloco, org, grupo, dir] = k.split('|');
        if (Number(bloco) >= atual) continue;
        ins.run(Number(org), new Date(Number(bloco)).toISOString(), Number(grupo), dir, ...x);
        this.tempoReal.delete(k);
        n++;
      }
      const t = new Date(agoraMs).toISOString();
      for (const org of orgs) {
        db.prepare('DELETE FROM trafego_top_atual WHERE organizacao_id = ?').run(org);
        for (const dir of ['entrada', 'saida']) {
          (tops.get(`${org}|${dir}`) ?? []).sort((a, b) => b.bps - a.bps).slice(0, TOP).forEach((x, i) => {
            db.prepare('INSERT INTO trafego_top_atual (organizacao_id, direcao, posicao, ip, grupo_id, bps, pps, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(org, dir, i + 1, x.ip, x.grupo, x.bps, x.pps, t);
          });
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return n;
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
      n += this.gravarConteudo(db, minuto, hora);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.minuto.clear();
    this.conteudo.clear();
    return n;
  }

  /** Conteúdos do minuto: até 300 chaves por organização e direção; o resto entra em "outros". */
  gravarConteudo(db, minuto, hora) {
    const sql = (tabela, col) => db.prepare(`INSERT INTO ${tabela} (organizacao_id, ${col}, chave, direcao, grupo_id, bytes, pacotes, fluxos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET bytes = bytes + excluded.bytes, pacotes = pacotes + excluded.pacotes, fluxos = fluxos + excluded.fluxos`);
    const insMin = sql('conteudo_minuto', 'minuto');
    const insHora = sql('conteudo_hora', 'hora');
    const porGrupo = new Map(); // 'org|dir' → Map(chave → total)
    for (const [k, x] of this.conteudo) {
      const [org, chave, dir] = k.split('|');
      const g = `${org}|${dir}`;
      if (!porGrupo.has(g)) porGrupo.set(g, new Map());
      const m = porGrupo.get(g);
      m.set(chave, (m.get(chave) ?? 0) + x[0]);
    }
    const manter = new Set();
    for (const [g, m] of porGrupo) {
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CONTEUDOS).forEach(([chave]) => manter.add(`${g}|${chave}`));
    }
    const final = new Map();
    for (const [k, x] of this.conteudo) {
      const [org, chave, dir, grupo] = k.split('|');
      const ch = manter.has(`${org}|${dir}|${chave}`) ? chave : 'outros';
      const kk = `${org}|${ch}|${dir}|${grupo}`;
      const y = final.get(kk) ?? [0, 0, 0];
      y[0] += x[0]; y[1] += x[1]; y[2] += x[2];
      final.set(kk, y);
    }
    for (const [k, x] of final) {
      const [org, chave, dir, grupo] = k.split('|');
      insMin.run(Number(org), minuto, chave, dir, Number(grupo), ...x);
      insHora.run(Number(org), hora, chave, dir, Number(grupo), ...x);
    }
    return final.size;
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
