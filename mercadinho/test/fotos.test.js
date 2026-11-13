'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { iniciar } = require('./helpers');

// Imagens mínimas de verdade (4x4), para o teste passar pelo mesmo caminho que o navegador usa.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDpqKKK6D8vP//Z', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGNUf7yNAQaYGJAAbg4AV/UByClZiqQAAAAASUVORK5CYII=', 'base64');

test('foto do produto: envio, troca, remoção e quem pode mexer', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const produto = (await app.post('/produtos', { nome: 'Café 500g', preco: '21,90', custo: '15,00', estoque: '10', categoria_id: 1 }, admin)).dados;
  assert.equal(produto.foto, null);

  // Envia a foto e ela aparece no cadastro.
  const envio = await app.enviarArquivo(`/produtos/${produto.id}/foto`, JPEG, 'image/jpeg', admin);
  assert.equal(envio.status, 201);
  assert.match(envio.dados.foto, new RegExp(`^${produto.id}-[0-9a-f]{8}\\.jpg$`));
  const comFoto = (await app.get(`/produtos/${produto.id}`, admin)).dados;
  assert.equal(comFoto.foto, envio.dados.foto);

  // E é servida como arquivo, para o <img> das telas (que não manda token).
  const baixada = await fetch(`${app.raiz}/fotos/${envio.dados.foto}`);
  assert.equal(baixada.status, 200);
  assert.equal(baixada.headers.get('content-type'), 'image/jpeg');
  assert.equal((await baixada.arrayBuffer()).byteLength, JPEG.length);

  // Trocar a foto apaga a anterior do disco (nada de lixo acumulado).
  const antiga = require('../server/lib/fotos').caminho(envio.dados.foto);
  const troca = await app.enviarArquivo(`/produtos/${produto.id}/foto`, PNG, 'image/png', admin);
  assert.equal(troca.status, 201);
  assert.match(troca.dados.foto, /\.png$/);
  assert.equal(fs.existsSync(antiga), false);
  assert.equal(fs.existsSync(require('../server/lib/fotos').caminho(troca.dados.foto)), true);

  // Remover limpa o cadastro e o arquivo.
  assert.equal((await app.del(`/produtos/${produto.id}/foto`, admin)).status, 200);
  assert.equal((await app.get(`/produtos/${produto.id}`, admin)).dados.foto, null);
  assert.equal(fs.existsSync(require('../server/lib/fotos').caminho(troca.dados.foto)), false);
  assert.equal((await fetch(`${app.raiz}/fotos/${troca.dados.foto}`)).status, 404);
});

test('foto do produto: só imagem de verdade entra', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const produto = (await app.post('/produtos', { nome: 'Suco 1L', preco: '12,00', custo: '7,00', estoque: '5', categoria_id: 1 }, admin)).dados;

  // Um arquivo qualquer disfarçado de imagem é recusado pelos primeiros bytes.
  const disfarce = await app.enviarArquivo(`/produtos/${produto.id}/foto`, Buffer.from('<script>alert(1)</script>'), 'image/jpeg', admin);
  assert.equal(disfarce.status, 422);
  assert.match(disfarce.dados.erro, /Formato/);
  assert.equal((await app.get(`/produtos/${produto.id}`, admin)).dados.foto, null);

  // Arquivo vazio também não passa.
  assert.equal((await app.enviarArquivo(`/produtos/${produto.id}/foto`, Buffer.alloc(0), 'image/jpeg', admin)).status, 422);

  // Produto que não existe.
  assert.equal((await app.enviarArquivo('/produtos/9999/foto', JPEG, 'image/jpeg', admin)).status, 404);

  // O caixa não mexe no cadastro de produtos.
  const { token: caixa } = await app.criarUsuario(admin, { nome: 'Ana Caixa', email: 'ana@mercadinho.com.br', perfil: 'caixa' });
  assert.equal((await app.enviarArquivo(`/produtos/${produto.id}/foto`, JPEG, 'image/jpeg', caixa)).status, 403);
});

test('foto do produto aparece no terminal do cliente', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const banana = (await app.post('/produtos', { nome: 'Banana prata', preco: '7,90', custo: '4,60', estoque: '20', unidade: 'kg', pesavel: true, categoria_id: 1 }, admin)).dados;
  const cafe = (await app.post('/produtos', { nome: 'Café 500g', codigo_barras: '7891000053508', preco: '21,90', custo: '15,00', estoque: '10', categoria_id: 1 }, admin)).dados;
  const foto = (await app.enviarArquivo(`/produtos/${banana.id}/foto`, JPEG, 'image/jpeg', admin)).dados.foto;
  await app.enviarArquivo(`/produtos/${cafe.id}/foto`, JPEG, 'image/jpeg', admin);

  const criado = await app.post('/admin/terminais', { nome: 'Balcão' }, admin);
  const token = (await app.post('/terminal/parear', { codigo: criado.dados.codigo })).dados.token;

  // Na vitrine de produtos sem código de barras.
  const semCodigo = await app.get('/terminal/produtos/sem-codigo', token);
  assert.equal(semCodigo.dados.find((p) => p.id === banana.id).foto, foto);
  // Na busca.
  assert.ok((await app.get('/terminal/produtos?termo=caf', token)).dados[0].foto);

  // E no carrinho, para o cliente reconhecer o que passou no leitor.
  const venda = (await app.post('/terminal/venda', {}, token)).dados;
  const comItem = await app.post(`/terminal/venda/${venda.id}/itens`, { codigo: '7891000053508' }, token);
  assert.ok(comItem.dados.itens[0].foto);
});
