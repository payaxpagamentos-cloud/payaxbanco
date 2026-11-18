'use strict';

/**
 * Dados de demonstração da PLAY TECH VIP: canais com grade, catálogo com artes geradas aqui,
 * assinantes, faturas e audiência dos últimos 30 dias.
 *
 * Os vídeos de demonstração são gerados pelo ffmpeg, se ele estiver instalado. Sem ffmpeg,
 * o catálogo entra como rascunho e o aviso no fim explica como enviar os vídeos pelo painel.
 *
 * Uso: npm run seed            (apaga o conteúdo de demonstração e recria)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const config = require('./config');
const { abrir, transacao, agora, slug, gravarConfig } = require('./db');
const { hashSenha } = require('./lib/senha');
const midia = require('./lib/midia');
const { hoje, somarDias, somarMeses, competencia } = require('./lib/datas');
const { CANAIS_ABERTOS } = require('./lib/tv-aberta');
const versoes = require('./lib/versoes');
const qualidades = require('./lib/qualidades');

const db = abrir();
const equipeFalsa = { id: 1, nome: 'seed' };
const temFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const SENHA_EQUIPE = 'play2026';
const SENHA_CLIENTE = 'cliente2026';

// ---------------------------------------------------------------- artes

const CORES = [['#7C2D12', '#FF8A5B'], ['#431407', '#FFC043'], ['#5B1A0B', '#FF4D1C'], ['#78350F', '#FBBF24'],
  ['#3F1D0B', '#F97316'], ['#4C1D0C', '#FDBA74'], ['#601410', '#EF4444'], ['#422006', '#FACC15']];

const escapar = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Quebra o nome em linhas que cabem na arte. */
function quebrar(nome, porLinha = 14) {
  const linhas = [];
  let atual = '';
  for (const palavra of String(nome).split(/\s+/)) {
    if ((`${atual} ${palavra}`).trim().length > porLinha) { linhas.push(atual.trim()); atual = palavra; } else atual = `${atual} ${palavra}`;
  }
  if (atual.trim()) linhas.push(atual.trim());
  return linhas.filter(Boolean);
}

/** Reserva: cartaz desenhado aqui mesmo, quando não há internet para buscar a foto. */
function arteSvg(nome, { largura = 600, altura = 900, etiqueta = 'PLAY TECH VIP', indice = 0, comNome = true } = {}) {
  const [a, b] = CORES[indice % CORES.length];
  const linhas = quebrar(nome);
  const base = altura / 2 - (linhas.length - 1) * (altura * 0.045);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${largura} ${altura}" width="${largura}" height="${altura}">
<defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".65"/></linearGradient></defs>
<rect width="${largura}" height="${altura}" fill="url(#f)"/>
<circle cx="${largura * 0.8}" cy="${altura * 0.2}" r="${largura * 0.33}" fill="#fff" fill-opacity=".07"/>
<circle cx="${largura * 0.2}" cy="${altura * 0.78}" r="${largura * 0.42}" fill="#000" fill-opacity=".12"/>
<rect width="${largura}" height="${altura}" fill="url(#s)"/>
${comNome ? linhas.map((l, i) => `<text x="${largura * 0.08}" y="${base + i * altura * 0.09}" font-family="sans-serif" font-size="${largura * 0.095}" font-weight="800" fill="#fff">${escapar(l)}</text>`).join('\n') : ''}
</svg>`, 'utf8');
}
void arteSvg;

/** Logo quadrada do canal (marca, não foto: desenhada aqui mesmo). */
const logoSvg = (nome, indice) => {
  const [a, b] = CORES[indice % CORES.length];
  const sigla = nome.split(/\s+/).map((p) => p[0]).join('').slice(0, 3).toUpperCase();
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="200" height="200" rx="34" fill="url(#g)"/>
<text x="100" y="124" text-anchor="middle" font-family="sans-serif" font-size="68" font-weight="800" fill="#fff">${escapar(sigla)}</text></svg>`, 'utf8');
};

const urlArchive = (item, arquivo) => `https://archive.org/download/${item}/${encodeURIComponent(arquivo)}`;

/** Tira um quadro do próprio filme (o ffmpeg busca só os bytes daquele trecho). */
function quadroDoFilme(url, segundo) {
  const saida = path.join(pastaArtes, `q-${crypto.randomBytes(6).toString('hex')}.jpg`);
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

/** Guarda um trecho do filme, copiando os fluxos (rápido e sem recomprimir). */
function trechoDoFilme(url, segundo, duracao) {
  const saida = path.join(pastaArtes, `t-${crypto.randomBytes(6).toString('hex')}.mp4`);
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(segundo), '-i', url, '-t', String(duracao),
      '-c', 'copy', '-movflags', '+faststart', saida], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000 });
    return fs.existsSync(saida) && fs.statSync(saida).size > 100_000 ? saida : null;
  } catch {
    return null;
  }
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
 * Gera as versões menores do trecho num passe só do ffmpeg: decodifica uma vez e escreve
 * todos os degraus abaixo do original. É assim que o assinante escolhe 4K, Full HD, HD ou SD.
 */
function versoesMenores(arquivoTopo, alturaTopo, larguraTopo = 0) {
  const doTopo = qualidades.porMedidas(larguraTopo, alturaTopo);
  // Só degraus abaixo do original — e nunca a mesma qualidade dele (um 1608p já é Full HD).
  const alvos = ESCADA.filter(([q, alt]) => alt < alturaTopo - 60 && qualidades.nivel(q) < qualidades.nivel(doTopo));
  if (!alvos.length) return [];
  const saidas = alvos.map(([q, alt]) => ({ qualidade: q, altura: alt, arquivo: path.join(pastaArtes, `v-${q}-${crypto.randomBytes(5).toString('hex')}.mp4`) }));
  const filtro = [`[0:v]split=${saidas.length}${saidas.map((_, i) => `[d${i}]`).join('')}`,
    ...saidas.map((s2, i) => `[d${i}]scale=-2:${s2.altura}[v${i}]`)].join(';');
  const args = ['-v', 'error', '-y', '-i', arquivoTopo, '-filter_complex', filtro];
  saidas.forEach((s2, i) => {
    args.push('-map', `[v${i}]`, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', s2.arquivo);
  });
  try {
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 900_000 });
  } catch {
    return saidas.filter((s2) => fs.existsSync(s2.arquivo) && fs.statSync(s2.arquivo).size > 50_000);
  }
  return saidas.filter((s2) => fs.existsSync(s2.arquivo) && fs.statSync(s2.arquivo).size > 50_000);
}

const pastaArtes = fs.mkdtempSync(path.join(os.tmpdir(), 'playtechvip-artes-'));
let fotosBaixadas = 0;
let fotosFalharam = 0;

/** Baixa uma foto (sempre a mesma para a mesma semente) para servir de base da arte. */
async function baixarFoto(semente, largura, altura) {
  const url = `https://picsum.photos/seed/${encodeURIComponent(semente)}/${largura}/${altura}`;
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    try {
      const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (!resp.ok) throw new Error(String(resp.status));
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 1000) {
        fotosBaixadas += 1;
        return buf;
      }
    } catch { /* tenta de novo */ }
  }
  fotosFalharam += 1;
  return null;
}

const FONTE = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf']
  .find((f) => fs.existsSync(f)) ?? null;

