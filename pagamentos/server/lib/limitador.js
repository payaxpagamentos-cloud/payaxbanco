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
    // Acima do limite não guarda mais tentativas (a lista não cresce sem fim) e a memória tem teto.
    if (tempos.length <= maximo) tempos.push(agora);
    if (!acessos.has(req.ip) && acessos.size >= 50_000) acessos.clear();
    acessos.set(req.ip, tempos);
    if (tempos.length > maximo) {
      res.set('Retry-After', String(Math.ceil(janelaMs / 1000)));
      const minutos = Math.max(1, Math.ceil((tempos[0] + janelaMs - agora) / 60_000));
      return next(new ErroNegocio(`Muitas tentativas. Aguarde ${minutos === 1 ? 'um minuto' : `${minutos} minutos`} e tente novamente.`, 429));
    }
    next();
  };
}

module.exports = { limitar };
