'use strict';

/*
 * Gerador de QR Code (ISO/IEC 18004), modo byte, correção de erro nível M.
 *
 * Por que existe: o DANFE-Com é obrigado a trazer o QR Code da consulta pública, e o portal do assinante
 * ganha o QR do PIX — hoje ele só oferece copiar e colar, o que no celular é pior do que apontar a câmera.
 * Nenhuma das duas coisas justifica trazer uma dependência para um projeto que não tem nenhuma.
 *
 * O que está implementado, na ordem em que a norma manda fazer:
 *   1. codificação em modo byte, com o indicador de tamanho e o enchimento padrão;
 *   2. correção de erro Reed-Solomon sobre GF(256), por bloco;
 *   3. intercalação dos blocos de dados e de correção;
 *   4. desenho da matriz: padrões de busca, separadores, sincronismo, alinhamento e módulo escuro;
 *   5. as oito máscaras, com a pontuação de penalidade da norma — vence a de menor penalidade.
 *
 * Correção não é opinião: um erro em qualquer tabela daqui produz um código que simplesmente não lê. Por
 * isso os testes não conferem a matriz byte a byte — eles mandam um leitor de QR de verdade ler a imagem
 * gerada e comparar com o texto original.
 */

/* Correção Reed-Solomon por versão, nível M: [códigos de correção por bloco, blocos+dados do grupo 1, blocos+dados do grupo 2]. */
const BLOCOS_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
  11: [30, 1, 50, 4, 51],
  12: [22, 6, 36, 2, 37],
  13: [22, 8, 37, 1, 38],
  14: [24, 4, 40, 5, 41],
  15: [24, 5, 41, 5, 42],
  16: [28, 7, 45, 3, 46],
  17: [28, 10, 46, 1, 47],
  18: [26, 9, 43, 4, 44],
  19: [26, 3, 44, 11, 45],
  20: [26, 3, 41, 13, 42],
};

/* Centros dos padrões de alinhamento, por versão. */
const ALINHAMENTO = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54],
  12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
  16: [6, 26, 50, 74], 17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
};

/* ---------------- Campo de Galois GF(256) ---------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = v;
    LOG[v] = i;
    v <<= 1;
    if (v & 0x100) v ^= 0x11d; // polinômio gerador do QR
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/* ---------------- BCH ---------------- */

/** Quantos bits tem o número (grau do polinômio mais um). */
const grauDe = (n) => {
  let d = 0;
  let v = n;
  while (v !== 0) { d++; v >>>= 1; }
  return d;
};

/**
 * Resto da divisão polinomial sobre GF(2) — é o que protege os bits de formato e de versão.
 *
 * Divisão de verdade: enquanto o dividendo tiver grau igual ou maior que o do gerador, soma-se (XOR) o
 * gerador deslocado para alinhar os bits mais altos, o que DERRUBA o grau a cada volta. Um laço que
 * desloca o dividendo para a esquerda faz o contrário: cresce para sempre e devolve lixo — e o lixo
 * aqui dá um QR que nenhum leitor enxerga, sem erro nenhum pelo caminho.
 */
function bch(valor, gerador) {
  let d = valor;
  const grauGerador = grauDe(gerador);
  while (grauDe(d) >= grauGerador) d ^= gerador << (grauDe(d) - grauGerador);
  return d;
}

/** Polinômio gerador de grau `grau`, para a correção de erro. */
function gerador(grau) {
  let p = [1];
  for (let i = 0; i < grau; i++) {
    const novo = new Array(p.length + 1).fill(0);
    for (let j = 0; j < p.length; j++) {
      novo[j] ^= mul(p[j], 1);
      novo[j + 1] ^= mul(p[j], EXP[i]);
    }
    p = novo;
  }
  return p;
}

