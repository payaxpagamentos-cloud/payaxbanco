/*
 * Tabela de preços na tela: a mesma ficha e o mesmo formulário para a tabela padrão (Contas e preços),
 * a tabela de cada cliente e a proposta do CRM.
 *
 * Modelo de preço da PAY AX: o cliente paga UMA tarifa por título pago — a Tarifa Boleto ou a Tarifa
 * Bolepix. O banco cobra da PAY AX a tarifa dele (cadastrada na conta bancária); a margem é a diferença.
 * Sem porcentagem e sem tarifa de repasse. Tabelas antigas com outros valores continuam valendo até uma
 * tabela nova entrar, e aparecem marcadas como "tabela antiga".
 */
import { el, campo, dinheiro, percentual, data, hojeIso } from '../../comum/ui.js';

/** Os preços próprios do Bolepix (objeto) ou null quando ele segue o preço do boleto. */
export function bolepixDe(p) {
  if (!p?.bolepix) return null;
  try { return typeof p.bolepix === 'string' ? JSON.parse(p.bolepix) : p.bolepix; } catch { return null; }
}

/** Tarifa do boleto e do Bolepix (o Bolepix sem preço próprio segue o boleto). */
export const tarifaBoleto = (p) => p?.tarifa_fixa_centavos ?? 0;
export const tarifaBolepix = (p) => bolepixDe(p)?.tarifa_fixa_centavos ?? tarifaBoleto(p);

const reais = (v) => (v === null || v === undefined ? '' : (v / 100).toFixed(2).replace('.', ','));
const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));

/** Valores do modelo antigo (emissão, %, bancária, mínima, máxima, repasse) que uma tabela ainda tenha. */
function antigos(p) {
  const bp = bolepixDe(p) ?? {};
  const l = [];
  // Mostra o valor do boleto e, se o Bolepix tiver outro, os dois.
  const par2 = (k, fmt) => {
    const a = p?.[k] ?? 0; const b = bp[k] ?? a;
    if (!a && !b) return null;
    return a === b ? fmt(a) : `${fmt(a)} (Bolepix ${fmt(b)})`;
  };
  for (const [k, rot, fmt] of [['tarifa_emissao_centavos', 'Tarifa de emissão', dinheiro], ['percentual_ppm', 'Tarifa %', percentual],
    ['tarifa_liquidacao_centavos', 'Tarifa bancária', dinheiro], ['comissao_minima_centavos', 'Tarifa mínima', dinheiro]]) {
    const x = par2(k, fmt);
    if (x) l.push([rot, x]);
  }
  if (p?.comissao_maxima_centavos !== null && p?.comissao_maxima_centavos !== undefined) l.push(['Tarifa máxima', dinheiro(p.comissao_maxima_centavos)]);
  if (p?.tarifa_repasse_centavos) l.push(['Tarifa de repasse', dinheiro(p.tarifa_repasse_centavos)]);
  return l;
}

/** Ficha da tabela vigente. */
export function fichaPreco(v) {
  const velhos = antigos(v);
  return el('div', {},
    el('div', { class: 'pares cols-3' },
      par('Tarifa Boleto', el('strong', {}, `${dinheiro(tarifaBoleto(v))} por boleto pago`)),
      par('Tarifa Bolepix', el('strong', {}, `${dinheiro(tarifaBolepix(v))} por Bolepix pago`)),
      par('Vigente desde', v?.vigencia_inicio ? data(v.vigencia_inicio) : 'na abertura da conta')),
    v?.observacao ? el('p', { class: 'sub', style: 'margin-top:10px' }, v.observacao) : null,
    velhos.length ? el('div', { style: 'margin-top:14px;padding-top:12px;border-top:1px dashed var(--borda-forte)' },
      el('p', { class: 'sub', style: 'margin-bottom:8px' }, 'Tabela antiga: estes valores ainda valem até salvar uma tabela nova (que zera todos eles).'),
      el('div', { class: 'pares cols-3' }, velhos.map(([r, x]) => par(r, x)))) : null);
}

/**
 * Formulário da tabela nova: só a Tarifa Boleto e a Tarifa Bolepix. Os demais campos do motor de preços
 * vão zerados (o servidor trata ausente como zero).
 */
export function formPreco(atual) {
  return el('form', { onsubmit: (e) => e.preventDefault() },
    el('input', { type: 'hidden', name: 'bolepix_proprio', value: '1' }),
    el('div', { class: 'linha-form cols-3' },
      campo({ nome: 'tarifa_fixa', rotulo: 'Tarifa Boleto', tipo: 'dinheiro', valor: reais(tarifaBoleto(atual)), obrigatorio: true,
        ajuda: 'Cobrada do cliente por boleto pago' }),
      campo({ nome: 'bolepix_tarifa_fixa', rotulo: 'Tarifa Bolepix', tipo: 'dinheiro', valor: reais(tarifaBolepix(atual)), obrigatorio: true,
        ajuda: 'Por Bolepix pago (boleto com QR Code PIX)' }),
      campo({ nome: 'vigencia_inicio', rotulo: 'Vigente a partir de', tipo: 'date', valor: hojeIso(), obrigatorio: true })),
    el('div', { style: 'margin-top:12px' }, campo({ nome: 'observacao', rotulo: 'Observação', valor: '' })));
}
