'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, CPF } = require('./helpers');
const cnab = require('../server/lib/cnab400');
const { gerarRetorno } = require('./retorno-falso');
const repassesLib = require('../server/lib/repasses');
const { dataLocal, somarDias } = require('../server/lib/datas');

const hoje = () => dataLocal('America/Sao_Paulo');
const CONTA = { carteira: '09', agencia: '3391', conta: '0006688', conta_dv: '4', beneficiario_nome: 'PAY AX Brasil Ltda', beneficiario_documento: '12345678000195' };
const destino = { banco: '237', agencia: '1234', agencia_dv: '5', conta: '98765', conta_dv: '0', nome: 'Connect Link Telecom Ltda' };

test('rateio de crédito: o Bradesco credita o cliente direto (CNAB 400, registro 3)', async (t) => {
  const boleto = {
    nosso_numero: '00000000042', nosso_numero_dv: '9', seu_numero: 'FAT-1', valor_centavos: 10000, emissao: '2026-11-13',
    vencimento: '2026-12-05', juros_mes_ppm: 10000, multa_ppm: 20000, desconto_centavos: 0, dias_baixa: 60,
    pagador_nome: 'Fulano', pagador_documento: CPF, pagador_cep: '11700000', pagador_endereco: 'Rua A', pagador_numero: '1',
    beneficiario_final_nome: 'Connect Link Telecom Ltda', beneficiario_final_documento: '11222333000181',
    rateio_ppm: 980100, rateio_destino: JSON.stringify(destino),
  };

  await t.test('o registro 3 vai logo depois do registro 1, com a parte do cliente em percentual', () => {
    const linhas = cnab.gerarRemessa({ conta: CONTA, boletos: [boleto], sequencial: 1, hoje: '2026-11-13' }).conteudo.split('\r\n').filter(Boolean);
    assert.deepEqual(linhas.map((l) => l[0]), ['0', '1', '3', '9'], 'header, título, rateio, trailer');
    assert.ok(linhas.every((l) => l.length === 400));
    const [, um, tres] = linhas;
    const c = (l, de, ate) => l.slice(de - 1, ate);
    assert.equal(c(um, 105, 105), 'R', 'título marcado com rateio');
    assert.equal(c(tres, 2, 17), '0090339100066884', 'carteira, agência, conta e dígito da PAY AX');
    assert.equal(c(tres, 18, 29), '000000000429', 'nosso número + dígito');
    assert.equal(c(tres, 30, 31), '11', 'sobre o valor cobrado, em percentual');
    assert.equal(c(tres, 44, 46), '237');
    assert.equal(c(tres, 47, 52), '012345', 'agência do cliente + dígito');
    assert.equal(c(tres, 53, 65), '0000000987650', 'conta do cliente + dígito');
    assert.equal(c(tres, 66, 80), '000000000098010', '98,010%');
    assert.equal(c(tres, 81, 120).trim(), 'CONNECT LINK TELECOM LTDA');
    assert.equal(c(tres, 395, 400), '000003', 'sequencial continua');
    assert.equal(c(linhas[3], 395, 400), '000004');
  });

  await t.test('baixa de título com rateio não repete o registro 3', () => {
    const linhas = cnab.gerarRemessa({ conta: CONTA, titulos: [{ boleto, comando: cnab.COMANDO.baixar }], sequencial: 2, hoje: '2026-11-13' })
      .conteudo.split('\r\n').filter(Boolean);
    assert.deepEqual(linhas.map((l) => l[0]), ['0', '1', '9']);
    assert.equal(linhas[1].slice(104, 105), ' ');
  });

  await t.test('o retorno traz quanto o banco creditou ao cliente', () => {
    // Retorno de liquidação gerado como o banco gera, com um registro 3 inserido depois do título.
    const base = gerarRetorno(CONTA, [{ nosso_numero: '00000000042', nosso_numero_dv: '9', seu_numero: 'FAT-1', ocorrencia: '06',
      ocorrido_em: '2026-12-05', vencimento: '2026-12-05', valor_centavos: 10000, pago_centavos: 10050 }]).split('\r\n').filter(Boolean);
    const tres = `3${' '.repeat(64)}000000000009850${' '.repeat(314)}000003`;
    assert.equal(tres.length, 400);
    const r = cnab.lerRetorno([base[0], base[1], tres, base.at(-1)].join('\r\n'));
    assert.equal(r.registros.length, 1);
    assert.equal(r.registros[0].rateio_centavos, 9850, 'valor efetivo do rateio (R$ 98,50, com juros)');
  });
});

