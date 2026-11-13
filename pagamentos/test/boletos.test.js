'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, CPF } = require('./helpers');
const febraban = require('../server/lib/febraban');
const pix = require('../server/lib/pix');
const codigobarras = require('../server/lib/codigobarras');

test('FEBRABAN: código de barras, linha digitável e nosso número do Bradesco', async (t) => {
  await t.test('o código gerado passa na própria validação e volta aos mesmos dados', () => {
    const b = febraban.boletoBradesco({ agencia: '3391', conta: '0006688', carteira: '09', nossoNumero: 12345, valorCentavos: 15075, vencimento: '2026-12-10' });
    assert.equal(b.codigo_barras.length, 44);
    assert.equal(b.linha_digitavel.length, 47);
    assert.ok(febraban.conferirCodigoBarras(b.codigo_barras));
    const lido = febraban.lerCodigoBarras(b.codigo_barras);
    assert.equal(lido.banco, '237');
    assert.equal(lido.valor_centavos, 15075);
    assert.equal(lido.vencimento, '2026-12-10');
    assert.equal(lido.agencia, '3391');
    assert.equal(lido.nosso_numero, '00000012345');
  });

  await t.test('os dígitos da linha digitável conferem campo a campo', () => {
    const b = febraban.boletoBradesco({ agencia: '1234', conta: '9876543', nossoNumero: 99, valorCentavos: 100, vencimento: '2027-01-15' });
    const l = b.linha_digitavel;
    for (const [i, campo] of [l.slice(0, 10), l.slice(10, 21), l.slice(21, 32)].entries()) {
      assert.equal(febraban.mod10(campo.slice(0, -1)), Number(campo.at(-1)), `campo ${i + 1}`);
    }
  });

  await t.test('o DV do nosso número segue a regra do Bradesco (resto 1 vira P, resto 0 vira 0)', () => {
    // Módulo 11 com pesos 2..7 sobre carteira (2) + nosso número (11).
    assert.equal(febraban.dvNossoNumeroBradesco('09', 2), 'P', 'resto 1 vira P');
    assert.equal(febraban.dvNossoNumeroBradesco('09', 7), '0', 'resto 0 vira 0');
    assert.equal(febraban.dvNossoNumeroBradesco('09', 1), '1');
    assert.equal(febraban.dvNossoNumeroBradesco('09', 14), '3');
    for (let n = 1; n <= 500; n++) assert.match(febraban.dvNossoNumeroBradesco('09', n), /^[0-9P]$/);
  });

  await t.test('o BR Code do Bolepix tem CRC válido e o valor certo', () => {
    const emv = pix.copiaECola({ chave: '12345678000195', nome: 'PayAx Pagamentos', cidade: 'Praia Grande', valorCentavos: 29990, txid: 'PAYAX00000000042' });
    assert.ok(pix.valido(emv));
    assert.equal(pix.ler(emv)['54'], '299.90');
    assert.equal(pix.ler(emv)['53'], '986');
  });

  await t.test('o desenho do código de barras tem a quantidade certa de barras', () => {
    const svg = codigobarras.svg('23798165100000299903391090000000004200066880');
    assert.equal((svg.match(/<rect/g) ?? []).length, 114); // 22 pares × 5 + início (2) + fim (2)
  });
});

