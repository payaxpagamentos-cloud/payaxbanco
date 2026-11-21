'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const contabil = require('../server/lib/contabil');
const fat = require('../server/lib/faturamento');
const { dataLocal } = require('../server/lib/datas');

const HOJE = dataLocal('America/Sao_Paulo');
const COMP = HOJE.slice(0, 7);

async function equipe(api) {
  const admin = await api.login();
  const tk = { admin };
  for (const perfil of ['financeiro', 'gestor', 'noc']) {
    const r = await api.post('/organizacao/usuarios', { nome: `U ${perfil}`, email: `${perfil}.ct@teste.local`, senha: 'senha-teste-123', perfil }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    tk[perfil] = await api.login(`${perfil}.ct@teste.local`, 'senha-teste-123');
  }
  return tk;
}

/** Devolve o id da conta pelo código. */
const idDe = (plano, codigo) => plano.contas.find((c) => c.codigo === codigo).id;

test('contabilidade: plano de contas, lançamento e as regras que não se dobram', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await equipe(api);

  await t.test('o plano padrão separa sintéticas de analíticas e já mapeia as contas do sistema', async () => {
    const r = await api.post('/contabil/plano/padrao', {}, tk.financeiro);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.ok(r.dados.contas > 40);
    const plano = (await api.get('/contabil/plano', tk.financeiro)).dados;
    const receita = plano.contas.find((c) => c.codigo === '4.1');
    const mensalidade = plano.contas.find((c) => c.codigo === '4.1.01');
    assert.equal(receita.analitica, 0, 'conta que tem filhas vira sintética sozinha');
    assert.equal(mensalidade.analitica, 1);
    assert.equal(receita.natureza, 'credora');
    assert.equal(plano.contas.find((c) => c.codigo === '1.1.03').natureza, 'devedora');
    assert.equal(plano.mapa.clientes, plano.contas.find((c) => c.codigo === '1.1.03').id);
    assert.deepEqual(contabil.OBRIGATORIAS ?? [], []);
  });

  await t.test('não cria o plano padrão duas vezes', async () => {
    const r = await api.post('/contabil/plano/padrao', {}, tk.financeiro);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /já tem plano/i);
  });

  const plano = (await api.get('/contabil/plano', tk.financeiro)).dados;
  const clientes = idDe(plano, '1.1.03');
  const mensalidades = idDe(plano, '4.1.01');
  const banco = idDe(plano, '1.1.02');
  const sintetica = idDe(plano, '4.1');

  await t.test('LANÇAMENTO QUE NÃO FECHA NÃO ENTRA', async () => {
    const r = await api.post('/contabil/lancamentos', {
      data: `${COMP}-10`, historico: 'Teste desbalanceado',
      partidas: [{ conta_id: clientes, tipo: 'D', valor: '100,00' }, { conta_id: mensalidades, tipo: 'C', valor: '90,00' }],
    }, tk.financeiro);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /não fecha/i);
    assert.match(r.dados.erro, /100\.00/);
  });

  await t.test('conta sintética não recebe lançamento', async () => {
    const r = await api.post('/contabil/lancamentos', {
      data: `${COMP}-10`, historico: 'Na mãe',
      partidas: [{ conta_id: clientes, tipo: 'D', valor: '10,00' }, { conta_id: sintetica, tipo: 'C', valor: '10,00' }],
    }, tk.financeiro);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /sintética/i);
  });

  await t.test('lançamento sem histórico é recusado', async () => {
    const r = await api.post('/contabil/lancamentos', {
      data: `${COMP}-10`, historico: '  ',
      partidas: [{ conta_id: clientes, tipo: 'D', valor: '10,00' }, { conta_id: mensalidades, tipo: 'C', valor: '10,00' }],
    }, tk.financeiro);
    assert.equal(r.status, 422);
  });

  let lancamento;
  await t.test('lançamento válido entra com as duas partidas', async () => {
    const r = await api.post('/contabil/lancamentos', {
      data: `${COMP}-10`, historico: 'Mensalidade manual',
      partidas: [{ conta_id: clientes, tipo: 'D', valor: '150,00' }, { conta_id: mensalidades, tipo: 'C', valor: '150,00' }],
    }, tk.financeiro);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    lancamento = r.dados;
    assert.equal(lancamento.valor_centavos, 15000);
    assert.equal(lancamento.partidas.length, 2);
    assert.equal(lancamento.partidas[0].tipo, 'D', 'débito primeiro, como se lê um lançamento');
  });

  await t.test('estorno não apaga: cria o inverso e os dois se apontam', async () => {
    const r = await api.post(`/contabil/lancamentos/${lancamento.id}/estornar`, { motivo: 'Lançado na conta errada' }, tk.financeiro);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    const estorno = r.dados;
    assert.equal(estorno.partidas.find((p) => p.conta_id === clientes).tipo, 'C', 'o débito virou crédito');
    const original = (await api.get(`/contabil/lancamentos/${lancamento.id}`, tk.financeiro)).dados;
    assert.equal(original.estornado_por_id, estorno.id);
    assert.equal(estorno.estorna_id, lancamento.id);
    assert.match(original.motivo_estorno, /conta errada/i);

    const denovo = await api.post(`/contabil/lancamentos/${lancamento.id}/estornar`, { motivo: 'de novo' }, tk.financeiro);
    assert.equal(denovo.status, 422);
    assert.match(denovo.dados.erro, /já foi estornado/i);
  });

  await t.test('balancete fecha e a conta sintética soma as filhas', async () => {
    await api.post('/contabil/lancamentos', {
      data: `${COMP}-11`, historico: 'Recebimento',
      partidas: [{ conta_id: banco, tipo: 'D', valor: '80,00' }, { conta_id: mensalidades, tipo: 'C', valor: '80,00' }],
    }, tk.financeiro);
    const b = (await api.get(`/contabil/balancete?de=${COMP}&ate=${COMP}`, tk.financeiro)).dados;
    assert.equal(b.fecha, true);
    assert.equal(b.diferenca_centavos, 0);
    assert.equal(b.linhas.find((c) => c.codigo === '4.1').movimento_centavos, 8000, 'a sintética 4.1 traz o movimento da filha');
    assert.equal(b.linhas.find((c) => c.codigo === '4').movimento_centavos, 8000, 'e sobe até a raiz');
  });

  await t.test('razão mostra o saldo correndo lançamento a lançamento', async () => {
    const r = (await api.get(`/contabil/razao/${mensalidades}?de=${COMP}&ate=${COMP}`, tk.financeiro)).dados;
    assert.equal(r.conta.codigo, '4.1.01');
    assert.equal(r.saldo_anterior_centavos, 0);
    assert.equal(r.saldo_centavos, 8000, '150 de receita, 150 estornados, 80 de receita');
    assert.equal(r.linhas.at(-1).saldo_centavos, r.saldo_centavos);
  });

  await t.test('fechar impede lançamento no mês, e só o admin reabre', async () => {
    const f = await api.post('/contabil/fechamentos', { competencia: COMP }, tk.financeiro);
    assert.equal(f.status, 201, JSON.stringify(f.dados));

    const tarde = await api.post('/contabil/lancamentos', {
      data: `${COMP}-28`, historico: 'Atrasado',
      partidas: [{ conta_id: clientes, tipo: 'D', valor: '10,00' }, { conta_id: mensalidades, tipo: 'C', valor: '10,00' }],
    }, tk.financeiro);
    assert.equal(tarde.status, 422);
    assert.match(tarde.dados.erro, /fechada/i);

    assert.equal((await api.post(`/contabil/fechamentos/${COMP}/reabrir`, { motivo: 'x' }, tk.financeiro)).status, 403, 'financeiro não reabre');
    const ok = await api.post(`/contabil/fechamentos/${COMP}/reabrir`, { motivo: 'Faltou um lançamento do contador' }, tk.admin);
    assert.equal(ok.status, 200);
    assert.match(ok.dados.aviso, /avise-o/i);
  });

  await t.test('conta com saldo não pode ser desativada', async () => {
    const atual = (await api.get('/contabil/plano', tk.financeiro)).dados.contas.find((c) => c.codigo === '4.1.01');
    const r = await api.patch(`/contabil/plano/${atual.id}`, { ativa: false, versao: atual.versao }, tk.financeiro);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /saldo/i);
  });

  await t.test('o gestor lê mas não lança; o NOC não vê nada', async () => {
    assert.equal((await api.get(`/contabil/balancete?de=${COMP}&ate=${COMP}`, tk.gestor)).status, 200);
    assert.equal((await api.post('/contabil/lancamentos', { data: `${COMP}-10`, historico: 'x', partidas: [] }, tk.gestor)).status, 403);
    assert.equal((await api.get('/contabil/plano', tk.noc)).status, 403);
    assert.equal((await api.get(`/contabil/dre?de=${COMP}&ate=${COMP}`, tk.noc)).status, 403);
  });
});

