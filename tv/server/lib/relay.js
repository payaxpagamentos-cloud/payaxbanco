'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { Readable } = require('node:stream');
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const { assinar, confere } = require('./cripto');

/**
 * Transmissão (o lado "CDN" da plataforma): o servidor busca a lista HLS na origem da emissora,
 * reescreve os endereços dos pedaços para o nosso endereço e repassa cada pedaço ao player.
 *
 * Com isso: a origem não aparece para o assinante (e não precisa liberar CORS), a política de
 * segurança das páginas continua fechada em 'self' e a operação vê num só lugar quem está no ar.
 */

/** Endereços que o relay nunca busca: rede interna, loopback, link-local e serviços de metadados da nuvem. */
function ipPrivado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local e metadados (169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast e reservados
    return false;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')) return true; // link-local
    if (/^f[cd]/.test(x)) return true; // rede privada (fc00::/7)
    const mapeado = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapeado) return ipPrivado(mapeado[1]);
    return false;
  }
  return true;
}

/**
 * Confere o endereço antes de buscar: só http(s), sem credenciais e fora da rede interna.
 * (A conferência é feita na resolução do nome; por isso, em produção, deixe o servidor sem
 * acesso de saída à rede interna — é a garantia que não depende de DNS.)
 */
async function conferirEndereco(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new ErroNegocio('Endereço do sinal inválido.', 422); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ErroNegocio('Endereço do sinal inválido (use http:// ou https://).', 422);
  if (u.username || u.password) throw new ErroNegocio('Endereço do sinal não pode levar usuário e senha.', 422);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (ipPrivado(host)) throw new ErroNegocio('Endereço do sinal aponta para a rede interna.', 422);
    return u;
  }
  let enderecos;
  try {
    enderecos = await dns.lookup(host, { all: true });
  } catch {
    throw new ErroNegocio('Não foi possível resolver o endereço do sinal.', 502);
  }
  if (!enderecos.length || enderecos.some((e) => ipPrivado(e.address))) throw new ErroNegocio('Endereço do sinal aponta para a rede interna.', 422);
  return u;
}

/** Assina um endereço da origem para que ele volte pelo nosso servidor sem abrir um proxy livre. */
const assinarUrl = (canalId, url) => {
  const dados = Buffer.from(String(url)).toString('base64url');
  return `${dados}.${assinar(`relay:${canalId}:${dados}`)}`;
};

/** Lê o endereço assinado (devolve null quando a assinatura não bate: ninguém usa nosso servidor como proxy). */
function lerUrlAssinada(canalId, valor) {
  const [dados, assinatura] = String(valor ?? '').split('.');
  if (!dados || !assinatura || !confere(assinar(`relay:${canalId}:${dados}`), assinatura)) return null;
  try {
    return Buffer.from(dados, 'base64url').toString();
  } catch {
    return null;
  }
}

const REDIRECIONA = [301, 302, 303, 307, 308];

/**
 * `fetch` que confere o endereço em CADA salto, e não só no primeiro.
 *
 * Com `redirect: 'follow'`, que era o que havia em todo lugar, a conferência de rede interna
 * valia para o endereço cadastrado e para mais nada: bastava a origem responder
 * "302 → http://10.0.0.1/..." e o servidor ia buscar lá dentro, sem pergunta. E a origem não é
 * de confiança — canal de lista pública, logo de emissora e grade XMLTV vêm de servidores de
 * terceiros. Num provedor isso pesa mais que o normal: a máquina da plataforma costuma enxergar
 * a rede de gerência (roteador, OLT, painel interno), que é exatamente o que não pode ser
 * alcançado a partir de um endereço que alguém de fora controla.
 *
 * Aqui o redirecionamento é seguido à mão: cada destino passa por `conferirEndereco` antes de
 * ser buscado, e a corrente tem tamanho máximo.
 *
 * O que isto NÃO cobre: um nome que resolve para IP público na conferência e para IP interno
 * na conexão (troca de DNS entre as duas consultas). Fechar isso exige fixar o IP na conexão;
 * a defesa que não depende de DNS continua sendo o firewall de saída do servidor.
 */
async function buscarSeguro(url, opcoes = {}, { maxSaltos = 5 } = {}) {
  let atual = String(url);
  for (let salto = 0; salto <= maxSaltos; salto += 1) {
    await conferirEndereco(atual);
    const resp = await fetch(atual, { ...opcoes, redirect: 'manual' });
    if (!REDIRECIONA.includes(resp.status)) return resp;
    const destino = resp.headers.get('location');
    if (!destino) return resp;
    try { await resp.body?.cancel(); } catch { /* corpo já fechado */ }
    try {
      atual = new URL(destino, atual).toString();
    } catch {
      throw new ErroNegocio('A origem redirecionou para um endereço inválido.', 502);
    }
  }
  throw new ErroNegocio('A origem redirecionou vezes demais.', 502);
}

