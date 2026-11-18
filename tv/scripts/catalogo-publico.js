'use strict';

/**
 * Traz filmes de **acervo público** para o catálogo: obras de domínio público ou em Creative
 * Commons, que podem ser transmitidas sem contrato com estúdio.
 *
 *   node scripts/catalogo-publico.js --listar              o que a lista curada oferece
 *   node scripts/catalogo-publico.js                       importa o que ainda falta dela
 *   node scripts/catalogo-publico.js --item Sintel         importa um item do Internet Archive
 *   node scripts/catalogo-publico.js --buscar "nasa"       procura no acervo (só mostra)
 *   node scripts/catalogo-publico.js --buscar "nasa" --importar --quantos 3
 *
 *   --completo    baixa o filme inteiro (o padrão guarda um trecho de 3 minutos, para demonstração)
 *   --rascunho    deixa os títulos sem publicar
 *   --forcar      importa mesmo quando a licença não ficou clara (a conferência passa a ser sua)
 *
 * SOBRE DIREITO AUTORAL: o script só importa sozinho o que está em coleção de domínio público
 * conhecida ou com licença Creative Commons que permita redistribuir **e** gerar as versões
 * menores (by, by-sa e domínio público). Licença "sem derivadas" (ND) fica de fora, porque
 * converter para Full HD, HD e SD é criar derivada. Lista de IPTV com filme de estúdio, dessas
 * que circulam como "VOD grátis", é conteúdo pirata: não entra aqui e não deve entrar no ar.
 */

const fs = require('node:fs');
const { abrir, agora, slug } = require('../server/db');
const midia = require('../server/lib/midia');
const versoes = require('../server/lib/versoes');
const qualidades = require('../server/lib/qualidades');
const acervo = require('../server/lib/acervo');

const args = process.argv.slice(2);
const valor = (nome, padrao = null) => {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : padrao;
};
const tem = (nome) => args.includes(nome);

const soListar = tem('--listar');
const itemPedido = valor('--item');
const termoBusca = valor('--buscar');
const colecaoBusca = valor('--colecao', 'feature_films');
const quantos = Number(valor('--quantos')) || 0;
const completo = tem('--completo');
const publicar = !tem('--rascunho');
const forcar = tem('--forcar');
const importarBusca = tem('--importar');
const SEGUNDOS_DO_TRECHO = Number(valor('--segundos')) || 180;

const db = abrir();
const equipe = { id: 1, nome: 'acervo público' };

/**
 * Lista curada: obras **atuais e coloridas**, em Full HD ou mais, com licença livre conferida
 * uma a uma. É daqui que sai um catálogo de demonstração apresentável — nada de preto e branco
 * dos anos 40, que é o que a busca aberta do acervo costuma devolver primeiro.
 */
const ACERVO_LIVRE = [
  {
    item: 'Sintel', nome: 'Sintel', original: 'Sintel', ano: 2010, classificacao: 12, pais: 'Holanda',
    generos: ['Fantasia', 'Aventura'], direcao: 'Colin Levy', elenco: 'Blender Foundation · Amsterdã',
    sinopse: 'Uma jovem solitária atravessa um mundo hostil atrás do filhote de dragão que criou e perdeu. Animação em alta resolução, do estúdio que criou o Blender.',
    licenca: 'Creative Commons Attribution 3.0',
  },
  {
    item: 'Tears-of-Steel', nome: 'Lágrimas de Aço', original: 'Tears of Steel', ano: 2012, classificacao: 14, pais: 'Holanda',
    generos: ['Ficção científica', 'Ação'], direcao: 'Ian Hubert', elenco: 'Blender Foundation · Amsterdã',
    sinopse: 'Num futuro tomado por máquinas, um grupo de cientistas tenta reescrever o passado para salvar Amsterdã. Curta de efeitos visuais rodado com atores e cenário real.',
    licenca: 'Creative Commons Attribution 3.0',
  },
  {
    item: 'Sita_Sings_the_Blues', nome: 'Sita Canta o Blues', original: 'Sita Sings the Blues', ano: 2008, classificacao: 12, pais: 'Estados Unidos',
    generos: ['Animação', 'Musical', 'Drama'], direcao: 'Nina Paley', elenco: 'Nina Paley · Annette Hanshaw',
    sinopse: 'A história de Sita, do épico indiano Ramayana, contada junto com a de uma animadora abandonada pelo marido — costuradas por canções de blues dos anos 1920. Longa de animação inteiro, em Full HD.',
    licenca: 'Domínio público (CC0)',
  },
  {
    item: 'BigBuckBunny_124', nome: 'Big Buck Bunny', original: 'Big Buck Bunny', ano: 2008, classificacao: 0, pais: 'Holanda',
    generos: ['Animação', 'Comédia', 'Infantil'], direcao: 'Sacha Goedegebure', elenco: 'Blender Foundation · Amsterdã',
    sinopse: 'Um coelho gigante e pacífico perde a paciência com três roedores valentões — e arma a vingança mais elaborada da floresta. Animação colorida, boa para a sessão da tarde.',
    licenca: 'Creative Commons Attribution 3.0',
  },
];

