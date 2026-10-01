'use strict';

const { Router } = require('express');
const { ErroNegocio } = require('../lib/erros');
const transacoes = require('./transacoes');

const celula = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Evita injeção de fórmulas em planilhas e escapa aspas/separadores.
  const seguro = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
};
const reais = (c) => (Number(c) / 100).toFixed(2).replace('.', ',');

function csv(colunas, linhas) {
  const cab = colunas.map((c) => celula(c.titulo)).join(';');
  const corpo = linhas.map((l) => colunas.map((c) => celula(c.valor(l))).join(';'));
  return '﻿' + [cab, ...corpo].join('\r\n');
}

module.exports = (db) => {
  const r = Router();

  const RELATORIOS = {
    clientes: () => csv([
      { titulo: 'ID', valor: (l) => l.id }, { titulo: 'Tipo', valor: (l) => l.tipo }, { titulo: 'Nome', valor: (l) => l.nome },
      { titulo: 'Documento', valor: (l) => l.documento }, { titulo: 'E-mail', valor: (l) => l.email }, { titulo: 'Telefone', valor: (l) => l.telefone },
      { titulo: 'Cidade', valor: (l) => l.cidade }, { titulo: 'UF', valor: (l) => l.uf }, { titulo: 'Status', valor: (l) => l.status },
      { titulo: 'Renda/Faturamento (R$)', valor: (l) => reais(l.renda_mensal_centavos) }, { titulo: 'Cadastro', valor: (l) => l.criado_em },
    ], db.prepare('SELECT * FROM clientes ORDER BY nome').all()),
    contas: () => csv([
      { titulo: 'Agência', valor: (l) => l.agencia }, { titulo: 'Conta', valor: (l) => `${l.numero}-${l.digito}` }, { titulo: 'Tipo', valor: (l) => l.tipo },
      { titulo: 'Titular', valor: (l) => l.cliente_nome }, { titulo: 'Documento', valor: (l) => l.documento },
      { titulo: 'Saldo (R$)', valor: (l) => reais(l.saldo_centavos) }, { titulo: 'Limite (R$)', valor: (l) => reais(l.limite_centavos) },
      { titulo: 'Status', valor: (l) => l.status }, { titulo: 'Abertura', valor: (l) => l.aberta_em },
    ], db.prepare('SELECT c.*, cl.nome AS cliente_nome, cl.documento FROM contas c JOIN clientes cl ON cl.id = c.cliente_id ORDER BY c.numero').all()),
    transacoes: (query) => {
      const { where, params } = transacoes.filtrar(query);
      return csv([
        { titulo: 'ID', valor: (l) => l.id }, { titulo: 'Data (UTC)', valor: (l) => l.criado_em }, { titulo: 'Conta', valor: (l) => `${l.agencia}/${l.conta}` },
        { titulo: 'Cliente', valor: (l) => l.cliente_nome }, { titulo: 'Tipo', valor: (l) => l.tipo }, { titulo: 'Descrição', valor: (l) => l.descricao },
        { titulo: 'Valor (R$)', valor: (l) => reais(l.valor_centavos) }, { titulo: 'Saldo após (R$)', valor: (l) => reais(l.saldo_apos_centavos) },
        { titulo: 'Operador', valor: (l) => l.usuario_nome }, { titulo: 'Estornada em', valor: (l) => l.estornada_em },
      ], db.prepare(`${transacoes.SELECT} ${where} ORDER BY t.id`).all(...params));
    },
    emprestimos: () => csv([
      { titulo: 'ID', valor: (l) => l.id }, { titulo: 'Cliente', valor: (l) => l.cliente_nome }, { titulo: 'Valor (R$)', valor: (l) => reais(l.valor_centavos) },
      { titulo: 'Taxa a.m. (%)', valor: (l) => (l.taxa_mensal * 100).toFixed(2).replace('.', ',') }, { titulo: 'Parcelas', valor: (l) => l.num_parcelas },
      { titulo: 'Parcela (R$)', valor: (l) => reais(l.valor_parcela_centavos) }, { titulo: 'Saldo devedor (R$)', valor: (l) => reais(l.saldo_devedor) },
      { titulo: 'Status', valor: (l) => l.status }, { titulo: 'Contratação', valor: (l) => l.criado_em },
    ], db.prepare(`SELECT e.*, cl.nome AS cliente_nome,
        (SELECT COALESCE(SUM(valor_centavos),0) FROM parcelas p WHERE p.emprestimo_id = e.id AND p.status = 'aberta') AS saldo_devedor
      FROM emprestimos e JOIN clientes cl ON cl.id = e.cliente_id ORDER BY e.id`).all()),
  };

  r.get('/:nome.csv', (req, res) => {
    const gerar = RELATORIOS[req.params.nome];
    if (!gerar) throw new ErroNegocio('Relatório inexistente.', 404);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="payax-${req.params.nome}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(gerar(req.query));
  });

  return r;
};
