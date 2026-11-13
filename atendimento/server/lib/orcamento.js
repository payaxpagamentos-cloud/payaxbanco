'use strict';

const { agora } = require('../db');
const { hoje, inicioMes, somarDias } = require('./datas');
const custo = require('./custo');
const v = require('./validacao');

/**
 * O orçamento mensal da conta da Meta — e o freio.
 *
 * Teto de gasto não serve para avisar depois que estourou. Aqui ele PARA o gasto: chegando no
 * limite, mensagem paga não sai mais; mensagem grátis (janela de 24 h, serviço) continua saindo
 * normalmente, porque o atendimento não pode parar por causa de dinheiro que não é cobrado.
 *
 * Marketing tem teto próprio. A R$ 0,32 por mensagem, uma campanha mal calibrada come num dia o
 * orçamento de cobrança do mês inteiro — e a cobrança é o que paga a empresa.
 */

const MARCOS = [50, 80, 100];

/** Quanto esta empresa já gastou no mês corrente, por categoria e no total. */
function gastoDoMes(db, empresaId, { mes = hoje().slice(0, 7) } = {}) {
  const inicio = `${mes}-01`;
  const fim = somarDias(`${mes}-01`, 31).slice(0, 8) + '01';
  const linhas = db.prepare(`SELECT categoria, COUNT(*) AS mensagens, COALESCE(SUM(custo_milesimos), 0) AS custo
    FROM mensagens WHERE empresa_id = ? AND direcao = 'saida' AND criada_em >= ? AND criada_em < ?
      AND status <> 'falhou' GROUP BY categoria`).all(empresaId, inicio, fim);
  const total = linhas.reduce((s, x) => s + Number(x.custo), 0);
  const marketing = Number(linhas.find((x) => x.categoria === 'marketing')?.custo ?? 0);
  return { mes, total_milesimos: total, marketing_milesimos: marketing, por_categoria: linhas };
}

/**
 * Estado do orçamento: o que foi aprovado, o que já foi gasto, o que sobra e em que ritmo.
 * `status`: sem_teto | ok | atencao (>=50%) | critico (>=80%) | estourado (>=100%).
 */
function estado(db, empresaId, { mes = hoje().slice(0, 7) } = {}) {
  const e = db.prepare('SELECT orcamento_milesimos, orcamento_marketing_milesimos FROM empresas WHERE id = ?').get(empresaId);
  const teto = Number(e?.orcamento_milesimos ?? 0);
  const tetoMarketing = Number(e?.orcamento_marketing_milesimos ?? 0);
  const g = gastoDoMes(db, empresaId, { mes });

  const percentual = teto ? Math.round((g.total_milesimos / teto) * 1000) / 10 : 0;
  const status = !teto ? 'sem_teto'
    : percentual >= 100 ? 'estourado' : percentual >= 80 ? 'critico' : percentual >= 50 ? 'atencao' : 'ok';

  // Ritmo: no passo de hoje, onde o mês termina.
  const dia = Number(hoje().slice(8, 10));
  const diasNoMes = new Date(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0).getDate();
  const ehMesCorrente = mes === hoje().slice(0, 7);
  const projecao = ehMesCorrente && dia > 0 ? Math.round((g.total_milesimos / dia) * diasNoMes) : g.total_milesimos;

  return {
    mes,
    orcamento_milesimos: teto,
    orcamento_marketing_milesimos: tetoMarketing,
    gasto_milesimos: g.total_milesimos,
    gasto_marketing_milesimos: g.marketing_milesimos,
    restante_milesimos: teto ? Math.max(0, teto - g.total_milesimos) : null,
    restante_marketing_milesimos: tetoMarketing ? Math.max(0, tetoMarketing - g.marketing_milesimos) : null,
    percentual,
    status,
    projecao_milesimos: projecao,
    projecao_estoura: Boolean(teto && projecao > teto),
    dias_corridos: ehMesCorrente ? dia : diasNoMes,
    dias_no_mes: diasNoMes,
  };
}

