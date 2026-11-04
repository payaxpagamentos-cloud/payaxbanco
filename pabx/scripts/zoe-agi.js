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
 * Variáveis de ambiente (ou argumentos do AGI: AGI(zoe-agi.js,URL,CHAVE)):
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

async function principal() {
  const agi = criarAgi(process.stdin, process.stdout);
  const env = await agi.ambiente();
  const base = env.agi_arg_1 || process.env.ZOE_API;
  const chave = env.agi_arg_2 || process.env.ZOE_CHAVE;
  if (!base || !chave) {
    await agi.comando('SET VARIABLE ZOE_STATUS "indisponivel"').catch(() => {});
    process.exit(0);
  }
  await atender(agi, criarApiZoe(base, chave), env, { tts: process.env.ZOE_TTS_APP || '' });
  process.exit(0);
}

if (require.main === module) principal();

module.exports = { criarAgi, criarApiZoe, atender, Desligou };
