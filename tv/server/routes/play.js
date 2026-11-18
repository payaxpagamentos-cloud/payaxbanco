'use strict';

const { Router } = require('express');
const config = require('../config');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const assinaturas = require('../lib/assinaturas');
const catalogo = require('../lib/catalogo');
const player = require('../lib/player');
const relay = require('../lib/relay');
const midia = require('../lib/midia');
const epg = require('../lib/epg');
const v = require('../lib/validacao');

const baseApi = () => `${config.basePath}/api`;

/**
 * Reprodução. O que precisa de sessão (abrir, sinal de vida, fechar) usa o token da conta;
 * o que o player pede sozinho (lista HLS, pedaços do sinal, vídeo e legenda) usa o token
 * de reprodução assinado, que vai na URL e vale por poucas horas.
 */
module.exports = (db, autenticado, comPerfil) => {
  const r = Router();

  const canalDe = (id) => {
    const c = db.prepare('SELECT * FROM canais WHERE id = ? AND ativo = 1').get(v.inteiro(id, 'o canal', { min: 1 }));
    if (!c) throw naoEncontrado('Canal');
    return c;
  };

  const videoPronto = (id, oQue) => {
    const m = db.prepare("SELECT * FROM midias WHERE id = ? AND tipo = 'video' AND status = 'pronta'").get(Number(id));
    if (!m) throw new ErroNegocio(`${oQue} ainda não tem vídeo disponível.`, 409);
    return m;
  };

  /** Próximo episódio publicado e com vídeo (para o "próximo episódio" no fim da reprodução). */
  const proximoEpisodio = (tituloId, episodioId) => db.prepare(`SELECT e.id, e.numero, e.nome, e.duracao_s, e.thumb_midia_id AS thumb, tm.numero AS temporada
    FROM episodios e JOIN temporadas tm ON tm.id = e.temporada_id
    WHERE e.titulo_id = ? AND e.situacao = 'publicado' AND e.video_midia_id IS NOT NULL
      AND (tm.numero, e.numero) > (SELECT tm2.numero, e2.numero FROM episodios e2 JOIN temporadas tm2 ON tm2.id = e2.temporada_id WHERE e2.id = ?)
    ORDER BY tm.numero, e.numero LIMIT 1`).get(Number(tituloId), Number(episodioId)) ?? null;

  const legendasDe = (tituloId, episodioId, token) => db.prepare(`SELECT id, idioma, rotulo, padrao, midia_id FROM legendas
    WHERE (titulo_id = ? AND episodio_id IS NULL) OR episodio_id = ? ORDER BY padrao DESC, rotulo`).all(Number(tituloId) || -1, Number(episodioId) || -1)
    .map((l) => ({ id: l.id, idioma: l.idioma, rotulo: l.rotulo, padrao: Boolean(l.padrao), url: `${baseApi()}/play/legenda/${l.midia_id}?t=${encodeURIComponent(token)}` }));

  /** Abre uma tela: confere assinatura, classificação, plano e limite de telas simultâneas. */
  r.post('/abrir', autenticado, comPerfil, (req, res) => {
    const acesso = assinaturas.exigirAcesso(db, req.usuario);
    const perfil = req.perfilView;
    const d = req.body;
    const tipo = v.opcao(d.tipo, 'o tipo de reprodução', player.TIPOS);
    const dispositivo = v.opcional(d.dispositivo, 'o aparelho', 120);

    if (tipo === 'canal') {
      const canal = canalDe(d.canal_id);
      catalogo.conferirPermissao(db, { item: canal, tipo: 'canal', perfil, acesso });
      if (canal.fonte === 'embed' ? !canal.url_embed : !canal.url_hls) {
        throw new ErroNegocio('Este canal ainda não tem sinal cadastrado. Fale com o atendimento.', 409, { motivo: 'sem_sinal' });
      }
      const { sessao, token } = player.abrirSessao(db, { usuario: req.usuario, perfil, acesso, tipo, canal, dispositivo, ip: req.ip });
      const noAr = epg.noAr(db, canal.id);
      return res.status(201).json({
        sessao_id: sessao.id,
        token,
        ao_vivo: true,
        // 'embed' abre o player oficial da emissora (não retransmitimos nada); 'hls' toca no nosso player.
        fonte: canal.fonte === 'embed'
          ? { tipo: 'embed', url: canal.url_embed, retransmitido: false, emissora: true }
          : canal.relay && config.relay.ligado
            ? { tipo: 'hls', url: `${baseApi()}/play/canal/${canal.id}/lista.m3u8?t=${encodeURIComponent(token)}`, retransmitido: true }
            : { tipo: 'hls', url: canal.url_hls, retransmitido: false },
        info: {
          titulo: canal.nome,
          subtitulo: noAr ? noAr.titulo : 'Ao vivo',
          descricao: noAr?.descricao ?? canal.descricao,
          canal: { id: canal.id, nome: canal.nome, numero: canal.numero, logo: canal.logo_midia_id },
          classificacao: Math.max(canal.classificacao, noAr?.classificacao ?? 0),
          agora: noAr ? { titulo: noAr.titulo, inicio: noAr.inicio, fim: noAr.fim, andamento: epg.andamento(noAr) } : null,
        },
        legendas: [],
        retomar_s: 0,
        limites: { telas: acesso.telas, qualidade: acesso.qualidade },
      });
    }

    // Sob demanda: filme, episódio ou trailer.
    const titulo = catalogo.buscarTitulo(db, v.inteiro(d.titulo_id, 'o título', { min: 1 }));
    if (!titulo || titulo.situacao !== 'publicado') throw naoEncontrado('Título');
    catalogo.conferirPermissao(db, { item: titulo, tipo: 'titulo', perfil, acesso });

    let episodio = null;
    let m;
    if (tipo === 'episodio') {
      episodio = db.prepare("SELECT e.*, tm.numero AS temporada FROM episodios e JOIN temporadas tm ON tm.id = e.temporada_id WHERE e.id = ? AND e.titulo_id = ? AND e.situacao = 'publicado'")
        .get(v.inteiro(d.episodio_id, 'o episódio', { min: 1 }), titulo.id);
      if (!episodio) throw naoEncontrado('Episódio');
      m = videoPronto(episodio.video_midia_id, 'Este episódio');
    } else if (tipo === 'trailer') {
      m = videoPronto(titulo.trailer_midia_id, 'Este título');
    } else {
      if (titulo.tipo !== 'filme') throw new ErroNegocio('Este título é uma série: escolha um episódio.', 422);
      m = videoPronto(titulo.video_midia_id, 'Este filme');
    }

    const { sessao, token } = player.abrirSessao(db, {
      usuario: req.usuario, perfil, acesso, tipo, titulo, episodio, midiaId: m.id, dispositivo, ip: req.ip,
      qualidade: m.qualidade && m.qualidade !== acesso.qualidade ? m.qualidade : acesso.qualidade,
    });
    const retomar = tipo === 'trailer' ? 0 : player.retomarEm(db, perfil.id, titulo.id, episodio?.id ?? 0);
    res.status(201).json({
      sessao_id: sessao.id,
      token,
      ao_vivo: false,
      fonte: { tipo: 'video', url: `${baseApi()}/play/video/${m.id}?t=${encodeURIComponent(token)}`, mime: m.mime, duracao_s: m.duracao_s, qualidade: m.qualidade },
      info: {
        titulo: titulo.nome,
        subtitulo: episodio ? `T${episodio.temporada} E${episodio.numero} · ${episodio.nome}` : tipo === 'trailer' ? 'Trailer' : null,
        descricao: episodio?.sinopse ?? titulo.sinopse,
        titulo_id: titulo.id,
        episodio_id: episodio?.id ?? null,
        classificacao: titulo.classificacao,
        capa: titulo.capa_midia_id,
      },
      legendas: tipo === 'trailer' ? [] : legendasDe(titulo.id, episodio?.id, token),
      retomar_s: retomar,
      proximo_episodio: episodio ? proximoEpisodio(titulo.id, episodio.id) : null,
      download: acesso.downloads && tipo !== 'trailer' ? `${baseApi()}/play/baixar/${m.id}?t=${encodeURIComponent(token)}` : null,
      limites: { telas: acesso.telas, qualidade: acesso.qualidade },
    });
  });

  /** Sinal de vida da tela: segura a vaga do plano e guarda onde o assinante parou. */
  r.post('/ping', autenticado, (req, res) => res.json(player.ping(db, req.usuario.id, v.inteiro(req.body.sessao_id, 'a tela', { min: 1 }), {
    segundos: req.body.segundos ?? null,
    posicao: req.body.posicao ?? null,
    duracao: req.body.duracao ?? null,
  })));

  r.post('/fechar', autenticado, (req, res) => res.json(player.fechar(db, req.usuario.id, v.inteiro(req.body.sessao_id, 'a tela', { min: 1 }), req.body.motivo ?? 'fim')));

  // ---------- O que o player busca sozinho (token na URL) ----------

  /**
   * Lista HLS do canal, retransmitida pelo nosso servidor: os endereços dos pedaços são
   * reescritos para cá, então a origem da emissora não aparece para o assinante.
   */
  r.get('/canal/:id/lista.m3u8', async (req, res, next) => {
    try {
      const canal = canalDe(req.params.id);
      const token = String(req.query.t ?? '');
      player.conferirToken(db, token, { tipo: 'canal', canalId: canal.id });
      if (!canal.relay || !config.relay.ligado) throw new ErroNegocio('Este canal não é retransmitido pelo servidor.', 409);
      const url = req.query.u ? relay.lerUrlAssinada(canal.id, req.query.u) : canal.url_hls;
      if (!url) throw new ErroNegocio('Endereço de lista inválido.', 403);
      const lista = await relay.listaReescrita(canal, { url, playToken: token, baseApi: baseApi() });
      res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      }).send(lista);
    } catch (err) {
      next(err);
    }
  });

  /** Pedaço do sinal ao vivo (segmento, chave ou cabeçalho), repassado em fluxo. */
  r.get('/canal/:id/segmento', async (req, res, next) => {
    try {
      const canalId = v.inteiro(req.params.id, 'o canal', { min: 1 });
      // Sem conferir a sessão no banco: são muitos pedaços por minuto. A assinatura do token e do
      // endereço já amarram o pedaço ao canal e à tela, e a lista (que a sessão confere) expira em segundos.
      player.conferirToken(db, String(req.query.t ?? ''), { tipo: 'canal', canalId, exigirSessaoViva: false });
      const url = relay.lerUrlAssinada(canalId, req.query.u);
      if (!url) throw new ErroNegocio('Endereço de pedaço inválido.', 403);
      await relay.repassarSegmento(req, res, url);
    } catch (err) {
      next(err);
    }
  });

  /** Vídeo sob demanda, com Range (o player adianta e volta sem baixar tudo). */
  r.get('/video/:id', (req, res) => {
    const id = v.inteiro(req.params.id, 'o vídeo', { min: 1 });
    player.conferirToken(db, String(req.query.t ?? ''), { midiaId: id, exigirSessaoViva: false });
    const m = midia.buscar(db, id);
    if (m.tipo !== 'video' || m.status !== 'pronta') throw new ErroNegocio('Vídeo não disponível.', 409);
    midia.enviar(req, res, m);
  });

  r.get('/legenda/:id', (req, res) => {
    const id = v.inteiro(req.params.id, 'a legenda', { min: 1 });
    const t = player.conferirToken(db, String(req.query.t ?? ''), { exigirSessaoViva: false });
    const l = db.prepare(`SELECT * FROM legendas WHERE midia_id = ? AND ((titulo_id = ? AND episodio_id IS NULL) OR episodio_id = ?)`)
      .get(id, Number(t.i) || -1, Number(t.e) || -1);
    if (!l) throw naoEncontrado('Legenda');
    const m = midia.buscar(db, id);
    midia.enviar(req, res, m, { cache: 'private, max-age=3600' });
  });

  /** Download para assistir sem internet (só nos planos que incluem). */
  r.get('/baixar/:id', (req, res) => {
    const id = v.inteiro(req.params.id, 'o vídeo', { min: 1 });
    const t = player.conferirToken(db, String(req.query.t ?? ''), { midiaId: id, exigirSessaoViva: false });
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(t.u);
    if (!usuario) throw naoEncontrado('Conta');
    const acesso = assinaturas.acessoDe(db, usuario);
    if (!acesso.ativa) throw new ErroNegocio('Assinatura sem acesso ativo.', 402);
    if (!acesso.downloads) throw new ErroNegocio('Seu plano não inclui downloads.', 403, { motivo: 'plano' });
    const m = midia.buscar(db, id);
    if (m.tipo !== 'video' || m.status !== 'pronta') throw new ErroNegocio('Vídeo não disponível.', 409);
    midia.enviar(req, res, m, { download: true });
  });

  return r;
};
