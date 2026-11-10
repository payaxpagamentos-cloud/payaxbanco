'use strict';

/*
 * Ações de bloqueio por BGP: blackhole (RTBH), FlowSpec e desvio para limpeza em linha.
 *
 * O Manager Network NÃO entra nos roteadores: ele gera os anúncios e o ExaBGP do provedor (scripts/exabgp-sincronizar.js)
 * lê a lista de anúncios ativos pela API do coletor e anuncia/retira na sessão BGP. Toda ação passa pelas proteções:
 *   - lista "nunca bloquear" (nenhuma sobreposição com o prefixo da ação);
 *   - limite de ações simultâneas da organização;
 *   - prefixo mínimo (blackhole só de host; limpeza no tamanho configurado);
 *   - retirada automática no prazo (expira_em) e registro de quem pediu, aprovou e retirou.
 */

const { agora, transacao } = require('../db');
const { lerIp, lerPrefixo, contemPrefixo, ipTexto, redeDe } = require('./ip');
const { ErroNegocio } = require('./erros');
const { registrar } = require('./auditoria');
const avisos = require('./avisos');
const fmt = require('./formato');

const TIPOS = { blackhole: 'Blackhole (RTBH)', flowspec: 'FlowSpec', limpeza: 'Limpeza em linha' };

/** Configuração do Anti-DDoS da organização (criada com os padrões na primeira leitura). */
function configDdos(db, org) {
  db.prepare('INSERT OR IGNORE INTO ddos_config (organizacao_id, atualizado_em) VALUES (?, ?)').run(org, agora());
  return db.prepare('SELECT * FROM ddos_config WHERE organizacao_id = ?').get(org);
}

/** Portas de amplificação conhecidas (porta de ORIGEM do tráfego refletido). */
const AMPLIFICACAO = { 53: 'DNS', 123: 'NTP', 1900: 'SSDP', 11211: 'Memcached', 389: 'CLDAP', 19: 'Chargen', 161: 'SNMP', 3702: 'WS-Discovery',
  37810: 'DVR', 3283: 'Apple Remote Desktop', 10001: 'Ubiquiti', 17: 'QOTD', 111: 'Portmap', 5353: 'mDNS', 1434: 'MS-SQL', 27015: 'Steam', 520: 'RIP',
  5683: 'CoAP', 3478: 'STUN', 500: 'IKE', 1194: 'OpenVPN', 6881: 'BitTorrent', 81: 'Câmeras IP' };
const NOMES_PROTO = { 1: 'ICMP', 6: 'TCP', 17: 'UDP', 47: 'GRE', 50: 'ESP', 58: 'ICMPv6' };

/**
 * Vetor do ataque a partir da captura: amplificação (porta de origem UDP dominante conhecida), SYN flood, ICMP, fragmentos, etc.
 * Devolve { vetor, proto, portaOrigem? }.
 */
function classificarVetor(r) {
  if (!r || !r.bytes) return { vetor: 'Volumétrico (sem detalhe)', proto: null };
  const proto = Number(r.protocolos[0]?.chave ?? 0);
  const fatia = (x) => (x ? x.bytes / r.bytes : 0);
  if (proto === 17) {
    const p = r.portasOrigem[0];
    const porta = p ? Number(p.chave.split('/')[1]) : null;
    if (p && fatia(p) >= 0.5 && AMPLIFICACAO[porta]) return { vetor: `Amplificação ${AMPLIFICACAO[porta]} (UDP ${porta})`, proto, portaOrigem: porta };
    if (p && porta === 0 && fatia(p) >= 0.5) return { vetor: 'Fragmentos UDP', proto, portaOrigem: 0 };
    return { vetor: 'UDP flood', proto };
  }
  if (proto === 6) return r.syn >= r.pkts * 0.5 ? { vetor: 'SYN flood', proto, syn: true } : { vetor: 'TCP flood', proto };
  if (proto === 1 || proto === 58) return { vetor: 'ICMP flood', proto };
  return { vetor: `${NOMES_PROTO[proto] ?? `Protocolo ${proto}`} flood`, proto };
}

