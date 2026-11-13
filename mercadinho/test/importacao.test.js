'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

const csv = (...linhas) => Buffer.from(linhas.join('\n'), 'utf8');
const enviar = (app, caminho, texto, token) => app.enviarArquivo(caminho, texto, 'text/csv', token);

test('importar catálogo: confere antes de gravar', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  await app.post('/produtos', { nome: 'Arroz 5 kg', codigo_barras: '7891000053508', preco: '28,90', custo: '21,50', estoque: '10', categoria_id: 1 }, admin);

  const planilha = csv(
    'Nome;Código de barras;Categoria;Fornecedor;Unidade;Preço de venda;Custo;Estoque;Estoque mínimo;Pesável',
    'Arroz 5 kg;7891000053508;Mercearia;Distribuidora Boa;un;31,90;23,00;30;6;não',
    'Mamão formosa - kg;;Hortifrúti;;kg;8,90;5,10;14;4;sim',
  );

  const conferencia = await enviar(app, '/produtos/importar', planilha, admin);
  assert.equal(conferencia.status, 200);
  assert.deepEqual(conferencia.dados.resumo.criar, 1);
  assert.deepEqual(conferencia.dados.resumo.atualizar, 1);
  assert.deepEqual(conferencia.dados.resumo.erros, 0);
  assert.deepEqual(conferencia.dados.resumo.fornecedores_novos, ['Distribuidora Boa']);
  const arroz = conferencia.dados.itens.find((i) => i.acao === 'atualizar');
  assert.deepEqual(arroz.mudancas, ['preço 28,90 → 31,90', 'custo 21,50 → 23,00', 'mínimo 0 → 6']);

  // A conferência não grava nada.
  assert.equal((await app.get('/produtos', admin)).dados.length, 1);
  assert.equal((await app.get('/produtos', admin)).dados[0].preco_centavos, 2890);

  // Agora grava.
  const aplicado = await enviar(app, '/produtos/importar?aplicar=1', planilha, admin);
  assert.equal(aplicado.status, 200);
  assert.equal(aplicado.dados.criados, 1);
  assert.equal(aplicado.dados.atualizados, 1);
  assert.equal(aplicado.dados.fornecedores, 1);

  const lista = (await app.get('/produtos', admin)).dados;
  assert.equal(lista.length, 2);
  const atualizado = lista.find((p) => p.codigo_barras === '7891000053508');
  assert.equal(atualizado.preco_centavos, 3190);
  assert.equal(atualizado.custo_centavos, 2300);
  assert.equal(atualizado.estoque_mil, 10_000); // estoque de quem já existe não muda sem pedir
  const novo = lista.find((p) => p.nome.startsWith('Mamão'));
  assert.equal(novo.pesavel, 1);
  assert.equal(novo.unidade, 'kg');
  assert.equal(novo.estoque_mil, 14_000);
  assert.equal(novo.preco_centavos, 890);
});

test('importar catálogo: erros de planilha barram a gravação', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();

  const comErro = csv('nome;preco', 'Produto sem preço;', 'Biscoito;4,50');
  const conferencia = await enviar(app, '/produtos/importar', comErro, admin);
  assert.equal(conferencia.dados.resumo.erros, 1);
  assert.match(conferencia.dados.itens[0].erro, /sem preço/);

  const recusado = await enviar(app, '/produtos/importar?aplicar=1', comErro, admin);
  assert.equal(recusado.status, 422);
  assert.match(recusado.dados.erro, /1 linha\(s\) com erro/);
  assert.equal((await app.get('/produtos', admin)).dados.length, 0); // nada entrou

  // Planilha sem as colunas obrigatórias.
  const semCabecalho = await enviar(app, '/produtos/importar', csv('quantia;valor', '1;2'), admin);
  assert.equal(semCabecalho.status, 422);
  assert.match(semCabecalho.dados.erro, /nome.*c[óo]digo de barras/i);

  // Planilha vazia.
  assert.equal((await enviar(app, '/produtos/importar', csv(''), admin)).status, 422);
});

test('importar catálogo: acerto de estoque só quando a equipe pede', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const produto = (await app.post('/produtos', { nome: 'Feijão 1 kg', preco: '8,90', custo: '6,20', estoque: '30', categoria_id: 1 }, admin)).dados;
  const planilha = csv('nome;preco;estoque', 'Feijão 1 kg;8,90;12');

  await enviar(app, '/produtos/importar?aplicar=1', planilha, admin);
  assert.equal((await app.get(`/produtos/${produto.id}`, admin)).dados.estoque_mil, 30_000);

  const comEstoque = await enviar(app, '/produtos/importar?aplicar=1&ajustar_estoque=1', planilha, admin);
  assert.equal(comEstoque.dados.estoque_ajustado, 1);
  const depois = (await app.get(`/produtos/${produto.id}`, admin)).dados;
  assert.equal(depois.estoque_mil, 12_000);
  // A diferença fica registrada como movimento, não some do histórico.
  assert.equal(depois.movimentos[0].observacao, 'Importação de planilha');
  assert.equal(depois.movimentos[0].qtd_mil, -18_000);
});

test('importar catálogo: formatos de planilha e permissão', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();

  // Separador vírgula, decimal com ponto e milhar com ponto.
  const outroFormato = csv('nome,preco,custo,estoque', 'Cesta básica,129.90,98.50,5', 'Azeite 500ml,"1.299,90",900,2');
  const r = await enviar(app, '/produtos/importar?aplicar=1', outroFormato, admin);
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const lista = (await app.get('/produtos', admin)).dados;
  assert.equal(lista.find((p) => p.nome === 'Cesta básica').preco_centavos, 12_990);
  assert.equal(lista.find((p) => p.nome === 'Azeite 500ml').preco_centavos, 129_990);

  // O modelo de planilha está disponível para quem vai montar o catálogo.
  const modelo = await app.get('/produtos/importar/modelo', admin);
  assert.match(modelo.headers.get('content-type'), /text\/csv/);
  assert.match(modelo.dados, /nome;codigo_barras;categoria/);

  // Caixa não importa catálogo.
  const { token: caixa } = await app.criarUsuario(admin, { nome: 'Ana Caixa', email: 'ana@mercadinho.com.br', perfil: 'caixa' });
  assert.equal((await enviar(app, '/produtos/importar', csv('nome;preco', 'X;1,00'), caixa)).status, 403);
});
