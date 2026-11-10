'use strict';

/*
 * Gerador de PDF mínimo (A4, Helvetica, texto em WinAnsi/cp1252 com os acentos do português), sem dependências.
 * Coordenadas a partir do canto superior esquerdo, em pontos (A4 = 595 × 842).
 */

const LARGURA = 595;
const ALTURA = 842;

// Caracteres do cp1252 fora do Latin-1.
const CP1252 = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
  '→': 0x3e, '≥': 0x3e, '≤': 0x3c, '×': 0xd7 };

function codificar(t) {
  const out = [];
  for (const ch of String(t ?? '').normalize('NFC')) {
    const c = ch.codePointAt(0);
    let b = CP1252[ch] ?? (c < 256 ? c : 0x3f);
    if (c >= 0x80 && c < 0xa0) b = 0x3f;
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  return Buffer.from(out).toString('latin1');
}

/** Largura aproximada do texto em Helvetica (média por tipo de caractere), para cortar e alinhar. */
function largura(t, tam) {
  let w = 0;
  for (const ch of String(t ?? '')) w += /[il.,:;'|!]/.test(ch) ? 0.28 : /[mwMW@]/.test(ch) ? 0.85 : /[A-Z0-9]/.test(ch) ? 0.64 : /\s/.test(ch) ? 0.28 : 0.52;
  return w * tam;
}

const cor = (c) => c.map((x) => (x / 255).toFixed(3)).join(' ');

class Pdf {
  constructor() {
    this.paginas = [];
    this.novaPagina();
  }

  novaPagina() {
    this.atual = [];
    this.paginas.push(this.atual);
    return this;
  }

  texto(x, y, t, { tam = 10, negrito = false, rgb = [28, 43, 36], max = null, direita = false } = {}) {
    let s = String(t ?? '');
    if (max) while (s.length > 1 && largura(s, tam) > max) s = `${s.slice(0, -2)}…`;
    const px = direita ? x - largura(s, tam) : x;
    this.atual.push(`BT /${negrito ? 'F2' : 'F1'} ${tam} Tf ${cor(rgb)} rg ${px.toFixed(2)} ${(ALTURA - y).toFixed(2)} Td (${codificar(s)}) Tj ET`);
    return this;
  }

  linha(x1, y1, x2, y2, { rgb = [213, 220, 210], larg = 0.8 } = {}) {
    this.atual.push(`${cor(rgb)} RG ${larg} w ${x1} ${ALTURA - y1} m ${x2} ${ALTURA - y2} l S`);
    return this;
  }

  retangulo(x, y, w, h, { preencher = null, borda = null } = {}) {
    const op = preencher && borda ? 'B' : preencher ? 'f' : 'S';
    this.atual.push(`${preencher ? `${cor(preencher)} rg ` : ''}${borda ? `${cor(borda)} RG 0.8 w ` : ''}${x} ${ALTURA - y - h} ${w} ${h} re ${op}`);
    return this;
  }

  polilinha(pontos, { rgb = [25, 114, 78], larg = 1.4 } = {}) {
    if (pontos.length < 2) return this;
    const [p0, ...resto] = pontos;
    this.atual.push(`${cor(rgb)} RG ${larg} w 1 j ${p0[0].toFixed(2)} ${(ALTURA - p0[1]).toFixed(2)} m ${resto.map(([x, y]) => `${x.toFixed(2)} ${(ALTURA - y).toFixed(2)} l`).join(' ')} S`);
    return this;
  }

  gerar() {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(''); // Pages, preenchido depois
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const p of this.paginas) {
      const conteudo = p.join('\n');
      const c = add(`<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${LARGURA} ${ALTURA}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    let saida = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(Buffer.byteLength(saida, 'latin1'));
      saida += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(saida, 'latin1');
    saida += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    saida += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(saida, 'latin1');
  }
}

module.exports = { Pdf, LARGURA, ALTURA, largura };
