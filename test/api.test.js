'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, dia } = require('./helpers');
const { inicioMes, fimMes, mes } = require('../server/lib/datas');

const EMPRESA = {
  razao_social: 'Padaria Pão Quente Ltda', nome_fantasia: 'Pão Quente', cnpj: '11.222.333/0001-81', email: 'financeiro@paoquente.com.br',
  responsavel: 'Marta Lima', plano: 'completo', mensalidade_centavos: 180000, dia_vencimento: 10, inicio_contrato: dia(-90),
};

/** Monta OFX 1.x com as linhas [data AAAA-MM-DD, valor em centavos, memo, fitid]. */
const ofx = (linhas) => `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKTRANLIST>\n${linhas.map(([d, v, memo, id]) =>
  `<STMTTRN>\n<DTPOSTED>${d.replace(/-/g, '')}\n<TRNAMT>${(v / 100).toFixed(2)}\n<FITID>${id}\n<MEMO>${memo}\n</STMTTRN>`).join('\n')}\n</BANKTRANLIST></OFX>`;

test('BPO Financeiro', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  let empresa, conta, cats, analistaTk, analistaId;
  const base = () => `/empresas/${empresa}`;
  const cat = (nome) => cats.find((c) => c.nome === nome).id;

  await t.test('login, sessão e senha', async () => {
    assert.equal((await api.post('/auth/login', { email: 'admin@ativabpo.com.br', senha: 'errada' }, null)).status, 401);
    assert.equal((await api.get('/painel', null)).status, 401);
    assert.equal((await api.get('/painel', 'token.falso')).status, 401);
    assert.equal((await api.get('/auth/me')).dados.usuario.perfil, 'admin');
  });

  await t.test('cadastra empresa com plano de contas, centro de custo e rotinas', async () => {
    assert.equal((await api.post('/empresas', { ...EMPRESA, cnpj: '11.222.333/0001-00' })).status, 422);
    const r = await api.post('/empresas', EMPRESA);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    empresa = r.dados.id;
    assert.equal((await api.post('/empresas', EMPRESA)).status, 409);
    cats = (await api.get(`${base()}/categorias`)).dados.itens;
    assert.ok(cats.length >= 20);
    assert.equal((await api.get(`${base()}/centros`)).dados[0].nome, 'Geral');
    assert.equal((await api.get(`/tarefas?empresa_id=${empresa}`)).dados.length, 3);
  });

  await t.test('analista só vê as empresas da própria carteira', async () => {
    const u = await api.post('/usuarios', { nome: 'Ana Analista', email: 'ana@ativabpo.com.br', senha: 'senha-forte-1', perfil: 'analista' });
    analistaId = u.dados.id;
    analistaTk = await api.login('ana@ativabpo.com.br', 'senha-forte-1');
    assert.equal((await api.get('/empresas', analistaTk)).dados.length, 0);
    assert.equal((await api.get(`${base()}/resumo`, analistaTk)).status, 403);
    assert.equal((await api.post('/empresas', { ...EMPRESA, cnpj: '06.990.590/0001-23' }, analistaTk)).status, 403);
    assert.equal((await api.get('/usuarios', analistaTk)).status, 403);
    assert.equal((await api.patch(`/empresas/${empresa}`, { analista_id: analistaId })).status, 204);
    assert.equal((await api.get('/empresas', analistaTk)).dados.length, 1);
    assert.equal((await api.get(`${base()}/resumo`, analistaTk)).status, 200);
    // O analista não muda contrato nem mensalidade.
    assert.equal((await api.patch(`/empresas/${empresa}`, { mensalidade_centavos: 1 }, analistaTk)).status, 403);
  });

  await t.test('conta bancária, contatos e categorias validados', async () => {
    const c = await api.post(`${base()}/contas-bancarias`, { descricao: 'Conta movimento', banco: 'Banco do Brasil', agencia: '0001', numero: '12345-6',
      saldo_inicial_centavos: 1_000_000, data_saldo_inicial: dia(-60) });
    assert.equal(c.status, 201);
    conta = c.dados.id;
    assert.equal((await api.post(`${base()}/contatos`, { tipo: 'fornecedor', nome: 'Moinho Sul', documento: '123' })).status, 422);
    assert.equal((await api.post(`${base()}/contatos`, { tipo: 'fornecedor', nome: 'Moinho Sul', documento: '06.990.590/0001-23' })).status, 201);
    assert.equal((await api.post(`${base()}/categorias`, { nome: 'Teste', tipo: 'receita', grupo_dre: 'custos' })).status, 422);
  });

  await t.test('conta a pagar parcelada e regras de categoria', async () => {
    assert.equal((await api.post(`${base()}/lancamentos`, { tipo: 'pagar', descricao: 'X', valor_centavos: 100, vencimento: dia(), categoria_id: cat('Venda de produtos') })).status, 422);
    const r = await api.post(`${base()}/lancamentos`, { tipo: 'pagar', descricao: 'Forno industrial', valor_centavos: 100_000, parcelas: 3,
      vencimento: dia(5), categoria_id: cat('Investimentos em imobilizado') });
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.ids.length, 3);
    const det = (await api.get(`${base()}/lancamentos/${r.dados.ids[0]}`)).dados;
    assert.deepEqual(det.parcelas.map((p) => p.valor_centavos), [33_334, 33_333, 33_333]);
    assert.equal(det.parcelas[1].vencimento.slice(0, 7) > det.parcelas[0].vencimento.slice(0, 7), true);
  });

  let aluguel;
  await t.test('baixa com juros, estorno e cancelamento', async () => {
    const r = await api.post(`${base()}/lancamentos`, { tipo: 'pagar', descricao: 'Aluguel', valor_centavos: 300_000, vencimento: dia(-2), categoria_id: cat('Aluguel e condomínio') });
    aluguel = r.dados.ids[0];
    assert.equal((await api.get(`${base()}/lancamentos?tipo=pagar&status=vencido`)).dados.total, 1);
    assert.equal((await api.post(`${base()}/lancamentos/${aluguel}/baixa`, { data: dia(-1) })).status, 422, 'exige conta');
    const b = await api.post(`${base()}/lancamentos/${aluguel}/baixa`, { data: dia(-1), conta_bancaria_id: conta, juros_centavos: 1_500 });
    assert.equal(b.status, 200, JSON.stringify(b.dados));
    let l = (await api.get(`${base()}/lancamentos/${aluguel}`)).dados;
    assert.equal(l.status, 'pago');
    assert.equal(l.valor_pago_centavos, 301_500);
    const saldo = (await api.get(`${base()}/contas-bancarias`)).dados[0].saldo_centavos;
    assert.equal(saldo, 1_000_000 - 301_500);
    assert.equal((await api.post(`${base()}/lancamentos/${aluguel}/baixa`, { conta_bancaria_id: conta })).status, 422);
    assert.equal((await api.post(`${base()}/lancamentos/${aluguel}/cancelar`)).status, 422);
    assert.equal((await api.post(`${base()}/lancamentos/${aluguel}/estorno`)).status, 204);
    l = (await api.get(`${base()}/lancamentos/${aluguel}`)).dados;
    assert.equal(l.status, 'aberto');
    assert.equal((await api.get(`${base()}/contas-bancarias`)).dados[0].saldo_centavos, 1_000_000);
  });

  await t.test('importa OFX sem duplicar e concilia (sugestão, automática e lançamento a partir do extrato)', async () => {
    // Recebimento previsto e venda já recebida (baixada) para conciliar com o extrato.
    const rec = await api.post(`${base()}/lancamentos`, { tipo: 'receber', descricao: 'Venda atacado', valor_centavos: 450_000, vencimento: dia(-3), categoria_id: cat('Venda de produtos') });
    const recebida = await api.post(`${base()}/lancamentos`, { tipo: 'receber', descricao: 'Venda balcão', valor_centavos: 80_000, vencimento: dia(-4),
      categoria_id: cat('Venda de produtos'), baixar: true, baixa: { data: dia(-4), conta_bancaria_id: conta } });
    assert.equal(recebida.status, 201, JSON.stringify(recebida.dados));
    const arquivo = ofx([
      [dia(-4), 80_000, 'PIX VENDA BALCAO', 'F1'],
      [dia(-3), 450_000, 'TED ATACADO', 'F2'],
      [dia(-1), -301_500, 'ALUGUEL', 'F3'],
      [dia(-1), -2_990, 'TARIFA PACOTE', 'F4'],
    ]);
    const imp = await api.post(`${base()}/extrato/importar`, { conta_bancaria_id: conta, conteudo: arquivo, arquivo: 'extrato.ofx' });
    assert.equal(imp.status, 201, JSON.stringify(imp.dados));
    assert.equal(imp.dados.importados, 4);
    assert.equal((await api.post(`${base()}/extrato/importar`, { conta_bancaria_id: conta, conteudo: arquivo })).dados.duplicados, 4);

    let painel = (await api.get(`${base()}/conciliacao?conta_bancaria_id=${conta}`)).dados;
    assert.equal(painel.itens.length, 4);
    const f1 = painel.itens.find((x) => x.fitid === 'F1');
    assert.equal(f1.sugestoes.movimentos.length, 1);
    const f2 = painel.itens.find((x) => x.fitid === 'F2');
    assert.equal(f2.sugestoes.abertos[0].id, rec.dados.ids[0]);
    const f3 = painel.itens.find((x) => x.fitid === 'F3');
    assert.equal(f3.sugestoes.abertos.length, 0, 'aluguel tem 300.000 em aberto; o débito foi 301.500');

    // Automática: F1 (movimento único) e F2 (conta em aberto única, no prazo).
    const auto = await api.post(`${base()}/extrato/automatica`, { conta_bancaria_id: conta });
    assert.deepEqual(auto.dados, { conciliados: 2, pendentes: 2 });
    assert.equal((await api.get(`${base()}/lancamentos/${rec.dados.ids[0]}`)).dados.status, 'pago');

    // Aluguel pago com juros: baixa manual a partir do extrato (diferença vira juros).
    const c3 = await api.post(`${base()}/extrato/${f3.id}/conciliar`, { lancamento_id: aluguel });
    assert.equal(c3.status, 200, JSON.stringify(c3.dados));
    const al = (await api.get(`${base()}/lancamentos/${aluguel}`)).dados;
    assert.equal(al.juros_centavos, 1_500);
    assert.equal(al.pago_em, dia(-1));
    assert.equal(al.extrato.fitid, 'F3');

    // Tarifa sem título: cria o lançamento já conciliado.
    const f4 = painel.itens.find((x) => x.fitid === 'F4');
    assert.equal((await api.post(`${base()}/extrato/${f4.id}/lancar`, { categoria_id: cat('Venda de produtos') })).status, 422, 'débito exige categoria de despesa');
    assert.equal((await api.post(`${base()}/extrato/${f4.id}/lancar`, { categoria_id: cat('Tarifas bancárias') })).status, 201);
    painel = (await api.get(`${base()}/conciliacao?conta_bancaria_id=${conta}`)).dados;
    assert.equal(painel.resumo.pendentes, 0);
    assert.equal(painel.resumo.conciliados, 4);
    assert.equal(painel.nao_conciliados.length, 0);

    // Saldo do livro caixa bate com saldo inicial + extrato.
    const saldo = (await api.get(`${base()}/contas-bancarias`)).dados[0].saldo_centavos;
    assert.equal(saldo, 1_000_000 + painel.resumo.extrato_centavos);
    assert.equal(painel.resumo.diferenca_centavos, 0);

    // Estornar uma baixa conciliada devolve o item do extrato para pendente.
    assert.equal((await api.post(`${base()}/lancamentos/${aluguel}/estorno`)).status, 204);
    assert.equal((await api.get(`${base()}/conciliacao?conta_bancaria_id=${conta}`)).dados.resumo.pendentes, 1);
    const f3b = (await api.get(`${base()}/conciliacao?conta_bancaria_id=${conta}`)).dados.itens[0];
    assert.equal((await api.post(`${base()}/extrato/${f3b.id}/conciliar`, { lancamento_id: aluguel })).status, 200);
  });

  await t.test('transferência entre contas não altera o caixa consolidado', async () => {
    const c2 = await api.post(`${base()}/contas-bancarias`, { descricao: 'Aplicação', banco: 'Banco do Brasil', saldo_inicial_centavos: 0, data_saldo_inicial: dia(-60) });
    const antes = (await api.get(`${base()}/resumo`)).dados.saldo_total_centavos;
    assert.equal((await api.post(`${base()}/transferencias`, { origem_id: conta, destino_id: c2.dados.id, valor_centavos: 200_000, data: dia() })).status, 201);
    assert.equal((await api.get(`${base()}/resumo`)).dados.saldo_total_centavos, antes);
    assert.equal((await api.post(`${base()}/transferencias`, { origem_id: conta, destino_id: conta, valor_centavos: 1 })).status, 422);
  });

  await t.test('DRE por competência e por caixa', async () => {
    const de = inicioMes(dia(-40));
    const ate = fimMes(dia(70)); // inclui as três parcelas do forno
    const d = (await api.get(`${base()}/dre?de=${de}&ate=${ate}`)).dados;
    const linha = (rotulo) => d.linhas.find((l) => l.rotulo === rotulo);
    assert.equal(linha('Receita bruta').total, 530_000);
    assert.equal(linha('Despesas operacionais').total, 300_000);
    assert.equal(linha('Despesas financeiras').total, 2_990 + 1_500);
    assert.equal(linha('Lucro líquido').total, 530_000 - 300_000 - 4_490);
    // Imobilizado fica fora da DRE (saída de caixa).
    assert.equal(d.fora_dre.total, -100_000);
    assert.ok(d.meses.includes(mes(dia())));
    const caixa = (await api.get(`${base()}/dre?de=${de}&ate=${ate}&regime=caixa`)).dados;
    assert.equal(caixa.linhas.find((l) => l.rotulo === 'Receita bruta').total, 530_000);
    assert.equal(caixa.fora_dre.total, 0, 'parcelas do forno ainda não pagas');
    const csv = await api.get(`${base()}/dre.csv?de=${de}&ate=${ate}`);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.dados, /= Lucro líquido/);
  });

  await t.test('fluxo de caixa: realizado, previsto e saldo projetado', async () => {
    const f = (await api.get(`${base()}/fluxo-caixa?de=${dia(-10)}&ate=${dia(100)}&agrupar=mes`)).dados;
    const realizado = f.periodos.reduce((a, p) => a + p.entradas_realizadas - p.saidas_realizadas, 0);
    assert.equal(realizado, 530_000 - 301_500 - 2_990);
    const previstoSaidas = f.periodos.reduce((a, p) => a + p.saidas_previstas, 0);
    assert.equal(previstoSaidas, 100_000);
    assert.equal(f.saldo_final, f.saldo_inicial + realizado - 100_000);
    assert.equal((await api.get(`${base()}/fluxo-caixa?de=${dia(-200)}&ate=${dia()}&agrupar=dia`)).status, 422);
  });

  await t.test('tarefa recorrente gera a próxima ao concluir', async () => {
    const lista = (await api.get(`/tarefas?empresa_id=${empresa}`, analistaTk)).dados;
    const t1 = lista[0];
    const r = await api.post(`/tarefas/${t1.id}/concluir`, {}, analistaTk);
    assert.equal(r.status, 200);
    assert.ok(r.dados.vencimento > t1.vencimento);
    assert.equal((await api.post(`/tarefas/${t1.id}/concluir`, {}, analistaTk)).status, 422);
  });

  await t.test('painel da carteira e auditoria', async () => {
    const p = (await api.get('/painel')).dados;
    assert.equal(p.carteira.mrr_centavos, 180_000);
    assert.equal(p.pendencias[0].id, empresa);
    assert.ok(p.por_analista.some((a) => a.id === analistaId && a.empresas === 1));
    assert.equal((await api.get('/painel', analistaTk)).dados.por_analista, null);
    const aud = (await api.get(`/auditoria?empresa_id=${empresa}`)).dados;
    assert.ok(aud.itens.some((a) => a.acao === 'extrato_importado'));
    assert.equal((await api.get('/auditoria', analistaTk)).status, 403);
  });

  await t.test('isolamento entre empresas', async () => {
    const outra = (await api.post('/empresas', { ...EMPRESA, razao_social: 'Outra SA', cnpj: '06.990.590/0001-23' })).dados.id;
    const catOutra = (await api.get(`/empresas/${outra}/categorias`)).dados.itens.find((c) => c.nome === 'Aluguel e condomínio').id;
    // Categoria de outra empresa não serve aqui.
    assert.equal((await api.post(`${base()}/lancamentos`, { tipo: 'pagar', descricao: 'X', valor_centavos: 100, vencimento: dia(), categoria_id: catOutra })).status, 422);
    assert.equal((await api.get(`/empresas/${outra}/lancamentos/${aluguel}`)).status, 404);
    assert.equal((await api.get(`/empresas/${outra}/resumo`, analistaTk)).status, 403);
  });
});
