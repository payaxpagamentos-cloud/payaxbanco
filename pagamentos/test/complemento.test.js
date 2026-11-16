'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { dataLocal, somarDias } = require('../server/lib/datas');
const cnab = require('../server/lib/cnab400');

test('complemento do endereço do pagador: guardado, impresso e na remessa', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin, { tarifa_fixa: '1,99', tarifa_liquidacao: '0', percentual: '0', comissao_minima: '0' });
  const a = await api.cliente(tk.admin);
  const b = await api.boleto(tk.admin, a.cliente.id, { tipo: 'boleto', valor: '10,00', vencimento: somarDias(dataLocal('America/Sao_Paulo'), 5),
    pagador_endereco: 'Rua José de Oliveira Coelho', pagador_numero: '808', pagador_complemento: 'Apto 12 Bl B', pagador_cep: '05727240' });
  const linha = api.db.prepare('SELECT * FROM boletos WHERE id = ?').get(b.id);
  assert.equal(linha.pagador_complemento, 'Apto 12 Bl B');
  const ficha = (await api.get(`/api/boletos/${b.id}/ficha`, tk.admin)).dados;
  assert.match(String(ficha), /Rua José de Oliveira Coelho, 808, Apto 12 Bl B/);
  const conta = api.db.prepare('SELECT * FROM contas_bancarias LIMIT 1').get();
  const detalhe = cnab.detalheRemessa(linha, conta, { sequencial: 2, hoje: '2026-11-16' });
  assert.equal(detalhe.length, 400);
  assert.match(detalhe.slice(274, 314), /^RUA JOSE DE OLIVEIRA COELHO, 808, APTO 1/i, 'endereço com complemento nas posições 275-314');
});
