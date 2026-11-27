'use strict';

const { ErroNegocio, naoEncontrado } = require('./erros');
const { agora } = require('../db');
const epg = require('./epg');
const v = require('./validacao');
const qualidades = require('./qualidades');
const embed = require('./embed');
const { memoriaPorBanco } = require('./memoria');

/**
 * Consultas do catálogo (o que o assinante vê). Tudo passa por dois filtros:
 * a classificação indicativa do perfil de visualização e o nível do plano assinado.
 */

const SELECT_CARD = `SELECT t.id, t.tipo, t.nome, t.slug, t.ano, t.classificacao, t.duracao_s, t.original, t.estreia, t.publicado_em,
  t.capa_midia_id AS capa, t.banner_midia_id AS banner, t.sinopse,
  (SELECT nivel FROM planos p WHERE p.id = t.plano_minimo_id) AS nivel_minimo,
  (SELECT nome FROM planos p WHERE p.id = t.plano_minimo_id) AS plano_nome,
  (SELECT COUNT(*) FROM episodios e WHERE e.titulo_id = t.id AND e.situacao = 'publicado') AS episodios_n,
  (SELECT group_concat(g.nome, ', ') FROM titulo_generos tg JOIN generos g ON g.id = tg.genero_id WHERE tg.titulo_id = t.id) AS generos
  FROM titulos t`;

const card = (t) => ({
  id: t.id,
  tipo: t.tipo,
  nome: t.nome,
  slug: t.slug,
  ano: t.ano,
  classificacao: t.classificacao,
  duracao_s: t.duracao_s,
  original: Boolean(t.original),
  capa: t.capa,
  banner: t.banner,
  sinopse: t.sinopse,
  generos: t.generos,
  episodios_n: t.episodios_n,
  nivel_minimo: t.nivel_minimo ?? null,
  plano_nome: t.nivel_minimo ? t.plano_nome : null,
  // Marcado quando o plano atual não alcança o título (a tela mostra o selo do plano).
  bloqueado: false,
});

const marcar = (linhas, acesso) => linhas.map((t) => {
  const c = card(t);
  c.bloqueado = Boolean(c.nivel_minimo && acesso.nivel < c.nivel_minimo);
  return c;
});

/** Filtro da classificação indicativa do perfil (o perfil infantil não vê nem a capa). */
const limiteIdade = (perfil) => (perfil ? Number(perfil.classificacao_max) : 18);

/** Fileira "Continuar assistindo": de onde o perfil parou, do mais recente para o mais antigo. */
function continuarAssistindo(db, perfil, limite = 20) {
  const linhas = db.prepare(`SELECT pr.segundos, pr.duracao_s AS visto_duracao, pr.episodio_id, pr.atualizado_em,
      e.numero AS episodio_numero, e.nome AS episodio_nome, tm.numero AS temporada_numero,
      t.id, t.tipo, t.nome, t.slug, t.ano, t.classificacao, t.duracao_s, t.original, t.estreia, t.publicado_em,
      t.capa_midia_id AS capa, t.banner_midia_id AS banner, t.sinopse,
      (SELECT nivel FROM planos p WHERE p.id = t.plano_minimo_id) AS nivel_minimo,
      (SELECT nome FROM planos p WHERE p.id = t.plano_minimo_id) AS plano_nome,
      NULL AS episodios_n, NULL AS generos
    FROM progresso pr JOIN titulos t ON t.id = pr.titulo_id
    LEFT JOIN episodios e ON e.id = pr.episodio_id LEFT JOIN temporadas tm ON tm.id = e.temporada_id
    WHERE pr.perfil_id = ? AND pr.concluido = 0 AND pr.segundos > 30 AND t.situacao = 'publicado' AND t.classificacao <= ?
    ORDER BY pr.atualizado_em DESC LIMIT ?`).all(perfil.id, limiteIdade(perfil), limite);
  return linhas.map((r) => ({
    ...card(r),
    retomar: {
      segundos: r.segundos,
      duracao_s: r.visto_duracao || r.duracao_s || 0,
      percentual: r.visto_duracao ? Math.min(99, Math.round((r.segundos / r.visto_duracao) * 100)) : 0,
      episodio_id: r.episodio_id || null,
      episodio: r.episodio_numero ? { numero: r.episodio_numero, nome: r.episodio_nome, temporada: r.temporada_numero } : null,
    },
  }));
}

