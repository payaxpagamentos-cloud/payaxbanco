'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

test('boleto em PDF: arquivo de verdade, pelo painel, pela Área do Cliente e pelo link do pagador', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  const b = (await api.post('/api/boletos', { cliente_id: a.cliente.id, tipo: 'bolepix', valor: '80,00', vencimento: '2026-12-10',
    pagador_nome: 'Maria Assinante', pagador_documento: '52998224725', pagador_cep: '01001000', pagador_endereco: 'Praça da Sé', pagador_numero: '1',
    pagador_bairro: 'Sé', pagador_cidade: 'São Paulo', pagador_uf: 'SP' }, tk.operacao)).dados;

  const ehPdf = (r) => {
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get('content-type')), /application\/pdf/);
    assert.equal(String(r.dados).slice(0, 5), '%PDF-');
    return String(r.dados);
  };

  await t.test('painel e Área do Cliente devolvem o PDF', async () => {
    ehPdf(await api.get(`/api/boletos/${b.id}/pdf`, tk.admin));
    ehPdf(await api.get(`/cliente/api/boletos/${b.id}/pdf`, a.token));
  });

  await t.test('o link do pagador com .pdf abre o arquivo; sem, a página com o botão "Baixar PDF"', async () => {
    const l = (await api.get(`/api/boletos/${b.id}/link`, tk.admin)).dados;
    assert.match(l.caminho_pdf, /\.pdf$/);
    ehPdf(await api.get(l.caminho_pdf));
    const pagina = await api.get(l.caminho);
    assert.match(String(pagina.dados), /Baixar PDF/);
    assert.equal((await api.get(l.caminho_pdf.replace(/.{6}\.pdf$/, 'aaaaaa.pdf'))).status, 403, 'assinatura errada não abre');
  });

  await t.test('boleto cancelado: o link do PDF responde com o aviso, sem código de barras', async () => {
    const l = (await api.get(`/api/boletos/${b.id}/link`, tk.admin)).dados;
    const antes = ehPdf(await api.get(l.caminho_pdf));
    api.db.prepare("UPDATE boletos SET situacao = 'cancelado' WHERE id = ?").run(b.id);
    const depois = ehPdf(await api.get(l.caminho_pdf));
    assert.ok(depois.length < antes.length / 2, 'sem QR Code nem código de barras, o arquivo fica bem menor');
    assert.equal((await api.get(l.caminho)).status, 410);
  });
});
