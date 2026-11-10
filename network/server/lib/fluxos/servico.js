'use strict';

/*
 * Coletor de rede: recebe flows (NetFlow v5/v9, IPFIX, sFlow) e a contabilidade RADIUS por UDP, conta o tráfego, detecta
 * ataques e grava as somas no banco. Só aceita pacotes de exportadores e NAS cadastrados (pelo IP de origem).
 *
 * Laços: avaliação dos limites a cada 5 s; gravação das somas a cada virada de minuto; recarga da configuração (grupos,
 * limites, exportadores, NAS) e das estatísticas a cada 10 s; limpeza da memória a cada 30 s.
 */

const dgram = require('node:dgram');
const { decodificar, EstadoTemplates } = require('./decodificar');
const { Agregador } = require('./agregador');
const { Detector } = require('./deteccao');
const radius = require('../radius');
const { decifrar } = require('../cripto');
const { garantirCatalogo } = require('../conteudo');

const semPrefixoV4 = (a) => (a.startsWith('::ffff:') ? a.slice(7) : a);

function iniciarColetorRede(db, { host = '0.0.0.0', portasFluxo = [], portaRadius = null, bufferBytes = 8 * 1024 * 1024, relogio = Date.now, lacos = true } = {}) {
  const ag = new Agregador();
  const det = new Detector(db, ag);
  const templates = new EstadoTemplates();
  let exportadores = new Map();
  let nas = new Map();
  const est = new Map(); // id do exportador → contadores desde a última gravação
  const estNas = new Map();
  const desconhecidos = { fluxo: new Map(), radius: new Map() };
  const sockets = [];
  const timers = [];

  function recarregar() {
    ag.carregarGrupos(db);
    for (const { organizacao_id: org } of db.prepare('SELECT DISTINCT organizacao_id FROM exportadores_fluxo').all()) garantirCatalogo(db, org);
    ag.carregarConteudos(db);
    det.carregar();
    exportadores = new Map(db.prepare('SELECT * FROM exportadores_fluxo WHERE ativo = 1').all().map((e) => [e.ip, e]));
    nas = new Map(db.prepare('SELECT * FROM radius_nas WHERE ativo = 1').all().map((n) => {
      try { return [n.ip, { ...n, segredo: decifrar(n.segredo_cifrado) }]; } catch { return [n.ip, { ...n, segredo: null }]; }
    }));
  }

  const somar = (mapa, id) => {
    let s = mapa.get(id);
    if (!s) { s = { pacotes: 0, fluxos: 0, erros: 0, semTemplate: 0, formato: null, ultimo: null, erro: null }; mapa.set(id, s); }
    return s;
  };

  function aoFluxo(msg, rinfo) {
    const ip = semPrefixoV4(rinfo.address);
    const e = exportadores.get(ip);
    if (!e) { desconhecidos.fluxo.set(ip, (desconhecidos.fluxo.get(ip) ?? 0) + 1); return; }
    const s = somar(est, e.id);
    s.pacotes++;
    s.ultimo = relogio();
    try {
      const r = decodificar(msg, { exportador: ip, taxaPadrao: e.taxa_amostragem, estado: templates });
      s.formato = r.versao === 'sflow5' ? 'sFlow v5' : r.versao === 10 ? 'IPFIX' : `NetFlow v${r.versao}`;
      s.semTemplate += r.semTemplate;
      s.fluxos += r.fluxos.length;
      const t = relogio();
      for (const f of r.fluxos) ag.registrar(f, { org: e.organizacao_id, papel: e.papel }, t);
    } catch (err) {
      s.erros++;
      s.erro = err.message;
    }
  }

  function aoRadius(msg, rinfo, sock) {
    const ip = semPrefixoV4(rinfo.address);
    const n = nas.get(ip);
    if (!n) { desconhecidos.radius.set(ip, (desconhecidos.radius.get(ip) ?? 0) + 1); return; }
    const s = somar(estNas, n.id);
    s.pacotes++;
    s.ultimo = relogio();
    try {
      if (!n.segredo) throw new Error('segredo do NAS ilegível (chave de credenciais trocada?)');
      const pkt = radius.lerPacote(msg);
      if (pkt.codigo !== 4) throw new Error(`código RADIUS ${pkt.codigo} ignorado (só Accounting-Request)`);
      if (!radius.conferir(msg, n.segredo)) throw new Error('autenticador inválido: segredo diferente do configurado no BRAS');
      const ev = radius.evento(pkt, ip);
      if (ev.tipo) radius.registrarSessao(db, n.organizacao_id, ev, 'radius');
      sock.send(radius.resposta(msg, n.segredo), rinfo.port, rinfo.address);
    } catch (err) {
      s.erros++;
      s.erro = err.message;
    }
  }

  /** Grava as estatísticas de recebimento de cada exportador e NAS. */
  function gravarEstatisticas() {
    for (const [id, s] of est) {
      db.prepare(`UPDATE exportadores_fluxo SET pacotes = pacotes + ?, fluxos = fluxos + ?, erros = erros + ?, sem_template = sem_template + ?,
        formato = COALESCE(?, formato), ultimo_pacote = COALESCE(?, ultimo_pacote), ultimo_erro = COALESCE(?, ultimo_erro) WHERE id = ?`)
        .run(s.pacotes, s.fluxos, s.erros, s.semTemplate, s.formato, s.ultimo ? new Date(s.ultimo).toISOString() : null, s.erro, id);
    }
    est.clear();
    for (const [id, s] of estNas) {
      db.prepare(`UPDATE radius_nas SET pacotes = pacotes + ?, erros = erros + ?, ultimo_pacote = COALESCE(?, ultimo_pacote), ultimo_erro = COALESCE(?, ultimo_erro) WHERE id = ?`)
        .run(s.pacotes, s.erros, s.ultimo ? new Date(s.ultimo).toISOString() : null, s.erro, id);
    }
    estNas.clear();
  }

  const proteger = (nome, fn) => () => { try { fn(); } catch (err) { console.error(`[Network] Coletor de rede (${nome}):`, err.message); } };

  recarregar();
  const tipo = host.includes(':') ? 'udp6' : 'udp4';
  const abrir = (porta, aoMsg) => new Promise((ok, falha) => {
    const s = dgram.createSocket({ type: tipo, reuseAddr: false, recvBufferSize: bufferBytes });
    s.on('message', (m, r) => aoMsg(m, r, s));
    s.once('error', falha);
    s.bind(porta, host, () => {
      try { s.setRecvBufferSize(bufferBytes); } catch { /* o sistema limita (net.core.rmem_max) */ }
      sockets.push(s);
      ok(s.address().port);
    });
  });

  const pronto = (async () => {
    const portas = { fluxo: [], radius: null };
    for (const p of portasFluxo) portas.fluxo.push(await abrir(p, aoFluxo));
    if (Number.isInteger(portaRadius)) portas.radius = await abrir(portaRadius, aoRadius);
    return portas;
  })();

  if (lacos) {
    timers.push(setInterval(proteger('detecção', () => { det.avaliar(relogio()); ag.gravarTempoReal(db, relogio()); }), 5000));
    timers.push(setInterval(proteger('configuração', () => { gravarEstatisticas(); recarregar(); }), 10_000));
    timers.push(setInterval(proteger('memória', () => ag.limparOciosos(relogio())), 30_000));
    const proximoMinuto = 60_000 - (Date.now() % 60_000) + 200;
    timers.push(setTimeout(() => {
      proteger('gravação', () => ag.gravar(db, relogio()))();
      timers.push(setInterval(proteger('gravação', () => ag.gravar(db, relogio())), 60_000));
    }, proximoMinuto));
    for (const t of timers) t.unref?.();
  }

  return {
    agregador: ag,
    detector: det,
    pronto,
    recarregar,
    gravarEstatisticas,
    avaliar: () => det.avaliar(relogio()),
    gravar: () => ag.gravar(db, relogio()),
    gravarTempoReal: () => ag.gravarTempoReal(db, relogio()),
    desconhecidos,
    fechar: () => { for (const t of timers) clearInterval(t); for (const s of sockets) s.close(); },
  };
}

module.exports = { iniciarColetorRede };
