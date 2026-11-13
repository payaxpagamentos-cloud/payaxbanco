'use strict';

const dns = require('node:dns/promises');
const dnsCb = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const config = require('../config');
const { agora } = require('../db');
const { cifrar, decifrar } = require('../lib/cripto');

/** Erro de conexão com a categoria que define o estado da integração (sem_permissao, limite_atingido, falha...). */
class ErroConector extends Error {
  constructor(mensagem, estado = 'falha', { status = null, retryAfterS = null, permanente = false } = {}) {
    super(mensagem);
    this.estado = estado;
    this.status = status;
    this.retryAfterS = retryAfterS;
    this.permanente = permanente;
  }
}

// Faixas que um conector não alcança sem NETWORK_CONECTOR_REDE_INTERNA=1 (rede interna, loopback, link-local, multicast...).
const PRIVADOS = new net.BlockList();
for (const [rede, prefixo] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) PRIVADOS.addSubnet(rede, prefixo, 'ipv4');
// ::/96 cobre o não especificado (::), o loopback (::1) e os IPv4 compatíveis (::a.b.c.d); 64:ff9b::/96 é o NAT64.
for (const [rede, prefixo] of [['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) PRIVADOS.addSubnet(rede, prefixo, 'ipv6');

/** IPv6 na forma canônica (a mesma da URL): '0:0:0:0:0:ffff:127.0.0.1' e '::ffff:127.0.0.1' viram '::ffff:7f00:1'. */
function ipv6Canonico(ip) {
  try { return new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return String(ip).toLowerCase(); }
}

/** IPv4 contido num IPv6 mapeado (::ffff:a.b.c.d, em qualquer escrita), ou null. */
function ipv4Mapeado(ip) {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ipv6Canonico(ip));
  if (!m) return null;
  const [a, b] = [parseInt(m[1], 16), parseInt(m[2], 16)];
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/** O IP está numa faixa interna? IPv4 mapeado em IPv6 é conferido como o IPv4 que ele contém; texto que não é IP conta como interno. */
function ipPrivado(ip) {
  const x = String(ip ?? '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(x)) return PRIVADOS.check(x, 'ipv4');
  if (!net.isIPv6(x)) return true;
  const v4 = ipv4Mapeado(x);
  return v4 ? PRIVADOS.check(v4, 'ipv4') : PRIVADOS.check(ipv6Canonico(x), 'ipv6');
}

const MSG_REDE_INTERNA = 'O endereço aponta para a rede interna. Para usar um serviço no mesmo servidor, defina NETWORK_CONECTOR_REDE_INTERNA=1.';

/** Valida a URL configurada: http(s), sem usuário/senha embutidos e, salvo liberação, sem destino na rede interna (SSRF). */
async function validarDestino(url) {
  let u;
  try { u = new URL(url); } catch { throw new ErroConector('Endereço inválido.', 'falha', { permanente: true }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ErroConector('Use um endereço http:// ou https://.', 'falha', { permanente: true });
  if (u.username || u.password) throw new ErroConector('Não coloque usuário e senha no endereço; use o campo de credencial.', 'falha', { permanente: true });
  if (config.producao && u.protocol === 'http:' && !config.conectorRedeInterna) throw new ErroConector('Em produção, use https://.', 'falha', { permanente: true });
  if (config.conectorRedeInterna) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => { throw new ErroConector(`Não foi possível resolver ${host}.`); })).map((x) => x.address);
  if (ips.some(ipPrivado)) throw new ErroConector(MSG_REDE_INTERNA, 'falha', { permanente: true });
  return u;
}

/**
 * Resolução de nomes usada na conexão: o endereço conferido é o mesmo em que o socket conecta, então trocar o DNS entre a
 * validação e a conexão (DNS rebinding) não leva o conector à rede interna.
 */
function lookupSeguro(hostname, opcoes, cb) {
  dnsCb.lookup(hostname, { ...opcoes, all: true }, (err, enderecos) => {
    if (err) return cb(err);
    if (!config.conectorRedeInterna && enderecos.some((e) => ipPrivado(e.address))) {
      return cb(Object.assign(new Error(MSG_REDE_INTERNA), { code: 'EREDEINTERNA' }));
    }
    if (opcoes.all) return cb(null, enderecos);
    return cb(null, enderecos[0].address, enderecos[0].family);
  });
}

const LIMITE_RESPOSTA = 5_000_000;

/** GET simples (sem seguir redirecionamentos), conectando só ao endereço conferido por lookupSeguro. */
function requisitar(url, cabecalhos) {
  const u = new URL(url);
  const modulo = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let timer = null;
    const falhar = (err) => { clearTimeout(timer); reject(err); };
    const req = modulo.request(u, { method: 'GET', headers: cabecalhos, lookup: lookupSeguro }, (resp) => {
      const partes = [];
      let total = 0;
      resp.on('data', (c) => {
        total += c.length;
        if (total > LIMITE_RESPOSTA) req.destroy(new ErroConector('Resposta grande demais.'));
        else partes.push(c);
      });
      resp.on('end', () => { clearTimeout(timer); resolve({ status: resp.statusCode, headers: resp.headers, texto: Buffer.concat(partes).toString('utf8') }); });
      resp.on('error', falhar);
    });
    timer = setTimeout(() => req.destroy(Object.assign(new Error('Tempo esgotado.'), { name: 'TimeoutError' })), config.conectorTimeoutMs);
    req.on('error', falhar);
    req.end();
  });
}

/** GET JSON com timeout, sem seguir redirecionamentos, classificando o resultado no estado da integração. */
async function buscarJson(url, cabecalhos = {}) {
  await validarDestino(url);
  let resp;
  try {
    resp = await requisitar(url, { Accept: 'application/json', 'User-Agent': 'ManagerNetwork/1.0', ...cabecalhos });
  } catch (err) {
    if (err instanceof ErroConector) throw err;
    if (err.code === 'EREDEINTERNA') throw new ErroConector(MSG_REDE_INTERNA, 'falha', { permanente: true });
    if (err.name === 'TimeoutError') throw new ErroConector(`Tempo esgotado (${config.conectorTimeoutMs / 1000} s) aguardando a fonte.`);
    throw new ErroConector(`Sem conexão com a fonte: ${err.code || err.message}.`);
  }
  if (resp.status === 401 || resp.status === 403) throw new ErroConector(`A fonte recusou a credencial (HTTP ${resp.status}).`, 'sem_permissao', { status: resp.status, permanente: true });
  if (resp.status === 429) {
    const ra = Number(resp.headers['retry-after']);
    throw new ErroConector('Limite de consultas da fonte atingido.', 'limite_atingido', { status: 429, retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : 300 });
  }
  if (resp.status >= 300 && resp.status < 400) throw new ErroConector(`A fonte respondeu com redirecionamento (HTTP ${resp.status}); confira o endereço.`, 'falha', { status: resp.status, permanente: true });
  if (resp.status === 404) throw new ErroConector('Recurso não encontrado na fonte (HTTP 404); confira o endereço e o caminho.', 'falha', { status: 404, permanente: true });
  if (resp.status < 200 || resp.status >= 300) throw new ErroConector(`A fonte respondeu HTTP ${resp.status}.`, 'falha', { status: resp.status });
  try { return JSON.parse(resp.texto); } catch { throw new ErroConector('A fonte não respondeu JSON.', 'falha', { status: resp.status }); }
}

// ---------------- Configuração e estado das integrações ----------------
function ler(db, org, tipo) {
  const x = db.prepare('SELECT * FROM integracoes WHERE organizacao_id = ? AND tipo = ?').get(org, tipo);
  return x ? { ...x, config: JSON.parse(x.config) } : null;
}

/** Versão para a interface: nunca devolve a credencial, só se ela existe. */
function publico(x, tipo) {
  if (!x) return { tipo, habilitada: false, estado: 'nao_configurada', config: {}, credencial_configurada: false };
  const { segredo_cifrado: s, ...resto } = x;
  return { ...resto, habilitada: Boolean(x.habilitada), credencial_configurada: Boolean(s) };
}

function salvar(db, org, tipo, { config: cfg, segredo, habilitada }) {
  const atual = ler(db, org, tipo);
  const cifrado = segredo === undefined ? atual?.segredo_cifrado ?? null : segredo === null || segredo === '' ? null : cifrar(segredo);
  db.prepare(`INSERT INTO integracoes (organizacao_id, tipo, habilitada, config, segredo_cifrado, estado, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (organizacao_id, tipo) DO UPDATE SET habilitada = excluded.habilitada, config = excluded.config, segredo_cifrado = excluded.segredo_cifrado,
    estado = excluded.estado, proxima_tentativa = NULL, falhas_consecutivas = 0, atualizado_em = excluded.atualizado_em`)
    .run(org, tipo, habilitada ? 1 : 0, JSON.stringify(cfg), cifrado, habilitada ? 'testando' : 'desabilitada', agora());
  return ler(db, org, tipo);
}

const segredoDe = (x) => (x?.segredo_cifrado ? decifrar(x.segredo_cifrado) : null);

/** Registra o resultado de uma coleta: estado, horários, erro resumido com ID e a próxima tentativa (backoff com jitter). */
function registrarResultado(db, org, tipo, { inicio, itens = 0, erro = null, parcial = false, intervaloS = 60 }) {
  const t = agora();
  const duracao = Date.now() - inicio;
  if (!erro) {
    db.prepare(`UPDATE integracoes SET estado = ?, ultimo_sucesso = ?, ultima_tentativa = ?, ultimo_erro = ?, erro_id = NULL, falhas_consecutivas = 0,
      proxima_tentativa = ? WHERE organizacao_id = ? AND tipo = ?`).run(parcial ? 'parcial' : 'conectada', t, t, parcial || null,
      new Date(Date.now() + intervaloS * 1000).toISOString(), org, tipo);
    db.prepare(`INSERT INTO sincronizacoes (organizacao_id, tipo, iniciado_em, terminado_em, resultado, itens, duracao_ms, erro) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(org, tipo, new Date(inicio).toISOString(), t, parcial ? 'parcial' : 'ok', itens, duracao, typeof parcial === 'string' ? parcial : null);
    return;
  }
  const erroId = crypto.randomBytes(5).toString('hex');
  const atual = ler(db, org, tipo);
  const falhas = (atual?.falhas_consecutivas ?? 0) + 1;
  let proxima = null;
  if (erro.estado === 'limite_atingido') proxima = Date.now() + (erro.retryAfterS ?? 300) * 1000;
  else if (!erro.permanente) proxima = Date.now() + Math.min(1800, intervaloS * 2 ** Math.min(falhas, 6)) * 1000 * (0.8 + Math.random() * 0.4);
  db.prepare(`UPDATE integracoes SET estado = ?, ultima_tentativa = ?, ultimo_erro = ?, erro_id = ?, falhas_consecutivas = ?, proxima_tentativa = ?
    WHERE organizacao_id = ? AND tipo = ?`).run(erro.estado || 'falha', t, String(erro.message).slice(0, 300), erroId, falhas,
    proxima ? new Date(proxima).toISOString() : null, org, tipo);
  db.prepare(`INSERT INTO sincronizacoes (organizacao_id, tipo, iniciado_em, terminado_em, resultado, itens, duracao_ms, erro, erro_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(org, tipo, new Date(inicio).toISOString(), t, erro.estado || 'falha', itens, duracao, String(erro.message).slice(0, 300), erroId);
  if (!(erro instanceof ErroConector)) console.error(`[Network] Conector ${tipo} (org ${org}) erro ${erroId}:`, erro);
}

/** Estado exibido: conectada sem sucesso recente vira "desatualizada" (a última leitura continua, com a idade). */
function estadoAtual(x, desatualizadoMin, intervaloS) {
  if (!x) return 'nao_configurada';
  if (!x.habilitada) return 'desabilitada';
  if (['conectada', 'parcial'].includes(x.estado) && x.ultimo_sucesso
    && Date.now() - Date.parse(x.ultimo_sucesso) > Math.max(desatualizadoMin * 60_000, intervaloS * 3000)) return 'desatualizada';
  return x.estado;
}

module.exports = { ErroConector, validarDestino, buscarJson, lookupSeguro, ler, publico, salvar, segredoDe, registrarResultado, estadoAtual, ipPrivado };
