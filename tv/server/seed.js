'use strict';

/**
 * Dados de demonstração da PLAY TV: canais com grade, catálogo com artes geradas aqui,
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
const { execFileSync } = require('node:child_process');
const config = require('./config');
const { abrir, transacao, agora, slug, gravarConfig } = require('./db');
const { hashSenha } = require('./lib/senha');
const midia = require('./lib/midia');
const { hoje, somarDias, somarMeses, competencia } = require('./lib/datas');
const { CANAIS_ABERTOS } = require('./lib/tv-aberta');

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

// ---------------------------------------------------------------- artes geradas

const CORES = [['#7C2D12', '#FF8A5B'], ['#431407', '#FFC043'], ['#5B1A0B', '#FF4D1C'], ['#78350F', '#FBBF24'],
  ['#3F1D0B', '#F97316'], ['#4C1D0C', '#FDBA74'], ['#601410', '#EF4444'], ['#422006', '#FACC15']];

const escapar = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Cartaz em SVG: gradiente, nome e selo. Serve de arte até a operação enviar a oficial. */
function arteSvg(nome, { largura = 600, altura = 900, etiqueta = 'PLAY TV', indice = 0, comNome = true } = {}) {
  const [a, b] = CORES[indice % CORES.length];
  const palavras = String(nome).split(/\s+/);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    if ((`${atual} ${p}`).trim().length > 14) { linhas.push(atual.trim()); atual = p; } else atual = `${atual} ${p}`;
  }
  if (atual.trim()) linhas.push(atual.trim());
  const base = altura / 2 - (linhas.length - 1) * (altura * 0.045);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${largura} ${altura}" width="${largura}" height="${altura}">
<defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".65"/></linearGradient></defs>
<rect width="${largura}" height="${altura}" fill="url(#f)"/>
<circle cx="${largura * 0.8}" cy="${altura * 0.2}" r="${largura * 0.33}" fill="#fff" fill-opacity=".07"/>
<circle cx="${largura * 0.2}" cy="${altura * 0.78}" r="${largura * 0.42}" fill="#000" fill-opacity=".12"/>
<rect width="${largura}" height="${altura}" fill="url(#s)"/>
<text x="${largura * 0.08}" y="${altura * 0.1}" font-family="Manrope, sans-serif" font-size="${largura * 0.045}" font-weight="800" fill="#fff" fill-opacity=".85" letter-spacing="2">${escapar(etiqueta).toUpperCase()}</text>
${comNome ? linhas.map((l, i) => `<text x="${largura * 0.08}" y="${base + i * altura * 0.09}" font-family="Manrope, sans-serif" font-size="${largura * 0.095}" font-weight="800" fill="#fff">${escapar(l)}</text>`).join('\n') : ''}
</svg>`, 'utf8');
}

/** Logo quadrada do canal. */
const logoSvg = (nome, indice) => {
  const [a, b] = CORES[indice % CORES.length];
  const sigla = nome.split(/\s+/).map((p) => p[0]).join('').slice(0, 3).toUpperCase();
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="200" height="200" rx="34" fill="url(#g)"/>
<text x="100" y="124" text-anchor="middle" font-family="Manrope, sans-serif" font-size="68" font-weight="800" fill="#fff">${escapar(sigla)}</text></svg>`, 'utf8');
};

const guardarArte = (buf, nome) => midia.salvarImagem(db, equipeFalsa, buf, { nome }).id;

// ---------------------------------------------------------------- vídeos de demonstração

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'play-tv-seed-'));

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
function guardarVideo(arquivo, { duracao, nome }) {
  const conteudo = fs.readFileSync(arquivo);
  const m = midia.abrirEnvioVideo(db, equipeFalsa, { nome, tamanho: conteudo.length, duracao_s: duracao, largura: 1280, altura: 720 });
  const pedaco = 512 * 1024;
  for (let off = 0; off < conteudo.length; off += pedaco) midia.receberParte(db, m.id, off, conteudo.subarray(off, Math.min(off + pedaco, conteudo.length)));
  return midia.concluirEnvioVideo(db, m.id, { duracao_s: duracao }).id;
}

// ---------------------------------------------------------------- dados

