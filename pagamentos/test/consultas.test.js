'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, CNPJ } = require('./helpers');
const { criarFontes } = require('./fontes-falsas');
const config = require('../server/config');

test('consulta de CEP e CNPJ: fontes, cache e queda para a pública', async (t) => {
  const api = await iniciar();
  const fontes = criarFontes();
  await fontes.iniciar();
  const cepPadrao = config.dados.cepFonte;
  const cnpjPadrao = config.dados.cnpjFonte;
  t.after(async () => {
    config.dados.cepFonte = cepPadrao;
    config.dados.cnpjFonte = cnpjPadrao;
    await api.fechar();
    await fontes.fechar();
  });

  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const cliente = await api.cliente(tk.admin);

  await t.test('exige sessão', async () => {
    assert.equal((await api.get('/api/consultas/cep/11704000')).status, 401);
    assert.equal((await api.get('/cliente/api/consultas/cep/11704000')).status, 401);
  });

  await t.test('CEP pela fonte pública preenche o endereço', async () => {
    config.dados.cepFonte = 'publica';
    const r = await api.get('/api/consultas/cep/11704-000', tk.operacao);
    assert.equal(r.status, 200);
    assert.deepEqual(
      { cidade: r.dados.cidade, uf: r.dados.uf, bairro: r.dados.bairro, endereco: r.dados.endereco, fonte: r.dados.fonte },
      { cidade: 'Praia Grande', uf: 'SP', bairro: 'Tupi', endereco: 'Rua Martins Fontes', fonte: 'publica' },
    );
    assert.equal(r.dados.do_cache, false);
  });

  await t.test('a segunda consulta vem do cache, sem bater na fonte', async () => {
    const antes = fontes.chamadas.length;
    const r = await api.get('/api/consultas/cep/11704000', tk.operacao);
    assert.equal(r.dados.do_cache, true);
    assert.equal(r.dados.cidade, 'Praia Grande');
    assert.equal(fontes.chamadas.length, antes, 'nenhuma chamada nova à fonte');
  });

  await t.test('CEP inexistente e CEP malformado', async () => {
    assert.equal((await api.get('/api/consultas/cep/99999999', tk.operacao)).status, 404);
    assert.equal((await api.get('/api/consultas/cep/123', tk.operacao)).status, 422);
  });

  await t.test('CNPJ traz razão social e endereço, sem guardar o quadro societário', async () => {
    config.dados.cnpjFonte = 'publica';
    const r = await api.get(`/api/consultas/cnpj/${CNPJ.beta}`, tk.operacao);
    assert.equal(r.status, 200);
    assert.equal(r.dados.razao_social, 'OPEN KNOWLEDGE BRASIL');
    assert.equal(r.dados.nome_fantasia, 'REDE PELO CONHECIMENTO LIVRE');
    assert.equal(r.dados.endereco, 'AVENIDA PAULISTA', 'o número sai do logradouro');
    assert.equal(r.dados.numero, '37');
    assert.equal(r.dados.ativa, true);
    assert.equal(r.dados.qsa, undefined, 'sócios não são guardados nem devolvidos');
    const guardado = JSON.parse(api.db.prepare("SELECT dados FROM consultas_cache WHERE tipo = 'cnpj'").get().dados);
    assert.equal(guardado.qsa, undefined);
  });

  await t.test('CNPJ inválido nem chega à fonte', async () => {
    const antes = fontes.chamadas.length;
    const r = await api.get('/api/consultas/cnpj/11111111111111', tk.operacao);
    assert.equal(r.status, 422);
    assert.equal(fontes.chamadas.length, antes);
  });

  await t.test('escolhida a API Brasil sem token, a consulta sai pela fonte pública', async () => {
    config.dados.cnpjFonte = 'apibrasil';
    api.db.prepare('DELETE FROM consultas_cache').run();
    const r = await api.get(`/api/consultas/cnpj/${CNPJ.beta}`, tk.operacao);
    assert.equal(r.dados.fonte, 'publica');
    const estado = (await api.get('/api/integracoes', tk.operacao)).dados.dados;
    assert.equal(estado.apibrasil_configurada, false);
    assert.equal(estado.cnpj.escolhida, 'apibrasil');
    assert.equal(estado.cnpj.fonte, 'publica');
  });

  await t.test('com token, a consulta sai pela API Brasil', async () => {
    assert.equal((await api.put('/api/integracoes/dados', { token: 'token-bom' }, tk.admin)).status, 200);
    api.db.prepare('DELETE FROM consultas_cache').run();
    const r = await api.get(`/api/consultas/cnpj/${CNPJ.beta}`, tk.operacao);
    assert.equal(r.dados.fonte, 'apibrasil');
    assert.equal(r.dados.razao_social, 'OPEN KNOWLEDGE BRASIL');
    assert.equal(r.dados.endereco, 'AVENIDA PAULISTA');
    const ultima = fontes.chamadas.at(-1);
    assert.match(ultima.url, /apibrasil\/cnpj$/);
    assert.equal(ultima.autorizacao, 'Bearer token-bom');
  });

  await t.test('token recusado não trava o cadastro: cai para a fonte pública com aviso', async () => {
    await api.put('/api/integracoes/dados', { token: 'token-errado' }, tk.admin);
    api.db.prepare('DELETE FROM consultas_cache').run();
    const r = await api.get(`/api/consultas/cnpj/${CNPJ.beta}`, tk.operacao);
    assert.equal(r.status, 200);
    assert.equal(r.dados.fonte, 'publica');
    assert.match(r.dados.aviso, /API Brasil/);
    assert.equal(r.dados.razao_social, 'OPEN KNOWLEDGE BRASIL');
  });

  await t.test('o teste da integração diz por qual fonte cada consulta saiu', async () => {
    await api.put('/api/integracoes/dados', { token: 'token-bom' }, tk.admin);
    api.db.prepare('DELETE FROM consultas_cache').run();
    const r = await api.post('/api/integracoes/dados/testar', { cnpj: CNPJ.beta, cep: '11704000' }, tk.operacao);
    assert.equal(r.status, 200);
    assert.equal(r.dados.cnpj.fonte, 'apibrasil');
    assert.equal(r.dados.cep.fonte, 'publica', 'o CEP segue na fonte sem custo');
  });

  await t.test('o Internet Bank consulta pelos próprios dados do pagador', async () => {
    const r = await api.get('/cliente/api/consultas/cep/11704000', cliente.token);
    assert.equal(r.status, 200);
    assert.equal(r.dados.cidade, 'Praia Grande');
  });

  await t.test('a fonte identifica o cliente com nome genérico, sem dado nosso', () => {
    for (const c of fontes.chamadas) {
      assert.equal(c.ua, 'PayAxPagamentos/1.0');
      assert.ok(!JSON.stringify(c.dados).includes('@'), 'nenhum e-mail sai nas consultas');
    }
  });
});
