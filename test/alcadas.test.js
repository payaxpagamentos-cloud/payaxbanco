'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

test('Alçadas da equipe', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);

  let tkGerente, tkOperador, conta;

  await t.test('administrador cria gerente e operador', async () => {
    for (const [nome, email, perfil] of [['Gabriela Gerente', 'g@payax.com.br', 'gerente'], ['Otávio Operador', 'o@payax.com.br', 'operador']]) {
      assert.equal((await api.post('/usuarios', { nome, email, perfil, senha: 'senha-forte-1' })).status, 201);
    }
    tkGerente = await api.login('g@payax.com.br', 'senha-forte-1');
    tkOperador = await api.login('o@payax.com.br', 'senha-forte-1');
    const cli = await api.post('/clientes', { tipo: 'PF', nome: 'Ana Souza', documento: '529.982.247-25' });
    conta = (await api.post('/contas', { cliente_id: cli.dados.id, tipo: 'corrente' })).dados;
  });

  await t.test('login devolve as permissões do perfil', async () => {
    const r = await api.post('/auth/login', { email: 'o@payax.com.br', senha: 'senha-forte-1' }, null);
    assert.equal(r.dados.permissoes['contas.abrir'].permitido, true);
    assert.equal(r.dados.permissoes['emprestimos.conceder'].permitido, false);
    const me = await api.get('/auth/me', tkGerente);
    assert.equal(me.dados.permissoes['emprestimos.conceder'].permitido, true);
  });

  await t.test('só o administrador vê e altera as alçadas', async () => {
    assert.equal((await api.get('/alcadas', tkGerente)).status, 403);
    assert.equal((await api.put('/alcadas', {}, tkOperador)).status, 403);
    const r = await api.get('/alcadas');
    assert.equal(r.status, 200);
    assert.deepEqual(r.dados.perfis, ['gerente', 'operador', 'ouvidoria']);
    assert.ok(r.dados.permissoes.find((p) => p.chave === 'emprestimos.conceder').valor);
  });

  await t.test('teto de valor: gerente concede empréstimo só até o limite da alçada', async () => {
    const s = await api.put('/alcadas', { gerente: { 'emprestimos.conceder': { permitido: true, limite_centavos: 1_000_000 } } });
    assert.equal(s.dados.alteradas, 1);
    const acima = await api.post('/emprestimos', { conta_id: conta.id, valor_centavos: 1_500_000, taxa_mensal: 0.02, num_parcelas: 6 }, tkGerente);
    assert.equal(acima.status, 403);
    assert.match(acima.dados.erro, /acima da sua alçada \(até R\$\s?10\.000,00\)/);
    const dentro = await api.post('/emprestimos', { conta_id: conta.id, valor_centavos: 500_000, taxa_mensal: 0.02, num_parcelas: 6 }, tkGerente);
    assert.equal(dentro.status, 201);
  });

  await t.test('liberar e retirar permissões do operador', async () => {
    assert.equal((await api.patch(`/contas/${conta.id}/limite`, { limite_centavos: 20_000 }, tkOperador)).status, 403);
    await api.put('/alcadas', { operador: { 'contas.limite': { permitido: true, limite_centavos: 50_000 }, 'contas.abrir': { permitido: false } } });
    assert.equal((await api.patch(`/contas/${conta.id}/limite`, { limite_centavos: 20_000 }, tkOperador)).status, 200);
    assert.equal((await api.patch(`/contas/${conta.id}/limite`, { limite_centavos: 80_000 }, tkOperador)).status, 403);
    const abrir = await api.post('/contas', { cliente_id: conta.cliente_id, tipo: 'poupanca' }, tkOperador);
    assert.equal(abrir.status, 403);
    assert.match(abrir.dados.erro, /não tem alçada para: abrir contas/);
  });

  await t.test('valores inválidos são recusados e nada muda', async () => {
    assert.equal((await api.put('/alcadas', { operador: { 'contas.limite': { permitido: true, limite_centavos: -5 } } })).status, 422);
    assert.equal((await api.put('/alcadas', { admin: { 'contas.abrir': { permitido: false } } })).status, 422);
    assert.equal((await api.put('/alcadas', { gerente: { 'nao.existe': { permitido: true } } })).status, 422);
    const r = await api.get('/alcadas');
    assert.equal(r.dados.permissoes.find((p) => p.chave === 'contas.limite').regras.operador.limite_centavos, 50_000);
  });

  await t.test('alterações ficam na auditoria e o padrão pode ser restaurado', async () => {
    const aud = await api.get('/auditoria?acao=alterar_alcadas');
    assert.ok(JSON.stringify(aud.dados).includes('alterar_alcadas'));
    await api.post('/alcadas/restaurar-padrao');
    const r = await api.get('/alcadas');
    const emp = r.dados.permissoes.find((p) => p.chave === 'emprestimos.conceder');
    assert.deepEqual(emp.regras.gerente, { permitido: true, limite_centavos: null });
    assert.equal(r.dados.permissoes.find((p) => p.chave === 'contas.abrir').regras.operador.permitido, true);
  });
});
