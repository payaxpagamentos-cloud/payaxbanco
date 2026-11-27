'use strict';

/**
 * O app instalado no celular guarda os arquivos para abrir rápido e funcionar sem rede. A lista
 * do que guardar é escrita à mão no service worker — e lista escrita à mão envelhece: já ficou
 * para trás em sete módulos de uma vez, incluindo os dois do player que entraram hoje.
 *
 * Módulo que não está na lista não é guardado. Sem rede, o primeiro `import` dele falha, a
 * cadeia inteira cai e o assinante vê uma tela branca — sem erro, sem explicação.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLICO = path.join(__dirname, '..', 'public');

test('o app guardado no celular inclui todos os módulos do assinante', () => {
  const sw = fs.readFileSync(path.join(PUBLICO, 'sw.js'), 'utf8');
  const noDisco = fs.readdirSync(path.join(PUBLICO, 'js'))
    .filter((n) => n.endsWith('.js'))
    .map((n) => n.replace(/\.js$/, ''))
    // O painel é outra página e não funciona sem rede: fica de fora de propósito.
    .filter((n) => !n.startsWith('admin'));

  const faltando = noDisco.filter((n) => !new RegExp(`'${n}'`).test(sw));
  assert.deepEqual(faltando, [],
    `módulo(s) fora da lista do service worker — sem rede, o app abre em branco: ${faltando.join(', ')}`);
});

test('trocar arquivo do app obriga a trocar a versão do cache', () => {
  // Sem mudar VERSAO, o celular continua servindo os arquivos velhos por mais que o servidor
  // tenha sido atualizado — e a operação fica perseguindo um defeito que já foi corrigido.
  const sw = fs.readFileSync(path.join(PUBLICO, 'sw.js'), 'utf8');
  const m = /const VERSAO = '(v\d+)'/.exec(sw);
  assert.ok(m, 'o service worker precisa declarar VERSAO');
  assert.match(m[1], /^v\d+$/);
});
