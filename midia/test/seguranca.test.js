'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/** Segurança do acesso: conta trava com senha errada repetida e trocar a senha derruba as sessões antigas. */
test('Segurança: bloqueio da conta e sessão que cai ao trocar a senha', async (t) => {
  const { iniciar, limparArquivos } = require('./helpers');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); });
  const master = await api.login();
  await api.post('/painel/usuarios', { nome: 'Caio', email: 'caio@x.com.br', senha: 'senha-do-caio', perfil: 'operador' }, master);

  // Senha curta não entra mais.
  const curta = await api.post('/painel/usuarios', { nome: 'Dea', email: 'dea@x.com.br', senha: '12345678', perfil: 'operador' }, master);
  assert.equal(curta.status, 422);

  // Trocar a senha: o acesso antigo cai, o novo (devolvido na troca) vale.
  const antigo = await api.login('caio@x.com.br', 'senha-do-caio');
  const outroAparelho = await api.login('caio@x.com.br', 'senha-do-caio');
  const troca = await api.post('/auth/senha', { atual: 'senha-do-caio', nova: 'senha-nova-do-caio' }, antigo);
  assert.equal(troca.status, 200);
  assert.equal((await api.get('/auth/me', outroAparelho)).status, 401, 'os outros aparelhos saem');
  assert.equal((await api.get('/auth/me', troca.dados.token)).status, 200, 'quem trocou continua dentro');

  // O master troca a senha de alguém: a pessoa também é desconectada.
  const id = api.db.prepare("SELECT id FROM usuarios WHERE email = 'caio@x.com.br'").get().id;
  await api.patch(`/painel/usuarios/${id}`, { senha: 'senha-dada-pelo-master' }, master);
  assert.equal((await api.get('/auth/me', troca.dados.token)).status, 401);

  // Oito senhas erradas seguidas travam a conta — nem a senha certa entra até passar o tempo.
  api.db.prepare('UPDATE usuarios SET falhas = 7 WHERE id = ?').run(id);
  assert.equal((await api.post('/auth/login', { email: 'caio@x.com.br', senha: 'errada-errada' })).status, 401);
  assert.equal((await api.post('/auth/login', { email: 'caio@x.com.br', senha: 'senha-dada-pelo-master' })).status, 429);
  api.db.prepare('UPDATE usuarios SET bloqueado_ate = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
  assert.equal((await api.post('/auth/login', { email: 'caio@x.com.br', senha: 'senha-dada-pelo-master' })).status, 200);
});

/** O código da TV entrega o acesso só à TV: depois de entregue, não serve para quem viu o código na tela. */
test('Segurança: código de pareamento não é reaproveitado', async (t) => {
  const { iniciar, limparArquivos } = require('./helpers');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); });
  const master = await api.login();
  const ponto = (await api.post('/painel/locais', { nome: 'Ponto', categoria: 'outro', cidade: 'Campinas', uf: 'SP', publico_dia: 10 }, master)).dados.id;
  const tela = (await api.post('/painel/telas', { local_id: ponto, nome: 'TV' }, master)).dados.id;
  const { codigo } = (await api.post('/player/registrar', { aparelho: 'teste' })).dados;
  assert.equal((await api.post('/painel/telas/parear', { codigo, tela_id: tela }, master)).status < 300, true);
  assert.equal((await api.get(`/player/pareamento?codigo=${codigo}`)).dados.pareado, true);
  api.db.prepare('UPDATE pareamentos SET entregue_em = ? WHERE codigo = ?').run(new Date(Date.now() - 5 * 60_000).toISOString(), codigo);
  const depois = (await api.get(`/player/pareamento?codigo=${codigo}`)).dados;
  assert.equal(depois.pareado, false);
  assert.equal(depois.token, undefined);
});

/** Comandos pelo painel: só o master, só os da lista, e com a senha. O painel deixa apenas o nome. */
test('Sistema: comandos pelo painel são uma lista fechada', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-comandos-'));
  process.env.MIDIA_COMANDOS = pasta;
  const { iniciar, limparArquivos } = require('./helpers');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); delete process.env.MIDIA_COMANDOS; fs.rmSync(pasta, { recursive: true, force: true }); });
  const master = await api.login();
  await api.post('/painel/usuarios', { nome: 'Adm', email: 'adm@x.com.br', senha: 'senha-do-adm', perfil: 'administrador' }, master);
  const adm = await api.login('adm@x.com.br', 'senha-do-adm');

  assert.equal((await api.get('/painel/sistema/comandos', adm)).status, 403);
  assert.equal((await api.post('/painel/sistema/comandos', { id: 'dns', senha: 'errada' }, master)).status, 403);
  assert.equal((await api.post('/painel/sistema/comandos', { id: 'rm -rf /', senha: 'master123' }, master)).status, 422);
  assert.equal(fs.existsSync(path.join(pasta, 'pedido')), false);
  assert.equal((await api.post('/painel/sistema/comandos', { id: 'dns', senha: 'master123' }, master)).status, 202);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pasta, 'pedido'), 'utf8')).id, 'dns');
  assert.equal((await api.post('/painel/sistema/comandos', { id: 'conferir', senha: 'master123' }, master)).status, 409, 'um de cada vez');
});
