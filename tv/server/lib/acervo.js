'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const qualidades = require('./qualidades');

/**
 * Ferramentas para trazer filme de **acervo público** para o catálogo: busca no Internet
 * Archive, escolha do arquivo de vídeo, quadros para a capa e o banner, medição e geração
 * das versões menores (Full HD, HD e SD).
 *
 * Usado pelo seed (dados de demonstração) e pelo script `catalogo-publico.js`.
 *
 * ATENÇÃO AO DIREITO AUTORAL: estar disponível num acervo público não quer dizer que a obra
 * seja livre. As funções daqui olham a licença declarada no item e a coleção de origem, mas a
 * conferência final é de quem publica. As coleções conhecidas de domínio público estão em
 * COLECOES_LIVRES.
 */

const ARCHIVE = 'https://archive.org';

/** Coleções do Internet Archive cujo acervo é, por definição, de domínio público ou livre. */
const COLECOES_LIVRES = {
  'feature_films': 'Longas de domínio público',
  'publicmovies212': 'Filmes de domínio público (seleção)',
  'classic_cartoons': 'Desenhos clássicos',
  'sci-fi_horror': 'Ficção científica e terror clássicos',
  'film_noir': 'Film noir clássico',
  'prelinger': 'Arquivo Prelinger (institucionais e educativos)',
  'silent_films': 'Cinema mudo',
  'malescollection': 'Acervo de curtas livres',
};

/**
 * Licenças que permitem **redistribuir e converter**: domínio público e Creative Commons by e
 * by-sa. A "sem derivadas" (by-nd) fica de fora de propósito — gerar Full HD, HD e SD a partir
 * do original é criar derivada, e isso ela não autoriza.
 */
const LICENCAS_LIVRES = /creativecommons\.org\/(licenses\/(by|by-sa)\/|publicdomain\/)/i;

const pastaTemporaria = fs.mkdtempSync(path.join(os.tmpdir(), 'playtechvip-acervo-'));
const temporario = (prefixo, extensao) => path.join(pastaTemporaria, `${prefixo}-${crypto.randomBytes(6).toString('hex')}.${extensao}`);

/** O ffmpeg está instalado? Sem ele não dá para tirar quadro nem gerar as versões menores. */
function temFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Tira um quadro do próprio filme (o ffmpeg busca só os bytes daquele trecho). */
function quadroDoFilme(url, segundo) {
  const saida = temporario('q', 'jpg');
  try {
    // thumbnail=60: olha 60 quadros e fica com o mais representativo (evita cortes e telas pretas).
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(segundo), '-i', url, '-vf', 'thumbnail=60', '-frames:v', '1', '-q:v', '2', saida],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 180_000 });
    const buf = fs.readFileSync(saida);
    fs.rmSync(saida, { force: true });
    return buf;
  } catch {
    return null;
  }
}

/**
 * Escolhe o melhor quadro entre alguns instantes: cena escura ou parada comprime muito,
 * então o maior JPEG costuma ser o quadro com mais imagem — e é esse que vira a arte.
 */
function melhorQuadro(url, instantes) {
  let melhor = null;
  for (const t of instantes) {
    const q = quadroDoFilme(url, t);
    if (q && (!melhor || q.length > melhor.length)) melhor = q;
  }
  return melhor;
}

/** Duração real da cópia no acervo (cada cópia tem a sua: restaurações são mais longas). */
function duracaoRemota(url) {
  try {
    const saida = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', url],
      { encoding: 'utf8', timeout: 180_000 }).trim();
    return Math.round(Number(saida)) || null;
  } catch {
    return null;
  }
}

/**
 * Guarda um trecho do filme. Primeiro tenta copiar os fluxos, que é rápido e não recomprime;
 * quando o formato de origem não cabe num MP4 (mkv com áudio Vorbis, avi antigo, webm), converte.
 */
