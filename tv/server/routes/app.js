'use strict';

const { Router } = require('express');
const { naoEncontrado } = require('../lib/erros');
const { hoje, somarDias } = require('../lib/datas');
const assinaturas = require('../lib/assinaturas');
const catalogo = require('../lib/catalogo');
const player = require('../lib/player');
const epg = require('../lib/epg');
const v = require('../lib/validacao');

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

  /** Guia de programação: a grade de todos os canais num período. */
  r.get('/guia', (req, res) => {
    const dia = req.query.dia ? v.data(req.query.dia, 'o dia') : hoje();
    const de = req.query.de ? v.instante(req.query.de, 'o início') : new Date(`${dia}T00:00:00-03:00`).toISOString();
    const ate = req.query.ate ? v.instante(req.query.ate, 'o fim') : new Date(`${somarDias(dia, 1)}T00:00:00-03:00`).toISOString();
    const canais = catalogo.canaisAoVivo(db, req.perfilView, req.acesso);
    const programas = epg.grade(db, { de, ate });
    res.json({
      dia,
      de,
      ate,
      canais: canais.map((c) => ({
        ...c,
        programas: programas.filter((p) => p.canal_id === c.id).map((p) => ({
          id: p.id, titulo: p.titulo, subtitulo: p.subtitulo, descricao: p.descricao, inicio: p.inicio, fim: p.fim,
          classificacao: p.classificacao, categoria: p.categoria, ao_vivo: Boolean(p.ao_vivo), andamento: epg.andamento(p),
        })),
      })),
    });
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
