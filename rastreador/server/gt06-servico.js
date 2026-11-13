'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Serviço GT06 separado: só a conexão com os rastreadores (porta TCP), num processo próprio. Assim, atualizar o painel não
 * derruba os rastreadores. Ele só reinicia quando o código que ele usa muda (o atualizador avisa).
 * No PM2: pm2 start "node --disable-warning=ExperimentalWarning --env-file-if-exists=.env server/gt06-servico.js" --name rastreador-gt06
 */
const fs = require('node:fs');
const config = require('./config');
const { abrir } = require('./db');
const { iniciarGt06 } = require('./lib/gt06');
const servico = require('./lib/servicoGt06');

require('./lib/licenca').exigir();
const porta = config.portaGt06 || 5023;
const db = abrir();
let gt06 = null;
let tentativa = null;

// Quem está com a porta TCP (Linux): procura o socket em escuta em /proc/net e o processo dono dele.
function donoDaPorta() {
  try {
    const hex = porta.toString(16).toUpperCase().padStart(4, '0');
    const inodes = new Set();
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let linhas = [];
      try { linhas = fs.readFileSync(f, 'utf8').split('\n').slice(1); } catch { /* sem IPv6 */ }
      for (const l of linhas) {
        const c = l.trim().split(/\s+/);
        if (c.length > 9 && c[1].endsWith(`:${hex}`) && c[3] === '0A') inodes.add(`socket:[${c[9]}]`);
      }
    }
    if (!inodes.size) return null;
    for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      if (Number(pid) === process.pid) continue;
      let fds = [];
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        try { if (inodes.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))) return Number(pid); } catch { /* fechou */ }
      }
    }
  } catch { /* sem /proc */ }
  return null;
}

// Um serviço GT06 antigo que ficou para trás (órfão de um reinício) segura a porta e não atende ninguém: encerra ele.
// Só mexe num processo que seja comprovadamente este mesmo serviço (linha de comando com gt06-servico.js). Se for o
// painel, ele mesmo devolve a porta ao ver este serviço no ar.
function encerrarAntigo() {
  const pid = donoDaPorta();
  if (!pid) return;
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!cmd.includes('gt06-servico.js')) return;
    process.kill(pid, 'SIGTERM');
    console.error(`[Rastreador] Serviço GT06: processo antigo (pid ${pid}) segurava a porta ${porta}; encerrado.`);
  } catch { /* já saiu */ }
}

// O painel pode estar com a porta (ele a usa quando o serviço não existe): tenta de novo até conseguir, avisando no log.
let ocupadaDesde = 0;
let avisoEm = 0;
function subir() {
  const g = iniciarGt06(db, porta);
  g.servidor.once('listening', () => { gt06 = g; ocupadaDesde = 0; console.log(`[Rastreador] Serviço GT06 (TCP): porta ${porta}`); situacao(); });
  g.servidor.once('error', (err) => {
    g.fechar().catch(() => {});
    if (err.code === 'EADDRINUSE') {
      const agora = Date.now();
      if (!ocupadaDesde) ocupadaDesde = agora;
      if (agora - ocupadaDesde > 10_000) encerrarAntigo();
      if (agora - avisoEm > 60_000) {
        avisoEm = agora;
        console.error(`[Rastreador] Serviço GT06: a porta ${porta} está ocupada por outro processo; tentando de novo (veja: ss -tlnp | grep ${porta}).`);
      }
    } else {
      console.error(`[Rastreador] Serviço GT06: ${err.message}`);
    }
    tentativa = setTimeout(subir, 3000);
  });
}

// Situação para o painel (aparelhos conectados) e o código carregado (para o atualizador saber se precisa reiniciar).
const meusArquivos = () => Object.keys(require.cache).filter((a) => a.startsWith(__dirname));
function situacao() {
  try { servico.gravar({ porta: gt06 ? porta : null, imeis: gt06 ? gt06.imeis() : [], digital: servico.digital(meusArquivos()), arquivos: meusArquivos() }); }
  catch (err) { console.error('[Rastreador] Serviço GT06 (situação):', err.message); }
}
subir();
situacao();
setInterval(situacao, 5000); // anuncia mesmo esperando a porta: o painel vê e devolve a porta se estiver com ela

// Se o processo que nos iniciou (PM2) sumir, ficamos órfãos segurando a porta: encerra para o PM2 subir um novo.
const paiInicial = process.ppid;
setInterval(() => {
  if (process.ppid !== paiInicial) {
    console.error('[Rastreador] Serviço GT06: ficou sem o processo que o iniciou; encerrando.');
    encerrar();
  }
}, 5000).unref();

// Comandos criados pelo painel (outro processo) chegam pelo banco: entrega a cada segundo.
setInterval(() => { try { gt06?.entregarPendentes(); } catch (err) { console.error('[Rastreador] Serviço GT06 (comandos):', err.message); } }, 1000);

// O atualizador pede reinício só quando o código deste serviço mudou.
setInterval(() => {
  if (fs.existsSync(servico.REINICIAR)) {
    try { fs.unlinkSync(servico.REINICIAR); } catch { /* outro já apagou */ }
    console.log('[Rastreador] Serviço GT06: código atualizado, reiniciando.');
    encerrar();
  }
}, 2000);

function encerrar() {
  clearTimeout(tentativa);
  Promise.resolve(gt06?.fechar()).catch(() => {}).finally(() => {
    try { fs.unlinkSync(servico.SITUACAO); } catch { /* já apagado */ }
    try { db.close(); } catch { /* já fechado */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
process.on('uncaughtException', (err) => { console.error('[Rastreador] Serviço GT06, erro:', err.stack || err.message); encerrar(); });