test('contabilidade: o financeiro se contabiliza sozinho e os dois não divergem', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await equipe(api);
  await api.post('/contabil/plano/padrao', {}, tk.financeiro);

  const plano = (await api.get('/contabil/plano', tk.financeiro)).dados;
  const criar = async (caminho, corpo, token = tk.financeiro, esperado = 201) => {
    const r = await api.post(caminho, corpo, token);
    assert.equal(r.status, esperado, `${caminho}: ${JSON.stringify(r.dados)}`);
    return r.dados;
  };
  const planoComercial = await criar('/planos', { nome: 'Fibra 500', tipo: 'internet', tecnologia: 'fibra', download_mbps: 500, upload_mbps: 250, mensalidade: '100,00' });
  const assinante = await criar('/assinantes', { tipo: 'pf', nome: 'Cliente Contábil', documento: '390.533.447-05' });

  await t.test('não liga a contabilização automática sem o mapa completo', async () => {
    await api.put('/contabil/plano/mapa', { clientes: null }, tk.financeiro);
    const r = await api.put('/contabil/automatica', { ligada: true }, tk.financeiro);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /mapeado/i);
    assert.match(r.dados.erro, /clientes/);
    // Restaura
    await api.put('/contabil/plano/mapa', { clientes: idDe(plano, '1.1.03') }, tk.financeiro);
  });

  await t.test('com o mapa completo, liga', async () => {
    const r = await api.put('/contabil/automatica', { ligada: true }, tk.financeiro);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.ligada, true);
  });

  let fatura;
  await t.test('fatura emitida vira lançamento: cliente deve, receita reconhecida', async () => {
    fatura = await criar('/faturamento/faturas', {
      assinante_id: assinante.id, vencimento: `${COMP}-20`,
      itens: [{ descricao: 'Mensalidade', valor: '100,00' }, { descricao: 'Instalação', valor: '150,00' }],
    });
    const l = (await api.get(`/contabil/lancamentos?origem=faturamento`, tk.financeiro)).dados.itens[0];
    assert.ok(l, 'a fatura gerou lançamento sozinha');
    assert.equal(l.valor_centavos, 25000);
    const porConta = Object.fromEntries(l.partidas.map((p) => [p.codigo, { tipo: p.tipo, valor: p.valor_centavos }]));
    assert.deepEqual(porConta['1.1.03'], { tipo: 'D', valor: 25000 }, 'o assinante passa a dever o total');
    assert.deepEqual(porConta['4.1.05'], { tipo: 'C', valor: 25000 }, 'item avulso vai para outros serviços');
  });

  await t.test('contabilizar duas vezes não duplica', async () => {
    const antes = (await api.get('/contabil/lancamentos', tk.financeiro)).dados.total;
    const r = await api.post('/contabil/pendencias/contabilizar', {}, tk.financeiro);
    assert.equal(r.status, 200);
    const depois = (await api.get('/contabil/lancamentos', tk.financeiro)).dados.total;
    assert.equal(depois, antes, 'a chave do fato impede o lançamento repetido');
  });

  await t.test('baixa com encargos: o caixa entra, a dívida cai e os encargos são receita à parte', async () => {
    // A fatura venceu ontem, então o financeiro acrescenta a multa por conta própria, além do juro informado.
    const baixa = await criar(`/faturamento/faturas/${fatura.id}/pagamentos`, { valor: '250,00', juros: '12,00', forma: 'pix', data: HOJE });
    const encargos = (baixa.pagamento?.juros_centavos ?? 1200) + (baixa.pagamento?.multa_centavos ?? 500);
    const l = (await api.get('/contabil/lancamentos?origem=recebimento', tk.financeiro)).dados.itens[0];
    assert.ok(l);
    const porConta = Object.fromEntries(l.partidas.map((p) => [p.codigo, { tipo: p.tipo, valor: p.valor_centavos }]));
    assert.deepEqual(porConta['1.1.02'], { tipo: 'D', valor: 25000 + encargos }, 'entrou no banco a fatura mais os encargos');
    assert.deepEqual(porConta['1.1.03'], { tipo: 'C', valor: 25000 }, 'a dívida baixa SÓ pelo valor da fatura');
    assert.deepEqual(porConta['4.2.01'], { tipo: 'C', valor: encargos }, 'juros e multa são receita nova, não abatem dívida');
    // É esta separação que impede o saldo do assinante de ficar negativo quando ele paga com encargos.
    assert.equal(porConta['1.1.02'].valor, porConta['1.1.03'].valor + porConta['4.2.01'].valor);
  });

  await t.test('estorno da baixa desfaz o lançamento, sem apagá-lo', async () => {
    const pg = (await api.get(`/faturamento/faturas/${fatura.id}`, tk.financeiro)).dados.pagamentos[0];
    await criar(`/faturamento/pagamentos/${pg.id}/estornar`, { motivo: 'Baixa em duplicidade' }, tk.admin, 200);
    const recebimento = (await api.get('/contabil/lancamentos?origem=recebimento', tk.financeiro)).dados.itens[0];
    assert.ok(recebimento.estornado_por_id, 'o lançamento do recebimento ficou marcado como estornado');
    const estorno = (await api.get(`/contabil/lancamentos/${recebimento.estornado_por_id}`, tk.financeiro)).dados;
    assert.equal(estorno.origem, 'estorno');
    assert.equal(estorno.partidas.find((p) => p.codigo === '1.1.02').tipo, 'C', 'o dinheiro sai do banco de volta');
  });

  await t.test('O BALANCETE CONTINUA FECHANDO DEPOIS DE TUDO ISSO', async () => {
    const b = (await api.get(`/contabil/balancete?de=${COMP}&ate=${COMP}`, tk.financeiro)).dados;
    assert.equal(b.fecha, true, `diferença de ${b.diferenca_centavos} centavos`);
  });

  await t.test('a conferência prova que nada do financeiro ficou de fora', async () => {
    const p = (await api.get('/contabil/pendencias', tk.financeiro)).dados;
    assert.equal(p.total, 0, 'nenhum fato do financeiro sem lançamento');
    assert.equal(p.mapa_completo, true);
    assert.equal(p.ligada, true);
  });

  await t.test('o que o financeiro deve receber bate com o saldo contábil de clientes', async () => {
    // Depois do estorno, a fatura voltou a ficar em aberto: contabilidade e financeiro têm de dizer o mesmo.
    const f = (await api.get(`/faturamento/faturas/${fatura.id}`, tk.financeiro)).dados;
    const aReceber = f.valor_centavos - f.pago_centavos;
    const razao = (await api.get(`/contabil/razao/${idDe(plano, '1.1.03')}?de=${COMP}&ate=${COMP}`, tk.financeiro)).dados;
    assert.equal(razao.saldo_centavos, aReceber, 'saldo de "clientes a receber" igual ao que o financeiro cobra');
  });

  await t.test('DESCONTO REDUZ a receita líquida, não aumenta', async () => {
    /*
     * "Deduções da receita" fica sob receita no plano (natureza credora), mas o desconto é lançado a
     * DÉBITO. Sem cuidado com o sinal, subtrair um movimento negativo AUMENTA a receita líquida — o
     * desconto dado ao assinante viraria receita a mais. É um erro silencioso: o balancete fecha igual.
     */
    const antes = (await api.get(`/contabil/dre?de=${COMP}&ate=${COMP}`, tk.financeiro)).dados;
    await criar('/contabil/lancamentos', {
      data: HOJE, historico: 'Desconto comercial concedido',
      partidas: [
        { conta_id: idDe(plano, '4.3.01'), tipo: 'D', valor: '20,00' },
        { conta_id: idDe(plano, '1.1.03'), tipo: 'C', valor: '20,00' },
      ],
    });
    const d = (await api.get(`/contabil/dre?de=${COMP}&ate=${COMP}`, tk.financeiro)).dados;
    assert.equal(d.deducoes_centavos, 2000, 'a dedução aparece positiva, como valor a subtrair');
    assert.equal(d.receita_liquida_centavos, d.receita_servicos_centavos + d.outras_receitas_centavos - 2000,
      'receita líquida = receitas MENOS deduções');
    assert.equal(d.receita_liquida_centavos, antes.receita_liquida_centavos - 2000,
      'conceder desconto tem de DIMINUIR a receita líquida');
    assert.equal(d.resultado_centavos, antes.resultado_centavos - 2000, 'e diminuir o resultado na mesma medida');
  });

  await t.test('fatura cancelada estorna a receita reconhecida', async () => {
    await criar(`/faturamento/faturas/${fatura.id}/cancelar`, { motivo: 'Lançada por engano' }, tk.admin, 200);
    const emissao = (await api.get('/contabil/lancamentos?origem=faturamento', tk.financeiro)).dados.itens[0];
    assert.ok(emissao.estornado_por_id, 'o reconhecimento da receita foi desfeito');
    const b = (await api.get(`/contabil/balancete?de=${COMP}&ate=${COMP}`, tk.financeiro)).dados;
    assert.equal(b.fecha, true);
    const dre = (await api.get(`/contabil/dre?de=${COMP}&ate=${COMP}`, tk.financeiro)).dados;
    assert.equal(dre.receita_servicos_centavos, 0, 'a receita da fatura cancelada não fica no resultado');
  });

  await t.test('fechar avisa quando há fato do financeiro sem contabilizar', async () => {
    await api.put('/contabil/automatica', { ligada: false }, tk.financeiro);
    await criar('/faturamento/faturas', { assinante_id: assinante.id, vencimento: `${COMP}-28`, itens: [{ descricao: 'Taxa', valor: '30,00' }] });
    const p = (await api.get('/contabil/pendencias', tk.financeiro)).dados;
    assert.equal(p.total, 1, 'com a automática desligada, o fato fica pendente — e aparece');
    const f = await api.post('/contabil/fechamentos', { competencia: COMP }, tk.financeiro);
    assert.equal(f.status, 201);
    assert.match(f.dados.aviso, /não foram contabilizados/i);
  });

  void planoComercial;
});

