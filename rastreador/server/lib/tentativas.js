'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const { ErroNegocio } = require('./erros');

/**
 * Trava por conta (CPF, e-mail) depois de várias senhas erradas seguidas, em memória. O limite por IP não basta para senha curta
 * (a do app do motorista tem de 4 a 6 números): quem troca de IP tentaria todas. Aqui a conta descansa um tempo e o acerto zera.
 */
function criarTrava({ maximo = 5, bloqueioMs = 15 * 60_000 } = {}) {
  const contas = new Map(); // chave → { n, ate }
  setInterval(() => {
    const agora = Date.now();
    for (const [k, x] of contas) if ((x.ate || x.ultima + bloqueioMs) < agora) contas.delete(k);
  }, bloqueioMs).unref();
  return {
    /** Lança 429 se a conta está travada. */
    conferir(chave) {
      const x = contas.get(chave);
      if (x?.ate > Date.now()) {
        throw new ErroNegocio(`Muitas senhas erradas. Tente de novo em ${Math.ceil((x.ate - Date.now()) / 60_000)} minuto(s).`, 429);
      }
    },
    falhou(chave) {
      if (contas.size > 50_000) contas.clear(); // teto de memória
      const x = contas.get(chave) ?? { n: 0, ate: 0 };
      x.n += 1; x.ultima = Date.now();
      if (x.n >= maximo) { x.ate = Date.now() + bloqueioMs; x.n = 0; }
      contas.set(chave, x);
    },
    acertou(chave) { contas.delete(chave); },
  };
}

module.exports = { criarTrava };