const minhaLista = (db, perfil, limite = 60) => db.prepare(`${SELECT_CARD}
  JOIN favoritos f ON f.titulo_id = t.id
  WHERE f.perfil_id = ? AND t.situacao = 'publicado' AND t.classificacao <= ?
  ORDER BY f.criado_em DESC LIMIT ?`).all(perfil.id, limiteIdade(perfil), limite);

/**
 * Quantas vezes cada título foi aberto nos últimos dias.
 *
 * É a conta por trás de "Em alta" e da ordenação "populares", e era refeita a CADA pedido,
 * varrendo o histórico de reprodução — a tabela que mais cresce na plataforma. Medido com 50
 * mil sessões, ordenar o catálogo por populares levava quase 1 segundo; com o histórico de uns
 * meses de operação passaria de 10, e nesse tempo o servidor não atende mais nada.
 *
 * A audiência dos últimos dias não muda de um minuto para o outro, e é a mesma para todo
 * mundo. Então a contagem é feita uma vez a cada dez minutos, numa passada só, por um índice
 * que só tem as sessões de filme e série (idx_sessoes_titulo).
 */
const memoriaAudiencia = memoriaPorBanco({ validadeMs: 10 * 60_000, maximo: 8 });
const audienciaPorTitulo = (db, dias) => memoriaAudiencia(db).obter(String(dias), () => new Map(
  db.prepare('SELECT titulo_id, COUNT(*) AS n FROM sessoes_player WHERE titulo_id IS NOT NULL AND iniciada_em >= ? GROUP BY titulo_id')
    .all(new Date(Date.now() - dias * 86_400_000).toISOString()).map((x) => [x.titulo_id, x.n]),
));

/** Busca os cartões de uma lista de ids, devolvendo na ordem pedida. */
function cartoesNaOrdem(db, ids, idadeMaxima) {
  if (!ids.length) return [];
  const linhas = db.prepare(`${SELECT_CARD} WHERE t.id IN (${ids.map(() => '?').join(',')}) AND t.situacao = 'publicado' AND t.classificacao <= ?`)
    .all(...ids, idadeMaxima);
  const porId = new Map(linhas.map((l) => [l.id, l]));
  return ids.map((id) => porId.get(id)).filter(Boolean);
}

/** Em alta: mais telas abertas nos últimos dias (audiência real, não cadastro). */
function emAlta(db, perfil, { dias = 7, limite = 20 } = {}) {
  const audiencia = audienciaPorTitulo(db, dias);
  // Candidatos com folga: parte deles pode cair no filtro de idade ou ter saído do ar.
  const candidatos = [...audiencia.entries()].sort((a, b) => b[1] - a[1]).slice(0, limite * 4 + 40).map(([id]) => id);
  return cartoesNaOrdem(db, candidatos, limiteIdade(perfil))
    // Empate na audiência: o publicado mais recentemente primeiro, como era.
    .sort((a, b) => (audiencia.get(b.id) - audiencia.get(a.id)) || String(b.publicado_em ?? '').localeCompare(String(a.publicado_em ?? '')))
    .slice(0, limite);
}

const novidades = (db, perfil, limite = 20) => db.prepare(`${SELECT_CARD}
  WHERE t.situacao = 'publicado' AND t.classificacao <= ? ORDER BY COALESCE(t.publicado_em, t.criado_em) DESC LIMIT ?`).all(limiteIdade(perfil), limite);

const porTipo = (db, perfil, tipo, limite = 20) => db.prepare(`${SELECT_CARD}
  WHERE t.situacao = 'publicado' AND t.tipo = ? AND t.classificacao <= ? ORDER BY COALESCE(t.publicado_em, t.criado_em) DESC LIMIT ?`)
  .all(tipo, limiteIdade(perfil), limite);

const originais = (db, perfil, limite = 20) => db.prepare(`${SELECT_CARD}
  WHERE t.situacao = 'publicado' AND t.original = 1 AND t.classificacao <= ? ORDER BY COALESCE(t.publicado_em, t.criado_em) DESC LIMIT ?`)
  .all(limiteIdade(perfil), limite);

