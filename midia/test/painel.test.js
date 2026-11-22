'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Coisas do painel que só aparecem no navegador e que já quebraram uma vez em produção.
 * O pareamento da TV ficou sem funcionar porque o campo do código não tinha nome: o formulário
 * mandava o código vazio e o servidor respondia "não encontrado" até para o código certo.
 */
test('Painel: o formulário de pareamento manda o código digitado', () => {
  const rede = fs.readFileSync(path.join(__dirname, '..', 'public/js/rede.js'), 'utf8');
  const campo = rede.match(/el\('input', \{[^}]*class: 'codigo-pareamento'[^}]*\}/s)?.[0] ?? '';
  assert.ok(campo, 'o campo do código existe');
  assert.match(campo, /name: 'codigo'/, 'sem nome, o código não vai junto no envio');

  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/midia.css'), 'utf8');
  assert.match(css, /\[hidden\]\{ display: none !important; \}/, 'campo escondido tem de ficar escondido');
});