/**
 * Lê o corpo de uma resposta até um teto, e para ali.
 *
 * `resp.arrayBuffer()` carrega tudo na memória antes de qualquer conferência de tamanho, e o
 * `content-length` é só o que o outro lado DIZ que vai mandar. Um servidor de terceiros que
 * responda com alguns GB derrubaria o processo — e, com ele, todos os canais no ar.
 */
async function lerCorpoLimitado(resp, maximo, oQue = 'O arquivo') {
  const declarado = Number(resp.headers.get('content-length')) || 0;
  if (declarado > maximo) throw new ErroNegocio(`${oQue} passa do tamanho permitido.`, 413);
  if (!resp.body) return Buffer.alloc(0);
  const partes = [];
  let total = 0;
  for await (const pedaco of resp.body) {
    total += pedaco.length;
    if (total > maximo) {
      try { await resp.body.cancel(); } catch { /* já fechado */ }
      throw new ErroNegocio(`${oQue} passa do tamanho permitido.`, 413);
    }
    partes.push(pedaco);
  }
  return Buffer.concat(partes);
}

async function buscar(url, { metodo = 'GET', cabecalhos = {} } = {}) {
  let resp;
  try {
    resp = await buscarSeguro(url, {
      method: metodo,
      headers: { 'User-Agent': config.relay.userAgent, Accept: '*/*', ...cabecalhos },
      signal: AbortSignal.timeout(config.relay.timeoutMs),
    });
  } catch (err) {
    // Recusa por endereço interno ou corrente longa já vem com o motivo certo: não vira "falha de rede".
    if (err instanceof ErroNegocio) throw err;
    throw new ErroNegocio(`A origem do sinal não respondeu (${err.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede'}).`, 504);
  }
  return resp;
}

const cacheLista = new Map(); // url -> { texto, em, finalUrl }

/** Reescreve um endereço da lista (relativo ou absoluto) para o nosso servidor. */
const nosso = (base, uri, { canalId, playToken, rota }) => {
  const absoluto = new URL(uri, base).toString();
  return `${rota}?t=${encodeURIComponent(playToken)}&u=${assinarUrl(canalId, absoluto)}`;
};

/**
 * Reescreve uma lista HLS: cada pedaço, cada lista filha, cada chave e cada faixa de áudio
 * ou legenda passa a apontar para o nosso servidor. Função pura (o texto já foi buscado).
 */
function reescrever(texto, { canal, playToken, baseApi, urlDaLista }) {
  if (!/^\s*#EXTM3U/.test(texto)) throw new ErroNegocio('A origem não devolveu uma lista HLS (.m3u8).', 502);
  const rotaLista = `${baseApi}/play/canal/${canal.id}/lista.m3u8`;
  const rotaSegmento = `${baseApi}/play/canal/${canal.id}/segmento`;
  const opcoesLista = { canalId: canal.id, playToken, rota: rotaLista };
  const opcoesSegmento = { canalId: canal.id, playToken, rota: rotaSegmento };
  // Lista mestre (várias qualidades) ou lista de pedaços de uma qualidade só.
  const mestre = /#EXT-X-STREAM-INF/i.test(texto);
  const trocarAtributo = (linha, opcoes) => linha.replace(/URI="([^"]+)"/i, (_m, uri) => `URI="${nosso(urlDaLista, uri, opcoes)}"`);

  return texto.split(/\r?\n/).map((linha) => {
    const l = linha.trim();
    if (!l) return linha;
    if (l.startsWith('#')) {
      // Faixas alternativas (áudio, legenda) e listas de I-frames são outras listas.
      if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)/i.test(l) && /URI="/i.test(l)) return trocarAtributo(l, opcoesLista);
      // Chave de criptografia e cabeçalho de inicialização são arquivos: viram segmentos.
      if (/^#EXT-X-(KEY|SESSION-KEY|MAP|PART|PRELOAD-HINT|RENDITION-REPORT)/i.test(l) && /URI="/i.test(l)) return trocarAtributo(l, opcoesSegmento);
      return linha;
    }
    return nosso(urlDaLista, l, mestre ? opcoesLista : opcoesSegmento);
  }).join('\n');
}

/**
 * Busca a lista HLS na origem e devolve a versão reescrita, com um cache curto
 * (o player pede a lista a cada poucos segundos).
 */
/** Cabeçalhos extras que o sinal exige (alguns servidores só respondem com User-Agent ou Referer próprios). */
function cabecalhosDoCanal(canal) {
  if (!canal?.cabecalhos) return {};
  try {
    const d = JSON.parse(canal.cabecalhos);
    const saida = {};
    if (d.user_agent) saida['User-Agent'] = String(d.user_agent).slice(0, 300);
    if (d.referrer) saida.Referer = String(d.referrer).slice(0, 300);
    return saida;
  } catch {
    return {};
  }
}

