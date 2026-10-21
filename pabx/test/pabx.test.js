'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { classificar, tarifar, simultaneas } = require('../server/lib/chamadas');

test('funções de apoio', () => {
  assert.equal(classificar('1001'), 'interno');
  assert.equal(classificar('11987654321'), 'movel');
  assert.equal(classificar('1133224455'), 'fixo');
  assert.equal(classificar('5511987654321'), 'movel');
  assert.equal(classificar('011987654321'), 'movel'); // 0 + DDD + celular
  assert.equal(classificar('01511987654321'), 'movel'); // 0 + operadora + DDD + celular
  assert.equal(classificar('0151133224455'), 'fixo');
  assert.equal(classificar('987654321'), 'movel');
  assert.equal(classificar('33224455'), 'fixo');
  assert.equal(classificar('0014155550100'), 'internacional');
  assert.equal(tarifar(0, 30, 6), 0);
  assert.equal(tarifar(5, 30, 6), 30);
  assert.equal(tarifar(30, 30, 6), 30);
  assert.equal(tarifar(31, 30, 6), 36);
  assert.equal(tarifar(95, 30, 6), 96);
  // Duas chamadas que se cruzam no segundo intervalo: pico 2 nele, 1 no primeiro e no terceiro.
  const ini = Date.parse('2026-10-21T00:00:00Z');
  const t = (min) => new Date(ini + min * 60_000).toISOString();
  const p = simultaneas([{ inicio: t(5), fim: t(20) }, { inicio: t(16), fim: t(40) }, { inicio: t(50), fim: t(51) }], ini, ini + 60 * 60_000, 15 * 60_000);
  assert.deepEqual(p, [1, 2, 1, 1]);
});

