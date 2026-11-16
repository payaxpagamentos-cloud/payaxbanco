'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const h = require('./helpers');
const { criarApp } = require('../server/app');
const empresasLib = require('../server/lib/empresas');

/**
 * Endereço próprio de cada empresa: connectlink.zoe360.com.br mostra o nome dela no login e só deixa
 * entrar a equipe dela (e a da plataforma). app.zoe360.com.br e o IP continuam sendo a entrada geral.
 */
describe('subdomínio da empresa', () => {
  let meta;
  let db;
  let empresa;
  let outra;
  let servidor;
  let porta;

  // fetch não deixa trocar o Host; http.request deixa (é assim que o nginx repassa o endereço).
  const chamar = (metodo, caminho, { host, corpo = null } = {}) => new Promise((ok, falha) => {
    const dados = corpo ? JSON.stringify(corpo) : null;
    const req = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: `/api${caminho}`,
      headers: { Host: host, ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } : {}) } }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => ok({ status: res.statusCode, json: t ? JSON.parse(t) : null }));
    });
    req.on('error', falha);
    if (dados) req.write(dados);
    req.end();
  });
  const entrar = (email, host) => chamar('POST', '/auth/login', { host, corpo: { email, senha: 'senha12345' } });

  before(async () => {
    meta = h.fingirMeta();
    ({ db, empresa } = h.criarAmbiente());
    db.prepare("UPDATE empresas SET nome = 'ConnectLink', subdominio = 'connectlink' WHERE id = ?").run(empresa.id);
    outra = empresasLib.criar(db, { nome: 'Outro Provedor' }, { comExemplos: false });
    empresasLib.criarUsuario(db, outra.id, { nome: 'Paulo', email: 'paulo@outro.com.br', perfil: 'cliente', senha: 'senha12345' });
    db.prepare("UPDATE usuarios SET senha_hash = (SELECT senha_hash FROM usuarios WHERE email = 'carlos@fibramais.com.br') WHERE perfil = 'master'").run();
    servidor = criarApp(db).listen(0);
    await new Promise((r) => servidor.once('listening', r));
    porta = servidor.address().port;
  });
  after(async () => { meta.restaurar(); await new Promise((r) => servidor.close(r)); });

  test('o endereço diz de qual empresa é', () => {
    assert.equal(empresasLib.porHost(db, 'connectlink.zoe360.com.br')?.id, empresa.id);
    assert.equal(empresasLib.porHost(db, 'CONNECTLINK.zoe360.com.br:443')?.id, empresa.id, 'maiúscula e porta não atrapalham');
    assert.equal(empresasLib.porHost(db, 'app.zoe360.com.br'), null, 'app é a entrada geral');
    assert.equal(empresasLib.porHost(db, 'zoe360.com.br'), null);
    assert.equal(empresasLib.porHost(db, '200.141.31.37'), null);
    assert.equal(empresasLib.porHost(db, 'naoexiste.zoe360.com.br'), null);
  });

  test('o subdomínio é validado: formato, reservados e repetidos', () => {
    assert.equal(empresasLib.validarSubdominio(db, ' Provedor-X '), 'provedor-x');
    assert.equal(empresasLib.validarSubdominio(db, ''), null);
    assert.throws(() => empresasLib.validarSubdominio(db, 'app'), /reservado/);
    assert.throws(() => empresasLib.validarSubdominio(db, 'con nect'), /inválido/);
    assert.throws(() => empresasLib.validarSubdominio(db, '-ab'), /inválido/);
    assert.throws(() => empresasLib.validarSubdominio(db, 'connectlink', { empresaId: outra.id }), /já é da empresa ConnectLink/);
    assert.equal(empresasLib.validarSubdominio(db, 'connectlink', { empresaId: empresa.id }), 'connectlink', 'a própria empresa pode manter o seu');
  });

  test('o login no endereço da empresa mostra o nome dela', async () => {
    const r = await chamar('GET', '/publico', { host: 'connectlink.zoe360.com.br' });
    assert.equal(r.json.empresa.nome, 'ConnectLink');
    assert.equal((await chamar('GET', '/publico', { host: 'app.zoe360.com.br' })).json.empresa, null);
  });

  test('só a equipe da empresa (e a da plataforma) entra pelo endereço dela', async () => {
    assert.equal((await entrar('carlos@fibramais.com.br', 'connectlink.zoe360.com.br')).status, 200);
    const intruso = await entrar('paulo@outro.com.br', 'connectlink.zoe360.com.br');
    assert.equal(intruso.status, 401);
    assert.equal(intruso.json.erro, 'E-mail ou senha incorretos.', 'mesma resposta de senha errada: não confirma quem existe');
    assert.equal((await entrar('paulo@outro.com.br', 'app.zoe360.com.br')).status, 200, 'pela entrada geral ele entra');
    const master = db.prepare("SELECT email FROM usuarios WHERE perfil = 'master'").get().email;
    assert.equal((await entrar(master, 'connectlink.zoe360.com.br')).status, 200, 'o master entra em qualquer endereço');
  });
});
