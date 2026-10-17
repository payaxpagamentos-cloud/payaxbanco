'use strict';

const { Router } = require('express');
const { transacao, lerConfig, agora, CONFIG_PADRAO } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { hoje, somarDias, intervalo } = require('../lib/datas');
const { hashSenha } = require('../lib/senha');
const { registrar } = require('../lib/auditoria');
const cor = require('../lib/corridas');
const fin = require('../lib/financeiro');
const v = require('../lib/validacao');

/** Período 'de'/'ate' da query (padrão: hoje), limitado a um ano. */
function periodo(q, padraoDias = 0) {
  const ate = q.ate ? v.data(q.ate, 'a data final') : hoje();
  const de = q.de ? v.data(q.de, 'a data inicial') : somarDias(ate, -padraoDias);
  v.exigir(de <= ate && de >= somarDias(ate, -366), 'Período inválido (até um ano).');
  return [de, ate];
}

module.exports = (db) => {
  const r = Router();
  r.use(permitir('admin', 'operador'));
  const soAdmin = permitir('admin');
  const nid = (req) => Number(req.params.id);

  r.get('/painel', (_req, res) => {
    cor.expirarSolicitacoes(db);
    const [ini, fim] = intervalo(hoje(), hoje());
    const corte = new Date(Date.now() - 5 * 60_000).toISOString();
    const status = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM corridas WHERE status IN ('solicitada','aceita','chegou','em_andamento') GROUP BY status`)
      .all().map((x) => [x.status, x.n]));
    const dia = db.prepare(`SELECT COUNT(*) AS finalizadas, COALESCE(SUM(valor_final_centavos),0) AS bruto, COALESCE(SUM(taxa_plataforma_centavos),0) AS taxa
      FROM corridas WHERE status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`).get(ini, fim);
    const canceladas = db.prepare(`SELECT COUNT(*) AS n FROM corridas WHERE status = 'cancelada' AND cancelada_em >= ? AND cancelada_em < ?`).get(ini, fim).n;
    const saldos = fin.saldos(db);
    res.json({
      motoristas_online: db.prepare(`SELECT COUNT(*) AS n FROM motoristas WHERE online = 1 AND posicao_em > ?`).get(corte).n,
      corridas_ativas: status,
      hoje: { finalizadas: dia.finalizadas, canceladas, bruto_centavos: dia.bruto, taxa_centavos: dia.taxa },
      pagamentos_pendentes: db.prepare(`SELECT COUNT(*) AS n FROM corridas WHERE status = 'finalizada' AND pagamento_status = 'pendente'`).get().n,
      motoristas_pendentes: db.prepare(`SELECT COUNT(*) AS n FROM motoristas WHERE situacao = 'pendente'`).get().n,
      veiculos_pendentes: db.prepare(`SELECT COUNT(*) AS n FROM veiculos WHERE situacao = 'pendente'`).get().n,
      a_repassar_centavos: saldos.filter((s) => s.saldo_centavos > 0).reduce((a, s) => a + s.saldo_centavos, 0),
      a_cobrar_centavos: -saldos.filter((s) => s.saldo_centavos < 0).reduce((a, s) => a + s.saldo_centavos, 0),
      repasses_pendentes: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(valor_centavos),0) AS total FROM repasses WHERE status = 'pendente'`).get(),
    });
  });

  /** Mapa ao vivo: motoristas online e corridas em curso. */
  r.get('/mapa', (_req, res) => {
    const corte = new Date(Date.now() - 5 * 60_000).toISOString();
    res.json({
      motoristas: db.prepare(`SELECT m.usuario_id AS id, u.nome, m.lat, m.lng, m.posicao_em, v.placa, v.categoria,
          (SELECT c.status FROM corridas c WHERE c.motorista_id = m.usuario_id AND c.status IN ('aceita','chegou','em_andamento') LIMIT 1) AS em_corrida
        FROM motoristas m JOIN usuarios u ON u.id = m.usuario_id LEFT JOIN veiculos v ON v.id = m.veiculo_id
        WHERE m.online = 1 AND m.lat IS NOT NULL AND m.posicao_em > ?`).all(corte),
      corridas: db.prepare(`SELECT c.id, c.status, c.categoria, c.origem_endereco, c.origem_lat, c.origem_lng, c.destino_endereco, c.destino_lat, c.destino_lng,
          c.solicitada_em, c.motorista_id, p.nome AS passageiro_nome, u.nome AS motorista_nome
        FROM corridas c JOIN usuarios p ON p.id = c.passageiro_id LEFT JOIN usuarios u ON u.id = c.motorista_id
        WHERE c.status IN ('solicitada','aceita','chegou','em_andamento') ORDER BY c.id`).all(),
    });
  });

  // Corridas
  r.get('/corridas', (req, res) => {
    const [de, ate] = periodo(req.query, 6);
    const [ini, fim] = intervalo(de, ate);
    const status = req.query.status ? v.opcao(req.query.status, 'o status', ['solicitada', 'aceita', 'chegou', 'em_andamento', 'finalizada', 'cancelada']) : null;
    const pendentes = req.query.pagamento === 'pendente';
    res.json(db.prepare(`SELECT c.id, c.status, c.categoria, c.origem_endereco, c.destino_endereco, c.solicitada_em, c.finalizada_em, c.cancelada_em, c.cancelada_por,
        c.forma_pagamento, c.pagamento_status, c.valor_estimado_centavos, c.valor_final_centavos, c.taxa_plataforma_centavos, c.nota_do_passageiro,
        p.nome AS passageiro_nome, u.nome AS motorista_nome
      FROM corridas c JOIN usuarios p ON p.id = c.passageiro_id LEFT JOIN usuarios u ON u.id = c.motorista_id
      WHERE c.solicitada_em >= ? AND c.solicitada_em < ? AND (? IS NULL OR c.status = ?) AND (? = 0 OR (c.status = 'finalizada' AND c.pagamento_status = 'pendente'))
      ORDER BY c.id DESC LIMIT 500`).all(ini, fim, status, status, pendentes ? 1 : 0));
  });
  r.get('/corridas/:id', (req, res) => res.json(cor.detalhar(db, cor.buscar(db, nid(req)))));
  r.post('/corridas/:id/cancelar', (req, res) => {
    v.texto(req.body.motivo, 'o motivo', 300);
    cor.cancelar(db, 'central', nid(req), req.body.motivo);
    registrar(db, req, 'corrida_cancelada', { corrida: nid(req), motivo: req.body.motivo });
    res.status(204).end();
  });
  r.post('/corridas/:id/pagamento', (req, res) => {
    cor.confirmarPagamento(db, nid(req), req.usuario);
    registrar(db, req, 'pagamento_confirmado', { corrida: nid(req) });
    res.status(204).end();
  });

  // Motoristas e veículos
  r.get('/motoristas', (req, res) => {
    const situacao = req.query.situacao ? v.opcao(req.query.situacao, 'a situação', ['pendente', 'aprovado', 'recusado', 'bloqueado']) : null;
    const lista = db.prepare(`SELECT m.usuario_id AS id, u.nome, u.email, u.telefone, u.ativo, m.cpf, m.cnh, m.cnh_validade, m.chave_pix, m.situacao, m.motivo,
        m.online, m.posicao_em, u.criado_em FROM motoristas m JOIN usuarios u ON u.id = m.usuario_id WHERE (? IS NULL OR m.situacao = ?) ORDER BY u.nome`).all(situacao, situacao);
    const veiculos = db.prepare('SELECT * FROM veiculos WHERE motorista_id = ? ORDER BY id');
    res.json(lista.map((m) => ({ ...m, veiculos: veiculos.all(m.id), saldo_centavos: fin.saldo(db, m.id), ...cor.notaMedia(db, m.id) })));
  });

  r.post('/motoristas/:id/situacao', (req, res) => {
    const situacao = v.opcao(req.body.situacao, 'a situação', ['aprovado', 'recusado', 'bloqueado']);
    const motivo = situacao === 'aprovado' ? null : v.texto(req.body.motivo, 'o motivo', 300);
    transacao(db, () => {
      const m = db.prepare('SELECT * FROM motoristas WHERE usuario_id = ?').get(nid(req));
      if (!m) throw naoEncontrado('Motorista');
      db.prepare('UPDATE motoristas SET situacao = ?, motivo = ?, analisado_em = ?, analisado_por = ?, online = CASE WHEN ? = \'aprovado\' THEN online ELSE 0 END WHERE usuario_id = ?')
        .run(situacao, motivo, agora(), req.usuario.id, situacao, m.usuario_id);
      // Ao aprovar o motorista, o veículo do cadastro (ainda pendente) é aprovado junto.
      if (situacao === 'aprovado') db.prepare("UPDATE veiculos SET situacao = 'aprovado' WHERE id = ? AND situacao = 'pendente'").run(m.veiculo_id);
      registrar(db, req, 'motorista_situacao', { motorista: m.usuario_id, situacao, motivo });
    });
    res.status(204).end();
  });

  r.post('/veiculos/:id/situacao', (req, res) => {
    const situacao = v.opcao(req.body.situacao, 'a situação', ['aprovado', 'recusado']);
    const x = db.prepare('UPDATE veiculos SET situacao = ? WHERE id = ?').run(situacao, nid(req));
    if (!x.changes) throw naoEncontrado('Veículo');
    if (situacao === 'recusado') db.prepare('UPDATE motoristas SET online = 0 WHERE veiculo_id = ?').run(nid(req));
    registrar(db, req, 'veiculo_situacao', { veiculo: nid(req), situacao });
    res.status(204).end();
  });

  // Passageiros
  r.get('/passageiros', (req, res) => {
    const busca = `%${String(req.query.busca ?? '').trim()}%`;
    res.json(db.prepare(`SELECT u.id, u.nome, u.email, u.telefone, u.ativo, u.criado_em,
        (SELECT COUNT(*) FROM corridas c WHERE c.passageiro_id = u.id AND c.status = 'finalizada') AS corridas,
        (SELECT ROUND(AVG(nota_do_motorista), 1) FROM corridas c WHERE c.passageiro_id = u.id) AS nota_media
      FROM usuarios u WHERE u.perfil = 'passageiro' AND (u.nome LIKE ? OR u.email LIKE ? OR u.telefone LIKE ?) ORDER BY u.nome LIMIT 200`).all(busca, busca, busca));
  });

  /** Ativa ou desativa a conta de um passageiro ou motorista. */
  r.post('/contas/:id/ativo', (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(nid(req));
    if (!u || !['passageiro', 'motorista'].includes(u.perfil)) throw naoEncontrado('Conta');
    const ativo = req.body.ativo === true ? 1 : 0;
    db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(ativo, u.id);
    if (!ativo && u.perfil === 'motorista') db.prepare('UPDATE motoristas SET online = 0 WHERE usuario_id = ?').run(u.id);
    registrar(db, req, 'conta_ativo', { usuario: u.id, ativo });
    res.status(204).end();
  });

  // Tarifas e configurações
  r.get('/tarifas', (_req, res) => res.json(db.prepare('SELECT * FROM tarifas ORDER BY categoria').all()));
  r.put('/tarifas/:categoria', soAdmin, (req, res) => {
    const c = v.opcao(req.params.categoria, 'a categoria', cor.CATEGORIAS);
    const n = (k, nome) => v.inteiro(req.body[k], nome, { min: 0, max: 1_000_000 });
    const t = [n('bandeirada_centavos', 'a bandeirada'), n('km_centavos', 'o valor do km'), n('km_bandeira2_centavos', 'o valor do km na bandeira 2'),
      n('minuto_centavos', 'o valor do minuto'), n('minima_centavos', 'a tarifa mínima')];
    db.prepare(`UPDATE tarifas SET bandeirada_centavos = ?, km_centavos = ?, km_bandeira2_centavos = ?, minuto_centavos = ?, minima_centavos = ?, atualizado_em = ?
      WHERE categoria = ?`).run(...t, agora(), c);
    registrar(db, req, 'tarifa_alterada', { categoria: c, valores: t });
    res.status(204).end();
  });

  r.get('/config', (_req, res) => res.json(lerConfig(db)));
  r.patch('/config', soAdmin, (req, res) => {
    const regras = {
      taxa_plataforma_bp: (x) => v.inteiro(x, 'a taxa da plataforma', { min: 0, max: 5000 }),
      raio_busca_km: (x) => v.numero(x, 'o raio de busca', { min: 0.5, max: 50 }),
      expirar_solicitacao_min: (x) => v.inteiro(x, 'o tempo de espera', { min: 1, max: 60 }),
      repasse_minimo_centavos: (x) => v.inteiro(x, 'o repasse mínimo', { min: 0, max: 10_000_000 }),
      fator_rota: (x) => v.numero(x, 'o fator de rota', { min: 1, max: 3 }),
      velocidade_media_kmh: (x) => v.numero(x, 'a velocidade média', { min: 5, max: 120 }),
      bandeira2_inicio_hora: (x) => v.inteiro(x, 'o início da bandeira 2', { min: 0, max: 23 }),
      bandeira2_fim_hora: (x) => v.inteiro(x, 'o fim da bandeira 2', { min: 0, max: 23 }),
      bandeira2_domingo: (x) => (x ? 1 : 0),
      bandeira2_feriados: (x) => (x ? 1 : 0),
      pix_chave: (x) => v.opcional(x, 'a chave PIX', 77) ?? '',
      pix_recebedor: (x) => v.texto(x, 'o nome do recebedor', 25),
      pix_cidade: (x) => v.texto(x, 'a cidade', 15),
    };
    const alteradas = Object.keys(req.body).filter((k) => k in CONFIG_PADRAO);
    v.exigir(alteradas.length, 'Nenhuma configuração enviada.');
    const valores = Object.fromEntries(alteradas.map((k) => [k, String(regras[k](req.body[k]))]));
    transacao(db, () => {
      for (const [k, val] of Object.entries(valores)) db.prepare('UPDATE configuracoes SET valor = ? WHERE chave = ?').run(val, k);
    });
    registrar(db, req, 'config_alterada', valores);
    res.status(204).end();
  });

  // Financeiro: saldos, repasses, ajustes, relatório e exportação
  r.get('/saldos', (_req, res) => res.json(fin.saldos(db)));
  r.get('/motoristas/:id/extrato', (req, res) => res.json({ saldo_centavos: fin.saldo(db, nid(req)), lancamentos: fin.extrato(db, nid(req), 200) }));
  r.post('/motoristas/:id/ajuste', soAdmin, (req, res) => {
    if (!db.prepare('SELECT 1 FROM motoristas WHERE usuario_id = ?').get(nid(req))) throw naoEncontrado('Motorista');
    fin.ajustar(db, req.usuario, nid(req), req.body.valor_centavos, req.body.motivo);
    registrar(db, req, 'ajuste_motorista', { motorista: nid(req), valor: req.body.valor_centavos, motivo: req.body.motivo });
    res.status(204).end();
  });

  r.get('/repasses', (req, res) => {
    const status = req.query.status ? v.opcao(req.query.status, 'o status', ['pendente', 'pago', 'cancelado']) : null;
    res.json(db.prepare(`SELECT r.*, u.nome, m.cpf FROM repasses r JOIN usuarios u ON u.id = r.motorista_id JOIN motoristas m ON m.usuario_id = r.motorista_id
      WHERE (? IS NULL OR r.status = ?) ORDER BY r.id DESC LIMIT 300`).all(status, status));
  });
  r.post('/repasses', (req, res) => {
    const ids = Array.isArray(req.body.motorista_ids) ? req.body.motorista_ids.map(Number) : null;
    const out = fin.gerarRepasses(db, req.usuario, ids);
    registrar(db, req, 'repasses_gerados', out.gerados.map((g) => g.id));
    res.status(201).json(out);
  });
  r.post('/repasses/:id/pagar', (req, res) => {
    fin.pagarRepasse(db, req.usuario, nid(req), req.body.identificador);
    registrar(db, req, 'repasse_pago', { repasse: nid(req), identificador: req.body.identificador });
    res.status(204).end();
  });
  r.post('/repasses/:id/cancelar', (req, res) => {
    fin.cancelarRepasse(db, req.usuario, nid(req), req.body.motivo);
    registrar(db, req, 'repasse_cancelado', { repasse: nid(req), motivo: req.body.motivo });
    res.status(204).end();
  });

  r.get('/relatorio', (req, res) => res.json(fin.relatorio(db, ...periodo(req.query, 29))));
  r.get('/exportar-bpo', (req, res) => {
    const [de, ate] = periodo(req.query, 29);
    const csv = fin.exportarBpo(db, de, ate, {
      categoriaReceita: v.opcional(req.query.categoria_receita, 'a categoria de receita', 120) ?? undefined,
      categoriaDespesa: v.opcional(req.query.categoria_despesa, 'a categoria de despesa', 120) ?? undefined,
    });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="taxi-bpo-${de}-a-${ate}.csv"` }).send(`﻿${csv}`);
  });

  // Equipe da central (só administrador)
  r.get('/equipe', soAdmin, (_req, res) => res.json(db.prepare(`SELECT id, nome, email, telefone, perfil, ativo, ultimo_acesso FROM usuarios
    WHERE perfil IN ('admin','operador') ORDER BY nome`).all()));
  r.post('/equipe', soAdmin, (req, res) => {
    const email = v.email(req.body.email);
    if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Já existe uma conta com este e-mail.', 409);
    const perfil = v.opcao(req.body.perfil ?? 'operador', 'o perfil', ['admin', 'operador']);
    const x = db.prepare('INSERT INTO usuarios (nome, email, telefone, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(v.texto(req.body.nome, 'o nome', 120), email, req.body.telefone ? v.telefone(req.body.telefone) : null, hashSenha(v.senha(req.body.senha)), perfil, agora());
    registrar(db, req, 'equipe_criada', { usuario: Number(x.lastInsertRowid), perfil });
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.post('/equipe/:id/ativo', soAdmin, (req, res) => {
    if (nid(req) === req.usuario.id) throw new ErroNegocio('Você não pode desativar a própria conta.', 422);
    const x = db.prepare("UPDATE usuarios SET ativo = ? WHERE id = ? AND perfil IN ('admin','operador')").run(req.body.ativo === true ? 1 : 0, nid(req));
    if (!x.changes) throw naoEncontrado('Usuário');
    registrar(db, req, 'equipe_ativo', { usuario: nid(req), ativo: req.body.ativo === true });
    res.status(204).end();
  });

  r.get('/auditoria', soAdmin, (_req, res) => res.json(db.prepare(`SELECT a.*, u.nome FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
    ORDER BY a.id DESC LIMIT 300`).all()));

  return r;
};
