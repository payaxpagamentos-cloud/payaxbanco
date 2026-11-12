'use strict';

/** CSV com ; e proteção contra fórmulas (=, +, -, @, tab, CR no início da célula viram texto). */
function csv(linhas) {
  const cel = (v) => {
    let t = v === null || v === undefined ? '' : String(v);
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return `﻿${linhas.map((l) => l.map(cel).join(';')).join('\r\n')}\r\n`;
}

/** Envia o CSV como arquivo para download. */
function enviarCsv(res, nome, linhas) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${nome}"`);
  res.send(csv(linhas));
}

/** Reais com vírgula, do jeito que a planilha brasileira espera. */
const reais = (c) => ((c ?? 0) / 100).toFixed(2).replace('.', ',');

module.exports = { csv, enviarCsv, reais };