const jaExiste = (nome) => db.prepare('SELECT id FROM titulos WHERE slug = ?').get(slug(nome));

const generoId = (nome) => {
  const chave = slug(nome);
  const achado = db.prepare('SELECT id FROM generos WHERE slug = ?').get(chave);
  if (achado) return achado.id;
  const ordem = db.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM generos').get().n;
  return Number(db.prepare('INSERT INTO generos (nome, slug, ordem) VALUES (?, ?, ?)').run(nome, chave, ordem).lastInsertRowid);
};

/** Entra no acervo pelo mesmo caminho do painel: abre o envio, manda os pedaços e conclui. */
function guardarVideo(arquivo, { duracao, nome, largura, altura }) {
  const conteudo = fs.readFileSync(arquivo);
  const m = midia.abrirEnvioVideo(db, equipe, {
    nome, tamanho: conteudo.length, duracao_s: duracao, largura: largura ?? 1280, altura: altura ?? 720,
  });
  const pedaco = 1024 * 1024;
  for (let off = 0; off < conteudo.length; off += pedaco) {
    midia.receberParte(db, m.id, off, conteudo.subarray(off, Math.min(off + pedaco, conteudo.length)));
  }
  return midia.concluirEnvioVideo(db, m.id, { duracao_s: duracao }).id;
}

/** Pega o pedaço do filme que vai ser guardado (trecho, ou o filme inteiro com --completo). */
async function arquivoDoFilme(fonte, duracaoTotal) {
  if (completo) {
    process.stdout.write('    baixando o filme inteiro… ');
    let ultimo = -1;
    const baixado = await acervo.baixarFilme(fonte.url, (p) => {
      const passo = Math.floor(p * 10) * 10;
      if (passo > ultimo) { ultimo = passo; process.stdout.write(`${passo}% `); }
    });
    process.stdout.write('\n');
    return baixado;
  }
  // Trecho a partir de uns 20% do filme: pula abertura e créditos iniciais.
  const inicio = Math.max(5, Math.round((duracaoTotal || 600) * 0.2));
  return acervo.trechoDoFilme(fonte.url, inicio, SEGUNDOS_DO_TRECHO);
}

