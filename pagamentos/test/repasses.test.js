'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { dataLocal, somarDias } = require('../server/lib/datas');
const repassesLib = require('../server/lib/repasses');

const hoje = () => dataLocal('America/Sao_Paulo');

/**
 * Regra da PAY AX: não guarda dinheiro de cliente. O banco creditou, a tarifa sai e o resto vai
 * por PIX para o cliente na hora — sem saque, mínimo ou aprovação.
 */
test('repasse imediato: nenhum dinheiro de cliente parado', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin, { tarifa_repasse: '1,00' });
  const a = await api.cliente(tk.admin);
  const venc = somarDias(hoje(), 10);

  const emitir = (valor) => api.boleto(tk.admin, a.cliente.id, { valor, vencimento: venc });
  const liquidar = (b, valor, meio) => api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: hoje(), valor_pago: valor, meio }, tk.financeiro);
  const repassesDoCliente = () => api.db.prepare('SELECT * FROM repasses WHERE cliente_id = ? ORDER BY id').all(a.cliente.id);

  await t.test('pago por PIX: o valor vai para o cliente na mesma hora, já sem as tarifas', async () => {
    const b = await emitir('1.000,00');
    assert.equal((await liquidar(b, '1.000,00', 'pix')).status, 200);
    const [r] = repassesDoCliente();
    assert.ok(r, 'repasse criado na hora da baixa');
    assert.equal(r.situacao, 'confirmado');
    // 1.000,00 − tarifa bancária 2,50 − tarifa PAY AX 23,50 = 974,00; − tarifa do PIX 1,00 = 973,00.
    assert.equal(r.valor_centavos, 97400);
    assert.equal(r.valor_liquido_centavos, 97300);
    assert.match(r.end_to_end, /^E237/);
    const c = (await api.get('/cliente/api/conta', a.token)).dados;
    assert.equal(c.saldo.disponivel_centavos, 0, 'nada parado');
    assert.equal(c.transferencias.transferido_hoje_centavos, 97300);
  });

  await t.test('pago pelo código de barras: fica em compensação até o banco creditar, e não é "parado"', async () => {
    const b = await emitir('500,00');
    await liquidar(b, '500,00', 'boleto');
    assert.equal(repassesDoCliente().length, 1, 'ainda não creditado: nenhum repasse novo');
    const c = (await api.get('/cliente/api/conta', a.token)).dados;
    assert.ok(c.transferencias.a_compensar_centavos > 0, 'aparece em compensação no banco');
    assert.equal(repassesLib.parados(api.db).length, 0, 'esperar o crédito do banco não é dinheiro parado');
  });

  await t.test('crédito de ontem ainda aqui é fora da norma; a rodada repassa e a regra volta a ficar em dia', async () => {
    // Simula o dia seguinte: o banco creditou ontem e, por algum motivo, a rodada não passou.
    api.db.prepare("UPDATE lancamentos SET data_liberacao = ? WHERE cliente_id = ? AND repasse_id IS NULL AND data_liberacao > ?")
      .run(somarDias(hoje(), -1), a.cliente.id, hoje());
    const parados = repassesLib.parados(api.db);
    assert.equal(parados.length, 1);
    const conf = (await api.get('/api/conformidade', tk.admin)).dados.grupos.flatMap((g) => g.regras).find((x) => x.id === 'repasse-imediato');
    assert.equal(conf.situacao, 'fora');

    const rodada = (await api.post('/api/repasses/rotina', {}, tk.financeiro)).dados;
    assert.equal(rodada.enviados, 1);
    assert.equal(repassesLib.parados(api.db).length, 0);
    const depois = (await api.get('/api/conformidade', tk.admin)).dados.grupos.flatMap((g) => g.regras).find((x) => x.id === 'repasse-imediato');
    assert.equal(depois.situacao, 'ok');
  });

  await t.test('PIX recusado: estorna, avisa, e a rodada seguinte tenta de novo', async () => {
    const recusa = await api.cliente(tk.admin, { razao_social: 'Chave Errada LTDA', cnpj: '19131243000197', pix_chave: 'financeiro@recusa.teste' });
    const b = await api.boleto(tk.admin, recusa.cliente.id, { valor: '200,00', vencimento: venc });
    await api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: hoje(), valor_pago: '200,00', meio: 'pix' }, tk.financeiro);
    const falho = api.db.prepare('SELECT * FROM repasses WHERE cliente_id = ?').get(recusa.cliente.id);
    assert.equal(falho.situacao, 'falhou');
    assert.match(falho.erro, /DICT/);
    const painel = (await api.get('/api/painel', tk.admin)).dados;
    assert.ok(painel.alertas.some((al) => al.tipo === 'repasses_falha'), 'a falha aparece no painel');

    // A equipe corrige a chave; a rodada seguinte leva o valor, sem ninguém pedir.
    const c = (await api.get(`/api/clientes/${recusa.cliente.id}`, tk.admin)).dados;
    await api.patch(`/api/clientes/${recusa.cliente.id}`, { pix_chave: '19131243000197', versao: c.versao }, tk.admin);
    const rodada = (await api.post('/api/repasses/rotina', {}, tk.financeiro)).dados;
    assert.equal(rodada.enviados, 1);
    const ultimo = api.db.prepare('SELECT * FROM repasses WHERE cliente_id = ? ORDER BY id DESC LIMIT 1').get(recusa.cliente.id);
    assert.equal(ultimo.situacao, 'confirmado');
    assert.equal(ultimo.pix_chave, '19131243000197');
  });

  await t.test('cliente sem chave PIX não emite: o dinheiro não teria para onde ir', async () => {
    const semPix = await api.cliente(tk.admin, { razao_social: 'Sem PIX LTDA', cnpj: '22233344000183', pix_chave: '' });
    const r = await api.post('/api/boletos', { cliente_id: semPix.cliente.id, valor: '50,00', vencimento: venc,
      pagador_nome: 'Fulano', pagador_documento: '52998224725' }, tk.admin);
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /chave PIX/);
  });

  await t.test('não existe saque: o cliente não pede repasse', async () => {
    const r = await api.post('/cliente/api/repasses', { valor: 'tudo' }, a.token);
    assert.equal(r.status, 404);
  });

  await t.test('o extrato mostra o repasse e a tarifa do PIX separados, e termina em zero', async () => {
    const e = (await api.get(`/cliente/api/conta/extrato?de=${somarDias(hoje(), -2)}&ate=${somarDias(hoje(), 10)}`, a.token)).dados;
    const tipos = e.itens.map((i) => i.tipo);
    assert.ok(tipos.includes('repasse'));
    assert.ok(tipos.includes('taxa_repasse'));
    assert.equal(e.itens.at(-1).saldo_acumulado_centavos, 0);
  });
});
