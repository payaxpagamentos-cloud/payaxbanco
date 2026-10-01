'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

test('Ouvidoria', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);

  let tkOuv, tkGerente, cliente, conta;

  await t.test('administrador cria o perfil Ouvidoria, que analisa mas não opera', async () => {
    assert.equal((await api.post('/usuarios', { nome: 'Olívia Ouvidoria', email: 'ouv@payax.com.br', perfil: 'ouvidoria', senha: 'senha-forte-1' })).status, 201);
    assert.equal((await api.post('/usuarios', { nome: 'Gabriela Gerente', email: 'g@payax.com.br', perfil: 'gerente', senha: 'senha-forte-1' })).status, 201);
    const l = await api.post('/auth/login', { email: 'ouv@payax.com.br', senha: 'senha-forte-1' }, null);
    assert.equal(l.dados.permissoes['ouvidoria.decidir'].permitido, true);
    assert.equal(l.dados.permissoes['contas.abrir'].permitido, false);
    tkOuv = l.dados.token;
    tkGerente = await api.login('g@payax.com.br', 'senha-forte-1');
    cliente = (await api.post('/clientes', { tipo: 'PF', nome: 'Ana Souza', documento: '529.982.247-25' })).dados;
    conta = (await api.post('/contas', { cliente_id: cliente.id, tipo: 'corrente' })).dados;
    assert.equal((await api.post('/contas', { cliente_id: cliente.id, tipo: 'corrente' }, tkOuv)).status, 403);
  });

  await t.test('bloqueio pedido pelo gerente vira solicitação com protocolo; nada muda antes da análise', async () => {
    assert.equal((await api.patch(`/contas/${conta.id}/status`, { status: 'bloqueada' }, tkGerente)).status, 422);
    const r = await api.patch(`/contas/${conta.id}/status`, { status: 'bloqueada', motivo: 'Suspeita de fraude' }, tkGerente);
    assert.equal(r.status, 202);
    assert.match(r.dados.solicitacao.protocolo, /^OUV-\d{4}-\d{6}$/);
    assert.equal(r.dados.solicitacao.tipo_rotulo, 'Bloqueio de conta');
    assert.equal((await api.get(`/contas/${conta.id}`)).dados.status, 'ativa');
    const dup = await api.patch(`/contas/${conta.id}/status`, { status: 'bloqueada', motivo: 'De novo' });
    assert.equal(dup.status, 409);
    assert.match(dup.dados.erro, /já existe uma solicitação/i);
  });

  await t.test('só quem tem a alçada decide, nunca o próprio solicitante; recusa exige parecer', async () => {
    const [s] = (await api.get('/ouvidoria?status=em_analise')).dados;
    assert.equal((await api.post(`/ouvidoria/${s.id}/aprovar`, {}, tkGerente)).status, 403);
    assert.equal((await api.post(`/ouvidoria/${s.id}/recusar`, {}, tkOuv)).status, 422);
    const r = await api.post(`/ouvidoria/${s.id}/recusar`, { parecer: 'Movimentações confirmadas pelo cliente.' }, tkOuv);
    assert.equal(r.dados.status, 'recusada');
    assert.equal((await api.get(`/contas/${conta.id}`)).dados.status, 'ativa');
    const proprio = await api.patch(`/contas/${conta.id}/status`, { status: 'bloqueada', motivo: 'Ordem judicial' });
    assert.equal((await api.post(`/ouvidoria/${proprio.dados.solicitacao.id}/aprovar`)).status, 403);
  });

  await t.test('aprovação executa a ação e fica na auditoria', async () => {
    const [s] = (await api.get(`/ouvidoria?status=em_analise&conta_id=${conta.id}`)).dados;
    const r = await api.post(`/ouvidoria/${s.id}/aprovar`, { parecer: 'Ofício conferido.' }, tkOuv);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.status, 'aprovada');
    assert.equal((await api.get(`/contas/${conta.id}`)).dados.status, 'bloqueada');
    const aud = await api.get('/auditoria?entidade=solicitacao');
    assert.ok(JSON.stringify(aud.dados).includes('aprovar_solicitacao'));
    assert.ok(JSON.stringify((await api.get('/auditoria?entidade=conta')).dados).includes(s.protocolo));
  });

  await t.test('mudança de situação do cliente aguarda a Ouvidoria; o resto do cadastro é salvo', async () => {
    const r = await api.put(`/clientes/${cliente.id}`, { ...cliente, nome: 'Ana Souza Lima', status: 'bloqueado', motivo_status: 'Documento falso' }, tkGerente);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.nome, 'Ana Souza Lima');
    assert.equal(r.dados.status, 'ativo');
    assert.equal(r.dados.solicitacao.tipo, 'bloquear_cliente');
    assert.equal((await api.post(`/ouvidoria/${r.dados.solicitacao.id}/cancelar`, {}, tkOuv)).status, 403);
    assert.equal((await api.post(`/ouvidoria/${r.dados.solicitacao.id}/cancelar`, {}, tkGerente)).dados.status, 'cancelada');
  });

  await t.test('administrador escolhe quais ações exigem análise', async () => {
    const regras = (await api.get('/alcadas')).dados.analises;
    assert.equal(regras.find((x) => x.acao === 'encerrar_conta').exige, true);
    await api.put('/alcadas', { analises: { desbloquear_conta: false } });
    const r = await api.patch(`/contas/${conta.id}/status`, { status: 'ativa', motivo: 'Liberado' }, tkGerente);
    assert.equal(r.status, 200);
    assert.equal(r.dados.status, 'ativa');
  });

  await t.test('cliente pede o encerramento pelo Internet Banking com senha de transação', async () => {
    const hab = await api.post(`/clientes/${cliente.id}/internet-banking`);
    const digitar = async (senha) => {
      const d = (await api.post('/ib/auth/teclado', {}, null)).dados;
      return { teclado_id: d.id, sequencia: [...senha].map((c) => d.teclas.findIndex((par) => par.includes(Number(c)))) };
    };
    let tk = (await api.post('/ib/auth/login', { documento: '52998224725', ...(await digitar(hab.dados.senha_provisoria)) }, null)).dados.token;
    await api.req('POST', '/ib/auth/primeiro-acesso', { nova_senha: '730194', pin: '482913' }, tk);
    tk = (await api.post('/ib/auth/login', { documento: '52998224725', ...(await digitar('730194')) }, null)).dados.token;
    const semPin = await api.req('POST', '/ib/solicitacoes/encerramento', { conta_id: conta.id, motivo: 'Vou mudar de banco' }, tk);
    assert.notEqual(semPin.status, 201);
    const r = await api.req('POST', '/ib/solicitacoes/encerramento', { conta_id: conta.id, motivo: 'Vou mudar de banco', pin: await digitar('482913') }, tk);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    const minhas = (await api.req('GET', '/ib/solicitacoes', undefined, tk)).dados;
    assert.equal(minhas.length, 1);
    assert.equal(minhas[0].tipo, 'Encerramento de conta');
    const fila = (await api.get('/ouvidoria?status=em_analise', tkOuv)).dados;
    assert.equal(fila.find((x) => x.protocolo === r.dados.protocolo).origem, 'cliente');
  });
});
