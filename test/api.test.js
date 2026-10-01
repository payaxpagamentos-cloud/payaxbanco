'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

test('API do Banqueiro', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);

  let ana, bruno, contaAna, contaBruno;

  await t.test('rejeita login inválido e acesso sem token', async () => {
    assert.equal((await api.post('/auth/login', { email: 'admin@payax.com.br', senha: 'errada' }, null)).status, 401);
    assert.equal((await api.get('/clientes', 'token-falso')).status, 401);
  });

  await t.test('cadastra clientes com validação de documento', async () => {
    const invalido = await api.post('/clientes', { tipo: 'PF', nome: 'Fulano', documento: '12345678900' });
    assert.equal(invalido.status, 422);
    const r1 = await api.post('/clientes', { tipo: 'PF', nome: 'Ana Souza', documento: '529.982.247-25', email: 'ana@x.com', uf: 'sp' });
    assert.equal(r1.status, 201, JSON.stringify(r1.dados));
    assert.equal(r1.dados.uf, 'SP');
    ana = r1.dados;
    const r2 = await api.post('/clientes', { tipo: 'PJ', nome: 'Bruno Comércio Ltda', documento: '11.222.333/0001-81' });
    assert.equal(r2.status, 201);
    bruno = r2.dados;
    assert.equal((await api.post('/clientes', { tipo: 'PF', nome: 'Ana Dup', documento: '52998224725' })).status, 409);
    const busca = await api.get('/clientes?q=529.982');
    assert.equal(busca.dados.total, 1);
  });

  await t.test('abre contas com número sequencial e dígito', async () => {
    const r1 = await api.post('/contas', { cliente_id: ana.id, tipo: 'corrente', limite_centavos: 50000 });
    assert.equal(r1.status, 201);
    assert.equal(r1.dados.agencia, '0001');
    assert.equal(r1.dados.numero, '100001');
    contaAna = r1.dados;
    const r2 = await api.post('/contas', { cliente_id: bruno.id, tipo: 'corrente' });
    assert.equal(r2.dados.numero, '100002');
    contaBruno = r2.dados;
    assert.equal((await api.post('/contas', { cliente_id: ana.id, tipo: 'poupanca', limite_centavos: 100 })).status, 422);
  });

  await t.test('equipe não movimenta dinheiro: só o cliente autoriza, no Internet Banking', async () => {
    const rotas = [
      ['/operacoes/deposito', { conta_id: contaAna.id, valor_centavos: 100 }],
      ['/operacoes/saque', { conta_id: contaAna.id, valor_centavos: 100 }],
      ['/operacoes/transferencia', { origem_conta_id: contaAna.id, destino_conta_id: contaBruno.id, valor_centavos: 100 }],
      ['/operacoes/pix', { origem_conta_id: contaAna.id, chave: 'x@y.com', valor_centavos: 100 }],
    ];
    for (const [rota, corpo] of rotas) assert.equal((await api.post(rota, corpo)).status, 404, rota);
    assert.equal((await api.get(`/contas/${contaAna.id}`)).dados.saldo_centavos, 0);
  });

  await t.test('crédito por cobrança PIX e chaves PIX', async () => {
    await api.creditar(contaAna.id, 150000);
    assert.equal((await api.get(`/contas/${contaAna.id}`)).dados.saldo_centavos, 150000);
    const k = await api.post('/pix', { conta_id: contaBruno.id, tipo: 'cnpj' });
    assert.equal(k.status, 201);
    assert.equal(k.dados.chave, '11222333000181');
    assert.equal((await api.post('/pix', { conta_id: contaAna.id, tipo: 'cpf' })).status, 201);
    assert.equal((await api.post('/pix', { conta_id: contaAna.id, tipo: 'email', chave: 'ANA@x.com' })).status, 201);
    assert.equal((await api.post('/pix', { conta_id: contaBruno.id, tipo: 'email', chave: 'ana@x.com' })).status, 409);
  });

  await t.test('favorecidos: equipe cadastra por chave PIX ou conta PAY AX', async () => {
    const pix = await api.post(`/clientes/${ana.id}/favorecidos`, { tipo: 'pix', chave: '11.222.333/0001-81', apelido: 'Fornecedor' });
    assert.equal(pix.status, 201, JSON.stringify(pix.dados));
    assert.equal(pix.dados.nome, 'Bruno Comércio Ltda');
    assert.equal(pix.dados.chave, '11222333000181');
    const ext = await api.post(`/clientes/${ana.id}/favorecidos`, { tipo: 'pix', chave: 'loja@outrobanco.com', nome: 'Loja Externa' });
    assert.equal(ext.status, 201);
    const conta = await api.post(`/clientes/${ana.id}/favorecidos`, { tipo: 'conta', agencia: '0001', numero: `${contaBruno.numero}-${contaBruno.digito}` });
    assert.equal(conta.status, 201);
    assert.equal(conta.dados.conta, `0001/${contaBruno.numero}-${contaBruno.digito}`);
    assert.equal((await api.post(`/clientes/${ana.id}/favorecidos`, { tipo: 'pix', chave: '11222333000181' })).status, 409);
    assert.equal((await api.post(`/clientes/${ana.id}/favorecidos`, { tipo: 'pix', chave: 'invalida' })).status, 422);
    assert.equal((await api.get(`/clientes/${ana.id}/favorecidos`)).dados.length, 3);
    assert.equal((await api.del(`/clientes/${ana.id}/favorecidos/${ext.dados.id}`)).status, 204);
    assert.equal((await api.get(`/clientes/${ana.id}/favorecidos`)).dados.length, 2);
  });

  await t.test('empréstimo: contrata e credita; parcelas só pelo cliente', async () => {
    const saldo0 = (await api.get(`/contas/${contaBruno.id}`)).dados.saldo_centavos;
    const e = await api.post('/emprestimos', { conta_id: contaBruno.id, valor_centavos: 120000, taxa_mensal: 0.02, num_parcelas: 3 });
    assert.equal(e.status, 201, JSON.stringify(e.dados));
    assert.equal(e.dados.parcelas.length, 3);
    assert.equal((await api.get(`/contas/${contaBruno.id}`)).dados.saldo_centavos, saldo0 + 120000);
    assert.equal((await api.post(`/emprestimos/${e.dados.id}/parcelas/1/pagar`)).status, 404);
  });

  await t.test('perfis: operador cadastra favorecido, mas não acessa usuários nem concede limite', async () => {
    const u = await api.post('/usuarios', { nome: 'Op Teste', email: 'op@payax.com.br', senha: 'senha-forte', perfil: 'operador' });
    assert.equal(u.status, 201);
    const tk = await api.login('op@payax.com.br', 'senha-forte');
    assert.equal((await api.get('/usuarios', tk)).status, 403);
    assert.equal((await api.get('/relatorios/clientes.csv', tk)).status, 403);
    assert.equal((await api.patch(`/contas/${contaAna.id}/limite`, { limite_centavos: 1 }, tk)).status, 403);
    assert.equal((await api.post('/emprestimos', { conta_id: contaAna.id, valor_centavos: 1000, taxa_mensal: 0.01, num_parcelas: 1 }, tk)).status, 403);
    assert.equal((await api.post(`/clientes/${bruno.id}/favorecidos`, { tipo: 'pix', chave: 'ana@x.com' }, tk)).status, 201);
  });

  await t.test('bloqueio e encerramento passam pela Ouvidoria; encerramento exige saldo zero', async () => {
    assert.equal((await api.post('/usuarios', { nome: 'Olívia Ouvidoria', email: 'ouv@payax.com.br', perfil: 'ouvidoria', senha: 'senha-forte-1' })).status, 201);
    const tkOuv = await api.login('ouv@payax.com.br', 'senha-forte-1');
    const aprovar = async (pedido) => {
      assert.equal(pedido.status, 202, JSON.stringify(pedido.dados));
      const r = await api.post(`/ouvidoria/${pedido.dados.solicitacao.id}/aprovar`, { parecer: 'Conferido.' }, tkOuv);
      assert.equal(r.status, 200, JSON.stringify(r.dados));
    };
    await aprovar(await api.patch(`/contas/${contaBruno.id}/status`, { status: 'bloqueada', motivo: 'Suspeita de fraude' }));
    assert.equal((await api.post('/integracoes/bradesco/cobrancas', { conta_id: contaBruno.id, valor_centavos: 100 })).status, 409);
    await aprovar(await api.patch(`/contas/${contaBruno.id}/status`, { status: 'ativa', motivo: 'Cliente confirmou as operações' }));
    assert.equal((await api.patch(`/contas/${contaBruno.id}/status`, { status: 'encerrada', motivo: 'Pedido do cliente' })).status, 409);
    const vazia = (await api.post('/contas', { cliente_id: bruno.id, tipo: 'pagamento' })).dados;
    await api.post('/pix', { conta_id: vazia.id, tipo: 'aleatoria' });
    await aprovar(await api.patch(`/contas/${vazia.id}/status`, { status: 'encerrada', motivo: 'Pedido do cliente' }));
    assert.equal((await api.get(`/contas/${vazia.id}`)).dados.status, 'encerrada');
    assert.equal((await api.get(`/pix?q=${encodeURIComponent('-')}`)).dados.filter((k) => k.conta_id === vazia.id).length, 0);
    assert.equal((await api.patch(`/contas/${vazia.id}/status`, { status: 'ativa', motivo: 'Reabrir' })).status, 409);
  });

  await t.test('dashboard, relatórios CSV e auditoria', async () => {
    const d = await api.get('/dashboard');
    assert.equal(d.status, 200);
    assert.equal(d.dados.clientes.total, 2);
    assert.equal(d.dados.serie.length, 14);
    const csv = await api.get('/relatorios/transacoes.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.dados, /Valor \(R\$\)/);
    const aud = await api.get('/auditoria?entidade=conta');
    assert.ok(aud.dados.total > 5);
  });

  await t.test('CSV neutraliza fórmulas em células', async () => {
    await api.post('/clientes', { tipo: 'PF', nome: '=HYPERLINK("x")', documento: '111.444.777-35' });
    const csv = await api.get('/relatorios/clientes.csv');
    assert.match(csv.dados, /"'=HYPERLINK\(""x""\)"/);
  });
});
