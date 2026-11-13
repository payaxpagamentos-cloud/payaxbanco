#!/usr/bin/env node
'use strict';

/**
 * ZOE — URA por teclas para Asterisk/Issabel (fase 1).
 *
 * Roda como AGI no plano de discagem e conduz a ligação pela API da ZOE (identificar, confirmar,
 * segunda via, desbloqueio de confiança, transferir). Ao terminar, deixa no canal:
 *   ZOE_STATUS   = resolvido | transferir | indisponivel | desligou
 *   ZOE_FILA_ID  / ZOE_FILA_NOME = fila para onde transferir (quando ZOE_STATUS = transferir)
 *   ZOE_RESUMO   = resumo da conversa para o atendente
 *
 * Dois modos:
 *
 *   CONVERSADO (com ZOE_CEREBRO e ZOE_TTS_APP): a ligação fala com a MESMA ZOE do WhatsApp, no
 *   ZOE Atende. O cliente fala o que quer, a fala é gravada, transcrita lá pelo mesmo whisper dos
 *   áudios do WhatsApp, e passa pelas mesmas regras, ferramentas, portão de identidade, alertas de
 *   rede e Ouvidoria. O que ela responderia por escrito, o TTS fala. Digitar no teclado continua
 *   valendo (os três primeiros números do CPF, por exemplo).
 *
 *   POR TECLAS (sem ZOE_CEREBRO, ou se ele cair): a URA de teclas de sempre, pela API do PABX.
 *   Fica como reserva — uma ligação nunca termina no silêncio porque um servidor caiu.
 *
 *   ZOE_CEREBRO        https://SEU-DOMINIO/atendimento   (o ZOE Atende)
 *   ZOE_CEREBRO_CHAVE  chave de API da empresa no ZOE Atende (Integrações → Nova chave, atd_…)
 *   ZOE_GRAVACOES      pasta temporária das falas gravadas (padrão /tmp/zoe-falas)
 *
 * Variáveis de ambiente do modo por teclas (ou argumentos do AGI: AGI(zoe-agi.js,URL,CHAVE)):
 *   ZOE_API      https://SEU-DOMINIO/pabx/api/integracao
 *   ZOE_CHAVE    chave da empresa (Integrações → Nova chave)
 *   ZOE_TTS_APP  aplicação de texto para voz do Asterisk (ex.: Flite). Vazio: toca os áudios gravados em sounds/zoe/.
 *
 * Exemplo (extensions.conf):
 *   exten => s,1,Answer()
 *    same => n,AGI(/opt/zoe/zoe-agi.js)
 *    same => n,GotoIf($["${ZOE_STATUS}" = "transferir" | "${ZOE_STATUS}" = "indisponivel"]?fila)
 *    same => n,Hangup()
 *    same => n(fila),Queue(${IF($["${ZOE_FILA_NOME}" = ""]?atendimento:${ZOE_FILA_NOME})})
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
      saida.write(`${cmd}\n`);
      let l = await lerLinha();
      while (l !== null && l.startsWith('HANGUP')) l = await lerLinha(); // aviso de desligamento (AGI assíncrono)
      if (l === null || l.startsWith('511')) throw new Desligou();
      const m = l.match(/^200 result=(-?\d*)/);
      if (!m) throw new Error(`Resposta AGI inesperada: ${l}`);
      if (m[1] === '-1') throw new Desligou();
      return m[1];
    },
  };
}

const aspas = (t) => `"${String(t).replace(/["\\\n]/g, ' ')}"`;

function criarApiZoe(base, chave) {
  const raiz = `${String(base).replace(/\/+$/, '')}/zoe/atendimentos`;
  const chamar = async (metodo, caminho, corpo) => {
    const resp = await fetch(raiz + caminho, {
      method: metodo,
      headers: { 'X-Api-Key': chave, 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(8000),
    });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) throw Object.assign(new Error(dados.erro || `HTTP ${resp.status}`), { status: resp.status });
    return dados;
  };
  return {
    iniciar: (corpo) => chamar('POST', '', corpo),
    get: (uid, etapa) => chamar('GET', `/${encodeURIComponent(uid)}/${etapa}`),
    post: (uid, etapa, corpo = {}) => chamar('POST', `/${encodeURIComponent(uid)}/${etapa}`, corpo),
  };
}

/**
 * Conduz uma ligação. `o.tts`: aplicação de TTS do Asterisk (fala o texto que a API devolve);
 * sem ela, toca os áudios gravados (zoe/<nome>) e fala números com SAY NUMBER.
 */
