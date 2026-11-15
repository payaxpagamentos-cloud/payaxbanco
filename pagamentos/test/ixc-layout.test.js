'use strict';

/*
 * Modo "o IXC monta e envia o boleto": a PAY AX só registra no Bradesco, com o nosso número que o IXC deu,
 * e só quando o código que o IXC calculou é exatamente o que vai para o banco.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { criarIxcFalso } = require('./ixc-falso');
const febraban = require('../server/lib/febraban');
const { nossoNumeroDoIxc } = require('../server/lib/sincronismo');

test('IXC monta e envia o boleto; a PAY AX registra', async (t) => {
  const titulos = [];
  const ixc = criarIxcFalso({ titulos });
  const url = await ixc.iniciar();
  const api = await iniciar();
  t.after(async () => { await api.fechar(); await ixc.fechar(); });
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  const conta = api.db.prepare('SELECT * FROM contas_bancarias LIMIT 1').get();
  const venc = '2026-12-15';
  const codigo = (nn, valor) => febraban.boletoBradesco({ agencia: conta.agencia, conta: conta.conta, carteira: conta.carteira, nossoNumero: nn, valorCentavos: valor, vencimento: venc });
  const base = { id_cliente: '9001', valor: '99,90', data_vencimento: venc, status: 'A' };
  const certo = codigo('50000000001', 9990);
  titulos.push(
    { ...base, id: '7001', documento: 'OK', nosso_numero: '50000000001', linha_digitavel: certo.linha_digitavel },
    { ...base, id: '7002', documento: 'LINHA ERRADA', nosso_numero: '50000000002', linha_digitavel: codigo('50000000002', 1000).linha_digitavel },
    { ...base, id: '7003', documento: 'SEM NUMERO', nosso_numero: '' },
    { ...base, id: '7004', documento: 'FORA DA FAIXA', nosso_numero: '00000000005' },
    { ...base, id: '7005', documento: 'COM DV', nosso_numero: `50000000003-${codigo('50000000003', 9990).nosso_numero_dv}` },
  );

  await t.test('a faixa do IXC é validada e não pode ser de outro cliente', async () => {
    const cfg = { url, token: '7:hash', numeracao: 'ixc', faixa_inicio: '50000000000', faixa_fim: '50099999999' };
    assert.equal((await api.put(`/api/integracoes/ixc/${a.cliente.id}`, { ...cfg, faixa_fim: '' }, tk.admin)).status, 422);
    assert.equal((await api.put(`/api/integracoes/ixc/${a.cliente.id}`, cfg, tk.admin)).status, 200);
    const b = await api.cliente(tk.admin, { razao_social: 'Outro Provedor LTDA', nome_fantasia: 'Outro', cnpj: '19131243000197' });
    assert.equal((await api.put(`/api/integracoes/ixc/${b.cliente.id}`, { ...cfg, faixa_inicio: '50050000000', faixa_fim: '50150000000' }, tk.admin)).status, 409);
  });

  await t.test('registra com o número do IXC só quando o código bate', async () => {
    const r = (await api.post(`/api/integracoes/ixc/${a.cliente.id}/importar`, { de: '2026-12-01', ate: '2026-12-31' }, tk.operacao)).dados;
    const por = (id) => api.db.prepare('SELECT * FROM boletos WHERE ixc_receber_id = ?').get(id);
    assert.equal(por('7001').nosso_numero, '50000000001');
    assert.equal(por('7001').linha_digitavel.replace(/\D/g, ''), certo.linha_digitavel.replace(/\D/g, ''));
    assert.equal(por('7001').tipo, 'boleto', 'o layout do IXC não leva o QR do Bolepix');
    assert.equal(por('7005').nosso_numero, '50000000003', 'aceita o número com o dígito do IXC');
    assert.equal(por('7002'), undefined, 'linha diferente: nada registrado');
    assert.equal(por('7004'), undefined, 'fora da faixa: nada registrado');
    assert.equal(por('7003'), undefined, 'sem número ainda: fica para a próxima rodada');
    assert.equal(r.criados, 2);
    assert.ok(r.detalhes.some((d) => /não bate/.test(d.erro ?? '')));
    assert.ok(!ixc.chamadas.some((c) => c.metodo === 'PUT' && /7001/.test(c.url)), 'não regrava o título do IXC');
  });

  await t.test('a numeração da PAY AX pula a faixa reservada ao IXC', async () => {
    api.db.prepare('UPDATE contas_bancarias SET nosso_numero_atual = 49999999999 WHERE id = ?').run(conta.id);
    const b = await api.boleto(tk.admin, a.cliente.id, { vencimento: venc });
    assert.equal(api.db.prepare('SELECT nosso_numero FROM boletos WHERE id = ?').get(b.id).nosso_numero, '50100000000');
  });

  await t.test('leitura do nosso número do IXC', () => {
    assert.deepEqual(nossoNumeroDoIxc('12345'), { numero: '00000012345', dv: null });
    assert.deepEqual(nossoNumeroDoIxc('00000012345-p'), { numero: '00000012345', dv: 'P' });
    assert.equal(nossoNumeroDoIxc(''), null);
  });
});
