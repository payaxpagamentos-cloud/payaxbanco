'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, PNG } = require('./helpers');

test('chamados técnicos e comissões', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const veic = (await api.post('/frota/veiculos', { placa: 'HBL1D09', modelo: 'Onix' }, tk.frota)).dados;
  // Regra de exemplo (valores comerciais são configurados pela organização).
  assert.equal((await api.post('/equipe/regras', { tipo_servico: 'reparo', nome: 'Reparo', valor: '35,00' }, tk.gestor)).status, 403);
  assert.equal((await api.post('/equipe/regras', { tipo_servico: 'reparo', nome: 'Reparo', valor: '35,00' }, tk.comissoes)).status, 201);

  const responder = async (c, tkn) => {
    const foto = (await api.post(`/anexos?recurso=chamado&recurso_id=${c.id}`, PNG, tkn, { 'X-Nome-Arquivo': 'foto.png' })).dados;
    for (const [chave, corpo] of [['potencia_antes', { valor: '-29,4' }], ['potencia_depois', { valor: -19.8 }], ['causa', { valor: 'Drop rompido' }], ['foto', { anexo_id: foto.id }]]) {
      const r = await api.put(`/chamados/${c.id}/checklist/${chave}`, corpo, tkn);
      assert.equal(r.status, 200, JSON.stringify(r.dados));
    }
    return (await api.get(`/chamados/${c.id}`, tkn)).dados;
  };
  const executar = async (titulo, extra = {}) => {
    let c = (await api.post('/chamados', { tipo: 'reparo', titulo, prioridade: 'alta', ...extra }, tk.gestor)).dados;
    c = (await api.post(`/chamados/${c.id}/atribuir`, { tecnico_id: tk.tecnico_tid, veiculo_id: veic.id, versao: c.versao, aceitar_conflito: true }, tk.gestor)).dados;
    c = (await api.post(`/chamados/${c.id}/iniciar-rota`, { versao: c.versao }, tk.tecnico)).dados;
    c = (await api.post(`/chamados/${c.id}/iniciar`, { versao: c.versao }, tk.tecnico)).dados;
    return c;
  };

  let os1;
  await t.test('fluxo completo: criar, atribuir, rota, execução, evidência, conclusão e validação', async () => {
    let c = await executar('Cliente sem sinal');
    assert.equal(c.status, 'em_execucao');
    assert.equal(c.checklist.itens.length, 4);
    // Checklist obrigatório incompleto: não conclui.
    const inc = await api.post(`/chamados/${c.id}/concluir`, { versao: c.versao }, tk.tecnico);
    assert.equal(inc.status, 422);
    assert.match(inc.dados.erro, /Checklist incompleto/);
    // Foto sem anexo não vale.
    assert.equal((await api.put(`/chamados/${c.id}/checklist/foto`, { anexo_id: 999 }, tk.tecnico)).status, 422);
    c = await responder(c, tk.tecnico);
    assert.deepEqual(c.pendencias, []);
    c = (await api.post(`/chamados/${c.id}/concluir`, { versao: c.versao, observacao: 'Drop trocado' }, tk.tecnico)).dados;
    assert.equal(c.status, 'em_validacao');
    assert.equal((await api.post(`/chamados/${c.id}/validar`, { decisao: 'aprovar', versao: c.versao }, tk.tecnico)).status, 403, 'técnico não valida');
    c = (await api.post(`/chamados/${c.id}/validar`, { decisao: 'aprovar', versao: c.versao }, tk.gestor)).dados;
    assert.equal(c.status, 'aprovado');
    assert.equal(c.comissoes_geradas.length, 1);
    assert.deepEqual(c.eventos.map((e) => e.acao), ['criado', 'atribuido', 'em_rota', 'em_execucao', 'concluido_tecnicamente', 'aprovado']);
    os1 = c;
  });

  await t.test('técnico não aprova a própria comissão, nem manipulando a chamada', async () => {
    const com = (await api.get('/equipe/comissoes', tk.comissoes)).dados.itens[0];
    assert.equal(com.valor_centavos, 3500);
    assert.equal(com.regra_versao, 1);
    assert.equal((await api.post(`/equipe/comissoes/${com.id}/aprovar`, {}, tk.tecnico)).status, 403);
    // Mesmo se o técnico tivesse o perfil de conferência: a regra de "não a própria" vale no servidor.
    api.db.prepare("UPDATE usuarios SET perfil = 'comissoes' WHERE id = ?").run(tk.tecnico_id);
    const r = await api.post(`/equipe/comissoes/${com.id}/aprovar`, {}, tk.tecnico);
    assert.equal(r.status, 403);
    assert.match(r.dados.erro, /própria comissão/);
    api.db.prepare("UPDATE usuarios SET perfil = 'tecnico' WHERE id = ?").run(tk.tecnico_id);
    assert.equal((await api.get('/equipe/comissoes', tk.tecnico)).dados.total, 1, 'técnico vê só as próprias');
  });

  await t.test('aprovar duas vezes ou reprocessar a aprovação não duplica', async () => {
    const com = (await api.get('/equipe/comissoes', tk.comissoes)).dados.itens[0];
    assert.equal((await api.post(`/equipe/comissoes/${com.id}/aprovar`, {}, tk.comissoes)).dados.status, 'aprovada');
    assert.equal((await api.post(`/equipe/comissoes/${com.id}/aprovar`, {}, tk.comissoes)).dados.ja_aprovada, true);
    assert.equal((await api.post(`/chamados/${os1.id}/validar`, { decisao: 'aprovar', versao: os1.versao }, tk.gestor)).status, 422, 'já aprovado');
    const { gerarComissoes } = require('../server/lib/comissoes');
    const chamado = api.db.prepare('SELECT * FROM chamados WHERE id = ?').get(os1.id);
    assert.deepEqual(gerarComissoes(api.db, { usuario: { id: 1 } }, chamado).geradas, []);
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM comissoes WHERE chamado_id = ?').get(os1.id).n, 1);
  });

  await t.test('nova versão da regra não altera comissões anteriores', async () => {
    await api.post('/equipe/regras', { tipo_servico: 'reparo', valor: '40,00' }, tk.comissoes);
    let c = await executar('Segundo reparo');
    c = await responder(c, tk.tecnico);
    c = (await api.post(`/chamados/${c.id}/concluir`, { versao: c.versao }, tk.tecnico)).dados;
    c = (await api.post(`/chamados/${c.id}/validar`, { decisao: 'aprovar', versao: c.versao }, tk.gestor)).dados;
    const lista = (await api.get('/equipe/comissoes', tk.comissoes)).dados.itens;
    const nova = lista.find((x) => x.chamado_id === c.id);
    const antiga = lista.find((x) => x.chamado_id === os1.id);
    assert.deepEqual([nova.valor_centavos, nova.regra_versao], [4000, 2]);
    assert.deepEqual([antiga.valor_centavos, antiga.regra_versao], [3500, 1]);
  });

  await t.test('pagamento registrado com comprovante não executa transferência', async () => {
    const com = (await api.get('/equipe/comissoes?status=aprovada', tk.comissoes)).dados.itens;
    assert.equal(com.length, 1);
    const comprovante = (await api.post('/anexos?recurso=comissao_pagamento', PNG, tk.comissoes)).dados;
    const pend = (await api.get('/equipe/comissoes?status=aguardando_aprovacao', tk.comissoes)).dados.itens[0];
    assert.equal((await api.post('/equipe/pagamentos', { comissao_ids: [pend.id], data_pagamento: '2026-11-05', referencia: 'PIX 1' }, tk.comissoes)).status, 409,
      'comissão não aprovada não entra');
    const r = await api.post('/equipe/pagamentos', { comissao_ids: [com[0].id], data_pagamento: '2026-11-05', referencia: 'Comprovante 001', comprovante_id: comprovante.id }, tk.comissoes);
    assert.equal(r.status, 201);
    assert.equal(r.dados.transferencia_bancaria, false);
    assert.equal(r.dados.valor_centavos, 3500);
    assert.equal((await api.post('/equipe/pagamentos', { comissao_ids: [com[0].id], data_pagamento: '2026-11-05', referencia: 'de novo' }, tk.comissoes)).status, 409);
  });

  await t.test('reabrir serviço pago exige ajuste rastreável, sem apagar o histórico', async () => {
    os1 = (await api.get(`/chamados/${os1.id}`, tk.gestor)).dados;
    const r = await api.post(`/chamados/${os1.id}/reabrir`, { motivo: 'Cliente voltou sem sinal', versao: os1.versao }, tk.gestor);
    assert.equal(r.dados.status, 'retornado');
    assert.equal(r.dados.comissoes_pagas.length, 1);
    assert.match(r.dados.aviso, /ajuste/);
    const cid = r.dados.comissoes_pagas[0];
    assert.equal((await api.post(`/equipe/comissoes/${cid}/ajustes`, { valor: '-35,00', motivo: 'Estorno por retrabalho' }, tk.comissoes)).status, 201);
    const d = (await api.get(`/equipe/comissoes/${cid}`, tk.comissoes)).dados;
    assert.equal(d.valor_centavos, 3500, 'valor original preservado');
    assert.equal(d.saldo_centavos, 0);
    assert.ok(d.pagamento);
    assert.ok(r.dados.eventos.some((e) => e.acao === 'aprovado') && r.dados.eventos.some((e) => e.acao === 'reaberto'));
    assert.equal((await api.post(`/equipe/comissoes/${cid}/ajustes`, { valor: '-1,00', motivo: 'x' }, tk.comissoes)).status, 422, 'saldo não fica negativo');
  });

  await t.test('rateio da equipe sem ultrapassar o valor e devolução com motivo', async () => {
    await api.post('/equipe/regras', { tipo_servico: 'fusao', nome: 'Fusão', modo: 'por_unidade', valor: '3,33', campo_unidade: 'fibras_fundidas' }, tk.comissoes);
    let c = (await api.post('/chamados', { tipo: 'fusao', titulo: 'Fusão CEO' }, tk.gestor)).dados;
    const ruim = await api.post(`/chamados/${c.id}/atribuir`, { tecnico_id: tk.tecnico_tid, versao: c.versao, equipe: [{ tecnico_id: tk.tecnico_tid, percentual: 50 }, { tecnico_id: tk.tecnico2_tid, percentual: 40 }] }, tk.gestor);
    assert.equal(ruim.status, 422);
    c = (await api.post(`/chamados/${c.id}/atribuir`, { tecnico_id: tk.tecnico_tid, versao: c.versao, equipe: [{ tecnico_id: tk.tecnico_tid, percentual: 67 }, { tecnico_id: tk.tecnico2_tid, percentual: 33 }] }, tk.gestor)).dados;
    c = (await api.post(`/chamados/${c.id}/iniciar`, { versao: c.versao }, tk.tecnico)).dados;
    const foto = (await api.post(`/anexos?recurso=chamado&recurso_id=${c.id}`, PNG, tk.tecnico)).dados;
    await api.put(`/chamados/${c.id}/checklist/fibras_fundidas`, { valor: 12 }, tk.tecnico);
    await api.put(`/chamados/${c.id}/checklist/teste_otdr`, { valor: true }, tk.tecnico);
    await api.put(`/chamados/${c.id}/checklist/foto`, { anexo_id: foto.id }, tk.tecnico);
    c = (await api.get(`/chamados/${c.id}`, tk.tecnico)).dados;
    c = (await api.post(`/chamados/${c.id}/concluir`, { versao: c.versao }, tk.tecnico)).dados;
    assert.equal((await api.post(`/chamados/${c.id}/validar`, { decisao: 'retornar', versao: c.versao }, tk.gestor)).status, 422, 'devolução exige motivo');
    c = (await api.post(`/chamados/${c.id}/validar`, { decisao: 'retornar', motivo: 'Faltou foto da bandeja 2', versao: c.versao }, tk.gestor)).dados;
    assert.equal(c.status, 'retornado');
    assert.equal(c.retrabalho, 1);
    c = (await api.post(`/chamados/${c.id}/iniciar`, { versao: c.versao }, tk.tecnico)).dados;
    c = (await api.post(`/chamados/${c.id}/concluir`, { versao: c.versao }, tk.tecnico)).dados;
    c = (await api.post(`/chamados/${c.id}/validar`, { decisao: 'aprovar', versao: c.versao }, tk.gestor)).dados;
    const coms = api.db.prepare('SELECT tecnico_id, valor_centavos FROM comissoes WHERE chamado_id = ? ORDER BY valor_centavos DESC').all(c.id);
    assert.equal(coms.reduce((a, x) => a + x.valor_centavos, 0), 12 * 333);
    assert.deepEqual(coms.map((x) => x.valor_centavos), [2678, 1318]);
  });

  await t.test('técnico só vê e executa os próprios chamados', async () => {
    const c = (await api.post('/chamados', { tipo: 'vistoria', titulo: 'Vistoria CTO' }, tk.gestor)).dados;
    assert.equal((await api.get(`/chamados/${c.id}`, tk.tecnico)).status, 404);
    await api.post(`/chamados/${c.id}/atribuir`, { tecnico_id: tk.tecnico2_tid, versao: c.versao }, tk.gestor);
    assert.equal((await api.post(`/chamados/${c.id}/iniciar`, { versao: 2 }, tk.tecnico)).status, 404);
  });

  await t.test('conflito de agenda é sinalizado e pode ser aceito explicitamente', async () => {
    const dia = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    const a = (await api.post('/chamados', { tipo: 'instalacao', titulo: 'Instalação A', agendado_para: `${dia}T13:00:00Z` }, tk.gestor)).dados;
    const b = (await api.post('/chamados', { tipo: 'instalacao', titulo: 'Instalação B', agendado_para: `${dia}T15:00:00Z` }, tk.gestor)).dados;
    await api.post(`/chamados/${a.id}/atribuir`, { tecnico_id: tk.tecnico2_tid, veiculo_id: veic.id, versao: a.versao }, tk.gestor);
    const r = await api.post(`/chamados/${b.id}/atribuir`, { tecnico_id: tk.tecnico2_tid, veiculo_id: veic.id, versao: b.versao }, tk.gestor);
    assert.equal(r.status, 409);
    assert.equal(r.dados.detalhes.conflitos.length, 1);
    assert.equal((await api.post(`/chamados/${b.id}/atribuir`, { tecnico_id: tk.tecnico2_tid, veiculo_id: veic.id, versao: b.versao, aceitar_conflito: true }, tk.gestor)).status, 200);
  });

  await t.test('concluir OS de rompimento não resolve o incidente', async () => {
    const inc = (await api.post('/noc/incidentes', { titulo: 'Rompimento de fibra', severidade: 'critica' }, tk.noc)).dados;
    let c = await executar('Rompimento', { incidente_id: inc.id });
    c = await responder(c, tk.tecnico);
    c = (await api.post(`/chamados/${c.id}/concluir`, { versao: c.versao }, tk.tecnico)).dados;
    c = (await api.post(`/chamados/${c.id}/validar`, { decisao: 'aprovar', versao: c.versao }, tk.gestor)).dados;
    const i = (await api.get(`/noc/incidentes/${inc.id}`, tk.noc)).dados;
    assert.equal(i.status, 'aberto');
    assert.equal(i.chamados.length, 1);
    assert.equal((await api.post(`/noc/incidentes/${inc.id}/resolver`, {}, tk.noc)).status, 422, 'resolução exige evidência');
  });

  await t.test('checklist versionado: chamados antigos mantêm a versão', async () => {
    const r = await api.post('/chamados/checklists', { tipo_servico: 'vistoria', itens: [{ rotulo: 'Situação', tipo: 'texto', obrigatorio: true }] }, tk.gestor);
    assert.equal(r.status, 201);
    const novo = (await api.post('/chamados', { tipo: 'vistoria', titulo: 'Nova vistoria' }, tk.gestor)).dados;
    assert.equal(novo.checklist.modelo.versao, 2);
    assert.equal(novo.checklist.itens.length, 1);
  });
});
