'use strict';

process.env.PAYAX_URL_PUBLICA = 'https://pagamentos.teste.local';
process.env.PAYAX_EMAIL_TESTE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { criarIxcFalso } = require('./ixc-falso');
const entrega = require('../server/lib/entrega');
const email = require('../server/lib/email');

const titulo = (id, extra = {}) => ({ id: String(id), id_cliente: '9001', id_contrato: '501', filial_id: '1', id_conta: '33', documento: `NF-${id}`, valor: '80,00', valor_aberto: '80.00',
  data_emissao: '2026-11-18', data_vencimento: '2026-12-15', status: 'A', liberado: 'S', id_carteira_cobranca: '12', tipo_recebimento: 'Gateway', previsao: 'M',
  nn_boleto: '', gateway_link: '', obs: 'observação da fatura', ...extra });

async function preparar(t, titulos, cfgExtra = {}) {
  const ixc = criarIxcFalso({ titulos });
  const url = await ixc.iniciar();
  const api = await iniciar();
  t.after(async () => { await api.fechar(); await ixc.fechar(); });
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  const cfg = { url, token: '7:hash-de-teste', tipo_padrao: 'bolepix', carteiras: '12', ...cfgExtra };
  const r = await api.put(`/api/integracoes/ixc/${a.cliente.id}`, cfg, tk.admin);
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const importar = () => api.post(`/api/integracoes/ixc/${a.cliente.id}/importar`, { de: '2026-12-01', ate: '2026-12-31' }, tk.operacao);
  return { ixc, api, tk, a, cfg, importar };
}

