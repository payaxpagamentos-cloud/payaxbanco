'use strict';

/*
 * Conteúdos: de onde vem (ou para onde vai) o tráfego dos clientes — Google/YouTube, Netflix, Meta, CDNs...
 *
 * Cada flow de borda tem um lado remoto (a origem na entrada, o destino na saída). O conteúdo é reconhecido, nesta ordem:
 *   1. prefixo cadastrado no catálogo (o mais específico vence);
 *   2. ASN do lado remoto: o que o roteador exporta no flow (src_as/dst_as) ou, sem ele, o da base IP → ASN importada;
 *   3. ASN fora do catálogo aparece pelo número e nome do ASN; sem ASN, como "desconhecido".
 * O flow não mostra o site nem o vídeo: CDNs compartilhadas (Akamai, Cloudflare, AWS) aparecem pelo nome da CDN.
 */

const { agora } = require('../db');
const { TabelaPrefixos, lerPrefixo } = require('./ip');

const CATEGORIAS = { video: 'Vídeo e streaming', redes_sociais: 'Redes sociais', jogos: 'Jogos', nuvem_cdn: 'Nuvem e CDN', musica: 'Música', comunicacao: 'Comunicação',
  software: 'Software e atualizações', outros: 'Outros' };

/** Catálogo inicial (ASNs públicos conhecidos e o logo, de public/js/marcas.js). O provedor confere, ajusta e completa na tela de Conteúdo. */
// Google e YouTube ficam separados, mas o YouTube também é entregue pelos servidores do Google: a separação é estimativa.
const AVISO_YOUTUBE = 'Estimativa: boa parte do vídeo do YouTube chega pelos servidores do Google (AS15169) e conta como Google. Cadastre aqui os prefixos do cache do Google (GGC) na sua rede para separar melhor.';
const AVISO_GOOGLE = 'Inclui a parte do vídeo do YouTube entregue pelos servidores do Google (AS15169), que o flow não separa pelo ASN.';

const CATALOGO_PADRAO = [
  ['Google', 'nuvem_cdn', [15169, 19527, 139070], 'google', AVISO_GOOGLE],
  ['YouTube', 'video', [36040, 43515], 'youtube', AVISO_YOUTUBE],
  ['Netflix', 'video', [2906, 40027, 55095], 'netflix'],
  ['Meta (Facebook, Instagram, WhatsApp)', 'redes_sociais', [32934, 63293], 'meta'],
  ['Amazon (AWS e Prime Video)', 'nuvem_cdn', [16509, 14618]],
  ['Akamai', 'nuvem_cdn', [20940, 16625, 21342, 32787], 'akamai'],
  ['Cloudflare', 'nuvem_cdn', [13335, 209242], 'cloudflare'],
  ['Microsoft (Xbox, Office, Azure)', 'software', [8075, 8068, 12076]],
  ['Apple', 'software', [714, 6185], 'apple'],
  ['TikTok', 'redes_sociais', [396986, 138699], 'tiktok'],
  ['Fastly', 'nuvem_cdn', [54113], 'fastly'],
  ['Twitch', 'video', [46489], 'twitch'],
  ['Valve (Steam)', 'jogos', [32590], 'steam'],
  ['Riot Games', 'jogos', [6507], 'riotgames'],
  ['X (Twitter)', 'redes_sociais', [13414], 'x'],
  ['Spotify', 'musica', [8403], 'spotify'],
];