/**
 * O freio. Responde se uma mensagem desta categoria pode sair AGORA.
 * Mensagem grátis nunca é barrada — não há o que frear num custo zero.
 */
function permite(db, empresaId, categoria, { quantas = 1 } = {}) {
  const preco = custo.preco(db, categoria, empresaId);
  if (preco <= 0) return { ok: true, custo_milesimos: 0 };

  const st = estado(db, empresaId);
  const aGastar = preco * Math.max(1, Number(quantas));

  if (st.orcamento_marketing_milesimos && categoria === 'marketing'
    && st.gasto_marketing_milesimos + aGastar > st.orcamento_marketing_milesimos) {
    return { ok: false, custo_milesimos: aGastar, estado: st,
      motivo: 'o orçamento de marketing do mês acabou' };
  }
  if (st.orcamento_milesimos && st.gasto_milesimos + aGastar > st.orcamento_milesimos) {
    return { ok: false, custo_milesimos: aGastar, estado: st,
      motivo: 'o orçamento do mês acabou: só mensagem grátis sai até virar o mês' };
  }
  return { ok: true, custo_milesimos: aGastar, estado: st };
}

/**
 * Marca os marcos cruzados (50/80/100%) uma vez por mês e devolve os que acabaram de cruzar,
 * para o painel mostrar e para o relatório do Manager. Sem isso o aviso viraria spam diário.
 */
function conferirMarcos(db, empresaId) {
  const st = estado(db, empresaId);
  if (!st.orcamento_milesimos) return [];
  const novos = [];
  // Confere antes de inserir, em vez de usar INSERT OR IGNORE: o OR IGNORE engole
  // qualquer violação (um NOT NULL, uma coluna a menos) e o aviso desaparece sem erro.
  const jaAvisado = db.prepare('SELECT 1 FROM orcamento_avisos WHERE empresa_id = ? AND mes = ? AND marco = ?');
  const inserir = db.prepare(`INSERT INTO orcamento_avisos
      (empresa_id, mes, marco, gasto_milesimos, orcamento_milesimos, criado_em)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const marco of MARCOS) {
    if (st.percentual < marco) continue;
    if (jaAvisado.get(empresaId, st.mes, marco)) continue;
    inserir.run(empresaId, st.mes, marco, st.gasto_milesimos, st.orcamento_milesimos, agora());
    novos.push({ marco, ...st });
  }
  return novos;
}

const avisos = (db, empresaId, { mes = hoje().slice(0, 7) } = {}) =>
  db.prepare('SELECT * FROM orcamento_avisos WHERE empresa_id = ? AND mes = ? ORDER BY marco').all(empresaId, mes);

/** Define o orçamento da empresa. Valores em milésimos de real, como todo preço da Meta aqui. */
function definir(db, empresaId, dados = {}) {
  const atual = db.prepare('SELECT orcamento_milesimos, orcamento_marketing_milesimos FROM empresas WHERE id = ?').get(empresaId);
  const total = dados.orcamento_milesimos === undefined ? Number(atual.orcamento_milesimos)
    : v.inteiro(dados.orcamento_milesimos, 'o orçamento do mês', { min: 0, max: 1_000_000_000 });
  const mkt = dados.orcamento_marketing_milesimos === undefined ? Number(atual.orcamento_marketing_milesimos)
    : v.inteiro(dados.orcamento_marketing_milesimos, 'o orçamento de marketing', { min: 0, max: 1_000_000_000 });
  v.exigir(!total || !mkt || mkt <= total, 'O orçamento de marketing não pode ser maior que o orçamento do mês.');
  db.prepare('UPDATE empresas SET orcamento_milesimos = ?, orcamento_marketing_milesimos = ? WHERE id = ?').run(total, mkt, empresaId);
  return estado(db, empresaId);
}

module.exports = { MARCOS, estado, gastoDoMes, permite, conferirMarcos, avisos, definir, inicioMes, agora };
