'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { dataLocal, somarDias } = require('../server/lib/datas');
const { REGRAS } = require('../server/lib/conformidade');

const hoje = () => dataLocal('America/Sao_Paulo');
const regrasDe = (d) => Object.fromEntries(d.grupos.flatMap((g) => g.regras).map((r) => [r.id, r]));

test('conformidade: o sistema confere as próprias regras', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  const venc = somarDias(hoje(), 20);

  await t.test('com o sistema em ordem, as regras de boleto e banco estão atendidas', async () => {
    await api.boleto(tk.admin, a.cliente.id, { vencimento: venc });
    const r = await api.get('/api/conformidade', tk.admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.resumo.total, REGRAS.length);
    const x = regrasDe(r.dados);
    for (const id of ['multa-cdc', 'juros-mora', 'especie-servico', 'beneficiario-final', 'nomenclatura',
      'pagador-identificado', 'beneficiario-identificado', 'sem-tarifa-bancaria', 'registro', 'cnab-layout',
      'repasse-imediato', 'termos-instituicao-financeira']) {
      assert.equal(x[id].situacao, 'ok', `${id}: ${x[id].detalhe}`);
    }
    // Toda regra diz de qual norma vem.
    for (const regra of Object.values(x)) assert.ok(regra.norma, `${regra.id} sem norma`);
  });

  await t.test('um boleto antigo com multa acima de 2% aparece como fora da norma, e o painel avisa', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { vencimento: venc });
    // Simula um título emitido antes da trava existir.
    api.db.prepare('UPDATE boletos SET multa_ppm = 50000 WHERE id = ?').run(b.id);
    const x = regrasDe((await api.get('/api/conformidade', tk.admin)).dados);
    assert.equal(x['multa-cdc'].situacao, 'fora');
    assert.match(x['multa-cdc'].detalhe, /1 boleto em aberto com multa acima de 2%/);
    const painel = (await api.get('/api/painel', tk.admin)).dados;
    assert.ok(painel.alertas.some((al) => al.tipo === 'conformidade' && al.severidade === 'erro'));

    // Baixado, o título não chega mais ao pagador: a regra volta a ficar em dia.
    api.db.prepare("UPDATE boletos SET situacao = 'baixado' WHERE id = ?").run(b.id);
    assert.equal(regrasDe((await api.get('/api/conformidade', tk.admin)).dados)['multa-cdc'].situacao, 'ok');
  });

  await t.test('título antigo registrado como duplicata mercantil fica em atenção, não fora', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { vencimento: venc });
    api.db.prepare("UPDATE boletos SET especie = 'DM' WHERE id = ?").run(b.id);
    const x = regrasDe((await api.get('/api/conformidade', tk.admin)).dados);
    assert.equal(x['especie-servico'].situacao, 'atencao');
    api.db.prepare("UPDATE boletos SET situacao = 'baixado' WHERE id = ?").run(b.id);
  });

  await t.test('o administrador registra o acompanhamento, e fica na auditoria', async () => {
    const r = await api.put('/api/conformidade/recebimento-terceiros', {
      situacao: 'em_andamento', responsavel: 'Dra. Fulana (advogada)', prazo: somarDias(hoje(), 30),
      observacao: 'Consulta enviada ao escritório.',
    }, tk.admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.situacao, 'em_andamento');
    assert.equal(r.dados.responsavel, 'Dra. Fulana (advogada)');
    assert.equal(r.dados.prazo_vencido, false);
    const log = api.db.prepare("SELECT * FROM auditoria WHERE acao = 'conformidade.atualizada' ORDER BY id DESC LIMIT 1").get();
    assert.ok(log, 'registrado na auditoria');
    assert.match(log.depois, /recebimento-terceiros/);
  });

  await t.test('prazo vencido aparece no resumo e no painel', async () => {
    await api.put('/api/conformidade/pld-politica', { situacao: 'pendente', prazo: somarDias(hoje(), -3) }, tk.admin);
    const d = (await api.get('/api/conformidade', tk.admin)).dados;
    assert.equal(regrasDe(d)['pld-politica'].prazo_vencido, true);
    assert.equal(d.resumo.prazos_vencidos, 1);
    const painel = (await api.get('/api/painel', tk.admin)).dados;
    assert.ok(painel.alertas.some((al) => al.tipo === 'conformidade_prazo'));
    // Atendida, o prazo deixa de contar.
    await api.put('/api/conformidade/pld-politica', { situacao: 'atendida', prazo: somarDias(hoje(), -3) }, tk.admin);
    assert.equal((await api.get('/api/conformidade', tk.admin)).dados.resumo.prazos_vencidos, 0);
  });

  await t.test('regra automática não se marca à mão', async () => {
    const r = await api.put('/api/conformidade/multa-cdc', { situacao: 'atendida' }, tk.admin);
    assert.equal(r.status, 409);
  });

  await t.test('situação inválida e regra que não existe são recusadas', async () => {
    assert.equal((await api.put('/api/conformidade/pld-politica', { situacao: 'resolvida' }, tk.admin)).status, 422);
    assert.equal((await api.put('/api/conformidade/nao-existe', { situacao: 'pendente' }, tk.admin)).status, 404);
  });

  await t.test('a equipe vê; só o administrador registra', async () => {
    for (const perfil of ['financeiro', 'operacao', 'consulta']) {
      assert.equal((await api.get('/api/conformidade', tk[perfil])).status, 200, `${perfil} vê`);
      assert.equal((await api.put('/api/conformidade/pld-politica', { situacao: 'pendente' }, tk[perfil])).status, 403, `${perfil} não registra`);
    }
  });
});