test('rateio de crédito no fluxo: emissão, liquidação e nada parado', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const conta = await api.conta(tk.admin);
  await api.precoPadrao(tk.admin, { tarifa_fixa: '1,99', percentual: '0', tarifa_liquidacao: '0' });
  const versao = (await api.get('/api/contas', tk.admin)).dados.itens?.find?.((x) => x.id === conta.id)?.versao
    ?? api.db.prepare('SELECT versao FROM contas_bancarias WHERE id = ?').get(conta.id).versao;
  const p = await api.patch(`/api/contas/${conta.id}`, { rateio_contratado: '1', versao }, tk.admin);
  assert.equal(p.status, 200, JSON.stringify(p.dados));

  const bradesco = { pix_chave: '', destino_banco: '237', destino_agencia: '1234', destino_agencia_dv: '5', destino_conta: '98765',
    destino_conta_dv: '0', destino_titular: 'Connect Link Telecom Ltda' };

  await t.test('cliente com conta Bradesco: o título sai com rateio; o PIX não é usado', async () => {
    const c = await api.cliente(tk.admin, { razao_social: 'Connect Link Telecom Ltda', ...bradesco });
    assert.equal((await api.get(`/api/clientes/${c.cliente.id}`, tk.admin)).dados.meio_entrega, 'rateio');
    const b = await api.boleto(tk.admin, c.cliente.id, { valor: '100,00', vencimento: somarDias(hoje(), 5) });
    const row = api.db.prepare('SELECT rateio_ppm, rateio_destino FROM boletos WHERE id = ?').get(b.id);
    assert.equal(row.rateio_ppm, 980100, 'R$ 98,01 de R$ 100,00 = 98,010%');
    assert.equal(JSON.parse(row.rateio_destino).conta, '98765');

    const l = (await api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: hoje(), valor_pago: '100,00', meio: 'pix' }, tk.financeiro)).dados;
    assert.equal(l.liquido_centavos, 9801);
    assert.equal(l.comissao_centavos, 199);
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM repasses WHERE cliente_id = ?').get(c.cliente.id).n, 0, 'nenhum PIX: o banco pagou');
    const lanc = api.db.prepare('SELECT tipo, valor_centavos, repasse_id FROM lancamentos WHERE boleto_id = ? ORDER BY id').all(b.id);
    assert.deepEqual(lanc.map((x) => [x.tipo, x.valor_centavos]), [['credito_liquidacao', 10000], ['comissao', -199], ['repasse', -9801]],
      'sem tarifa bancária: lançamento de valor zero não é gravado');
    assert.equal(api.db.prepare('SELECT IFNULL(SUM(valor_centavos), 0) AS s FROM lancamentos WHERE cliente_id = ?').get(c.cliente.id).s, 0, 'nada conosco');
    assert.ok(api.db.prepare('SELECT rateado_em FROM boletos WHERE id = ?').get(b.id).rateado_em);
    assert.equal(repassesLib.parados(api.db).length, 0);
    const painel = (await api.get('/cliente/api/painel', c.token)).dados;
    assert.equal(painel.transferencias.transferido_hoje_centavos, 9801, 'o cliente vê o que o banco creditou');
  });

  await t.test('pago com juros: a parte do cliente é a que o banco informou no retorno', async () => {
    const c = api.db.prepare("SELECT id FROM clientes WHERE razao_social = 'Connect Link Telecom Ltda'").get();
    const b = await api.boleto(tk.admin, c.id, { valor: '100,00', vencimento: somarDias(hoje(), 5) });
    const boletosLib = require('../server/lib/boletos');
    const out = boletosLib.liquidar(api.db, b.id, { pago_em: hoje(), valor_pago_centavos: 10050, meio: 'boleto', rateio_centavos: 9850 });
    assert.equal(out.liquido_centavos, 9850);
    assert.equal(out.comissao_centavos, 200, 'R$ 100,50 − R$ 98,50');
  });

  await t.test('cliente com conta em outro banco: PIX pelos dados da conta, sem rateio', async () => {
    const c = await api.cliente(tk.admin, { razao_social: 'Outro Banco Ltda', cnpj: '19131243000197', pix_chave: '',
      destino_banco: '341', destino_agencia: '1234', destino_conta: '567890', destino_titular: 'Outro Banco Ltda' });
    const b = await api.boleto(tk.admin, c.cliente.id, { valor: '100,00', vencimento: somarDias(hoje(), 5) });
    assert.equal(api.db.prepare('SELECT rateio_ppm FROM boletos WHERE id = ?').get(b.id).rateio_ppm, null);
    await api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: hoje(), valor_pago: '100,00', meio: 'pix' }, tk.financeiro);
    assert.equal(api.db.prepare('SELECT situacao FROM repasses WHERE cliente_id = ?').get(c.cliente.id).situacao, 'confirmado');
  });
});
