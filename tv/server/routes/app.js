'use strict';

const { Router } = require('express');
const { naoEncontrado } = require('../lib/erros');
const { hoje, somarDias, inicioDia } = require('../lib/datas');
const assinaturas = require('../lib/assinaturas');
const catalogo = require('../lib/catalogo');
const player = require('../lib/player');
const epg = require('../lib/epg');
const v = require('../lib/validacao');
const embed = require('../lib/embed');
const aovivo = require('../lib/aovivo');
const { memoriaPorBanco } = require('../lib/memoria');

// O guia pronto, em texto, por faixa etária e plano (ver a rota /guia).
const memoriaGuia = memoriaPorBanco({ validadeMs: 30_000, maximo: 80 });

/**
 * O que o assinante vê. Toda rota aqui exige assinatura ativa (402 quando falta):
 * a tela leva direto para os planos.
 */
module.exports = (db) => {
  const r = Router();

  // Assinatura ativa (ou acesso da operação) em tudo.
  r.use((req, _res, next) => {
    req.acesso = assinaturas.exigirAcesso(db, req.usuario);
    next();
  });

  r.get('/home', (req, res) => res.json({
    perfil: { id: req.perfilView.id, nome: req.perfilView.nome, infantil: Boolean(req.perfilView.infantil), classificacao_max: req.perfilView.classificacao_max },
    plano: { nome: req.acesso.plano?.nome ?? null, qualidade: req.acesso.qualidade, telas: req.acesso.telas, downloads: req.acesso.downloads },
    ...catalogo.home(db, req.perfilView, req.acesso),
  }));

  r.get('/canais', (req, res) => res.json({ canais: catalogo.canaisAoVivo(db, req.perfilView, req.acesso) }));

  r.get('/canais/:id', (req, res) => {
    const id = v.inteiro(req.params.id, 'o canal', { min: 1 });
    const canal = catalogo.canaisAoVivo(db, req.perfilView, req.acesso).find((c) => c.id === id);
    if (!canal) throw naoEncontrado('Canal');
    const de = new Date(Date.now() - 2 * 3600_000).toISOString();
    const ate = new Date(Date.now() + 36 * 3600_000).toISOString();
    res.json({ canal, grade: epg.grade(db, { canalId: id, de, ate }).map((p) => ({ ...p, ao_vivo: Boolean(p.ao_vivo), andamento: epg.andamento(p) })) });
  });

  /**
   * Aviso de intenção: o assinante parou num canal e provavelmente vai abrir. Se couber, o
   * canal começa a subir já (ver `aovivo.aquecer`). Não abre tela, não ocupa vaga do plano e
   * passa pelas mesmas permissões de abrir — canal bloqueado ou fora da faixa etária não liga.
   */
  r.post('/canais/:id/aquecer', (req, res) => {
    const id = v.inteiro(req.params.id, 'o canal', { min: 1 });
    const visivel = catalogo.canaisAoVivo(db, req.perfilView, req.acesso).find((c) => c.id === id);
    if (!visivel) throw naoEncontrado('Canal');
    if (visivel.bloqueado || visivel.fonte !== 'rtmp') return res.json({ aquecendo: false, motivo: 'nao_se_aplica' });
    const canal = db.prepare("SELECT id, numero, nome, url_hls, sinal_video, sinal_audio, melhoria FROM canais WHERE id = ? AND ativo = 1 AND fonte = 'rtmp' AND url_hls IS NOT NULL AND url_hls <> ''").get(id);
    if (!canal) return res.json({ aquecendo: false, motivo: 'nao_se_aplica' });
    return res.json(aovivo.aquecer(canal, db, req.usuario.id));
  });

  /**
   * Guia de programação: a grade de todos os canais num período.
   * Sem dia, a janela começa um pouco antes de agora — assim o programa no ar sempre aparece,
   * mesmo que o aparelho esteja num fuso diferente do da operação.
   */
  /**
   * Um programa da grade, com a descrição. A grade não a traz: ela sozinha respondia por 2,5 MB
   * dos 3,1 MB do guia, e só aparece quando alguém toca num programa.
   */
  r.get('/programa/:id', (req, res) => {
    const p = epg.programa(db, v.inteiro(req.params.id, 'o programa', { min: 1 }));
    if (!p) throw naoEncontrado('Programa');
    if (p.classificacao > (req.perfilView.classificacao_max ?? 18)) throw naoEncontrado('Programa');
    return res.json({ programa: p });
  });

  r.get('/guia', (req, res) => {
    const diaPedido = req.query.dia ? v.data(req.query.dia, 'o dia') : null;
    const dia = diaPedido ?? hoje();
    const de = req.query.de ? v.instante(req.query.de, 'o início')
      : diaPedido ? inicioDia(diaPedido) : new Date(Date.now() - 2 * 3600_000).toISOString();
    const ate = req.query.ate ? v.instante(req.query.ate, 'o fim')
      : diaPedido ? inicioDia(somarDias(diaPedido, 1)) : new Date(Date.now() + 36 * 3600_000).toISOString();
    const montar = () => {
      const canais = catalogo.canaisAoVivo(db, req.perfilView, req.acesso);
      // Agrupa numa passada. Antes cada canal filtrava a lista inteira de programas: com 116
      // canais e ~6 mil programas na janela, eram quase 700 mil comparações por pedido.
      const porCanal = new Map();
      for (const p of epg.grade(db, { de, ate })) {
        let lista = porCanal.get(p.canal_id);
        if (!lista) porCanal.set(p.canal_id, lista = []);
        lista.push({
          // Sem `descricao` de propósito: ela vem por /tv/programa/:id quando a janela abre.
          id: p.id, titulo: p.titulo, subtitulo: p.subtitulo, inicio: p.inicio, fim: p.fim,
          classificacao: p.classificacao, categoria: p.categoria, ao_vivo: Boolean(p.ao_vivo), andamento: epg.andamento(p),
        });
      }
      return JSON.stringify({ dia, de, ate, canais: canais.map((c) => ({ ...c, programas: porCanal.get(c.id) ?? [] })) });
    };
    // O guia é a resposta mais pesada da plataforma (mais de 1 MB antes de comprimir) e sai
    // igual para todo mundo que tem a mesma faixa etária e o mesmo plano. Guardado já em texto,
    // por 30 s: quem pede em seguida recebe a cópia pronta, sem consulta e sem montar o JSON de
    // novo. Só o pedido sem instante próprio entra aqui — "agora" e "o dia tal" são poucas
    // chaves; um `de`/`ate` qualquer viraria uma chave por pedido.
    const proprio = Boolean(req.query.de || req.query.ate);
    const corpo = proprio ? montar() : memoriaGuia(db).obter(
      [req.perfilView.classificacao_max, req.perfilView.infantil, req.acesso.nivel, req.acesso.canais_ao_vivo, diaPedido ?? 'agora', embed.versaoAtual()].join('|'),
      montar,
    );
    res.type('application/json').send(corpo);
  });

  r.get('/catalogo', (req, res) => res.json(catalogo.navegar(db, req.perfilView, req.acesso, req.query)));
  r.get('/generos', (req, res) => res.json({ generos: catalogo.generos(db) }));
  r.get('/busca', (req, res) => res.json(catalogo.busca(db, req.perfilView, req.acesso, req.query.q)));
  r.get('/titulos/:chave', (req, res) => res.json({ titulo: catalogo.detalhe(db, req.params.chave, req.perfilView, req.acesso) }));

  r.get('/minha-lista', (req, res) => res.json({ itens: catalogo.marcar(catalogo.minhaLista(db, req.perfilView), req.acesso) }));
  r.post('/minha-lista/:id', (req, res) => res.json(catalogo.favoritar(db, req.perfilView, req.params.id, true)));
  r.delete('/minha-lista/:id', (req, res) => res.json(catalogo.favoritar(db, req.perfilView, req.params.id, false)));

  r.get('/continuar', (req, res) => res.json({ itens: catalogo.continuarAssistindo(db, req.perfilView) }));

  /** Guarda onde parou (o player manda de tempo em tempo e ao sair). */
  r.post('/progresso', (req, res) => {
    const d = req.body;
    const saida = player.registrarProgresso(db, req.perfilView.id, {
      titulo_id: v.inteiro(d.titulo_id, 'o título', { min: 1 }),
      episodio_id: v.inteiroOpcional(d.episodio_id, 'o episódio', { min: 1 }) ?? 0,
      segundos: v.numero(d.segundos, 'a posição', { min: 0, max: 86_400 }),
      duracao_s: v.numero(d.duracao_s ?? 0, 'a duração', { min: 0, max: 86_400 }),
    });
    res.json(saida);
  });

  /** Tira um item de "Continuar assistindo". */
  r.delete('/continuar/:id', (req, res) => {
    db.prepare('DELETE FROM progresso WHERE perfil_id = ? AND titulo_id = ?').run(req.perfilView.id, v.inteiro(req.params.id, 'o título', { min: 1 }));
    res.status(204).end();
  });

  return r;
};
