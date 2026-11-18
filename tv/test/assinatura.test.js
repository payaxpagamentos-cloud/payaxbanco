'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { rodarCobranca } = require('../server/lib/assinaturas');
const { hoje, somarDias, somarMeses, competencia } = require('../server/lib/datas');

test('sem assinatura, o conteúdo fica bloqueado com 402', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const cliente = await s.assinante('sem@exemplo.com.br');
  const r = await s.get('/tv/home', cliente.token, cliente.comPerfil);
  assert.equal(r.status, 402);
  assert.equal(r.dados.detalhes.motivo, 'sem_assinatura');
});

test('contratar gera fatura com PIX, e o pagamento libera o acesso', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  await s.put('/admin/config', { pix_chave: 'pix@playtechvip.com.br', pix_recebedor: 'PLAY TECH VIP', pix_cidade: 'SAO PAULO' }, admin);

  const cliente = await s.assinante('novo@exemplo.com.br');
  const a = await s.post('/conta/assinar', { plano_id: 2 }, cliente.token);
  assert.equal(a.status, 201);
  assert.equal(a.dados.assinatura.status, 'pendente');
  assert.match(a.dados.fatura.pix_copia_cola, /^000201/, 'o PIX copia e cola começa no padrão EMV');
  assert.ok(a.dados.fatura.pix_copia_cola.includes('pix@playtechvip.com.br'));

  // Antes de pagar, nada de catálogo.
  assert.equal((await s.get('/tv/home', cliente.token, cliente.comPerfil)).status, 402);

  const pago = await s.post(`/conta/faturas/${a.dados.fatura.id}/pagar`, {}, cliente.token);
  assert.equal(pago.status, 200);
  assert.equal(pago.dados.assinatura.ativa, true);
  assert.equal(pago.dados.assinatura.acesso_ate, somarMeses(hoje(), 1));
  assert.equal((await s.get('/tv/home', cliente.token, cliente.comPerfil)).status, 200);
});

test('QR Code do PIX sai como SVG', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  await s.put('/admin/config', { pix_chave: 'pix@playtechvip.com.br' }, admin);
  const cliente = await s.assinante('qr@exemplo.com.br');
  const a = await s.post('/conta/assinar', { plano_id: 1 }, cliente.token);
  const qr = await s.get(`/conta/faturas/${a.dados.fatura.id}/qr`, cliente.token);
  assert.equal(qr.status, 200);
  assert.match(String(qr.dados), /^<svg/);
});

test('fatura vencida além da carência suspende o acesso; pagar reativa', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const cliente = await s.assinante('atrasado@exemplo.com.br', { plano: 1 });
  assert.equal((await s.get('/tv/home', cliente.token, cliente.comPerfil)).status, 200);

  // Fatura do próximo ciclo, vencida há 10 dias (a carência padrão é 5).
  const assinatura = s.db.prepare("SELECT * FROM assinaturas WHERE status = 'ativa'").get();
  s.db.prepare(`INSERT INTO faturas (assinatura_id, usuario_id, competencia, descricao, valor_centavos, vencimento, criada_em)
    VALUES (?, ?, '2000-01', 'Mensalidade atrasada', 1990, ?, ?)`)
    .run(assinatura.id, assinatura.usuario_id, somarDias(hoje(), -10), new Date().toISOString());

  const saida = rodarCobranca(s.db);
  assert.equal(saida.suspensas, 1);
  const barrado = await s.get('/tv/home', cliente.token, cliente.comPerfil);
  assert.equal(barrado.status, 402);
  assert.equal(barrado.dados.detalhes.motivo, 'suspensa');

  const aberta = s.db.prepare("SELECT id FROM faturas WHERE status = 'aberta'").get();
  const admin = await s.adminLogin();
  const confirmada = await s.post(`/admin/faturas/${aberta.id}/confirmar`, {}, admin);
  assert.equal(confirmada.status, 200);
  assert.equal((await s.get('/tv/home', cliente.token, cliente.comPerfil)).status, 200);
});