test('entrega: link no título, PDF nos arquivos do cliente e e-mail com o PDF anexado', async (t) => {
  const email_ = { email_ativo: '1', email_host: 'smtp.provedor.test', email_porta: '587', email_remetente: 'financeiro@provedor.test', email_senha: 'senha-do-email' };
  const { ixc, api, tk, a, importar } = await preparar(t, [titulo(101)], { gravar_link: '1', anexar_pdf: 'cliente', ...email_ });

  await t.test('a senha do e-mail não volta para a tela e não fica na configuração', async () => {
    const i = api.db.prepare("SELECT config FROM integracoes WHERE escopo = 'ixc' AND cliente_id = ?").get(a.cliente.id);
    assert.ok(!i.config.includes('senha-do-email'));
    assert.equal(JSON.parse(i.config).email.remetente, 'financeiro@provedor.test');
  });

  await t.test('ao importar, o título ganha o nosso número e o link do PDF, sem perder os outros campos', async () => {
    const r = await importar();
    assert.equal(r.dados.criados, 1, JSON.stringify(r.dados));
    const tit = ixc.titulos[0];
    assert.match(tit.nn_boleto, /^\d{11}-[0-9P]$/);
    assert.match(tit.gateway_link, /^https:\/\/pagamentos\.teste\.local\/api\/publico\/boleto\/\d+\/[\w-]{32}\.pdf$/);
    assert.equal(tit.liberado, 'S', 'a fatura continua visível');
    assert.equal(tit.obs, 'observação da fatura');
    assert.equal(tit.data_vencimento, '2026-12-15', 'a data foi e voltou no formato certo');
    assert.equal(tit.valor, '80,00');
    const altera = ixc.chamadas.find((c) => c.recurso === 'fn_areceber_altera');
    assert.equal(altera.dados.liberado, 'S');
    assert.equal(altera.dados.data_vencimento, '15/12/2026', 'a escrita manda a data como o IXC exige');
  });

  await t.test('o PDF foi anexado nos arquivos do cliente e o link do título abre o PDF', async () => {
    assert.equal(ixc.arquivos.length, 1);
    const arq = ixc.arquivos[0];
    assert.equal(arq.recurso, 'cliente_arquivos');
    assert.equal(arq.id_cliente, '9001');
    assert.match(arq.descricao, /^Boleto PAY AX - venc\. 15\/12\/2026 - R\$ 80,00/);
    assert.equal(arq.local_arquivo.inicio, '%PDF-');
    assert.match(arq.local_arquivo.nome, /\.pdf$/);
    const caminho = new URL(ixc.titulos[0].gateway_link).pathname;
    const pdf = await api.get(caminho);
    assert.equal(pdf.status, 200);
    assert.equal(String(pdf.dados).slice(0, 5), '%PDF-');
  });

  await t.test('o e-mail saiu em nome do cliente, com o PDF anexado e sem link', async () => {
    assert.equal(email.caixaDeTeste.length, 1);
    const m = email.caixaDeTeste[0];
    assert.equal(m.para, 'joao@teste.local');
    assert.match(m.assunto, /Alfa Net: boleto de R\$ 80,00 com vencimento em 15\/12\/2026/);
    assert.match(m.anexo, /\.pdf$/);
    assert.ok(m.bytes > 3000);
    assert.ok(!/https?:\/\//.test(m.texto), 'sem link no texto');
    assert.match(m.texto, /Linha digitável:\n\d{5}\.\d{5} /);
    const bruto = JSON.parse(m.bruto);
    assert.equal(bruto.from.address, 'financeiro@provedor.test');
    assert.equal(bruto.from.name, 'Alfa Net');
    const reg = api.db.prepare('SELECT * FROM emails_enviados').all();
    assert.equal(reg.length, 1);
    assert.equal(reg[0].situacao, 'enviado');
  });

  await t.test('a rotina não repete o que já foi entregue; o botão da tela refaz', async () => {
    const r = await entrega.entregarPendentes(api.db);
    assert.equal(r.tentados, 0);
    const b = api.db.prepare("SELECT * FROM boletos WHERE origem = 'ixc'").get();
    assert.ok(b.ixc_link_em && b.ixc_pdf_em && b.email_enviado_em);
    const de_novo = await api.post(`/api/boletos/${b.id}/entrega`, {}, tk.operacao);
    assert.equal(de_novo.status, 200);
    assert.deepEqual(de_novo.dados.passos.map((p) => [p.passo, p.ok]), [['link', true], ['pdf', true], ['email', true]]);
    assert.equal(ixc.arquivos.length, 2);
  });

  await t.test('PDF e e-mail só saem com o boleto confirmado pelo banco; o link sai já na emissão', async () => {
    ixc.titulos.push(titulo(102));
    assert.equal((await importar()).dados.criados, 1);
    const b = api.db.prepare("SELECT * FROM boletos WHERE ixc_receber_id = '102'").get();
    api.db.prepare("UPDATE boletos SET situacao = 'registrando', ixc_link_em = NULL, ixc_pdf_em = NULL, email_enviado_em = NULL WHERE id = ?").run(b.id);
    const antes = { arquivos: ixc.arquivos.length, emails: email.caixaDeTeste.length };
    const r = await entrega.entregarBoleto(api.db, b.id);
    assert.deepEqual(r.passos.map((p) => p.passo), ['link']);
    assert.equal(ixc.arquivos.length, antes.arquivos);
    assert.equal(email.caixaDeTeste.length, antes.emails);
    // O banco confirmou: a rotina entrega o que faltava.
    api.db.prepare("UPDATE boletos SET situacao = 'registrado' WHERE id = ?").run(b.id);
    const rotina = await entrega.entregarPendentes(api.db);
    assert.equal(rotina.ok, 1);
    assert.equal(ixc.arquivos.length, antes.arquivos + 1);
    assert.equal(email.caixaDeTeste.length, antes.emails + 1);
  });

  await t.test('trava de segurança: se gravar o link mexer em outro campo do título, a gravação de link é desligada', async () => {
    ixc.titulos.push(titulo(103));
    ixc.opcoes.edicaoEstragaValor = true;
    const r = await importar();
    ixc.opcoes.edicaoEstragaValor = false;
    assert.equal(r.dados.criados, 1);
    assert.ok(r.dados.detalhes.some((d) => /entrega falhou \(link\)/.test(d.aviso ?? '')), JSON.stringify(r.dados.detalhes));
    const c = JSON.parse(api.db.prepare("SELECT config FROM integracoes WHERE escopo = 'ixc' AND cliente_id = ?").get(a.cliente.id).config);
    assert.equal(c.gravar_link, false);
    assert.match(c.entrega_alerta, /mudou outros campos do título 103 \(valor/);
  });
});

test('entrega: o que só vale para o boleto montado pela PAY AX, e a partir de quando é ligado', async (t) => {
  const { ixc, api, tk, a, cfg, importar } = await preparar(t, [titulo(201)]);

  await t.test('boleto emitido antes de ligar a entrega não é entregue depois (não dispara para a carteira antiga)', async () => {
    assert.equal((await importar()).dados.criados, 1);
    api.db.prepare("UPDATE boletos SET criado_em = '2026-01-01T00:00:00.000Z'").run();
    assert.equal((await api.put(`/api/integracoes/ixc/${a.cliente.id}`, { ...cfg, token: '', anexar_pdf: 'cliente' }, tk.admin)).status, 200);
    const r = await entrega.entregarPendentes(api.db);
    assert.equal(r.tentados, 0);
    assert.equal(ixc.arquivos.length, 0);
  });

  await t.test('com o sistema do cliente montando o boleto, link, PDF e e-mail são recusados', async () => {
    const r = await api.put(`/api/integracoes/ixc/${a.cliente.id}`, { ...cfg, token: '', numeracao: 'ixc', faixa_inicio: '50000000000', faixa_fim: '50100000000', gravar_link: '1' }, tk.admin);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /Quem monta e envia o boleto/);
  });

  await t.test('ligar o e-mail sem senha é recusado', async () => {
    const r = await api.put(`/api/integracoes/ixc/${a.cliente.id}`, { ...cfg, token: '', email_ativo: '1', email_host: 'smtp.provedor.test', email_remetente: 'fin@provedor.test' }, tk.admin);
    assert.equal(r.status, 422);
  });
});

test('baixa no IXC pela rota oficial: pagou com juros vira acréscimo; baixa sem efeito é erro', async (t) => {
  const { ixc, api, tk, importar } = await preparar(t, [titulo(301), titulo(302)], { baixa_conta: '88', baixa_planejamento: '44' });
  assert.equal((await importar()).dados.criados, 2);
  const boletos = api.db.prepare("SELECT * FROM boletos WHERE origem = 'ixc' ORDER BY id").all();

  await t.test('pagamento com multa e juros: acréscimo, conta e planejamento configurados', async () => {
    await api.post(`/api/boletos/${boletos[0].id}/liquidar`, { pago_em: '2026-12-20', valor_pago: '81,73' }, tk.financeiro);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ixc.baixas.length, 1);
    const b = ixc.baixas[0];
    assert.equal(b.conta_, '88');
    assert.equal(b.id_conta, '44');
    assert.equal(b.valor_parcela, '80,00');
    assert.equal(b.vacrescimo, '1,73');
    assert.equal(b.credito, '81,73');
    assert.equal(b.data, '20/12/2026');
    assert.equal(b.filial_id, '1');
  });

  await t.test('o IXC respondeu "sucesso" mas o título continua aberto: fica como falha e a rotina tenta de novo', async () => {
    ixc.opcoes.baixaSemEfeito = true;
    await api.post(`/api/boletos/${boletos[1].id}/liquidar`, { pago_em: '2026-12-15', valor_pago: '80,00' }, tk.financeiro);
    await new Promise((r) => setTimeout(r, 300));
    const s = api.db.prepare("SELECT * FROM sincronismos WHERE tipo = 'baixa' ORDER BY id DESC LIMIT 1").get();
    assert.equal(s.erros, 1);
    assert.match(s.detalhe, /continua em aberto/);
    ixc.opcoes.baixaSemEfeito = false;
    const sincronismo = require('../server/lib/sincronismo');
    const r = await sincronismo.reprocessarBaixas(api.db);
    assert.equal(r.ok, 1);
    assert.equal(ixc.titulos[1].status, 'R');
  });
});

