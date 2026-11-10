'use strict';

/*
 * Detecção de ataques a partir dos contadores do agregador. Roda a cada 5 s e compara, para cada IP protegido e para cada
 * grupo, as médias de 5, 10 ou 60 s com os limites do grupo.
 *
 * - Confirmação: o ataque abre depois de N avaliações seguidas acima do limite (ddos_config.confirmacoes). Na primeira
 *   avaliação acima do limite a captura de origens e portas é ligada, para o ataque já abrir com o vetor.
 * - Histerese: o ataque só encerra depois de encerrar_apos_s segundos seguidos abaixo de limite × fator_recuperacao.
 * - Um ataque ativo por alvo e direção (índice único no banco); a lista de ativos é relida do banco a cada recarga,
 *   então um encerramento manual na tela vale também aqui.
 */

const { agora, proximoNumero } = require('../../db');
const { novaCaptura, resumoCaptura } = require('./agregador');
const mitigacao = require('../mitigacao');
const avisos = require('../avisos');
const fmt = require('../formato');

const DIRECAO = { entrada: 'de fora para dentro', saida: 'saindo da rede', interno: 'dentro da rede' };

class Detector {
  constructor(db, agregador) {
    this.db = db;
    this.ag = agregador;
    this.limites = new Map(); // org → Map(grupo → [limites])
    this.cfgs = new Map();
    this.grupos = new Map(); // grupo id → linha
    this.ativos = new Map(); // 'org|alvo|dir' → ataque
    this.estado = new Map(); // 'org|alvo|dir' → { okDesde, ultimaSerie, ultimoResumo }
  }

  carregar() {
    const db = this.db;
    this.limites = new Map();
    for (const l of db.prepare('SELECT * FROM ddos_limites WHERE ativo = 1').all()) {
      if (!this.limites.has(l.organizacao_id)) this.limites.set(l.organizacao_id, new Map());
      const m = this.limites.get(l.organizacao_id);
      if (!m.has(l.grupo_id)) m.set(l.grupo_id, []);
      m.get(l.grupo_id).push(l);
    }
    this.grupos = new Map(db.prepare('SELECT * FROM grupos_ip').all().map((g) => [g.id, g]));
    this.cfgs = new Map();
    this.ativos = new Map(db.prepare("SELECT * FROM ataques WHERE status = 'ativo' AND direcao IN ('entrada','saida')").all()
      .map((a) => [`${a.organizacao_id}|${a.alvo}|${a.direcao}`, a]));
    for (const k of this.estado.keys()) if (!this.ativos.has(k)) this.estado.delete(k);
  }

  cfg(org) {
    if (!this.cfgs.has(org)) this.cfgs.set(org, mitigacao.configDdos(this.db, org));
    return this.cfgs.get(org);
  }

  /** Uma rodada de avaliação. Devolve { abertos, encerrados } (ids). */
  avaliar(agoraMs) {
    const fimSeg = Math.floor(agoraMs / 1000) - 1;
    const r = { abertos: [], encerrados: [] };
    const vistos = new Set();
    for (const c of this.ag.contadores.values()) {
      const chave = `${c.org}|${c.texto}|${c.dir}`;
      const ativo = this.ativos.get(chave);
      const limites = (this.limites.get(c.org)?.get(c.grupoId) ?? []).filter((l) => l.escopo === c.escopo && l.direcao === c.dir);
      if (ativo) {
        vistos.add(chave);
        if (this.atualizar(c, ativo, agoraMs, fimSeg)) r.encerrados.push(ativo.id);
        continue;
      }
      c.ataqueId = null;
      let pior = null;
      for (const l of limites) {
        const taxa = c.taxa(l.metrica, l.janela_s, fimSeg);
        const razao = taxa / l.limite;
        if (razao > 1 && (!pior || razao > pior.razao)) pior = { l, taxa, razao };
      }
      if (!pior) { c.violacoes = 0; c.captura = null; continue; }
      c.violacoes++;
      c.captura ??= novaCaptura();
      if (c.violacoes >= this.cfg(c.org).confirmacoes) {
        const a = this.abrir(c, pior, agoraMs, fimSeg);
        if (a) { r.abertos.push(a.id); vistos.add(chave); }
      }
    }
    // Ataques sem tráfego algum (o contador saiu da memória ou o processo reiniciou): encerram pelo tempo sem medição.
    for (const [chave, a] of this.ativos) {
      if (vistos.has(chave)) continue;
      const cfg = this.cfg(a.organizacao_id);
      if (agoraMs - Date.parse(a.ultima_atualizacao) >= cfg.encerrar_apos_s * 1000) {
        this.encerrar(a, 'Tráfego normalizado (sem medições acima do limite).');
        r.encerrados.push(a.id);
      }
    }
    return r;
  }

