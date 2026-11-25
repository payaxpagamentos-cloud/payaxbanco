'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { Router } = require('express');
const { agora, lerConfig } = require('../db');
const config = require('../config');
const { autenticarTela, emitirTokenTela } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { limitar } = require('../lib/limitador');
const grade = require('../lib/grade');
const exibicoes = require('../lib/exibicoes');
const arquivos = require('../lib/arquivos');

// Sem letras e números parecidos (0/O, 1/I), para ninguém errar lendo da TV.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODIGO_MINUTOS = 15;

function novoCodigo(db) {
  for (let i = 0; i < 30; i++) {
    const c = Array.from(crypto.randomBytes(6), (b) => ALFABETO[b % ALFABETO.length]).join('');
    if (!db.prepare('SELECT 1 FROM pareamentos WHERE codigo = ?').get(c)) return c;
  }
  throw new ErroNegocio('Não foi possível gerar o código agora. Tente de novo.', 503);
}

const limparTexto = (v, max = 120) => (v === undefined || v === null ? null : String(v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) || null);

/**
 * API das TVs. O aparelho não tem usuário nem senha: ele mostra um código, a equipe confirma no painel
 * e a partir daí usa o token do aparelho (Authorization: Bearer ...).
 */
module.exports = (db) => {
  const r = Router();
  const autenticada = autenticarTela(db);

  // Um aparelho novo pede o código que aparece na TV.
  r.post('/registrar', limitar({ janelaMs: 60_000, maximo: 20 }), (req, res) => {
    const cfg = lerConfig(db);
    const codigo = novoCodigo(db);
    const expira = new Date(Date.now() + CODIGO_MINUTOS * 60_000).toISOString();
    db.prepare('INSERT INTO pareamentos (codigo, aparelho, largura, altura, versao, ip, expira_em, criado_em, visto_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      codigo, limparTexto(req.body.aparelho, 160), Number(req.body.largura) || null, Number(req.body.altura) || null,
      limparTexto(req.body.versao, 20), req.ip ?? null, expira, agora(), agora(),
    );
    res.status(201).json({ codigo, expira_em: expira, consulta_s: 5, plataforma: cfg.nome_plataforma, slogan: cfg.slogan });
  });

  // A TV consulta até a equipe confirmar; quando confirma, recebe o token e guarda.
  r.get('/pareamento', limitar({ janelaMs: 60_000, maximo: 120, todos: true }), (req, res) => {
    const p = db.prepare('SELECT * FROM pareamentos WHERE codigo = ?').get(String(req.query.codigo ?? '').toUpperCase().trim());
    if (!p || p.expira_em < agora()) return res.json({ pareado: false, expirado: true });
    if (!p.tela_id) {
      // O aparelho continua com a página aberta: segue na lista de "aguardando" do painel.
      db.prepare('UPDATE pareamentos SET visto_em = ? WHERE id = ?').run(agora(), p.id);
      return res.json({ pareado: false, expira_em: p.expira_em });
    }
    const tela = db.prepare('SELECT * FROM telas WHERE id = ?').get(p.tela_id);
    if (!tela) return res.json({ pareado: false, expirado: true });
    // O acesso é entregue à TV que pediu o código. Depois de entregue, o código só repete a entrega
    // por 2 minutos (caso a resposta tenha se perdido) — não serve para outra pessoa que viu o código.
    if (p.entregue_em && Date.parse(p.entregue_em) < Date.now() - 120_000) return res.json({ pareado: false, expirado: true });
    db.prepare('UPDATE pareamentos SET entregue_em = COALESCE(entregue_em, ?) WHERE id = ?').run(agora(), p.id);
    res.json({ pareado: true, token: emitirTokenTela(tela), tela: { id: tela.id, nome: tela.nome, orientacao: tela.orientacao } });
  });

  /** Programação atual da TV: o que rodar, em que ordem e por quanto tempo. */
  r.get('/programacao', autenticada, (req, res) => {
    const cfg = lerConfig(db);
    const tela = grade.buscarTela(db, req.tela.id);
    const g = grade.montar(db, tela);
    db.prepare('UPDATE telas SET grade_versao = ?, ultimo_contato = ?, ip = ? WHERE id = ?').run(g.versao, agora(), req.ip ?? null, tela.id);
    const avisoVale = tela.aviso && (!tela.aviso_ate || tela.aviso_ate >= agora());
    res.json({
      tela: {
        id: tela.id, nome: tela.nome, local: tela.local_nome, orientacao: tela.orientacao,
        som: Boolean(tela.som), relogio: Boolean(tela.relogio), giro: tela.giro ?? 0, legenda: tela.legenda ?? null, aviso: avisoVale ? tela.aviso : null,
      },
      plataforma: cfg.nome_plataforma,
      slogan: cfg.slogan,
      // A TV mostra a hora no fuso da rede, não no do aparelho (TV box costuma vir em outro fuso).
      fuso: config.fuso,
      batida_s: cfg.batida_intervalo_s,
      // De quanto em quanto tempo esta TV manda uma foto do que está na tela (0 desliga).
      foto_minutos: cfg.foto_minutos,
      grade: g,
    });
  });

  /**
   * Batida: a TV diz que está viva e o que está no ar; a resposta diz se a programação mudou
   * (aí ela baixa de novo) e a hora do servidor, para o relógio da tela.
   */
  r.post('/batida', autenticada, (req, res) => {
    const cfg = lerConfig(db);
    const tela = grade.buscarTela(db, req.tela.id);
    const anterior = db.prepare('SELECT tipo FROM telas_eventos WHERE tela_id = ? ORDER BY id DESC LIMIT 1').get(tela.id)?.tipo;
    if (anterior !== 'online' && anterior !== 'pareada') {
      db.prepare("INSERT INTO telas_eventos (tela_id, tipo, detalhe, criado_em) VALUES (?, 'online', ?, ?)")
        .run(tela.id, `Voltou a responder${req.body.versao ? ` (player ${limparTexto(req.body.versao, 20)})` : ''}`, agora());
    }
    if (req.body.erro) {
      db.prepare("INSERT INTO telas_eventos (tela_id, tipo, detalhe, criado_em) VALUES (?, 'erro', ?, ?)").run(tela.id, limparTexto(req.body.erro, 300), agora());
    }
    const g = grade.montar(db, tela);
    db.prepare('UPDATE telas SET ultimo_contato = ?, ip = ?, versao_player = COALESCE(?, versao_player), item_atual = COALESCE(?, item_atual), grade_versao = ? WHERE id = ?')
      .run(agora(), req.ip ?? null, limparTexto(req.body.versao, 20), limparTexto(req.body.item_atual, 160), g.versao, tela.id);
    // Comandos que a equipe mandou pelo painel: saem da fila aqui e vão na resposta.
    const pendentes = db.prepare('SELECT id, comando FROM tela_comandos WHERE tela_id = ? AND entregue_em IS NULL ORDER BY id').all(tela.id);
    if (pendentes.length) {
      const marcar = db.prepare('UPDATE tela_comandos SET entregue_em = ? WHERE id = ?');
      for (const c of pendentes) marcar.run(agora(), c.id);
    }
    res.json({
      grade_versao: g.versao,
      recarregar: String(req.body.grade_versao ?? '') !== g.versao,
      comandos: pendentes.map((c) => c.comando),
      player_versao: config.playerVersao,
      // Mudou o carimbo dos arquivos do player (o sistema foi atualizado): a TV recarrega sozinha.
      player_arquivos: require('../lib/carimbo-player').carimboPlayer(),
      hora: agora(),
      batida_s: cfg.batida_intervalo_s,
    });
  });

  /** Prova de exibição em lote (a TV guarda a fila e reenvia quando a internet volta). */
  r.post('/exibicoes', autenticada, (req, res) => {
    const r2 = exibicoes.registrar(db, req.tela, req.body.exibicoes ?? req.body.itens ?? []);
    db.prepare('UPDATE telas SET ultimo_contato = ? WHERE id = ?').run(agora(), req.tela.id);
    res.json(r2);
  });

  /**
   * Prova visual: a TV manda uma foto do que está na tela agora (o player desenha o próprio
   * conteúdo num canvas e envia o JPEG). Guardamos só a última de cada tela — serve para ver
   * que a TV está realmente no ar com o conteúdo certo, sem ir até o prédio.
   */
  r.post('/foto', autenticada, (req, res) => {
    const cfg = lerConfig(db);
    if (!cfg.foto_minutos) throw new ErroNegocio('A prova visual está desligada nas configurações.', 409);
    const conteudo = Buffer.isBuffer(req.body) ? req.body : null;
    if (!conteudo || !conteudo.length) throw new ErroNegocio('Envie a imagem.', 422);
    const foto = arquivos.salvarImagem(conteudo, 600 * 1024);
    const anterior = db.prepare('SELECT foto_arquivo FROM telas WHERE id = ?').get(req.tela.id)?.foto_arquivo;
    db.prepare('UPDATE telas SET foto_arquivo = ?, foto_em = ?, foto_item = ?, ultimo_contato = ? WHERE id = ?')
      .run(foto.arquivo, agora(), limparTexto(req.query.item, 160), agora(), req.tela.id);
    // Só a última foto fica: a anterior sai do disco.
    if (anterior) arquivos.remover({ arquivo: anterior });
    res.status(201).json({ ok: true, proxima_em_min: cfg.foto_minutos });
  });

  /**
   * Arquivo do criativo. O player guarda em cache pela URL (que leva o resumo do arquivo),
   * então o mesmo arquivo nunca é baixado duas vezes. Aceita download parcial (vídeo).
   */
  r.get('/midia/:id', autenticada, (req, res) => {
    const m = db.prepare("SELECT * FROM midias WHERE id = ? AND status = 'aprovada'").get(Number(req.params.id));
    if (!m) throw new ErroNegocio('Mídia não encontrada.', 404);
    if (m.local_id && m.local_id !== req.tela.local_id) throw new ErroNegocio('Mídia não é desta tela.', 403);
    if (m.empresa_id && req.tela.empresa_id && m.empresa_id !== req.tela.empresa_id) throw new ErroNegocio('Mídia não é desta tela.', 403);
    const caminho = arquivos.caminho(m);
    let tamanho;
    try { tamanho = fs.statSync(caminho).size; } catch { throw new ErroNegocio('Arquivo da mídia não encontrado no servidor.', 500); }

    res.set({
      'Content-Type': m.mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${m.sha256.slice(0, 32)}"`,
      'Accept-Ranges': 'bytes',
    });
    if (req.get('if-none-match') === `"${m.sha256.slice(0, 32)}"`) return res.status(304).end();

    const faixa = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') || '');
    if (faixa) {
      const inicio = faixa[1] ? Number(faixa[1]) : Math.max(0, tamanho - Number(faixa[2] || 0));
      const fim = faixa[1] ? Math.min(tamanho - 1, faixa[2] ? Number(faixa[2]) : tamanho - 1) : tamanho - 1;
      if (inicio > fim || inicio >= tamanho) return res.status(416).set('Content-Range', `bytes */${tamanho}`).end();
      res.status(206).set({ 'Content-Range': `bytes ${inicio}-${fim}/${tamanho}`, 'Content-Length': String(fim - inicio + 1) });
      return fs.createReadStream(caminho, { start: inicio, end: fim }).pipe(res);
    }
    res.set('Content-Length', String(tamanho));
    return fs.createReadStream(caminho).pipe(res);
  });

  /** Logo da administradora do ponto, para o cabeçalho do comunicado na tela. */
  // Foto do comunicado: só de comunicado do ponto desta TV.
  r.get('/comunicados/:id/imagem', autenticada, (req, res) => {
    const c = db.prepare('SELECT * FROM comunicados WHERE id = ? AND local_id = ?').get(Number(req.params.id), req.tela.local_id);
    require('../lib/comunicado-foto').enviar(res, c);
  });

  r.get('/logo', autenticada, (req, res) => {
    const l = db.prepare('SELECT logo_arquivo, logo_mime FROM locais WHERE id = ?').get(req.tela.local_id);
    if (!l?.logo_arquivo) throw new ErroNegocio('Este ponto não tem logo.', 404);
    res.set({ 'Content-Type': l.logo_mime, 'Cache-Control': 'private, max-age=86400' });
    fs.createReadStream(arquivos.caminho({ arquivo: l.logo_arquivo })).pipe(res);
  });

  // Deixa a TV avisar que foi reiniciada (aparece no histórico do aparelho).
  r.post('/reinicio', autenticada, (req, res) => {
    db.prepare("INSERT INTO telas_eventos (tela_id, tipo, detalhe, criado_em) VALUES (?, 'reinicio', ?, ?)")
      .run(req.tela.id, limparTexto(req.body.motivo, 160) ?? 'Player reiniciado', agora());
    res.status(204).end();
  });

  return r;
};