test('a cobrança gera a fatura do próximo ciclo uma vez só', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  await s.assinante('ciclo@exemplo.com.br', { plano: 1 });
  // Olha mais para a frente do que o padrão (máximo aceito: 30 dias), para alcançar a cobrança do mês que vem.
  const recusado = await s.put('/admin/config', { antecedencia_fatura_dias: 90 }, admin);
  assert.equal(recusado.status, 422, 'a antecedência tem limite');
  await s.put('/admin/config', { antecedencia_fatura_dias: 30 }, admin);
  assert.equal(rodarCobranca(s.db).faturas, 1, 'emite a fatura do mês seguinte');
  assert.equal(rodarCobranca(s.db).faturas, 0, 'não duplica a fatura da mesma competência');
  const competencias = s.db.prepare('SELECT competencia FROM faturas ORDER BY competencia').all().map((f) => f.competencia);
  assert.deepEqual(competencias, [competencia(hoje()), competencia(somarMeses(hoje(), 1))]);
});

test('fatura cancelada não impede emitir outra no mesmo mês', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const cliente = await s.assinante('recomeco@exemplo.com.br');
  const primeira = await s.post('/conta/assinar', { plano_id: 1 }, cliente.token);
  // Trocar de plano antes de pagar cancela a fatura da adesão e emite outra.
  const troca = await s.post('/conta/trocar-plano', { plano_id: 3 }, cliente.token);
  assert.equal(troca.dados.quando, 'agora');
  const faturas = s.db.prepare('SELECT id, status FROM faturas ORDER BY id').all();
  assert.equal(faturas.length, 2);
  assert.equal(faturas[0].status, 'cancelada');
  assert.equal(faturas[1].status, 'aberta');
  assert.notEqual(faturas[1].id, primeira.dados.fatura.id);
});

test('cancelamento mantém o acesso até o fim do período pago e pode ser desfeito', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const cliente = await s.assinante('cancela@exemplo.com.br', { plano: 2 });
  const c = await s.post('/conta/cancelar', { motivo: 'teste' }, cliente.token);
  assert.equal(c.status, 200);
  assert.equal(c.dados.assinatura.cancelar_no_fim, true);
  assert.equal((await s.get('/tv/home', cliente.token, cliente.comPerfil)).status, 200, 'continua assistindo até o fim');

  const r = await s.post('/conta/reativar', {}, cliente.token);
  assert.equal(r.dados.assinatura.cancelar_no_fim, false);

  // Quando o período pago termina, a assinatura se encerra sozinha.
  s.db.prepare("UPDATE assinaturas SET cancelar_no_fim = 1, acesso_ate = ? WHERE status = 'ativa'").run(somarDias(hoje(), -1));
  assert.equal(rodarCobranca(s.db).encerradas, 1);
  assert.equal((await s.get('/tv/home', cliente.token, cliente.comPerfil)).status, 402);
});

test('troca de plano vale na próxima cobrança e muda o limite de telas na hora', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const cliente = await s.assinante('troca@exemplo.com.br', { plano: 1 });
  assert.equal((await s.get('/conta/telas', cliente.token)).dados.limite, 1);
  const r = await s.post('/conta/trocar-plano', { plano_id: 3 }, cliente.token);
  assert.equal(r.dados.quando, 'proxima_cobranca');
  assert.equal((await s.get('/conta/telas', cliente.token)).dados.limite, 6);
});

test('o assinante não confirma o próprio pagamento fora do modo de testes', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const config = require('../server/config');
  const cliente = await s.assinante('manual@exemplo.com.br');
  const a = await s.post('/conta/assinar', { plano_id: 1 }, cliente.token);
  config.pagamentos = 'manual';
  const tentativa = await s.post(`/conta/faturas/${a.dados.fatura.id}/pagar`, {}, cliente.token);
  config.pagamentos = 'simulado';
  assert.equal(tentativa.status, 409);
});
