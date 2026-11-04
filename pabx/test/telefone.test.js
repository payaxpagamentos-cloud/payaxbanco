'use strict';

// O telefone do painel só liga com o endereço WSS do Asterisk configurado no servidor.
process.env.PABX_WEBRTC_WSS = 'wss://pbx.exemplo.com.br:8089/ws';
process.env.PABX_SIP_DOMINIO = 'pbx.exemplo.com.br';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

test('telefone do painel', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  const master = await api.login();
  const empresa = (await api.post('/master/empresas', {
    nome: 'Central Fone', administrador: { nome: 'Adm', email: 'adm@fone.com', senha: 'senha-do-adm' },
  }, master)).dados.id;
  const outra = (await api.post('/master/empresas', { nome: 'Outra Fone' }, master)).dados.id;
  const adm = await api.login('adm@fone.com', 'senha-do-adm');
  const r100 = (await api.post(`/empresas/${empresa}/ramais`, { numero: '100', nome: 'Marcos' }, adm)).dados.id;
  const r101 = (await api.post(`/empresas/${empresa}/ramais`, { numero: '101', nome: 'Juliana' }, adm)).dados.id;
  const rOutra = (await api.post(`/empresas/${outra}/ramais`, { numero: '100', nome: 'Alheio' }, master)).dados.id;

  await t.test('cabeçalhos: microfone liberado e o Asterisk no connect-src', async () => {
    const r = await api.get('/saude');
    assert.match(r.headers.get('content-security-policy'), /connect-src 'self' wss:\/\/pbx\.exemplo\.com\.br:8089;/);
    assert.match(r.headers.get('permissions-policy'), /microphone=\(self\)/);
  });

  await t.test('sem ramal ligado, o telefone avisa e não entrega senha', async () => {
    const r = await api.get(`/empresas/${empresa}/telefone`, adm);
    assert.equal(r.status, 200);
    assert.equal(r.dados.configurado, true);
    assert.equal(r.dados.ramal, null);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  let sup;
  await t.test('o administrador liga um ramal a cada usuário (um usuário por ramal)', async () => {
    const eu = (await api.get(`/empresas/${empresa}/usuarios`, adm)).dados[0];
    assert.equal((await api.patch(`/empresas/${empresa}/usuarios/${eu.id}`, { ramal_id: rOutra }, adm)).status, 422, 'ramal de outra empresa não');
    assert.equal((await api.patch(`/empresas/${empresa}/usuarios/${eu.id}`, { ramal_id: r100 }, adm)).status, 204);
    const criado = await api.post(`/empresas/${empresa}/usuarios`, { nome: 'Sup', email: 'sup@fone.com', perfil: 'supervisor', senha: 'senha-do-sup', ramal_id: r100 }, adm);
    assert.equal(criado.status, 422, 'o mesmo ramal não vai para dois usuários');
    assert.match(criado.dados.erro, /já é usado por Adm/);
    assert.equal((await api.post(`/empresas/${empresa}/usuarios`, { nome: 'Sup', email: 'sup@fone.com', perfil: 'supervisor', senha: 'senha-do-sup', ramal_id: r101 }, adm)).status, 201);
    sup = await api.login('sup@fone.com', 'senha-do-sup');
    const lista = (await api.get(`/empresas/${empresa}/usuarios`, adm)).dados;
    assert.deepEqual(lista.map((u) => [u.nome, u.ramal]), [['Adm', '100'], ['Sup', '101']]);
  });

  await t.test('cada usuário recebe só a senha SIP do próprio ramal', async () => {
    const a = (await api.get(`/empresas/${empresa}/telefone`, adm)).dados;
    assert.equal(a.wss, 'wss://pbx.exemplo.com.br:8089/ws');
    assert.equal(a.dominio, 'pbx.exemplo.com.br');
    assert.equal(a.ramal.numero, '100');
    assert.equal(a.ramal.usuario_sip, `${empresa}_100`);
    const sip = (await api.get(`/empresas/${empresa}/ramais/${r100}/sip`, adm)).dados;
    assert.equal(a.ramal.senha_sip, sip.senha);
    const s = (await api.get(`/empresas/${empresa}/telefone`, sup)).dados;
    assert.equal(s.ramal.numero, '101');
    assert.notEqual(s.ramal.senha_sip, a.ramal.senha_sip);
    assert.equal((await api.get(`/empresas/${outra}/telefone`, sup)).status, 404);
    // O master entra no painel da empresa, mas não tem ramal.
    assert.equal((await api.get(`/empresas/${empresa}/telefone`, master)).dados.ramal, null);
  });

  await t.test('ramal excluído ou desativado sai do telefone', async () => {
    assert.ok([200, 204].includes((await api.del(`/empresas/${empresa}/ramais/${r101}`, undefined, adm)).status));
    assert.equal((await api.get(`/empresas/${empresa}/telefone`, sup)).dados.ramal, null);
    assert.equal(api.db.prepare("SELECT ramal_id FROM usuarios WHERE email = 'sup@fone.com'").get().ramal_id, null);
    const eu = (await api.get(`/empresas/${empresa}/usuarios`, adm)).dados.find((u) => u.nome === 'Adm');
    assert.equal((await api.patch(`/empresas/${empresa}/usuarios/${eu.id}`, { ramal_id: '' }, adm)).status, 204);
    assert.equal((await api.get(`/empresas/${empresa}/telefone`, adm)).dados.ramal, null);
  });
});
