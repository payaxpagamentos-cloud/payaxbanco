'use strict';

/*
 * O boleto em PDF de verdade (arquivo), com o mesmo conteúdo da ficha em página: é o que o atendimento do
 * cliente anexa numa conversa, o que vai anexado no e-mail e o que fica guardado no sistema de gestão dele.
 *
 * O PDF é sempre montado na hora, com a situação do momento:
 *   - registrado ......... boleto completo (com mora e multa, se já venceu);
 *   - registrando ........ boleto completo, com o aviso de que o banco ainda está registrando;
 *   - liquidado .......... só o aviso "já foi pago" (sem código de barras: ninguém paga duas vezes);
 *   - baixado/cancelado .. só o aviso "não está mais disponível" (sem código de barras).
 * Assim um arquivo ou link antigo nunca leva a um pagamento indevido.
 */
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const codigobarras = require('./codigobarras');
const logoLib = require('./logo');
const { dadosFicha, ROTULO_BENEFICIARIO_FINAL, brl, data, doc: docFmt } = require('./impressao');

const MM = 72 / 25.4;
const MARGEM = 10 * MM;
const LARGURA = 595.28 - 2 * MARGEM;

/** Logo da PAY AX (o do site), como desenho vetorial: a parte branca vira azul-escuro para aparecer no papel. */
const MARCA = (() => {
  try {
    const svg = fs.readFileSync(path.join(__dirname, '../../site/assets/payax-logo.svg'), 'utf8');
    const caixa = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    const pecas = [...svg.matchAll(/<path d="([^"]+)" fill="([^"]+)"( fill-rule="evenodd")?/g)]
      .map((m) => ({ d: m[1], cor: m[2], parImpar: Boolean(m[3]) }));
    return caixa && pecas.length ? { largura: Number(caixa[1]), altura: Number(caixa[2]), pecas } : null;
  } catch { return null; }
})();

function desenharMarca(pdf, x, y, altura) {
  if (!MARCA) return 0;
  const k = altura / MARCA.altura;
  pdf.save().translate(x, y).scale(k);
  for (const p of MARCA.pecas) {
    let cor = p.cor.toLowerCase() === '#ffffff' ? '#0a2540' : p.cor;
    if (cor.startsWith('url(')) cor = pdf.linearGradient(308.3, 100, 458.3, 0).stop(0, '#1784ee').stop(0.6, '#00c8e0').stop(1, '#00c8e0');
    pdf.path(p.d).fill(cor, p.parImpar ? 'even-odd' : 'non-zero');
  }
  pdf.restore();
  return MARCA.largura * k;
}

/** Texto numa linha só, cortado com reticências se não couber. */
function linha(pdf, texto, x, y, largura, { fonte = 'Helvetica', tamanho = 9, alinhar = 'left', cor = '#000' } = {}) {
  pdf.font(fonte).fontSize(tamanho).fillColor(cor)
    .text(String(texto ?? ''), x, y, { width: largura, height: tamanho * 1.15, ellipsis: true, align: alinhar, lineBreak: true });
}

/** Uma casa da ficha: rótulo pequeno em cima, valor embaixo. */
function casa(pdf, x, y, w, h, rotulo, valor, { grande = false, negrito = false } = {}) {
  pdf.lineWidth(0.6).strokeColor('#000').rect(x, y, w, h).stroke();
  linha(pdf, rotulo, x + 3, y + 2.5, w - 6, { tamanho: 6.3, cor: '#333' });
  if (grande) linha(pdf, valor, x + 3, y + h - 13.5, w - 6, { fonte: 'Helvetica-Bold', tamanho: 11, alinhar: 'right' });
  else linha(pdf, valor, x + 3, y + 10.5, w - 6, { fonte: negrito ? 'Helvetica-Bold' : 'Helvetica', tamanho: 8.6 });
}