/** Prefixo e regra da ação, conforme o tipo. alvo: IP ou prefixo em texto. vetor: resultado de classificarVetor (FlowSpec). */
function construir(cfg, tipo, alvo, vetor = null) {
  const p = lerPrefixo(alvo);
  if (!p) throw new ErroNegocio('Endereço ou prefixo inválido.', 422);
  const max = p.v === 4 ? 32 : 128;
  if (tipo === 'blackhole') {
    if (p.len !== max) throw new ErroNegocio('Blackhole só é aplicado a um único IP (/32 ou /128), nunca a um bloco.', 422);
    return { prefixo: p.texto, v: p.v, regra: null };
  }
  if (tipo === 'limpeza') {
    const len = p.v === 4 ? cfg.limpeza_prefixo_v4 : cfg.limpeza_prefixo_v6;
    if (!cfg.bgp_next_hop_limpeza) throw new ErroNegocio('Configure o next-hop da limpeza em linha antes de desviar tráfego.', 422);
    const rede = redeDe(p.v, p.rede, Math.min(len, p.len));
    return { prefixo: `${ipTexto(p.v, rede)}/${Math.min(len, p.len)}`, v: p.v, regra: null };
  }
  // FlowSpec: destino + o que caracteriza o ataque (protocolo, porta de origem da amplificação, SYN)
  const regra = { destino: p.texto };
  if (vetor?.proto) regra.protocolo = vetor.proto;
  if (vetor?.portaOrigem !== undefined && vetor?.portaOrigem !== null) regra.porta_origem = vetor.portaOrigem;
  if (vetor?.syn) regra.tcp_flags = 'syn';
  regra.acao = cfg.flowspec_acao === 'rate-limit' && cfg.flowspec_taxa_bps ? { limitar_bps: cfg.flowspec_taxa_bps } : 'descartar';
  return { prefixo: p.texto, v: p.v, regra };
}

/** Motivo pelo qual a ação não pode ser ativada agora, ou null. */
function protecoes(db, org, cfg, prefixo, { ignorarId = null } = {}) {
  const p = lerPrefixo(prefixo);
  for (const n of db.prepare('SELECT prefixo, motivo FROM nunca_bloquear WHERE organizacao_id = ?').all(org)) {
    const q = lerPrefixo(n.prefixo);
    if (q && (contemPrefixo(q, p) || contemPrefixo(p, q))) return `Atinge ${n.prefixo}, que está na lista "nunca bloquear" (${n.motivo}).`;
  }
  const ativas = db.prepare("SELECT COUNT(*) AS n FROM mitigacoes WHERE organizacao_id = ? AND status = 'ativa' AND id IS NOT ?").get(org, ignorarId).n;
  if (ativas >= cfg.max_acoes_simultaneas) return `Limite de ${cfg.max_acoes_simultaneas} ações simultâneas atingido. Retire uma ação ou aumente o limite.`;
  return null;
}

const evento = (db, ataqueId, tipo, detalhes, usuarioId = null) => {
  if (!ataqueId) return;
  db.prepare('INSERT INTO ataque_eventos (ataque_id, tipo, detalhes, usuario_id, em) VALUES (?, ?, ?, ?, ?)')
    .run(ataqueId, tipo, typeof detalhes === 'string' ? detalhes : JSON.stringify(detalhes), usuarioId, agora());
};

function descricao(m) {
  return `${TIPOS[m.tipo]} em ${m.prefixo}${m.regra ? ` (${resumoRegra(typeof m.regra === 'string' ? JSON.parse(m.regra) : m.regra)})` : ''}`;
}
function resumoRegra(r) {
  if (!r) return '';
  return [r.protocolo ? (NOMES_PROTO[r.protocolo] ?? `proto ${r.protocolo}`) : null, r.porta_origem !== undefined ? `porta de origem ${r.porta_origem}` : null,
    r.tcp_flags ? 'só SYN' : null, r.acao === 'descartar' ? 'descartar' : r.acao?.limitar_bps ? `limitar a ${fmt.bits(r.acao.limitar_bps)}` : null].filter(Boolean).join(', ');
}

