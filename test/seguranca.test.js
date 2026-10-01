'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { iniciar } = require('./helpers');
const seguranca = require('../server/lib/seguranca');
const { fonteDisco } = require('../server/lib/integridade-fs');
const { diferenca } = require('../server/lib/integridade');

test('Diferença linha a linha', () => {
  const d = diferenca('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.equal(d.adicionadas, 2);
  assert.equal(d.removidas, 1);
  assert.deepEqual(d.trechos.map((x) => `${x.tipo}${x.texto}`), ['-b', '+B', '+e']);
});

test('Monitoramento de segurança', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  // Cópia temporária de uma "plataforma" para simular alterações de código.
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'payax-integridade-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  fs.mkdirSync(path.join(raiz, 'server'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'public', 'site', 'js'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'public', 'ib', 'js'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'public', 'js'), { recursive: true });
  for (const f of ['public/index.html', 'public/js/app.js', 'public/ib/index.html', 'public/ib/js/app.js', 'public/site/index.html', 'public/site/js/site.js']) {
    fs.writeFileSync(path.join(raiz, f), `// ${f}\n`);
  }
  fs.writeFileSync(path.join(raiz, 'server', 'regras.js'), 'const limite = 1000;\nmodule.exports = { limite };\n');
  seguranca.configurar({ fonte: fonteDisco(raiz), coletarServidor: () => ({ ambiente: 'teste' }) });

  await t.test('só o administrador acessa', async () => {
    await api.post('/usuarios', { nome: 'Gabriela Gerente', email: 'g@payax.com.br', perfil: 'gerente', senha: 'senha-forte-1' });
    const tk = await api.login('g@payax.com.br', 'senha-forte-1');
    assert.equal((await api.get('/seguranca', tk)).status, 403);
  });

  await t.test('primeira verificação cria a linha de base e testa as funções', async () => {
    const v = (await api.post('/seguranca/verificar')).dados;
    assert.equal(v.integridade.status, 'base_criada');
    assert.equal(v.integridade.arquivos, 7);
    assert.ok(v.funcoes.length >= 10);
    assert.deepEqual(v.funcoes.filter((f) => !f.ok), []);
    assert.ok(v.conexoes.checagens.length >= 5);
  });

  await t.test('alteração no código aparece com as linhas mudadas', async () => {
    fs.writeFileSync(path.join(raiz, 'server', 'regras.js'), 'const limite = 999999;\nmodule.exports = { limite };\n');
    fs.writeFileSync(path.join(raiz, 'server', 'porta-dos-fundos.js'), 'require("child_process").exec(process.env.CMD);\n');
    fs.rmSync(path.join(raiz, 'public', 'site', 'js', 'site.js'));
    const v = (await api.post('/seguranca/verificar')).dados;
    assert.equal(v.status, 'critico');
    assert.equal(v.integridade.status, 'alterado');
    const porTipo = Object.fromEntries(v.integridade.alteracoes.map((a) => [a.caminho, a.tipo]));
    assert.deepEqual(porTipo, { 'public/site/js/site.js': 'removido', 'server/porta-dos-fundos.js': 'adicionado', 'server/regras.js': 'alterado' });
    const regras = v.integridade.alteracoes.find((a) => a.caminho === 'server/regras.js');
    assert.deepEqual(regras.diff.trechos.map((x) => `${x.tipo}${x.texto}`), ['-const limite = 1000;', '+const limite = 999999;']);
    assert.equal(v.funcoes.find((f) => f.nome === 'Site institucional').ok, false);
  });

  await t.test('administrador aprova as alterações como nova versão', async () => {
    assert.equal((await api.post('/seguranca/integridade/aprovar', {})).status, 422);
    fs.writeFileSync(path.join(raiz, 'public', 'site', 'js', 'site.js'), '// site\n');
    const r = await api.post('/seguranca/integridade/aprovar', { motivo: 'Atualização revisada' });
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.verificacao.integridade.status, 'ok');
    const p = (await api.get('/seguranca')).dados;
    assert.equal(p.historico.length, 3);
    assert.equal(p.base.arquivos, 8);
    assert.ok(JSON.stringify((await api.get('/auditoria?entidade=verificacao_seguranca')).dados).includes('aprovar_integridade'));
  });
});
