#!/usr/bin/env node
'use strict';

/**
 * ZOE no telefone — AGI para Asterisk/Issabel.
 *
 * A ligação fala com a MESMA ZOE do WhatsApp: o cliente fala o que quer, a fala é gravada,
 * transcrita pelo mesmo whisper dos áudios do WhatsApp e passa pelas mesmas regras, ferramentas,
 * portão de identidade, alertas de rede e Ouvidoria. O que ela responderia por escrito, o TTS fala.
 * Digitar no teclado continua valendo (os três primeiros números do CPF, por exemplo). Se a empresa
 * escolheu atender por teclas (ZOE › Como ela atende), é a mesma ZOE com menu numerado: cada
 * resposta diz se a central grava a fala ou lê teclas, e quantas.
 *
 * Ao terminar, deixa no canal:
 *   ZOE_STATUS   = resolvido | transferir | indisponivel | desligou
 *   ZOE_FILA_ID  / ZOE_FILA_NOME = fila para onde transferir (quando ZOE_STATUS = transferir)
 *   ZOE_RESUMO   = resumo da conversa para o atendente
 * Se a ZOE estiver fora do ar, ZOE_STATUS = indisponivel e o plano de discagem manda para a fila:
 * uma ligação nunca termina no silêncio porque um servidor caiu.
 *
 * Configuração (/etc/asterisk/zoe-agi.conf ou variáveis de ambiente):
 *   ZOE_URL      https://SEU-DOMINIO/atendimento
 *   ZOE_CHAVE    chave da central (master › Telefonia › Chave da central, cen_…)
 *   ZOE_TTS_APP  aplicação de texto para voz do Asterisk (ex.: Flite). Obrigatória: a ZOE fala texto livre.
 *   ZOE_GRAVACOES  pasta temporária das falas gravadas (padrão /tmp/zoe-falas)
 *   ZOE_SUSSURRO=0 desliga o resumo sussurrado ao atendente (o painel abre do mesmo jeito)
 *
 * Exemplo (extensions.conf):
 *   [zoe-entrada]
 *   exten => s,1,Answer()
 *    same => n,AGI(/usr/local/bin/zoe-agi)
 *    same => n,GotoIf($["${ZOE_STATUS}" = "transferir" | "${ZOE_STATUS}" = "indisponivel"]?fila)
 *    same => n,Hangup()
 *    same => n(fila),Queue(${IF($["${ZOE_FILA_NOME}" = ""]?Atendimento:${ZOE_FILA_NOME})},,,,,,,zoe-atendeu^s^1)
 *   ; ZOE_FILA_NOME chega sem vírgula, | , parênteses, $ e aspas (trocados por _): a fila no
 *   ; Asterisk deve ter o nome da fila do painel com essa troca. Nomes simples evitam surpresa.
 *   ; O cliente desligou (na fila, com o atendente ou com a ZOE): fecha a conversa na ZOE.
 *   exten => h,1,AGI(/usr/local/bin/zoe-agi,fim)
 *
 *   ; Roda no canal do RAMAL quando ele atende (8º parâmetro do Queue). Abre a passagem no painel
 *   ; de quem tem esse ramal (Usuários › Ramal) e sussurra o resumo antes de ligar o cliente.
 *   [zoe-atendeu]
 *   exten => s,1,AGI(/usr/local/bin/zoe-agi,atendeu)
 *    same => n,Return()
 */

class Desligou extends Error {}

/** Conversa AGI sobre stdin/stdout (ou quaisquer streams, para teste). */
function criarAgi(entrada, saida) {
  let buffer = '';
  const linhas = [];
  const esperando = [];
  let fechado = false;
  entrada.setEncoding?.('utf8');
  entrada.on('data', (pedaco) => {
    buffer += pedaco;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const linha = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      if (esperando.length) esperando.shift()(linha); else linhas.push(linha);
    }
  });
  entrada.on('end', () => { fechado = true; while (esperando.length) esperando.shift()(null); });
  const lerLinha = () => (linhas.length ? Promise.resolve(linhas.shift()) : fechado ? Promise.resolve(null) : new Promise((r) => esperando.push(r)));

  return {
    /** Variáveis agi_* enviadas pelo Asterisk no início. */
    async ambiente() {
      const env = {};
      for (;;) {
        const l = await lerLinha();
        if (l === null || l === '') return env;
        const i = l.indexOf(':');
        if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
    },
    /** Envia um comando e devolve o result=. Canal desligado: Desligou. */
    async comando(cmd) {
      return (await this.resposta(cmd)).result;
    },
    /** Como `comando`, mas devolve também o valor entre parênteses ("200 result=1 (PJSIP/201)"). */
    async resposta(cmd) {
      saida.write(`${cmd}\n`);
      let l = await lerLinha();
      while (l !== null && l.startsWith('HANGUP')) l = await lerLinha(); // aviso de desligamento (AGI assíncrono)
      if (l === null || l.startsWith('511')) throw new Desligou();
      const m = l.match(/^200 result=(-?\d*)(?: \((.*)\))?/);
      if (!m) throw new Error(`Resposta AGI inesperada: ${l}`);
      if (m[1] === '-1') throw new Desligou();
      return { result: m[1], valor: m[2] ?? '' };
    },
    /** Valor de uma variável do canal ('' quando não existe). */
    async variavel(nome) {
      const r = await this.resposta(`GET VARIABLE ${nome}`);
      return r.result === '1' ? r.valor : '';
    },
  };
}

