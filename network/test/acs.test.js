'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { criarCpeFalso } = require('./cpe-falso');
const acs = require('../server/lib/acs');
const cwmp = require('../server/lib/cwmp');

const SENHA_ACS = 'senha-do-acs-bem-longa';

/*
 * O que estes testes garantem é o que o TR-069 tem de diferente de tudo mais no sistema: quem liga é o
 * aparelho. Então "configurar o Wi-Fi" nunca é síncrono, e a tela não pode dizer que aplicou antes de o
 * aparelho confirmar. O CPE de mentira fala o protocolo de verdade, inclusive o Connection Request com Digest.
 */
async function cenario(api, { modeloDados = 'tr098' } = {}) {
  const admin = await api.login();
  const tk = { admin };
  for (const perfil of ['financeiro', 'noc']) {
    const r = await api.post('/organizacao/usuarios', { nome: `U ${perfil}`, email: `${perfil}.acs@teste.local`, senha: 'senha-teste-123', perfil }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    tk[perfil] = await api.login(`${perfil}.acs@teste.local`, 'senha-teste-123');
  }
  const cfg = await api.put('/cpes/acs', { usuario: 'acs', senha: SENHA_ACS, url: 'https://provedor.exemplo/acs' }, admin);
  assert.equal(cfg.status, 200, JSON.stringify(cfg.dados));
  const cpe = criarCpeFalso({ modeloDados });
  return { tk, admin, cpe, urlAcs: `${api.raiz}/api/acs` };
}

test('ACS: o aparelho liga, se registra e recebe o que estava guardado', async (t) => {
  const api = await iniciar();
  const c = await cenario(api);
  t.after(async () => { await c.cpe.fechar(); await api.fechar(); });

  await t.test('sem a credencial do ACS, o aparelho não entra', async () => {
    const r = await fetch(c.urlAcs, { method: 'POST', body: '' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') ?? '', /Basic/);
    const errada = await c.cpe.conversar(c.urlAcs, { senha: 'senha-errada' });
    assert.equal(errada.autorizado, false);
  });

  await t.test('o primeiro Inform cria o aparelho com o que ele mesmo contou', async () => {
    await c.cpe.ligarChamado(() => {});
    const r = await c.cpe.conversar(c.urlAcs, { senha: SENHA_ACS, evento: '0 BOOTSTRAP' });
    assert.equal(r.autorizado, true);
    // O CPE nunca conta a senha de chamada (ela é de escrita): na primeira conversa o ACS grava a dele,
    // e é isso que depois permite "aplicar agora" em vez de esperar o Inform periódico.
    assert.equal(r.comandos, 1, 'a primeira sessão grava a credencial de chamada');
    assert.equal(r.encerrou, true);
    assert.ok(/ConnectionRequestPassword$/.test(Object.keys(c.cpe.parametros).find((k) => /ConnectionRequestPassword$/.test(k)) ?? ''),
      'a senha de chamada foi gravada no aparelho');
    const lista = await api.get('/cpes', c.tk.financeiro);
    assert.equal(lista.dados.total, 1);
    const cpe = lista.dados.itens[0];
    assert.equal(cpe.chamado_configurado, true, 'o ACS já sabe como fazer este aparelho ligar');
    assert.equal(cpe.serial, 'CPE0001ABC');
    assert.equal(cpe.fabricante, 'Exemplo');
    assert.equal(cpe.modelo, 'RX-1200');
    assert.equal(cpe.modelo_dados, 'tr098');
    assert.equal(cpe.versao_firmware, '1.4.2');
    assert.equal(cpe.ultimo_evento, '0 BOOTSTRAP');
    assert.ok(cpe.url_chamado, 'o endereço de chamada veio do próprio aparelho');
    assert.equal(cpe.senha_chamado_cifrada, undefined, 'nenhum segredo sai na resposta');
  });

  let cpeId;
  await t.test('pedir Wi-Fi bate na porta do aparelho e ele aplica na hora', async () => {
    cpeId = (await api.get('/cpes', c.tk.financeiro)).dados.itens[0].id;
    // Como um CPE de verdade: atendida a chamada, ele abre a sessão com o ACS.
    let conversa = null;
    await c.cpe.fechar();
    await c.cpe.ligarChamado(() => { conversa = c.cpe.conversar(c.urlAcs, { senha: SENHA_ACS, evento: '6 CONNECTION REQUEST' }); });
    // Uma conversa para o ACS aprender o novo endereço de chamada deste aparelho.
    await c.cpe.conversar(c.urlAcs, { senha: SENHA_ACS });

    const r = await api.post(`/cpes/${cpeId}/wifi`, { ssid: 'Casa da Maria', senha: 'senha-nova-123', canal: 11 }, c.tk.financeiro);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.chamada.atendeu, true, 'o aparelho atendeu a chamada');
    assert.match(r.dados.aviso, /atendeu a chamada e está aplicando/);
    assert.equal(r.dados.tarefa.situacao, 'pendente', 'ainda não é "aplicado": só o aparelho confirma isso');

    const resultado = await conversa;
    assert.ok(resultado.comandos >= 2, 'o aparelho recebeu a escrita e a conferência');
    assert.equal(c.cpe.ssid(), 'Casa da Maria');
    assert.equal(c.cpe.senhaWifi(), 'senha-nova-123');
    assert.equal(c.cpe.canal(), '11');
  });

  await t.test('a tarefa só fica concluída depois da confirmação do aparelho', async () => {
    const d = (await api.get(`/cpes/${cpeId}`, c.tk.financeiro)).dados;
    const escrita = d.tarefas.find((x) => x.rpc === 'SetParameterValues');
    assert.equal(escrita.situacao, 'concluida');
    assert.equal(escrita.resultado.aplicado, 'na hora');
    assert.match(escrita.descricao, /Casa da Maria/);
    const conferencia = d.tarefas.find((x) => x.rpc === 'GetParameterValues');
    assert.equal(conferencia.situacao, 'concluida');
    // O retrato do aparelho reflete o que ele devolveu, e a senha do Wi-Fi não é guardada no retrato.
    assert.equal(d.parametros['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'], 'Casa da Maria');
    assert.equal(d.parametros['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase'], undefined);
  });

  await t.test('aparelho fora do ar: o pedido fica guardado e é aplicado no próximo contato', async () => {
    await c.cpe.fechar();
    const r = await api.post(`/cpes/${cpeId}/wifi`, { ssid: 'Casa da Maria 5G' }, c.tk.financeiro);
    assert.equal(r.status, 201);
    assert.equal(r.dados.chamada.atendeu, false);
    assert.match(r.dados.aviso, /Nada foi aplicado ainda/);
    assert.equal(c.cpe.ssid(), 'Casa da Maria', 'o aparelho não mudou: ninguém falou com ele');
    // Mais tarde, o aparelho liga sozinho (Inform periódico) e pega o que estava guardado.
    const conversa = await c.cpe.conversar(c.urlAcs, { senha: SENHA_ACS, evento: '2 PERIODIC' });
    assert.ok(conversa.comandos >= 1);
    assert.equal(c.cpe.ssid(), 'Casa da Maria 5G');
  });

  await t.test('falha do aparelho vira erro legível, não "aplicado"', async () => {
    await c.cpe.ligarChamado(() => {});
    c.cpe.falharProximoSet();
    await api.post(`/cpes/${cpeId}/wifi`, { ssid: 'Nome Invalido' }, c.tk.financeiro);
    await c.cpe.conversar(c.urlAcs, { senha: SENHA_ACS });
    const d = (await api.get(`/cpes/${cpeId}`, c.tk.financeiro)).dados;
    const falhou = d.tarefas.find((x) => x.situacao === 'falhou');
    assert.ok(falhou, 'a tarefa ficou como falhou');
    assert.match(falhou.erro, /9007/);
    assert.notEqual(c.cpe.ssid(), 'Nome Invalido');
  });

  await t.test('reiniciar o aparelho', async () => {
    const r = await api.post(`/cpes/${cpeId}/reiniciar`, {}, c.tk.financeiro);
    assert.equal(r.status, 201);
    await c.cpe.conversar(c.urlAcs, { senha: SENHA_ACS });
    assert.equal(c.cpe.reiniciou, 1);
  });

  await t.test('validação do Wi-Fi antes de incomodar o aparelho', async () => {
    assert.equal((await api.post(`/cpes/${cpeId}/wifi`, {}, c.tk.financeiro)).status, 422);
    assert.equal((await api.post(`/cpes/${cpeId}/wifi`, { senha: 'curta' }, c.tk.financeiro)).status, 422);
    assert.equal((await api.post(`/cpes/${cpeId}/wifi`, { ssid: 'x'.repeat(33) }, c.tk.financeiro)).status, 422);
    assert.equal((await api.post(`/cpes/${cpeId}/wifi`, { canal: 500 }, c.tk.financeiro)).status, 422);
  });

  await t.test('permissões e isolamento', async () => {
    assert.equal((await api.post(`/cpes/${cpeId}/wifi`, { ssid: 'Teste' }, c.tk.noc)).status, 403, 'NOC não mexe no aparelho do assinante');
    assert.equal((await api.get(`/cpes/${cpeId}`, c.tk.noc)).status, 200, 'mas consulta');
    assert.equal((await api.put('/cpes/acs', { usuario: 'x', senha: 'outra-senha-longa' }, c.tk.financeiro)).status, 403);
    const outro = await api.outraOrganizacao();
    assert.equal((await api.get(`/cpes/${cpeId}`, outro)).status, 404);
    assert.equal((await api.get('/cpes', outro)).dados.total, 0);
  });

  await t.test('a senha do ACS tem de ser longa: ela fica em milhares de aparelhos', async () => {
    assert.equal((await api.put('/cpes/acs', { usuario: 'acs', senha: 'curta' }, c.admin)).status, 422);
    const r = await api.put('/cpes/acs', { usuario: 'acs', senha: 'outra-senha-bem-longa' }, c.admin);
    assert.equal(r.status, 200);
    assert.match(r.dados.aviso, /param de falar com o ACS/);
    const log = (await api.get('/organizacao/auditoria?acao=acs_configurado', c.admin)).dados.itens;
    assert.doesNotMatch(JSON.stringify(log), /senha-do-acs|outra-senha/, 'a senha do ACS não entra na auditoria');
  });
});

test('ACS: aparelho que fala o modelo novo (TR-181) é atendido pelos parâmetros dele', async (t) => {
  const api = await iniciar();
  const c = await cenario(api, { modeloDados: 'tr181' });
  t.after(async () => { await c.cpe.fechar(); await api.fechar(); });

  await c.cpe.ligarChamado(() => {});
  await c.cpe.conversar(c.urlAcs, { senha: SENHA_ACS, evento: '0 BOOTSTRAP' });
  const cpe = (await api.get('/cpes', c.tk.financeiro)).dados.itens[0];
  assert.equal(cpe.modelo_dados, 'tr181');

  const r = await api.post(`/cpes/${cpe.id}/wifi`, { ssid: 'Rede Nova', senha: 'senha-do-wifi-1', canal: 36 }, c.tk.financeiro);
  assert.equal(r.status, 201);
  await c.cpe.conversar(c.urlAcs, { senha: SENHA_ACS });
  assert.equal(c.cpe.parametros['Device.WiFi.SSID.1.SSID'], 'Rede Nova', 'escreveu na árvore do TR-181');
  assert.equal(c.cpe.parametros['Device.WiFi.AccessPoint.1.Security.KeyPassphrase'], 'senha-do-wifi-1');
  assert.equal(c.cpe.parametros['Device.WiFi.Radio.1.Channel'], '36');
});

test('ACS: o envelope recebido é tratado como entrada hostil', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const admin = await api.login();
  await api.put('/cpes/acs', { usuario: 'acs', senha: SENHA_ACS }, admin);
  const url = `${api.raiz}/api/acs`;
  const enviar = (corpo) => fetch(url, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`acs:${SENHA_ACS}`).toString('base64')}`, 'Content-Type': 'text/xml' }, body: corpo });

  await t.test('XML com DOCTYPE ou ENTITY é recusado', async () => {
    const ataque = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>&e;</soapenv:Body></soapenv:Envelope>';
    const r = await enviar(ataque);
    assert.equal(r.status, 400);
    const corpo = await r.text();
    assert.doesNotMatch(corpo, /root:|passwd/);
  });

  await t.test('corpo que não é envelope é recusado sem explodir', async () => {
    assert.equal((await enviar('isto não é xml')).status, 400);
    assert.equal((await enviar('<html><body>oi</body></html>')).status, 400);
  });

  await t.test('envelope sem número de série é recusado', async () => {
    const semSerial = '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">'
      + '<soapenv:Header><cwmp:ID>1</cwmp:ID></soapenv:Header><soapenv:Body><cwmp:Inform><DeviceId><Manufacturer>X</Manufacturer></DeviceId>'
      + '<Event><EventStruct><EventCode>2 PERIODIC</EventCode></EventStruct></Event></cwmp:Inform></soapenv:Body></soapenv:Envelope>';
    assert.equal((await enviar(semSerial)).status, 400);
  });

  await t.test('POST vazio sem sessão encerra sem erro', async () => {
    assert.equal((await enviar('')).status, 204);
  });
});

test('ACS: leitura do protocolo', () => {
  assert.equal(cwmp.decodificar('Casa &amp; Cia &lt;5G&gt;'), 'Casa & Cia <5G>');
  assert.equal(cwmp.codificar('Casa & Cia <5G>'), 'Casa &amp; Cia &lt;5G&gt;');
  assert.throws(() => cwmp.conferir('<!DOCTYPE x><Envelope/>'), /não permitida/);
  assert.throws(() => cwmp.conferir('oi'), /envelope SOAP/);
  const env = cwmp.setParameterValues('t1', [{ nome: 'A.B', valor: 'x & y' }, { nome: 'A.C', valor: 7 }]);
  assert.match(env, /<Name>A\.B<\/Name>/);
  assert.match(env, /x &amp; y/);
  assert.match(env, /xsd:unsignedInt/, 'número vai tipado, senão o aparelho recusa');
  assert.equal(cwmp.mensagem(env), 'SetParameterValues');

  // Digest: a resposta tem de bater com o cálculo do RFC 2617.
  const crypto = require('node:crypto');
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const cabecalho = acs.respostaDigest({ desafio: 'Digest realm="cpe", qop="auth", nonce="abc123"', usuario: 'acs', senha: 'segredo', metodo: 'GET', uri: '/cr' });
  const campos = Object.fromEntries([...cabecalho.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]));
  const esperado = md5(`${md5('acs:cpe:segredo')}:abc123:${campos.nc}:${campos.cnonce}:auth:${md5('GET:/cr')}`);
  assert.equal(campos.response, esperado);
});