const porGenero = (db, perfil, generoId, limite = 20) => db.prepare(`${SELECT_CARD}
  JOIN titulo_generos tg ON tg.titulo_id = t.id
  WHERE tg.genero_id = ? AND t.situacao = 'publicado' AND t.classificacao <= ? ORDER BY COALESCE(t.publicado_em, t.criado_em) DESC LIMIT ?`)
  .all(Number(generoId), limiteIdade(perfil), limite);

const manual = (db, perfil, fileiraId, limite = 20) => db.prepare(`${SELECT_CARD}
  JOIN fileira_itens fi ON fi.titulo_id = t.id
  WHERE fi.fileira_id = ? AND t.situacao = 'publicado' AND t.classificacao <= ? ORDER BY fi.ordem, t.nome LIMIT ?`)
  .all(Number(fileiraId), limiteIdade(perfil), limite);

/** Canais ao vivo com o programa que está no ar e o próximo. */
/**
 * Canais que este perfil pode ver.
 *
 * O teto é alto de propósito: com 116 canais no contrato, um limite de 100 cortaria justamente
 * os últimos da lista — que é onde ficam Globo, SBT e Record — e ninguém entenderia por que a
 * TV aberta "sumiu". Quem precisa de poucos (as fileiras da home) passa `limite`.
 */
function canaisAoVivo(db, perfil, acesso, { limite = 500 } = {}) {
  // O que muda de um assinante para outro aqui é só a faixa etária (que canais ele vê) e o
  // plano (quais aparecem bloqueados). O resto — canal, o que está no ar, o que vem depois — é
  // igual para todos e custava ~25 ms por pedido, medido com 116 canais e sete dias de grade.
  // Com a tela de canais se atualizando sozinha em cada aparelho, isso sozinho ocupava o
  // servidor. Agora é calculado uma vez a cada 20 s por faixa etária.
  // A versão dos canais entra na chave: mexeu num canal pelo painel, vale na hora.
  const base = memoriaCanais(db).obter(`${limiteIdade(perfil)}|${limite}|${embed.versaoAtual()}`, () => baseDosCanais(db, limiteIdade(perfil), limite));
  return base.map(({ canal: c, agora: p, depois }) => ({
    ...c,
    relay: Boolean(c.relay),
    bloqueado: Boolean((c.nivel_minimo && acesso.nivel < c.nivel_minimo) || !acesso.canais_ao_vivo),
    plano_nome: c.nivel_minimo ? c.plano_nome : null,
    // O andamento é calculado na hora, não guardado: é o que faz a barra andar entre uma
    // atualização e outra.
    agora: p ? { id: p.id, titulo: p.titulo, subtitulo: p.subtitulo, descricao: p.descricao, inicio: p.inicio, fim: p.fim,
      classificacao: p.classificacao, ao_vivo: Boolean(p.ao_vivo), andamento: epg.andamento(p) } : null,
    depois,
  }));
}

const memoriaCanais = memoriaPorBanco({ validadeMs: 20_000, maximo: 60 });

/** Canais com o programa do momento e o seguinte, sem nada que dependa de quem pede. */
function baseDosCanais(db, idadeMaxima, limite) {
  const canais = db.prepare(`SELECT c.id, c.numero, c.nome, c.slug, c.descricao, c.categoria, c.regiao, c.classificacao, c.logo_midia_id AS logo, c.logo_luz,
      c.sinal_status, c.relay, c.fonte,
      (SELECT nivel FROM planos p WHERE p.id = c.plano_minimo_id) AS nivel_minimo,
      (SELECT nome FROM planos p WHERE p.id = c.plano_minimo_id) AS plano_nome
    FROM canais c WHERE c.ativo = 1 AND c.classificacao <= ? ORDER BY c.ordem, c.numero LIMIT ?`).all(idadeMaxima, limite);
  const noAr = epg.agoraEmTodos(db, canais.map((c) => c.id));
  // O "a seguir" de todos os canais numa consulta só. Era uma por canal: com 116 canais e a tela
  // se atualizando sozinha de 2 em 2 minutos, viravam 116 consultas por assinante, o tempo todo.
  const depoisDe = new Map();
  if (canais.length) {
    const marcas = canais.map(() => '?').join(',');
    for (const linha of db.prepare(`SELECT canal_id, titulo, inicio, fim FROM (
        SELECT canal_id, titulo, inicio, fim, ROW_NUMBER() OVER (PARTITION BY canal_id ORDER BY inicio) AS n
        FROM programas WHERE canal_id IN (${marcas}) AND inicio >= ?
      ) WHERE n = 1`).all(...canais.map((c) => c.id), new Date().toISOString())) {
      depoisDe.set(linha.canal_id, { titulo: linha.titulo, inicio: linha.inicio, fim: linha.fim });
    }
  }
  return canais.map((c) => ({ canal: c, agora: noAr.get(c.id) ?? null, depois: depoisDe.get(c.id) ?? null }));
}

