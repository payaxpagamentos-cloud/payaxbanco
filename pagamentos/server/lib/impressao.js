'use strict';

/**
 * Ficha de compensação para o pagador: recibo + boleto, em HTML pronto para imprimir ou salvar em PDF
 * pelo próprio navegador (sem depender de biblioteca de PDF).
 *
 * No modelo de conta gráfica quem consta como BENEFICIÁRIO é a PAY AX (dona do convênio); o cliente
 * aparece como BENEFICIÁRIO FINAL (sacador avalista), como manda a prática para esse arranjo.
 */
const QRCode = require('qrcode');
const codigobarras = require('./codigobarras');
const febraban = require('./febraban');
const { valorAtualizado } = require('./boletos');

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const data = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const doc = (d) => {
  const t = String(d ?? '').replace(/\D/g, '');
  if (t.length === 11) return t.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (t.length === 14) return t.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return t;
};
const pct = (ppm) => (Number(ppm || 0) / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 4 });

const campo = (rotulo, valor, { grande = false, classe = '' } = {}) =>
  `<div class="campo ${classe}"><span class="rot">${esc(rotulo)}</span><span class="val${grande ? ' grande' : ''}">${esc(valor ?? '')}</span></div>`;

/** @returns {Promise<string>} HTML completo da ficha. */
async function fichaCompensacao({ boleto, conta, cliente, hoje, base = '' }) {
  const atual = valorAtualizado(boleto, hoje);
  const linha = febraban.formatarLinha(boleto.linha_digitavel ?? '');
  const nn = febraban.formatarNossoNumero(boleto.nosso_numero, boleto.nosso_numero_dv);
  const barras = boleto.codigo_barras ? codigobarras.svg(boleto.codigo_barras, { altura: 50 }) : '';
  const qr = boleto.pix_emv
    ? await QRCode.toString(boleto.pix_emv, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
    : '';
  const instrucoes = [
    boleto.mensagem,
    boleto.multa_ppm ? `Após o vencimento, multa de ${pct(boleto.multa_ppm)}%.` : null,
    boleto.juros_mes_ppm ? `Após o vencimento, juros de ${pct(boleto.juros_mes_ppm)}% ao mês (pro rata die).` : null,
    boleto.desconto_centavos && boleto.desconto_ate ? `Desconto de R$ ${brl(boleto.desconto_centavos)} para pagamento até ${data(boleto.desconto_ate)}.` : null,
    boleto.dias_baixa ? `Não receber após ${boleto.dias_baixa} dias do vencimento.` : null,
    boleto.pix_emv ? 'Este boleto também pode ser pago pelo QR Code PIX (Bolepix).' : null,
  ].filter(Boolean);

  const enderecoPagador = [boleto.pagador_endereco, boleto.pagador_numero].filter(Boolean).join(', ');
  const cidadePagador = [boleto.pagador_bairro, [boleto.pagador_cidade, boleto.pagador_uf].filter(Boolean).join('/'),
    boleto.pagador_cep ? `CEP ${String(boleto.pagador_cep).replace(/(\d{5})(\d{3})/, '$1-$2')}` : null].filter(Boolean).join(' · ');

  const cabecalho = (titulo) => `<div class="banco">
      <span class="logo">BRADESCO</span><span class="cod">${esc(conta.banco)}-2</span>
      <span class="linha-dig">${esc(linha)}</span>
    </div><div class="titulo-via">${esc(titulo)}</div>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boleto ${esc(nn)} — ${esc(boleto.pagador_nome)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font: 11px/1.3 Arial, Helvetica, sans-serif; color: #000; background: #e9eaec; margin: 0; padding: 16px; }
  .folha { background: #fff; max-width: 190mm; margin: 0 auto; padding: 10mm; }
  .acoes { max-width: 190mm; margin: 0 auto 12px; display: flex; gap: 8px; justify-content: flex-end; }
  .acoes button { font: 600 13px/1 Arial; padding: 10px 16px; border: 0; border-radius: 6px; background: #0b3d2c; color: #fff; cursor: pointer; }
  .acoes button.sec { background: #fff; color: #0b3d2c; border: 1px solid #0b3d2c; }
  .banco { display: flex; align-items: flex-end; gap: 10px; border-bottom: 2px solid #000; padding-bottom: 3px; }
  .logo { font: 700 22px/1 Arial; letter-spacing: -0.5px; color: #cc092f; }
  .cod { font: 700 17px/1 Arial; border-left: 2px solid #000; border-right: 2px solid #000; padding: 2px 8px; }
  .linha-dig { font: 700 15px/1 Arial; margin-left: auto; letter-spacing: 0.2px; }
  .titulo-via { text-align: right; font-size: 10px; color: #444; padding: 2px 0 4px; }
  table.ficha { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.ficha td { border: 1px solid #000; border-top: 0; border-left: 0; padding: 0; vertical-align: top; }
  table.ficha tr td:last-child { border-right: 0; }
  .campo { padding: 2px 5px 3px; min-height: 30px; }
  .campo .rot { display: block; font-size: 8.5px; color: #333; line-height: 1.2; }
  .campo .val { display: block; font-size: 11.5px; min-height: 14px; word-break: break-word; }
  .campo .val.grande { font-size: 15px; font-weight: 700; text-align: right; }
  .campo.alto { min-height: 56px; }
  .instrucoes { padding: 3px 5px; min-height: 70px; }
  .instrucoes p { margin: 0 0 3px; }
  .pagador { border-top: 1px solid #000; padding: 4px 5px; font-size: 11px; }
  .pagador strong { font-size: 11.5px; }
  .pagador small { display: block; color: #333; }
  /* Medidas do padrão FEBRABAN: barra fina de 0,254 mm (103 mm no total) por 13 mm de altura. */
  .barras { margin-top: 10px; display: flex; align-items: flex-end; gap: 16px; }
  .barras svg { width: 103mm; height: 13mm; }
  .corte { border-top: 1px dashed #666; margin: 14px 0 10px; position: relative; }
  .corte span { position: absolute; top: -8px; left: 0; background: #fff; padding-right: 6px; font-size: 9px; color: #666; }
  .pix { border: 1px solid #000; padding: 6px; display: flex; gap: 10px; align-items: center; margin-top: 8px; }
  .pix svg { width: 92px; height: 92px; }
  .pix .texto { font-size: 10px; }
  .pix .texto strong { display: block; font-size: 12px; margin-bottom: 2px; }
  .pix .emv { font: 9px/1.25 monospace; word-break: break-all; color: #333; margin-top: 4px; max-width: 320px; }
  .rodape { margin-top: 8px; font-size: 9px; color: #555; display: flex; justify-content: space-between; }
  @media print { body { background: #fff; padding: 0; } .folha { padding: 0; max-width: none; } .acoes { display: none; } }
</style>
</head>
<body>
<div class="acoes">
  <button type="button" onclick="window.print()">Imprimir / salvar PDF</button>
  ${boleto.pix_emv ? '<button type="button" class="sec" id="copiar">Copiar código PIX</button>' : ''}
</div>
<div class="folha">
  ${cabecalho('Recibo do pagador')}
  <table class="ficha">
    <tr>
      <td colspan="4">${campo('Beneficiário', `${conta.beneficiario_nome} — CNPJ ${doc(conta.beneficiario_documento)}`)}</td>
      <td colspan="2">${campo('Agência / Código do beneficiário', `${conta.agencia}${conta.agencia_dv ? `-${conta.agencia_dv}` : ''} / ${conta.conta}${conta.conta_dv ? `-${conta.conta_dv}` : ''}`)}</td>
    </tr>
    <tr>
      <td colspan="2">${campo('Beneficiário final (sacador avalista)', `${cliente.razao_social} — CNPJ ${doc(cliente.cnpj)}`)}</td>
      <td>${campo('Nosso número', nn)}</td>
      <td>${campo('Nº do documento', boleto.seu_numero || '—')}</td>
      <td>${campo('Vencimento', data(boleto.vencimento))}</td>
      <td>${campo('Valor do documento', `R$ ${brl(boleto.valor_centavos)}`, { grande: true })}</td>
    </tr>
    <tr>
      <td colspan="6">
        <div class="pagador">
          <strong>Pagador:</strong> ${esc(boleto.pagador_nome)} — ${esc(doc(boleto.pagador_documento))}
          <small>${esc([enderecoPagador, cidadePagador].filter(Boolean).join(' · '))}</small>
        </div>
      </td>
    </tr>
  </table>

  <div class="corte"><span>Corte aqui</span></div>

  ${cabecalho('Ficha de compensação')}
  <table class="ficha">
    <tr>
      <td colspan="4">${campo('Local de pagamento', 'Pagável em qualquer banco, casa lotérica ou aplicativo até o vencimento.')}</td>
      <td colspan="2">${campo('Vencimento', data(boleto.vencimento), { grande: true })}</td>
    </tr>
    <tr>
      <td colspan="4">${campo('Beneficiário', `${conta.beneficiario_nome} — CNPJ ${doc(conta.beneficiario_documento)}`)}</td>
      <td colspan="2">${campo('Agência / Código do beneficiário', `${conta.agencia}${conta.agencia_dv ? `-${conta.agencia_dv}` : ''} / ${conta.conta}${conta.conta_dv ? `-${conta.conta_dv}` : ''}`)}</td>
    </tr>
    <tr>
      <td>${campo('Data do documento', data(boleto.emissao))}</td>
      <td>${campo('Nº do documento', boleto.seu_numero || '—')}</td>
      <td>${campo('Espécie doc.', boleto.especie || 'DM')}</td>
      <td>${campo('Aceite', 'N')}</td>
      <td>${campo('Data processamento', data(hoje))}</td>
      <td>${campo('Nosso número', nn)}</td>
    </tr>
    <tr>
      <td>${campo('Uso do banco', '')}</td>
      <td>${campo('Carteira', conta.carteira)}</td>
      <td>${campo('Espécie', 'R$')}</td>
      <td>${campo('Quantidade', '')}</td>
      <td>${campo('Valor', '')}</td>
      <td>${campo('(=) Valor do documento', `R$ ${brl(boleto.valor_centavos)}`, { grande: true })}</td>
    </tr>
    <tr>
      <td colspan="5" rowspan="4">
        <div class="instrucoes">
          <span class="rot" style="font-size:8.5px;color:#333">Instruções (texto de responsabilidade do beneficiário)</span>
          ${instrucoes.map((i) => `<p>${esc(i)}</p>`).join('')}
        </div>
      </td>
      <td>${campo('(-) Desconto / Abatimento', boleto.desconto_centavos ? `R$ ${brl(boleto.desconto_centavos)}` : '', { grande: true })}</td>
    </tr>
    <tr><td>${campo('(+) Mora / Multa', atual.multa_centavos + atual.juros_centavos ? `R$ ${brl(atual.multa_centavos + atual.juros_centavos)}` : '', { grande: true })}</td></tr>
    <tr><td>${campo('(=) Valor cobrado', `R$ ${brl(atual.valor_centavos)}`, { grande: true })}</td></tr>
    <tr><td>${campo('Autenticação mecânica', '')}</td></tr>
    <tr>
      <td colspan="6">
        <div class="pagador">
          <strong>Pagador:</strong> ${esc(boleto.pagador_nome)} — ${esc(doc(boleto.pagador_documento))}
          <small>${esc([enderecoPagador, cidadePagador].filter(Boolean).join(' · '))}</small>
          <small><strong>Beneficiário final:</strong> ${esc(cliente.razao_social)} — ${esc(doc(cliente.cnpj))}</small>
        </div>
      </td>
    </tr>
  </table>

  ${qr ? `<div class="pix">${qr}<div class="texto"><strong>Bolepix — pague pelo PIX</strong>
      Abra o aplicativo do seu banco, escolha PIX → Ler QR Code e aponte para o código ao lado.
      <div class="emv" id="emv">${esc(boleto.pix_emv)}</div></div></div>` : ''}

  <div class="barras">${barras}</div>
  <div class="rodape">
    <span>Nosso número ${esc(nn)} · ${esc(linha)}</span>
    <span>Emitido por ${esc(conta.beneficiario_nome)} em nome de ${esc(cliente.razao_social)}</span>
  </div>
</div>
<script src="${esc(base)}/js/boleto.js"></script>
</body>
</html>`;
}

module.exports = { fichaCompensacao };
