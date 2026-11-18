'use strict';

const { Router } = require('express');
const express = require('express');
const config = require('../config');
const { agora, transacao, slug, lerConfig, gravarConfig } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { permitir } = require('../auth');
const midia = require('../lib/midia');
const relay = require('../lib/relay');
const epg = require('../lib/epg');
const embed = require('../lib/embed');
const { CANAIS_ABERTOS, AVISO_NUMEROS } = require('../lib/tv-aberta');
const listasPublicas = require('../lib/listas-publicas');
const player = require('../lib/player');
const versoes = require('../lib/versoes');
const transcodificar = require('../lib/transcodificar');
const qualidades = require('../lib/qualidades');
const v = require('../lib/validacao');

const CATEGORIAS = ['aberta', 'noticias', 'esportes', 'filmes', 'series', 'infantil', 'documentarios', 'musica', 'variedades', 'religioso', 'local'];

/** Ingestão e curadoria: canais, grade, catálogo, arquivos de vídeo, destaques e fileiras da home. */
module.exports = (db) => {
  const r = Router();

  const slugLivre = (tabela, nome, id = null) => {
    const base = slug(nome);
    let tentativa = base;
    for (let i = 2; db.prepare(`SELECT 1 FROM ${tabela} WHERE slug = ? AND id <> ?`).get(tentativa, Number(id) || -1); i += 1) tentativa = `${base}-${i}`;
    return tentativa;
  };
  const achar = (tabela, id, oQue) => {
    const x = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(v.inteiro(id, 'o registro', { min: 1 }));
    if (!x) throw naoEncontrado(oQue);
    return x;
  };
  const midiaPronta = (id, tipo, oQue) => {
    if (id === null || id === undefined || id === '') return null;
    const m = midia.buscar(db, id);
    if (m.tipo !== tipo || m.status !== 'pronta') throw new ErroNegocio(`${oQue}: o arquivo enviado não está pronto.`, 409);
    return m.id;
  };

  // ---------------- Canais ao vivo ----------------

  r.get('/canais', (req, res) => res.json({
    canais: db.prepare(`SELECT c.*, p.nome AS plano_nome, (SELECT COUNT(*) FROM programas pr WHERE pr.canal_id = c.id AND pr.fim > ?) AS programas_futuros
      FROM canais c LEFT JOIN planos p ON p.id = c.plano_minimo_id ORDER BY c.ordem, c.numero`).all(new Date().toISOString())
      .map((c) => ({ ...c, ativo: Boolean(c.ativo), relay: Boolean(c.relay), agora: epg.noAr(db, c.id) })),
    relay_ligado: config.relay.ligado,
  }));

  const dadosCanal = (d, id = null) => {
    const fonte = v.opcao(d.fonte ?? 'hls', 'a forma de transmissão', ['hls', 'embed']);
    const ativo = v.booleano(d.ativo, true) ? 1 : 0;
    const urlHls = v.urlHls(d.url_hls, { obrigatorio: false });
    const urlEmbed = d.url_embed ? embed.normalizar(d.url_embed).url : null;
    // Um canal só vai ao ar com endereço: sem ele, fica cadastrado e desligado.
    if (ativo && fonte === 'hls' && !urlHls) {
      throw new ErroNegocio('Cadastre o endereço do sinal (.m3u8) ou deixe o canal desligado até ele chegar.', 422);
    }
    if (ativo && fonte === 'embed' && !urlEmbed) {
      throw new ErroNegocio('Cadastre o endereço do player oficial da emissora ou deixe o canal desligado.', 422);
    }
    return {
    numero: v.inteiro(d.numero, 'o número do canal', { min: 1, max: 9999 }),
    nome: v.texto(d.nome, 'o nome do canal', 80),
    descricao: v.opcional(d.descricao, 'a descrição', 500),
    categoria: v.opcao(d.categoria ?? 'aberta', 'a categoria', CATEGORIAS),
    fonte,
    url_hls: urlHls,
    url_embed: urlEmbed,
    observacao: v.opcional(d.observacao, 'a observação', 1000),
    relay: v.booleano(d.relay, true) ? 1 : 0,
    logo_midia_id: midiaPronta(d.logo_midia_id, 'imagem', 'Logo do canal'),
    plano_minimo_id: d.plano_minimo_id ? achar('planos', d.plano_minimo_id, 'Plano').id : null,
    classificacao: v.classificacao(d.classificacao),
    regiao: v.opcional(d.regiao, 'a região', 60),
    ordem: v.inteiro(d.ordem ?? 0, 'a ordem', { min: 0, max: 9999 }),
    ativo,
    slug: slugLivre('canais', d.slug || d.nome, id),
    };
  };

  r.post('/canais', (req, res) => {
    const c = dadosCanal(req.body);
    const r2 = db.prepare(`INSERT INTO canais (numero, nome, slug, descricao, categoria, fonte, url_hls, url_embed, observacao, relay, logo_midia_id,
        plano_minimo_id, classificacao, regiao, ordem, ativo, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.numero, c.nome, c.slug, c.descricao, c.categoria, c.fonte, c.url_hls,
      c.url_embed, c.observacao, c.relay, c.logo_midia_id, c.plano_minimo_id, c.classificacao, c.regiao, c.ordem, c.ativo, agora(), agora());
    const canal = achar('canais', Number(r2.lastInsertRowid), 'Canal');
    embed.invalidar();
    registrar(db, req, 'canal_criado', { id: canal.id, nome: canal.nome });
    res.status(201).json({ canal });
  });

  r.patch('/canais/:id', (req, res) => {
    const atual = achar('canais', req.params.id, 'Canal');
    const c = dadosCanal({ ...atual, ...req.body }, atual.id);
    db.prepare(`UPDATE canais SET numero = ?, nome = ?, slug = ?, descricao = ?, categoria = ?, fonte = ?, url_hls = ?, url_embed = ?, observacao = ?,
        relay = ?, logo_midia_id = ?, plano_minimo_id = ?, classificacao = ?, regiao = ?, ordem = ?, ativo = ?, atualizado_em = ? WHERE id = ?`)
      .run(c.numero, c.nome, c.slug, c.descricao, c.categoria, c.fonte, c.url_hls, c.url_embed, c.observacao, c.relay, c.logo_midia_id,
        c.plano_minimo_id, c.classificacao, c.regiao, c.ordem, c.ativo, agora(), atual.id);
    // Trocou o endereço do sinal: o cache da lista antiga não serve mais.
    if (atual.url_hls && c.url_hls !== atual.url_hls) relay.cacheLista.delete(atual.url_hls);
    embed.invalidar();
    registrar(db, req, 'canal_alterado', { id: atual.id, nome: c.nome });
    res.json({ canal: achar('canais', atual.id, 'Canal') });
  });

  r.delete('/canais/:id', (req, res) => {
    const c = achar('canais', req.params.id, 'Canal');
    transacao(db, () => {
      db.prepare('DELETE FROM programas WHERE canal_id = ?').run(c.id);
      db.prepare('DELETE FROM destaques WHERE canal_id = ?').run(c.id);
      db.prepare('DELETE FROM canais WHERE id = ?').run(c.id);
    });
    embed.invalidar();
    registrar(db, req, 'canal_excluido', { id: c.id, nome: c.nome });
    res.status(204).end();
  });

  /**
   * Deixa a TV aberta inteira cadastrada de uma vez (número, categoria, logo e o lembrete de
   * onde pedir o sinal). Os canais nascem desligados: cada um entra no ar quando a operação
   * cadastra o endereço do sinal ou o player oficial da emissora.
   */
  r.post('/canais/importar-abertos', (req, res) => {
    const criados = [];
    const existentes = [];
    transacao(db, () => {
      for (const [numero, nome, categoria, grupo, observacao] of CANAIS_ABERTOS) {
        const ja = db.prepare('SELECT id FROM canais WHERE slug = ? OR numero = ?').get(slug(nome), numero);
        if (ja) { existentes.push(nome); continue; }
        const r2 = db.prepare(`INSERT INTO canais (numero, nome, slug, descricao, categoria, fonte, observacao, relay, classificacao, regiao, ordem, ativo, criado_em, atualizado_em)
          VALUES (?, ?, ?, ?, ?, 'hls', ?, 1, 0, 'Nacional', ?, 0, ?, ?)`)
          .run(numero, nome, slug(nome), grupo, categoria, observacao, numero, agora(), agora());
        criados.push({ id: Number(r2.lastInsertRowid), nome, numero });
      }
    });
    registrar(db, req, 'canais_abertos_importados', { criados: criados.length });
    res.json({
      criados: criados.length,
      ja_existiam: existentes.length,
      canais: criados,
      aviso: AVISO_NUMEROS,
      proximo_passo: 'Os canais entraram desligados. Em cada um, cadastre o endereço do sinal (.m3u8) que a emissora fornece ou o endereço do player oficial dela, e ligue o canal.',
    });
  });

  /**
   * Catálogo aberto de canais (projeto iptv-org): mostra o que existe para o país,
   * já com o melhor sinal de cada canal, para a operação escolher o que importar.
   */
  r.get('/canais/lista-publica', async (req, res, next) => {
    try {
      const pais = String(req.query.pais ?? 'BR').toUpperCase().slice(0, 2);
      const canais = await listasPublicas.canaisDoPais(pais, { limite: v.inteiro(req.query.limite ?? 200, 'o limite', { min: 1, max: 500 }) });
      const jaTenho = new Set(db.prepare('SELECT slug FROM canais').all().map((x) => x.slug));
      res.json({
        pais,
        fonte: listasPublicas.FONTE_CANAIS,
        canais: canais.map((x) => ({ ...x, ja_cadastrado: jaTenho.has(slug(x.nome)) })),
      });
    } catch (err) {
      next(err);
    }
  });

  /** Importa os canais escolhidos da lista pública. Entram desligados, para a operação testar antes. */
  r.post('/canais/importar-lista-publica', async (req, res, next) => {
    try {
      const pais = String(req.body.pais ?? 'BR').toUpperCase().slice(0, 2);
      const escolhidos = Array.isArray(req.body.ids) ? new Set(req.body.ids.map(String)) : null;
      const disponiveis = await listasPublicas.canaisDoPais(pais, { limite: 500 });
      const criados = [];
      const existentes = [];
      transacao(db, () => {
        let numero = db.prepare('SELECT COALESCE(MAX(numero), 199) AS n FROM canais WHERE numero >= 200').get().n;
        for (const canal of disponiveis) {
          if (escolhidos && !escolhidos.has(canal.id)) continue;
          if (db.prepare('SELECT 1 FROM canais WHERE slug = ?').get(slug(canal.nome))) { existentes.push(canal.nome); continue; }
          numero += 1;
          const aviso = canal.avisos?.length ? ` · ${canal.avisos.join(', ')}` : '';
          const r2 = db.prepare(`INSERT INTO canais (numero, nome, slug, descricao, categoria, fonte, url_hls, cabecalhos, observacao, relay,
              classificacao, regiao, ordem, ativo, criado_em, atualizado_em)
            VALUES (?, ?, ?, ?, ?, 'hls', ?, ?, ?, 1, 0, ?, ?, 0, ?, ?)`)
            .run(numero, canal.nome, slug(canal.nome), canal.site ?? null, canal.categoria, canal.url,
              canal.cabecalhos ? JSON.stringify(canal.cabecalhos) : null,
              `Importado da lista pública (iptv-org) em ${new Date().toLocaleDateString('pt-BR')} · sinal ${canal.qualidade ?? 'sem qualidade informada'}${aviso}. Teste o sinal e confirme que pode transmitir este canal antes de ligar.`,
              pais === 'BR' ? 'Nacional' : pais, numero, agora(), agora());
          criados.push({ id: Number(r2.lastInsertRowid), nome: canal.nome, numero });
        }
      });
      embed.invalidar();
      registrar(db, req, 'canais_lista_publica_importados', { pais, criados: criados.length });
      res.json({
        criados: criados.length,
        ja_existiam: existentes.length,
        canais: criados,
        proximo_passo: 'Os canais entraram desligados, numerados a partir do 200. Clique em "Testar sinal" em cada um e ligue os que forem ficar no ar.',
      });
    } catch (err) {
      next(err);
    }
  });

  /** Testa o sinal agora (a operação clica antes de colocar o canal no ar). */
  r.post('/canais/:id/testar', async (req, res, next) => {
    try {
      const c = achar('canais', req.params.id, 'Canal');
      relay.cacheLista.delete(c.url_hls);
      res.json(await relay.verificarCanal(db, c));
    } catch (err) {
      next(err);
    }
  });

  /** Link de conferência: abre o canal no player do painel sem gastar uma tela do plano. */
  r.get('/canais/:id/previa', (req, res) => {
    const c = achar('canais', req.params.id, 'Canal');
    if (c.fonte === 'embed') {
      if (!c.url_embed) throw new ErroNegocio('Este canal ainda não tem o endereço do player oficial.', 409);
      return res.json({ tipo: 'embed', url: c.url_embed, nossos_servidores: false });
    }
    if (!c.url_hls) throw new ErroNegocio('Este canal ainda não tem o endereço do sinal.', 409);
    const token = player.emitirToken({ s: 0, u: req.usuario.id, p: 0, t: 'canal', c: c.id });
    return res.json({
      tipo: 'hls',
      url: c.relay && config.relay.ligado ? `${config.basePath}/api/play/canal/${c.id}/lista.m3u8?t=${encodeURIComponent(token)}` : c.url_hls,
      nossos_servidores: Boolean(c.relay && config.relay.ligado),
    });
  });

  // ---------------- Grade de programação ----------------

  r.get('/canais/:id/programas', (req, res) => {
    const c = achar('canais', req.params.id, 'Canal');
    const de = req.query.de ? v.instante(req.query.de, 'o início') : new Date(Date.now() - 3600_000).toISOString();
    const ate = req.query.ate ? v.instante(req.query.ate, 'o fim') : new Date(Date.now() + 7 * 86_400_000).toISOString();
    res.json({ programas: epg.grade(db, { canalId: c.id, de, ate }).map((p) => ({ ...p, ao_vivo: Boolean(p.ao_vivo) })) });
  });

  r.post('/canais/:id/programas', (req, res) => {
    const c = achar('canais', req.params.id, 'Canal');
    const p = epg.salvarPrograma(db, c.id, req.body);
    res.status(201).json({ programa: p });
  });

  r.patch('/programas/:id', (req, res) => {
    const atual = achar('programas', req.params.id, 'Programa');
    res.json({ programa: epg.salvarPrograma(db, atual.canal_id, { ...atual, ...req.body }, { id: atual.id }) });
  });

  r.delete('/programas/:id', (req, res) => {
    const p = achar('programas', req.params.id, 'Programa');
    db.prepare('DELETE FROM programas WHERE id = ?').run(p.id);
    res.status(204).end();
  });

  /** Importação de grade em XMLTV (o formato que as emissoras publicam). Envie o XML no corpo. */
  r.post('/epg/xmltv', express.text({ type: ['application/xml', 'text/xml', 'text/plain'], limit: '12mb' }), (req, res) => {
    const saida = epg.importarXmltv(db, req.body, {
      canalId: req.query.canal_id ? achar('canais', req.query.canal_id, 'Canal').id : null,
      substituir: req.query.substituir !== '0',
    });
    registrar(db, req, 'epg_importada', saida);
    res.json(saida);
  });

  /** Importa a grade de um endereço XMLTV (o provedor é escolhido pela operação). */
  r.post('/epg/importar-url', async (req, res, next) => {
    try {
      const url = v.texto(req.body.url ?? lerConfig(db).epg_url, 'o endereço do XMLTV', 1000);
      const saida = await epg.importarDeUrl(db, url, { substituir: req.body.substituir !== false });
      if (v.booleano(req.body.guardar, true)) gravarConfig(db, { epg_url: url });
      registrar(db, req, 'epg_importada_url', { url, ...saida });
      res.json(saida);
    } catch (err) {
      next(err);
    }
  });

  r.post('/epg/limpar', (req, res) => res.json({ removidos: epg.limparAntigos(db, v.inteiro(req.body.dias ?? 7, 'os dias', { min: 1, max: 365 })) }));

  // ---------------- Arquivos (vídeos, artes e legendas) ----------------

  r.get('/midias', (req, res) => {
    const tipo = req.query.tipo ? v.opcao(req.query.tipo, 'o tipo', ['video', 'imagem', 'legenda']) : null;
    res.json({
      midias: db.prepare(`SELECT m.id, m.tipo, m.nome_original, m.mime, m.tamanho, m.recebido, m.duracao_s, m.largura, m.altura, m.qualidade,
          m.idioma, m.rotulo, m.status, m.criado_em, u.nome AS enviado_por
        FROM midias m LEFT JOIN usuarios u ON u.id = m.enviado_por ${tipo ? 'WHERE m.tipo = ?' : ''}
        ORDER BY m.id DESC LIMIT 300`).all(...(tipo ? [tipo] : [])),
      limites: { video_max_mb: Math.round(config.videoMaxBytes / 1048576), arte_max_mb: Math.round(config.arteMaxBytes / 1048576),
        parte_max_mb: Math.round(config.uploadParteMaxBytes / 1048576) },
    });
  });

  /** Abre o envio de um vídeo: o painel manda o arquivo em pedaços e fecha no fim. */
  r.post('/midias/video', (req, res) => {
    const m = midia.abrirEnvioVideo(db, req.usuario, req.body);
    res.status(201).json({ midia: { id: m.id, tamanho: m.tamanho, recebido: 0 }, parte_max_bytes: config.uploadParteMaxBytes });
  });

  r.put('/midias/:id/parte', express.raw({ type: ['application/octet-stream', 'video/*'], limit: config.uploadParteMaxBytes }), (req, res) => {
    const offset = v.inteiro(req.query.offset ?? 0, 'a posição', { min: 0 });
    res.json(midia.receberParte(db, v.inteiro(req.params.id, 'o arquivo', { min: 1 }), offset, req.body));
  });

  r.post('/midias/:id/concluir', (req, res) => {
    const m = midia.concluirEnvioVideo(db, v.inteiro(req.params.id, 'o arquivo', { min: 1 }), req.body);
    registrar(db, req, 'video_enviado', { id: m.id, nome: m.nome_original, tamanho: m.tamanho });
    res.json({ midia: { id: m.id, tipo: m.tipo, mime: m.mime, tamanho: m.tamanho, duracao_s: m.duracao_s, qualidade: m.qualidade, status: m.status } });
  });

  r.post('/midias/imagem', express.raw({ type: ['image/*', 'application/octet-stream'], limit: config.arteMaxBytes }), (req, res) => {
    const m = midia.salvarImagem(db, req.usuario, req.body, { nome: req.query.nome });
    res.status(201).json({ midia: { id: m.id, tipo: m.tipo, mime: m.mime, tamanho: m.tamanho } });
  });

  r.post('/midias/legenda', express.raw({ type: ['text/vtt', 'text/plain', 'application/octet-stream'], limit: config.legendaMaxBytes }), (req, res) => {
    const m = midia.salvarLegenda(db, req.usuario, req.body, { nome: req.query.nome, idioma: req.query.idioma, rotulo: req.query.rotulo });
    res.status(201).json({ midia: { id: m.id, tipo: m.tipo, idioma: m.idioma, rotulo: m.rotulo, tamanho: m.tamanho } });
  });

  /** Link para conferir o vídeo enviado dentro do painel. */
  r.get('/midias/:id/previa', (req, res) => {
    const m = midia.buscar(db, v.inteiro(req.params.id, 'o arquivo', { min: 1 }));
    if (m.tipo !== 'video' || m.status !== 'pronta') throw new ErroNegocio('Este arquivo não é um vídeo pronto.', 409);
    const token = player.emitirToken({ s: 0, u: req.usuario.id, p: 0, t: 'trailer', m: m.id });
    res.json({ url: `${config.basePath}/api/play/video/${m.id}?t=${encodeURIComponent(token)}`, mime: m.mime, duracao_s: m.duracao_s });
  });

  r.delete('/midias/:id', (req, res) => {
    const m = midia.excluir(db, v.inteiro(req.params.id, 'o arquivo', { min: 1 }));
    registrar(db, req, 'midia_excluida', { id: m.id, nome: m.nome_original });
    res.status(204).end();
  });

  // ---------------- Catálogo (filmes e séries) ----------------

  r.get('/titulos', (req, res) => {
    const filtros = [];
    const params = [];
    if (req.query.situacao) { filtros.push('t.situacao = ?'); params.push(v.opcao(req.query.situacao, 'a situação', ['rascunho', 'publicado', 'arquivado'])); }
    if (req.query.tipo) { filtros.push('t.tipo = ?'); params.push(v.opcao(req.query.tipo, 'o tipo', ['filme', 'serie'])); }
    if (req.query.q) { filtros.push("t.nome LIKE ? ESCAPE '\\' COLLATE NOCASE"); params.push(`%${String(req.query.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    res.json({
      titulos: db.prepare(`SELECT t.id, t.tipo, t.nome, t.slug, t.ano, t.classificacao, t.situacao, t.original, t.duracao_s, t.publicado_em, t.atualizado_em,
          t.capa_midia_id AS capa, (t.video_midia_id IS NOT NULL) AS tem_video,
          (SELECT COUNT(*) FROM episodios e WHERE e.titulo_id = t.id) AS episodios_n,
          (SELECT COUNT(*) FROM episodios e WHERE e.titulo_id = t.id AND e.video_midia_id IS NOT NULL) AS episodios_com_video,
          (SELECT group_concat(g.nome, ', ') FROM titulo_generos tg JOIN generos g ON g.id = tg.genero_id WHERE tg.titulo_id = t.id) AS generos
        FROM titulos t ${where} ORDER BY t.atualizado_em DESC LIMIT 400`).all(...params)
        .map((t) => ({ ...t, original: Boolean(t.original), tem_video: Boolean(t.tem_video) })),
      generos: db.prepare('SELECT id, nome, slug FROM generos ORDER BY ordem, nome').all(),
    });
  });

  const dadosTitulo = (d, id = null) => ({
    tipo: v.opcao(d.tipo, 'o tipo', ['filme', 'serie']),
    nome: v.texto(d.nome, 'o nome', 160),
    nome_original: v.opcional(d.nome_original, 'o nome original', 160),
    sinopse: v.opcional(d.sinopse, 'a sinopse', 4000),
    ano: v.inteiroOpcional(d.ano, 'o ano', { min: 1890, max: new Date().getFullYear() + 5 }),
    pais: v.opcional(d.pais, 'o país', 60),
    classificacao: v.classificacao(d.classificacao),
    duracao_s: v.inteiroOpcional(d.duracao_s, 'a duração', { min: 0, max: 86_400 }),
    elenco: v.opcional(d.elenco, 'o elenco', 2000),
    direcao: v.opcional(d.direcao, 'a direção', 500),
    capa_midia_id: midiaPronta(d.capa_midia_id, 'imagem', 'Capa'),
    banner_midia_id: midiaPronta(d.banner_midia_id, 'imagem', 'Banner'),
    trailer_midia_id: midiaPronta(d.trailer_midia_id, 'video', 'Trailer'),
    video_midia_id: midiaPronta(d.video_midia_id, 'video', 'Vídeo'),
    plano_minimo_id: d.plano_minimo_id ? achar('planos', d.plano_minimo_id, 'Plano').id : null,
    original: v.booleano(d.original) ? 1 : 0,
    estreia: d.estreia ? v.data(d.estreia, 'a data de estreia') : null,
    slug: slugLivre('titulos', d.slug || d.nome, id),
  });

  r.post('/titulos', (req, res) => {
    const t = dadosTitulo(req.body);
    const criado = transacao(db, () => {
      const r2 = db.prepare(`INSERT INTO titulos (tipo, nome, slug, nome_original, sinopse, ano, pais, classificacao, duracao_s, elenco, direcao,
          capa_midia_id, banner_midia_id, trailer_midia_id, video_midia_id, plano_minimo_id, original, estreia, criado_em, atualizado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.tipo, t.nome, t.slug, t.nome_original, t.sinopse, t.ano, t.pais,
        t.classificacao, t.duracao_s, t.elenco, t.direcao, t.capa_midia_id, t.banner_midia_id, t.trailer_midia_id, t.video_midia_id,
        t.plano_minimo_id, t.original, t.estreia, agora(), agora());
      const id = Number(r2.lastInsertRowid);
      if (Array.isArray(req.body.generos)) trocarGeneros(id, req.body.generos);
      // Série nova já nasce com a 1ª temporada (é o que a operação sempre faz em seguida).
      if (t.tipo === 'serie') db.prepare('INSERT INTO temporadas (titulo_id, numero, nome) VALUES (?, 1, ?)').run(id, 'Temporada 1');
      return id;
    });
    registrar(db, req, 'titulo_criado', { id: criado, nome: t.nome });
    res.status(201).json({ titulo: achar('titulos', criado, 'Título') });
  });

  const trocarGeneros = (tituloId, ids) => {
    db.prepare('DELETE FROM titulo_generos WHERE titulo_id = ?').run(Number(tituloId));
    const ins = db.prepare('INSERT OR IGNORE INTO titulo_generos (titulo_id, genero_id) VALUES (?, ?)');
    for (const g of ids.slice(0, 10)) ins.run(Number(tituloId), v.inteiro(g, 'o gênero', { min: 1 }));
  };

  r.get('/titulos/:id', (req, res) => {
    const t = achar('titulos', req.params.id, 'Título');
    res.json({
      titulo: { ...t, original: Boolean(t.original) },
      generos: db.prepare('SELECT genero_id FROM titulo_generos WHERE titulo_id = ?').all(t.id).map((g) => g.genero_id),
      temporadas: db.prepare('SELECT * FROM temporadas WHERE titulo_id = ? ORDER BY numero').all(t.id).map((tm) => ({
        ...tm,
        episodios: db.prepare('SELECT * FROM episodios WHERE temporada_id = ? ORDER BY numero').all(tm.id),
      })),
      legendas: db.prepare('SELECT * FROM legendas WHERE titulo_id = ? OR episodio_id IN (SELECT id FROM episodios WHERE titulo_id = ?)').all(t.id, t.id),
      versoes: db.prepare(`SELECT v.*, m.nome_original, m.largura, m.altura, m.tamanho, m.duracao_s FROM versoes v JOIN midias m ON m.id = v.midia_id
        WHERE v.titulo_id = ? OR v.episodio_id IN (SELECT id FROM episodios WHERE titulo_id = ?)
        ORDER BY v.episodio_id, v.qualidade`).all(t.id, t.id),
    });
  });

  r.patch('/titulos/:id', (req, res) => {
    const atual = achar('titulos', req.params.id, 'Título');
    const t = dadosTitulo({ ...atual, ...req.body }, atual.id);
    db.prepare(`UPDATE titulos SET tipo = ?, nome = ?, slug = ?, nome_original = ?, sinopse = ?, ano = ?, pais = ?, classificacao = ?, duracao_s = ?,
        elenco = ?, direcao = ?, capa_midia_id = ?, banner_midia_id = ?, trailer_midia_id = ?, video_midia_id = ?, plano_minimo_id = ?,
        original = ?, estreia = ?, atualizado_em = ? WHERE id = ?`)
      .run(t.tipo, t.nome, t.slug, t.nome_original, t.sinopse, t.ano, t.pais, t.classificacao, t.duracao_s, t.elenco, t.direcao,
        t.capa_midia_id, t.banner_midia_id, t.trailer_midia_id, t.video_midia_id, t.plano_minimo_id, t.original, t.estreia, agora(), atual.id);
    if (Array.isArray(req.body.generos)) trocarGeneros(atual.id, req.body.generos);
    registrar(db, req, 'titulo_alterado', { id: atual.id, nome: t.nome });
    res.json({ titulo: achar('titulos', atual.id, 'Título') });
  });

  /** Publicar: confere se há o que assistir antes de deixar o título no ar. */
  r.post('/titulos/:id/situacao', (req, res) => {
    const t = achar('titulos', req.params.id, 'Título');
    const situacao = v.opcao(req.body.situacao, 'a situação', ['rascunho', 'publicado', 'arquivado']);
    if (situacao === 'publicado') {
      if (t.tipo === 'filme' && !t.video_midia_id) throw new ErroNegocio('Envie o vídeo do filme antes de publicar.', 409);
      if (t.tipo === 'serie') {
        const comVideo = db.prepare("SELECT COUNT(*) AS n FROM episodios WHERE titulo_id = ? AND video_midia_id IS NOT NULL AND situacao = 'publicado'").get(t.id).n;
        if (!comVideo) throw new ErroNegocio('Publique pelo menos um episódio com vídeo antes de publicar a série.', 409);
      }
      if (!t.capa_midia_id) throw new ErroNegocio('Envie a capa antes de publicar.', 409);
    }
    db.prepare('UPDATE titulos SET situacao = ?, publicado_em = CASE WHEN ? = \'publicado\' AND publicado_em IS NULL THEN ? ELSE publicado_em END, atualizado_em = ? WHERE id = ?')
      .run(situacao, situacao, agora(), agora(), t.id);
    registrar(db, req, 'titulo_situacao', { id: t.id, nome: t.nome, situacao });
    res.json({ titulo: achar('titulos', t.id, 'Título') });
  });

  r.delete('/titulos/:id', permitir('admin'), (req, res) => {
    const t = achar('titulos', req.params.id, 'Título');
    transacao(db, () => {
      db.prepare('DELETE FROM progresso WHERE titulo_id = ?').run(t.id);
      db.prepare('DELETE FROM favoritos WHERE titulo_id = ?').run(t.id);
      db.prepare('DELETE FROM titulos WHERE id = ?').run(t.id);
    });
    registrar(db, req, 'titulo_excluido', { id: t.id, nome: t.nome });
    res.status(204).end();
  });

  // ---------------- Temporadas e episódios ----------------

  r.post('/titulos/:id/temporadas', (req, res) => {
    const t = achar('titulos', req.params.id, 'Título');
    if (t.tipo !== 'serie') throw new ErroNegocio('Só séries têm temporadas.', 409);
    const numero = v.inteiro(req.body.numero ?? (db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM temporadas WHERE titulo_id = ?').get(t.id).n),
      'o número da temporada', { min: 1, max: 100 });
    const r2 = db.prepare('INSERT INTO temporadas (titulo_id, numero, nome, sinopse, ano) VALUES (?, ?, ?, ?, ?)')
      .run(t.id, numero, v.opcional(req.body.nome, 'o nome', 120) ?? `Temporada ${numero}`, v.opcional(req.body.sinopse, 'a sinopse', 2000),
        v.inteiroOpcional(req.body.ano, 'o ano', { min: 1890, max: new Date().getFullYear() + 5 }));
    res.status(201).json({ temporada: achar('temporadas', Number(r2.lastInsertRowid), 'Temporada') });
  });

  r.patch('/temporadas/:id', (req, res) => {
    const tm = achar('temporadas', req.params.id, 'Temporada');
    db.prepare('UPDATE temporadas SET nome = ?, sinopse = ?, ano = ? WHERE id = ?')
      .run(v.opcional(req.body.nome ?? tm.nome, 'o nome', 120), v.opcional(req.body.sinopse ?? tm.sinopse, 'a sinopse', 2000),
        v.inteiroOpcional(req.body.ano ?? tm.ano, 'o ano', { min: 1890, max: new Date().getFullYear() + 5 }), tm.id);
    res.json({ temporada: achar('temporadas', tm.id, 'Temporada') });
  });

  r.delete('/temporadas/:id', (req, res) => {
    const tm = achar('temporadas', req.params.id, 'Temporada');
    db.prepare('DELETE FROM temporadas WHERE id = ?').run(tm.id);
    res.status(204).end();
  });

  const dadosEpisodio = (d, temporada) => ({
    numero: v.inteiro(d.numero, 'o número do episódio', { min: 1, max: 10_000 }),
    nome: v.texto(d.nome, 'o nome do episódio', 160),
    sinopse: v.opcional(d.sinopse, 'a sinopse', 2000),
    duracao_s: v.inteiroOpcional(d.duracao_s, 'a duração', { min: 0, max: 86_400 }),
    video_midia_id: midiaPronta(d.video_midia_id, 'video', 'Vídeo do episódio'),
    thumb_midia_id: midiaPronta(d.thumb_midia_id, 'imagem', 'Miniatura'),
    estreia: d.estreia ? v.data(d.estreia, 'a data de estreia') : null,
    situacao: v.opcao(d.situacao ?? 'rascunho', 'a situação', ['rascunho', 'publicado']),
    temporada_id: temporada.id,
    titulo_id: temporada.titulo_id,
  });

  r.post('/temporadas/:id/episodios', (req, res) => {
    const tm = achar('temporadas', req.params.id, 'Temporada');
    const proximo = db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM episodios WHERE temporada_id = ?').get(tm.id).n;
    const e = dadosEpisodio({ numero: proximo, ...req.body }, tm);
    if (e.situacao === 'publicado' && !e.video_midia_id) throw new ErroNegocio('Envie o vídeo antes de publicar o episódio.', 409);
    const r2 = db.prepare(`INSERT INTO episodios (titulo_id, temporada_id, numero, nome, sinopse, duracao_s, video_midia_id, thumb_midia_id, estreia, situacao, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.titulo_id, e.temporada_id, e.numero, e.nome, e.sinopse, e.duracao_s, e.video_midia_id,
      e.thumb_midia_id, e.estreia, e.situacao, agora());
    db.prepare('UPDATE titulos SET atualizado_em = ? WHERE id = ?').run(agora(), tm.titulo_id);
    res.status(201).json({ episodio: achar('episodios', Number(r2.lastInsertRowid), 'Episódio') });
  });

  r.patch('/episodios/:id', (req, res) => {
    const atual = achar('episodios', req.params.id, 'Episódio');
    const tm = achar('temporadas', atual.temporada_id, 'Temporada');
    const e = dadosEpisodio({ ...atual, ...req.body }, tm);
    if (e.situacao === 'publicado' && !e.video_midia_id) throw new ErroNegocio('Envie o vídeo antes de publicar o episódio.', 409);
    db.prepare(`UPDATE episodios SET numero = ?, nome = ?, sinopse = ?, duracao_s = ?, video_midia_id = ?, thumb_midia_id = ?, estreia = ?, situacao = ? WHERE id = ?`)
      .run(e.numero, e.nome, e.sinopse, e.duracao_s, e.video_midia_id, e.thumb_midia_id, e.estreia, e.situacao, atual.id);
    db.prepare('UPDATE titulos SET atualizado_em = ? WHERE id = ?').run(agora(), atual.titulo_id);
    res.json({ episodio: achar('episodios', atual.id, 'Episódio') });
  });

  r.delete('/episodios/:id', (req, res) => {
    const e = achar('episodios', req.params.id, 'Episódio');
    transacao(db, () => {
      db.prepare('DELETE FROM progresso WHERE episodio_id = ?').run(e.id);
      db.prepare('DELETE FROM episodios WHERE id = ?').run(e.id);
    });
    res.status(204).end();
  });

  // ---------------- Legendas ----------------

  // ---------------- Versões em SD, HD, Full HD e 4K ----------------

  /**
   * Liga um arquivo já enviado a um filme ou episódio como a versão de uma qualidade.
   * O assinante vê todas no menu do player, limitado ao que o plano dele permite.
   */
  r.post('/versoes', (req, res) => {
    const d = req.body;
    const tituloId = d.titulo_id ? achar('titulos', d.titulo_id, 'Título').id : null;
    const episodioId = d.episodio_id ? achar('episodios', d.episodio_id, 'Episódio').id : null;
    if (!tituloId && !episodioId) throw new ErroNegocio('Diga de qual filme ou episódio é a versão.', 422);
    const m = midia.buscar(db, v.inteiro(d.midia_id, 'o vídeo', { min: 1 }));
    const versao = versoes.registrar(db, {
      tituloId: episodioId ? null : tituloId,
      episodioId,
      midiaId: m.id,
      // Sem qualidade informada, vale a altura do arquivo.
      qualidade: d.qualidade ?? qualidades.porMedidas(m.largura, m.altura) ?? 'hd',
    });
    registrar(db, req, 'versao_cadastrada', { id: versao.id, qualidade: versao.qualidade, titulo_id: tituloId, episodio_id: episodioId });
    res.status(201).json({ versao });
  });

  /**
   * Gera sozinho as versões menores a partir do arquivo já enviado.
   * O ffmpeg roda em segundo plano, uma conversão de cada vez.
   */
  r.post('/versoes/gerar', (req, res) => {
    const d = req.body;
    const tituloId = d.titulo_id ? achar('titulos', d.titulo_id, 'Título').id : null;
    const episodioId = d.episodio_id ? achar('episodios', d.episodio_id, 'Episódio').id : null;
    if (!tituloId && !episodioId) throw new ErroNegocio('Diga de qual filme ou episódio é a conversão.', 422);
    const resultado = transcodificar.enfileirar(db, {
      midiaId: d.midia_id,
      tituloId: episodioId ? null : tituloId,
      episodioId,
      qualidadesPedidas: Array.isArray(d.qualidades) ? d.qualidades : null,
    });
    registrar(db, req, 'conversao_enfileirada', {
      titulo_id: tituloId, episodio_id: episodioId, qualidades: resultado.criadas.map((c) => c.qualidade),
    });
    res.status(201).json(resultado);
  });

  /** Fila de conversão, para o painel acompanhar. */
  r.get('/conversoes', (req, res) => res.json({
    conversoes: transcodificar.listar(db, { limite: Number(req.query.limite) || 40 }),
    ffmpeg: transcodificar.temFfmpeg(),
  }));

  r.delete('/conversoes/:id', (req, res) => {
    res.json({ conversao: transcodificar.cancelar(db, v.inteiro(req.params.id, 'a conversão', { min: 1 })) });
  });

  r.delete('/versoes/:id', (req, res) => {
    if (!versoes.remover(db, v.inteiro(req.params.id, 'a versão', { min: 1 }))) throw naoEncontrado('Versão');
    res.status(204).end();
  });

  r.post('/legendas', (req, res) => {
    const d = req.body;
    const m = midia.buscar(db, v.inteiro(d.midia_id, 'a legenda', { min: 1 }));
    if (m.tipo !== 'legenda') throw new ErroNegocio('O arquivo enviado não é uma legenda.', 409);
    const tituloId = d.titulo_id ? achar('titulos', d.titulo_id, 'Título').id : null;
    const episodioId = d.episodio_id ? achar('episodios', d.episodio_id, 'Episódio').id : null;
    if (!tituloId && !episodioId) throw new ErroNegocio('Diga de qual filme ou episódio é a legenda.', 422);
    const r2 = db.prepare('INSERT INTO legendas (titulo_id, episodio_id, midia_id, idioma, rotulo, padrao, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(episodioId ? null : tituloId, episodioId, m.id, v.idioma(d.idioma ?? m.idioma), v.opcional(d.rotulo, 'o rótulo', 60) ?? m.rotulo ?? 'Português',
        v.booleano(d.padrao) ? 1 : 0, agora());
    res.status(201).json({ legenda: achar('legendas', Number(r2.lastInsertRowid), 'Legenda') });
  });

  r.delete('/legendas/:id', (req, res) => {
    const l = achar('legendas', req.params.id, 'Legenda');
    db.prepare('DELETE FROM legendas WHERE id = ?').run(l.id);
    res.status(204).end();
  });

  // ---------------- Destaques e fileiras da home ----------------

  r.get('/home', (req, res) => res.json({
    destaques: db.prepare(`SELECT d.*, t.nome AS titulo_nome, c.nome AS canal_nome FROM destaques d
      LEFT JOIN titulos t ON t.id = d.titulo_id LEFT JOIN canais c ON c.id = d.canal_id ORDER BY d.ordem, d.id`).all()
      .map((d) => ({ ...d, ativo: Boolean(d.ativo) })),
    fileiras: db.prepare(`SELECT f.*, g.nome AS genero_nome, (SELECT COUNT(*) FROM fileira_itens fi WHERE fi.fileira_id = f.id) AS itens_n
      FROM fileiras f LEFT JOIN generos g ON g.id = f.genero_id ORDER BY f.ordem, f.id`).all()
      .map((f) => ({ ...f, ativa: Boolean(f.ativa) })),
  }));

  r.post('/destaques', (req, res) => {
    const d = req.body;
    const tituloId = d.titulo_id ? achar('titulos', d.titulo_id, 'Título').id : null;
    const canalId = d.canal_id ? achar('canais', d.canal_id, 'Canal').id : null;
    if (!tituloId && !canalId) throw new ErroNegocio('Escolha um título ou um canal para o destaque.', 422);
    const r2 = db.prepare(`INSERT INTO destaques (titulo_id, canal_id, chamada, descricao, arte_midia_id, ordem, inicio, fim, ativo, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tituloId, canalId, v.opcional(d.chamada, 'a chamada', 120), v.opcional(d.descricao, 'a descrição', 500),
      midiaPronta(d.arte_midia_id, 'imagem', 'Arte do destaque'), v.inteiro(d.ordem ?? 0, 'a ordem', { min: 0, max: 999 }),
      d.inicio ? v.instante(d.inicio, 'o início') : null, d.fim ? v.instante(d.fim, 'o fim') : null, v.booleano(d.ativo, true) ? 1 : 0, agora());
    res.status(201).json({ destaque: achar('destaques', Number(r2.lastInsertRowid), 'Destaque') });
  });

  r.patch('/destaques/:id', (req, res) => {
    const atual = achar('destaques', req.params.id, 'Destaque');
    const d = { ...atual, ...req.body };
    db.prepare('UPDATE destaques SET chamada = ?, descricao = ?, arte_midia_id = ?, ordem = ?, inicio = ?, fim = ?, ativo = ? WHERE id = ?')
      .run(v.opcional(d.chamada, 'a chamada', 120), v.opcional(d.descricao, 'a descrição', 500), midiaPronta(d.arte_midia_id, 'imagem', 'Arte do destaque'),
        v.inteiro(d.ordem ?? 0, 'a ordem', { min: 0, max: 999 }), d.inicio ? v.instante(d.inicio, 'o início') : null,
        d.fim ? v.instante(d.fim, 'o fim') : null, v.booleano(d.ativo, true) ? 1 : 0, atual.id);
    res.json({ destaque: achar('destaques', atual.id, 'Destaque') });
  });

  r.delete('/destaques/:id', (req, res) => {
    db.prepare('DELETE FROM destaques WHERE id = ?').run(achar('destaques', req.params.id, 'Destaque').id);
    res.status(204).end();
  });

  const dadosFileira = (d) => ({
    nome: v.texto(d.nome, 'o nome da fileira', 80),
    tipo: v.opcao(d.tipo, 'o tipo', ['manual', 'novidades', 'em_alta', 'genero', 'originais', 'canais', 'filmes', 'series']),
    genero_id: d.genero_id ? achar('generos', d.genero_id, 'Gênero').id : null,
    limite: v.inteiro(d.limite ?? 20, 'o limite', { min: 1, max: 60 }),
    ordem: v.inteiro(d.ordem ?? 0, 'a ordem', { min: 0, max: 999 }),
    ativa: v.booleano(d.ativa, true) ? 1 : 0,
  });

  r.post('/fileiras', (req, res) => {
    const f = dadosFileira(req.body);
    if (f.tipo === 'genero' && !f.genero_id) throw new ErroNegocio('Escolha o gênero da fileira.', 422);
    const r2 = db.prepare('INSERT INTO fileiras (nome, tipo, genero_id, limite, ordem, ativa, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.nome, f.tipo, f.genero_id, f.limite, f.ordem, f.ativa, agora());
    res.status(201).json({ fileira: achar('fileiras', Number(r2.lastInsertRowid), 'Fileira') });
  });

  r.patch('/fileiras/:id', (req, res) => {
    const atual = achar('fileiras', req.params.id, 'Fileira');
    const f = dadosFileira({ ...atual, ...req.body });
    db.prepare('UPDATE fileiras SET nome = ?, tipo = ?, genero_id = ?, limite = ?, ordem = ?, ativa = ? WHERE id = ?')
      .run(f.nome, f.tipo, f.genero_id, f.limite, f.ordem, f.ativa, atual.id);
    res.json({ fileira: achar('fileiras', atual.id, 'Fileira') });
  });

  r.delete('/fileiras/:id', (req, res) => {
    db.prepare('DELETE FROM fileiras WHERE id = ?').run(achar('fileiras', req.params.id, 'Fileira').id);
    res.status(204).end();
  });

  /** Itens da fileira manual, na ordem em que a curadoria quer mostrar. */
  r.get('/fileiras/:id/itens', (req, res) => {
    const f = achar('fileiras', req.params.id, 'Fileira');
    res.json({
      itens: db.prepare(`SELECT fi.titulo_id, fi.ordem, t.nome, t.tipo, t.situacao, t.capa_midia_id AS capa FROM fileira_itens fi
        JOIN titulos t ON t.id = fi.titulo_id WHERE fi.fileira_id = ? ORDER BY fi.ordem, t.nome`).all(f.id),
    });
  });

  r.put('/fileiras/:id/itens', (req, res) => {
    const f = achar('fileiras', req.params.id, 'Fileira');
    const ids = Array.isArray(req.body.titulos) ? req.body.titulos : [];
    transacao(db, () => {
      db.prepare('DELETE FROM fileira_itens WHERE fileira_id = ?').run(f.id);
      const ins = db.prepare('INSERT OR IGNORE INTO fileira_itens (fileira_id, titulo_id, ordem) VALUES (?, ?, ?)');
      ids.slice(0, 60).forEach((id, i) => ins.run(f.id, achar('titulos', id, 'Título').id, i + 1));
    });
    res.json({ itens: ids.length });
  });

  /** Gêneros (a curadoria pode criar os seus). */
  r.post('/generos', (req, res) => {
    const nome = v.texto(req.body.nome, 'o nome do gênero', 40);
    const r2 = db.prepare('INSERT INTO generos (nome, slug, ordem) VALUES (?, ?, ?)')
      .run(nome, slug(nome), v.inteiro(req.body.ordem ?? 99, 'a ordem', { min: 0, max: 999 }));
    res.status(201).json({ genero: achar('generos', Number(r2.lastInsertRowid), 'Gênero') });
  });

  return r;
};
