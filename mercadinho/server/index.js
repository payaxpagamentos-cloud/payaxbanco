'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { expirarPendentes } = require('./lib/maquininha');
const { expirarAbandonadas } = require('./lib/vendas');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[Mercadinho] No ar em http://localhost:${config.port}${config.basePath}/`);
});

// Cobranças paradas na maquininha e carrinhos esquecidos no terminal são encerrados sozinhos.
setInterval(() => {
  try { expirarPendentes(db); } catch (err) { console.error('[Mercadinho] Falha ao expirar cobranças:', err.message); }
  try { expirarAbandonadas(db); } catch (err) { console.error('[Mercadinho] Falha ao limpar carrinhos:', err.message); }
}, 60_000).unref();
