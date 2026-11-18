'use strict';

/**
 * Preenche o catálogo a partir da base de filmes (TMDB): ficha em português e artes oficiais.
 *
 *   node scripts/catalogo-tmdb.js                          (lista de demonstração)
 *   node scripts/catalogo-tmdb.js "Duna: Parte Dois" "Oppenheimer"
 *   node scripts/catalogo-tmdb.js --serie "Round 6" "The Last of Us"
 *   node scripts/catalogo-tmdb.js --video 123              (qual arquivo tocar)
 *   node scripts/catalogo-tmdb.js --rascunho               (não publica)
 *   node scripts/catalogo-tmdb.js --so-qualidades         (só reaplica 4K/Full HD/HD/SD no catálogo)
 *   node scripts/catalogo-tmdb.js --generos-pt           (só traduz os gêneros que vieram em inglês)
 *
 * ATENÇÃO: o vídeo é só um arquivo de demonstração ligado a todos os títulos, para a vitrine
 * ter o que tocar. O conteúdo licenciado entra depois, um arquivo por título, pelo painel.
 */

const config = require('../server/config');
const { abrir, agora, slug } = require('../server/db');
const tmdb = require('../server/lib/tmdb');
const midia = require('../server/lib/midia');
const versoes = require('../server/lib/versoes');
const qualidades = require('../server/lib/qualidades');
const { baixarImagem } = require('../server/lib/baixar');

const FILMES = [
  'Duna: Parte Dois', 'Oppenheimer', 'Barbie', 'Wicked', 'Deadpool & Wolverine',
  'Divertida Mente 2', 'Gladiador II', 'Ainda Estou Aqui', 'Homem-Aranha: Através do Aranhaverso',
  'Vingadores: Ultimato', 'Top Gun: Maverick', 'Super Mario Bros. O Filme',
];
const SERIES = ['Round 6', 'Stranger Things', 'The Last of Us', 'Wandinha', 'A Casa do Dragão', 'The Boys'];

const args = process.argv.slice(2);
const valor = (nome, padrao = null) => {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : padrao;
};
const nomesDaLinha = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--video');
const soSerie = args.includes('--serie');
const publicar = !args.includes('--rascunho');
// Só reaplica a escada de qualidades no que já está no catálogo (não chama a base de filmes).
const soQualidades = args.includes('--so-qualidades');

const db = abrir();
const equipe = { id: 1, nome: 'catálogo' };

const semRede = soQualidades || args.includes('--generos-pt');
if (!semRede && !tmdb.ligado()) {
  console.error('Falta o token do TMDB em TV_TMDB_TOKEN. Crie um gratuito em themoviedb.org → Configurações → API.');
  process.exit(1);
}

/** Arquivo de vídeo que os títulos de demonstração vão tocar. */
const videoDemo = Number(valor('--video'))
  || db.prepare("SELECT id FROM midias WHERE tipo = 'video' AND status = 'pronta' ORDER BY tamanho DESC LIMIT 1").get()?.id
  || null;

/**
 * Escada de qualidades do arquivo de demonstração: a qualidade do próprio arquivo mais as
 * versões menores que o servidor já converteu dele. Assim **todo** título da vitrine oferece
 * as mesmas opções no player (4K, Full HD, HD e SD), e não só o primeiro que foi convertido.
 */
function escadaDoDemo(midiaId) {
  if (!midiaId) return [];
  const m = db.prepare("SELECT * FROM midias WHERE id = ? AND tipo = 'video' AND status = 'pronta'").get(midiaId);
  if (!m) return [];
  const escada = [];
  const propria = m.qualidade || qualidades.porMedidas(m.largura, m.altura);
  if (propria) escada.push({ qualidade: propria, midiaId: m.id });

  // 1) O que o servidor já converteu deste arquivo pela fila de conversão.
  const convertidas = db.prepare(`SELECT c.qualidade, c.saida_midia_id AS midia_id FROM conversoes c
    JOIN midias s ON s.id = c.saida_midia_id
    WHERE c.midia_id = ? AND c.situacao = 'pronta' AND s.status = 'pronta'
    GROUP BY c.qualidade`).all(m.id);
  for (const c of convertidas) {
    if (!escada.some((x) => x.qualidade === c.qualidade)) escada.push({ qualidade: c.qualidade, midiaId: c.midia_id });
  }

  // 2) Ou a escada que algum título que toca este mesmo arquivo já tem cadastrada
  //    (é o caso dos vídeos que vieram prontos, em várias qualidades, com os dados de demonstração).
  const modelo = db.prepare(`SELECT v.titulo_id AS id, COUNT(*) AS n FROM versoes v
    JOIN titulos t ON t.id = v.titulo_id
    WHERE t.video_midia_id = ? GROUP BY v.titulo_id ORDER BY n DESC LIMIT 1`).get(m.id);
  if (modelo && modelo.n > escada.length) {
    const doModelo = db.prepare(`SELECT v.qualidade, v.midia_id FROM versoes v
      JOIN midias s ON s.id = v.midia_id AND s.status = 'pronta' WHERE v.titulo_id = ?`).all(modelo.id);
    for (const d of doModelo) {
      if (!escada.some((x) => x.qualidade === d.qualidade)) escada.push({ qualidade: d.qualidade, midiaId: d.midia_id });
    }
  }
  return escada;
}

