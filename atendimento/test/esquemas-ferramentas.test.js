'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const ferramentas = require('../server/ia/ferramentas');

/**
 * As ferramentas vão para a API com `strict: true`, e a API recusa o pedido inteiro (400) se um
 * esquema quebra as regras — a conversa caía na fila com "Invalid schema". Os testes usam uma IA
 * de mentira, que não valida nada; este confere os esquemas do jeito que a API confere.
 */
const { problemasEstrito } = require('../server/ia/esquema-estrito');

test('toda ferramenta que vai para a IA tem um esquema que a API aceita em strict', () => {
  const { db, empresa } = h.criarAmbiente();
  h.comIxc(db, empresa.id);
  const { tools } = ferramentas.montar(db, { empresaId: empresa.id });
  // Também as internas que só entram em certas condições (alertas da região, transferência).
  const todas = [...tools, ...Object.entries(ferramentas.INTERNAS).map(([name, f]) => ({ name, input_schema: f.entrada, strict: true }))];
  assert.ok(tools.some((t) => t.name === 'enviar_segunda_via'), 'as do IXC estão no kit');
  const problemas = [];
  for (const t of todas.filter((x) => x.strict)) problemasEstrito(t.input_schema, t.name, problemas);
  assert.deepEqual(problemas, []);
});

test('ferramenta cadastrada pela empresa com esquema fora da regra vai sem strict (não derruba a conversa)', () => {
  const boa = ferramentas.comoTool({ nome: 'consulta', descricao: 'x', parametros: JSON.stringify({ type: 'object', properties: { cpf: { type: 'string' } } }) });
  assert.equal(boa.strict, true);
  assert.deepEqual(problemasEstrito(boa.input_schema), []);
  const opcional = ferramentas.comoTool({ nome: 'c2', descricao: 'x', parametros: JSON.stringify({ type: 'object', properties: { cpf: { type: 'string', minLength: 11 }, obs: { type: 'string' } }, required: ['cpf'] }) });
  assert.equal(opcional.strict, undefined, 'campo opcional e minLength: sem strict');
});
