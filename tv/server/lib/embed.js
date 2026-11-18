'use strict';

const { ErroNegocio } = require('./erros');

/**
 * Player oficial da emissora (fonte "embed"): a PLAY TV não transmite nada, ela abre o
 * player público da própria emissora dentro da tela, com os anúncios dela.
 *
 * Aceita o endereço como a pessoa copiou (página ao vivo, link curto, canal do YouTube) e
 * devolve o endereço de incorporação correto.
 */

/** Converte endereços do YouTube para a forma de incorporação, inclusive "sempre a live do canal". */
function doYouTube(u) {
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (!['youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) return null;
  const params = new URLSearchParams({ autoplay: '1', rel: '0', modestbranding: '1', playsinline: '1' });
  // youtu.be/ID
  if (host === 'youtu.be') return `https://www.youtube.com/embed/${u.pathname.slice(1).split('/')[0]}?${params}`;
  // /watch?v=ID  e  /live/ID
  const v = u.searchParams.get('v');
  if (v) return `https://www.youtube.com/embed/${v}?${params}`;
  const live = /^\/live\/([^/]+)/.exec(u.pathname);
  if (live) return `https://www.youtube.com/embed/${live[1]}?${params}`;
  // /embed/live_stream?channel=UC...  (sempre a transmissão do momento daquele canal)
  const canal = u.searchParams.get('channel');
  if (canal) return `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(canal)}&${params}`;
  const jaEmbed = /^\/embed\//.test(u.pathname);
  if (jaEmbed) return `https://www.youtube.com${u.pathname}?${params}`;
  // /@canal/live  e  /channel/UC.../live não dão para resolver sem a API: peça o endereço do vídeo.
  throw new ErroNegocio('Deste endereço do YouTube não dá para montar o player. Abra a transmissão ao vivo e copie o endereço do vídeo (youtube.com/watch?v=… ou youtu.be/…).', 422);
}

/** Normaliza o endereço do player oficial. Devolve { url, origem } (a origem entra na política de segurança). */
function normalizar(valor) {
  let u;
  try {
    u = new URL(String(valor ?? '').trim());
  } catch {
    throw new ErroNegocio('Endereço do player oficial inválido (use https://…).', 422);
  }
  if (u.protocol !== 'https:') throw new ErroNegocio('O player oficial precisa ser https.', 422);
  const youtube = doYouTube(u);
  const url = youtube ?? u.toString();
  return { url, origem: new URL(url).origin };
}

// Muda sempre que um canal é criado, alterado ou apagado: a política de segurança das páginas
// precisa enxergar o player novo na hora, não no próximo minuto.
let versao = 1;
const invalidar = () => { versao += 1; };
const versaoAtual = () => versao;

/** Origens dos players oficiais cadastrados, para liberar só elas nas páginas. */
function origensCadastradas(db) {
  const linhas = db.prepare("SELECT DISTINCT url_embed FROM canais WHERE fonte = 'embed' AND url_embed IS NOT NULL AND ativo = 1").all();
  const origens = new Set();
  for (const l of linhas) {
    try {
      origens.add(new URL(l.url_embed).origin);
    } catch { /* endereço inválido no cadastro: ignora */ }
  }
  // O YouTube serve o player por dois domínios.
  if ([...origens].some((o) => o.includes('youtube'))) origens.add('https://www.youtube-nocookie.com');
  return [...origens];
}

module.exports = { normalizar, origensCadastradas, invalidar, versaoAtual };
