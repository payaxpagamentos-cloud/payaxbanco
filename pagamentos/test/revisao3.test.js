'use strict';

/* Revisão geral (novembro/2026): cada falha encontrada tem aqui o teste que prova a correção. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
process.env.PAYAX_SITE_HOSTS = 'payax.com.br';
const { iniciar, CNPJ } = require('./helpers');
const { dataLocal, somarDias } = require('../server/lib/datas');

function pedirComHost(raiz, caminho, cabecalhos) {
  const u = new URL(raiz);
  return new Promise((ok, falha) => {
    http.get({ hostname: u.hostname, port: u.port, path: caminho, headers: cabecalhos }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); }).on('error', falha);
  });
}

test('revisão geral: segurança, dinheiro e abertura de conta', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  const hoje = dataLocal('America/Sao_Paulo');

  await t.test('senha provisória: "?x=/api/auth/eu" no endereço não libera outras rotas', async () => {
    api.db.prepare('UPDATE usuarios SET senha_provisoria = 1 WHERE id = ?').run(tk.operacao_id);
    assert.equal((await api.get('/api/painel', tk.operacao)).status, 403);
    assert.equal((await api.get('/api/painel?x=/api/auth/eu', tk.operacao)).status, 403);
    assert.equal((await api.get('/api/auth/eu', tk.operacao)).status, 200);
    api.db.prepare('UPDATE usuarios SET senha_provisoria = 0 WHERE id = ?').run(tk.operacao_id);
  });

  await t.test('Área do Cliente: com senha provisória, só dá para trocar a senha', async () => {
    const u = api.db.prepare('SELECT id FROM usuarios_cliente WHERE cliente_id = ?').get(a.cliente.id);
    api.db.prepare('UPDATE usuarios_cliente SET senha_provisoria = 1 WHERE id = ?').run(u.id);
    assert.equal((await api.get('/cliente/api/painel', a.token)).status, 403);
    assert.equal((await api.get('/cliente/api/auth/eu', a.token)).status, 200);
    api.db.prepare('UPDATE usuarios_cliente SET senha_provisoria = 0 WHERE id = ?').run(u.id);
  });

  await t.test('trocar a senha derruba as outras sessões; quem trocou segue com token novo', async () => {
    const outra = (await api.post('/api/auth/login', { email: 'consulta@payax.local', senha: 'senha-de-teste-1' })).dados.token;
    const r = await api.post('/api/auth/senha', { senha_atual: 'senha-de-teste-1', senha_nova: 'nova-senha-2026' }, tk.consulta);
    assert.equal(r.status, 200);
    assert.equal((await api.get('/api/painel', tk.consulta)).status, 401, 'token antigo caiu');
    assert.equal((await api.get('/api/painel', outra)).status, 401, 'a outra sessão também');
    assert.equal((await api.get('/api/painel', r.dados.token)).status, 200);
  });

  await t.test('o login guarda o IP na auditoria', async () => {
    await api.post('/api/auth/login', { email: 'admin@payax.local', senha: 'admin12345' });
    assert.ok(api.db.prepare("SELECT ip FROM auditoria WHERE acao = 'login' ORDER BY id DESC LIMIT 1").get().ip);
  });

  await t.test('X-Forwarded-Host não abre o Backoffice pelo endereço do site', async () => {
    assert.equal(await pedirComHost(api.raiz, '/js/app.js', { Host: 'payax.com.br' }), 404);
    assert.equal(await pedirComHost(api.raiz, '/js/app.js', { Host: 'payax.com.br', 'X-Forwarded-Host': 'pagamentos.payax.com.br' }), 404);
  });

  await t.test('senha provisória e link de ativação não ficam guardados na idempotência', async () => {
    const r = await api.post(`/api/clientes/${a.cliente.id}/acessos`, { nome: 'Novo', email: 'novo@alfa.test', perfil: 'operador' }, tk.admin, { 'Idempotency-Key': 'chave-teste-000001' });
    assert.equal(r.status, 201);
    const l = await api.post(`/api/clientes/${a.cliente.id}/acessos/${r.dados.id}/ativacao`, {}, tk.admin, { 'Idempotency-Key': 'chave-teste-000002' });
    assert.equal(l.status, 201);
    const guardado = JSON.stringify(api.db.prepare('SELECT corpo FROM idempotencia').all());
    assert.ok(!guardado.includes(r.dados.senha_provisoria));
    assert.ok(!guardado.includes('#t='));
  });

  await t.test('aviso do banco: evento que não é pagamento não liquida; estornado não liquida de novo', async () => {
    const token = await api.tokenWebhook(tk.admin);
    const b = await api.boleto(tk.admin, a.cliente.id, { valor: '100,00', vencimento: somarDias(hoje, 5) });
    for (const corpo of [{ evento: 'aguardando_pagamento' }, { evento: 'pagamento_estornado', valorPago: '100,00' }, { situacao: 'REGISTRADO' }]) {
      await api.post(`/api/publico/webhook/${token}`, { nossoNumero: b.nosso_numero, ...corpo });
      assert.equal(api.db.prepare('SELECT situacao FROM boletos WHERE id = ?').get(b.id).situacao, 'registrado', JSON.stringify(corpo));
    }
    const pago = { evento: 'liquidacao', nossoNumero: b.nosso_numero, valorPago: '100,00', dataPagamento: hoje };
    assert.equal((await api.post(`/api/publico/webhook/${token}`, pago)).dados.processado, true);
    assert.equal((await api.post(`/api/boletos/${b.id}/estorno`, { motivo: 'Pagamento devolvido pelo banco' }, tk.financeiro)).status, 200);
    const repetido = await api.post(`/api/publico/webhook/${token}`, pago);
    assert.equal(repetido.dados.processado, false);
    assert.notEqual(api.db.prepare('SELECT situacao FROM boletos WHERE id = ?').get(b.id).situacao, 'liquidado');
  });

  await t.test('limite mensal: boleto baixado (cancelado) não conta', async () => {
    const v = api.db.prepare('SELECT versao FROM clientes WHERE id = ?').get(a.cliente.id).versao;
    assert.equal((await api.patch(`/api/clientes/${a.cliente.id}`, { limite_mensal: '450,00', versao: v }, tk.admin)).status, 200);
    const b = await api.boleto(tk.admin, a.cliente.id, { valor: '300,00', vencimento: somarDias(hoje, 5) });
    assert.equal((await api.post(`/api/boletos/${b.id}/baixa`, { motivo: 'Emitido errado' }, tk.admin)).status, 200);
    await api.boleto(tk.admin, a.cliente.id, { valor: '300,00', vencimento: somarDias(hoje, 5) });
  });

  await t.test('nosso número do sistema do cliente com traço ("12345-6")', () => {
    const { nossoNumeroDoIxc } = require('../server/lib/sincronismo');
    assert.deepEqual(nossoNumeroDoIxc('12345-6'), { numero: '00000012345', dv: '6' });
    assert.deepEqual(nossoNumeroDoIxc('0000012345-P'), { numero: '00000012345', dv: 'P' });
  });

  await t.test('abertura: mudar dados depois da análise zera o checklist', async () => {
    const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF').toString('base64')}`;
    const p = await api.post('/api/publico/abertura', { aceite: true,
      empresa: { cnpj: CNPJ.beta, razao_social: 'Beta Ltda', email: 'b@beta.com.br', telefone: '1133334444', cep: '01001000', endereco: 'Rua', numero: '1', bairro: 'C', cidade: 'São Paulo', uf: 'SP' },
      representante: { nome: 'Maria', cpf: '11144477735', email: 'm@beta.com.br', telefone: '11999998888' },
      financeiro: { nome: 'João', email: 'j@beta.com.br', telefone: '11988887777' },
      destino: { banco: '237', agencia: '1', conta: '2', conta_dv: '3', pix_tipo: 'cnpj', pix_chave: CNPJ.beta },
      documentos: { contrato_social: { nome: 'c.pdf', conteudo: PDF } } });
    const id = Number(p.dados.protocolo.slice(3));
    const d = (await api.get(`/api/aberturas/${id}`, tk.admin)).dados;
    for (const c of d.checklist) await api.put(`/api/aberturas/${id}/checklist/${c.chave}`, { feito: true }, tk.admin);
    const e = await api.put(`/api/aberturas/${id}/dados`, { ...d, empresa: { ...d.empresa, razao_social: 'Outra Empresa Ltda' } }, tk.admin);
    assert.equal(e.status, 200, JSON.stringify(e.dados));
    assert.equal(e.dados.checklist.filter((c) => c.feito).length, 0);
    assert.ok(e.dados.pendencias.some((x) => /checklist/.test(x)));
  });
});
