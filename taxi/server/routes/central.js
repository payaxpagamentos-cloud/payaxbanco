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
const pag = require('../lib/pagamentos');
const emp = require('../lib/empresas');
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
    const status = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM corridas WHERE status IN ('aguardando_pagamento','solicitada','aceita','chegou','em_andamento') GROUP BY status`)
      .all().map((x) => [x.status, x.n]));
    const dia = db.prepare(`SELECT COUNT(*) AS finalizadas, COALESCE(SUM(valor_final_centavos),0) AS bruto, COALESCE(SUM(taxa_plataforma_centavos),0) AS taxa
      FROM corridas WHERE status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`).get(ini, fim);
    const canceladas = db.prepare(`SELECT COUNT(*) AS n FROM corridas WHERE status = 'cancelada' AND cancelada_em >= ? AND cancelada_em < ?`).get(ini, fim).n;
    const saldos = fin.saldos(db);
    res.json({
      motoristas_online: db.prepare(`SELECT COUNT(*) AS n FROM motoristas WHERE online = 1 AND posicao_em > ?`).get(corte).n,
      corridas_ativas: status,
      hoje: { finalizadas: dia.finalizadas, canceladas, bruto_centavos: dia.bruto, taxa_centavos: dia.taxa },
      // Na central: PIX a confirmar (modo manual) e estornos a devolver.
      cobrancas_pendentes: Object.fromEntries(db.prepare(`SELECT tipo, COUNT(*) AS n FROM cobrancas WHERE status = 'pendente' GROUP BY tipo`).all().map((x) => [x.tipo, x.n])),
      faturas_abertas: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(valor_centavos),0) AS total FROM faturas WHERE status = 'aberta'`).get(),
      motoristas_pendentes: db.prepare(`SELECT COUNT(*) AS n FROM motoristas WHERE situacao = 'pendente'`).get().n,
      veiculos_pendentes: db.prepare(`SELECT COUNT(*) AS n FROM veiculos WHERE situacao = 'pendente'`).get().n,
      a_repassar_centavos: saldos.filter((s) => s.saldo_centavos > 0).reduce((a, s) => a + s.saldo_centavos, 0),
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
        WHERE c.status IN ('aguardando_pagamento','solicitada','aceita','chegou','em_andamento') ORDER BY c.id`).all(),
    });
  });

  // Corridas
  r.get('/corridas', (req, res) => {
    const [de, ate] = periodo(req.query, 6);
    const [ini, fim] = intervalo(de, ate);
    const status = req.query.status ? v.opcao(req.query.status, 'o status', ['aguardando_pagamento', 'solicitada', 'aceita', 'chegou', 'em_andamento', 'finalizada', 'cancelada']) : null;
    const pendentes = req.query.pagamento === 'pendente';
    res.json(db.prepare(`SELECT c.id, c.status, c.categoria, c.origem_endereco, c.destino_endereco, c.solicitada_em, c.finalizada_em, c.cancelada_em, c.cancelada_por,
        c.forma_pagamento, c.pagamento_status, c.empresa_id, c.valor_estimado_centavos, c.valor_final_centavos, c.taxa_plataforma_centavos, c.nota_do_passageiro,
        p.nome AS passageiro_nome, u.nome AS motorista_nome
      FROM corridas c JOIN usuarios p ON p.id = c.passageiro_id LEFT JOIN usuarios u ON u.id = c.motorista_id
      WHERE c.criada_em >= ? AND c.criada_em < ? AND (? IS NULL OR c.status = ?) AND (? = 0 OR c.pagamento_status = 'pendente')
      ORDER BY c.id DESC LIMIT 500`).all(ini, fim, status, status, pendentes ? 1 : 0));
  });
  r.get('/corridas/:id', (req, res) => res.json(cor.detalhar(db, cor.buscar(db, nid(req)))));
  r.post('/corridas/:id/cancelar', (req, res) => {
    v.texto(req.body.motivo, 'o motivo', 300);
    cor.cancelar(db, 'central', nid(req), req.body.motivo);
    registrar(db, req, 'corrida_cancelada', { corrida: nid(req), motivo: req.body.motivo });
    res.status(204).end();
  });

  // Cobranças: PIX recebido na chave da plataforma (modo manual) e estornos devolvidos.
  r.get('/cobrancas', (req, res) => {
    const status = req.query.status ? v.opcao(req.query.status, 'o status', ['pendente', 'concluida', 'cancelada']) : null;
    res.json(db.prepare(`SELECT b.*, c.status AS corrida_status, u.nome AS passageiro_nome, u.email AS passageiro_email FROM cobrancas b
      JOIN corridas c ON c.id = b.corrida_id JOIN usuarios u ON u.id = c.passageiro_id WHERE (? IS NULL OR b.status = ?) ORDER BY b.id DESC LIMIT 300`).all(status, status));
  });
  r.post('/cobrancas/:id/concluir', (req, res) => {
    const cob = pag.buscar(db, nid(req));
    const ident = v.texto(req.body.identificador, cob.tipo === 'estorno' ? 'o identificador da devolução' : 'o identificador do pagamento (E2E do PIX)', 100);
    transacao(db, () => pag.concluir(db, cob.id, req.usuario.id, ident));
    registrar(db, req, cob.tipo === 'estorno' ? 'estorno_concluido' : 'pagamento_confirmado', { cobranca: cob.id, corrida: cob.corrida_id, identificador: ident });
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
      expirar_pagamento_min: (x) => v.inteiro(x, 'o prazo para pagar', { min: 2, max: 60 }),
      repasse_minimo_centavos: (x) => v.inteiro(x, 'o valor mínimo do PIX', { min: 0, max: 10_000_000 }),
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

  // Financeiro: saldos, PIX pedidos pelos motoristas (repasses), ajustes, relatório e exportação
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
  /** Pedidos de PIX dos motoristas: a gestão libera (faz a transferência e registra o identificador) ou recusa (o valor volta ao saldo). */
  r.post('/repasses/:id/liberar', (req, res) => {
    fin.liberarPix(db, req.usuario, nid(req), req.body.identificador);
    registrar(db, req, 'pix_liberado', { pedido: nid(req), identificador: req.body.identificador });
    res.status(204).end();
  });
  r.post('/repasses/:id/recusar', (req, res) => {
    fin.recusarPix(db, req.usuario, nid(req), req.body.motivo);
    registrar(db, req, 'pix_recusado', { pedido: nid(req), motivo: req.body.motivo });
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

  // Empresas (corridas faturadas) e passageiros autorizados a pedir por elas
  const dadosEmpresa = (b, parcial = false) => {
    const d = {};
    if (!parcial || b.razao_social !== undefined) d.razao_social = v.texto(b.razao_social, 'a razão social', 160);
    if (!parcial || b.cnpj !== undefined) { v.exigir(v.cnpjValido(b.cnpj), 'CNPJ inválido.'); d.cnpj = v.digitos(b.cnpj); }
    if (!parcial || b.email_financeiro !== undefined) d.email_financeiro = v.email(b.email_financeiro);
    if (b.telefone !== undefined) d.telefone = b.telefone ? v.telefone(b.telefone) : null;
    if (b.limite_mensal_centavos !== undefined) d.limite_mensal_centavos = b.limite_mensal_centavos ? v.inteiro(b.limite_mensal_centavos, 'o limite mensal', { min: 1 }) : null;
    if (b.dia_vencimento !== undefined) d.dia_vencimento = v.inteiro(b.dia_vencimento, 'o dia de vencimento', { min: 1, max: 28 });
    if (b.ativa !== undefined) d.ativa = b.ativa ? 1 : 0;
    return d;
  };
  r.get('/empresas', (_req, res) => res.json(db.prepare(`SELECT e.*,
      (SELECT COUNT(*) FROM empresa_usuarios eu WHERE eu.empresa_id = e.id AND eu.ativo = 1) AS usuarios_autorizados
    FROM empresas e ORDER BY e.razao_social`).all().map((e) => ({ ...e, gasto_mes_centavos: emp.gastoNoMes(db, e.id) }))));
  r.post('/empresas', (req, res) => {
    const d = dadosEmpresa(req.body);
    if (db.prepare('SELECT 1 FROM empresas WHERE cnpj = ?').get(d.cnpj)) throw new ErroNegocio('Empresa já cadastrada com este CNPJ.', 409);
    const cols = Object.keys(d);
    const x = db.prepare(`INSERT INTO empresas (${cols.join(', ')}, criada_em) VALUES (${cols.map(() => '?').join(', ')}, ?)`).run(...Object.values(d), agora());
    registrar(db, req, 'empresa_criada', { empresa: Number(x.lastInsertRowid), ...d });
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.patch('/empresas/:id', (req, res) => {
    emp.buscar(db, nid(req));
    const d = dadosEmpresa(req.body, true);
    v.exigir(Object.keys(d).length, 'Nada para alterar.');
    db.prepare(`UPDATE empresas SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), nid(req));
    registrar(db, req, 'empresa_alterada', { empresa: nid(req), ...d });
    res.status(204).end();
  });

  r.get('/empresas/:id/usuarios', (req, res) => {
    emp.buscar(db, nid(req));
    res.json(db.prepare(`SELECT eu.usuario_id, u.nome, u.email, u.telefone, eu.ativo, eu.limite_mensal_centavos, eu.centro_custo, eu.autorizado_em
      FROM empresa_usuarios eu JOIN usuarios u ON u.id = eu.usuario_id WHERE eu.empresa_id = ? ORDER BY u.nome`).all(nid(req))
      .map((u) => ({ ...u, gasto_mes_centavos: emp.gastoNoMes(db, nid(req), u.usuario_id) })));
  });
  /** Autoriza um passageiro (pelo e-mail da conta dele no app) a pedir corridas pela empresa. */
  r.post('/empresas/:id/usuarios', (req, res) => {
    const e = emp.buscar(db, nid(req));
    const u = db.prepare(`SELECT id, perfil FROM usuarios WHERE email = ?`).get(v.email(req.body.email));
    if (!u || u.perfil !== 'passageiro') throw new ErroNegocio('Nenhum passageiro com este e-mail. Peça para a pessoa criar a conta no app primeiro.', 404);
    const limite = req.body.limite_mensal_centavos ? v.inteiro(req.body.limite_mensal_centavos, 'o limite mensal', { min: 1 }) : null;
    const centro = v.opcional(req.body.centro_custo, 'o centro de custo', 80);
    db.prepare(`INSERT INTO empresa_usuarios (empresa_id, usuario_id, limite_mensal_centavos, centro_custo, autorizado_em, autorizado_por) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (empresa_id, usuario_id) DO UPDATE SET ativo = 1, limite_mensal_centavos = excluded.limite_mensal_centavos, centro_custo = excluded.centro_custo,
      autorizado_em = excluded.autorizado_em, autorizado_por = excluded.autorizado_por`).run(e.id, u.id, limite, centro, agora(), req.usuario.id);
    registrar(db, req, 'empresa_usuario_autorizado', { empresa: e.id, usuario: u.id, limite, centro });
    res.status(201).json({ usuario_id: u.id });
  });
  r.patch('/empresas/:id/usuarios/:uid', (req, res) => {
    const sets = [];
    const vals = [];
    if (req.body.ativo !== undefined) { sets.push('ativo = ?'); vals.push(req.body.ativo ? 1 : 0); }
    if (req.body.limite_mensal_centavos !== undefined) {
      sets.push('limite_mensal_centavos = ?');
      vals.push(req.body.limite_mensal_centavos ? v.inteiro(req.body.limite_mensal_centavos, 'o limite mensal', { min: 1 }) : null);
    }
    if (req.body.centro_custo !== undefined) { sets.push('centro_custo = ?'); vals.push(v.opcional(req.body.centro_custo, 'o centro de custo', 80)); }
    v.exigir(sets.length, 'Nada para alterar.');
    const x = db.prepare(`UPDATE empresa_usuarios SET ${sets.join(', ')} WHERE empresa_id = ? AND usuario_id = ?`).run(...vals, nid(req), Number(req.params.uid));
    if (!x.changes) throw naoEncontrado('Autorização');
    registrar(db, req, 'empresa_usuario_alterado', { empresa: nid(req), usuario: Number(req.params.uid), ...req.body });
    res.status(204).end();
  });

  r.get('/empresas/:id/corridas', (req, res) => {
    emp.buscar(db, nid(req));
    res.json(emp.corridasDaEmpresa(db, nid(req), { competencia: req.query.competencia ?? hoje().slice(0, 7) }));
  });
  r.get('/empresas/:id/faturas', (req, res) => res.json(db.prepare('SELECT * FROM faturas WHERE empresa_id = ? ORDER BY competencia DESC').all(nid(req))));
  r.post('/empresas/:id/faturas', (req, res) => {
    const f = emp.gerarFatura(db, req.usuario, nid(req), req.body.competencia);
    registrar(db, req, 'fatura_gerada', { empresa: nid(req), competencia: req.body.competencia, ...f });
    res.status(201).json(f);
  });
  const fatura = (id) => {
    const f = db.prepare('SELECT * FROM faturas WHERE id = ?').get(id);
    if (!f) throw naoEncontrado('Fatura');
    return f;
  };
  r.post('/faturas/:id/pagar', (req, res) => {
    const f = fatura(nid(req));
    if (f.status !== 'aberta') throw new ErroNegocio('Fatura já paga ou cancelada.', 409);
    const ident = v.texto(req.body.identificador, 'o identificador do pagamento', 100);
    db.prepare(`UPDATE faturas SET status = 'paga', paga_em = ?, identificador = ? WHERE id = ?`).run(agora(), ident, f.id);
    registrar(db, req, 'fatura_paga', { fatura: f.id, identificador: ident });
    res.status(204).end();
  });
  /** Cancela a fatura e libera as corridas para uma nova (ex.: corrigir uma corrida antes de reenviar). */
  r.post('/faturas/:id/cancelar', (req, res) => {
    const f = fatura(nid(req));
    if (f.status !== 'aberta') throw new ErroNegocio('Só faturas abertas podem ser canceladas.', 409);
    transacao(db, () => {
      db.prepare(`UPDATE faturas SET status = 'cancelada' WHERE id = ?`).run(f.id);
      db.prepare('UPDATE corridas SET fatura_id = NULL WHERE fatura_id = ?').run(f.id);
    });
    registrar(db, req, 'fatura_cancelada', { fatura: f.id, motivo: v.texto(req.body.motivo, 'o motivo', 300) });
    res.status(204).end();
  });
  /** Extrato da fatura em CSV para enviar à empresa. */
  r.get('/faturas/:id/csv', (req, res) => {
    const f = fatura(nid(req));
    const e = emp.buscar(db, f.empresa_id);
    const linhas = [['Corrida', 'Data', 'Passageiro', 'E-mail', 'Centro de custo', 'Origem', 'Destino', 'Km', 'Valor']];
    for (const c of emp.corridasDaEmpresa(db, f.empresa_id, { faturaId: f.id })) {
      linhas.push([c.id, c.finalizada_em.slice(0, 10).split('-').reverse().join('/'), c.passageiro, c.email, c.centro_custo ?? '', c.origem_endereco, c.destino_endereco,
        (c.distancia_percorrida_m / 1000).toFixed(1).replace('.', ','), (c.valor_final_centavos / 100).toFixed(2).replace('.', ',')]);
    }
    linhas.push(['', '', '', '', '', '', 'Total', '', (f.valor_centavos / 100).toFixed(2).replace('.', ',')]);
    const csv = linhas.map((l) => l.map((t) => (/[;"\n]/.test(String(t)) ? `"${String(t).replace(/"/g, '""')}"` : String(t))).join(';')).join('\r\n');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="fatura-${e.cnpj}-${f.competencia}.csv"` }).send(`\ufeff${csv}\r\n`);
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
