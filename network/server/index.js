'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { iniciarColetas } = require('./coletas');
const { iniciarTarefasTrafego } = require('./tarefas-trafego');

const db = abrir();
criarApp(db).listen(config.port, () => console.log(`[Network] Painel: http://localhost:${config.port}${config.basePath}/`));
if (config.coletasAutomaticas) {
  iniciarColetas(db);
  iniciarTarefasTrafego(db);
}
if (config.coletorRede.embutido) {
  const { iniciarColetorRede } = require('./lib/fluxos/servico');
  const c = config.coletorRede;
  iniciarColetorRede(db, { host: c.host, portasFluxo: c.portasFluxo, portaRadius: c.portaRadius > 0 ? c.portaRadius : null, bufferBytes: c.bufferBytes }).pronto
    .then((p) => console.log(`[Network] Coletor de rede embutido: flows em UDP ${p.fluxo.join(', ')}${p.radius ? ` · RADIUS em UDP ${p.radius}` : ''}.`))
    .catch((err) => console.error(`[Network] Coletor de rede embutido não iniciou: ${err.message}`));
}
