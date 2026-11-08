'use strict';

/** Linhas da DRE, na ordem em que aparecem. `sinal`: +1 soma ao resultado, -1 subtrai. */
const GRUPOS_DRE = [
  { chave: 'receita_bruta', rotulo: 'Receita bruta', tipo: 'receita', sinal: 1 },
  { chave: 'deducoes', rotulo: 'Deduções da receita', tipo: 'despesa', sinal: -1 },
  { chave: 'custos', rotulo: 'Custos (CMV / CSP)', tipo: 'despesa', sinal: -1 },
  { chave: 'despesas_operacionais', rotulo: 'Despesas operacionais', tipo: 'despesa', sinal: -1 },
  { chave: 'receitas_financeiras', rotulo: 'Receitas financeiras', tipo: 'receita', sinal: 1 },
  { chave: 'despesas_financeiras', rotulo: 'Despesas financeiras', tipo: 'despesa', sinal: -1 },
  { chave: 'outras_receitas', rotulo: 'Outras receitas', tipo: 'receita', sinal: 1 },
  { chave: 'outras_despesas', rotulo: 'Outras despesas', tipo: 'despesa', sinal: -1 },
  { chave: 'impostos_lucro', rotulo: 'IRPJ e CSLL', tipo: 'despesa', sinal: -1 },
  // Movimentações de caixa que não são resultado: aportes, empréstimos, investimentos, distribuição de lucros.
  { chave: 'fora_dre', rotulo: 'Fora da DRE (caixa apenas)', tipo: null, sinal: 0 },
];
const GRUPO = Object.fromEntries(GRUPOS_DRE.map((g) => [g.chave, g]));

/** Grupos aceitos para cada tipo de categoria. */
const gruposDoTipo = (tipo) => GRUPOS_DRE.filter((g) => g.tipo === tipo || g.tipo === null).map((g) => g.chave);

const CATEGORIAS_PADRAO = [
  ['Venda de produtos', 'receita', 'receita_bruta'],
  ['Prestação de serviços', 'receita', 'receita_bruta'],
  ['Rendimentos de aplicações', 'receita', 'receitas_financeiras'],
  ['Outras receitas', 'receita', 'outras_receitas'],
  ['Aporte de sócios', 'receita', 'fora_dre'],
  ['Empréstimos recebidos', 'receita', 'fora_dre'],
  ['Impostos sobre vendas (Simples, ISS, ICMS)', 'despesa', 'deducoes'],
  ['Devoluções e abatimentos', 'despesa', 'deducoes'],
  ['Compra de mercadorias', 'despesa', 'custos'],
  ['Serviços terceirizados', 'despesa', 'custos'],
  ['Salários e encargos', 'despesa', 'despesas_operacionais'],
  ['Pró-labore', 'despesa', 'despesas_operacionais'],
  ['Aluguel e condomínio', 'despesa', 'despesas_operacionais'],
  ['Energia, água e internet', 'despesa', 'despesas_operacionais'],
  ['Marketing e publicidade', 'despesa', 'despesas_operacionais'],
  ['Software e sistemas', 'despesa', 'despesas_operacionais'],
  ['Contabilidade e BPO', 'despesa', 'despesas_operacionais'],
  ['Material de escritório', 'despesa', 'despesas_operacionais'],
  ['Tarifas bancárias', 'despesa', 'despesas_financeiras'],
  ['Juros e multas', 'despesa', 'despesas_financeiras'],
  ['IRPJ e CSLL', 'despesa', 'impostos_lucro'],
  ['Outras despesas', 'despesa', 'outras_despesas'],
  ['Distribuição de lucros', 'despesa', 'fora_dre'],
  ['Investimentos em imobilizado', 'despesa', 'fora_dre'],
  ['Amortização de empréstimos', 'despesa', 'fora_dre'],
];

/** Rotinas mensais criadas para toda empresa nova da carteira (dia do mês, título). */
const ROTINAS_PADRAO = [
  [5, 'Conciliação bancária do mês anterior'],
  [8, 'Fechamento e envio da DRE do mês anterior'],
  [25, 'Programação de pagamentos do próximo mês'],
];

module.exports = { GRUPOS_DRE, GRUPO, gruposDoTipo, CATEGORIAS_PADRAO, ROTINAS_PADRAO };
