'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { agora } = require('../db');
const config = require('../config');
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
 * Claridade do logo, de 0 (preto) a 1 (branco).
 *
 * Logo de emissora costuma vir com fundo transparente, e metade deles é escuro: SporTV, HBO,
 * TCM e Warner são praticamente pretos. Sobre o fundo preto da tela, somem. Pintar o fundo de
 * branco para todos resolveria esses e faria sumir os claros, como TV Cultura e Fish TV. Então
 * cada logo é medido na hora de salvar, e a tela escolhe o fundo dele.
 *
 * A medição reduz a imagem a 16x16 e tira a média ponderada pelo alpha: pixel transparente não
 * conta. O ffmpeg já está no servidor (é ele quem converte os vídeos) e lê PNG, WebP e SVG.
 */
function medirLuz(arquivo) {
  try {
    const bruto = execFileSync(config.ffmpeg,
      ['-v', 'error', '-i', arquivo, '-vf', 'scale=16:16', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
      { maxBuffer: 1 << 20, timeout: 20_000 });
    let soma = 0;
    let peso = 0;
    for (let i = 0; i + 3 < bruto.length; i += 4) {
      const a = bruto[i + 3] / 255;
      if (a < 0.15) continue;                 // quase transparente: não é o desenho do logo
      soma += (0.2126 * bruto[i] + 0.7152 * bruto[i + 1] + 0.0722 * bruto[i + 2]) * a;
      peso += a;
    }
    return peso ? Number((soma / peso / 255).toFixed(3)) : null;
  } catch {
    return null;                              // sem medida, a tela usa o fundo neutro de sempre
  }
}

/** Mede e guarda a claridade do logo de um canal que já tem imagem. */
function medirDoCanal(db, canalId) {
  const linha = db.prepare(`SELECT m.arquivo FROM canais c JOIN midias m ON m.id = c.logo_midia_id WHERE c.id = ?`).get(Number(canalId));
  if (!linha) return null;
  const luz = medirLuz(path.join(config.midiaDir, linha.arquivo));
  if (luz !== null) db.prepare('UPDATE canais SET logo_luz = ? WHERE id = ?').run(luz, Number(canalId));
  return luz;
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
  medirDoCanal(db, canal.id);
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

module.exports = { aplicar, aplicarEmTodos, medirLuz, medirDoCanal };
