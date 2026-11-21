'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { criarRouterOsFalso } = require('./routeros-falso');
const pano = require('../server/lib/panorama');
const prov = require('../server/lib/provisionamento');
const fat = require('../server/lib/faturamento');
const { dataLocal } = require('../server/lib/datas');

const HOJE = dataLocal('America/Sao_Paulo');
const RETRASADA = fat.somarMeses(fat.competenciaDe(HOJE), -2);
const ORG = 1;

// Praia Grande, litoral paulista: coordenadas plausíveis e próximas, para a área e a distância fazerem sentido.
const PG = { lat: -24.0058, lng: -46.4028 };
const perto = (i) => ({ latitude: PG.lat + i * 0.0012, longitude: PG.lng + i * 0.0012 });

/** Carteira com coordenadas, concentrador falso e serviços provisionados. */
async function cenario(api) {
  const admin = await api.login();
  const tk = { admin };
  for (const perfil of ['financeiro', 'noc', 'gestor', 'tecnico']) {
    const r = await api.post('/organizacao/usuarios', { nome: `U ${perfil}`, email: `${perfil}.pan@teste.local`, senha: 'senha-teste-123', perfil }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    tk[perfil] = await api.login(`${perfil}.pan@teste.local`, 'senha-teste-123');
  }
  const roteador = criarRouterOsFalso();
  const { host, porta } = await roteador.iniciar();

  const pop = (await api.post('/rede/ativos', { tipo: 'pop', codigo: 'POP-01', nome: 'POP Centro', lat: PG.lat, lng: PG.lng }, tk.noc)).dados;
  const equipamento = (await api.post('/rede/equipamentos', { tipo: 'roteador', nome: 'BRAS-01', ativo_id: pop.id, fabricante: 'MikroTik' }, tk.noc)).dados;
  assert.equal((await api.put(`/provisionamento/equipamentos/${equipamento.id}/acesso`,
    { driver: 'mikrotik_routeros', papel: 'concentrador', host, porta, protocolo: 'http', usuario: 'admin', senha: 'senha-do-roteador' }, admin)).status, 200);

  // Duas caixas: uma com porta livre, outra lotada — é o que a viabilidade precisa distinguir.
  const cheia = (await api.post('/rede/ativos', { tipo: 'cto', codigo: 'CTO-CHEIA', lat: PG.lat + 0.0005, lng: PG.lng, capacidade: 2 }, tk.noc)).dados;
  const livre = (await api.post('/rede/ativos', { tipo: 'cto', codigo: 'CTO-LIVRE', lat: PG.lat + 0.0010, lng: PG.lng, capacidade: 8 }, tk.noc)).dados;

  const plano = (await api.post('/planos', { nome: 'Fibra 500', tipo: 'internet', tecnologia: 'fibra', download_mbps: 500, upload_mbps: 250, mensalidade: '100,00' }, tk.financeiro)).dados;

  const carteira = [];
  const DOCS = ['390.533.447-05', '528.713.260-37', '693.419.080-78', '040.981.520-96', '370.527.980-77'];
  for (const [i, documento] of DOCS.entries()) {
    const criar = async (caminho, corpo, esperado = 201) => {
      const r = await api.post(caminho, corpo, tk.financeiro);
      assert.equal(r.status, esperado, `${caminho}: ${JSON.stringify(r.dados)}`);
      return r.dados;
    };
    const assinante = await criar('/assinantes', {
      tipo: 'pf', nome: `Assinante ${i + 1}`, documento, telefone: `139999900${i}${i}`,
      logradouro: 'Rua do Mar', numero: String(100 + i), bairro: i < 3 ? 'Centro' : 'Boqueirão', cidade: 'Praia Grande', uf: 'SP',
      ...perto(i),
    });
    const contrato = await criar('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 10, ...perto(i) });
    await criar(`/contratos/${contrato.id}/ativar`, { ativacao: `${RETRASADA}-01` }, 200);
    const sv = await api.put(`/provisionamento/contratos/${contrato.id}/servico`, { concentrador_id: equipamento.id, tipo_acesso: 'pppoe', login: `cliente${i + 1}` }, tk.financeiro);
    assert.ok([200, 201].includes(sv.status), JSON.stringify(sv.dados));
    carteira.push({ assinante, contrato, login: `cliente${i + 1}` });
  }
  return { tk, admin, roteador, equipamento, plano, carteira, ctos: { cheia, livre } };
}

test('panorama: o mapa só pinta o que foi lido de verdade', async (t) => {
  const api = await iniciar();
  const c = await cenario(api);
  t.after(async () => { await c.roteador.fechar(); await api.fechar(); });

  await t.test('sem nenhuma leitura, ninguém é verde nem vermelho', async () => {
    const r = await api.get('/panorama/pontos', c.tk.noc);
    assert.equal(r.status, 200);
    assert.equal(r.dados.pontos.length, 5);
    assert.equal(r.dados.por_estado.nunca_lido, 5, 'todos começam como "não sei"');
    assert.equal(r.dados.por_estado.conectado ?? 0, 0);
    assert.equal(r.dados.por_estado.sem_conexao ?? 0, 0);
    for (const p of r.dados.pontos) assert.match(p.motivo, /Nunca lido/i);
  });

  await t.test('a varredura lê o concentrador uma vez e atualiza a carteira inteira', async () => {
    c.roteador.conectar('cliente1');
    c.roteador.conectar('cliente2');
    c.roteador.conectar('cliente3');
    c.roteador.limparChamadas();

    const r = await api.post('/panorama/varredura', {}, c.tk.noc);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.servicos, 5);
    assert.equal(r.dados.aviso, null);

    const leituras = c.roteador.chamadas.filter((x) => x.caminho === '/rest/ppp/active');
    assert.equal(leituras.length, 1, 'uma chamada por concentrador, não uma por assinante');
    assert.equal(c.roteador.escritas().length, 0, 'varredura não escreve nada no equipamento');

    const pontos = (await api.get('/panorama/pontos', c.tk.noc)).dados;
    assert.equal(pontos.por_estado.conectado, 3);
    assert.equal(pontos.por_estado.sem_conexao, 2);
    const p1 = pontos.pontos.find((p) => p.login === 'cliente1');
    assert.equal(p1.estado, 'conectado');
    assert.equal(p1.atencao, false);
    const p4 = pontos.pontos.find((p) => p.login === 'cliente4');
    assert.equal(p4.estado, 'sem_conexao');
    assert.equal(p4.atencao, true, 'contrato ativo e fora do ar pede ação');
  });

  await t.test('queda e volta viram eventos, com o tempo fora do ar medido', async () => {
    c.roteador.desconectar('cliente1');
    assert.equal((await api.post('/panorama/varredura', {}, c.tk.noc)).dados.caiu, 1);
    const caiu = (await api.get(`/panorama/contratos/${c.carteira[0].contrato.id}`, c.tk.noc)).dados;
    assert.equal(caiu.estado, 'sem_conexao');
    assert.equal(caiu.quedas_hoje, 1);
    assert.equal(caiu.historico[0].evento, 'caiu');

    c.roteador.conectar('cliente1');
    assert.equal((await api.post('/panorama/varredura', {}, c.tk.noc)).dados.voltou, 1);
    const voltou = (await api.get(`/panorama/contratos/${c.carteira[0].contrato.id}`, c.tk.noc)).dados;
    assert.equal(voltou.estado, 'conectado');
    assert.equal(voltou.quedas_hoje, 1, 'voltar não apaga a queda que já aconteceu');
    assert.equal(voltou.historico[0].evento, 'voltou');
    assert.equal(typeof voltou.historico[0].duracao_s, 'number', 'o tempo fora do ar fica medido, não estimado');
  });

  await t.test('varredura sem mudança não gera evento nenhum', async () => {
    const antes = (await api.get(`/panorama/contratos/${c.carteira[0].contrato.id}`, c.tk.noc)).dados.historico.length;
    const r = await api.post('/panorama/varredura', {}, c.tk.noc);
    assert.equal(r.dados.caiu, 0);
    assert.equal(r.dados.voltou, 0);
    const depois = (await api.get(`/panorama/contratos/${c.carteira[0].contrato.id}`, c.tk.noc)).dados.historico.length;
    assert.equal(depois, antes, 'o histórico guarda transições, não leituras');
  });

  await t.test('CONCENTRADOR MUDO NÃO PINTA NINGUÉM DE VERMELHO', async () => {
    const antes = (await api.get('/panorama/pontos', c.tk.noc)).dados.por_estado;
    await c.roteador.fechar();

    const r = await api.post('/panorama/varredura', {}, c.tk.noc);
    assert.equal(r.status, 200);
    assert.ok(r.dados.aviso, 'a tela precisa dizer que a varredura falhou');
    assert.match(r.dados.aviso, /não respondeu/i);
    assert.equal(r.dados.concentradores[0].ok, false);

    const depois = (await api.get('/panorama/pontos', c.tk.noc)).dados.por_estado;
    assert.deepEqual(depois, antes, 'equipamento mudo não é prova de que ninguém está conectado');
  });

  await t.test('leitura velha deixa de valer como "agora"', async () => {
    // Envelhece a leitura no banco: é o que acontece quando a varredura para de rodar.
    api.db.prepare("UPDATE servicos SET conexao_em = ? WHERE organizacao_id = ?").run('2020-01-01T00:00:00.000Z', ORG);
    const r = await api.get('/panorama/pontos', c.tk.noc);
    assert.equal(r.dados.por_estado.conectado ?? 0, 0, 'nada continua verde com leitura de 2020');
    assert.equal(r.dados.por_estado.leitura_antiga, 5);
    const p = r.dados.pontos[0];
    assert.match(p.motivo, /velha demais/i);
    assert.ok(['conectado', 'sem_conexao'].includes(p.era), 'a tela ainda pode dizer o que a última leitura dizia');
  });

  await t.test('contrato bloqueado por inadimplência não é tratado como defeito', async () => {
    api.db.prepare("UPDATE servicos SET conexao_em = ? WHERE organizacao_id = ?").run(new Date().toISOString(), ORG);
    const alvo = c.carteira[4].contrato.id;
    const bloqueio = await api.post(`/cobranca/contratos/${alvo}/bloquear`, { tipo: 'inadimplencia', motivo: 'Inadimplência de teste' }, c.tk.admin);
    assert.equal(bloqueio.status, 201, JSON.stringify(bloqueio.dados));
    const r = await api.get('/panorama/pontos', c.tk.noc);
    const p = r.dados.pontos.find((x) => x.contrato_id === alvo);
    assert.equal(p.estado, 'bloqueado');
    assert.equal(p.atencao, false, 'corte por falta de pagamento não é chamado técnico');
    assert.match(p.motivo, /esperado/i);
  });
});

test('panorama: área, viabilidade, calor e quem fica fora do mapa', async (t) => {
  const api = await iniciar();
  const c = await cenario(api);
  t.after(async () => { await c.roteador.fechar(); await api.fechar(); });
  c.roteador.conectar('cliente1');
  await api.post('/panorama/varredura', {}, c.tk.noc);

  // Um polígono generoso em volta dos três primeiros pontos.
  const area = [
    { lat: PG.lat - 0.0005, lng: PG.lng - 0.0005 },
    { lat: PG.lat - 0.0005, lng: PG.lng + 0.0030 },
    { lat: PG.lat + 0.0030, lng: PG.lng + 0.0030 },
    { lat: PG.lat + 0.0030, lng: PG.lng - 0.0005 },
  ];

  await t.test('a área soma quem está dentro, separando defeito de corte e de "não sei"', async () => {
    const r = await api.post('/panorama/area', { area }, c.tk.noc);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.assinantes, 3, 'três pontos dentro do polígono');
    assert.equal(r.dados.conectados, 1);
    assert.equal(r.dados.sem_conexao, 2);
    assert.equal(r.dados.mensalidade_centavos, 30000, 'três contratos de R$ 100,00');
    assert.equal(r.dados.itens[0].atencao, true, 'quem precisa de ação vem primeiro');
  });

  await t.test('área com menos de três pontos é recusada', async () => {
    const r = await api.post('/panorama/area', { area: [{ lat: -24, lng: -46 }, { lat: -24.1, lng: -46.1 }] }, c.tk.noc);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /três pontos/i);
  });

  await t.test('incidente aberto pela área já nasce com a conta do estrago', async () => {
    const r = await api.post('/panorama/area/incidente', { area, titulo: 'Queda no Centro', severidade: 'alta' }, c.tk.noc);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.impacto.assinantes, 3);
    assert.equal(r.dados.impacto.sem_conexao, 2);

    const inc = (await api.get(`/noc/incidentes/${r.dados.id}`, c.tk.noc)).dados;
    assert.equal(inc.titulo, 'Queda no Centro');
    const ev = inc.evidencias;
    assert.equal(ev.origem, 'panorama');
    assert.equal(ev.assinantes_na_area, 3);
    assert.equal(ev.area.length, 4, 'a área desenhada fica guardada no incidente');
  });

  await t.test('viabilidade: caixa com porta livre vem na frente, e a ressalva vem junto', async () => {
    const r = await api.get(`/panorama/viabilidade?lat=${PG.lat}&lng=${PG.lng}&raio_m=400`, c.tk.noc);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.atendivel, true);
    const codigos = r.dados.caixas.map((x) => x.codigo);
    assert.ok(codigos.includes('CTO-LIVRE'));
    assert.ok(r.dados.caixas.every((x) => x.distancia_m <= 400));
    // Ordenadas por distância: a mais perto primeiro.
    assert.deepEqual([...r.dados.caixas].sort((a, b) => a.distancia_m - b.distancia_m).map((x) => x.codigo), codigos);
    assert.match(r.dados.ressalva, /linha reta/i);
    assert.match(r.dados.ressalva, /n[ãa]o|nunca/i);
  });

  await t.test('viabilidade sem caixa perto responde que não tem, em vez de inventar', async () => {
    const r = await api.get('/panorama/viabilidade?lat=-23.5&lng=-46.6&raio_m=500', c.tk.noc);
    assert.equal(r.dados.atendivel, false);
    assert.equal(r.dados.caixas.length, 0);
    assert.match(r.dados.resumo, /Nenhuma caixa/i);
  });

  await t.test('coordenada inválida é recusada', async () => {
    assert.equal((await api.get('/panorama/viabilidade?lat=200&lng=0', c.tk.noc)).status, 422);
    assert.equal((await api.get('/panorama/viabilidade', c.tk.noc)).status, 422);
  });

  await t.test('mapa de calor conta queda observada, e diz o que não conta', async () => {
    c.roteador.desconectar('cliente1');
    await api.post('/panorama/varredura', {}, c.tk.noc);
    const r = await api.get('/panorama/calor?dias=7&celula_m=250', c.tk.noc);
    assert.equal(r.status, 200);
    assert.equal(r.dados.quedas, 1);
    assert.equal(r.dados.assinantes_afetados, 1);
    assert.equal(r.dados.celulas.length, 1);
    assert.equal(r.dados.celulas[0].intensidade, 1);
    assert.match(r.dados.ressalva, /nunca leu/i, 'a ausência de mancha não pode ser lida como ausência de problema');
  });

  await t.test('quem não tem coordenada não some: é contado e listado', async () => {
    const assinante = (await api.post('/assinantes', { tipo: 'pj', nome: 'Sem Coordenada LTDA', documento: '11.222.333/0001-81' }, c.tk.financeiro)).dados;
    const contrato = (await api.post('/contratos', { assinante_id: assinante.id, plano_id: c.plano.id, dia_vencimento: 10 }, c.tk.financeiro)).dados;
    await api.post(`/contratos/${contrato.id}/ativar`, { ativacao: `${RETRASADA}-01` }, c.tk.financeiro);

    const pontos = (await api.get('/panorama/pontos', c.tk.noc)).dados;
    assert.equal(pontos.sem_coordenada, 1);
    assert.equal(pontos.total, pontos.no_mapa + pontos.sem_coordenada);
    assert.equal(pontos.fora_do_mapa[0].assinante_nome, 'Sem Coordenada LTDA');

    const fora = (await api.get('/panorama/sem-coordenada', c.tk.noc)).dados;
    assert.equal(fora.total, 1);

    const r = await api.post('/panorama/area', { area }, c.tk.noc);
    assert.match(r.dados.aviso, /sem coordenada/i, 'a área precisa avisar que pode haver gente dentro que ela não vê');
  });
});

