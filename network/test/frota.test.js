'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, PDF } = require('./helpers');
const { situacaoPlano } = require('../server/lib/manutencao');

const diasAtras = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const horaAtras = (h) => new Date(Date.now() - h * 3600_000).toISOString();

test('frota, manutenção e lavagem', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  let veic;

  await t.test('placa válida e única na organização, em qualquer formatação', async () => {
    assert.equal((await api.post('/frota/veiculos', { placa: 'AB-12', modelo: 'Fiorino' }, tk.frota)).status, 422);
    const r = await api.post('/frota/veiculos', { placa: 'gkv-8b32', modelo: 'Fiorino', marca: 'Fiat', tanque_litros: 50, odometro_km: 62000 }, tk.frota);
    assert.equal(r.status, 201);
    assert.equal(r.dados.placa, 'GKV8B32');
    veic = r.dados;
    const dup = await api.post('/frota/veiculos', { placa: 'GKV 8B32', modelo: 'Outro' }, tk.frota);
    assert.equal(dup.status, 409);
    assert.match(dup.dados.erro, /já está cadastrada/);
  });

  await t.test('veículo em oficina não recebe escala, e o motivo aparece', async () => {
    await api.post(`/frota/veiculos/${veic.id}/restricoes`, { tipo: 'oficina', motivo: 'Barulho no motor' }, tk.frota);
    const ch = (await api.post('/chamados', { tipo: 'reparo', titulo: 'Cliente sem sinal' }, tk.gestor)).dados;
    const r = await api.post(`/chamados/${ch.id}/atribuir`, { tecnico_id: tk.tecnico_tid, veiculo_id: veic.id, versao: ch.versao }, tk.gestor);
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /indisponível: Barulho no motor/);
    assert.equal((await api.post(`/frota/veiculos/${veic.id}/responsavel`, { tecnico_id: tk.tecnico_tid }, tk.frota)).status, 409);
    const d = (await api.get(`/frota/veiculos/${veic.id}`, tk.frota)).dados;
    assert.equal(d.status, 'em_oficina');
    const rid = d.restricoes[0].id;
    assert.equal((await api.post(`/frota/restricoes/${rid}/liberar`, {}, tk.frota)).status, 422, 'liberação exige motivo');
    assert.equal((await api.post(`/frota/restricoes/${rid}/liberar`, { motivo: 'Revisado' }, tk.frota)).dados.status, 'disponivel');
  });

  await t.test('óleo, lavagem e pneus com contadores próprios; preventiva pelo primeiro limite', async () => {
    const plano = async (item, dias, km, ultimaData, ultimoKm) => (await api.post('/manutencao/planos', { veiculo_id: veic.id, item, intervalo_dias: dias, intervalo_km: km,
      ultima_data: ultimaData, ultimo_km: ultimoKm }, tk.frota)).dados;
    // 180 dias ou 10.000 km: vence por km (62.000 ≥ 51.000 + 10.000) mesmo com a data em dia.
    const oleo = await plano('oleo', 180, 10000, diasAtras(30), 51000);
    assert.equal(oleo.situacao, 'critico');
    assert.match(oleo.motivos.join(' '), /limite/);
    // Vence pela data mesmo com a quilometragem em dia.
    const pneus = await plano('pneus', 180, 40000, diasAtras(200), 60000);
    assert.equal(pneus.situacao, 'critico');
    // Sem odômetro: avalia por data e informa a limitação.
    const s = situacaoPlano({ intervalo_dias: 180, intervalo_km: 10000, ultima_data: diasAtras(10), ultimo_km: 1000, antecedencia_dias: 15, antecedencia_km: 500,
      tolerancia_dias: 0, tolerancia_km: 0 }, { odometro_km: null }, diasAtras(0));
    assert.equal(s.situacao, 'em_dia');
    assert.match(s.limitacao, /Sem odômetro confiável/);

    const lav = (await api.post('/manutencao/ordens', { veiculo_id: veic.id, tipo: 'lavagem', lavagem_tipo: 'completa', descricao: 'Lavagem completa' }, tk.frota)).dados;
    const fim = await api.post(`/manutencao/ordens/${lav.id}/status`, { status: 'concluido', custo_realizado: '60,00', versao: lav.versao }, tk.frota);
    assert.equal(fim.status, 200);
    const planos = (await api.get(`/manutencao/planos?veiculo_id=${veic.id}`, tk.frota)).dados;
    assert.equal(planos.find((p) => p.item === 'oleo').ultima_data, diasAtras(30), 'lavagem não zera o óleo');
    assert.equal(planos.find((p) => p.item === 'pneus').ultimo_km, 60000);

    // Troca de óleo: orçamento, aprovação, execução (bloqueia), conclusão reinicia só o óleo.
    const o = (await api.post('/manutencao/ordens', { veiculo_id: veic.id, tipo: 'preventiva', plano_id: oleo.id, descricao: 'Troca de óleo e filtro' }, tk.frota)).dados;
    assert.equal(o.status, 'solicitado');
    assert.equal((await api.post(`/manutencao/ordens/${o.id}/status`, { status: 'aprovado', versao: o.versao }, tk.frota)).status, 422, 'sem orçamento não aprova');
    let x = (await api.post(`/manutencao/ordens/${o.id}/status`, { status: 'orcado', custo_previsto: '350,00', versao: o.versao }, tk.frota)).dados;
    x = (await api.post(`/manutencao/ordens/${o.id}/status`, { status: 'aprovado', versao: x.versao }, tk.frota)).dados;
    x = (await api.post(`/manutencao/ordens/${o.id}/status`, { status: 'em_execucao', versao: x.versao }, tk.frota)).dados;
    assert.equal((await api.get(`/frota/veiculos/${veic.id}`, tk.frota)).dados.status, 'em_oficina');
    // Outro bloqueio ativo: concluir a ordem não libera o veículo.
    await api.post(`/frota/veiculos/${veic.id}/restricoes`, { tipo: 'documento', motivo: 'CRLV vencido' }, tk.frota);
    x = (await api.post(`/manutencao/ordens/${o.id}/status`, { status: 'concluido', custo_realizado: '362,50', km_execucao: 62010, versao: x.versao }, tk.frota)).dados;
    const depois = (await api.get(`/frota/veiculos/${veic.id}`, tk.frota)).dados;
    assert.equal(depois.status, 'indisponivel');
    assert.deepEqual(depois.restricoes.map((r) => r.tipo), ['documento']);
    assert.equal(depois.odometro_km, 62010);
    const p2 = (await api.get(`/manutencao/planos?veiculo_id=${veic.id}`, tk.frota)).dados;
    assert.equal(p2.find((p) => p.item === 'oleo').ultimo_km, 62010);
    assert.equal(p2.find((p) => p.item === 'oleo').situacao, 'em_dia');
    assert.equal(p2.find((p) => p.item === 'pneus').situacao, 'critico', 'óleo não reinicia os pneus');

    // Orçado e realizado separados, sem somar o mesmo serviço duas vezes.
    const c = (await api.get('/manutencao/custos', tk.frota)).dados;
    const linha = c.por_veiculo.find((l) => l.veiculo_id === veic.id);
    assert.equal(linha.orcado_centavos, 35000);
    assert.equal(linha.realizado_centavos, 36250 + 6000);
    assert.equal(linha.lavagem_centavos, 6000);
  });

  await t.test('alçada de aprovação da manutenção por valor', async () => {
    const o = (await api.post('/manutencao/ordens', { veiculo_id: veic.id, tipo: 'corretiva', descricao: 'Embreagem', custo_previsto: '2.500,00' }, tk.frota)).dados;
    assert.equal(o.status, 'orcado');
    assert.equal((await api.post(`/manutencao/ordens/${o.id}/status`, { status: 'aprovado', versao: o.versao }, tk.frota)).status, 403);
    assert.equal((await api.post(`/manutencao/ordens/${o.id}/status`, { status: 'aprovado', versao: o.versao }, tk.admin)).status, 200);
    assert.equal((await api.post(`/manutencao/ordens/${o.id}/status`, { status: 'cancelado', versao: o.versao }, tk.admin)).status, 409, 'versão antiga');
  });
});

