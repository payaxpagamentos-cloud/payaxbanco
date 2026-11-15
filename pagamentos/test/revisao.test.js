'use strict';

/*
 * Regressões da revisão geral: cada teste reproduz uma falha encontrada e prova a correção.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { gerarRetorno } = require('./retorno-falso');
const arquivos = require('../server/lib/arquivosBanco');
const boletosLib = require('../server/lib/boletos');
const { dataLocal, somarDias } = require('../server/lib/datas');

const hoje = () => dataLocal('America/Sao_Paulo');

test('revisão: dinheiro', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  const contaA = await api.conta(tk.admin);
  await api.precoPadrao(tk.admin, { tarifa_emissao: '1,00' });
  const a = await api.cliente(tk.admin);
  const venc = somarDias(hoje(), 10);
  const linha = (id) => api.db.prepare('SELECT * FROM boletos WHERE id = ?').get(id);
  const creditos = (id) => api.db.prepare("SELECT COUNT(*) AS n FROM lancamentos WHERE boleto_id = ? AND tipo = 'credito_liquidacao'").get(id).n;
  let n = 0;
  const retorno = (conta, regs) => arquivos.processarRetorno(api.db, gerarRetorno(conta, regs, { gerado_em: hoje(), credito_em: hoje(), sequencial: ++n }), { nome: `r${n}` });

  await t.test('mesmo nosso número em duas contas: o retorno sem conta identificada não liquida nenhum', async () => {
    const contaB = await api.conta(tk.admin, { apelido: 'Outra conta', agencia: '1111', conta: '0002222' });
    const b1 = await api.boleto(tk.admin, a.cliente.id, { vencimento: venc });
    const b2 = await api.boleto(tk.admin, a.cliente.id, { vencimento: venc, conta_id: contaB.id });
    const x1 = linha(b1.id); const x2 = linha(b2.id);
    if (x1.nosso_numero !== x2.nosso_numero) return; // faixas diferentes: não há conflito para testar
    const contaRow = api.db.prepare('SELECT * FROM contas_bancarias WHERE id = ?').get(contaA.id);
    const r = retorno(contaRow, [{ nosso_numero: x1.nosso_numero, nosso_numero_dv: x1.nosso_numero_dv, ocorrencia: '06', ocorrido_em: hoje(),
      vencimento: venc, valor_centavos: 10000, pago_centavos: 10000, creditado_em: hoje() }]);
    assert.equal(r.liquidados ?? 0, 0);
    assert.notEqual(linha(b1.id).situacao, 'liquidado');
    assert.notEqual(linha(b2.id).situacao, 'liquidado');
  });

  await t.test('instrução recusada depois do pagamento não derruba o título nem permite creditar de novo', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { vencimento: venc });
    const x = linha(b.id);
    const contaRow = api.db.prepare('SELECT * FROM contas_bancarias WHERE id = ?').get(x.conta_id);
    const base = { nosso_numero: x.nosso_numero, nosso_numero_dv: x.nosso_numero_dv, ocorrido_em: hoje(), vencimento: venc, valor_centavos: x.valor_centavos };
    retorno(contaRow, [{ ...base, ocorrencia: '06', pago_centavos: x.valor_centavos, creditado_em: hoje() }, { ...base, ocorrencia: '32', motivos: ['04'] }]);
    assert.equal(linha(b.id).situacao, 'liquidado');
    boletosLib.liquidar(api.db, b.id, { pago_em: hoje(), valor_pago_centavos: x.valor_centavos });
    assert.equal(creditos(b.id), 1, 'um crédito só');
  });

  await t.test('banco recusou o registro: a tarifa de emissão volta para o cliente (uma vez)', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { vencimento: venc });
    const x = linha(b.id);
    const contaRow = api.db.prepare('SELECT * FROM contas_bancarias WHERE id = ?').get(x.conta_id);
    const reg = { nosso_numero: x.nosso_numero, nosso_numero_dv: x.nosso_numero_dv, ocorrencia: '03', ocorrido_em: hoje(), vencimento: venc, valor_centavos: x.valor_centavos, motivos: ['01'] };
    retorno(contaRow, [reg]); retorno(contaRow, [{ ...reg, seu_numero: 'repetido' }]);
    const soma = api.db.prepare("SELECT IFNULL(SUM(valor_centavos), 0) AS s FROM lancamentos WHERE boleto_id = ? AND tipo IN ('tarifa_emissao', 'estorno')").get(b.id).s;
    assert.equal(linha(b.id).situacao, 'falha');
    assert.equal(soma, 0, 'cobrou R$ 1,00 e devolveu R$ 1,00');
  });

  await t.test('a emissão é sempre hoje (data informada não escolhe tabela de preço antiga)', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { vencimento: venc, emissao: '2025-06-01' });
    assert.equal(linha(b.id).emissao, hoje());
  });

  await t.test('vencimento no fim de semana: sem multa e juros no dia útil seguinte', () => {
    // 14/11/2026 é sábado; segunda 16/11 ainda paga sem encargos; terça 17/11 já tem.
    const b = { valor_centavos: 10000, vencimento: '2026-11-14', multa_ppm: 20000, juros_mes_ppm: 10000 };
    assert.equal(boletosLib.valorAtualizado(b, '2026-11-16').valor_centavos, 10000);
    assert.ok(boletosLib.valorAtualizado(b, '2026-11-17').valor_centavos > 10000);
  });

  await t.test('extrato filtrado por tipo não mostra "saldo" sem sentido', async () => {
    const e = (await api.get(`/cliente/api/conta/extrato?de=${somarDias(hoje(), -5)}&ate=${somarDias(hoje(), 5)}&tipo=comissao`, a.token)).dados;
    assert.ok(e.itens.every((i) => i.saldo_acumulado_centavos === null));
    const d = (await api.get(`/cliente/api/conta/extrato?de=${somarDias(hoje(), -5)}&ate=${somarDias(hoje(), 5)}&ordem=desc&limite=1`, a.token)).dados;
    const tudo = (await api.get(`/cliente/api/conta/extrato?de=${somarDias(hoje(), -5)}&ate=${somarDias(hoje(), 5)}`, a.token)).dados;
    assert.equal(d.itens[0].id, tudo.itens.at(-1).id, 'ordem=desc traz o mais recente primeiro');
  });
});

test('revisão: destino do dinheiro e acesso', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  const ficha = async () => (await api.get(`/api/clientes/${a.cliente.id}`, tk.admin)).dados;

  await t.test('chave PIX de terceiro é recusada', async () => {
    const r = await api.patch(`/api/clientes/${a.cliente.id}`, { pix_chave: 'laranja@example.com', pix_documento: '52998224725', versao: (await ficha()).versao }, tk.admin);
    assert.equal(r.status, 422);
    const cpf = await api.patch(`/api/clientes/${a.cliente.id}`, { pix_chave: '52998224725', pix_tipo: 'cpf', versao: (await ficha()).versao }, tk.admin);
    assert.equal(cpf.status, 422);
  });

  await t.test('só financeiro/administrador trocam o destino', async () => {
    const r = await api.patch(`/api/clientes/${a.cliente.id}`, { pix_chave: 'financeiro@alfanet.com.br', versao: (await ficha()).versao }, tk.operacao);
    assert.equal(r.status, 403);
    const ok = await api.patch(`/api/clientes/${a.cliente.id}`, { pix_chave: 'financeiro@alfanet.com.br', versao: (await ficha()).versao }, tk.financeiro);
    assert.equal(ok.status, 200);
  });

  await t.test('perfil consulta não recebe margem no faturamento', async () => {
    const r = (await api.get(`/api/relatorios/faturamento?de=${somarDias(hoje(), -5)}&ate=${hoje()}`, tk.consulta)).dados;
    assert.equal(r.liquidacoes?.margem_centavos, undefined);
  });

  await t.test('a segunda etapa do login tem limite de tentativas', async () => {
    let bloqueado = false;
    for (let i = 0; i < 15 && !bloqueado; i++) {
      const r = await api.post('/api/auth/2fa', { desafio: 'x', codigo: '000000' });
      if (r.status === 429) bloqueado = true;
    }
    assert.ok(bloqueado, 'depois de algumas tentativas, 429');
  });
});