async function atender(agi, api, env, o = {}) {
  const uid = env.agi_uniqueid;
  const telefone = /^\+?\d{8,}$/.test(env.agi_callerid ?? '') ? env.agi_callerid : '';
  const set = (nome, valor) => agi.comando(`SET VARIABLE ${nome} ${aspas(valor ?? '')}`);

  const falar = async (texto, audios) => {
    if (o.tts) return agi.comando(`EXEC ${o.tts} ${aspas(texto)}`);
    for (const a of audios) {
      if (typeof a === 'number') await agi.comando(`SAY NUMBER ${a} ""`);
      else await agi.comando(`STREAM FILE zoe/${a} ""`);
    }
    return null;
  };
  /** Fala e espera as teclas (# encerra). */
  const pedir = async (texto, audio, max, tempo = 6000) => {
    if (o.tts) {
      await falar(texto);
      return agi.comando(`GET DATA silence/1 ${tempo} ${max}`);
    }
    return agi.comando(`GET DATA zoe/${audio} ${tempo} ${max}`);
  };

  let iniciado = false;
  let status = 'resolvido';
  try {
    let r;
    try {
      r = await api.iniciar({ uid, telefone });
      iniciado = true;
    } catch {
      await set('ZOE_STATUS', 'indisponivel');
      return 'indisponivel';
    }
    let invalidas = 0;
    // Com TTS o aviso já vem na primeira fala; com áudios gravados, toca antes.
    if (!o.tts) await falar(null, ['aviso']);

    for (let passo = 0; passo < 30; passo++) {
      if (r.etapa === 'documento') {
        const d = await pedir(r.fala, 'digite-documento', 14, 15000);
        r = await api.post(uid, 'documento', { documento: d });
        continue;
      }
      if (r.etapa === 'confirmar') {
        const cpf3 = r.metodo === 'cpf3';
        const d = await pedir(r.fala, cpf3 ? 'digite-cpf3' : 'digite-nascimento', cpf3 ? 3 : 8, 10000);
        r = await api.post(uid, 'confirmar', { codigo: d });
        continue;
      }
      if (r.etapa === 'transferir') {
        await falar(r.fala, ['transferindo']);
        status = 'transferir';
        await set('ZOE_FILA_ID', r.fila?.id ?? '');
        await set('ZOE_FILA_NOME', r.fila?.nome ?? '');
        await set('ZOE_RESUMO', r.resumo ?? '');
        break;
      }
      if (r.etapa !== 'menu') break;

      const opcao = r.opcao ?? await pedir(r.fala, 'menu', 1);
      delete r.opcao;
      if (opcao === '1') {
        const f = await api.get(uid, 'faturas');
        if (f.etapa !== 'menu') { r = f; continue; }
        if (!f.faturas.length) { await falar(f.fala, ['sem-faturas']); break; }
        if (!f.canais.length) { r = await api.post(uid, 'transferir', { motivo: 'financeiro' }); continue; }
        const x = f.faturas[0];
        const audios = ['faturas-abertas', f.faturas.length, 'vence-em', Number(x.vencimento.slice(8, 10)), `mes-${x.vencimento.slice(5, 7)}`,
          'valor-de', Math.floor(x.valor_centavos / 100), 'reais', ...(x.valor_centavos % 100 ? ['e', x.valor_centavos % 100, 'centavos'] : [])];
        await falar(f.fala.replace(/ Para receber.*$/, ''), audios);
        const canalTexto = f.fala.slice(f.fala.indexOf('Para receber'));
        const escolha = o.tts ? await pedir(canalTexto, null, 1) : await (async () => {
          for (const [i, c] of f.canais.entries()) await falar(null, [`canal-${c.canal}`, i + 1]);
          return agi.comando('GET DATA silence/1 6000 1');
        })();
        const canal = f.canais[Number(escolha) - 1];
        if (!canal) { if (++invalidas >= 3) { r = await api.post(uid, 'transferir', { motivo: 'financeiro' }); continue; } r.opcao = '1'; continue; }
        const b = await api.post(uid, 'boleto', { canal: canal.canal, fatura_id: x.id });
        if (b.etapa !== 'menu') { r = b; continue; }
        await falar(b.fala, ['boleto-enviado']);
        break;
      }
      if (opcao === '2') {
        const d = await api.post(uid, 'desbloqueio');
        if (d.etapa !== 'menu') { r = d; continue; }
        const audio = d.liberado ? 'liberado' : { limite: 'desbloqueio-limite', ja_liberado: 'ja-liberado' }[d.motivo] ?? 'desbloqueio-negado';
        const prox = await pedir(d.fala, audio, 1);
        if (prox === '1') { r.opcao = '1'; continue; }
        if (prox === '0') { r = await api.post(uid, 'transferir', { motivo: 'financeiro' }); continue; }
        if (prox === '3') { r = await api.post(uid, 'transferir', { motivo: 'suporte' }); continue; }
        break;
      }
      if (['3', '4', '0'].includes(opcao)) {
        r = await api.post(uid, 'transferir', { motivo: { 3: 'suporte', 4: 'comercial', 0: 'outro' }[opcao] });
        continue;
      }
      // Nada ou tecla inválida: repete o menu; na terceira vez, transfere.
      if (++invalidas >= 3) r = await api.post(uid, 'transferir', { motivo: 'outro' });
    }
    if (status === 'resolvido') await falar('Obrigada por ligar!', ['obrigada']).catch(() => {});
    await set('ZOE_STATUS', status);
    return status;
  } catch (err) {
    if (err instanceof Desligou) return 'desligou';
    // Falha da API no meio da ligação: a ligação segue para o atendimento.
    await set('ZOE_STATUS', 'indisponivel').catch(() => {});
    return 'indisponivel';
  } finally {
    if (iniciado) await api.post(uid, 'fim').catch(() => {});
  }
}

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
  };
}

