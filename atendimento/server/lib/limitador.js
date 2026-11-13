'use strict';

const { ErroNegocio } = require('./erros');

/**
 * Limite simples de requisições por IP em memória (janela deslizante).
 * Para várias instâncias do servidor, troque por um armazenamento compartilhado (ex.: Redis).
 */
function limitar({ janelaMs, maximo, todos = false }) {
  const acessos = new Map();
  setInterval(() => {
    const corte = Date.now() - janelaMs;
    for (const [ip, tempos] of acessos) if (tempos.at(-1) < corte) acessos.delete(ip);
  }, janelaMs).unref();
  return (req, res, next) => {
    // Por padrão só POST (login, formulários). `todos`: qualquer método — para as rotas públicas.
    if (!todos && req.method !== 'POST') return next();
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

/**
 * Registra um acesso recusado sem deixar o registro virar ataque: o mesmo IP com o mesmo motivo
 * grava no máximo uma linha por minuto. Sem isso, um robô tentando chaves faria o banco crescer sem fim.
 */
const ultimas = new Map();
function registrarRecusa(db, ip, motivo, { agoraIso = new Date().toISOString() } = {}) {
  const chave = `${ip}|${motivo}`;
  const agora = Date.now();
  if (agora - (ultimas.get(chave) ?? 0) < 60_000) return false;
  if (ultimas.size > 10_000) ultimas.clear();
  ultimas.set(chave, agora);
  db.prepare('INSERT INTO acessos_recusados (ip, motivo, criado_em) VALUES (?, ?, ?)').run(ip, motivo, agoraIso);
  return true;
}

module.exports = { limitar, registrarRecusa };
