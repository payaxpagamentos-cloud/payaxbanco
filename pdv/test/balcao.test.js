'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, empresaDeTeste } = require('./helpers');
const { ixcFalso } = require('./ixc-falso');

const hoje = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

test('Caixa: sangria, suprimento e limites', async (t) => {
  const app = await iniciar();
  const e = await empresaDeTeste(app, { terminal: false });
  t.after(() => app.fechar());
  const caixa = (await app.post(`/empresas/${e.eid}/caixa`, { pdv_id: e.pdv.id, fundo_centavos: 5000 }, e.operador)).dados;

  await t.test('não dá para sangrar mais do que tem na gaveta', async () => {
    const r = await app.post(`/empresas/${e.eid}/caixa/${caixa.id}/movimentos`, { tipo: 'sangria', valor_centavos: 9000, motivo: 'cofre' }, e.operador);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /maior que o dinheiro/);
  });

  await t.test('suprimento aumenta o dinheiro em caixa e sangria diminui', async () => {
    await app.post(`/empresas/${e.eid}/caixa/${caixa.id}/movimentos`, { tipo: 'suprimento', valor_centavos: 10000, motivo: 'troco' }, e.operador);
    const r = await app.post(`/empresas/${e.eid}/caixa/${caixa.id}/movimentos`, { tipo: 'sangria', valor_centavos: 4000, motivo: 'cofre' }, e.operador);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.resumo.dinheiro_em_caixa_centavos, 5000 + 10000 - 4000);
  });

  await t.test('o caixa de outro operador não é mexido pelo operador', async () => {
    const outro = await app.post(`/empresas/${e.eid}/cadastros/usuarios`,
      { nome: 'Outro caixa', email: 'outro@provedor.com.br', senha: e.senha, perfil: 'operador' }, e.admin);
    assert.equal(outro.status, 201);
    const token = await app.login('outro@provedor.com.br', e.senha);
    const r = await app.post(`/empresas/${e.eid}/caixa/${caixa.id}/movimentos`, { tipo: 'sangria', valor_centavos: 100, motivo: 'x' }, token);
    assert.equal(r.status, 403);
    assert.equal((await app.get(`/empresas/${e.eid}/caixa/${caixa.id}`, token)).status, 403);
  });

  await t.test('a supervisão fecha, reabre e confere o caixa', async () => {
    const fechado = await app.post(`/empresas/${e.eid}/caixa/${caixa.id}/fechar`, { contagem: { dinheiro: 11000 } }, e.supervisor);
    assert.equal(fechado.status, 200, JSON.stringify(fechado.dados));
    assert.equal(fechado.dados.diferenca_centavos, 0);

    const semMotivo = await app.post(`/empresas/${e.eid}/caixa/${caixa.id}/reabrir`, {}, e.supervisor);
    assert.equal(semMotivo.status, 422);
    const reaberto = await app.post(`/empresas/${e.eid}/caixa/${caixa.id}/reabrir`, { motivo: 'faltou lançar um recebimento' }, e.supervisor);
    assert.equal(reaberto.dados.status, 'aberto');

    await app.post(`/empresas/${e.eid}/caixa/${caixa.id}/fechar`, { contagem: { dinheiro: 11000 } }, e.operador);
    const conferido = await app.post(`/empresas/${e.eid}/caixa/${caixa.id}/conferir`, {}, e.supervisor);
    assert.equal(conferido.dados.status, 'conferido');
    assert.equal((await app.post(`/empresas/${e.eid}/caixa/${caixa.id}/conferir`, {}, e.operador)).status, 403);
  });
});