const ESCADA = [];

/** Repete a escada do arquivo de demonstração num título ou episódio. */
const aplicarEscada = (alvo) => {
  for (const degrau of ESCADA) versoes.registrar(db, { ...alvo, midiaId: degrau.midiaId, qualidade: degrau.qualidade });
};

/**
 * Põe em português os gêneros que o TMDB devolve em inglês mesmo quando se pede pt-BR
 * ("Action & Adventure", "Sci-Fi & Fantasy"…). Eles aparecem na ficha do título.
 */
function traduzirGeneros() {
  let mudados = 0;
  for (const [ingles, portugues] of Object.entries(tmdb.GENEROS_PT)) {
    const g = db.prepare('SELECT id, nome FROM generos WHERE nome = ?').get(ingles);
    if (!g) continue;
    const novoSlug = slug(portugues);
    const ocupado = db.prepare('SELECT id FROM generos WHERE slug = ? AND id <> ?').get(novoSlug, g.id);
    if (ocupado) {
      // Já existe um gênero com esse nome: junta os títulos nele e apaga o repetido.
      db.prepare('UPDATE OR IGNORE titulo_generos SET genero_id = ? WHERE genero_id = ?').run(ocupado.id, g.id);
      db.prepare('DELETE FROM titulo_generos WHERE genero_id = ?').run(g.id);
      db.prepare('DELETE FROM generos WHERE id = ?').run(g.id);
    } else {
      db.prepare('UPDATE generos SET nome = ?, slug = ? WHERE id = ?').run(portugues, novoSlug, g.id);
    }
    mudados += 1;
  }
  return mudados;
}

const generoId = (nome) => {
  const chave = slug(nome);
  const achado = db.prepare('SELECT id FROM generos WHERE slug = ?').get(chave);
  if (achado) return achado.id;
  const ordem = db.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM generos').get().n;
  return Number(db.prepare('INSERT INTO generos (nome, slug, ordem) VALUES (?, ?, ?)').run(nome, chave, ordem).lastInsertRowid);
};

async function entrar(nome, tipo) {
  const achados = await tmdb.buscar(nome, { tipo, limite: 1 });
  if (!achados.length) return console.log(`   ${nome}: não encontrado na base`);
  const f = await tmdb.detalhes(achados[0].tmdb_id, { tipo });

  const capa = f.capa_url ? midia.salvarImagem(db, equipe, await baixarImagem(f.capa_url), { nome: `capa-${slug(f.nome)}` }).id : null;
  const banner = f.banner_url ? midia.salvarImagem(db, equipe, await baixarImagem(f.banner_url), { nome: `banner-${slug(f.nome)}` }).id : null;

  const jaTem = db.prepare('SELECT id FROM titulos WHERE slug = ?').get(slug(f.nome));
  const situacao = publicar && (tipo === 'filme' ? videoDemo : true) && capa ? 'publicado' : 'rascunho';
  let id;
  if (jaTem) {
    id = jaTem.id;
    db.prepare(`UPDATE titulos SET nome = ?, nome_original = ?, sinopse = ?, ano = ?, pais = ?, classificacao = ?, duracao_s = ?,
        elenco = ?, direcao = ?, capa_midia_id = ?, banner_midia_id = ?, situacao = ?, atualizado_em = ? WHERE id = ?`)
      .run(f.nome, f.nome_original, f.sinopse, f.ano, f.pais, f.classificacao ?? 0, f.duracao_s,
        f.elenco, f.direcao, capa, banner, situacao, agora(), id);
  } else {
    id = Number(db.prepare(`INSERT INTO titulos (tipo, nome, slug, nome_original, sinopse, ano, pais, classificacao, duracao_s, elenco, direcao,
        situacao, capa_midia_id, banner_midia_id, video_midia_id, original, publicado_em, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(tipo, f.nome, slug(f.nome), f.nome_original, f.sinopse, f.ano, f.pais, f.classificacao ?? 0, f.duracao_s,
        f.elenco, f.direcao, situacao, capa, banner, tipo === 'filme' ? videoDemo : null,
        situacao === 'publicado' ? agora() : null, agora(), agora()).lastInsertRowid);
  }

  if (tipo === 'filme' && videoDemo) {
    db.prepare('UPDATE titulos SET video_midia_id = ? WHERE id = ?').run(videoDemo, id);
    aplicarEscada({ tituloId: id });
  }

  db.prepare('DELETE FROM titulo_generos WHERE titulo_id = ?').run(id);
  const ligar = db.prepare('INSERT OR IGNORE INTO titulo_generos (titulo_id, genero_id) VALUES (?, ?)');
  for (const g of f.generos) ligar.run(id, generoId(g));

  // Série precisa de pelo menos um episódio publicado para entrar no ar.
  if (tipo === 'serie') {
    let temporada = db.prepare('SELECT id FROM temporadas WHERE titulo_id = ? AND numero = 1').get(id);
    if (!temporada) {
      temporada = { id: Number(db.prepare('INSERT INTO temporadas (titulo_id, numero, nome, ano) VALUES (?, 1, ?, ?)')
        .run(id, 'Temporada 1', f.ano).lastInsertRowid) };
    }
    for (let n = 1; n <= 3; n += 1) {
      const ja = db.prepare('SELECT id FROM episodios WHERE temporada_id = ? AND numero = ?').get(temporada.id, n);
      let episodioId;
      if (ja) {
        db.prepare('UPDATE episodios SET video_midia_id = ?, thumb_midia_id = ?, situacao = ? WHERE id = ?')
          .run(videoDemo, banner, videoDemo ? 'publicado' : 'rascunho', ja.id);
        episodioId = ja.id;
      } else {
        episodioId = Number(db.prepare(`INSERT INTO episodios (titulo_id, temporada_id, numero, nome, sinopse, duracao_s, video_midia_id, thumb_midia_id, situacao, criado_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, temporada.id, n, `Episódio ${n}`, null, 2700, videoDemo, banner,
            videoDemo ? 'publicado' : 'rascunho', agora()).lastInsertRowid);
      }
      if (videoDemo) aplicarEscada({ episodioId });
    }
  }

  console.log(`   ${f.nome} (${f.ano}) · ${f.classificacao ?? 0} anos · ${f.generos.join(', ')}`);
}

