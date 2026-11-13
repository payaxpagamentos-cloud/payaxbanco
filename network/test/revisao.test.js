'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { iniciar, PNG } = require('./helpers');
const config = require('../server/config');
const base = require('../server/conectores/base');
const rastreador = require('../server/conectores/rastreador');
const { limitesDoDia } = require('../server/lib/datas');

const min = (n) => new Date(Date.now() + n * 60_000).toISOString();

test('SSRF: IPv6 mapeado e DNS conferido na própria conexão', async (t) => {
  // Mesmo IPv4 interno escrito como IPv6 mapeado, em qualquer forma (a URL normaliza para hexadecimal).
  for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:a9fe:a9fe', '::ffff:a00:1', '::7f00:1', '64:ff9b::a9fe:a9fe']) {
    assert.equal(base.ipPrivado(ip), true, ip);
  }
  assert.equal(base.ipPrivado('::ffff:808:808'), false);
  assert.equal(base.ipPrivado('2001:4860:4860::8888'), false);

  const antes = config.conectorRedeInterna;
  t.after(() => { config.conectorRedeInterna = antes; });
  config.conectorRedeInterna = false;
  for (const url of ['http://[::ffff:127.0.0.1]:9/', 'http://[::ffff:169.254.169.254]/latest', 'http://[0:0:0:0:0:ffff:a00:1]/']) {
    await assert.rejects(base.validarDestino(url), /rede interna/, url);
    await assert.rejects(base.buscarJson(url), /rede interna/, url);
  }
  // A resolução usada no socket recusa endereço interno (um DNS que mude depois da validação não passa).
  const erro = await new Promise((r) => base.lookupSeguro('localhost', {}, (e) => r(e)));
  assert.equal(erro?.code, 'EREDEINTERNA');
  // Com a liberação explícita, o serviço no mesmo servidor continua acessível.
  config.conectorRedeInterna = true;
  const ok = await new Promise((r) => base.lookupSeguro('localhost', {}, (e, end) => r(e ?? end)));
  assert.equal(typeof ok, 'string');
});

test('NOC: pai resolvido promove os filhos e não declara operacional a CTO ainda afetada', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const pop = (await api.post('/rede/ativos', { tipo: 'pop', codigo: 'POP-01' }, tk.noc)).dados;
  const olt = (await api.post('/rede/equipamentos', { tipo: 'olt', nome: 'OLT', ativo_id: pop.id, monitoramento_id: 'olt1' }, tk.noc)).dados;
  const cto1 = (await api.post('/rede/ativos', { tipo: 'cto', codigo: 'CTO-1', capacidade: 4, equipamento_id: olt.id, pon: '1/1/1' }, tk.noc)).dados;
  const cto2 = (await api.post('/rede/ativos', { tipo: 'cto', codigo: 'CTO-2', capacidade: 4, equipamento_id: olt.id, pon: '1/1/2' }, tk.noc)).dados;
  const col = (await api.post('/noc/coletores', { nome: 'c' }, tk.admin)).dados;
  await api.post('/noc/regras', { nome: 'Potência', metrica: 'optical_rx_dbm', comparacao: 'menor', limiar: -27, limiar_recuperacao: -25, confirmacoes: 2, severidade: 'alta' }, tk.noc);
  let n = 0;
  const enviar = (a) => api.post('/coletor/amostras', { amostras: a }, null, { Authorization: `Bearer ${col.token}` });
  const am = (metrica, valor, em, ponto) => ({ source_event_id: `e${++n}`, target_id: 'olt1', metric: metrica, value: valor, observed_at: em, ...(ponto ? { ponto } : {}) });
  const inc = () => api.db.prepare('SELECT id, status, incidente_pai_id FROM incidentes ORDER BY id').all();
  const statusCto = (id) => api.db.prepare('SELECT status_operacional FROM ativos_rede WHERE id = ?').get(id).status_operacional;

  // OLT sem resposta (pai) e a PON 1/1/1 com potência baixa (filho).
  await enviar([am('disponibilidade', 0, min(-30)), am('disponibilidade', 0, min(-29))]);
  await enviar([am('optical_rx_dbm', -30, min(-28), '1/1/1'), am('optical_rx_dbm', -30, min(-27), '1/1/1')]);
  let [pai, filho] = inc();
  assert.equal(filho.incidente_pai_id, pai.id);
  assert.equal((await api.get('/noc/resumo', tk.noc)).dados.incidentes.principais, 1);

  // A OLT volta; a PON continua ruim.
  await enviar([am('disponibilidade', 1, min(-20)), am('disponibilidade', 1, min(-19))]);
  [pai, filho] = inc();
  assert.equal(pai.status, 'resolvido');
  assert.equal(filho.status, 'aberto');
  assert.equal(filho.incidente_pai_id, null, 'o filho aberto volta a ser principal');
  const r = (await api.get('/noc/resumo', tk.noc)).dados.incidentes;
  assert.equal(r.principais, 1);
  assert.equal(r.por_severidade.alta, 1);
  assert.equal((await api.get('/noc/incidentes?principais=1', tk.noc)).dados.total, 1);
  assert.equal((await api.get('/noc/tv', tk.noc)).dados.incidentes.length, 1);
  const ev = api.db.prepare("SELECT detalhes FROM incidente_eventos WHERE incidente_id = ? AND tipo = 'correlacao_encerrada'").get(filho.id);
  assert.match(ev.detalhes, new RegExp(`#${pai.id}`));
  // A CTO da PON que continua em falha não vira "operacional"; a outra CTO da OLT sim.
  assert.notEqual(statusCto(cto1.id), 'operacional');
  assert.equal(statusCto(cto2.id), 'operacional');

  // Resolução manual do pai também promove os filhos abertos.
  const manual = (await api.post('/noc/incidentes', { titulo: 'Rompimento', severidade: 'critica', equipamento_id: olt.id }, tk.noc)).dados;
  api.db.prepare('UPDATE incidentes SET incidente_pai_id = ? WHERE id = ?').run(manual.id, filho.id);
  assert.equal((await api.post(`/noc/incidentes/${manual.id}/resolver`, { evidencia: 'Fibra emendada e medida' }, tk.noc)).status, 200);
  assert.equal(api.db.prepare('SELECT incidente_pai_id FROM incidentes WHERE id = ?').get(filho.id).incidente_pai_id, null);
});

