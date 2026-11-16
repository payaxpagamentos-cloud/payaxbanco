'use strict';

/*
 * Regressões da segunda revisão geral (antes da produção): cada teste reproduz uma falha encontrada.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const totp = require('../server/lib/totp');
const { criarIxcFalso } = require('./ixc-falso');
const boletosLib = require('../server/lib/boletos');
const { dataLocal, somarDias } = require('../server/lib/datas');

const hoje = () => dataLocal('America/Sao_Paulo');

test('revisão 2: aviso do banco (webhook)', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  const token = await api.tokenWebhook(tk.admin);

  await t.test('o token do aviso não aparece para quem só consulta', async () => {
    const r = await api.get('/api/integracoes', tk.consulta);
    assert.equal(r.status, 200);
    assert.equal(r.dados.banco.config.webhook_token, undefined);
    assert.equal(r.dados.banco.webhook_caminho, undefined);
    assert.doesNotMatch(JSON.stringify(r.dados), new RegExp(token));
    const adm = await api.get('/api/integracoes', tk.admin);
    assert.match(adm.dados.banco.webhook_caminho, new RegExp(`${token}$`), 'o administrador ainda vê o endereço');
  });

  await t.test('nosso número repetido em duas contas: o aviso não liquida nenhum (não adivinha o cliente)', async () => {
    const contaB = await api.conta(tk.admin, { apelido: 'Outra conta', agencia: '1111', conta: '0002222' });
    const b = await api.cliente(tk.admin, { razao_social: 'Provedor Beta LTDA', nome_fantasia: 'Beta', cnpj: '19131243000197' });
    const x1 = await api.boleto(tk.admin, a.cliente.id, { vencimento: somarDias(hoje(), 5) });
    const x2 = await api.boleto(tk.admin, b.cliente.id, { vencimento: somarDias(hoje(), 5), conta_id: contaB.id });
    const l1 = api.db.prepare('SELECT * FROM boletos WHERE id = ?').get(x1.id);
    const l2 = api.db.prepare('SELECT * FROM boletos WHERE id = ?').get(x2.id);
    if (l1.nosso_numero !== l2.nosso_numero) return; // faixas diferentes: sem conflito para testar
    const r = await api.post(`/api/publico/webhook/${token}`, { evento: 'liquidacao', nossoNumero: l1.nosso_numero, valorPago: '100,00' });
    assert.equal(r.dados.processado, false);
    for (const id of [x1.id, x2.id]) assert.notEqual(api.db.prepare('SELECT situacao FROM boletos WHERE id = ?').get(id).situacao, 'liquidado');
  });
});

test('revisão 2: estorno e relatórios', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin, { tarifa_emissao: '1,00' });
  const a = await api.cliente(tk.admin);
  const situacao = (id) => api.db.prepare('SELECT situacao FROM boletos WHERE id = ?').get(id).situacao;

  await t.test('estornado, o título pode ser pago de novo (e estornado de novo sem dobrar o estorno)', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { vencimento: somarDias(hoje(), 5) });
    boletosLib.liquidar(api.db, b.id, { pago_em: hoje(), valor_pago_centavos: 10000 });
    boletosLib.estornarLiquidacao(api.db, b.id, 'pagamento devolvido');
    assert.equal(situacao(b.id), 'registrado');
    const de_novo = boletosLib.liquidar(api.db, b.id, { pago_em: hoje(), valor_pago_centavos: 10000 });
    assert.notEqual(de_novo.ja_liquidado, true);
    assert.equal(situacao(b.id), 'liquidado');
    boletosLib.estornarLiquidacao(api.db, b.id, 'de novo');
    const soma = api.db.prepare("SELECT IFNULL(SUM(valor_centavos), 0) AS s FROM lancamentos WHERE boleto_id = ? AND tipo <> 'tarifa_emissao'").get(b.id).s;
    assert.equal(soma, 0, 'duas liquidações, dois estornos: nada sobra');
  });

  await t.test('receita e "ficou para você" descontam os estornos', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { vencimento: somarDias(hoje(), 5) });
    const periodo = `de=${somarDias(hoje(), -1)}&ate=${somarDias(hoje(), 1)}`;
    const antes = (await api.get(`/api/relatorios/faturamento?${periodo}`, tk.admin)).dados;
    boletosLib.liquidar(api.db, b.id, { pago_em: hoje(), valor_pago_centavos: 10000 });
    boletosLib.estornarLiquidacao(api.db, b.id, 'pagamento devolvido');
    const depois = (await api.get(`/api/relatorios/faturamento?${periodo}`, tk.admin)).dados;
    // Pago e estornado: a tarifa PAY AX e a tarifa bancária voltam; a receita não muda.
    assert.equal(depois.liquidacoes.receita_centavos - antes.liquidacoes.receita_centavos, 0);
    assert.ok(depois.liquidacoes.liquido_cliente_centavos >= 0, 'nunca negativo');
  });

  await t.test('CSV de boletos traz todos os títulos, não só os 200 primeiros', async () => {
    const ins = api.db.prepare(`INSERT INTO boletos (cliente_id, conta_id, nosso_numero, nosso_numero_dv, tipo, pagador_nome, pagador_documento,
      valor_centavos, emissao, vencimento, situacao, criado_em)
      SELECT cliente_id, conta_id, printf('%011d', 900000 + ?), '0', tipo, pagador_nome, pagador_documento, valor_centavos, emissao, vencimento, situacao, criado_em
      FROM boletos WHERE cliente_id = ? LIMIT 1`);
    for (let i = 0; i < 210; i++) ins.run(i, a.cliente.id);
    const total = api.db.prepare('SELECT COUNT(*) AS n FROM boletos WHERE cliente_id = ?').get(a.cliente.id).n;
    const cl = await api.get('/cliente/api/boletos/export.csv', a.token);
    const bo = await api.get(`/api/boletos/export.csv?cliente_id=${a.cliente.id}`, tk.admin);
    const linhas = (txt) => String(txt).trim().split('\n').length - 1;
    assert.equal(linhas(cl.dados), total);
    assert.equal(linhas(bo.dados), total);
  });
});

test('revisão 2: acesso e horários', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);

  await t.test('PIX enviado há mais de 30 minutos, no mesmo dia, aparece no painel', async () => {
    const r = api.db.prepare(`INSERT INTO repasses (cliente_id, valor_centavos, taxa_centavos, valor_liquido_centavos, pix_chave, situacao,
      criado_em, enviado_em) VALUES (?, 1000, 0, 1000, 'x', 'enviado', ?, ?) RETURNING id`)
      .get(a.cliente.id, new Date(Date.now() - 2 * 3600e3).toISOString(), new Date(Date.now() - 2 * 3600e3).toISOString());
    const painel = (await api.get('/api/painel', tk.admin)).dados;
    assert.ok(painel.alertas.some((x) => x.tipo === 'repasses_sem_resposta'));
    api.db.prepare('DELETE FROM repasses WHERE id = ?').run(r.id);
  });

  await t.test('filtro de data usa o dia de Brasília (22h30 do dia 14 é dia 14)', async () => {
    // 01:30 UTC do dia 15 = 22:30 do dia 14 em Brasília.
    const r = api.db.prepare(`INSERT INTO repasses (cliente_id, valor_centavos, taxa_centavos, valor_liquido_centavos, pix_chave, situacao,
      criado_em) VALUES (?, 1000, 0, 1000, 'x', 'confirmado', '2026-11-15T01:30:00.000Z') RETURNING id`).get(a.cliente.id);
    const lista = (await api.get('/api/repasses?de=2026-11-14&ate=2026-11-14', tk.admin)).dados;
    assert.ok(lista.itens.some((x) => x.id === r.id));
    api.db.prepare('DELETE FROM repasses WHERE id = ?').run(r.id);
  });

  await t.test('2FA exigido da equipe vale no servidor, não só na tela', async () => {
    const i = await api.post('/api/auth/2fa/iniciar', {}, tk.admin);
    await api.post('/api/auth/2fa/ativar', { codigo: totp.codigo(i.dados.segredo, totp.passoAtual()) }, tk.admin);
    assert.equal((await api.put('/api/seguranca/exigir-2fa', { exigir: true }, tk.admin)).status, 200);
    const sem = await api.post('/api/auth/login', { email: 'financeiro@payax.local', senha: 'senha-de-teste-1' });
    assert.equal(sem.status, 200);
    assert.equal(sem.dados.configurar_2fa, true);
    assert.equal((await api.post('/api/repasses/rotina', {}, sem.dados.token)).status, 403, 'sem 2FA não opera');
    assert.equal((await api.get('/api/boletos', sem.dados.token)).status, 403, 'nem consulta');
    assert.equal((await api.get('/api/auth/eu', sem.dados.token)).status, 200, 'mas vê a sessão');
    assert.equal((await api.post('/api/auth/2fa/iniciar', {}, sem.dados.token)).status, 200, 'e configura o 2FA');
    await api.put('/api/seguranca/exigir-2fa', { exigir: false }, tk.admin);
  });

  await t.test('senha provisória: só troca a senha antes de trabalhar', async () => {
    api.db.prepare("UPDATE usuarios SET senha_provisoria = 1 WHERE email = 'operacao@payax.local'").run();
    assert.equal((await api.get('/api/boletos', tk.operacao)).status, 403);
    assert.equal((await api.get('/api/auth/eu', tk.operacao)).status, 200);
    api.db.prepare("UPDATE usuarios SET senha_provisoria = 0 WHERE email = 'operacao@payax.local'").run();
  });

  await t.test('baixa no IXC: o sucesso do boleto 12 não esconde a falha do boleto 1', () => {
    const s = api.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT '{"boleto_id":12,"ixc_id":5}' AS detalhe) s
      WHERE (CASE WHEN json_valid(s.detalhe) THEN json_extract(s.detalhe, '$.boleto_id') END) = 1`).get().n;
    assert.equal(s, 0);
  });
});

test('revisão 2: provedor grande no IXC', async (t) => {
  const titulos = Array.from({ length: 450 }, (_, i) => ({
    id: String(5000 + i), id_cliente: '9001', documento: `NF-${i}`, valor: '99,90', data_vencimento: '2026-12-15', status: 'A' }));
  const ixc = criarIxcFalso({ titulos });
  const url = await ixc.iniciar();
  const api = await iniciar();
  t.after(async () => { await api.fechar(); await ixc.fechar(); });
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  await api.put(`/api/integracoes/ixc/${a.cliente.id}`, { url, token: '7:hash-de-teste', tipo_padrao: 'bolepix' }, tk.admin);

  await t.test('a importação lê todas as páginas (antes parava nos 200 primeiros)', async () => {
    const r = await api.post(`/api/integracoes/ixc/${a.cliente.id}/importar`, { de: '2026-12-01', ate: '2026-12-31' }, tk.operacao);
    assert.equal(r.status, 200);
    assert.equal(r.dados.lidos, 450);
    assert.equal(r.dados.criados, 450);
    const de_novo = await api.post(`/api/integracoes/ixc/${a.cliente.id}/importar`, { de: '2026-12-01', ate: '2026-12-31' }, tk.operacao);
    assert.equal(de_novo.dados.criados, 0, 'rodar de novo não duplica');
  });

  await t.test('com a carteira PAY AX informada, título de outra carteira não vira boleto', async () => {
    titulos.push({ id: '9990', id_cliente: '9001', documento: 'OUTRO', valor: '50,00', data_vencimento: '2026-12-16', status: 'A', id_carteira_cobranca: '3' },
      { id: '9991', id_cliente: '9001', documento: 'PAYAX', valor: '50,00', data_vencimento: '2026-12-16', status: 'A', id_carteira_cobranca: '12' });
    assert.equal((await api.put(`/api/integracoes/ixc/${a.cliente.id}`, { url, tipo_padrao: 'bolepix', carteiras: '12' }, tk.admin)).status, 200);
    const r = await api.post(`/api/integracoes/ixc/${a.cliente.id}/importar`, { de: '2026-12-01', ate: '2026-12-31' }, tk.operacao);
    assert.equal(r.dados.criados, 1);
    const ids = api.db.prepare("SELECT ixc_receber_id FROM boletos WHERE ixc_receber_id IN ('9990','9991')").all().map((x) => x.ixc_receber_id);
    assert.deepEqual(ids, ['9991']);
    assert.equal((await api.put(`/api/integracoes/ixc/${a.cliente.id}`, { url, carteiras: 'abc' }, tk.admin)).status, 422);
  });

  await t.test('duas empresas no mesmo IXC: cada uma precisa da sua carteira, sem repetir', async () => {
    assert.equal((await api.put(`/api/integracoes/ixc/${a.cliente.id}`, { url, tipo_padrao: 'bolepix', carteiras: '12' }, tk.admin)).status, 200);
    const b = await api.cliente(tk.admin, { razao_social: 'Alfa Net Filial SP LTDA', cnpj: '45543915000181', email: 'filial-sp@exemplo.com.br' });
    const semCarteira = await api.put(`/api/integracoes/ixc/${b.cliente.id}`, { url: `${url}/`, token: '7:hash-de-teste' }, tk.admin);
    assert.equal(semCarteira.status, 422, 'sem carteira, importaria os títulos da outra empresa');
    const mesma = await api.put(`/api/integracoes/ixc/${b.cliente.id}`, { url, token: '7:hash-de-teste', carteiras: '12' }, tk.admin);
    assert.equal(mesma.status, 409);
    assert.equal((await api.put(`/api/integracoes/ixc/${b.cliente.id}`, { url, token: '7:hash-de-teste', carteiras: '15' }, tk.admin)).status, 200);
    const r = await api.post(`/api/integracoes/ixc/${b.cliente.id}/importar`, { de: '2026-12-01', ate: '2026-12-31' }, tk.operacao);
    assert.equal(r.dados.criados, 0, 'nenhum título da carteira 12 (da outra empresa) vira boleto desta');
  });
});

test('revisão 2: valores no padrão da tela (R$ 1.500,00)', () => {
  const v = require('../server/lib/validacao');
  assert.equal(v.centavos('R$ 1.500,00', 'o valor'), 150000);
  assert.equal(v.centavos('R$ 0,09', 'o valor'), 9);
  assert.equal(v.centavos('R$ 1.234.567,89', 'o valor'), 123456789);
  assert.equal(v.centavosOpcional('', 'o valor'), null, 'campo apagado = vazio (ex.: tarifa máxima sem teto)');
});
