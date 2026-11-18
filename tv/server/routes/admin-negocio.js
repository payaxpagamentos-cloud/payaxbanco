'use strict';

const { Router } = require('express');
const config = require('../config');
const { agora, transacao, lerConfig, gravarConfig } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { hashSenha } = require('../lib/senha');
const { registrar } = require('../lib/auditoria');
const { permitir } = require('../auth');
const { hoje, somarDias } = require('../lib/datas');
const { enviarCsv, reais } = require('../lib/csv');
const assinaturas = require('../lib/assinaturas');
const audiencia = require('../lib/audiencia');
const player = require('../lib/player');
const v = require('../lib/validacao');

const soAdmin = permitir('admin');

/** Operação: painel, planos, assinantes, faturas, relatórios, equipe e configurações. */
module.exports = (db) => {
  const r = Router();
  const achar = (tabela, id, oQue) => {
    const x = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(v.inteiro(id, 'o registro', { min: 1 }));
    if (!x) throw naoEncontrado(oQue);
    return x;
  };

  // ---------------- Painel ----------------

  r.get('/painel', (req, res) => {
    const p = audiencia.painel(db);
    res.json({
      ...p,
      // O curador cuida do conteúdo: os números de receita ficam com o administrador.
      receita: req.usuario.perfil === 'admin' ? p.receita : null,
      assinantes: req.usuario.perfil === 'admin' ? p.assinantes : { ativos: p.assinantes.ativos },
      canais_com_falha: db.prepare("SELECT id, nome, numero, sinal_detalhe, sinal_em FROM canais WHERE ativo = 1 AND sinal_status = 'falha' ORDER BY ordem, numero").all(),
      enviando: db.prepare("SELECT id, nome_original, tamanho, recebido, criado_em FROM midias WHERE status = 'enviando' ORDER BY id DESC LIMIT 20").all(),
      marca: config.marca,
      pagamentos: config.pagamentos,
    });
  });

  /** Quem está assistindo neste instante (telas abertas). */
  r.get('/assistindo', (req, res) => {
    player.encerrarSessoesMortas(db);
    res.json({ telas: audiencia.assistindoAgora(db) });
  });

  // ---------------- Planos ----------------

  r.get('/planos', soAdmin, (req, res) => res.json({
    planos: assinaturas.listarPlanos(db, { todos: true }).map((p) => ({
      ...p, ativo: Boolean(p.ativo), downloads: Boolean(p.downloads), canais_ao_vivo: Boolean(p.canais_ao_vivo),
      assinaturas_ativas: db.prepare("SELECT COUNT(*) AS n FROM assinaturas WHERE plano_id = ? AND status = 'ativa'").get(p.id).n,
    })),
  }));

  const dadosPlano = (d) => ({
    nome: v.texto(d.nome, 'o nome do plano', 60),
    descricao: v.opcional(d.descricao, 'a descrição', 400),
    preco_centavos: v.inteiro(d.preco_centavos, 'o preço', { min: 0, max: 1_000_000 }),
    periodicidade: v.opcao(d.periodicidade ?? 'mensal', 'a periodicidade', ['mensal', 'anual']),
    telas: v.inteiro(d.telas ?? 1, 'as telas', { min: 1, max: 10 }),
    perfis_max: v.inteiro(d.perfis_max ?? 4, 'os perfis', { min: 1, max: 10 }),
    qualidade: v.opcao(d.qualidade ?? 'hd', 'a qualidade', ['sd', 'hd', '4k']),
    downloads: v.booleano(d.downloads) ? 1 : 0,
    canais_ao_vivo: v.booleano(d.canais_ao_vivo, true) ? 1 : 0,
    nivel: v.inteiro(d.nivel ?? 1, 'o nível', { min: 1, max: 9 }),
    ordem: v.inteiro(d.ordem ?? 0, 'a ordem', { min: 0, max: 999 }),
    ativo: v.booleano(d.ativo, true) ? 1 : 0,
  });

  r.post('/planos', soAdmin, (req, res) => {
    const p = dadosPlano(req.body);
    const { slug } = require('../db');
    const r2 = db.prepare(`INSERT INTO planos (nome, slug, descricao, preco_centavos, periodicidade, telas, perfis_max, qualidade, downloads, canais_ao_vivo, nivel, ordem, ativo, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.nome, slug(req.body.slug || p.nome), p.descricao, p.preco_centavos, p.periodicidade,
      p.telas, p.perfis_max, p.qualidade, p.downloads, p.canais_ao_vivo, p.nivel, p.ordem, p.ativo, agora());
    registrar(db, req, 'plano_criado', { id: Number(r2.lastInsertRowid), nome: p.nome });
    res.status(201).json({ plano: achar('planos', Number(r2.lastInsertRowid), 'Plano') });
  });

  r.patch('/planos/:id', soAdmin, (req, res) => {
    const atual = achar('planos', req.params.id, 'Plano');
    const p = dadosPlano({ ...atual, ...req.body });
    db.prepare(`UPDATE planos SET nome = ?, descricao = ?, preco_centavos = ?, periodicidade = ?, telas = ?, perfis_max = ?, qualidade = ?,
      downloads = ?, canais_ao_vivo = ?, nivel = ?, ordem = ?, ativo = ? WHERE id = ?`)
      .run(p.nome, p.descricao, p.preco_centavos, p.periodicidade, p.telas, p.perfis_max, p.qualidade, p.downloads, p.canais_ao_vivo,
        p.nivel, p.ordem, p.ativo, atual.id);
    registrar(db, req, 'plano_alterado', { id: atual.id, nome: p.nome, preco: p.preco_centavos });
    res.json({ plano: achar('planos', atual.id, 'Plano') });
  });

  // ---------------- Assinantes ----------------

  r.get('/assinantes', soAdmin, (req, res) => {
    const filtros = ["u.perfil = 'assinante'"];
    const params = [];
    if (req.query.status) {
      filtros.push('a.status = ?');
      params.push(v.opcao(req.query.status, 'a situação', ['pendente', 'ativa', 'suspensa', 'cancelada']));
    }
    if (req.query.q) {
      filtros.push("(u.nome LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.email LIKE ? ESCAPE '\\' COLLATE NOCASE)");
      const like = `%${String(req.query.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    res.json({
      assinantes: db.prepare(`SELECT u.id, u.nome, u.email, u.telefone, u.ativo, u.criado_em, u.ultimo_acesso,
          a.id AS assinatura_id, a.status, a.acesso_ate, a.proxima_cobranca, a.cancelar_no_fim, p.nome AS plano, p.preco_centavos,
          (SELECT COUNT(*) FROM perfis pf WHERE pf.usuario_id = u.id) AS perfis,
          (SELECT COUNT(*) FROM faturas f WHERE f.usuario_id = u.id AND f.status = 'aberta') AS faturas_abertas
        FROM usuarios u LEFT JOIN assinaturas a ON a.usuario_id = u.id AND a.status <> 'cancelada' LEFT JOIN planos p ON p.id = a.plano_id
        WHERE ${filtros.join(' AND ')} ORDER BY u.criado_em DESC LIMIT 300`).all(...params)
        .map((x) => ({ ...x, ativo: Boolean(x.ativo), cancelar_no_fim: Boolean(x.cancelar_no_fim) })),
    });
  });

  r.get('/assinantes/:id', soAdmin, (req, res) => {
    const u = achar('usuarios', req.params.id, 'Assinante');
    res.json({
      assinante: { id: u.id, nome: u.nome, email: u.email, telefone: u.telefone, ativo: Boolean(u.ativo), criado_em: u.criado_em, ultimo_acesso: u.ultimo_acesso },
      assinatura: assinaturas.resumo(db, u),
      historico: db.prepare(`SELECT a.*, p.nome AS plano FROM assinaturas a JOIN planos p ON p.id = a.plano_id WHERE a.usuario_id = ? ORDER BY a.id DESC`).all(u.id),
      faturas: assinaturas.faturasDe(db, u.id, 36),
      perfis: db.prepare('SELECT id, nome, infantil, classificacao_max, principal FROM perfis WHERE usuario_id = ? ORDER BY principal DESC, id').all(u.id),
      telas: player.sessoesVivas(db, u.id).map((s) => ({ id: s.id, o_que: s.canal_nome ?? s.titulo_nome, dispositivo: s.dispositivo, desde: s.iniciada_em })),
      audiencia: db.prepare(`SELECT COUNT(*) AS sessoes, COALESCE(SUM(segundos), 0) AS segundos FROM sessoes_player WHERE usuario_id = ? AND iniciada_em >= ?`)
        .get(u.id, new Date(Date.now() - 30 * 86_400_000).toISOString()),
    });
  });

  /** Ativa ou desativa a conta (a desativada não entra mais). */
  r.patch('/assinantes/:id', soAdmin, (req, res) => {
    const u = achar('usuarios', req.params.id, 'Assinante');
    if (req.body.ativo !== undefined) {
      db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(v.booleano(req.body.ativo) ? 1 : 0, u.id);
      if (!v.booleano(req.body.ativo)) player.encerrarOutras(db, u.id);
      registrar(db, req, 'assinante_situacao', { id: u.id, ativo: v.booleano(req.body.ativo) });
    }
    if (req.body.nome !== undefined) db.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').run(v.texto(req.body.nome, 'o nome', 120), u.id);
    if (req.body.telefone !== undefined) db.prepare('UPDATE usuarios SET telefone = ? WHERE id = ?').run(req.body.telefone ? v.telefone(req.body.telefone) : null, u.id);
    if (req.body.senha !== undefined) {
      db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(req.body.senha)), u.id);
      registrar(db, req, 'assinante_senha_trocada', { id: u.id });
    }
    res.json({ assinante: { id: u.id, ativo: Boolean(db.prepare('SELECT ativo FROM usuarios WHERE id = ?').get(u.id).ativo) } });
  });

  /** A operação coloca o assinante num plano (venda por telefone, cortesia, teste). */
  r.post('/assinantes/:id/assinatura', soAdmin, (req, res) => {
    const u = achar('usuarios', req.params.id, 'Assinante');
    const planoId = v.inteiro(req.body.plano_id, 'o plano', { min: 1 });
    const atual = assinaturas.assinaturaDe(db, u.id);
    const saida = atual ? assinaturas.trocarPlano(db, u, planoId) : assinaturas.contratar(db, u, planoId);
    // Cortesia / ajuste manual: libera o acesso até a data informada, sem fatura.
    if (req.body.acesso_ate) {
      const ate = v.data(req.body.acesso_ate, 'a data do acesso');
      const a = assinaturas.assinaturaDe(db, u.id);
      transacao(db, () => {
        db.prepare("UPDATE assinaturas SET status = 'ativa', inicio = COALESCE(inicio, ?), acesso_ate = ?, proxima_cobranca = ?, atualizada_em = ? WHERE id = ?")
          .run(hoje(), ate, v.booleano(req.body.cobrar_depois, true) ? ate : null, agora(), a.id);
        if (saida.fatura) db.prepare("UPDATE faturas SET status = 'cancelada' WHERE id = ? AND status = 'aberta'").run(saida.fatura.id);
      });
    }
    registrar(db, req, 'assinatura_pela_operacao', { usuario_id: u.id, plano_id: planoId, acesso_ate: req.body.acesso_ate ?? null });
    res.json({ assinatura: assinaturas.resumo(db, u) });
  });

  r.post('/assinantes/:id/cancelar', soAdmin, (req, res) => {
    const u = achar('usuarios', req.params.id, 'Assinante');
    assinaturas.cancelar(db, u, { motivo: req.body.motivo, imediato: v.booleano(req.body.imediato) });
    registrar(db, req, 'assinatura_cancelada_pela_operacao', { usuario_id: u.id, imediato: v.booleano(req.body.imediato) });
    res.json({ assinatura: assinaturas.resumo(db, u) });
  });

  // ---------------- Faturas ----------------

  r.get('/faturas', soAdmin, (req, res) => {
    const filtros = [];
    const params = [];
    if (req.query.status) { filtros.push('f.status = ?'); params.push(v.opcao(req.query.status, 'a situação', ['aberta', 'paga', 'cancelada'])); }
    if (req.query.vencidas === '1') { filtros.push("f.status = 'aberta' AND f.vencimento < ?"); params.push(hoje()); }
    if (req.query.competencia) { filtros.push('f.competencia = ?'); params.push(String(req.query.competencia).slice(0, 7)); }
    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const faturas = db.prepare(`SELECT f.*, u.nome AS assinante, u.email, p.nome AS plano FROM faturas f
      JOIN usuarios u ON u.id = f.usuario_id JOIN assinaturas a ON a.id = f.assinatura_id JOIN planos p ON p.id = a.plano_id
      ${where} ORDER BY f.vencimento DESC, f.id DESC LIMIT 500`).all(...params);
    if (req.query.csv === '1') {
      return enviarCsv(res, `faturas-${hoje()}.csv`, [
        ['Fatura', 'Assinante', 'E-mail', 'Plano', 'Competência', 'Vencimento', 'Valor (R$)', 'Situação', 'Pago em'],
        ...faturas.map((f) => [f.id, f.assinante, f.email, f.plano, f.competencia, f.vencimento, reais(f.valor_centavos), f.status, f.paga_em ?? '']),
      ]);
    }
    return res.json({ faturas, total_centavos: faturas.reduce((s, f) => s + (f.status === 'aberta' ? f.valor_centavos : 0), 0) });
  });

  /** Baixa do PIX: a operação confere o extrato e libera o acesso. */
  r.post('/faturas/:id/confirmar', soAdmin, (req, res) => {
    const saida = assinaturas.confirmarPagamento(db, v.inteiro(req.params.id, 'a fatura', { min: 1 }), { operadorId: req.usuario.id });
    registrar(db, req, 'fatura_confirmada', { fatura_id: saida.fatura.id, valor: saida.fatura.valor_centavos });
    res.json({ fatura: saida.fatura, assinatura: saida.assinatura });
  });

  r.post('/faturas/:id/cancelar', soAdmin, (req, res) => {
    const f = achar('faturas', req.params.id, 'Fatura');
    if (f.status === 'paga') throw new ErroNegocio('Fatura já paga não pode ser cancelada.', 409);
    db.prepare("UPDATE faturas SET status = 'cancelada' WHERE id = ?").run(f.id);
    registrar(db, req, 'fatura_cancelada', { fatura_id: f.id, motivo: req.body.motivo ?? null });
    res.json({ fatura: achar('faturas', f.id, 'Fatura') });
  });

  /** Roda a cobrança agora (ela também roda sozinha de hora em hora). */
  r.post('/faturas/rodar-cobranca', soAdmin, (req, res) => {
    const saida = assinaturas.rodarCobranca(db);
    registrar(db, req, 'cobranca_rodada', saida);
    res.json(saida);
  });

  // ---------------- Relatórios ----------------

  const periodo = (q) => ({
    de: q.de ? v.data(q.de, 'a data inicial') : somarDias(hoje(), -29),
    ate: q.ate ? v.data(q.ate, 'a data final') : hoje(),
  });

  r.get('/relatorios/audiencia', (req, res) => {
    const p = periodo(req.query);
    res.json({
      ...p,
      por_dia: audiencia.porDia(db, p),
      por_hora: audiencia.porHora(db, p),
      por_dispositivo: audiencia.porDispositivo(db, p),
      titulos: audiencia.topTitulos(db, { ...p, limite: 20 }),
      canais: audiencia.topCanais(db, { ...p, limite: 20 }),
    });
  });

  r.get('/relatorios/audiencia.csv', (req, res) => {
    const p = periodo(req.query);
    enviarCsv(res, `audiencia-${p.de}-a-${p.ate}.csv`, [
      ['Dia', 'Telas abertas', 'Minutos assistidos', 'Contas'],
      ...audiencia.porDia(db, p).map((l) => [l.dia, l.sessoes, l.minutos, l.contas]),
    ]);
  });

  r.get('/relatorios/financeiro', soAdmin, (req, res) => res.json({
    competencias: audiencia.financeiro(db, { meses: v.inteiro(req.query.meses ?? 12, 'os meses', { min: 1, max: 60 }) }),
    planos: audiencia.porPlano(db),
    painel: audiencia.painel(db).receita,
  }));

  r.get('/relatorios/financeiro.csv', soAdmin, (req, res) => {
    enviarCsv(res, `financeiro-${hoje()}.csv`, [
      ['Competência', 'Faturas', 'Cobrado (R$)', 'Pago (R$)', 'Em aberto (R$)', 'Cancelado (R$)'],
      ...audiencia.financeiro(db, { meses: 36 }).map((l) => [l.competencia, l.faturas, reais(l.cobrado_centavos), reais(l.pago_centavos),
        reais(l.aberto_centavos), reais(l.cancelado_centavos)]),
    ]);
  });

  // ---------------- Equipe ----------------

  r.get('/equipe', soAdmin, (req, res) => res.json({
    equipe: db.prepare("SELECT id, nome, email, perfil, ativo, ultimo_acesso, criado_em FROM usuarios WHERE perfil IN ('admin','curador') ORDER BY nome").all()
      .map((u) => ({ ...u, ativo: Boolean(u.ativo) })),
  }));

  r.post('/equipe', soAdmin, (req, res) => {
    const d = req.body;
    const email = v.email(d.email);
    if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Já existe uma conta com este e-mail.', 409);
    const r2 = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?)')
      .run(v.texto(d.nome, 'o nome', 120), email, hashSenha(v.senha(d.senha)), v.opcao(d.perfil, 'o perfil', ['admin', 'curador']), agora());
    registrar(db, req, 'equipe_criada', { id: Number(r2.lastInsertRowid), email, perfil: d.perfil });
    res.status(201).json({ usuario: { id: Number(r2.lastInsertRowid), nome: d.nome, email, perfil: d.perfil } });
  });

  r.patch('/equipe/:id', soAdmin, (req, res) => {
    const u = achar('usuarios', req.params.id, 'Usuário');
    if (u.perfil === 'assinante') throw new ErroNegocio('Esta conta é de assinante. Use a tela de assinantes.', 409);
    const d = req.body;
    if (d.nome !== undefined) db.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').run(v.texto(d.nome, 'o nome', 120), u.id);
    if (d.perfil !== undefined) {
      if (u.id === req.usuario.id) throw new ErroNegocio('Você não pode mudar o seu próprio perfil de acesso.', 409);
      db.prepare('UPDATE usuarios SET perfil = ? WHERE id = ?').run(v.opcao(d.perfil, 'o perfil', ['admin', 'curador']), u.id);
    }
    if (d.ativo !== undefined) {
      if (u.id === req.usuario.id) throw new ErroNegocio('Você não pode desativar a sua própria conta.', 409);
      const outros = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'admin' AND ativo = 1 AND id <> ?").get(u.id).n;
      if (!v.booleano(d.ativo) && u.perfil === 'admin' && outros === 0) throw new ErroNegocio('A plataforma precisa de pelo menos um administrador ativo.', 409);
      db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(v.booleano(d.ativo) ? 1 : 0, u.id);
    }
    if (d.senha !== undefined) db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(d.senha)), u.id);
    registrar(db, req, 'equipe_alterada', { id: u.id });
    res.json({ usuario: db.prepare('SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = ?').get(u.id) });
  });

  // ---------------- Configurações e auditoria ----------------

  r.get('/config', soAdmin, (req, res) => res.json({
    config: lerConfig(db),
    servidor: {
      marca: config.marca,
      pagamentos: config.pagamentos,
      relay_ligado: config.relay.ligado,
      video_max_mb: Math.round(config.videoMaxBytes / 1048576),
      telas_sem_sinal_s: config.sessaoPlayerSegundos,
      midia_dir: config.midiaDir,
    },
  }));

  r.put('/config', soAdmin, (req, res) => {
    const d = req.body;
    const valores = {};
    if (d.pix_chave !== undefined) valores.pix_chave = String(d.pix_chave ?? '').trim().slice(0, 120);
    if (d.pix_recebedor !== undefined) valores.pix_recebedor = v.texto(d.pix_recebedor, 'o nome do recebedor', 60);
    if (d.pix_cidade !== undefined) valores.pix_cidade = v.texto(d.pix_cidade, 'a cidade do recebedor', 40);
    if (d.carencia_dias !== undefined) valores.carencia_dias = v.inteiro(d.carencia_dias, 'a carência', { min: 0, max: 60 });
    if (d.antecedencia_fatura_dias !== undefined) valores.antecedencia_fatura_dias = v.inteiro(d.antecedencia_fatura_dias, 'a antecedência', { min: 0, max: 30 });
    if (d.creditos_s !== undefined) valores.creditos_s = v.inteiro(d.creditos_s, 'o tempo dos créditos', { min: 0, max: 1800 });
    if (d.retomar_folga_s !== undefined) valores.retomar_folga_s = v.inteiro(d.retomar_folga_s, 'a folga ao retomar', { min: 0, max: 120 });
    if (d.aviso_home !== undefined) valores.aviso_home = String(d.aviso_home ?? '').slice(0, 300);
    if (d.epg_url !== undefined) valores.epg_url = String(d.epg_url ?? '').trim().slice(0, 1000);
    gravarConfig(db, valores);
    registrar(db, req, 'config_alterada', Object.keys(valores));
    res.json({ config: lerConfig(db) });
  });

  r.get('/auditoria', soAdmin, (req, res) => res.json({
    registros: db.prepare(`SELECT a.id, a.acao, a.detalhes, a.ip, a.criado_em, u.nome AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
      ORDER BY a.id DESC LIMIT ?`).all(v.inteiro(req.query.limite ?? 200, 'o limite', { min: 1, max: 1000 })),
  }));

  return r;
};
