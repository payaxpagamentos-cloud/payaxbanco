'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { gerarBoletoBancario, gerarConvenio, lerBoleto, vencimentoPorFator } = require('../server/lib/boleto');

test('boletos FEBRABAN', () => {
  const b = gerarBoletoBancario({ banco: '237', valorCentavos: 15990, vencimento: '2026-10-15', campoLivre: '123' });
  assert.equal(b.linha_digitavel.length, 47);
  assert.deepEqual(
    (({ tipo, banco, valor_centavos, vencimento }) => ({ tipo, banco, valor_centavos, vencimento }))(lerBoleto(b.linha_digitavel)),
    { tipo: 'boleto', banco: '237', valor_centavos: 15990, vencimento: '2026-10-15' },
  );
  assert.equal(lerBoleto(b.codigo_barras).linha_digitavel, b.linha_digitavel);
  const errado = b.linha_digitavel.slice(0, 5) + ((Number(b.linha_digitavel[5]) + 1) % 10) + b.linha_digitavel.slice(6);
  assert.throws(() => lerBoleto(errado), /não confere/);
  const c = gerarConvenio({ valorCentavos: 4321 });
  assert.equal(lerBoleto(c.linha_digitavel).valor_centavos, 4321);
  assert.equal(lerBoleto(c.linha_digitavel).tipo, 'convenio');
  // Fator de vencimento reiniciado em 22/02/2025.
  assert.equal(vencimentoPorFator(1000, new Date('2026-01-01')), '2025-02-22');
  assert.equal(vencimentoPorFator(9999, new Date('2025-01-01')), '2025-02-21');
});

