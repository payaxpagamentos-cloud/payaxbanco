'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Operadora falsa: responde como a Zenvia e como a Twilio e guarda o que recebeu.
const recebidos = [];
let recusar = false;
let apibrasil = 'ok';
const falsa = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    recebidos.push({ url: req.url, headers: req.headers, corpo });
    if (recusar) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: 'Número bloqueado' })); }
    if (req.url.startsWith('/apibrasil')) {
      if (req.headers.authorization !== 'Bearer tok-apibrasil') { res.writeHead(401); return res.end('{"error":true,"message":"Token inválido"}'); }
      if (apibrasil === 'saldo') { res.writeHead(402, { 'Content-Type': 'application/json' }); return res.end('{"error":true,"message":"Saldo insuficiente"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (apibrasil === 'erro200') return res.end(JSON.stringify({ error: true, message: 'Número inválido', response: { status: 'invalid' } }));
      return res.end(JSON.stringify({ error: false, message: 'Voce foi tarifado em R$ 0,10.', response: { data: { id: 'abr-1', status: 'processed' }, status: 'success' } }));
    }
    if (req.url.startsWith('/zenvia')) {
      if (req.headers['x-api-token'] !== 'tok-zenvia') { res.writeHead(401); return res.end('{"message":"token inválido"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'zen-123' }));
    }
    res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ sid: 'SM123' }));
  });
});

