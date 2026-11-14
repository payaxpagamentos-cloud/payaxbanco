'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, CPF } = require('./helpers');
const { dataLocal, somarDias } = require('../server/lib/datas');
const repassesLib = require('../server/lib/repasses');

const hoje = () => dataLocal('America/Sao_Paulo');
const regrasDe = (d) => Object.fromEntries(d.grupos.flatMap((g) => g.regras).map((r) => [r.id, r]));

/** CPF válido a partir de 9 dígitos (para ter pagadores diferentes). */
function cpf(base) {
  const d = String(base).padStart(9, '0').split('').map(Number);
  const dv = (nums) => { const s = nums.reduce((acc, n, i) => acc + n * (nums.length + 1 - i), 0) % 11; return s < 2 ? 0 : 11 - s; };
  d.push(dv(d)); d.push(dv(d));
  return d.join('');
}

test('PLD: monitoramento, análise, comunicação ao Coaf e sigilo', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  const venc = somarDias(hoje(), 10);

  const pagar = async (valor, extra = {}) => {
    const b = await api.boleto(tk.admin, a.cliente.id, { valor, vencimento: venc, ...extra });
    await api.post(`/api/boletos/${b.id}/liquidar`, { pago_em: hoje(), valor_pago: valor, meio: 'pix' }, tk.financeiro);
    return b;
  };
  const alertas = async (situacao = '') => (await api.get(`/api/pld/alertas?situacao=${situacao}`, tk.admin)).dados.itens;

  await t.test('boleto pago de valor alto gera alerta, e rodar de novo não duplica', async () => {
    const b = await pagar('12.000,00');
    const r = (await api.post('/api/pld/monitorar', {}, tk.admin)).dados;
    assert.ok(r.novos >= 1);
    const lista = await alertas();
    assert.ok(lista.some((x) => x.regra === 'valor-alto' && x.boleto_id === b.id));
    assert.equal((await api.post('/api/pld/monitorar', {}, tk.admin)).dados.novos, 0, 'idempotente');
  });

  await t.test('fracionamento: o mesmo pagador com muitos boletos em poucos dias', async () => {
    const outro = cpf(123456780);
    for (let i = 0; i < 5; i++) await pagar('300,00', { pagador_documento: outro, pagador_nome: 'Fracionador' });
    await api.post('/api/pld/monitorar', {}, tk.admin);
    assert.ok((await alertas()).some((x) => x.regra === 'fracionamento' && /Fracionador pagou 5 boletos/.test(x.descricao)));
  });

  await t.test('o próprio cliente pagando o boleto', async () => {
    await pagar('80,00', { pagador_documento: a.cliente.cnpj, pagador_nome: 'Provedor Alfa LTDA' });
    await api.post('/api/pld/monitorar', {}, tk.admin);
    assert.ok((await alertas()).some((x) => x.regra === 'pagador-e-o-cliente'));
  });

  await t.test('arquivar exige justificativa, e alerta arquivado não volta atrás', async () => {
    const alvo = (await alertas()).find((x) => x.regra === 'pagador-e-o-cliente');
    assert.equal((await api.post(`/api/pld/alertas/${alvo.id}/assumir`, {}, tk.admin)).dados.situacao, 'em_analise');
    assert.equal((await api.post(`/api/pld/alertas/${alvo.id}/arquivar`, { justificativa: 'ok' }, tk.admin)).status, 422);
    const r = await api.post(`/api/pld/alertas/${alvo.id}/arquivar`, {
      justificativa: 'Teste de cobrança feito pelo próprio provedor, valor baixo, com e-mail de confirmação arquivado.' }, tk.admin);
    assert.equal(r.dados.situacao, 'arquivado');
    assert.equal((await api.post(`/api/pld/alertas/${alvo.id}/comunicar`, { fundamentacao: 'x'.repeat(30) }, tk.admin)).status, 409);
  });

  await t.test('comunicar abre 24 horas; vencido, vira fora da norma e alerta no painel do administrador', async () => {
    const alvo = (await alertas()).find((x) => x.regra === 'valor-alto');
    const d = (await api.post(`/api/pld/alertas/${alvo.id}/comunicar`, {
      fundamentacao: 'Valor incompatível com o perfil de cobrança de internet residencial do cliente.' }, tk.admin)).dados;
    assert.equal(d.situacao, 'a_comunicar');
    const horas = (Date.parse(d.prazo_comunicacao) - Date.now()) / 3_600_000;
    assert.ok(horas > 23.9 && horas <= 24, `prazo de 24 horas (${horas.toFixed(2)})`);

    api.db.prepare('UPDATE pld_alertas SET prazo_comunicacao = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), alvo.id);
    const conf = regrasDe((await api.get('/api/conformidade', tk.admin)).dados);
    assert.equal(conf['pld-prazos'].situacao, 'fora');
    const painel = (await api.get('/api/painel', tk.admin)).dados;
    assert.ok(painel.alertas.some((x) => x.tipo === 'pld_comunicacao'));

    const reg = (await api.post(`/api/pld/alertas/${alvo.id}/comunicado`, { protocolo: 'SISCOAF-2026-000123' }, tk.admin)).dados;
    assert.equal(reg.situacao, 'comunicado');
    assert.equal(reg.coaf_protocolo, 'SISCOAF-2026-000123');
    assert.notEqual(regrasDe((await api.get('/api/conformidade', tk.admin)).dados)['pld-prazos'].situacao, 'fora');
  });

  await t.test('sigilo: só o administrador vê; a equipe e o cliente não', async () => {
    for (const perfil of ['financeiro', 'operacao', 'consulta']) {
      assert.equal((await api.get('/api/pld', tk[perfil])).status, 403, `${perfil} não vê PLD`);
      const painel = (await api.get('/api/painel', tk[perfil])).dados;
      assert.ok(!painel.alertas.some((x) => x.tipo.startsWith('pld')), `${perfil} não vê alerta de PLD no painel`);
    }
    assert.equal((await api.get('/api/pld', a.token)).status, 401, 'o token do cliente não abre o Backoffice');
    // A auditoria guarda só a situação, nunca o texto da análise.
    const log = api.db.prepare("SELECT depois FROM auditoria WHERE acao LIKE 'pld.%'").all().map((x) => x.depois).join(' ');
    assert.ok(!log.includes('incompatível'), 'a fundamentação não vai para a auditoria');
  });

  await t.test('conheça seu cliente: sem sócios e representantes, o cadastro fica pendente', async () => {
    let conf = regrasDe((await api.get('/api/conformidade', tk.admin)).dados);
    assert.equal(conf['pld-conheca-cliente'].situacao, 'fora');
    assert.equal((await api.put(`/api/pld/clientes/${a.cliente.id}`, { socios: [], representantes: [] }, tk.admin)).status, 422);
    const r = (await api.put(`/api/pld/clientes/${a.cliente.id}`, {
      socios: [{ nome: 'Maria Souza', qualificacao: 'Sócia-administradora' }],
      representantes: [{ nome: 'Maria Souza', documento: CPF, qualificacao: 'Administradora' }],
      situacao_receita: 'ATIVA',
    }, tk.admin)).dados;
    assert.equal(r.completo, true);
    conf = regrasDe((await api.get('/api/conformidade', tk.admin)).dados);
    assert.equal(conf['pld-conheca-cliente'].situacao, 'ok');
    // Revisão vencida volta a pendência.
    api.db.prepare('UPDATE clientes SET kyc_revisado_em = ? WHERE id = ?').run(`${somarDias(hoje(), -400)}T12:00:00Z`, a.cliente.id);
    const k = (await api.get('/api/pld/clientes', tk.admin)).dados.itens.find((x) => x.id === a.cliente.id);
    assert.ok(k.pendencias.includes('revisão do cadastro vencida'));
  });

  await t.test('ordem legal suspende o repasse: o valor fica retido à parte, não como dinheiro parado', async () => {
    const s = await api.post(`/api/pld/clientes/${a.cliente.id}/suspender-repasse`, { motivo: 'Ordem judicial', documento: 'Processo 0001234-56.2026' }, tk.admin);
    assert.equal(s.status, 200);
    const antes = api.db.prepare('SELECT COUNT(*) AS n FROM repasses WHERE cliente_id = ?').get(a.cliente.id).n;
    await pagar('150,00');
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM repasses WHERE cliente_id = ?').get(a.cliente.id).n, antes, 'não repassou');
    // No dia seguinte o valor ainda está aqui — retido, não parado.
    api.db.prepare('UPDATE lancamentos SET data_liberacao = ? WHERE cliente_id = ? AND data_liberacao = ? AND repasse_id IS NULL')
      .run(somarDias(hoje(), -1), a.cliente.id, hoje());
    assert.equal(repassesLib.parados(api.db).length, 0);
    assert.equal(repassesLib.retidosPorOrdem(api.db).length, 1);
    const conf = regrasDe((await api.get('/api/conformidade', tk.admin)).dados);
    assert.equal(conf['repasse-imediato'].situacao, 'ok');
    assert.match(conf['repasse-imediato'].detalhe, /Retido por ordem legal/);

    await api.post(`/api/pld/clientes/${a.cliente.id}/liberar-repasse`, { motivo: 'Ordem revogada' }, tk.admin);
    const rodada = (await api.post('/api/repasses/rotina', {}, tk.financeiro)).dados;
    assert.ok(rodada.enviados >= 1, 'liberado, o valor sai na rodada');
    assert.equal(repassesLib.retidosPorOrdem(api.db).length, 0);
  });

  await t.test('declaração de não ocorrência: só para ano sem comunicação', async () => {
    const ano = Number(hoje().slice(0, 4));
    assert.equal((await api.post('/api/pld/declaracoes', { ano, protocolo: 'X-1' }, tk.admin)).status, 409, 'houve comunicação neste ano');
    const r = await api.post('/api/pld/declaracoes', { ano: ano - 1, protocolo: 'SISCOAF-NO-2025', enviado_em: `${ano}-01-20` }, tk.admin);
    assert.equal(r.status, 201);
    assert.equal(r.dados.ano, ano - 1);
  });

  await t.test('parâmetros: a política define os limites', async () => {
    const r = await api.put('/api/pld/parametros', { valor_alto_centavos: '25.000,00', fracionamento_qtd: '8' }, tk.admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.valor_alto_centavos, 2_500_000);
    assert.equal(r.dados.fracionamento_qtd, 8);
    assert.equal((await api.put('/api/pld/parametros', { fracionamento_qtd: '0' }, tk.admin)).status, 422);
  });
});
