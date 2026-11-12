'use strict';

const { lerConfig } = require('./ixcEmpresa');
const { detalhe } = require('./recebimentos');

const FORMAS = { dinheiro: 'Dinheiro', pix: 'PIX', debito: 'Cartão de débito', credito: 'Cartão de crédito', transferencia: 'Transferência', outro: 'Outro' };
const dinheiro = (c) => ((c ?? 0) / 100).toFixed(2).replace('.', ',');
const dataBr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const dataHoraBr = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Comprovante do recebimento em texto, para a impressora do balcão (bobina de 58 mm ≈ 32 colunas, 80 mm ≈ 48).
 * Sai sempre como texto puro: o painel imprime e também oferece uma cópia por mensagem.
 */
function comprovante(db, empresa, recebimentoId, { colunas = 42, via = 'Cliente' } = {}) {
  const r = detalhe(db, empresa.id, recebimentoId);
  const cfg = lerConfig(db, empresa.id);
  const L = Math.max(28, Math.min(64, Number(colunas) || 42));
  const linhas = [];
  const centro = (t) => String(t).trim().slice(0, L).padStart(Math.floor((L + String(t).trim().slice(0, L).length) / 2)).padEnd(L).trimEnd();
  const regua = (c = '-') => c.repeat(L);
  const par = (a, b) => {
    const esq = String(a);
    const dir = String(b);
    const espaco = L - esq.length - dir.length;
    return espaco > 0 ? esq + ' '.repeat(espaco) + dir : `${esq} ${dir}`;
  };
  const quebrar = (t) => String(t ?? '').match(new RegExp(`.{1,${L}}`, 'g')) ?? [];
  /** Linha secundária (indentada), quebrada em palavras para não cortar NSU nem autorização. */
  const linhaDetalhe = (t) => {
    const saida = [];
    let atual = ' ';
    for (const palavra of String(t).split(' ')) {
      if (`${atual} ${palavra}`.length > L) { saida.push(atual); atual = ' '; }
      atual = `${atual} ${palavra}`;
    }
    if (atual.trim()) saida.push(atual);
    return saida;
  };

  for (const l of String(cfg.comprovante_cabecalho ?? empresa.nome).split('\n').slice(0, 5)) linhas.push(centro(l));
  if (empresa.documento) linhas.push(centro(`CNPJ ${empresa.documento}`));
  linhas.push(regua('='));
  linhas.push(centro(`RECIBO DE PAGAMENTO Nº ${r.numero}`));
  linhas.push(centro(`Via ${via}`));
  linhas.push(regua('='));
  linhas.push(par('Data', dataHoraBr(r.criado_em)));
  linhas.push(par('Loja', String(r.loja_nome ?? '').slice(0, L - 6)));
  if (r.pdv_nome) linhas.push(par('PDV', String(r.pdv_nome).slice(0, L - 5)));
  linhas.push(par('Operador', String(r.operador_nome ?? '').slice(0, L - 10)));
  linhas.push(regua());
  linhas.push(...quebrar(`Cliente: ${r.cliente_nome}`));
  if (r.cliente_documento) linhas.push(`CPF/CNPJ: ${r.cliente_documento}`);
  if (r.cliente_ixc_id) linhas.push(`Código no sistema: ${r.cliente_ixc_id}`);
  linhas.push(regua());
  linhas.push('FATURAS PAGAS');
  for (const t of r.titulos) {
    const nome = t.fatura_ixc_id ? `Fatura ${t.fatura_ixc_id}` : (t.descricao ?? 'Recebimento');
    linhas.push(par(nome.slice(0, L - 12), dinheiro(t.valor_centavos)));
    const detalhes = [t.vencimento ? `venc. ${dataBr(t.vencimento)}` : null, t.documento ? `doc. ${t.documento}` : null].filter(Boolean).join(' · ');
    if (detalhes) linhas.push(...linhaDetalhe(detalhes));
    if (t.acrescimo_centavos) linhas.push(par('  multa e juros', dinheiro(t.acrescimo_centavos)));
    if (t.desconto_centavos) linhas.push(par('  desconto', `-${dinheiro(t.desconto_centavos)}`));
  }
  linhas.push(regua());
  if (r.acrescimo_centavos) linhas.push(par('Multa e juros', dinheiro(r.acrescimo_centavos)));
  if (r.desconto_centavos) linhas.push(par('Desconto', `-${dinheiro(r.desconto_centavos)}`));
  linhas.push(par('TOTAL PAGO', `R$ ${dinheiro(r.valor_centavos)}`));
  linhas.push(regua());
  linhas.push('PAGAMENTO');
  for (const p of r.pagamentos) {
    const rotulo = FORMAS[p.forma] + (p.forma === 'credito' && p.parcelas > 1 ? ` ${p.parcelas}x` : '');
    linhas.push(par(rotulo, dinheiro(p.valor_centavos)));
    const extra = [p.bandeira, p.cartao_final ? `final ${p.cartao_final}` : null, p.nsu ? `NSU ${p.nsu}` : null, p.autorizacao ? `AUT ${p.autorizacao}` : null]
      .filter(Boolean).join(' · ');
    if (extra) linhas.push(...linhaDetalhe(extra));
  }
  if (r.troco_centavos) linhas.push(par('Troco', dinheiro(r.troco_centavos)));
  if (r.status === 'cancelado') {
    linhas.push(regua('*'));
    linhas.push(centro('RECEBIMENTO CANCELADO'));
    if (r.motivo_cancelamento) linhas.push(...quebrar(r.motivo_cancelamento));
    linhas.push(regua('*'));
  }
  linhas.push(regua());
  if (r.observacao) linhas.push(...quebrar(r.observacao));
  for (const l of String(cfg.comprovante_rodape ?? 'Obrigado pela preferência!').split('\n').slice(0, 5)) linhas.push(centro(l));
  linhas.push(centro(`${dataHoraBr(new Date().toISOString())}`));
  return linhas.join('\n');
}

module.exports = { comprovante };
