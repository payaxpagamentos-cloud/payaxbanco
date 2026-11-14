'use strict';
/**
 * A ponte com o Asterisk (zoe-central): a configuração gerada, o cliente do AMI, o caminho das
 * ligações até a ZOE (com a ZOE de verdade no ar) e a URA conduzida pelo AGI.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const h = require('./helpers');
const { criarApp } = require('../server/app');
const { gerar, ramalDoCanal, ramalDoAor } = require('../scripts/central/gerar');
const { Ami, lerBloco } = require('../scripts/central/ami');
const { criarPonte, opcoesDaConf, chavesDaConf } = require('../scripts/zoe-central');
const { criarAgi, conduzirUra, destinoDaOpcao, conversar } = require('../scripts/zoe-agi');

const CFG = {
  empresa: { id: 3, nome: 'Fibra Mais', limite_canais: 10, gravar_chamadas: true },
  terminacao: { id: 1, nome: 'Operadora', host: 'sip.op.exemplo', porta: 5060, prefixo: '0' },
  ramais: [
    { id: 11, numero: '1001', nome: 'Marina\n[geral];x', senha_sip: 's3nha', gravar: true },
    { id: 12, numero: '1002', nome: 'Rafael', senha_sip: 'x', gravar: false },
  ],
  numeros: [{ id: 1, numero: '1130001000', destino_tipo: 'ura', destino_id: 7 }, { id: 2, numero: '1130001001', destino_tipo: 'zoe', destino_id: null }],
  filas: [{ id: 5, nome: 'Suporte', estrategia: 'menos_chamadas', espera_maxima_s: 90, ramais: ['1001', '1002'] }],
  uras: [{ id: 7, nome: 'Principal', tipo: 'inteligente', mensagem: 'Olá', opcoes: [], tecla_atendente: '0', fila_padrao_id: 5 }],
};

describe('configuração do Asterisk gerada a partir da ZOE', () => {
  test('ramais, tronco, filas e números', () => {
    const f = gerar([CFG], { troncos: { 1: { usuario: 'conta', senha: 'sec', registro: true } } });
    const pj = f['pjsip_zoe.conf'];
    assert.match(pj, /^\[3_1001\]\ntype=endpoint/m);
    assert.match(pj, /password=s3nha/);
    assert.match(pj, /set_var=__ZOE_EMPRESA=3/);
    assert.match(pj, /set_var=ZOE_GRAVAR=1/);
    assert.match(pj, /\[3_1002\][\s\S]*?set_var=ZOE_GRAVAR=0/, 'o ramal sem gravação não grava');
    assert.doesNotMatch(pj, /\[3_1001w\]/, 'sem WebRTC, sem o cadastro do navegador');
    assert.match(pj, /callerid="Marina geral x" <1001>/, 'nome sem quebra de linha nem colchete');
    assert.doesNotMatch(pj, /^\[geral\]/m);
    assert.match(pj, /\[zoe-tronco-1-registro\]\ntype=registration/);
    assert.match(pj, /username=conta\npassword=sec/);
    const filas = f['queues_zoe.conf'];
    assert.match(filas, /\[zoe-e3-f5\]\nstrategy=fewestcalls/);
    assert.match(filas, /member => PJSIP\/3_1002,0,Rafael,PJSIP\/3_1002/);
    const plano = f['extensions_zoe.conf'];
    for (const forma of ['1130001000', '551130001000', '+551130001000', '01130001000']) {
      assert.ok(plano.includes(`exten => ${forma},1,Goto(zoe-did,1130001000,1)`), `o número chega como ${forma}`);
    }
    assert.match(plano, /exten => 1130001000,1,Set\(ZOE_EMPRESA=3\)\n same => n,Gosub\(zoe-inicio,s,1\(entrada,\$\{FILTER\(0-9\+,\$\{CALLERID\(num\)\}\)\},1130001000,10,1\)\)\n same => n,Goto\(zoe-e3-destinos,ura-7,1\)/);
    assert.match(plano, /Goto\(zoe-e3-destinos,zoe,1\)/);
    assert.match(plano, /exten => 1001,1,Gosub\(zoe-inicio,s,1\(interna,\$\{ZOE_RAMAL\},1001,10,\$\{ZOE_GRAVAR\}\)\)\n same => n,Goto\(zoe-e3-destinos,ramal-11,1\)/);
    assert.match(plano, /Dial\(PJSIP\/0\$\{EXTEN\}@zoe-tronco-1,60,U\(zoe-atendeu\)\)/, 'saída com o prefixo da rota');
    assert.match(plano, /Set\(CALLERID\(num\)=1130001000\)/, 'sai com o primeiro número da empresa');
    assert.match(plano, /exten => fila-5,1,Queue\(zoe-e3-f5,t,,,90,,,zoe-atendeu\)/);
    assert.match(plano, /exten => ura-7,1,Answer\(\)\n same => n,AGI\(\/usr\/local\/bin\/zoe-agi,ura,7\)/);
    assert.match(plano, /exten => padrao,1,Goto\(fila-5,1\)/);
    assert.match(plano, /GROUP_COUNT\(e\$\{ZOE_EMPRESA\}@zoe\)\} > \$\{ARG4\}/, 'limite de simultâneas no próprio Asterisk');
    assert.match(plano, /exten => _X\.,1,Hangup\(1\)/, 'número que não é da ZOE é recusado');
  });

  test('com WebRTC, cada ramal ganha o cadastro do navegador, e os dois tocam', () => {
    const f = gerar([CFG], { webrtc: true });
    assert.match(f['pjsip_zoe.conf'], /\[3_1001w\]\ntype=endpoint\nwebrtc=yes/);
    assert.match(f['extensions_zoe.conf'], /Dial\(PJSIP\/3_1001&PJSIP\/3_1001w,30,U\(zoe-atendeu\)\)/);
    assert.match(f['queues_zoe.conf'], /member => PJSIP\/3_1001w,0,/);
  });

  test('empresa sem rota de saída não liga para fora; destino apagado vira "fim"', () => {
    const f = gerar([{ ...CFG, terminacao: null, numeros: [{ id: 9, numero: '1130009999', destino_tipo: 'fila', destino_id: 999 }] }]);
    assert.match(f['extensions_zoe.conf'], /exten => _XXXXXXX\.,1,Hangup\(1\)/);
    assert.match(f['extensions_zoe.conf'], /Goto\(zoe-e3-destinos,fim,1\)/);
    assert.doesNotMatch(f['pjsip_zoe.conf'], /zoe-tronco/);
  });

  test('canal e AOR viram empresa e ramal', () => {
    assert.deepEqual(ramalDoCanal('PJSIP/3_1001w-0000002a'), { empresa: 3, ramal: '1001', web: true });
    assert.equal(ramalDoCanal('PJSIP/zoe-tronco-1-00000001'), null);
    assert.deepEqual(ramalDoAor('12_2001'), { empresa: 12, ramal: '2001', web: false });
    assert.deepEqual(chavesDaConf({ ZOE_CHAVE: 'a', ZOE_CHAVE_3: 'b', ZOE_URL: 'x', ZOE_CHAVE_7: 'a' }), ['a', 'b']);
    assert.deepEqual(opcoesDaConf({ TRONCO_2_USUARIO: 'u', TRONCO_2_SENHA: 's', TRONCO_2_REGISTRO: '1', ZOE_WEBRTC: '1' }).troncos, { 2: { usuario: 'u', senha: 's', registro: true } });
  });
});

describe('cliente do AMI', () => {
  test('login, comando, lista e eventos', async (t) => {
    const recebidos = [];
    const srv = net.createServer((s) => {
      s.write('Asterisk Call Manager/7.0.3\r\n');
      let buf = '';
      s.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
          const m = lerBloco(buf.slice(0, i));
          buf = buf.slice(i + 4);
          recebidos.push(m);
          if (m.action === 'Login') {
            s.write(`Response: ${m.secret === 'certa' ? 'Success' : 'Error'}\r\nActionID: ${m.actionid}\r\nMessage: x\r\n\r\n`);
            if (m.secret === 'certa') s.write('Event: UserEvent\r\nUserEvent: ZoeInicio\r\nuid: 1.2\r\n\r\n');
          } else if (m.action === 'Command') {
            s.write(`Response: Success\r\nActionID: ${m.actionid}\r\nOutput: ok\r\n\r\n`);
          } else if (m.action === 'PJSIPShowContacts') {
            s.write(`Response: Success\r\nActionID: ${m.actionid}\r\nEventList: start\r\n\r\n`);
            s.write(`Event: ContactList\r\nActionID: ${m.actionid}\r\nAor: 3_1001\r\nStatus: Reachable\r\n\r\n`);
            s.write(`Event: ContactListComplete\r\nActionID: ${m.actionid}\r\nEventList: Complete\r\n\r\n`);
          }
        }
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const ami = new Ami({ porta: srv.address().port, usuario: 'zoe', senha: 'certa', reconectarMs: 50 });
    t.after(() => { ami.parar(); srv.closeAllConnections?.(); return new Promise((r) => srv.close(r)); });
    const eventos = [];
    ami.on('evento', (e) => eventos.push(e));
    const conectou = new Promise((r) => ami.once('conectado', r));
    ami.iniciar();
    await conectou;
    assert.equal((await ami.comando('dialplan reload')).response, 'Success');
    const lista = await ami.acao({ Action: 'PJSIPShowContacts' });
    assert.deepEqual(lista.eventos.map((e) => [e.aor, e.status]), [['3_1001', 'Reachable']]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(eventos[0].userevent, 'ZoeInicio');
    assert.equal(recebidos.find((m) => m.action === 'Command').command, 'dialplan reload');
  });

  test('senha errada: não fica conectado e avisa', async (t) => {
    const srv = net.createServer((s) => s.on('data', (d) => {
      const m = lerBloco(String(d));
      if (m.actionid) s.write(`Response: Error\r\nActionID: ${m.actionid}\r\nMessage: Authentication failed\r\n\r\n`);
    }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const ami = new Ami({ porta: srv.address().port, usuario: 'zoe', senha: 'errada', reconectarMs: 10_000 });
    t.after(() => { ami.parar(); return new Promise((r) => srv.close(r)); });
    const erro = new Promise((r) => ami.once('erro', r));
    ami.iniciar();
    assert.match((await erro).message, /Authentication failed/);
    assert.equal(ami.conectado, false);
  });
});

describe('ponte: do Asterisk até a ZOE (com a ZOE no ar)', () => {
  let servidor;
  let db;
  let empresa;
  let base;
  let chave;
  let pasta;
  const req = async (metodo, caminho, corpo, tk) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await r.text();
    try { return { status: r.status, dados: JSON.parse(texto) }; } catch { return { status: r.status, dados: texto }; }
  };
  /** O Asterisk de mentira: recarregas anotadas e a lista de contatos registrada. */
  const amiFalso = () => Object.assign(new EventEmitter(), {
    conectado: true, comandos: [], contatos: [],
    comando(c) { this.comandos.push(c); return Promise.resolve({ response: 'Success' }); },
    acao(a) { return Promise.resolve({ response: 'Success', eventos: a.Action === 'PJSIPShowContacts' ? this.contatos : [] }); },
  });

  test('preparar: ZOE com telefonia, ramais, fila, número na ZOE e chave da central', async () => {
    h.fingirMeta();
    let filas;
    ({ db, empresa, filas } = h.criarAmbiente());
    servidor = criarApp(db).listen(0);
    await new Promise((r) => servidor.once('listening', r));
    base = `http://127.0.0.1:${servidor.address().port}`;
    const master = (await req('POST', '/api/auth/login', { email: 'master@atendimento.com.br', senha: 'master123' })).dados.token;
    const admin = (await req('POST', '/api/auth/login', { email: 'carlos@fibramais.com.br', senha: 'senha12345' })).dados.token;
    await req('POST', '/api/master/telefonia/troncos', { nome: 'Operadora', host: 'sip.op.exemplo', usuario: 'conta', senha: 'segredo' }, master);
    const tronco = (await req('GET', '/api/master/telefonia/troncos', undefined, master)).dados[0].id;
    await req('PUT', `/api/master/telefonia/empresas/${empresa.id}`, { telefonia_ativa: true, limite_ramais: 5, limite_canais: 4, tronco_id: tronco, tarifa_movel_centavos: 30 }, master);
    const tel = (c) => `/api/empresas/${empresa.id}/telefonia${c}`;
    const r1 = (await req('POST', tel('/ramais'), { numero: '1001', nome: 'Marina' }, admin)).dados.id;
    await req('PUT', tel(`/filas/${filas[0].id}`), { ramais: [r1] }, admin);
    await req('POST', '/api/master/telefonia/numeros', { numeros: '1130001000', tronco_id: tronco, empresa_id: empresa.id }, master);
    const n = (await req('GET', tel('/numeros'), undefined, admin)).dados[0];
    assert.equal((await req('PATCH', tel(`/numeros/${n.id}`), { destino_tipo: 'zoe' }, admin)).status, 204);
    chave = (await req('POST', '/api/master/telefonia/chaves', { empresa_id: empresa.id, nome: 'Asterisk' }, master)).dados.chave;
    assert.match(chave, /^cen_/);
    pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'zoe-central-'));
  });

  test('sincroniza: escreve os três arquivos, recarrega o Asterisk e, sem mudança, não mexe de novo', async () => {
    const ami = amiFalso();
    const ponte = criarPonte({ conf: { ZOE_URL: base, ZOE_CHAVE: chave, TRONCO_1_USUARIO: 'conta', TRONCO_1_SENHA: 'segredo' }, ami, pasta, log: () => {} });
    const r = await ponte.sincronizar();
    assert.deepEqual(r.mudaram.sort(), ['extensions_zoe.conf', 'pjsip_zoe.conf', 'queues_zoe.conf']);
    assert.deepEqual(ami.comandos.sort(), ['dialplan reload', 'module reload app_queue.so', 'module reload res_pjsip.so']);
    const plano = fs.readFileSync(path.join(pasta, 'extensions_zoe.conf'), 'utf8');
    assert.match(plano, new RegExp(`Goto\\(zoe-e${empresa.id}-destinos,zoe,1\\)`), 'o número cai na ZOE');
    assert.match(fs.readFileSync(path.join(pasta, 'pjsip_zoe.conf'), 'utf8'), new RegExp(`\\[${empresa.id}_1001\\]`));
    assert.equal((fs.statSync(path.join(pasta, 'pjsip_zoe.conf')).mode & 0o777), 0o640, 'senhas SIP: só root e o grupo do Asterisk leem');
    ami.comandos.length = 0;
    assert.deepEqual((await ponte.sincronizar()).mudaram, []);
    assert.deepEqual(ami.comandos, []);
  });

  test('uma ligação de ponta a ponta: início, atendida pelo ramal, fim — e a ZOE fica sabendo de tudo', async () => {
    const ami = amiFalso();
    const ponte = criarPonte({ conf: { ZOE_URL: base, ZOE_CHAVE: chave }, ami, pasta, log: () => {} });
    await ponte.sincronizar({ escrever: false });
    const e = String(empresa.id);
    await ponte.tratarEvento({ event: 'UserEvent', userevent: 'ZoeInicio', empresa: e, uid: '1700.1', direcao: 'entrada', origem: '11988887777', destino: '1130001000' });
    let c = db.prepare('SELECT * FROM pabx_chamadas WHERE uid = ?').get('1700.1');
    assert.equal(c.direcao, 'entrada');
    assert.equal(c.fim, null, 'em curso');
    await ponte.tratarEvento({ event: 'UserEvent', userevent: 'ZoeAtendida', empresa: e, uid: '1700.1', canal: `PJSIP/${e}_1001-00000003` });
    await ponte.tratarEvento({ event: 'UserEvent', userevent: 'ZoeFim', empresa: e, uid: '1700.1', dialstatus: '', queuestatus: 'COMPLETECALLER', zoe: 'transferir' });
    c = db.prepare('SELECT * FROM pabx_chamadas WHERE uid = ?').get('1700.1');
    assert.equal(c.status, 'atendida');
    assert.ok(c.atendida_em && c.fim);
  });

  test('ligação de saída ocupada e ligação resolvida pela ZOE', async () => {
    const ponte = criarPonte({ conf: { ZOE_URL: base, ZOE_CHAVE: chave }, ami: amiFalso(), pasta, log: () => {} });
    await ponte.sincronizar({ escrever: false });
    const e = String(empresa.id);
    await ponte.tratarEvento({ event: 'UserEvent', userevent: 'ZoeInicio', empresa: e, uid: '1700.2', direcao: 'saida', origem: '1001', destino: '11977776666' });
    await ponte.tratarEvento({ event: 'UserEvent', userevent: 'ZoeFim', empresa: e, uid: '1700.2', dialstatus: 'BUSY' });
    assert.equal(db.prepare('SELECT status FROM pabx_chamadas WHERE uid = ?').get('1700.2').status, 'ocupado');
    await ponte.tratarEvento({ event: 'UserEvent', userevent: 'ZoeInicio', empresa: e, uid: '1700.3', direcao: 'entrada', origem: '11955554444', destino: '1130001000' });
    await ponte.tratarEvento({ event: 'UserEvent', userevent: 'ZoeFim', empresa: e, uid: '1700.3', zoe: 'resolvido' });
    assert.equal(db.prepare('SELECT status FROM pabx_chamadas WHERE uid = ?').get('1700.3').status, 'atendida', 'a ZOE resolveu: foi atendida');
  });

  test('ramal registrado no Asterisk aparece online na ZOE; o navegador e o aparelho contam juntos', async () => {
    const ami = amiFalso();
    const ponte = criarPonte({ conf: { ZOE_URL: base, ZOE_CHAVE: chave }, ami, pasta, log: () => {} });
    await ponte.sincronizar({ escrever: false });
    const e = empresa.id;
    const online = () => db.prepare("SELECT online FROM pabx_ramais WHERE numero = '1001' AND empresa_id = ?").get(e).online;
    await ponte.tratarEvento({ event: 'ContactStatus', aor: `${e}_1001`, contactstatus: 'Created', uri: 'sip:x@200.1.2.3:5060', useragent: 'Yealink' });
    assert.equal(online(), 1);
    assert.equal(db.prepare("SELECT registro_ip FROM pabx_ramais WHERE numero = '1001' AND empresa_id = ?").get(e).registro_ip, '200.1.2.3');
    await ponte.tratarEvento({ event: 'ContactStatus', aor: `${e}_1001w`, contactstatus: 'Created' });
    await ponte.tratarEvento({ event: 'ContactStatus', aor: `${e}_1001`, contactstatus: 'Removed' });
    assert.equal(online(), 1, 'ainda online pelo navegador');
    await ponte.tratarEvento({ event: 'ContactStatus', aor: `${e}_1001w`, contactstatus: 'Removed' });
    assert.equal(online(), 0);
    // Ao reconectar, a lista do Asterisk vale.
    ami.contatos = [{ aor: `${e}_1001`, status: 'Reachable' }];
    await ponte.renovarRegistros();
    await ponte.enviar();
    assert.equal(online(), 1);
  });

  test('ZOE fora do ar: a ponte guarda e manda depois, na ordem e com a hora certa', async () => {
    let fora = true;
    const fetchFalso = (url, o) => (fora ? Promise.reject(new Error('ECONNREFUSED')) : fetch(url, o));
    const ponte = criarPonte({ conf: { ZOE_URL: base, ZOE_CHAVE: chave }, ami: amiFalso(), pasta, fetch: fetchFalso, log: () => {} });
    fora = false;
    await ponte.sincronizar({ escrever: false });
    fora = true;
    const e = String(empresa.id);
    await ponte.tratarEvento({ event: 'UserEvent', userevent: 'ZoeInicio', empresa: e, uid: '1700.9', direcao: 'interna', origem: '1001', destino: '1002' });
    await ponte.tratarEvento({ event: 'UserEvent', userevent: 'ZoeFim', empresa: e, uid: '1700.9', dialstatus: 'NOANSWER' });
    assert.equal(ponte.fila.length, 2);
    assert.equal(db.prepare('SELECT 1 FROM pabx_chamadas WHERE uid = ?').get('1700.9'), undefined);
    fora = false;
    await ponte.enviar();
    assert.equal(ponte.fila.length, 0);
    const c = db.prepare('SELECT * FROM pabx_chamadas WHERE uid = ?').get('1700.9');
    assert.equal(c.status, 'nao_atendida');
    assert.ok(c.fim, 'o fim chegou depois do início');
  });

  test('chave revogada: a empresa sai da central, sem derrubar a ponte', async () => {
    const ponte = criarPonte({ conf: { ZOE_URL: base, ZOE_CHAVE: 'cen_nao_existe' }, ami: amiFalso(), pasta: fs.mkdtempSync(path.join(os.tmpdir(), 'zoe-central-')), log: () => {} });
    const r = await ponte.sincronizar();
    assert.equal(ponte.chavePorEmpresa.size, 0);
    assert.doesNotMatch(r.arquivos['pjsip_zoe.conf'], /type=endpoint/);
  });

  test('encerrar', () => {
    servidor.close();
    fs.rmSync(pasta, { recursive: true, force: true });
  });
});

