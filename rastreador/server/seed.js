'use strict';

// Dados de exemplo: 3 empresas com veículos, rastreadores, motoristas, cercas, manutenção e 3 dias de trajetos em São Paulo.
// Uso: npm run seed   (com o servidor parado; recria as empresas de exemplo se já existirem)

const { abrir, agora, transacao } = require('./db');
const { hashSenha } = require('./lib/senha');
const { receber } = require('./lib/posicoes');
const { distancia } = require('./lib/geo');
const { imeiValido } = require('./lib/validacao');

const db = abrir();
const SENHA = hashSenha('demo12345');

// Gerador pseudoaleatório fixo: o mesmo seed gera sempre os mesmos dados.
let semente = 20261024;
const aleatorio = () => ((semente = (semente * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const entre = (a, b) => a + aleatorio() * (b - a);

const EMPRESAS = [
  {
    nome: 'Transportes Rota Sul Ltda', documento: '11222333000181', tipo: 'frota', limite: 15, mensalidade: 5990, email: 'cliente@transportes.demo',
    operador: 'operador@transportes.demo', horario: ['06:00', '20:00'], base: { lat: -23.6505, lng: -46.7256, nome: 'Garagem Santo Amaro' },
    veiculos: [
      { placa: 'RTS1A23', descricao: 'Caminhão 01 · Entregas', tipo: 'caminhao', marca: 'Volkswagen', modelo: 'Delivery 11.180', ano: 2022, limite: 80, km: 182_400 },
      { placa: 'RTS2B34', descricao: 'Caminhão 02 · Entregas', tipo: 'caminhao', marca: 'Mercedes-Benz', modelo: 'Accelo 1016', ano: 2021, limite: 80, km: 214_900 },
      { placa: 'RTS3C45', descricao: 'Van 01 · Expresso', tipo: 'van', marca: 'Renault', modelo: 'Master', ano: 2023, limite: 100, km: 64_200 },
      { placa: 'FRT4567', descricao: 'Utilitário · Supervisão', tipo: 'carro', marca: 'Fiat', modelo: 'Strada', ano: 2020, limite: 110, km: 98_300 },
    ],
    motoristas: [['Carlos Almeida', '52998224725', '2027-05-10'], ['Roberto Lima', '15350946056', '2026-11-05'], ['Ana Souza', '11144477735', '2028-02-20']],
  },
  {
    nome: 'Entrega Já Logística', documento: '45723174000110', tipo: 'frota', limite: 10, mensalidade: 4990, email: 'cliente@entregas.demo',
    base: { lat: -23.5329, lng: -46.6395, nome: 'Centro de distribuição Bom Retiro' },
    veiculos: [
      { placa: 'EJA1D11', descricao: 'Moto 01', tipo: 'moto', marca: 'Honda', modelo: 'CG 160', ano: 2023, limite: 70, km: 22_100 },
      { placa: 'EJA2D22', descricao: 'Moto 02', tipo: 'moto', marca: 'Honda', modelo: 'CG 160', ano: 2023, limite: 70, km: 18_700 },
      { placa: 'EJA3D33', descricao: 'Fiorino 01', tipo: 'van', marca: 'Fiat', modelo: 'Fiorino', ano: 2022, limite: 90, km: 51_000 },
    ],
    motoristas: [['Diego Martins', '39053344705', '2027-09-01'], ['Paulo Henrique', '86288366757', '2027-01-15']],
  },
  {
    nome: 'Marcos Pereira', documento: '74125896352', tipo: 'pessoa', limite: 2, mensalidade: 3990, email: 'cliente@pessoal.demo',
    base: { lat: -23.5874, lng: -46.6576, nome: 'Casa' },
    veiculos: [{ placa: 'MPE2E45', descricao: 'Carro da família', tipo: 'carro', marca: 'Toyota', modelo: 'Corolla', ano: 2021, limite: 0, km: 45_800, celular: true }],
    motoristas: [],
  },
];

/** Trajeto simulado: sai da base, anda em direção a um destino com curvas, para um pouco e volta. Posições a cada 30 s. */
function viagem(inicio, base, { velMax, limite, excesso }) {
  const pontos = [];
  let t = inicio;
  let p = { ...base };
  const destino = { lat: base.lat + entre(-0.06, 0.06), lng: base.lng + entre(-0.07, 0.07) };
  const andar = (alvo) => {
    let curvas = 0;
    while (distancia(p, alvo) > 150 && curvas++ < 400) {
      const rumo = Math.atan2(alvo.lng - p.lng, alvo.lat - p.lat) + entre(-0.6, 0.6);
      let vel = entre(velMax * 0.35, velMax);
      if (excesso && limite && aleatorio() < 0.05) vel = limite + entre(8, 22);
      if (aleatorio() < 0.08) vel = entre(0, 4); // semáforo
      const m = (vel / 3.6) * 30;
      p = { lat: p.lat + (Math.cos(rumo) * m) / 111_195, lng: p.lng + (Math.sin(rumo) * m) / (111_195 * Math.cos((p.lat * Math.PI) / 180)) };
      t += 30_000;
      pontos.push({ ...p, velocidade_kmh: Math.round(vel), curso: Math.round(((rumo * 180) / Math.PI + 360) % 360), ignicao: true, gps_em: new Date(t).toISOString() });
    }
  };
  pontos.push({ ...p, velocidade_kmh: 0, ignicao: true, gps_em: new Date(t).toISOString() });
  andar(destino);
  // Parada no cliente com o motor desligado (posições a cada 5 min, como os rastreadores fazem parados).
  const parada = entre(10, 40) * 60_000;
  for (let s = 0; s < parada; s += 5 * 60_000) { t += 5 * 60_000; pontos.push({ ...p, velocidade_kmh: 0, ignicao: false, gps_em: new Date(t).toISOString() }); }
  t += 60_000;
  pontos.push({ ...p, velocidade_kmh: 0, ignicao: true, gps_em: new Date(t).toISOString() });
  andar(base);
  t += 30_000;
  pontos.push({ ...p, velocidade_kmh: 0, ignicao: false, gps_em: new Date(t).toISOString() });
  return { pontos, fim: t };
}

function apagarExemplos() {
  const ids = db.prepare(`SELECT id FROM empresas WHERE nome IN (${EMPRESAS.map(() => '?').join(', ')})`).all(...EMPRESAS.map((e) => e.nome)).map((x) => x.id);
  for (const id of ids) {
    db.prepare('UPDATE rastreadores SET empresa_id = NULL WHERE empresa_id = ?').run(id);
    for (const t of ['alertas', 'comandos', 'manutencoes', 'compartilhamentos', 'chaves_api', 'auditoria']) db.prepare(`DELETE FROM ${t} WHERE empresa_id = ?`).run(id);
    db.prepare('DELETE FROM cercas WHERE empresa_id = ?').run(id);
    db.prepare('DELETE FROM veiculos WHERE empresa_id = ?').run(id);
    db.prepare('DELETE FROM motoristas WHERE empresa_id = ?').run(id);
    db.prepare('DELETE FROM usuarios WHERE empresa_id = ?').run(id);
    db.prepare('DELETE FROM empresas WHERE id = ?').run(id);
  }
  db.prepare("DELETE FROM rastreadores WHERE imei LIKE '86655708000%' OR imei LIKE 'app-demo%'").run();
}

transacao(db, apagarExemplos);
const agoraMs = Date.now();
// IMEIs de exemplo na faixa do J16 4G, com o dígito verificador certo.
let sequencia = 100;
const proximoImei = () => { const b = `86655708000${sequencia++}`; return [...'0123456789'].map((d) => b + d).find(imeiValido); };
let total = 0;

for (const [i, e] of EMPRESAS.entries()) {
  const eid = transacao(db, () => {
    const id = Number(db.prepare(`INSERT INTO empresas (nome, documento, tipo, email, limite_veiculos, mensalidade_centavos, alertar_ignicao, horario_inicio, horario_fim,
      dias_uso, criada_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.nome, e.documento, e.tipo, e.email, e.limite, e.mensalidade, i === 2 ? 1 : 0,
      e.horario?.[0] ?? null, e.horario?.[1] ?? null, e.horario ? '123456' : '0123456', agora()).lastInsertRowid);
    db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, criado_em) VALUES (?, ?, ?, 'cliente', ?, ?)").run(`Administrador · ${e.nome}`, e.email, SENHA, id, agora());
    if (e.operador) db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, criado_em) VALUES (?, ?, ?, 'operador', ?, ?)").run('Central de monitoramento', e.operador, SENHA, id, agora());
    db.prepare("INSERT INTO cercas (empresa_id, nome, tipo, lat, lng, raio_m, cor, criada_em) VALUES (?, ?, 'circulo', ?, ?, 400, '#20A852', ?)").run(id, e.base.nome, e.base.lat, e.base.lng, agora());
    if (i === 0) {
      const z = (dl, dg) => [Number((e.base.lat + dl).toFixed(6)), Number((e.base.lng + dg).toFixed(6))];
      db.prepare("INSERT INTO cercas (empresa_id, nome, tipo, pontos, alertar_entrada, alertar_saida, cor, criada_em) VALUES (?, 'Área de risco', 'poligono', ?, 1, 0, '#E5484D', ?)")
        .run(id, JSON.stringify([z(0.05, 0.02), z(0.06, 0.06), z(0.03, 0.07), z(0.02, 0.03)]), agora());
    }
    return id;
  });
  const motoristas = e.motoristas.map(([nome, cpf, validade]) => Number(db.prepare(`INSERT INTO motoristas (empresa_id, nome, cpf, cnh, cnh_categoria, cnh_validade, telefone, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(eid, nome, cpf, String(Math.floor(entre(1e10, 9e10))), 'D', validade, `119${Math.floor(entre(1e7, 9e7))}`, agora()).lastInsertRowid));

  for (const [j, x] of e.veiculos.entries()) {
    const id = x.celular ? `app-demo${String(j + 1).padStart(4, '0')}` : proximoImei();
    const rid = Number(db.prepare('INSERT INTO rastreadores (imei, modelo, protocolo, chip_numero, chip_operadora, empresa_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, x.celular ? 'Celular (Traccar Client)' : 'J16 4G', x.celular ? 'osmand' : 'gt06', x.celular ? null : `1199${Math.floor(entre(1e6, 9e6))}`, x.celular ? null : 'Vivo',
        eid, agora()).lastInsertRowid);
    const vid = Number(db.prepare(`INSERT INTO veiculos (empresa_id, placa, descricao, marca, modelo, ano, tipo, rastreador_id, motorista_id, limite_velocidade_kmh, hodometro_m, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(eid, x.placa, x.descricao, x.marca, x.modelo, x.ano, x.tipo, rid, motoristas[j] ?? null, x.limite, x.km * 1000, agora()).lastInsertRowid);
    db.prepare('INSERT INTO manutencoes (empresa_id, veiculo_id, descricao, intervalo_km, intervalo_dias, ultima_km, ultima_data, criada_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(eid, vid, 'Troca de óleo e filtros', x.tipo === 'moto' ? 3000 : 10_000, 180, x.km - Math.floor(entre(2000, x.tipo === 'moto' ? 3200 : 10_500)),
        new Date(agoraMs - entre(30, 170) * 86_400_000).toISOString().slice(0, 10), agora());

    // 3 dias de uso: 2 a 4 viagens por dia em horário comercial; a última termina perto de agora para o mapa ter veículos ao vivo.
    const pontos = [];
    for (let d = 3; d >= 1; d--) {
      let t = agoraMs - d * 86_400_000 - 11 * 3_600_000 + entre(0, 2) * 3_600_000;
      const n = Math.floor(entre(2, 5));
      for (let k = 0; k < n; k++) {
        const v = viagem(t, e.base, { velMax: x.tipo === 'moto' ? 60 : x.tipo === 'caminhao' ? 75 : 85, limite: x.limite, excesso: j % 2 === 0 });
        pontos.push(...v.pontos);
        t = v.fim + entre(20, 90) * 60_000;
      }
    }
    // Hoje: uma viagem em andamento (sem a volta) para os veículos que estão rodando agora.
    if (j !== e.veiculos.length - 1 || i === 2) {
      const v = viagem(agoraMs - entre(40, 90) * 60_000, e.base, { velMax: 70, limite: x.limite, excesso: true });
      pontos.push(...v.pontos.filter((p) => Date.parse(p.gps_em) <= agoraMs - 20_000));
    }
    for (const p of pontos.sort((a, b) => a.gps_em.localeCompare(b.gps_em))) {
      receber(db, { imei: id, protocolo: x.celular ? 'osmand' : 'gt06', ...p });
      total++;
    }
    // O último veículo de cada frota não comunica há 3 h (aparece "sem sinal").
    if (j === e.veiculos.length - 1 && i !== 2) {
      const t = new Date(agoraMs - 3 * 3_600_000).toISOString();
      db.prepare('UPDATE veiculos SET comunicacao_em = ? WHERE id = ?').run(t, vid);
      db.prepare('UPDATE rastreadores SET ultima_comunicacao = ? WHERE id = ?').run(t, rid);
    }
  }
}

// Um pânico e um comando de exemplo na transportadora.
const caminhao = db.prepare("SELECT * FROM veiculos WHERE placa = 'RTS2B34'").get();
receber(db, { imei: db.prepare('SELECT imei FROM rastreadores WHERE id = ?').get(caminhao.rastreador_id).imei, protocolo: 'gt06', evento: 'panico' });
db.prepare(`INSERT INTO comandos (empresa_id, veiculo_id, rastreador_id, tipo, texto, status, criado_em, enviado_em, respondido_em, resposta)
  VALUES (?, ?, ?, 'localizar', 'WHERE#', 'confirmado', ?, ?, ?, 'Lat:S23.65 Lon:W46.72 OK')`).run(caminhao.empresa_id, caminhao.id, caminhao.rastreador_id,
  new Date(agoraMs - 7_200_000).toISOString(), new Date(agoraMs - 7_190_000).toISOString(), new Date(agoraMs - 7_180_000).toISOString());
// Alertas com mais de 12 h já foram vistos pela central.
db.prepare("UPDATE alertas SET tratado_em = ocorrido_em, observacao = 'Verificado pela central.' WHERE ocorrido_em < ? AND tipo <> 'panico'")
  .run(new Date(agoraMs - 12 * 3_600_000).toISOString());
// Um equipamento que tentou enviar sem estar cadastrado.
receber(db, { imei: '866557080099908', protocolo: 'gt06', ip: '177.10.20.30' });

console.log(`Seed concluído: ${EMPRESAS.length} empresas, ${EMPRESAS.reduce((s, e) => s + e.veiculos.length, 0)} veículos, ${total} posições.`);
console.log('Contas (senha demo12345): cliente@transportes.demo, cliente@entregas.demo, cliente@pessoal.demo e operador@transportes.demo (operador).');
