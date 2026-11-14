#!/usr/bin/env node
'use strict';
/**
 * zoe-central — a ponte entre a ZOE e o Asterisk. Roda na máquina do Asterisk, como serviço.
 *
 *  1. A cada minuto lê, na ZOE, o que está cadastrado (ramais, filas, URAs, números) e escreve
 *     pjsip_zoe.conf, queues_zoe.conf e extensions_zoe.conf. Só recarrega o Asterisk quando muda.
 *  2. Escuta o Asterisk pelo AMI e manda para a ZOE cada ligação (início, atendida, fim — a base dos
 *     relatórios e da tarifação) e o registro dos ramais (online/offline). Se a ZOE estiver fora do
 *     ar, guarda e reenvia na ordem, com a hora certa de cada coisa.
 *
 * Configuração: /etc/asterisk/zoe.conf (CHAVE=valor)
 *   ZOE_URL=https://zoe.seuprovedor.com.br/atendimento
 *   ZOE_CHAVE=cen_...               (uma empresa)   ou   ZOE_CHAVE_3=cen_..., ZOE_CHAVE_7=cen_...
 *   AMI_USUARIO=zoe   AMI_SENHA=...   (AMI_HOST=127.0.0.1  AMI_PORTA=5038)
 *   TRONCO_1_USUARIO=...  TRONCO_1_SENHA=...  TRONCO_1_REGISTRO=1   (a conta da operadora da rota 1)
 *   ZOE_WEBRTC=1        cria também o cadastro do telefone no navegador (precisa do transporte wss)
 *   ZOE_IP_PUBLICO=...  quando o Asterisk está atrás de NAT
 *
 * Uso:  zoe-central            (serviço)
 *       zoe-central --teste    confere a ZOE, as chaves e o AMI, e sai
 *       zoe-central --gerar    mostra os arquivos que seriam escritos, sem escrever
 *       zoe-central --uma-vez  escreve, recarrega e sai
 */
const fs = require('node:fs');
const path = require('node:path');
const { gerar, ramalDoCanal, ramalDoAor } = require('./central/gerar');
const { Ami } = require('./central/ami');

const ARQUIVOS_RECARGA = {
  'pjsip_zoe.conf': 'module reload res_pjsip.so',
  'extensions_zoe.conf': 'dialplan reload',
  'queues_zoe.conf': 'module reload app_queue.so',
};
const ONLINE = new Set(['created', 'reachable', 'updated', 'nonqualified']);

