'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const consultas = require('../server/lib/consultas');

/*
 * As fontes públicas são simuladas: o teste é sobre o comportamento do sistema (validar antes de gastar a cota,
 * cair para a fonte seguinte, usar o cache, e nunca travar o cadastro quando ninguém responde), não sobre a
 * disponibilidade da internet. O formato de cada resposta aqui é o real, copiado das fontes.
 */
const RECEITA = {
  cnpj: '45997418000153',
  razao_social: 'COCA COLA INDUSTRIAS LTDA',
  nome_fantasia: '',
  descricao_tipo_de_logradouro: 'PRAIA',
  logradouro: 'DE BOTAFOGO',
  numero: '374',
  complemento: 'ANDAR 12 PARTE',
  bairro: 'BOTAFOGO',
  municipio: 'RIO DE JANEIRO',
  uf: 'RJ',
  cep: '22250040',
  ddd_telefone_1: '2125591000',
  email: null,
  descricao_situacao_cadastral: 'ATIVA',
  data_situacao_cadastral: '2005-11-03',
  data_inicio_atividade: '1971-12-24',
  cnae_fiscal_descricao: 'Fabricação de outros produtos alimentícios',
  natureza_juridica: 'Sociedade Empresária Limitada',
  porte: 'DEMAIS',
};
const CEP = { cep: '01310100', state: 'SP', city: 'São Paulo', neighborhood: 'Bela Vista', street: 'Avenida Paulista',
  ibge: { city: '3550308' }, location: { coordinates: { longitude: '-46.63611', latitude: '-23.5475' } } };

/**
 * Troca o fetch global por um roteador de respostas e devolve as chamadas feitas.
 * As chamadas do próprio teste ao servidor local passam direto: só as fontes externas são simuladas.
 */
