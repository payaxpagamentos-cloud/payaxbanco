'use strict';

const { Router } = require('express');
const QRCode = require('qrcode');
const { agora, transacao } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { hoje, mes, somarMeses, somarDias } = require('../lib/datas');
const faturamento = require('../lib/faturamento');
const rel = require('../lib/relatorios');
const v = require('../lib/validacao');

const CATEGORIAS_DESPESA = ['internet', 'aparelho', 'instalacao', 'manutencao', 'aluguel_espaco', 'comissao', 'energia', 'software', 'imposto', 'outros'];

/**
 * Financeiro: o que entra e o que sai.
 *
 *  - Contratos: o acordo comercial de cada cliente, que sustenta as campanhas dele.
 *  - Contas a receber: as faturas dos anunciantes (geradas no fechamento do mês).
 *  - Contas a pagar: os repasses aos pontos (também do fechamento) somados às despesas da operação —
 *    internet do prédio, aparelho, instalação, manutenção, comissão de vendedor.
 */
module.exports = (db) => {
  const r = Router();

  // ----------------------------------------------------------------- Contratos (ficam na ficha do cliente)
  function detalheContrato(id) {
    const c = db.prepare(`SELECT c.*, a.nome AS anunciante, ag.nome AS agencia FROM contratos c
      JOIN anunciantes a ON a.id = c.anunciante_id LEFT JOIN agencias ag ON ag.id = c.agencia_id WHERE c.id = ?`).get(id);
    if (!c) throw naoEncontrado('Contrato');
    return {
      ...c,
      campanhas: db.prepare('SELECT id, nome, status, inicio, fim, cobranca, valor_centavos, cpm_centavos FROM campanhas WHERE contrato_id = ? ORDER BY inicio DESC').all(c.id),
      faturas: db.prepare("SELECT id, competencia, vencimento, valor_centavos, status, pago_em FROM faturas WHERE contrato_id = ? ORDER BY competencia DESC").all(c.id),
    };
  }

  const lerContrato = (c, parcial = false) => {
    const d = {};
    const tem = (k) => c[k] !== undefined || !parcial;
    if (!parcial) {
      d.anunciante_id = Number(c.anunciante_id);
      if (!db.prepare('SELECT 1 FROM anunciantes WHERE id = ?').get(d.anunciante_id)) throw new ErroNegocio('Cliente não encontrado.', 422);
    }
    if (tem('numero')) d.numero = v.texto(c.numero, 'o número do contrato', 40);
    if (c.objeto !== undefined) d.objeto = v.opcional(c.objeto, 'o objeto', 300);
    if (tem('inicio')) d.inicio = v.data(c.inicio, 'a data de início');
    if (c.fim !== undefined) d.fim = c.fim === null || c.fim === '' ? null : v.data(c.fim, 'a data de término');
    if (tem('cobranca')) d.cobranca = v.opcao(c.cobranca ?? 'mensal', 'a forma de cobrança', ['mensal', 'cpm', 'pacote', 'cortesia']);
    if (c.valor_centavos !== undefined) d.valor_centavos = v.inteiro(c.valor_centavos, 'o valor', { max: 1_000_000_000 });
    if (c.vencimento_dia !== undefined) d.vencimento_dia = v.inteiro(c.vencimento_dia, 'o dia de vencimento', { min: 1, max: 28 });
    if (c.reajuste !== undefined) d.reajuste = v.opcional(c.reajuste, 'o reajuste', 60);
    if (c.renovacao_automatica !== undefined) d.renovacao_automatica = v.booleano(c.renovacao_automatica) ? 1 : 0;
    if (c.status !== undefined) d.status = v.opcao(c.status, 'a situação', ['rascunho', 'ativo', 'suspenso', 'encerrado']);
    if (c.observacao !== undefined) d.observacao = v.opcional(c.observacao, 'a observação', 500);
    if (c.agencia_id !== undefined) {
      d.agencia_id = c.agencia_id === null || c.agencia_id === '' ? null : Number(c.agencia_id);
      if (d.agencia_id && !db.prepare('SELECT 1 FROM agencias WHERE id = ?').get(d.agencia_id)) throw new ErroNegocio('Agência não encontrada.', 422);
    }
    return d;
  };

  r.get('/contratos', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.anunciante_id) { onde.push('c.anunciante_id = ?'); p.push(Number(req.query.anunciante_id)); }
    if (req.query.status) { onde.push('c.status = ?'); p.push(req.query.status); }
    if (req.query.busca) { onde.push('(c.numero LIKE ? OR a.nome LIKE ?)'); p.push(`%${req.query.busca}%`, `%${req.query.busca}%`); }
    const itens = db.prepare(`SELECT c.*, a.nome AS anunciante, ag.nome AS agencia,
        (SELECT COUNT(*) FROM campanhas x WHERE x.contrato_id = c.id) AS campanhas,
        (SELECT COALESCE(SUM(f.valor_centavos), 0) FROM faturas f WHERE f.contrato_id = c.id AND f.status = 'aberta') AS aberto_centavos
      FROM contratos c JOIN anunciantes a ON a.id = c.anunciante_id LEFT JOIN agencias ag ON ag.id = c.agencia_id
      ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''}
      ORDER BY CASE c.status WHEN 'ativo' THEN 0 WHEN 'suspenso' THEN 1 WHEN 'rascunho' THEN 2 ELSE 3 END, c.inicio DESC`).all(...p);
    const data = hoje();
    res.json({
      itens: itens.map((c) => ({ ...c, vencendo: Boolean(c.status === 'ativo' && c.fim && c.fim <= somarDias(data, 30)) })),
      totais: {
        ativos: itens.filter((c) => c.status === 'ativo').length,
        mensal_centavos: itens.filter((c) => c.status === 'ativo' && c.cobranca === 'mensal').reduce((t, c) => t + c.valor_centavos, 0),
      },
    });
  });

  r.get('/contratos/:id', (req, res) => res.json(detalheContrato(Number(req.params.id))));

  r.post('/contratos', (req, res) => {
    const d = lerContrato(req.body);
    const id = Number(db.prepare(`INSERT INTO contratos (${Object.keys(d).join(', ')}, criado_por, criado_em)
      VALUES (${Object.keys(d).map(() => '?').join(', ')}, ?, ?)`).run(...Object.values(d), req.usuario.id, agora()).lastInsertRowid);
    registrar(db, req, 'contrato_criado', { id, numero: d.numero, anunciante_id: d.anunciante_id });
    res.status(201).json(detalheContrato(id));
  });

  r.patch('/contratos/:id', (req, res) => {
    const id = Number(req.params.id);
    const atual = db.prepare('SELECT * FROM contratos WHERE id = ?').get(id);
    if (!atual) throw naoEncontrado('Contrato');
    const d = lerContrato(req.body, true);
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    const fim = d.fim !== undefined ? d.fim : atual.fim;
    if (fim && fim < (d.inicio ?? atual.inicio)) throw new ErroNegocio('O término não pode ser antes do início.', 422);
    db.prepare(`UPDATE contratos SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'contrato_alterado', { id, depois: d });
    res.json(detalheContrato(id));
  });

  r.delete('/contratos/:id', permitir('master'), (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(id);
    if (!c) throw naoEncontrado('Contrato');
    if (db.prepare('SELECT 1 FROM faturas WHERE contrato_id = ? LIMIT 1').get(id)) {
      throw new ErroNegocio('Este contrato já tem fatura. Encerre em vez de excluir.', 409);
    }
    transacao(db, () => {
      db.prepare('UPDATE campanhas SET contrato_id = NULL WHERE contrato_id = ?').run(id);
      db.prepare('DELETE FROM contratos WHERE id = ?').run(id);
    });
    registrar(db, req, 'contrato_excluido', { id, numero: c.numero });
    res.status(204).end();
  });

  /** Liga (ou desliga) uma campanha a um contrato. */
  r.post('/contratos/:id/campanhas', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM contratos WHERE id = ?').get(id)) throw naoEncontrado('Contrato');
    const campanha = db.prepare('SELECT * FROM campanhas WHERE id = ?').get(Number(req.body.campanha_id));
    if (!campanha) throw new ErroNegocio('Campanha não encontrada.', 422);
    const contrato = db.prepare('SELECT anunciante_id FROM contratos WHERE id = ?').get(id);
    if (campanha.anunciante_id !== contrato.anunciante_id) throw new ErroNegocio('A campanha é de outro cliente.', 422);
    db.prepare('UPDATE campanhas SET contrato_id = ? WHERE id = ?').run(v.booleano(req.body.remover) ? null : id, campanha.id);
    registrar(db, req, 'contrato_campanha', { contrato_id: id, campanha_id: campanha.id, removido: v.booleano(req.body.remover) });
    res.json(detalheContrato(id));
  });

  // ----------------------------------------------------------------- Contas a receber (faturas)
  r.get('/faturas', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.status) { onde.push('f.status = ?'); p.push(req.query.status); }
    if (req.query.anunciante_id) { onde.push('f.anunciante_id = ?'); p.push(Number(req.query.anunciante_id)); }
    if (req.query.competencia) { onde.push('f.competencia = ?'); p.push(v.competencia(req.query.competencia)); }
    const itens = db.prepare(`SELECT f.*, a.nome AS anunciante, (f.status = 'aberta' AND f.vencimento < ?) AS atrasada
      FROM faturas f JOIN anunciantes a ON a.id = f.anunciante_id ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''}
      ORDER BY f.competencia DESC, a.nome`).all(hoje(), ...p);
    res.json({
      itens,
      totais: {
        aberto_centavos: itens.filter((f) => f.status === 'aberta').reduce((t, f) => t + f.valor_centavos, 0),
        pago_centavos: itens.filter((f) => f.status === 'paga').reduce((t, f) => t + f.valor_centavos, 0),
        atrasadas: itens.filter((f) => f.atrasada).length,
      },
    });
  });

  r.get('/faturas/:id', async (req, res) => {
    const f = faturamento.detalhe(db, Number(req.params.id));
    if (f.pix) f.pix.qr = await QRCode.toDataURL(f.pix.codigo, { margin: 1, width: 320 }).catch(() => null);
    res.json(f);
  });

  r.post('/faturas/:id/pagar', (req, res) => {
    const id = Number(req.params.id);
    const f = db.prepare('SELECT * FROM faturas WHERE id = ?').get(id);
    if (!f) throw naoEncontrado('Fatura');
    if (f.status !== 'aberta') throw new ErroNegocio('Esta fatura não está aberta.', 409);
    const pago = req.body.pago_em ? v.data(req.body.pago_em, 'a data do pagamento') : hoje();
    db.prepare("UPDATE faturas SET status = 'paga', pago_em = ?, observacao = COALESCE(?, observacao) WHERE id = ?")
      .run(pago, v.opcional(req.body.observacao, 'a observação', 300), id);
    registrar(db, req, 'fatura_paga', { id, valor_centavos: f.valor_centavos, pago_em: pago });
    res.json(db.prepare('SELECT * FROM faturas WHERE id = ?').get(id));
  });

  r.post('/faturas/:id/cancelar', (req, res) => {
    const id = Number(req.params.id);
    const f = db.prepare('SELECT * FROM faturas WHERE id = ?').get(id);
    if (!f) throw naoEncontrado('Fatura');
    if (f.status === 'paga') throw new ErroNegocio('Fatura paga não pode ser cancelada.', 409);
    db.prepare("UPDATE faturas SET status = 'cancelada', observacao = ? WHERE id = ?").run(v.texto(req.body.motivo, 'o motivo', 300), id);
    registrar(db, req, 'fatura_cancelada', { id });
    res.json(db.prepare('SELECT * FROM faturas WHERE id = ?').get(id));
  });

  r.get('/repasses', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.status) { onde.push('r.status = ?'); p.push(req.query.status); }
    if (req.query.competencia) { onde.push('r.competencia = ?'); p.push(v.competencia(req.query.competencia)); }
    if (req.query.local_id) { onde.push('r.local_id = ?'); p.push(Number(req.query.local_id)); }
    const itens = db.prepare(`SELECT r.*, l.nome AS local, l.cidade, l.responsavel, l.telefone FROM repasses r JOIN locais l ON l.id = r.local_id
      ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''} ORDER BY r.competencia DESC, r.valor_centavos DESC`).all(...p);
    res.json({ itens, total_centavos: itens.filter((x) => x.status === 'a_pagar').reduce((t, x) => t + x.valor_centavos, 0) });
  });

  r.post('/repasses/:id/pagar', (req, res) => {
    const id = Number(req.params.id);
    const x = db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
    if (!x) throw naoEncontrado('Repasse');
    if (x.status !== 'a_pagar') throw new ErroNegocio('Este repasse não está a pagar.', 409);
    db.prepare("UPDATE repasses SET status = 'pago', pago_em = ?, observacao = COALESCE(?, observacao) WHERE id = ?")
      .run(req.body.pago_em ? v.data(req.body.pago_em, 'a data do pagamento') : hoje(), v.opcional(req.body.observacao, 'a observação', 300), id);
    registrar(db, req, 'repasse_pago', { id, valor_centavos: x.valor_centavos });
    res.json(db.prepare('SELECT * FROM repasses WHERE id = ?').get(id));
  });

  /** Visão de contas a receber: as faturas com os totais e o que está vencendo. */
  r.get('/contas-a-receber', (req, res) => {
    const data = hoje();
    const onde = ["f.status <> 'cancelada'"];
    const p = [];
    if (req.query.status) { onde.push('f.status = ?'); p.push(req.query.status); }
    if (req.query.anunciante_id) { onde.push('f.anunciante_id = ?'); p.push(Number(req.query.anunciante_id)); }
    if (req.query.competencia) { onde.push('f.competencia = ?'); p.push(v.competencia(req.query.competencia)); }
    if (req.query.de) { onde.push('f.vencimento >= ?'); p.push(v.data(req.query.de, 'a data inicial')); }
    if (req.query.ate) { onde.push('f.vencimento <= ?'); p.push(v.data(req.query.ate, 'a data final')); }
    const itens = db.prepare(`SELECT f.*, a.nome AS anunciante, ag.nome AS agencia, c.numero AS contrato
      FROM faturas f JOIN anunciantes a ON a.id = f.anunciante_id
      LEFT JOIN agencias ag ON ag.id = f.agencia_id LEFT JOIN contratos c ON c.id = f.contrato_id
      WHERE ${onde.join(' AND ')} ORDER BY f.vencimento DESC, a.nome`).all(...p)
      .map((f) => ({ ...f, atrasada: f.status === 'aberta' && f.vencimento < data, dias_atraso: f.status === 'aberta' && f.vencimento < data
        ? Math.round((Date.parse(`${data}T12:00:00Z`) - Date.parse(`${f.vencimento}T12:00:00Z`)) / 86_400_000) : 0 }));

    if (req.query.csv) {
      return rel.enviarCsv(res, `contas-a-receber-${data}.csv`, rel.csv([
        ['competencia', 'Competência'], ['anunciante', 'Cliente'], [(x) => x.agencia ?? '', 'Agência'],
        [(x) => x.contrato ?? '', 'Contrato'], ['vencimento', 'Vencimento'], ['status', 'Situação'],
        [(x) => (x.atrasada ? x.dias_atraso : ''), 'Dias em atraso'], [(x) => x.pago_em ?? '', 'Pago em'],
        [(x) => rel.reais(x.valor_centavos), 'Valor (R$)'],
      ], itens));
    }

    const soma = (f) => itens.filter(f).reduce((t, x) => t + x.valor_centavos, 0);
    const faixa = (min, max) => soma((x) => x.atrasada && x.dias_atraso >= min && (max === null || x.dias_atraso <= max));
    res.json({
      itens,
      totais: {
        aberto_centavos: soma((x) => x.status === 'aberta'),
        atrasado_centavos: soma((x) => x.atrasada),
        recebido_centavos: soma((x) => x.status === 'paga'),
        vence_em_7_centavos: soma((x) => x.status === 'aberta' && !x.atrasada && x.vencimento <= somarDias(data, 7)),
        clientes_em_atraso: new Set(itens.filter((x) => x.atrasada).map((x) => x.anunciante_id)).size,
      },
      // Atraso por faixa, para saber o que ainda dá para cobrar por telefone e o que já virou perda.
      atraso: { ate_30: faixa(1, 30), de_31_a_60: faixa(31, 60), de_61_a_90: faixa(61, 90), mais_de_90: faixa(91, null) },
    });
  });

  // ----------------------------------------------------------------- Contas a pagar (repasses + despesas)
  const lerDespesa = (c, parcial = false) => {
    const d = {};
    const tem = (k) => c[k] !== undefined || !parcial;
    if (tem('descricao')) d.descricao = v.texto(c.descricao, 'a descrição', 160);
    if (c.fornecedor !== undefined) d.fornecedor = v.opcional(c.fornecedor, 'o fornecedor', 120);
    if (tem('categoria')) d.categoria = v.opcao(c.categoria ?? 'outros', 'a categoria', CATEGORIAS_DESPESA);
    if (tem('vencimento')) d.vencimento = v.data(c.vencimento, 'o vencimento');
    if (tem('valor_centavos')) d.valor_centavos = v.inteiro(c.valor_centavos, 'o valor', { min: 1, max: 1_000_000_000 });
    if (c.competencia !== undefined) d.competencia = c.competencia ? v.competencia(c.competencia) : null;
    if (c.observacao !== undefined) d.observacao = v.opcional(c.observacao, 'a observação', 300);
    if (c.local_id !== undefined) {
      d.local_id = c.local_id === null || c.local_id === '' ? null : Number(c.local_id);
      if (d.local_id && !db.prepare('SELECT 1 FROM locais WHERE id = ?').get(d.local_id)) throw new ErroNegocio('Ponto não encontrado.', 422);
    }
    return d;
  };

  r.post('/despesas', (req, res) => {
    const d = lerDespesa(req.body);
    // Repetir cria uma conta por mês, com o mesmo dia de vencimento (internet, aluguel do espaço...).
    const repetir = v.inteiro(req.body.repete_meses ?? 0, 'a repetição', { max: 36 });
    const ids = transacao(db, () => {
      const criados = [];
      for (let i = 0; i <= repetir; i++) {
        const campos = { ...d, vencimento: i === 0 ? d.vencimento : somarMesesData(d.vencimento, i), repete_meses: repetir };
        if (campos.competencia && i > 0) campos.competencia = somarMeses(campos.competencia, i);
        criados.push(Number(db.prepare(`INSERT INTO despesas (${Object.keys(campos).join(', ')}, criado_por, criado_em)
          VALUES (${Object.keys(campos).map(() => '?').join(', ')}, ?, ?)`).run(...Object.values(campos), req.usuario.id, agora()).lastInsertRowid));
      }
      return criados;
    });
    registrar(db, req, 'despesa_criada', { ids, descricao: d.descricao, valor_centavos: d.valor_centavos });
    res.status(201).json({ ids, criadas: ids.length });
  });

  r.patch('/despesas/:id', (req, res) => {
    const id = Number(req.params.id);
    const atual = db.prepare('SELECT * FROM despesas WHERE id = ?').get(id);
    if (!atual) throw naoEncontrado('Despesa');
    if (atual.status === 'paga') throw new ErroNegocio('Esta conta já foi paga. Estorne antes de alterar.', 409);
    const d = lerDespesa(req.body, true);
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    db.prepare(`UPDATE despesas SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'despesa_alterada', { id, depois: d });
    res.json(db.prepare('SELECT * FROM despesas WHERE id = ?').get(id));
  });

  r.post('/despesas/:id/pagar', (req, res) => {
    const id = Number(req.params.id);
    const d = db.prepare('SELECT * FROM despesas WHERE id = ?').get(id);
    if (!d) throw naoEncontrado('Despesa');
    if (d.status !== 'aberta') throw new ErroNegocio('Esta conta não está aberta.', 409);
    db.prepare("UPDATE despesas SET status = 'paga', pago_em = ? WHERE id = ?").run(req.body.pago_em ? v.data(req.body.pago_em, 'a data do pagamento') : hoje(), id);
    registrar(db, req, 'despesa_paga', { id, valor_centavos: d.valor_centavos });
    res.json(db.prepare('SELECT * FROM despesas WHERE id = ?').get(id));
  });

  r.post('/despesas/:id/estornar', (req, res) => {
    const id = Number(req.params.id);
    const d = db.prepare('SELECT * FROM despesas WHERE id = ?').get(id);
    if (!d) throw naoEncontrado('Despesa');
    if (d.status !== 'paga') throw new ErroNegocio('Esta conta não está paga.', 409);
    db.prepare("UPDATE despesas SET status = 'aberta', pago_em = NULL WHERE id = ?").run(id);
    registrar(db, req, 'despesa_estornada', { id });
    res.json(db.prepare('SELECT * FROM despesas WHERE id = ?').get(id));
  });

  r.delete('/despesas/:id', (req, res) => {
    const id = Number(req.params.id);
    const d = db.prepare('SELECT * FROM despesas WHERE id = ?').get(id);
    if (!d) throw naoEncontrado('Despesa');
    if (d.status === 'paga') throw new ErroNegocio('Conta paga não é excluída: estorne primeiro.', 409);
    db.prepare('DELETE FROM despesas WHERE id = ?').run(id);
    registrar(db, req, 'despesa_excluida', { id, descricao: d.descricao });
    res.status(204).end();
  });

  /** Tudo o que a rede tem para pagar: os repasses aos pontos e as despesas da operação, numa lista só. */
  r.get('/contas-a-pagar', (req, res) => {
    const data = hoje();
    const status = req.query.status || '';
    const de = req.query.de ? v.data(req.query.de, 'a data inicial') : null;
    const ate = req.query.ate ? v.data(req.query.ate, 'a data final') : null;
    const dentro = (vencimento) => (!de || vencimento >= de) && (!ate || vencimento <= ate);

    const repasses = db.prepare(`SELECT r.*, l.nome AS local FROM repasses r JOIN locais l ON l.id = r.local_id WHERE r.status <> 'cancelado'`).all()
      .map((x) => ({
        tipo: 'repasse', id: x.id, descricao: `Repasse ${x.competencia} — ${x.local}`, fornecedor: x.local, categoria: 'repasse',
        competencia: x.competencia, vencimento: x.competencia ? `${somarMeses(x.competencia, 1)}-10` : data,
        valor_centavos: x.valor_centavos, status: x.status === 'pago' ? 'paga' : 'aberta', pago_em: x.pago_em, local_id: x.local_id,
      }));
    const despesas = db.prepare("SELECT * FROM despesas WHERE status <> 'cancelada'").all()
      .map((x) => ({ ...x, tipo: 'despesa', fornecedor: x.fornecedor ?? null }));

    const itens = [...repasses, ...despesas]
      .filter((x) => dentro(x.vencimento) && (!status || x.status === status) && (!req.query.tipo || x.tipo === req.query.tipo))
      .map((x) => ({ ...x, atrasada: x.status === 'aberta' && x.vencimento < data }))
      .sort((a, b) => a.vencimento.localeCompare(b.vencimento) || b.valor_centavos - a.valor_centavos);

    if (req.query.csv) {
      return rel.enviarCsv(res, `contas-a-pagar-${data}.csv`, rel.csv([
        ['vencimento', 'Vencimento'], [(x) => (x.tipo === 'repasse' ? 'Repasse ao ponto' : 'Despesa'), 'Tipo'],
        ['descricao', 'Descrição'], [(x) => x.fornecedor ?? '', 'Fornecedor / ponto'], ['categoria', 'Categoria'],
        [(x) => x.competencia ?? '', 'Competência'], ['status', 'Situação'], [(x) => (x.atrasada ? 'sim' : ''), 'Em atraso'],
        [(x) => x.pago_em ?? '', 'Pago em'], [(x) => rel.reais(x.valor_centavos), 'Valor (R$)'],
      ], itens));
    }

    const soma = (f) => itens.filter(f).reduce((t, x) => t + x.valor_centavos, 0);
    res.json({
      itens,
      categorias: CATEGORIAS_DESPESA,
      totais: {
        aberto_centavos: soma((x) => x.status === 'aberta'),
        atrasado_centavos: soma((x) => x.atrasada),
        pago_centavos: soma((x) => x.status === 'paga'),
        repasses_centavos: soma((x) => x.tipo === 'repasse' && x.status === 'aberta'),
        despesas_centavos: soma((x) => x.tipo === 'despesa' && x.status === 'aberta'),
        vence_em_7_centavos: soma((x) => x.status === 'aberta' && !x.atrasada && x.vencimento <= somarDias(data, 7)),
      },
    });
  });

  /**
   * Fluxo de caixa: o que entrou e o que saiu de verdade (pela data do pagamento) e o que está previsto
   * (pela data de vencimento). É a visão que faltava entre contas a receber e contas a pagar.
   */
  r.get('/fluxo-caixa', (req, res) => {
    const data = hoje();
    const ate = req.query.ate ? v.data(req.query.ate, 'a data final') : `${mes()}-${String(new Date(Date.UTC(
      Number(mes().slice(0, 4)), Number(mes().slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
    const de = req.query.de ? v.data(req.query.de, 'a data inicial') : `${mes()}-01`;
    v.exigir(de <= ate, 'A data inicial não pode ser depois da final.');

    const entradas = db.prepare(`SELECT f.pago_em AS data, f.valor_centavos, f.competencia, a.nome AS quem
      FROM faturas f JOIN anunciantes a ON a.id = f.anunciante_id
      WHERE f.status = 'paga' AND f.pago_em BETWEEN ? AND ?`).all(de, ate)
      .map((x) => ({ ...x, tipo: 'entrada', origem: 'fatura', descricao: `Fatura ${x.competencia} — ${x.quem}` }));

    const saidasDespesas = db.prepare(`SELECT d.pago_em AS data, d.valor_centavos, d.descricao, d.categoria, d.fornecedor AS quem
      FROM despesas d WHERE d.status = 'paga' AND d.pago_em BETWEEN ? AND ?`).all(de, ate)
      .map((x) => ({ ...x, tipo: 'saida', origem: 'despesa' }));
    const saidasRepasses = db.prepare(`SELECT r.pago_em AS data, r.valor_centavos, r.competencia, l.nome AS quem
      FROM repasses r JOIN locais l ON l.id = r.local_id WHERE r.status = 'pago' AND r.pago_em BETWEEN ? AND ?`).all(de, ate)
      .map((x) => ({ ...x, tipo: 'saida', origem: 'repasse', categoria: 'repasse', descricao: `Repasse ${x.competencia} — ${x.quem}` }));

    const movimentos = [...entradas, ...saidasDespesas, ...saidasRepasses].sort((a, b) => a.data.localeCompare(b.data));
    const soma = (lista) => lista.reduce((t, x) => t + x.valor_centavos, 0);
    const recebido = soma(entradas);
    const pago = soma([...saidasDespesas, ...saidasRepasses]);

    if (req.query.csv) {
      return rel.enviarCsv(res, `fluxo-de-caixa-${de}-${ate}.csv`, rel.csv([
        ['data', 'Data'], [(x) => (x.tipo === 'entrada' ? 'Entrada' : 'Saída'), 'Tipo'], ['origem', 'Origem'],
        ['descricao', 'Descrição'], ['quem', 'Cliente / fornecedor'], [(x) => x.categoria ?? '', 'Categoria'],
        [(x) => rel.reais(x.tipo === 'entrada' ? x.valor_centavos : -x.valor_centavos), 'Valor (R$)'],
      ], movimentos));
    }

    // Previsto no mesmo período: o que vence e ainda não foi pago (dos dois lados).
    const aReceber = db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS n FROM faturas WHERE status = 'aberta' AND vencimento BETWEEN ? AND ?").get(de, ate).n;
    const aPagarDespesas = db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS n FROM despesas WHERE status = 'aberta' AND vencimento BETWEEN ? AND ?").get(de, ate).n;
    const aPagarRepasses = db.prepare("SELECT competencia, valor_centavos FROM repasses WHERE status = 'a_pagar'").all()
      .filter((x) => { const venc = `${somarMeses(x.competencia, 1)}-10`; return venc >= de && venc <= ate; })
      .reduce((t, x) => t + x.valor_centavos, 0);

    // Série dos últimos 12 meses (pelo caixa), para ver a tendência.
    const serie = db.prepare(`
      SELECT substr(pago_em, 1, 7) AS competencia, SUM(valor_centavos) AS entrou, 0 AS saiu FROM faturas WHERE status = 'paga' AND pago_em >= ? GROUP BY 1
      UNION ALL
      SELECT substr(pago_em, 1, 7), 0, SUM(valor_centavos) FROM despesas WHERE status = 'paga' AND pago_em >= ? GROUP BY 1
      UNION ALL
      SELECT substr(pago_em, 1, 7), 0, SUM(valor_centavos) FROM repasses WHERE status = 'pago' AND pago_em >= ? GROUP BY 1`)
      .all(`${somarMeses(mes(), -11)}-01`, `${somarMeses(mes(), -11)}-01`, `${somarMeses(mes(), -11)}-01`);
    const porMes = new Map();
    for (const x of serie) {
      const m = porMes.get(x.competencia) ?? { competencia: x.competencia, entrou: 0, saiu: 0 };
      m.entrou += x.entrou;
      m.saiu += x.saiu;
      porMes.set(x.competencia, m);
    }

    // Saídas por categoria (o repasse aos pontos costuma ser a maior delas).
    const categorias = new Map();
    for (const x of [...saidasDespesas, ...saidasRepasses]) {
      categorias.set(x.categoria, (categorias.get(x.categoria) ?? 0) + x.valor_centavos);
    }

    res.json({
      de,
      ate,
      realizado: { recebido_centavos: recebido, pago_centavos: pago, saldo_centavos: recebido - pago },
      previsto: {
        a_receber_centavos: aReceber,
        a_pagar_centavos: aPagarDespesas + aPagarRepasses,
        saldo_centavos: aReceber - (aPagarDespesas + aPagarRepasses),
      },
      // Como o mês termina se tudo que está em aberto for pago e recebido no prazo.
      projetado_centavos: (recebido - pago) + aReceber - (aPagarDespesas + aPagarRepasses),
      por_mes: [...porMes.values()].sort((a, b) => a.competencia.localeCompare(b.competencia))
        .map((m) => ({ ...m, saldo: m.entrou - m.saiu })),
      saidas_por_categoria: [...categorias.entries()].map(([categoria, valor_centavos]) => ({ categoria, valor_centavos }))
        .sort((a, b) => b.valor_centavos - a.valor_centavos),
      movimentos: movimentos.slice(-300).reverse(),
      // Os próximos 30 dias, para saber se o caixa aperta.
      proximos: {
        receber_centavos: db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS n FROM faturas WHERE status = 'aberta' AND vencimento BETWEEN ? AND ?")
          .get(data, somarDias(data, 30)).n,
        pagar_centavos: db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS n FROM despesas WHERE status = 'aberta' AND vencimento BETWEEN ? AND ?")
          .get(data, somarDias(data, 30)).n,
      },
    });
  });

  return r;
};

/** Soma meses a uma data 'AAAA-MM-DD' mantendo o dia (28 no máximo, para não escorregar de mês). */
function somarMesesData(data, n) {
  const [a, m, d] = data.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, Math.min(d, 28)));
  return alvo.toISOString().slice(0, 10);
}
