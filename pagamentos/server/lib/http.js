'use strict';

const crypto = require('node:crypto');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');

/** Request ID: aceita o do proxy (X-Request-Id) se for seguro, senão gera; volta na resposta e entra na auditoria. */
function requestId(req, res, next) {
  const vindo = req.get('x-request-id');
  req.requestId = vindo && /^[A-Za-z0-9._-]{8,64}$/.test(vindo) ? vindo : crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
}

/**
 * Idempotência dos comandos POST: com o cabeçalho Idempotency-Key, a primeira resposta é guardada e devolvida
 * às repetições do mesmo usuário na mesma rota. É o que impede que um clique duplo emita dois boletos ou
 * peça dois repasses. Repetir a chave em outra rota é conflito.
 */
function idempotencia(db) {
  const ler = db.prepare('SELECT * FROM idempotencia WHERE usuario_chave = ? AND chave = ?');
  const reservar = db.prepare('INSERT OR IGNORE INTO idempotencia (usuario_chave, chave, rota, criado_em) VALUES (?, ?, ?, ?)');
  const gravar = db.prepare('UPDATE idempotencia SET status = ?, corpo = ? WHERE usuario_chave = ? AND chave = ?');
  const soltar = db.prepare('DELETE FROM idempotencia WHERE usuario_chave = ? AND chave = ? AND status IS NULL');
  return (req, res, next) => {
    const chave = req.get('idempotency-key');
    if (req.method !== 'POST' || !chave || !req.usuario) return next();
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(chave)) return next(new ErroNegocio('Idempotency-Key inválida.', 400));
    const rota = `${req.method} ${req.baseUrl}${req.path}`;
    const k = [`${req.usuarioTipo ?? 'equipe'}:${req.usuario.id}`, chave];
    if (reservar.run(...k, rota, agora()).changes === 0) {
      const x = ler.get(...k);
      if (x.rota !== rota) return next(new ErroNegocio('Esta chave de idempotência já foi usada em outra operação.', 409));
      if (x.status === null) return next(new ErroNegocio('A mesma operação ainda está sendo processada.', 409));
      res.set('Idempotent-Replay', 'true');
      return res.status(x.status).type('application/json').send(x.corpo);
    }
    const json = res.json.bind(res);
    res.json = (corpo) => {
      if (res.statusCode < 500) gravar.run(res.statusCode, JSON.stringify(corpo), ...k);
      else soltar.run(...k);
      return json(corpo);
    };
    res.on('finish', () => soltar.run(...k));
    next();
  };
}

/** Paginação: ?pagina=1&por_pagina=50 (máx. 200). */
function paginar(query, { padrao = 50, maximo = 200 } = {}) {
  const pagina = Math.max(1, Number.parseInt(query.pagina, 10) || 1);
  const porPagina = Math.min(maximo, Math.max(1, Number.parseInt(query.por_pagina, 10) || padrao));
  return { pagina, porPagina, offset: (pagina - 1) * porPagina };
}

/** Executa a consulta paginada: sql sem LIMIT; devolve { itens, total, pagina, por_pagina }. */
function listaPaginada(db, sql, params, query, opcoes) {
  const { pagina, porPagina, offset } = paginar(query, opcoes);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params).n;
  const itens = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, porPagina, offset);
  return { itens, total, pagina, por_pagina: porPagina };
}

/** Busca textual segura para LIKE. */
const like = (t) => `%${String(t ?? '').trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Controle de versão otimista: a alteração só vale se a versão enviada for a atual. */
function conferirVersao(atual, enviada) {
  if (enviada === undefined || enviada === null) throw new ErroNegocio('Informe a versão do registro (campo versao).', 428);
  if (Number(enviada) !== atual) throw new ErroNegocio('O registro foi alterado por outra pessoa. Recarregue e tente de novo.', 409);
}

/** CSV com ; e proteção contra fórmulas (=, +, -, @, tab, CR no início da célula viram texto). */
function csv(linhas) {
  const cel = (v) => {
    let t = v === null || v === undefined ? '' : String(v);
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return `﻿${linhas.map((l) => l.map(cel).join(';')).join('\r\n')}\r\n`;
}

module.exports = { requestId, idempotencia, paginar, listaPaginada, like, conferirVersao, csv };
