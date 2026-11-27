#!/usr/bin/env node
'use strict';

/**
 * Mostra em que resolução cada canal ao vivo está CHEGANDO da origem.
 *
 *   node scripts/qualidade-canais.js           # resumo + os que não são Full HD
 *   node scripts/qualidade-canais.js --todos   # a lista inteira
 *
 * Existe por causa de uma pergunta que a operação faz sempre: "dá para melhorar a imagem deste
 * canal?". Dá, mas não aqui dentro. A conversão é remux puro (`-c copy`): o vídeo sai do jeito
 * que entrou, sem recomprimir. Logo, a qualidade na tela do assinante é a qualidade que o
 * fornecedor entrega, e o único lugar onde ela melhora é na origem — pedindo o feed Full HD do
 * canal, quando existe.
 *
 * Recodificar para "subir" de 720p para 1080p não melhora nada: a informação que falta não volta,
 * e o custo pula de 1,8% de um núcleo para quase um núcleo inteiro, por canal.
 *
 * A leitura vem do que o `testar-canais.js` gravou. Para atualizar os números antes de olhar:
 *   node scripts/testar-canais.js
 */

const { abrir } = require('../server/db');

const todos = process.argv.includes('--todos');
const db = abrir();

const canais = db.prepare(`SELECT numero, nome, sinal_status, sinal_detalhe, sinal_em
  FROM canais WHERE fonte = 'rtmp' AND url_hls IS NOT NULL AND url_hls <> ''
  ORDER BY numero`).all();

if (!canais.length) {
  console.log('Nenhum canal ao vivo cadastrado.');
  process.exit(0);
}

/** A resolução está dentro da ficha que o teste gravou, no formato "H264 1920x1080 30fps + AAC". */
function resolucao(detalhe) {
  const m = /(\d{3,4})x(\d{3,4})/.exec(String(detalhe || ''));
  return m ? { largura: Number(m[1]), altura: Number(m[2]) } : null;
}

function faixa(r) {
  if (!r) return 'sem medida';
  if (r.altura >= 1080) return 'Full HD';
  if (r.altura >= 720) return 'HD';
  return 'SD';
}

const ORDEM = ['Full HD', 'HD', 'SD', 'sem medida'];
const canal = (n) => `${n} ${n === 1 ? 'canal' : 'canais'}`;
const grupos = new Map(ORDEM.map((f) => [f, []]));
for (const c of canais) grupos.get(faixa(resolucao(c.sinal_detalhe))).push(c);

const linha = (c) => {
  const r = resolucao(c.sinal_detalhe);
  const fora = c.sinal_status === 'falha' ? '  \x1b[33m(fora do ar na última medição)\x1b[0m' : '';
  return `  ${String(c.numero).padStart(4)}  ${String(c.nome).slice(0, 30).padEnd(30)}  ${(r ? `${r.largura}x${r.altura}` : '—').padStart(9)}${fora}`;
};

console.log('\nCOMO CADA CANAL CHEGA DA ORIGEM\n');
for (const f of ORDEM) {
  const lista = grupos.get(f);
  if (!lista.length) continue;
  console.log(`${f}: ${canal(lista.length)}`);
}

const abaixo = [...grupos.get('HD'), ...grupos.get('SD'), ...grupos.get('sem medida')];
const mostrar = todos ? canais : abaixo;

if (!mostrar.length) {
  console.log('\nTodos os canais chegam em Full HD.');
} else {
  console.log(todos ? '\nTODOS OS CANAIS\n' : '\nABAIXO DE FULL HD — é nestes que vale pedir o feed melhor ao fornecedor\n');
  for (const c of mostrar) console.log(linha(c));
}

const semMedida = grupos.get('sem medida').length;
if (semMedida) console.log(`\n${canal(semMedida)} sem medida: rode  node scripts/testar-canais.js  para ler a origem.`);

const maisVelha = canais.map((c) => c.sinal_em).filter(Boolean).sort()[0];
if (maisVelha) console.log(`\nMedição mais antiga desta lista: ${maisVelha}.`);
console.log('\nA plataforma copia o vídeo sem recomprimir — a imagem na tela é a que a origem entrega.');
console.log('Para um canal subir de 720p para 1080p, o feed Full HD tem de vir do fornecedor.\n');

db.close();