describe('URA pelo AGI', () => {
  /** Asterisk de mentira para a URA: GET DATA devolve as teclas do roteiro; SET VARIABLE é anotado. */
  function asterisk(teclas) {
    const de = new PassThrough();
    const para = new PassThrough();
    const vars = {};
    let buf = '';
    para.setEncoding('utf8');
    para.on('data', (p) => {
      buf += p;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const cmd = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const sv = cmd.match(/^SET VARIABLE (\w+) "(.*)"$/);
        if (sv) vars[sv[1]] = sv[2];
        if (cmd.startsWith('GET DATA')) de.write(`200 result=${teclas.shift() ?? ''}\n`);
        else if (cmd.startsWith('GET VARIABLE ZOE_CHAMADA')) de.write('200 result=1 (1700.50)\n');
        else de.write('200 result=0\n');
      }
    });
    return { agi: criarAgi(de, para), vars };
  }
  const falas = [];
  const falar = async (t) => { falas.push(t); return ''; };
  const env = { agi_uniqueid: '1700.50', agi_callerid: '11988887777' };

  test('menu: a tecla escolhida vira o destino', async () => {
    const a = asterisk(['2']);
    const central = { atender: async () => ({ fase: 'menu', fala: 'Digite 1 ou 2', opcoes: [{ digito: '1', acao: 'fila', destino_id: 5 }, { digito: '2', acao: 'zoe' }, { digito: '0', acao: 'fila', destino_id: 5 }] }) };
    assert.equal(await conduzirUra(a.agi, env, central, 7, { falar }), 'zoe');
    assert.equal(a.vars.ZOE_DESTINO, 'zoe');
  });

  test('inteligente: confirma os 3 dígitos e a segunda via vai para a ZOE já com o pedido', async () => {
    const a = asterisk(['123', '1']);
    const pedidos = [];
    const central = {
      atender: async (id, corpo) => { pedidos.push(['atender', id, corpo]); return { fase: 'confirmar', fala: 'Digite os três primeiros…', opcoes: [{ digito: '0', acao: 'fila', destino_id: 5 }] }; },
      confirmado: async (id, corpo) => { pedidos.push(['confirmado', id, corpo]); return { confirmado: true, fase: 'oferta', fala: 'Oi, Ana! Fatura em aberto.', opcoes: [{ digito: '1', acao: 'segunda_via' }, { digito: '0', acao: 'fila', destino_id: 5 }] }; },
    };
    assert.equal(await conduzirUra(a.agi, env, central, 7, { falar }), 'zoe');
    assert.equal(a.vars.ZOE_PEDIDO, 'Quero a segunda via da minha fatura.');
    assert.deepEqual(pedidos[0], ['atender', 7, { uid: '1700.50', telefone: '11988887777' }], 'o uid é o da chamada, o mesmo da tarifação');
    assert.deepEqual(pedidos[1][2], { uid: '1700.50', codigo: '123' });
  });

  test('três vezes sem resposta: vai para o atendente; ZOE fora do ar: fila padrão', async () => {
    const a = asterisk(['', '9', '']);
    const central = { atender: async () => ({ fase: 'menu', fala: 'Menu', opcoes: [{ digito: '1', acao: 'ura', destino_id: 2 }, { digito: '0', acao: 'fila', destino_id: 8 }] }) };
    assert.equal(await conduzirUra(a.agi, env, central, 7, { falar }), 'fila-8');
    const b = asterisk([]);
    assert.equal(await conduzirUra(b.agi, env, { atender: async () => { throw new Error('fora'); } }, 7, { falar }), 'padrao');
    const c = asterisk([]);
    assert.equal(await conduzirUra(c.agi, env, { atender: async () => ({}) }, 7, { falar: null }), 'padrao', 'sem fala configurada, nem tenta');
  });

  test('opções viram destinos do plano de discagem', () => {
    assert.deepEqual(destinoDaOpcao({ acao: 'ramal', destino_id: 11 }), { destino: 'ramal-11' });
    assert.deepEqual(destinoDaOpcao({ acao: 'fila', destino_id: null }), { destino: 'padrao' });
    assert.deepEqual(destinoDaOpcao({ acao: 'encerrar' }), { destino: 'fim' });
    assert.deepEqual(destinoDaOpcao({ acao: 'desbloqueio' }).destino, 'zoe');
  });

  test('a ZOE começa pelo pedido que veio da URA, sem a saudação', async () => {
    const a = asterisk([]);
    const turnos = [];
    const cerebro = {
      iniciar: async () => ({ acao: 'ouvir', fala: 'Olá! Sou a ZOE.' }),
      turno: async (uid, corpo) => { turnos.push(corpo); return { acao: 'encerrar', fala: 'Mandei a segunda via no seu WhatsApp.' }; },
      fim: async () => ({}),
    };
    const ditas = [];
    await conversar(a.agi, cerebro, env, { falar: async (t) => { ditas.push(t); }, pedido: 'Quero a segunda via da minha fatura.' });
    assert.deepEqual(turnos, [{ texto: 'Quero a segunda via da minha fatura.', turno_id: '0' }]);
    assert.deepEqual(ditas, ['Mandei a segunda via no seu WhatsApp.']);
  });
});
