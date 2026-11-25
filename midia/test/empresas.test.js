'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Empresas separadas: cada empresa só enxerga e só mexe no que é dela (pontos, TVs, anunciantes,
 * campanhas, criativos, CRM, financeiro, relatórios). O master enxerga tudo. E a campanha de uma
 * empresa nunca entra no loop de uma TV de outra.
 */
test('Empresas: cada uma vê e mexe só no que é dela', async (t) => {
  const { iniciar, png, limparArquivos } = require('./helpers');
  const grade = require('../server/lib/grade');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); });
  const master = await api.login();

  // Duas empresas, uma pessoa em cada.
  const a = (await api.post('/painel/empresas', { nome: 'Mídia Campinas' }, master)).dados.id;
  const b = (await api.post('/painel/empresas', { nome: 'Mídia Valinhos' }, master)).dados.id;
  await api.post('/painel/usuarios', { nome: 'Ana', email: 'ana@a.com.br', senha: 'senha-da-ana', perfil: 'administrador', empresa_id: a }, master);
  await api.post('/painel/usuarios', { nome: 'Beto', email: 'beto@b.com.br', senha: 'senha-do-beto', perfil: 'operador', empresa_id: b }, master);
  const ana = await api.login('ana@a.com.br', 'senha-da-ana');
  const beto = await api.login('beto@b.com.br', 'senha-do-beto');

  // Cada uma cadastra o seu: ponto, TV, anunciante, criativo e campanha.
  const montar = async (tk, sufixo) => {
    const ponto = (await api.post('/painel/locais', { nome: `Ponto ${sufixo}`, categoria: 'outro', cidade: 'Campinas', uf: 'SP', publico_dia: 100 }, tk)).dados.id;
    const tela = (await api.post('/painel/telas', { local_id: ponto, nome: `TV ${sufixo}` }, tk)).dados.id;
    api.db.prepare('UPDATE telas SET pareada_em = ? WHERE id = ?').run(new Date().toISOString(), tela);
    const anunciante = (await api.post('/painel/anunciantes', { nome: `Cliente ${sufixo}` }, tk)).dados.id;
    const midia = (await api.enviarArquivo(`/painel/midias?nome=Peca+${sufixo}&anunciante_id=${anunciante}`, png(1920, 1080), tk)).dados.id;
    await api.post(`/painel/midias/${midia}/aprovacao`, { decisao: 'aprovar' }, tk);
    const hoje = new Date().toLocaleDateString('en-CA');
    const campanha = (await api.post('/painel/campanhas', {
      anunciante_id: anunciante, nome: `Campanha ${sufixo}`, inicio: hoje, cobranca: 'cortesia', insercoes_hora: 6,
      dias_semana: '0123456', hora_inicio: '00:00', hora_fim: '00:00', criativos: [{ midia_id: midia }],
    }, tk)).dados.id;
    api.db.prepare("UPDATE campanhas SET status = 'ativa' WHERE id = ?").run(campanha);
    const lead = (await api.post('/painel/crm/leads', { nome: `Lead ${sufixo}`, tipo: 'anunciante', origem: 'indicacao' }, tk)).dados.id;
    return { ponto, tela, anunciante, midia, campanha, lead };
  };
  const da = await montar(ana, 'A');
  const db_ = await montar(beto, 'B');

  // Listas: só o próprio.
  const nomes = async (rota, tk, campo = 'nome') => (await api.get(rota, tk)).dados.itens.map((x) => x[campo]);
  assert.deepEqual(await nomes('/painel/locais', ana), ['Ponto A']);
  assert.deepEqual(await nomes('/painel/locais', beto), ['Ponto B']);
  assert.deepEqual(await nomes('/painel/telas', ana), ['TV A']);
  assert.deepEqual(await nomes('/painel/anunciantes', beto), ['Cliente B']);
  assert.deepEqual(await nomes('/painel/campanhas', ana), ['Campanha A']);
  assert.deepEqual(await nomes('/painel/midias', beto), ['Peca B']);
  const funilA = (await api.get('/painel/crm/funil', ana)).dados.etapas.flatMap((e) => e.itens.map((l) => l.nome));
  assert.deepEqual(funilA, ['Lead A']);
  const opcoesB = (await api.get('/painel/opcoes', beto)).dados;
  assert.deepEqual(opcoesB.locais.map((l) => l.nome), ['Ponto B'], 'os seletores também só mostram o da empresa');
  assert.deepEqual(opcoesB.empresas, [], 'só o master vê a lista de empresas');

  // O master vê as duas.
  const doMaster = await nomes('/painel/locais', master);
  assert.ok(doMaster.includes('Ponto A') && doMaster.includes('Ponto B'));

  // Abrir, alterar ou apagar o da outra: como se não existisse.
  assert.equal((await api.get(`/painel/locais/${db_.ponto}`, ana)).status, 404);
  assert.equal((await api.get(`/painel/campanhas/${da.campanha}`, beto)).status, 404);
  assert.equal((await api.patch(`/painel/anunciantes/${db_.anunciante}`, { nome: 'Invadido' }, ana)).status, 404);
  assert.equal((await api.get(`/painel/crm/leads/${da.lead}`, beto)).status, 404);
  assert.equal((await api.get(`/painel/midias/${da.midia}/arquivo`, beto)).status, 404);

  // Apontar para o da outra (no corpo do pedido): recusado.
  assert.equal((await api.post('/painel/telas', { local_id: db_.ponto, nome: 'TV intrusa' }, ana)).status, 404);
  assert.equal((await api.post('/painel/campanhas', {
    anunciante_id: db_.anunciante, nome: 'Intrusa', inicio: '2026-01-01', cobranca: 'cortesia',
  }, ana)).status, 404);
  assert.equal((await api.post(`/painel/campanhas/${da.campanha}/criativos`, { midia_id: db_.midia }, ana)).status, 404);

  // A TV da empresa B nunca passa a campanha da empresa A, e vice-versa.
  const loopA = JSON.stringify(grade.montarPorTela(api.db, da.tela));
  const loopB = JSON.stringify(grade.montarPorTela(api.db, db_.tela));
  assert.ok(loopA.includes('Campanha A') && !loopA.includes('Campanha B'), 'TV A: só a campanha A');
  assert.ok(loopB.includes('Campanha B') && !loopB.includes('Campanha A'), 'TV B: só a campanha B');

  // Equipe: cada empresa vê a sua; ninguém de empresa cria master.
  assert.ok(!(await nomes('/painel/usuarios', ana)).includes('Beto'));
  assert.equal((await api.get('/painel/empresas', ana)).status, 403);

  // Empresa desativada: a equipe dela não entra mais.
  await api.patch(`/painel/empresas/${b}`, { ativo: false }, master);
  assert.equal((await api.get('/painel/locais', beto)).status, 401);
});

test('Empresas: banco antigo vira a empresa inicial, sem perder nada', () => {
  const { abrir } = require('../server/db');
  const db = abrir(':memory:');
  const inicial = db.prepare('SELECT * FROM empresas').all();
  assert.equal(inicial.length, 1, 'a instalação nasce com uma empresa');
  // Quem chega sem empresa (site, portal, caixa de e-mail) cai na inicial.
  db.prepare("INSERT INTO anunciantes (nome, status, criado_em) VALUES ('Veio do site', 'ativo', '2026-01-01')").run();
  assert.equal(db.prepare("SELECT empresa_id FROM anunciantes WHERE nome = 'Veio do site'").get().empresa_id, inicial[0].id);
});
