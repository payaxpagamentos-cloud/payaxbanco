'use strict';

const config = require('./config');
const { abrir, lerConfig } = require('./db');
const { criarApp } = require('./app');
const { encerrarSessoesMortas } = require('./lib/player');
const { rodarCobranca } = require('./lib/assinaturas');
const { verificarSinais } = require('./lib/relay');
const aovivo = require('./lib/aovivo');
const { atualizarGradeAutomatica, limparAntigos } = require('./lib/epg');
const transcodificar = require('./lib/transcodificar');

const db = abrir();
const servidor = criarApp(db).listen(config.port, () => {
  const url = `http://localhost:${config.port}${config.basePath}`;
  console.log(`[${config.marca}] Assinante: ${url}/  ·  Operação: ${url}/admin/`);
});
// Envio de vídeo grande e canal ao vivo são conexões longas: o proxy à frente controla o tempo.
servidor.requestTimeout = 0;
servidor.headersTimeout = 65_000;
servidor.keepAliveTimeout = 61_000;

const cada = (ms, nome, fn) => setInterval(() => {
  try { fn(); } catch (err) { console.error(`[${config.marca}] Falha em ${nome}:`, err.message); }
}, ms).unref();

// Telas que pararam de dar sinal de vida liberam a vaga do plano.
cada(30_000, 'sessões do player', () => encerrarSessoesMortas(db));
// Faturas do próximo ciclo e suspensão de quem passou da carência.
cada(60 * 60_000, 'cobrança', () => rodarCobranca(db));
// Sinal dos canais: o painel mostra quem está fora do ar.
cada(15 * 60_000, 'verificação de sinal', () => { verificarSinais(db).catch(() => {}); });
// Conversão dos canais em RTMP/SRT. Sob demanda, o canal entra no ar quando o assinante abre;
// esta volta de 30 em 30 segundos é quem desliga o que ninguém está mais assistindo e quem
// derruba a conversão de um canal que a operação tirou do ar.
cada(30_000, 'canais ao vivo', () => aovivo.sincronizar(db));
// Grade dos canais abertos: busca o XMLTV cadastrado e limpa o que já passou.
const cuidarDaGrade = () => {
  const removidos = limparAntigos(db, 7);
  if (removidos) console.log(`[${config.marca}] Grade: ${removidos} programa(s) antigo(s) removido(s).`);
  return atualizarGradeAutomatica(db)
    .then((r) => r && console.log(`[${config.marca}] Grade atualizada: ${r.importados} programa(s).`))
    .catch((err) => console.error(`[${config.marca}] Falha ao atualizar a grade:`, err.message));
};
cada(24 * 60 * 60_000, 'atualização da grade', cuidarDaGrade);

setTimeout(() => {
  try { rodarCobranca(db); } catch (err) { console.error(`[${config.marca}] Falha na cobrança:`, err.message); }
  verificarSinais(db).catch(() => {});
  // Canais em RTMP/SRT. Sob demanda, nenhum sobe agora: cada um entra no ar quando alguém abrir.
  try {
    const { ligados, limitados, sob_demanda: sobDemanda } = aovivo.sincronizar(db);
    if (sobDemanda) console.log(`[${config.marca}] Ao vivo: conversão sob demanda (canal entra no ar ao ser assistido, sai após ${config.aoVivo.ociosoSegundos}s ocioso).`);
    else if (ligados) console.log(`[${config.marca}] Ao vivo: ${ligados} canal(is) convertendo para HLS.`);
    if (limitados) console.warn(`[${config.marca}] Ao vivo: ${limitados} canal(is) além do teto de ${config.aoVivo.maxCanais}.`);
  } catch (err) { console.error(`[${config.marca}] Falha ao ligar os canais ao vivo:`, err.message); }
  // Conversões que ficaram pela metade num reinício voltam para a fila.
  const retomadas = transcodificar.retomar(db);
  if (retomadas) console.log(`[${config.marca}] ${retomadas} conversão(ões) retomada(s).`);
  // Num servidor que reinicia todo dia, a atualização de 24 em 24 horas nunca chegaria a rodar:
  // ao subir, põe a grade em dia se a última importação já passou de 12 horas.
  try {
    const { epg_importado_em: ultima } = lerConfig(db);
    const velha = !ultima || Date.now() - new Date(ultima).getTime() > 12 * 60 * 60_000;
    if (velha) cuidarDaGrade();
  } catch (err) { console.error(`[${config.marca}] Falha ao conferir a grade:`, err.message); }
}, 3000).unref();

// Erro solto em tarefa de fundo não derruba a plataforma: fica registrado e o serviço continua.
process.on('unhandledRejection', (motivo) => console.error(`[${config.marca}] Promessa rejeitada sem tratamento:`, motivo));
process.on('uncaughtException', (err) => console.error(`[${config.marca}] Exceção não tratada:`, err));

/** Parada limpa: para de aceitar conexões, deixa as em curso terminarem e fecha o banco. */
let encerrando = false;
const encerrar = (sinal) => {
  if (encerrando) return;
  encerrando = true;
  console.log(`[${config.marca}] ${sinal} recebido: encerrando…`);
  const prazo = setTimeout(() => { console.log(`[${config.marca}] Encerrando à força.`); process.exit(0); }, 15_000);
  prazo.unref();
  // Os ffmpeg do ao vivo são filhos deste processo: sem isto ficariam órfãos escrevendo em disco.
  try { aovivo.desligarTudo(); } catch { /* nada convertendo */ }
  servidor.close(() => {
    try { db.close(); } catch { /* já fechado */ }
    clearTimeout(prazo);
    console.log(`[${config.marca}] Encerrado.`);
    process.exit(0);
  });
};
for (const sinal of ['SIGTERM', 'SIGINT']) process.on(sinal, () => encerrar(sinal));
