'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { agora, lerConfig } = require('../db');
const { detectarTipo } = require('./arquivos');

/**
 * Notícias na tela.
 *
 * Tela que só passa anúncio cansa; uma manchete com foto entre os anúncios é o que faz a pessoa olhar de
 * novo — e valoriza o espaço de quem anuncia. As notícias vêm da Agência Brasil (EBC), a agência pública,
 * que autoriza a reprodução "desde que citada a fonte": por isso a tela sempre mostra "Agência Brasil".
 *
 *  - O servidor busca em segundo plano e guarda manchete e foto; a TV nunca fala com site de terceiro.
 *    Sem internet ou com a fonte fora do ar, a tela só deixa de mostrar notícia — nenhum anúncio para.
 *  - Política, justiça e polícia ficam de fora: tela em comércio não é lugar de assunto que divide o cliente.
 *
 * Depende de internet no servidor, por isso vem desligado de fábrica.
 */
const FONTE = { nome: 'Agência Brasil', feed: 'https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml' };
const HOSTS_IMAGEM = new Set(['imagens.ebc.com.br', 'agenciabrasil.ebc.com.br']);
const EDITORIAS = {
  geral: 'Geral', economia: 'Economia', esportes: 'Esportes', cultura: 'Cultura', saude: 'Saúde', educacao: 'Educação',
  'meio-ambiente': 'Meio ambiente', internacional: 'Mundo', 'ciencia-e-tecnologia': 'Tecnologia', 'pesquisa-e-inovacao': 'Ciência',
};
const VALIDADE_H = 36; // notícia mais velha que isso não vai para a tela
const GUARDAR = 30;
const MAX_IMAGEM = 4 * 1024 * 1024;
const pasta = () => path.join(config.arquivos, 'noticias');

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', ordf: 'ª', ordm: 'º', deg: '°' };
const decodificar = (t) => String(t ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m);
const semMarcas = (t) => String(t ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
const campo = (bloco, nome) => {
  const m = new RegExp(`<${nome}[^>]*>([\\s\\S]*?)</${nome}>`).exec(bloco);
  return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : '';
};
/** Corta no fim de uma frase (ou de uma palavra), sem deixar a manchete pela metade. */
function encurtar(texto, max) {
  if (texto.length <= max) return texto;
  const corte = texto.slice(0, max);
  const frase = corte.lastIndexOf('. ');
  if (frase > max * 0.5) return corte.slice(0, frase + 1);
  return `${corte.slice(0, corte.lastIndexOf(' '))}…`;
}

/** Lê o RSS e devolve as notícias que servem para a tela. */
function lerFeed(xml) {
  const itens = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const bloco = m[1];
    const link = decodificar(campo(bloco, 'link'));
    const editoria = /^https:\/\/agenciabrasil\.ebc\.com\.br\/([a-z-]+)\/noticia\//.exec(link)?.[1];
    if (!editoria || !EDITORIAS[editoria]) continue;
    const titulo = semMarcas(decodificar(campo(bloco, 'title'))).slice(0, 200);
    const imagem = decodificar(campo(bloco, 'imagem-destaque'));
    const data = new Date(campo(bloco, 'pubDate'));
    if (!titulo || !imagem || Number.isNaN(data.getTime())) continue;
    // O resumo é o primeiro parágrafo em destaque do texto (a "linha fina" da notícia).
    const descricao = decodificar(campo(bloco, 'description'));
    const destaque = /<strong>([\s\S]*?)<\/strong>/.exec(descricao)?.[1] ?? '';
    itens.push({ link, titulo, resumo: encurtar(semMarcas(decodificar(destaque)), 220) || null, categoria: EDITORIAS[editoria], imagem, publicada_em: data.toISOString() });
  }
  return itens;
}

/** Baixa a foto da notícia para o servidor (só do site da própria agência, e só se for imagem de verdade). */
async function baixarImagem(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !HOSTS_IMAGEM.has(u.hostname)) return null;
  const r = await fetch(u, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!r.ok || Number(r.headers.get('content-length') ?? 0) > MAX_IMAGEM) return null;
  const dados = Buffer.from(await r.arrayBuffer());
  const tipo = detectarTipo(dados);
  if (dados.length > MAX_IMAGEM || tipo?.tipo !== 'imagem') return null;
  const nome = `${crypto.createHash('sha256').update(dados).digest('hex').slice(0, 24)}.${tipo.ext}`;
  fs.mkdirSync(pasta(), { recursive: true });
  fs.writeFileSync(path.join(pasta(), nome), dados);
  return { arquivo: nome, mime: tipo.mime };
}

/** Busca as notícias novas e guarda (com a foto). `buscar` existe para os testes não dependerem da internet. */
async function atualizar(db, { buscarFeed, buscarFoto = baixarImagem } = {}) {
  if (!lerConfig(db).noticias_ligado) return { ligado: false, novas: 0 };
  const xml = buscarFeed ? await buscarFeed() : await (async () => {
    const r = await fetch(FONTE.feed, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/rss+xml, application/xml' } });
    if (!r.ok) throw new Error(`fonte respondeu ${r.status}`);
    return r.text();
  })();
  let novas = 0;
  for (const n of lerFeed(xml).slice(0, 12)) {
    if (db.prepare('SELECT 1 FROM noticias WHERE link = ?').get(n.link)) continue;
    const foto = await buscarFoto(n.imagem).catch(() => null);
    if (!foto) continue; // sem foto a tela fica pobre: melhor não mostrar
    db.prepare(`INSERT INTO noticias (link, titulo, resumo, categoria, fonte, imagem_arquivo, imagem_mime, publicada_em, buscada_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(n.link, n.titulo, n.resumo, n.categoria, FONTE.nome, foto.arquivo, foto.mime, n.publicada_em, agora());
    novas++;
  }
  // Faxina: ficam só as mais recentes (e as fotos delas).
  const velhas = db.prepare('SELECT id, imagem_arquivo FROM noticias ORDER BY publicada_em DESC LIMIT -1 OFFSET ?').all(GUARDAR);
  for (const v of velhas) {
    db.prepare('DELETE FROM noticias WHERE id = ?').run(v.id);
    if (!db.prepare('SELECT 1 FROM noticias WHERE imagem_arquivo = ?').get(v.imagem_arquivo)) fs.rmSync(path.join(pasta(), v.imagem_arquivo), { force: true });
  }
  return { ligado: true, novas };
}

/** As notícias que vão para a tela agora: as mais novas, ainda frescas. */
function paraTela(db, quantas = 6) {
  if (!lerConfig(db).noticias_ligado) return [];
  const desde = new Date(Date.now() - VALIDADE_H * 3_600_000).toISOString();
  return db.prepare('SELECT * FROM noticias WHERE publicada_em >= ? ORDER BY publicada_em DESC LIMIT ?').all(desde, quantas);
}

/** Manda a foto da notícia para a TV. */
function enviarImagem(db, res, id) {
  const n = db.prepare('SELECT imagem_arquivo, imagem_mime FROM noticias WHERE id = ?').get(Number(id));
  const caminho = n && /^[a-f0-9]{24}\.(jpg|png|webp)$/.test(n.imagem_arquivo) ? path.join(pasta(), n.imagem_arquivo) : null;
  if (!caminho || !fs.existsSync(caminho)) return res.status(404).json({ erro: 'Notícia sem foto.' });
  res.set({ 'Content-Type': n.imagem_mime, 'Cache-Control': 'private, max-age=86400' });
  return fs.createReadStream(caminho).pipe(res);
}

module.exports = { FONTE, lerFeed, atualizar, paraTela, enviarImagem };
