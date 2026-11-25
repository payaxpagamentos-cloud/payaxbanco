'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, limparArquivos, servidorDeEmail } = require('./helpers');
const mime = require('../server/lib/mime');
const { caixaTeste } = require('../server/lib/email');

/**
 * A caixa de entrada do CRM e o servidor de e-mail da própria plataforma.
 *
 * O que estes testes garantem é o que mais importa no dia a dia: a mensagem do cliente chega inteira
 * (com acento, com anexo), cai grudada no lead certo, a resposta sai amarrada à mesma conversa — e o
 * servidor não vira trampolim de spam para o mundo.
 */

const mensagemCrua = ({ de = 'Cliente <cliente@empresa.com.br>', para = 'comercial@vaimidia.com.br', assunto = 'Teste', corpo = 'Olá', id = 'abc@empresa.com.br', extras = [] } = {}) => [
  `From: ${de}`,
  `To: ${para}`,
  `Subject: ${assunto}`,
  `Message-ID: <${id}>`,
  'Date: Fri, 21 Nov 2025 10:00:00 -0300',
  'MIME-Version: 1.0',
  ...extras,
  'Content-Type: text/plain; charset=utf-8',
  '',
  corpo,
].join('\r\n');

test('Leitura do e-mail cru: acento, assunto codificado, HTML e anexo', async (t) => {
  await t.test('assunto codificado e corpo em quoted-printable chegam legíveis', () => {
    const bruto = [
      'From: =?UTF-8?Q?Jo=C3=A3o_da_Silva?= <joao@empresa.com.br>',
      'To: comercial@vaimidia.com.br',
      'Subject: =?UTF-8?B?UHJvcG9zdGEgcGFyYSBvIGNvbmRvbcOtbmlv?=',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Bom dia! Quero an=C3=BAncio no elevador do pr=C3=A9dio.',
    ].join('\r\n');
    const lida = mime.ler(Buffer.from(bruto));
    assert.equal(lida.de, 'joao@empresa.com.br');
    assert.equal(lida.de_nome, 'João da Silva');
    assert.equal(lida.assunto, 'Proposta para o condomínio');
    assert.match(lida.texto, /anúncio no elevador do prédio/);
  });

  await t.test('mensagem com texto, HTML e anexo: o anexo é separado do corpo', () => {
    const bruto = [
      'From: agencia@exemplo.com',
      'To: comercial@vaimidia.com.br',
      'Subject: Com anexo',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="LIMITE"',
      '',
      '--LIMITE',
      'Content-Type: multipart/alternative; boundary="DENTRO"',
      '',
      '--DENTRO',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Segue o briefing em anexo.',
      '--DENTRO',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Segue o <b>briefing</b> em anexo.</p>',
      '--DENTRO--',
      '--LIMITE',
      'Content-Type: text/csv; name="briefing.csv"',
      'Content-Disposition: attachment; filename="briefing.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('ponto;telas\nShopping;4\n').toString('base64'),
      '--LIMITE--',
    ].join('\r\n');
    const lida = mime.ler(Buffer.from(bruto));
    assert.match(lida.texto, /Segue o briefing em anexo\./);
    assert.ok(!/<b>/.test(lida.texto), 'o painel mostra texto, não HTML de fora');
    assert.equal(lida.anexos.length, 1);
    assert.equal(lida.anexos[0].nome, 'briefing.csv');
    assert.match(lida.anexos[0].conteudo.toString(), /Shopping;4/);
  });

  await t.test('acento escrito direto no cabeçalho (sem codificar) também chega certo', () => {
    // Metade dos programas de e-mail manda os bytes crus; sistema que não trata isso mostra "mÃ­dia".
    const bruto = Buffer.from([
      'From: Agência Meta <contato@agenciameta.com.br>',
      'To: comercial@vaimidia.com.br',
      'Subject: Recebi o mídia kit',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Vamos fechar?',
    ].join('\r\n'), 'utf8');
    const lida = mime.ler(bruto);
    assert.equal(lida.de_nome, 'Agência Meta');
    assert.equal(lida.assunto, 'Recebi o mídia kit');
  });

  await t.test('só com HTML, o texto sai do HTML mesmo assim', () => {
    const bruto = [
      'From: so-html@exemplo.com', 'To: comercial@vaimidia.com.br', 'Subject: Oi',
      'Content-Type: text/html; charset=utf-8', '',
      '<html><head><style>p{color:red}</style></head><body><p>Primeira linha</p><p>Segunda&nbsp;linha</p>'
      + '<script>alert(1)</script></body></html>',
    ].join('\r\n');
    const lida = mime.ler(Buffer.from(bruto));
    assert.equal(lida.texto, 'Primeira linha\nSegunda linha');
    assert.ok(!/alert/.test(lida.texto), 'script de fora não vira texto da mensagem');
  });
});

