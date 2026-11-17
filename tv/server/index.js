'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { encerrarSessoesMortas } = require('./lib/player');
const { rodarCobranca } = require('./lib/assinaturas');
const { verificarSinais } = require('./lib/relay');

const db = abrir();
criarApp(db).listen(config.port, () => {
  const url = `http://localhost:${config.port}${config.basePath}`;
  console.log(`[${config.marca}] Assinante: ${url}/  ·  Operação: ${url}/admin/`);
});

const cada = (ms, nome, fn) => setInterval(() => {
  try { fn(); } catch (err) { console.error(`[${config.marca}] Falha em ${nome}:`, err.message); }
}, ms).unref();

// Telas que pararam de dar sinal de vida liberam a vaga do plano.
cada(30_000, 'sessões do player', () => encerrarSessoesMortas(db));
// Faturas do próximo ciclo e suspensão de quem passou da carência.
cada(60 * 60_000, 'cobrança', () => rodarCobranca(db));
// Sinal dos canais: o painel mostra quem está fora do ar.
cada(15 * 60_000, 'verificação de sinal', () => { verificarSinais(db).catch(() => {}); });

setTimeout(() => {
  try { rodarCobranca(db); } catch (err) { console.error(`[${config.marca}] Falha na cobrança:`, err.message); }
  verificarSinais(db).catch(() => {});
}, 3000).unref();