test('boletos: emissão, validações e ciclo de vida', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin, { limite_boleto: '5.000,00' });

  await t.test('emite com código válido e nosso número sequencial', async () => {
    const um = await api.boleto(tk.admin, a.cliente.id, { valor: '150,75', vencimento: '2026-12-10' });
    const dois = await api.boleto(tk.admin, a.cliente.id, { valor: '99,90', vencimento: '2026-12-11' });
    assert.equal(um.situacao, 'registrado');
    assert.ok(febraban.conferirCodigoBarras(um.codigo_barras));
    assert.equal(Number(dois.nosso_numero), Number(um.nosso_numero) + 1);
    assert.ok(um.pix_emv, 'bolepix traz o BR Code');
    assert.equal(febraban.lerCodigoBarras(um.codigo_barras).valor_centavos, 15075);
  });

  await t.test('recusa valores e datas impossíveis', async () => {
    const ruim = (d) => api.post('/api/boletos', { cliente_id: a.cliente.id, pagador_nome: 'X', pagador_documento: CPF, valor: '100,00', vencimento: '2026-12-10', ...d }, tk.admin);
    assert.equal((await ruim({ valor: '1,00' })).status, 422, 'abaixo do mínimo');
    assert.equal((await ruim({ valor: '9.000,00' })).status, 422, 'acima do limite do cliente');
    assert.equal((await ruim({ vencimento: '2020-01-01', emissao: '2026-01-01' })).status, 422, 'vencimento antes da emissão');
    assert.equal((await ruim({ pagador_documento: '111.111.111-11' })).status, 422, 'CPF inválido');
    assert.equal((await ruim({ desconto: '200,00', desconto_ate: '2026-12-01' })).status, 422, 'desconto maior que o valor');
    assert.equal((await ruim({ desconto: '10,00' })).status, 422, 'desconto sem data limite');
  });

  await t.test('cliente suspenso não emite', async () => {
    const c = (await api.get(`/api/clientes/${a.cliente.id}`, tk.admin)).dados;
    await api.patch(`/api/clientes/${a.cliente.id}`, { situacao: 'suspenso', versao: c.versao }, tk.admin);
    const r = await api.post('/api/boletos', { cliente_id: a.cliente.id, valor: '50,00', vencimento: '2026-12-20', pagador_nome: 'X', pagador_documento: CPF }, tk.admin);
    assert.equal(r.status, 409);
    const c2 = (await api.get(`/api/clientes/${a.cliente.id}`, tk.admin)).dados;
    await api.patch(`/api/clientes/${a.cliente.id}`, { situacao: 'ativo', versao: c2.versao }, tk.admin);
  });

  await t.test('juros e multa só contam depois do vencimento', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { valor: '1.000,00', vencimento: '2026-12-10', juros_mes: '1', multa: '2' });
    const { valorAtualizado } = require('../server/lib/boletos');
    const bruto = api.db.prepare('SELECT * FROM boletos WHERE id = ?').get(b.id);
    assert.equal(valorAtualizado(bruto, '2026-12-05').valor_centavos, 100000);
    const atraso = valorAtualizado(bruto, '2026-12-25');
    assert.equal(atraso.multa_centavos, 2000);
    assert.equal(atraso.juros_centavos, 500); // 1% ao mês por 15 dias
    assert.equal(atraso.valor_centavos, 102500);
  });

  await t.test('baixa impede pagamento e liquidado não se baixa', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { valor: '80,00', vencimento: '2026-12-20' });
    assert.equal((await api.post(`/api/boletos/${b.id}/baixa`, { motivo: 'cliente desistiu' }, tk.operacao)).status, 200);
    assert.equal((await api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: '2026-12-20', valor_pago: '80,00' }, tk.financeiro)).status, 200);

    const pago = await api.boleto(tk.admin, a.cliente.id, { valor: '80,00', vencimento: '2026-12-21' });
    await api.post(`/api/boletos/${pago.id}/liquidar`, { pago_em: '2026-12-21', valor_pago: '80,00' }, tk.financeiro);
    const r = await api.post(`/api/boletos/${pago.id}/baixa`, { motivo: 'tentativa' }, tk.operacao);
    assert.equal(r.status, 409);
  });

  await t.test('a ficha de compensação sai pronta para imprimir', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { valor: '123,45', vencimento: '2026-12-28' });
    const r = await api.get(`/api/boletos/${b.id}/ficha`, tk.admin);
    assert.equal(r.status, 200);
    assert.match(r.dados, /Ficha de compensação/);
    assert.match(r.dados, /<rect/, 'tem o código de barras desenhado');
    assert.match(r.dados, /Bolepix/, 'tem o QR do PIX');
    assert.ok(r.dados.includes(b.linha_digitavel.slice(0, 5)));
  });

  await t.test('o link público só abre com a assinatura certa', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { valor: '55,00', vencimento: '2026-12-29' });
    const link = (await api.get(`/api/boletos/${b.id}/link`, tk.admin)).dados;
    assert.equal((await api.get(link.caminho)).status, 200, 'sem sessão, mas com assinatura');
    assert.equal((await api.get(`/api/publico/boleto/${b.id}/assinatura-errada-1234567890123456`)).status, 403);
  });
});
