'use strict';

const { ErroNegocio } = require('./erros');
const { conferirEndereco } = require('./relay');

/**
 * Listas públicas de canais (projeto iptv-org): um catálogo aberto com o nome, a categoria e o
 * endereço do sinal de milhares de canais, inclusive os brasileiros.
 *
 * Serve para a operação não precisar caçar endereço a endereço. O que vem daqui entra
 * **desligado**: a operação testa o sinal, confere se pode transmitir aquele canal e só então liga.
 */

const FONTE_CANAIS = 'https://iptv-org.github.io/api/channels.json';
const FONTE_FLUXOS = 'https://iptv-org.github.io/api/streams.json';

// Os arquivos são grandes (vários MB): guarda por alguns minutos.
const cache = { em: 0, canais: null, fluxos: null };
const VALIDADE_MS = 10 * 60_000;

async function baixarJson(url, timeoutMs) {
  await conferirEndereco(url);
  let resp;
  try {
    resp = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'PLAYTECHVIP/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
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

module.exports = { canaisDoPais, CATEGORIAS, FONTE_CANAIS, FONTE_FLUXOS };
