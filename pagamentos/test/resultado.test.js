'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { dataLocal, somarDias } = require('../server/lib/datas');
const { somarMeses } = require('../server/lib/resultado');

const hoje = () => dataLocal('America/Sao_Paulo');

test('resultado da PAY AX (lucro real)', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin, { custo_emissao: '0,40', custo_liquidacao: '1,90', custo_pix: '0,10' });
  await api.precoPadrao(tk.admin, { tarifa_emissao: '1,00', tarifa_liquidacao: '2,50', percentual: '2,35', comissao_minima: '1,00' });
  const a = await api.cliente(tk.admin);
  const mes = hoje().slice(0, 7);

  const b = await api.boleto(tk.admin, a.cliente.id, { valor: '100,00', vencimento: somarDias(hoje(), 5) });
  await api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: hoje(), valor_pago: '100,00', meio: 'pix' }, tk.financeiro);

  await t.test('só administrador e financeiro veem e mexem', async () => {
    assert.equal((await api.get('/api/resultado', tk.consulta)).status, 403);
    assert.equal((await api.get('/api/resultado', tk.operacao)).status, 403);
    assert.equal((await api.post('/api/resultado/despesas', { categoria: 'outros', descricao: 'x', valor: '1,00', inicio: mes }, tk.operacao)).status, 403);
    assert.equal((await api.get('/api/resultado', tk.financeiro)).status, 200);
  });

  await t.test('receita, impostos, custos do banco, despesas e lucro do mês', async () => {
    assert.equal((await api.post('/api/resultado/despesas', { categoria: 'infraestrutura', descricao: 'Servidor', valor: '50,00', recorrencia: 'mensal', inicio: mes }, tk.admin)).status, 201);
    assert.equal((await api.post('/api/resultado/despesas', { categoria: 'servicos', descricao: 'Certificado', valor: '10,00', recorrencia: 'unica', inicio: mes }, tk.financeiro)).status, 201);
    assert.equal((await api.put('/api/resultado/imposto', { percentual: '6' }, tk.admin)).status, 200);

    const d = (await api.get(`/api/resultado?mes=${mes}`, tk.admin)).dados;
    // Receita: emissão 1,00 + tarifa PAY AX 2,35 + tarifa bancária 2,50.
    assert.equal(d.receita.total, 100 + 235 + 250);
    assert.equal(d.impostos.valor, Math.round(585 * 0.06));
    // Banco: registro 0,40 + liquidação 1,90 + PIX do repasse 0,10.
    assert.deepEqual([d.custo_banco.registro.valor, d.custo_banco.liquidacao.valor, d.custo_banco.pix.valor], [40, 190, 10]);
    assert.equal(d.margem_contribuicao, 585 - 35 - 240);
    assert.equal(d.despesas.total, 6000);
    assert.equal(d.lucro, 310 - 6000);
    assert.equal(d.equilibrio.boletos_necessarios, Math.ceil(6000 / 310));
    assert.equal(d.historico.length, 6);
    assert.equal(d.historico.at(-1).lucro, d.lucro);
  });

  await t.test('no mês seguinte a despesa mensal continua e a única não', async () => {
    const d = (await api.get(`/api/resultado?mes=${somarMeses(mes, 1)}`, tk.admin)).dados;
    assert.equal(d.despesas.total, 5000);
    assert.equal(d.receita.total, 0);
  });

  await t.test('despesa que já valeu em mês passado é encerrada, não apagada', async () => {
    const antiga = (await api.post('/api/resultado/despesas', { categoria: 'pessoal', descricao: 'Pró-labore', valor: '1000,00', inicio: somarMeses(mes, -2) }, tk.admin)).dados;
    assert.equal((await api.req('DELETE', `/api/resultado/despesas/${antiga.id}`, undefined, tk.admin)).status, 409);
    const fim = somarMeses(mes, -1);
    const r = await api.put(`/api/resultado/despesas/${antiga.id}`, { ...antiga, valor: '1000,00', fim }, tk.admin);
    assert.equal(r.status, 200);
    assert.equal((await api.get(`/api/resultado?mes=${fim}`, tk.admin)).dados.despesas.total, 100000, 'no mês anterior só o pró-labore (o servidor começa neste mês)');
    assert.equal((await api.get(`/api/resultado?mes=${mes}`, tk.admin)).dados.despesas.total, 6000, 'encerrada: não conta mais');
    const nova = (await api.post('/api/resultado/despesas', { categoria: 'outros', descricao: 'Lançada errada', valor: '5,00', inicio: mes }, tk.admin)).dados;
    assert.equal((await api.req('DELETE', `/api/resultado/despesas/${nova.id}`, undefined, tk.admin)).status, 200);
  });

  await t.test('valores e meses inválidos são recusados', async () => {
    assert.equal((await api.post('/api/resultado/despesas', { categoria: 'outros', descricao: 'x', valor: '0', inicio: mes }, tk.admin)).status, 422);
    assert.equal((await api.post('/api/resultado/despesas', { categoria: 'xyz', descricao: 'x', valor: '1,00', inicio: mes }, tk.admin)).status, 422);
    assert.equal((await api.get('/api/resultado?mes=2026-13', tk.admin)).status, 422);
    assert.equal((await api.put('/api/resultado/imposto', { percentual: '80' }, tk.admin)).status, 422);
  });
});