/** Destaques do topo da home (o que a curadoria quer mostrar primeiro). */
function destaques(db, perfil, acesso) {
  const instante = new Date().toISOString();
  const linhas = db.prepare(`SELECT d.id, d.chamada, d.descricao, d.arte_midia_id AS arte, d.ordem,
      t.id AS titulo_id, t.tipo, t.nome AS titulo_nome, t.slug, t.sinopse, t.ano, t.classificacao AS titulo_classificacao, t.duracao_s,
      t.capa_midia_id AS capa, t.banner_midia_id AS banner, t.original,
      c.id AS canal_id, c.nome AS canal_nome, c.numero AS canal_numero, c.logo_midia_id AS canal_logo, c.classificacao AS canal_classificacao
    FROM destaques d LEFT JOIN titulos t ON t.id = d.titulo_id LEFT JOIN canais c ON c.id = d.canal_id
    WHERE d.ativo = 1 AND (d.inicio IS NULL OR d.inicio <= ?) AND (d.fim IS NULL OR d.fim >= ?)
      AND (t.id IS NULL OR t.situacao = 'publicado') AND (c.id IS NULL OR c.ativo = 1)
    ORDER BY d.ordem, d.id`).all(instante, instante);
  const idade = limiteIdade(perfil);
  return linhas
    .filter((d) => (d.titulo_id ? d.titulo_classificacao <= idade : d.canal_classificacao <= idade))
    .map((d) => (d.titulo_id
      ? {
        id: d.id, tipo: 'titulo', chamada: d.chamada, descricao: d.descricao ?? d.sinopse, arte: d.arte ?? d.banner ?? d.capa,
        titulo: { id: d.titulo_id, tipo: d.tipo, nome: d.titulo_nome, slug: d.slug, ano: d.ano, classificacao: d.titulo_classificacao,
          duracao_s: d.duracao_s, capa: d.capa, banner: d.banner, original: Boolean(d.original) },
      }
      : {
        id: d.id, tipo: 'canal', chamada: d.chamada, descricao: d.descricao, arte: d.arte,
        canal: { id: d.canal_id, nome: d.canal_nome, numero: d.canal_numero, logo: d.canal_logo, classificacao: d.canal_classificacao,
          agora: epg.noAr(db, d.canal_id) },
      }))
    .map((d) => ({ ...d, bloqueado: d.tipo === 'canal' ? !acesso.canais_ao_vivo : false }));
}

/** Monta a home: destaques + fileiras configuradas pela curadoria. */
function home(db, perfil, acesso) {
  const fileiras = [];
  const continuar = continuarAssistindo(db, perfil);
  if (continuar.length) fileiras.push({ id: 'continuar', nome: 'Continuar assistindo', tipo: 'continuar', itens: continuar });

  for (const f of db.prepare('SELECT * FROM fileiras WHERE ativa = 1 ORDER BY ordem, id').all()) {
    let itens = [];
    if (f.tipo === 'canais') {
      const canais = canaisAoVivo(db, perfil, acesso, { limite: f.limite });
      if (canais.length) fileiras.push({ id: f.id, nome: f.nome, tipo: 'canais', itens: canais });
      continue;
    }
    if (f.tipo === 'em_alta') itens = emAlta(db, perfil, { limite: f.limite });
    else if (f.tipo === 'novidades') itens = novidades(db, perfil, f.limite);
    else if (f.tipo === 'originais') itens = originais(db, perfil, f.limite);
    else if (f.tipo === 'filmes') itens = porTipo(db, perfil, 'filme', f.limite);
    else if (f.tipo === 'series') itens = porTipo(db, perfil, 'serie', f.limite);
    else if (f.tipo === 'genero' && f.genero_id) itens = porGenero(db, perfil, f.genero_id, f.limite);
    else if (f.tipo === 'manual') itens = manual(db, perfil, f.id, f.limite);
    if (itens.length) fileiras.push({ id: f.id, nome: f.nome, tipo: f.tipo, itens: marcar(itens, acesso) });
  }

  const lista = minhaLista(db, perfil, 30);
  if (lista.length) fileiras.splice(continuar.length ? 1 : 0, 0, { id: 'minha-lista', nome: 'Minha lista', tipo: 'minha_lista', itens: marcar(lista, acesso) });
  return { destaques: destaques(db, perfil, acesso), fileiras };
}