function cabecalhoBanco(pdf, y, d, titulo) {
  const x = MARGEM;
  pdf.font('Helvetica-Bold').fontSize(15).fillColor('#000').text(d.bancoNome, x, y + 2, { lineBreak: false });
  const fimNome = x + pdf.widthOfString(d.bancoNome) + 7;
  pdf.fontSize(13);
  const larguraCod = pdf.widthOfString(d.bancoCodigo) + 12;
  pdf.lineWidth(1.4).strokeColor('#000').moveTo(fimNome, y).lineTo(fimNome, y + 18).stroke().moveTo(fimNome + larguraCod, y).lineTo(fimNome + larguraCod, y + 18).stroke();
  pdf.text(d.bancoCodigo, fimNome + 6, y + 3.5, { lineBreak: false });
  linha(pdf, d.linha, fimNome + larguraCod + 6, y + 5, MARGEM + LARGURA - (fimNome + larguraCod + 6), { fonte: 'Helvetica-Bold', tamanho: 11, alinhar: 'right' });
  pdf.lineWidth(1.4).moveTo(x, y + 19).lineTo(x + LARGURA, y + 19).stroke();
  linha(pdf, titulo, x, y + 21.5, LARGURA, { tamanho: 7, cor: '#444', alinhar: 'right' });
  return y + 31;
}

function blocoPagador(pdf, x, y, w, h, boleto, d, comBeneficiarioFinal) {
  pdf.lineWidth(0.6).rect(x, y, w, h).stroke();
  pdf.font('Helvetica-Bold').fontSize(8.6).fillColor('#000').text('Pagador: ', x + 3, y + 3.5, { continued: true, lineBreak: false })
    .font('Helvetica').text(`${boleto.pagador_nome} — ${docFmt(boleto.pagador_documento)}`, { lineBreak: false });
  linha(pdf, [d.enderecoPagador, d.cidadePagador].filter(Boolean).join(' · '), x + 3, y + 14.5, w - 6, { tamanho: 7.4, cor: '#333' });
  if (comBeneficiarioFinal) {
    pdf.lineWidth(0.6).moveTo(x, y + 26).lineTo(x + w, y + 26).stroke();
    linha(pdf, ROTULO_BENEFICIARIO_FINAL, x + 3, y + 28.5, w - 6, { tamanho: 6.3, cor: '#333' });
    linha(pdf, d.beneficiarioFinal, x + 3, y + 36, w - 6, { fonte: 'Helvetica-Bold', tamanho: 8.8 });
  }
}

/** Quadro do topo: quem cobra (o cliente), de quem, quanto e quando. Devolve o y logo abaixo. */
function quadroCobrador(pdf, y, { boleto, cliente }, d, { semValores = false } = {}) {
  const x = MARGEM;
  const logo = logoLib.paraFicha(cliente.logo);
  let alturaLogo = 0;
  let imagem = null;
  if (logo) {
    try { imagem = Buffer.from(logo.slice(logo.indexOf(',') + 1), 'base64'); alturaLogo = 40; } catch { imagem = null; }
  }
  const h = 62 + alturaLogo;
  const larguraQuanto = semValores ? 0 : 132;
  pdf.lineWidth(1.5).strokeColor('#000').roundedRect(x, y, LARGURA, h, 3).stroke();
  let yy = y + 8;
  if (imagem) {
    try { pdf.image(imagem, x + 10, yy, { fit: [170, 36], align: 'left', valign: 'center' }); } catch { /* imagem que o PDF não lê: segue sem logo */ }
    yy += alturaLogo;
  }
  const w = LARGURA - 20 - larguraQuanto;
  linha(pdf, 'COBRANÇA DE', x + 10, yy, w, { tamanho: 6.5, cor: '#333' });
  linha(pdf, d.bfFantasia, x + 10, yy + 8, w, { fonte: 'Helvetica-Bold', tamanho: 16 });
  linha(pdf, `${d.bfNome} · CNPJ ${d.bfDoc}`, x + 10, yy + 27, w, { tamanho: 8.5, cor: '#222' });
  pdf.font('Helvetica-Bold').fontSize(8.5).fillColor('#000').text('Para: ', x + 10, yy + 39, { continued: true, lineBreak: false })
    .font('Helvetica').text(`${boleto.pagador_nome} — ${docFmt(boleto.pagador_documento)}`, { lineBreak: false });
  if (!semValores) {
    const xq = x + LARGURA - larguraQuanto;
    pdf.lineWidth(0.6).moveTo(xq, y + 8).lineTo(xq, y + h - 8).stroke();
    const meio = y + h / 2;
    linha(pdf, 'VALOR', xq, meio - 27, larguraQuanto - 10, { tamanho: 6.5, cor: '#333', alinhar: 'right' });
    linha(pdf, `R$ ${brl(d.atual.valor_centavos)}`, xq, meio - 19, larguraQuanto - 10, { fonte: 'Helvetica-Bold', tamanho: 13, alinhar: 'right' });
    linha(pdf, 'VENCIMENTO', xq, meio + 2, larguraQuanto - 10, { tamanho: 6.5, cor: '#333', alinhar: 'right' });
    linha(pdf, data(boleto.vencimento), xq, meio + 10, larguraQuanto - 10, { fonte: 'Helvetica-Bold', tamanho: 13, alinhar: 'right' });
  }
  return y + h;
}

