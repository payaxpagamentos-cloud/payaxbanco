'use strict';

const config = require('../config');
const { ErroNegocio } = require('./erros');
const { conferirEndereco } = require('./relay');

/**
 * Busca de imagens na internet (logos das emissoras, cartazes e banners do catálogo),
 * com os mesmos cuidados do resto: nada de IP privado, tamanho limitado e paciência com
 * quem limita a frequência.
 */

const esperar = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Origem a declarar ao buscar a imagem (i.imgur.com só entrega para quem vem do imgur.com). */
function refererDe(url) {
  try {
    const u = new URL(url);
    return `https://${u.hostname.replace(/^i\./, '')}/`;
  } catch {
    return 'https://iptv-org.github.io/';
  }
}

/** Baixa uma imagem e devolve o conteúdo. Lança ErroNegocio com o motivo quando não dá. */
async function baixarImagem(url, { tentativas = 4 } = {}) {
  await conferirEndereco(url);
  let resp;
  for (let tentativa = 0; tentativa < tentativas; tentativa += 1) {
    // Espera dobrando (2s, 4s, 8s). Quem hospeda a maior parte dos logos corta por frequência
    // depois de algumas dezenas de imagens, e devolve 403 — esperar um pouco resolve, insistir
    // na mesma velocidade não. Com a espera linear de antes, 47 dos 116 canais ficavam sem arte.
    if (tentativa) await esperar(2000 * (2 ** (tentativa - 1)));
    try {
      resp = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'PLAYTECHVIP/1.0',
          Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8',
          Referer: refererDe(url),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (tentativa === tentativas - 1) {
        throw new ErroNegocio(`Não foi possível baixar a imagem (${err.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede'}).`, 504);
      }
      continue;
    }
    // 403 e 429 aqui são quase sempre limite de frequência de quem hospeda a imagem.
    if (resp.ok || ![403, 429, 500, 502, 503].includes(resp.status)) break;
  }
  if (!resp.ok) throw new ErroNegocio(`O endereço da imagem respondeu ${resp.status}.`, 502);
  const tamanho = Number(resp.headers.get('content-length')) || 0;
  if (tamanho > config.arteMaxBytes) throw new ErroNegocio('A imagem passa do tamanho permitido.', 413);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > config.arteMaxBytes) throw new ErroNegocio('A imagem passa do tamanho permitido.', 413);
  if (buf.length < 200) throw new ErroNegocio('O endereço não devolveu uma imagem.', 422);
  return buf;
}

module.exports = { baixarImagem, esperar, refererDe };
