'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const fat = require('../server/lib/faturamento');
const cob = require('../server/lib/cobranca');
const { dataLocal, somarDias } = require('../server/lib/datas');

const HOJE = dataLocal('America/Sao_Paulo');
const ATUAL = fat.competenciaDe(HOJE);
const ANTERIOR = fat.somarMeses(ATUAL, -1);
const RETRASADA = fat.somarMeses(ATUAL, -2);
const dia = (competencia, d) => `${competencia}-${String(d).padStart(2, '0')}`;
const ORG = 1;

/*
 * A régua e a confiança dependem do dia. Pela API, a execução só aceita data até hoje e a confiança sempre começa
 * agora — então o que precisa de data à frente (expirar a confiança) é exercitado chamando a rotina direto na lib,
 * que é exatamente o que o agendador faz todo dia.
 */
async function cenario(api) {
  const admin = await api.login();
  const tk = { admin };
  for (const perfil of ['financeiro', 'gestor']) {
    await api.post('/organizacao/usuarios', { nome: `Usuário ${perfil}`, email: `${perfil}.cob@teste.local`, senha: 'senha-teste-123', perfil }, admin);
    tk[perfil] = await api.login(`${perfil}.cob@teste.local`, 'senha-teste-123');
  }
  const plano = (await api.post('/planos', { nome: 'Fibra 300', tipo: 'internet', download_mbps: 300, mensalidade: '89,90' }, tk.financeiro)).dados;
  const assinante = (await api.post('/assinantes', { tipo: 'pf', nome: 'João Lima', documento: '111.444.777-35', telefone: '13988887777' }, tk.financeiro)).dados;
  const contrato = (await api.post('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 5 }, tk.financeiro)).dados;
  await api.post(`/contratos/${contrato.id}/ativar`, { ativacao: dia(RETRASADA, 1) }, tk.financeiro);
  const ciclo = await api.post('/faturamento/ciclos', { competencia: ANTERIOR }, tk.financeiro);
  assert.equal(ciclo.status, 201, JSON.stringify(ciclo.dados));
  const fatura = (await api.get(`/faturamento/faturas?competencia=${ANTERIOR}`, tk.financeiro)).dados.itens[0];
  return { tk, plano, assinante, contrato, fatura };
}

const situacao = async (api, tk, id) => (await api.get(`/contratos/${id}`, tk.financeiro)).dados.situacao;

test('cobrança: régua respeita carência, registra quem cortou e não repete', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const { tk, contrato, fatura } = await cenario(api);
  assert.equal(fatura.vencimento, dia(ANTERIOR, 5));

  let regraBloqueio;
  await t.test('regras: bloquear antes do vencimento é recusado e a carência é avisada', async () => {
    assert.equal((await api.post('/cobranca/regras', { nome: 'Corte antecipado', dias: -5, acao: 'bloquear' }, tk.financeiro)).status, 422);
    const aviso = await api.post('/cobranca/regras', { nome: 'Aviso de vencimento', dias: -3, acao: 'avisar', canal: 'whatsapp' }, tk.financeiro);
    assert.equal(aviso.status, 201);
    regraBloqueio = await api.post('/cobranca/regras', { nome: 'Corte por atraso', dias: 3, acao: 'bloquear' }, tk.financeiro);
    assert.equal(regraBloqueio.status, 201);
    assert.match(regraBloqueio.dados.aviso, /carência da operação é de 5/);
    assert.equal((await api.post('/cobranca/regras', { nome: 'Indicar cancelamento', dias: 45, acao: 'indicar_cancelamento' }, tk.financeiro)).status, 201);
  });

  await t.test('antes do vencimento a régua só avisa, e o aviso fica pendente de envio', async () => {
    const r = cob.rotinaDiaria(api.db, ORG, dia(ANTERIOR, 2));
    assert.equal(r.regua.avisos, 1);
    assert.equal(r.regua.bloqueios, 0);
    const pendentes = (await api.get('/cobranca/eventos?pendentes=1', tk.financeiro)).dados;
    assert.equal(pendentes.total, 1);
    assert.equal(pendentes.itens[0].canal, 'whatsapp');
    assert.equal(pendentes.itens[0].resultado, 'pendente_envio');
    assert.equal(pendentes.itens[0].assinante_nome, 'João Lima');
  });

  await t.test('rodar de novo não repete a mesma regra na mesma fatura', async () => {
    const r = cob.rotinaDiaria(api.db, ORG, dia(ANTERIOR, 3));
    assert.equal(r.regua.avisos, 0);
    assert.equal(r.regua.eventos.length, 0);
  });

  await t.test('o aviso é marcado como despachado por quem enviou', async () => {
    const ev = (await api.get('/cobranca/eventos?pendentes=1', tk.financeiro)).dados.itens[0];
    assert.equal((await api.post(`/cobranca/eventos/${ev.id}/enviado`, {}, tk.gestor)).status, 403);
    const r = await api.post(`/cobranca/eventos/${ev.id}/enviado`, {}, tk.financeiro);
    assert.equal(r.status, 200);
    assert.ok(r.dados.enviado_em);
    assert.equal((await api.post(`/cobranca/eventos/${ev.id}/enviado`, {}, tk.financeiro)).status, 422, 'não marca duas vezes');
    assert.equal((await api.get('/cobranca/eventos?pendentes=1', tk.financeiro)).dados.total, 0);
  });

  await t.test('a carência segura o corte, mesmo com a regra mandando antes', async () => {
    const r = cob.rotinaDiaria(api.db, ORG, dia(ANTERIOR, 8));
    assert.equal(r.regua.bloqueios, 0, '3 dias de atraso, carência de 5');
    assert.equal(await situacao(api, tk, contrato.id), 'ativo');
  });

  await t.test('terminada a carência, a régua bloqueia e o bloqueio aponta a regra e a fatura', async () => {
    const r = cob.rotinaDiaria(api.db, ORG, dia(ANTERIOR, 10));
    assert.equal(r.regua.bloqueios, 1);
    const c = (await api.get(`/contratos/${contrato.id}`, tk.financeiro)).dados;
    assert.equal(c.situacao, 'bloqueado');
    assert.equal(c.bloqueio.origem, 'regua');
    assert.equal(c.bloqueio.regra_id, regraBloqueio.dados.id);
    assert.equal(c.bloqueio.fatura_id, fatura.id);
    assert.equal(c.bloqueio.tipo, 'inadimplencia');
    assert.match(c.bloqueio.motivo, /Corte por atraso/);
    assert.ok(c.eventos.some((e) => e.evento === 'bloqueado' && e.origem === 'regua'));
  });

  await t.test('contrato bloqueado por inadimplência continua faturando', async () => {
    const r = await api.post('/faturamento/ciclos', { competencia: ATUAL }, tk.financeiro);
    assert.equal(r.status, 201);
    assert.equal(r.dados.faturas, 1);
  });

  await t.test('indicar cancelamento registra o caso e não cancela nada', async () => {
    cob.rotinaDiaria(api.db, ORG, somarDias(dia(ANTERIOR, 5), 46));
    const c = (await api.get(`/contratos/${contrato.id}`, tk.financeiro)).dados;
    assert.notEqual(c.situacao, 'cancelado');
    assert.ok(c.eventos.some((e) => e.evento === 'indicado_para_cancelamento' && e.origem === 'regua'));
    const ev = (await api.get('/cobranca/eventos?acao=indicar_cancelamento', tk.financeiro)).dados.itens[0];
    assert.match(ev.detalhe, /nenhum cancelamento foi feito/);
  });

  await t.test('inadimplência por faixa de atraso e taxa', async () => {
    const r = await api.get('/cobranca/inadimplencia', tk.financeiro);
    assert.equal(r.status, 200);
    assert.ok(r.dados.faturas >= 1);
    assert.equal(r.dados.devedores[0].nome, 'João Lima');
    assert.ok(r.dados.devedores[0].bloqueado);
    assert.ok(r.dados.devedores[0].devido_centavos > r.dados.devedores[0].saldo_centavos, 'o devido inclui multa e juros');
    assert.ok(r.dados.taxa_pct > 0);
    const soma = Object.values(r.dados.faixas).reduce((s, f) => s + f.faturas, 0);
    assert.equal(soma, r.dados.faturas);
  });

  await t.test('quitar tudo desbloqueia automaticamente, com registro do sistema', async () => {
    for (const f of (await api.get('/faturamento/faturas?situacao=aberta', tk.financeiro)).dados.itens) {
      const r = await api.post(`/faturamento/faturas/${f.id}/pagamentos`, { forma: 'pix' }, tk.financeiro);
      assert.equal(r.status, 201, JSON.stringify(r.dados));
    }
    const c = (await api.get(`/contratos/${contrato.id}`, tk.financeiro)).dados;
    assert.equal(c.situacao, 'ativo');
    assert.equal(c.bloqueio, null);
    assert.ok(c.eventos.some((e) => e.evento === 'desbloqueado' && e.origem === 'sistema'));
    assert.equal((await api.get('/cobranca/inadimplencia', tk.financeiro)).dados.faturas, 0);
  });

  await t.test('a execução da rotina fica registrada', async () => {
    const r = await api.get('/cobranca/execucoes', tk.financeiro);
    assert.ok(r.dados.length >= 4);
    assert.match(r.dados[0].resultado, /Régua:/);
  });
});

test('cobrança: desbloqueio de confiança, expiração e limite anual', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const { tk, contrato } = await cenario(api);
  await api.post('/cobranca/regras', { nome: 'Corte por atraso', dias: 5, acao: 'bloquear' }, tk.financeiro);
  const bloquearPelaRegua = () => cob.rotinaDiaria(api.db, ORG, HOJE);

  await t.test('confiança exige bloqueio por inadimplência em vigor', async () => {
    assert.equal((await api.post(`/cobranca/contratos/${contrato.id}/confianca`, { dias: 3 }, tk.financeiro)).status, 422);
    const r = bloquearPelaRegua();
    assert.equal(r.regua.bloqueios, 1);
    assert.equal(await situacao(api, tk, contrato.id), 'bloqueado');
  });

  await t.test('confiança devolve o serviço e trava novo bloqueio por inadimplência', async () => {
    assert.equal((await api.post(`/cobranca/contratos/${contrato.id}/confianca`, { dias: 90 }, tk.financeiro)).status, 422, 'acima do prazo da operação');
    const r = await api.post(`/cobranca/contratos/${contrato.id}/confianca`, { dias: 5, motivo: 'Cliente prometeu pagar sexta' }, tk.financeiro);
    assert.equal(r.status, 201);
    assert.equal(r.dados.ate, somarDias(HOJE, 5));
    assert.equal(r.dados.contrato.situacao, 'ativo');
    assert.match(r.dados.aviso, /bloqueia de novo/);
    // Nem a régua nem o operador bloqueiam por inadimplência enquanto a confiança vale.
    const regua = cob.aplicarRegua(api.db, ORG, HOJE);
    assert.ok(regua.eventos.every((e) => e.resultado !== 'executada' || e.acao !== 'bloquear'));
    assert.equal(await situacao(api, tk, contrato.id), 'ativo');
    const manual = await api.post(`/cobranca/contratos/${contrato.id}/bloquear`, { tipo: 'inadimplencia', motivo: 'tentativa' }, tk.financeiro);
    assert.equal(manual.status, 409);
    assert.match(manual.dados.erro, /confiança em vigor/);
  });

  await t.test('bloqueio técnico continua possível durante a confiança', async () => {
    const r = await api.post(`/cobranca/contratos/${contrato.id}/bloquear`, { tipo: 'tecnico', motivo: 'Rompimento no trecho da CTO' }, tk.financeiro);
    assert.equal(r.status, 201);
    assert.equal(r.dados.contrato.situacao, 'bloqueado');
    await api.post(`/cobranca/contratos/${contrato.id}/desbloquear`, { motivo: 'Trecho reparado' }, tk.financeiro);
    assert.equal(await situacao(api, tk, contrato.id), 'ativo');
  });

  await t.test('confiança vencida sem pagamento bloqueia de novo', async () => {
    const depois = somarDias(HOJE, 6);
    const r = cob.expirarConfiancas(api.db, ORG, depois);
    assert.equal(r.expiradas, 1);
    assert.equal(r.bloqueios, 1);
    const c = (await api.get(`/contratos/${contrato.id}`, tk.financeiro)).dados;
    assert.equal(c.situacao, 'bloqueado');
    assert.equal(c.bloqueio.origem, 'sistema');
    assert.match(c.bloqueio.motivo, /desbloqueio de confiança terminou/);
    const confiancas = (await api.get('/cobranca/confiancas', tk.financeiro)).dados.itens;
    assert.equal(confiancas[0].encerramento, 'expirada');
  });

  await t.test('o limite anual por contrato é respeitado', async () => {
    // A primeira já foi usada; a segunda e a terceira completam o limite de 3 da organização.
    for (const n of [2, 3]) {
      const r = await api.post(`/cobranca/contratos/${contrato.id}/confianca`, { dias: 2 }, tk.financeiro);
      assert.equal(r.status, 201, `confiança ${n}: ${JSON.stringify(r.dados)}`);
      cob.expirarConfiancas(api.db, ORG, somarDias(HOJE, 3 + n));
    }
    const quarta = await api.post(`/cobranca/contratos/${contrato.id}/confianca`, { dias: 2 }, tk.financeiro);
    assert.equal(quarta.status, 409);
    assert.match(quarta.dados.erro, /limite de 3/);
    assert.equal((await api.get(`/contratos/${contrato.id}`, tk.financeiro)).dados.confiancas_no_ano, 3);
  });

  await t.test('pagar dentro do prazo encerra a confiança como paga', async () => {
    const novo = (await api.post('/assinantes', { tipo: 'pf', nome: 'Rita Alves', documento: '390.533.447-05' }, tk.financeiro)).dados;
    const plano = (await api.get('/planos', tk.financeiro)).dados[0];
    const ct = (await api.post('/contratos', { assinante_id: novo.id, plano_id: plano.id, dia_vencimento: 5 }, tk.financeiro)).dados;
    await api.post(`/contratos/${ct.id}/ativar`, { ativacao: dia(RETRASADA, 1) }, tk.financeiro);
    await api.post('/faturamento/ciclos', { competencia: ATUAL }, tk.financeiro);
    cob.rotinaDiaria(api.db, ORG, HOJE);
    assert.equal(await situacao(api, tk, ct.id), 'bloqueado');
    await api.post(`/cobranca/contratos/${ct.id}/confianca`, { dias: 4 }, tk.financeiro);
    for (const f of (await api.get(`/faturamento/faturas?assinante_id=${novo.id}&situacao=aberta`, tk.financeiro)).dados.itens) {
      await api.post(`/faturamento/faturas/${f.id}/pagamentos`, { forma: 'pix' }, tk.financeiro);
    }
    const encerrada = (await api.get('/cobranca/confiancas', tk.financeiro)).dados.itens.find((x) => x.contrato_numero === ct.numero);
    assert.equal(encerrada.encerramento, 'pago');
    // Expirar depois não bloqueia quem já pagou.
    const r = cob.expirarConfiancas(api.db, ORG, somarDias(HOJE, 10));
    assert.equal(r.bloqueios, 0);
    assert.equal(await situacao(api, tk, ct.id), 'ativo');
  });
});