function simularFontes(rotas) {
  const original = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url, opcoes) => {
    if (/^http:\/\/127\.0\.0\.1:/.test(String(url))) return original(url, opcoes);
    chamadas.push(String(url));
    for (const [padrao, resposta] of rotas) {
      if (!String(url).includes(padrao)) continue;
      if (resposta instanceof Error) throw resposta;
      if (typeof resposta === 'number') return new Response('', { status: resposta });
      return new Response(JSON.stringify(resposta), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  };
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
}

test('consulta de CNPJ e CEP: valida antes de gastar a cota, usa cache e nunca trava o cadastro', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const admin = await api.login();
  const r = await api.post('/organizacao/usuarios', { nome: 'Fin', email: 'fin.consulta@teste.local', senha: 'senha-teste-123', perfil: 'financeiro' }, admin);
  assert.equal(r.status, 201);
  const financeiro = await api.login('fin.consulta@teste.local', 'senha-teste-123');
  const gestor = await (async () => {
    await api.post('/organizacao/usuarios', { nome: 'G', email: 'g.consulta@teste.local', senha: 'senha-teste-123', perfil: 'gestor' }, admin);
    return api.login('g.consulta@teste.local', 'senha-teste-123');
  })();

  await t.test('documento inválido é recusado antes de qualquer chamada à fonte', async () => {
    const f = simularFontes([]);
    t.after(f.restaurar);
    assert.equal((await api.get('/consultas/cnpj/11111111111111', financeiro)).status, 422);
    assert.equal((await api.get('/consultas/cnpj/123', financeiro)).status, 422);
    assert.equal((await api.get('/consultas/cep/123', financeiro)).status, 422);
    assert.equal(f.chamadas.length, 0, 'nenhuma consulta externa foi feita');
    f.restaurar();
  });

  await t.test('CNPJ: o endereço da Receita vira cadastro legível', async () => {
    const f = simularFontes([['brasilapi.com.br/api/cnpj', RECEITA]]);
    const resp = await api.get('/consultas/cnpj/45997418000153', financeiro);
    f.restaurar();
    assert.equal(resp.status, 200);
    const d = resp.dados.dados;
    assert.equal(resp.dados.encontrado, true);
    assert.equal(resp.dados.fonte, 'BrasilAPI');
    assert.equal(d.nome, 'Coca Cola Industrias Ltda', 'caixa alta da Receita vira nome legível');
    assert.equal(d.logradouro, 'Praia de Botafogo', 'tipo e nome do logradouro vêm juntos');
    assert.equal(d.numero, '374');
    assert.equal(d.cidade, 'Rio de Janeiro');
    assert.equal(d.uf, 'RJ');
    assert.equal(d.telefone, '2125591000');
    assert.equal(d.situacao, 'ATIVA');
    assert.equal(d.nome_fantasia, null, 'vazio da fonte não vira string vazia');
  });

  await t.test('a segunda consulta do mesmo número vem do cache, sem tocar na fonte', async () => {
    const f = simularFontes([]);
    const resp = await api.get('/consultas/cnpj/45997418000153', financeiro);
    f.restaurar();
    assert.equal(resp.dados.do_cache, true);
    assert.equal(resp.dados.dados.nome, 'Coca Cola Industrias Ltda');
    assert.equal(f.chamadas.length, 0);
  });

  await t.test('forcar=1 ignora o cache e consulta de novo', async () => {
    const f = simularFontes([['brasilapi.com.br/api/cnpj', { ...RECEITA, razao_social: 'COCA COLA INDUSTRIAS S/A' }]]);
    const resp = await api.get('/consultas/cnpj/45997418000153?forcar=1', financeiro);
    f.restaurar();
    assert.equal(resp.dados.do_cache, false);
    assert.equal(resp.dados.dados.nome, 'Coca Cola Industrias S/A');
    assert.equal(f.chamadas.length, 1);
  });

  await t.test('CEP: a fonte traz endereço e coordenadas', async () => {
    const f = simularFontes([['brasilapi.com.br/api/cep', CEP]]);
    const resp = await api.get('/consultas/cep/01310100', financeiro);
    f.restaurar();
    const d = resp.dados.dados;
    assert.equal(d.logradouro, 'Avenida Paulista');
    assert.equal(d.bairro, 'Bela Vista');
    assert.equal(d.cidade, 'São Paulo');
    assert.equal(d.uf, 'SP');
    assert.equal(d.latitude, -23.5475);
  });

  await t.test('fonte fora do ar cai para a seguinte e diz de onde veio o dado', async () => {
    const f = simularFontes([
      ['brasilapi.com.br/api/cep', new Error('getaddrinfo ENOTFOUND')],
      ['opencep.com', { cep: '30130-010', logradouro: 'Praça Sete de Setembro', bairro: 'Centro', localidade: 'Belo Horizonte', uf: 'MG', ibge: '3106200' }],
    ]);
    const resp = await api.get('/consultas/cep/30130010', financeiro);
    f.restaurar();
    assert.equal(resp.dados.encontrado, true);
    assert.equal(resp.dados.fonte, 'OpenCEP');
    assert.equal(resp.dados.dados.cidade, 'Belo Horizonte');
    assert.match(resp.dados.aviso, /primeira fonte falhou/);
  });

  await t.test('CEP que não existe é resposta, não falha', async () => {
    const f = simularFontes([['brasilapi.com.br/api/cep', 404], ['opencep.com', 404]]);
    const resp = await api.get('/consultas/cep/99999999', financeiro);
    f.restaurar();
    assert.equal(resp.status, 200);
    assert.equal(resp.dados.encontrado, false);
    assert.match(resp.dados.aviso, /não encontrado/i);
  });

  await t.test('nenhuma fonte respondendo não trava o cadastro: devolve o motivo', async () => {
    const f = simularFontes([
      ['brasilapi.com.br/api/cep', new Error('connect ETIMEDOUT')],
      ['opencep.com', new Error('connect ETIMEDOUT')],
    ]);
    const resp = await api.get('/consultas/cep/88010000', financeiro);
    f.restaurar();
    assert.equal(resp.status, 200);
    assert.equal(resp.dados.encontrado, false);
    assert.match(resp.dados.aviso, /Preencha à mão/);
    assert.match(resp.dados.aviso, /BrasilAPI|OpenCEP/);
  });

  await t.test('sem fonte agora, o cache vencido ainda serve — dizendo que é antigo', async () => {
    api.db.prepare(`INSERT INTO consultas_cache (tipo, chave, dados, fonte, consultado_em) VALUES ('cep', '04538133', ?, 'BrasilAPI', ?)
      ON CONFLICT (tipo, chave) DO UPDATE SET consultado_em = excluded.consultado_em`)
      .run(JSON.stringify({ cep: '04538133', cidade: 'São Paulo', uf: 'SP' }), new Date(Date.now() - 400 * 86400_000).toISOString());
    const f = simularFontes([['brasilapi', new Error('sem rede')], ['opencep', new Error('sem rede')]]);
    const resp = await api.get('/consultas/cep/04538133', financeiro);
    f.restaurar();
    assert.equal(resp.dados.encontrado, true);
    assert.equal(resp.dados.do_cache, true);
    assert.match(resp.dados.aviso, /pode estar desatualizado/);
  });

  await t.test('permissões: a consulta segue quem pode cadastrar', async () => {
    await api.post('/organizacao/usuarios', { nome: 'C', email: 'c.consulta@teste.local', senha: 'senha-teste-123', perfil: 'comissoes' }, admin);
    const comissoes = await api.login('c.consulta@teste.local', 'senha-teste-123');
    assert.equal((await api.get('/consultas/cnpj/45997418000153', gestor)).status, 403, 'gestor não cadastra assinante');
    // O gestor edita a planta óptica, então consultar CEP faz parte do trabalho dele.
    assert.equal((await api.get('/consultas/cep/01310100', gestor)).status, 200);
    assert.equal((await api.get('/consultas/cep/01310100', comissoes)).status, 403, 'conferência de comissões não cadastra nada');
    assert.equal((await api.get('/consultas/cnpj/45997418000153')).status, 401, 'sem sessão');
  });

  await t.test('a consulta entra na auditoria, para o cadastro explicar de onde veio o endereço', async () => {
    const log = (await api.get('/organizacao/auditoria?acao=consulta_cnpj', admin)).dados.itens;
    assert.ok(log.length >= 1);
    assert.match(log[0].depois, /BrasilAPI/);
  });
});

test('consulta: capitalização e normalização', () => {
  assert.equal(consultas.capitalizar('COCA COLA INDUSTRIAS LTDA'), 'Coca Cola Industrias Ltda');
  assert.equal(consultas.capitalizar('BANCO DO BRASIL S/A'), 'Banco do Brasil S/A');
  assert.equal(consultas.capitalizar('MERCADO 24 HORAS'), 'Mercado 24 Horas');
  assert.equal(consultas.capitalizar('Já Está Normal'), 'Já Está Normal', 'texto que não veio em caixa alta não é mexido');
  assert.equal(consultas.capitalizar(''), null);
  assert.equal(consultas.normalizar('cep', '11701-000'), '11701000');
  assert.equal(consultas.normalizar('cnpj', '45.997.418/0001-53'), '45997418000153');
  assert.throws(() => consultas.normalizar('cnpj', '45997418000154'), /inválido/);
});