test('panorama: quem pode ver o mapa da carteira', async (t) => {
  const api = await iniciar();
  const c = await cenario(api);
  t.after(async () => { await c.roteador.fechar(); await api.fechar(); });
  const area = [{ lat: PG.lat - 0.01, lng: PG.lng - 0.01 }, { lat: PG.lat - 0.01, lng: PG.lng + 0.01 }, { lat: PG.lat + 0.01, lng: PG.lng + 0.01 }];

  await t.test('o técnico NÃO vê a base de assinantes no mapa', async () => {
    assert.equal((await api.get('/panorama/pontos', c.tk.tecnico)).status, 403);
    assert.equal((await api.get('/panorama/resumo', c.tk.tecnico)).status, 403);
    assert.equal((await api.get('/panorama/viabilidade?lat=-24&lng=-46', c.tk.tecnico)).status, 403);
  });

  await t.test('o financeiro vê o mapa, mas não desenha área nem abre incidente', async () => {
    assert.equal((await api.get('/panorama/pontos', c.tk.financeiro)).status, 200);
    assert.equal((await api.post('/panorama/area', { area }, c.tk.financeiro)).status, 403);
    assert.equal((await api.post('/panorama/area/incidente', { area, titulo: 'x' }, c.tk.financeiro)).status, 403);
    assert.equal((await api.post('/panorama/varredura', {}, c.tk.financeiro)).status, 403);
  });

  await t.test('outra organização não enxerga nem mede nada daqui', async () => {
    const outro = await api.outraOrganizacao();
    assert.deepEqual((await api.get('/panorama/pontos', outro)).dados.pontos, []);
    assert.deepEqual((await api.post('/panorama/area', { area }, outro)).dados.itens, []);
    assert.deepEqual((await api.get(`/panorama/viabilidade?lat=${PG.lat}&lng=${PG.lng}&raio_m=5000`, outro)).dados.caixas, []);
    assert.equal((await api.get(`/panorama/contratos/${c.carteira[0].contrato.id}`, outro)).status, 404);
  });
});

