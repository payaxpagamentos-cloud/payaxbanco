'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, CPF } = require('./helpers');
const { dataLocal, somarDias } = require('../server/lib/datas');
const lgpd = require('../server/lib/lgpd');

const hoje = () => dataLocal('America/Sao_Paulo');
const regrasDe = (d) => Object.fromEntries(d.grupos.flatMap((g) => g.regras).map((r) => [r.id, r]));

/** Envia o formulário público como um navegador (application/x-www-form-urlencoded). */
async function enviarFormulario(api, caminho, campos) {
  const resp = await fetch(`${api.raiz}${caminho}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(campos).toString(),
  });
  return { status: resp.status, html: await resp.text() };
}

test('LGPD: aviso público, pedido do titular, retenção e incidentes', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);

  await t.test('o aviso de privacidade é público, nas duas áreas, e mostra o inventário e os direitos', async () => {
    for (const caminho of ['/privacidade', '/cliente/privacidade']) {
      const resp = await fetch(`${api.raiz}${caminho}`);
      assert.equal(resp.status, 200, caminho);
      const html = await resp.text();
      assert.match(html, /Como a PAY AX trata os seus dados/);
      for (const x of lgpd.INVENTARIO) assert.ok(html.includes(x.titulo), `inventário: ${x.titulo}`);
      assert.match(html, /art\. 18/);
      assert.match(html, /15 dias/);
      assert.match(html, /<form method="post"/);
    }
  });

  await t.test('sem encarregado é fora da norma; cadastrado, aparece no aviso', async () => {
    assert.equal(regrasDe((await api.get('/api/conformidade', tk.admin)).dados)['lgpd-encarregado'].situacao, 'fora');
    const r = await api.put('/api/lgpd/encarregado', { nome: 'Ana Encarregada', email: 'dpo@payax.com.br' }, tk.admin);
    assert.equal(r.status, 200);
    const html = await (await fetch(`${api.raiz}/privacidade`)).text();
    assert.ok(html.includes('Ana Encarregada') && html.includes('dpo@payax.com.br'));
    assert.equal(regrasDe((await api.get('/api/conformidade', tk.admin)).dados)['lgpd-encarregado'].situacao, 'ok');
  });

  await t.test('o boleto e a Área do Cliente levam ao aviso', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { vencimento: somarDias(hoje(), 10) });
    const ficha = (await api.get(`/api/boletos/${b.id}/ficha`, tk.admin)).dados;
    assert.match(ficha, /privacidade/);
    assert.equal(regrasDe((await api.get('/api/conformidade', tk.admin)).dados)['lgpd-aviso'].situacao, 'ok');
  });

  let protocolo;
  await t.test('o titular faz o pedido pelo formulário e recebe protocolo e prazo de 15 dias', async () => {
    const r = await enviarFormulario(api, '/privacidade/pedido', { tipo: 'acesso', nome: 'Maria Souza', documento: CPF, email: 'maria@exemplo.com.br', mensagem: 'Quero saber o que vocês têm.' });
    assert.equal(r.status, 201);
    protocolo = r.html.match(/LGPD-\d{4}-\d{6}-[0-9A-F]{4}/)?.[0];
    assert.ok(protocolo, 'protocolo na resposta');
    const p = api.db.prepare('SELECT * FROM lgpd_pedidos WHERE protocolo = ?').get(protocolo);
    assert.equal(p.prazo, somarDias(hoje(), 15), 'art. 19, II');
    assert.equal(p.situacao, 'recebido');
  });

  await t.test('formulário com dado inválido volta com o erro, sem gravar; robô é ignorado', async () => {
    const antes = api.db.prepare('SELECT COUNT(*) AS n FROM lgpd_pedidos').get().n;
    const r = await enviarFormulario(api, '/privacidade/pedido', { tipo: 'acesso', nome: 'X', documento: '123', email: 'a@b.com' });
    assert.equal(r.status, 422);
    assert.match(r.html, /Não foi possível registrar o pedido/);
    await enviarFormulario(api, '/privacidade/pedido', { tipo: 'acesso', nome: 'Robô', documento: CPF, email: 'r@b.com', site: 'spam' });
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM lgpd_pedidos').get().n, antes);
  });

  await t.test('só responde depois de conferir a identidade; o relatório traz os boletos e não traz PLD', async () => {
    const p = api.db.prepare('SELECT id FROM lgpd_pedidos WHERE protocolo = ?').get(protocolo);
    assert.equal((await api.get(`/api/lgpd/pedidos/${p.id}/dados`, tk.admin)).status, 409, 'sem identidade, sem relatório');
    assert.equal((await api.post(`/api/lgpd/pedidos/${p.id}/responder`, { resultado: 'atendido', resposta: 'x'.repeat(30) }, tk.admin)).status, 409);
    await api.post(`/api/lgpd/pedidos/${p.id}/identidade`, { como: 'Confirmou pelo e-mail que consta no boleto' }, tk.admin);
    const dados = (await api.get(`/api/lgpd/pedidos/${p.id}/dados`, tk.admin)).dados;
    assert.ok(dados.como_pagador.length >= 1);
    assert.equal(dados.como_pagador[0].provedor, 'Alfa Net');
    assert.match(dados.observacao, /Lei 9\.613/);
    assert.ok(!JSON.stringify(dados).includes('pld_'), 'nada de PLD no relatório');
    const r = await api.post(`/api/lgpd/pedidos/${p.id}/responder`, { resultado: 'atendido', resposta: 'Enviamos por e-mail o relatório dos seus dados, com os boletos emitidos pela Alfa Net.' }, tk.admin);
    assert.equal(r.dados.situacao, 'atendido');
  });

  await t.test('pedido sem resposta depois de 15 dias é fora da norma e alerta no painel', async () => {
    const r = await enviarFormulario(api, '/privacidade/pedido', { tipo: 'correcao', nome: 'João Lima', documento: CPF, email: 'joao@exemplo.com.br' });
    const prot = r.html.match(/LGPD-\d{4}-\d{6}-[0-9A-F]{4}/)[0];
    api.db.prepare('UPDATE lgpd_pedidos SET prazo = ? WHERE protocolo = ?').run(somarDias(hoje(), -1), prot);
    assert.equal(regrasDe((await api.get('/api/conformidade', tk.admin)).dados)['lgpd-pedidos'].situacao, 'fora');
    assert.ok((await api.get('/api/painel', tk.admin)).dados.alertas.some((x) => x.tipo === 'lgpd_pedidos' && x.severidade === 'erro'));
  });

  await t.test('só o administrador vê os pedidos', async () => {
    for (const perfil of ['financeiro', 'operacao', 'consulta']) {
      assert.equal((await api.get('/api/lgpd/pedidos', tk[perfil])).status, 403, perfil);
    }
  });

  await t.test('retenção: título concluído há mais de 5 anos é anonimizado; em aberto, nunca', async () => {
    const pago = await api.boleto(tk.admin, a.cliente.id, { vencimento: somarDias(hoje(), 10) });
    await api.post(`/api/boletos/${pago.id}/liquidar`, { pago_em: hoje(), valor_pago: '100,00', meio: 'pix' }, tk.financeiro);
    const aberto = await api.boleto(tk.admin, a.cliente.id, { vencimento: somarDias(hoje(), 10) });
    const antigo = somarDias(hoje(), -6 * 366);
    api.db.prepare('UPDATE boletos SET pago_em = ? WHERE id = ?').run(antigo, pago.id);
    api.db.prepare('UPDATE boletos SET criado_em = ? WHERE id = ?').run(`${antigo}T10:00:00Z`, aberto.id);
    api.db.prepare("INSERT INTO auditoria (usuario_tipo, acao, ip, criado_em) VALUES ('sistema', 'teste.antigo', '200.1.2.3', ?)").run(`${somarDias(hoje(), -200)}T10:00:00Z`);
    assert.equal(regrasDe((await api.get('/api/conformidade', tk.admin)).dados)['lgpd-retencao'].situacao, 'fora');

    const r = (await api.post('/api/lgpd/retencao', {}, tk.admin)).dados;
    assert.ok(r.boletos >= 1);
    const b = api.db.prepare('SELECT * FROM boletos WHERE id = ?').get(pago.id);
    assert.equal(b.pagador_nome, 'Titular anonimizado');
    assert.equal(b.pagador_documento, 'anonimizado');
    assert.ok(b.anonimizado_em);
    assert.equal(b.pago_valor_centavos, 10000, 'o valor fica: é registro financeiro sem dado pessoal');
    const lanc = api.db.prepare('SELECT descricao FROM lancamentos WHERE boleto_id = ?').all(pago.id);
    assert.ok(lanc.every((l) => !l.descricao.includes('Maria')), 'descrição dos lançamentos sem o nome');
    assert.equal(api.db.prepare('SELECT pagador_nome FROM boletos WHERE id = ?').get(aberto.id).pagador_nome, 'Maria Souza', 'em aberto não se toca');
    assert.equal(api.db.prepare("SELECT ip FROM auditoria WHERE acao = 'teste.antigo'").get().ip, null, 'IP com mais de 6 meses apagado');
    assert.equal(regrasDe((await api.get('/api/conformidade', tk.admin)).dados)['lgpd-retencao'].situacao, 'ok');
  });

  await t.test('incidente: prazo de 3 dias úteis da descoberta; risco relevante só encerra comunicado', async () => {
    const sexta = '2026-11-13';
    const inc = (await api.post('/api/lgpd/incidentes', { descoberto_em: sexta, descricao: 'Planilha de pagadores enviada por e-mail ao destinatário errado.',
      dados_afetados: 'nome e CPF de pagadores', titulares_estimados: 40, risco: 'relevante' }, tk.admin)).dados;
    assert.equal(inc.prazo_comunicacao, '2026-11-18', 'descoberto na sexta: conta segunda, terça e quarta');
    assert.equal((await api.patch(`/api/lgpd/incidentes/${inc.id}`, { encerrar: 'true' }, tk.admin)).status, 409);
    await api.patch(`/api/lgpd/incidentes/${inc.id}`, { anpd_protocolo: 'ANPD-2026-555', titulares_comunicados: 'true' }, tk.admin);
    const fim = await api.patch(`/api/lgpd/incidentes/${inc.id}`, { encerrar: 'true' }, tk.admin);
    assert.equal(fim.status, 200);
    assert.ok(fim.dados.encerrado_em);
  });
});
