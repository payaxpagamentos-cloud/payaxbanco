'use strict';

const config = require('../config');
const { agora } = require('../db');
const { hoje, somarDias } = require('./datas');

/**
 * O dólar do dia, direto do Banco Central.
 *
 * A fonte é a PTAX, a taxa oficial que o Banco Central publica todo dia útil por volta das 13h.
 * É pública, gratuita e não precisa de chave. Usamos a de VENDA, que é a referência para quem paga
 * em dólar — a Meta, no caso.
 *
 * O cartão de crédito cobra o dólar dele, com IOF e spread, um pouco acima da PTAX. Por isso a
 * conferência da fatura mostra, à parte, o "câmbio efetivo" — quanto o dólar ficou de verdade.
 *
 * Fim de semana e feriado não têm boletim: vale o último dia útil. Se o Banco Central não
 * responder, o sistema segue com a última cotação guardada, e na falta dela com a informada à mão.
 */

const x10000 = (n) => Math.round(Number(n) * 10_000);
// A API do Banco Central quer as datas como MM-DD-AAAA.
const dataBc = (iso) => `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}`;

/** Os boletins PTAX entre duas datas, do Banco Central. */
async function buscar({ de, ate, buscarHttp = fetch } = {}) {
  const url = `${config.ptax.url}/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)`
    + `?@dataInicial='${dataBc(de)}'&@dataFinalCotacao='${dataBc(ate)}'&$format=json&$select=cotacaoCompra,cotacaoVenda,dataHoraCotacao`;
  const r = await buscarHttp(url, { signal: AbortSignal.timeout(config.ptax.timeoutMs) });
  if (!r.ok) throw new Error(`o Banco Central respondeu ${r.status}`);
  const d = await r.json();
  const lista = Array.isArray(d?.value) ? d.value : [];
  return lista
    .filter((x) => Number(x.cotacaoVenda) > 0 && Number(x.cotacaoCompra) > 0 && x.dataHoraCotacao)
    .map((x) => ({
      data: String(x.dataHoraCotacao).slice(0, 10),
      venda_x10000: x10000(x.cotacaoVenda),
      compra_x10000: x10000(x.cotacaoCompra),
      // O Banco Central manda o horário de Brasília sem fuso; sem marcar, um servidor em UTC
      // mostraria o boletim das 13h como 10h.
      boletim_em: `${String(x.dataHoraCotacao).slice(0, 19).replace(' ', 'T')}-03:00`,
    }));
}

/**
 * Busca os últimos dias e guarda. Dez dias cobrem feriado prolongado e Carnaval. Devolve o
 * boletim mais recente, ou null se nada veio — quem chama segue com o que já estava guardado.
 */
async function atualizar(db, { buscarHttp = fetch, ate = hoje() } = {}) {
  const lista = await buscar({ de: somarDias(ate, -10), ate, buscarHttp });
  const gravar = db.prepare(`INSERT INTO cotacoes (data, venda_x10000, compra_x10000, boletim_em, obtida_em) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (data) DO UPDATE SET venda_x10000 = excluded.venda_x10000, compra_x10000 = excluded.compra_x10000,
      boletim_em = excluded.boletim_em, obtida_em = excluded.obtida_em`);
  // O Banco Central publica boletins intermediários no dia; o último do dia é o fechamento.
  for (const b of [...lista].sort((a, b2) => a.boletim_em.localeCompare(b2.boletim_em))) {
    gravar.run(b.data, b.venda_x10000, b.compra_x10000, b.boletim_em, agora());
  }
  return doDia(db);
}

/** O boletim mais recente guardado: o dólar "de hoje" (ou do último dia útil). */
const doDia = (db) => db.prepare('SELECT * FROM cotacoes ORDER BY data DESC LIMIT 1').get() ?? null;

/** A média da PTAX de venda no mês — é com ela que o mês fecha em reais. */
function mediaDoMes(db, mes) {
  const r = db.prepare("SELECT AVG(venda_x10000) AS media, COUNT(*) AS dias FROM cotacoes WHERE substr(data, 1, 7) = ?").get(mes);
  return r?.dias ? { media_x10000: Math.round(r.media), dias: Number(r.dias) } : null;
}

const publico = (c) => (c ? {
  data: c.data, venda: c.venda_x10000 / 10_000, compra: c.compra_x10000 / 10_000,
  venda_x10000: c.venda_x10000, boletim_em: c.boletim_em, obtida_em: c.obtida_em,
  fonte: 'PTAX de venda — Banco Central do Brasil',
} : null);

module.exports = { buscar, atualizar, doDia, mediaDoMes, publico };
