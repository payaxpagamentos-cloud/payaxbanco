/*
 * Tabela de preços na tela: a mesma ficha e o mesmo formulário para a tabela padrão (Contas e preços)
 * e para a tabela de cada cliente. O Bolepix pode ter preço próprio; sem isso, segue o do boleto.
 */
import { el, campo, dinheiro, percentual, data, hojeIso } from '../../comum/ui.js';

/** Os preços próprios do Bolepix (objeto) ou null quando ele segue o preço do boleto. */
export function bolepixDe(p) {
  if (!p?.bolepix) return null;
  try { return typeof p.bolepix === 'string' ? JSON.parse(p.bolepix) : p.bolepix; } catch { return null; }
}

const reais = (v) => (v === null || v === undefined ? '' : (v / 100).toFixed(2).replace('.', ','));
const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));

/**
 * As tarifas que podem mudar entre boleto e Bolepix. "Tarifa bancária repassada" e "Tarifa mínima" saíram da
 * tela (o cliente vê uma tarifa só, a PAY AX); só aparecem se uma tabela antiga ainda tiver valor nelas.
 */
const paresTarifas = (p) => [
  par('Tarifa de emissão', dinheiro(p.tarifa_emissao_centavos ?? 0)),
  par('Tarifa PAY AX fixa', dinheiro(p.tarifa_fixa_centavos ?? 0)),
  par('Tarifa PAY AX %', percentual(p.percentual_ppm)),
  par('Tarifa máxima', p.comissao_maxima_centavos === null || p.comissao_maxima_centavos === undefined ? 'sem teto' : dinheiro(p.comissao_maxima_centavos)),
  p.tarifa_liquidacao_centavos ? par('Tarifa bancária (tabela antiga)', dinheiro(p.tarifa_liquidacao_centavos)) : null,
  p.comissao_minima_centavos ? par('Tarifa mínima (tabela antiga)', dinheiro(p.comissao_minima_centavos)) : null,
].filter(Boolean);

/** Ficha da tabela vigente: boleto, Bolepix (próprio ou "mesmo preço") e o que vale para os dois. */
export function fichaPreco(v) {
  const bp = bolepixDe(v);
  const subtitulo = (t) => el('h3', { style: 'font-size:12.5px;font-weight:650;margin:4px 0 10px;color:var(--texto-2)' }, t);
  return el('div', {},
    subtitulo(bp ? 'Boleto' : 'Boleto e Bolepix'),
    el('div', { class: 'pares cols-3' }, paresTarifas(v)),
    bp ? el('div', { style: 'margin-top:16px' }, subtitulo('Bolepix (preço próprio)'), el('div', { class: 'pares cols-3' }, paresTarifas(bp))) : null,
    el('div', { style: 'margin-top:16px' }, subtitulo('Para os dois'),
      el('div', { class: 'pares cols-3' },
        par('Tarifa do repasse', dinheiro(v.tarifa_repasse_centavos ?? 0)),
        par('Vigente desde', v.vigencia_inicio ? data(v.vigencia_inicio) : '—'),
        par('Observação', v.observacao || '—'))));
}

/** Os campos de tarifa do formulário, com prefixo (vazio para o boleto, "bolepix_" para o Bolepix). */
const camposTarifas = (p, prefixo = '') => [
  campo({ nome: `${prefixo}tarifa_emissao`, rotulo: 'Tarifa de emissão', tipo: 'dinheiro', valor: reais(p?.tarifa_emissao_centavos ?? 0), ajuda: 'Cobrada no registro' }),
  campo({ nome: `${prefixo}tarifa_fixa`, rotulo: 'Tarifa PAY AX fixa', tipo: 'dinheiro', valor: reais(p?.tarifa_fixa_centavos ?? 0), ajuda: 'Por boleto pago. Ex.: 1,99' }),
  campo({ nome: `${prefixo}percentual`, rotulo: 'Tarifa PAY AX (%)', valor: ((p?.percentual_ppm || 0) / 10000).toString().replace('.', ','), ajuda: 'Sobre o valor pago; soma com a fixa' }),
  campo({ nome: `${prefixo}comissao_maxima`, rotulo: 'Tarifa máxima', tipo: 'dinheiro', valor: reais(p?.comissao_maxima_centavos), ajuda: 'Teto da tarifa % · vazio = sem teto' }),
];

/** Formulário da tabela nova, já preenchido com a atual. */
export function formPreco(atual) {
  const bp = bolepixDe(atual);
  const blocoBolepix = el('div', { class: 'linha-form cols-3', style: 'margin-top:12px' }, camposTarifas(bp ?? atual, 'bolepix_'));
  const escolha = campo({ nome: 'bolepix_proprio', rotulo: 'Bolepix', tipo: 'select', valor: bp ? '1' : '0',
    opcoes: [['0', 'Mesmo preço do boleto'], ['1', 'Preço próprio']] });
  const mostrar = () => { blocoBolepix.hidden = escolha.querySelector('select').value !== '1'; };
  escolha.querySelector('select').addEventListener('change', mostrar);
  mostrar();
  const titulo = (t) => el('h3', { style: 'font-size:13px;font-weight:650;margin:18px 0 8px' }, t);
  return el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form cols-3' },
      campo({ nome: 'vigencia_inicio', rotulo: 'Vigente a partir de', tipo: 'date', valor: hojeIso(), obrigatorio: true }),
      campo({ nome: 'tarifa_repasse', rotulo: 'Tarifa do repasse', tipo: 'dinheiro', valor: reais(atual?.tarifa_repasse_centavos ?? 0), ajuda: 'Vale para os dois tipos' }),
      campo({ nome: 'observacao', rotulo: 'Observação', valor: '' })),
    titulo('Boleto'),
    el('div', { class: 'linha-form cols-3' }, camposTarifas(atual)),
    titulo('Bolepix (boleto com QR Code PIX)'),
    el('div', { class: 'linha-form cols-3' }, escolha),
    blocoBolepix);
}
