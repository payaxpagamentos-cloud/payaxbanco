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

/** Duas etapas: com ela ligada, a senha sozinha não entra; o código do aplicativo ou um de reserva, sim. */
test('Segurança: verificação em duas etapas', async (t) => {
  const totp = require('../server/lib/totp');
  const { iniciar, limparArquivos } = require('./helpers');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); });
  // Vetor do padrão (RFC 6238, SHA-1): segredo "12345678901234567890", instante 59 s.
  assert.equal(totp.codigoEm('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082');

  const master = await api.login();
  const { segredo, qr } = (await api.post('/auth/duas-etapas/iniciar', {}, master)).dados;
  assert.match(qr, /^data:image\/png/);
  assert.equal((await api.post('/auth/duas-etapas/ativar', { codigo: '000000' }, master)).status, 422);
  const agora = () => totp.codigoEm(segredo, Math.floor(Date.now() / 30_000));
  const { codigos_reserva: reserva } = (await api.post('/auth/duas-etapas/ativar', { codigo: agora() }, master)).dados;
  assert.equal(reserva.length, 8);

  const entrar = (extra) => api.post('/auth/login', { email: 'master@midia.com.br', senha: 'master123', ...extra });
  const soSenha = await entrar({});
  assert.equal(soSenha.dados.precisa_codigo, true);
  assert.equal(soSenha.dados.token, undefined, 'a senha sozinha não entrega o acesso');
  assert.equal((await entrar({ codigo: '123456' })).status, 401);
  assert.ok((await entrar({ codigo: agora() })).dados.token);
  assert.ok((await entrar({ codigo: reserva[0] })).dados.token, 'código de reserva entra');
  assert.equal((await entrar({ codigo: reserva[0] })).status, 401, 'e só uma vez');

  assert.equal((await api.post('/auth/duas-etapas/desligar', { senha: 'master123' }, master)).status, 204);
  assert.ok((await entrar({})).dados.token);
});

/** E-mails da empresa ligados a pessoas: o que chega para o endereço de alguém é dele; e ele escreve com esse endereço. */
test('E-mails por usuário: criar, associar, receber e enviar', async (t) => {
  const config = require('../server/config');
  const caixa = require('../server/lib/caixa');
  const antes = config.entrada.dominios;
  config.entrada.dominios = ['vaimidia.com.br'];
  const { iniciar, limparArquivos } = require('./helpers');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); config.entrada.dominios = antes; });
  const master = await api.login();
  const ana = (await api.post('/painel/usuarios', { nome: 'Ana', email: 'ana@x.com.br', senha: 'senha-da-ana', perfil: 'operador' }, master)).dados.id;
  await api.post('/painel/usuarios', { nome: 'Beto', email: 'beto@x.com.br', senha: 'senha-do-beto', perfil: 'operador' }, master);
  const tkAna = await api.login('ana@x.com.br', 'senha-da-ana');
  const tkBeto = await api.login('beto@x.com.br', 'senha-do-beto');

  assert.equal((await api.post('/painel/enderecos-email', { local: 'ana' }, tkAna)).status, 403, 'operador não cria e-mail');
  assert.equal((await api.post('/painel/enderecos-email', { local: 'a b', usuario_id: ana }, master)).status, 422);
  assert.equal((await api.post('/painel/enderecos-email', { local: 'ana', dominio: 'outro.com' }, master)).status, 422);
  const criado = await api.post('/painel/enderecos-email', { local: 'Ana', nome: 'Ana — Vai Mídia', usuario_id: ana }, master);
  assert.equal(criado.status, 201);
  assert.equal(criado.dados.endereco, 'ana@vaimidia.com.br');
  assert.equal((await api.post('/painel/enderecos-email', { local: 'ana' }, master)).status, 409, 'não repete');
  await api.post('/painel/enderecos-email', { local: 'comercial' }, master);

  const msg = (para) => Buffer.from(`From: Cliente <cliente@fora.com>\r\nTo: ${para}\r\nSubject: Oi ${para}\r\nMessage-ID: <${para}@fora.com>\r\n\r\nQuero anunciar.\r\n`);
  const daAna = caixa.receber(api.db, { bruto: msg('ana@vaimidia.com.br'), de: 'cliente@fora.com', para: ['ana@vaimidia.com.br'] });
  const geral = caixa.receber(api.db, { bruto: msg('comercial@vaimidia.com.br'), de: 'cliente@fora.com', para: ['comercial@vaimidia.com.br'] });

  const assuntos = async (tk, q = '') => (await api.get(`/painel/crm/emails${q}`, tk)).dados.itens.map((e) => e.id).sort();
  assert.deepEqual(await assuntos(tkAna), [daAna.id, geral.id].sort());
  assert.deepEqual(await assuntos(tkAna, '?caixa=meus'), [daAna.id]);
  assert.deepEqual(await assuntos(tkBeto), [geral.id], 'o Beto não vê a caixa da Ana');
  assert.equal((await api.get(`/painel/crm/emails/${daAna.id}`, tkBeto)).status, 403);
  assert.equal((await api.get(`/painel/crm/emails/${daAna.id}`, master)).status, 200, 'o master vê tudo');

  // A Ana responde: sai com o endereço dela.
  const resposta = await api.post('/painel/crm/emails', { para: 'cliente@fora.com', texto: 'Olá!', responder_a: daAna.id }, tkAna);
  assert.equal(resposta.status, 201);
  assert.equal(resposta.dados.de, 'ana@vaimidia.com.br');
  // O Beto não tem endereço: sai com o geral do sistema.
  const doBeto = await api.post('/painel/crm/emails', { para: 'cliente@fora.com', assunto: 'Oi', texto: 'Olá!' }, tkBeto);
  assert.notEqual(doBeto.dados.de, 'ana@vaimidia.com.br');

  // Excluir o endereço não apaga as mensagens.
  assert.equal((await api.del(`/painel/enderecos-email/${criado.dados.id}`, undefined, master)).status, 204);
  assert.deepEqual(await assuntos(tkBeto), [daAna.id, geral.id].sort());
});