/** Importa um item do Internet Archive para o catálogo. */
async function importar(entrada) {
  const id = entrada.item ?? entrada.id;
  const ficha = await acervo.fichaDoArchive(id);
  const meta = ficha.metadata ?? {};
  const nome = entrada.nome ?? String(meta.title ?? id).trim();

  if (jaExiste(nome)) {
    console.log(`  —  ${nome}: já está no catálogo`);
    return false;
  }

  const livre = acervo.podeRedistribuir({
    licenca: meta.licenseurl ?? null,
    colecoes: Array.isArray(meta.collection) ? meta.collection : [meta.collection].filter(Boolean),
  });
  if (!livre && !forcar) {
    console.log(`  ✗  ${nome}: licença não confirmada (${meta.licenseurl ?? 'sem licença declarada'}). Use --forcar se tiver certeza.`);
    return false;
  }

  const fonte = acervo.melhorArquivo(ficha);
  if (!fonte) {
    console.log(`  ✗  ${nome}: o item não tem arquivo de vídeo aproveitável`);
    return false;
  }
  console.log(`  ·  ${nome}: ${fonte.largura}×${fonte.altura}, ${Math.round(fonte.bytes / 1e6)} MB${fonte.precisaConverter ? ' (converte na entrada)' : ''}`);

  const duracaoTotal = acervo.duracaoRemota(fonte.url);
  const arquivo = await arquivoDoFilme(fonte, duracaoTotal);
  if (!arquivo) {
    console.log(`  ✗  ${nome}: não consegui ler o vídeo no acervo`);
    return false;
  }

  const medida = acervo.medirVideo(arquivo);
  const altura = medida.altura ?? fonte.altura;
  const largura = medida.largura ?? fonte.largura;
  const videoId = guardarVideo(arquivo, { duracao: medida.duracao, nome: `${slug(nome)}.mp4`, largura, altura });

  // Capa (2:3) e banner (16:9) saem de quadros do próprio filme.
  const instantes = [0.25, 0.45, 0.65].map((p) => Math.round((duracaoTotal || 600) * p));
  const quadro = acervo.melhorQuadro(fonte.url, instantes);
  const capa = quadro ? midia.salvarImagem(db, equipe, quadro, { nome: `${slug(nome)}-capa.jpg` }).id : null;
  const outroQuadro = acervo.quadroDoFilme(fonte.url, instantes[2] + 7) ?? quadro;
  const banner = outroQuadro ? midia.salvarImagem(db, equipe, outroQuadro, { nome: `${slug(nome)}-banner.jpg` }).id : null;

  const credito = entrada.licenca ?? (meta.licenseurl ? `Licença ${meta.licenseurl}` : 'Domínio público');
  const sinopse = `${entrada.sinopse ?? String(meta.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900)}\n\nObra livre — ${credito}. Acervo: Internet Archive (${id}).`;

  const tituloId = Number(db.prepare(`INSERT INTO titulos
    (tipo, nome, slug, nome_original, sinopse, ano, pais, classificacao, duracao_s, elenco, direcao,
     situacao, capa_midia_id, banner_midia_id, video_midia_id, original, publicado_em, criado_em, atualizado_em)
    VALUES ('filme', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(nome, slug(nome), entrada.original ?? nome, sinopse, entrada.ano ?? (Number(meta.year) || null),
      entrada.pais ?? null, entrada.classificacao ?? 12, medida.duracao ?? duracaoTotal,
      entrada.elenco ?? null, entrada.direcao ?? (meta.creator ? String(meta.creator) : null),
      publicar && capa ? 'publicado' : 'rascunho', capa, banner, videoId,
      publicar && capa ? agora() : null, agora(), agora()).lastInsertRowid);

  for (const g of entrada.generos ?? ['Filmes livres']) {
    db.prepare('INSERT OR IGNORE INTO titulo_generos (titulo_id, genero_id) VALUES (?, ?)').run(tituloId, generoId(g));
  }

  // Escada de qualidade: a do arquivo guardado, mais as versões menores geradas aqui.
  const minha = qualidades.porMedidas(largura, altura);
  if (minha) versoes.registrar(db, { tituloId, midiaId: videoId, qualidade: minha });
  const menores = acervo.versoesMenores(arquivo, altura, largura);
  for (const v of menores) {
    const m = acervo.medirVideo(v.arquivo);
    const id2 = guardarVideo(v.arquivo, { duracao: m.duracao, nome: `${slug(nome)}-${v.qualidade}.mp4`, largura: m.largura, altura: m.altura });
    versoes.registrar(db, { tituloId, midiaId: id2, qualidade: v.qualidade });
    fs.rmSync(v.arquivo, { force: true });
  }
  fs.rmSync(arquivo, { force: true });

  const escada = [minha, ...menores.map((v) => v.qualidade)].filter(Boolean).map((q) => qualidades.rotulo(q));
  console.log(`  ✓  ${nome} (${entrada.ano ?? meta.year ?? '—'}) · ${escada.join(', ')}`);
  return true;
}

(async () => {
  if (!acervo.temFfmpeg()) {
    console.error('Este script precisa do ffmpeg instalado (ele corta o trecho, tira os quadros e gera as qualidades).');
    process.exit(1);
  }

  if (soListar) {
    console.log('Acervo livre conferido (modernos, coloridos, em Full HD ou mais):\n');
    for (const f of ACERVO_LIVRE) {
      const estado = jaExiste(f.nome) ? 'já no catálogo' : 'disponível';
      console.log(`  ${String(f.ano).padEnd(6)} ${f.nome.padEnd(22)} ${f.licenca.padEnd(34)} ${estado}`);
    }
    console.log('\nColeções de domínio público que a busca aceita em --colecao:');
    for (const [chave, texto] of Object.entries(acervo.COLECOES_LIVRES)) console.log(`  ${chave.padEnd(20)} ${texto}`);
    return;
  }

  if (termoBusca) {
    const achados = await acervo.buscarNoArchive({ colecao: colecaoBusca, termo: termoBusca, quantos: quantos || 10 });
    console.log(`${achados.length} resultado(s) em "${colecaoBusca || 'todo o acervo'}":\n`);
    for (const a of achados) {
      const livre = acervo.podeRedistribuir(a) ? 'livre' : 'conferir';
      console.log(`  ${String(a.ano ?? '----').padEnd(6)} ${livre.padEnd(9)} ${a.id.padEnd(40)} ${a.titulo.slice(0, 50)}`);
    }
    if (!importarBusca) {
      console.log('\nPara trazer para o catálogo, repita com --importar (ou use --item <identificador>).');
      return;
    }
    let entraram = 0;
    for (const a of achados) {
      if (quantos && entraram >= quantos) break;
      if (await importar(a)) entraram += 1;
    }
    console.log(`\n${entraram} título(s) importado(s).`);
    return;
  }

  if (itemPedido) {
    const curado = ACERVO_LIVRE.find((f) => f.item === itemPedido);
    await importar(curado ?? { item: itemPedido });
    return;
  }

  const faltando = ACERVO_LIVRE.filter((f) => !jaExiste(f.nome));
  if (!faltando.length) {
    console.log('Todos os títulos da lista curada já estão no catálogo. Use --buscar para procurar mais no acervo.');
    return;
  }
  const alvos = quantos ? faltando.slice(0, quantos) : faltando;
  console.log(`Importando ${alvos.length} título(s) de acervo público${completo ? ' (filme inteiro)' : ` (trecho de ${SEGUNDOS_DO_TRECHO}s)`}…\n`);
  let entraram = 0;
  for (const f of alvos) if (await importar(f)) entraram += 1;
  console.log(`\n${entraram} título(s) no catálogo.`);
})().catch((err) => {
  console.error('Falhou:', err.message);
  process.exit(1);
});
