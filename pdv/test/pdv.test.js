'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, empresaDeTeste } = require('./helpers');
const { ixcFalso } = require('./ixc-falso');

const hoje = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

test('PDV: do caixa ao recebimento, com baixa no IXC e conferência', async (t) => {
  const ixc = await ixcFalso();
  const app = await iniciar();
  const e = await empresaDeTeste(app, { ixcUrl: ixc.url, ixcToken: ixc.token });
  t.after(async () => { await app.fechar(); await ixc.fechar(); });

  await t.test('o teste de conexão com o IXC responde', async () => {
    const r = await app.post(`/empresas/${e.eid}/configuracoes/ixc/testar`, {}, e.admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.ok, true);
  });

  await t.test('sem caixa aberto o PDV recusa o recebimento', async () => {
    const r = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_nome: 'MARIA DA SILVA',
      titulos: [{ fatura_ixc_id: '900', valor_centavos: 9990 }],
      pagamentos: [{ forma: 'dinheiro', valor_centavos: 9990 }],
    }, e.operador);
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /Abra o caixa/);
  });

  let caixaId;
  await t.test('o operador abre o caixa com fundo de troco', async () => {
    const r = await app.post(`/empresas/${e.eid}/caixa`, { pdv_id: e.pdv.id, fundo_centavos: 10000 }, e.operador);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    caixaId = r.dados.id;
    assert.equal(r.dados.resumo.dinheiro_em_caixa_centavos, 10000);
    const outro = await app.post(`/empresas/${e.eid}/caixa`, { pdv_id: e.pdv.id, fundo_centavos: 0 }, e.operador);
    assert.equal(outro.status, 409);
  });

  await t.test('a busca do cliente traz as faturas em aberto com multa e juros', async () => {
    const busca = await app.get(`/empresas/${e.eid}/clientes?busca=529.982.247-25`, e.operador);
    assert.equal(busca.status, 200, JSON.stringify(busca.dados));
    assert.equal(busca.dados.clientes.length, 1);
    assert.equal(busca.dados.clientes[0].id, '10');

    const cliente = await app.get(`/empresas/${e.eid}/clientes/10`, e.operador);
    assert.equal(cliente.status, 200);
    assert.equal(cliente.dados.faturas.length, 2);
    const vencida = cliente.dados.faturas.find((f) => f.id === '900');
    assert.ok(vencida.atraso.dias > 0, 'a fatura de 10/10/2026 deve estar vencida');
    assert.ok(vencida.total_centavos > vencida.aberto_centavos, 'vencida soma multa e juros');
  });

  let recebimentoId;
  await t.test('recebe em dinheiro com troco e baixa a fatura no IXC', async () => {
    const r = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_ixc_id: '10',
      cliente_nome: 'MARIA DA SILVA',
      cliente_documento: '529.982.247-25',
      titulos: [{ fatura_ixc_id: '901', contrato_ixc_id: '100', documento: '901/1', vencimento: '2026-11-10', valor_centavos: 9990 }],
      pagamentos: [{ forma: 'dinheiro', valor_centavos: 9990, recebido_centavos: 10000 }],
    }, e.operador);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    recebimentoId = r.dados.id;
    assert.equal(r.dados.valor_centavos, 9990);
    assert.equal(r.dados.troco_centavos, 10);
    assert.equal(r.dados.ixc_status, 'baixado', r.dados.ixc_erro ?? '');
    assert.equal(ixc.estado.faturas.find((f) => f.id === '901').status, 'R');
    assert.equal(ixc.estado.faturas.find((f) => f.id === '901').valor_recebido, '99.90');
  });

  await t.test('o comprovante sai com o cliente, a fatura e o troco', async () => {
    const r = await app.get(`/empresas/${e.eid}/recebimentos/${recebimentoId}/comprovante`, e.operador);
    assert.equal(r.status, 200);
    assert.match(r.dados.texto, /MARIA DA SILVA/);
    assert.match(r.dados.texto, /Fatura 901/);
    assert.match(r.dados.texto, /Troco/);
  });

  await t.test('a soma das formas de pagamento precisa fechar com o total', async () => {
    const r = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_nome: 'MARIA DA SILVA',
      titulos: [{ fatura_ixc_id: '900', valor_centavos: 9990 }],
      pagamentos: [{ forma: 'dinheiro', valor_centavos: 5000 }],
    }, e.operador);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /diferente do total/);
  });

  await t.test('a conferência com o IXC fecha o período sem divergência', async () => {
    const r = await app.post(`/empresas/${e.eid}/conferencia/conferir`, { de: hoje(), ate: hoje() }, e.supervisor);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.divergentes, 0);
    assert.ok(r.dados.conferidos >= 1);

    const resumo = await app.get(`/empresas/${e.eid}/conferencia?de=${hoje()}&ate=${hoje()}`, e.supervisor);
    assert.equal(resumo.dados.totais.recebimentos, 1);
    assert.equal(resumo.dados.totais.baixados_centavos, 9990);
    assert.equal(resumo.dados.totais.a_confirmar_centavos, 0);
    assert.equal(resumo.dados.divergencias_abertas, 0);
  });

  await t.test('a baixa desfeita no IXC vira divergência na conferência', async () => {
    const fatura = ixc.estado.faturas.find((f) => f.id === '901');
    Object.assign(fatura, { status: 'A', data_pagamento: '', valor_recebido: '0.00', valor_aberto: '99.90' });
    const r = await app.post(`/empresas/${e.eid}/conferencia/conferir`, { de: hoje(), ate: hoje(), somente_pendentes: false }, e.supervisor);
    assert.equal(r.dados.divergentes, 1, JSON.stringify(r.dados));

    const divs = await app.get(`/empresas/${e.eid}/conferencia/divergencias`, e.supervisor);
    assert.equal(divs.dados.itens.length, 1);
    assert.equal(divs.dados.itens[0].tipo, 'nao_baixado');
    assert.equal(divs.dados.itens[0].recebimento_numero, 1);

    const resolvida = await app.post(`/empresas/${e.eid}/conferencia/divergencias/${divs.dados.itens[0].id}/resolver`,
      { status: 'resolvida', resolucao: 'Baixa refeita no IXC pelo financeiro.' }, e.supervisor);
    assert.equal(resolvida.status, 200);
    assert.equal(resolvida.dados.status, 'resolvida');
    const abertas = await app.get(`/empresas/${e.eid}/conferencia/divergencias?status=aberta`, e.supervisor);
    assert.equal(abertas.dados.itens.length, 0);
    // devolve a fatura ao estado baixado para os próximos testes
    Object.assign(fatura, { status: 'R', data_pagamento: hoje(), valor_recebido: '99.90', valor_aberto: '0.00' });
  });

  await t.test('o operador não cancela recebimento; a supervisão cancela e o IXC reabre a fatura', async () => {
    const negado = await app.post(`/empresas/${e.eid}/recebimentos/${recebimentoId}/cancelar`, { motivo: 'erro de digitação' }, e.operador);
    assert.equal(negado.status, 403);

    const r = await app.post(`/empresas/${e.eid}/recebimentos/${recebimentoId}/cancelar`, { motivo: 'cliente desistiu do pagamento' }, e.supervisor);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.status, 'cancelado');
    assert.equal(r.dados.ixc_status, 'estornado');
    assert.equal(ixc.estado.faturas.find((f) => f.id === '901').status, 'A');
  });

  await t.test('o caixa fecha com a contagem e aponta a diferença', async () => {
    const antes = await app.get(`/empresas/${e.eid}/caixa/${caixaId}`, e.operador);
    // Só o recebimento cancelado passou pelo caixa: a gaveta tem apenas o fundo.
    assert.equal(antes.dados.resumo.dinheiro_em_caixa_centavos, 10000);

    const r = await app.post(`/empresas/${e.eid}/caixa/${caixaId}/fechar`, { contagem: { dinheiro: 9950 } }, e.operador);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.status, 'fechado');
    assert.equal(r.dados.diferenca_centavos, -50);

    const divs = await app.get(`/empresas/${e.eid}/conferencia/divergencias?status=aberta`, e.supervisor);
    assert.equal(divs.dados.itens[0].tipo, 'caixa_diferenca');
  });
});

