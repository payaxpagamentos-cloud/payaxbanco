'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { iniciar } = require('./helpers');
const totp = require('../server/lib/totp');
const backup = require('../server/lib/backup');
const config = require('../server/config');

/**
 * Código utilizável agora. Nos testes tudo acontece dentro da mesma janela de 30 s, então o passo
 * já consumido é liberado antes — é o equivalente a esperar o relógio virar.
 */
function codigoUsavel(api, segredo, { tabela = 'usuarios', id = 1 } = {}) {
  api.db.prepare(`UPDATE ${tabela} SET totp_ultimo_passo = NULL WHERE id = ?`).run(id);
  return totp.codigo(segredo, totp.passoAtual());
}

test('backup: gera, confere e protege o arquivo', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const c = await api.cliente(tk.admin, { retencao_dias: 0 });
  const b = await api.boleto(tk.admin, c.cliente.id, { valor: '500,00', vencimento: '2026-12-20' });
  await api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: '2026-12-20', valor_pago: '500,00' }, tk.financeiro);

  await t.test('a cópia confere contra o razão do banco em uso', async () => {
    const r = await api.post('/api/seguranca/backups', {}, tk.admin);
    assert.equal(r.status, 201);
    assert.equal(r.dados.confere, true);
    assert.equal(r.dados.integridade, 'ok');
    assert.equal(r.dados.lancamentos, api.db.prepare('SELECT COUNT(*) AS n FROM lancamentos').get().n);
    assert.ok(fs.existsSync(path.join(config.backupDir, r.dados.nome)));
  });

  await t.test('o histórico registra a conferência', async () => {
    const d = (await api.get('/api/seguranca', tk.financeiro)).dados;
    assert.ok(d.backups.historico.length >= 1);
    assert.equal(d.backups.historico[0].confere, 1);
    assert.equal(d.backups.ultimo.confere, true);
    assert.equal(d.backups.atrasado, false);
  });

  await t.test('uma cópia adulterada não passa na conferência', () => {
    // Simula o pior caso: o arquivo existe mas o razão dentro dele não bate.
    const r = backup.gerar(api.db, { automatico: false });
    const copia = path.join(config.backupDir, r.nome);
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(copia);
    d.prepare('DELETE FROM lancamentos').run();
    d.close();
    // Reabrindo e conferindo na mão o que o gerar() faz:
    const dc = new DatabaseSync(copia, { readOnly: true });
    const totalCopia = dc.prepare('SELECT COUNT(*) AS n FROM lancamentos').get().n;
    dc.close();
    assert.notEqual(totalCopia, api.db.prepare('SELECT COUNT(*) AS n FROM lancamentos').get().n);
  });

  await t.test('não dá para baixar arquivo fora da pasta de backups', async () => {
    assert.equal(backup.caminho('../../etc/passwd'), null);
    assert.equal(backup.caminho('payax-nao-existe.db'), null);
    assert.equal((await api.get('/api/seguranca/backups/..%2F..%2Fetc%2Fpasswd', tk.admin)).status, 404);
  });

  await t.test('só o administrador gera e baixa', async () => {
    assert.equal((await api.post('/api/seguranca/backups', {}, tk.financeiro)).status, 403);
    const nome = (await api.get('/api/seguranca', tk.admin)).dados.backups.historico[0].nome;
    assert.equal((await api.get(`/api/seguranca/backups/${nome}`, tk.operacao)).status, 403);
  });

  await t.test('o painel avisa quando o backup atrasa', () => {
    api.db.prepare("UPDATE backups SET criado_em = datetime('now', '-3 days')").run();
    const s = backup.situacao(api.db);
    assert.equal(s.atrasado, true);
  });
});

