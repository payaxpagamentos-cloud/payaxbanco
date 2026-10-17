'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { copiaECola, crc16 } = require('../server/lib/pix');
const { cnhValida, cpfValido } = require('../server/lib/validacao');
const tarifa = require('../server/lib/tarifa');
const { distancia } = require('../server/lib/geo');
const { hoje } = require('../server/lib/datas');

// Praça da Sé → Avenida Paulista (São Paulo), cerca de 3 km em linha reta.
const SE = { endereco: 'Praça da Sé, São Paulo', lat: -23.5503, lng: -46.6339 };
const PAULISTA = { endereco: 'Av. Paulista, 1578, São Paulo', lat: -23.5614, lng: -46.6559 };
const PERTO_DA_SE = { lat: -23.5480, lng: -46.6360 };

const MOTORISTA = {
  nome: 'Carlos Motorista', email: 'carlos@teste.com', telefone: '(11) 98888-7777', senha: 'senha-do-carlos', cpf: '529.982.247-25',
  cnh: '12345678900', cnh_validade: '2030-12-31', chave_pix: 'carlos@teste.com',
  veiculo: { placa: 'ABC1D23', marca_modelo: 'Toyota Corolla', cor: 'Prata', ano: 2022, categoria: 'executivo' },
};

test('funções de apoio', () => {
  assert.equal(crc16('123456789'), '29B1');
  const br = copiaECola({ chave: 'pix@apptaxi.com.br', recebedor: 'App Táxi Ltda', cidade: 'São Paulo', valorCentavos: 2350, txid: 'CORRIDA7' });
  assert.match(br, /^000201/);
  assert.ok(br.includes('br.gov.bcb.pix'));
  assert.ok(br.includes('540523.50'));
  assert.ok(br.includes('5913App Taxi Ltda'));
  assert.equal(br.slice(-4), crc16(br.slice(0, -4)));
  assert.ok(cnhValida('12345678900'));
  assert.ok(!cnhValida('12345678901'));
  assert.ok(cpfValido('52998224725'));
  const cfg = { bandeira2_inicio_hora: 20, bandeira2_fim_hora: 6, bandeira2_domingo: true, bandeira2_feriados: true };
  assert.equal(tarifa.bandeira('2026-10-14T15:00:00Z', cfg), 1); // quarta, 12h em Brasília
  assert.equal(tarifa.bandeira('2026-10-15T01:00:00Z', cfg), 2); // quarta, 22h
  assert.equal(tarifa.bandeira('2026-10-18T15:00:00Z', cfg), 2); // domingo
  assert.equal(tarifa.bandeira('2026-12-25T15:00:00Z', cfg), 2); // Natal
  const t = { bandeirada_centavos: 500, km_centavos: 300, km_bandeira2_centavos: 400, minuto_centavos: 60, minima_centavos: 1000 };
  assert.equal(tarifa.calcular(t, { distancia_m: 10_000, duracao_s: 600, bandeira: 1 }), 500 + 3000 + 600);
  assert.equal(tarifa.calcular(t, { distancia_m: 10_000, duracao_s: 600, bandeira: 2 }), 500 + 4000 + 600);
  assert.equal(tarifa.calcular(t, { distancia_m: 100, duracao_s: 30, bandeira: 1 }), 1000);
  assert.deepEqual(tarifa.dividir(2001, 1500), { taxa_plataforma_centavos: 300, valor_motorista_centavos: 1701 });
});