test('PDV: pagamento no cartão passa pela maquininha', async (t) => {
  const ixc = await ixcFalso();
  const app = await iniciar();
  const e = await empresaDeTeste(app, { ixcUrl: ixc.url, ixcToken: ixc.token });
  t.after(async () => { await app.fechar(); await ixc.fechar(); });
  const chave = e.maquininha.chave;
  assert.ok(chave, 'a maquininha nasce com chave de integração');
  await app.post(`/empresas/${e.eid}/caixa`, { pdv_id: e.pdv.id, fundo_centavos: 0 }, e.operador);

  let cobranca;
  await t.test('a cobrança fica esperando a maquininha', async () => {
    const r = await app.post(`/empresas/${e.eid}/cartao/cobrancas`, { terminal_id: e.maquininha.id, forma: 'credito', valor_centavos: 15000, parcelas: 3 }, e.operador);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    cobranca = r.dados;
    assert.equal(cobranca.status, 'pendente');
  });

  await t.test('o cartão só vira recebimento depois de aprovado', async () => {
    const r = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_ixc_id: '11', cliente_nome: 'JOAO SOUZA',
      titulos: [{ fatura_ixc_id: '902', valor_centavos: 15000 }],
      pagamentos: [{ forma: 'credito', valor_centavos: 15000, transacao_id: cobranca.id }],
    }, e.operador);
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /pendente/);
  });

  await t.test('a maquininha busca a cobrança e devolve o resultado', async () => {
    const maquina = app.terminal(chave);
    const quem = await maquina.get('/terminal');
    assert.equal(quem.status, 200);
    assert.equal(quem.dados.terminal.id, e.maquininha.id);

    const pega = await maquina.get('/terminal/cobranca');
    assert.equal(pega.status, 200);
    assert.equal(pega.dados.referencia, cobranca.referencia);
    assert.equal(pega.dados.status, 'enviada');
    assert.equal((await maquina.get('/terminal/cobranca')).status, 204, 'a mesma cobrança não é entregue duas vezes');

    const resultado = await maquina.post('/terminal/resultado', {
      referencia: cobranca.referencia, status: 'aprovada', nsu: '123456', autorizacao: '998877', bandeira: 'VISA', cartao_final: '4321',
    });
    assert.equal(resultado.status, 200, JSON.stringify(resultado.dados));
    assert.equal(resultado.dados.status, 'aprovada');

    const semChave = await app.post('/integracao/terminal/resultado', { referencia: cobranca.referencia, status: 'aprovada' });
    assert.equal(semChave.status, 401);
  });

  await t.test('o recebimento no cartão guarda NSU, bandeira e parcelas', async () => {
    const r = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_ixc_id: '11', cliente_nome: 'JOAO SOUZA',
      titulos: [{ fatura_ixc_id: '902', valor_centavos: 15000 }],
      pagamentos: [{ forma: 'credito', valor_centavos: 15000, transacao_id: cobranca.id }],
    }, e.operador);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.pagamentos[0].nsu, '123456');
    assert.equal(r.dados.pagamentos[0].parcelas, 3);
    assert.equal(r.dados.ixc_status, 'baixado');

    const repetido = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_nome: 'JOAO SOUZA',
      titulos: [{ fatura_ixc_id: '902', valor_centavos: 15000 }],
      pagamentos: [{ forma: 'credito', valor_centavos: 15000, transacao_id: cobranca.id }],
    }, e.operador);
    assert.equal(repetido.status, 409, 'a mesma cobrança não entra em dois recebimentos');
  });
});

