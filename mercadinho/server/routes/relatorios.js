'use strict';

const { Router } = require('express');
const relatorios = require('../lib/relatorios');
const { hoje, somarDias } = require('../lib/datas');
const v = require('../lib/validacao');

/** Relatórios de venda, giro, perdas e consumo — na tela e em CSV para a planilha. */
module.exports = (db) => {
  const r = Router();
  const periodo = (req) => ({
    de: req.query.de ? v.data(req.query.de, 'a data inicial') : somarDias(hoje(), -29),
    ate: req.query.ate ? v.data(req.query.ate, 'a data final') : hoje(),
  });
  const dinheiro = (c) => ((c ?? 0) / 100).toFixed(2).replace('.', ',');
  const qtd = (mil) => ((mil ?? 0) / 1000).toFixed(3).replace('.', ',');

  r.get('/vendas', (req, res) => res.json(relatorios.vendas(db, periodo(req))));
  r.get('/mais-vendidos', (req, res) => res.json(relatorios.maisVendidos(db, { ...periodo(req), limite: Math.min(Number(req.query.limite) || 20, 200) })));
  r.get('/abc', (req, res) => res.json(relatorios.curvaAbc(db, periodo(req))));
  r.get('/categorias', (req, res) => res.json(relatorios.porCategoria(db, periodo(req))));
  r.get('/moradores', (req, res) => res.json(relatorios.porMorador(db, periodo(req))));
  r.get('/sem-giro', (req, res) => res.json(relatorios.semGiro(db, periodo(req))));
  r.get('/perdas', (req, res) => res.json(relatorios.perdas(db, periodo(req))));

  /** Exportação em CSV (separador ';', abre direto no Excel). */
  r.get('/csv/:relatorio', (req, res) => {
    const p = periodo(req);
    const tabelas = {
      'mais-vendidos': () => [relatorios.maisVendidos(db, { ...p, limite: 500 }), [
        { rotulo: 'Produto', campo: 'nome' }, { rotulo: 'Categoria', campo: 'categoria' },
        { rotulo: 'Quantidade', valor: (l) => qtd(l.qtd_mil) }, { rotulo: 'Faturamento', valor: (l) => dinheiro(l.total_centavos) },
        { rotulo: 'Custo', valor: (l) => dinheiro(l.custo_centavos) }, { rotulo: 'Lucro', valor: (l) => dinheiro(l.lucro_centavos) },
      ]],
      abc: () => [relatorios.curvaAbc(db, p), [
        { rotulo: 'Classe', campo: 'classe' }, { rotulo: 'Produto', campo: 'nome' },
        { rotulo: 'Faturamento', valor: (l) => dinheiro(l.total_centavos) }, { rotulo: 'Acumulado %', valor: (l) => (l.acumulado_bp / 100).toFixed(2).replace('.', ',') },
      ]],
      perdas: () => [relatorios.perdas(db, p), [
        { rotulo: 'Data', campo: 'criado_em' }, { rotulo: 'Produto', campo: 'produto' }, { rotulo: 'Tipo', campo: 'tipo' },
        { rotulo: 'Quantidade', valor: (l) => qtd(l.qtd_mil) }, { rotulo: 'Valor', valor: (l) => dinheiro(l.valor_centavos) },
        { rotulo: 'Motivo', campo: 'observacao' }, { rotulo: 'Responsável', campo: 'usuario' },
      ]],
      moradores: () => [relatorios.porMorador(db, p), [
        { rotulo: 'Morador', campo: 'nome' }, { rotulo: 'Bloco', campo: 'bloco' }, { rotulo: 'Unidade', campo: 'unidade' },
        { rotulo: 'Compras', campo: 'compras' }, { rotulo: 'Total', valor: (l) => dinheiro(l.total_centavos) },
        { rotulo: 'Saldo devedor', valor: (l) => dinheiro(l.saldo_centavos) },
      ]],
      'sem-giro': () => [relatorios.semGiro(db, { ...p, limite: 500 }), [
        { rotulo: 'Produto', campo: 'nome' }, { rotulo: 'Estoque', valor: (l) => qtd(l.estoque_mil) },
        { rotulo: 'Valor parado', valor: (l) => dinheiro(l.parado_centavos) },
      ]],
      vendas: () => [relatorios.vendas(db, p).por_dia, [
        { rotulo: 'Dia', campo: 'dia' }, { rotulo: 'Vendas', campo: 'vendas' },
        { rotulo: 'Faturamento', valor: (l) => dinheiro(l.total) }, { rotulo: 'Custo', valor: (l) => dinheiro(l.custo) },
        { rotulo: 'Lucro', valor: (l) => dinheiro(l.total - l.custo) },
      ]],
    };
    const montar = tabelas[req.params.relatorio];
    if (!montar) throw new (require('../lib/erros').ErroNegocio)('Relatório desconhecido.', 404);
    const [linhas, colunas] = montar();
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${req.params.relatorio}-${p.de}-a-${p.ate}.csv"` });
    res.send(relatorios.csv(linhas, colunas));
  });

  return r;
};