test('acompanhamento: fatura cancelada, paga por fora ou alterada no IXC', async (t) => {
  const { ixc, api, a, importar } = await preparar(t, [titulo(401), titulo(402), titulo(403), titulo(404), titulo(405)], { gravar_link: '1' });
  assert.equal((await importar()).dados.criados, 5);
  const doTitulo = (id) => api.db.prepare('SELECT * FROM boletos WHERE ixc_receber_id = ? ORDER BY id').all(String(id));

  ixc.titulos.find((x) => x.id === '401').status = 'C';                       // cancelada
  ixc.titulos.find((x) => x.id === '402').status = 'R';                       // recebida por outro meio
  Object.assign(ixc.titulos.find((x) => x.id === '403'), { valor: '95,50', valor_aberto: '95.50', data_vencimento: '2026-12-28' }); // alterada
  ixc.titulos.splice(ixc.titulos.findIndex((x) => x.id === '404'), 1);       // o IXC não devolve (falha de consulta)
  const linkAntigo = ixc.titulos.find((x) => x.id === '403').gateway_link;

  const r = await entrega.acompanhar(api.db);

  await t.test('cancelada e recebida por outro meio: o boleto é baixado', async () => {
    assert.equal(doTitulo(401)[0].situacao, 'baixado');
    assert.match(doTitulo(401)[0].motivo_baixa, /cancelada/);
    assert.equal(doTitulo(402)[0].situacao, 'baixado');
    assert.match(doTitulo(402)[0].motivo_baixa, /outro meio/);
  });

  await t.test('alterada: o antigo é baixado e marcado como substituído, e sai um novo com o valor e a data novos', async () => {
    const [antigo, novo] = doTitulo(403);
    assert.equal(antigo.situacao, 'baixado');
    assert.ok(antigo.substituido_em);
    assert.equal(novo.valor_centavos, 9550);
    assert.equal(novo.vencimento, '2026-12-28');
    assert.equal(novo.situacao, 'registrado');
    assert.equal(r.reemitidos, 1);
    const tit = ixc.titulos.find((x) => x.id === '403');
    assert.notEqual(tit.gateway_link, linkAntigo, 'o título aponta para o boleto novo');
    assert.equal(tit.nn_boleto, `${novo.nosso_numero}-${novo.nosso_numero_dv}`);
    // O link antigo não leva a pagamento: responde o aviso, sem código de barras.
    const velho = await api.get(new URL(linkAntigo).pathname);
    assert.equal(velho.status, 200);
    assert.ok(String(velho.dados).length < 6000);
  });

  await t.test('fatura que o IXC não devolveu não baixa nada (só avisa); a que não mudou fica como está', async () => {
    assert.equal(doTitulo(404)[0].situacao, 'registrado');
    assert.ok(r.avisos.some((x) => /não devolveu a fatura 404/.test(x.aviso ?? '')));
    assert.equal(doTitulo(405).length, 1);
    assert.equal(doTitulo(405)[0].situacao, 'registrado');
    assert.equal(r.baixados, 3);
  });

  await t.test('rodar de novo não mexe em mais nada', async () => {
    const de_novo = await entrega.acompanhar(api.db);
    assert.equal(de_novo.baixados, 0);
    assert.equal(de_novo.reemitidos, 0);
    assert.equal(api.db.prepare("SELECT COUNT(*) n FROM boletos WHERE cliente_id = ?").get(a.cliente.id).n, 6);
  });
});

