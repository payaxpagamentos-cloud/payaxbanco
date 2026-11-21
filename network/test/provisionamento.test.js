'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { criarRouterOsFalso } = require('./routeros-falso');
const fat = require('../server/lib/faturamento');
const cob = require('../server/lib/cobranca');
const prov = require('../server/lib/provisionamento');
const { dataLocal } = require('../server/lib/datas');

const HOJE = dataLocal('America/Sao_Paulo');
const ATUAL = fat.competenciaDe(HOJE);
const ANTERIOR = fat.somarMeses(ATUAL, -1);
const RETRASADA = fat.somarMeses(ATUAL, -2);
const dia = (c, d) => `${c}-${String(d).padStart(2, '0')}`;
const ORG = 1;
const SENHA_ROTEADOR = 'senha-do-roteador';

/** Monta carteira, concentrador falso e o serviço provisionado de um contrato ativo. */
async function cenario(api, { senha = SENHA_ROTEADOR } = {}) {
  const admin = await api.login();
  const tk = { admin };
  for (const perfil of ['financeiro', 'noc', 'gestor']) {
    const r = await api.post('/organizacao/usuarios', { nome: `U ${perfil}`, email: `${perfil}.prov@teste.local`, senha: 'senha-teste-123', perfil }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    tk[perfil] = await api.login(`${perfil}.prov@teste.local`, 'senha-teste-123');
  }
  const roteador = criarRouterOsFalso({ senha });
  const { host, porta } = await roteador.iniciar();

  const pop = (await api.post('/rede/ativos', { tipo: 'pop', codigo: 'POP-01', nome: 'POP Centro' }, tk.noc)).dados;
  const equipamento = (await api.post('/rede/equipamentos', { tipo: 'roteador', nome: 'BRAS-01', ativo_id: pop.id, fabricante: 'MikroTik' }, tk.noc)).dados;
  const acesso = await api.put(`/provisionamento/equipamentos/${equipamento.id}/acesso`,
    { driver: 'mikrotik_routeros', papel: 'concentrador', host, porta, protocolo: 'http', usuario: 'admin', senha: SENHA_ROTEADOR }, admin);
  assert.equal(acesso.status, 200, JSON.stringify(acesso.dados));

  const plano = (await api.post('/planos', { nome: 'Fibra 500', tipo: 'internet', download_mbps: 500, upload_mbps: 250, mensalidade: '109,90' }, tk.financeiro)).dados;
  const assinante = (await api.post('/assinantes', { tipo: 'pf', nome: 'Maria Souza', documento: '390.533.447-05' }, tk.financeiro)).dados;
  const contrato = (await api.post('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 5 }, tk.financeiro)).dados;
  await api.post(`/contratos/${contrato.id}/ativar`, { ativacao: dia(RETRASADA, 1) }, tk.financeiro);
  return { tk, admin, roteador, equipamento, plano, assinante, contrato };
}

test('provisionamento: o driver fala com o equipamento e o sistema guarda o que ele respondeu', async (t) => {
  const api = await iniciar();
  const c = await cenario(api);
  t.after(async () => { await c.roteador.fechar(); await api.fechar(); });

  await t.test('catálogo de drivers diz o que cada um sabe fazer', async () => {
    const r = await api.get('/provisionamento/drivers', c.tk.noc);
    assert.equal(r.status, 200);
    const mk = r.dados.find((x) => x.nome === 'mikrotik_routeros');
    assert.equal(mk.fabricante, 'MikroTik');
    assert.deepEqual(mk.papeis, ['concentrador']);
    assert.ok(mk.capacidades.includes('cortar'));
    assert.ok(mk.campos.some((x) => x.nome === 'host'));
  });

  await t.test('teste de conexão identifica o equipamento de verdade', async () => {
    const r = await api.post(`/provisionamento/equipamentos/${c.equipamento.id}/testar`, {}, c.admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.situacao, 'concluida');
    assert.equal(r.dados.resultado.modelo, 'CCR2004-1G-12S+2XS');
    assert.equal(r.dados.resultado.versao, '7.14.3');
    assert.equal(r.dados.equipamento.estado_conexao, 'conectado');
    assert.equal(r.dados.equipamento.credencial_configurada, true);
    assert.equal(r.dados.equipamento.segredo_cifrado, undefined, 'a senha do equipamento nunca sai na resposta');
  });

  let servico;
  await t.test('serviço do contrato nasce com senha gerada e sem tocar no equipamento', async () => {
    c.roteador.limparChamadas();
    const r = await api.put(`/provisionamento/contratos/${c.contrato.id}/servico`,
      { concentrador_id: c.equipamento.id, login: 'maria.souza', tipo_acesso: 'pppoe' }, c.tk.financeiro);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    servico = r.dados;
    assert.equal(servico.login, 'maria.souza');
    assert.equal(servico.senha_definida, true);
    assert.equal(servico.senha_cifrada, undefined, 'a senha do acesso nunca sai na resposta');
    assert.equal(c.roteador.escritas().length, 0, 'cadastrar o serviço não escreve no equipamento');
  });

  await t.test('antes de aplicar, a divergência é "não existe no equipamento"', async () => {
    const r = await api.get(`/provisionamento/servicos/${servico.id}`, c.tk.noc);
    const d = r.dados.divergencias;
    assert.equal(d.length, 1);
    assert.equal(d[0].campo, 'leitura', 'sem leitura ainda, o sistema diz que não sabe em vez de inventar');
  });

  await t.test('ensaio descreve o que faria e não escreve nada', async () => {
    c.roteador.limparChamadas();
    const r = await api.post(`/provisionamento/servicos/${servico.id}/sincronizar?ensaio=1`, {}, c.tk.financeiro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.ensaio, true);
    assert.equal(r.dados.tarefa.situacao, 'concluida');
    assert.equal(r.dados.tarefa.resultado.ensaio, true);
    assert.match(r.dados.tarefa.resultado.mudancas.join(' | '), /criar acesso PPPoE maria\.souza/);
    assert.match(r.dados.tarefa.resultado.mudancas.join(' | '), /velocidade 250000k\/500000k/);
    assert.equal(c.roteador.escritas().length, 0, 'ensaio não escreve no equipamento');
    assert.equal(c.roteador.secretDe('maria.souza'), null);
  });

  await t.test('aplicar cria o acesso com a velocidade do plano', async () => {
    const r = await api.post(`/provisionamento/servicos/${servico.id}/sincronizar`, {}, c.tk.financeiro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.tarefa.situacao, 'concluida');
    const secret = c.roteador.secretDe('maria.souza');
    assert.ok(secret, 'o acesso existe no equipamento');
    assert.equal(secret.service, 'pppoe');
    assert.equal(secret.disabled, 'false');
    assert.equal(secret['rate-limit'], '250000k/500000k');
    assert.match(secret.comment, new RegExp(`contrato ${c.contrato.numero}`));
  });

  await t.test('depois de aplicar, o sistema lê de volta e a divergência some', async () => {
    const processado = await prov.processarFila(api.db, ORG);
    assert.ok(processado.executadas >= 1, 'a leitura de conferência entrou na fila sozinha');
    const r = await api.get(`/provisionamento/servicos/${servico.id}`, c.tk.noc);
    assert.equal(r.dados.estado_real.presente, true);
    assert.equal(r.dados.estado_real.situacao, 'liberado');
    assert.deepEqual(r.dados.divergencias, [], 'contratado e equipamento batem');
    assert.ok(r.dados.lido_em);
  });

  await t.test('aplicar de novo não mexe no equipamento à toa', async () => {
    c.roteador.limparChamadas();
    const r = await api.post(`/provisionamento/servicos/${servico.id}/sincronizar`, {}, c.tk.financeiro);
    assert.equal(r.dados.tarefa.resultado.semMudanca, true);
    assert.equal(c.roteador.escritas().length, 0);
  });

  await t.test('mudar o plano muda o desejado, e a divergência aparece sozinha', async () => {
    const novo = (await api.post('/planos', { nome: 'Fibra 700', tipo: 'internet', download_mbps: 700, upload_mbps: 350, mensalidade: '149,90' }, c.tk.financeiro)).dados;
    const atual = (await api.get(`/contratos/${c.contrato.id}`, c.tk.financeiro)).dados;
    await api.patch(`/contratos/${c.contrato.id}`, { plano_id: novo.id, versao: atual.versao }, c.tk.financeiro);
    const r = await api.get(`/provisionamento/servicos/${servico.id}`, c.tk.noc);
    const velocidade = r.dados.divergencias.find((x) => x.campo === 'velocidade');
    assert.ok(velocidade, 'o equipamento ficou com a velocidade do plano antigo');
    assert.equal(velocidade.esperado, '350000k/700000k');
    assert.equal(velocidade.real, '250000k/500000k');
    // Sincronizar resolve.
    await api.post(`/provisionamento/servicos/${servico.id}/sincronizar`, {}, c.tk.financeiro);
    await prov.processarFila(api.db, ORG);
    const depois = await api.get(`/provisionamento/servicos/${servico.id}`, c.tk.noc);
    assert.deepEqual(depois.dados.divergencias, []);
    assert.equal(c.roteador.secretDe('maria.souza')['rate-limit'], '350000k/700000k');
  });

  await t.test('corte desabilita o acesso e derruba a sessão, sem apagar a conta', async () => {
    c.roteador.conectar('maria.souza');
    assert.equal(c.roteador.conectado('maria.souza'), true);
    const r = await api.post(`/provisionamento/servicos/${servico.id}/cortar`, { motivo: 'Teste de corte' }, c.tk.financeiro);
    assert.equal(r.status, 200);
    assert.match(r.dados.tarefa.resultado.mudancas.join(' | '), /desabilitar o acesso/);
    assert.match(r.dados.tarefa.resultado.mudancas.join(' | '), /derrubar a sessão/);
    const secret = c.roteador.secretDe('maria.souza');
    assert.equal(secret.disabled, 'true');
    assert.ok(secret, 'o acesso continua no equipamento: corte não é exclusão');
    assert.equal(c.roteador.conectado('maria.souza'), false, 'a sessão em andamento caiu');
  });

  await t.test('contrato ativo com serviço cortado é divergência crítica', async () => {
    await prov.processarFila(api.db, ORG);
    const r = await api.get(`/provisionamento/servicos/${servico.id}`, c.tk.noc);
    const critica = r.dados.divergencias.find((x) => x.gravidade === 'critica');
    assert.ok(critica);
    assert.match(critica.texto, /contrato está ativo e o serviço está cortado/);
  });

  await t.test('religar devolve o acesso', async () => {
    await api.post(`/provisionamento/servicos/${servico.id}/religar`, {}, c.tk.financeiro);
    await prov.processarFila(api.db, ORG);
    assert.equal(c.roteador.secretDe('maria.souza').disabled, 'false');
    const r = await api.get(`/provisionamento/servicos/${servico.id}`, c.tk.noc);
    assert.deepEqual(r.dados.divergencias, []);
  });

  await t.test('a fila guarda o histórico de tudo que tocou o equipamento', async () => {
    const r = await api.get('/provisionamento/tarefas', c.tk.noc);
    assert.ok(r.dados.total >= 6);
    const acoes = r.dados.itens.map((x) => x.acao);
    for (const esperada of ['identificar', 'aplicar', 'ler', 'cortar', 'religar']) assert.ok(acoes.includes(esperada), `faltou ${esperada} no histórico`);
    assert.ok(r.dados.itens.every((x) => x.situacao !== 'executando'));
  });
});

test('provisionamento: equipamento fora do ar não perde o pedido nem trava o atendimento', async (t) => {
  const api = await iniciar();
  const c = await cenario(api);
  t.after(async () => { await c.roteador.fechar().catch(() => {}); await api.fechar(); });

  const servico = (await api.put(`/provisionamento/contratos/${c.contrato.id}/servico`,
    { concentrador_id: c.equipamento.id, login: 'maria.offline' }, c.tk.financeiro)).dados;
  await api.post(`/provisionamento/servicos/${servico.id}/sincronizar`, {}, c.tk.financeiro);
  await prov.processarFila(api.db, ORG);
  await c.roteador.fechar();

  await t.test('o pedido fica na fila com o erro legível e nova tentativa marcada', async () => {
    const r = await api.post(`/provisionamento/servicos/${servico.id}/cortar`, { motivo: 'Inadimplência' }, c.tk.financeiro);
    assert.equal(r.status, 200, 'a rota responde: o atendimento não fica preso esperando o equipamento');
    assert.equal(r.dados.tarefa.situacao, 'pendente', 'continua na fila para nova tentativa');
    assert.match(r.dados.tarefa.erro, /Não foi possível falar com o equipamento|não respondeu/);
    assert.ok(r.dados.tarefa.erro_id, 'o erro tem id para diagnóstico');
    assert.ok(r.dados.tarefa.proxima_tentativa);
  });

  await t.test('o equipamento fica marcado como em falha, com o erro', async () => {
    const r = await api.get('/provisionamento/equipamentos', c.tk.noc);
    const e = r.dados.find((x) => x.id === c.equipamento.id);
    assert.equal(e.estado_conexao, 'falha');
    assert.ok(e.ultimo_erro);
    assert.ok(e.erro_id);
  });

  await t.test('o mesmo pedido não entra duas vezes na fila', async () => {
    const antes = (await api.get('/provisionamento/tarefas?pendentes=1', c.tk.noc)).dados.total;
    await api.post(`/provisionamento/servicos/${servico.id}/cortar`, { motivo: 'de novo' }, c.tk.financeiro);
    const depois = (await api.get('/provisionamento/tarefas?pendentes=1', c.tk.noc)).dados.total;
    assert.equal(depois, antes, 'a tarefa pendente foi reaproveitada');
  });

  await t.test('credencial errada é falha permanente: não adianta repetir', async () => {
    const outro = criarRouterOsFalso({ senha: 'outra-senha' });
    const { host, porta } = await outro.iniciar();
    t.after(() => outro.fechar());
    await api.put(`/provisionamento/equipamentos/${c.equipamento.id}/acesso`,
      { driver: 'mikrotik_routeros', papel: 'concentrador', host, porta, protocolo: 'http', usuario: 'admin', senha: 'senha-errada' }, c.admin);
    const r = await api.post(`/provisionamento/equipamentos/${c.equipamento.id}/testar`, {}, c.admin);
    assert.equal(r.dados.situacao, 'falhou', 'falha permanente não fica repetindo');
    assert.equal(r.dados.proxima_tentativa, null);
    assert.match(r.dados.erro, /recusou a credencial/);
    assert.equal(r.dados.equipamento.estado_conexao, 'sem_permissao');
  });
});

test('provisionamento: a régua corta no equipamento e a quitação religa', async (t) => {
  const api = await iniciar();
  const c = await cenario(api);
  t.after(async () => { await c.roteador.fechar(); await api.fechar(); });

  const servico = (await api.put(`/provisionamento/contratos/${c.contrato.id}/servico`,
    { concentrador_id: c.equipamento.id, login: 'maria.regua' }, c.tk.financeiro)).dados;
  await api.post(`/provisionamento/servicos/${servico.id}/sincronizar`, {}, c.tk.financeiro);
  await prov.processarFila(api.db, ORG);
  await api.post('/cobranca/regras', { nome: 'Corte por atraso', dias: 5, acao: 'bloquear' }, c.tk.financeiro);
  const ciclo = await api.post('/faturamento/ciclos', { competencia: ANTERIOR }, c.tk.financeiro);
  assert.equal(ciclo.status, 201, JSON.stringify(ciclo.dados));

  await t.test('o bloqueio comercial da régua enfileira o corte no equipamento', async () => {
    c.roteador.conectar('maria.regua');
    const r = cob.rotinaDiaria(api.db, ORG, HOJE);
    assert.equal(r.regua.bloqueios, 1);
    assert.equal((await api.get(`/contratos/${c.contrato.id}`, c.tk.financeiro)).dados.situacao, 'bloqueado');
    const fila = (await api.get('/provisionamento/tarefas?pendentes=1', c.tk.noc)).dados.itens;
    assert.ok(fila.some((x) => x.acao === 'cortar' && x.origem === 'regua'), 'o corte entrou na fila vindo da régua');
  });

  await t.test('a fila executa e o assinante perde o acesso de verdade', async () => {
    await prov.processarFila(api.db, ORG);
    const secret = c.roteador.secretDe('maria.regua');
    assert.equal(secret.disabled, 'true');
    assert.equal(c.roteador.conectado('maria.regua'), false);
    await prov.processarFila(api.db, ORG);
    const r = await api.get(`/provisionamento/servicos/${servico.id}`, c.tk.noc);
    assert.equal(r.dados.estado_real.situacao, 'cortado');
    assert.deepEqual(r.dados.divergencias, [], 'contrato bloqueado e serviço cortado: bate');
  });

  await t.test('quitar religa o serviço no equipamento', async () => {
    for (const f of (await api.get('/faturamento/faturas?situacao=aberta', c.tk.financeiro)).dados.itens) {
      await api.post(`/faturamento/faturas/${f.id}/pagamentos`, { forma: 'pix' }, c.tk.financeiro);
    }
    assert.equal((await api.get(`/contratos/${c.contrato.id}`, c.tk.financeiro)).dados.situacao, 'ativo');
    await prov.processarFila(api.db, ORG);
    assert.equal(c.roteador.secretDe('maria.regua').disabled, 'false', 'o acesso voltou sozinho');
  });

  await t.test('com o corte automático desligado, o bloqueio é só comercial', async () => {
    await api.patch('/organizacao', { corte_automatico: false }, c.admin);
    const r = prov.pedirCorte(api.db, { org: ORG, contratoId: c.contrato.id, cortar: true });
    assert.equal(r.enfileirado, false);
    assert.match(r.motivo, /desligado nos parâmetros/);
  });

  await t.test('cancelar o contrato pede a remoção do acesso', async () => {
    await api.patch('/organizacao', { corte_automatico: true }, c.admin);
    await api.post(`/contratos/${c.contrato.id}/cancelar`, { motivo: 'Mudança de cidade' }, c.tk.financeiro);
    await prov.processarFila(api.db, ORG);
    await prov.processarFila(api.db, ORG);
    assert.equal(c.roteador.secretDe('maria.regua'), null, 'o acesso saiu do equipamento no cancelamento');
  });
});

test('provisionamento: reconciliação encontra o que foi mexido por fora do sistema', async (t) => {
  const api = await iniciar();
  const c = await cenario(api);
  t.after(async () => { await c.roteador.fechar(); await api.fechar(); });

  const servico = (await api.put(`/provisionamento/contratos/${c.contrato.id}/servico`,
    { concentrador_id: c.equipamento.id, login: 'maria.reconcilia' }, c.tk.financeiro)).dados;
  await api.post(`/provisionamento/servicos/${servico.id}/sincronizar`, {}, c.tk.financeiro);
  await prov.processarFila(api.db, ORG);

  await t.test('alguém libera no equipamento um contrato bloqueado: a releitura acusa', async () => {
    await api.post(`/cobranca/contratos/${c.contrato.id}/bloquear`, { tipo: 'administrativo', motivo: 'Suspeita de fraude' }, c.tk.financeiro);
    await prov.processarFila(api.db, ORG);
    assert.equal(c.roteador.secretDe('maria.reconcilia').disabled, 'true');
    // Mão de alguém direto no equipamento, por fora do sistema.
    c.roteador.secretDe('maria.reconcilia').disabled = 'false';
    // Com a fila vazia e a última leitura envelhecida, a releitura periódica tem de pegar este serviço.
    await prov.processarFila(api.db, ORG);
    api.db.prepare('UPDATE servicos SET lido_em = ? WHERE id = ?').run(new Date(Date.now() - 48 * 3600_000).toISOString(), servico.id);
    const enfileirados = prov.reconciliar(api.db, ORG, { horas: 12 });
    assert.equal(enfileirados.enfileirados, 1, 'a releitura do serviço desatualizado foi para a fila');
    assert.equal(prov.reconciliar(api.db, ORG, { horas: 12 }).ja_na_fila, 1, 'reconciliar de novo não duplica a leitura');
    await prov.processarFila(api.db, ORG);
    const r = await api.get('/provisionamento/reconciliacao', c.tk.noc);
    assert.equal(r.status, 200);
    assert.equal(r.dados.criticos, 1);
    const alvo = r.dados.divergentes[0];
    assert.equal(alvo.login, 'maria.reconcilia');
    assert.match(alvo.divergencias[0].texto, /bloqueado e o serviço continua liberado/);
  });

  await t.test('o filtro de divergentes mostra só o que está fora', async () => {
    const r = await api.get('/provisionamento/servicos?divergentes=1', c.tk.noc);
    assert.equal(r.dados.itens.length, 1);
    assert.equal(r.dados.itens[0].login, 'maria.reconcilia');
  });

  await t.test('permissões: quem não mexe em rede nem em contrato não provisiona', async () => {
    assert.equal((await api.put(`/provisionamento/equipamentos/${c.equipamento.id}/acesso`, { driver: 'mikrotik_routeros', host: '10.0.0.1', usuario: 'x', senha: 'y' }, c.tk.financeiro)).status, 403);
    assert.equal((await api.post(`/provisionamento/servicos/${servico.id}/cortar`, { motivo: 'x' }, c.tk.gestor)).status, 403);
    // O gestor operacional vê a rede, e o financeiro precisa ver a divergência: serviço liberado com
    // contrato bloqueado é receita escapando. Quem não tem nem rede nem faturamento é que fica de fora.
    assert.equal((await api.get('/provisionamento/reconciliacao', c.tk.gestor)).status, 200);
    assert.equal((await api.get('/provisionamento/reconciliacao', c.tk.financeiro)).status, 200);
    await api.post('/organizacao/usuarios', { nome: 'K', email: 'k.prov@teste.local', senha: 'senha-teste-123', perfil: 'comissoes' }, c.admin);
    const comissoes = await api.login('k.prov@teste.local', 'senha-teste-123');
    assert.equal((await api.get('/provisionamento/reconciliacao', comissoes)).status, 403);
    // O técnico de campo tem rede.ver, mas a base de assinantes não é dele: nem serviços, nem fila, nem divergências.
    await api.post('/organizacao/usuarios', { nome: 'T', email: 't.prov@teste.local', senha: 'senha-teste-123', perfil: 'tecnico' }, c.admin);
    const tecnico = await api.login('t.prov@teste.local', 'senha-teste-123');
    assert.equal((await api.get('/provisionamento/reconciliacao', tecnico)).status, 403);
    assert.equal((await api.get('/provisionamento/servicos', tecnico)).status, 403);
    assert.equal((await api.get('/provisionamento/tarefas', tecnico)).status, 403);
    assert.equal((await api.get('/provisionamento/equipamentos', tecnico)).status, 200, 'a planta de rede continua sendo do técnico');
    const outro = await api.outraOrganizacao();
    assert.equal((await api.get(`/provisionamento/servicos/${servico.id}`, outro)).status, 404);
    assert.equal((await api.get('/provisionamento/equipamentos', outro)).dados.length, 0);
  });

  await t.test('endereço de gerência inválido é recusado com o motivo', async () => {
    const tentar = (host) => api.put(`/provisionamento/equipamentos/${c.equipamento.id}/acesso`,
      { driver: 'mikrotik_routeros', papel: 'concentrador', host, usuario: 'admin', senha: 'x' }, c.admin);
    assert.equal((await tentar('')).status, 400);
    assert.equal((await tentar('169.254.1.1')).status, 400);
    assert.equal((await tentar('http://10.0.0.1/rest')).status, 400);
    assert.equal((await tentar('10.0.0.1')).status, 200, 'rede interna é onde o equipamento vive');
  });
});
