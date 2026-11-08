'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { iniciar } = require('./helpers');
const config = require('../server/config');
const { instrucao } = require('../server/lib/rotas');

// Resposta no formato do OSRM: Sé → Paulista com quatro manobras.
const OSRM = {
  code: 'Ok',
  routes: [{
    distance: 4210.4, duration: 380.2,
    geometry: { type: 'LineString', coordinates: [[-46.6339, -23.5503], [-46.64, -23.553], [-46.65, -23.558], [-46.6559, -23.5614]] },
    legs: [{ steps: [
      { maneuver: { type: 'depart', modifier: 'left', location: [-46.6339, -23.5503] }, name: 'Praça da Sé', distance: 80, duration: 12 },
      { maneuver: { type: 'turn', modifier: 'right', location: [-46.64, -23.553] }, name: 'Rua Direita', distance: 900, duration: 90 },
      { maneuver: { type: 'roundabout', modifier: 'right', exit: 2, location: [-46.65, -23.558] }, name: 'Avenida Paulista', distance: 3230, duration: 278 },
      { maneuver: { type: 'arrive', modifier: 'right', location: [-46.6559, -23.5614] }, name: 'Avenida Paulista', distance: 0, duration: 0 },
    ] }],
  }],
};

test('instruções em português', () => {
  assert.equal(instrucao({ type: 'turn', modifier: 'left' }, 'Rua Augusta'), 'Vire à esquerda na Rua Augusta');
  assert.equal(instrucao({ type: 'turn', modifier: 'slight right' }, 'Av. Rebouças'), 'Mantenha-se à direita na Av. Rebouças');
  assert.equal(instrucao({ type: 'turn', modifier: 'uturn' }, ''), 'Faça o retorno');
  assert.equal(instrucao({ type: 'end of road', modifier: 'right' }, 'Rua A'), 'No fim da via, vire à direita na Rua A');
  assert.equal(instrucao({ type: 'roundabout', exit: 3 }, 'Rua B'), 'Na rotatória, pegue a terceira saída para Rua B');
  assert.equal(instrucao({ type: 'fork', modifier: 'slight left' }, ''), 'Na bifurcação, mantenha-se à esquerda');
  assert.equal(instrucao({ type: 'arrive', modifier: 'left' }, ''), 'Você chegou. O destino está à esquerda');
  assert.equal(instrucao({ type: 'new name', modifier: 'straight' }, 'Rua C'), 'Continue pela Rua C');
  assert.equal(instrucao({ type: 'continue', modifier: 'straight' }, 'Túnel São João Paulo II'), 'Continue pelo Túnel São João Paulo II');
  assert.equal(instrucao({ type: 'turn', modifier: 'right' }, 'Viaduto do Chá'), 'Vire à direita no Viaduto do Chá');
  assert.equal(instrucao({ type: 'turn', modifier: 'left' }, 'SP-280'), 'Vire à esquerda em SP-280');
});

test('rota pelas ruas: navegador do motorista e preço fechado pela distância real', async (t) => {
  const pedidos = [];
  const osrm = http.createServer((req, res) => { pedidos.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(OSRM)); });
  await new Promise((r) => osrm.listen(0, r));
  config.rotas.url = `http://127.0.0.1:${osrm.address().port}`;
  const api = await iniciar();
  t.after(async () => { config.rotas.url = ''; await api.fechar(); osrm.close(); });

  const p = (await api.post('/auth/cadastro', { nome: 'Rui', email: 'rui@teste.com', telefone: '11999990000', senha: 'senha-do-rui' })).dados.token;
  const est = (await api.get('/passageiro/estimativa?olat=-23.5503&olng=-46.6339&dlat=-23.5614&dlng=-46.6559', p)).dados;
  const comum = est.find((e) => e.categoria === 'comum');
  assert.equal(comum.por_ruas, true);
  assert.equal(comum.distancia_m, 4210);
  // O OSRM não considera trânsito: vale o maior entre o tempo dele e a distância na velocidade média (25 km/h).
  assert.equal(comum.duracao_s, Math.round(4210 / (25000 / 3600)));
  const tf = api.db.prepare("SELECT * FROM tarifas WHERE categoria = 'comum'").get();
  assert.equal(comum.valor_centavos, tf.bandeirada_centavos + Math.round((tf.km_centavos * 4210) / 1000) + Math.round((tf.minuto_centavos * comum.duracao_s) / 60));
  assert.match(pedidos[0], /^\/route\/v1\/driving\/-46\.633900,-23\.550300;-46\.655900,-23\.561400\?overview=full&geometries=geojson&steps=true$/);

  const admin = await api.login();
  const m = await api.post('/auth/cadastro-motorista', { nome: 'Lia', email: 'lia@teste.com', telefone: '11988887777', senha: 'senha-da-lia', cpf: '529.982.247-25',
    cnh: '12345678900', cnh_validade: '2031-01-01', chave_pix: 'lia@teste.com', veiculo: { placa: 'LIA1A23', marca_modelo: 'Toyota Corolla', cor: 'Preto', ano: 2022 } });
  await api.post(`/central/motoristas/${m.dados.usuario.id}/situacao`, { situacao: 'aprovado' }, admin);
  const r = (await api.get('/motorista/rota?lat=-23.5503&lng=-46.6339&dlat=-23.5614&dlng=-46.6559', m.dados.token)).dados;
  assert.equal(r.geometria.length, 4);
  assert.deepEqual(r.geometria[0], [-23.5503, -46.6339]);
  assert.deepEqual(r.passos.map((x) => x.instrucao), ['Siga pela Praça da Sé', 'Vire à direita na Rua Direita', 'Na rotatória, pegue a segunda saída para Avenida Paulista',
    'Você chegou. O destino está à direita']);
  assert.deepEqual(r.passos.map((x) => x.seta), ['↑', '↱', '⟳', '🏁']);
  assert.equal((await api.get('/motorista/rota?lat=-23.5503&lng=-46.6339&dlat=-23.5614&dlng=-46.6559', p)).status, 403);

  // Servidor de rotas fora do ar: a estimativa volta para a linha reta e a navegação avisa.
  osrm.close();
  config.rotas.url = 'http://127.0.0.1:1';
  const semRota = (await api.get('/passageiro/estimativa?olat=-23.5503&olng=-46.6339&dlat=-23.55&dlng=-46.66', p)).dados;
  assert.equal(semRota[0].por_ruas, false);
  assert.equal((await api.get('/motorista/rota?lat=-23.5503&lng=-46.6339&dlat=-23.55&dlng=-46.66', m.dados.token)).status, 502);
});
