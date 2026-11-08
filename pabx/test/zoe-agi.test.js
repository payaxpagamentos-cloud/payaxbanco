'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { iniciar } = require('./helpers');
const { ixcFalso } = require('./ixc-falso');
const { criarAgi, criarApiZoe, atender } = require('../scripts/zoe-agi');

/** Asterisk de mentira: responde aos comandos AGI e "aperta" as teclas da lista em cada GET DATA. */
function asterisk(teclas, { desligarApos = Infinity } = {}) {
  const deAsterisk = new PassThrough();
  const paraAsterisk = new PassThrough();
  const comandos = [];
  const variaveis = {};
  let buffer = '';
  paraAsterisk.setEncoding('utf8');
  paraAsterisk.on('data', (p) => {
    buffer += p;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const cmd = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      comandos.push(cmd);
      if (comandos.length > desligarApos) { deAsterisk.write('HANGUP\n200 result=-1\n'); continue; }
      const sv = cmd.match(/^SET VARIABLE (\w+) "(.*)"$/);
      if (sv) variaveis[sv[1]] = sv[2];
      deAsterisk.write(cmd.startsWith('GET DATA') ? `200 result=${teclas.shift() ?? ''} (timeout)\n` : '200 result=0\n');
    }
  });
  return { agi: criarAgi(deAsterisk, paraAsterisk), comandos, variaveis };
}

test('URA por teclas da ZOE (AGI)', async (t) => {
  const api = await iniciar();
  const ixc = await ixcFalso();
  t.after(async () => { await api.fechar(); await ixc.fechar(); });
  const master = await api.login();
  const empresa = (await api.post('/master/empresas', {
    nome: 'Provedor AGI', administrador: { nome: 'G', email: 'g@agi.net', senha: 'senha-do-g-agi' },
  }, master)).dados.id;
  const gestor = await api.login('g@agi.net', 'senha-do-g-agi');
  const chave = (await api.post(`/empresas/${empresa}/chaves`, { nome: 'Asterisk' }, gestor)).dados.chave;
  const base = `${api.base}/integracao`;
  const zoe = criarApiZoe(base, chave);

  await t.test('ZOE desligada: a central segue o plano normal', async () => {
    const a = asterisk([]);
    assert.equal(await atender(a.agi, zoe, { agi_uniqueid: 'a0', agi_callerid: '11987654321' }), 'indisponivel');
    assert.equal(a.variaveis.ZOE_STATUS, 'indisponivel');
  });

  const fila = (await api.post(`/empresas/${empresa}/filas`, { nome: 'Suporte N1' }, gestor)).dados.id;
  assert.equal((await api.put(`/empresas/${empresa}/zoe`, { ativo: true, ixc_url: ixc.url, ixc_token: ixc.estado.token, fila_suporte_id: fila }, gestor)).status, 200);

  await t.test('confirma, libera em confiança e envia o boleto por SMS', async () => {
    // 529 = CPF; 2 = desbloqueio; 1 = boleto depois de liberar; 1 = primeiro canal (SMS).
    const a = asterisk(['529', '2', '1', '1']);
    const status = await atender(a.agi, zoe, { agi_uniqueid: 'a1', agi_callerid: '11987654321' });
    assert.equal(status, 'resolvido');
    assert.equal(a.variaveis.ZOE_STATUS, 'resolvido');
    assert.ok(a.comandos.includes('STREAM FILE zoe/aviso ""'));
    assert.ok(a.comandos.includes('GET DATA zoe/digite-cpf3 10000 3'));
    assert.ok(a.comandos.includes('SAY NUMBER 99 ""'), 'fala o valor');
    assert.ok(a.comandos.includes('STREAM FILE zoe/canal-sms ""'));
    assert.ok(ixc.estado.pedidos.some((p) => p.recurso === 'desbloqueio_confianca'));
    assert.ok(ixc.estado.pedidos.some((p) => p.recurso === 'get_boleto' && p.corpo.tipo_boleto === 'sms'));
    const at = api.db.prepare("SELECT resultado, fim FROM zoe_atendimentos WHERE uid = 'a1'").get();
    assert.equal(at.resultado, 'resolvido');
    assert.ok(at.fim, 'o atendimento é encerrado');
  });

  await t.test('com TTS, fala o texto da API; tecla 3 transfere para o suporte com resumo', async () => {
    const a = asterisk(['529', '3']);
    const status = await atender(a.agi, zoe, { agi_uniqueid: 'a2', agi_callerid: '11987654321' }, { tts: 'Flite' });
    assert.equal(status, 'transferir');
    assert.ok(a.comandos.some((c) => /^EXEC Flite ".*três primeiros números/.test(c)));
    assert.equal(a.variaveis.ZOE_FILA_ID, String(fila));
    assert.equal(a.variaveis.ZOE_FILA_NOME, 'Suporte N1');
    assert.match(a.variaveis.ZOE_RESUMO, /MARIA DA SILVA.*pediu: suporte/);
  });

  await t.test('cliente desliga no meio: o atendimento é encerrado mesmo assim', async () => {
    const a = asterisk(['529'], { desligarApos: 3 });
    assert.equal(await atender(a.agi, zoe, { agi_uniqueid: 'a3', agi_callerid: '11987654321' }), 'desligou');
    assert.equal(api.db.prepare("SELECT etapa FROM zoe_atendimentos WHERE uid = 'a3'").get().etapa, 'encerrado');
  });

  await t.test('sem resposta no menu três vezes: transfere', async () => {
    const a = asterisk(['529', '', '9', '']);
    assert.equal(await atender(a.agi, zoe, { agi_uniqueid: 'a4', agi_callerid: '11987654321' }), 'transferir');
  });
});
