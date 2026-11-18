'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { encerrarSessoesMortas } = require('./lib/player');
const { rodarCobranca } = require('./lib/assinaturas');
const { verificarSinais } = require('./lib/relay');
const { atualizarGradeAutomatica } = require('./lib/epg');
const transcodificar = require('./lib/transcodificar');

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
// Grade dos canais abertos: busca o XMLTV cadastrado uma vez por dia.
cada(24 * 60 * 60_000, 'atualização da grade', () => {
  atualizarGradeAutomatica(db).then((r) => r && console.log(`[${config.marca}] Grade atualizada: ${r.importados} programa(s).`)).catch((err) => {
    console.error(`[${config.marca}] Falha ao atualizar a grade:`, err.message);
  });
});

setTimeout(() => {
  try { rodarCobranca(db); } catch (err) { console.error(`[${config.marca}] Falha na cobrança:`, err.message); }
  verificarSinais(db).catch(() => {});
  // Conversões que ficaram pela metade num reinício voltam para a fila.
  const retomadas = transcodificar.retomar(db);
  if (retomadas) console.log(`[${config.marca}] ${retomadas} conversão(ões) retomada(s).`);
}, 3000).unref();
