'use strict';

/**
 * O cuidado com a reserva do ao vivo (public/js/ritmo.js): canal que começou com pouca folga
 * toca um pouco mais devagar até juntar folga de novo. Aqui o <video> é de mentira e o
 * intervalo é curto; o efeito com vídeo e HLS de verdade é medido à parte, no navegador.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Módulo do navegador (ESM) numa pasta que o Node lê como CommonJS: carregado pelo conteúdo.
let modulo = null;
const carregar = async () => {
  if (!modulo) {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ritmo.js'), 'utf8');
    modulo = await import(`data:text/javascript;base64,${Buffer.from(fonte).toString('base64')}`);
  }
  return modulo;
};

/** <video> de mentira: só o que o cuidado olha. A reserva é `fim - currentTime`. */
const videoFalso = (reserva) => ({
  currentTime: 100, paused: false, readyState: 4, playbackRate: 1, fim: 100 + reserva,
  get buffered() { const v = this; return { length: 1, end: () => v.fim }; },
});
const esperar = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('reserva baixa desacelera; reserva boa devolve a velocidade normal', async () => {
  const { cuidarDaReserva, RITMO_LENTO } = await carregar();
  const v = videoFalso(3);
  const parar = cuidarDaReserva(v, { baixaS: 6, boaS: 9, intervaloMs: 10 });
  await esperar(40);
  assert.equal(v.playbackRate, RITMO_LENTO, 'com 3 s de reserva, toca mais devagar');

  // Entre a linha de baixo e a de cima, mantém o que estava fazendo: sem liga-desliga.
  v.fim = v.currentTime + 7.5;
  await esperar(40);
  assert.equal(v.playbackRate, RITMO_LENTO, 'ainda não chegou na reserva boa');

  v.fim = v.currentTime + 9.2;
  await esperar(40);
  assert.equal(v.playbackRate, 1, 'reserva boa: velocidade normal');

  // E não volta a desacelerar só porque caiu um pouco abaixo da linha de cima.
  v.fim = v.currentTime + 7;
  await esperar(40);
  assert.equal(v.playbackRate, 1);
  parar();
});

test('canal que já começa com reserva boa nunca é tocado', async () => {
  const { cuidarDaReserva } = await carregar();
  const v = videoFalso(20);
  const parar = cuidarDaReserva(v, { intervaloMs: 10 });
  await esperar(50);
  assert.equal(v.playbackRate, 1);
  parar();
});

test('não mexe em vídeo pausado, carregando, nem na velocidade que o assinante escolheu', async () => {
  const { cuidarDaReserva } = await carregar();

  const pausado = Object.assign(videoFalso(2), { paused: true });
  const carregando = Object.assign(videoFalso(2), { readyState: 1 });
  const escolhida = Object.assign(videoFalso(2), { playbackRate: 1.5 });
  const paradas = [pausado, carregando, escolhida].map((v) => cuidarDaReserva(v, { intervaloMs: 10 }));
  await esperar(50);
  assert.equal(pausado.playbackRate, 1);
  assert.equal(carregando.playbackRate, 1);
  assert.equal(escolhida.playbackRate, 1.5, 'quem escolheu 1,5x fica em 1,5x');
  paradas.forEach((p) => p());
});

test('parar devolve a velocidade normal', async () => {
  const { cuidarDaReserva, RITMO_LENTO } = await carregar();
  const v = videoFalso(2);
  const parar = cuidarDaReserva(v, { intervaloMs: 10 });
  await esperar(40);
  assert.equal(v.playbackRate, RITMO_LENTO);
  parar();
  assert.equal(v.playbackRate, 1, 'fechar o canal não pode deixar o próximo vídeo lento');
  // Depois de parado, não mexe mais.
  v.fim = v.currentTime + 1;
  await esperar(40);
  assert.equal(v.playbackRate, 1);
});
