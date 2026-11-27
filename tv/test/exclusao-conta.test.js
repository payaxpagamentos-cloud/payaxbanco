'use strict';

/**
 * Exclusão da conta pelo próprio assinante — exigência da App Store (regra 5.1.1(v))
 * e direito à eliminação da LGPD.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

test('a conta é excluída pelo app e não entra mais', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const cliente = await s.assinante('sai@exemplo.com.br');

  const r = await s.del('/conta', { senha: 'senha12345' }, cliente.token);
  assert.equal(r.status, 200);
  assert.match(r.dados.aviso, /exclu/i);

  // A sessão morre junto: o token antigo não vale mais.
  assert.equal((await s.get('/conta', cliente.token)).status, 401);
  // E a senha de antes não entra.
  assert.equal((await s.post('/auth/login', { email: 'sai@exemplo.com.br', senha: 'senha12345' })).status, 401);
});

test('exclusão exige a senha certa', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const cliente = await s.assinante('fica@exemplo.com.br');

  assert.equal((await s.del('/conta', { senha: 'errada' }, cliente.token)).status, 403);
  assert.equal((await s.del('/conta', {}, cliente.token)).status, 403);
  // Continua entrando normalmente.
  assert.equal((await s.get('/conta', cliente.token)).status, 200);
});

test('ao excluir, a assinatura é cancelada e os perfis somem', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const cliente = await s.assinante('assina@exemplo.com.br');
  await s.post('/conta/assinar', { plano_id: 2 }, cliente.token);
  await s.post('/conta/perfis', { nome: 'Crianças', avatar: 'dino', infantil: true }, cliente.token);

  const antes = await s.get('/conta', cliente.token);
  assert.ok(antes.dados.perfis.length >= 2, 'tinha mais de um perfil antes');

  assert.equal((await s.del('/conta', { senha: 'senha12345' }, cliente.token)).status, 200);

  const lista = await s.get('/admin/assinantes', admin);
  const removido = lista.dados.assinantes.find((a) => a.nome === 'Conta removida');
  assert.ok(removido, 'a conta aparece como removida no painel');
  assert.equal(Boolean(removido.ativo), false, 'a conta fica desativada');
  assert.notEqual(removido.email, 'assina@exemplo.com.br', 'o e-mail original foi liberado');
});

test('a conta da operação não é excluída por esta rota', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const admin = await s.adminLogin();
  const r = await s.del('/conta', { senha: 'admin123' }, admin);
  assert.equal(r.status, 422);
  assert.match(r.dados.erro, /Equipe/i);
});

test('o perfil exige uma foto, e ela tem que ser uma das nossas', async (t) => {
  const s = await iniciar();
  t.after(s.fechar);
  const cliente = await s.assinante('comfoto@exemplo.com.br', { plano: 3 });

  // O perfil que nasce junto com o cadastro já vem com mascote: ninguém fica sem foto.
  const { perfis } = (await s.get('/conta/perfis', cliente.token)).dados;
  assert.ok(perfis[0].avatar, 'o primeiro perfil vem com mascote');

  // Sem escolher foto, não cria.
  const semFoto = await s.post('/conta/perfis', { nome: 'Sem Foto' }, cliente.token);
  assert.equal(semFoto.status, 422);
  assert.match(semFoto.dados.erro, /foto/i);

  // Nome inventado não pode virar caminho de arquivo.
  const inventado = await s.post('/conta/perfis', { nome: 'Hacker', avatar: '../../etc/passwd' }, cliente.token);
  assert.equal(inventado.status, 422);

  // Com um mascote de verdade, cria e devolve.
  const ok = await s.post('/conta/perfis', { nome: 'Filho', avatar: 'dino' }, cliente.token);
  assert.equal(ok.status, 201, JSON.stringify(ok.dados));
  assert.equal(ok.dados.perfil.avatar, 'dino');

  // Dá para trocar, não para apagar.
  assert.equal((await s.patch(`/conta/perfis/${ok.dados.perfil.id}`, { avatar: 'panda' }, cliente.token)).dados.perfil.avatar, 'panda');
  assert.equal((await s.patch(`/conta/perfis/${ok.dados.perfil.id}`, { avatar: '' }, cliente.token)).status, 422);
});
