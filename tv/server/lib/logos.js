'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { agora } = require('../db');
const config = require('../config');
const { ErroNegocio, naoEncontrado } = require('./erros');
// O módulo inteiro, não as funções soltas: desestruturar aqui congela a referência e o teste
// não consegue pôr um host de mentira no lugar para exercitar o bloqueio.
const baixar = require('./baixar');
const { esperar } = baixar;
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
 * O quanto o logo se destaca do preto, de 0 (some) a 1 (salta aos olhos).
 *
 * Logo de emissora costuma vir com fundo transparente, e metade deles é escuro: SporTV, HBO,
 * TCM e Warner são praticamente pretos. Sobre o fundo preto da tela, somem. Pintar o fundo de
 * branco para todos resolveria esses e faria sumir os claros, como TV Cultura. Então cada logo
 * é medido na hora de salvar, e a tela escolhe o fundo dele.
 *
 * A medição olha o CANAL MAIS FORTE de cada pixel, não a luminância. É uma correção: com
 * luminância, cor saturada era confundida com cor escura. O laranja de "A Fazenda" dá 0,35 de
 * luminância e ganhava fundo claro — onde justamente fica lavado —, sendo que sobre o preto ele
 * salta. O azul da RedeTV! e o verde do Sabor & Arte caíam no mesmo erro. Pelo canal mais forte,
 * laranja vivo dá 0,43 (fica no preto) e um desenho quase preto dá 0,03 (ganha o fundo claro),
 * que é o que a vista faz.
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
      soma += Math.max(bruto[i], bruto[i + 1], bruto[i + 2]) * a;
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
async function aplicar(db, canalId, { url = null, forcar = false, hostsBloqueados = null } = {}) {
  const canal = db.prepare('SELECT * FROM canais WHERE id = ?').get(Number(canalId));
  if (!canal) throw naoEncontrado('Canal');
  if (canal.logo_midia_id && !forcar && !url) return { canal: canal.nome, logo_midia_id: canal.logo_midia_id, origem: 'já tinha' };

  const achado = url ? { url, nome: canal.nome } : await listasPublicas.logoDoCanal(canal.nome, { id: canal.id_publico });
  if (!achado) return null;

  // Host que já se mostrou fechado nesta rodada: nem tenta. Economiza mais de dois minutos por
  // canal e deixa o relatório final honesto sobre quantos ficaram para a próxima.
  let hostDoLogo = null;
  try { hostDoLogo = new URL(achado.url).hostname; } catch { /* endereço estranho */ }
  if (hostDoLogo && hostsBloqueados?.has(hostDoLogo)) return { canal: canal.nome, pulado: true, host: hostDoLogo };

  let conteudo;
  try {
    conteudo = await baixar.baixarImagem(achado.url);
  } catch (err) {
    // De onde a imagem viria: é o que distingue "esse host limitou a frequência" de "este
    // servidor não consegue sair para esse host".
    try { err.host = new URL(achado.url).hostname; } catch { /* endereço estranho */ }
    throw err;
  }
  const imagem = midia.salvarImagem(db, equipeLogos, conteudo, { nome: `logo-${canal.slug}` });
  db.prepare('UPDATE canais SET logo_midia_id = ?, atualizado_em = ? WHERE id = ?').run(imagem.id, agora(), canal.id);
  medirDoCanal(db, canal.id);
  return { canal: canal.nome, logo_midia_id: imagem.id, host: hostDoLogo,
    origem: url ? 'endereço informado' : `lista pública (${achado.nome})` };
}

/**
 * Busca o logo de todos os canais de uma vez. Sem `forcar`, só mexe em quem ainda não tem.
 * Um canal que falhar não derruba os outros.
 */
const RECUSAS_ATE_DESISTIR = 5;

async function aplicarEmTodos(db, { forcar = false, pausaMs = 1200, aoAndar = null } = {}) {
  const canais = db.prepare(`SELECT id, nome FROM canais ${forcar ? '' : 'WHERE logo_midia_id IS NULL'} ORDER BY numero`).all();
  const comLogo = [];
  const semLogo = [];
  const falharam = [];
  // Host que já recusou seguidas vezes. Quando quem hospeda bloqueia o ENDEREÇO do servidor —
  // e o imgur, onde está a maioria dos logos brasileiros, faz isso depois de uma rajada —, a
  // recusa chega em milissegundos e nenhuma espera resolve. Insistir nos 90 canais seguintes
  // custa mais de uma hora de tentativa e devolve zero logo. Então desiste daquele host, segue
  // com os outros e diz claramente o que houve, para a operação rodar de novo mais tarde.
  const recusas = new Map();
  const bloqueados = new Set();
  let pulados = 0;

  for (const [i, c] of canais.entries()) {
    // Avisa ANTES de tentar: um canal que vai esgotar prazo e tentar de novo leva mais de dois
    // minutos, e sem esta linha o terminal fica parado sem sinal de vida. Foi o que pareceu
    // "travar em 110/123" na implantação.
    aoAndar?.({ i: i + 1, total: canais.length, canal: c.nome, resultado: 'tentando' });
    try {
      const r = await aplicar(db, c.id, { forcar, hostsBloqueados: bloqueados });
      if (r?.pulado) { pulados += 1; aoAndar?.({ i: i + 1, total: canais.length, canal: c.nome, resultado: 'pulado', host: r.host }); continue; }
      if (r) comLogo.push(r);
      else semLogo.push(c.nome);
      if (r?.host) recusas.delete(r.host);   // voltou a responder: zera a contagem
      aoAndar?.({ i: i + 1, total: canais.length, canal: c.nome, resultado: r ? 'ok' : 'sem-logo' });
    } catch (err) {
      const host = err.host ?? null;
      falharam.push({ canal: c.nome, erro: err.message, host });
      if (host && /respondeu (403|429)/.test(err.message)) {
        const n = (recusas.get(host) ?? 0) + 1;
        recusas.set(host, n);
        if (n >= RECUSAS_ATE_DESISTIR) bloqueados.add(host);
      }
      aoAndar?.({ i: i + 1, total: canais.length, canal: c.nome, resultado: 'erro', erro: err.message, host,
        hostDesistido: host && bloqueados.has(host) && recusas.get(host) === RECUSAS_ATE_DESISTIR ? host : null });
    }
    // Pausa entre os canais: quem hospeda as imagens limita a frequência, e um provedor com
    // mais de cem canais chega perto desse limite.
    if (i < canais.length - 1) await esperar(pausaMs);
  }
  return { com_logo: comLogo, sem_logo: semLogo, falharam, hosts_bloqueados: [...bloqueados], pulados };
}

module.exports = { aplicar, aplicarEmTodos, medirLuz, medirDoCanal };