/** Códigos de correção de um bloco de dados. */
function correcao(dados, quantidade) {
  const g = gerador(quantidade);
  const resto = new Array(dados.length + quantidade).fill(0);
  for (let i = 0; i < dados.length; i++) resto[i] = dados[i];
  for (let i = 0; i < dados.length; i++) {
    const fator = resto[i];
    if (fator === 0) continue;
    for (let j = 0; j < g.length; j++) resto[i + j] ^= mul(g[j], fator);
  }
  return resto.slice(dados.length);
}

/* ---------------- Codificação ---------------- */

/** Quantos bytes de dados cabem numa versão. */
const capacidade = (versao) => {
  const [, b1, d1, b2, d2] = BLOCOS_M[versao];
  return b1 * d1 + b2 * d2;
};

/** A menor versão que comporta o texto. */
function escolherVersao(bytes) {
  for (const versao of Object.keys(BLOCOS_M).map(Number).sort((a, b) => a - b)) {
    const bitsTamanho = versao < 10 ? 8 : 16;
    const necessario = Math.ceil((4 + bitsTamanho + bytes.length * 8) / 8);
    if (necessario <= capacidade(versao)) return versao;
  }
  throw new Error(`Texto longo demais para um QR Code deste gerador (${bytes.length} bytes).`);
}

/** Monta a sequência de códigos: dados + correção, já intercalados. */
function codificar(bytes, versao) {
  const bitsTamanho = versao < 10 ? 8 : 16;
  const bits = [];
  const push = (valor, n) => { for (let i = n - 1; i >= 0; i--) bits.push((valor >> i) & 1); };
  push(0b0100, 4);              // modo byte
  push(bytes.length, bitsTamanho);
  for (const b of bytes) push(b, 8);

  const total = capacidade(versao) * 8;
  for (let i = 0; i < 4 && bits.length < total; i++) bits.push(0);   // terminador
  while (bits.length % 8) bits.push(0);

  const codigos = [];
  for (let i = 0; i < bits.length; i += 8) {
    codigos.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  }
  // Enchimento alternado, como a norma define.
  const ENCHIMENTO = [0xec, 0x11];
  for (let i = 0; codigos.length < capacidade(versao); i++) codigos.push(ENCHIMENTO[i % 2]);

  const [ecPorBloco, b1, d1, b2, d2] = BLOCOS_M[versao];
  const blocos = [];
  let pos = 0;
  for (let i = 0; i < b1; i++) { blocos.push(codigos.slice(pos, pos + d1)); pos += d1; }
  for (let i = 0; i < b2; i++) { blocos.push(codigos.slice(pos, pos + d2)); pos += d2; }
  const ecs = blocos.map((b) => correcao(b, ecPorBloco));

  // Intercalação: um código de cada bloco por vez, dados primeiro, correção depois.
  const saida = [];
  const maiorDados = Math.max(...blocos.map((b) => b.length));
  for (let i = 0; i < maiorDados; i++) for (const b of blocos) if (i < b.length) saida.push(b[i]);
  for (let i = 0; i < ecPorBloco; i++) for (const e of ecs) saida.push(e[i]);
  return saida;
}

/* ---------------- Matriz ---------------- */

const LIVRE = -1;