test('comissão: reaprovação depois da reabertura recalcula quantidade e valor', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  assert.equal((await api.post('/equipe/regras', { tipo_servico: 'fusao', modo: 'por_unidade', valor: '10,00', campo_unidade: 'fibras_fundidas' }, tk.admin)).status, 201);
  let c = (await api.post('/chamados', { tipo: 'fusao', titulo: 'Fusão na CEO' }, tk.gestor)).dados;
  c = (await api.post(`/chamados/${c.id}/atribuir`, { tecnico_id: tk.tecnico_tid, versao: c.versao }, tk.gestor)).dados;
  const executar = async (fibras) => {
    c = (await api.post(`/chamados/${c.id}/iniciar`, { versao: c.versao }, tk.tecnico)).dados;
    const foto = (await api.req('POST', `/anexos?recurso=chamado&recurso_id=${c.id}`, PNG, tk.tecnico)).dados;
    await api.put(`/chamados/${c.id}/checklist/fibras_fundidas`, { valor: fibras }, tk.tecnico);
    await api.put(`/chamados/${c.id}/checklist/teste_otdr`, { valor: true }, tk.tecnico);
    c = (await api.put(`/chamados/${c.id}/checklist/foto`, { anexo_id: foto.id }, tk.tecnico)).dados;
    c = (await api.post(`/chamados/${c.id}/concluir`, { versao: c.versao }, tk.tecnico)).dados;
    c = (await api.post(`/chamados/${c.id}/validar`, { versao: c.versao, decisao: 'aprovar' }, tk.gestor)).dados;
  };
  const comissao = () => api.db.prepare('SELECT * FROM comissoes WHERE chamado_id = ?').all(c.id);
  await executar(12);
  assert.equal(comissao()[0].valor_centavos, 12000);
  // Nova versão da regra entre a reabertura e a nova aprovação.
  await api.post('/equipe/regras', { tipo_servico: 'fusao', modo: 'por_unidade', valor: '11,00', campo_unidade: 'fibras_fundidas' }, tk.admin);
  c = (await api.post(`/chamados/${c.id}/reabrir`, { versao: c.versao, motivo: 'Contagem de fibras errada' }, tk.gestor)).dados;
  assert.equal(comissao()[0].status, 'suspensa');
  await executar(6);
  const [co] = comissao();
  assert.equal(comissao().length, 1);
  assert.equal(co.status, 'aguardando_aprovacao');
  assert.equal(co.quantidade, 6);
  assert.equal(co.valor_centavos, 6600);
  assert.equal(api.db.prepare('SELECT versao FROM comissao_versoes WHERE id = ?').get(co.versao_id).versao, 2);
  assert.match(api.db.prepare('SELECT motivo FROM comissao_eventos WHERE comissao_id = ? ORDER BY id DESC').get(co.id).motivo, /12000 para 6600/);
});