function ativarLinha(db, id, usuarioId, duracaoMin) {
  const t = agora();
  db.prepare(`UPDATE mitigacoes SET status = 'ativa', aprovada_em = COALESCE(aprovada_em, ?), aprovada_por = COALESCE(aprovada_por, ?), ativada_em = ?, expira_em = ?,
    versao = versao + 1 WHERE id = ?`).run(t, usuarioId, t, new Date(Date.now() + duracaoMin * 60_000).toISOString(), id);
}

/**
 * Pede uma ação. origem 'automatica' (detecção) ou 'manual' (operador). aprovar=true ativa já (automática, ou operador que pediu).
 * Se já houver ação vigente igual (mesmo tipo e prefixo), devolve a existente; se ativa, estende o prazo.
 */
function solicitar(db, org, { tipo, alvo, ataqueId = null, vetor = null, duracaoMin = null, origem, usuarioId = null, aprovar = false, req = null, motivo = null }) {
  const cfg = configDdos(db, org);
  const dur = Math.min(duracaoMin ?? cfg.duracao_padrao_min, cfg.max_duracao_min);
  const { prefixo, v, regra } = construir(cfg, tipo, alvo, vetor);
  return transacao(db, () => {
    const existente = db.prepare("SELECT * FROM mitigacoes WHERE organizacao_id = ? AND tipo = ? AND prefixo = ? AND status IN ('aguardando_aprovacao','ativa')").get(org, tipo, prefixo);
    if (existente) {
      if (existente.status === 'ativa') {
        const expira = new Date(Math.max(Date.parse(existente.expira_em), Date.now() + dur * 60_000)).toISOString();
        db.prepare('UPDATE mitigacoes SET expira_em = ?, versao = versao + 1 WHERE id = ?').run(expira, existente.id);
        evento(db, ataqueId, 'mitigacao_estendida', { mitigacao: existente.id, expira_em: expira });
      }
      return { ...db.prepare('SELECT * FROM mitigacoes WHERE id = ?').get(existente.id), existente: true };
    }
    const bloqueio = protecoes(db, org, cfg, prefixo);
    const status = bloqueio ? 'bloqueada' : aprovar ? 'ativa' : 'aguardando_aprovacao';
    const t = agora();
    const id = Number(db.prepare(`INSERT INTO mitigacoes (organizacao_id, ataque_id, tipo, prefixo, versao_ip, regra, status, origem, motivo, duracao_min, solicitada_em, solicitada_por, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, 'aguardando_aprovacao', ?, ?, ?, ?, ?, ?)`).run(org, ataqueId, tipo, prefixo, v, regra ? JSON.stringify(regra) : null, origem,
      bloqueio ?? motivo, dur, t, usuarioId, t).lastInsertRowid);
    if (status === 'ativa') ativarLinha(db, id, usuarioId, dur);
    else if (status === 'bloqueada') db.prepare("UPDATE mitigacoes SET status = 'bloqueada' WHERE id = ?").run(id);
    const m = db.prepare('SELECT * FROM mitigacoes WHERE id = ?').get(id);
    evento(db, ataqueId, `mitigacao_${status}`, { mitigacao: id, descricao: descricao(m), motivo: bloqueio }, usuarioId);
    registrar(db, req, `mitigacao_${origem}`, { recurso: 'mitigacao', recursoId: id, organizacaoId: org, depois: { tipo, prefixo, regra, status, motivo: bloqueio, duracao_min: dur } });
    const ev = { ativa: 'mitigacao_ativa', bloqueada: 'mitigacao_bloqueada', aguardando_aprovacao: 'mitigacao_pendente' }[status];
    avisos.enfileirar(db, org, ev, { severidade: 'alta', recurso: 'mitigacao', recursoId: id,
      texto: `${avisos.EVENTOS[ev]}: ${descricao(m)}${bloqueio ? `\nMotivo: ${bloqueio}` : ''}${status === 'ativa' ? `\nRetirada automática em ${dur} min.` : ''}` });
    return m;
  });
}

function obter(db, org, id) {
  const m = db.prepare('SELECT * FROM mitigacoes WHERE id = ? AND organizacao_id = ?').get(Number(id), org);
  if (!m) throw new ErroNegocio('Ação de bloqueio não encontrada.', 404);
  return m;
}

