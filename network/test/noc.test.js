'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { iniciar } = require('./helpers');
const rastreador = require('../server/conectores/rastreador');
const downdetector = require('../server/conectores/downdetector');

const min = (n) => new Date(Date.now() + n * 60_000).toISOString();

test('NOC: coletor, confirmação, histerese, recorrência, correlação e impacto', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const ativo = async (b) => (await api.post('/rede/ativos', b, tk.noc)).dados;
  const pop = await ativo({ tipo: 'pop', codigo: 'POP-01' });
  const ceo = await ativo({ tipo: 'ceo', codigo: 'CEO-01', capacidade: 24 });
  const olt = (await api.post('/rede/equipamentos', { tipo: 'olt', nome: 'OLT-PG-01', ativo_id: pop.id, monitoramento_id: 'olt-pg-01' }, tk.noc)).dados;
  const ctoA = await ativo({ tipo: 'cto', codigo: 'CTO-A', capacidade: 4, equipamento_id: olt.id, pon: '1/1/4' });
  const ctoB = await ativo({ tipo: 'cto', codigo: 'CTO-B', capacidade: 4, equipamento_id: olt.id, pon: '1/1/5' });
  await api.post('/rede/enlaces', { origem_id: ceo.id, destino_id: pop.id }, tk.noc);
  for (const c of [ctoA, ctoB]) await api.post('/rede/enlaces', { origem_id: c.id, destino_id: ceo.id }, tk.noc);
  // O mesmo cliente aparece em duas CTOs (ex.: migração): deve contar uma vez.
  for (const [c, cli] of [[ctoA, 'CLI-1'], [ctoA, 'CLI-2'], [ctoB, 'CLI-2'], [ctoB, null]]) {
    const portas = (await api.get(`/rede/ativos/${c.id}`, tk.noc)).dados.lista_portas.filter((p) => p.situacao === 'livre');
    if (cli) await api.post(`/rede/portas/${portas[0].id}/ocupar`, { cliente_ref: cli }, tk.noc);
    else api.db.prepare("UPDATE portas_rede SET situacao = 'ocupada' WHERE id = ?").run(portas[0].id);
  }
  const regra = (await api.post('/noc/regras', { nome: 'Potência baixa', metrica: 'optical_rx_dbm', comparacao: 'menor', limiar: -27, limiar_recuperacao: -25,
    confirmacoes: 2, severidade: 'alta' }, tk.noc)).dados;
  assert.equal((await api.post('/noc/regras', { nome: 'Ruim', metrica: 'optical_rx_dbm', comparacao: 'menor', limiar: -27, limiar_recuperacao: -30, severidade: 'alta' }, tk.noc)).status, 422,
    'histerese do lado errado');

  const coletor = (await api.post('/noc/coletores', { nome: 'Agente POP-01' }, tk.admin)).dados;
  const enviar = (amostras, token = coletor.token) => api.post('/coletor/amostras', { amostras }, null, { Authorization: `Bearer ${token}` });
  let n = 0;
  const amostra = (valor, em, extra = {}) => ({ schema_version: 1, source_event_id: `ev-${++n}`, target_id: 'olt-pg-01', ponto: '1/1/4', metric: 'optical_rx_dbm', value: valor, unit: 'dBm', observed_at: em, ...extra });

  await t.test('token do coletor e validação', async () => {
    assert.equal((await enviar([amostra(-20, min(-60))], 'mnc_00000000_xxxxxxxxxxxxxxxxxxxxxxxxxx')).status, 401);
    const r = (await enviar([amostra(-20, min(-60)), { target_id: 'x' }, amostra(-20, min(-59), { target_id: 'desconhecido' })])).dados;
    assert.deepEqual(r.resultado.map((x) => x.status), ['gravada', 'invalida', 'alvo_desconhecido']);
  });

  let incId;
  await t.test('confirmação: uma amostra ruim não abre; duas abrem; repetida atualiza; duplicada ignorada', async () => {
    let r = (await enviar([amostra(-28.1, min(-50))])).dados;
    assert.equal(r.resultado[0].regras[0].acao, 'aguardando_confirmacao');
    const segunda = amostra(-28.4, min(-49));
    r = (await enviar([segunda])).dados;
    assert.equal(r.resultado[0].regras[0].acao, 'aberto');
    incId = r.resultado[0].regras[0].incidente;
    assert.equal((await enviar([segunda])).dados.resultado[0].status, 'duplicada');
    r = (await enviar([amostra(-28.9, min(-48))])).dados;
    assert.deepEqual(r.resultado[0].regras[0], { regra: regra.id, acao: 'atualizado', incidente: incId });
    const i = (await api.get(`/noc/incidentes/${incId}`, tk.noc)).dados;
    assert.equal(i.evidencias.regra.versao, 1);
    assert.equal(i.evidencias.medicoes.length, 2);
    assert.equal(i.evidencias.regra.limiar, -27);
  });

  await t.test('inferência na CTO passiva guarda a evidência do equipamento, sem medição própria', async () => {
    const a = (await api.get(`/rede/ativos/${ctoA.id}`, tk.noc)).dados;
    assert.equal(a.status_origem, 'inferencia');
    assert.equal(a.status_operacional, 'atencao');
    assert.match(a.status_evidencia, /OLT-PG-01 · 1\/1\/4/);
    assert.match(a.status_evidencia, /não é medição da CTO/);
    assert.equal((await api.get(`/rede/ativos/${ctoB.id}`, tk.noc)).dados.status_origem, 'sem_avaliacao', 'outra PON não é afetada');
  });

  await t.test('histerese: valor entre os limiares não resolve; duas recuperações resolvem com duração', async () => {
    let r = (await enviar([amostra(-26, min(-40))])).dados;
    assert.equal(r.resultado[0].regras[0].acao, 'normal');
    assert.equal((await api.get(`/noc/incidentes/${incId}`, tk.noc)).dados.status, 'aberto');
    await api.post(`/noc/incidentes/${incId}/reconhecer`, {}, tk.noc);
    await enviar([amostra(-24, min(-39))]);
    r = (await enviar([amostra(-23.8, min(-38))])).dados;
    assert.equal(r.resultado[0].regras[0].acao, 'resolvido');
    const i = (await api.get(`/noc/incidentes/${incId}`, tk.noc)).dados;
    assert.equal(i.status, 'resolvido');
    assert.ok(i.reconhecido_em && i.resolvido_em && i.inicio);
    assert.equal(i.duracao_min, 11);
    assert.equal((await api.get(`/rede/ativos/${ctoA.id}`, tk.noc)).dados.status_operacional, 'operacional');
  });

  await t.test('recorrência dentro da janela reabre o mesmo incidente; amostra antiga não muda o estado', async () => {
    await enviar([amostra(-29, min(-30)), amostra(-29.5, min(-29))]);
    const i = (await api.get(`/noc/incidentes/${incId}`, tk.noc)).dados;
    assert.equal(i.status, 'aberto');
    assert.equal(i.recorrencias, 1);
    const r = (await enviar([amostra(-10, min(-45))])).dados;
    assert.equal(r.resultado[0].regras[0].acao, 'fora_de_ordem');
  });

  await t.test('falha no POP organiza os alarmes descendentes e conta clientes únicos', async () => {
    const pai = (await api.post('/noc/incidentes', { titulo: 'POP-01 sem energia', severidade: 'critica', ativo_id: pop.id }, tk.noc)).dados;
    const lista = (await api.get('/noc/incidentes?principais=1', tk.noc)).dados.itens;
    assert.deepEqual(lista.map((x) => x.id), [pai.id]);
    assert.equal(lista[0].relacionados, 1);
    const d = (await api.get(`/noc/incidentes/${pai.id}`, tk.noc)).dados;
    assert.equal(d.impacto.portas_ocupadas, 4);
    assert.equal(d.impacto.clientes_unicos, 2, 'CLI-2 aparece em duas CTOs e conta uma vez');
    assert.equal(d.impacto.clientes_sem_referencia, 1);
    const filho = (await api.get(`/noc/incidentes/${incId}`, tk.noc)).dados;
    assert.equal(filho.incidente_pai_id, pai.id);
    assert.equal(filho.confianca_correlacao, 'provavel');
    assert.ok(filho.eventos.some((e) => e.tipo === 'correlacionado'));
    // O operador corrige a correlação com motivo.
    assert.equal((await api.post(`/noc/incidentes/${incId}/correlacao`, { pai_id: null }, tk.noc)).status, 422);
    assert.equal((await api.post(`/noc/incidentes/${incId}/correlacao`, { pai_id: null, motivo: 'PON caiu antes, causa distinta' }, tk.noc)).dados.incidente_pai_id, null);
  });

  await t.test('causa só aparece como confirmada com validação explícita', async () => {
    assert.equal((await api.post(`/noc/incidentes/${incId}/causa`, { causa: 'Conector sujo', confirmada: true }, tk.noc)).status, 422);
    const r = (await api.post(`/noc/incidentes/${incId}/causa`, { causa: 'Conector sujo' }, tk.noc)).dados;
    assert.equal(r.causa_confirmada, 0);
  });

  await t.test('disponibilidade medida vem das amostras, com fonte e horário', async () => {
    let s = (await api.get('/noc/resumo', tk.consulta)).dados;
    assert.equal(s.disponibilidade.valor, null, 'sem coleta, sem número');
    await enviar([0, 1, 2, 3].map((k) => ({ source_event_id: `disp-${k}`, target_id: 'olt-pg-01', metric: 'disponibilidade', value: k === 1 ? 0 : 1, observed_at: min(-20 + k) })));
    s = (await api.get('/noc/resumo', tk.consulta)).dados;
    assert.equal(s.disponibilidade.valor, 75);
    assert.equal(s.disponibilidade.amostras, 4);
    assert.ok(s.disponibilidade.ultima_coleta);
    const tv = (await api.get('/noc/tv', tk.consulta)).dados;
    assert.doesNotMatch(JSON.stringify(tv), /CLI-/, 'TV sem dados de clientes');
  });
});