test('Balcão: desconto, avulso e maquininha digitada', async (t) => {
  const ixc = await ixcFalso();
  const app = await iniciar();
  const e = await empresaDeTeste(app, { ixcUrl: ixc.url, ixcToken: ixc.token, modo: 'manual' });
  t.after(async () => { await app.fechar(); await ixc.fechar(); });
  await app.post(`/empresas/${e.eid}/caixa`, { pdv_id: e.pdv.id, fundo_centavos: 0 }, e.operador);

  await t.test('desconto acima do limite da empresa é recusado', async () => {
    const r = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_ixc_id: '10', cliente_nome: 'MARIA DA SILVA',
      titulos: [{ fatura_ixc_id: '900', valor_centavos: 9990, desconto_centavos: 1000 }],
      pagamentos: [{ forma: 'dinheiro', valor_centavos: 8990 }],
    }, e.operador);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /[Dd]esconto/);
  });

  await t.test('com o limite liberado, o desconto entra e o total cai', async () => {
    assert.equal((await app.patch(`/empresas/${e.eid}/configuracoes`, { desconto_max_percentual: 10 }, e.admin)).status, 200);
    const r = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_ixc_id: '10', cliente_nome: 'MARIA DA SILVA',
      titulos: [{ fatura_ixc_id: '900', valor_centavos: 9990, desconto_centavos: 990 }],
      pagamentos: [{ forma: 'dinheiro', valor_centavos: 9000 }],
    }, e.operador);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.valor_centavos, 9000);
    assert.equal(r.dados.desconto_centavos, 990);
    assert.equal(ixc.estado.faturas.find((f) => f.id === '900').valor_recebido, '90.00');
  });

  await t.test('maquininha digitada: o NSU é obrigatório e a cobrança já nasce aprovada', async () => {
    const semNsu = await app.post(`/empresas/${e.eid}/cartao/cobrancas/manual`,
      { terminal_id: e.maquininha.id, forma: 'debito', valor_centavos: 5000 }, e.operador);
    assert.equal(semNsu.status, 422);

    const naoIntegra = await app.post(`/empresas/${e.eid}/cartao/cobrancas`,
      { terminal_id: e.maquininha.id, forma: 'debito', valor_centavos: 5000 }, e.operador);
    assert.equal(naoIntegra.status, 409, 'a maquininha manual não recebe cobrança pela integração');

    const manual = await app.post(`/empresas/${e.eid}/cartao/cobrancas/manual`,
      { terminal_id: e.maquininha.id, forma: 'debito', valor_centavos: 15000, nsu: '445566', bandeira: 'ELO', cartao_final: '9876' }, e.operador);
    assert.equal(manual.status, 201, JSON.stringify(manual.dados));
    assert.equal(manual.dados.status, 'aprovada');

    const r = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_ixc_id: '11', cliente_nome: 'JOAO SOUZA',
      titulos: [{ fatura_ixc_id: '902', valor_centavos: 15000 }],
      pagamentos: [{ forma: 'debito', valor_centavos: 15000, transacao_id: manual.dados.id }],
    }, e.operador);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.pagamentos[0].nsu, '445566');
    assert.equal(r.dados.pagamentos[0].cartao_final, '9876');
  });

  await t.test('recebimento avulso fica fora da conferência do IXC', async () => {
    const r = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_nome: 'CONSUMIDOR NO BALCAO', descricao: 'Taxa de religação', valor_centavos: 4500,
      pagamentos: [{ forma: 'pix', valor_centavos: 4500, nsu: 'E12345' }],
    }, e.operador);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.ixc_status, 'avulso');
    assert.equal(r.dados.titulos[0].ixc_status, 'avulso');

    const resumo = await app.get(`/empresas/${e.eid}/conferencia?de=${hoje()}&ate=${hoje()}`, e.supervisor);
    assert.equal(resumo.dados.totais.avulsos, 1);
    assert.equal(resumo.dados.totais.a_confirmar_centavos, 0, 'avulso não entra no que falta confirmar no IXC');

    const conferido = await app.post(`/empresas/${e.eid}/recebimentos/${r.dados.id}/conferir`, {}, e.supervisor);
    assert.equal(conferido.dados.conferencia, 'conferido');
  });

  await t.test('valor diferente no IXC vira divergência de valor', async () => {
    const recebimento = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_ixc_id: '10', cliente_nome: 'MARIA DA SILVA',
      titulos: [{ fatura_ixc_id: '901', valor_centavos: 9990 }],
      pagamentos: [{ forma: 'dinheiro', valor_centavos: 9990 }],
    }, e.operador);
    assert.equal(recebimento.dados.ixc_status, 'baixado');
    // Alguém alterou o valor recebido direto no IXC.
    ixc.estado.faturas.find((f) => f.id === '901').valor_recebido = '50.00';

    const conferido = await app.post(`/empresas/${e.eid}/recebimentos/${recebimento.dados.id}/conferir`, {}, e.supervisor);
    assert.equal(conferido.dados.conferencia, 'divergente');
    const divs = await app.get(`/empresas/${e.eid}/conferencia/divergencias?status=aberta&tipo=valor_diferente`, e.supervisor);
    assert.equal(divs.dados.itens.length, 1);
    assert.equal(divs.dados.itens[0].valor_pdv_centavos, 9990);
    assert.equal(divs.dados.itens[0].valor_ixc_centavos, 5000);
  });

  await t.test('a planilha da conferência sai com uma linha por fatura', async () => {
    const r = await app.get(`/empresas/${e.eid}/conferencia/exportar.csv?de=${hoje()}&ate=${hoje()}`, e.supervisor);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const linhas = String(r.dados).trim().split('\r\n');
    assert.equal(linhas.length, 5, 'cabeçalho + 4 títulos recebidos');
    assert.match(linhas[0], /Fatura IXC;Vencimento;Valor/);
  });
});