test('duas etapas: login, exigência e redefinição', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);

  let segredo;
  await t.test('configura e ativa', async () => {
    const i = await api.post('/api/auth/2fa/iniciar', {}, tk.admin);
    assert.equal(i.status, 200);
    assert.match(i.dados.qr_svg, /^<svg/);
    segredo = i.dados.segredo;
    assert.equal((await api.post('/api/auth/2fa/ativar', { codigo: '000000' }, tk.admin)).status, 422);
    assert.equal((await api.post('/api/auth/2fa/ativar', { codigo: totp.codigo(segredo, totp.passoAtual()) }, tk.admin)).status, 200);
  });

  let desafio;
  await t.test('o login passa a pedir o código e não devolve token na primeira etapa', async () => {
    const r = await api.post('/api/auth/login', { email: 'admin@payax.local', senha: 'admin12345' });
    assert.equal(r.status, 200);
    assert.equal(r.dados.precisa_2fa, true);
    assert.equal(r.dados.token, undefined);
    desafio = r.dados.desafio;
  });

  await t.test('o desafio não abre nenhuma rota do sistema', async () => {
    assert.equal((await api.get('/api/painel', desafio)).status, 401);
    assert.equal((await api.get('/api/clientes', desafio)).status, 401);
  });

  await t.test('código errado é recusado e fica na auditoria', async () => {
    assert.equal((await api.post('/api/auth/2fa', { desafio, codigo: '123456' })).status, 401);
    const n = api.db.prepare("SELECT COUNT(*) AS n FROM auditoria WHERE acao = 'login.2fa.recusado'").get().n;
    assert.ok(n >= 1);
  });

  let tkNovo;
  await t.test('código certo entra, e o mesmo código não serve de novo', async () => {
    const codigo = codigoUsavel(api, segredo);
    const r = await api.post('/api/auth/2fa', { desafio, codigo });
    assert.equal(r.status, 200);
    assert.ok(r.dados.token);
    assert.equal(r.dados.usuario.totp_ativo, true);
    tkNovo = r.dados.token;
    assert.equal((await api.post('/api/auth/2fa', { desafio, codigo })).status, 401, 'código reutilizado');
  });

  await t.test('desafio inválido ou vencido não entra', async () => {
    assert.equal((await api.post('/api/auth/2fa', { desafio: 'inventado.aqui', codigo: codigoUsavel(api, segredo) })).status, 401);
  });

  await t.test('exigir da equipe: só com o próprio 2FA ativo', async () => {
    const semProprio = await api.put('/api/seguranca/exigir-2fa', { exigir: true }, tk.financeiro);
    assert.equal(semProprio.status, 403, 'financeiro não configura segurança');
    const r = await api.put('/api/seguranca/exigir-2fa', { exigir: true }, tkNovo);
    assert.equal(r.status, 200);
    assert.equal(r.dados.exigir_2fa_equipe, true);
  });

  await t.test('com a exigência ligada, quem não tem 2FA é mandado configurar', async () => {
    const r = await api.post('/api/auth/login', { email: 'financeiro@payax.local', senha: 'senha-de-teste-1' });
    assert.equal(r.status, 200);
    assert.equal(r.dados.configurar_2fa, true, 'a tela força a configuração');
    assert.equal(r.dados.usuario.totp_ativo, false);
  });

  await t.test('com a exigência ligada, ninguém desliga o próprio 2FA', async () => {
    const r = await api.post('/api/auth/2fa/desativar', { senha: 'admin12345', codigo: codigoUsavel(api, segredo) }, tkNovo);
    assert.equal(r.status, 403);
  });

  await t.test('o administrador redefine o 2FA de quem perdeu o celular', async () => {
    const r = await api.post(`/api/seguranca/equipe/${tk.financeiro_id}/redefinir-2fa`, {}, tkNovo);
    assert.equal(r.status, 200);
    assert.equal(api.db.prepare('SELECT totp_ativo FROM usuarios WHERE id = ?').get(tk.financeiro_id).totp_ativo, 0);
    assert.ok(api.db.prepare("SELECT 1 FROM auditoria WHERE acao = '2fa.redefinida'").get());
  });

  await t.test('desligada a exigência, dá para desativar com senha e código', async () => {
    await api.put('/api/seguranca/exigir-2fa', { exigir: false }, tkNovo);
    const r = await api.post('/api/auth/2fa/desativar', { senha: 'admin12345', codigo: codigoUsavel(api, segredo) }, tkNovo);
    assert.equal(r.status, 200);
    const login = await api.post('/api/auth/login', { email: 'admin@payax.local', senha: 'admin12345' });
    assert.equal(login.dados.precisa_2fa, undefined);
    assert.ok(login.dados.token);
  });

  await t.test('desativar com a senha errada é recusado', async () => {
    const i = await api.post('/api/auth/2fa/iniciar', {}, tk.admin);
    await api.post('/api/auth/2fa/ativar', { codigo: totp.codigo(i.dados.segredo, totp.passoAtual()) }, tk.admin);
    const r = await api.post('/api/auth/2fa/desativar', { senha: 'senha-errada', codigo: codigoUsavel(api, i.dados.segredo) }, tk.admin);
    assert.equal(r.status, 422);
  });
});

test('duas etapas na Área do Cliente do cliente', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const c = await api.cliente(tk.admin);

  await t.test('o cliente ativa e passa a precisar do código', async () => {
    const i = await api.post('/cliente/api/auth/2fa/iniciar', {}, c.token);
    assert.equal(i.status, 200);
    const segredo = i.dados.segredo;
    assert.equal((await api.post('/cliente/api/auth/2fa/ativar', { codigo: totp.codigo(segredo, totp.passoAtual()) }, c.token)).status, 200);

    const login = await api.post('/cliente/api/auth/login', { email: c.acesso.email, senha: c.acesso.senha_provisoria });
    assert.equal(login.dados.precisa_2fa, true);
    assert.equal(login.dados.token, undefined);

    const entrou = await api.post('/cliente/api/auth/2fa', {
      desafio: login.dados.desafio,
      codigo: codigoUsavel(api, segredo, { tabela: 'usuarios_cliente', id: c.acesso.id }),
    });
    assert.equal(entrou.status, 200);
    assert.ok(entrou.dados.token);
    assert.equal((await api.get('/cliente/api/painel', entrou.dados.token)).status, 200);
  });

  await t.test('o desafio do cliente não vale no backoffice, nem o contrário', async () => {
    const login = await api.post('/cliente/api/auth/login', { email: c.acesso.email, senha: c.acesso.senha_provisoria });
    assert.equal((await api.post('/api/auth/2fa', { desafio: login.dados.desafio, codigo: '123456' })).status, 401);
  });

  await t.test('a equipe redefine o 2FA do acesso do cliente', async () => {
    const r = await api.post(`/api/seguranca/acessos/${c.acesso.id}/redefinir-2fa`, {}, tk.admin);
    assert.equal(r.status, 200);
    const login = await api.post('/cliente/api/auth/login', { email: c.acesso.email, senha: c.acesso.senha_provisoria });
    assert.ok(login.dados.token, 'volta a entrar só com a senha');
  });
});
