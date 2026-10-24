'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { iniciar } = require('./helpers');
const gt = require('../server/lib/gt06');
const { viagens, paradas, situacaoManutencao } = require('../server/lib/relatorios');
const { dentroPoligono, distancia } = require('../server/lib/geo');
const { foraDoHorario } = require('../server/lib/posicoes');
const { manutencao } = require('../server/lib/manutencao');
const { local } = require('../server/lib/datas');

// IMEI do rastreador J16 4G da etiqueta.
const IMEI = '866557088453933';
const min = (n, base = Date.now()) => new Date(base + n * 60_000).toISOString();
/** Ponto a `metros` ao norte de (lat, lng). */
const norte = (lat, lng, metros) => ({ lat: lat + metros / 111_195, lng });

/** Conteúdo de GPS do GT06 (18 bytes): data UTC, satélites, latitude, longitude, velocidade e curso com os sinais. */
function gpsGt06({ em, lat, lng, vel = 0, curso = 0, valido = true }) {
  const d = new Date(em);
  const b = Buffer.alloc(18);
  b.set([d.getUTCFullYear() - 2000, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), 0xc8], 0);
  b.writeUInt32BE(Math.round(Math.abs(lat) * 1_800_000), 7);
  b.writeUInt32BE(Math.round(Math.abs(lng) * 1_800_000), 11);
  b[15] = vel;
  b.writeUInt16BE((valido ? 0x1000 : 0) | (lat >= 0 ? 0x0400 : 0) | (lng < 0 ? 0x0800 : 0) | curso, 16);
  return b;
}
const loginGt06 = (imei, serial = 1) => gt.quadro(0x01, Buffer.from(`0${imei}`, 'hex'), serial);

test('protocolo GT06: CRC, quadros e decodificação', () => {
  // Exemplo do manual do protocolo: login do IMEI 123456789012345.
  const login = Buffer.from('78780d01012345678901234500018cdd0d0a', 'hex');
  assert.equal(gt.crc16(login.subarray(2, 14)), 0x8cdd);
  assert.deepEqual(gt.quadro(0x01, Buffer.from('0123456789012345', 'hex'), 1), login);
  const { quadros, resto } = gt.extrair(Buffer.concat([Buffer.from([0x00, 0x11]), login, login.subarray(0, 6)]));
  assert.equal(quadros.length, 1);
  assert.equal(resto.length, 6, 'o pedaço incompleto fica para a próxima leitura');
  assert.deepEqual(gt.decodificar(quadros[0]), { tipo: 'login', imei: '123456789012345', fusoMin: 0, ack: true });
  // CRC errado: o quadro é ignorado.
  const ruim = Buffer.from(login);
  ruim[14] ^= 0xff;
  assert.equal(gt.extrair(ruim).quadros.length, 0);

  const em = '2026-10-20T13:45:10.000Z';
  const pos = gt.decodificar(gt.extrair(gt.quadro(0x12, Buffer.concat([gpsGt06({ em, lat: -23.55052, lng: -46.633308, vel: 62, curso: 271 }), Buffer.alloc(8)]), 7)).quadros[0]);
  assert.equal(pos.tipo, 'posicao');
  assert.deepEqual({ ...pos.mensagem }, { gps_em: em, satelites: 8, lat: -23.55052, lng: -46.633308, velocidade_kmh: 62, curso: 271, valido: true });
  // Modelo novo (0x22): ignição depois do LBS.
  const p22 = gt.decodificar(gt.extrair(gt.quadro(0x22, Buffer.concat([gpsGt06({ em, lat: 1, lng: 2 }), Buffer.alloc(8), Buffer.from([1, 0, 0])]), 8)).quadros[0]);
  assert.equal(p22.mensagem.ignicao, true);
  // Estado: ACC ligado, corte de combustível e alarme de pânico (bits 3-5 = 100).
  const est = gt.decodificar(gt.extrair(gt.quadro(0x13, Buffer.from([0x80 | 0x20 | 0x02, 4, 3, 0, 2]), 9)).quadros[0]);
  assert.deepEqual(est.mensagem, { ignicao: true, bloqueado: true, evento: 'panico', tensao: 3.8 });
  // Alarme 0x16 com corte de energia.
  const alarme = Buffer.concat([gpsGt06({ em, lat: 1, lng: 2 }), Buffer.from([9]), Buffer.alloc(8), Buffer.from([0x02, 5, 4, 0x02, 0x02])]);
  assert.equal(gt.decodificar(gt.extrair(gt.quadro(0x16, alarme, 10)).quadros[0]).mensagem.evento, 'bateria_desconectada');
  // Comando: tamanho, identificador, texto e idioma; a resposta 0x15 casa pelo identificador.
  const cmd = gt.extrair(gt.quadroComando(42, 'RELAY,1#', 3)).quadros[0];
  assert.equal(cmd.protocolo, 0x80);
  assert.equal(cmd.conteudo.readUInt32BE(1), 42);
  const resp = Buffer.concat([Buffer.from([4 + 2]), cmd.conteudo.subarray(1, 5), Buffer.from('OK'), Buffer.from([0, 2])]);
  assert.deepEqual(gt.decodificar(gt.extrair(gt.quadro(0x15, resp, 4)).quadros[0]), { tipo: 'resposta', comando: 42, texto: 'OK', ack: false });

  // Modelos 4G (J16 4G): login com o fuso (oeste 3:00 = UTC-3), posição 0xA0 com a célula 4G e a ignição, alarme 0xA4 e tensão (0x94).
  const login4g = Buffer.concat([Buffer.from('0866557088453933', 'hex'), Buffer.from([0x36, 0x08]), Buffer.from([(300 << 4 | 0x08) >> 8, (300 << 4 | 0x08) & 0xff])]);
  const l = gt.decodificar(gt.extrair(gt.quadro(0x01, login4g, 1)).quadros[0]);
  assert.deepEqual([l.imei, l.fusoMin], ['866557088453933', -180]);
  const celula4g = Buffer.concat([Buffer.from([0x02, 0xd4, 0x0b]), Buffer.alloc(4), Buffer.alloc(8)]); // MCC 724 (Brasil), MNC 11
  const a0 = gt.extrair(gt.quadro(0xa0, Buffer.concat([gpsGt06({ em: '2026-10-20T10:45:10Z', lat: -23.5, lng: -46.6, vel: 40 }), celula4g, Buffer.from([1, 0, 0])]), 2)).quadros[0];
  const p4g = gt.decodificar(a0, { fusoMin: -180 });
  assert.equal(p4g.mensagem.gps_em, em, 'hora local (UTC-3) convertida para UTC');
  assert.deepEqual([p4g.mensagem.lat, p4g.mensagem.ignicao, p4g.mensagem.velocidade_kmh], [-23.5, true, 40]);
  const a4 = Buffer.concat([gpsGt06({ em, lat: 1, lng: 2 }), Buffer.from([16]), celula4g, Buffer.from([0x02, 5, 4, 0x01, 0x02, 0x00])]);
  assert.equal(gt.decodificar(gt.extrair(gt.quadro(0xa4, a4, 3)).quadros[0]).mensagem.evento, 'panico');
  const info = gt.decodificar({ protocolo: 0x94, conteudo: Buffer.from([0x00, 0x04, 0xd8]), serial: 1 });
  assert.deepEqual(info.mensagem, { tensao: 12.4 });
  // Quadro longo (79 79, tamanho em 2 bytes).
  const corpo = Buffer.concat([Buffer.from([0x00, 0x08, 0x94]), Buffer.from([0x00, 0x04, 0xd8]), Buffer.from([0x00, 0x05])]);
  const longo = Buffer.concat([Buffer.from([0x79, 0x79]), corpo, Buffer.from([gt.crc16(corpo) >> 8, gt.crc16(corpo) & 0xff]), Buffer.from([0x0d, 0x0a])]);
  assert.equal(gt.extrair(longo).quadros[0].protocolo, 0x94);
});

