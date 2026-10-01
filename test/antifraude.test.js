'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const antifraude = require('../server/lib/antifraude');
const { lancar, novoGrupo } = require('../server/lib/conta');

test('Antifraude', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  const digitar = async (senha) => {
    const d = (await api.post('/ib/auth/teclado', {}, null)).dados;
    return { teclado_id: d.id, sequencia: [...senha].map((c) => d.teclas.findIndex((par) => par.includes(Number(c)))) };
  };
  const login = async (documento, senha) => api.post('/ib/auth/login', { documento, ...(await digitar(senha)) }, null);
  let tkAf, tkOper, ana, beto, contaAna, contaBeto, tkAna;

  await t.test('perfil Antifraude acessa o painel; outros perfis não', async () => {
    await api.post('/usuarios', { nome: 'Augusto Antifraude', email: 'af@payax.com.br', perfil: 'antifraude', senha: 'senha-forte-1' });
    await api.post('/usuarios', { nome: 'Otávio Operador', email: 'op@payax.com.br', perfil: 'operador', senha: 'senha-forte-1' });
    tkAf = await api.login('af@payax.com.br', 'senha-forte-1');
    tkOper = await api.login('op@payax.com.br', 'senha-forte-1');
    assert.equal((await api.get('/antifraude/painel', tkOper)).status, 403);
    assert.equal((await api.get('/antifraude/painel', tkAf)).status, 200);
    assert.equal((await api.get('/antifraude/painel')).status, 200);
    assert.equal((await api.post('/contas', { cliente_id: 1, tipo: 'corrente' }, tkAf)).status, 403);
  });

  await t.test('preparação: dois clientes com Internet Banking', async () => {
    ana = (await api.post('/clientes', { tipo: 'PF', nome: 'Ana Souza', documento: '529.982.247-25' })).dados;
    beto = (await api.post('/clientes', { tipo: 'PF', nome: 'Beto Lima', documento: '111.444.777-35' })).dados;
    contaAna = (await api.post('/contas', { cliente_id: ana.id, tipo: 'corrente' })).dados;
    contaBeto = (await api.post('/contas', { cliente_id: beto.id, tipo: 'corrente' })).dados;
    await api.creditar(contaAna.id, 10_000_000);
    const hab = await api.post(`/clientes/${ana.id}/internet-banking`);
    let tk = (await login('52998224725', hab.dados.senha_provisoria)).dados.token;
    await api.req('POST', '/ib/auth/primeiro-acesso', { nova_senha: '730194', pin: '482913' }, tk);
    await api.patch(`/clientes/${ana.id}/internet-banking`, { limite_diario_centavos: 10_000_000 });
    tkAna = (await login('52998224725', '730194')).dados.token;
    assert.ok(tkAna);
  });

  await t.test('tentativas de acesso: senha errada repetida e bloqueio viram alertas', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login('52998224725', '111111')).status, 401);
    const tent = (await api.get('/antifraude/painel', tkAf)).dados.tentativas;
    assert.ok(tent.some((x) => x.motivo === 'senha_incorreta_bloqueou'));
    assert.ok(tent.every((x) => !/52998224725/.test(x.identificador)), 'documento aparece mascarado');
    const regras = (await api.get('/antifraude/alertas', tkAf)).dados.map((a) => a.regra);
    assert.ok(regras.includes('senha_repetida'));
    assert.ok(regras.includes('acesso_bloqueado'));
    for (const doc of ['15350946056', '39053344705', '11144477735', '04252011000110', '45997418000153']) await login(doc, '123456');
    assert.ok((await api.get('/antifraude/alertas', tkAf)).dados.some((a) => a.regra === 'enumeracao_documentos'));
    assert.ok((await api.get('/antifraude/alertas', tkAf)).dados.some((a) => a.regra === 'forca_bruta_ip'));
    await api.post('/auth/login', { email: 'admin@payax.com.br', senha: 'errada' }, null);
    api.db.prepare("UPDATE acessos_cliente SET bloqueado_ate = NULL, tentativas = 0").run();
  });

  await t.test('transações fora do padrão', async () => {
    const transferir = async (valor) => api.req('POST', '/ib/transferencias', {
      conta_id: contaAna.id, destino_agencia: contaBeto.agencia, destino_numero: `${contaBeto.numero}-${contaBeto.digito}`, valor_centavos: valor, pin: await digitar('482913'),
    }, tkAna);
    for (let i = 0; i < 3; i++) assert.equal((await transferir(10_000)).status, 201);
    assert.equal((await transferir(2_000_000)).status, 201); // 200x a média
    await transferir(10_000);
    const alertas = (await api.get('/antifraude/alertas', tkAf)).dados;
    const regras = new Set(alertas.map((a) => a.regra));
    assert.ok(regras.has('valor_atipico'));
    assert.ok(regras.has('rajada'));
    assert.ok(regras.has('conta_nova'));
    const atip = alertas.find((a) => a.regra === 'valor_atipico');
    assert.equal(atip.severidade, 'alta');
    assert.equal(atip.valor_centavos, 2_000_000);
  });

  await t.test('operação de madrugada e destinatário novo', async () => {
    const tx = lancar(api.db, { contaId: contaAna.id, tipo: 'transferencia_enviada', valor: -600_000, descricao: 'teste', contraparteId: null, grupo: novoGrupo(), canal: 'internet_banking' });
    api.db.prepare("UPDATE transacoes SET criado_em = '2026-10-01 05:30:00' WHERE id = ?").run(tx.id); // 02h30 em Brasília
    antifraude.analisar(api.db);
    const regras = (await api.get('/antifraude/alertas', tkAf)).dados.filter((a) => a.transacao_id === tx.id).map((a) => a.regra);
    assert.ok(regras.includes('horario_noturno'));
  });

  await t.test('análise: descartar exige parecer; confirmar bloqueia o acesso e pede bloqueio da conta à Ouvidoria', async () => {
    const atip = (await api.get('/antifraude/alertas?status=aberto', tkAf)).dados.find((a) => a.regra === 'valor_atipico');
    const det = (await api.get(`/antifraude/alertas/${atip.id}`, tkAf)).dados;
    assert.equal(det.transacao.valor_centavos, -2_000_000);
    assert.equal((await api.post(`/antifraude/alertas/${atip.id}/decidir`, { acao: 'descartar' }, tkAf)).status, 422);
    const r = await api.post(`/antifraude/alertas/${atip.id}/decidir`, { acao: 'confirmar', parecer: 'Cliente não reconhece a operação.', bloquear_ib: true, bloquear_conta: true }, tkAf);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.status, 'confirmado');
    assert.equal(r.dados.efeitos[0], 'Acesso ao Internet Banking bloqueado');
    assert.match(r.dados.efeitos[1], /Ouvidoria \(OUV-/);
    assert.equal((await api.get(`/clientes/${ana.id}/internet-banking`)).dados.status, 'bloqueado');
    assert.equal((await api.post(`/antifraude/alertas/${atip.id}/decidir`, { acao: 'descartar', parecer: 'De novo' }, tkAf)).status, 409);
  });

  await t.test('painel resume os números', async () => {
    const p = (await api.get('/antifraude/painel?dias=7', tkAf)).dados;
    assert.ok(p.abertos > 0);
    assert.ok(p.alta_abertos > 0);
    assert.equal(p.confirmados, 1);
    assert.ok(p.acessos_24h.falhas >= 11);
    assert.equal(p.acessos_24h.falhas_equipe, 1);
    assert.equal(p.serie.length, 7);
    assert.equal(p.horas.length, 24);
    assert.ok(p.por_regra.length >= 6);
    assert.equal(p.clientes[0].nome, 'Ana Souza');
    assert.ok(p.transacoes_24h.analisadas >= 5);
  });
});