function trechoDoFilme(url, segundo, duracao, { converter = true } = {}) {
  const tentar = (args) => {
    const saida = temporario('t', 'mp4');
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(segundo), '-i', url, '-t', String(duracao),
        ...args, '-movflags', '+faststart', saida], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 900_000 });
      return fs.existsSync(saida) && fs.statSync(saida).size > 100_000 ? saida : null;
    } catch {
      fs.rmSync(saida, { force: true });
      return null;
    }
  };
  return tentar(['-c', 'copy'])
    ?? (converter ? tentar(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k']) : null);
}

/** Baixa o filme inteiro do acervo para um arquivo local. */
async function baixarFilme(url, aoAndar = null) {
  const saida = temporario('f', 'mp4');
  const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!resp.ok) throw new Error(`o acervo respondeu ${resp.status}`);
  const total = Number(resp.headers.get('content-length')) || 0;
  let recebido = 0;
  const destino = fs.createWriteStream(saida);
  for await (const pedaco of resp.body) {
    recebido += pedaco.length;
    destino.write(pedaco);
    if (aoAndar && total) aoAndar(recebido / total);
  }
  await new Promise((pronto, falhou) => { destino.end(pronto); destino.on('error', falhou); });
  return saida;
}

/** Largura, altura e duração reais de um arquivo (o painel grava isso junto com a mídia). */
function medirVideo(arquivo) {
  try {
    const saida = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration', '-of', 'default=nw=1:nk=1', arquivo],
    { encoding: 'utf8', timeout: 60_000 }).trim().split(/\s+/);
    return { largura: Number(saida[0]) || null, altura: Number(saida[1]) || null, duracao: Math.round(Number(saida[2])) || null };
  } catch {
    return { largura: null, altura: null, duracao: null };
  }
}

// Altura de cada degrau da escada de qualidade.
const ESCADA = [['4k', 2160], ['fullhd', 1080], ['hd', 720], ['sd', 480]];

/**
 * Gera as versões menores num passe só do ffmpeg: decodifica uma vez e escreve todos os
 * degraus abaixo do original. É assim que o assinante escolhe 4K, Full HD, HD ou SD.
 */
function versoesMenores(arquivoTopo, alturaTopo, larguraTopo = 0) {
  const doTopo = qualidades.porMedidas(larguraTopo, alturaTopo);
  // Só degraus abaixo do original — e nunca a mesma qualidade dele (um 1608p já é Full HD).
  const alvos = ESCADA.filter(([q, alt]) => alt < alturaTopo - 60 && qualidades.nivel(q) < qualidades.nivel(doTopo));
  if (!alvos.length) return [];
  const saidas = alvos.map(([q, alt]) => ({ qualidade: q, altura: alt, arquivo: temporario(`v-${q}`, 'mp4') }));
  const filtro = [`[0:v]split=${saidas.length}${saidas.map((_, i) => `[d${i}]`).join('')}`,
    ...saidas.map((s, i) => `[d${i}]scale=-2:${s.altura}[v${i}]`)].join(';');
  const args = ['-v', 'error', '-y', '-i', arquivoTopo, '-filter_complex', filtro];
  saidas.forEach((s, i) => {
    args.push('-map', `[v${i}]`, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', s.arquivo);
  });
  const prontas = () => saidas.filter((s) => fs.existsSync(s.arquivo) && fs.statSync(s.arquivo).size > 50_000);
  try {
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 900_000 });
  } catch {
    return prontas();
  }
  return prontas();
}

// ---------------------------------------------------------------- Internet Archive

const comoTexto = (v) => (Array.isArray(v) ? v.join(', ') : (v ?? ''));

/**
 * Busca itens no Internet Archive. Devolve o que a busca sabe: identificador, título, ano,
 * descrição, coleções e licença — sem baixar nada ainda.
 */