test('viagens, paradas, cercas, horário e manutenção', () => {
  const t0 = Date.parse('2026-10-20T10:00:00Z');
  const p = (m, metros, vel, ignicao = 1) => ({ ...norte(-23.5, -46.6, metros), velocidade_kmh: vel, ignicao, gps_em: min(m, t0) });
  const pontos = [
    p(0, 0, 0), p(1, 500, 40), p(2, 1500, 60), p(3, 2000, 30), p(4, 2000, 0), // primeira viagem: 2 km
    p(6, 2000, 0), p(10, 2000, 0), // parada de 7 min (3 a 10) com a ignição ligada
    p(11, 2600, 36), p(12, 3200, 36), p(13, 3200, 0, 0), // segunda viagem, encerrada pela ignição
    p(30, 3200, 0, 0),
  ];
  const vs = viagens(pontos, 5);
  assert.equal(vs.length, 2);
  assert.equal(vs[0].inicio, min(0, t0));
  assert.equal(vs[0].fim, min(3, t0));
  assert.ok(Math.abs(vs[0].distancia_m - 2000) < 5, `distância ${vs[0].distancia_m}`);
  assert.equal(vs[0].velocidade_max_kmh, 60);
  assert.equal(vs[1].fim, min(13, t0));
  assert.ok(Math.abs(vs[1].distancia_m - 1200) < 5);
  const ps = paradas(vs, pontos, 5);
  assert.deepEqual(ps.map((x) => x.duracao_s), [7 * 60, 17 * 60]);
  // Oscilação parada do GPS não vira viagem.
  assert.equal(viagens([p(0, 0, 0), p(1, 30, 6), p(2, 0, 0)], 5).length, 0);

  const quadrado = [[0, 0], [0, 1], [1, 1], [1, 0]];
  assert.equal(dentroPoligono({ lat: 0.5, lng: 0.5 }, quadrado), true);
  assert.equal(dentroPoligono({ lat: 1.5, lng: 0.5 }, quadrado), false);
  assert.ok(Math.abs(distancia({ lat: 0, lng: 0 }, norte(0, 0, 1000)) - 1000) < 1);

  // Horário de uso 08:00–18:00 em dias úteis (o teste usa o fuso padrão, America/Sao_Paulo: UTC-3).
  const empresa = { horario_inicio: '08:00', horario_fim: '18:00', dias_uso: '12345' };
  assert.equal(foraDoHorario('2026-10-20T13:00:00Z', empresa), false); // terça, 10:00
  assert.equal(foraDoHorario('2026-10-20T22:30:00Z', empresa), true); // terça, 19:30
  assert.equal(foraDoHorario('2026-10-18T13:00:00Z', empresa), true); // domingo
  assert.equal(foraDoHorario('2026-10-21T02:00:00Z', { horario_inicio: '22:00', horario_fim: '06:00', dias_uso: '0123456' }), false); // 23:00, turno da noite
  assert.equal(foraDoHorario('2026-10-20T13:00:00Z', { horario_inicio: null, horario_fim: null, dias_uso: '' }), false);

  const plano = { intervalo_km: 10_000, intervalo_dias: 180, ultima_km: 50_000, ultima_data: '2026-06-01' };
  assert.equal(situacaoManutencao(plano, 55_000, '2026-07-01').situacao, 'em_dia');
  assert.equal(situacaoManutencao(plano, 59_200, '2026-07-01').situacao, 'proxima');
  assert.equal(situacaoManutencao(plano, 60_000, '2026-07-01').situacao, 'vencida');
  assert.equal(situacaoManutencao(plano, 51_000, '2026-11-28').situacao, 'vencida');
  assert.equal(situacaoManutencao(plano, 51_000, '2026-07-01').proxima_data, '2026-11-28');
});

