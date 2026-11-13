'use strict';

const { ErroNegocio } = require('./erros');

/**
 * Limite simples de requisições por IP em memória (janela deslizante).
 * Para várias instâncias do servidor, troque por um armazenamento compartilhado (ex.: Redis).
 */
function limitar({ janelaMs, maximo }) {
  const acessos = new Map();
  setInterval(() => {
    const corte = Date.now() - janelaMs;
    for (const [ip, tempos] of acessos) if (tempos.at(-1) < corte) acessos.delete(ip);
  }, janelaMs).unref();
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const agora = Date.now();
    const tempos = (acessos.get(req.ip) ?? []).filter((t) => t > agora - janelaMs);
    tempos.push(agora);
    acessos.set(req.ip, tempos);
    if (tempos.length > maximo) {
      res.set('Retry-After', String(Math.ceil(janelaMs / 1000)));
      return next(new ErroNegocio('Muitas tentativas. Aguarde um minuto e tente novamente.', 429));
    }
    next();
  };
}

module.exports = { limitar };