const DIGITOS = '0123456789*#';

/**
 * Conduz a ligação conversando. Devolve o status deixado no canal (mesmo contrato do modo por
 * teclas: resolvido | transferir | indisponivel | desligou), para o plano de discagem não mudar.
 */
async function conversar(agi, cerebro, env, o = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const uid = env.agi_uniqueid;
  const telefone = /^\+?\d{8,}$/.test(env.agi_callerid ?? '') ? env.agi_callerid : '';
  const set = (nome, valor) => agi.comando(`SET VARIABLE ${nome} ${aspas(valor ?? '')}`);
  const falar = (texto) => (texto ? agi.comando(`EXEC ${o.tts} ${aspas(texto)}`) : null);
  const pasta = o.gravacoes || '/tmp/zoe-falas';
  try { fs.mkdirSync(pasta, { recursive: true }); } catch { /* o RECORD FILE avisa se não der */ }

  /**
   * Ouve o cliente: grava até 2 s de silêncio (máx. 20 s). Se ele apertar uma tecla em vez de
   * falar, a gravação para e o resto do número é lido pelo teclado.
   */
  const ouvir = async (n) => {
    const base = path.join(pasta, `${String(uid).replace(/[^\w.-]/g, '_')}-${n}`);
    const r = Number(await agi.comando(`RECORD FILE ${base} wav "${DIGITOS}" 20000 0 s=2`));
    const arquivo = `${base}.wav`;
    try {
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
      fs.rm(arquivo, { force: true }, () => {});
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
        await set('ZOE_FILA_NOME', r.fila?.nome ?? '');
        await set('ZOE_RESUMO', r.resumo ?? '');
        break;
      }
      if (r.acao === 'encerrar') break;
      const fala = await ouvir(n);
      r = await cerebro.turno(uid, { ...fala, turno_id: String(n) });
    }
    await set('ZOE_STATUS', status);
    return status;
  } catch (err) {
    if (err instanceof Desligou) return 'desligou';
    // O cérebro caiu no meio da ligação: a pessoa vai para a fila, não para o silêncio.
    await set('ZOE_STATUS', iniciado ? 'transferir' : 'indisponivel').catch(() => {});
    if (!iniciado) err.naoIniciou = true;
    if (!iniciado) throw err;
    return 'transferir';
  } finally {
    if (iniciado) await cerebro.fim(uid).catch(() => {});
  }
}

/**
 * Conversado quando dá (cérebro configurado e TTS para falar texto livre); por teclas como reserva.
 * Se o cérebro não responder logo no início, a mesma ligação segue pela URA de teclas.
 */
async function escolherModo(agi, env, { cerebro = null, teclas = null, tts = '', gravacoes } = {}) {
  if (cerebro && tts) {
    try {
      return await conversar(agi, cerebro, env, { tts, gravacoes });
    } catch (err) {
      if (!err.naoIniciou) throw err;
      // Cérebro fora do ar antes de atender: cai para as teclas, sem a pessoa perceber.
    }
  }
  if (teclas) return atender(agi, teclas, env, { tts });
  await agi.comando('SET VARIABLE ZOE_STATUS "indisponivel"').catch(() => {});
  return 'indisponivel';
}

async function principal() {
  const agi = criarAgi(process.stdin, process.stdout);
  const env = await agi.ambiente();
  const base = env.agi_arg_1 || process.env.ZOE_API;
  const chave = env.agi_arg_2 || process.env.ZOE_CHAVE;
  const tts = process.env.ZOE_TTS_APP || '';
  const cerebro = process.env.ZOE_CEREBRO && process.env.ZOE_CEREBRO_CHAVE
    ? criarApiCerebro(process.env.ZOE_CEREBRO, process.env.ZOE_CEREBRO_CHAVE) : null;
  await escolherModo(agi, env, { cerebro, teclas: base && chave ? criarApiZoe(base, chave) : null, tts, gravacoes: process.env.ZOE_GRAVACOES });
  process.exit(0);
}

if (require.main === module) principal();

module.exports = { criarAgi, criarApiZoe, criarApiCerebro, atender, conversar, escolherModo, Desligou };
