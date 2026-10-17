'use strict';

const { transacao } = require('../db');
const { daEmpresa } = require('./acesso');
const v = require('./validacao');
const { mes: mesDe, somarMeses, hoje } = require('./datas');

const MESES = (ano) => Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, '0')}`);

/**
 * Orçado × realizado por categoria e mês (realizado pela competência, sem cancelados).
 * Para despesas, variação positiva é gasto acima do orçado.
 */
function comparativo(db, empresaId, ano) {
  v.exigir(/^\d{4}$/.test(String(ano)), 'Ano inválido.');
  const meses = MESES(ano);
  const categorias = db.prepare("SELECT id, nome, tipo, grupo_dre FROM categorias WHERE empresa_id = ? AND (ativo = 1 OR id IN (SELECT categoria_id FROM orcamentos WHERE empresa_id = ?)) AND grupo_dre <> 'fora_dre' ORDER BY tipo DESC, nome")
    .all(empresaId, empresaId);
  const orcado = db.prepare('SELECT categoria_id, mes, valor_centavos FROM orcamentos WHERE empresa_id = ? AND mes BETWEEN ? AND ?').all(empresaId, meses[0], meses[11]);
  const realizado = db.prepare(`SELECT categoria_id, substr(competencia, 1, 7) AS mes, SUM(valor_centavos) AS valor FROM lancamentos
    WHERE empresa_id = ? AND status <> 'cancelado' AND competencia BETWEEN ? AND ? GROUP BY categoria_id, mes`).all(empresaId, `${ano}-01-01`, `${ano}-12-31`);
  const mapa = (linhas, campo) => {
    const m = new Map();
    for (const l of linhas) m.set(`${l.categoria_id}|${l.mes}`, l[campo]);
    return m;
  };
  const o = mapa(orcado, 'valor_centavos');
  const r = mapa(realizado, 'valor');
  const linhas = categorias.map((c) => {
    const valores = meses.map((m) => ({ mes: m, orcado: o.get(`${c.id}|${m}`) ?? 0, realizado: r.get(`${c.id}|${m}`) ?? 0 }));
    const totalO = valores.reduce((a, x) => a + x.orcado, 0);
    const totalR = valores.reduce((a, x) => a + x.realizado, 0);
    return { ...c, valores, orcado: totalO, realizado: totalR, variacao: totalR - totalO, percentual: totalO ? totalR / totalO : null };
  });
  const soma = (tipo, campo) => linhas.filter((l) => l.tipo === tipo).reduce((a, l) => a + l[campo], 0);
  return {
    ano: Number(ano), meses, linhas,
    totais: {
      receitas: { orcado: soma('receita', 'orcado'), realizado: soma('receita', 'realizado') },
      despesas: { orcado: soma('despesa', 'orcado'), realizado: soma('despesa', 'realizado') },
    },
  };
}

/** Grava valores: [{ categoria_id, mes, valor_centavos }]. Valor zero apaga. */
function salvar(db, empresaId, itens) {
  v.exigir(Array.isArray(itens) && itens.length <= 5000, 'Envie a lista de valores.');
  transacao(db, () => {
    for (const i of itens) {
      daEmpresa(db, 'categorias', v.id(i.categoria_id), empresaId, 'Categoria');
      v.exigir(/^\d{4}-(0[1-9]|1[0-2])$/.test(String(i.mes)), 'Mês inválido.');
      const valor = v.valorCentavos(i.valor_centavos ?? 0, 'valor orçado', { zero: true });
      if (valor) {
        db.prepare(`INSERT INTO orcamentos (empresa_id, categoria_id, mes, valor_centavos) VALUES (?, ?, ?, ?)
          ON CONFLICT (empresa_id, categoria_id, mes) DO UPDATE SET valor_centavos = excluded.valor_centavos`).run(empresaId, Number(i.categoria_id), i.mes, valor);
      } else {
        db.prepare('DELETE FROM orcamentos WHERE empresa_id = ? AND categoria_id = ? AND mes = ?').run(empresaId, Number(i.categoria_id), i.mes);
      }
    }
  });
}

/** Preenche o ano com a média mensal realizada nos 3 meses anteriores ao pedido, com reajuste percentual. */
function sugerir(db, empresaId, ano, reajuste = 0, base = hoje()) {
  const fim = `${mesDe(somarMeses(base, -1))}-31`;
  const inicio = `${mesDe(somarMeses(base, -3))}-01`;
  const medias = db.prepare(`SELECT categoria_id, SUM(valor_centavos) / 3 AS media FROM lancamentos
    WHERE empresa_id = ? AND status <> 'cancelado' AND competencia BETWEEN ? AND ? GROUP BY categoria_id`).all(empresaId, inicio, fim);
  const fator = 1 + Number(reajuste || 0) / 100;
  v.exigir(fator > 0 && fator < 5, 'Reajuste inválido.');
  const itens = medias.flatMap((m) => MESES(ano).map((mes) => ({ categoria_id: m.categoria_id, mes, valor_centavos: Math.round(m.media * fator) })));
  salvar(db, empresaId, itens);
  return { categorias: medias.length };
}

module.exports = { comparativo, salvar, sugerir };