/** Aprovação manual: confere as proteções de novo (a situação pode ter mudado desde o pedido). */
function aprovar(db, org, id, req) {
  return transacao(db, () => {
    const m = obter(db, org, id);
    if (m.status !== 'aguardando_aprovacao') throw new ErroNegocio('Esta ação não está aguardando aprovação.', 409);
    const cfg = configDdos(db, org);
    const bloqueio = protecoes(db, org, cfg, m.prefixo);
    if (bloqueio) throw new ErroNegocio(bloqueio, 409);
    ativarLinha(db, m.id, req.usuario.id, m.duracao_min);
    const x = db.prepare('SELECT * FROM mitigacoes WHERE id = ?').get(m.id);
    evento(db, m.ataque_id, 'mitigacao_aprovada', { mitigacao: m.id, descricao: descricao(m) }, req.usuario.id);
    registrar(db, req, 'mitigacao_aprovada', { recurso: 'mitigacao', recursoId: m.id, antes: { status: m.status }, depois: { status: 'ativa', expira_em: x.expira_em } });
    avisos.enfileirar(db, org, 'mitigacao_ativa', { severidade: 'alta', recurso: 'mitigacao', recursoId: m.id,
      texto: `${avisos.EVENTOS.mitigacao_ativa}: ${descricao(m)}\nAprovado por ${req.usuario.nome}. Retirada automática em ${m.duracao_min} min.` });
    return x;
  });
}

function recusar(db, org, id, motivo, req) {
  return transacao(db, () => {
    const m = obter(db, org, id);
    if (m.status !== 'aguardando_aprovacao') throw new ErroNegocio('Esta ação não está aguardando aprovação.', 409);
    db.prepare("UPDATE mitigacoes SET status = 'recusada', retirada_em = ?, retirada_por = ?, motivo_retirada = ?, versao = versao + 1 WHERE id = ?")
      .run(agora(), req.usuario.id, motivo, m.id);
    evento(db, m.ataque_id, 'mitigacao_recusada', { mitigacao: m.id, motivo }, req.usuario.id);
    registrar(db, req, 'mitigacao_recusada', { recurso: 'mitigacao', recursoId: m.id, antes: { status: m.status }, depois: { status: 'recusada', motivo } });
    return db.prepare('SELECT * FROM mitigacoes WHERE id = ?').get(m.id);
  });
}

/** Retira uma ação ativa (operador ou prazo). req null = retirada automática. */
function retirar(db, org, id, motivo, req = null) {
  return transacao(db, () => {
    const m = obter(db, org, id);
    if (m.status !== 'ativa') throw new ErroNegocio('Esta ação não está ativa.', 409);
    db.prepare("UPDATE mitigacoes SET status = 'retirada', retirada_em = ?, retirada_por = ?, motivo_retirada = ?, versao = versao + 1 WHERE id = ?")
      .run(agora(), req?.usuario?.id ?? null, motivo, m.id);
    evento(db, m.ataque_id, 'mitigacao_retirada', { mitigacao: m.id, motivo }, req?.usuario?.id ?? null);
    registrar(db, req, 'mitigacao_retirada', { recurso: 'mitigacao', recursoId: m.id, organizacaoId: org, antes: { status: 'ativa' }, depois: { status: 'retirada', motivo } });
    avisos.enfileirar(db, org, 'mitigacao_retirada', { severidade: 'media', recurso: 'mitigacao', recursoId: m.id,
      texto: `${avisos.EVENTOS.mitigacao_retirada}: ${descricao(m)}\n${motivo}${req?.usuario ? ` (${req.usuario.nome})` : ''}` });
    return db.prepare('SELECT * FROM mitigacoes WHERE id = ?').get(m.id);
  });
}