function novaMatriz(versao) {
  const tamanho = versao * 4 + 17;
  const m = Array.from({ length: tamanho }, () => new Array(tamanho).fill(LIVRE));
  const reservado = Array.from({ length: tamanho }, () => new Array(tamanho).fill(false));

  const por = (x, y, valor) => { if (x >= 0 && y >= 0 && x < tamanho && y < tamanho) { m[y][x] = valor; reservado[y][x] = true; } };

  /* Padrões de busca, com o separador branco em volta. */
  const busca = (cx, cy) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const dentro = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const anel = dentro && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
        const miolo = dentro && dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        por(cx + dx, cy + dy, anel || miolo ? 1 : 0);
      }
    }
  };
  busca(0, 0);
  busca(tamanho - 7, 0);
  busca(0, tamanho - 7);

  /* Sincronismo. */
  for (let i = 8; i < tamanho - 8; i++) {
    por(i, 6, i % 2 === 0 ? 1 : 0);
    por(6, i, i % 2 === 0 ? 1 : 0);
  }

  /* Alinhamento, exceto onde bateria nos padrões de busca. */
  const centros = ALINHAMENTO[versao];
  for (const cy of centros) {
    for (const cx of centros) {
      const perto = (x, y) => (x < 8 && y < 8) || (x > tamanho - 9 && y < 8) || (x < 8 && y > tamanho - 9);
      if (perto(cx, cy)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const borda = Math.abs(dx) === 2 || Math.abs(dy) === 2;
          por(cx + dx, cy + dy, borda || (dx === 0 && dy === 0) ? 1 : 0);
        }
      }
    }
  }

  /*
   * Área do formato: reservada aqui, preenchida depois de escolhida a máscara.
   * A cópia horizontal ocupa 8 módulos (m[8][tamanho-1] a m[8][tamanho-8]); a vertical, 7
   * (m[tamanho-1][8] a m[tamanho-7][8]). O que sobra entre elas, em m[tamanho-8][8], é o MÓDULO ESCURO,
   * que a norma exige sempre aceso — por isso ele é escrito por último, depois das reservas.
   */
  for (let i = 0; i < 9; i++) { if (m[8][i] === LIVRE) por(i, 8, 0); if (m[i][8] === LIVRE) por(8, i, 0); }
  for (let i = 0; i < 8; i++) por(tamanho - 1 - i, 8, 0);
  for (let i = 0; i < 7; i++) por(8, tamanho - 1 - i, 0);
  por(8, tamanho - 8, 1);

  /* Informação de versão, da 7 em diante. */
  if (versao >= 7) {
    const info = ((versao << 12) | bch(versao << 12, 0x1f25)) >>> 0;
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1;
      por(Math.floor(i / 3), tamanho - 11 + (i % 3), bit);
      por(tamanho - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }

  return { m, reservado, tamanho };
}

/** Escreve os códigos no caminho em zigue-zague, de baixo para cima e da direita para a esquerda. */
function preencher({ m, reservado, tamanho }, codigos) {
  const bits = [];
  for (const c of codigos) for (let i = 7; i >= 0; i--) bits.push((c >> i) & 1);
  let i = 0;
  let subindo = true;
  for (let colunaDireita = tamanho - 1; colunaDireita > 0; colunaDireita -= 2) {
    if (colunaDireita === 6) colunaDireita = 5; // a coluna de sincronismo é pulada
    for (let passo = 0; passo < tamanho; passo++) {
      const y = subindo ? tamanho - 1 - passo : passo;
      for (const x of [colunaDireita, colunaDireita - 1]) {
        if (reservado[y][x]) continue;
        m[y][x] = i < bits.length ? bits[i] : 0;
        i++;
      }
    }
    subindo = !subindo;
  }
}

const MASCARAS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Penalidade da norma: quanto menor, melhor o código se lê. */
function penalidade(m, tamanho) {
  let total = 0;
  // Regra 1: sequências de cinco ou mais módulos iguais.
  const corrida = (pegar) => {
    for (let a = 0; a < tamanho; a++) {
      let contagem = 1;
      for (let b = 1; b < tamanho; b++) {
        if (pegar(a, b) === pegar(a, b - 1)) { contagem++; } else { if (contagem >= 5) total += contagem - 2; contagem = 1; }
      }
      if (contagem >= 5) total += contagem - 2;
    }
  };
  corrida((y, x) => m[y][x]);
  corrida((x, y) => m[y][x]);

  // Regra 2: blocos 2x2 da mesma cor.
  for (let y = 0; y < tamanho - 1; y++) {
    for (let x = 0; x < tamanho - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) total += 3;
    }
  }

  // Regra 3: o padrão que imita um padrão de busca.
  const alvo = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const invertido = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const bate = (pegar, a, b, p) => p.every((v, k) => pegar(a, b + k) === v);
  for (let a = 0; a < tamanho; a++) {
    for (let b = 0; b + 11 <= tamanho; b++) {
      if (bate((y, x) => m[y][x], a, b, alvo) || bate((y, x) => m[y][x], a, b, invertido)) total += 40;
      if (bate((x, y) => m[y][x], a, b, alvo) || bate((x, y) => m[y][x], a, b, invertido)) total += 40;
    }
  }

  // Regra 4: desequilíbrio entre escuros e claros.
  let escuros = 0;
  for (let y = 0; y < tamanho; y++) for (let x = 0; x < tamanho; x++) escuros += m[y][x];
  const proporcao = (escuros * 100) / (tamanho * tamanho);
  total += Math.floor(Math.abs(proporcao - 50) / 5) * 10;
  return total;
}

