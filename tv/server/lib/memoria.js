'use strict';

/**
 * Memória curta para respostas que são iguais para muita gente ao mesmo tempo.
 *
 * O banco (SQLite, em modo síncrono) atende UM pedido por vez: enquanto uma consulta roda,
 * todo o resto espera — inclusive os pedaços de vídeo dos canais no ar. Então o que pesa não é
 * só a consulta lenta; é a consulta de 25 ms repetida por milhares de aparelhos, cada um
 * refazendo um trabalho cujo resultado é idêntico ao do vizinho. A lista de canais com o que
 * está no ar, por exemplo, só muda de um assinante para outro pela faixa etária do perfil.
 *
 * Aqui o resultado é calculado uma vez e reaproveitado por alguns segundos. O preço é o
 * resultado poder estar esse tanto atrasado, e por isso cada uso escolhe a validade conforme
 * o que guarda — e nada que dependa de quem está pedindo (plano, bloqueio, sessão) entra aqui:
 * isso é aplicado por cima, a cada pedido.
 */
function criarMemoria({ validadeMs, maximo = 200 }) {
  const itens = new Map();   // chave -> { valor, ate }
  return {
    /** Devolve o que está guardado ou calcula, guarda e devolve. */
    obter(chave, calcular) {
      const agora = Date.now();
      const tem = itens.get(chave);
      if (tem && tem.ate > agora) return tem.valor;
      const valor = calcular();
      itens.set(chave, { valor, ate: agora + validadeMs });
      // Chave demais é sinal de que algo variável entrou na chave: melhor esvaziar do que crescer.
      if (itens.size > maximo) for (const [k, x] of itens) if (x.ate <= agora || itens.size > maximo) itens.delete(k);
      return valor;
    },
    limpar() { itens.clear(); },
    get tamanho() { return itens.size; },
  };
}

/**
 * Uma memória por banco de dados.
 *
 * A chave de cada item diz O QUE foi pedido, não DE ONDE veio. Com um banco só (produção) dá
 * no mesmo; mas os testes abrem um banco por caso, e uma memória global entregaria ao segundo
 * teste os canais do primeiro. Amarrar ao objeto do banco resolve sem pôr nada na chave — e a
 * memória some sozinha quando o banco é descartado.
 */
function memoriaPorBanco(opcoes) {
  const porBanco = new WeakMap();
  return (db) => {
    let m = porBanco.get(db);
    if (!m) porBanco.set(db, m = criarMemoria(opcoes));
    return m;
  };
}

module.exports = { criarMemoria, memoriaPorBanco };
