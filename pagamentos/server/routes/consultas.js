'use strict';

/*
 * Consulta de CEP e CNPJ para preencher formulário. Serve as duas áreas, com o mesmo limite por usuário —
 * são chamadas a serviço externo (e, no caso da API Brasil, com custo por consulta).
 */
const express = require('express');
const { ErroNegocio } = require('../lib/erros');
const dados = require('../lib/consultaDados');

/** Limite simples por usuário, em memória (janela deslizante). */
function limitarPorUsuario({ janelaMs = 60_000, maximo = 40 } = {}) {
  const acessos = new Map();
  setInterval(() => {
    const corte = Date.now() - janelaMs;
    for (const [k, t] of acessos) if (t.at(-1) < corte) acessos.delete(k);
  }, janelaMs).unref();
  return (req, res, next) => {
    const chave = `${req.usuarioTipo ?? 'equipe'}:${req.usuario?.id ?? req.ip}`;
    const n = Date.now();
    const tempos = (acessos.get(chave) ?? []).filter((t) => t > n - janelaMs);
    tempos.push(n);
    acessos.set(chave, tempos);
    if (tempos.length > maximo) {
      res.set('Retry-After', String(Math.ceil(janelaMs / 1000)));
      return next(new ErroNegocio('Muitas consultas seguidas. Aguarde um instante.', 429));
    }
    next();
  };
}

module.exports = (db) => {
  const r = express.Router();
  r.use(limitarPorUsuario());

  r.get('/cep/:cep', async (req, res) => res.json(await dados.consultarCep(db, req.params.cep)));
  r.get('/cnpj/:cnpj', async (req, res) => res.json(await dados.consultarCnpj(db, req.params.cnpj)));

  return r;
};