/** Escreve os 15 bits de formato (nível M + máscara), nos dois lugares em que eles vivem. */
function escreverFormato(m, tamanho, mascara) {
  const dados = (0b00 << 3) | mascara; // 00 = indicador do nível M
  const info = (((dados << 10) | bch(dados << 10, 0x537)) ^ 0x5412) >>> 0;

  for (let i = 0; i < 15; i++) {
    const bit = (info >> i) & 1;
    // Cópia 1: em volta do padrão de busca superior esquerdo.
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else if (i === 8) m[8][7] = bit;
    else m[8][14 - i] = bit;
    // Cópia 2: nos outros dois cantos.
    if (i < 8) m[8][tamanho - 1 - i] = bit;
    else m[tamanho - 15 + i][8] = bit;
  }
}

/**
 * Gera a matriz do QR Code. Devolve uma matriz de 0 e 1, sem a margem branca.
 */
function matriz(texto) {
  const bytes = Buffer.from(String(texto), 'utf8');
  const versao = escolherVersao(bytes);
  const codigos = codificar(bytes, versao);

  let melhor = null;
  for (let mascara = 0; mascara < 8; mascara++) {
    const base = novaMatriz(versao);
    preencher(base, codigos);
    const { m, reservado, tamanho } = base;
    for (let y = 0; y < tamanho; y++) {
      for (let x = 0; x < tamanho; x++) {
        if (!reservado[y][x] && MASCARAS[mascara](x, y)) m[y][x] ^= 1;
      }
    }
    escreverFormato(m, tamanho, mascara);
    const p = penalidade(m, tamanho);
    if (!melhor || p < melhor.p) melhor = { p, m, tamanho, mascara };
  }
  return { matriz: melhor.m, tamanho: melhor.tamanho, versao, mascara: melhor.mascara };
}

/**
 * O QR Code como SVG. `modulo` é o lado de cada quadradinho e `margem` a borda branca em módulos
 * (a norma pede 4, e sem ela muitos leitores não enxergam o código).
 */
function svg(texto, { modulo = 4, margem = 4, cor = '#000', fundo = '#fff' } = {}) {
  const { matriz: m, tamanho } = matriz(texto);
  const lado = (tamanho + margem * 2) * modulo;
  const partes = [];
  for (let y = 0; y < tamanho; y++) {
    let x = 0;
    while (x < tamanho) {
      if (!m[y][x]) { x++; continue; }
      let largura = 1;
      while (x + largura < tamanho && m[y][x + largura]) largura++;
      partes.push(`M${(x + margem) * modulo} ${(y + margem) * modulo}h${largura * modulo}v${modulo}h-${largura * modulo}z`);
      x += largura;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" width="${lado}" height="${lado}" shape-rendering="crispEdges">`
    + `<rect width="${lado}" height="${lado}" fill="${fundo}"/>`
    + `<path d="${partes.join('')}" fill="${cor}"/></svg>`;
}

module.exports = { matriz, svg, capacidade, escolherVersao, BLOCOS_M };
