'use strict';

/**
 * Regras que a API de IA aplica aos esquemas de ferramentas com `strict: true`. Se um esquema quebra
 * uma delas, a API recusa o pedido INTEIRO (400) — e a ZOE para de atender. Usado nos testes (as
 * ferramentas da plataforma) e em tempo real nas ferramentas que cada empresa cadastra.
 */
const TIPO_JS = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean' };
const NAO_SUPORTADO = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties'];

function problemasEstrito(esquema, onde = 'esquema', problemas = []) {
  if (!esquema || typeof esquema !== 'object') return problemas;
  for (const k of NAO_SUPORTADO) if (k in esquema) problemas.push(`${onde}: "${k}" não é aceito em strict`);
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
    for (const [p, sub] of Object.entries(esquema.properties ?? {})) problemasEstrito(sub, `${onde}.${p}`, problemas);
  }
  if (esquema.items) problemasEstrito(esquema.items, `${onde}[]`, problemas);
  for (const k of ['anyOf', 'oneOf', 'allOf']) (esquema[k] ?? []).forEach((s, i) => problemasEstrito(s, `${onde}.${k}[${i}]`, problemas));
  return problemas;
}

module.exports = { problemasEstrito };