test('Maquininha: cobrança sem resposta pode ser cancelada e a chave é por maquininha', async (t) => {
  const app = await iniciar();
  const e = await empresaDeTeste(app);
  t.after(() => app.fechar());
  await app.post(`/empresas/${e.eid}/caixa`, { pdv_id: e.pdv.id, fundo_centavos: 0 }, e.operador);

  const cobranca = (await app.post(`/empresas/${e.eid}/cartao/cobrancas`,
    { terminal_id: e.maquininha.id, forma: 'debito', valor_centavos: 7000 }, e.operador)).dados;

  await t.test('a cobrança cancelada no PDV não é mais entregue à maquininha', async () => {
    const cancelada = await app.post(`/empresas/${e.eid}/cartao/cobrancas/${cobranca.id}/cancelar`, {}, e.operador);
    assert.equal(cancelada.dados.status, 'cancelada');
    assert.equal((await app.terminal(e.maquininha.chave).get('/terminal/cobranca')).status, 204);
    const tarde = await app.terminal(e.maquininha.chave).post('/terminal/resultado', { referencia: cobranca.referencia, status: 'aprovada', nsu: '1' });
    assert.equal(tarde.status, 409);
  });

  await t.test('a chave de uma empresa não serve na outra', async () => {
    const outra = (await app.post('/master/empresas', { nome: 'Provedor Dois' }, e.master)).dados;
    const lojas = (await app.get(`/empresas/${outra.id}/cadastros/lojas`, e.master)).dados.itens;
    const t2 = (await app.post(`/empresas/${outra.id}/cadastros/terminais`, { nome: 'Maq B', loja_id: lojas[0].id }, e.master)).dados;
    const r = await app.post(`/empresas/${e.eid}/cartao/cobrancas`, { terminal_id: t2.id, forma: 'debito', valor_centavos: 1000 }, e.operador);
    assert.equal(r.status, 404, 'maquininha de outra empresa não existe para esta');

    const nova = await app.post(`/empresas/${e.eid}/cartao/cobrancas`, { terminal_id: e.maquininha.id, forma: 'debito', valor_centavos: 1000 }, e.operador);
    assert.equal(nova.status, 201);
    const comChaveErrada = await app.terminal(t2.chave).get('/terminal/cobranca');
    assert.equal(comChaveErrada.status, 204, 'a maquininha B não enxerga a cobrança da empresa A');
  });
});