/** Canais próprios da PLAY TV, com sinal de demonstração (esses tocam de verdade no exemplo). */
const CANAIS_PROPRIOS = [
  // número, nome, categoria, região, descrição
  [100, 'PLAY Destaques', 'variedades', 'Nacional', 'O canal da casa: o melhor do catálogo PLAY TV, 24 horas no ar.'],
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

const FILMES = [
  ['A Noite do Sertão', 2026, 12, 'Um caminhoneiro atravessa o sertão levando uma carga que pode mudar o destino de uma cidade inteira.', ['Drama', 'Suspense'], true],
  ['Capital Sul', 2025, 14, 'Dois irmãos disputam a herança de uma construtora em meio a uma investigação federal.', ['Drama'], true],
  ['Último Trem para Olinda', 2024, 10, 'Uma comédia de enganos a bordo do último trem de uma linha que vai ser desativada.', ['Comédia', 'Romance'], false],
  ['Maré Alta', 2026, 16, 'Pescadores descobrem um segredo afundado na baía e precisam decidir o que fazer com ele.', ['Suspense', 'Ação'], true],
  ['O Vale dos Inventores', 2025, 0, 'Três crianças constroem uma máquina para salvar a feira de ciências da escola.', ['Infantil', 'Aventura'], false],
  ['Samba no Asfalto', 2023, 12, 'A história da ala de uma escola de samba que decidiu levar o bairro inteiro para a avenida.', ['Documentário'], false],
  ['Linha de Frente', 2026, 18, 'Repórteres cobrem uma operação policial que sai do controle em uma noite de chuva.', ['Ação', 'Drama'], true],
];

const SERIES = [
  ['Capital Norte', 2026, 14, 'Uma procuradora recém-chegada a Belém enfrenta um esquema que envolve o porto e a prefeitura.', ['Drama', 'Suspense'], true,
    [['Temporada 1', ['O porto', 'A procuradora', 'Primeira audiência', 'Noite de cheia', 'O depoimento', 'Sentença']],
      ['Temporada 2', ['Volta ao porto', 'Novo promotor', 'A testemunha', 'Marés']]]],
  ['Cozinha de Bairro', 2025, 0, 'Cozinheiros de bairro apresentam a receita que criaram para alimentar a vizinhança.', ['Variedades'], true,
    [['Temporada 1', ['Feijoada de domingo', 'Peixe na folha', 'Pão da esquina', 'Doce de tacho', 'Café da feira']]]],
  ['Plantão 24h', 2026, 16, 'A rotina de um pronto-socorro público em uma cidade que não para.', ['Drama'], false,
    [['Temporada 1', ['Turno da noite', 'Sala vermelha', 'Ambulância 7', 'Troca de plantão']]]],
  ['Mata Adentro', 2024, 10, 'Uma expedição documenta espécies que ninguém havia filmado antes.', ['Documentário', 'Aventura'], false,
    [['Temporada 1', ['Rio acima', 'O topo da árvore', 'Chuva na mata', 'De volta']]]],
];

const ASSINANTES = [
  ['Marina Costa', 'marina@exemplo.com.br', '11988880001', 2, 'ativa'],
  ['Rogério Lima', 'rogerio@exemplo.com.br', '21988880002', 3, 'ativa'],
  ['Família Andrade', 'andrade@exemplo.com.br', '31988880003', 1, 'suspensa'],
  ['Juliana Prado', 'juliana@exemplo.com.br', '85988880004', 2, 'pendente'],
];

// ---------------------------------------------------------------- execução

console.log(`[${config.marca}] Gerando dados de demonstração…`);
if (!temFfmpeg) console.warn('  · ffmpeg não encontrado: o catálogo entra como rascunho (sem vídeo). Envie os vídeos pelo painel.');

// Limpa o que o seed cria (mantém a conta de administrador e as configurações).
transacao(db, () => {
  for (const t of ['sessoes_player', 'progresso', 'favoritos', 'perfis', 'faturas', 'assinaturas', 'destaques', 'fileira_itens',
    'legendas', 'episodios', 'temporadas', 'titulo_generos', 'titulos', 'programas', 'canais', 'midias']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM usuarios WHERE perfil = 'assinante' OR email LIKE '%@playtv.com.br' AND perfil = 'curador'").run();
});
fs.rmSync(config.midiaDir, { recursive: true, force: true });

gravarConfig(db, {
  pix_chave: 'pix@playtv.com.br',
  pix_recebedor: 'PLAY TV LTDA',
  pix_cidade: 'SAO PAULO',
  aviso_home: '',
});

// Equipe
const curador = db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, 'curador', ?)")
  .run('Curadoria PLAY', 'curadoria@playtv.com.br', hashSenha(SENHA_EQUIPE), agora());
console.log(`  · equipe: admin + curadoria (senha ${SENHA_EQUIPE})`);
void curador;

// Canais: a TV aberta inteira já cadastrada (desligada, esperando o sinal) + os canais da casa.
const canaisCriados = [];
const inserirCanal = db.prepare(`INSERT INTO canais (numero, nome, slug, descricao, categoria, fonte, url_hls, observacao, relay, logo_midia_id,
    classificacao, regiao, ordem, ativo, criado_em, atualizado_em)
  VALUES (?, ?, ?, ?, ?, 'hls', ?, ?, 1, ?, 0, ?, ?, ?, ?, ?)`);

CANAIS_ABERTOS.forEach(([numero, nome, categoria, grupo, site, observacao], i) => {
  const logo = guardarArte(logoSvg(nome, i), `logo-${slug(nome)}.svg`);
  // Sem endereço de sinal e desligado: entra no ar quando a operação cadastrar o sinal.
  inserirCanal.run(numero, nome, slug(nome), `${grupo} · ${site}`, categoria, null, observacao, logo, 'Nacional', numero, 0, agora(), agora());
});

CANAIS_PROPRIOS.forEach(([numero, nome, categoria, regiao, descricao], i) => {
  const logo = guardarArte(logoSvg(nome, i + 9), `logo-${slug(nome)}.svg`);
  const r = inserirCanal.run(numero, nome, slug(nome), descricao, categoria, SINAIS_DEMO[i % SINAIS_DEMO.length],
    'Canal próprio da PLAY TV (sinal de demonstração).', logo, regiao, numero, 1, agora(), agora());
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
  videos = ['Demonstração PLAY TV', 'Episódio de demonstração', 'Trailer de demonstração'].map((nome, i) => {
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

FILMES.forEach(([nome, ano, classificacao, sinopse, generos, original], i) => {
  const capa = guardarArte(arteSvg(nome, { indice: i, etiqueta: original ? 'Original PLAY' : 'Filme' }), `capa-${slug(nome)}.svg`);
  const banner = guardarArte(arteSvg(nome, { largura: 1600, altura: 900, indice: i, etiqueta: 'PLAY TV', comNome: false }), `banner-${slug(nome)}.svg`);
  const duracaoFilme = temFfmpeg ? 15 : 5400 + i * 300;
  const r = db.prepare(`INSERT INTO titulos (tipo, nome, slug, sinopse, ano, pais, classificacao, duracao_s, elenco, direcao, situacao,
      capa_midia_id, banner_midia_id, trailer_midia_id, video_midia_id, original, publicado_em, criado_em, atualizado_em)
    VALUES ('filme', ?, ?, ?, ?, 'Brasil', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nome, slug(nome), sinopse, ano, classificacao, duracaoFilme, 'Elenco de demonstração', 'Direção de demonstração', situacao,
      capa, banner, videoTrailer ?? null, videoFilme ?? null, original ? 1 : 0,
      situacao === 'publicado' ? new Date(Date.now() - (i + 1) * 86_400_000).toISOString() : null, agora(), agora());
  const id = Number(r.lastInsertRowid);
  ligarGeneros(id, generos);
  titulos.push({ id, nome, tipo: 'filme' });
});

SERIES.forEach(([nome, ano, classificacao, sinopse, generos, original, temporadas], i) => {
  const indice = i + FILMES.length;
  const capa = guardarArte(arteSvg(nome, { indice, etiqueta: original ? 'Original PLAY' : 'Série' }), `capa-${slug(nome)}.svg`);
  const banner = guardarArte(arteSvg(nome, { largura: 1600, altura: 900, indice, etiqueta: 'Série PLAY', comNome: false }), `banner-${slug(nome)}.svg`);
  const r = db.prepare(`INSERT INTO titulos (tipo, nome, slug, sinopse, ano, pais, classificacao, elenco, direcao, situacao,
      capa_midia_id, banner_midia_id, trailer_midia_id, original, publicado_em, criado_em, atualizado_em)
    VALUES ('serie', ?, ?, ?, ?, 'Brasil', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nome, slug(nome), sinopse, ano, classificacao, 'Elenco de demonstração', 'Direção de demonstração', situacao,
      capa, banner, videoTrailer ?? null, original ? 1 : 0,
      situacao === 'publicado' ? new Date(Date.now() - (i + 1) * 43_200_000).toISOString() : null, agora(), agora());
  const tituloId = Number(r.lastInsertRowid);
  ligarGeneros(tituloId, generos);
  temporadas.forEach(([nomeTemporada, episodios], t) => {
    const tr = db.prepare('INSERT INTO temporadas (titulo_id, numero, nome, ano) VALUES (?, ?, ?, ?)').run(tituloId, t + 1, nomeTemporada, ano + t);
    const temporadaId = Number(tr.lastInsertRowid);
    episodios.forEach((nomeEp, e) => {
      const thumb = guardarArte(arteSvg(nomeEp, { largura: 640, altura: 360, indice: indice + e, etiqueta: `T${t + 1} E${e + 1}` }), `thumb-${slug(nomeEp)}.svg`);
      db.prepare(`INSERT INTO episodios (titulo_id, temporada_id, numero, nome, sinopse, duracao_s, video_midia_id, thumb_midia_id, situacao, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tituloId, temporadaId, e + 1, nomeEp, `${nomeEp} — episódio de demonstração.`,
        temFfmpeg ? 15 : 2700, videoEpisodio ?? null, thumb, temFfmpeg ? 'publicado' : 'rascunho', agora());
    });
  });
  titulos.push({ id: tituloId, nome, tipo: 'serie' });
});
console.log(`  · catálogo: ${FILMES.length} filmes e ${SERIES.length} séries (${situacao})`);

// Destaques e uma fileira de gênero
const destaque = db.prepare('INSERT INTO destaques (titulo_id, canal_id, chamada, descricao, arte_midia_id, ordem, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
const porNome = (nome) => titulos.find((t) => t.nome === nome);
destaque.run(porNome('Capital Norte').id, null, 'Original PLAY · 2ª temporada', 'A procuradora volta ao porto — e agora ninguém está a salvo.',
  db.prepare('SELECT banner_midia_id AS b FROM titulos WHERE id = ?').get(porNome('Capital Norte').id).b, 1, agora());
destaque.run(porNome('A Noite do Sertão').id, null, 'Estreia da semana', 'Um caminhoneiro, uma carga e uma cidade inteira esperando.',
  db.prepare('SELECT banner_midia_id AS b FROM titulos WHERE id = ?').get(porNome('A Noite do Sertão').id).b, 2, agora());
destaque.run(null, canaisCriados[0].id, 'Agora, ao vivo', 'O melhor do catálogo PLAY TV, 24 horas no ar.', null, 3, agora());

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

console.log(`\n[${config.marca}] Pronto.`);
console.log(`  App do assinante : http://localhost:${config.port}${config.basePath}/`);
console.log(`  Painel           : http://localhost:${config.port}${config.basePath}/admin/`);
console.log(`  Operação         : ${config.admin.email} / ${config.admin.senha}  ·  curadoria@playtv.com.br / ${SENHA_EQUIPE}`);
console.log(`  Assinantes       : ${ASSINANTES.map(([, e]) => e).join(', ')} (senha ${SENHA_CLIENTE})`);
if (!temFfmpeg) console.log('  Atenção: sem ffmpeg o catálogo ficou em rascunho. Envie os vídeos no painel (Catálogo) e publique.');
console.log('  TV aberta: Globo, SBT, Record, Band, RedeTV! e os demais já estão cadastrados e DESLIGADOS.');
console.log('  Em Canais, cadastre em cada um o endereço do sinal (.m3u8) que a emissora fornece ou o');
console.log('  endereço do player oficial dela, e ligue o canal. Os dois canais da casa usam sinal de teste.');
