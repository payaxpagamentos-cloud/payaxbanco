'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, csv } = require('../lib/http');
const { dataLocal, dataBr } = require('../lib/datas');
const cob = require('../lib/cobranca');
const fat = require('../lib/faturamento');
const v = require('../lib/validacao');

const ACOES = ['avisar', 'bloquear', 'indicar_cancelamento'];
const CANAIS = ['sistema', 'email', 'whatsapp'];
const TIPOS_BLOQUEIO = ['inadimplencia', 'pedido', 'tecnico', 'administrativo'];

/*
 * Régua de cobrança, inadimplência e bloqueio.
 *
 * Editar uma regra não altera a regra que já executou: cria a versão seguinte e aposenta a anterior, que continua
 * explicando os bloqueios e avisos que originou. Nenhum cancelamento de contrato é automático.
 */
module.exports = (db) => {
  const r = Router();
  const hoje = (req) => dataLocal(req.usuario.fuso);
  const organizacao = (req) => db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org);
  const contrato = (req, id) => {
    const x = db.prepare('SELECT * FROM contratos WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Contrato não encontrado.', 404);
    return x;
  };

  function dadosRegra(b, atual = {}) {
    const val = (k, f) => (b[k] !== undefined ? f(b[k]) : atual[k] ?? null);
    return {
      nome: val('nome', (x) => v.texto(x, 'o nome da regra', 120)),
      dias: b.dias !== undefined && b.dias !== '' ? v.inteiro(b.dias, 'os dias', { min: -60, max: 365 }) : atual.dias,
      acao: val('acao', (x) => v.opcao(x, 'a ação', ACOES)),
      canal: val('canal', (x) => v.opcao(x, 'o canal', CANAIS)) ?? 'sistema',
      texto: val('texto', (x) => v.opcional(x, 'o texto do aviso', 1000)),
    };
  }

  // ---------------- Regras ----------------
  r.get('/regras', exigir('cobranca.ver'), (req, res) => {
    const regras = db.prepare(`SELECT rr.*, u.nome AS criada_por_nome,
      (SELECT COUNT(*) FROM regua_eventos ev WHERE ev.regra_id = rr.id) AS execucoes
      FROM regua_regras rr LEFT JOIN usuarios u ON u.id = rr.criada_por WHERE rr.organizacao_id = ?
      ORDER BY rr.ativa DESC, rr.dias, rr.id`).all(req.org);
    res.json({ regras, carencia_organizacao: organizacao(req).carencia_bloqueio_dias });
  });

  r.post('/regras', exigir('cobranca.regras'), (req, res) => {
    const d = dadosRegra(req.body ?? {});
    v.exigir(d.nome && d.acao && d.dias !== null && d.dias !== undefined, 'Informe nome, dias e ação.');
    if (d.acao === 'bloquear') v.exigir(d.dias >= 0, 'Bloquear antes do vencimento não é possível: use dias zero ou em atraso.');
    const id = Number(db.prepare(`INSERT INTO regua_regras (organizacao_id, nome, dias, acao, canal, texto, criada_por, criada_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, d.nome, d.dias, d.acao, d.canal, d.texto, req.usuario.id, agora()).lastInsertRowid);
    registrar(db, req, 'regua_regra_criada', { recurso: 'regua_regra', recursoId: id, depois: d });
    const carencia = organizacao(req).carencia_bloqueio_dias;
    res.status(201).json({
      ...db.prepare('SELECT * FROM regua_regras WHERE id = ?').get(id),
      aviso: d.acao === 'bloquear' && d.dias < carencia
        ? `A carência da operação é de ${carencia} dia(s): esta regra só vai bloquear a partir dela, não aos ${d.dias}.` : null,
    });
  });

  /** Alterar é criar a versão seguinte: a regra anterior fica aposentada e apontando para a nova. */
  r.patch('/regras/:id', exigir('cobranca.regras'), (req, res) => {
    const antes = db.prepare('SELECT * FROM regua_regras WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!antes) throw new ErroNegocio('Regra não encontrada.', 404);
    if (!antes.ativa) throw new ErroNegocio('Esta regra já foi aposentada. Crie uma regra nova.', 422);
    const d = dadosRegra(req.body ?? {}, antes);
    if (d.acao === 'bloquear') v.exigir(d.dias >= 0, 'Bloquear antes do vencimento não é possível: use dias zero ou em atraso.');
    const id = transacao(db, () => {
      const nova = Number(db.prepare(`INSERT INTO regua_regras (organizacao_id, nome, dias, acao, canal, texto, versao, criada_por, criada_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, d.nome, d.dias, d.acao, d.canal, d.texto, antes.versao + 1, req.usuario.id, agora()).lastInsertRowid);
      db.prepare('UPDATE regua_regras SET ativa = 0, substituida_por = ? WHERE id = ?').run(nova, antes.id);
      return nova;
    });
    registrar(db, req, 'regua_regra_versionada', { recurso: 'regua_regra', recursoId: id, antes, depois: { ...d, versao: antes.versao + 1 } });
    res.json({ ...db.prepare('SELECT * FROM regua_regras WHERE id = ?').get(id), substituiu: antes.id });
  });

  r.post('/regras/:id/desativar', exigir('cobranca.regras'), (req, res) => {
    const regra = db.prepare('SELECT * FROM regua_regras WHERE id = ? AND organizacao_id = ? AND ativa = 1').get(Number(req.params.id), req.org);
    if (!regra) throw new ErroNegocio('Regra não encontrada ou já aposentada.', 404);
    db.prepare('UPDATE regua_regras SET ativa = 0 WHERE id = ?').run(regra.id);
    registrar(db, req, 'regua_regra_desativada', { recurso: 'regua_regra', recursoId: regra.id, antes: regra });
    res.json({ ...regra, ativa: 0 });
  });

  // ---------------- Execução ----------------
  r.post('/executar', exigir('cobranca.executar'), (req, res) => {
    const d = req.body?.data ? v.data(req.body.data, 'a data') : hoje(req);
    v.exigir(d <= hoje(req), 'A régua não roda com data no futuro.');
    const resultado = cob.rotinaDiaria(db, req.org, d);
    registrar(db, req, 'cobranca_executada', { recurso: 'cobranca', depois: { data: d, bloqueios: resultado.regua.bloqueios, avisos: resultado.regua.avisos,
      indicacoes: resultado.regua.indicacoes, confiancas_expiradas: resultado.confiancas.expiradas } });
    res.json(resultado);
  });

  r.get('/execucoes', exigir('cobranca.ver'), (req, res) => {
    res.json(db.prepare("SELECT * FROM sincronizacoes WHERE organizacao_id = ? AND tipo = 'cobranca' ORDER BY id DESC LIMIT 30").all(req.org));
  });

  r.get('/eventos', exigir('cobranca.ver'), (req, res) => {
    const f = ['ev.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.resultado) { f.push('ev.resultado = ?'); p.push(v.opcao(req.query.resultado, 'o resultado', ['executada', 'pendente_envio', 'ignorada'])); }
    if (req.query.pendentes === '1') { f.push("ev.resultado = 'pendente_envio' AND ev.enviado_em IS NULL"); }
    if (req.query.acao) { f.push('ev.acao = ?'); p.push(v.opcao(req.query.acao, 'a ação', ACOES)); }
    res.json(listaPaginada(db, `SELECT ev.*, rr.nome AS regra_nome, rr.texto AS regra_texto, f.numero AS fatura_numero, f.vencimento, f.valor_centavos, f.pago_centavos,
      f.situacao AS fatura_situacao, a.nome AS assinante_nome, a.codigo AS assinante_codigo, a.telefone, a.email, c.numero AS contrato_numero
      FROM regua_eventos ev JOIN regua_regras rr ON rr.id = ev.regra_id JOIN faturas f ON f.id = ev.fatura_id JOIN assinantes a ON a.id = f.assinante_id
      LEFT JOIN contratos c ON c.id = ev.contrato_id WHERE ${f.join(' AND ')} ORDER BY ev.id DESC`, p, req.query));
  });

  /** Marca o aviso como despachado pelo canal da operação (o envio em si depende do serviço contratado). */
  r.post('/eventos/:id/enviado', exigir('cobranca.executar'), (req, res) => {
    const ev = db.prepare('SELECT * FROM regua_eventos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!ev) throw new ErroNegocio('Evento de cobrança não encontrado.', 404);
    if (ev.enviado_em) throw new ErroNegocio('Este aviso já está marcado como enviado.', 422);
    if (ev.resultado !== 'pendente_envio') throw new ErroNegocio('Este evento não é um aviso pendente de envio.', 422);
    db.prepare('UPDATE regua_eventos SET enviado_em = ?, enviado_por = ? WHERE id = ?').run(agora(), req.usuario.id, ev.id);
    registrar(db, req, 'cobranca_aviso_enviado', { recurso: 'regua_evento', recursoId: ev.id, depois: { canal: ev.canal } });
    res.json({ ...ev, enviado_em: agora(), enviado_por: req.usuario.id });
  });

  // ---------------- Inadimplência ----------------
  r.get('/inadimplencia', exigir('cobranca.ver'), (req, res) => res.json(cob.inadimplencia(db, req.org, hoje(req))));

  r.get('/inadimplencia/csv', exigir('cobranca.ver'), (req, res) => {
    const d = hoje(req);
    const dados = cob.inadimplencia(db, req.org, d);
    const real = (c) => (c / 100).toFixed(2).replace('.', ',');
    const linhas = [['Código', 'Assinante', 'Telefone', 'Faturas vencidas', 'Saldo (R$)', 'Total devido (R$)', 'Maior atraso (dias)', 'Serviço bloqueado']];
    for (const x of dados.devedores) linhas.push([x.codigo, x.nome, x.telefone, x.faturas, real(x.saldo_centavos), real(x.devido_centavos), x.atraso_dias, x.bloqueado ? 'Sim' : 'Não']);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="inadimplencia-${d}.csv"` }).send(csv(linhas));
  });

  // ---------------- Bloqueio e desbloqueio ----------------
  r.get('/bloqueios', exigir('cobranca.ver'), (req, res) => {
    const f = ['b.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.abertos !== '0') f.push('b.fim IS NULL');
    if (req.query.tipo) { f.push('b.tipo = ?'); p.push(v.opcao(req.query.tipo, 'o tipo', TIPOS_BLOQUEIO)); }
    res.json(listaPaginada(db, `SELECT b.*, c.numero AS contrato_numero, a.nome AS assinante_nome, a.codigo AS assinante_codigo, a.telefone,
      u.nome AS criado_por_nome, l.nome AS liberado_por_nome, rr.nome AS regra_nome, f.numero AS fatura_numero
      FROM bloqueios b JOIN contratos c ON c.id = b.contrato_id JOIN assinantes a ON a.id = c.assinante_id
      LEFT JOIN usuarios u ON u.id = b.criado_por LEFT JOIN usuarios l ON l.id = b.liberado_por LEFT JOIN regua_regras rr ON rr.id = b.regra_id
      LEFT JOIN faturas f ON f.id = b.fatura_id WHERE ${f.join(' AND ')} ORDER BY b.id DESC`, p, req.query));
  });

  r.post('/contratos/:id/bloquear', exigir('bloqueios.aplicar'), (req, res) => {
    const c = contrato(req, req.params.id);
    const tipo = v.opcao(req.body?.tipo, 'o tipo', TIPOS_BLOQUEIO);
    const motivo = v.texto(req.body?.motivo, 'o motivo', 300);
    const resultado = transacao(db, () => cob.bloquear(db, { contrato: c, tipo, motivo, usuarioId: req.usuario.id, hoje: hoje(req) }));
    registrar(db, req, 'contrato_bloqueado', { recurso: 'contrato', recursoId: c.id, antes: c, depois: { tipo, motivo, ...resultado } });
    res.status(201).json({ ...resultado, contrato: db.prepare('SELECT * FROM contratos WHERE id = ?').get(c.id) });
  });

  r.post('/contratos/:id/desbloquear', exigir('bloqueios.liberar'), (req, res) => {
    const c = contrato(req, req.params.id);
    const motivo = v.texto(req.body?.motivo, 'o motivo da liberação', 300);
    const posicao = fat.posicaoDoContrato(db, c.id, hoje(req));
    const resultado = transacao(db, () => cob.desbloquear(db, { contrato: c, motivo, usuarioId: req.usuario.id }));
    registrar(db, req, 'contrato_desbloqueado', { recurso: 'contrato', recursoId: c.id, antes: c, depois: { motivo, saldo_centavos: posicao.saldo_centavos } });
    res.json({
      ...resultado,
      contrato: db.prepare('SELECT * FROM contratos WHERE id = ?').get(c.id),
      aviso: posicao.vencidas
        ? `Liberado com ${posicao.vencidas} fatura(s) vencida(s) em aberto: a régua pode bloquear de novo na próxima execução. Para segurar por um prazo, use o desbloqueio de confiança.`
        : null,
    });
  });

  r.post('/contratos/:id/confianca', exigir('bloqueios.liberar'), (req, res) => {
    const c = contrato(req, req.params.id);
    const org = organizacao(req);
    const dias = req.body?.dias !== undefined && req.body.dias !== '' ? v.inteiro(req.body.dias, 'os dias', { min: 1, max: 90 }) : org.confianca_dias;
    const motivo = v.opcional(req.body?.motivo, 'o motivo', 300);
    const resultado = transacao(db, () => cob.concederConfianca(db, { organizacao: org, contrato: c, dias, motivo, usuarioId: req.usuario.id, hoje: hoje(req) }));
    registrar(db, req, 'confianca_concedida', { recurso: 'contrato', recursoId: c.id, depois: { ...resultado, motivo } });
    res.status(201).json({
      ...resultado,
      contrato: db.prepare('SELECT * FROM contratos WHERE id = ?').get(c.id),
      aviso: `Serviço liberado até ${dataBr(resultado.ate)}. Sem pagamento até lá, a rotina bloqueia de novo automaticamente.`,
    });
  });

  r.get('/confiancas', exigir('cobranca.ver'), (req, res) => {
    const d = hoje(req);
    res.json(listaPaginada(db, `SELECT cf.*, c.numero AS contrato_numero, a.nome AS assinante_nome, a.codigo AS assinante_codigo, u.nome AS concedida_por_nome,
      CASE WHEN cf.encerrada_em IS NULL AND cf.ate >= ? THEN 'vigente' WHEN cf.encerrada_em IS NULL THEN 'vencendo' ELSE cf.encerramento END AS estado
      FROM confiancas cf JOIN contratos c ON c.id = cf.contrato_id JOIN assinantes a ON a.id = c.assinante_id
      LEFT JOIN usuarios u ON u.id = cf.concedida_por WHERE cf.organizacao_id = ? ORDER BY cf.id DESC`, [d, req.org], req.query));
  });

  return r;
};