test('Balcão: a mesma fatura não é recebida duas vezes', async (t) => {
  const ixc = await ixcFalso();
  const app = await iniciar();
  const e = await empresaDeTeste(app, { ixcUrl: ixc.url, ixcToken: ixc.token, terminal: false });
  t.after(async () => { await app.fechar(); await ixc.fechar(); });
  await app.post(`/empresas/${e.eid}/caixa`, { pdv_id: e.pdv.id, fundo_centavos: 0 }, e.operador);
  const corpo = {
    cliente_ixc_id: '10', cliente_nome: 'MARIA DA SILVA',
    titulos: [{ fatura_ixc_id: '900', valor_centavos: 9990 }],
    pagamentos: [{ forma: 'dinheiro', valor_centavos: 9990 }],
  };

  const primeiro = await app.post(`/empresas/${e.eid}/recebimentos`, corpo, e.operador);
  assert.equal(primeiro.status, 201, JSON.stringify(primeiro.dados));

  const repetido = await app.post(`/empresas/${e.eid}/recebimentos`, corpo, e.operador);
  assert.equal(repetido.status, 409);
  assert.match(repetido.dados.erro, /já foi recebida no PDV/);

  // Depois de cancelado, a mesma fatura pode ser recebida de novo.
  await app.post(`/empresas/${e.eid}/recebimentos/${primeiro.dados.id}/cancelar`, { motivo: 'erro de digitação' }, e.supervisor);
  const denovo = await app.post(`/empresas/${e.eid}/recebimentos`, corpo, e.operador);
  assert.equal(denovo.status, 201, JSON.stringify(denovo.dados));
});

test('Maquininha: só oferece as formas que o aparelho aceita', async (t) => {
  const app = await iniciar();
  const e = await empresaDeTeste(app, { terminal: false });
  t.after(() => app.fechar());

  await t.test('Getnet (Santander) nasce com crédito e débito, sem PIX', async () => {
    const r = await app.post(`/empresas/${e.eid}/cadastros/terminais`,
      { nome: 'POS Santander', loja_id: e.loja.id, pdv_id: e.pdv.id, adquirente: 'getnet' }, e.admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.deepEqual(r.dados.formas, ['debito', 'credito']);

    await app.post(`/empresas/${e.eid}/caixa`, { pdv_id: e.pdv.id, fundo_centavos: 0 }, e.operador);
    const pix = await app.post(`/empresas/${e.eid}/cartao/cobrancas`, { terminal_id: r.dados.id, forma: 'pix', valor_centavos: 5000 }, e.operador);
    assert.equal(pix.status, 409);
    assert.match(pix.dados.erro, /não aceita PIX/);

    const debito = await app.post(`/empresas/${e.eid}/cartao/cobrancas`, { terminal_id: r.dados.id, forma: 'debito', valor_centavos: 5000 }, e.operador);
    assert.equal(debito.status, 201, JSON.stringify(debito.dados));
  });

  await t.test('a tela do cliente mostra só o que a maquininha do PDV faz', async () => {
    const { chave } = (await app.post(`/empresas/${e.eid}/cadastros/pdvs/${e.pdv.id}/autoatendimento`, {}, e.admin)).dados;
    const abertura = await app.req('GET', '/autoatendimento/', undefined, null, { 'X-Api-Key': chave });
    assert.deepEqual(abertura.dados.formas, ['debito', 'credito']);
  });

  await t.test('o CV da transação é guardado para o estorno no aparelho', async () => {
    const terminais = (await app.get(`/empresas/${e.eid}/cadastros/terminais`, e.admin)).dados.itens;
    const maquina = terminais[0];
    const { chave } = (await app.post(`/empresas/${e.eid}/cadastros/terminais/${maquina.id}/chave`, {}, e.admin)).dados;
    const cobranca = (await app.post(`/empresas/${e.eid}/cartao/cobrancas`, { terminal_id: maquina.id, forma: 'credito', valor_centavos: 9900, parcelas: 2 }, e.operador)).dados;
    await app.terminal(chave).get('/terminal/cobranca');
    const r = await app.terminal(chave).post('/terminal/resultado',
      { referencia: cobranca.referencia, status: 'aprovada', nsu: '000123', cv: '004567', autorizacao: '778899', bandeira: 'VISA', cartao_final: '4321' });
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.cv, '004567');
  });
});
