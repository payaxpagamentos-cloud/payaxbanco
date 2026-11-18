'use strict';

/**
 * Preenche o catálogo a partir da base de filmes (TMDB): ficha em português e artes oficiais.
 *
 *   node scripts/catalogo-tmdb.js                          (lista de demonstração)
 *   node scripts/catalogo-tmdb.js "Duna: Parte Dois" "Oppenheimer"
 *   node scripts/catalogo-tmdb.js --serie "Round 6" "The Last of Us"
 *   node scripts/catalogo-tmdb.js --video 123              (qual arquivo tocar)
 *   node scripts/catalogo-tmdb.js --rascunho               (não publica)
 *
 * ATENÇÃO: o vídeo é só um arquivo de demonstração ligado a todos os títulos, para a vitrine
 * ter o que tocar. O conteúdo licenciado entra depois, um arquivo por título, pelo painel.
 */

const config = require('../server/config');
const { abrir, agora, slug } = require('../server/db');
const tmdb = require('../server/lib/tmdb');
const midia = require('../server/lib/midia');
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

const db = abrir();
const equipe = { id: 1, nome: 'catálogo' };

if (!tmdb.ligado()) {
  console.error('Falta o token do TMDB em TV_TMDB_TOKEN. Crie um gratuito em themoviedb.org → Configurações → API.');
  process.exit(1);
}

/** Arquivo de vídeo que os títulos de demonstração vão tocar. */
const videoDemo = Number(valor('--video'))
  || db.prepare("SELECT id FROM midias WHERE tipo = 'video' AND status = 'pronta' ORDER BY tamanho DESC LIMIT 1").get()?.id
  || null;

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

  if (tipo === 'filme' && videoDemo) db.prepare('UPDATE titulos SET video_midia_id = ? WHERE id = ?').run(videoDemo, id);

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
      if (ja) {
        db.prepare('UPDATE episodios SET video_midia_id = ?, thumb_midia_id = ?, situacao = ? WHERE id = ?')
          .run(videoDemo, banner, videoDemo ? 'publicado' : 'rascunho', ja.id);
      } else {
        db.prepare(`INSERT INTO episodios (titulo_id, temporada_id, numero, nome, sinopse, duracao_s, video_midia_id, thumb_midia_id, situacao, criado_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, temporada.id, n, `Episódio ${n}`, null, 2700, videoDemo, banner,
            videoDemo ? 'publicado' : 'rascunho', agora());
      }
    }
  }

  console.log(`   ${f.nome} (${f.ano}) · ${f.classificacao ?? 0} anos · ${f.generos.join(', ')}`);
}

(async () => {
  const filmes = nomesDaLinha.length && !soSerie ? nomesDaLinha : (nomesDaLinha.length ? [] : FILMES);
  const series = nomesDaLinha.length && soSerie ? nomesDaLinha : (nomesDaLinha.length ? [] : SERIES);

  if (!videoDemo) console.log('Aviso: nenhum vídeo no acervo — os títulos entram como rascunho.');
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