test('panorama: o estado de cada ponto, caso a caso', () => {
  const agora = new Date('2026-11-21T12:00:00Z');
  const op = { agora, validadeMin: 15 };
  const base = { contrato_situacao: 'ativo', servico_id: 1, lido_em: '2026-11-21T11:55:00Z' };
  const estado = (extra) => pano.estadoDo({ ...base, ...extra }, op).estado;

  assert.equal(estado({ conectado: 1, conexao_em: '2026-11-21T11:55:00Z' }), 'conectado');
  assert.equal(estado({ conectado: 0, conexao_em: '2026-11-21T11:55:00Z' }), 'sem_conexao');
  assert.equal(estado({ conectado: 1, conexao_em: '2026-11-21T11:00:00Z' }), 'leitura_antiga', 'uma hora é velho demais para 15 min de validade');
  assert.equal(estado({ conectado: null, conexao_em: null, lido_em: null }), 'nunca_lido');
  assert.equal(estado({ conectado: null, conexao_em: null }), 'desconhecido', 'lido, mas o login não existe no concentrador');
  assert.equal(estado({ contrato_situacao: 'bloqueado', conectado: 0 }), 'bloqueado');
  assert.equal(estado({ contrato_situacao: 'suspenso' }), 'suspenso');
  assert.equal(estado({ contrato_situacao: 'em_implantacao' }), 'implantacao');
  assert.equal(estado({ contrato_situacao: 'cancelado' }), 'cancelado');
  assert.equal(pano.estadoDo({ contrato_situacao: 'ativo', servico_id: null }, op).estado, 'sem_servico');

  // Só estes três pedem ação da equipe técnica.
  assert.deepEqual([...pano.PRECISA_ATENCAO].sort(), ['desconhecido', 'sem_conexao', 'sem_servico']);
});