test('Servidor de e-mail da plataforma: recebe, liga ao lead e não vira trampolim de spam', async (t) => {
  const api = await iniciar();
  const correio = await servidorDeEmail(api.db);
  t.after(async () => { await correio.fechar(); api.fechar(); limparArquivos(); });
  const master = await api.login();

  let leadId;
  await t.test('um lead do funil, com o e-mail de quem vai escrever', async () => {
    const r = await api.post('/painel/crm/leads', {
      nome: 'Pizzaria Forno de Pedra', tipo: 'anunciante', email: 'dono@fornodepedra.com.br', origem: 'indicacao',
    }, master);
    assert.equal(r.status, 201);
    leadId = r.dados.id;
  });

  await t.test('a mensagem do cliente entra na caixa, ligada ao lead', async () => {
    const respostas = await correio.entregar({
      de: 'dono@fornodepedra.com.br',
      para: 'comercial@vaimidia.com.br',
      mensagem: mensagemCrua({
        de: 'Dono <dono@fornodepedra.com.br>',
        assunto: '=?UTF-8?B?UXVhbnRvIGZpY2EgbyBwcsOpZGlvPw==?=',
        corpo: 'Quero anunciar nos elevadores. Quanto fica?',
        id: 'primeira@fornodepedra.com.br',
      }),
    });
    assert.match(respostas[0], /^220 /, 'o servidor se apresenta');
    assert.ok(respostas.some((l) => /^250 2\.0\.0 Recebido/.test(l)), `esperava confirmação de recebimento: ${respostas.join(' | ')}`);

    const caixa = (await api.get('/painel/crm/emails', master)).dados;
    assert.equal(caixa.itens.length, 1);
    const e = caixa.itens[0];
    assert.equal(e.de, 'dono@fornodepedra.com.br');
    assert.equal(e.assunto, 'Quanto fica o prédio?', 'o assunto codificado chega legível');
    assert.equal(e.lead_id, leadId, 'a mensagem cai grudada no lead de quem escreveu');
    assert.equal(e.lido_em, null);
    assert.equal(caixa.totais.nao_lidos, 1);
    assert.equal(caixa.totais.sem_resposta, 1, 'alguém está esperando resposta');

    // E entra no histórico do lead, junto com ligações e visitas.
    const ficha = (await api.get(`/painel/crm/leads/${leadId}`, master)).dados;
    assert.equal(ficha.emails.length, 1);
    assert.match(ficha.interacoes[0].texto, /Recebido: Quanto fica o prédio\?/);
  });

  await t.test('abrir a mensagem marca como lida e mostra a conversa', async () => {
    const id = (await api.get('/painel/crm/emails', master)).dados.itens[0].id;
    const e = (await api.get(`/painel/crm/emails/${id}`, master)).dados;
    assert.ok(e.lido_em, 'abrir é ler');
    assert.match(e.texto, /Quero anunciar nos elevadores/);
    assert.equal((await api.get('/painel/crm/emails', master)).dados.totais.nao_lidos, 0);
  });

  await t.test('a resposta sai amarrada à mesma conversa e fica guardada', async () => {
    caixaTeste.length = 0;
    const entrada = (await api.get('/painel/crm/emails', master)).dados.itens[0];
    const r = await api.post('/painel/crm/emails', {
      para: 'dono@fornodepedra.com.br',
      texto: 'Oi! O prédio sai por R$ 480 o mês, com 8 inserções por hora.',
      responder_a: entrada.id,
    }, master);
    assert.equal(r.status, 201);
    assert.equal(r.dados.assunto, 'Re: Quanto fica o prédio?', 'a resposta herda o assunto');
    assert.equal(r.dados.thread, entrada.thread, 'pergunta e resposta ficam na mesma conversa');
    assert.equal(r.dados.lead_id, leadId);

    assert.equal(caixaTeste.length, 1, 'a mensagem saiu de verdade pelo servidor de envio');
    const enviada = JSON.parse(caixaTeste[0].info.message);
    assert.equal(enviada.inReplyTo, '<primeira@fornodepedra.com.br>', 'quem recebe vê a resposta embaixo da pergunta');

    const ficha = (await api.get(`/painel/crm/leads/${leadId}`, master)).dados;
    assert.ok(ficha.interacoes.some((i) => /^Respondido:/.test(i.texto)), 'a resposta entra no histórico do lead');
    assert.equal((await api.get('/painel/crm/emails?caixa=enviados', master)).dados.itens.length, 1);
    assert.equal((await api.get('/painel/crm/emails', master)).dados.totais.sem_resposta, 0, 'ninguém mais esperando');
  });

  await t.test('não entregamos para fora: o endereço não vira relay aberto', async () => {
    const respostas = await correio.entregar({
      de: 'spammer@ruim.example',
      para: 'vitima@gmail.com',
      mensagem: mensagemCrua({ de: 'spam@ruim.example', para: 'vitima@gmail.com' }),
    });
    assert.ok(respostas.some((l) => /^550 /.test(l)), `esperava recusa 550: ${respostas.join(' | ')}`);
    assert.ok(!respostas.some((l) => /Recebido/.test(l)), 'nada foi aceito');
  });

  await t.test('DATA sem destinatário aceito é recusado', async () => {
    const respostas = await correio.entregar({
      comandos: ['EHLO teste.exemplo.com', 'MAIL FROM:<alguem@exemplo.com>', 'DATA', 'QUIT'],
    });
    assert.ok(respostas.some((l) => /^503 /.test(l)), `esperava 503: ${respostas.join(' | ')}`);
  });

  await t.test('mensagem de desconhecido fica sem vínculo e pode virar lead', async () => {
    await correio.entregar({
      de: 'novo@academiaforte.com.br',
      para: 'comercial@vaimidia.com.br',
      mensagem: mensagemCrua({
        de: 'Academia Forte <novo@academiaforte.com.br>',
        assunto: 'Tela na academia',
        corpo: 'Tenho uma academia e queria uma tela aqui.',
        id: 'academia-1@academiaforte.com.br',
      }),
    });
    const caixa = (await api.get('/painel/crm/emails', master)).dados;
    const nova = caixa.itens.find((e) => e.de === 'novo@academiaforte.com.br');
    assert.ok(nova, 'a mensagem chegou');
    assert.equal(nova.lead_id, null, 'caixa de e-mail não cria lead sozinha');
    assert.equal(caixa.totais.sem_vinculo, 1);

    const r = await api.post(`/painel/crm/emails/${nova.id}/virar-lead`, { tipo: 'ponto' }, master);
    assert.equal(r.status, 201);
    const ficha = (await api.get(`/painel/crm/leads/${r.dados.lead_id}`, master)).dados;
    assert.equal(ficha.tipo, 'ponto');
    assert.equal(ficha.email, 'novo@academiaforte.com.br');
    assert.equal(ficha.emails.length, 1, 'a conversa vai junto para a ficha do lead novo');
  });

  await t.test('o anexo e a mensagem original ficam guardados e saem pelo painel', async () => {
    await correio.entregar({
      de: 'agencia@exemplo.com',
      para: 'comercial@vaimidia.com.br',
      mensagem: [
        'From: Agência <agencia@exemplo.com>',
        'To: comercial@vaimidia.com.br',
        'Subject: PI assinado',
        'Message-ID: <pi-1@exemplo.com>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="X"',
        '',
        '--X',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Segue o PI assinado.',
        '--X',
        'Content-Type: text/csv; name="pi.csv"',
        'Content-Disposition: attachment; filename="pi.csv"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('campanha;valor\nVerao;480000\n').toString('base64'),
        '--X--',
      ].join('\r\n'),
    });
    const e = (await api.get('/painel/crm/emails', master)).dados.itens.find((x) => x.assunto === 'PI assinado');
    assert.equal(e.anexos, 1);
    const detalhe = (await api.get(`/painel/crm/emails/${e.id}`, master)).dados;
    assert.equal(detalhe.anexos[0].nome, 'pi.csv');

    const anexo = await fetch(`${api.base}/painel/crm/emails/${e.id}/anexo/0`, { headers: { Authorization: `Bearer ${master}` } });
    assert.equal(anexo.status, 200);
    assert.match(await anexo.text(), /Verao;480000/);

    const original = await fetch(`${api.base}/painel/crm/emails/${e.id}/original`, { headers: { Authorization: `Bearer ${master}` } });
    assert.equal(original.status, 200);
    assert.match(original.headers.get('content-type'), /message\/rfc822/);
    assert.match(await original.text(), /Message-ID: <pi-1@exemplo\.com>/);
  });

  await t.test('arquivar tira da caixa sem apagar nada', async () => {
    const e = (await api.get('/painel/crm/emails', master)).dados.itens[0];
    await api.post(`/painel/crm/emails/${e.id}/arquivar`, {}, master);
    const caixa = (await api.get('/painel/crm/emails', master)).dados;
    assert.ok(!caixa.itens.some((x) => x.id === e.id), 'saiu da caixa de entrada');
    assert.ok((await api.get('/painel/crm/emails?caixa=arquivados', master)).dados.itens.some((x) => x.id === e.id));
  });

  await t.test('o portal do anunciante não enxerga a caixa da equipe', async () => {
    const r = await api.get('/painel/crm/emails');
    assert.equal(r.status, 401, 'sem sessão, nada');
  });
});
