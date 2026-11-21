'use strict';

const { Router } = require('express');
const { agora, lerConfig } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const arquivos = require('../lib/arquivos');
const { estaOnline, pontoAberto } = require('../lib/monitor');
const { montarPorTela } = require('../lib/grade');
const { lerComunicado } = require('./cadastros');
const rel = require('../lib/relatorios');
const { hoje, mes, somarDias, inicioMes, fimMes } = require('../lib/datas');
const v = require('../lib/validacao');

/**
 * Portal do lojista (o comércio onde a TV está): ele vê se a TV está no ar, o que está passando,
 * escreve o aviso da própria loja, manda conteúdo do estabelecimento e acompanha o repasse.
 */
module.exports = (db) => {
  const r = Router();
  const meu = (req) => req.usuario.local_id;
  const minhaTela = (req, id) => {
    const t = db.prepare('SELECT * FROM telas WHERE id = ? AND local_id = ?').get(Number(id), meu(req));
    if (!t) throw naoEncontrado('Tela');
    return t;
  };

  r.get('/resumo', (req, res) => {
    const c = lerConfig(db);
    const competencia = mes();
    const telas = db.prepare('SELECT * FROM telas WHERE local_id = ? ORDER BY nome').all(meu(req));
    res.json({
      ponto: db.prepare('SELECT id, nome, categoria, cidade, uf, publico_dia, comissao_percentual, status FROM locais WHERE id = ?').get(meu(req)),
      aberto: pontoAberto(db, meu(req)),
      pode_avisar: Boolean(c.aviso_lojista),
      telas: telas.map((t) => ({
        id: t.id, nome: t.nome, orientacao: t.orientacao, status: t.status, online: estaOnline(t, c), pareada: Boolean(t.pareada_em),
        ultimo_contato: t.ultimo_contato, item_atual: t.item_atual, aviso: t.aviso, aviso_ate: t.aviso_ate, legenda: t.legenda,
      })),
      hoje: db.prepare(`SELECT COALESCE(SUM(insercoes), 0) AS insercoes, COALESCE(SUM(segundos), 0) AS segundos FROM resumo_dia WHERE local_id = ? AND data = ?`)
        .get(meu(req), hoje()),
      mes: db.prepare(`SELECT COALESCE(SUM(insercoes), 0) AS insercoes, COALESCE(SUM(segundos), 0) AS segundos FROM resumo_dia
        WHERE local_id = ? AND data BETWEEN ? AND ?`).get(meu(req), inicioMes(competencia), fimMes(competencia)),
      por_dia: rel.porDia(db, { de: somarDias(hoje(), -13), ate: hoje() }).map((d) => d),
      repasses: db.prepare('SELECT * FROM repasses WHERE local_id = ? ORDER BY competencia DESC LIMIT 12').all(meu(req)),
      a_receber_centavos: db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS n FROM repasses WHERE local_id = ? AND status = 'a_pagar'").get(meu(req)).n,
      midias: db.prepare('SELECT id, nome, tipo, status, motivo, duracao_s, criado_em FROM midias WHERE local_id = ? ORDER BY id DESC').all(meu(req)),
      comunicados: db.prepare("SELECT * FROM comunicados WHERE local_id = ? ORDER BY (status = 'pendente') DESC, fim DESC, id DESC LIMIT 30").all(meu(req)),
      comunicado_automatico: Boolean(c.comunicado_automatico),
    });
  });

  /** O que está no ar agora nesta TV (sem valores de campanha). */
  r.get('/telas/:id/programacao', (req, res) => {
    const t = minhaTela(req, req.params.id);
    const g = montarPorTela(db, t.id);
    res.json({
      tela: { id: t.id, nome: t.nome, orientacao: t.orientacao, online: estaOnline(t, lerConfig(db)) },
      duracao_s: g.duracao_s,
      itens: g.itens.map((i) => ({ ordem: i.ordem, nome: i.nome, tipo: i.tipo, duracao_s: i.duracao_s, publicidade: Boolean(i.campanha_id) })),
    });
  });

  /** Aviso na faixa da TV (ex.: "Hoje: pão quentinho às 17h"). A equipe pode desligar esse recurso. */
  r.put('/telas/:id/aviso', (req, res) => {
    if (!lerConfig(db).aviso_lojista) throw new ErroNegocio('O aviso pelo portal está desligado. Fale com a equipe.', 403);
    const t = minhaTela(req, req.params.id);
    const texto = req.body.aviso === null || req.body.aviso === '' ? null : v.texto(req.body.aviso, 'o aviso', 160);
    const horas = texto ? v.inteiro(req.body.horas ?? 12, 'as horas', { min: 1, max: 72 }) : 0;
    db.prepare('UPDATE telas SET aviso = ?, aviso_ate = ? WHERE id = ?')
      .run(texto, texto ? new Date(Date.now() + horas * 3_600_000).toISOString() : null, t.id);
    registrar(db, req, 'aviso_lojista', { tela_id: t.id, aviso: texto });
    res.json(db.prepare('SELECT id, aviso, aviso_ate FROM telas WHERE id = ?').get(t.id));
  });

  /**
   * Comunicados do ponto: o recado do prédio ou da loja ("assembleia dia 12", "elevador em manutenção").
   * Entram no carrossel entre os anúncios e são desenhados pela própria TV, sem precisar de arte.
   */
  r.get('/comunicados', (req, res) => {
    res.json({
      itens: db.prepare("SELECT * FROM comunicados WHERE local_id = ? ORDER BY (status = 'pendente') DESC, fim DESC, id DESC").all(meu(req)),
      automatico: Boolean(lerConfig(db).comunicado_automatico),
    });
  });

  r.post('/comunicados', (req, res) => {
    const automatico = Boolean(lerConfig(db).comunicado_automatico);
    const d = lerComunicado(db, { ...req.body, local_id: meu(req) });
    const id = Number(db.prepare(`INSERT INTO comunicados (local_id, titulo, texto, tipo, inicio, fim, duracao_s, status, criado_por, aprovado_em, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(d.local_id, d.titulo, d.texto, d.tipo, d.inicio, d.fim, d.duracao_s ?? 10, automatico ? 'aprovado' : 'pendente', req.usuario.id,
        automatico ? agora() : null, agora()).lastInsertRowid);
    registrar(db, req, 'comunicado_do_ponto', { id, local_id: d.local_id, automatico });
    res.status(201).json(db.prepare('SELECT * FROM comunicados WHERE id = ?').get(id));
  });

  r.patch('/comunicados/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM comunicados WHERE id = ? AND local_id = ?').get(Number(req.params.id), meu(req));
    if (!c) throw naoEncontrado('Comunicado');
    const d = lerComunicado(db, { local_id: c.local_id, ...req.body }, true);
    delete d.local_id;
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    // Alterar um comunicado já no ar manda ele de volta para a aprovação da equipe.
    const automatico = Boolean(lerConfig(db).comunicado_automatico);
    db.prepare(`UPDATE comunicados SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')}, status = ?, motivo = NULL WHERE id = ?`)
      .run(...Object.values(d), automatico ? 'aprovado' : 'pendente', c.id);
    registrar(db, req, 'comunicado_alterado_ponto', { id: c.id });
    res.json(db.prepare('SELECT * FROM comunicados WHERE id = ?').get(c.id));
  });

  r.delete('/comunicados/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM comunicados WHERE id = ? AND local_id = ?').get(Number(req.params.id), meu(req));
    if (!c) throw naoEncontrado('Comunicado');
    db.prepare('UPDATE exibicoes SET comunicado_id = NULL WHERE comunicado_id = ?').run(c.id);
    db.prepare('DELETE FROM comunicados WHERE id = ?').run(c.id);
    registrar(db, req, 'comunicado_removido_ponto', { id: c.id });
    res.status(204).end();
  });

  /** Conteúdo do próprio estabelecimento (entra no preenchimento da grade depois de aprovado). */
  r.post('/midias', (req, res) => {
    const c = lerConfig(db);
    const lido = arquivos.salvar(req.body, {
      duracaoInformada: req.query.duracao_s ? v.inteiro(req.query.duracao_s, 'a duração', { min: 1, max: 600 }) : null,
      duracaoImagemPadrao: c.duracao_imagem_s,
    });
    try {
      const id = Number(db.prepare(`INSERT INTO midias (local_id, nome, uso, tipo, arquivo, mime, bytes, sha256, largura, altura, duracao_s, orientacao,
          status, enviada_por, criado_em) VALUES (?, ?, 'institucional', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`)
        .run(meu(req), v.texto(req.query.nome ?? `Conteúdo ${hoje()}`, 'o nome do conteúdo', 140), lido.tipo, lido.arquivo, lido.mime, lido.bytes, lido.sha256,
          lido.largura, lido.altura, lido.duracao_s, lido.orientacao, req.usuario.id, agora()).lastInsertRowid);
      registrar(db, req, 'midia_enviada_lojista', { id, local_id: meu(req) });
      res.status(201).json(db.prepare('SELECT * FROM midias WHERE id = ?').get(id));
    } catch (err) {
      arquivos.remover(lido);
      throw err;
    }
  });

  /** Arquivo do próprio conteúdo, para a prévia no portal. */
  r.get('/midias/:id/arquivo', (req, res) => {
    const m = db.prepare('SELECT * FROM midias WHERE id = ? AND local_id = ?').get(Number(req.params.id), meu(req));
    if (!m) throw naoEncontrado('Conteúdo');
    res.set({ 'Content-Type': m.mime, 'Cache-Control': 'private, max-age=86400' });
    require('node:fs').createReadStream(arquivos.caminho(m)).pipe(res);
  });

  r.delete('/midias/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM midias WHERE id = ? AND local_id = ?').get(Number(req.params.id), meu(req));
    if (!m) throw naoEncontrado('Conteúdo');
    if (db.prepare('SELECT 1 FROM exibicoes WHERE midia_id = ? LIMIT 1').get(m.id)) throw new ErroNegocio('Este conteúdo já foi exibido e fica no histórico.', 409);
    db.prepare('DELETE FROM midias WHERE id = ?').run(m.id);
    arquivos.remover(m);
    registrar(db, req, 'midia_removida_lojista', { id: m.id });
    res.status(204).end();
  });

  r.get('/relatorios', (req, res) => {
    const p = rel.periodo(req.query);
    res.json({
      ...p,
      por_dia: rel.porDia(db, p),
      telas: rel.porTela(db, { ...p, localId: meu(req) }),
    });
  });

  r.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return r;
};