async function listaReescrita(canal, { url = canal.url_hls, playToken, baseApi }) {
  const agoraMs = Date.now();
  const emCache = cacheLista.get(url);
  let texto;
  let finalUrl = url;
  if (emCache && agoraMs - emCache.em < config.relay.cacheListaMs) {
    texto = emCache.texto;
    finalUrl = emCache.finalUrl;
  } else {
    const resp = await buscar(url, { cabecalhos: cabecalhosDoCanal(canal) });
    if (!resp.ok) throw new ErroNegocio(`A origem do sinal respondeu ${resp.status}.`, 502);
    texto = await resp.text();
    finalUrl = resp.url || url;
    cacheLista.set(url, { texto, em: agoraMs, finalUrl });
    if (cacheLista.size > 500) for (const [k, val] of cacheLista) if (agoraMs - val.em > 60_000) cacheLista.delete(k);
  }
  return reescrever(texto, { canal, playToken, baseApi, urlDaLista: finalUrl });
}

/** Repassa um pedaço do sinal (segmento, chave ou cabeçalho) ao player, em fluxo, sem guardar em disco. */
async function repassarSegmento(req, res, url, canal = null) {
  const faixa = req.get('range');
  const resp = await buscar(url, { cabecalhos: { ...cabecalhosDoCanal(canal), ...(faixa ? { Range: faixa } : {}) } });
  if (!resp.ok && resp.status !== 206) throw new ErroNegocio(`A origem do sinal respondeu ${resp.status}.`, 502);
  const tamanho = Number(resp.headers.get('content-length') || 0);
  if (tamanho && tamanho > config.relay.segmentoMaxBytes) throw new ErroNegocio('Pedaço do sinal maior que o permitido.', 502);
  res.status(resp.status === 206 ? 206 : 200);
  res.set({
    'Content-Type': resp.headers.get('content-type') || 'video/mp2t',
    'Cache-Control': 'private, max-age=6',
    'X-Content-Type-Options': 'nosniff',
    ...(resp.headers.get('content-length') ? { 'Content-Length': resp.headers.get('content-length') } : {}),
    ...(resp.headers.get('content-range') ? { 'Content-Range': resp.headers.get('content-range') } : {}),
  });
  if (!resp.body) return res.end();
  // Corta o repasse se a origem mandar mais do que o permitido (protege a memória e o disco do servidor).
  let enviados = 0;
  const fluxo = Readable.fromWeb(resp.body);
  fluxo.on('data', (pedaco) => {
    enviados += pedaco.length;
    if (enviados > config.relay.segmentoMaxBytes) {
      fluxo.destroy(new Error('pedaço grande demais'));
      res.destroy();
    }
  });
  fluxo.on('error', () => res.destroy());
  req.on('close', () => fluxo.destroy());
  return fluxo.pipe(res);
}

/** Confere o sinal de um canal: a origem devolve uma lista HLS válida? */
async function verificarCanal(db, canal) {
  let status = 'ok';
  let detalhe = null;
  try {
    const resp = await buscar(canal.url_hls, { cabecalhos: cabecalhosDoCanal(canal) });
    if (!resp.ok) {
      status = 'falha';
      detalhe = `A origem respondeu ${resp.status}.`;
    } else {
      const texto = (await resp.text()).slice(0, 2000);
      if (!/^\s*#EXTM3U/.test(texto)) {
        status = 'falha';
        detalhe = 'A origem não devolveu uma lista HLS (.m3u8).';
      }
    }
  } catch (err) {
    status = 'falha';
    detalhe = err.message;
  }
  db.prepare('UPDATE canais SET sinal_status = ?, sinal_detalhe = ?, sinal_em = ? WHERE id = ?').run(status, detalhe, agora(), canal.id);
  return { canal_id: canal.id, nome: canal.nome, status, detalhe };
}

/** Verifica todos os canais ativos (roda sozinha de 15 em 15 minutos). */
async function verificarSinais(db, { apenas = null } = {}) {
  if (!config.relay.ligado && !apenas) return [];
  // Só faz sentido conferir quem tem lista HLS: canal com player da emissora não passa por aqui.
  const canais = apenas
    ? db.prepare("SELECT * FROM canais WHERE id = ? AND fonte = 'hls' AND url_hls IS NOT NULL").all(Number(apenas))
    : db.prepare("SELECT * FROM canais WHERE ativo = 1 AND fonte = 'hls' AND url_hls IS NOT NULL").all();
  const resultados = [];
  // Em série para não disparar dezenas de buscas ao mesmo tempo.
  for (const c of canais) resultados.push(await verificarCanal(db, c));
  return resultados;
}

module.exports = { ipPrivado, conferirEndereco, buscarSeguro, lerCorpoLimitado, assinarUrl, lerUrlAssinada, reescrever, listaReescrita, cabecalhosDoCanal, repassarSegmento, verificarCanal, verificarSinais, cacheLista };