test('dia local da operação: agenda, filtros de período e limites do dia', async (t) => {
  assert.deepEqual(limitesDoDia('America/Sao_Paulo', '2026-11-20'), { inicio: '2026-11-20T03:00:00.000Z', fim: '2026-11-21T03:00:00.000Z' });
  assert.deepEqual(limitesDoDia('America/Manaus', '2026-12-31'), { inicio: '2026-12-31T04:00:00.000Z', fim: '2027-01-01T04:00:00.000Z' });

  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const atribuir = async (quando) => {
    const c = (await api.post('/chamados', { tipo: 'reparo', titulo: `Reparo ${quando}` }, tk.gestor)).dados;
    return api.post(`/chamados/${c.id}/atribuir`, { tecnico_id: tk.tecnico_tid, versao: c.versao, agendado_para: quando }, tk.gestor);
  };
  // 20/11 às 22h em São Paulo = 21/11 01h UTC.
  assert.equal((await atribuir('2026-11-21T01:00:00.000Z')).status, 200);
  // 21/11 às 8h local: outro dia local (no dia UTC seria o mesmo) → sem conflito.
  assert.equal((await atribuir('2026-11-21T11:00:00.000Z')).status, 200);
  // 20/11 às 8h local: mesmo dia local do primeiro (no dia UTC seria outro) → conflito.
  const r = await atribuir('2026-11-20T11:00:00.000Z');
  assert.equal(r.status, 409);
  assert.equal(r.dados.detalhes.conflitos.length, 1);

  // Abastecimento às 22h de 20/10 (local) entra no dia 20, não no 21.
  const vei = (await api.post('/frota/veiculos', { placa: 'ABC1D23', modelo: 'Strada' }, tk.admin)).dados;
  assert.equal((await api.post('/combustivel/abastecimentos', { veiculo_id: vei.id, data_hora: '2026-10-21T01:00:00.000Z', combustivel: 'gasolina', odometro_km: 1000,
    litros: '30', preco_litro: '5,899' }, tk.frota)).status, 201);
  assert.equal((await api.get('/combustivel/abastecimentos?de=2026-10-20&ate=2026-10-20', tk.frota)).dados.total, 1);
  assert.equal((await api.get('/combustivel/abastecimentos?de=2026-10-21&ate=2026-10-21', tk.frota)).dados.total, 0);
  assert.equal((await api.get('/combustivel/resumo?de=2026-10-20&ate=2026-10-20', tk.frota)).dados.total.lancamentos, 1);
});

test('rastreador: data inválida da fonte conta como item inválido, sem derrubar a coleta', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const agora = new Date().toISOString();
  const fonte = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([
      { imei: '111', placa: 'AAA1A11', lat: -24.0, lng: -46.4, posicao_em: 'ontem à tarde' },
      { imei: '222', placa: 'BBB2B22', lat: -24.01, lng: -46.41, posicao_em: agora, velocidade_kmh: 40 },
      null,
    ]));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fonte.once('listening', r));
  t.after(() => fonte.close());
  const v1 = (await api.post('/frota/veiculos', { placa: 'AAA1A11', modelo: 'Fiorino' }, tk.admin)).dados;
  const v2 = (await api.post('/frota/veiculos', { placa: 'BBB2B22', modelo: 'Fiorino' }, tk.admin)).dados;
  await api.post('/rastreamento/vinculos', { dispositivo_id: '111', veiculo_id: v1.id }, tk.admin);
  await api.post('/rastreamento/vinculos', { dispositivo_id: '222', veiculo_id: v2.id }, tk.admin);
  assert.equal((await api.put('/integracoes/rastreador', { config: { url_base: `http://127.0.0.1:${fonte.address().port}` }, segredo: 'chave-teste' }, tk.admin)).status, 200);
  const r = await rastreador.coletar(api.db, 1);
  assert.deepEqual(r, { veiculos: 3, posicoes_novas: 1, invalidas: 2 });
  assert.equal(api.db.prepare('SELECT estado FROM integracoes WHERE tipo = ?').get('rastreador').estado, 'parcial');
  assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM posicao_atual WHERE veiculo_id = ?').get(v2.id).n, 1);
});

test('anexos: o corpo do upload só é lido depois da autenticação', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const grande = Buffer.alloc(config.arquivoMaxBytes + 4096, 1);
  // Antes, o corpo era lido (e recusado por tamanho, 413) sem sessão; agora a sessão é conferida primeiro.
  assert.equal((await api.req('POST', '/anexos?recurso=chamado', grande)).status, 401);
  assert.equal((await api.req('POST', '/anexos?recurso=chamado', PNG)).status, 401);
  // Com sessão, o envio continua funcionando e o limite continua valendo.
  assert.equal((await api.req('POST', '/anexos?recurso=chamado', PNG, tk.gestor)).status, 201);
  assert.equal((await api.req('POST', '/anexos?recurso=chamado', grande, tk.gestor)).status, 413);
  // As demais rotas continuam recebendo JSON.
  assert.equal((await api.post('/noc/incidentes', { titulo: 'Teste', severidade: 'baixa' }, tk.noc)).status, 201);
});