const aspas = (t) => `"${String(t).replace(/["\\\r\n]/g, ' ')}"`;

/**
 * Texto livre para EXEC <aplicação de TTS>. O Asterisk entrega o texto à aplicação, que separa
 * os argumentos por vírgula: "Obrigada, Maria. Para segunda via…" falava só "Obrigada", e o resto
 * virava opção da aplicação. A vírgula vai escapada (\\, no AGI vira \, para a aplicação, que lê
 * como vírgula); o | (separador antigo) sai; ${ e $[ ficam inertes caso AGIEXECFULL esteja ligado.
 * Pressupõe o res_agi sem o modo de compatibilidade 1.4 (o padrão desde o Asterisk 1.6).
 */
const textoApp = (t) => `"${String(t)
  .replace(/["\\\r\n|]/g, ' ')
  .replace(/\$(?=[{[])/g, '$ ')
  .replace(/,/g, '\\\\,')}"`;

/**
 * Nome da fila para o plano de discagem: ele entra em Queue(${ZOE_FILA_NOME},…), e uma vírgula
 * no nome deslocaria os argumentos do Queue (opções, gosub). Separadores e agrupadores viram "_";
 * a fila no Asterisk deve ter o mesmo nome com essa troca (ou use ZOE_FILA_ID).
 */
