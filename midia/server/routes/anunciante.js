'use strict';

const { Router } = require('express');
const QRCode = require('qrcode');
const { agora, lerConfig } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const arquivos = require('../lib/arquivos');
const rel = require('../lib/relatorios');
const faturamento = require('../lib/faturamento');
const { hoje, mes, somarDias, inicioMes, fimMes } = require('../lib/datas');
const v = require('../lib/validacao');

/**
 * Portal do anunciante: ele vê onde os anúncios dele rodaram, com a prova de exibição, envia criativos
 * (que a equipe aprova antes de ir ao ar) e acompanha as faturas. Nunca vê dados de outro anunciante.
 */
module.exports = (db) => {
  const r = Router();
  const meu = (req) => req.usuario.anunciante_id;
  const minhaCampanha = (req, id) => {
    const c = db.prepare('SELECT * FROM campanhas WHERE id = ? AND anunciante_id = ?').get(Number(id), meu(req));
    if (!c) throw naoEncontrado('Campanha');
    return c;
  };

  r.get('/resumo', (req, res) => {
    const competencia = mes();
    const p = { de: inicioMes(competencia), ate: fimMes(competencia) };
    const campanhas = rel.porCampanha(db, { ...p, anuncianteId: meu(req) });
    res.json({
      anunciante: db.prepare('SELECT id, nome, documento, email, telefone FROM anunciantes WHERE id = ?').get(meu(req)),
      competencia,
      campanhas: db.prepare(`SELECT COALESCE(SUM(status = 'ativa'), 0) AS ativas, COALESCE(SUM(status = 'aguardando'), 0) AS aguardando,
        COALESCE(SUM(status = 'pausada'), 0) AS pausadas FROM campanhas WHERE anunciante_id = ?`).get(meu(req)),
      mes: {
        insercoes: campanhas.reduce((t, c) => t + c.insercoes, 0),
        impactos: campanhas.reduce((t, c) => t + c.impactos, 0),
        telas: Math.max(0, ...campanhas.map((c) => c.telas)),
      },
      hoje: db.prepare(`SELECT COALESCE(SUM(rd.insercoes), 0) AS insercoes FROM resumo_dia rd
        WHERE rd.data = ? AND rd.campanha_id IN (SELECT id FROM campanhas WHERE anunciante_id = ?)`).get(hoje(), meu(req)),
      por_dia: rel.porDia(db, { de: somarDias(hoje(), -13), ate: hoje(), anuncianteId: meu(req) }),
      desempenho: campanhas,
      midias_pendentes: db.prepare("SELECT COUNT(*) AS n FROM midias WHERE anunciante_id = ? AND status = 'pendente'").get(meu(req)).n,
      faturas: db.prepare(`SELECT COALESCE(SUM(status = 'aberta'), 0) AS abertas,
        COALESCE(SUM(CASE WHEN status = 'aberta' THEN valor_centavos ELSE 0 END), 0) AS aberto_centavos,
        COALESCE(SUM(status = 'aberta' AND vencimento < ?), 0) AS atrasadas FROM faturas WHERE anunciante_id = ?`).get(hoje(), meu(req)),
    });
  });

  r.get('/campanhas', (req, res) => {
    res.json({
      itens: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM campanha_midias cm WHERE cm.campanha_id = c.id) AS criativos,
          (SELECT COALESCE(SUM(insercoes), 0) FROM resumo_dia rd WHERE rd.campanha_id = c.id) AS insercoes_total
        FROM campanhas c WHERE c.anunciante_id = ? ORDER BY c.inicio DESC`).all(meu(req)),
    });
  });

  r.get('/campanhas/:id', (req, res) => {
    const c = minhaCampanha(req, req.params.id);
    const ate = c.fim && c.fim < hoje() ? c.fim : hoje();
    const p = { de: c.inicio < ate ? c.inicio : ate, ate };
    res.json({
      ...c,
      criativos: db.prepare(`SELECT m.id, m.nome, m.tipo, m.status, m.motivo, COALESCE(cm.duracao_s, m.duracao_s) AS duracao_s, m.validade_ate
        FROM campanha_midias cm JOIN midias m ON m.id = cm.midia_id WHERE cm.campanha_id = ? ORDER BY cm.ordem, cm.id`).all(c.id),
      desempenho: rel.porCampanha(db, { ...p, campanhaId: c.id })[0] ?? { insercoes: 0, segundos: 0, telas: 0, impactos: 0 },
      por_dia: rel.porDia(db, { ...p, campanhaId: c.id }),
      pontos: db.prepare(`SELECT l.nome AS local, l.cidade, l.uf, l.categoria, COUNT(DISTINCT rd.tela_id) AS telas, SUM(rd.insercoes) AS insercoes
        FROM resumo_dia rd JOIN locais l ON l.id = rd.local_id WHERE rd.campanha_id = ? GROUP BY l.id ORDER BY insercoes DESC`).all(c.id),
    });
  });

  /** Prova de exibição das próprias campanhas (com CSV para arquivar). */
  r.get('/prova', (req, res) => {
    const p = rel.periodo(req.query);
    const dados = rel.prova(db, {
      ...p,
      anuncianteId: meu(req),
      campanhaId: req.query.campanha_id ? minhaCampanha(req, req.query.campanha_id).id : null,
      pagina: Math.max(1, Number(req.query.pagina) || 1),
      limite: req.query.csv ? 20000 : Math.min(500, Number(req.query.limite) || 200),
    });
    if (req.query.csv) return rel.enviarCsv(res, `prova-de-exibicao-${p.de}-${p.ate}.csv`, rel.csv(rel.COLUNAS_PROVA, dados.itens));
    res.json(dados);
  });

  r.get('/midias', (req, res) => {
    res.json({ itens: db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM campanha_midias cm WHERE cm.midia_id = m.id) AS campanhas
      FROM midias m WHERE m.anunciante_id = ? ORDER BY m.id DESC`).all(meu(req)) });
  });

  /** Envio de criativo pelo anunciante: entra como pendente e a equipe aprova. */
  r.post('/midias', (req, res) => {
    const c = lerConfig(db);
    const lido = arquivos.salvar(req.body, {
      duracaoInformada: req.query.duracao_s ? v.inteiro(req.query.duracao_s, 'a duração', { min: 1, max: 600 }) : null,
      duracaoImagemPadrao: c.duracao_imagem_s,
    });
    try {
      const id = Number(db.prepare(`INSERT INTO midias (anunciante_id, nome, uso, tipo, arquivo, mime, bytes, sha256, largura, altura, duracao_s, orientacao,
          status, enviada_por, criado_em) VALUES (?, ?, 'campanha', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`)
        .run(meu(req), v.texto(req.query.nome ?? `Criativo ${hoje()}`, 'o nome do criativo', 140), lido.tipo, lido.arquivo, lido.mime, lido.bytes, lido.sha256,
          lido.largura, lido.altura, lido.duracao_s, lido.orientacao, req.usuario.id, agora()).lastInsertRowid);
      registrar(db, req, 'midia_enviada_anunciante', { id, bytes: lido.bytes });
      res.status(201).json(db.prepare('SELECT * FROM midias WHERE id = ?').get(id));
    } catch (err) {
      arquivos.remover(lido);
      throw err;
    }
  });

  r.get('/midias/:id/arquivo', (req, res) => {
    const m = db.prepare('SELECT * FROM midias WHERE id = ? AND anunciante_id = ?').get(Number(req.params.id), meu(req));
    if (!m) throw naoEncontrado('Criativo');
    res.set({ 'Content-Type': m.mime, 'Cache-Control': 'private, max-age=86400' });
    require('node:fs').createReadStream(arquivos.caminho(m)).pipe(res);
  });

  r.get('/faturas', (req, res) => {
    res.json({
      itens: db.prepare(`SELECT *, (status = 'aberta' AND vencimento < ?) AS atrasada FROM faturas WHERE anunciante_id = ? ORDER BY competencia DESC`)
        .all(hoje(), meu(req)),
    });
  });

  r.get('/faturas/:id', async (req, res) => {
    const f = db.prepare('SELECT id FROM faturas WHERE id = ? AND anunciante_id = ?').get(Number(req.params.id), meu(req));
    if (!f) throw naoEncontrado('Fatura');
    const d = faturamento.detalhe(db, f.id);
    if (d.pix) d.pix.qr = await QRCode.toDataURL(d.pix.codigo, { margin: 1, width: 320 }).catch(() => null);
    res.json(d);
  });

  /** A rede de telas onde os anúncios podem rodar (sem dados de outros anunciantes). */
  r.get('/rede', (_req, res) => {
    res.json({
      pontos: db.prepare(`SELECT l.nome, l.categoria, l.cidade, l.uf, l.publico_dia, COUNT(t.id) AS telas
        FROM locais l LEFT JOIN telas t ON t.local_id = l.id AND t.status = 'ativa'
        WHERE l.status = 'ativo' GROUP BY l.id HAVING telas > 0 ORDER BY l.cidade, l.nome`).all(),
    });
  });

  r.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return r;
};
