'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { pontefalsa } = require('./ponte-falsa');

/** Sobe a ponte TEF de mentira e devolve o endereço dela. */
async function subirPonte(opcoes) {
  const servidor = pontefalsa(opcoes);
  servidor.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  return { url: `http://127.0.0.1:${servidor.address().port}`, fechar: () => new Promise((r) => servidor.close(r)) };
}

test('maquininha pela ponte TEF: cobrança pendente, consulta e aprovação', async (t) => {
  const app = await iniciar();
  const ponte = await subirPonte({ aprovarEm: 2 });
  t.after(async () => { await app.fechar(); await ponte.fechar(); });
  const admin = await app.login();

  const maquininha = (await app.post('/admin/maquininhas', {
    nome: 'Pinpad do caixa 1', provedor: 'ponte', url: ponte.url, taxa_debito_bp: 149, prazo_debito_dias: 1,
  }, admin)).dados;

  // O teste de comunicação fala com a ponte sem cobrar nada.
  const teste = await app.post(`/admin/maquininhas/${maquininha.id}/testar`, {}, admin);
  assert.equal(teste.status, 200);
  assert.match(teste.dados.mensagem, /Pinpad conectado/);

  const produto = (await app.post('/produtos', { nome: 'Chocolate', preco: '8,00', custo: '5,00', estoque: '10', categoria_id: 1 }, admin)).dados;
  await app.post('/caixa/abrir', { abertura: '0,00' }, admin);
  const venda = (await app.post('/pdv/venda', {}, admin)).dados;
  await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: produto.id, quantidade: 2 }, admin);

  // A ponte devolve 'pendente': o cliente ainda vai passar o cartão.
  const cobranca = await app.post(`/pdv/vendas/${venda.id}/cartao`, { maquininha_id: maquininha.id, forma: 'debito' }, admin);
  assert.equal(cobranca.status, 201);
  assert.equal(cobranca.dados.status, 'pendente');
  assert.ok(cobranca.dados.externo_id);

  // Enquanto está pendente, a venda não fecha.
  const cedo = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'debito', valor: '16,00', transacao_id: cobranca.dados.id }] }, admin);
  assert.equal(cedo.status, 409);

  // Primeira consulta: continua pendente. Segunda: aprovada com NSU e bandeira.
  assert.equal((await app.get(`/pdv/cartao/${cobranca.dados.id}`, admin)).dados.status, 'pendente');
  const aprovada = await app.get(`/pdv/cartao/${cobranca.dados.id}`, admin);
  assert.equal(aprovada.dados.status, 'aprovada');
  assert.equal(aprovada.dados.nsu, '998877');
  assert.equal(aprovada.dados.bandeira, 'Mastercard');
  assert.equal(aprovada.dados.taxa_centavos, 24); // 1,49% de R$ 16,00
  assert.equal(aprovada.dados.liquido_centavos, 1576);

  const paga = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'debito', valor: '16,00', transacao_id: cobranca.dados.id }] }, admin);
  assert.equal(paga.status, 200);
  assert.equal(paga.dados.pagamentos[0].nsu, '998877');
});

test('maquininha pela ponte TEF: cancelamento cancela também o recebível', async (t) => {
  const app = await iniciar();
  const ponte = await subirPonte({ aprovarEm: 1 });
  t.after(async () => { await app.fechar(); await ponte.fechar(); });
  const admin = await app.login();
  const maquininha = (await app.post('/admin/maquininhas', { nome: 'Pinpad', provedor: 'ponte', url: ponte.url }, admin)).dados;
  const produto = (await app.post('/produtos', { nome: 'Biscoito', preco: '10,00', custo: '6,00', estoque: '10', categoria_id: 1 }, admin)).dados;
  await app.post('/caixa/abrir', { abertura: '0,00' }, admin);
  const venda = (await app.post('/pdv/venda', {}, admin)).dados;
  await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: produto.id }, admin);

  const cobranca = (await app.post(`/pdv/vendas/${venda.id}/cartao`, { maquininha_id: maquininha.id, forma: 'credito' }, admin)).dados;
  assert.equal((await app.get(`/pdv/cartao/${cobranca.id}`, admin)).dados.status, 'aprovada');
  assert.equal((await app.get('/financeiro/lancamentos?tipo=receber&status=aberto', admin)).dados.length, 1);

  const cancelada = await app.post(`/pdv/cartao/${cobranca.id}/cancelar`, { motivo: 'Cliente desistiu' }, admin);
  assert.equal(cancelada.dados.status, 'cancelada');
  assert.equal((await app.get('/financeiro/lancamentos?tipo=receber&status=aberto', admin)).dados.length, 0);
  // Cancelada não paga venda.
  const recusada = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'credito', valor: '10,00', transacao_id: cobranca.id }] }, admin);
  assert.equal(recusada.status, 409);
});

test('maquininha fora do ar e cobranças pendentes que expiram', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();

  // Ponte apontando para uma porta sem ninguém ouvindo.
  const maquininha = (await app.post('/admin/maquininhas', { nome: 'Pinpad offline', provedor: 'ponte', url: 'http://127.0.0.1:9' }, admin)).dados;
  const produto = (await app.post('/produtos', { nome: 'Salgadinho', preco: '7,00', custo: '4,00', estoque: '10', categoria_id: 1 }, admin)).dados;
  await app.post('/caixa/abrir', { abertura: '0,00' }, admin);
  const venda = (await app.post('/pdv/venda', {}, admin)).dados;
  await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: produto.id }, admin);

  const erro = await app.post(`/pdv/vendas/${venda.id}/cartao`, { maquininha_id: maquininha.id, forma: 'debito' }, admin);
  assert.equal(erro.status, 502);
  // A tentativa fica registrada como negada, com o motivo.
  const transacoes = await app.get('/admin/transacoes', admin);
  assert.equal(transacoes.dados[0].status, 'negada');
  assert.ok(transacoes.dados[0].mensagem);

  // Mercado Pago sem token nem número de série é recusado antes de qualquer chamada.
  const mp = (await app.post('/admin/maquininhas', { nome: 'Point', provedor: 'mercadopago' }, admin)).dados;
  const semToken = await app.post(`/pdv/vendas/${venda.id}/cartao`, { maquininha_id: mp.id, forma: 'credito' }, admin);
  assert.equal(semToken.status, 409);

  // A rotina de limpeza encerra cobranças pendentes antigas.
  app.db.prepare(`INSERT INTO transacoes_cartao (maquininha_id, forma, parcelas, valor_centavos, criada_em, atualizada_em)
    VALUES (?, 'debito', 1, 1000, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`).run(maquininha.id);
  assert.equal(require('../server/lib/maquininha').expirarPendentes(app.db), 1);
});