test('Internet Banking', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  const ana = (await api.post('/clientes', { tipo: 'PF', nome: 'Ana Cliente', documento: '529.982.247-25' })).dados;
  const beto = (await api.post('/clientes', { tipo: 'PF', nome: 'Beto Cliente', documento: '111.444.777-35' })).dados;
  const contaAna = (await api.post('/contas', { cliente_id: ana.id, tipo: 'corrente' })).dados;
  const contaBeto = (await api.post('/contas', { cliente_id: beto.id, tipo: 'corrente' })).dados;
  await api.creditar(contaAna.id, 1_000_000);
  await api.post('/pix', { conta_id: contaBeto.id, tipo: 'cpf' });
  let tk;
  const ib = (m, c, b) => api.req(m, `/ib${c}`, b, tk);
  // Simula o cliente clicando no teclado virtual: para cada dígito, o botão (par) que o contém.
  const digitar = async (senha) => {
    const d = (await api.post('/ib/auth/teclado', {}, null)).dados;
    return { teclado_id: d.id, sequencia: [...senha].map((c) => d.teclas.findIndex((par) => par.includes(Number(c)))) };
  };
  const login = async (documento, senha) => api.post('/ib/auth/login', { documento, ...(await digitar(senha)) }, null);
  const PIN = '482913';
  const comPin = async (corpo, pin = PIN) => ({ ...corpo, pin: await digitar(pin) });

  await t.test('equipe habilita o acesso e recebe senha provisória', async () => {
    const r = await api.post(`/clientes/${ana.id}/internet-banking`);
    assert.equal(r.status, 201);
    assert.match(r.dados.senha_provisoria, /^\d{6}$/);
    assert.equal((await api.post(`/clientes/${ana.id}/internet-banking`)).status, 409);
    const l = await login('529.982.247-25', r.dados.senha_provisoria);
    assert.equal(l.status, 200, JSON.stringify(l.dados));
    assert.equal(l.dados.precisa_trocar_senha, true);
    tk = l.dados.token;
  });

  await t.test('primeiro acesso é obrigatório e valida senha e PIN', async () => {
    assert.equal((await ib('GET', '/resumo')).status, 403);
    assert.equal((await ib('POST', '/auth/primeiro-acesso', { nova_senha: '12345', pin: PIN })).status, 422);
    assert.equal((await ib('POST', '/auth/primeiro-acesso', { nova_senha: '730194', pin: '123456' })).status, 422);
    assert.equal((await ib('POST', '/auth/primeiro-acesso', { nova_senha: '730194', pin: '730194' })).status, 422);
    assert.equal((await ib('POST', '/auth/primeiro-acesso', { nova_senha: '730194', pin: PIN })).status, 200);
    assert.equal((await ib('GET', '/resumo')).status, 200);
  });

  await t.test('tokens de cliente e de equipe não se misturam', async () => {
    assert.equal((await api.get('/clientes', tk)).status, 401);
    assert.equal((await api.req('GET', '/ib/resumo', undefined)).status, 401);
  });

  await t.test('cliente vê apenas as próprias contas', async () => {
    const r = await ib('GET', '/resumo');
    assert.deepEqual(r.dados.contas.map((c) => c.id), [contaAna.id]);
    assert.equal(r.dados.contas[0].saldo_centavos, 1_000_000);
    assert.equal((await ib('GET', `/contas/${contaBeto.id}/extrato`)).status, 404);
    assert.equal((await ib('POST', '/pix', await comPin({ conta_id: contaBeto.id, chave: 'x@y.com', valor_centavos: 1 }, '482913'))).status, 404);
  });

  await t.test('PIX interno exige PIN e gera comprovante', async () => {
    const dest = await ib('POST', '/pix/destinatario', { chave: '111.444.777-35' });
    assert.equal(dest.dados.interno, true);
    assert.equal(dest.dados.nome, 'Beto Cliente');
    assert.equal(dest.dados.documento, '***.444.777-**');
    const errado = await ib('POST', '/pix', await comPin({ conta_id: contaAna.id, chave: '11144477735', valor_centavos: 10000 }, '000001'));
    assert.equal(errado.status, 422);
    assert.match(errado.dados.erro, /Restam 2/);
    const ok = await ib('POST', '/pix', await comPin({ conta_id: contaAna.id, chave: '11144477735', valor_centavos: 10000 }, '482913'));
    assert.equal(ok.status, 201, JSON.stringify(ok.dados));
    const comp = await ib('GET', `/comprovantes/${ok.dados.transacao_id}`);
    assert.equal(comp.dados.contraparte.nome, 'Beto Cliente');
    assert.equal(comp.dados.valor_centavos, -10000);
    const ext = await api.get(`/contas/${contaAna.id}/extrato`);
    assert.equal(ext.dados.itens[0].canal, 'internet_banking');
  });

  await t.test('PIX para outro banco e transferência', async () => {
    const pix = await ib('POST', '/pix', await comPin({ conta_id: contaAna.id, chave: 'loja@outro.com', valor_centavos: 5000 }, '482913'));
    assert.equal(pix.status, 201);
    assert.equal(pix.dados.externo, true);
    const d = await ib('POST', '/transferencias/destinatario', { agencia: '0001', numero: `${contaBeto.numero}-${contaBeto.digito}` });
    assert.equal(d.dados.nome, 'Beto Cliente');
    const tr = await ib('POST', '/transferencias', await comPin({ conta_id: contaAna.id, destino_agencia: '0001', destino_numero: contaBeto.numero, valor_centavos: 2500 }, '482913'));
    assert.equal(tr.status, 201);
  });

  await t.test('transferência sem saldo é recusada e não altera nada; equipe estorna PIX interno', async () => {
    const antes = (await ib('GET', '/resumo')).dados.contas[0].saldo_centavos;
    const falha = await ib('POST', '/transferencias', await comPin({ conta_id: contaAna.id, destino_agencia: '0001', destino_numero: contaBeto.numero, valor_centavos: 99_000_000 }));
    assert.ok([409, 422].includes(falha.status), JSON.stringify(falha.dados));
    assert.equal((await ib('GET', '/resumo')).dados.contas[0].saldo_centavos, antes);
    // Estorno (correção feita pelo gerente) desfaz os dois lados do PIX interno.
    const ext = await api.get(`/contas/${contaAna.id}/extrato`);
    const pix = ext.dados.itens.find((x) => x.tipo === 'pix_enviado' && x.contraparte_conta_id === contaBeto.id);
    const betoAntes = (await api.get(`/contas/${contaBeto.id}`)).dados.saldo_centavos;
    const est = await api.post('/operacoes/estorno', { transacao_id: pix.id, motivo: 'Teste' });
    assert.equal(est.status, 201);
    assert.equal(est.dados.estornadas, 2);
    assert.equal((await api.get(`/contas/${contaBeto.id}`)).dados.saldo_centavos, betoAntes + pix.valor_centavos);
    assert.equal((await api.post('/operacoes/estorno', { transacao_id: pix.id, motivo: 'De novo' })).status, 409);
  });

  await t.test('pagamento de boleto e de conta de consumo', async () => {
    const b = gerarBoletoBancario({ valorCentavos: 18990, vencimento: '2026-12-01', campoLivre: '9' });
    const consulta = await ib('POST', '/pagamentos/consultar', { linha: b.linha_digitavel });
    assert.equal(consulta.dados.valor_centavos, 18990);
    const pg = await ib('POST', '/pagamentos', await comPin({ conta_id: contaAna.id, linha: b.linha_digitavel }, '482913'));
    assert.equal(pg.status, 201, JSON.stringify(pg.dados));
    assert.ok(pg.dados.transacao_id);
    const conv = gerarConvenio({ valorCentavos: 13472 });
    assert.equal((await ib('POST', '/pagamentos', await comPin({ conta_id: contaAna.id, linha: conv.linha_digitavel }, '482913'))).status, 201);
    assert.equal((await ib('POST', '/pagamentos/consultar', { linha: '1234' })).status, 422);
    const saldo = (await ib('GET', '/resumo')).dados.contas[0].saldo_centavos;
    assert.equal(saldo, 1_000_000 - 5000 - 2500 - 18990 - 13472); // o PIX interno de 10000 foi estornado
  });

  await t.test('limite diário do Internet Banking', async () => {
    const r = await ib('GET', '/resumo');
    assert.equal(r.dados.limite.usado_centavos, 5000 + 2500 + 18990 + 13472); // estornado não conta no limite
    const acima = await ib('POST', '/pix', await comPin({ conta_id: contaAna.id, chave: '11144477735', valor_centavos: r.dados.limite.disponivel_centavos + 1 }, '482913'));
    assert.equal(acima.status, 422);
    assert.match(acima.dados.erro, /limite diário/);
    assert.equal((await api.patch(`/clientes/${ana.id}/internet-banking`, { limite_diario_centavos: 2_000_000 })).status, 200);
    assert.equal((await ib('GET', '/resumo')).dados.limite.limite_centavos, 2_000_000);
  });

  await t.test('cobrança PIX para receber na conta', async () => {
    const c = await ib('POST', '/pix/cobrancas', { conta_id: contaAna.id, valor_centavos: 7000 });
    assert.equal(c.status, 201);
    const antes = (await ib('GET', '/resumo')).dados.contas[0].saldo_centavos;
    assert.equal((await ib('POST', `/pix/cobrancas/${c.dados.txid}/simular-pagamento`)).dados.creditados, 1);
    assert.equal((await ib('GET', '/resumo')).dados.contas[0].saldo_centavos, antes + 7000);
  });

  await t.test('chaves PIX do cliente', async () => {
    const k = await ib('POST', '/pix/chaves', { conta_id: contaAna.id, tipo: 'email', chave: 'ana@cliente.com' });
    assert.equal(k.status, 201);
    assert.equal((await ib('GET', '/pix/chaves')).dados.length, 1);
    assert.equal((await ib('POST', '/pix/chaves', { conta_id: contaAna.id, tipo: 'cnpj' })).status, 422);
    assert.equal((await ib('DELETE', `/pix/chaves/${k.dados.id}`)).status, 204);
  });

  await t.test('3 PINs errados bloqueiam; equipe redefine e desbloqueia', async () => {
    for (let i = 0; i < 2; i++) await ib('POST', '/pix', await comPin({ conta_id: contaAna.id, chave: '11144477735', valor_centavos: 100 }, '999991'));
    const bloq = await ib('POST', '/pix', await comPin({ conta_id: contaAna.id, chave: '11144477735', valor_centavos: 100 }, '999991'));
    assert.equal(bloq.status, 403);
    assert.equal((await ib('GET', '/resumo')).status, 401);
    const nova = await api.post(`/clientes/${ana.id}/internet-banking/redefinir-senha`);
    assert.equal(nova.dados.status, 'bloqueado');
    await api.patch(`/clientes/${ana.id}/internet-banking`, { status: 'ativo' });
    const l = await login('52998224725', nova.dados.senha_provisoria);
    assert.equal(l.dados.precisa_trocar_senha, true);
  });

  await t.test('5 senhas erradas bloqueiam o login temporariamente', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login('52998224725', '000000')).status, 401);
    assert.equal((await login('52998224725', '000000')).status, 429);
    assert.equal((await login('00000000000', '000000')).status, 401);
  });

  await t.test('teclado virtual: desafio de uso único e sem dígitos no tráfego', async () => {
    const d = (await api.post('/ib/auth/teclado', {}, null)).dados;
    assert.equal(d.teclas.length, 5);
    assert.deepEqual(d.teclas.flat().sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const corpo = { documento: '11144477735', teclado_id: d.id, sequencia: [0, 0, 0, 0, 0, 0] };
    await api.post('/ib/auth/login', corpo, null);
    const reuso = await api.post('/ib/auth/login', corpo, null);
    assert.equal(reuso.status, 422);
    assert.match(reuso.dados.erro, /expirou/);
    assert.equal((await api.post('/ib/auth/login', { documento: '11144477735', senha: '123456' }, null)).status, 422);
  });

  await t.test('cliente não vê o banco liquidante', async () => {
    // Novo login da Ana (acesso redefinido no teste anterior).
    const nova = await api.post(`/clientes/${ana.id}/internet-banking/redefinir-senha`);
    await api.patch(`/clientes/${ana.id}/internet-banking`, { status: 'ativo' });
    tk = (await login('52998224725', nova.dados.senha_provisoria)).dados.token;
    assert.equal((await ib('POST', '/auth/primeiro-acesso', { nova_senha: '730194', pin: PIN })).status, 200);
    const respostas = [await ib('GET', '/me'), await ib('GET', '/resumo'), await ib('GET', `/contas/${contaAna.id}/extrato?limite=100`)];
    const ext = respostas[2].dados.itens;
    for (const t2 of ext) respostas.push(await ib('GET', `/comprovantes/${t2.id}`));
    respostas.push(await ib('POST', '/pix', await comPin({ conta_id: contaAna.id, chave: 'final@outro.com', valor_centavos: 100 })));
    const texto = JSON.stringify(respostas.map((r) => r.dados));
    assert.doesNotMatch(texto, /bradesco|60746948/i);
  });

  await t.test('auditoria registra ações do cliente', async () => {
    const a = await api.get('/auditoria?q=ib_');
    assert.ok(a.dados.itens.some((x) => x.acao === 'ib_primeiro_acesso' && x.cliente_id === ana.id));
  });
});