function prorrogar(db, org, id, minutos, req) {
  return transacao(db, () => {
    const m = obter(db, org, id);
    if (m.status !== 'ativa') throw new ErroNegocio('Só uma ação ativa pode ser prorrogada.', 409);
    const cfg = configDdos(db, org);
    const limite = Date.parse(m.ativada_em) + cfg.max_duracao_min * 60_000;
    const nova = Math.min(Date.parse(m.expira_em) + minutos * 60_000, limite);
    if (nova <= Date.parse(m.expira_em)) throw new ErroNegocio(`A ação já está no prazo máximo (${cfg.max_duracao_min} min).`, 409);
    db.prepare('UPDATE mitigacoes SET expira_em = ?, versao = versao + 1 WHERE id = ?').run(new Date(nova).toISOString(), m.id);
    evento(db, m.ataque_id, 'mitigacao_prorrogada', { mitigacao: m.id, expira_em: new Date(nova).toISOString() }, req.usuario.id);
    registrar(db, req, 'mitigacao_prorrogada', { recurso: 'mitigacao', recursoId: m.id, antes: { expira_em: m.expira_em }, depois: { expira_em: new Date(nova).toISOString() } });
    return db.prepare('SELECT * FROM mitigacoes WHERE id = ?').get(m.id);
  });
}

/** Retirada automática das ações cujo prazo terminou. */
function expirar(db) {
  const vencidas = db.prepare("SELECT id, organizacao_id FROM mitigacoes WHERE status = 'ativa' AND expira_em <= ?").all(agora());
  for (const m of vencidas) {
    try { retirar(db, m.organizacao_id, m.id, 'Retirada automática: prazo da ação terminou.'); } catch { /* já retirada por outra pessoa */ }
  }
  return vencidas.length;
}

// ---------------------------------------------------------------- Anúncios BGP (ExaBGP)
/** Linhas de anúncio e retirada no formato da API de texto do ExaBGP. */
function comandos(m, cfg) {
  const regra = typeof m.regra === 'string' ? JSON.parse(m.regra) : m.regra;
  if (m.tipo === 'blackhole') {
    const nh = m.versao_ip === 4 ? cfg.bgp_next_hop_blackhole : cfg.bgp_next_hop_blackhole_v6;
    const corpo = `route ${m.prefixo} next-hop ${nh} community [${cfg.bgp_community_blackhole}] no-export`;
    return { anunciar: `announce ${corpo}`, retirar: `withdraw route ${m.prefixo} next-hop ${nh}` };
  }
  if (m.tipo === 'limpeza') {
    const corpo = `route ${m.prefixo} next-hop ${cfg.bgp_next_hop_limpeza}${cfg.bgp_community_limpeza ? ` community [${cfg.bgp_community_limpeza}]` : ''}`;
    return { anunciar: `announce ${corpo}`, retirar: `withdraw route ${m.prefixo} next-hop ${cfg.bgp_next_hop_limpeza}` };
  }
  const match = [`destination ${regra.destino};`];
  if (regra.protocolo) match.push(`protocol =${regra.protocolo};`);
  if (regra.porta_origem !== undefined) match.push(`source-port =${regra.porta_origem};`);
  if (regra.tcp_flags === 'syn') match.push('tcp-flags [ syn ];');
  const entao = regra.acao === 'descartar' ? 'discard;' : `rate-limit ${Math.round(regra.acao.limitar_bps / 8)};`; // ExaBGP: bytes/s
  const corpo = `flow route { match { ${match.join(' ')} } then { ${entao} } }`;
  return { anunciar: `announce ${corpo}`, retirar: `withdraw ${corpo}` };
}

/** Anúncios ativos da organização (lidos pelo ExaBGP). */
function anunciosAtivos(db, org) {
  const cfg = configDdos(db, org);
  return db.prepare("SELECT * FROM mitigacoes WHERE organizacao_id = ? AND status = 'ativa' ORDER BY id").all(org)
    .map((m) => ({ id: m.id, tipo: m.tipo, prefixo: m.prefixo, expira_em: m.expira_em, ...comandos(m, cfg) }));
}

/** Endereço válido? (para as telas e a configuração do next-hop) */
const ipValido = (t) => Boolean(lerIp(t));

module.exports = { TIPOS, AMPLIFICACAO, NOMES_PROTO, configDdos, classificarVetor, construir, protecoes, solicitar, aprovar, recusar, retirar, prorrogar, expirar,
  comandos, anunciosAtivos, descricao, resumoRegra, ipValido };
