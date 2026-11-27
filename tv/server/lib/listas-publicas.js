'use strict';

const { ErroNegocio } = require('./erros');
const { buscarSeguro } = require('./relay');

/**
 * Listas públicas de canais (projeto iptv-org): um catálogo aberto com o nome, a categoria e o
 * endereço do sinal de milhares de canais, inclusive os brasileiros.
 *
 * Serve para a operação não precisar caçar endereço a endereço. O que vem daqui entra
 * **desligado**: a operação testa o sinal, confere se pode transmitir aquele canal e só então liga.
 */

const FONTE_CANAIS = 'https://iptv-org.github.io/api/channels.json';
const FONTE_FLUXOS = 'https://iptv-org.github.io/api/streams.json';
const FONTE_LOGOS = 'https://iptv-org.github.io/api/logos.json';

// Os arquivos são grandes (vários MB): guarda por alguns minutos.
const cache = { em: 0, canais: null, fluxos: null, logos: null, logosEm: 0 };
const VALIDADE_MS = 10 * 60_000;

async function baixarJson(url, timeoutMs) {
  let resp;
  try {
    resp = await buscarSeguro(url, { headers: { 'User-Agent': 'PLAYTECHVIP/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof ErroNegocio) throw err;
    throw new ErroNegocio(`Não foi possível baixar a lista pública (${err.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede'}).`, 504);
  }
  if (!resp.ok) throw new ErroNegocio(`A lista pública respondeu ${resp.status}.`, 502);
  return resp.json();
}

async function carregar({ timeoutMs = 60_000 } = {}) {
  if (cache.canais && Date.now() - cache.em < VALIDADE_MS) return cache;
  const [canais, fluxos] = await Promise.all([baixarJson(FONTE_CANAIS, timeoutMs), baixarJson(FONTE_FLUXOS, timeoutMs)]);
  cache.canais = canais;
  cache.fluxos = fluxos;
  cache.em = Date.now();
  return cache;
}

/**
 * Logos das emissoras, da mesma lista pública.
 *
 * O logo serve para identificar o canal na grade — é o mesmo uso que qualquer guia de
 * programação faz. Quem tiver o material oficial da emissora pode trocar pelo painel.
 */
async function carregarLogos({ timeoutMs = 60_000 } = {}) {
  if (cache.logos && Date.now() - cache.logosEm < VALIDADE_MS) return cache.logos;
  cache.logos = await baixarJson(FONTE_LOGOS, timeoutMs);
  cache.logosEm = Date.now();
  return cache.logos;
}

/** Só letras e números, sem acento: a forma de comparar dois nomes de canal. */
const chaveDoNome = (nome) => String(nome ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');

/**
 * Separa a palavra genérica do começo do nome: "TV Globo" vira ['tv', 'globo'].
 * Dois canais só são o mesmo quando o resto bate **e** o começo não os distingue —
 * "Rede Brasil" e "TV Brasil" são emissoras diferentes, e não podem trocar de logo.
 */
function partes(nome) {
  const cheia = chaveDoNome(nome);
  const m = /^(tv|rede|canal|radio)(.+)$/.exec(cheia);
  return m ? { prefixo: m[1], resto: m[2], cheia } : { prefixo: '', resto: cheia, cheia };
}

const mesmoCanal = (a, b) => {
  const x = partes(a);
  const y = partes(b);
  if (!x.cheia || !y.cheia) return false;
  if (x.cheia === y.cheia) return true;
  // Um dos dois não traz a palavra genérica: "Globo" é o mesmo canal que "TV Globo".
  return x.resto === y.resto && x.resto.length >= 4 && (!x.prefixo || !y.prefixo);
};

/** Entre os logos do mesmo canal, o melhor para a grade: em uso, quadrado e nem grande nem minúsculo. */
/**
 * Quanto se pode confiar em quem hospeda a imagem.
 *
 * Isto não é capricho: 79% dos logos de canais brasileiros da lista pública estão no imgur, e o
 * imgur bloqueia o ENDEREÇO depois de uma rajada de pedidos — medido aqui, 18 pedidos a cada
 * 1,2s derrubaram o acesso inteiro, e depois disso tudo responde 403 em 4 ms, inclusive o que
 * funcionava minutos antes. Um provedor com 116 canais estoura esse limite na primeira volta e
 * fica sem a maior parte dos logos. Quando o mesmo canal tem logo em outro lugar, é de lá que a
 * gente baixa.
 */
const CONFIANCA_DO_HOST = [
  [/(^|\.)wikimedia\.org$/, 200],        // não bloqueia, serve bem e é estável
  [/(^|\.)wikia\.nocookie\.net$/, 120],
  [/(^|\.)googleusercontent\.com$/, 100],
  [/(^|\.)ibb\.co$/, 80],
  [/(^|\.)imgur\.com$/, -250],           // bloqueia por endereço: último recurso
];

function notaDoHost(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return -500; }
  for (const [padrao, nota] of CONFIANCA_DO_HOST) if (padrao.test(host)) return nota;
  return 0;
}

function melhorLogo(lista) {
  const nota = (l) => {
    const largura = Number(l.width) || 0;
    const altura = Number(l.height) || 0;
    if (!largura || !altura) return -1e9;
    const proporcao = largura / altura;
    return (l.in_use ? 300 : 0)
      + notaDoHost(l.url)
      + (String(l.format).toUpperCase() === 'SVG' ? 60 : 0)
      - Math.abs(Math.log(proporcao)) * 120          // perto do quadrado
      - Math.abs(Math.log(Math.max(largura, altura) / 512)) * 40;  // perto de 512 px
  };
  return [...lista].sort((a, b) => nota(b) - nota(a))[0] ?? null;
}

/**
 * Escolhe, na lista pública, o canal que corresponde a este nome.
 *
 * Procurar só no país não basta. Boa parte do que um provedor brasileiro carrega é marca
 * pan-regional, e a lista pública registra essas marcas fora do BR: Warner Channel está em
 * `WarnerChannel.us`, Studio Universal em `StudioUniversalLatinAmerica.us`, Discovery Kids em
 * `DiscoveryKidsLiveLatinAmerica.br`. Procurando só `country === 'BR'` com nome igual, metade
 * dos canais ficava sem logo — e é a mesma arte.
 *
 * Então a escolha é por pontos, nesta ordem de peso: nome igual, país do assinante, feed
 * brasileiro ou latino-americano, canal no ar. Empate desempata pelo id, para a mesma lista
 * dar sempre o mesmo resultado.
 */
function melhorCanal(canais, nome, pais = 'BR') {
  const alvo = chaveDoNome(nome);
  if (!alvo) return null;
  const nomes = (c) => [c.name, ...(c.alt_names ?? [])];
  const nota = (c) => {
    const igual = nomes(c).some((n) => chaveDoNome(n) === alvo);
    const parecido = igual || nomes(c).some((n) => mesmoCanal(n, nome));
    if (!parecido) return -1e9;
    const id = String(c.id).toLowerCase();
    let n = igual ? 1000 : 300;
    if (c.country === pais) n += 500;
    if (/brasil|brazil/.test(id)) n += 400;
    if (/latinamerica|latino|americalatina/.test(id)) n += 300;
    if (!c.closed) n += 200;
    // Nome mais curto é o canal "puro": entre "Discovery Kids" e "Discovery Kids Live", o
    // primeiro é o que a pessoa reconhece.
    n -= Math.max(0, chaveDoNome(c.name).length - alvo.length) * 2;
    return n;
  };
  const candidatos = canais.map((c) => [c, nota(c)]).filter(([, n]) => n > -1e8);
  if (!candidatos.length) return null;
  candidatos.sort((a, b) => b[1] - a[1] || String(a[0].id).localeCompare(String(b[0].id)));
  return candidatos[0][0];
}

/**
 * Procura o logo de um canal pelo nome. Devolve { url, largura, altura, canal } ou null.
 * Casa pelo nome do canal na lista pública (e pelos nomes alternativos que ela traz).
 */
async function logoDoCanal(nome, { id = null, pais = 'BR', timeoutMs = 60_000 } = {}) {
  const { canais } = await carregar({ timeoutMs });
  if (!id && !chaveDoNome(nome)) return null;

  // Com o identificador na mão não há adivinhação: é o canal certo. A lista de logos cobre
  // canais que nem estão no catálogo de canais (o SBT nacional, por exemplo), então a busca
  // vai direto nela.
  if (id) {
    const logos = await carregarLogos({ timeoutMs });
    const melhor = melhorLogo(logos.filter((l) => l.channel === id));
    if (melhor) {
      const certo = canais.find((c) => c.id === id);
      return { url: melhor.url, largura: melhor.width, altura: melhor.height, canal: id, nome: certo?.name ?? id.replace(/\.[a-z]{2}$/, '') };
    }
    return null;
  }

  const canal = melhorCanal(canais, nome, pais);
  if (!canal) return null;

  const logos = await carregarLogos({ timeoutMs });
  const escolhido = melhorLogo(logos.filter((l) => l.channel === canal.id));
  if (!escolhido) return null;
  return { url: escolhido.url, largura: escolhido.width, altura: escolhido.height, canal: canal.id, nome: canal.name };
}

// Categorias da lista pública → categorias da PLAY TECH VIP.
const CATEGORIAS = {
  news: 'noticias', sports: 'esportes', movies: 'filmes', series: 'series', kids: 'infantil',
  animation: 'infantil', documentary: 'documentarios', music: 'musica', religious: 'religioso',
  general: 'aberta', entertainment: 'variedades', culture: 'variedades', education: 'documentarios',
  lifestyle: 'variedades', comedy: 'variedades', family: 'variedades', travel: 'documentarios',
  science: 'documentarios', business: 'noticias', legislative: 'noticias', local: 'local',
};

const ORDEM_QUALIDADE = ['2160p', '1080p', '720p', '576p', '480p', '360p', '240p'];
const notaQualidade = (q) => {
  const i = ORDEM_QUALIDADE.indexOf(String(q ?? '').toLowerCase());
  return i === -1 ? ORDEM_QUALIDADE.length : i;
};

/**
 * Canais de um país, já casados com o melhor sinal de cada um.
 * Devolve a lista pronta para a operação escolher o que importar.
 */
async function canaisDoPais(pais = 'BR', { limite = 120 } = {}) {
  const { canais, fluxos } = await carregar();
  const doPais = new Map(canais
    .filter((c) => c.country === pais && !c.is_nsfw && !c.closed && !c.replaced_by)
    .map((c) => [c.id, c]));

  const melhor = new Map();
  for (const f of fluxos) {
    if (!f.channel || !f.url || !doPais.has(f.channel)) continue;
    if (!/^https?:\/\//i.test(f.url)) continue;
    const atual = melhor.get(f.channel);
    if (!atual || notaQualidade(f.quality) < notaQualidade(atual.quality)) melhor.set(f.channel, f);
  }

  return [...melhor.entries()]
    .map(([id, fluxo]) => {
      const c = doPais.get(id);
      const categoria = (c.categories ?? []).map((x) => CATEGORIAS[x]).find(Boolean) ?? 'variedades';
      return {
        id,
        nome: c.name,
        categoria,
        site: c.website ?? null,
        url: fluxo.url,
        qualidade: fluxo.quality ?? null,
        // "Not 24/7" e afins: o sinal não fica no ar o tempo todo.
        avisos: fluxo.labels ?? [],
        cabecalhos: (fluxo.user_agent || fluxo.referrer)
          ? { user_agent: fluxo.user_agent ?? null, referrer: fluxo.referrer ?? null }
          : null,
      };
    })
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .slice(0, limite);
}

module.exports = { canaisDoPais, logoDoCanal, melhorCanal, chaveDoNome, mesmoCanal, CATEGORIAS, FONTE_CANAIS, FONTE_FLUXOS, FONTE_LOGOS, notaDoHost, melhorLogo };