const paraFfmpeg = (t) => String(t).replace(/\\/g, '').replace(/'/g, '').replace(/:/g, ' ').replace(/[%]/g, '');

/**
 * Monta a arte a partir da foto: recorte, correção de cor, escurecimento em degradê
 * e o nome do título — do jeito que um cartaz de catálogo se parece.
 */
function tratarFoto(foto, { largura, altura, nome = null, etiqueta = null, lado = 'baixo' }) {
  const entrada = path.join(pastaArtes, `e-${crypto.randomBytes(6).toString('hex')}.jpg`);
  const saida = path.join(pastaArtes, `s-${crypto.randomBytes(6).toString('hex')}.jpg`);
  fs.writeFileSync(entrada, foto);

  const filtros = [
    `scale=${largura}:${altura}:force_original_aspect_ratio=increase`,
    `crop=${largura}:${altura}`,
    'eq=saturation=0.95:contrast=1.08:brightness=-0.02',
    'vignette=PI/5',
  ];
  // Só o cartaz em pé recebe degradê pintado (é onde o nome fica escrito na arte).
  // No banner, quem escurece é o próprio layout — pintar aqui deixaria faixas à mostra.
  if (lado === 'baixo') {
    // Degradê liso: faixas de 1% da altura, para não aparecer escada no cartaz.
    const faixas = 56;
    const h = Math.ceil((altura * 0.58) / faixas);
    for (let i = 0; i < faixas; i += 1) {
      const alpha = ((i / faixas) ** 1.8 * 0.88).toFixed(3);
      filtros.push(`drawbox=x=0:y=${Math.round(altura - (faixas - i) * h)}:w=${largura}:h=${h}:color=black@${alpha}:t=fill`);
    }
  } else {
    filtros.push('eq=brightness=-0.03');
  }
  if (nome && FONTE) {
    const linhas = quebrar(nome, largura > 1000 ? 22 : 13);
    const tamanho = Math.round(largura * (largura > 1000 ? 0.052 : 0.105));
    const base = altura - Math.round(altura * 0.07) - (linhas.length - 1) * Math.round(tamanho * 1.08);
    if (etiqueta) {
      filtros.push(`drawtext=fontfile=${FONTE}:text='${paraFfmpeg(etiqueta.toUpperCase())}':fontcolor=#E50914:fontsize=${Math.round(tamanho * 0.3)}:x=${Math.round(largura * 0.07)}:y=${base - Math.round(tamanho * 0.75)}:borderw=0`);
    }
    linhas.forEach((linha, i) => {
      filtros.push(`drawtext=fontfile=${FONTE}:text='${paraFfmpeg(linha)}':fontcolor=white:fontsize=${tamanho}:x=${Math.round(largura * 0.07)}:y=${base + i * Math.round(tamanho * 1.08)}:shadowcolor=black@0.6:shadowx=2:shadowy=3`);
    });
  }

  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', entrada, '-vf', filtros.join(','), '-q:v', '3', saida], { stdio: ['ignore', 'ignore', 'pipe'] });
  const resultado = fs.readFileSync(saida);
  fs.rmSync(entrada, { force: true });
  fs.rmSync(saida, { force: true });
  return resultado;
}

/**
 * Arte do catálogo: tenta a foto tratada; sem internet (ou sem ffmpeg), cai no desenho local.
 * `tipo` é 'capa' (em pé), 'banner' (deitado) ou 'thumb' (miniatura de episódio).
 */
async function arteDoTitulo(nome, { tipo = 'capa', semente, indice = 0, etiqueta = null } = {}) {
  const medidas = { capa: [800, 1200], banner: [1920, 1080], thumb: [854, 480] }[tipo];
  const foto = temFfmpeg ? await baixarFoto(semente ?? slug(nome), medidas[0], medidas[1]) : null;
  if (foto) {
    try {
      return tratarFoto(foto, {
        largura: medidas[0],
        altura: medidas[1],
        nome: tipo === 'capa' ? nome : null,
        etiqueta: tipo === 'capa' ? etiqueta : null,
        lado: tipo === 'banner' ? 'esquerda' : 'baixo',
      });
    } catch { /* cai na arte desenhada */ }
  }
  return arteSvg(nome, { largura: medidas[0], altura: medidas[1], indice, etiqueta: etiqueta ?? 'PLAY TECH VIP', comNome: tipo === 'capa' });
}

const guardarArte = (buf, nome) => midia.salvarImagem(db, equipeFalsa, buf, { nome }).id;
const guardarArteDoTitulo = async (nome, opcoes) => guardarArte(await arteDoTitulo(nome, opcoes), `${slug(nome)}-${opcoes.tipo ?? 'capa'}.jpg`);

// ---------------------------------------------------------------- vídeos de demonstração

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'play-tech-vip-seed-'));

