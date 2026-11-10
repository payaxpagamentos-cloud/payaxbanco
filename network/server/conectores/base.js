'use strict';

const dns = require('node:dns/promises');
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

function ipPrivado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return ipPrivado(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

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
  if (ips.some(ipPrivado)) {
    throw new ErroConector('O endereço aponta para a rede interna. Para usar um serviço no mesmo servidor, defina NETWORK_CONECTOR_REDE_INTERNA=1.', 'falha', { permanente: true });
  }
  return u;
}

/** GET JSON com timeout, sem seguir redirecionamentos, classificando o resultado no estado da integração. */
const buscarJson = (url, cabecalhos = {}) => requisitarJson(url, { cabecalhos });

/** POST JSON (avisos por Telegram, WhatsApp e webhook), com as mesmas proteções e classificação de erros do GET. */
const enviarJson = (url, corpo, cabecalhos = {}) => requisitarJson(url, { metodo: 'POST', corpo, cabecalhos, aceitaTexto: true });

async function requisitarJson(url, { metodo = 'GET', corpo, cabecalhos = {}, aceitaTexto = false }) {
  await validarDestino(url);
  let resp;
  try {
    resp = await fetch(url, { method: metodo, headers: { Accept: 'application/json', 'User-Agent': 'ManagerNetwork/1.0',
      ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...cabecalhos }, body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    redirect: 'manual', signal: AbortSignal.timeout(config.conectorTimeoutMs) });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new ErroConector(`Tempo esgotado (${config.conectorTimeoutMs / 1000} s) aguardando a fonte.`);
    throw new ErroConector(`Sem conexão com a fonte: ${err.cause?.code || err.message}.`);
  }
  if (resp.status === 401 || resp.status === 403) throw new ErroConector(`A fonte recusou a credencial (HTTP ${resp.status}).`, 'sem_permissao', { status: resp.status, permanente: true });
  if (resp.status === 429) {
    const ra = Number(resp.headers.get('retry-after'));
    throw new ErroConector('Limite de consultas da fonte atingido.', 'limite_atingido', { status: 429, retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : 300 });
  }
  if (resp.status >= 300 && resp.status < 400) throw new ErroConector(`A fonte respondeu com redirecionamento (HTTP ${resp.status}); confira o endereço.`, 'falha', { status: resp.status, permanente: true });
  if (resp.status === 404) throw new ErroConector('Recurso não encontrado na fonte (HTTP 404); confira o endereço e o caminho.', 'falha', { status: 404, permanente: true });
  if (!resp.ok) throw new ErroConector(`A fonte respondeu HTTP ${resp.status}.`, 'falha', { status: resp.status });
  const texto = await resp.text();
  if (texto.length > 5_000_000) throw new ErroConector('Resposta grande demais.');
  try { return JSON.parse(texto); } catch {
    if (aceitaTexto) return { texto: texto.slice(0, 500) };
    throw new ErroConector('A fonte não respondeu JSON.', 'falha', { status: resp.status });
  }
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

module.exports = { ErroConector, validarDestino, buscarJson, enviarJson, ler, publico, salvar, segredoDe, registrarResultado, estadoAtual, ipPrivado };