test('contabilidade: outra organização não enxerga nem lança nada daqui', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await equipe(api);
  await api.post('/contabil/plano/padrao', {}, tk.financeiro);
  const plano = (await api.get('/contabil/plano', tk.financeiro)).dados;
  const outro = await api.outraOrganizacao();

  assert.deepEqual((await api.get('/contabil/plano', outro)).dados.contas, []);
  assert.deepEqual((await api.get('/contabil/lancamentos', outro)).dados.itens, []);
  assert.equal((await api.get(`/contabil/razao/${idDe(plano, '1.1.03')}?de=${COMP}&ate=${COMP}`, outro)).status, 404);
  const r = await api.post('/contabil/lancamentos', {
    data: `${COMP}-10`, historico: 'Invasão',
    partidas: [{ conta_id: idDe(plano, '1.1.03'), tipo: 'D', valor: '10,00' }, { conta_id: idDe(plano, '4.1.01'), tipo: 'C', valor: '10,00' }],
  }, outro);
  assert.equal(r.status, 422, 'conta de outra organização não existe para esta');
});

test('contabilidade: as contas do motor, conferidas à mão', () => {
  // Natureza decide o sinal: devedora soma débito; credora soma crédito.
  assert.equal(contabil.NATUREZA.ativo, 'devedora');
  assert.equal(contabil.NATUREZA.receita, 'credora');
  assert.equal(contabil.NATUREZA.despesa, 'devedora');
  assert.equal(contabil.NATUREZA.passivo, 'credora');
  assert.equal(contabil.NATUREZA.patrimonio, 'credora');

  assert.equal(contabil.competenciaValida('2026-03'), true);
  assert.equal(contabil.competenciaValida('2026-13'), false);
  assert.equal(contabil.competenciaValida('2026-3'), false);
  assert.equal(contabil.competenciaDe('2026-03-15'), '2026-03');

  // O plano padrão tem toda conta com mãe existente antes dela.
  const codigos = new Set(contabil.PLANO_PADRAO.map(([c]) => c));
  for (const [codigo] of contabil.PLANO_PADRAO) {
    const partes = codigo.split('.');
    if (partes.length > 1) assert.ok(codigos.has(partes.slice(0, -1).join('.')), `${codigo} não tem conta mãe no plano padrão`);
  }
  // E toda chave do mapa aponta para uma conta que existe nele.
  for (const [chave, codigo] of Object.entries(contabil.PADRAO_CONTAS)) {
    assert.ok(codigos.has(codigo), `o mapa "${chave}" aponta para ${codigo}, que não está no plano padrão`);
  }
  void fat;
});