test('SMS com o protocolo da abertura de conta', async (t) => {
  await new Promise((r) => falsa.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${falsa.address().port}`;
  process.env.PAYAX_ZENVIA_URL = `${base}/zenvia/v2/channels/sms/messages`;
  process.env.PAYAX_TWILIO_URL = `${base}/twilio/2010-04-01`;
  process.env.PAYAX_APIBRASIL_SMS_URL = `${base}/apibrasil/sms/send/credits`;
  process.env.PAYAX_ARQUIVOS = fs.mkdtempSync(path.join(os.tmpdir(), 'payax-arq-'));
  const { iniciar, CNPJ, CPF } = require('./helpers');
  const sms = require('../server/lib/sms');
  const api = await iniciar();
  t.after(async () => { await api.fechar(); falsa.close(); });
  const tk = await api.equipe();
  const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF').toString('base64')}`;
  const pedido = (cnpj, financeiro = {}) => ({ aceite: true,
    empresa: { cnpj, razao_social: 'Provedor Ágil Ltda', nome_fantasia: 'Ágil Net', email: 'a@agil.com.br', telefone: '1133334444', cep: '01001000', endereco: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' },
    representante: { nome: 'Maria', cpf: CPF, email: 'm@agil.com.br', telefone: '11999998888' },
    financeiro: { nome: 'João', email: `j${cnpj.slice(0, 3)}@agil.com.br`, telefone: '(11) 98888-7777', ...financeiro },
    destino: { banco: '237', agencia: '1', conta: '2', conta_dv: '3', pix_tipo: 'cnpj', pix_chave: cnpj },
    documentos: { contrato_social: { nome: 'c.pdf', conteudo: PDF } } });
  const esperar = async (fn) => { for (let i = 0; i < 50; i += 1) { const x = fn(); if (x) return x; await new Promise((r) => setTimeout(r, 40)); } return null; };

  await t.test('celular: só número móvel com DDD', () => {
    assert.equal(sms.celular('(11) 98888-7777'), '+5511988887777');
    assert.equal(sms.celular('+55 11 98888-7777'), '+5511988887777');
    assert.equal(sms.celular('1133334444'), null);
    assert.equal(sms.mascarar('+5511988887777'), '(11) 9****-7777');
  });

  await t.test('o formulário exige celular do responsável financeiro', async () => {
    const r = await api.post('/api/publico/abertura', pedido(CNPJ.beta, { telefone: '1133334444' }));
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /celular do responsável financeiro/);
  });

  await t.test('sem SMS configurado: o pedido entra e o histórico diz por quê', async () => {
    const r = await api.post('/api/publico/abertura', pedido(CNPJ.alfa));
    assert.equal(r.status, 201);
    const id = Number(r.dados.protocolo.slice(3));
    const m = await esperar(() => api.db.prepare("SELECT * FROM sms_mensagens WHERE referencia_id = ?").get(id));
    assert.equal(m.situacao, 'nao_configurado');
    const d = (await api.get(`/api/aberturas/${id}`, tk.admin)).dados;
    assert.ok(d.interacoes.some((i) => /SMS com o protocolo não enviado/.test(i.texto)));
  });

  await t.test('Zenvia: configura, testa e envia o protocolo', async () => {
    assert.equal((await api.put('/api/integracoes/sms', { provedor: 'zenvia', remetente: 'payax', token: 'x' }, tk.financeiro)).status, 403);
    assert.equal((await api.put('/api/integracoes/sms', { provedor: 'zenvia', remetente: 'payax', token: 'tok-zenvia' }, tk.admin)).status, 200);
    const g = (await api.get('/api/integracoes', tk.admin)).dados.sms;
    assert.equal(g.configurada, true);
    assert.ok(!JSON.stringify(g).includes('tok-zenvia'), 'o token não volta para a tela');
    const teste = await api.post('/api/integracoes/sms/testar', { telefone: '11977776666' }, tk.admin);
    assert.equal(teste.dados.ok, true, JSON.stringify(teste.dados));
    assert.equal((await api.get('/api/integracoes', tk.admin)).dados.sms.estado, 'conectada');

    const r = await api.post('/api/publico/abertura', pedido(CNPJ.payax));
    const id = Number(r.dados.protocolo.slice(3));
    const m = await esperar(() => api.db.prepare("SELECT * FROM sms_mensagens WHERE referencia_id = ? AND situacao = 'enviado'").get(id));
    assert.ok(m, 'SMS enviado');
    assert.equal(m.destino, '+5511988887777');
    assert.equal(m.id_provedor, 'zen-123');
    const ultimo = JSON.parse(recebidos.at(-1).corpo);
    assert.equal(ultimo.to, '5511988887777');
    assert.equal(ultimo.from, 'payax');
    assert.match(ultimo.contents[0].text, new RegExp(`Protocolo ${r.dados.protocolo}`));
    assert.match(ultimo.contents[0].text, /Agil Net/, 'sem acento');
    assert.ok(ultimo.contents[0].text.length <= 160);
    const d = (await api.get(`/api/aberturas/${id}`, tk.operacao)).dados;
    assert.equal(d.sms[0].situacao, 'enviado');
    assert.equal(d.sms[0].destino, '(11) 9****-7777');
  });

  await t.test('operadora recusa: fica registrado; reenviar pela ficha', async () => {
    const id = api.db.prepare('SELECT id FROM solicitacoes_abertura ORDER BY id DESC LIMIT 1').get().id;
    recusar = true;
    const f = await api.post(`/api/aberturas/${id}/sms`, {}, tk.operacao);
    assert.equal(f.dados.situacao, 'falha');
    assert.match(f.dados.erro, /Número bloqueado/);
    assert.equal((await api.get('/api/integracoes', tk.admin)).dados.sms.estado, 'falha');
    recusar = false;
    const ok = await api.post(`/api/aberturas/${id}/sms`, {}, tk.operacao);
    assert.equal(ok.dados.situacao, 'enviado');
    assert.ok(ok.dados.pedido.interacoes.some((i) => /reenviado por/.test(i.texto)));
    assert.equal((await api.post(`/api/aberturas/${id}/sms`, {}, tk.consulta)).status, 403);
  });

  await t.test('Twilio: autenticação básica e número de envio', async () => {
    assert.equal((await api.put('/api/integracoes/sms', { provedor: 'twilio', remetente: '+5511900000000', token: '' }, tk.admin)).status, 422, 'trocar de operadora pede o token');
    const sid = `AC${'a'.repeat(32)}`;
    assert.equal((await api.put('/api/integracoes/sms', { provedor: 'twilio', remetente: '+5511900000000', token: 'tok-twilio', conta_sid: sid }, tk.admin)).status, 200);
    const r = await api.post('/api/integracoes/sms/testar', { telefone: '11977776666' }, tk.admin);
    assert.equal(r.dados.ok, true, JSON.stringify(r.dados));
    const ultimo = recebidos.at(-1);
    assert.equal(ultimo.url, `/twilio/2010-04-01/Accounts/${sid}/Messages.json`);
    assert.equal(ultimo.headers.authorization, `Basic ${Buffer.from(`${sid}:tok-twilio`).toString('base64')}`);
    const corpo = new URLSearchParams(ultimo.corpo);
    assert.equal(corpo.get('To'), '+5511977776666');
    assert.equal(corpo.get('From'), '+5511900000000');
  });

  await t.test('API Brasil: usa o mesmo token da consulta de CNPJ, sem configurar nada no SMS', async () => {
    api.db.prepare("DELETE FROM integracoes WHERE escopo = 'sms'").run();
    assert.equal((await api.put('/api/integracoes/dados', { token: 'tok-apibrasil' }, tk.admin)).status, 200);
    const g = (await api.get('/api/integracoes', tk.admin)).dados.sms;
    assert.equal(g.pronto, true);
    assert.equal(g.provedor_em_uso, 'apibrasil');
    const r = await api.post('/api/integracoes/sms/testar', { telefone: '(31) 99435-9434' }, tk.admin);
    assert.equal(r.dados.ok, true, JSON.stringify(r.dados));
    const ultimo = recebidos.at(-1);
    assert.equal(ultimo.url, '/apibrasil/sms/send/credits');
    assert.deepEqual(JSON.parse(ultimo.corpo), { number: '5531994359434', message: 'PAY AX: teste de envio de SMS. Se voce recebeu, a integracao esta funcionando.' });
    assert.equal((await api.get('/api/integracoes', tk.admin)).dados.sms.estado, 'conectada');
    // Pedido novo pelo site: protocolo por SMS pela API Brasil.
    const p = await api.post('/api/publico/abertura', pedido('11444777000161'));
    assert.equal(p.status, 201, JSON.stringify(p.dados));
    const id = Number(p.dados.protocolo.slice(3));
    const m = await esperar(() => api.db.prepare("SELECT * FROM sms_mensagens WHERE referencia_id = ? AND situacao = 'enviado'").get(id));
    assert.equal(m?.provedor, 'apibrasil');
    assert.equal(m.id_provedor, 'abr-1');
  });

  await t.test('API Brasil: erro com HTTP 200 e saldo insuficiente (402) viram falha com o motivo', async () => {
    apibrasil = 'erro200';
    const a = await api.post('/api/integracoes/sms/testar', { telefone: '11977776666' }, tk.admin);
    assert.equal(a.dados.ok, false);
    assert.match(a.dados.mensagem, /Número inválido/);
    apibrasil = 'saldo';
    const b = await api.post('/api/integracoes/sms/testar', { telefone: '11977776666' }, tk.admin);
    assert.match(b.dados.mensagem, /saldo insuficiente/);
    assert.equal((await api.get('/api/integracoes', tk.admin)).dados.sms.estado, 'falha');
    apibrasil = 'ok';
    // Escolher a API Brasil na tela, sem token próprio: continua usando o da consulta.
    assert.equal((await api.put('/api/integracoes/sms', { provedor: 'apibrasil' }, tk.admin)).status, 200);
    assert.equal((await api.post('/api/integracoes/sms/testar', { telefone: '11977776666' }, tk.admin)).dados.ok, true);
  });
});