test('panorama: geometria conferida à mão', () => {
  const quadrado = [{ lat: 0, lng: 0 }, { lat: 0, lng: 2 }, { lat: 2, lng: 2 }, { lat: 2, lng: 0 }];
  assert.equal(pano.dentro({ lat: 1, lng: 1 }, quadrado), true);
  assert.equal(pano.dentro({ lat: 3, lng: 1 }, quadrado), false);
  assert.equal(pano.dentro({ lat: -1, lng: 1 }, quadrado), false);
  assert.equal(pano.dentro({ lat: 1, lng: 3 }, quadrado), false);

  // Polígono em "L": o ponto no vão não pode contar como dentro.
  const ele = [{ lat: 0, lng: 0 }, { lat: 0, lng: 3 }, { lat: 1, lng: 3 }, { lat: 1, lng: 1 }, { lat: 3, lng: 1 }, { lat: 3, lng: 0 }];
  assert.equal(pano.dentro({ lat: 0.5, lng: 0.5 }, ele), true);
  assert.equal(pano.dentro({ lat: 2, lng: 2 }, ele), false, 'o vão do L está fora');

  // Haversine: um grau de latitude são ~111,3 km; 100 m medem 100 m.
  assert.equal(pano.distanciaM({ lat: -24, lng: -46.4 }, { lat: -23.99910, lng: -46.4 }), 100);
  assert.ok(Math.abs(pano.distanciaM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111195) < 200);
  assert.equal(pano.distanciaM(PG, PG), 0);

  assert.throws(() => pano.validarPoligono([{ lat: 0, lng: 0 }]), /três pontos/);
  assert.throws(() => pano.validarPoligono([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }, { lat: 200, lng: 0 }]), /inválida/);
});

test('panorama: a leitura que não sabe nada não apaga o que já se sabia', () => {
  const conexao = require('../server/lib/conexao');
  assert.deepEqual(conexao.daLeitura({ presente: true, conectado: true, ip_atual: '100.64.0.9' }), { conectado: 1, ip: '100.64.0.9' });
  assert.deepEqual(conexao.daLeitura({ presente: true, conectado: false, ip_atual: null }), { conectado: 0, ip: null });
  // Login que não existe no equipamento é problema de provisionamento, não "desconectado".
  assert.deepEqual(conexao.daLeitura({ presente: false }), { conectado: null, ip: null, ausente: true });
  assert.deepEqual(conexao.daLeitura(null), { conectado: null, ip: null });
  assert.deepEqual(conexao.daLeitura({ presente: true }), { conectado: null, ip: null });
  assert.equal(conexao.duracao('2026-11-21T11:00:00Z', '2026-11-21T11:30:00Z'), 1800);
  assert.equal(conexao.duracao(null, '2026-11-21T11:30:00Z'), null);
});

void prov;