/** CHAVE=valor por linha (# comenta). As variáveis de ambiente de mesmo nome valem por cima. */
function lerConf(arquivo) {
  const conf = {};
  try {
    for (const l of fs.readFileSync(arquivo, 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) conf[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch { /* sem arquivo: só o ambiente */ }
  for (const [k, v] of Object.entries(process.env)) if (/^(ZOE|AMI|TRONCO)_/.test(k) && v) conf[k] = v;
  return conf;
}

function opcoesDaConf(conf) {
  const troncos = {};
  for (const [k, v] of Object.entries(conf)) {
    const m = k.match(/^TRONCO_(\d+)_(USUARIO|SENHA|REGISTRO)$/);
    if (!m) continue;
    troncos[m[1]] = troncos[m[1]] ?? {};
    troncos[m[1]][{ USUARIO: 'usuario', SENHA: 'senha', REGISTRO: 'registro' }[m[2]]] = m[2] === 'REGISTRO' ? v === '1' : v;
  }
  return {
    troncos,
    webrtc: conf.ZOE_WEBRTC === '1',
    ipPublico: conf.ZOE_IP_PUBLICO || '',
    toque: Number(conf.ZOE_TOQUE) || 30,
    agi: conf.ZOE_AGI || '/usr/local/bin/zoe-agi',
    gravacoes: conf.ZOE_GRAVACOES_CHAMADAS || '/var/spool/asterisk/monitor/zoe',
  };
}

const chavesDaConf = (conf) => [...new Set(Object.entries(conf).filter(([k]) => /^ZOE_CHAVE(_\d+)?$/.test(k)).map(([, v]) => v).filter(Boolean))];

/**
 * A ponte, com as dependências de fora entregues (para testar sem Asterisk nem rede):
 * `ami` (Ami ou falso), `fetch`, `pasta` (onde escrever os .conf), `agora()`.
 */
function criarPonte({ conf, ami, fetch = globalThis.fetch, pasta = '/etc/asterisk', agora = () => new Date().toISOString(), log = console.log, grupo = null }) {
  const base = `${String(conf.ZOE_URL || '').replace(/\/+$/, '')}/api/central`;
  const opcoes = opcoesDaConf(conf);
  const chaves = chavesDaConf(conf);
  const chavePorEmpresa = new Map();
  const empresasVistas = new Map(); // id → config (para saber os ramais de cada empresa)
  const chamadas = new Map(); // uid → { empresa, atendida }
  const ramaisOnline = new Map(); // "empresa:ramal" → Set de AOR online
  const ultimoRegistro = new Map(); // "empresa:ramal" → último online enviado
  const fila = [];
  let recargaPendente = new Set();

  async function api(chave, metodo, caminho, corpo) {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'X-Api-Key': chave, 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(10000),
    });
    const dados = await r.json().catch(() => ({}));
    return { status: r.status, dados };
  }

  // ---------- 1. Configuração ----------
  async function lerConfiguracoes() {
    const cfgs = [];
    for (const chave of chaves) {
      const r = await api(chave, 'GET', '/config'); // erro de rede sobe: não escreve nada pela metade
      if (r.status === 401 || r.status === 403) { log(`[zoe-central] chave ${chave.slice(0, 8)}…: ${r.dados.erro ?? r.status} (empresa fora da central)`); continue; }
      if (r.status !== 200) throw new Error(`ZOE respondeu ${r.status} em /config`);
      chavePorEmpresa.set(Number(r.dados.empresa.id), chave);
      empresasVistas.set(Number(r.dados.empresa.id), r.dados);
      cfgs.push(r.dados);
    }
    return cfgs;
  }

  async function sincronizar({ escrever = true } = {}) {
    const arquivos = gerar(await lerConfiguracoes(), opcoes);
    if (!escrever) return { arquivos, mudaram: [] };
    const mudaram = [];
    for (const [nome, texto] of Object.entries(arquivos)) {
      const destino = path.join(pasta, nome);
      let atual = null;
      try { atual = fs.readFileSync(destino, 'utf8'); } catch { /* ainda não existe */ }
      if (atual === texto) continue;
      const tmp = `${destino}.novo`;
      fs.writeFileSync(tmp, texto, { mode: 0o640 });
      if (grupo !== null) { try { fs.chownSync(tmp, 0, grupo); } catch { /* sem permissão: segue */ } }
      fs.renameSync(tmp, destino);
      mudaram.push(nome);
    }
    for (const n of mudaram) recargaPendente.add(n);
    await recarregar();
    await renovarRegistros();
    return { arquivos, mudaram };
  }

  async function recarregar() {
    if (!recargaPendente.size || !ami?.conectado) return;
    const lista = [...recargaPendente];
    recargaPendente = new Set();
    for (const nome of lista) {
      try {
        await ami.comando(ARQUIVOS_RECARGA[nome]);
        log(`[zoe-central] ${nome} atualizado e recarregado`);
      } catch (err) {
        recargaPendente.add(nome);
        log(`[zoe-central] não recarregou ${nome}: ${err.message}`);
      }
    }
  }

  // ---------- 2. Eventos do Asterisk → ZOE ----------
  function enfileirar(empresa, caminho, corpo) {
    fila.push({ empresa: Number(empresa), caminho, corpo });
    if (fila.length > 20000) fila.splice(0, fila.length - 20000);
    return enviar();
  }

  /**
   * Envia na ordem. Erro de rede ou 5xx: para e tenta de novo depois. 4xx: a ZOE recusou, descarta.
   * Chamado com um envio em andamento, espera ele terminar e faz mais uma passada.
   */
  let corrida = null;
  function enviar() {
    if (corrida) return corrida.then(() => (corrida ? corrida : passada()));
    return passada();
  }
  function passada() {
    corrida = (async () => {
      while (fila.length) {
        const item = fila[0];
        const chave = chavePorEmpresa.get(item.empresa);
        if (!chave) {
          if (empresasVistas.size || !chaves.length) { fila.shift(); continue; } // empresa sem chave nesta central
          break; // ainda não leu a configuração: espera
        }
        let r;
        try { r = await api(chave, 'POST', item.caminho, item.corpo); } catch { break; }
        if (r.status >= 500) break;
        if (r.status >= 400) log(`[zoe-central] ZOE recusou ${item.caminho}: ${r.dados.erro ?? r.status}`);
        fila.shift();
      }
    })().finally(() => { corrida = null; });
    return corrida;
  }

  function statusFinal(ev, estado) {
    // A ZOE atendeu (conversou, mesmo que depois tenha transferido ou o cliente desligado): foi atendida.
    if (estado?.atendida || ['resolvido', 'transferir', 'desligou'].includes(ev.zoe)) return 'atendida';
    const s = String(ev.dialstatus || ev.queuestatus || '').toUpperCase();
    if (s === 'BUSY') return 'ocupado';
    if (s === 'CHANUNAVAIL' || s === 'CONGESTION') return 'falha';
    // Sem informação: a ZOE decide pelo que já sabe (se houve atendimento, é atendida).
    return undefined;
  }

  function bytesGravacao(uid) {
    try { return fs.statSync(path.join(opcoes.gravacoes, `${String(uid).replace(/[^\w.-]/g, '_')}.wav`)).size; } catch { return 0; }
  }

  function tratarEvento(ev) {
    const tipo = (ev.event ?? '').toLowerCase();
    if (tipo === 'userevent') {
      const nome = (ev.userevent ?? '').toLowerCase();
      const uid = ev.uid;
      const empresa = Number(ev.empresa);
      if (!uid || !empresa) return null;
      if (nome === 'zoeinicio') {
        chamadas.set(uid, { empresa, atendida: false });
        return enfileirar(empresa, '/chamadas', { uid, direcao: ev.direcao, origem: ev.origem || 'anonimo', destino: ev.destino, inicio: agora() });
      }
      if (nome === 'zoeatendida') {
        const estado = chamadas.get(uid);
        if (estado?.atendida) return null; // só o primeiro atendimento conta
        if (estado) estado.atendida = true;
        const r = ramalDoCanal(ev.canal);
        return enfileirar(empresa, `/chamadas/${encodeURIComponent(uid)}/atendida`, { em: agora(), ...(r ? { ramal: r.ramal } : {}) });
      }
      if (nome === 'zoefim') {
        const estado = chamadas.get(uid);
        chamadas.delete(uid);
        const status = statusFinal(ev, estado);
        return enfileirar(empresa, `/chamadas/${encodeURIComponent(uid)}/fim`, { fim: agora(), ...(status ? { status } : {}), gravacao_bytes: bytesGravacao(uid) });
      }
      return null;
    }
    if (tipo === 'contactstatus') {
      const r = ramalDoAor(ev.aor);
      if (!r) return null;
      const chave = `${r.empresa}:${r.ramal}`;
      const set = ramaisOnline.get(chave) ?? new Set();
      if (ONLINE.has(String(ev.contactstatus).toLowerCase())) set.add(ev.aor); else set.delete(ev.aor);
      ramaisOnline.set(chave, set);
      return informarRamal(r.empresa, r.ramal, { ip: ipDaUri(ev.uri), agente: ev.useragent });
    }
    return null;
  }

  const ipDaUri = (uri) => String(uri ?? '').match(/@\[?([0-9a-fA-F.:]+?)\]?(?::\d+)?(?:;|$)/)?.[1] ?? undefined;

  function informarRamal(empresa, ramal, extra = {}, forcar = false) {
    const chave = `${empresa}:${ramal}`;
    const online = (ramaisOnline.get(chave)?.size ?? 0) > 0;
    if (!forcar && ultimoRegistro.get(chave) === online) return null;
    ultimoRegistro.set(chave, online);
    return enfileirar(empresa, `/ramais/${encodeURIComponent(ramal)}/registro`, { online, ...(extra.ip ? { ip: extra.ip } : {}), ...(extra.agente ? { agente: extra.agente } : {}) });
  }

  /** Lê os registros atuais (ao conectar e a cada sincronia) e renova os online na ZOE, que expira quem some. */
  async function renovarRegistros() {
    if (!ami?.conectado) return;
    let r;
    try { r = await ami.acao({ Action: 'PJSIPShowContacts' }); } catch { return; }
    const novos = new Map();
    for (const ev of r.eventos ?? []) {
      const x = ramalDoAor(ev.aor);
      if (!x) continue;
      const chave = `${x.empresa}:${x.ramal}`;
      if (!novos.has(chave)) novos.set(chave, new Set());
      if (ONLINE.has(String(ev.status).toLowerCase()) || String(ev.status).toLowerCase() === 'unknown') novos.get(chave).add(ev.aor);
    }
    ramaisOnline.clear();
    for (const [k, v] of novos) ramaisOnline.set(k, v);
    for (const [empresa, cfg] of empresasVistas) {
      for (const ramal of cfg.ramais ?? []) {
        const online = (ramaisOnline.get(`${empresa}:${ramal.numero}`)?.size ?? 0) > 0;
        // Online: renova sempre (a ZOE marca offline quem fica sem notícia). Offline: só quando muda.
        informarRamal(empresa, ramal.numero, {}, online);
      }
    }
  }

  return { sincronizar, tratarEvento, enviar, recarregar, renovarRegistros, fila, chavePorEmpresa, chaves, opcoes };
}

async function principal() {
  const args = process.argv.slice(2);
  const arquivoConf = process.env.ZOE_CONF || '/etc/asterisk/zoe.conf';
  let conf = lerConf(arquivoConf);
  if (!conf.ZOE_URL || !chavesDaConf(conf).length) {
    if (args.length) {
      console.error(`Configure ZOE_URL e ZOE_CHAVE em ${arquivoConf} (a chave da central, cen_…).`);
      process.exit(2);
    }
    // Como serviço, espera a chave ser colada no arquivo: não precisa reiniciar nada depois.
    console.log(`[zoe-central] aguardando ZOE_URL e ZOE_CHAVE em ${arquivoConf}`);
    while (!conf.ZOE_URL || !chavesDaConf(conf).length) {
      await new Promise((r) => setTimeout(r, 30_000));
      conf = lerConf(arquivoConf);
    }
    console.log('[zoe-central] chave encontrada: começando');
  }
  let grupo = null;
  try { grupo = fs.statSync('/etc/asterisk').gid; } catch { /* sem a pasta */ }

  if (args.includes('--gerar')) {
    const ponte = criarPonte({ conf, ami: null });
    const { arquivos } = await ponte.sincronizar({ escrever: false });
    for (const [nome, texto] of Object.entries(arquivos)) process.stdout.write(`\n===== ${nome} =====\n${texto}`);
    return;
  }

  const ami = new Ami({ host: conf.AMI_HOST || '127.0.0.1', porta: Number(conf.AMI_PORTA) || 5038, usuario: conf.AMI_USUARIO, senha: conf.AMI_SENHA });
  const ponte = criarPonte({ conf, ami, grupo });

  if (args.includes('--teste')) {
    let falhou = 0;
    const ok = (t) => console.log(`  ✔ ${t}`);
    const ruim = (t) => { console.log(`  ✘ ${t}`); falhou = 1; };
    try {
      const { arquivos } = await ponte.sincronizar({ escrever: false });
      ok(`ZOE respondeu (${conf.ZOE_URL}); empresas nesta central: ${[...ponte.chavePorEmpresa.keys()].join(', ') || 'nenhuma'}`);
      if (!ponte.chavePorEmpresa.size) ruim('nenhuma chave válida: confira ZOE_CHAVE (chave da central, cen_…) e se a telefonia da empresa está ligada');
      ok(`configuração gerada: ${Object.entries(arquivos).map(([n, t]) => `${n} (${t.split('\n').length} linhas)`).join(', ')}`);
    } catch (err) { ruim(`ZOE: ${err.message}`); }
    await new Promise((fim) => {
      ami.once('conectado', () => { ok('AMI conectado'); fim(); });
      ami.once('erro', (err) => { ruim(err.message); fim(); });
      ami.iniciar();
      setTimeout(fim, 8000);
    });
    ami.parar();
    process.exit(falhou);
  }

  ami.on('evento', (ev) => { Promise.resolve(ponte.tratarEvento(ev)).catch((err) => console.log(`[zoe-central] ${err.message}`)); });
  ami.on('conectado', () => { console.log('[zoe-central] AMI conectado'); ponte.recarregar().then(() => ponte.renovarRegistros()).catch(() => {}); });
  ami.on('desconectado', () => console.log('[zoe-central] AMI desconectado; tentando de novo'));
  let ultimoErro = '';
  ami.on('erro', (err) => { if (err.message !== ultimoErro) console.log(`[zoe-central] ${err.message}`); ultimoErro = err.message; });
  ami.iniciar();

  const ciclo = async () => {
    try {
      const { mudaram } = await ponte.sincronizar();
      if (mudaram.length) console.log(`[zoe-central] mudou: ${mudaram.join(', ')}`);
    } catch (err) { console.log(`[zoe-central] sem a configuração da ZOE agora: ${err.message}`); }
    await ponte.enviar().catch(() => {});
  };
  if (args.includes('--uma-vez')) {
    await new Promise((r) => { ami.once('conectado', r); setTimeout(r, 8000); });
    await ciclo();
    ami.parar();
    process.exit(0);
  }
  await ciclo();
  setInterval(ciclo, (Number(conf.ZOE_INTERVALO) || 60) * 1000);
  setInterval(() => ponte.enviar().catch(() => {}), 10_000);
  process.on('SIGTERM', () => { ami.parar(); process.exit(0); });
}

if (require.main === module) principal();

module.exports = { criarPonte, lerConf, opcoesDaConf, chavesDaConf };