test('Downdetector: não conectado sem acesso; adaptador configurável com limite e sinais honestos', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();

  await t.test('sem acesso: não conectado, sem cartões inventados, com o site oficial', async () => {
    const s = (await api.get('/noc/servicos-externos', tk.noc)).dados;
    assert.equal(s.estado, 'nao_configurada');
    assert.deepEqual(s.servicos, []);
    assert.equal(s.site_oficial, 'https://downdetector.com.br/');
    const r = (await api.post('/integracoes/downdetector/testar', {}, tk.admin)).dados;
    assert.equal(r.ok, false);
    assert.equal(r.estado, 'nao_configurada');
  });

  await t.test('classificação: sem dados ≠ normal; pico = indício externo', () => {
    assert.equal(downdetector.classificar(null, 10, 2), 'sem_dados');
    assert.equal(downdetector.classificar(0, null, 2), 'sem_relatos_relevantes');
    assert.equal(downdetector.classificar(15, null, 2), 'sem_dados');
    assert.equal(downdetector.classificar(25, 10, 2), 'indicio_externo');
    assert.equal(downdetector.classificar(12, 10, 2), 'sem_relatos_relevantes');
  });

  // Servidor local de teste (não é a API do Downdetector): exercita o adaptador configurável e a política de limite.
  let modo = 'ok';
  let autorizacao = null;
  const fake = http.createServer((req, res) => {
    autorizacao = req.headers.authorization;
    if (modo === 'limite') { res.writeHead(429, { 'Retry-After': '120' }); return res.end(); }
    if (modo === 'negado') { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ resultado: { relatos: req.url.includes('servico-a') ? 40 : 3, referencia: 10 } }));
  }).listen(0);
  t.after(() => fake.close());
  await new Promise((r) => fake.once('listening', r));

  await t.test('configurado: coleta por serviço, credencial nunca devolvida', async () => {
    const cfg = { url_base: `http://127.0.0.1:${fake.address().port}`, caminho: '/consulta/{servico}', campo_relatos: 'resultado.relatos', campo_baseline: 'resultado.referencia' };
    const r = await api.put('/integracoes/downdetector', { config: cfg, segredo: 'token-secreto-do-contrato' }, tk.admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.credencial_configurada, true);
    assert.doesNotMatch(JSON.stringify(r.dados), /token-secreto/);
    assert.equal((await api.put('/integracoes/downdetector', { config: cfg }, tk.noc)).status, 403);
    await api.post('/noc/servicos-externos', { nome: 'Serviço A', referencia: 'servico-a', regiao: 'SP' }, tk.admin);
    await api.post('/noc/servicos-externos', { nome: 'Serviço B', referencia: 'servico-b' }, tk.admin);
    const teste = (await api.post('/integracoes/downdetector/testar', {}, tk.admin)).dados;
    assert.equal(teste.ok, true);
    assert.equal(autorizacao, 'Bearer token-secreto-do-contrato');
    const s = (await api.get('/noc/servicos-externos', tk.noc)).dados;
    assert.equal(s.estado, 'conectada');
    assert.deepEqual(s.servicos.map((x) => [x.nome, x.ultima.relatos, x.ultima.sinal]), [['Serviço A', 40, 'indicio_externo'], ['Serviço B', 3, 'sem_relatos_relevantes']]);
    assert.doesNotMatch(JSON.stringify(await api.get('/integracoes', tk.admin)), /token-secreto/);
  });

  await t.test('limite atingido respeita Retry-After; credencial recusada não repete', async () => {
    modo = 'limite';
    const r = (await api.post('/integracoes/downdetector/testar', {}, tk.admin)).dados;
    assert.equal(r.estado, 'limite_atingido');
    const prox = Date.parse(r.integracao.proxima_tentativa) - Date.now();
    assert.ok(prox > 100_000 && prox <= 121_000, `próxima tentativa em ${prox} ms`);
    assert.ok(r.erro_id);
    modo = 'negado';
    const n = (await api.post('/integracoes/downdetector/testar', {}, tk.admin)).dados;
    assert.equal(n.estado, 'sem_permissao');
    assert.equal(n.integracao.proxima_tentativa, null);
    // A última leitura continua, marcada como desatualizada quando passa do limite.
    api.db.prepare('UPDATE amostras_servico_externo SET coletado_em = ?').run(min(-120));
    const s = (await api.get('/noc/servicos-externos', tk.noc)).dados;
    assert.equal(s.servicos[0].desatualizada, true);
    assert.equal(s.servicos[0].ultima.relatos, 40);
  });

  await t.test('SSRF: rede interna bloqueada sem a liberação explícita', async () => {
    const base = require('../server/conectores/base');
    assert.equal(base.ipPrivado('10.0.0.1'), true);
    assert.equal(base.ipPrivado('192.168.1.10'), true);
    assert.equal(base.ipPrivado('::ffff:127.0.0.1'), true);
    assert.equal(base.ipPrivado('8.8.8.8'), false);
    await assert.rejects(base.validarDestino('file:///etc/passwd'));
    await assert.rejects(base.validarDestino('http://usuario:senha@exemplo.com'));
  });
});