(async () => {
  const filmes = nomesDaLinha.length && !soSerie ? nomesDaLinha : (nomesDaLinha.length ? [] : FILMES);
  const series = nomesDaLinha.length && soSerie ? nomesDaLinha : (nomesDaLinha.length ? [] : SERIES);

  const traduzidos = traduzirGeneros();
  if (traduzidos) console.log(`${traduzidos} gênero(s) de série traduzido(s) para português.`);
  if (args.includes('--generos-pt')) return;

  if (!videoDemo) console.log('Aviso: nenhum vídeo no acervo — os títulos entram como rascunho.');
  ESCADA.push(...escadaDoDemo(videoDemo));
  if (ESCADA.length > 1) {
    console.log(`Qualidades do arquivo de demonstração: ${ESCADA.map((d) => d.qualidade).join(', ')} (todos os títulos recebem as mesmas).`);
  } else if (videoDemo) {
    console.log('O arquivo de demonstração tem uma versão só. Gere as versões menores no painel (Conversão automática) e rode este script de novo.');
  }
  // Reaplicação da escada em quem já está no catálogo tocando o mesmo arquivo de demonstração.
  if (soQualidades) {
    if (!ESCADA.length) { console.error('Sem escada de qualidades para aplicar.'); process.exit(1); }
    const alvos = db.prepare('SELECT id FROM titulos WHERE video_midia_id = ?').all(videoDemo);
    const eps = db.prepare('SELECT id FROM episodios WHERE video_midia_id = ?').all(videoDemo);
    for (const t2 of alvos) aplicarEscada({ tituloId: t2.id });
    for (const e of eps) aplicarEscada({ episodioId: e.id });
    console.log(`${alvos.length} título(s) e ${eps.length} episódio(s) agora oferecem ${ESCADA.map((d) => d.qualidade).join(', ')}.`);
    return;
  }

  if (filmes.length) console.log(`Filmes (${filmes.length}):`);
  for (const nome of filmes) await entrar(nome, 'filme');
  if (series.length) console.log(`Séries (${series.length}):`);
  for (const nome of series) await entrar(nome, 'serie');

  // Os destaques da home passam a ser os títulos recém-trazidos (é o que o cliente vê primeiro).
  if (!args.includes('--sem-destaques')) {
    const novos = db.prepare(`SELECT id, nome, sinopse, banner_midia_id, tipo FROM titulos
      WHERE situacao = 'publicado' AND banner_midia_id IS NOT NULL
      ORDER BY atualizado_em DESC LIMIT 3`).all();
    if (novos.length) {
      db.prepare('DELETE FROM destaques').run();
      const inserir = db.prepare(`INSERT INTO destaques (titulo_id, chamada, descricao, arte_midia_id, ordem, ativo, criado_em)
        VALUES (?, ?, ?, ?, ?, 1, ?)`);
      novos.forEach((t2, i) => inserir.run(t2.id, t2.tipo === 'serie' ? 'Série em destaque' : 'Em cartaz agora',
        t2.sinopse, t2.banner_midia_id, i + 1, agora()));
      console.log(`\nDestaques da home: ${novos.map((t2) => t2.nome).join(', ')}`);
    }
  }

  const publicados = db.prepare("SELECT COUNT(*) AS n FROM titulos WHERE situacao = 'publicado'").get().n;
  console.log(`\nCatálogo com ${publicados} título(s) no ar.`);
  console.log('O vídeo ligado a estes títulos é de demonstração: o conteúdo licenciado entra pelo painel, um arquivo por título.');
})().catch((err) => {
  console.error('Falhou:', err.message);
  process.exit(1);
});
