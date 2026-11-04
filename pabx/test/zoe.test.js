'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ixcFalso } = require('./ixc-falso');
const { iniciar } = require('./helpers');
const { mesmoTelefone, formatarDocumento } = require('../server/zoe/ixc');
const { falarValor, falarData } = require('../server/zoe/core');

test('funções de apoio da ZOE', () => {
  assert.ok(mesmoTelefone('(11) 98765-4321', '5511987654321'));
  assert.ok(mesmoTelefone('(11) 8765-4321', '011987654321'), 'celular antigo, sem o 9');
  assert.ok(!mesmoTelefone('(21) 98765-4321', '11987654321'), 'DDD diferente');
  assert.ok(mesmoTelefone('98765-4321', '11987654321'), 'cadastro sem DDD');
  assert.equal(formatarDocumento('52998224725'), '529.982.247-25');
  assert.equal(formatarDocumento('11222333000181'), '11.222.333/0001-81');
  assert.equal(falarValor(9990), '99 reais e 90 centavos');
  assert.equal(falarValor(100), '1 real');
  assert.equal(falarData('2026-10-10'), '10 de outubro');
});

test('ZOE', async (t) => {
  const api = await iniciar();
  const ixc = await ixcFalso();
  const whats = [];
  const webhook = http.createServer((req, res) => {
    let c = '';
    req.on('data', (x) => { c += x; });
    req.on('end', () => { whats.push(JSON.parse(c)); res.end('{}'); });
  });
  await new Promise((r) => webhook.listen(0, '127.0.0.1', r));
  t.after(async () => { await api.fechar(); await ixc.fechar(); webhook.closeAllConnections(); await new Promise((r) => webhook.close(r)); });

  const master = await api.login();
  const empresa = (await api.post('/master/empresas', {
    nome: 'Provedor Net', administrador: { nome: 'Gestor', email: 'gestor@provedor.net', senha: 'senha-do-gestor' },
  }, master)).dados.id;
  const gestor = await api.login('gestor@provedor.net', 'senha-do-gestor');
  const base = `/empresas/${empresa}/zoe`;
  const filaFin = (await api.post(`/empresas/${empresa}/filas`, { nome: 'Financeiro' }, gestor)).dados.id;
  const filaSup = (await api.post(`/empresas/${empresa}/filas`, { nome: 'Suporte' }, gestor)).dados.id;
  const chave = (await api.post(`/empresas/${empresa}/chaves`, { nome: 'Asterisk' }, gestor)).dados.chave;
  const central = api.central(chave);
  const zoe = (uid, etapa, corpo) => central.post(`/zoe/atendimentos/${uid}/${etapa}`, corpo);

  await t.test('desligada, a ZOE recusa a ligação (a central segue o plano normal)', async () => {
    const r = await central.post('/zoe/atendimentos', { uid: 'x0', telefone: '11987654321' });
    assert.equal(r.status, 409);
  });

  await t.test('configuração: valida, testa o IXC e nunca devolve o token', async () => {
    assert.equal((await api.put(base, { ativo: true }, gestor)).status, 422, 'não liga sem IXC');
    assert.equal((await api.put(base, { ixc_url: 'ftp://ixc' }, gestor)).status, 422);
    assert.equal((await api.put(base, { canal_whatsapp: true }, gestor)).status, 422, 'WhatsApp exige o webhook');
    const ruim = await api.post(`${base}/testar`, { ixc_url: ixc.url, ixc_token: 'errado' }, gestor);
    assert.equal(ruim.status, 502);
    assert.match(ruim.dados.erro, /recusou o token/);
    assert.equal((await api.post(`${base}/testar`, { ixc_url: ixc.url, ixc_token: ixc.estado.token }, gestor)).status, 200);
    const r = await api.put(base, {
      ativo: true, ixc_url: `${ixc.url}/webservice/v1/`, ixc_token: ixc.estado.token, canal_whatsapp: true,
      whatsapp_webhook: `http://127.0.0.1:${webhook.address().port}/zoe`, fila_financeiro_id: filaFin, fila_suporte_id: filaSup,
    }, gestor);
    assert.equal(r.status, 200);
    assert.equal(r.dados.token_configurado, true);
    assert.equal(r.dados.ixc_url, ixc.url);
    const painel = (await api.get(base, gestor)).dados;
    assert.ok(!JSON.stringify(painel).includes('segredo-do-ixc'), 'o token não volta para o painel');
    const guardado = api.db.prepare('SELECT ixc_token_cifrado FROM zoe_config WHERE empresa_id = ?').get(empresa).ixc_token_cifrado;
    assert.ok(!guardado.includes('segredo'), 'o token fica cifrado no banco');
    assert.equal((await api.post(`${base}/testar`, {}, gestor)).status, 200, 'testa com o token salvo');
  });

  await t.test('número cadastrado: confirma com os 3 primeiros dígitos do CPF', async () => {
    const r = await central.post('/zoe/atendimentos', { uid: 'c1', telefone: '5511987654321' });
    assert.equal(r.status, 201);
    assert.equal(r.dados.etapa, 'confirmar');
    assert.equal(r.dados.metodo, 'cpf3');
    assert.ok(!('cliente' in r.dados), 'não revela o cliente antes da confirmação');
    assert.match(r.dados.fala, /gravada/);
    assert.equal((await central.post('/zoe/atendimentos', { uid: 'c1', telefone: '5511987654321' })).dados.repetida, true);
    assert.equal((await zoe('c1', 'desbloqueio')).status, 409, 'nada antes de confirmar');
    const errado = await zoe('c1', 'confirmar', { codigo: '111' });
    assert.equal(errado.dados.etapa, 'confirmar');
    const ok = await zoe('c1', 'confirmar', { codigo: '529' });
    assert.equal(ok.dados.etapa, 'menu');
    assert.equal(ok.dados.cliente.nome, 'Maria');
    assert.ok(ixc.estado.pedidos.every((p) => p.recurso === 'cliente' ? p.listar : true), 'consultas com ixcsoft: listar');
  });

  await t.test('segunda via: lista as abertas e envia só para contatos do cadastro', async () => {
    const f = await central.get('/zoe/atendimentos/c1/faturas');
    assert.equal(f.status, 200);
    assert.deepEqual(f.dados.faturas.map((x) => x.id), ['900', '901'], 'só as abertas, a mais antiga primeiro');
    assert.equal(f.dados.total_centavos, 19980);
    assert.match(f.dados.fala, /2 faturas em aberto.*10 de outubro.*99 reais e 90 centavos/);
    assert.deepEqual(f.dados.canais.map((c) => c.canal), ['whatsapp', 'sms', 'email']);
    assert.equal(f.dados.canais[2].destino, 'e-mail m***@exemplo.com');
    assert.ok(!JSON.stringify(f.dados).includes('maria@'), 'não expõe o e-mail completo');

    const sms = await zoe('c1', 'boleto', { canal: 'sms' });
    assert.equal(sms.status, 200);
    assert.equal(sms.dados.fatura.id, '900');
    assert.equal(sms.dados.destino, 'celular final 4321');
    assert.ok(ixc.estado.pedidos.some((p) => p.recurso === 'get_boleto' && p.corpo.tipo_boleto === 'sms' && p.corpo.boletos === '900'));

    const w = await zoe('c1', 'boleto', { canal: 'whatsapp', fatura_id: '901' });
    assert.equal(w.status, 200);
    assert.equal(whats.length, 1);
    assert.equal(whats[0].telefone, '11987654321', 'o WhatsApp vai para o número do cadastro');
    assert.equal(whats[0].pdf_base64, 'JVBERi0x');
    assert.equal((await zoe('c1', 'boleto', { canal: 'whatsapp', fatura_id: '899' })).status, 422, 'fatura paga não');
    assert.equal((await zoe('c1', 'boleto', { canal: 'pombo' })).status, 422);
  });

  await t.test('desbloqueio de confiança: só bloqueio por atraso e dentro do limite', async () => {
    const r = await zoe('c1', 'desbloqueio');
    assert.equal(r.dados.liberado, true);
    assert.equal(ixc.estado.contratos[0].status_internet, 'A');
    // Outra ligação da mesma cliente, bloqueada de novo: o limite (1 por 30 dias) segura.
    ixc.estado.contratos[0].status_internet = 'CA';
    await central.post('/zoe/atendimentos', { uid: 'c2', telefone: '11987654321' });
    await zoe('c2', 'confirmar', { codigo: '529' });
    const limite = await zoe('c2', 'desbloqueio');
    assert.equal(limite.dados.liberado, false);
    assert.equal(limite.dados.motivo, 'limite');
    ixc.estado.contratos[0].status_internet = 'CM';
    await api.put(base, { desbloqueio_limite: 5 }, gestor);
    await central.post('/zoe/atendimentos', { uid: 'c3', telefone: '11987654321' });
    await zoe('c3', 'confirmar', { codigo: '529' });
    const manual = await zoe('c3', 'desbloqueio');
    assert.equal(manual.dados.motivo, 'bloqueio_manual', 'bloqueio manual nunca é liberado pela ZOE');
  });

  await t.test('transferência leva a fila do motivo e o resumo para o atendente', async () => {
    const r = await zoe('c2', 'transferir', { motivo: 'financeiro' });
    assert.equal(r.dados.etapa, 'transferir');
    assert.deepEqual(r.dados.fila, { id: filaFin, nome: 'Financeiro' });
    assert.match(r.dados.resumo, /MARIA DA SILVA \(IXC 10\).*desbloqueio negado \(limite\).*pediu: financeiro/);
    assert.equal((await zoe('c2', 'fim')).dados.resultado, 'transferido');
    assert.equal((await zoe('c1', 'fim')).dados.resultado, 'resolvido');
    assert.equal((await zoe('c1', 'fim')).dados.resultado, 'resolvido', 'fim repetido não muda nada');
  });

  await t.test('número desconhecido: CPF completo e data de nascimento', async () => {
    await central.post('/zoe/atendimentos', { uid: 'd1', telefone: '1140040000' });
    assert.equal((await zoe('d1', 'confirmar', { codigo: '1' })).status, 409);
    const invalido = await zoe('d1', 'documento', { documento: '123' });
    assert.equal(invalido.dados.etapa, 'documento');
    assert.match(invalido.dados.fala, /não parece/);
    const doc = await zoe('d1', 'documento', { documento: '52998224725' });
    assert.equal(doc.dados.etapa, 'confirmar');
    assert.equal(doc.dados.metodo, 'nascimento');
    assert.equal((await zoe('d1', 'confirmar', { codigo: '05031990' })).dados.etapa, 'menu');

    // Sem data de nascimento no cadastro não há como confirmar: vai para um atendente.
    await central.post('/zoe/atendimentos', { uid: 'd2' });
    const semData = await zoe('d2', 'documento', { documento: '111.444.777-35' });
    assert.equal(semData.dados.etapa, 'transferir');
    assert.deepEqual(semData.dados.fila, { id: filaSup, nome: 'Suporte' });
  });

  await t.test('três erros na confirmação transferem', async () => {
    await central.post('/zoe/atendimentos', { uid: 'e1', telefone: '11987654321' });
    for (let i = 0; i < 2; i++) assert.equal((await zoe('e1', 'confirmar', { codigo: '000' })).dados.etapa, 'confirmar');
    assert.equal((await zoe('e1', 'confirmar', { codigo: '000' })).dados.etapa, 'transferir');
  });

  await t.test('IXC fora do ar: avisa e transfere em até ~3 segundos', async () => {
    ixc.estado.lento = true;
    const ini = Date.now();
    const r = await central.post('/zoe/atendimentos', { uid: 'f1', telefone: '11987654321' });
    ixc.estado.lento = false;
    assert.ok(Date.now() - ini < 3400, `demorou ${Date.now() - ini} ms`);
    assert.equal(r.dados.etapa, 'transferir');
    assert.match(r.dados.fala, /dificuldade/);
    assert.match(r.dados.resumo, /falha no IXC: O IXC não respondeu a tempo/);
  });

  await t.test('painel: indicadores, histórico e só o administrador altera', async () => {
    const p = (await api.get(base, gestor)).dados;
    assert.equal(p.hoje.total, 7);
    assert.equal(p.hoje.resolvidos, 1);
    assert.equal(p.mes.boletos, 2);
    assert.equal(p.mes.desbloqueios, 1);
    const c1 = p.ultimos.find((a) => a.uid === 'c1');
    const det = (await api.get(`${base}/atendimentos/${c1.id}`, gestor)).dados;
    assert.deepEqual(det.acoes.map((a) => a.tipo), ['identificacao', 'confirmacao', 'confirmacao', 'faturas', 'boleto', 'boleto', 'desbloqueio']);
    assert.ok(!JSON.stringify(det).includes('529.982'), 'o CPF não fica guardado');

    await api.post(`/empresas/${empresa}/usuarios`, { nome: 'Sup', email: 'sup@provedor.net', perfil: 'supervisor', senha: 'senha-do-sup' }, gestor);
    const sup = await api.login('sup@provedor.net', 'senha-do-sup');
    assert.equal((await api.get(base, sup)).status, 200);
    assert.equal((await api.put(base, { ativo: false }, sup)).status, 403);
    const outra = (await api.post('/master/empresas', { nome: 'Outra' }, master)).dados.id;
    assert.equal((await api.get(`/empresas/${outra}/zoe/atendimentos/${c1.id}`, master)).status, 404);
  });
});