/** Gera um clipe com barras de teste, o nome escrito na tela e um tom de áudio. */
function gerarClipe(nome, segundos = 15) {
  const destino = path.join(pasta, `${slug(nome)}.mp4`);
  const texto = nome.replace(/[':\\]/g, ' ');
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=25:duration=${segundos}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${segundos}`,
    '-vf', `drawtext=text='${texto}':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=18`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', destino], { stdio: ['ignore', 'ignore', 'pipe'] });
  return destino;
}

/** Entra no acervo pelo mesmo caminho do painel: abre o envio, manda os pedaços e conclui. */
function guardarVideo(arquivo, { duracao, nome, largura = null, altura = null }) {
  const conteudo = fs.readFileSync(arquivo);
  const medida = largura && altura ? { largura, altura } : medirVideo(arquivo);
  const m = midia.abrirEnvioVideo(db, equipeFalsa, { nome, tamanho: conteudo.length, duracao_s: duracao,
    largura: medida.largura ?? 1280, altura: medida.altura ?? 720 });
  const pedaco = 512 * 1024;
  for (let off = 0; off < conteudo.length; off += pedaco) midia.receberParte(db, m.id, off, conteudo.subarray(off, Math.min(off + pedaco, conteudo.length)));
  return midia.concluirEnvioVideo(db, m.id, { duracao_s: duracao }).id;
}

// ---------------------------------------------------------------- dados

/** Canais próprios da PLAY TECH VIP, com sinal de demonstração (esses tocam de verdade no exemplo). */
const CANAIS_PROPRIOS = [
  // número, nome, categoria, região, descrição
  [100, 'PLAY Destaques', 'variedades', 'Nacional', 'O canal da casa: o melhor do catálogo PLAY TECH VIP, 24 horas no ar.'],
  [101, 'PLAY Cinema', 'filmes', 'Nacional', 'Um filme por sessão, sem intervalo comercial.'],
];

// Sinais públicos de teste de HLS, só para a demonstração: troque pelo sinal da emissora no painel.
const SINAIS_DEMO = [
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
];

const GRADE = {
  variedades: [['Clipes da Manhã', 120], ['Sessão da Tarde', 120], ['Show da Noite', 90], ['Cinema de Madrugada', 120]],
  aberta: [['Bom Dia Brasil Agora', 120], ['Novela: Rio Acima', 60], ['Sessão da Tarde', 120], ['Telejornal PLAY', 60], ['Novela: Ventos do Sul', 60], ['Show da Noite', 90], ['Cinema de Madrugada', 120]],
  noticias: [['Primeiro Giro', 60], ['PLAY News 10h', 60], ['Bolsa e Mercado', 60], ['Entrevista da Semana', 60], ['Jornal das Seis', 60], ['Mesa Redonda', 60], ['Plantão da Noite', 120]],
  esportes: [['Mesa de Debates', 90], ['Brasileirão: clássico ao vivo', 120], ['Vôlei Superliga', 120], ['Resenha Esportiva', 60], ['Futebol Regional', 120], ['Melhores Momentos', 60]],
  filmes: [['Clássicos: Terra Seca', 120], ['Comédia da Tarde', 120], ['Sessão Nacional', 120], ['Grande Sessão', 150], ['Suspense de Madrugada', 120]],
  infantil: [['Turma do Quintal', 60], ['Aventuras na Mata', 60], ['Hora da História', 60], ['Desenho Animado', 60], ['Clube dos Inventores', 60]],
  documentarios: [['Amazônia Profunda', 60], ['Histórias do Sertão', 60], ['Arquivos Abertos', 60], ['Cidades Invisíveis', 60], ['Grandes Obras', 90]],
  musica: [['Clipes da Manhã', 120], ['Acústico PLAY', 60], ['Festival ao Vivo', 120], ['Samba de Raiz', 60], ['Rock Nacional', 120]],
  local: [['Bom Dia Região', 90], ['Jornal Local 1ª edição', 60], ['Nossa Terra', 60], ['Jornal Local 2ª edição', 60], ['Programa do Interior', 90]],
};

/**
 * Catálogo de demonstração com **filmes de verdade, atuais e em alta resolução**: as produções
 * do Blender Studio (2008–2023), todas em Creative Commons Attribution — uso livre, inclusive
 * comercial, bastando creditar. São animações e VFX coloridos, em Full HD e 4K de verdade.
 *
 * O seed tira o cartaz e o banner de quadros do próprio filme e guarda um trecho para tocar,
 * em todas as qualidades. Na operação, o catálogo definitivo entra pelo painel.
 *
 * [nome em português, título original, ano, classificação, sinopse, gêneros, direção, elenco/estúdio,
 *  duração real, item no archive.org, arquivo, altura do original]
 */
const FILMES_REAIS = [
  { nome: 'Charge', original: 'Charge', ano: 2022, classificacao: 12, pais: 'Holanda', original_play: 1,
    sinopse: 'Numa guerra entre fortalezas voadoras, um esquadrão de robôs recebe a ordem de carregar o canhão principal — e descobre o preço de obedecer. Curta de animação em 4K.',
    generos: ['Ficção científica', 'Ação'], direcao: 'Blender Studio', elenco: 'Blender Studio · Amsterdã',
    duracao: 240, item: 'charge-blender-open-movie-1608p', arquivo: 'Charge - Blender Open Movie 1608p.mp4', altura: 1608 },
  { nome: 'Wing It!', original: 'Wing It!', ano: 2023, classificacao: 10, pais: 'Holanda', original_play: 1,
    sinopse: 'Uma piloto atrapalhada e um copiloto irritado tentam pousar uma nave que está caindo aos pedaços. Comédia de animação, em Full HD.',
    generos: ['Comédia', 'Aventura'], direcao: 'Blender Studio', elenco: 'Blender Studio · Amsterdã',
    duracao: 300, item: 'wing_it', arquivo: 'wing_it.ia.mp4', altura: 1080 },
  { nome: 'Sprite Fright', original: 'Sprite Fright', ano: 2021, classificacao: 14, pais: 'Holanda', original_play: 0,
    sinopse: 'Um grupo de adolescentes acampa numa floresta proibida e descobre, do pior jeito possível, que as criaturinhas que vivem ali não gostam de visita. Terror e comédia na mesma dose.',
    generos: ['Terror', 'Comédia'], direcao: 'Matthew Luhn e Hjalti Hjálmarsson', elenco: 'Blender Studio · Amsterdã',
    duracao: 630, item: 'sprite-fright-2021', arquivo: 'Sprite Fright (2021).mkv', altura: 858 },
  { nome: 'Spring', original: 'Spring', ano: 2019, classificacao: 10, pais: 'Holanda', original_play: 0,
    sinopse: 'A guardiã da montanha e seu cão enfrentam o inverno que não quer ir embora, para que a primavera volte ao vale. Animação desenhada e pintada quadro a quadro.',
    generos: ['Fantasia', 'Drama'], direcao: 'Andy Goralczyk', elenco: 'Blender Studio · Amsterdã',
    duracao: 470, item: 'spring_blenderopenmovie', arquivo: 'Spring - Blender Open Movie - YouTube.mkv', altura: 858 },
  { nome: 'Hero', original: 'Hero', ano: 2018, classificacao: 10, pais: 'Holanda', original_play: 0,
    sinopse: 'Uma heroína de rua encara o próprio passado num duelo desenhado à mão dentro do espaço 3D. Um marco técnico da animação.',
    generos: ['Ação', 'Fantasia'], direcao: 'Daniel Martinez Lara', elenco: 'Blender Studio · Amsterdã',
    duracao: 240, item: 'hero_20260106', arquivo: 'hero.ia.mp4', altura: 858 },
  { nome: 'Agente 327: Operação Barbearia', original: 'Agent 327: Operation Barbershop', ano: 2017, classificacao: 12, pais: 'Holanda', original_play: 1,
    sinopse: 'O espião holandês mais azarado do mundo cai numa emboscada dentro de uma barbearia — e sai dela do jeito mais improvável. Ação e humor em 4K.',
    generos: ['Ação', 'Comédia'], direcao: 'Colin Levy', elenco: 'Blender Studio · Amsterdã',
    duracao: 230, item: 'agent327operationbarbershop', arquivo: 'agent327.mkv', altura: 1610 },
  { nome: 'Cosmos Laundromat', original: 'Cosmos Laundromat: First Cycle', ano: 2015, classificacao: 14, pais: 'Holanda', original_play: 0,
    sinopse: 'Numa ilha deserta, uma ovelha suicida encontra um vendedor excêntrico que oferece vidas alternativas — e cada escolha sai mais cara que a anterior.',
    generos: ['Fantasia', 'Drama'], direcao: 'Mathieu Auvray', elenco: 'Blender Studio · Amsterdã',
    duracao: 730, item: 'CosmosLaundromatFirstCycle', arquivo: 'Cosmos Laundromat - First Cycle (1080p).mp4', altura: 804 },
  { nome: 'Meio Copo', original: 'Glass Half', ano: 2015, classificacao: 0, pais: 'Holanda', original_play: 0,
    sinopse: 'Num museu, uma discussão sobre um vaso grego vira guerra de egos entre críticos de arte. Comédia curta e certeira.',
    generos: ['Comédia', 'Infantil'], direcao: 'Beorn Leonard', elenco: 'Blender Studio · Amsterdã',
    duracao: 180, item: 'GlassHalf1080p', arquivo: 'Glass Half-1080p.mp4', altura: 1080 },
];

/** Séries de verdade: cada episódio é um item no Internet Archive, em Full HD. */
const SERIES_REAIS = [
  {
    nome: 'Caminandes',
    original: 'Caminandes',
    ano: 2016,
    classificacao: 0,
    pais: 'Holanda',
    sinopse: 'Koro, uma lhama teimosa da Patagônia, quer só atravessar a estrada, comer em paz e sobreviver ao inverno — e o mundo inteiro parece conspirar contra. Três episódios de pura comédia animada.',
    generos: ['Infantil', 'Comédia', 'Aventura'],
    direcao: 'Pablo Vazquez',
    elenco: 'Blender Studio · Amsterdã',
    episodios: [
      { nome: 'Drama de Lhama', item: 'Caminandes1LlamaDrama', arquivo: '01_llama_drama_1080p.mp4', duracao: 90,
        sinopse: 'Koro descobre que atravessar uma estrada na Patagônia é mais difícil do que parece.' },
      { nome: 'Grande Dilema', item: 'Caminandes2GranDillama', arquivo: '02_gran_dillama_1080p.mp4', duracao: 150,
        sinopse: 'Do outro lado da cerca o capim é mais verde — e tem muito mais espinho do que Koro imaginava.' },
      { nome: 'Llamigos', item: 'CaminandesLlamigos', arquivo: 'Caminandes_ Llamigos-1080p.mp4', duracao: 150,
        sinopse: 'No inverno, Koro e um pinguim disputam a última fruta da planície — e aprendem a dividir.' },
    ],
  },
];

const FILMES = [
  // Reservaconst FILMES = [
  // Reserva: usado quando não há internet para buscar os filmes reais.
  // nome, ano, classificação, sinopse, gêneros, original
  ['A Noite do Sertão', 2026, 12, 'Um caminhoneiro atravessa o sertão levando uma carga que pode mudar o destino de uma cidade inteira.', ['Drama', 'Suspense'], true],
  ['Capital Sul', 2025, 14, 'Dois irmãos disputam a herança de uma construtora em meio a uma investigação federal.', ['Drama'], true],
  ['Último Trem para Olinda', 2024, 10, 'Uma comédia de enganos a bordo do último trem de uma linha que vai ser desativada.', ['Comédia', 'Romance'], false],
  ['Maré Alta', 2026, 16, 'Pescadores descobrem um segredo afundado na baía e precisam decidir o que fazer com ele.', ['Suspense', 'Ação'], true],
  ['O Vale dos Inventores', 2025, 0, 'Três crianças constroem uma máquina para salvar a feira de ciências da escola.', ['Infantil', 'Aventura'], false],
  ['Samba no Asfalto', 2023, 12, 'A história da ala de uma escola de samba que decidiu levar o bairro inteiro para a avenida.', ['Documentário'], false],
  ['Linha de Frente', 2026, 18, 'Repórteres cobrem uma operação policial que sai do controle em uma noite de chuva.', ['Ação', 'Drama'], true],
  ['Serra da Garoa', 2025, 14, 'Uma delegada volta à cidade natal para investigar um desaparecimento de trinta anos atrás.', ['Suspense', 'Drama'], true],
  ['Praia Grande', 2024, 12, 'Quatro amigos se reencontram no verão em que tudo mudou para a cidade litorânea.', ['Drama', 'Romance'], false],
  ['Carnaval Fora de Época', 2026, 10, 'Uma banda de interior tenta emplacar o hit do ano a três dias do desfile.', ['Comédia'], false],
  ['Pantanal Secreto', 2025, 0, 'Uma expedição filma onças, ariranhas e tuiuiús num ano de cheia histórica.', ['Documentário', 'Aventura'], true],
  ['Noite de São João', 2024, 12, 'Numa quadrilha junina, dois rivais descobrem que disputam mais do que a fogueira.', ['Romance', 'Comédia'], false],
  ['O Último Ônibus', 2026, 16, 'O motorista da última linha da madrugada carrega passageiros com segredos demais.', ['Suspense'], true],
  ['Cerrado em Chamas', 2025, 14, 'Brigadistas enfrentam a maior queimada da região enquanto a fazenda vizinha some de vista.', ['Ação', 'Drama'], false],
  ['Minha Rua, Meu Time', 2024, 0, 'A várzea paulistana ganha um torneio e um bairro inteiro entra em campo.', ['Esportes', 'Documentário'], false],
  ['Hotel Beira-Mar', 2026, 14, 'Uma herdeira reabre o hotel da família e descobre por que ele fechou.', ['Drama', 'Suspense'], true],
];

const SERIES = [
  // nome, ano, classificação, sinopse, gêneros, original, temporadas
  ['Capital Norte', 2026, 14, 'Uma procuradora recém-chegada a Belém enfrenta um esquema que envolve o porto e a prefeitura.', ['Drama', 'Suspense'], true,
    [['Temporada 1', ['O porto', 'A procuradora', 'Primeira audiência', 'Noite de cheia', 'O depoimento', 'Sentença']],
      ['Temporada 2', ['Volta ao porto', 'Novo promotor', 'A testemunha', 'Marés']]]],
  ['Cozinha de Bairro', 2025, 0, 'Cozinheiros de bairro apresentam a receita que criaram para alimentar a vizinhança.', ['Variedades'], true,
    [['Temporada 1', ['Feijoada de domingo', 'Peixe na folha', 'Pão da esquina', 'Doce de tacho', 'Café da feira']]]],
  ['Plantão 24h', 2026, 16, 'A rotina de um pronto-socorro público em uma cidade que não para.', ['Drama'], false,
    [['Temporada 1', ['Turno da noite', 'Sala vermelha', 'Ambulância 7', 'Troca de plantão']]]],
  ['Mata Adentro', 2024, 10, 'Uma expedição documenta espécies que ninguém havia filmado antes.', ['Documentário', 'Aventura'], false,
    [['Temporada 1', ['Rio acima', 'O topo da árvore', 'Chuva na mata', 'De volta']]]],
  ['Clube da Esquina', 2026, 12, 'Cinco músicos dividem o mesmo apartamento e o mesmo sonho em Belo Horizonte.', ['Drama', 'Romance'], true,
    [['Temporada 1', ['Primeiro ensaio', 'Palco pequeno', 'A demo', 'Turnê de ônibus', 'O contrato']]]],
  ['Fronteira Seca', 2025, 16, 'Uma policial federal e um contrabandista se enfrentam na tríplice fronteira.', ['Ação', 'Suspense'], true,
    [['Temporada 1', ['A travessia', 'Posto 12', 'O informante', 'Caminho fechado', 'Última carga']]]],
];

const ELENCO = [
  'Ana Clara Ribeiro, Marcos Veloso, Tereza Lins',
  'João Bastos, Helena Prado, Rui Camargo',
  'Débora Nunes, Caio Serrano, Lúcia Amaral',
  'Fernando Tavares, Bia Rocha, Otávio Mendes',
  'Sandra Vilela, Pedro Arruda, Clara Monteiro',
  'Rafael Duarte, Juliana Peixoto, Nelson Braga',
];
const DIRECAO = ['Marina Siqueira', 'Jorge Albuquerque', 'Letícia Franco', 'Paulo Vasconcelos', 'Renata Khoury'];

const ASSINANTES = [
  ['Marina Costa', 'marina@exemplo.com.br', '11988880001', 2, 'ativa'],
  ['Rogério Lima', 'rogerio@exemplo.com.br', '21988880002', 3, 'ativa'],
  ['Família Andrade', 'andrade@exemplo.com.br', '31988880003', 1, 'suspensa'],
  ['Juliana Prado', 'juliana@exemplo.com.br', '85988880004', 2, 'pendente'],
];

// ---------------------------------------------------------------- execução

async function gerar() {
console.log(`[${config.marca}] Gerando dados de demonstração…`);
if (!temFfmpeg) console.warn('  · ffmpeg não encontrado: o catálogo entra como rascunho (sem vídeo). Envie os vídeos pelo painel.');

// Limpa o que o seed cria (mantém a conta de administrador e as configurações).
transacao(db, () => {
  for (const t of ['sessoes_player', 'progresso', 'favoritos', 'perfis', 'faturas', 'assinaturas', 'destaques', 'fileira_itens',
    'legendas', 'episodios', 'temporadas', 'titulo_generos', 'titulos', 'programas', 'canais', 'midias']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM usuarios WHERE perfil = 'assinante' OR email LIKE '%@playtechvip.com.br' AND perfil = 'curador'").run();
});
fs.rmSync(config.midiaDir, { recursive: true, force: true });

gravarConfig(db, {
  pix_chave: 'pix@playtechvip.com.br',
  pix_recebedor: 'PLAY TECH VIP LTDA',
  pix_cidade: 'SAO PAULO',
  aviso_home: '',
});

// Equipe
const curador = db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, 'curador', ?)")
  .run('Curadoria PLAY', 'curadoria@playtechvip.com.br', hashSenha(SENHA_EQUIPE), agora());
console.log(`  · equipe: admin + curadoria (senha ${SENHA_EQUIPE})`);

// Planos de demonstração alinhados com o que o player oferece hoje (SD, HD, Full HD e 4K).
for (const [slug2, qualidade] of [['essencial', 'hd'], ['familia', 'fullhd'], ['cinema', '4k']]) {
  db.prepare('UPDATE planos SET qualidade = ? WHERE slug = ?').run(qualidade, slug2);
}
void curador;

// Canais: a TV aberta inteira já cadastrada (desligada, esperando o sinal) + os canais da casa.
const canaisCriados = [];
const inserirCanal = db.prepare(`INSERT INTO canais (numero, nome, slug, descricao, categoria, fonte, url_hls, observacao, relay, logo_midia_id,
    classificacao, regiao, ordem, ativo, criado_em, atualizado_em)
  VALUES (?, ?, ?, ?, ?, 'hls', ?, ?, 1, ?, 0, ?, ?, ?, ?, ?)`);

CANAIS_ABERTOS.forEach(([numero, nome, categoria, grupo, observacao], i) => {
  const logo = guardarArte(logoSvg(nome, i), `logo-${slug(nome)}.svg`);
  // Sem endereço de sinal e desligado: entra no ar quando a operação cadastrar o sinal.
  inserirCanal.run(numero, nome, slug(nome), grupo, categoria, null, observacao, logo, 'Nacional', numero, 0, agora(), agora());
});

CANAIS_PROPRIOS.forEach(([numero, nome, categoria, regiao, descricao], i) => {
  const logo = guardarArte(logoSvg(nome, i + 9), `logo-${slug(nome)}.svg`);
  const r = inserirCanal.run(numero, nome, slug(nome), descricao, categoria, SINAIS_DEMO[i % SINAIS_DEMO.length],
    'Canal próprio da PLAY TECH VIP (sinal de demonstração).', logo, regiao, numero, 1, agora(), agora());
  canaisCriados.push({ id: Number(r.lastInsertRowid), numero, nome, categoria });
});

// Grade de 3 dias: ontem, hoje e amanhã, começando às 6h locais.
const inserirPrograma = db.prepare(`INSERT OR IGNORE INTO programas (canal_id, titulo, subtitulo, descricao, inicio, fim, categoria, classificacao, ao_vivo, criado_em)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
let programas = 0;
for (const c of canaisCriados) {
  const modelo = GRADE[c.categoria] ?? GRADE.aberta;
  for (const d of [-1, 0, 1]) {
    let inicio = new Date(`${somarDias(hoje(), d)}T06:00:00-03:00`).getTime();
    let i = 0;
    while (inicio < new Date(`${somarDias(hoje(), d + 1)}T06:00:00-03:00`).getTime()) {
      const [nome, minutos] = modelo[i % modelo.length];
      const fim = inicio + minutos * 60_000;
      inserirPrograma.run(c.id, nome, null, `${nome} no ${c.nome}.`, new Date(inicio).toISOString(), new Date(fim).toISOString(),
        c.categoria, c.categoria === 'infantil' ? 0 : [0, 0, 10, 12][i % 4], /ao vivo|jornal|plantão/i.test(nome) ? 1 : 0, agora());
      programas += 1;
      inicio = fim;
      i += 1;
    }
  }
}
console.log(`  · ${CANAIS_ABERTOS.length} canais de TV aberta cadastrados (desligados, aguardando o sinal de cada emissora)`);
console.log(`  · ${canaisCriados.length} canais próprios no ar, com ${programas} programas na grade (ontem, hoje e amanhã)`);

// Vídeos de demonstração (reaproveitados pelo catálogo)
let videos = [];
if (temFfmpeg) {
  videos = ['Demonstração PLAY TECH VIP', 'Episódio de demonstração', 'Trailer de demonstração'].map((nome, i) => {
    const arquivo = gerarClipe(nome, i === 2 ? 8 : 15);
    return guardarVideo(arquivo, { duracao: i === 2 ? 8 : 15, nome: `${slug(nome)}.mp4` });
  });
  console.log(`  · ${videos.length} vídeos de demonstração gerados com ffmpeg`);
}
const [videoFilme, videoEpisodio, videoTrailer] = videos;

const generoId = (nome) => db.prepare('SELECT id FROM generos WHERE nome = ?').get(nome)?.id;
const ligarGeneros = (tituloId, nomes) => {
  const ins = db.prepare('INSERT OR IGNORE INTO titulo_generos (titulo_id, genero_id) VALUES (?, ?)');
  for (const n of nomes) { const g = generoId(n); if (g) ins.run(tituloId, g); }
};

const situacao = temFfmpeg ? 'publicado' : 'rascunho';
const titulos = [];

/** O acervo de filmes está ao alcance? */
async function archiveResponde() {
  try {
    const r = await fetch('https://archive.org/metadata/Detour', { signal: AbortSignal.timeout(15_000) });
    return r.ok;
  } catch {
    return false;
  }
}

const TRECHO_S = Number(process.env.SEED_TRECHO_S) || 120;
// Para testar rápido: SEED_LIMITE_FILMES=2 npm run seed
const LIMITE_FILMES = Number(process.env.SEED_LIMITE_FILMES) || 0;
const comFilmesReais = temFfmpeg && await archiveResponde();

if (comFilmesReais) {
  console.log(`  · montando o catálogo com ${LIMITE_FILMES || FILMES_REAIS.length} filmes de verdade (domínio público, do Internet Archive)…`);
  for (const [i, f] of (LIMITE_FILMES ? FILMES_REAIS.slice(0, LIMITE_FILMES) : FILMES_REAIS).entries()) {
    const url = urlArchive(f.item, f.arquivo);
    // Cartaz e banner saem de quadros do próprio filme, em pontos espalhados pela projeção
    // (cada cópia tem uma duração: a restauração de um clássico costuma ser mais longa).
    const duracaoCopia = duracaoRemota(url) ?? f.duracao;
    const em = (...fracoes) => fracoes.map((x) => Math.round(duracaoCopia * x));
    // Fica na primeira metade: o fim da cópia costuma ser crédito e bastidor, não filme.
    const quadroCartaz = melhorQuadro(url, em(0.12, 0.26, 0.4, 0.52));
    const quadroBanner = melhorQuadro(url, em(0.2, 0.33, 0.46, 0.6));
    const capa = quadroCartaz
      ? guardarArte(tratarFoto(quadroCartaz, { largura: 800, altura: 1200, nome: f.nome, etiqueta: `${f.ano} · clássico`, lado: 'baixo' }), `capa-${slug(f.nome)}.jpg`)
      : await guardarArteDoTitulo(f.nome, { tipo: 'capa', indice: i, semente: slug(f.nome) });
    const banner = quadroBanner
      ? guardarArte(tratarFoto(quadroBanner, { largura: 1920, altura: 1080, lado: 'esquerda' }), `banner-${slug(f.nome)}.jpg`)
      : await guardarArteDoTitulo(f.nome, { tipo: 'banner', indice: i, semente: `${slug(f.nome)}-b` });

    // Trecho real do filme, para o player ter o que tocar: a cópia do original é a melhor
    // versão (4K ou Full HD, conforme a cópia), e dela saem os degraus menores.
    const arquivoTrecho = trechoDoFilme(url, Math.round(duracaoCopia * 0.5), TRECHO_S);
    const medida = arquivoTrecho ? medirVideo(arquivoTrecho) : { largura: null, altura: null };
    const video = arquivoTrecho
      ? guardarVideo(arquivoTrecho, { duracao: TRECHO_S, nome: `${slug(f.nome)}.mp4`, largura: medida.largura, altura: medida.altura })
      : videoFilme ?? null;
    const menores = arquivoTrecho ? versoesMenores(arquivoTrecho, medida.altura ?? f.altura ?? 0, medida.largura ?? 0) : [];
    const midiasMenores = menores.map((m2) => {
      const id2 = guardarVideo(m2.arquivo, { duracao: TRECHO_S, nome: `${slug(f.nome)}-${m2.qualidade}.mp4` });
      fs.rmSync(m2.arquivo, { force: true });
      return { qualidade: m2.qualidade, midiaId: id2 };
    });
    if (arquivoTrecho) fs.rmSync(arquivoTrecho, { force: true });

    const r = db.prepare(`INSERT INTO titulos (tipo, nome, slug, nome_original, sinopse, ano, pais, classificacao, duracao_s, elenco, direcao, situacao,
        capa_midia_id, banner_midia_id, trailer_midia_id, video_midia_id, original, publicado_em, criado_em, atualizado_em)
      VALUES ('filme', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      // A ficha mostra a duração real do filme; o arquivo guardado é um trecho de demonstração.
      .run(f.nome, slug(f.nome), f.original, f.sinopse, f.ano, f.pais ?? 'Holanda', f.classificacao, video ? f.duracao : null,
        f.elenco, f.direcao, video ? 'publicado' : 'rascunho', capa, banner, videoTrailer ?? null, video, f.original_play ?? 0,
        video ? new Date(Date.now() - (i + 1) * 86_400_000).toISOString() : null, agora(), agora());
    const id = Number(r.lastInsertRowid);
    ligarGeneros(id, f.generos);
    // O menu de qualidade do player sai daqui: a versão principal mais os degraus menores.
    const qualidadePrincipal = qualidades.porMedidas(medida.largura ?? 0, medida.altura ?? f.altura ?? 0);
    if (video && qualidadePrincipal) versoes.registrar(db, { tituloId: id, midiaId: video, qualidade: qualidadePrincipal });
    for (const m2 of midiasMenores) versoes.registrar(db, { tituloId: id, midiaId: m2.midiaId, qualidade: m2.qualidade });
    titulos.push({ id, nome: f.nome, tipo: 'filme' });
    const escada = [qualidadePrincipal, ...midiasMenores.map((m2) => m2.qualidade)].filter(Boolean).map((q) => qualidades.rotulo(q)).join(', ');
    process.stdout.write(`    ${i + 1}/${LIMITE_FILMES || FILMES_REAIS.length} ${f.nome}${video ? ` — ${escada}` : ' (sem vídeo)'}\n`);
  }
} else {
  console.log('  · sem acesso ao acervo de filmes: montando um catálogo de demonstração com artes locais…');
  for (const [i, [nome, ano, classificacao, sinopse, generos, original]] of FILMES.entries()) {
    const capa = await guardarArteDoTitulo(nome, { tipo: 'capa', indice: i, semente: `${slug(nome)}-capa`, etiqueta: original ? 'Original PLAY' : null });
    const banner = await guardarArteDoTitulo(nome, { tipo: 'banner', indice: i, semente: `${slug(nome)}-banner` });
    const duracaoFilme = temFfmpeg ? 15 : 5400 + i * 300;
    const r = db.prepare(`INSERT INTO titulos (tipo, nome, slug, sinopse, ano, pais, classificacao, duracao_s, elenco, direcao, situacao,
        capa_midia_id, banner_midia_id, trailer_midia_id, video_midia_id, original, publicado_em, criado_em, atualizado_em)
      VALUES ('filme', ?, ?, ?, ?, 'Brasil', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(nome, slug(nome), sinopse, ano, classificacao, duracaoFilme, ELENCO[i % ELENCO.length], DIRECAO[i % DIRECAO.length], situacao,
        capa, banner, videoTrailer ?? null, videoFilme ?? null, original ? 1 : 0,
        situacao === 'publicado' ? new Date(Date.now() - (i + 1) * 86_400_000).toISOString() : null, agora(), agora());
    const id = Number(r.lastInsertRowid);
    ligarGeneros(id, generos);
    titulos.push({ id, nome, tipo: 'filme' });
  }
}

if (comFilmesReais) {
  // Seriados de verdade: cada capítulo tem trecho e miniatura tirados do próprio episódio.
  for (const serie of SERIES_REAIS) {
    console.log(`  · montando a série "${serie.nome}" com ${serie.episodios.length} episódios de verdade…`);
    const urlDoEpisodio = (ep) => urlArchive(ep.item, ep.arquivo);

    // Capa e banner da série saem de quadros do primeiro episódio.
    const urlPrimeiro = urlDoEpisodio(serie.episodios[0]);
    const duracaoPrimeiro = duracaoRemota(urlPrimeiro) ?? serie.episodios[0].duracao;
    const emEp = (...fracoes) => fracoes.map((x) => Math.round(duracaoPrimeiro * x));
    const quadroCapa = melhorQuadro(urlPrimeiro, emEp(0.15, 0.3, 0.45, 0.58));
    const quadroBanner = melhorQuadro(urlPrimeiro, emEp(0.22, 0.36, 0.5, 0.62));
    const capa = quadroCapa
      ? guardarArte(tratarFoto(quadroCapa, { largura: 800, altura: 1200, nome: serie.nome, etiqueta: `${serie.ano} · série`, lado: 'baixo' }), `capa-${slug(serie.nome)}.jpg`)
      : await guardarArteDoTitulo(serie.nome, { tipo: 'capa', indice: 0, semente: slug(serie.nome) });
    const banner = quadroBanner
      ? guardarArte(tratarFoto(quadroBanner, { largura: 1920, altura: 1080, lado: 'esquerda' }), `banner-${slug(serie.nome)}.jpg`)
      : await guardarArteDoTitulo(serie.nome, { tipo: 'banner', indice: 0, semente: `${slug(serie.nome)}-b` });

    const rs = db.prepare(`INSERT INTO titulos (tipo, nome, slug, nome_original, sinopse, ano, pais, classificacao, elenco, direcao, situacao,
        capa_midia_id, banner_midia_id, original, publicado_em, criado_em, atualizado_em)
      VALUES ('serie', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'publicado', ?, ?, 0, ?, ?, ?)`)
      .run(serie.nome, slug(serie.nome), serie.original, serie.sinopse, serie.ano, serie.pais ?? 'Holanda', serie.classificacao,
        serie.elenco, serie.direcao, capa, banner, new Date(Date.now() - 3 * 86_400_000).toISOString(), agora(), agora());
    const serieId = Number(rs.lastInsertRowid);
    ligarGeneros(serieId, serie.generos);
    const tr = db.prepare('INSERT INTO temporadas (titulo_id, numero, nome, ano) VALUES (?, 1, ?, ?)').run(serieId, 'Temporada 1', serie.ano);
    const temporadaId = Number(tr.lastInsertRowid);

    for (const [e, ep] of serie.episodios.entries()) {
      let video = null;
      let thumb = null;
      let midiasMenoresEp = [];
      let alturaEp = null;
      let larguraEp = null;
      const url = urlDoEpisodio(ep);
      const duracaoEp = duracaoRemota(url) ?? ep.duracao;
      const quadro = melhorQuadro(url, [Math.round(duracaoEp * 0.25), Math.round(duracaoEp * 0.45)]);
      if (quadro) thumb = guardarArte(tratarFoto(quadro, { largura: 854, altura: 480, lado: 'esquerda' }), `thumb-${slug(serie.nome)}-${e + 1}.jpg`);
      // Episódios curtos entram inteiros; os longos, num trecho.
      const duracaoTrecho = Math.min(TRECHO_S, duracaoEp);
      const trecho = trechoDoFilme(url, duracaoEp > TRECHO_S ? Math.round(duracaoEp * 0.3) : 0, duracaoTrecho);
      if (trecho) {
        const medidaEp = medirVideo(trecho);
        alturaEp = medidaEp.altura;
        larguraEp = medidaEp.largura;
        video = guardarVideo(trecho, { duracao: duracaoTrecho, nome: `${slug(serie.nome)}-ep${e + 1}.mp4`, largura: medidaEp.largura, altura: medidaEp.altura });
        midiasMenoresEp = versoesMenores(trecho, medidaEp.altura ?? 0, medidaEp.largura ?? 0).map((m2) => {
          const id2 = guardarVideo(m2.arquivo, { duracao: duracaoTrecho, nome: `${slug(serie.nome)}-ep${e + 1}-${m2.qualidade}.mp4` });
          fs.rmSync(m2.arquivo, { force: true });
          return { qualidade: m2.qualidade, midiaId: id2 };
        });
        fs.rmSync(trecho, { force: true });
      }
      const re = db.prepare(`INSERT INTO episodios (titulo_id, temporada_id, numero, nome, sinopse, duracao_s, video_midia_id, thumb_midia_id, situacao, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(serieId, temporadaId, e + 1, ep.nome,
        ep.sinopse, ep.duracao, video, thumb, video ? 'publicado' : 'rascunho', agora());
      const episodioId = Number(re.lastInsertRowid);
      const qEp = qualidades.porMedidas(larguraEp ?? 0, alturaEp ?? 0);
      if (video && qEp) versoes.registrar(db, { episodioId, midiaId: video, qualidade: qEp });
      for (const m2 of midiasMenoresEp) versoes.registrar(db, { episodioId, midiaId: m2.midiaId, qualidade: m2.qualidade });
    }
    titulos.push({ id: serieId, nome: serie.nome, tipo: 'serie' });
  }
}

// Séries de demonstração próprias: só quando não dá para buscar as séries de verdade.
if (!comFilmesReais) for (const [i, [nome, ano, classificacao, sinopse, generos, original, temporadas]] of SERIES.entries()) {
  const indice = i + FILMES.length;
  const capa = await guardarArteDoTitulo(nome, { tipo: 'capa', indice, semente: `${slug(nome)}-capa`, etiqueta: original ? 'Original PLAY' : null });
  const banner = await guardarArteDoTitulo(nome, { tipo: 'banner', indice, semente: `${slug(nome)}-banner` });
  const r = db.prepare(`INSERT INTO titulos (tipo, nome, slug, sinopse, ano, pais, classificacao, elenco, direcao, situacao,
      capa_midia_id, banner_midia_id, trailer_midia_id, original, publicado_em, criado_em, atualizado_em)
    VALUES ('serie', ?, ?, ?, ?, 'Brasil', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nome, slug(nome), sinopse, ano, classificacao, ELENCO[indice % ELENCO.length], DIRECAO[indice % DIRECAO.length], situacao,
      capa, banner, videoTrailer ?? null, original ? 1 : 0,
      situacao === 'publicado' ? new Date(Date.now() - (i + 1) * 43_200_000).toISOString() : null, agora(), agora());
  const tituloId = Number(r.lastInsertRowid);
  ligarGeneros(tituloId, generos);
  for (const [t, [nomeTemporada, episodios]] of temporadas.entries()) {
    const tr = db.prepare('INSERT INTO temporadas (titulo_id, numero, nome, ano) VALUES (?, ?, ?, ?)').run(tituloId, t + 1, nomeTemporada, ano + t);
    const temporadaId = Number(tr.lastInsertRowid);
    for (const [e, nomeEp] of episodios.entries()) {
      const thumb = await guardarArteDoTitulo(nomeEp, { tipo: 'thumb', indice: indice + e, semente: `${slug(nome)}-t${t + 1}e${e + 1}` });
      db.prepare(`INSERT INTO episodios (titulo_id, temporada_id, numero, nome, sinopse, duracao_s, video_midia_id, thumb_midia_id, situacao, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tituloId, temporadaId, e + 1, nomeEp, `${nomeEp} — episódio de demonstração.`,
        temFfmpeg ? 15 : 2700, videoEpisodio ?? null, thumb, temFfmpeg ? 'publicado' : 'rascunho', agora());
    }
  }
  titulos.push({ id: tituloId, nome, tipo: 'serie' });
}
console.log(`  · catálogo: ${comFilmesReais
  ? `${LIMITE_FILMES || FILMES_REAIS.length} filmes e ${SERIES_REAIS.length} série(s) de verdade, em Creative Commons (Blender Studio), coloridos e em alta resolução`
  : `${FILMES.length} filmes e ${SERIES.length} séries de demonstração`}`);

// Destaques e uma fileira de gênero
const destaque = db.prepare('INSERT INTO destaques (titulo_id, canal_id, chamada, descricao, arte_midia_id, ordem, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
const publicadosParaDestaque = db.prepare(`SELECT id, nome, tipo, original, sinopse, banner_midia_id AS banner
  FROM titulos WHERE situacao = 'publicado' ORDER BY tipo, id`).all();
const filmeDestaque = publicadosParaDestaque.find((t) => t.tipo === 'filme') ?? publicadosParaDestaque[0];
const serieDestaque = publicadosParaDestaque.find((t) => t.tipo === 'serie') ?? publicadosParaDestaque[1] ?? filmeDestaque;

/** A chamada do destaque fala a verdade sobre o que é aquele título. */
const chamadaDe = (t) => (t.original ? 'Original PLAY TECH VIP' : t.tipo === 'serie' ? 'Série em destaque' : 'Em cartaz agora');

if (filmeDestaque) {
  destaque.run(filmeDestaque.id, null, chamadaDe(filmeDestaque), filmeDestaque.sinopse, filmeDestaque.banner, 1, agora());
}
if (serieDestaque && serieDestaque.id !== filmeDestaque?.id) {
  destaque.run(serieDestaque.id, null, chamadaDe(serieDestaque), serieDestaque.sinopse, serieDestaque.banner, 2, agora());
}
destaque.run(null, canaisCriados[0].id, 'Agora, ao vivo', 'O melhor do catálogo PLAY TECH VIP, 24 horas no ar.', null, 3, agora());

if (!db.prepare("SELECT 1 FROM fileiras WHERE tipo = 'genero'").get()) {
  db.prepare('INSERT INTO fileiras (nome, tipo, genero_id, limite, ordem, ativa, criado_em) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run('Drama brasileiro', 'genero', generoId('Drama'), 20, 7, agora());
}

// Assinantes, perfis, assinaturas e faturas
const planos = db.prepare('SELECT * FROM planos ORDER BY ordem').all();
const assinantesCriados = [];
for (const [nome, email, telefone, planoOrdem, estado] of ASSINANTES) {
  const plano = planos[planoOrdem - 1];
  const u = db.prepare("INSERT INTO usuarios (nome, email, telefone, senha_hash, perfil, criado_em, ultimo_acesso) VALUES (?, ?, ?, ?, 'assinante', ?, ?)")
    .run(nome, email, telefone, hashSenha(SENHA_CLIENTE), new Date(Date.now() - 120 * 86_400_000).toISOString(), agora());
  const usuarioId = Number(u.lastInsertRowid);
  db.prepare('INSERT INTO perfis (usuario_id, nome, principal, criado_em) VALUES (?, ?, 1, ?)').run(usuarioId, nome.split(' ')[0], agora());
  if (plano.perfis_max > 1) {
    db.prepare('INSERT INTO perfis (usuario_id, nome, infantil, classificacao_max, criado_em) VALUES (?, ?, 1, 10, ?)').run(usuarioId, 'Infantil', agora());
  }
  const perfilPrincipal = db.prepare('SELECT id FROM perfis WHERE usuario_id = ? ORDER BY principal DESC LIMIT 1').get(usuarioId).id;

  const inicio = somarMeses(hoje(), -4);
  const status = estado === 'pendente' ? 'pendente' : estado;
  const acessoAte = estado === 'ativa' ? somarDias(hoje(), 12) : estado === 'suspensa' ? somarDias(hoje(), -9) : null;
  const a = db.prepare(`INSERT INTO assinaturas (usuario_id, plano_id, status, inicio, acesso_ate, proxima_cobranca, criada_em, atualizada_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(usuarioId, plano.id, status, status === 'pendente' ? null : inicio, acessoAte,
    estado === 'ativa' ? acessoAte : null, new Date(Date.now() - 120 * 86_400_000).toISOString(), agora());
  const assinaturaId = Number(a.lastInsertRowid);

  // Histórico de faturas: as antigas pagas; a atual conforme a situação.
  const inserirFatura = db.prepare(`INSERT OR IGNORE INTO faturas (assinatura_id, usuario_id, competencia, descricao, valor_centavos, vencimento, status, txid, paga_em, criada_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let m = 4; m >= 1; m -= 1) {
    const venc = somarMeses(hoje(), -m);
    inserirFatura.run(assinaturaId, usuarioId, competencia(venc), `Plano ${plano.nome} · ${competencia(venc)}`, plano.preco_centavos, venc,
      estado === 'pendente' ? 'cancelada' : 'paga', `TVSEED${assinaturaId}${m}`, estado === 'pendente' ? null : `${venc}T10:12:00.000Z`, agora());
  }
  if (estado === 'suspensa') {
    const venc = somarDias(hoje(), -9);
    inserirFatura.run(assinaturaId, usuarioId, competencia(venc), `Plano ${plano.nome} · ${competencia(venc)}`, plano.preco_centavos, venc, 'aberta', `TVSEEDA${assinaturaId}`, null, agora());
  }
  if (estado === 'pendente') {
    inserirFatura.run(assinaturaId, usuarioId, competencia(hoje()), `Plano ${plano.nome} · adesão`, plano.preco_centavos, hoje(), 'aberta', `TVSEEDP${assinaturaId}`, null, agora());
  }
  assinantesCriados.push({ usuarioId, perfilPrincipal, estado, plano });
}
// Preenche o PIX das faturas em aberto.
const { pixDaFatura } = require('./lib/assinaturas');
for (const f of db.prepare("SELECT * FROM faturas WHERE status = 'aberta'").all()) {
  db.prepare('UPDATE faturas SET pix_copia_cola = ? WHERE id = ?').run(pixDaFatura(db, f), f.id);
}
console.log(`  · ${ASSINANTES.length} assinantes com perfis, assinaturas e faturas (senha ${SENHA_CLIENTE})`);

// Audiência dos últimos 30 dias (telas já encerradas) + progresso e favoritos
const publicados = db.prepare("SELECT id, tipo FROM titulos WHERE situacao = 'publicado'").all();
const episodiosPublicados = db.prepare("SELECT id, titulo_id FROM episodios WHERE situacao = 'publicado'").all();
const inserirSessao = db.prepare(`INSERT INTO sessoes_player (usuario_id, perfil_id, tipo, canal_id, titulo_id, episodio_id, dispositivo, segundos, iniciada_em, ultimo_ping, encerrada_em, motivo_fim)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fim')`);
const APARELHOS = ['Android · Chrome', 'iPhone/iPad · Safari', 'Windows · Chrome', 'Mac · Safari', 'Smart TV · Navegador'];
let sessoes = 0;
for (const a of assinantesCriados.filter((x) => x.estado === 'ativa' || x.estado === 'suspensa')) {
  for (let d = 29; d >= 0; d -= 1) {
    const quantas = 1 + ((d * 7 + a.usuarioId) % 3);
    for (let k = 0; k < quantas; k += 1) {
      const horaBase = 19 + ((d + k) % 4);
      const inicio = new Date(`${somarDias(hoje(), -d)}T${String(horaBase).padStart(2, '0')}:${String((k * 17) % 60).padStart(2, '0')}:00-03:00`);
      const aoVivo = (d + k) % 3 === 0;
      const segundos = 600 + ((d * 137 + k * 311) % 4200);
      const canal = canaisCriados[(d + k) % canaisCriados.length];
      const titulo = publicados.length ? publicados[(d + k) % publicados.length] : null;
      const ep = titulo?.tipo === 'serie' ? episodiosPublicados.find((e) => e.titulo_id === titulo.id) : null;
      inserirSessao.run(a.usuarioId, a.perfilPrincipal, aoVivo ? 'canal' : (ep ? 'episodio' : 'filme'),
        aoVivo ? canal.id : null, aoVivo ? null : titulo?.id ?? null, aoVivo ? null : ep?.id ?? null,
        APARELHOS[(d + k) % APARELHOS.length], segundos, inicio.toISOString(), new Date(inicio.getTime() + segundos * 1000).toISOString(),
        new Date(inicio.getTime() + segundos * 1000).toISOString());
      sessoes += 1;
    }
  }
}
if (publicados.length) {
  const inserirProgresso = db.prepare(`INSERT OR IGNORE INTO progresso (perfil_id, titulo_id, episodio_id, segundos, duracao_s, concluido, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const inserirFavorito = db.prepare('INSERT OR IGNORE INTO favoritos (perfil_id, titulo_id, criado_em) VALUES (?, ?, ?)');
  assinantesCriados.forEach((a, i) => {
    const t = publicados[i % publicados.length];
    const ep = t.tipo === 'serie' ? episodiosPublicados.find((e) => e.titulo_id === t.id) : null;
    const duracaoItem = temFfmpeg ? 15 : 5400;
    inserirProgresso.run(a.perfilPrincipal, t.id, ep?.id ?? 0, Math.round(duracaoItem * 0.4), duracaoItem, 0, agora());
    inserirFavorito.run(a.perfilPrincipal, publicados[(i + 1) % publicados.length].id, agora());
  });
}
console.log(`  · ${sessoes} sessões de audiência nos últimos 30 dias`);

fs.rmSync(pasta, { recursive: true, force: true });

console.log(`  · artes: ${fotosBaixadas} foto(s) tratadas${fotosFalharam ? ` · ${fotosFalharam} sem internet (desenho local)` : ''}`);
fs.rmSync(pastaArtes, { recursive: true, force: true });

console.log(`\n[${config.marca}] Pronto.`);
console.log(`  App do assinante : http://localhost:${config.port}${config.basePath}/`);
console.log(`  Painel           : http://localhost:${config.port}${config.basePath}/admin/`);
console.log(`  Operação         : ${config.admin.email} / ${config.admin.senha}  ·  curadoria@playtechvip.com.br / ${SENHA_EQUIPE}`);
console.log(`  Assinantes       : ${ASSINANTES.map(([, e]) => e).join(', ')} (senha ${SENHA_CLIENTE})`);
if (!temFfmpeg) console.log('  Atenção: sem ffmpeg o catálogo ficou em rascunho. Envie os vídeos no painel (Catálogo) e publique.');
console.log('  TV aberta: Globo, SBT, Record, Band, RedeTV! e os demais já estão cadastrados e DESLIGADOS.');
console.log('  Em Canais, cadastre em cada um o endereço do sinal (.m3u8) que a emissora fornece ou o');
console.log('  endereço do player oficial dela, e ligue o canal. Os dois canais da casa usam sinal de teste.');
}

gerar().catch((err) => {
  console.error(`[${config.marca}] Falha ao gerar os dados:`, err.message);
  process.exitCode = 1;
});
