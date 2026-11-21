'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const fat = require('../server/lib/faturamento');
const { dataLocal } = require('../server/lib/datas');

const HOJE = dataLocal('America/Sao_Paulo');
const ATUAL = fat.competenciaDe(HOJE);
const ANTERIOR = fat.somarMeses(ATUAL, -1);
const RETRASADA = fat.somarMeses(ATUAL, -2);
const dia = (competencia, d) => `${competencia}-${String(d).padStart(2, '0')}`;

/** Cria financeiro e gestor e devolve os tokens. */
async function equipeFinanceira(api, admin) {
  const tk = { admin };
  for (const perfil of ['financeiro', 'gestor', 'tecnico']) {
    const r = await api.post('/organizacao/usuarios', { nome: `Usuário ${perfil}`, email: `${perfil}.fin@teste.local`, senha: 'senha-teste-123', perfil }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    tk[perfil] = await api.login(`${perfil}.fin@teste.local`, 'senha-teste-123');
  }
  return tk;
}

test('faturamento: pró-rata, ciclo, baixa, estorno e cancelamento', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const admin = await api.login();
  const tk = await equipeFinanceira(api, admin);
  const criar = async (caminho, corpo, token = tk.financeiro, esperado = 201) => {
    const r = await api.post(caminho, corpo, token);
    assert.equal(r.status, esperado, `${caminho}: ${JSON.stringify(r.dados)}`);
    return r.dados;
  };

  const plano = await criar('/planos', { nome: 'Fibra 500', tipo: 'internet', tecnologia: 'fibra', download_mbps: 500, upload_mbps: 250,
    mensalidade: '99,90', instalacao: '150,00', fidelidade_meses: 12 });

  await t.test('plano exige velocidade e não repete nome', async () => {
    assert.equal((await api.post('/planos', { nome: 'Sem velocidade', tipo: 'internet', mensalidade: '50,00' }, tk.financeiro)).status, 422);
    assert.equal((await api.post('/planos', { nome: 'Fibra 500', tipo: 'internet', download_mbps: 100, mensalidade: '50,00' }, tk.financeiro)).status, 409);
  });

  await t.test('assinante: documento conferido pelo dígito e único na organização', async () => {
    assert.equal((await api.post('/assinantes', { tipo: 'pf', nome: 'Inválido', documento: '111.111.111-11' }, tk.financeiro)).status, 422);
    assert.equal((await api.post('/assinantes', { tipo: 'pj', nome: 'Empresa', documento: '390.533.447-05' }, tk.financeiro)).status, 422, 'CPF no lugar de CNPJ');
  });

  const assinante = await criar('/assinantes', { tipo: 'pf', nome: 'Maria Souza', documento: '390.533.447-05', telefone: '13999887766',
    email: 'maria@exemplo.com', cep: '11750-000', logradouro: 'Rua das Flores', numero: '120', bairro: 'Centro', cidade: 'Peruíbe', uf: 'SP' });
  assert.equal(assinante.situacao, 'prospecto');

  // Vencimento no dia 20: como o contrato entra no dia 8, o vencimento do mês ainda está à frente e a pró-rata é cobrada ali mesmo.
  const contrato = await criar('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 20 });

  await t.test('primeiro contrato transforma o prospecto em cliente', async () => {
    assert.equal((await api.get(`/assinantes/${assinante.id}`, tk.financeiro)).dados.situacao, 'cliente');
    assert.equal(contrato.mensalidade_centavos, 9990, 'contrato nasce com o valor do plano');
    assert.equal(contrato.situacao, 'em_implantacao');
  });

  await t.test('contrato em implantação fica fora do ciclo', async () => {
    const r = await api.post('/faturamento/ciclos', { competencia: ANTERIOR, simulacao: true }, tk.financeiro);
    assert.equal(r.dados.faturas, 0);
    assert.match(JSON.stringify(r.dados.pulados), /não ativado/);
  });

  await t.test('ativação registra fidelidade e não aceita data futura', async () => {
    assert.equal((await api.post(`/contratos/${contrato.id}/ativar`, { ativacao: dia(fat.somarMeses(ATUAL, 1), 10) }, tk.financeiro)).status, 422);
    const r = await api.post(`/contratos/${contrato.id}/ativar`, { ativacao: dia(ANTERIOR, 8) }, tk.financeiro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.situacao, 'ativo');
    assert.ok(r.dados.fidelidade_fim > dia(ANTERIOR, 8));
    assert.equal((await api.post(`/contratos/${contrato.id}/ativar`, {}, tk.financeiro)).status, 422, 'ativar duas vezes');
  });

  const diasMes = fat.diasNoMes(ANTERIOR);
  const proRata = Math.round((9990 * (diasMes - 8 + 1)) / diasMes);

  await t.test('simulação mostra a pró-rata e a instalação, sem gravar nada', async () => {
    const r = await api.post('/faturamento/ciclos', { competencia: ANTERIOR, simulacao: true }, tk.financeiro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.faturas, 1);
    const p = r.dados.previsao[0];
    assert.equal(p.valor_centavos, proRata + 15000);
    assert.deepEqual(p.itens.map((i) => i.origem).sort(), ['instalacao', 'pro_rata']);
    // Repetir a simulação não muda nada e não consome número de fatura.
    assert.equal((await api.post('/faturamento/ciclos', { competencia: ANTERIOR, simulacao: true }, tk.financeiro)).dados.faturas, 1);
    assert.equal((await api.get('/faturamento/faturas', tk.financeiro)).dados.total, 0);
    assert.equal((await api.get('/faturamento/ciclos', tk.financeiro)).dados.length, 0);
  });

  let fatura;
  await t.test('ciclo efetivado emite a fatura e a competência não roda duas vezes', async () => {
    const r = await api.post('/faturamento/ciclos', { competencia: ANTERIOR }, tk.financeiro);
    assert.equal(r.status, 201);
    assert.equal(r.dados.faturas, 1);
    const repetido = await api.post('/faturamento/ciclos', { competencia: ANTERIOR }, tk.financeiro);
    assert.equal(repetido.status, 409);
    const lista = await api.get('/faturamento/faturas', tk.financeiro);
    assert.equal(lista.dados.total, 1);
    fatura = lista.dados.itens[0];
    assert.equal(fatura.valor_centavos, proRata + 15000);
    assert.equal(fatura.vencimento, dia(ANTERIOR, 20));
    assert.equal(fatura.situacao, 'aberta');
  });

  await t.test('competência seguinte cobra o mês cheio e não repete a instalação', async () => {
    const r = await api.post('/faturamento/ciclos', { competencia: ATUAL }, tk.financeiro);
    assert.equal(r.status, 201);
    const nova = (await api.get(`/faturamento/faturas?competencia=${ATUAL}`, tk.financeiro)).dados.itens[0];
    assert.equal(nova.valor_centavos, 9990);
    const itens = (await api.get(`/faturamento/faturas/${nova.id}`, tk.financeiro)).dados.itens;
    assert.deepEqual(itens.map((i) => i.origem), ['mensalidade']);
  });

  await t.test('itens fixos entram pela vigência; desconto é guardado negativo', async () => {
    const sva = await criar(`/contratos/${contrato.id}/itens`, { descricao: 'Streaming', tipo: 'sva', valor: '19,90', inicio: ATUAL });
    const desconto = await criar(`/contratos/${contrato.id}/itens`, { descricao: 'Desconto fidelidade', tipo: 'desconto', valor: '10,00', inicio: ATUAL });
    assert.equal(sva.valor_centavos, 1990);
    assert.equal(desconto.valor_centavos, -1000);
    const prox = fat.somarMeses(ATUAL, 1);
    const r = await api.post('/faturamento/ciclos', { competencia: prox, simulacao: true }, tk.financeiro);
    assert.equal(r.dados.previsao[0].valor_centavos, 9990 + 1990 - 1000);
    // Item encerrado guarda a competência final em vez de desaparecer.
    const fim = await api.post(`/contratos/${contrato.id}/itens/${sva.id}/encerrar`, { fim: ATUAL }, tk.financeiro);
    assert.equal(fim.status, 200);
    assert.equal(fim.dados.fim, ATUAL);
    assert.equal((await api.post('/faturamento/ciclos', { competencia: prox, simulacao: true }, tk.financeiro)).dados.previsao[0].valor_centavos, 9990 - 1000);
  });

  await t.test('encargos: multa única e juros pro rata die sobre a fatura vencida', async () => {
    const x = (await api.get(`/faturamento/faturas/${fatura.id}`, tk.financeiro)).dados;
    const esperadoMulta = Math.round(x.valor_centavos * 0.02);
    assert.ok(x.encargos.dias_atraso > 0, 'a fatura do mês anterior já venceu');
    assert.equal(x.encargos.multa_centavos, esperadoMulta);
    assert.equal(x.encargos.juros_centavos, Math.round((Math.round(x.valor_centavos * 0.01) * x.encargos.dias_atraso) / 30));
    assert.equal(x.encargos.total_devido_centavos, x.encargos.saldo_centavos + x.encargos.multa_centavos + x.encargos.juros_centavos);
  });

  let pagamentoParcial;
  await t.test('baixa parcial, excesso recusado e baixa que quita o saldo', async () => {
    const parcial = await api.post(`/faturamento/faturas/${fatura.id}/pagamentos`, { valor: '100,00', forma: 'pix' }, tk.financeiro);
    assert.equal(parcial.status, 201);
    assert.equal(parcial.dados.fatura.situacao, 'parcial');
    assert.equal(parcial.dados.fatura.pago_centavos, 10000);
    assert.match(parcial.dados.aviso, /restam/);
    pagamentoParcial = parcial.dados.pagamento_id;
    const excesso = await api.post(`/faturamento/faturas/${fatura.id}/pagamentos`, { valor: '9.999,00', forma: 'pix' }, tk.financeiro);
    assert.equal(excesso.status, 422);
    assert.match(excesso.dados.erro, /saldo/);
    const quita = await api.post(`/faturamento/faturas/${fatura.id}/pagamentos`, { forma: 'pix' }, tk.financeiro);
    assert.equal(quita.dados.fatura.situacao, 'paga');
    assert.equal(quita.dados.fatura.pago_centavos, fatura.valor_centavos);
    assert.ok(quita.dados.fatura.pago_em);
    assert.equal((await api.post(`/faturamento/faturas/${fatura.id}/pagamentos`, { valor: '1,00', forma: 'pix' }, tk.financeiro)).status, 422, 'fatura quitada não recebe baixa');
  });

  await t.test('estorno mantém o pagamento no histórico e volta a situação', async () => {
    assert.equal((await api.post(`/faturamento/pagamentos/${pagamentoParcial}/estornar`, { motivo: 'teste' }, tk.financeiro)).status, 403, 'financeiro não estorna');
    assert.equal((await api.post(`/faturamento/pagamentos/${pagamentoParcial}/estornar`, {}, admin)).status, 422, 'estorno exige motivo');
    const r = await api.post(`/faturamento/pagamentos/${pagamentoParcial}/estornar`, { motivo: 'Baixa em duplicidade' }, admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.situacao, 'parcial');
    const detalhe = (await api.get(`/faturamento/faturas/${fatura.id}`, tk.financeiro)).dados;
    assert.equal(detalhe.pagamentos.length, 2, 'o pagamento estornado continua no histórico');
    assert.ok(detalhe.pagamentos.some((p) => p.estornado_em && p.motivo_estorno === 'Baixa em duplicidade'));
    assert.equal((await api.post(`/faturamento/pagamentos/${pagamentoParcial}/estornar`, { motivo: 'de novo' }, admin)).status, 422, 'não estorna duas vezes');
  });

  await t.test('cancelar fatura exige estorno antes e libera a competência', async () => {
    assert.equal((await api.post(`/faturamento/faturas/${fatura.id}/cancelar`, { motivo: 'Emitida errada' }, admin)).status, 422, 'tem baixa em vigor');
    const emVigor = (await api.get(`/faturamento/faturas/${fatura.id}`, tk.financeiro)).dados.pagamentos.find((p) => !p.estornado_em);
    await api.post(`/faturamento/pagamentos/${emVigor.id}/estornar`, { motivo: 'Correção da emissão' }, admin);
    const r = await api.post(`/faturamento/faturas/${fatura.id}/cancelar`, { motivo: 'Emitida com valor errado' }, admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.situacao, 'cancelada');
    assert.match(r.dados.aviso, new RegExp(`${ANTERIOR.slice(5, 7)}/${ANTERIOR.slice(0, 4)}`), 'a mensagem traz a competência no formato brasileiro');
    // Com a fatura cancelada, a competência pode ser refeita para aquele contrato.
    const itens = fat.itensDoCiclo(api.db, api.db.prepare('SELECT * FROM organizacoes WHERE id = 1').get(),
      api.db.prepare('SELECT * FROM contratos WHERE id = ?').get(contrato.id), ANTERIOR);
    assert.equal(itens.motivo, null, 'a competência voltou a ficar disponível');
  });

  await t.test('cobrança avulsa exige itens com valor', async () => {
    assert.equal((await api.post('/faturamento/faturas', { assinante_id: assinante.id, vencimento: HOJE, itens: [] }, tk.financeiro)).status, 422);
    const r = await api.post('/faturamento/faturas', { assinante_id: assinante.id, vencimento: HOJE,
      itens: [{ descricao: 'Visita técnica', valor: '80,00' }, { descricao: 'Conector', valor: '12,50' }] }, tk.financeiro);
    assert.equal(r.status, 201);
    assert.equal(r.dados.valor_centavos, 9250);
    assert.equal(r.dados.competencia, null, 'avulsa não pertence a competência');
  });

  await t.test('permissões e isolamento entre organizações', async () => {
    assert.equal((await api.post('/planos', { nome: 'X', tipo: 'internet', download_mbps: 10, mensalidade: '1,00' }, tk.gestor)).status, 403);
    assert.equal((await api.post('/faturamento/ciclos', { competencia: ATUAL }, tk.gestor)).status, 403);
    assert.equal((await api.get('/faturamento/faturas', tk.gestor)).status, 200, 'gestor consulta');
    assert.equal((await api.get('/assinantes', tk.tecnico)).status, 403, 'técnico não acessa a base de assinantes');
    assert.equal((await api.get('/faturamento/resumo', tk.tecnico)).status, 403);
    const outro = await api.outraOrganizacao();
    assert.equal((await api.get(`/assinantes/${assinante.id}`, outro)).status, 404);
    assert.equal((await api.get(`/contratos/${contrato.id}`, outro)).status, 404);
    assert.equal((await api.get('/faturamento/faturas', outro)).dados.total, 0);
    assert.equal((await api.get('/planos', outro)).dados.length, 0);
    // O mesmo CPF pode existir em outra organização.
    assert.equal((await api.post('/assinantes', { tipo: 'pf', nome: 'Maria Souza', documento: '39053344705' }, outro)).status, 201);
  });
});

test('faturamento: pró-rata adiada quando o vencimento do mês de entrada já passou', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const admin = await api.login();
  const tk = await equipeFinanceira(api, admin);

  const plano = (await api.post('/planos', { nome: 'Fibra 300', tipo: 'internet', download_mbps: 300, mensalidade: '89,90' }, tk.financeiro)).dados;
  const assinante = (await api.post('/assinantes', { tipo: 'pf', nome: 'João Lima', documento: '111.444.777-35' }, tk.financeiro)).dados;
  // Vencimento no dia 5 e entrada no dia 25: cobrar a pró-rata nesta competência nasceria vencida.
  const contrato = (await api.post('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 5 }, tk.financeiro)).dados;
  await api.post(`/contratos/${contrato.id}/ativar`, { ativacao: dia(RETRASADA, 25) }, tk.financeiro);

  await t.test('o mês de entrada não gera fatura', async () => {
    const r = await api.post('/faturamento/ciclos', { competencia: RETRASADA }, tk.financeiro);
    assert.equal(r.status, 201);
    assert.equal(r.dados.faturas, 0);
    assert.match(JSON.stringify(r.dados.pulados), /Nada a cobrar/);
  });

  await t.test('a competência seguinte cobra o mês cheio mais a pró-rata adiada', async () => {
    const r = await api.post('/faturamento/ciclos', { competencia: ANTERIOR }, tk.financeiro);
    assert.equal(r.dados.faturas, 1);
    const f = (await api.get(`/faturamento/faturas?competencia=${ANTERIOR}`, tk.financeiro)).dados.itens[0];
    const diasRetrasada = fat.diasNoMes(RETRASADA);
    const adiada = Math.round((8990 * (diasRetrasada - 25 + 1)) / diasRetrasada);
    assert.equal(f.valor_centavos, 8990 + adiada);
    const itens = (await api.get(`/faturamento/faturas/${f.id}`, tk.financeiro)).dados.itens;
    assert.deepEqual(itens.map((i) => i.origem).sort(), ['mensalidade', 'pro_rata']);
  });

  await t.test('a pró-rata adiada não é cobrada duas vezes', async () => {
    const r = await api.post('/faturamento/ciclos', { competencia: ATUAL, simulacao: true }, tk.financeiro);
    assert.deepEqual(r.dados.previsao[0].itens.map((i) => i.origem), ['mensalidade']);
  });
});

test('faturamento: suspensão não fatura, cancelamento cobra os dias usados', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const admin = await api.login();
  const tk = await equipeFinanceira(api, admin);
  const plano = (await api.post('/planos', { nome: 'Rádio 50', tipo: 'internet', tecnologia: 'radio', download_mbps: 50, mensalidade: '70,00' }, tk.financeiro)).dados;
  const assinante = (await api.post('/assinantes', { tipo: 'pf', nome: 'Ana Dias', documento: '111.444.777-35' }, tk.financeiro)).dados;
  const contrato = (await api.post('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 10 }, tk.financeiro)).dados;
  await api.post(`/contratos/${contrato.id}/ativar`, { ativacao: dia(RETRASADA, 1) }, tk.financeiro);

  await t.test('suspensão a pedido exige motivo e tira o contrato do faturamento', async () => {
    assert.equal((await api.post(`/contratos/${contrato.id}/suspender`, {}, tk.financeiro)).status, 422);
    const r = await api.post(`/contratos/${contrato.id}/suspender`, { motivo: 'Viagem de três meses' }, tk.financeiro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.situacao, 'suspenso');
    const sim = await api.post('/faturamento/ciclos', { competencia: ANTERIOR, simulacao: true }, tk.financeiro);
    assert.equal(sim.dados.faturas, 0);
    assert.match(JSON.stringify(sim.dados.pulados), /suspenso/);
  });

  await t.test('cancelamento cobra só os dias de serviço do mês e libera a porta', async () => {
    assert.equal((await api.post(`/contratos/${contrato.id}/reativar`, {}, tk.financeiro)).status, 200);
    const corte = dia(ANTERIOR, 10);
    const r = await api.post(`/contratos/${contrato.id}/cancelar`, { motivo: 'Mudança de cidade', data: corte }, tk.financeiro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.situacao, 'cancelado');
    const sim = await api.post('/faturamento/ciclos', { competencia: ANTERIOR, simulacao: true }, tk.financeiro);
    assert.equal(sim.dados.previsao[0].valor_centavos, Math.round((7000 * 10) / fat.diasNoMes(ANTERIOR)));
    assert.equal(sim.dados.previsao[0].itens[0].origem, 'pro_rata');
  });

  await t.test('contrato cancelado é final e o assinante fica inativo', async () => {
    assert.equal((await api.post(`/contratos/${contrato.id}/cancelar`, { motivo: 'de novo' }, tk.financeiro)).status, 422);
    assert.equal((await api.patch(`/contratos/${contrato.id}`, { observacoes: 'x', versao: 99 }, tk.financeiro)).status, 409);
    assert.equal((await api.get(`/assinantes/${assinante.id}`, tk.financeiro)).dados.situacao, 'inativo');
    const sim = await api.post('/faturamento/ciclos', { competencia: ATUAL, simulacao: true }, tk.financeiro);
    assert.equal(sim.dados.faturas, 0, 'mês inteiro depois do cancelamento não fatura');
  });
});

test('parâmetros da operação: o que o ciclo e a régua leem é editável e validado', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const admin = await api.login();
  const tk = await equipeFinanceira(api, admin);

  await t.test('os padrões vêm preenchidos e só o administrador altera', async () => {
    const o = (await api.get('/organizacao', admin)).dados;
    assert.equal(o.dia_vencimento_padrao, 10);
    assert.equal(o.carencia_bloqueio_dias, 5);
    assert.equal(o.multa_atraso_pct_centesimos, 200, '2,00%');
    assert.equal(o.juros_mes_pct_centesimos, 100, '1,00% ao mês');
    assert.equal(o.pro_rata, 1);
    assert.equal((await api.patch('/organizacao', { carencia_bloqueio_dias: 10 }, tk.financeiro)).status, 403);
  });

  await t.test('percentuais aceitam casas decimais e recusam valores fora da faixa', async () => {
    assert.equal((await api.patch('/organizacao', { multa_atraso_pct: 50 }, admin)).status, 422);
    assert.equal((await api.patch('/organizacao', { dia_vencimento_padrao: 31 }, admin)).status, 422);
    const r = await api.patch('/organizacao', { multa_atraso_pct: '2,5', juros_mes_pct: '0,33', carencia_bloqueio_dias: 3, pro_rata: false, confianca_dias: 0 }, admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.multa_atraso_pct_centesimos, 250);
    assert.equal(r.dados.juros_mes_pct_centesimos, 33);
    assert.equal(r.dados.pro_rata, 0);
  });

  await t.test('os novos parâmetros valem na execução seguinte', async () => {
    const plano = (await api.post('/planos', { nome: 'Fibra', tipo: 'internet', download_mbps: 100, mensalidade: '100,00' }, tk.financeiro)).dados;
    const assinante = (await api.post('/assinantes', { tipo: 'pf', nome: 'Teste Parâmetros', documento: '111.444.777-35' }, tk.financeiro)).dados;
    const contrato = (await api.post('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 20 }, tk.financeiro)).dados;
    await api.post(`/contratos/${contrato.id}/ativar`, { ativacao: dia(ANTERIOR, 8) }, tk.financeiro);
    // Pró-rata desligada: o mês de entrada passa a ser cobrado inteiro.
    await api.post('/faturamento/ciclos', { competencia: ANTERIOR }, tk.financeiro);
    const f = (await api.get(`/faturamento/faturas?competencia=${ANTERIOR}`, tk.financeiro)).dados.itens[0];
    assert.equal(f.valor_centavos, 10000, 'mês cheio, sem pró-rata');
    assert.equal(f.encargos.multa_centavos, Math.round(10000 * 0.025), 'multa de 2,5%');
    // Confiança desligada.
    assert.equal((await api.post(`/cobranca/contratos/${contrato.id}/confianca`, { dias: 2 }, tk.financeiro)).status, 422);
  });
});