test('cobrança: regra versionada, desbloqueio manual e permissões', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const { tk, contrato } = await cenario(api);

  await t.test('alterar a regra cria a versão seguinte e aposenta a anterior', async () => {
    const original = (await api.post('/cobranca/regras', { nome: 'Corte', dias: 10, acao: 'bloquear' }, tk.financeiro)).dados;
    const nova = await api.patch(`/cobranca/regras/${original.id}`, { dias: 7 }, tk.financeiro);
    assert.equal(nova.status, 200);
    assert.equal(nova.dados.versao, 2);
    assert.equal(nova.dados.dias, 7);
    assert.equal(nova.dados.substituiu, original.id);
    const regras = (await api.get('/cobranca/regras', tk.financeiro)).dados.regras;
    const velha = regras.find((x) => x.id === original.id);
    assert.equal(velha.ativa, 0);
    assert.equal(velha.substituida_por, nova.dados.id);
    assert.equal((await api.patch(`/cobranca/regras/${original.id}`, { dias: 9 }, tk.financeiro)).status, 422, 'regra aposentada não é editada');
  });

  await t.test('desbloqueio manual com fatura vencida avisa que a régua pode cortar de novo', async () => {
    cob.rotinaDiaria(api.db, ORG, HOJE);
    assert.equal(await situacao(api, tk, contrato.id), 'bloqueado');
    assert.equal((await api.post(`/cobranca/contratos/${contrato.id}/desbloquear`, {}, tk.financeiro)).status, 422, 'exige motivo');
    const r = await api.post(`/cobranca/contratos/${contrato.id}/desbloquear`, { motivo: 'Acordo verbal com o cliente' }, tk.financeiro);
    assert.equal(r.status, 200);
    assert.match(r.dados.aviso, /pode bloquear de novo/);
    assert.equal((await api.post(`/cobranca/contratos/${contrato.id}/desbloquear`, { motivo: 'de novo' }, tk.financeiro)).status, 422);
  });

  await t.test('permissões e isolamento', async () => {
    assert.equal((await api.post('/cobranca/regras', { nome: 'X', dias: 1, acao: 'avisar' }, tk.gestor)).status, 403);
    assert.equal((await api.post('/cobranca/executar', {}, tk.gestor)).status, 403);
    assert.equal((await api.post(`/cobranca/contratos/${contrato.id}/bloquear`, { tipo: 'tecnico', motivo: 'x' }, tk.gestor)).status, 403);
    assert.equal((await api.get('/cobranca/inadimplencia', tk.gestor)).status, 200, 'gestor acompanha');
    assert.equal((await api.post('/cobranca/executar', { data: somarDias(HOJE, 1) }, tk.financeiro)).status, 422, 'não roda com data no futuro');
    const outro = await api.outraOrganizacao();
    assert.equal((await api.get('/cobranca/regras', outro)).dados.regras.length, 0);
    assert.equal((await api.get('/cobranca/inadimplencia', outro)).dados.faturas, 0);
    assert.equal((await api.post(`/cobranca/contratos/${contrato.id}/bloquear`, { tipo: 'tecnico', motivo: 'x' }, outro)).status, 404);
  });
});