const buscarTitulo = (db, chave) => (/^\d+$/.test(String(chave))
  ? db.prepare('SELECT * FROM titulos WHERE id = ?').get(Number(chave))
  : db.prepare('SELECT * FROM titulos WHERE slug = ?').get(String(chave)));

/** Página do filme ou da série: fichas, temporadas, episódios, legendas e onde você parou. */
/**
 * Qualidades que este título oferece: as versões cadastradas do filme (ou dos episódios),
 * mais a do arquivo principal. Da melhor para a pior.
 */
function qualidadesDoTitulo(db, t) {
  const linhas = db.prepare(`SELECT DISTINCT v.qualidade FROM versoes v
    WHERE v.titulo_id = ? OR v.episodio_id IN (SELECT id FROM episodios WHERE titulo_id = ? AND situacao = 'publicado')`).all(t.id, t.id);
  const lista = new Set(linhas.map((l) => l.qualidade));
  const principal = db.prepare('SELECT largura, altura FROM midias WHERE id = ?').get(t.video_midia_id ?? -1);
  const q = qualidades.porMedidas(principal?.largura, principal?.altura);
  if (q) lista.add(q);
  return [...lista].sort((a, b) => qualidades.nivel(b) - qualidades.nivel(a));
}

function detalhe(db, chave, perfil, acesso) {
  const t = buscarTitulo(db, chave);
  if (!t || t.situacao !== 'publicado') throw naoEncontrado('Título');
  if (t.classificacao > limiteIdade(perfil)) throw new ErroNegocio('Este conteúdo não é permitido neste perfil.', 403, { classificacao: t.classificacao });
  const base = db.prepare(`${SELECT_CARD} WHERE t.id = ?`).get(t.id);
  const bloqueado = Boolean(base.nivel_minimo && acesso.nivel < base.nivel_minimo);

  const temporadas = t.tipo === 'serie'
    ? db.prepare('SELECT * FROM temporadas WHERE titulo_id = ? ORDER BY numero').all(t.id).map((tm) => ({
      id: tm.id,
      numero: tm.numero,
      nome: tm.nome,
      sinopse: tm.sinopse,
      ano: tm.ano,
      episodios: db.prepare(`SELECT e.id, e.numero, e.nome, e.sinopse, e.duracao_s, e.estreia, e.thumb_midia_id AS thumb,
          (e.video_midia_id IS NOT NULL) AS tem_video,
          (SELECT segundos FROM progresso pr WHERE pr.perfil_id = ? AND pr.episodio_id = e.id) AS visto_segundos,
          (SELECT concluido FROM progresso pr WHERE pr.perfil_id = ? AND pr.episodio_id = e.id) AS visto_concluido
        FROM episodios e WHERE e.temporada_id = ? AND e.situacao = 'publicado' ORDER BY e.numero`).all(perfil.id, perfil.id, tm.id)
        .map((e) => ({ ...e, tem_video: Boolean(e.tem_video), concluido: Boolean(e.visto_concluido), visto_segundos: e.visto_segundos ?? 0 })),
    }))
    : [];

  const progresso = db.prepare('SELECT * FROM progresso WHERE perfil_id = ? AND titulo_id = ? ORDER BY atualizado_em DESC LIMIT 1').get(perfil.id, t.id);
  // Próximo episódio a assistir: o primeiro não concluído, ou o primeiro de todos.
  const todos = temporadas.flatMap((tm) => tm.episodios.map((e) => ({ ...e, temporada: tm.numero, temporada_id: tm.id })));
  const proximo = todos.find((e) => !e.concluido && e.tem_video) ?? todos.find((e) => e.tem_video) ?? null;

  return {
    ...card(base),
    bloqueado,
    nome_original: t.nome_original,
    pais: t.pais,
    elenco: t.elenco,
    direcao: t.direcao,
    trailer: t.trailer_midia_id ? { midia_id: t.trailer_midia_id } : null,
    tem_video: Boolean(t.video_midia_id),
    // Qualidades disponíveis (4K, Full HD, HD, SD): a ficha mostra como selo, igual aos grandes.
    qualidades: qualidadesDoTitulo(db, t),
    estreia: t.estreia,
    temporadas,
    proximo_episodio: proximo,
    favorito: Boolean(db.prepare('SELECT 1 FROM favoritos WHERE perfil_id = ? AND titulo_id = ?').get(perfil.id, t.id)),
    progresso: progresso ? { segundos: progresso.segundos, duracao_s: progresso.duracao_s, concluido: Boolean(progresso.concluido), episodio_id: progresso.episodio_id || null } : null,
    legendas: db.prepare(`SELECT l.id, l.idioma, l.rotulo, l.padrao, l.midia_id, l.episodio_id FROM legendas l WHERE l.titulo_id = ?`).all(t.id)
      .map((l) => ({ ...l, padrao: Boolean(l.padrao) })),
    similares: marcar(db.prepare(`${SELECT_CARD}
      WHERE t.situacao = 'publicado' AND t.id <> ? AND t.classificacao <= ?
        AND (t.id IN (SELECT tg.titulo_id FROM titulo_generos tg WHERE tg.genero_id IN (SELECT genero_id FROM titulo_generos WHERE titulo_id = ?)) OR t.tipo = ?)
      ORDER BY t.original DESC, COALESCE(t.publicado_em, t.criado_em) DESC LIMIT 12`).all(t.id, limiteIdade(perfil), t.id, t.tipo), acesso),
  };
}