test('abastecimentos: cálculos, ciclos, retroativo e comprovante', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const veic = (await api.post('/frota/veiculos', { placa: 'FRT2A41', modelo: 'Strada', tanque_litros: 55 }, tk.frota)).dados;
  const outro = (await api.post('/frota/veiculos', { placa: 'EQP4C17', modelo: 'S10', combustivel: 'diesel' }, tk.frota)).dados;
  const lancar = (b) => api.post('/abastecimentos'.replace(/^/, '/combustivel'), { veiculo_id: veic.id, combustivel: 'gasolina', ...b }, tk.frota);

  await t.test('40 L × R$ 5,90 = R$ 236,00 com precisão persistida', async () => {
    const r = await lancar({ data_hora: horaAtras(100), odometro_km: 10000, litros: '40', preco_litro: '5,90', tanque_cheio: true });
    assert.equal(r.status, 201);
    assert.equal(r.dados.total_centavos, 23600);
    assert.equal(r.dados.litros_ml, 40000);
    assert.equal(r.dados.preco_milesimos, 5900);
  });

  await t.test('ciclo entre dois tanques cheios inclui o parcial e exclui o primeiro fechamento', async () => {
    let res = (await api.get(`/combustivel/resumo?veiculo_id=${veic.id}`, tk.frota)).dados;
    assert.equal(res.por_veiculo[0].consumo.situacao, 'dados_insuficientes');
    await lancar({ data_hora: horaAtras(80), odometro_km: 10150, litros: '10', preco_litro: '5,00' });
    await lancar({ data_hora: horaAtras(60), odometro_km: 10300, litros: '20', preco_litro: '6,00', tanque_cheio: true });
    res = (await api.get(`/combustivel/resumo?veiculo_id=${veic.id}`, tk.frota)).dados;
    const c = res.por_veiculo[0];
    assert.equal(c.consumo.km_por_litro, 10);
    assert.equal(c.ciclos[0].litros_ml, 30000);
    assert.equal(c.consumo.custo_combustivel_km_centavos, Math.round(((5000 + 12000) / 300) * 100) / 100);
  });

  await t.test('preço médio ponderado: 10 L a R$ 5 e 30 L a R$ 6 = R$ 5,75', async () => {
    await api.post('/combustivel/abastecimentos', { veiculo_id: outro.id, combustivel: 'diesel', data_hora: horaAtras(50), odometro_km: 500, litros: 10, preco_litro: 5 }, tk.frota);
    await api.post('/combustivel/abastecimentos', { veiculo_id: outro.id, combustivel: 'diesel', data_hora: horaAtras(40), odometro_km: 700, litros: 30, preco_litro: 6 }, tk.frota);
    const r = (await api.get(`/combustivel/resumo?veiculo_id=${outro.id}`, tk.frota)).dados;
    assert.equal(r.por_veiculo[0].preco_medio_milesimos, 5750);
  });

  await t.test('retroativo validado contra o anterior e o posterior; futuro recusado', async () => {
    const entre = await lancar({ data_hora: horaAtras(90), odometro_km: 10200, litros: 5, preco_litro: 5 });
    assert.equal(entre.status, 422);
    assert.match(entre.dados.erro, /seguinte \(10150 km/);
    assert.equal((await lancar({ data_hora: horaAtras(90), odometro_km: 9990, litros: 5, preco_litro: 5 })).status, 422);
    assert.equal((await lancar({ data_hora: horaAtras(90), odometro_km: 10080, litros: 5, preco_litro: 5 })).status, 201);
    assert.equal((await lancar({ data_hora: new Date(Date.now() + 86400_000).toISOString(), odometro_km: 20000, litros: 5, preco_litro: 5 })).status, 422);
  });

  await t.test('volume acima do tanque é sinalizado; correção guarda o original', async () => {
    const r = await lancar({ data_hora: horaAtras(30), odometro_km: 10400, litros: '60', preco_litro: '5,80' });
    assert.equal(r.dados.alerta_volume, 1);
    assert.equal(r.dados.avisos.length, 1);
    assert.equal((await api.post(`/combustivel/abastecimentos/${r.dados.id}/corrigir`, { litros: '45' }, tk.frota)).status, 422, 'motivo obrigatório');
    assert.equal((await api.post(`/combustivel/abastecimentos/${r.dados.id}/corrigir`, { litros: '45', motivo: 'Erro de digitação' }, tk.tecnico)).status, 403);
    const c = await api.post(`/combustivel/abastecimentos/${r.dados.id}/corrigir`, { litros: '45', motivo: 'Erro de digitação' }, tk.frota);
    assert.equal(c.dados.total_centavos, 26100);
    const d = (await api.get(`/combustivel/abastecimentos/${r.dados.id}`, tk.frota)).dados;
    assert.deepEqual(d.correcoes.filter((x) => x.campo === 'litros_ml').map((x) => [x.valor_anterior, x.valor_novo]), [['60000', '45000']]);
  });

  await t.test('comprovante: perfil sem permissão recebe acesso negado no servidor', async () => {
    const a = (await api.post('/anexos?recurso=abastecimento', PDF, tk.frota)).dados;
    const r = await lancar({ data_hora: horaAtras(20), odometro_km: 10500, litros: 30, preco_litro: '5,79', comprovante_id: a.id });
    assert.equal(r.dados.comprovantes.length, 1);
    assert.equal((await api.get(`/anexos/${a.id}/link`, tk.gestor)).status, 403);
    assert.equal((await api.get(`/anexos/${a.id}/link`, tk.consulta)).status, 403);
    assert.equal((await api.get(`/anexos/${a.id}/link`, tk.frota)).status, 200);
  });

  await t.test('técnico só lança no veículo sob sua responsabilidade e vê só os próprios', async () => {
    const r = await api.post('/combustivel/abastecimentos', { veiculo_id: veic.id, combustivel: 'gasolina', data_hora: horaAtras(1), odometro_km: 10600, litros: 10, preco_litro: 6 }, tk.tecnico);
    assert.equal(r.status, 403);
    await api.post(`/frota/veiculos/${veic.id}/responsavel`, { tecnico_id: tk.tecnico_tid }, tk.frota);
    const ok = await api.post('/combustivel/abastecimentos', { veiculo_id: veic.id, combustivel: 'gasolina', data_hora: horaAtras(1), odometro_km: 10600, litros: 10, preco_litro: 6 }, tk.tecnico);
    assert.equal(ok.status, 201);
    assert.equal(ok.dados.tecnico_id, tk.tecnico_tid);
    assert.equal((await api.get('/combustivel/abastecimentos', tk.tecnico)).dados.total, 1);
  });

  await t.test('exportação CSV com acesso controlado', async () => {
    assert.equal((await api.get('/combustivel/exportar.csv', tk.tecnico)).status, 422);
    const r = await api.get('/combustivel/exportar.csv', tk.frota);
    assert.equal(r.status, 200);
    assert.match(r.dados, /FRT2A41;.*;40,000;5,900;236,00;sim/);
  });
});
