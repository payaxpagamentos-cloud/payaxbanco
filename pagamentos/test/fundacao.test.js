'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, CNPJ } = require('./helpers');

test('acesso: perfis, audiências e isolamento entre clientes', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  const b = await api.cliente(tk.admin, { razao_social: 'Provedor Beta', nome_fantasia: 'Beta', cnpj: CNPJ.beta });

  await t.test('login recusa senha errada com a mesma mensagem de e-mail inexistente', async () => {
    const errada = await api.post('/api/auth/login', { email: 'admin@payax.local', senha: 'nao-e-essa' });
    const inexistente = await api.post('/api/auth/login', { email: 'ninguem@payax.local', senha: 'qualquer' });
    assert.equal(errada.status, 401);
    assert.equal(inexistente.status, 401);
    assert.equal(errada.dados.erro, inexistente.dados.erro);
  });

  await t.test('o token da equipe não vale no Internet Bank e vice-versa', async () => {
    assert.equal((await api.get('/cliente/api/painel', tk.admin)).status, 401);
    assert.equal((await api.get('/api/painel', a.token)).status, 401);
  });

  await t.test('perfil consulta não emite boleto nem mexe em dinheiro', async () => {
    assert.equal((await api.post('/api/boletos', { cliente_id: a.cliente.id, valor: '10,00', vencimento: '2026-12-01', pagador_nome: 'X', pagador_documento: '11144477735' }, tk.consulta)).status, 403);
    assert.equal((await api.post('/api/repasses', { cliente_id: a.cliente.id }, tk.consulta)).status, 403);
    assert.equal((await api.get('/api/boletos', tk.consulta)).status, 200);
  });

  await t.test('operação não aprova repasse; financeiro não mexe em credenciais do banco', async () => {
    assert.equal((await api.post('/api/repasses', { cliente_id: a.cliente.id }, tk.operacao)).status, 403);
    assert.equal((await api.put('/api/integracoes/banco', { client_id: 'x' }, tk.financeiro)).status, 403);
  });

  await t.test('o cliente só enxerga os próprios boletos', async () => {
    const meu = await api.boleto(tk.admin, a.cliente.id);
    const alheio = await api.boleto(tk.admin, b.cliente.id, { pagador_nome: 'Outro' });
    assert.equal((await api.get(`/cliente/api/boletos/${meu.id}`, a.token)).status, 200);
    assert.equal((await api.get(`/cliente/api/boletos/${alheio.id}`, a.token)).status, 404);
    const lista = (await api.get('/cliente/api/boletos', a.token)).dados;
    assert.ok(lista.itens.every((x) => x.cliente_id === a.cliente.id));
  });

  await t.test('o cliente não vê o nosso custo com o banco nem a margem', async () => {
    const meu = await api.boleto(tk.admin, a.cliente.id, { valor: '250,00' });
    const visaoCliente = (await api.get(`/cliente/api/boletos/${meu.id}`, a.token)).dados;
    assert.equal(visaoCliente.split.margem_centavos, undefined);
    assert.equal(visaoCliente.split.custo_banco_centavos, undefined);
    assert.equal(visaoCliente.custo_liquidacao_centavos, undefined);
    const visaoEquipe = (await api.get(`/api/boletos/${meu.id}`, tk.admin)).dados;
    assert.ok(visaoEquipe.split.margem_centavos > 0, 'a equipe vê a margem');
  });

  await t.test('o cliente não troca a chave PIX de destino sozinho', async () => {
    const r = await api.patch('/cliente/api/cadastro', { pix_chave: '99999999000199' }, a.token);
    assert.equal(r.status, 403);
    assert.match(r.dados.erro, /equipe PayAx/i);
  });

  await t.test('idempotência: o mesmo comando com a mesma chave não emite dois boletos', async () => {
    const corpo = { cliente_id: a.cliente.id, valor: '77,00', vencimento: '2026-12-22', pagador_nome: 'Repetido', pagador_documento: '11144477735' };
    const chave = { 'Idempotency-Key': 'teste-idempotencia-0001' };
    const um = await api.post('/api/boletos', corpo, tk.admin, chave);
    const dois = await api.post('/api/boletos', corpo, tk.admin, chave);
    assert.equal(um.status, 201);
    assert.equal(dois.status, 201);
    assert.equal(um.dados.id, dois.dados.id);
    assert.equal(dois.headers.get('idempotent-replay'), 'true');
  });

  await t.test('margem e custo do banco só para quem tem a permissão', async () => {
    const comMargem = (await api.get('/api/painel', tk.financeiro)).dados;
    const semMargem = (await api.get('/api/painel', tk.operacao)).dados;
    assert.equal(comMargem.pode_ver_margem, true);
    assert.equal(semMargem.pode_ver_margem, false);
    assert.equal(typeof comMargem.liquidacoes.margem_centavos, 'number');
    assert.equal(semMargem.liquidacoes.margem_centavos, undefined);
    assert.equal(semMargem.liquidacoes.custo_banco_centavos, undefined);
    assert.equal(typeof semMargem.liquidacoes.receita_centavos, 'number', 'a receita continua visível');

    const ficha = (await api.get(`/api/clientes/${a.cliente.id}`, tk.operacao)).dados;
    assert.equal(ficha.liquidacoes_mes.margem_centavos, undefined);
    const relatorio = (await api.get('/api/relatorios/faturamento', tk.operacao)).dados;
    assert.equal(relatorio.totais.margem_centavos, undefined);
  });

  await t.test('sempre sobra um administrador ativo', async () => {
    const r = await api.patch('/api/admin/usuarios/1', { ativo: false }, tk.admin);
    assert.equal(r.status, 409);
  });
});
