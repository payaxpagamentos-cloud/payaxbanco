'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** O módulo é do navegador (ESM); aqui ele é lido como .mjs para o Node importar. */
async function carregar() {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'ilustracoes-'));
  const arquivo = path.join(pasta, 'ilustracoes.mjs');
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', 'ilustracoes.js'), arquivo);
  try { return await import(arquivo); } finally { fs.rmSync(pasta, { recursive: true, force: true }); }
}
const PASTA = path.join(__dirname, '..', 'public', 'img', 'ilustracoes');

test('desenho do produto sem foto: pelo nome, depois pela categoria', async () => {
  const { nomeDaIlustracao: n } = await carregar();
  const casos = {
    'Cerveja lata 350 ml': 'lata-cerveja', 'Coca-Cola lata 350 ml': 'lata-refri', 'Refrigerante cola 2 L': 'garrafa-refri',
    'Água mineral 1,5 L': 'garrafa-agua', 'Água sanitária 1 L': 'galao-sanitaria', 'Leite integral 1 L': 'caixa-leite',
    'Chocolate ao leite 90 g': 'chocolate', 'Leite condensado 395 g': 'lata-molho', 'Macarrão espaguete 500 g': 'pacote-macarrao',
    'Maçã fuji - kg': 'maca', 'Pão de forma 500 g': 'pao-forma', 'Pão francês - kg': 'pao-frances',
    'Salgadinho de milho 110 g': 'pacote-salgadinho', 'Batata - kg': 'batata', 'Café torrado e moído 500 g': 'pacote-cafe',
  };
  for (const [nome, esperado] of Object.entries(casos)) assert.equal(n({ nome }), esperado, nome);
  // Nome que não diz nada: vale a categoria; sem categoria, a sacola da loja.
  assert.equal(n({ nome: 'Produto X', categoria: 'Limpeza' }), 'detergente');
  assert.equal(n({ nome: 'Produto X', categoria: 'Hortifrúti' }), 'maca');
  assert.equal(n({ nome: 'Produto X' }), 'sacola');
  // Itens da venda vêm com "descricao" em vez de "nome".
  assert.equal(n({ descricao: 'Sabonete 90 g' }), 'sabonete');
});

test('toda regra aponta para um desenho que existe', async () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ilustracoes.js'), 'utf8');
  const nomes = new Set([...fonte.matchAll(/'([a-z-]+)'\]/g)].map((m) => m[1]).concat('sacola'));
  assert.ok(nomes.size >= 30);
  for (const nome of nomes) assert.ok(fs.existsSync(path.join(PASTA, `${nome}.svg`)), `falta ${nome}.svg`);
});
