'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, PNG, PDF } = require('./helpers');

test('fundação: acesso, perfis, isolamento, idempotência, anexos e auditoria', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();

  await t.test('login e permissões devolvidas pelo servidor', async () => {
    assert.equal((await api.post('/auth/login', { email: 'admin@managernetwork.local', senha: 'errada' })).status, 401);
    assert.equal((await api.get('/frota/veiculos')).status, 401);
    const me = (await api.get('/auth/me', tk.tecnico)).dados.usuario;
    assert.equal(me.perfil, 'tecnico');
    assert.equal(me.tecnico_id, tk.tecnico_tid);
    assert.ok(!me.permissoes.includes('comissoes.aprovar'));
  });

  await t.test('perfil sem permissão recebe 403 no servidor', async () => {
    assert.equal((await api.post('/frota/veiculos', { placa: 'ABC1D23', modelo: 'X' }, tk.tecnico)).status, 403);
    assert.equal((await api.post('/frota/veiculos', { placa: 'ABC1D23', modelo: 'X' }, tk.consulta)).status, 403);
    assert.equal((await api.get('/organizacao/usuarios', tk.gestor)).status, 403);
    assert.equal((await api.get('/rastreamento/mapa', tk.tecnico)).status, 403, 'técnico não vê a posição das equipes');
    assert.equal((await api.get('/equipe/pagamentos', tk.gestor)).status, 403);
    assert.equal((await api.get('/noc/tv', tk.consulta)).status, 200);
    assert.equal((await api.post('/noc/incidentes', { titulo: 'x', severidade: 'alta' }, tk.consulta)).status, 403, 'TV/consulta não escreve');
  });

  await t.test('isolamento entre organizações', async () => {
    const veic = (await api.post('/frota/veiculos', { placa: 'QWE1234', modelo: 'Strada' }, tk.frota)).dados;
    const outro = await api.outraOrganizacao();
    assert.equal((await api.get(`/frota/veiculos/${veic.id}`, outro)).status, 404);
    assert.equal((await api.get('/frota/veiculos', outro)).dados.total, 0);
    // A mesma placa pode existir em outra organização.
    assert.equal((await api.post('/frota/veiculos', { placa: 'QWE-1234', modelo: 'Strada' }, outro)).status, 201);
    assert.equal((await api.patch(`/frota/veiculos/${veic.id}`, { modelo: 'Y', versao: 1 }, outro)).status, 404);
  });

  await t.test('idempotência: repetir o comando devolve a mesma resposta sem duplicar', async () => {
    const h = { 'Idempotency-Key': 'criar-chamado-0001' };
    const a = await api.post('/chamados', { tipo: 'reparo', titulo: 'Sem sinal', prioridade: 'alta' }, tk.gestor, h);
    const b = await api.post('/chamados', { tipo: 'reparo', titulo: 'Sem sinal', prioridade: 'alta' }, tk.gestor, h);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers.get('idempotent-replay'), 'true');
    assert.equal(a.dados.id, b.dados.id);
    assert.equal((await api.get('/chamados', tk.gestor)).dados.total, 1);
    assert.equal((await api.post('/frota/veiculos', { placa: 'ZZZ9Z99', modelo: 'X' }, tk.gestor, h)).status, 409, 'mesma chave em outra rota');
  });

  await t.test('anexos: tipo pelo conteúdo, acesso por recurso e link temporário', async () => {
    const txt = await api.post('/anexos?recurso=abastecimento', Buffer.from('não é imagem'), tk.frota);
    assert.equal(txt.status, 415);
    const a = await api.post('/anexos?recurso=abastecimento', PDF, tk.frota, { 'X-Nome-Arquivo': encodeURIComponent('cupom posto.pdf') });
    assert.equal(a.status, 201);
    assert.equal(a.dados.mime, 'application/pdf');
    // Perfil sem permissão de comprovantes: acesso negado no servidor, no link e no arquivo.
    assert.equal((await api.get(`/anexos/${a.dados.id}/link`, tk.noc)).status, 403);
    const link = (await api.get(`/anexos/${a.dados.id}/link`, tk.frota)).dados;
    const arq = await fetch(api.raiz + link.url);
    assert.equal(arq.status, 200);
    assert.equal(arq.headers.get('content-type'), 'application/pdf');
    const adulterado = link.url.replace(/s=[^&]+/, 's=abc');
    assert.equal((await fetch(api.raiz + adulterado)).status, 403);
    const outro = await api.outraOrganizacao().catch(() => api.login('admin@outro.local', 'senha-outro-123'));
    assert.equal((await api.get(`/anexos/${a.dados.id}/link`, outro)).status, 404);
    assert.equal((await api.post('/anexos?recurso=chamado&recurso_id=999', PNG, tk.gestor)).status, 404);
  });

  await t.test('auditoria com request ID e sem segredos', async () => {
    const r = await api.post('/organizacao/usuarios', { nome: 'Novo', email: 'novo@teste.local', senha: 'senha-secreta-1', perfil: 'consulta' }, tk.admin);
    const reqId = r.headers.get('x-request-id');
    const log = (await api.get('/organizacao/auditoria?acao=usuario_criado', tk.admin)).dados.itens;
    const item = log.find((x) => x.request_id === reqId);
    assert.ok(item);
    assert.doesNotMatch(JSON.stringify(log), /senha-secreta-1/);
    assert.equal((await api.get('/organizacao/auditoria', tk.gestor)).status, 403);
  });

  await t.test('CSV neutraliza fórmulas', async () => {
    const { csv } = require('../server/lib/http');
    assert.match(csv([['=HYPERLINK("x")', -5, '+1', 'ok']]), /'=HYPERLINK\(""x""\)";-5;'\+1;ok/);
  });
});
