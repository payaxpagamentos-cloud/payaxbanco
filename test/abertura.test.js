'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

const PROPOSTA = {
  tipo: 'PF', nome: 'Joana Pereira', documento: '390.533.447-05', email: 'joana@email.com', telefone: '(11) 98888-7777',
  data_nascimento: '1992-05-10', renda_mensal_centavos: 450000, cep: '01310-100', logradouro: 'Av. Paulista', numero: '1000',
  bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP', tipo_conta: 'corrente', aceite_termos: true, aceite_privacidade: true,
};

test('Abertura de conta pelo site', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  let proposta;

  await t.test('valida a proposta antes de enviar', async () => {
    const semAceite = await api.post('/ib/abertura', { ...PROPOSTA, aceite_privacidade: false }, null);
    assert.equal(semAceite.status, 422);
    assert.match(semAceite.dados.erro, /LGPD/);
    assert.equal((await api.post('/ib/abertura', { ...PROPOSTA, documento: '123.456.789-00' }, null)).status, 422);
    const menor = await api.post('/ib/abertura', { ...PROPOSTA, data_nascimento: new Date(Date.now() - 10 * 365 * 86_400_000).toISOString().slice(0, 10) }, null);
    assert.match(menor.dados.erro, /maiores de 18/);
    assert.equal((await api.post('/ib/abertura', { ...PROPOSTA, cep: '' }, null)).status, 422);
  });

  await t.test('envia proposta e recebe protocolo; não aceita duplicada', async () => {
    const r = await api.post('/ib/abertura', PROPOSTA, null);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.match(r.dados.protocolo, /^AB\d{14}$/);
    proposta = r.dados;
    const dup = await api.post('/ib/abertura', PROPOSTA, null);
    assert.equal(dup.status, 409);
    assert.match(dup.dados.erro, new RegExp(proposta.protocolo));
  });

  await t.test('consulta pública exige protocolo e documento', async () => {
    const c = await api.post('/ib/abertura/consulta', { protocolo: proposta.protocolo, documento: '39053344705' }, null);
    assert.equal(c.dados.status, 'em_analise');
    assert.equal((await api.post('/ib/abertura/consulta', { protocolo: proposta.protocolo, documento: '52998224725' }, null)).status, 404);
  });

  await t.test('operador vê, mas só gerente ou administrador decide', async () => {
    await api.post('/usuarios', { nome: 'Operador Três', email: 'op3@payax.com.br', senha: 'senha-forte', perfil: 'operador' });
    const tk = await api.login('op3@payax.com.br', 'senha-forte');
    const lista = await api.get('/aberturas', tk);
    assert.equal(lista.dados[0].protocolo, proposta.protocolo);
    assert.equal((await api.post(`/aberturas/${lista.dados[0].id}/aprovar`, {}, tk)).status, 403);
  });

  await t.test('aprovação cria cliente, conta e acesso ao Internet Banking', async () => {
    const id = (await api.get('/aberturas?status=em_analise')).dados[0].id;
    const r = await api.post(`/aberturas/${id}/aprovar`, {});
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.match(r.dados.senha_provisoria, /^\d{6}$/);
    assert.equal(r.dados.conta.tipo, 'corrente');
    const cli = await api.get(`/clientes/${r.dados.cliente_id}`);
    assert.equal(cli.dados.nome, 'Joana Pereira');
    assert.equal(cli.dados.cidade, 'São Paulo');
    assert.equal((await api.get(`/clientes/${r.dados.cliente_id}/internet-banking`)).dados.precisa_trocar_senha, 1);
    // O cliente entra no Internet Banking com a senha provisória.
    const d = (await api.post('/ib/auth/teclado', {}, null)).dados;
    const sequencia = [...r.dados.senha_provisoria].map((c) => d.teclas.findIndex((par) => par.includes(Number(c))));
    const login = await api.post('/ib/auth/login', { documento: '39053344705', teclado_id: d.id, sequencia }, null);
    assert.equal(login.status, 200);
    assert.equal((await api.post(`/aberturas/${id}/aprovar`, {})).status, 409);
    assert.equal((await api.post('/ib/abertura/consulta', { protocolo: proposta.protocolo, documento: '39053344705' }, null)).dados.status, 'aprovada');
    // Quem já é cliente é orientado a acessar a conta.
    assert.match((await api.post('/ib/abertura', PROPOSTA, null)).dados.erro, /já é cliente/);
  });

  await t.test('recusa exige motivo e fica registrada', async () => {
    const pj = await api.post('/ib/abertura', { ...PROPOSTA, tipo: 'PJ', nome: 'Mercado Bom Preço Ltda', documento: '45.997.418/0001-53', data_nascimento: '2015-03-01' }, null);
    assert.equal(pj.status, 201, JSON.stringify(pj.dados));
    const id = (await api.get('/aberturas?status=em_analise')).dados[0].id;
    assert.equal((await api.post(`/aberturas/${id}/recusar`, {})).status, 422);
    assert.equal((await api.post(`/aberturas/${id}/recusar`, { motivo: 'Documentação inconsistente' })).status, 200);
    const c = await api.post('/ib/abertura/consulta', { protocolo: pj.dados.protocolo, documento: '45997418000153' }, null);
    assert.equal(c.dados.status, 'recusada');
    assert.equal(c.dados.motivo, undefined);
  });
});