test('Rastreador', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  const master = await api.login();
  let empresa, outra, cliente, operador, rastreador, veiculo, app, chave;
  const base = () => `/empresas/${empresa}`;
  const veic = () => api.db.prepare('SELECT * FROM veiculos WHERE id = ?').get(veiculo);
  const alertas = (tipo) => api.db.prepare('SELECT * FROM alertas WHERE veiculo_id = ? AND tipo = ? ORDER BY id').all(veiculo, tipo);

  await t.test('master cria empresas, administrador e rastreadores do estoque', async () => {
    assert.equal((await api.post('/master/empresas', { nome: 'X', documento: '11.111.111/1111-11' }, master)).status, 422);
    const r = await api.post('/master/empresas', {
      nome: 'Transportes Rota Ltda', documento: '11.222.333/0001-81', limite_veiculos: 2, mensalidade_centavos: 5990,
      administrador: { nome: 'Gestora', email: 'gestora@rota.com', senha: 'senha-da-gestora' },
    }, master);
    assert.equal(r.status, 201);
    empresa = r.dados.id;
    outra = (await api.post('/master/empresas', { nome: 'Outra' }, master)).dados.id;
    cliente = await api.login('gestora@rota.com', 'senha-da-gestora');
    const x = await api.post('/master/rastreadores', { imei: `IMEI:${IMEI}`, modelo: 'J16 4G', protocolo: 'gt06', chip_numero: '(11) 99999-0000', empresa_id: empresa }, master);
    assert.equal(x.status, 201);
    rastreador = x.dados.id;
    assert.equal((await api.post('/master/rastreadores', { imei: IMEI }, master)).status, 409);
    assert.equal((await api.post('/master/rastreadores', { imei: 'x' }, master)).status, 422);
    const digito = await api.post('/master/rastreadores', { imei: '866557088453934' }, master);
    assert.equal(digito.status, 422, 'IMEI com o dígito verificador errado');
    assert.match(digito.dados.erro, /confira os 15 dígitos/);
    const estoque = (await api.get('/master/rastreadores?situacao=empresa', master)).dados;
    assert.deepEqual(estoque.map((e) => e.imei), [IMEI]);
  });

  await t.test('cliente só acessa a própria empresa', async () => {
    assert.equal((await api.get(`${base()}/dashboard`, cliente)).status, 200);
    assert.equal((await api.get(`/empresas/${outra}/dashboard`, cliente)).status, 404);
    assert.equal((await api.get('/master/empresas', cliente)).status, 403);
    assert.equal((await api.get('/empresas/999/dashboard', master)).status, 404);
  });

  await t.test('veículos: placa válida, rastreador da empresa e limite do plano', async () => {
    assert.equal((await api.post(`${base()}/veiculos`, { placa: 'AB-123' }, cliente)).status, 422);
    const r = await api.post(`${base()}/veiculos`, { placa: 'abc-1d23', descricao: 'Caminhão 01', tipo: 'caminhao', rastreador_id: rastreador, limite_velocidade_kmh: 80,
      hodometro_km: 120_000 }, cliente);
    assert.equal(r.status, 201);
    veiculo = r.dados.id;
    assert.equal(veic().placa, 'ABC1D23');
    assert.equal(veic().hodometro_m, 120_000_000);
    assert.equal((await api.post(`${base()}/veiculos`, { placa: 'ABC1D23' }, cliente)).status, 409);
    // O mesmo rastreador não vai em dois veículos; rastreador de outra empresa não aparece.
    const dois = await api.post(`${base()}/veiculos`, { placa: 'DEF4567', rastreador_id: rastreador }, cliente);
    assert.equal(dois.status, 422);
    assert.match(dois.dados.erro, /outro veículo/);
    const deOutra = (await api.post('/master/rastreadores', { imei: '111122223333442', empresa_id: outra }, master)).dados.id;
    assert.equal((await api.post(`${base()}/veiculos`, { placa: 'DEF4567', rastreador_id: deOutra }, cliente)).status, 422);
    // Celular como rastreador (Traccar Client), cadastrado pela própria empresa.
    app = (await api.post(`${base()}/rastreadores`, {}, cliente)).dados;
    assert.match(app.imei, /^app-\d{10}$/);
    assert.equal((await api.post(`${base()}/veiculos`, { placa: 'DEF4567', descricao: 'Moto', tipo: 'moto', rastreador_id: app.id }, cliente)).status, 201);
    const cheio = await api.post(`${base()}/veiculos`, { placa: 'GHI8901' }, cliente);
    assert.equal(cheio.status, 422);
    assert.match(cheio.dados.erro, /Limite de 2 veículos/);
  });

  await t.test('operador consulta e trata alertas, sem alterar cadastros', async () => {
    assert.equal((await api.post(`${base()}/usuarios`, { nome: 'Op', email: 'op@rota.com', senha: 'senha-do-op', perfil: 'operador' }, cliente)).status, 201);
    assert.equal((await api.post(`${base()}/usuarios`, { nome: 'M', email: 'm@rota.com', senha: 'senha-do-m', perfil: 'master' }, cliente)).status, 422);
    operador = await api.login('op@rota.com', 'senha-do-op');
    assert.equal((await api.get(`${base()}/mapa`, operador)).status, 200);
    assert.equal((await api.post(`${base()}/veiculos`, { placa: 'JKL2345' }, operador)).status, 403);
    assert.equal((await api.post(`${base()}/veiculos/${veiculo}/comandos`, { tipo: 'localizar' }, operador)).status, 403);
    assert.equal((await api.post(`${base()}/alertas/tratar-todos`, {}, operador)).status, 200);
  });

  await t.test('celular (OsmAnd): posições, velocidade em nós, repetidas e salto do GPS', async () => {
    const t0 = Date.now() - 50 * 60_000;
    const lat = -23.55;
    const lng = -46.63;
    assert.equal((await api.osmand({ id: app.imei, lat, lon: lng, timestamp: Math.floor(t0 / 1000), speed: 10, bearing: 90 })).status, 200);
    const moto = api.db.prepare('SELECT * FROM veiculos WHERE placa = ?').get('DEF4567');
    assert.equal(moto.lat, lat);
    assert.equal(Math.round(moto.velocidade_kmh), 19); // 10 nós
    assert.equal(moto.curso, 90);
    // Mesma posição de novo: não duplica.
    await api.osmand({ id: app.imei, lat, lon: lng, timestamp: Math.floor(t0 / 1000), speed: 10 });
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM posicoes WHERE veiculo_id = ?').get(moto.id).n, 1);
    // 50 km em 1 minuto: erro do GPS, descartado.
    const longe = norte(lat, lng, 50_000);
    await api.osmand({ id: app.imei, lat: longe.lat, lon: longe.lng, timestamp: Math.floor(t0 / 1000) + 60 });
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM posicoes WHERE veiculo_id = ?').get(moto.id).n, 1);
    // JSON do Traccar Client novo (velocidade em m/s).
    const perto = norte(lat, lng, 300);
    const r = await fetch(`${api.raiz}/api/osmand`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      device_id: app.imei, location: { timestamp: new Date(t0 + 60_000).toISOString(), coords: { latitude: perto.lat, longitude: perto.lng, speed: 5, heading: 0 } } }) });
    assert.equal(r.status, 200);
    const depois = api.db.prepare('SELECT * FROM veiculos WHERE id = ?').get(moto.id);
    assert.equal(depois.velocidade_kmh, 18);
    assert.ok(Math.abs(depois.hodometro_m - 300) < 2, `hodômetro ${depois.hodometro_m}`);
    // Equipamento desconhecido: aceito (200) e listado para o master cadastrar.
    assert.equal((await api.osmand({ id: 'celular-novo', lat, lon: lng })).status, 200);
    assert.deepEqual((await api.get('/master/desconhecidos', master)).dados.map((d) => d.imei), ['celular-novo']);
    assert.equal((await api.osmand({ lat, lon: lng })).status, 400);
  });

  await t.test('GT06 por TCP: login, posições, alertas e bloqueio confirmado', async () => {
    // Cerca circular de 500 m em volta do pátio e regra de ignição.
    const patio = { lat: -23.6, lng: -46.7 };
    assert.equal((await api.post(`${base()}/cercas`, { nome: 'Pátio', tipo: 'circulo', ...patio, raio_m: 500 }, cliente)).status, 201);
    assert.equal((await api.post(`${base()}/cercas`, { nome: 'Ruim', tipo: 'poligono', pontos: [[1, 1], [2, 2]] }, cliente)).status, 422);
    assert.equal((await api.put(`${base()}/configuracoes`, { alertar_ignicao: true }, cliente)).status, 204);

    const sock = net.connect(api.portaGt06, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    let recebido = Buffer.alloc(0);
    sock.on('data', (d) => { recebido = Buffer.concat([recebido, d]); });
    const esperar = async (cond, ms = 2000) => {
      const fim = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > fim) throw new Error('tempo esgotado');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const enviar = (b) => new Promise((r) => sock.write(b, r));

    // Comando criado antes do login fica pendente e é entregue quando o equipamento conecta.
    const loc = await api.post(`${base()}/veiculos/${veiculo}/comandos`, { tipo: 'localizar' }, cliente);
    assert.equal(loc.status, 201);
    assert.equal(loc.dados.status, 'pendente');

    await enviar(loginGt06(IMEI, 1));
    await esperar(() => gt.extrair(recebido).quadros.length >= 2);
    let qs = gt.extrair(recebido).quadros;
    assert.deepEqual([qs[0].protocolo, qs[0].serial], [0x01, 1], 'confirmação do login');
    assert.equal(qs[1].protocolo, 0x80);
    assert.equal(qs[1].conteudo.subarray(5, qs[1].conteudo.length - 2).toString(), 'WHERE#');
    assert.equal(api.db.prepare('SELECT status FROM comandos WHERE id = ?').get(loc.dados.id).status, 'enviado');
    assert.ok(api.gt06.conectado(IMEI));

    const t0 = Math.floor((Date.now() - 40 * 60_000) / 1000) * 1000; // o GT06 manda a hora em segundos
    const gps = (m, ponto, vel) => gt.quadro(0x12, Buffer.concat([gpsGt06({ em: min(m, t0), lat: ponto.lat, lng: ponto.lng, vel }), Buffer.alloc(8)]), 10 + m);
    const estado = (ignicao, serial) => gt.quadro(0x13, Buffer.from([0x40 | (ignicao ? 0x02 : 0), 5, 4, 0, 2]), serial);
    await enviar(estado(false, 2));
    await enviar(gps(0, patio, 0)); // dentro do pátio, desligado
    await enviar(estado(true, 3)); // ligou
    await enviar(gps(1, norte(patio.lat, patio.lng, 300), 40));
    await enviar(gps(2, norte(patio.lat, patio.lng, 1500), 95)); // saiu da cerca acima do limite (80)
    await enviar(gps(3, norte(patio.lat, patio.lng, 3000), 100)); // continua em excesso: não repete
    await enviar(gps(4, norte(patio.lat, patio.lng, 4000), 60));
    await esperar(() => veic().posicao_em === min(4, t0));

    const v = veic();
    assert.equal(v.ignicao, 1);
    assert.equal(v.velocidade_kmh, 60);
    assert.ok(Math.abs(v.hodometro_m - 120_000_000 - 4000) < 5, `hodômetro ${v.hodometro_m}`);
    assert.equal(alertas('ignicao_ligada').length, 1);
    assert.equal(alertas('cerca_saida').length, 1);
    assert.equal(alertas('cerca_entrada').length, 0, 'a primeira posição só registra onde o veículo está');
    const vel = alertas('velocidade');
    assert.equal(vel.length, 1);
    assert.match(vel[0].mensagem, /95 km\/h \(limite 80/);
    const uso = api.db.prepare('SELECT * FROM uso_diario WHERE veiculo_id = ?').all(veiculo);
    assert.equal(uso.reduce((s, x) => s + x.posicoes, 0), 5);
    assert.equal(uso.reduce((s, x) => s + x.ligado_s, 0), 4 * 60, "ligado desde a mensagem de estado, antes da posição 1");

    // Botão de pânico pelo estado do terminal: um alerta, mesmo com o alarme repetido.
    await enviar(gt.quadro(0x13, Buffer.from([0x20 | 0x02, 5, 4, 0, 2]), 30));
    await enviar(gt.quadro(0x13, Buffer.from([0x20 | 0x02, 5, 4, 0, 2]), 31));
    await esperar(() => alertas('panico').length === 1);

    // Bloqueio: exige digitar a placa; o equipamento conectado recebe na hora e a resposta confirma.
    assert.equal((await api.post(`${base()}/veiculos/${veiculo}/comandos`, { tipo: 'bloquear' }, cliente)).status, 422);
    const antes = gt.extrair(recebido).quadros.length;
    const bl = await api.post(`${base()}/veiculos/${veiculo}/comandos`, { tipo: 'bloquear', confirmacao: 'abc-1d23' }, cliente);
    assert.equal(bl.status, 201);
    await esperar(() => gt.extrair(recebido).quadros.slice(antes).some((q) => q.protocolo === 0x80));
    qs = gt.extrair(recebido).quadros.slice(antes).filter((q) => q.protocolo === 0x80);
    const id = qs[0].conteudo.readUInt32BE(1);
    assert.equal(id, bl.dados.id);
    assert.equal(qs[0].conteudo.subarray(5, qs[0].conteudo.length - 2).toString(), 'RELAY,1#');
    const texto = Buffer.from('Cut off the fuel supply: Success!');
    await enviar(gt.quadro(0x15, Buffer.concat([Buffer.from([4 + texto.length]), qs[0].conteudo.subarray(1, 5), texto, Buffer.from([0, 2])]), 40));
    await esperar(() => veic().bloqueado === 1);
    const c = api.db.prepare('SELECT * FROM comandos WHERE id = ?').get(id);
    assert.equal(c.status, 'confirmado');
    assert.equal(c.resposta, 'Cut off the fuel supply: Success!');
    // Consulta de estado do J16: o texto do modelo (STATUS#) e a resposta guardada no comando.
    const st = await api.post(`${base()}/veiculos/${veiculo}/comandos`, { tipo: 'status' }, cliente);
    assert.equal(st.status, 201);
    await esperar(() => gt.extrair(recebido).quadros.some((q) => q.protocolo === 0x80 && q.conteudo.readUInt32BE(1) === st.dados.id));
    const qst = gt.extrair(recebido).quadros.find((q) => q.protocolo === 0x80 && q.conteudo.readUInt32BE(1) === st.dados.id);
    assert.equal(qst.conteudo.subarray(5, qst.conteudo.length - 2).toString(), 'STATUS#');
    const txt = Buffer.from('Battery:100%; GPRS:Link Up; GSM Signal:4; GPS:Successful positioning');
    await enviar(gt.quadro(0x15, Buffer.concat([Buffer.from([4 + txt.length]), qst.conteudo.subarray(1, 5), txt]), 41));
    await esperar(() => api.db.prepare('SELECT status FROM comandos WHERE id = ?').get(st.dados.id).status === 'confirmado');
    // Posição 4G (0xA0) com a ignição desligada no fim do quadro.
    const cel = Buffer.concat([Buffer.from([0x02, 0xd4, 0x0b]), Buffer.alloc(12)]);
    await enviar(gt.quadro(0xa0, Buffer.concat([gpsGt06({ em: min(5, t0), lat: norte(patio.lat, patio.lng, 4100).lat, lng: patio.lng, vel: 0 }), cel, Buffer.from([0, 0, 0])]), 42));
    await esperar(() => veic().posicao_em === min(5, t0));
    assert.equal(veic().ignicao, 0);
    // Celular não recebe comandos.
    const moto = api.db.prepare('SELECT id FROM veiculos WHERE placa = ?').get('DEF4567').id;
    assert.equal((await api.post(`${base()}/veiculos/${moto}/comandos`, { tipo: 'localizar' }, cliente)).status, 422);
    sock.destroy();
    await esperar(() => !api.gt06.conectado(IMEI));
  });

  await t.test('mapa, percurso, relatórios e alertas', async () => {
    const mapa = (await api.get(`${base()}/mapa`, operador)).dados;
    const v = mapa.veiculos.find((x) => x.id === veiculo);
    assert.equal(v.situacao, 'parado', 'a última posição (0xA0) chegou parada e desligada');
    assert.equal(v.bloqueado, 1);
    assert.equal(mapa.cercas.length, 1);

    const p = (await api.get(`${base()}/veiculos/${veiculo}/percurso`, cliente)).dados;
    assert.equal(p.pontos.length, 6);
    assert.equal(p.viagens.length, 1);
    assert.equal(p.viagens[0].em_andamento, false, 'a ignição desligada encerrou a viagem');
    assert.equal(p.velocidade_max_kmh, 100);
    assert.ok(p.alertas.length >= 3);
    assert.equal((await api.get(`${base()}/veiculos/${veiculo}/percurso?de=2026-01-01&ate=2026-01-30`, cliente)).status, 422);

    const resumo = (await api.get(`${base()}/relatorios/resumo`, cliente)).dados;
    const linha = resumo.linhas.find((x) => x.id === veiculo);
    assert.ok(Math.abs(linha.distancia_m - 4100) < 5);
    assert.equal(linha.excessos, 1);
    assert.equal(linha.velocidade_max_kmh, 100);
    const arquivo = await api.get(`${base()}/relatorios/resumo?csv=1`, cliente);
    assert.match(arquivo.headers.get('content-type'), /text\/csv/);
    assert.match(arquivo.dados, /ABC1D23;Caminhão 01;;4,1;/);
    const viag = (await api.get(`${base()}/relatorios/viagens?veiculo_id=${veiculo}`, cliente)).dados;
    assert.equal(viag.viagens.length, 1);

    const pend = (await api.get(`${base()}/alertas`, operador)).dados;
    assert.ok(pend.every((a) => !a.tratado_em));
    const panico = pend.find((a) => a.tipo === 'panico');
    assert.equal((await api.post(`${base()}/alertas/${panico.id}/tratar`, { observacao: 'Falso alarme, motorista confirmou.' }, operador)).status, 204);
    assert.equal((await api.post(`${base()}/alertas/${panico.id}/tratar`, {}, operador)).status, 404);
    const tratados = (await api.get(`${base()}/alertas?status=tratados`, cliente)).dados;
    assert.deepEqual(tratados.map((a) => a.tratado_por_nome), ['Op']);
    const dash = (await api.get(`${base()}/dashboard`, cliente)).dados;
    assert.equal(dash.veiculos.total, 2);
    assert.equal(dash.veiculos.bloqueados, 1);
    assert.equal(dash.alertas_pendentes, pend.length - 1);
  });

  await t.test('uso fora do horário e sem comunicação', async () => {
    // Horário de uso que não inclui agora: a próxima posição com o veículo ligado gera um alerta (uma vez).
    const h = local().hora;
    const hh = (n) => `${String((h + n) % 24).padStart(2, '0')}:00`;
    assert.equal((await api.put(`${base()}/configuracoes`, { horario_inicio: hh(2), horario_fim: hh(3), dias_uso: '0123456' }, cliente)).status, 204);
    const { receber } = require('../server/lib/posicoes');
    const ultimo = veic();
    const prox = norte(ultimo.lat, ultimo.lng, 200);
    receber(api.db, { imei: IMEI, protocolo: 'gt06', ...prox, velocidade_kmh: 40, ignicao: true, gps_em: min(-1) });
    receber(api.db, { imei: IMEI, protocolo: 'gt06', ...norte(prox.lat, prox.lng, 200), velocidade_kmh: 40, ignicao: true, gps_em: min(0) });
    assert.equal(alertas('fora_horario').length, 1);
    // Sem comunicar além do tempo da empresa: um alerta, e só de novo depois de voltar a comunicar.
    api.db.prepare('UPDATE veiculos SET comunicacao_em = ? WHERE id = ?').run(min(-200), veiculo);
    assert.equal(manutencao(api.db).sem_comunicacao, 1);
    assert.equal(manutencao(api.db).sem_comunicacao, 0);
    assert.match(alertas('sem_comunicacao')[0].mensagem, /há 3 h/);
  });

  await t.test('API de integração: frota, posições de outro sistema e comandos', async () => {
    chave = (await api.post(`${base()}/chaves`, { nome: 'ERP' }, cliente)).dados.chave;
    assert.match(chave, /^rst_[0-9a-f]{8}_/);
    const i = api.integracao(chave);
    assert.equal((await api.integracao('rst_00000000_xxxxxxxxxxxxxxxxxxxxxxxx').get('/veiculos')).status, 401);
    const frota = (await i.get('/veiculos')).dados;
    assert.deepEqual(frota.map((x) => x.placa).sort(), ['ABC1D23', 'DEF4567']);
    assert.equal(frota.find((x) => x.placa === 'ABC1D23').bloqueado, true);
    const pos = (await i.get(`/veiculos/ABC1D23/posicoes?de=${min(-120)}`)).dados;
    assert.equal(pos.length, 8);

    // Rastreador do protocolo "api" (outro sistema entrega as posições e os comandos).
    const gw = (await api.post('/master/rastreadores', { imei: 'gw-0001', protocolo: 'api', empresa_id: empresa }, master)).dados.id;
    const moto = api.db.prepare('SELECT id FROM veiculos WHERE placa = ?').get('DEF4567').id;
    assert.equal((await api.put(`${base()}/veiculos/${moto}`, { rastreador_id: gw }, cliente)).status, 204);
    const lote = await i.post('/posicoes', [
      { imei: 'gw-0001', lat: -23.548, lng: -46.631, velocidade_kmh: 30, ignicao: true, gps_em: min(-2) },
      { imei: 'gw-0001', lat: -23.548, lng: -46.631, velocidade_kmh: 30, ignicao: true, gps_em: min(-2) },
      { imei: 'nao-cadastrado-01', lat: 1, lng: 1 },
      { lat: 1, lng: 1 },
    ]);
    assert.equal(lote.status, 200);
    assert.deepEqual(lote.dados.resultado.map((x) => x.status), ['gravada', 'repetida', 'desconhecido', 'invalida']);
    const c = (await api.post(`${base()}/veiculos/${moto}/comandos`, { tipo: 'desbloquear' }, cliente)).dados;
    const pend = (await i.get('/comandos')).dados;
    assert.deepEqual(pend.map((x) => [x.id, x.texto, x.imei]), [[c.id, 'desbloquear', 'gw-0001']]);
    assert.equal((await i.get('/comandos')).dados.length, 0, 'devolvido uma vez só');
    assert.equal((await i.post(`/comandos/${c.id}`, { sucesso: true, resposta: 'ok' })).status, 200);
    assert.equal(api.db.prepare('SELECT status FROM comandos WHERE id = ?').get(c.id).status, 'confirmado');
    assert.equal((await i.post(`/comandos/${c.id}`, { sucesso: true })).status, 404);
    assert.ok((await i.get(`/alertas?desde=${min(-600)}`)).dados.length >= 4);
  });

  await t.test('link de localização compartilhada', async () => {
    const r = await api.post(`${base()}/veiculos/${veiculo}/compartilhar`, { horas: 2 }, cliente);
    assert.equal(r.status, 201);
    const pub = await api.get(`/publico/compartilhado/${r.dados.codigo}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.dados.placa, 'ABC1D23');
    assert.equal(typeof pub.dados.lat, 'number');
    assert.ok(!('imei' in pub.dados));
    assert.equal((await api.get('/publico/compartilhado/codigo-errado')).status, 404);
    const link = (await api.get(`${base()}/veiculos/${veiculo}`, cliente)).dados.compartilhamentos[0];
    assert.equal((await api.del(`${base()}/compartilhamentos/${link.id}`, undefined, cliente)).status, 204);
    assert.equal((await api.get(`/publico/compartilhado/${r.dados.codigo}`)).status, 404);
  });

  await t.test('manutenção e motoristas', async () => {
    const m = await api.post(`${base()}/manutencoes`, { veiculo_id: veiculo, descricao: 'Troca de óleo', intervalo_km: 10_000, ultima_km: 110_000 }, cliente);
    assert.equal(m.status, 201);
    assert.equal((await api.post(`${base()}/manutencoes`, { veiculo_id: veiculo, descricao: 'Sem intervalo' }, cliente)).status, 422);
    let planos = (await api.get(`${base()}/manutencoes`, cliente)).dados.planos;
    assert.equal(planos[0].situacao, 'vencida');
    assert.equal((await api.post(`${base()}/manutencoes/${m.dados.id}/realizar`, { custo_centavos: 45_000 }, cliente)).status, 204);
    const lista = (await api.get(`${base()}/manutencoes`, cliente)).dados;
    planos = lista.planos;
    assert.equal(planos[0].situacao, 'em_dia');
    assert.equal(planos[0].ultima_km, 120_004);
    assert.equal(lista.registros[0].custo_centavos, 45_000);

    assert.equal((await api.post(`${base()}/motoristas`, { nome: 'João', cpf: '111.111.111-11' }, cliente)).status, 422);
    const mot = await api.post(`${base()}/motoristas`, { nome: 'João Silva', cpf: '529.982.247-25', cnh_validade: '2026-10-01', telefone: '11988887777' }, cliente);
    assert.equal(mot.status, 201);
    assert.equal((await api.put(`${base()}/veiculos/${veiculo}`, { motorista_id: mot.dados.id }, cliente)).status, 204);
    const dash = (await api.get(`${base()}/dashboard`, cliente)).dados;
    assert.deepEqual(dash.cnh.map((x) => x.nome), ['João Silva'], 'CNH vencida aparece no dashboard');
    assert.equal((await api.get(`${base()}/mapa`, cliente)).dados.veiculos.find((x) => x.id === veiculo).motorista, 'João Silva');
  });

  await t.test('bloqueio da empresa e exclusão', async () => {
    assert.equal((await api.post(`/master/empresas/${empresa}/bloquear`, { motivo: 'Inadimplente' }, master)).status, 204);
    assert.equal((await api.get(`${base()}/mapa`, cliente)).status, 401);
    const antes = api.db.prepare('SELECT COUNT(*) AS n FROM posicoes').get().n;
    await api.osmand({ id: app.imei, lat: -23.5, lon: -46.6 });
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM posicoes').get().n, antes, 'empresa bloqueada não grava posições');
    assert.equal((await api.post(`/master/empresas/${empresa}/desbloquear`, {}, master)).status, 204);
    const dash = (await api.get('/master/dashboard', master)).dados;
    assert.equal(dash.faturamento_mensal_centavos, 2 * 5990);
    assert.equal(dash.desconhecidos, 1);
    assert.equal((await api.get('/master/diagnostico', master)).status, 200);
    assert.equal((await api.del(`/master/empresas/${empresa}`, { confirmacao: 'errado' }, master)).status, 422);
    assert.equal((await api.del(`/master/empresas/${empresa}`, { confirmacao: 'Transportes Rota Ltda' }, master)).status, 204);
    assert.equal(api.db.prepare('SELECT empresa_id FROM rastreadores WHERE id = ?').get(rastreador).empresa_id, null, 'rastreador volta ao estoque');
    assert.equal((await api.integracao(chave).get('/veiculos')).status, 401);
  });
});