async function buscarNoArchive({ colecao = 'feature_films', termo = '', quantos = 20, pagina = 1, anoDe = null, anoAte = null } = {}) {
  const partes = ['mediatype:(movies)', '-collection:(test_collection)'];
  if (colecao) partes.push(`collection:(${colecao})`);
  if (termo) partes.push(`(title:(${termo}) OR description:(${termo}))`);
  if (anoDe || anoAte) partes.push(`year:[${anoDe ?? '*'} TO ${anoAte ?? '*'}]`);

  const url = new URL(`${ARCHIVE}/advancedsearch.php`);
  url.searchParams.set('q', partes.join(' AND '));
  for (const campo of ['identifier', 'title', 'year', 'description', 'collection', 'licenseurl', 'downloads', 'runtime']) {
    url.searchParams.append('fl[]', campo);
  }
  url.searchParams.set('sort[]', 'downloads desc');
  url.searchParams.set('rows', String(Math.min(100, quantos)));
  url.searchParams.set('page', String(pagina));
  url.searchParams.set('output', 'json');

  const resp = await fetch(url, { headers: { 'User-Agent': 'PLAYTECHVIP/1.0' }, signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw new Error(`a busca no acervo respondeu ${resp.status}`);
  const dados = await resp.json();
  return (dados.response?.docs ?? []).map((d) => ({
    id: d.identifier,
    titulo: comoTexto(d.title).trim(),
    ano: Number(comoTexto(d.year)) || null,
    descricao: comoTexto(d.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    colecoes: Array.isArray(d.collection) ? d.collection : [d.collection].filter(Boolean),
    licenca: comoTexto(d.licenseurl) || null,
    baixados: Number(d.downloads) || 0,
  }));
}

/**
 * O item pode ser redistribuído?
 * Vale quando a licença declarada é livre **ou** quando ele está numa coleção de domínio
 * público conhecida. Fora disso, devolve false — e aí a operação confere à mão.
 */
function podeRedistribuir(item) {
  if (item.licenca && LICENCAS_LIVRES.test(item.licenca)) return true;
  return (item.colecoes ?? []).some((c) => Object.hasOwn(COLECOES_LIVRES, c));
}

/** Ficha completa de um item, com a lista de arquivos. */
async function fichaDoArchive(id) {
  const resp = await fetch(`${ARCHIVE}/metadata/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': 'PLAYTECHVIP/1.0' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`o acervo respondeu ${resp.status} para ${id}`);
  return resp.json();
}

// Tamanho acima do qual um arquivo só entra se for pedido (masters de estúdio passam de 100 GB).
const BYTES_MAX = 20 * 1024 * 1024 * 1024;
const FORMATOS = [/\.mp4$/i, /\.m4v$/i, /\.mkv$/i, /\.mov$/i, /\.webm$/i, /\.avi$/i, /\.ogv$/i];
const posicaoDoFormato = (nome) => FORMATOS.findIndex((p) => p.test(nome));

/**
 * Melhor arquivo de vídeo de um item.
 *
 * O acervo guarda o original e várias cópias menores que ele gera sozinho — e a cópia chamada
 * "720p.mp4" costuma ser, na verdade, 360p. Por isso a escolha é pela **resolução de verdade**,
 * e só depois pelo formato: MP4 toca direto; os demais entram convertidos.
 */
function melhorArquivo(ficha, { bytesMax = BYTES_MAX } = {}) {
  const candidatos = (ficha.files ?? [])
    .filter((f) => posicaoDoFormato(f.name) >= 0 && Number(f.size) > 2_000_000 && Number(f.size) <= bytesMax)
    .map((f) => ({
      nome: f.name,
      bytes: Number(f.size),
      largura: Number(f.width) || 0,
      altura: Number(f.height) || 0,
      original: f.source === 'original',
      formato: posicaoDoFormato(f.name),
    }));
  if (!candidatos.length) return null;

  candidatos.sort((a, b) => (b.altura - a.altura)
    || (a.formato - b.formato)
    || (Number(b.original) - Number(a.original))
    || (b.bytes - a.bytes));

  const f = candidatos[0];
  return {
    ...f,
    // Fora do MP4, o navegador pode não tocar: o importador converte na entrada.
    precisaConverter: !/\.(mp4|m4v)$/i.test(f.nome),
    url: `${ARCHIVE}/download/${encodeURIComponent(ficha.metadata.identifier)}/${f.nome.split('/').map(encodeURIComponent).join('/')}`,
  };
}

module.exports = {
  ARCHIVE,
  COLECOES_LIVRES,
  pastaTemporaria,
  temFfmpeg,
  quadroDoFilme,
  melhorQuadro,
  duracaoRemota,
  trechoDoFilme,
  baixarFilme,
  medirVideo,
  versoesMenores,
  buscarNoArchive,
  podeRedistribuir,
  fichaDoArchive,
  melhorArquivo,
};