test('PDV: IXC fora do ar não impede o recebimento e a fila baixa depois', async (t) => {
  const ixc = await ixcFalso();
  const app = await iniciar();
  const e = await empresaDeTeste(app, { ixcUrl: ixc.url, ixcToken: ixc.token });
  t.after(async () => { await app.fechar(); await ixc.fechar(); });
  await app.post(`/empresas/${e.eid}/caixa`, { pdv_id: e.pdv.id, fundo_centavos: 0 }, e.operador);

  let id;
  await t.test('o recebimento é registrado mesmo com o IXC recusando a baixa', async () => {
    ixc.estado.recusarBaixa = 'Usuário sem permissão para baixar títulos';
    const r = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_ixc_id: '10', cliente_nome: 'MARIA DA SILVA',
      titulos: [{ fatura_ixc_id: '900', valor_centavos: 9990 }],
      pagamentos: [{ forma: 'pix', valor_centavos: 9990 }],
    }, e.operador);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    id = r.dados.id;
    assert.equal(r.dados.ixc_status, 'erro');
    assert.match(r.dados.titulos[0].ixc_erro, /permissão/);
    assert.ok(r.dados.aviso, 'o operador é avisado de que a baixa não saiu');
  });

  await t.test('a conferência mostra o valor que ainda falta confirmar no IXC', async () => {
    const resumo = await app.get(`/empresas/${e.eid}/conferencia?de=${hoje()}&ate=${hoje()}`, e.supervisor);
    assert.equal(resumo.dados.totais.a_confirmar_centavos, 9990);
    assert.equal(resumo.dados.pendencias.com_erro, 1);
  });

  await t.test('a fila baixa o que ficou para trás quando o IXC volta', async () => {
    const r = await app.post(`/empresas/${e.eid}/conferencia/fila`, {}, e.supervisor);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.baixados, 1);
    assert.equal(r.dados.pendencias.total, 0);
    assert.equal(ixc.estado.faturas.find((f) => f.id === '900').status, 'R');

    const depois = await app.get(`/empresas/${e.eid}/recebimentos/${id}`, e.supervisor);
    assert.equal(depois.dados.ixc_status, 'baixado');
  });

  await t.test('a baixa feita à mão no IXC tira o recebimento da fila', async () => {
    ixc.estado.recusarBaixa = 'IXC indisponível';
    const novo = await app.post(`/empresas/${e.eid}/recebimentos`, {
      cliente_ixc_id: '10', cliente_nome: 'MARIA DA SILVA',
      titulos: [{ fatura_ixc_id: '901', valor_centavos: 9990 }],
      pagamentos: [{ forma: 'dinheiro', valor_centavos: 9990 }],
    }, e.operador);
    assert.equal(novo.dados.ixc_status, 'erro');

    const r = await app.post(`/empresas/${e.eid}/recebimentos/${novo.dados.id}/baixa-manual`, { motivo: 'baixado direto no IXC' }, e.supervisor);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.ixc_status, 'manual');
    const pend = await app.get(`/empresas/${e.eid}/conferencia?de=${hoje()}&ate=${hoje()}`, e.supervisor);
    assert.equal(pend.dados.pendencias.total, 0);
  });
});

test('PDV: cada empresa só enxerga o que é seu', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const a = await empresaDeTeste(app, { terminal: false });
  const master = a.master;
  const b = (await app.post('/master/empresas', { nome: 'Outro Provedor' }, master)).dados;
  await app.post(`/empresas/${b.id}/cadastros/usuarios`, { nome: 'Op B', email: 'op@outro.com.br', senha: 'pdv12345', perfil: 'operador' }, master);
  const opB = await app.login('op@outro.com.br', 'pdv12345');

  assert.equal((await app.get(`/empresas/${a.eid}/recebimentos`, opB)).status, 404);
  assert.equal((await app.get(`/empresas/${a.eid}/caixa/meu`, opB)).status, 404);
  assert.equal((await app.get('/master/empresas', a.operador)).status, 403);
  assert.equal((await app.post(`/empresas/${a.eid}/cadastros/lojas`, { nome: 'Nova' }, a.operador)).status, 403);
  assert.equal((await app.patch(`/empresas/${a.eid}/configuracoes`, { exigir_caixa: false }, a.supervisor)).status, 403);
  assert.equal((await app.patch(`/empresas/${a.eid}/configuracoes`, { exigir_caixa: false }, a.admin)).status, 200);
});