const nomeFila = (t) => String(t ?? '').replace(/[,|()[\]{}$"'\\;&\r\n]/g, '_');

// ---------- Modo conversado: o mesmo cérebro do WhatsApp ----------

function criarApiCerebro(base, chave) {
  const raiz = `${String(base).replace(/\/+$/, '')}/api/integracao/voz/ligacoes`;
  const chamar = async (caminho, corpo, prazoMs = 25000) => {
    const resp = await fetch(raiz + caminho, {
      method: 'POST',
      headers: { 'X-Api-Key': chave, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo ?? {}),
      // Uma fala leva transcrição (~3 s) e o raciocínio da ZOE: 25 s é o teto antes de desistir.
      signal: AbortSignal.timeout(prazoMs),
    });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) throw Object.assign(new Error(dados.erro || `HTTP ${resp.status}`), { status: resp.status });
    return dados;
  };
  return {
    iniciar: (corpo) => chamar('', corpo, 8000),
    turno: (uid, corpo) => chamar(`/${encodeURIComponent(uid)}/turno`, corpo),
    fim: (uid) => chamar(`/${encodeURIComponent(uid)}/fim`, {}, 5000),
    atendida: (uid, corpo) => chamar(`/${encodeURIComponent(uid)}/atendida`, corpo, 3000),
  };
}

const DIGITOS = '0123456789*#';

/**
 * Conduz a ligação conversando. Devolve o status deixado no canal (resolvido | transferir |
 * indisponivel | desligou), para o plano de discagem não mudar.
 */
async function conversar(agi, cerebro, env, o = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const uid = env.agi_uniqueid;
  const telefone = /^\+?\d{8,}$/.test(env.agi_callerid ?? '') ? env.agi_callerid : '';
  const set = (nome, valor) => agi.comando(`SET VARIABLE ${nome} ${aspas(valor ?? '')}`);
  const falar = (texto) => (texto ? agi.comando(`EXEC ${o.tts} ${textoApp(texto)}`) : null);
  const pasta = o.gravacoes || '/tmp/zoe-falas';
  try { fs.mkdirSync(pasta, { recursive: true }); } catch { /* o RECORD FILE avisa se não der */ }

  /**
   * Ouve o cliente: grava até 2 s de silêncio (máx. 20 s). Se ele apertar uma tecla em vez de
   * falar, a gravação para e o resto do número é lido pelo teclado.
   */
  const ouvir = async (n) => {
    const base = path.join(pasta, `${String(uid).replace(/[^\w.-]/g, '_')}-${n}`);
    const arquivo = `${base}.wav`;
    // O RECORD fica dentro do try: se o cliente desliga no meio da gravação, o Asterisk já
    // escreveu parte do WAV (com a voz, às vezes o CPF falado) e ele tem de sair do disco também.
    try {
      const r = Number(await agi.comando(`RECORD FILE ${base} wav "${DIGITOS}" 20000 0 s=2`));
      if (r > 0) {
        const primeira = String.fromCharCode(r);
        const resto = await agi.comando('GET DATA silence/1 4000 13');
        return { digitos: `${primeira}${resto ?? ''}` };
      }
      const buffer = fs.existsSync(arquivo) ? fs.readFileSync(arquivo) : null;
      // Menos de meio segundo de áudio útil (cabeçalho WAV + quase nada): não falou nada.
      if (!buffer || buffer.length < 8000) return { texto: '' };
      return { audio_base64: buffer.toString('base64') };
    } finally {
      // Síncrono: logo depois do desligamento o processo termina e um rm assíncrono não chegaria a rodar.
      try { fs.rmSync(arquivo, { force: true }); } catch { /* sem permissão: não há o que fazer aqui */ }
    }
  };

  let iniciado = false;
  let status = 'resolvido';
  try {
    let r = await cerebro.iniciar({ uid, telefone });
    iniciado = true;
    for (let n = 1; n <= 40; n++) {
      await falar(r.fala);
      if (r.acao === 'transferir') {
        status = 'transferir';
        await set('ZOE_FILA_ID', r.fila?.id ?? '');
        await set('ZOE_FILA_NOME', nomeFila(r.fila?.nome));
        await set('ZOE_RESUMO', r.resumo ?? '');
        // Com dois sublinhados a variável passa para o canal do ramal que a fila chamar: é por ela
        // que o "atendeu" (gosub da fila) sabe de qual ligação se trata e o que sussurrar.
        await set('__ZOE_UID', uid);
        await set('__ZOE_SUSSURRO', r.sussurro ?? '');
        break;
      }
      if (r.acao === 'encerrar') break;
      // Quem decide como ouvir é a ZOE: no modo teclas ela pede dígitos, e diz quantos — uma tecla
      // para escolher no menu, três para o começo do CPF. O # encerra antes, se o cliente quiser.
      const fala = r.aguardar === 'digitos'
        ? { digitos: (await agi.comando(`GET DATA silence/1 ${(r.max_digitos ?? 1) > 1 ? 10000 : 6000} ${r.max_digitos ?? 1}`)) ?? '' }
        : await ouvir(n);
      r = await cerebro.turno(uid, { ...fala, turno_id: String(n) });
    }
    await set('ZOE_STATUS', status);
    return status;
  } catch (err) {
    if (err instanceof Desligou) return (status = 'desligou');
    // O cérebro caiu no meio da ligação: a pessoa vai para a fila, não para o silêncio.
    await set('ZOE_STATUS', iniciado ? 'transferir' : 'indisponivel').catch(() => {});
    if (!iniciado) err.naoIniciou = true;
    if (!iniciado) throw err;
    return (status = 'transferir');
  } finally {
    // Transferida, a ligação continua — agora com uma pessoa. Quem fecha a conversa é o "h" do
    // plano de discagem (zoe-agi.js fim), quando o cliente desligar de verdade.
    if (iniciado && status !== 'transferir') await cerebro.fim(uid).catch(() => {});
  }
}

/** "PJSIP/201-0000002a", "SIP/201-…", "Local/201@from-queue-…" → "201". */
const ramalDoCanal = (canal) => String(canal ?? '').match(/^[A-Za-z]+\/(\d{2,8})(?:\b|[-@/])/)?.[1] ?? '';

/**
 * Roda no canal do RAMAL, quando ele atende uma ligação da fila (gosub do Queue). Avisa o
 * ZOE Atende — o painel de quem tem esse ramal abre com a passagem — e sussurra no ouvido do
 * atendente quem é o cliente e o que ele quer, antes de o cliente entrar na linha.
 * Nada aqui pode segurar a ligação: o aviso tem 3 s, e qualquer falha só é ignorada.
 */
async function atendeu(agi, env, cerebro, { tts = '', sussurrar = true } = {}) {
  const uid = await agi.variavel('ZOE_UID').catch(() => '');
  if (!uid) return 'sem-zoe'; // ligação que não passou pela ZOE: nada a fazer
  const ramal = ramalDoCanal(env.agi_channel);
  if (cerebro && ramal) await cerebro.atendida(uid, { ramal }).catch(() => {});
  const frase = sussurrar && tts ? await agi.variavel('ZOE_SUSSURRO').catch(() => '') : '';
  if (frase) await agi.comando(`EXEC ${tts} ${textoApp(frase)}`).catch(() => {});
  return 'avisado';
}

/**
 * Roda no "h" do plano de discagem: o cliente desligou. Fecha a conversa na ZOE.
 * Repetir o fim não faz mal: a ZOE ignora o que já está encerrado ou não existe.
 */
async function fimDaLigacao(agi, env, cerebro) {
  const uid = (await agi.variavel('ZOE_UID').catch(() => '')) || env.agi_uniqueid;
  if (cerebro && uid) await cerebro.fim(uid).catch(() => {});
  return 'encerrado';
}

/** Conversa quando dá (ZOE configurada e TTS para falar texto livre); senão, a fila. */
async function escolherModo(agi, env, { cerebro = null, tts = '', gravacoes } = {}) {
  if (cerebro && tts) {
    try {
      return await conversar(agi, cerebro, env, { tts, gravacoes });
    } catch (err) {
      if (!err.naoIniciou) throw err;
      // ZOE fora do ar antes de atender: o ZOE_STATUS já ficou "indisponivel" e a pessoa vai para a fila.
      return 'indisponivel';
    }
  }
  await agi.comando('SET VARIABLE ZOE_STATUS "indisponivel"').catch(() => {});
  return 'indisponivel';
}

/** Lê /etc/asterisk/zoe-agi.conf (CHAVE=valor); as variáveis de ambiente têm prioridade. */
function lerConf(arquivo = process.env.ZOE_AGI_CONF || '/etc/asterisk/zoe-agi.conf') {
  const conf = {};
  try {
    for (const linha of require('node:fs').readFileSync(arquivo, 'utf8').split('\n')) {
      const m = linha.match(/^\s*(ZOE_[A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) conf[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sem arquivo: só as variáveis de ambiente */ }
  const v = (k) => process.env[k] || conf[k] || '';
  return {
    // ZOE_CEREBRO / ZOE_CEREBRO_CHAVE: nomes antigos, ainda aceitos.
    url: v('ZOE_URL') || v('ZOE_CEREBRO'),
    chave: v('ZOE_CHAVE') || v('ZOE_CEREBRO_CHAVE'),
    tts: v('ZOE_TTS_APP'),
    gravacoes: v('ZOE_GRAVACOES'),
    sussurrar: v('ZOE_SUSSURRO') !== '0',
  };
}

async function principal() {
  // Quando o cliente desliga, o Asterisk manda SIGHUP ao script (a menos que AGISIGHUP=no). O
  // padrão do Node é morrer na hora — sem o "fim" para a API e sem apagar a fala gravada. O
  // desligamento já chega pelo próprio AGI (511 / result=-1), que vira Desligou e passa pelos finally.
  process.on('SIGHUP', () => {});
  const agi = criarAgi(process.stdin, process.stdout);
  const env = await agi.ambiente();
  const c = lerConf();
  const cerebro = c.url && c.chave ? criarApiCerebro(c.url, c.chave) : null;
  // AGI(zoe-agi.js,atendeu) no gosub da fila e AGI(zoe-agi.js,fim) no "h": ver o exemplo no topo.
  if (env.agi_arg_1 === 'atendeu') await atendeu(agi, env, cerebro, { tts: c.tts, sussurrar: c.sussurrar }).catch(() => {});
  else if (env.agi_arg_1 === 'fim') await fimDaLigacao(agi, env, cerebro).catch(() => {});
  else await escolherModo(agi, env, { cerebro, tts: c.tts, gravacoes: c.gravacoes }).catch(() => {});
  process.exit(0);
}

if (require.main === module) principal();

module.exports = { criarAgi, criarApiCerebro, conversar, escolherModo, atendeu, fimDaLigacao, ramalDoCanal, textoApp, nomeFila, lerConf, Desligou };