function faixa(pdf, y, texto, { fundo = '#fff4d6', borda = '#e0b100', cor = '#5c4400' } = {}) {
  pdf.font('Helvetica-Bold').fontSize(9);
  const h = pdf.heightOfString(texto, { width: LARGURA - 16 }) + 10;
  pdf.lineWidth(0.8).roundedRect(MARGEM, y, LARGURA, h, 3).fillAndStroke(fundo, borda);
  pdf.fillColor(cor).text(texto, MARGEM + 8, y + 5.5, { width: LARGURA - 16 });
  pdf.strokeColor('#000').fillColor('#000');
  return y + h + 8;
}

/**
 * @returns {Promise<Buffer>} o PDF pronto.
 */
async function gerar({ boleto, conta, cliente, hoje }) {
  const d = dadosFicha({ boleto, conta, cliente, hoje });
  const pdf = new PDFDocument({
    size: 'A4', margin: MARGEM, autoFirstPage: true, compress: true,
    info: { Title: `Boleto ${d.nn} — ${boleto.pagador_nome}`, Author: conta.beneficiario_nome, Subject: `Cobrança de ${d.bfNome}`, Producer: 'PAY AX', Creator: 'PAY AX' },
  });
  const partes = [];
  pdf.on('data', (c) => partes.push(c));
  const pronto = new Promise((resolve, reject) => { pdf.on('end', () => resolve(Buffer.concat(partes))); pdf.on('error', reject); });

  const x = MARGEM;
  let y = MARGEM;

  // Topo: a marca de quem processa.
  desenharMarca(pdf, x, y, 15.5);
  linha(pdf, `Cobrança processada pela ${conta.beneficiario_nome}`, x, y + 5, LARGURA, { tamanho: 7, cor: '#333', alinhar: 'right' });
  y += 24;

  const pago = boleto.situacao === 'liquidado';
  const indisponivel = ['baixado', 'cancelado', 'falha'].includes(boleto.situacao);

  if (pago || indisponivel) {
    y = quadroCobrador(pdf, y, { boleto, cliente }, d, { semValores: true }) + 14;
    y = pago
      ? faixa(pdf, y, `Este boleto já foi pago${boleto.pago_em ? ` em ${data(boleto.pago_em)}` : ''}. Não é preciso pagar de novo.`, { fundo: '#e7f6ec', borda: '#2e8b57', cor: '#14532d' })
      : faixa(pdf, y, `Este boleto não está mais disponível para pagamento. Não pague. Em caso de dúvida, fale com ${d.bfFantasia}.`, { fundo: '#fdecec', borda: '#c62828', cor: '#7f1d1d' });
    pdf.font('Helvetica').fontSize(9).fillColor('#222')
      .text(`Nosso número ${d.nn} · Nº do documento ${boleto.seu_numero || '—'} · Valor do documento R$ ${brl(boleto.valor_centavos)} · Vencimento ${data(boleto.vencimento)}`, x, y, { width: LARGURA });
    pdf.end();
    return pronto;
  }

  if (d.teste) y = faixa(pdf, y, 'Boleto de teste, gerado no simulador. Não está registrado em banco nenhum e não pode ser pago.');
  else if (boleto.situacao === 'registrando') y = faixa(pdf, y, 'Boleto em registro no banco. O pagamento é aceito depois da confirmação do banco, o que pode levar até 1 dia útil.');

  y = quadroCobrador(pdf, y, { boleto, cliente }, d) + 6;
  pdf.font('Helvetica').fontSize(7.2).fillColor('#333')
    .text(`Pagamento processado por ${conta.beneficiario_nome} (CNPJ ${docFmt(conta.beneficiario_documento)}). É esse o nome que o aplicativo do seu banco mostra como beneficiário: a ${conta.beneficiario_nome} recebe em nome de ${d.bfFantasia}.`, x, y, { width: LARGURA });
  y = pdf.y + 8;

  const c6 = LARGURA / 6;
  const h = 24;

  // ---- Recibo do pagador
  y = cabecalhoBanco(pdf, y, d, 'Recibo do pagador');
  casa(pdf, x, y, c6 * 4, h, ROTULO_BENEFICIARIO_FINAL, d.beneficiarioFinal, { negrito: true });
  casa(pdf, x + c6 * 4, y, c6 * 2, h, 'Vencimento', data(boleto.vencimento));
  y += h;
  casa(pdf, x, y, c6 * 4, h, 'Beneficiário', d.beneficiario);
  casa(pdf, x + c6 * 4, y, c6 * 2, h, 'Agência / Código do beneficiário', d.codigoBeneficiario);
  y += h;
  casa(pdf, x, y, c6 * 2, h, 'Nosso número', d.nn);
  casa(pdf, x + c6 * 2, y, c6 * 2, h, 'Nº do documento', boleto.seu_numero || '—');
  casa(pdf, x + c6 * 4, y, c6 * 2, h, 'Valor do documento', `R$ ${brl(boleto.valor_centavos)}`, { grande: true });
  y += h;
  blocoPagador(pdf, x, y, LARGURA, 26, boleto, d, false);
  y += 26 + 13;

  // ---- Corte
  pdf.lineWidth(0.6).strokeColor('#666').dash(3, { space: 3 }).moveTo(x, y).lineTo(x + LARGURA, y).stroke().undash().strokeColor('#000');
  pdf.rect(x, y - 5, 40, 9).fill('#fff');
  linha(pdf, 'Corte aqui', x, y - 3.5, 40, { tamanho: 6.5, cor: '#666' });
  y += 11;

  // ---- Ficha de compensação
  y = cabecalhoBanco(pdf, y, d, 'Ficha de compensação');
  casa(pdf, x, y, c6 * 4, h, 'Local de pagamento', 'Pagável em qualquer banco, casa lotérica ou aplicativo até o vencimento.');
  casa(pdf, x + c6 * 4, y, c6 * 2, h, 'Vencimento', data(boleto.vencimento), { grande: true });
  y += h;
  casa(pdf, x, y, c6 * 4, h, 'Beneficiário', d.beneficiario);
  casa(pdf, x + c6 * 4, y, c6 * 2, h, 'Agência / Código do beneficiário', d.codigoBeneficiario);
  y += h;
  [['Data do documento', data(boleto.emissao)], ['Nº do documento', boleto.seu_numero || '—'], ['Espécie doc.', boleto.especie || 'DS'],
    ['Aceite', 'N'], ['Data processamento', data(hoje)], ['Nosso número', d.nn]]
    .forEach(([r, v], i) => casa(pdf, x + c6 * i, y, c6, h, r, v));
  y += h;
  [['Uso do banco', ''], ['Carteira', conta.carteira], ['Espécie', 'R$'], ['Quantidade', ''], ['Valor', '']]
    .forEach(([r, v], i) => casa(pdf, x + c6 * i, y, c6, h, r, v));
  casa(pdf, x + c6 * 5, y, c6, h, '(=) Valor do documento', `R$ ${brl(boleto.valor_centavos)}`, { grande: true });
  y += h;
  // Instruções (à esquerda, 4 linhas de altura) e os valores (à direita).
  pdf.lineWidth(0.6).rect(x, y, c6 * 5, h * 4).stroke();
  linha(pdf, 'Instruções (texto de responsabilidade do beneficiário)', x + 3, y + 2.5, c6 * 5 - 6, { tamanho: 6.3, cor: '#333' });
  pdf.font('Helvetica').fontSize(8.6).fillColor('#000')
    .text(d.instrucoes.join('\n'), x + 3, y + 12, { width: c6 * 5 - 6, height: h * 4 - 15, ellipsis: true, lineGap: 1.5 });
  const mora = d.atual.multa_centavos + d.atual.juros_centavos;
  casa(pdf, x + c6 * 5, y, c6, h, '(-) Desconto / Abatimento', boleto.desconto_centavos ? `R$ ${brl(boleto.desconto_centavos)}` : '', { grande: true });
  casa(pdf, x + c6 * 5, y + h, c6, h, '(+) Mora / Multa', mora ? `R$ ${brl(mora)}` : '', { grande: true });
  casa(pdf, x + c6 * 5, y + h * 2, c6, h, '(=) Valor cobrado', `R$ ${brl(d.atual.valor_centavos)}`, { grande: true });
  casa(pdf, x + c6 * 5, y + h * 3, c6, h, 'Autenticação mecânica', '');
  y += h * 4;
  blocoPagador(pdf, x, y, LARGURA, 48, boleto, d, true);
  y += 48 + 8;

  // ---- Bolepix: QR Code e o código copia e cola
  if (boleto.pix_emv) {
    const lado = 74;
    pdf.lineWidth(0.6).rect(x, y, LARGURA, lado + 12).stroke();
    const qr = QRCode.create(boleto.pix_emv, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const m = lado / n;
    pdf.fillColor('#000');
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (qr.modules.data[i * n + j]) pdf.rect(x + 6 + j * m, y + 6 + i * m, m + 0.05, m + 0.05).fill();
    const xt = x + lado + 16;
    linha(pdf, 'Bolepix — pague pelo PIX', xt, y + 8, LARGURA - lado - 22, { fonte: 'Helvetica-Bold', tamanho: 9.5 });
    pdf.font('Helvetica').fontSize(7.8).fillColor('#000')
      .text('Abra o aplicativo do seu banco, escolha PIX, depois Ler QR Code, e aponte para o código ao lado. Ou copie o código abaixo (PIX copia e cola):', xt, y + 21, { width: LARGURA - lado - 22 });
    pdf.font('Courier').fontSize(6.2).fillColor('#333')
      .text(boleto.pix_emv, xt, pdf.y + 3, { width: LARGURA - lado - 22, height: y + lado + 8 - pdf.y - 3, ellipsis: true });
    y += lado + 12 + 8;
  }

  // ---- Código de barras (padrão FEBRABAN: 103 mm de largura por 13 mm de altura)
  if (boleto.codigo_barras) {
    const w = codigobarras.larguras(boleto.codigo_barras);
    const total = w.reduce((s, v) => s + v, 0);
    const modulo = (103 * MM) / total;
    let xb = x;
    pdf.fillColor('#000');
    w.forEach((larg, i) => { if (i % 2 === 0) pdf.rect(xb, y, larg * modulo, 13 * MM).fill(); xb += larg * modulo; });
    y += 13 * MM + 7;
  }

  // ---- Rodapé
  pdf.font('Helvetica').fontSize(6.5).fillColor('#555')
    .text(`Nosso número ${d.nn} · ${d.linha}`, x, y, { width: LARGURA })
    .text(`Cobrança de ${d.bfNome}, processada por ${conta.beneficiario_nome}.`, x, pdf.y + 1, { width: LARGURA });

  // ---- Marca-d'água do boleto de teste
  if (d.teste) {
    pdf.save().fillOpacity(0.13).fillColor('#cc092f').font('Helvetica-Bold').fontSize(46)
      .rotate(-28, { origin: [297, 430] }).text('TESTE · NÃO PAGUE', 60, 405, { width: 480, align: 'center', lineBreak: false }).restore();
  }

  pdf.end();
  return pronto;
}

/** Nome do arquivo para baixar ou anexar. */
const nomeArquivo = (boleto) => `boleto-${String(boleto.seu_numero || boleto.nosso_numero).replace(/[^\w.-]+/g, '-').slice(0, 40)}-venc-${String(boleto.vencimento).slice(0, 10)}.pdf`;

module.exports = { gerar, nomeArquivo };
