'use strict';

const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { conferirEndereco } = require('./relay');
const listasPublicas = require('./listas-publicas');
const midia = require('./midia');

/**
 * Logos das emissoras nos canais.
 *
 * O logo identifica o canal na grade e no app — é o mesmo uso que qualquer guia de programação
 * faz. A busca automática usa a lista pública (iptv-org), que traz o endereço do logo de cada
 * canal; quem tiver o material oficial da emissora troca pelo painel, enviando a imagem.
 */

const equipeLogos = { id: null, nome: 'logos' };

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

/**
 * Baixa a imagem do logo, com os mesmos cuidados do resto: sem IP privado e com tamanho limitado.
 * Os sites que hospedam os logos limitam a frequência, então vale esperar e tentar de novo.
 */
async function baixar(url) {
  await conferirEndereco(url);
  let resp;
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    if (tentativa) await esperar(1500 * tentativa);
    try {
      resp = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'PLAYTECHVIP/1.0',
          Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8',
          // Alguns sites de imagem recusam quem chega sem origem (proteção contra link direto).
          Referer: refererDe(url),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (tentativa === 2) throw new ErroNegocio(`Não foi possível baixar o logo (${err.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede'}).`, 504);
      continue;
    }
    // 403 e 429 aqui são quase sempre limite de frequência de quem hospeda a imagem.
    if (resp.ok || ![403, 429, 500, 502, 503].includes(resp.status)) break;
  }
  if (!resp.ok) throw new ErroNegocio(`O endereço do logo respondeu ${resp.status}.`, 502);
  const tamanho = Number(resp.headers.get('content-length')) || 0;
  if (tamanho > config.arteMaxBytes) throw new ErroNegocio('O logo passa do tamanho permitido.', 413);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > config.arteMaxBytes) throw new ErroNegocio('O logo passa do tamanho permitido.', 413);
  if (buf.length < 200) throw new ErroNegocio('O endereço não devolveu uma imagem.', 422);
  return buf;
}

/**
 * Põe o logo num canal: do endereço informado ou do que a lista pública tiver para ele.
 * Devolve { canal, logo_midia_id, origem } ou null quando não há logo para esse canal.
 */
async function aplicar(db, canalId, { url = null, forcar = false } = {}) {
  const canal = db.prepare('SELECT * FROM canais WHERE id = ?').get(Number(canalId));
  if (!canal) throw naoEncontrado('Canal');
  if (canal.logo_midia_id && !forcar && !url) return { canal: canal.nome, logo_midia_id: canal.logo_midia_id, origem: 'já tinha' };

  const achado = url ? { url, nome: canal.nome } : await listasPublicas.logoDoCanal(canal.nome, { id: canal.id_publico });
  if (!achado) return null;

  const conteudo = await baixar(achado.url);
  const imagem = midia.salvarImagem(db, equipeLogos, conteudo, { nome: `logo-${canal.slug}` });
  db.prepare('UPDATE canais SET logo_midia_id = ?, atualizado_em = ? WHERE id = ?').run(imagem.id, agora(), canal.id);
  return { canal: canal.nome, logo_midia_id: imagem.id, origem: url ? 'endereço informado' : `lista pública (${achado.nome})` };
}

/**
 * Busca o logo de todos os canais de uma vez. Sem `forcar`, só mexe em quem ainda não tem.
 * Um canal que falhar não derruba os outros.
 */
async function aplicarEmTodos(db, { forcar = false } = {}) {
  const canais = db.prepare(`SELECT id, nome FROM canais ${forcar ? '' : 'WHERE logo_midia_id IS NULL'} ORDER BY numero`).all();
  const comLogo = [];
  const semLogo = [];
  const falharam = [];
  for (const [i, c] of canais.entries()) {
    // Uma pausa curta entre os canais: quem hospeda as imagens limita a frequência.
    if (i) await esperar(600);
    try {
      const r = await aplicar(db, c.id, { forcar });
      if (r) comLogo.push(r);
      else semLogo.push(c.nome);
    } catch (err) {
      falharam.push({ canal: c.nome, erro: err.message });
    }
  }
  return { com_logo: comLogo, sem_logo: semLogo, falharam };
}

module.exports = { aplicar, aplicarEmTodos };
