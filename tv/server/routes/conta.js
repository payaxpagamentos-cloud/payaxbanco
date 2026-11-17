'use strict';

const { Router } = require('express');
const QRCode = require('qrcode');
const config = require('../config');
const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { hashSenha, verificarSenha } = require('../lib/senha');
const { registrar } = require('../lib/auditoria');
const { chavePerfil } = require('../auth');
const assinaturas = require('../lib/assinaturas');
const player = require('../lib/player');
const v = require('../lib/validacao');

const perfilPublico = (p) => ({
  id: p.id, nome: p.nome, cor: p.cor, infantil: Boolean(p.infantil), classificacao_max: p.classificacao_max,
  tem_pin: Boolean(p.pin_hash), principal: Boolean(p.principal),
});

const pin = (valor) => {
  const t = String(valor ?? '').trim();
  v.exigir(/^\d{4,6}$/.test(t), 'O PIN deve ter de 4 a 6 números.');
  return t;
};

/** Minha conta: planos, assinatura, faturas, perfis de visualização e telas em uso. */
module.exports = (db) => {
  const r = Router();

  r.get('/', (req, res) => res.json({
    usuario: { id: req.usuario.id, nome: req.usuario.nome, email: req.usuario.email, telefone: req.usuario.telefone, perfil: req.usuario.perfil },
    assinatura: assinaturas.resumo(db, req.usuario),
    perfis: db.prepare('SELECT * FROM perfis WHERE usuario_id = ? ORDER BY principal DESC, id').all(req.usuario.id).map(perfilPublico),
    telas: player.sessoesVivas(db, req.usuario.id).length,
    pagamentos: config.pagamentos,
  }));

  r.get('/planos', (req, res) => {
    const atual = assinaturas.acessoDe(db, req.usuario);
    res.json({
      atual: atual.plano?.id ?? null,
      planos: assinaturas.listarPlanos(db).map((p) => ({
        id: p.id, nome: p.nome, slug: p.slug, descricao: p.descricao, preco_centavos: p.preco_centavos, periodicidade: p.periodicidade,
        telas: p.telas, perfis_max: p.perfis_max, qualidade: p.qualidade, downloads: Boolean(p.downloads),
        canais_ao_vivo: Boolean(p.canais_ao_vivo), nivel: p.nivel,
      })),
    });
  });

  // ---------- Assinatura ----------

  r.post('/assinar', (req, res) => {
    const { assinatura, plano, fatura } = assinaturas.contratar(db, req.usuario, v.inteiro(req.body.plano_id, 'o plano', { min: 1 }));
    registrar(db, req, 'assinatura_contratada', { plano: plano.nome, fatura_id: fatura.id });
    res.status(201).json({ assinatura: assinaturas.resumo(db, req.usuario), status: assinatura.status, fatura: { id: fatura.id, valor_centavos: fatura.valor_centavos,
      vencimento: fatura.vencimento, pix_copia_cola: fatura.pix_copia_cola, txid: fatura.txid }, pagamentos: config.pagamentos });
  });

  r.post('/trocar-plano', (req, res) => {
    const saida = assinaturas.trocarPlano(db, req.usuario, v.inteiro(req.body.plano_id, 'o plano', { min: 1 }));
    registrar(db, req, 'plano_trocado', { plano: saida.plano.nome, quando: saida.quando });
    res.json({
      quando: saida.quando,
      aviso: saida.quando === 'proxima_cobranca' ? `Pronto! O plano ${saida.plano.nome} já vale para suas telas e a diferença entra na próxima fatura.`
        : saida.quando === 'agora' ? `Plano ${saida.plano.nome} escolhido. Pague a fatura para liberar o acesso.` : 'Você já está neste plano.',
      assinatura: assinaturas.resumo(db, req.usuario),
    });
  });

  r.post('/cancelar', (req, res) => {
    const a = assinaturas.cancelar(db, req.usuario, { motivo: req.body.motivo });
    registrar(db, req, 'assinatura_cancelada', { motivo: req.body.motivo ?? null });
    res.json({
      assinatura: assinaturas.resumo(db, req.usuario),
      aviso: a.status === 'cancelada' ? 'Assinatura cancelada.' : `Cancelamento agendado: você assiste até ${a.acesso_ate}.`,
    });
  });

  r.post('/reativar', (req, res) => {
    assinaturas.reativar(db, req.usuario);
    registrar(db, req, 'assinatura_reativada');
    res.json({ assinatura: assinaturas.resumo(db, req.usuario), aviso: 'Cancelamento desfeito. Boa sessão!' });
  });

  // ---------- Faturas ----------

  r.get('/faturas', (req, res) => res.json({
    faturas: assinaturas.faturasDe(db, req.usuario.id).map((f) => ({
      id: f.id, competencia: f.competencia, descricao: f.descricao, plano: f.plano_nome, valor_centavos: f.valor_centavos,
      vencimento: f.vencimento, status: f.status, paga_em: f.paga_em, pix_copia_cola: f.status === 'aberta' ? f.pix_copia_cola : null, txid: f.txid,
    })),
  }));

  const minhaFatura = (req) => {
    const f = db.prepare('SELECT * FROM faturas WHERE id = ? AND usuario_id = ?').get(v.inteiro(req.params.id, 'a fatura', { min: 1 }), req.usuario.id);
    if (!f) throw naoEncontrado('Fatura');
    return f;
  };

  /** QR Code do PIX como imagem SVG (desenhado no servidor, sem depender de serviço externo). */
  r.get('/faturas/:id/qr', async (req, res) => {
    const f = minhaFatura(req);
    if (!f.pix_copia_cola) throw new ErroNegocio('Esta fatura ainda não tem PIX. Fale com o atendimento.', 409);
    const svg = await QRCode.toString(f.pix_copia_cola, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=300' }).send(svg);
  });

  /**
   * Confirmação do pagamento pelo próprio assinante: só na fase de testes (TV_PAGAMENTOS=simulado).
   * Em produção, a baixa é da operação (ou de um intermediador de pagamentos ligado à conta PIX).
   */
  r.post('/faturas/:id/pagar', (req, res) => {
    const f = minhaFatura(req);
    if (config.pagamentos !== 'simulado') {
      throw new ErroNegocio('Assim que o PIX cair, a liberação é automática no nosso sistema de cobrança. Guarde o comprovante.', 409, { modo: config.pagamentos });
    }
    const saida = assinaturas.confirmarPagamento(db, f.id, { usuarioId: req.usuario.id });
    registrar(db, req, 'fatura_paga_simulado', { fatura_id: f.id });
    res.json({ fatura: { id: saida.fatura.id, status: saida.fatura.status }, assinatura: assinaturas.resumo(db, req.usuario) });
  });

  // ---------- Perfis de visualização ----------

  r.get('/perfis', (req, res) => res.json({
    perfis: db.prepare('SELECT * FROM perfis WHERE usuario_id = ? ORDER BY principal DESC, id').all(req.usuario.id).map(perfilPublico),
    maximo: assinaturas.acessoDe(db, req.usuario).perfis_max,
  }));

  r.post('/perfis', (req, res) => {
    const acesso = assinaturas.acessoDe(db, req.usuario);
    const d = req.body;
    const p = transacao(db, () => {
      const quantos = db.prepare('SELECT COUNT(*) AS n FROM perfis WHERE usuario_id = ?').get(req.usuario.id).n;
      if (quantos >= acesso.perfis_max) throw new ErroNegocio(`Seu plano permite ${acesso.perfis_max} perfis.`, 409);
      const infantil = v.booleano(d.infantil);
      const r2 = db.prepare('INSERT INTO perfis (usuario_id, nome, cor, infantil, classificacao_max, pin_hash, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.usuario.id, v.texto(d.nome, 'o nome do perfil', 30), v.opcional(d.cor, 'a cor', 20) ?? '#E50914', infantil ? 1 : 0,
          infantil ? v.classificacao(d.classificacao_max, 10) : v.classificacao(d.classificacao_max, 18),
          d.pin ? hashSenha(pin(d.pin)) : null, agora());
      return db.prepare('SELECT * FROM perfis WHERE id = ?').get(Number(r2.lastInsertRowid));
    });
    res.status(201).json({ perfil: perfilPublico(p) });
  });

  const meuPerfil = (req) => {
    const p = db.prepare('SELECT * FROM perfis WHERE id = ? AND usuario_id = ?').get(v.inteiro(req.params.id, 'o perfil', { min: 1 }), req.usuario.id);
    if (!p) throw naoEncontrado('Perfil');
    return p;
  };

  r.patch('/perfis/:id', (req, res) => {
    const p = meuPerfil(req);
    const d = req.body;
    if (d.nome !== undefined) db.prepare('UPDATE perfis SET nome = ? WHERE id = ?').run(v.texto(d.nome, 'o nome do perfil', 30), p.id);
    if (d.cor !== undefined) db.prepare('UPDATE perfis SET cor = ? WHERE id = ?').run(v.texto(d.cor, 'a cor', 20), p.id);
    if (d.infantil !== undefined) {
      const inf = v.booleano(d.infantil);
      db.prepare('UPDATE perfis SET infantil = ?, classificacao_max = ? WHERE id = ?')
        .run(inf ? 1 : 0, inf ? Math.min(p.classificacao_max, 10) : p.classificacao_max, p.id);
    }
    if (d.classificacao_max !== undefined) db.prepare('UPDATE perfis SET classificacao_max = ? WHERE id = ?').run(v.classificacao(d.classificacao_max), p.id);
    if (d.pin !== undefined) {
      // Para tirar o PIN é preciso informar o atual (quem está na sala com a TV não desliga o bloqueio sozinho).
      if (d.pin === null || d.pin === '') {
        if (p.pin_hash && !verificarSenha(String(d.pin_atual ?? ''), p.pin_hash)) throw new ErroNegocio('Informe o PIN atual para tirar o bloqueio.', 422);
        db.prepare('UPDATE perfis SET pin_hash = NULL WHERE id = ?').run(p.id);
      } else {
        if (p.pin_hash && !verificarSenha(String(d.pin_atual ?? ''), p.pin_hash)) throw new ErroNegocio('PIN atual incorreto.', 422);
        db.prepare('UPDATE perfis SET pin_hash = ? WHERE id = ?').run(hashSenha(pin(d.pin)), p.id);
      }
    }
    res.json({ perfil: perfilPublico(db.prepare('SELECT * FROM perfis WHERE id = ?').get(p.id)) });
  });

  r.delete('/perfis/:id', (req, res) => {
    const p = meuPerfil(req);
    if (p.principal) throw new ErroNegocio('O perfil principal da conta não pode ser apagado.', 409);
    db.prepare('DELETE FROM perfis WHERE id = ?').run(p.id);
    res.status(204).end();
  });

  /** Abre o perfil protegido: confere o PIN e devolve a chave que o aparelho guarda. */
  r.post('/perfis/:id/abrir', (req, res) => {
    const p = meuPerfil(req);
    if (!p.pin_hash) return res.json({ perfil: perfilPublico(p), chave: null });
    if (!verificarSenha(String(req.body.pin ?? ''), p.pin_hash)) throw new ErroNegocio('PIN incorreto.', 422);
    return res.json({ perfil: perfilPublico(p), chave: chavePerfil(p) });
  });

  // ---------- Telas em uso ----------

  r.get('/telas', (req, res) => {
    player.encerrarSessoesMortas(db);
    const acesso = assinaturas.acessoDe(db, req.usuario);
    res.json({
      limite: acesso.telas,
      telas: player.sessoesVivas(db, req.usuario.id).map((s) => ({
        id: s.id, tipo: s.tipo, o_que: s.canal_nome ?? s.episodio_nome ?? s.titulo_nome, dispositivo: s.dispositivo,
        desde: s.iniciada_em, qualidade: s.qualidade,
      })),
    });
  });

  r.post('/telas/encerrar', (req, res) => {
    const encerradas = req.body.id
      ? player.fechar(db, req.usuario.id, v.inteiro(req.body.id, 'a tela', { min: 1 }), 'outra_tela').encerrada ? 1 : 0
      : player.encerrarOutras(db, req.usuario.id, req.body.manter ?? null);
    res.json({ encerradas });
  });

  return r;
};
