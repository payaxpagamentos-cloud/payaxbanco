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
const TIPO_JS = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean' };

function conferir(esquema, onde, problemas) {
  if (!esquema || typeof esquema !== 'object') return;
  if (esquema.enum) {
    if (typeof esquema.type !== 'string') problemas.push(`${onde}: enum com type ${JSON.stringify(esquema.type)} (use um tipo só)`);
    for (const valor of esquema.enum) {
      if (typeof valor !== TIPO_JS[esquema.type]) problemas.push(`${onde}: valor ${JSON.stringify(valor)} do enum não é ${esquema.type}`);
    }
  }
  const tipos = [].concat(esquema.type ?? []);
  if (tipos.includes('object')) {
    if (esquema.additionalProperties !== false) problemas.push(`${onde}: objeto sem additionalProperties: false`);
    const props = Object.keys(esquema.properties ?? {});
    const faltam = props.filter((p) => !(esquema.required ?? []).includes(p));
    if (faltam.length) problemas.push(`${onde}: em strict todo campo é obrigatório; faltam em required: ${faltam.join(', ')}`);
    for (const [p, sub] of Object.entries(esquema.properties ?? {})) conferir(sub, `${onde}.${p}`, problemas);
  }
  if (esquema.items) conferir(esquema.items, `${onde}[]`, problemas);
  for (const k of ['anyOf', 'oneOf', 'allOf']) (esquema[k] ?? []).forEach((s, i) => conferir(s, `${onde}.${k}[${i}]`, problemas));
}

test('toda ferramenta que vai para a IA tem um esquema que a API aceita em strict', () => {
  const { db, empresa } = h.criarAmbiente();
  h.comIxc(db, empresa.id);
  const { tools } = ferramentas.montar(db, { empresaId: empresa.id });
  // Também as internas que só entram em certas condições (alertas da região, transferência).
  const todas = [...tools, ...Object.entries(ferramentas.INTERNAS).map(([name, f]) => ({ name, input_schema: f.entrada, strict: true }))];
  assert.ok(tools.some((t) => t.name === 'enviar_segunda_via'), 'as do IXC estão no kit');
  const problemas = [];
  for (const t of todas.filter((x) => x.strict)) conferir(t.input_schema, t.name, problemas);
  assert.deepEqual(problemas, []);
});