test('PABX', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  const master = await api.login();
  let empresa, outra, cliente, supervisor, chave, tronco, fila, ramal1001;

  await t.test('master cria rota, empresas e o administrador da empresa', async () => {
    assert.equal((await api.post('/master/troncos', { nome: 'Operadora', host: 'sip.op.exemplo', custo_movel_centavos: 10 }, master)).status, 201);
    tronco = (await api.get('/master/troncos', master)).dados[0].id;
    assert.equal((await api.post('/master/empresas', { nome: 'X', documento: '11.111.111/1111-11' }, master)).status, 422);
    const r = await api.post('/master/empresas', {
      nome: 'Cobrança Ltda', documento: '11.222.333/0001-81', tipo: 'discador', limite_ramais: 2, limite_canais: 2, disco_mb: 1,
      tts_limite: 10, stt_limite: 0, tarifa_fixo_centavos: 12, tarifa_movel_centavos: 30, tronco_id: tronco,
      administrador: { nome: 'Gestora', email: 'gestora@cobranca.com', senha: 'senha-da-gestora' },
    }, master);
    assert.equal(r.status, 201);
    empresa = r.dados.id;
    outra = (await api.post('/master/empresas', { nome: 'Outra Empresa' }, master)).dados.id;
    cliente = await api.login('gestora@cobranca.com', 'senha-da-gestora');
    const lista = (await api.get('/master/empresas?tipo=discador', master)).dados;
    assert.deepEqual(lista.map((e) => e.nome), ['Cobrança Ltda']);
    assert.equal(lista[0].limite_ramais, 2);
  });

  await t.test('cliente só acessa a própria empresa e não o master', async () => {
    assert.equal((await api.get(`/empresas/${empresa}/dashboard`, cliente)).status, 200);
    assert.equal((await api.get(`/empresas/${outra}/dashboard`, cliente)).status, 404);
    assert.equal((await api.get('/master/empresas', cliente)).status, 403);
    assert.equal((await api.get('/empresas/9999/dashboard', master)).status, 404);
  });

  await t.test('ramais respeitam o limite e o número único', async () => {
    const r1 = await api.post(`/empresas/${empresa}/ramais`, { numero: '1001', nome: 'Ana' }, cliente);
    assert.equal(r1.status, 201);
    ramal1001 = r1.dados.id;
    assert.equal((await api.post(`/empresas/${empresa}/ramais`, { numero: '1001', nome: 'Bia' }, cliente)).status, 409);
    assert.equal((await api.post(`/empresas/${empresa}/ramais`, { numero: '1', nome: 'Bia' }, cliente)).status, 422);
    assert.equal((await api.post(`/empresas/${empresa}/ramais`, { numero: '1002', nome: 'Bia' }, cliente)).status, 201);
    const cheio = await api.post(`/empresas/${empresa}/ramais`, { numero: '1003', nome: 'Caio' }, cliente);
    assert.equal(cheio.status, 422);
    assert.match(cheio.dados.erro, /Limite de 2 ramais/);
    const lista = (await api.get(`/empresas/${empresa}/ramais`, cliente)).dados;
    assert.equal(lista.length, 2);
    assert.ok(!('senha_sip' in lista[0]), 'a lista não expõe a senha SIP');
    const sip = (await api.get(`/empresas/${empresa}/ramais/${ramal1001}/sip`, cliente)).dados;
    assert.equal(sip.usuario, `${empresa}_1001`);
    assert.ok(sip.senha.length >= 12);
  });

  await t.test('supervisor só consulta', async () => {
    assert.equal((await api.post(`/empresas/${empresa}/usuarios`, { nome: 'Sup', email: 'sup@cobranca.com', senha: 'senha-do-sup', perfil: 'supervisor' }, cliente)).status, 201);
    assert.equal((await api.post(`/empresas/${empresa}/usuarios`, { nome: 'M', email: 'm@x.com', senha: 'senha-1234', perfil: 'master' }, cliente)).status, 422);
    supervisor = await api.login('sup@cobranca.com', 'senha-do-sup');
    assert.equal((await api.get(`/empresas/${empresa}/chamadas`, supervisor)).status, 200);
    assert.equal((await api.post(`/empresas/${empresa}/contatos`, { nome: 'X', telefone: '11999990000' }, supervisor)).status, 403);
    assert.equal((await api.get(`/empresas/${empresa}/ramais/${ramal1001}/sip`, supervisor)).status, 403);
    assert.equal((await api.get(`/empresas/${empresa}/chaves`, supervisor)).status, 403);
  });

  await t.test('filas, URA e destino do número entrante', async () => {
    const f = await api.post(`/empresas/${empresa}/filas`, { nome: 'Atendimento', ramais: [ramal1001] }, cliente);
    assert.equal(f.status, 201);
    fila = f.dados.id;
    const outraFila = (await api.post(`/empresas/${outra}/filas`, { nome: 'De outra' }, master)).dados.id;
    assert.equal((await api.post(`/empresas/${empresa}/uras`, { nome: 'Menu', mensagem: 'Olá', opcoes: [{ digito: '1', destino_tipo: 'fila', destino_id: outraFila }] }, cliente)).status, 422);
    assert.equal((await api.post(`/empresas/${empresa}/uras`, { nome: 'Menu', mensagem: 'Olá', opcoes: [{ digito: '1', destino_tipo: 'fila', destino_id: fila }, { digito: '1', destino_tipo: 'ramal', destino_id: ramal1001 }] }, cliente)).status, 422);
    const ura = await api.post(`/empresas/${empresa}/uras`, { nome: 'Menu', mensagem: 'Olá', opcoes: [{ digito: '1', destino_tipo: 'fila', destino_id: fila }] }, cliente);
    assert.equal(ura.status, 201);
    // Número: o master cadastra e atribui; a empresa escolhe o destino.
    assert.equal((await api.post('/master/numeros', { numeros: '1130001000\n1130001001', tronco_id: tronco, empresa_id: empresa }, master)).dados.criados, 2);
    const numeros = (await api.get(`/empresas/${empresa}/numeros`, cliente)).dados;
    assert.equal(numeros.length, 2);
    assert.equal((await api.patch(`/empresas/${empresa}/numeros/${numeros[0].id}`, { destino_tipo: 'ura', destino_id: ura.dados.id }, cliente)).status, 204);
    assert.equal((await api.get(`/empresas/${empresa}/numeros`, cliente)).dados[0].destino_nome, 'Menu');
    // Excluir a URA tira o destino do número.
    assert.equal((await api.del(`/empresas/${empresa}/uras/${ura.dados.id}`, undefined, cliente)).status, 204);
    assert.equal((await api.get(`/empresas/${empresa}/numeros`, cliente)).dados[0].destino_tipo, null);
  });

  await t.test('chave de API: criação, configuração e revogação', async () => {
    const k = await api.post(`/empresas/${empresa}/chaves`, { nome: 'Asterisk' }, cliente);
    assert.equal(k.status, 201);
    chave = k.dados.chave;
    assert.match(chave, /^pbx_[0-9a-f]{8}_/);
    assert.ok(!JSON.stringify((await api.get(`/empresas/${empresa}/chaves`, cliente)).dados).includes(chave.split('_')[2]), 'o segredo não volta na lista');
    assert.equal((await api.central('pbx_00000000_xxxxxxxxxxxxxxxxxxxxxxxx').get('/config')).status, 401);
    const cfg = (await api.central(chave).get('/config')).dados;
    assert.equal(cfg.empresa.id, empresa);
    assert.deepEqual(cfg.ramais.map((r) => r.numero), ['1001', '1002']);
    assert.equal(cfg.terminacao.host, 'sip.op.exemplo');
    assert.deepEqual(cfg.filas[0].ramais, ['1001']);
    const tmp = (await api.post(`/empresas/${empresa}/chaves`, { nome: 'Temporária' }, cliente)).dados;
    assert.equal((await api.del(`/empresas/${empresa}/chaves/${tmp.id}`, undefined, cliente)).status, 204);
    assert.equal((await api.central(tmp.chave).get('/config')).status, 401);
  });

  await t.test('chamadas: registro, tarifação, limite de canais e dashboard', async () => {
    const c = api.central(chave);
    const inicio = new Date(Date.now() - 120_000).toISOString();
    const a = await c.post('/chamadas', { uid: 'a1', direcao: 'saida', origem: '1001', destino: '11987654321', inicio });
    assert.equal(a.status, 201);
    assert.equal(a.dados.gravar, true);
    assert.equal((await c.post('/chamadas', { uid: 'a1', direcao: 'saida', origem: '1001', destino: '11987654321' })).status, 200, 'repetir o início não duplica');
    assert.equal((await c.post('/chamadas', { uid: 'b1', direcao: 'entrada', origem: '1133224455', destino: '1002', numero: '1130001000' })).status, 201);
    const lotado = await c.post('/chamadas', { uid: 'c1', direcao: 'saida', origem: '1002', destino: '1133224455' });
    assert.equal(lotado.status, 429);
    assert.equal((await api.get(`/empresas/${empresa}/dashboard`, cliente)).dados.em_curso, 2);

    // Atendida 10 s depois do início e encerrada 95 s depois: 95 s falados → 96 s tarifados (30/6) × R$ 0,30/min = R$ 0,48.
    const atendida = new Date(Date.parse(inicio) + 10_000).toISOString();
    assert.equal((await c.post('/chamadas/a1/atendida', { em: atendida })).status, 200);
    const fim = await c.post('/chamadas/a1/fim', { fim: new Date(Date.parse(atendida) + 95_000).toISOString(), gravacao_bytes: 2 * 1024 * 1024 });
    assert.equal(fim.dados.duracao_s, 95);
    assert.equal(fim.dados.custo_centavos, 48);
    assert.equal((await c.post('/chamadas/b1/fim', { status: 'nao_atendida' })).dados.custo_centavos, 0);
    assert.equal((await c.post('/chamadas/nao-existe/fim', {})).status, 404);

    const lista = (await api.get(`/empresas/${empresa}/chamadas`, cliente)).dados;
    assert.equal(lista.total, 2);
    assert.equal(lista.custo_centavos, 48);
    const saida = lista.itens.find((x) => x.uid === 'a1');
    assert.equal(saida.tipo_destino, 'movel');
    assert.equal(saida.tarifado_s, 96);
    assert.equal(saida.ramal, '1001');
    const d = (await api.get(`/empresas/${empresa}/dashboard`, cliente)).dados;
    assert.equal(d.utilizacao.hoje.realizadas, 1);
    assert.equal(d.utilizacao.hoje.recebidas, 1);
    assert.equal(d.utilizacao.mes.gastos_centavos, 48);
    assert.equal(d.uso_mes.movel.tarifado_s, 96);
    assert.equal(d.em_curso, 0);
    assert.ok(d.simultaneas.pico >= 1);
    // Disco (1 MB) cheio com a gravação de 2 MB: as próximas chamadas não são gravadas.
    assert.equal((await c.post('/chamadas', { uid: 'd1', direcao: 'interna', origem: '1001', destino: '1002' })).dados.gravar, false);
    await c.post('/chamadas/d1/fim', {});
    const csv = await api.get(`/empresas/${empresa}/chamadas.csv`, cliente);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.ok(csv.dados.includes('11987654321'));
    // O master vê as chamadas de todas as empresas.
    assert.equal((await api.get(`/master/chamadas?empresa_id=${empresa}`, master)).dados.total, 3);
  });

  await t.test('ramal: registro online e exclusão que preserva o histórico', async () => {
    const c = api.central(chave);
    assert.equal((await c.post('/ramais/1002/registro', { online: true, ip: '200.1.2.3', agente: 'Yealink' })).status, 200);
    const r = (await api.get(`/empresas/${empresa}/ramais`, cliente)).dados.find((x) => x.numero === '1002');
    assert.equal(r.online, 1);
    assert.equal(r.registro_ip, '200.1.2.3');
    assert.equal((await api.get(`/empresas/${empresa}/dashboard`, cliente)).dados.ramais.online, 1);
    // 1001 tem chamadas: só é desativado.
    assert.deepEqual((await api.del(`/empresas/${empresa}/ramais/${ramal1001}`, undefined, cliente)).dados, { desativado: true });
    assert.equal((await api.get(`/empresas/${empresa}/chamadas`, cliente)).dados.itens.find((x) => x.uid === 'a1').ramal, '1001');
  });

  await t.test('TTS/STT respeitam o limite do mês', async () => {
    const c = api.central(chave);
    assert.equal((await c.post('/recursos', { recurso: 'tts', quantidade: 8 })).status, 201);
    assert.equal((await c.post('/recursos', { recurso: 'tts', quantidade: 3 })).status, 429);
    assert.equal((await c.post('/recursos', { recurso: 'stt' })).status, 429);
    assert.deepEqual((await api.get(`/empresas/${empresa}/dashboard`, cliente)).dados.recursos.tts, { usado: 8, limite: 10 });
  });

  await t.test('campanha: importação, ativação e discador', async () => {
    const cp = (await api.post(`/empresas/${empresa}/campanhas`, { nome: 'Outubro', canais: 2 }, cliente)).dados.id;
    assert.equal((await api.patch(`/empresas/${empresa}/campanhas/${cp}`, { status: 'ativa' }, cliente)).status, 422, 'sem fila');
    assert.equal((await api.patch(`/empresas/${empresa}/campanhas/${cp}`, { fila_id: fila }, cliente)).status, 204);
    assert.equal((await api.patch(`/empresas/${empresa}/campanhas/${cp}`, { status: 'ativa' }, cliente)).status, 422, 'sem contatos');
    const imp = await api.post(`/empresas/${empresa}/campanhas/${cp}/contatos`, { linhas: 'Maria;11911112222\n11933334444\nrepetido;11933334444\ninválido;12' }, cliente);
    assert.deepEqual(imp.dados, { importados: 2, ignorados: 1, linhas_invalidas: [4] });
    assert.equal((await api.patch(`/empresas/${empresa}/campanhas/${cp}`, { status: 'ativa' }, cliente)).status, 204);
    const c = api.central(chave);
    const prox = (await c.post(`/campanhas/${cp}/proximos`)).dados;
    assert.equal(prox.contatos.length, 2);
    assert.equal(prox.fila.id, fila);
    assert.equal((await c.post(`/campanhas/${cp}/proximos`)).dados.contatos.length, 0, 'canais da campanha ocupados');
    const [x] = prox.contatos;
    await c.post('/chamadas', { uid: 'cp1', direcao: 'saida', origem: '1002', destino: x.telefone, campanha_contato_id: x.id });
    await c.post('/chamadas/cp1/atendida', {});
    await c.post('/chamadas/cp1/fim', {});
    const contatos = (await api.get(`/empresas/${empresa}/campanhas/${cp}/contatos`, cliente)).dados;
    assert.equal(contatos.find((y) => y.id === x.id).status, 'atendido');
    const sup = (await api.get(`/empresas/${empresa}/supervisao`, cliente)).dados;
    assert.equal(sup.campanhas[0].atendidos, 1);
    assert.equal((await api.get(`/empresas/${empresa}/chamadas?campanha_id=${cp}`, cliente)).dados.total, 1);
    assert.equal((await api.del(`/empresas/${empresa}/campanhas/${cp}`, undefined, cliente)).status, 422, 'campanha com chamadas não é excluída');
  });

  await t.test('CRM liga o contato às chamadas', async () => {
    const ct = await api.post(`/empresas/${empresa}/contatos`, { nome: 'Cliente VIP', telefone: '(11) 98765-4321' }, cliente);
    assert.equal(ct.status, 201);
    assert.equal((await api.post(`/empresas/${empresa}/contatos`, { nome: 'Dup', telefone: '11987654321' }, cliente)).status, 409);
    const det = (await api.get(`/empresas/${empresa}/contatos/${ct.dados.id}`, cliente)).dados;
    assert.equal(det.chamadas.length, 1);
    assert.equal((await api.get(`/empresas/${empresa}/chamadas?busca=VIP`, cliente)).dados.itens[0].contato, 'Cliente VIP');
  });

  await t.test('relatórios da empresa e do master', async () => {
    const r = (await api.get(`/empresas/${empresa}/relatorios`, cliente)).dados;
    assert.equal(r.total.chamadas, 4);
    assert.equal(r.total.atendidas, 2); // a1 e cp1 (b1 não atendida; d1 terminou sem atendimento)
    assert.equal(r.por_dia.length, 1);
    assert.ok(r.por_ramal.some((x) => x.numero === '1001'));
    const m = (await api.get('/master/relatorios', master)).dados;
    assert.equal(m.por_empresa[0].nome, 'Cobrança Ltda');
    assert.equal((await api.get('/master/relatorios?de=2020-01-01&ate=2026-10-21', master)).status, 422);
  });

  await t.test('bloqueio da empresa', async () => {
    assert.equal((await api.post(`/master/empresas/${empresa}/bloquear`, {}, master)).status, 422);
    assert.equal((await api.post(`/master/empresas/${empresa}/bloquear`, { motivo: 'Fatura em atraso' }, master)).status, 204);
    assert.equal((await api.get(`/empresas/${empresa}/dashboard`, cliente)).status, 401);
    assert.equal((await api.post('/auth/login', { email: 'gestora@cobranca.com', senha: 'senha-da-gestora' })).status, 403);
    assert.equal((await api.central(chave).post('/chamadas', { uid: 'z', direcao: 'saida', origem: '1002', destino: '1133224455' })).status, 403);
    assert.equal((await api.get(`/empresas/${empresa}/dashboard`, master)).status, 200, 'o master continua vendo');
    assert.equal((await api.post(`/master/empresas/${empresa}/desbloquear`, {}, master)).status, 204);
    cliente = await api.login('gestora@cobranca.com', 'senha-da-gestora');
  });

  await t.test('usuários da plataforma e proteção do último master', async () => {
    assert.equal((await api.post('/master/usuarios', { nome: 'Suporte', email: 'suporte@pabx.com.br', senha: 'senha-do-suporte', perfil: 'suporte' }, master)).status, 201);
    const suporte = await api.login('suporte@pabx.com.br', 'senha-do-suporte');
    assert.equal((await api.get('/master/empresas', suporte)).status, 200);
    assert.equal((await api.get('/master/usuarios', suporte)).status, 403);
    assert.equal((await api.patch('/master/configuracoes', { cadencia_s: 1 }, suporte)).status, 403);
    assert.equal((await api.del(`/master/empresas/${outra}`, { confirmacao: 'Outra Empresa' }, suporte)).status, 403);
    const eu = (await api.get('/auth/me', master)).dados.usuario.id;
    assert.equal((await api.patch(`/master/usuarios/${eu}`, { ativo: false }, master)).status, 422);
  });

  await t.test('segurança: auditoria de login e bloqueio de IP', async () => {
    assert.equal((await api.post('/auth/login', { email: 'master@pabx.com.br', senha: 'errada' })).status, 401);
    const resumo = (await api.get('/master/seguranca/resumo', master)).dados;
    assert.ok(resumo.falhas_login.some((x) => x.tentativas >= 1));
    assert.equal((await api.post('/master/seguranca/ips', { ip: '127.0.0.1' }, master)).status, 422, 'não bloqueia o próprio IP');
    assert.equal((await api.post('/master/seguranca/ips', { ip: '203.0.113.9', motivo: 'robô' }, master)).status, 201);
    api.db.prepare("UPDATE ips_bloqueados SET ip = '127.0.0.1' WHERE ip = '203.0.113.9'").run(); // simula acesso do IP bloqueado
    assert.equal((await api.get('/saude')).status, 403);
    api.db.prepare('DELETE FROM ips_bloqueados').run();
    assert.ok((await api.get('/master/seguranca/auditoria?acao=empresa_bloqueada', master)).dados.length >= 1);
  });

  await t.test('exclusão da empresa', async () => {
    const k = (await api.post('/master/chaves', { empresa_id: outra, nome: 'Central' }, master)).dados.chave;
    assert.equal((await api.del(`/master/empresas/${outra}`, { confirmacao: 'errado' }, master)).status, 422);
    assert.equal((await api.del(`/master/empresas/${outra}`, { confirmacao: 'Outra Empresa' }, master)).status, 204);
    assert.ok(!(await api.get('/master/empresas', master)).dados.some((e) => e.id === outra));
    assert.equal((await api.central(k).get('/config')).status, 401);
    assert.equal((await api.get(`/empresas/${outra}/dashboard`, master)).status, 404);
  });

  await t.test('diagnóstico e configurações', async () => {
    const d = (await api.get('/master/diagnostico', master)).dados;
    assert.equal(d.verificacoes[0].situacao, 'ok');
    assert.equal((await api.patch('/master/configuracoes', { cadencia_inicial_s: 60, cadencia_s: 60 }, master)).status, 204);
    assert.equal((await api.patch('/master/configuracoes', { nao_existe: 1 }, master)).status, 422);
    assert.equal((await api.get('/master/configuracoes', master)).dados.cadencia_s, 60);
  });

  await t.test('chamadas presas são encerradas e ramais sem registro ficam offline', async () => {
    const c = api.central(chave);
    await c.post('/chamadas', { uid: 'presa', direcao: 'interna', origem: '1002', destino: '1001', inicio: new Date(Date.now() - 7 * 3600_000).toISOString() });
    api.db.prepare("UPDATE ramais SET registro_em = '2020-01-01T00:00:00.000Z'").run();
    const d = (await api.get(`/empresas/${empresa}/dashboard`, cliente)).dados;
    assert.equal(d.em_curso, 0);
    assert.equal(d.ramais.online, 0);
    assert.equal(api.db.prepare("SELECT status FROM chamadas WHERE uid = 'presa'").get().status, 'falha');
  });
});