  abrir(c, pior, agoraMs, fimSeg) {
    const db = this.db;
    const { l } = pior;
    const resumo = resumoCaptura(c.captura);
    const vetor = mitigacao.classificarVetor(resumo);
    const severidade = pior.razao >= 5 ? 'critica' : l.severidade;
    const t = new Date(agoraMs).toISOString();
    const bps = c.taxa('bps', 10, fimSeg);
    const pps = c.taxa('pps', 10, fimSeg);
    const fps = c.taxa('fps', 10, fimSeg);
    const grupo = this.grupos.get(c.grupoId);
    let a;
    db.exec('BEGIN IMMEDIATE');
    try {
      const numero = proximoNumero(db, c.org, 'ataque');
      const id = Number(db.prepare(`INSERT INTO ataques (organizacao_id, numero, grupo_id, alvo, alvo_tipo, versao_ip, direcao, vetor, metrica, limite, janela_s, severidade,
        inicio, ultima_atualizacao, atual_bps, atual_pps, pico_bps, pico_pps, pico_fps, origens, portas_origem, portas_destino, protocolos, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.org, numero, c.grupoId, c.texto, c.escopo, c.v, c.dir, vetor.vetor,
        l.metrica, l.limite, l.janela_s, severidade, t, t, bps, pps, bps, pps, fps, JSON.stringify(resumo?.origens ?? []), JSON.stringify(resumo?.portasOrigem ?? []),
        JSON.stringify(resumo?.portasDestino ?? []), JSON.stringify(resumo?.protocolos ?? []), t).lastInsertRowid);
      db.prepare('INSERT INTO ataque_eventos (ataque_id, tipo, detalhes, em) VALUES (?, ?, ?, ?)').run(id, 'inicio',
        JSON.stringify({ metrica: l.metrica, medido: pior.taxa, limite: l.limite, janela_s: l.janela_s, limite_id: l.id }), t);
      db.prepare('INSERT OR IGNORE INTO ataque_serie (ataque_id, em, bps, pps) VALUES (?, ?, ?, ?)').run(id, t, bps, pps);
      a = db.prepare('SELECT * FROM ataques WHERE id = ?').get(id);
      const alvo = c.escopo === 'ip' ? c.texto : `grupo ${grupo?.nome ?? c.grupoId} (soma do grupo)`;
      avisos.enfileirar(db, c.org, 'ataque_inicio', { severidade, recurso: 'ataque', recursoId: id, texto: [
        `🚨 Ataque detectado #${numero} (${DIRECAO[c.dir]})`,
        `Alvo: ${alvo}${grupo && c.escopo === 'ip' ? ` · ${grupo.nome}` : ''}`,
        `Vetor: ${vetor.vetor}`,
        `Medido: ${fmt.metrica(l.metrica, pior.taxa)} (limite ${fmt.metrica(l.metrica, l.limite)} em ${l.janela_s} s)`,
        `Tráfego: ${fmt.bits(bps)} · ${fmt.pacotes(pps)}`,
        `Início: ${fmt.dataHora(t, this.fuso(c.org))}`].join('\n') });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (/UNIQUE/.test(err.message)) return null; // outro processo já abriu
      throw err;
    }
    const chave = `${c.org}|${c.texto}|${c.dir}`;
    this.ativos.set(chave, a);
    this.estado.set(chave, { okDesde: null, ultimaSerie: agoraMs });
    c.violacoes = 0;
    c.ataqueId = a.id;
    // Mitigação automática ou pedido de aprovação, conforme a política do grupo (só ataques de entrada a um IP).
    if (c.dir === 'entrada' && c.escopo === 'ip' && grupo && grupo.mitigacao_modo !== 'desligada') {
      try {
        mitigacao.solicitar(db, c.org, { tipo: grupo.mitigacao_tipo, alvo: c.texto, ataqueId: a.id, vetor, duracaoMin: grupo.mitigacao_duracao_min,
          origem: 'automatica', aprovar: grupo.mitigacao_modo === 'automatica' });
      } catch (err) {
        db.prepare('INSERT INTO ataque_eventos (ataque_id, tipo, detalhes, em) VALUES (?, ?, ?, ?)').run(a.id, 'mitigacao_erro', err.message, agora());
      }
    }
    return a;
  }

  /** Atualiza um ataque ativo. Devolve true se encerrou. */
  atualizar(c, a, agoraMs, fimSeg) {
    const chave = `${c.org}|${c.texto}|${c.dir}`;
    const est = this.estado.get(chave) ?? { okDesde: null, ultimaSerie: 0 };
    this.estado.set(chave, est);
    c.ataqueId = a.id;
    c.captura ??= novaCaptura();
    const cfg = this.cfg(c.org);
    const taxa = c.taxa(a.metrica, a.janela_s, fimSeg);
    const bps = c.taxa('bps', 10, fimSeg);
    const pps = c.taxa('pps', 10, fimSeg);
    const fps = c.taxa('fps', 10, fimSeg);
    const t = new Date(agoraMs).toISOString();
    if (taxa < a.limite * cfg.fator_recuperacao) est.okDesde ??= agoraMs;
    else est.okDesde = null;
    const db = this.db;
    const resumo = agoraMs - est.ultimaSerie >= 10_000 ? resumoCaptura(c.captura) : null;
    if (resumo) {
      est.ultimaSerie = agoraMs;
      db.prepare('INSERT OR IGNORE INTO ataque_serie (ataque_id, em, bps, pps) VALUES (?, ?, ?, ?)').run(a.id, t, bps, pps);
      const vetor = mitigacao.classificarVetor(resumo);
      db.prepare(`UPDATE ataques SET vetor = ?, origens = ?, portas_origem = ?, portas_destino = ?, protocolos = ?, total_bytes = ? WHERE id = ? AND status = 'ativo'`)
        .run(vetor.vetor, JSON.stringify(resumo.origens), JSON.stringify(resumo.portasOrigem), JSON.stringify(resumo.portasDestino), JSON.stringify(resumo.protocolos),
          resumo.bytes, a.id);
    }
    const pico = { bps: Math.max(a.pico_bps, bps), pps: Math.max(a.pico_pps, pps), fps: Math.max(a.pico_fps, fps) };
    const sev = a.severidade !== 'critica' && taxa / a.limite >= 5 ? 'critica' : a.severidade;
    // Com o tráfego normalizado, a última atualização congela: ela marca o fim do ataque.
    db.prepare(`UPDATE ataques SET atual_bps = ?, atual_pps = ?, pico_bps = ?, pico_pps = ?, pico_fps = ?, severidade = ?, ultima_atualizacao = ?
      WHERE id = ? AND status = 'ativo'`).run(bps, pps, pico.bps, pico.pps, pico.fps, sev, est.okDesde ? new Date(est.okDesde).toISOString() : t, a.id);
    Object.assign(a, { atual_bps: bps, atual_pps: pps, pico_bps: pico.bps, pico_pps: pico.pps, pico_fps: pico.fps, severidade: sev });
    if (est.okDesde && agoraMs - est.okDesde >= cfg.encerrar_apos_s * 1000) {
      this.encerrar(a, `Tráfego abaixo de ${Math.round(cfg.fator_recuperacao * 100)}% do limite por ${cfg.encerrar_apos_s} s.`, new Date(est.okDesde).toISOString());
      c.captura = null;
      c.violacoes = 0;
      c.ataqueId = null;
      return true;
    }
    return false;
  }

  encerrar(a, motivo, fim = agora()) {
    const db = this.db;
    const ok = db.prepare("UPDATE ataques SET status = 'encerrado', fim = ?, motivo_encerramento = ? WHERE id = ? AND status = 'ativo'").run(fim, motivo, a.id).changes;
    this.ativos.delete(`${a.organizacao_id}|${a.alvo}|${a.direcao}`);
    this.estado.delete(`${a.organizacao_id}|${a.alvo}|${a.direcao}`);
    if (!ok) return;
    db.prepare('INSERT INTO ataque_eventos (ataque_id, tipo, detalhes, em) VALUES (?, ?, ?, ?)').run(a.id, 'fim', motivo, agora());
    const x = db.prepare('SELECT * FROM ataques WHERE id = ?').get(a.id);
    avisos.enfileirar(db, a.organizacao_id, 'ataque_fim', { severidade: x.severidade, recurso: 'ataque', recursoId: a.id, texto: [
      `✅ Ataque encerrado #${x.numero} (${DIRECAO[x.direcao]})`, `Alvo: ${x.alvo}`, `Vetor: ${x.vetor ?? '—'}`,
      `Pico: ${fmt.bits(x.pico_bps)} · ${fmt.pacotes(x.pico_pps)}`, `Duração: ${fmt.duracao(Date.parse(x.fim) - Date.parse(x.inicio))}`].join('\n') });
  }

  fuso(org) {
    return this.db.prepare('SELECT fuso FROM organizacoes WHERE id = ?').get(org)?.fuso ?? 'America/Sao_Paulo';
  }
}

module.exports = { Detector, DIRECAO };
