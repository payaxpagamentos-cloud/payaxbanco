'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** Todos os .js das telas (Backoffice, Área do Cliente e componentes comuns). */
function arquivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? arquivos(p) : p.endsWith('.js') ? [p] : [];
  });
}

/**
 * A classe "menu" é a barra lateral inteira (fixa, com fundo). Se outro elemento usar a mesma
 * classe, vira um painel por cima do menu — foi o que escondeu o menu da Área do Cliente.
 */
test('só a barra lateral usa a classe "menu"', () => {
  const raiz = path.join(__dirname, '..');
  const achados = [];
  for (const f of ['public/js', 'cliente/js', 'comum'].flatMap((d) => arquivos(path.join(raiz, d)))) {
    const texto = fs.readFileSync(f, 'utf8');
    for (const m of texto.matchAll(/el\('(\w+)',\s*\{\s*class:\s*'([^']*)'/g)) {
      if (m[2].split(/\s+/).includes('menu') && m[1] !== 'aside') achados.push(`${path.relative(raiz, f)}: <${m[1]} class="${m[2]}">`);
    }
  }
  assert.deepEqual(achados, []);
});