/** Sobe o Rastreador de Veículos deste repositório num processo separado, com banco temporário. */
async function subirRastreador() {
  const dir = path.join(__dirname, '..', '..', 'rastreador');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'express'))) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rastreador-'));
  const porta = 34000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', PORT: String(porta), RASTREADOR_GT06_PORTA: '0', RASTREADOR_DB: path.join(tmp, 'r.db'), RASTREADOR_SECRET: 'segredo-rastreador-teste',
      RASTREADOR_BASE_PATH: '/rastreador', RASTREADOR_LIMITE_LOGIN: '1000' } });
  const url = `http://127.0.0.1:${porta}/rastreador`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${url}/api/saude`)).ok) return { url, proc }; } catch { /* aguardando subir */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('O rastreador não subiu.');
}

test('rastreador real: vínculo pelo IMEI, deduplicação, ordem e campos ausentes', async (t) => {
  const r = await subirRastreador();
  if (!r) { t.skip('rastreador/node_modules ausente (rode npm install em rastreador/)'); return; }
  t.after(() => r.proc.kill());
  const rq = async (metodo, c, b, tok, h = {}) => {
    const x = await fetch(`${r.url}/api${c}`, { method: metodo, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...h }, body: b ? JSON.stringify(b) : undefined });
    return x.json();
  };
  const master = (await rq('POST', '/auth/login', { email: 'master@rastreador.com.br', senha: 'master123' })).token;
  const emp = await rq('POST', '/master/empresas', { nome: 'Provedor', limite_veiculos: 5, mensalidade_centavos: 1000, administrador: { nome: 'G', email: 'g@p.com', senha: 'senha-gestor-1' } }, master);
  await rq('POST', '/master/rastreadores', { imei: 'gw-0001', protocolo: 'api', empresa_id: emp.id }, master);
  const rid = (await rq('GET', '/master/rastreadores', null, master)).find((x) => x.imei === 'gw-0001').id;
  const cliente = (await rq('POST', '/auth/login', { email: 'g@p.com', senha: 'senha-gestor-1' })).token;
  await rq('POST', `/empresas/${emp.id}/veiculos`, { placa: 'FRT2A41', descricao: 'Strada', rastreador_id: rid }, cliente);
  const chave = (await rq('POST', `/empresas/${emp.id}/chaves`, { nome: 'Manager Network' }, cliente)).chave;
  const pos = (lat, em, extra = {}) => rq('POST', '/integracao/posicoes', [{ imei: 'gw-0001', lat, lng: -46.43, velocidade_kmh: 0, gps_em: em, ...extra }], null, { 'X-Api-Key': chave });
  await pos(-24.01, min(-3));

  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const veic = (await api.post('/frota/veiculos', { placa: 'FRT-2A41', modelo: 'Strada' }, tk.frota)).dados;

  await t.test('sem chave: não configurada; chave errada: sem permissão', async () => {
    assert.equal((await api.get('/rastreamento/mapa', tk.frota)).dados.conexao.estado, 'nao_configurada');
    await api.put('/integracoes/rastreador', { config: { url_base: r.url }, segredo: 'rst_00000000_xxxxxxxxxxxxxxxxxxxxxxxx' }, tk.admin);
    const x = (await api.post('/integracoes/rastreador/testar', {}, tk.admin)).dados;
    assert.equal(x.estado, 'sem_permissao');
  });

  await t.test('coleta real, dispositivo vinculado pelo IMEI e sugestão pela placa', async () => {
    await api.put('/integracoes/rastreador', { config: { url_base: r.url }, segredo: chave }, tk.admin);
    let x = (await api.post('/integracoes/rastreador/testar', {}, tk.admin)).dados;
    assert.equal(x.ok, true, JSON.stringify(x));
    assert.equal(x.resultado.posicoes_novas, 0, 'sem vínculo, nenhuma posição é atribuída');
    const disp = (await api.get('/rastreamento/dispositivos', tk.frota)).dados;
    assert.deepEqual(disp.map((d) => [d.dispositivo_id, d.placa, d.sugestao_veiculo_id]), [['gw-0001', 'FRT2A41', veic.id]]);
    assert.equal((await api.post('/rastreamento/vinculos', { dispositivo_id: 'gw-0001', veiculo_id: veic.id }, tk.frota)).status, 201);
    x = (await api.post('/integracoes/rastreador/testar', {}, tk.admin)).dados;
    assert.equal(x.resultado.posicoes_novas, 1);
    x = (await api.post('/integracoes/rastreador/testar', {}, tk.admin)).dados;
    assert.equal(x.resultado.posicoes_novas, 0, 'evento repetido não duplica');
    const m = (await api.get('/rastreamento/mapa', tk.frota)).dados;
    const v = m.veiculos.find((y) => y.id === veic.id);
    assert.equal(m.conexao.estado, 'conectada');
    assert.equal(v.situacao, 'parado');
    assert.equal(v.ignicao, 'desconhecida', 'ignição ausente não vira desligada');
    assert.ok(v.idade_s >= 170);
  });

  await t.test('posição antiga depois da nova não substitui a atual; trajeto vem da fonte', async () => {
    const nova = min(-1);
    await pos(-24.02, nova);
    await api.post('/integracoes/rastreador/testar', {}, tk.admin);
    const db = api.db;
    // Posição mais antiga chegando depois (memória do equipamento): gravada no histórico, sem mudar a atual.
    rastreador.gravarPosicao(db, 1, veic.id, 'gw-0001', { lat: -24.5, lng: -46.4, observado_em: min(-10) });
    const atual = db.prepare('SELECT p.lat, p.observado_em FROM posicao_atual a JOIN posicoes p ON p.id = a.posicao_id WHERE a.veiculo_id = ?').get(veic.id);
    assert.equal(atual.observado_em, new Date(nova).toISOString());
    const tr = (await api.get(`/rastreamento/veiculos/${veic.id}/trajeto?de=${encodeURIComponent(min(-60))}`, tk.frota)).dados;
    assert.equal(tr.fonte, 'rastreador');
    assert.equal(tr.pontos.length, 2);
  });

  await t.test('fonte desconectada: mostra falha e preserva a última leitura com a idade', async () => {
    r.proc.kill();
    await new Promise((ok) => r.proc.once('exit', ok));
    const x = (await api.post('/integracoes/rastreador/testar', {}, tk.admin)).dados;
    assert.equal(x.estado, 'falha');
    assert.ok(x.erro_id);
    const m = (await api.get('/rastreamento/mapa', tk.frota)).dados;
    assert.equal(m.conexao.estado, 'falha');
    const v = m.veiculos.find((y) => y.id === veic.id);
    assert.ok(v.observado_em && v.idade_s > 0, 'última leitura preservada');
    const tr = (await api.get(`/rastreamento/veiculos/${veic.id}/trajeto?de=${encodeURIComponent(min(-60))}`, tk.frota)).dados;
    assert.equal(tr.fonte, 'armazenamento_local');
    assert.match(tr.aviso, /Fonte indisponível/);
  });
});