test('diagnóstico do sistema do cliente num título de teste', async (t) => {
  const { ixc, api, tk, a, importar } = await preparar(t, [titulo(501)]);

  await t.test('só leitura: mostra o título e a carteira, sem gravar nada', async () => {
    const antes = ixc.chamadas.filter((c) => c.metodo !== 'GET' && !c.listar).length;
    const r = await api.post(`/api/integracoes/ixc/${a.cliente.id}/diagnostico`, { titulo_id: '501' }, tk.admin);
    assert.equal(r.status, 200);
    assert.deepEqual(r.dados.passos.map((p) => [p.passo, p.ok]), [['Ler o título', true], ['Ler a carteira de cobrança', true], ['Boleto PAY AX deste título', false]]);
    assert.equal(r.dados.passos[0].dados.id_carteira_cobranca, '12');
    assert.equal(ixc.chamadas.filter((c) => c.metodo !== 'GET' && !c.listar).length, antes);
  });

  await t.test('com o boleto emitido: grava número e link, anexa no cliente; anexo na fatura mostra o erro do IXC', async () => {
    assert.equal((await importar()).dados.criados, 1);
    const r = await api.post(`/api/integracoes/ixc/${a.cliente.id}/diagnostico`,
      { titulo_id: '501', gravar_nosso_numero: '1', gravar_link: '1', anexar_cliente: '1', anexar_titulo: '1' }, tk.admin);
    const por = Object.fromEntries(r.dados.passos.map((p) => [p.passo, p]));
    assert.equal(por['Gravar o nosso número (Alterar boleto)'].ok, true);
    assert.equal(por['Gravar o link no campo "Link gateway" (edição completa)'].ok, true);
    assert.equal(por['Anexar o PDF nos arquivos do cliente'].ok, true);
    assert.equal(por['Anexar o PDF nos arquivos da fatura'].ok, false);
    assert.match(por['Anexar o PDF nos arquivos da fatura'].detalhe, /Recurso não encontrado/);
    assert.match(ixc.titulos[0].gateway_link, /\.pdf$/);
  });

  await t.test('título que não existe e operador sem permissão', async () => {
    const r = await api.post(`/api/integracoes/ixc/${a.cliente.id}/diagnostico`, { titulo_id: '999' }, tk.admin);
    assert.equal(r.dados.passos[0].ok, false);
    assert.equal((await api.post(`/api/integracoes/ixc/${a.cliente.id}/diagnostico`, { titulo_id: '501' }, tk.consulta)).status, 403);
  });
});
