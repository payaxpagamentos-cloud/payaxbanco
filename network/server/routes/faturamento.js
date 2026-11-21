'use strict';

const { Router } = require('express');
const { transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, like, csv } = require('../lib/http');
const { dataLocal, somarDias, competenciaBr } = require('../lib/datas');
const cob = require('../lib/cobranca');
const fat = require('../lib/faturamento');
const v = require('../lib/validacao');

const FORMAS = ['pix', 'boleto', 'dinheiro', 'cartao', 'transferencia', 'outro'];
const SITUACOES = ['aberta', 'parcial', 'paga', 'cancelada'];

/*
 * Faturas, ciclo mensal e baixas.
 *
 * O ciclo pode ser simulado quantas vezes quiser: a simulação não grava nada e não consome número de fatura.
 * Depois de efetivada, a competência não roda de novo — o que muda depois é fatura avulsa ou correção com
 * cancelamento e nova emissão, sempre com motivo registrado.
 */
module.exports = (db) => {
  const r = Router();
  const hoje = (req) => dataLocal(req.usuario.fuso);
  const organizacao = (req) => db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org);
  const buscar = (req, id) => {
    const x = db.prepare('SELECT * FROM faturas WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Fatura não encontrada.', 404);
    return x;
  };

  // ---------------- Painel ----------------
  r.get('/resumo', exigir('faturamento.ver'), (req, res) => {
    const d = hoje(req);
    const org = organizacao(req);
    const competencia = fat.competenciaDe(d);
    const soma = (sql, ...p) => db.prepare(sql).get(req.org, ...p);
    const abertas = db.prepare("SELECT * FROM faturas WHERE organizacao_id = ? AND situacao IN ('aberta','parcial')").all(req.org);
    const vencidas = abertas.filter((f) => f.vencimento < d);
    const devido = vencidas.reduce((s, f) => s + fat.encargos(f, org, d).total_devido_centavos, 0);
    res.json({
      hoje: d,
      competencia,
      ciclo_atual: db.prepare('SELECT * FROM ciclos WHERE organizacao_id = ? AND competencia = ?').get(req.org, competencia) ?? null,
      faturado_mes: soma(`SELECT COUNT(*) AS faturas, COALESCE(SUM(valor_centavos), 0) AS valor_centavos FROM faturas
        WHERE organizacao_id = ? AND competencia = ? AND situacao <> 'cancelada'`, competencia),
      recebido_mes: soma(`SELECT COUNT(*) AS pagamentos, COALESCE(SUM(valor_centavos + juros_centavos + multa_centavos - desconto_centavos), 0) AS valor_centavos
        FROM pagamentos WHERE organizacao_id = ? AND estornado_em IS NULL AND data >= ?`, `${competencia}-01`),
      a_receber: { faturas: abertas.length, valor_centavos: abertas.reduce((s, f) => s + (f.valor_centavos - f.pago_centavos), 0) },
      vencido: { faturas: vencidas.length, saldo_centavos: vencidas.reduce((s, f) => s + (f.valor_centavos - f.pago_centavos), 0), devido_centavos: devido },
      vence_em_7: abertas.filter((f) => f.vencimento >= d && f.vencimento <= somarDias(d, 7)).length,
      contratos: db.prepare('SELECT situacao, COUNT(*) AS n FROM contratos WHERE organizacao_id = ? GROUP BY situacao').all(req.org)
        .reduce((o, x) => ({ ...o, [x.situacao]: x.n }), {}),
      assinantes: db.prepare('SELECT situacao, COUNT(*) AS n FROM assinantes WHERE organizacao_id = ? GROUP BY situacao').all(req.org)
        .reduce((o, x) => ({ ...o, [x.situacao]: x.n }), {}),
      // Receita recorrente dos contratos que faturam (ativos e bloqueados por inadimplência continuam faturando).
      mrr_centavos: db.prepare(`SELECT COALESCE(SUM(mensalidade_centavos), 0) AS v FROM contratos
        WHERE organizacao_id = ? AND situacao IN ('ativo','bloqueado')`).get(req.org).v,
    });
  });

  // ---------------- Ciclo mensal ----------------
  r.get('/ciclos', exigir('faturamento.ver'), (req, res) => {
    const itens = db.prepare(`SELECT c.*, u.nome AS executado_por_nome FROM ciclos c LEFT JOIN usuarios u ON u.id = c.executado_por
      WHERE c.organizacao_id = ? ORDER BY c.competencia DESC LIMIT 36`).all(req.org);
    res.json(itens.map((c) => ({ ...c, pulados: JSON.parse(c.pulados ?? '[]') })));
  });

  r.post('/ciclos', exigir('faturamento.faturar'), (req, res) => {
    const competencia = String(req.body?.competencia ?? fat.competenciaDe(hoje(req)));
    const simulacao = v.booleano(req.body?.simulacao);
    v.exigir(competencia <= fat.competenciaDe(somarDias(hoje(req), 31)), 'Competência muito à frente: fature o mês corrente ou o seguinte.');
    const resultado = transacao(db, () => fat.gerarCiclo(db, { org: req.org, competencia, simulacao, usuarioId: req.usuario.id }));
    if (!simulacao) {
      registrar(db, req, 'ciclo_faturado', { recurso: 'ciclo', recursoId: resultado.ciclo_id,
        depois: { competencia, faturas: resultado.faturas, valor_centavos: resultado.valor_centavos, pulados: resultado.pulados.length } });
    }
    res.status(simulacao ? 200 : 201).json(resultado);
  });

  // ---------------- Faturas ----------------
  r.get('/faturas', exigir('faturamento.ver'), (req, res) => {
    const d = hoje(req);
    const org = organizacao(req);
    const f = ['f.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.situacao === 'vencida') { f.push("f.situacao IN ('aberta','parcial') AND f.vencimento < ?"); p.push(d); }
    else if (req.query.situacao) { f.push('f.situacao = ?'); p.push(v.opcao(req.query.situacao, 'a situação', SITUACOES)); }
    if (req.query.assinante_id) { f.push('f.assinante_id = ?'); p.push(Number(req.query.assinante_id)); }
    if (req.query.contrato_id) { f.push('f.contrato_id = ?'); p.push(Number(req.query.contrato_id)); }
    if (req.query.competencia) { f.push('f.competencia = ?'); p.push(String(req.query.competencia)); }
    if (req.query.de) { f.push('f.vencimento >= ?'); p.push(v.data(req.query.de, 'a data inicial')); }
    if (req.query.ate) { f.push('f.vencimento <= ?'); p.push(v.data(req.query.ate, 'a data final')); }
    if (req.query.busca) {
      const t = String(req.query.busca).trim();
      f.push("(a.nome LIKE ? ESCAPE '\\' OR a.documento LIKE ? ESCAPE '\\' OR f.numero = ?)");
      p.push(like(t), like(v.digitos(t) || t), Number(t.replace(/\D/g, '')) || -1);
    }
    const lista = listaPaginada(db, `SELECT f.*, a.nome AS assinante_nome, a.codigo AS assinante_codigo, c.numero AS contrato_numero
      FROM faturas f JOIN assinantes a ON a.id = f.assinante_id LEFT JOIN contratos c ON c.id = f.contrato_id
      WHERE ${f.join(' AND ')} ORDER BY f.vencimento DESC, f.numero DESC`, p, req.query);
    lista.itens = lista.itens.map((x) => ({ ...x, encargos: fat.encargos(x, org, d) }));
    res.json(lista);
  });

  r.get('/faturas/:id', exigir('faturamento.ver'), (req, res) => {
    const x = buscar(req, req.params.id);
    const d = hoje(req);
    res.json({
      ...db.prepare(`SELECT f.*, a.nome AS assinante_nome, a.codigo AS assinante_codigo, a.documento AS assinante_documento, a.telefone AS assinante_telefone,
        a.email AS assinante_email, c.numero AS contrato_numero, p.nome AS plano_nome FROM faturas f JOIN assinantes a ON a.id = f.assinante_id
        LEFT JOIN contratos c ON c.id = f.contrato_id LEFT JOIN planos p ON p.id = c.plano_id WHERE f.id = ?`).get(x.id),
      encargos: fat.encargos(x, organizacao(req), d),
      itens: db.prepare('SELECT * FROM fatura_itens WHERE fatura_id = ? ORDER BY id').all(x.id),
      pagamentos: db.prepare(`SELECT pg.*, u.nome AS criado_por_nome, e.nome AS estornado_por_nome FROM pagamentos pg
        LEFT JOIN usuarios u ON u.id = pg.criado_por LEFT JOIN usuarios e ON e.id = pg.estornado_por WHERE pg.fatura_id = ? ORDER BY pg.id DESC`).all(x.id),
      cobranca: db.prepare(`SELECT ev.*, rr.nome AS regra_nome FROM regua_eventos ev JOIN regua_regras rr ON rr.id = ev.regra_id
        WHERE ev.fatura_id = ? ORDER BY ev.id DESC`).all(x.id),
    });
  });

  /** Cobrança avulsa: fora do ciclo, com itens informados à mão (serviço, taxa, material). */
  r.post('/faturas', exigir('faturamento.faturar'), (req, res) => {
    const b = req.body ?? {};
    const assinante = db.prepare('SELECT * FROM assinantes WHERE id = ? AND organizacao_id = ?').get(Number(b.assinante_id), req.org);
    if (!assinante) throw new ErroNegocio('Assinante não encontrado.', 404);
    let contratoId = null;
    if (b.contrato_id) {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ? AND organizacao_id = ? AND assinante_id = ?').get(Number(b.contrato_id), req.org, assinante.id);
      if (!c) throw new ErroNegocio('Contrato não encontrado para este assinante.', 404);
      contratoId = c.id;
    }
    const vencimento = v.data(b.vencimento, 'o vencimento');
    const itens = (Array.isArray(b.itens) ? b.itens : []).map((i) => ({
      descricao: v.texto(i.descricao, 'a descrição do item', 160),
      valor_centavos: v.centavos(i.valor, 'o valor do item'),
      origem: 'avulso',
    }));
    v.exigir(itens.length, 'Informe pelo menos um item na cobrança.');
    v.exigir(itens.every((i) => i.valor_centavos > 0), 'Cada item precisa de um valor maior que zero.');
    const nova = transacao(db, () => fat.emitirFatura(db, { org: req.org, assinanteId: assinante.id, contratoId, vencimento, itens,
      observacoes: v.opcional(b.observacoes, 'as observações', 500), usuarioId: req.usuario.id }));
    registrar(db, req, 'fatura_avulsa_emitida', { recurso: 'fatura', recursoId: nova.id, depois: { ...nova, assinante_id: assinante.id, itens } });
    res.status(201).json(buscar(req, nova.id));
  });

  // ---------------- Baixa ----------------
  r.post('/faturas/:id/pagamentos', exigir('faturamento.baixar'), (req, res) => {
    const fatura = buscar(req, req.params.id);
    const b = req.body ?? {};
    const d = hoje(req);
    const org = organizacao(req);
    const data = b.data ? v.data(b.data, 'a data do pagamento') : d;
    v.exigir(data <= d, 'A data do pagamento não pode ser no futuro.');
    const sugerido = fat.encargos(fatura, org, data);
    const dados = {
      // Sem valor informado, a baixa quita o saldo (o caso comum).
      valor_centavos: b.valor !== undefined && b.valor !== '' ? v.centavos(b.valor, 'o valor') : fatura.valor_centavos - fatura.pago_centavos,
      juros_centavos: b.juros !== undefined && b.juros !== '' ? v.centavos(b.juros, 'os juros') : sugerido.juros_centavos,
      multa_centavos: b.multa !== undefined && b.multa !== '' ? v.centavos(b.multa, 'a multa') : sugerido.multa_centavos,
      desconto_centavos: b.desconto !== undefined && b.desconto !== '' ? v.centavos(b.desconto, 'o desconto') : 0,
      data,
      forma: v.opcao(b.forma, 'a forma de pagamento', FORMAS),
      origem: b.origem ? v.opcao(b.origem, 'a origem', ['manual', 'retorno', 'portal']) : 'manual',
      observacoes: v.opcional(b.observacoes, 'as observações', 500),
    };
    v.exigir(dados.valor_centavos > 0, 'Informe um valor maior que zero.');
    const resultado = transacao(db, () => {
      const pago = fat.registrarPagamento(db, { org: req.org, fatura, dados, usuarioId: req.usuario.id });
      let desbloqueio = null;
      if (pago.fatura.situacao === 'paga' && fatura.contrato_id) {
        const contrato = db.prepare('SELECT * FROM contratos WHERE id = ?').get(fatura.contrato_id);
        desbloqueio = cob.aoQuitar(db, { contrato, hoje: d, usuarioId: req.usuario.id });
      }
      return { ...pago, desbloqueio };
    });
    registrar(db, req, 'fatura_baixada', { recurso: 'fatura', recursoId: fatura.id, antes: fatura, depois: { ...dados, pagamento_id: resultado.pagamento_id } });
    res.status(201).json({
      ...resultado,
      aviso: resultado.desbloqueio?.desbloqueado ? 'Fatura quitada e serviço desbloqueado automaticamente.'
        : resultado.fatura.situacao === 'parcial' ? `Pagamento parcial: restam R$ ${((resultado.fatura.valor_centavos - resultado.fatura.pago_centavos) / 100).toFixed(2)}.`
          : resultado.desbloqueio?.motivo ?? null,
    });
  });

  r.post('/pagamentos/:id/estornar', exigir('faturamento.estornar'), (req, res) => {
    const pagamento = db.prepare('SELECT * FROM pagamentos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!pagamento) throw new ErroNegocio('Pagamento não encontrado.', 404);
    const motivo = v.texto(req.body?.motivo, 'o motivo do estorno', 300);
    const fatura = transacao(db, () => fat.estornarPagamento(db, { pagamento, motivo, usuarioId: req.usuario.id }));
    registrar(db, req, 'pagamento_estornado', { recurso: 'fatura', recursoId: pagamento.fatura_id, antes: pagamento, depois: { motivo } });
    // O estorno não refaz o bloqueio na hora: a régua volta a alcançar a fatura na próxima execução, com registro próprio.
    res.json({ ...fatura, aviso: 'Estorno registrado. Se a fatura voltar a ficar vencida, a régua de cobrança trata o bloqueio na próxima execução.' });
  });

  r.post('/faturas/:id/cancelar', exigir('faturamento.estornar'), (req, res) => {
    const fatura = buscar(req, req.params.id);
    const motivo = v.texto(req.body?.motivo, 'o motivo do cancelamento', 300);
    const nova = transacao(db, () => fat.cancelarFatura(db, { fatura, motivo, usuarioId: req.usuario.id }));
    registrar(db, req, 'fatura_cancelada', { recurso: 'fatura', recursoId: fatura.id, antes: fatura, depois: { motivo } });
    res.json({ ...nova, aviso: fatura.competencia ? `Competência ${competenciaBr(fatura.competencia)} liberada: o contrato pode ser faturado de novo nela.` : null });
  });

  // ---------------- Exportações ----------------
  r.get('/faturas/csv/lista', exigir('faturamento.ver'), (req, res) => {
    const d = hoje(req);
    const org = organizacao(req);
    const f = ['f.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.competencia) { f.push('f.competencia = ?'); p.push(String(req.query.competencia)); }
    if (req.query.situacao === 'vencida') { f.push("f.situacao IN ('aberta','parcial') AND f.vencimento < ?"); p.push(d); }
    else if (req.query.situacao) { f.push('f.situacao = ?'); p.push(v.opcao(req.query.situacao, 'a situação', SITUACOES)); }
    const itens = db.prepare(`SELECT f.*, a.nome AS assinante_nome, a.codigo AS assinante_codigo, a.documento, c.numero AS contrato_numero
      FROM faturas f JOIN assinantes a ON a.id = f.assinante_id LEFT JOIN contratos c ON c.id = f.contrato_id
      WHERE ${f.join(' AND ')} ORDER BY f.vencimento, f.numero`).all(...p);
    const real = (c) => (c / 100).toFixed(2).replace('.', ',');
    const linhas = [['Fatura', 'Competência', 'Assinante', 'Código', 'Documento', 'Contrato', 'Vencimento', 'Valor (R$)', 'Pago (R$)',
      'Saldo (R$)', 'Multa (R$)', 'Juros (R$)', 'Total devido (R$)', 'Dias de atraso', 'Situação']];
    for (const x of itens) {
      const e = fat.encargos(x, org, d);
      linhas.push([x.numero, x.competencia, x.assinante_nome, x.assinante_codigo, x.documento, x.contrato_numero, x.vencimento, real(x.valor_centavos),
        real(x.pago_centavos), real(e.saldo_centavos), real(e.multa_centavos), real(e.juros_centavos), real(e.total_devido_centavos), e.dias_atraso, x.situacao]);
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="faturas-${d}.csv"` }).send(csv(linhas));
  });

  return r;
};
