import { api } from './api.js';
import { html, $, moeda, dataHora, data, modal, TIPO_TRANSACAO, icone } from '../../js/ui.js';
import { tecladoPares } from './teclado.js';
import { RAIZ } from './raiz.js';

/** Estado da sessão do cliente: dados pessoais, resumo e conta selecionada. */
export const estado = { me: null, resumo: null, contaId: null, ocultarSaldo: false };

try { estado.ocultarSaldo = localStorage.getItem('payax.ib.ocultar') === '1'; } catch { /* ignora */ }
export function alternarSaldo() {
  estado.ocultarSaldo = !estado.ocultarSaldo;
  try { localStorage.setItem('payax.ib.ocultar', estado.ocultarSaldo ? '1' : '0'); } catch { /* ignora */ }
}

export async function carregarResumo() {
  estado.resumo = await api.get('/resumo');
  const contas = estado.resumo.contas;
  if (!contas.some((c) => c.id === estado.contaId)) estado.contaId = (contas.find((c) => c.tipo !== 'poupanca') ?? contas[0])?.id ?? null;
  return estado.resumo;
}

export const contaAtual = () => estado.resumo?.contas.find((c) => c.id === estado.contaId);
export const TIPO_CONTA_IB = { corrente: 'Conta corrente', poupanca: 'Poupança', pagamento: 'Conta de pagamento', salario: 'Conta salário' };
export const rotuloConta = (c) => `${TIPO_CONTA_IB[c.tipo]} · ${c.agencia} / ${c.numero}-${c.digito}`;

/** Seletor de conta de origem, para telas de saída de dinheiro. */
export function seletorConta(id = 'conta-origem') {
  const contas = estado.resumo.contas.filter((c) => c.status === 'ativa');
  return html`<label for="${id}">Conta de origem</label><select id="${id}" name="conta_id">
    ${contas.map((c) => html`<option value="${c.id}" ${c.id === estado.contaId ? 'selected' : ''}>${rotuloConta(c)} · saldo ${moeda(c.saldo_centavos)}</option>`)}</select>`;
}

export function limiteRestante() {
  const l = estado.resumo.limite;
  return html`<div class="ajuda">Limite diário disponível: <strong>${moeda(l.disponivel_centavos)}</strong> de ${moeda(l.limite_centavos)}</div>`;
}

/**
 * Pede a senha de transação e executa a operação. Erros (PIN incorreto, saldo) aparecem no próprio modal.
 * Resolve com o resultado da operação, ou null se o cliente cancelar.
 */
export function confirmarComPin({ titulo = 'Confirmar operação', resumo, executar }) {
  return new Promise((resolve) => {
    let concluido = false;
    let teclado;
    const { el } = modal({
      titulo,
      rotuloEnviar: 'Confirmar',
      corpo: html`${resumo}<div id="teclado-pin" style="margin-top:16px"></div>`,
      aoAbrir: (m) => { teclado = tecladoPares($('#teclado-pin', m), { rotulo: 'Senha de transação' }); },
      aoEnviar: async (_form, fechar) => {
        if (!teclado.completo()) throw new Error('Digite os 6 números da senha de transação.');
        try {
          const r = await executar(teclado.valor());
          concluido = true;
          fechar();
          resolve(r);
        } catch (e) {
          teclado.renovar(); // cada teclado vale para uma única tentativa
          throw e;
        }
      },
    });
    const observar = new MutationObserver(() => { if (!el.isConnected) { observar.disconnect(); if (!concluido) resolve(null); } });
    observar.observe(document.querySelector('#modal-root'), { childList: true });
  });
}

export const linhaRecibo = (rotulo, valor) => (valor ? html`<div class="linha"><span>${rotulo}</span><span>${valor}</span></div>` : '');

