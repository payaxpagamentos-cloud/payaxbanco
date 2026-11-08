'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

test('rede óptica: portas, ligações, percurso, fusões e capacidade', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const criar = async (b) => (await api.post('/rede/ativos', b, tk.noc)).dados;
  const pop = await criar({ tipo: 'pop', codigo: 'pop-pg-01', bairro: 'Centro', lat: -24.005, lng: -46.41 });
  const ceo = await criar({ tipo: 'ceo', codigo: 'CEO-OCN-003', capacidade: 48, bandejas: 2, lat: -24.01, lng: -46.42 });
  const cto = await criar({ tipo: 'cto', codigo: 'CTO-OCN-024', capacidade: 8, splitter: '1:8', bairro: 'Ocian', lat: -24.012, lng: -46.43 });

  await t.test('cadastro valida código único e coordenadas', async () => {
    assert.equal(pop.codigo, 'POP-PG-01');
    assert.equal((await api.post('/rede/ativos', { tipo: 'cto', codigo: 'cto-ocn-024', capacidade: 8 }, tk.noc)).status, 409);
    assert.equal((await api.post('/rede/ativos', { tipo: 'cto', codigo: 'CTO-X', capacidade: 8, lat: 95, lng: 0 }, tk.noc)).status, 422);
    assert.equal((await api.post('/rede/ativos', { tipo: 'cto', codigo: 'CTO-Y', capacidade: 8, lat: -24 }, tk.noc)).status, 422);
    assert.equal(cto.portas.total, 8);
    assert.equal((await api.post('/rede/ativos', { tipo: 'cto', codigo: 'CTO-Z', capacidade: 8 }, tk.tecnico)).status, 403);
  });

  let portas;
  await t.test('reserva concorrente da mesma porta: uma vence, a outra recebe conflito', async () => {
    portas = (await api.get(`/rede/ativos/${cto.id}`, tk.noc)).dados.lista_portas;
    const p1 = portas[0];
    const [a, b] = await Promise.all([
      api.post(`/rede/portas/${p1.id}/reservar`, { cliente_ref: 'CLI-1', versao: p1.versao }, tk.noc),
      api.post(`/rede/portas/${p1.id}/reservar`, { cliente_ref: 'CLI-2', versao: p1.versao }, tk.tecnico),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const ocupar = await api.post(`/rede/portas/${p1.id}/ocupar`, { cliente_ref: 'CLI-1', onu_ref: 'ONU-01' }, tk.tecnico);
    assert.equal(ocupar.dados.situacao, 'ocupada');
    assert.equal((await api.post(`/rede/portas/${p1.id}/ocupar`, { cliente_ref: 'CLI-9' }, tk.tecnico)).status, 409, 'duas ligações ativas na mesma porta');
    await api.post(`/rede/portas/${portas[1].id}/defeito`, { motivo: 'Conector quebrado' }, tk.noc);
    assert.equal((await api.post(`/rede/portas/${portas[1].id}/reservar`, {}, tk.noc)).status, 409, 'porta com defeito não fica disponível');
    const hist = (await api.get(`/rede/portas/${p1.id}/historico`, tk.noc)).dados;
    assert.deepEqual(hist.map((h) => h.situacao), ['ocupada', 'reservada']);
  });

  await t.test('CTO → CEO → POP: percurso auditável e trecho desconhecido explícito', async () => {
    let p = (await api.get(`/rede/ativos/${cto.id}/percurso`, tk.noc)).dados;
    assert.equal(p.completo, false);
    assert.match(p.trecho_desconhecido, /CTO-OCN-024/);
    const cabo = (await api.post('/rede/cabos', { codigo: 'CB-12', fibras: 12 }, tk.noc)).dados;
    assert.equal((await api.post('/rede/enlaces', { origem_id: pop.id, destino_id: cto.id }, tk.noc)).status, 422, 'POP não é alimentado por CTO');
    assert.equal((await api.post('/rede/enlaces', { origem_id: cto.id, destino_id: ceo.id, cabo_id: cabo.id, fibras: '3' }, tk.noc)).status, 201);
    assert.equal((await api.post('/rede/enlaces', { origem_id: ceo.id, destino_id: pop.id }, tk.noc)).status, 201);
    assert.equal((await api.post('/rede/enlaces', { origem_id: cto.id, destino_id: pop.id }, tk.noc)).status, 409, 'um alimentador ativo por vez');
    p = (await api.get(`/rede/ativos/${cto.id}/percurso`, tk.noc)).dados;
    assert.equal(p.completo, true);
    assert.deepEqual(p.passos.map((x) => x.codigo), ['CTO-OCN-024', 'CEO-OCN-003', 'POP-PG-01']);
    const det = (await api.get(`/rede/ativos/${pop.id}`, tk.tecnico)).dados;
    assert.equal(det.impacto.portas_ocupadas, 1);
    assert.equal(det.impacto.clientes_unicos, 1);
  });

  await t.test('fusões: extremidade ativa não se repete', async () => {
    const cabos = (await api.get('/rede/cabos', tk.noc)).dados;
    const cb48 = (await api.post('/rede/cabos', { codigo: 'CB-48', fibras: 48 }, tk.noc)).dados;
    const det = (await api.get(`/rede/ativos/${ceo.id}`, tk.noc)).dados;
    const bandeja = det.bandejas[0].id;
    const f = await api.post(`/rede/ativos/${ceo.id}/fusoes`, { bandeja_id: bandeja, a: { cabo_id: cb48.id, tubo: 1, fibra: 3, cor: 'verde' }, b: { cabo_id: cabos[0].id, tubo: 1, fibra: 3 } }, tk.noc);
    assert.equal(f.status, 201);
    const conflito = await api.post(`/rede/ativos/${ceo.id}/fusoes`, { bandeja_id: bandeja, a: { cabo_id: cb48.id, tubo: 1, fibra: 3 }, b: { cabo_id: cabos[0].id, tubo: 1, fibra: 4 } }, tk.noc);
    assert.equal(conflito.status, 409);
    assert.match(conflito.dados.erro, /já está na fusão/);
    assert.equal((await api.post(`/rede/ativos/${ceo.id}/fusoes`, { bandeja_id: bandeja, a: { cabo_id: cb48.id, fibra: 60 }, b: { cabo_id: cabos[0].id, fibra: 5 } }, tk.noc)).status, 422);
    await api.post(`/rede/fusoes/${f.dados.id}/desfazer`, { motivo: 'Refeita' }, tk.noc);
    assert.equal((await api.post(`/rede/ativos/${ceo.id}/fusoes`, { bandeja_id: bandeja, a: { cabo_id: cb48.id, tubo: 1, fibra: 3 }, b: { cabo_id: cabos[0].id, tubo: 1, fibra: 4 } }, tk.noc)).status, 201);
  });

  await t.test('encerrar ligação com dependentes exige tratamento explícito e preserva o histórico', async () => {
    const det = (await api.get(`/rede/ativos/${ceo.id}`, tk.noc)).dados;
    const enlace = det.acima.id;
    const r = await api.post(`/rede/enlaces/${enlace}/encerrar`, { motivo: 'Remanejamento' }, tk.noc);
    assert.equal(r.status, 409);
    assert.deepEqual(r.dados.detalhes.dependentes.map((d) => d.codigo), ['CTO-OCN-024']);
    assert.equal((await api.post(`/rede/enlaces/${enlace}/encerrar`, { motivo: 'Remanejamento', confirmar_dependentes: true }, tk.noc)).status, 200);
    const depois = (await api.get(`/rede/ativos/${ceo.id}`, tk.noc)).dados;
    assert.equal(depois.acima, null);
    assert.equal(depois.historico_ligacoes[0].motivo_fim, 'Remanejamento');
    assert.ok(depois.historico.some((h) => h.acao === 'ligacao_encerrada'));
    assert.equal((await api.post(`/rede/ativos/${ceo.id}/desativar`, { motivo: 'x' }, tk.noc)).status, 409, 'ainda alimenta a CTO');
  });

  await t.test('capacidade não fica abaixo da ocupação ativa', async () => {
    const det = (await api.get(`/rede/ativos/${cto.id}`, tk.noc)).dados;
    const ultima = det.lista_portas.at(-1);
    await api.post(`/rede/portas/${ultima.id}/reservar`, { cliente_ref: 'CLI-8' }, tk.noc);
    const r = await api.patch(`/rede/ativos/${cto.id}`, { capacidade: 4, versao: det.versao }, tk.noc);
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /porta 8 \(reservada\)/);
    await api.post(`/rede/portas/${ultima.id}/liberar`, { motivo: 'Cliente desistiu' }, tk.noc);
    const ok = await api.patch(`/rede/ativos/${cto.id}`, { capacidade: 4, versao: det.versao }, tk.noc);
    assert.equal(ok.status, 200);
    assert.equal(ok.dados.portas.total, 4);
    assert.equal((await api.get(`/rede/portas/${ultima.id}/historico`, tk.noc)).status, 404, 'porta fora de uso');
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM porta_historico WHERE porta_id = ?').get(ultima.id).n, 2, 'histórico preservado');
    const mais = await api.patch(`/rede/ativos/${cto.id}`, { capacidade: 16, versao: ok.dados.versao }, tk.noc);
    assert.equal(mais.dados.portas.total, 16);
    assert.equal((await api.patch(`/rede/ativos/${cto.id}`, { nome: 'x', versao: det.versao }, tk.noc)).status, 409, 'versão antiga');
  });

  await t.test('inspeção manual guarda origem e evidência', async () => {
    const r = await api.post(`/rede/ativos/${cto.id}/inspecao`, { status_operacional: 'atencao', evidencia: 'Tampa danificada, conectores expostos' }, tk.tecnico);
    assert.equal(r.dados.status_origem, 'inspecao_manual');
    assert.match(r.dados.status_evidencia, /Tampa/);
  });

  await t.test('mapa traz ativos com coordenadas e as ligações ativas', async () => {
    const m = (await api.get('/rede/mapa', tk.consulta)).dados;
    assert.equal(m.ativos.length, 3);
    assert.equal(m.ligacoes.length, 1);
  });
});
