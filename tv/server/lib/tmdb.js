'use strict';

const config = require('../config');
const { ErroNegocio } = require('./erros');

/**
 * Catálogo do TMDB (themoviedb.org): a base que os aplicativos de streaming usam para
 * trazer cartaz, banner, sinopse, elenco e classificação de filmes e séries.
 *
 * A operação busca o título pelo nome e a ficha vem preenchida, com as artes oficiais.
 * Precisa do token da conta do cliente em `TV_TMDB_TOKEN` (gratuito em themoviedb.org).
 * Sem token, a busca some do painel e o cadastro segue manual.
 */

const API = 'https://api.themoviedb.org/3';
const IMAGENS = 'https://image.tmdb.org/t/p';

/** O cliente configurou o token? */
const ligado = () => Boolean(config.tmdb.token);

/** Endereço de uma arte do TMDB, no tamanho pedido ('original', 'w780'…). */
const arte = (caminho, tamanho = 'original') => (caminho ? `${IMAGENS}/${tamanho}${caminho}` : null);

/**
 * O TMDB tem duas credenciais: a chave antiga (v3, 32 caracteres, vai na URL) e o token de
 * leitura (v4, longo, vai no cabeçalho). As duas servem, e aqui a diferença é só essa.
 */
const ehChaveAntiga = (token) => /^[0-9a-f]{32}$/i.test(String(token).trim());

async function pedir(caminho, parametros = {}) {
  if (!ligado()) throw new ErroNegocio('A busca de filmes não está configurada: falta o token do TMDB.', 409, { motivo: 'sem_tmdb' });
  const url = new URL(`${API}${caminho}`);
  url.searchParams.set('language', config.tmdb.idioma);
  for (const [k, v2] of Object.entries(parametros)) if (v2 !== null && v2 !== undefined && v2 !== '') url.searchParams.set(k, String(v2));
  if (ehChaveAntiga(config.tmdb.token)) url.searchParams.set('api_key', config.tmdb.token.trim());

  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        ...(ehChaveAntiga(config.tmdb.token) ? {} : { Authorization: `Bearer ${config.tmdb.token}` }),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ErroNegocio(`Não foi possível falar com o TMDB (${err.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede'}).`, 504);
  }
  if (resp.status === 401) {
    throw new ErroNegocio('O TMDB recusou a credencial. Use a "API Read Access Token" (a longa) ou a "API Key" (32 caracteres) da conta.', 502, { motivo: 'tmdb_401' });
  }
  if (!resp.ok) throw new ErroNegocio(`O TMDB respondeu ${resp.status}.`, 502);
  return resp.json();
}

const ANO = (d) => (d ? Number(String(d).slice(0, 4)) || null : null);

/** Busca por nome. `tipo` é 'filme' ou 'serie'. */
async function buscar(termo, { tipo = 'filme', ano = null, limite = 12 } = {}) {
  const caminho = tipo === 'serie' ? '/search/tv' : '/search/movie';
  const dados = await pedir(caminho, {
    query: String(termo ?? '').slice(0, 120),
    include_adult: 'false',
    ...(ano ? (tipo === 'serie' ? { first_air_date_year: ano } : { primary_release_year: ano }) : {}),
  });
  return (dados.results ?? []).slice(0, limite).map((r) => ({
    tmdb_id: r.id,
    tipo,
    nome: tipo === 'serie' ? r.name : r.title,
    nome_original: tipo === 'serie' ? r.original_name : r.original_title,
    ano: ANO(tipo === 'serie' ? r.first_air_date : r.release_date),
    sinopse: r.overview || null,
    nota: r.vote_average ? Number(r.vote_average.toFixed(1)) : null,
    capa: arte(r.poster_path, 'w342'),
    banner: arte(r.backdrop_path, 'w780'),
  }));
}

// Classificação indicativa brasileira → os degraus que a plataforma usa.
const CLASSIFICACOES = { L: 0, ER: 0, AL: 0, 10: 10, 12: 12, 14: 14, 16: 16, 18: 18 };

/** Classificação brasileira do filme, quando o TMDB tem. */
function classificacaoBR(dados) {
  const lancamentos = dados.release_dates?.results ?? dados.content_ratings?.results ?? [];
  const br = lancamentos.find((x) => x.iso_3166_1 === 'BR');
  if (!br) return null;
  const valores = br.release_dates ? br.release_dates.map((x) => x.certification) : [br.rating];
  for (const v2 of valores) {
    const limpo = String(v2 ?? '').trim().toUpperCase();
    if (limpo in CLASSIFICACOES) return CLASSIFICACOES[limpo];
  }
  return null;
}

/**
 * Ficha completa de um título: o que o cadastro precisa, já no formato da plataforma.
 * `elenco` e `direcao` vêm dos créditos; as artes vêm no tamanho original.
 */
async function detalhes(tmdbId, { tipo = 'filme' } = {}) {
  const caminho = tipo === 'serie' ? `/tv/${Number(tmdbId)}` : `/movie/${Number(tmdbId)}`;
  const extras = tipo === 'serie' ? 'credits,content_ratings' : 'credits,release_dates';
  const d = await pedir(caminho, { append_to_response: extras });

  const elenco = (d.credits?.cast ?? []).slice(0, 8).map((p) => p.name).join(', ') || null;
  const direcao = tipo === 'serie'
    ? (d.created_by ?? []).map((p) => p.name).join(', ') || null
    : (d.credits?.crew ?? []).filter((p) => p.job === 'Director').map((p) => p.name).join(', ') || null;

  return {
    tmdb_id: d.id,
    tipo,
    nome: tipo === 'serie' ? d.name : d.title,
    nome_original: tipo === 'serie' ? d.original_name : d.original_title,
    sinopse: d.overview || null,
    ano: ANO(tipo === 'serie' ? d.first_air_date : d.release_date),
    pais: (d.production_countries ?? [])[0]?.name ?? null,
    duracao_s: tipo === 'serie' ? null : (d.runtime ? d.runtime * 60 : null),
    classificacao: classificacaoBR(d),
    generos: (d.genres ?? []).map((g) => g.name),
    elenco,
    direcao,
    nota: d.vote_average ? Number(d.vote_average.toFixed(1)) : null,
    temporadas: tipo === 'serie' ? d.number_of_seasons ?? null : null,
    capa_url: arte(d.poster_path, 'original'),
    banner_url: arte(d.backdrop_path, 'original'),
  };
}

module.exports = { ligado, buscar, detalhes, arte, IMAGENS };
