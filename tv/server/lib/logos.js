'use strict';

const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { baixarImagem, esperar } = require('./baixar');
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

  let conteudo;
  try {
    conteudo = await baixarImagem(achado.url);
  } catch (err) {
    // De onde a imagem viria: é o que distingue "esse host limitou a frequência" de "este
    // servidor não consegue sair para esse host".
    try { err.host = new URL(achado.url).hostname; } catch { /* endereço estranho */ }
    throw err;
  }
  const imagem = midia.salvarImagem(db, equipeLogos, conteudo, { nome: `logo-${canal.slug}` });
  db.prepare('UPDATE canais SET logo_midia_id = ?, atualizado_em = ? WHERE id = ?').run(imagem.id, agora(), canal.id);
  return { canal: canal.nome, logo_midia_id: imagem.id, origem: url ? 'endereço informado' : `lista pública (${achado.nome})` };
}

/**
 * Busca o logo de todos os canais de uma vez. Sem `forcar`, só mexe em quem ainda não tem.
 * Um canal que falhar não derruba os outros.
 */
async function aplicarEmTodos(db, { forcar = false, pausaMs = 1200, aoAndar = null } = {}) {
  const canais = db.prepare(`SELECT id, nome FROM canais ${forcar ? '' : 'WHERE logo_midia_id IS NULL'} ORDER BY numero`).all();
  const comLogo = [];
  const semLogo = [];
  const falharam = [];
  for (const [i, c] of canais.entries()) {
    // Pausa entre os canais: quem hospeda as imagens limita a frequência, e um provedor com
    // mais de cem canais chega perto desse limite. 1,2s dá uns 2 minutos e meio no total.
    if (i) await esperar(pausaMs);
    // Avisa canal a canal: com mais de cem canais, juntar tudo para imprimir no fim deixa quem
    // está no terminal olhando uma tela parada por minutos, sem saber se travou.
    try {
      const r = await aplicar(db, c.id, { forcar });
      if (r) comLogo.push(r);
      else semLogo.push(c.nome);
      aoAndar?.({ i: i + 1, total: canais.length, canal: c.nome, resultado: r ? 'ok' : 'sem-logo' });
    } catch (err) {
      falharam.push({ canal: c.nome, erro: err.message, host: err.host ?? null });
      aoAndar?.({ i: i + 1, total: canais.length, canal: c.nome, resultado: 'erro', erro: err.message });
    }
  }
  return { com_logo: comLogo, sem_logo: semLogo, falharam };
}

module.exports = { aplicar, aplicarEmTodos };