/** Cria o catálogo padrão uma vez por organização. */
function garantirCatalogo(db, org) {
  db.prepare('INSERT OR IGNORE INTO ddos_config (organizacao_id, atualizado_em) VALUES (?, ?)').run(org, agora());
  if (db.prepare('SELECT conteudos_semeados FROM ddos_config WHERE organizacao_id = ?').get(org).conteudos_semeados) return false;
  const t = agora();
  db.exec('SAVEPOINT catalogo');
  try {
    for (const [nome, categoria, asns, marca = null, aviso = null] of CATALOGO_PADRAO) {
      const id = Number(db.prepare('INSERT OR IGNORE INTO conteudos (organizacao_id, nome, categoria, marca, aviso, padrao, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
        .run(org, nome, categoria, marca, aviso, t, t).lastInsertRowid);
      if (!id) continue;
      for (const asn of asns) db.prepare("INSERT OR IGNORE INTO conteudo_regras (organizacao_id, conteudo_id, tipo, valor, criado_em) VALUES (?, ?, 'asn', ?, ?)").run(org, id, String(asn), t);
    }
    db.prepare('UPDATE ddos_config SET conteudos_semeados = 1 WHERE organizacao_id = ?').run(org);
    db.exec('RELEASE catalogo');
  } catch (err) {
    db.exec('ROLLBACK TO catalogo');
    db.exec('RELEASE catalogo');
    throw err;
  }
  return true;
}

// ---------------------------------------------------------------- Base IP → ASN
const hex = (v, n) => (v === 4 ? n.toString(16).padStart(8, '0') : n.toString(16).padStart(32, '0'));

/** Faixas em memória (ordenadas pelo início) com busca binária. */
class BaseAsn {
  constructor() { this.v4 = { ini: [], fim: [], asn: [] }; this.v6 = { ini: [], fim: [], asn: [] }; this.versao = null; }

  carregar(db) {
    const b = db.prepare('SELECT importado_em FROM asn_base WHERE id = 1').get();
    const versao = b?.importado_em ?? null;
    if (versao === this.versao) return false;
    const v4 = { ini: [], fim: [], asn: [] };
    const v6 = { ini: [], fim: [], asn: [] };
    for (const r of db.prepare('SELECT versao_ip, inicio, fim, asn FROM asn_faixas ORDER BY versao_ip, inicio').iterate()) {
      if (r.versao_ip === 4) { v4.ini.push(Number.parseInt(r.inicio, 16)); v4.fim.push(Number.parseInt(r.fim, 16)); v4.asn.push(r.asn); }
      else { v6.ini.push(BigInt(`0x${r.inicio}`)); v6.fim.push(BigInt(`0x${r.fim}`)); v6.asn.push(r.asn); }
    }
    this.v4 = { ini: Float64Array.from(v4.ini), fim: Float64Array.from(v4.fim), asn: Uint32Array.from(v4.asn) };
    this.v6 = v6;
    this.versao = versao;
    return true;
  }

  get faixas() { return this.v4.ini.length + this.v6.ini.length; }

  buscar(v, n) {
    const t = v === 4 ? this.v4 : this.v6;
    let a = 0;
    let b = t.ini.length - 1;
    while (a <= b) {
      const m = (a + b) >> 1;
      if (t.ini[m] <= n) a = m + 1; else b = m - 1;
    }
    return b >= 0 && n <= t.fim[b] ? t.asn[b] : 0;
  }
}

/** Importa linhas no formato do iptoasn.com (inicio, fim, asn, país, descrição separados por tab). Substitui a base inteira. */
function importarBase(db, linhas, origem) {
  const { lerIp } = require('./ip');
  let n = 0;
  const nomes = new Map();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM asn_faixas; DELETE FROM asn_nomes;');
    const ins = db.prepare('INSERT OR REPLACE INTO asn_faixas (versao_ip, inicio, fim, asn) VALUES (?, ?, ?, ?)');
    for (const linha of linhas) {
      const c = linha.split('\t');
      if (c.length < 3) continue;
      const asn = Number(c[2]);
      const a = lerIp(c[0]);
      const b = lerIp(c[1]);
      if (!asn || !a || !b || a.v !== b.v) continue;
      ins.run(a.v, hex(a.v, a.n), hex(b.v, b.n), asn);
      if (c[4] && !nomes.has(asn)) nomes.set(asn, [c[4].trim().slice(0, 120), (c[3] ?? '').trim().slice(0, 4) || null]);
      n++;
    }
    const insNome = db.prepare('INSERT OR REPLACE INTO asn_nomes (asn, nome, pais) VALUES (?, ?, ?)');
    for (const [asn, [nome, pais]] of nomes) insNome.run(asn, nome, pais);
    db.prepare('INSERT OR REPLACE INTO asn_base (id, origem, faixas, importado_em) VALUES (1, ?, ?, ?)').run(origem, n, agora());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { faixas: n, asns: nomes.size };
}

// ---------------------------------------------------------------- Classificador
class Classificador {
  constructor() {
    this.base = new BaseAsn();
    this.orgs = new Map(); // org → { prefixos: TabelaPrefixos, asns: Map(asn → id) }
    this.cache = new Map();
  }

  carregar(db) {
    this.base.carregar(db);
    const orgs = new Map();
    const pegar = (org) => {
      if (!orgs.has(org)) orgs.set(org, { prefixos: new TabelaPrefixos(), asns: new Map() });
      return orgs.get(org);
    };
    for (const r of db.prepare('SELECT r.organizacao_id AS org, r.tipo, r.valor, r.conteudo_id FROM conteudo_regras r JOIN conteudos c ON c.id = r.conteudo_id WHERE c.ativo = 1').all()) {
      const o = pegar(r.org);
      if (r.tipo === 'asn') o.asns.set(Number(r.valor), r.conteudo_id);
      else if (lerPrefixo(r.valor)) o.prefixos.adicionar(r.valor, r.conteudo_id);
    }
    this.orgs = orgs;
    this.cache.clear();
  }

  /** Chave do conteúdo para o lado remoto (v, n) do flow; asnFlow = ASN exportado pelo roteador (0 se não houver). */
  classificar(org, v, n, asnFlow) {
    const ck = `${org}|${v}|${n}|${asnFlow}`;
    const c = this.cache.get(ck);
    if (c !== undefined) return c;
    const o = this.orgs.get(org);
    let chave;
    const porPrefixo = o?.prefixos.buscar(v, n);
    if (porPrefixo !== undefined) chave = `c:${porPrefixo}`;
    else {
      const asn = asnFlow || this.base.buscar(v, n);
      const id = asn ? o?.asns.get(asn) : undefined;
      chave = id !== undefined ? `c:${id}` : asn ? `as:${asn}` : 'desconhecido';
    }
    if (this.cache.size > 200_000) this.cache.clear();
    this.cache.set(ck, chave);
    return chave;
  }
}

/** Logos disponíveis (public/js/marcas.js). */
const MARCAS = ['google', 'youtube', 'netflix', 'meta', 'akamai', 'cloudflare', 'apple', 'tiktok', 'fastly', 'twitch', 'steam', 'riotgames', 'x', 'spotify', 'whatsapp', 'instagram'];

module.exports = { MARCAS, CATEGORIAS, CATALOGO_PADRAO, garantirCatalogo, BaseAsn, importarBase, Classificador, hex };