test('APP Táxi', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  const admin = await api.login();
  let passageiro, motorista, motoristaId, corrida;

  await t.test('configuração fixa a bandeira 1 e cadastra a chave PIX', async () => {
    assert.equal((await api.patch('/central/config', { bandeira2_inicio_hora: 0, bandeira2_fim_hora: 0, bandeira2_domingo: false, bandeira2_feriados: false,
      pix_chave: 'pix@apptaxi.com.br' }, admin)).status, 204);
    assert.equal((await api.get('/central/config', admin)).dados.pix_chave, 'pix@apptaxi.com.br');
    assert.equal((await api.patch('/central/config', { taxa_plataforma_bp: 9000 }, admin)).status, 422);
  });

  await t.test('cadastro e login do passageiro', async () => {
    assert.equal((await api.post('/auth/cadastro', { nome: 'Ana', email: 'ana@teste', telefone: '11999990000', senha: 'senha-da-ana' })).status, 422);
    const r = await api.post('/auth/cadastro', { nome: 'Ana Passageira', email: 'ana@teste.com', telefone: '(11) 99999-0000', senha: 'senha-da-ana' });
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.usuario.perfil, 'passageiro');
    assert.equal((await api.post('/auth/cadastro', { nome: 'Ana', email: 'ANA@teste.com', telefone: '11999990000', senha: 'senha-da-ana' })).status, 409);
    assert.equal((await api.post('/auth/login', { email: 'ana@teste.com', senha: 'errada' })).status, 401);
    passageiro = await api.login('ana@teste.com', 'senha-da-ana');
    assert.equal((await api.get('/auth/me', passageiro)).dados.usuario.nome, 'Ana Passageira');
    assert.equal((await api.get('/central/painel', passageiro)).status, 403);
    assert.equal((await api.get('/motorista/perfil', passageiro)).status, 403);
    assert.equal((await api.get('/passageiro/corridas', 'token.falso')).status, 401);
  });

  await t.test('motorista se cadastra e fica pendente até a central aprovar', async () => {
    assert.equal((await api.post('/auth/cadastro-motorista', { ...MOTORISTA, cpf: '111.111.111-11' })).status, 422);
    assert.equal((await api.post('/auth/cadastro-motorista', { ...MOTORISTA, cnh: '12345678901' })).status, 422);
    assert.equal((await api.post('/auth/cadastro-motorista', { ...MOTORISTA, cnh_validade: '2020-01-01' })).status, 422);
    assert.equal((await api.post('/auth/cadastro-motorista', { ...MOTORISTA, veiculo: { ...MOTORISTA.veiculo, placa: 'XX12' } })).status, 422);
    const r = await api.post('/auth/cadastro-motorista', MOTORISTA);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    motorista = r.dados.token;
    motoristaId = r.dados.usuario.id;
    assert.equal((await api.post('/auth/cadastro-motorista', { ...MOTORISTA, email: 'outro@teste.com' })).status, 409);

    const perfil = (await api.get('/motorista/perfil', motorista)).dados;
    assert.equal(perfil.situacao, 'pendente');
    assert.equal(perfil.veiculos[0].placa, 'ABC1D23');
    const online = await api.post('/motorista/online', { online: true, ...PERTO_DA_SE }, motorista);
    assert.equal(online.status, 403);
    assert.match(online.dados.erro, /análise/);

    assert.equal((await api.get('/central/painel', admin)).dados.motoristas_pendentes, 1);
    assert.equal((await api.post(`/central/motoristas/${motoristaId}/situacao`, { situacao: 'recusado' }, admin)).status, 422); // sem motivo
    assert.equal((await api.post(`/central/motoristas/${motoristaId}/situacao`, { situacao: 'aprovado' }, admin)).status, 204);
    const lista = (await api.get('/central/motoristas?situacao=aprovado', admin)).dados;
    assert.equal(lista[0].veiculos[0].situacao, 'aprovado');
    assert.equal((await api.post('/motorista/online', { online: true, ...PERTO_DA_SE }, motorista)).status, 204);
  });

  await t.test('estimativa e solicitação de corrida', async () => {
    const est = (await api.get(`/passageiro/estimativa?olat=${SE.lat}&olng=${SE.lng}&dlat=${PAULISTA.lat}&dlng=${PAULISTA.lng}`, passageiro)).dados;
    assert.equal(est.length, 2);
    const comum = est.find((e) => e.categoria === 'comum');
    assert.equal(comum.bandeira, 1);
    assert.equal(comum.distancia_m, Math.round(distancia(SE, PAULISTA) * 1.3));
    assert.ok(est.find((e) => e.categoria === 'executivo').valor_centavos > comum.valor_centavos);

    assert.equal((await api.post('/passageiro/corridas', { origem: SE, destino: SE, forma_pagamento: 'pix' }, passageiro)).status, 422);
    assert.equal((await api.post('/passageiro/corridas', { origem: SE, destino: PAULISTA, forma_pagamento: 'boleto' }, passageiro)).status, 422);
    const r = await api.post('/passageiro/corridas', { origem: SE, destino: PAULISTA, categoria: 'comum', forma_pagamento: 'pix' }, passageiro);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    corrida = r.dados.id;
    assert.equal((await api.post('/passageiro/corridas', { origem: SE, destino: PAULISTA, forma_pagamento: 'pix' }, passageiro)).status, 409);
    const atual = (await api.get('/passageiro/corridas/atual', passageiro)).dados;
    assert.equal(atual.status, 'solicitada');
    assert.equal(atual.valor_estimado_centavos, comum.valor_centavos);
    assert.equal((await api.get('/passageiro/proximos?lat=-23.55&lng=-46.634', passageiro)).dados.length, 1);
  });

  await t.test('motorista recebe a oferta, aceita, chega e inicia', async () => {
    const ofertas = (await api.get('/motorista/ofertas', motorista)).dados;
    assert.equal(ofertas.length, 1);
    assert.equal(ofertas[0].id, corrida);
    assert.ok(ofertas[0].ganho_estimado_centavos < ofertas[0].valor_estimado_centavos);
    assert.equal(ofertas[0].passageiro_id, undefined);
    assert.equal((await api.post(`/motorista/corridas/${corrida}/iniciar`, {}, motorista)).status, 404);
    assert.equal((await api.post(`/motorista/ofertas/${corrida}/aceitar`, {}, motorista)).status, 204);
    assert.equal((await api.get('/motorista/ofertas', motorista)).dados.length, 0);
    const p = (await api.get('/passageiro/corridas/atual', passageiro)).dados;
    assert.equal(p.status, 'aceita');
    assert.equal(p.motorista.placa, 'ABC1D23');
    assert.ok(p.motorista.chegada_s > 0);
    assert.equal((await api.post('/motorista/online', { online: false }, motorista)).status, 409);
    assert.equal((await api.post(`/motorista/corridas/${corrida}/chegou`, {}, motorista)).status, 204);
    await api.post('/motorista/posicao', { lat: SE.lat, lng: SE.lng }, motorista);
    assert.equal((await api.post(`/motorista/corridas/${corrida}/iniciar`, {}, motorista)).status, 204);
    assert.equal((await api.post(`/passageiro/corridas/${corrida}/cancelar`, {}, passageiro)).status, 409);
  });

  await t.test('trajeto soma as posições e ignora saltos de GPS', async () => {
    const voltar = (s) => api.db.prepare('UPDATE corridas SET ultima_posicao_em = ? WHERE id = ?').run(new Date(Date.now() - s * 1000).toISOString(), corrida);
    const meio = { lat: -23.5560, lng: -46.6450 };
    voltar(120);
    await api.post('/motorista/posicao', meio, motorista);
    voltar(1);
    await api.post('/motorista/posicao', { lat: -22.9, lng: -43.2 }, motorista); // "Rio de Janeiro" em 1 s: descartado
    voltar(120);
    await api.post('/motorista/posicao', { lat: PAULISTA.lat, lng: PAULISTA.lng }, motorista);
    const c = api.db.prepare('SELECT distancia_percorrida_m FROM corridas WHERE id = ?').get(corrida);
    const esperado = distancia(SE, meio) + distancia(meio, PAULISTA);
    assert.ok(Math.abs(c.distancia_percorrida_m - esperado) <= 2, `${c.distancia_percorrida_m} vs ${esperado}`);
  });

  await t.test('finaliza com o valor real e divide entre plataforma e motorista', async () => {
    api.db.prepare('UPDATE corridas SET iniciada_em = ? WHERE id = ?').run(new Date(Date.now() - 600_000).toISOString(), corrida);
    const r = await api.post(`/motorista/corridas/${corrida}/finalizar`, {}, motorista);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    const c = r.dados;
    const tf = api.db.prepare("SELECT * FROM tarifas WHERE categoria = 'comum'").get();
    assert.equal(c.valor_final_centavos, tarifa.calcular(tf, { distancia_m: c.distancia_percorrida_m, duracao_s: c.duracao_real_s, bandeira: 1 }));
    assert.ok(c.duracao_real_s >= 600);
    assert.equal(c.taxa_plataforma_centavos, Math.round(c.valor_final_centavos * 0.15));
    assert.equal(c.taxa_plataforma_centavos + c.valor_motorista_centavos, c.valor_final_centavos);
    corrida = c;
  });

  await t.test('PIX da corrida e confirmação do pagamento', async () => {
    const pix = (await api.get(`/passageiro/corridas/${corrida.id}/pix`, passageiro)).dados;
    assert.ok(pix.copia_e_cola.includes(`54${String((corrida.valor_final_centavos / 100).toFixed(2).length).padStart(2, '0')}${(corrida.valor_final_centavos / 100).toFixed(2)}`));
    assert.match(pix.qr_svg, /^<svg/);
    assert.equal((await api.get('/motorista/corrida-atual', motorista)).dados.pagamento_status, 'pendente');
    assert.equal((await api.post('/motorista/online', { online: false }, motorista)).status, 204); // finalizada não prende o motorista
    assert.equal((await api.post(`/motorista/corridas/${corrida.id}/pagamento`, {}, motorista)).status, 204);
    assert.equal((await api.post(`/central/corridas/${corrida.id}/pagamento`, {}, admin)).status, 409);
    // Paga e ainda sem avaliação do motorista: continua na tela dele para avaliar o passageiro, sem bloquear novas ofertas.
    assert.equal((await api.get('/motorista/corrida-atual', motorista)).dados.pagamento_status, 'pago');
    assert.equal((await api.get(`/passageiro/corridas/${corrida.id}/pix`, passageiro)).status, 409);
    const g = (await api.get('/motorista/ganhos', motorista)).dados;
    assert.equal(g.total_corridas, 1);
    assert.equal(g.liquido_centavos, corrida.valor_motorista_centavos);
    assert.equal(g.saldo_centavos, corrida.valor_motorista_centavos); // PIX: a plataforma deve a parte do motorista
    assert.equal(g.extrato[0].tipo, 'corrida');
  });

  await t.test('avaliações dos dois lados', async () => {
    assert.equal((await api.post(`/passageiro/corridas/${corrida.id}/avaliar`, { nota: 6 }, passageiro)).status, 422);
    assert.equal((await api.post(`/passageiro/corridas/${corrida.id}/avaliar`, { nota: 5, comentario: 'Ótimo!' }, passageiro)).status, 204);
    assert.equal((await api.post(`/passageiro/corridas/${corrida.id}/avaliar`, { nota: 4 }, passageiro)).status, 409);
    assert.equal((await api.post(`/motorista/corridas/${corrida.id}/avaliar`, { nota: 4 }, motorista)).status, 204);
    assert.equal((await api.get('/motorista/perfil', motorista)).dados.nota_media, 5);
    assert.equal((await api.get('/passageiro/corridas/atual', passageiro)).dados, null);
  });

  await t.test('corrida em dinheiro debita a taxa; cancelamentos e redistribuição', async () => {
    await api.post('/motorista/online', { online: true, ...PERTO_DA_SE }, motorista);
    const id = (await api.post('/passageiro/corridas', { origem: SE, destino: PAULISTA, forma_pagamento: 'dinheiro' }, passageiro)).dados.id;
    // Motorista desiste: a corrida volta para a fila e não é oferecida de novo a ele.
    await api.post(`/motorista/ofertas/${id}/aceitar`, {}, motorista);
    assert.equal((await api.post(`/motorista/corridas/${id}/cancelar`, { motivo: 'Pneu furado' }, motorista)).status, 204);
    assert.equal((await api.get('/passageiro/corridas/atual', passageiro)).dados.status, 'solicitada');
    assert.equal((await api.get('/motorista/ofertas', motorista)).dados.length, 0);
    // Segundo motorista, só categoria comum, assume.
    const r2 = await api.post('/auth/cadastro-motorista', { ...MOTORISTA, nome: 'Bia', email: 'bia@teste.com', cpf: '168.995.350-09', cnh: '24681357982',
      chave_pix: null, veiculo: { placa: 'XYZ9876', marca_modelo: 'Fiat Cronos', cor: 'Branco', ano: 2021, categoria: 'comum' } });
    assert.equal(r2.status, 201, JSON.stringify(r2.dados));
    const bia = r2.dados.token;
    await api.post(`/central/motoristas/${r2.dados.usuario.id}/situacao`, { situacao: 'aprovado' }, admin);
    await api.post('/motorista/online', { online: true, ...PERTO_DA_SE }, bia);
    assert.equal((await api.post(`/motorista/ofertas/${id}/aceitar`, {}, bia)).status, 204);
    assert.equal((await api.post(`/motorista/ofertas/${id}/aceitar`, {}, motorista)).status, 409);
    await api.post(`/motorista/corridas/${id}/iniciar`, {}, bia);
    const fim = (await api.post(`/motorista/corridas/${id}/finalizar`, {}, bia)).dados;
    assert.equal(fim.distancia_percorrida_m, fim.distancia_estimada_m); // sem GPS: usa a estimativa
    await api.post(`/motorista/corridas/${id}/pagamento`, {}, bia);
    const g = (await api.get('/motorista/ganhos', bia)).dados;
    assert.equal(g.saldo_centavos, -fim.taxa_plataforma_centavos);
    assert.equal(g.recebido_em_maos_centavos, fim.valor_final_centavos);

    // Executivo não é oferecido à Bia (veículo comum).
    await api.post(`/passageiro/corridas/${id}/avaliar`, { nota: 4 }, passageiro);
    const exec = (await api.post('/passageiro/corridas', { origem: SE, destino: PAULISTA, categoria: 'executivo', forma_pagamento: 'cartao' }, passageiro)).dados.id;
    assert.equal((await api.get('/motorista/ofertas', bia)).dados.length, 0);
    assert.equal((await api.get('/motorista/ofertas', motorista)).dados[0].id, exec);
    assert.equal((await api.post(`/passageiro/corridas/${exec}/cancelar`, { motivo: 'Mudei de ideia' }, passageiro)).status, 204);
    // Solicitação esquecida expira sozinha.
    const velha = (await api.post('/passageiro/corridas', { origem: SE, destino: PAULISTA, forma_pagamento: 'pix' }, passageiro)).dados.id;
    api.db.prepare('UPDATE corridas SET solicitada_em = ? WHERE id = ?').run(new Date(Date.now() - 3_600_000).toISOString(), velha);
    assert.equal((await api.get('/passageiro/corridas/atual', passageiro)).dados, null);
    assert.equal((await api.get(`/passageiro/corridas/${velha}`, passageiro)).dados.cancelada_por, 'sistema');
    assert.equal((await api.get(`/passageiro/corridas/${velha}`, admin)).status, 403);
  });

  await t.test('repasses: gera, cancela (volta ao saldo) e paga', async () => {
    const saldoCarlos = corrida.valor_motorista_centavos;
    await api.patch('/central/config', { repasse_minimo_centavos: 0 }, admin);
    const r = await api.post('/central/repasses', {}, admin);
    assert.equal(r.status, 201);
    assert.equal(r.dados.gerados.length, 1); // a Bia deve taxa (saldo negativo) e não recebe repasse
    assert.equal(r.dados.gerados[0].valor_centavos, saldoCarlos);
    const rep = r.dados.gerados[0].id;
    assert.equal((await api.get('/motorista/ganhos', motorista)).dados.saldo_centavos, 0);
    assert.equal((await api.post('/central/repasses', {}, admin)).dados.gerados.length, 0);
    assert.equal((await api.post(`/central/repasses/${rep}/cancelar`, {}, admin)).status, 422);
    assert.equal((await api.post(`/central/repasses/${rep}/cancelar`, { motivo: 'Chave errada' }, admin)).status, 204);
    assert.equal((await api.get('/motorista/ganhos', motorista)).dados.saldo_centavos, saldoCarlos);
    const novo = (await api.post('/central/repasses', { motorista_ids: [motoristaId] }, admin)).dados.gerados[0].id;
    assert.equal((await api.post(`/central/repasses/${novo}/pagar`, { identificador: 'E12345678202610171200abc' }, admin)).status, 204);
    assert.equal((await api.post(`/central/repasses/${novo}/pagar`, { identificador: 'x' }, admin)).status, 409);
    const g = (await api.get('/motorista/ganhos', motorista)).dados;
    assert.equal(g.saldo_centavos, 0);
    assert.equal(g.repasses[0].status, 'pago');
    const painel = (await api.get('/central/painel', admin)).dados;
    assert.equal(painel.a_repassar_centavos, 0);
    assert.ok(painel.a_cobrar_centavos > 0);
  });

  await t.test('relatório e exportação para o BPO', async () => {
    const rel = (await api.get('/central/relatorio', admin)).dados;
    assert.equal(rel.finalizadas, 2);
    assert.equal(rel.canceladas, 2);
    assert.equal(rel.por_dia[0].data, hoje());
    assert.equal(rel.bruto_centavos, rel.por_forma_centavos.pix + rel.por_forma_centavos.dinheiro);
    assert.equal(rel.ranking_motoristas.length, 2);
    const csv = await api.get('/central/exportar-bpo', admin);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const linhas = csv.dados.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(linhas.length, 1 + 2 + 1); // cabeçalho, 2 taxas, 1 repasse
    assert.match(linhas[1], /^receber;Taxa da plataforma/);
    assert.match(linhas.at(-1), /^pagar;Repasse ao motorista/);
    // O arquivo é lido pelo importador do Ativa BPO Financeiro (quando o APP Táxi está no mesmo repositório).
    let lerCsvLancamentos;
    try { ({ lerCsvLancamentos } = require('../../server/lib/integracoes')); } catch { return; }
    const itens = lerCsvLancamentos(csv.dados.replace(/^﻿/, ''));
    assert.equal(itens.length, 3);
    assert.equal(itens.at(-1).tipo, 'pagar');
    assert.equal(itens.at(-1).valor_centavos, corrida.valor_motorista_centavos);
    assert.equal(itens.at(-1).categoria, 'Serviços terceirizados');
  });

  await t.test('tarifas, equipe e permissões da central', async () => {
    const op = await api.post('/central/equipe', { nome: 'Olga Operadora', email: 'olga@apptaxi.com.br', senha: 'senha-da-olga', perfil: 'operador' }, admin);
    assert.equal(op.status, 201);
    const olga = await api.login('olga@apptaxi.com.br', 'senha-da-olga');
    assert.equal((await api.get('/central/mapa', olga)).status, 200);
    const novaTarifa = { bandeirada_centavos: 600, km_centavos: 400, km_bandeira2_centavos: 480, minuto_centavos: 55, minima_centavos: 1200 };
    assert.equal((await api.put('/central/tarifas/comum', novaTarifa, olga)).status, 403);
    assert.equal((await api.patch('/central/config', { raio_busca_km: 3 }, olga)).status, 403);
    assert.equal((await api.put('/central/tarifas/comum', novaTarifa, admin)).status, 204);
    assert.equal((await api.get('/central/tarifas', olga)).dados.find((x) => x.categoria === 'comum').km_centavos, 400);
    assert.equal((await api.get('/central/equipe', olga)).status, 403);
    const pass = (await api.get('/central/passageiros?busca=Ana', olga)).dados;
    assert.equal(pass.length, 1);
    assert.equal((await api.post(`/central/contas/${pass[0].id}/ativo`, { ativo: false }, olga)).status, 204);
    assert.equal((await api.get('/passageiro/corridas', passageiro)).status, 401);
    assert.equal((await api.post('/auth/login', { email: 'ana@teste.com', senha: 'senha-da-ana' })).status, 403);
    const aud = (await api.get('/central/auditoria', admin)).dados;
    assert.ok(aud.some((a) => a.acao === 'repasse_pago'));
  });

  await t.test('páginas e cabeçalhos de segurança', async () => {
    for (const p of ['/passageiro/', '/motorista/', '/central/', '/']) {
      const r = await fetch(api.raiz + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-security-policy'), /img-src 'self' data: https:\/\/tile\.openstreetmap\.org/);
    }
    assert.equal((await fetch(`${api.raiz}/vendor/leaflet/leaflet.js`)).status, 200);
    assert.equal((await api.get('/publico')).dados.busca_enderecos, false);
    assert.equal((await api.get('/geo/buscar?q=paulista', admin)).status, 503);
  });
});