/** Comprovante de uma transação. */
export async function mostrarComprovante(transacaoId, { sucesso = false } = {}) {
  const c = await api.get(`/comprovantes/${transacaoId}`);
  const saida = c.valor_centavos < 0;
  const destino = c.contraparte
    ? `${c.contraparte.nome} · ${c.contraparte.documento} · ${c.contraparte.instituicao} ${c.contraparte.conta}`
    : c.pix_saida ? `Chave ${c.pix_saida.chave} · outro banco` : null;
  const origem = c.pix_entrada ? `${c.pix_entrada.pagador_nome ?? 'Pagador'}${c.pix_entrada.pagador_documento ? ` · ${c.pix_entrada.pagador_documento}` : ''}` : null;
  modal({
    titulo: 'Comprovante',
    corpo: html`
      ${sucesso ? html`<div class="sucesso"><div class="ok">${icone('check')}</div><h2>${saida ? 'Pronto! Operação realizada.' : 'Recebido!'}</h2></div>` : ''}
      <div class="recibo">
        <div style="text-align:center;margin-bottom:10px"><img src="${RAIZ}img/logo-payax.svg" alt="PAY AX" style="height:26px"></div>
        ${linhaRecibo('Operação', TIPO_TRANSACAO[c.tipo] ?? c.tipo)}
        ${linhaRecibo('Valor', moeda(Math.abs(c.valor_centavos)))}
        ${linhaRecibo('Data e hora', dataHora(c.criado_em))}
        ${linhaRecibo(saida ? 'Origem' : 'Destino', `${c.titular} · ${c.conta}`)}
        ${linhaRecibo(saida ? 'Destino' : 'Origem', saida ? destino : (origem || (c.contraparte ? `${c.contraparte.nome} · ${c.contraparte.conta}` : null)))}
        ${c.pagamento ? html`${linhaRecibo('Código', c.pagamento.linha_formatada)}${linhaRecibo('Vencimento', c.pagamento.vencimento ? data(c.pagamento.vencimento) : null)}` : ''}
        ${linhaRecibo('Descrição', c.descricao)}
        ${c.estornada_em ? linhaRecibo('Situação', `Devolvido em ${dataHora(c.estornada_em)}`) : ''}
        ${linhaRecibo('Autenticação', html`<span class="mono small">${c.autenticacao}</span>`)}
      </div>`,
    rodape: html`<div class="modal-foot"><button class="btn primario" data-cancelar>Fechar</button></div>`,
  });
}

export function iconeLancamento(t) {
  const entrada = t.valor_centavos > 0;
  return html`<span class="ic ${entrada ? 'entrada' : ''}">${icone(entrada ? 'entrada' : 'saida')}</span>`;
}

export function listaLancamentos(itens, { agruparPorDia = false } = {}) {
  if (!itens.length) return html`<div class="vazio">Nenhum lançamento no período.</div>`;
  let diaAnterior = null;
  return html`${itens.map((t) => {
    const dia = data(t.criado_em);
    const cabecalho = agruparPorDia && dia !== diaAnterior ? html`<div class="dia">${dia}</div>` : '';
    diaAnterior = dia;
    return html`${cabecalho}<button type="button" class="lanc" data-comprovante="${t.id}">${iconeLancamento(t)}
      <span class="txt"><strong>${TIPO_TRANSACAO[t.tipo] ?? t.tipo}${t.estornada_em ? ' · devolvido' : ''}</strong><span>${t.contraparte_nome ?? t.descricao ?? ''} · ${dataHora(t.criado_em)}</span></span>
      <span class="vl ${t.valor_centavos > 0 ? 'pos' : ''} ${estado.ocultarSaldo ? 'oculto' : ''}">${t.valor_centavos > 0 ? '+' : '−'} ${moeda(Math.abs(t.valor_centavos))}</span></button>`;
  })}`;
}

export function ligarComprovantes(raiz) {
  raiz.querySelectorAll('[data-comprovante]').forEach((b) => b.addEventListener('click', () => mostrarComprovante(b.dataset.comprovante)));
}
