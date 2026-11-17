'use strict';

/** CSV com ; e proteção contra fórmulas (=, +, -, @ no começo da célula viram texto). */
function csv(linhas) {
  const cel = (val) => {
    let t = val === null || val === undefined ? '' : String(val);
    if (typeof val !== 'number' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return `﻿${linhas.map((l) => l.map(cel).join(';')).join('\r\n')}\r\n`;
}

/** Envia o CSV como arquivo. */
function enviarCsv(res, nome, linhas) {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${nome}"`,
    'Cache-Control': 'no-store',
  });
  res.send(csv(linhas));
}

const reais = (centavos) => ((centavos ?? 0) / 100).toFixed(2).replace('.', ',');

module.exports = { csv, enviarCsv, reais };