/** Grade do catálogo com filtros (tela "Filmes", "Séries", "Gêneros"). */
function navegar(db, perfil, acesso, { tipo = null, genero = null, ordem = 'recentes', pagina = 1, por_pagina: porPagina = 30 } = {}) {
  const filtros = ["t.situacao = 'publicado'", 't.classificacao <= ?'];
  const params = [limiteIdade(perfil)];
  if (tipo) { filtros.push('t.tipo = ?'); params.push(v.opcao(tipo, 'o tipo', ['filme', 'serie'])); }
  if (genero) {
    filtros.push('t.id IN (SELECT tg.titulo_id FROM titulo_generos tg JOIN generos g ON g.id = tg.genero_id WHERE g.slug = ? OR g.id = ?)');
    params.push(String(genero), Number(genero) || -1);
  }
  const ordens = {
    recentes: 'COALESCE(t.publicado_em, t.criado_em) DESC',
    nome: 't.nome COLLATE NOCASE',
    ano: 't.ano DESC',
  };
  const p = Math.max(1, Number(pagina) || 1);
  const n = Math.min(60, Math.max(1, Number(porPagina) || 30));
  const where = filtros.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM titulos t WHERE ${where}`).get(...params).n;
  if (ordem === 'populares') {
    // Era uma contagem no histórico para CADA título do catálogo, a cada pedido (ver
    // `audienciaPorTitulo`). Agora: pega os ids que passam no filtro, já na ordem de
    // "recentes" (que vira o desempate), ordena pela audiência dos últimos 30 dias guardada em
    // memória e só então busca os cartões da página pedida.
    const audiencia = audienciaPorTitulo(db, 30);
    const ids = db.prepare(`SELECT t.id FROM titulos t WHERE ${where} ORDER BY ${ordens.recentes}`).all(...params).map((x) => x.id);
    const pos = new Map(ids.map((id, i) => [id, i]));
    ids.sort((a, b) => ((audiencia.get(b) ?? 0) - (audiencia.get(a) ?? 0)) || (pos.get(a) - pos.get(b)));
    const itens = cartoesNaOrdem(db, ids.slice((p - 1) * n, p * n), limiteIdade(perfil));
    return { itens: marcar(itens, acesso), total, pagina: p, por_pagina: n };
  }
  const ord = ordens[ordem] ?? ordens.recentes;
  const itens = db.prepare(`${SELECT_CARD} WHERE ${where} ORDER BY ${ord} LIMIT ? OFFSET ?`).all(...params, n, (p - 1) * n);
  return { itens: marcar(itens, acesso), total, pagina: p, por_pagina: n };
}

/** Busca por título, elenco, canal e programa da grade. */
function busca(db, perfil, acesso, termo) {
  const t = String(termo ?? '').trim();
  if (t.length < 2) throw new ErroNegocio('Digite pelo menos 2 letras para buscar.', 422);
  const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const idade = limiteIdade(perfil);
  const titulos = db.prepare(`${SELECT_CARD}
    WHERE t.situacao = 'publicado' AND t.classificacao <= ?
      AND (t.nome LIKE ? ESCAPE '\\' COLLATE NOCASE OR t.nome_original LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR t.elenco LIKE ? ESCAPE '\\' COLLATE NOCASE OR t.direcao LIKE ? ESCAPE '\\' COLLATE NOCASE OR t.sinopse LIKE ? ESCAPE '\\' COLLATE NOCASE)
    ORDER BY (t.nome LIKE ? ESCAPE '\\' COLLATE NOCASE) DESC, t.nome LIMIT 40`).all(idade, like, like, like, like, like, `${t}%`);
  const canais = db.prepare(`SELECT c.id, c.numero, c.nome, c.slug, c.categoria, c.logo_midia_id AS logo FROM canais c
    WHERE c.ativo = 1 AND c.classificacao <= ? AND c.nome LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY c.ordem, c.numero LIMIT 20`).all(idade, like);
  const programas = db.prepare(`SELECT p.id, p.titulo, p.inicio, p.fim, p.canal_id, c.nome AS canal_nome, c.numero AS canal_numero, c.logo_midia_id AS canal_logo
    FROM programas p JOIN canais c ON c.id = p.canal_id
    WHERE c.ativo = 1 AND c.classificacao <= ? AND p.classificacao <= ? AND p.fim > ? AND p.titulo LIKE ? ESCAPE '\\' COLLATE NOCASE
    ORDER BY p.inicio LIMIT 20`).all(idade, idade, new Date().toISOString(), like);
  return { termo: t, titulos: marcar(titulos, acesso), canais, programas };
}

function favoritar(db, perfil, tituloId, ligado) {
  const t = buscarTitulo(db, tituloId);
  if (!t || t.situacao !== 'publicado') throw naoEncontrado('Título');
  if (ligado) db.prepare('INSERT OR IGNORE INTO favoritos (perfil_id, titulo_id, criado_em) VALUES (?, ?, ?)').run(perfil.id, t.id, agora());
  else db.prepare('DELETE FROM favoritos WHERE perfil_id = ? AND titulo_id = ?').run(perfil.id, t.id);
  return { titulo_id: t.id, favorito: Boolean(ligado) };
}

const generos = (db) => db.prepare(`SELECT g.id, g.nome, g.slug,
  (SELECT COUNT(*) FROM titulo_generos tg JOIN titulos t ON t.id = tg.titulo_id WHERE tg.genero_id = g.id AND t.situacao = 'publicado') AS titulos_n
  FROM generos g ORDER BY g.ordem, g.nome`).all();

/**
 * Pode assistir? Confere a classificação indicativa do perfil e o nível do plano assinado.
 * (A assinatura ativa já foi conferida antes, em assinaturas.exigirAcesso.)
 */
function conferirPermissao(db, { item, tipo = 'titulo', perfil, acesso }) {
  if (Number(item.classificacao) > limiteIdade(perfil)) {
    throw new ErroNegocio(`Este conteúdo é para ${item.classificacao} anos e o perfil "${perfil.nome}" não permite.`, 403,
      { motivo: 'classificacao', classificacao: item.classificacao });
  }
  if (tipo === 'canal' && !acesso.canais_ao_vivo) throw new ErroNegocio('Seu plano não inclui os canais ao vivo.', 403, { motivo: 'plano' });
  if (item.plano_minimo_id) {
    const p = db.prepare('SELECT nome, nivel FROM planos WHERE id = ?').get(item.plano_minimo_id);
    if (p && acesso.nivel < p.nivel) {
      throw new ErroNegocio(`Este conteúdo faz parte do plano ${p.nome}. Mude de plano para assistir.`, 403, { motivo: 'plano', plano: p.nome });
    }
  }
  return true;
}

module.exports = {
  SELECT_CARD, card, marcar, limiteIdade, continuarAssistindo, minhaLista, emAlta, novidades, porTipo, originais, porGenero,
  canaisAoVivo, destaques, home, detalhe, navegar, busca, favoritar, generos, buscarTitulo, conferirPermissao,
};
