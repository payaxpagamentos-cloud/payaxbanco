'use strict';

const crypto = require('node:crypto');
const { ErroNegocio } = require('./erros');
const { dataValida } = require('./validacao');

/** "1.234,56", "-1234.56", "1234,5" → centavos. */
function valorTexto(s) {
  let t = String(s ?? '').trim().replace(/\s|R\$/g, '');
  if (!t) return NaN;
  const negativo = /^-|-$|^\(.*\)$/.test(t);
  t = t.replace(/[()-]/g, '').replace(/^\+/, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if ((t.match(/\./g) || []).length > 1) t = t.replace(/\./g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  const c = Math.round(Number(t) * 100);
  return negativo ? -c : c;
}

/** "31/01/2026", "2026-01-31" ou "20260131" → '2026-01-31'. */
function dataTexto(s) {
  const t = String(s ?? '').trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
  const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : (m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(t)) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  return iso && dataValida(iso) ? iso : null;
}

/** Identificador estável para linhas sem FITID: repetir a importação do mesmo arquivo não duplica. */
function idSintetico(itens) {
  const vistos = new Map();
  for (const it of itens) {
    if (it.fitid) continue;
    const base = `${it.data}|${it.valor_centavos}|${it.descricao ?? ''}|${it.documento ?? ''}`;
    const n = (vistos.get(base) ?? 0) + 1;
    vistos.set(base, n);
    it.fitid = `h:${crypto.createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 32)}`;
  }
  return itens;
}

/** Lê OFX 1.x (SGML, tags sem fechamento) e 2.x (XML). */
function lerOfx(conteudo) {
  const blocos = String(conteudo).match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi) || [];
  const campo = (bloco, tag) => {
    const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(bloco);
    return m ? m[1].trim() : null;
  };
  const itens = blocos.map((b, i) => {
    const data = dataTexto(campo(b, 'DTPOSTED'));
    const valor = valorTexto(campo(b, 'TRNAMT'));
    if (!data || Number.isNaN(valor)) throw new ErroNegocio(`OFX: transação ${i + 1} sem data ou valor válido.`, 422);
    const memo = campo(b, 'MEMO');
    const nome = campo(b, 'NAME');
    return {
      data,
      valor_centavos: valor,
      descricao: [nome, memo].filter(Boolean).filter((x, k, a) => a.indexOf(x) === k).join(' · ').slice(0, 200) || null,
      documento: campo(b, 'CHECKNUM') || campo(b, 'REFNUM'),
      fitid: campo(b, 'FITID'),
    };
  });
  return idSintetico(itens);
}

/**
 * Lê CSV com as colunas data; descrição; valor [; documento]. Separador ";" (ou "," quando não há ";").
 * Cabeçalho e linhas de saldo sem data são ignorados.
 */
function lerCsv(conteudo) {
  const linhas = String(conteudo).split(/\r?\n/).filter((l) => l.trim());
  const sep = linhas.some((l) => l.includes(';')) ? ';' : ',';
  const itens = [];
  for (const linha of linhas) {
    const col = linha.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    const data = dataTexto(col[0]);
    if (!data) continue;
    const valor = valorTexto(col[2]);
    if (Number.isNaN(valor) || valor === 0) continue;
    itens.push({ data, valor_centavos: valor, descricao: col[1]?.slice(0, 200) || null, documento: col[3] || null, fitid: null });
  }
  return idSintetico(itens);
}

function ler(conteudo, formato) {
  const f = formato || (/<OFX>|OFXHEADER/i.test(conteudo) ? 'ofx' : 'csv');
  const itens = f === 'ofx' ? lerOfx(conteudo) : lerCsv(conteudo);
  if (!itens.length) throw new ErroNegocio('Nenhuma transação encontrada no arquivo.', 422);
  return { formato: f, itens: itens.filter((i) => i.valor_centavos !== 0) };
}

module.exports = { ler, lerOfx, lerCsv, valorTexto, dataTexto };
