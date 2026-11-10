'use strict';

/*
 * Processo do coletor de rede (flows + RADIUS):  npm run coletor-rede
 * Usa o mesmo banco do servidor (SQLite em modo WAL). Em instalações pequenas, dá para rodar dentro do servidor com
 * NETWORK_COLETOR_EMBUTIDO=1 em vez de um processo separado.
 */

const config = require('./config');
const { abrir } = require('./db');
const { iniciarColetorRede } = require('./lib/fluxos/servico');

const db = abrir();
const c = config.coletorRede;
const coletor = iniciarColetorRede(db, { host: c.host, portasFluxo: c.portasFluxo, portaRadius: c.portaRadius > 0 ? c.portaRadius : null, bufferBytes: c.bufferBytes });
coletor.pronto.then((p) => {
  console.log(`[Network] Coletor de rede: flows em UDP ${p.fluxo.join(', ') || '(desligado)'}${p.radius ? ` · RADIUS accounting em UDP ${p.radius}` : ''} (${c.host}).`);
}).catch((err) => {
  console.error(`[Network] Coletor de rede não iniciou: ${err.message}. Portas abaixo de 1024 exigem permissão; confira se outra aplicação já usa a porta.`);
  process.exit(1);
});
const sair = () => { try { coletor.gravarEstatisticas(); coletor.gravarTempoReal(); coletor.gravar(); } catch { /* encerrando */ } coletor.fechar(); db.close(); process.exit(0); };
process.on('SIGINT', sair);
process.on('SIGTERM', sair);
