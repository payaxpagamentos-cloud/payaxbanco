'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { iniciar } = require('./helpers');
const { criarCertificado, temOpenssl } = require('./certificado-falso');
const sefazFalsa = require('./sefaz-falsa');
const { dataLocal } = require('../server/lib/datas');
const sefaz = require('../server/lib/fiscal/sefaz');
const transmissao = require('../server/lib/fiscal/transmissao');

const HOJE = dataLocal('America/Sao_Paulo');
const COMP = HOJE.slice(0, 7);

/*
 * Transmissão à SEFAZ.
 *
 * A SEFAZ de verdade exige TLS mútua, cadeia ICP-Brasil e CNPJ credenciado — nada disso existe numa
 * máquina de teste, e nada disso é código deste sistema. O que é nosso, e o que estes testes provam:
 * o envelope sai no formato certo, a nota vai compactada, o retorno é lido, a falha vira mensagem que
 * ensina, e a situação da nota muda SÓ pelo que a SEFAZ respondeu.
 */

/** Organização pronta para emitir, apontando para a SEFAZ de mentira. */
async function cenario(api, falsa) {
  const admin = await api.login();
  await api.patch('/organizacao', {
    documento: '11.222.333/0001-81', inscricao_estadual: '9012345678', nome_fantasia: 'Provedor Teste',
    cep: '80010000', logradouro: 'Rua das Fibras', numero_endereco: '100', bairro: 'Centro',
    cidade: 'CURITIBA', uf: 'PR', codigo_municipio: '4106902', telefone: '4133334444', email: 'fiscal@provedor.test',
  }, admin);
  const c = criarCertificado({ nome: 'PROVEDOR TESTE LTDA', cnpj: '11222333000181' });
  await api.post('/certificado', { apelido: 'e-CNPJ', arquivo: c.base64, senha: c.senha }, admin);
  const r = await api.put('/fiscal/config', {
    resp_tec_cnpj: '11222333000181', resp_tec_contato: 'Equipe de TI',
    resp_tec_email: 'ti@provedor.test', resp_tec_fone: '4133334444',
    urls: {
      recepcao: falsa.url('NFComRecepcao'), consulta: falsa.url('NFComConsulta'),
      evento: falsa.url('NFComRecepcaoEvento'), status: falsa.url('NFComStatusServico'),
    },
  }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  await api.post('/fiscal/regras/padrao', {}, admin);

  const plano = (await api.post('/planos', { nome: 'Fibra 300', tipo: 'internet', tecnologia: 'fibra', download_mbps: 300, upload_mbps: 150, mensalidade: '99,90' }, admin)).dados;
  const assinante = (await api.post('/assinantes', {
    tipo: 'pf', nome: 'Ana Fiscal', documento: '390.533.447-05', telefone: '41999990000',
    cep: '80020000', logradouro: 'Rua do Assinante', numero: '50', bairro: 'Batel',
    cidade: 'CURITIBA', uf: 'PR', codigo_municipio: '4106902',
  }, admin)).dados;
  const contrato = (await api.post('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 10 }, admin)).dados;
  await api.post(`/contratos/${contrato.id}/ativar`, { data: HOJE }, admin);

  const novaFatura = async (dia) => (await api.post('/faturamento/faturas', {
    assinante_id: assinante.id, contrato_id: contrato.id, vencimento: `${COMP}-${dia}`, competencia: COMP,
    itens: [{ descricao: 'Mensalidade Fibra 300', valor: '99,90', origem: 'mensalidade' }],
  }, admin)).dados;

  const emitir = async (dia) => (await api.post('/fiscal/nfcom', { fatura_id: (await novaFatura(dia)).id }, admin)).dados;
  return { admin, emitir, assinante, contrato };
}

/** A cadeia da SEFAZ de mentira entra pela mesma variável que, em produção, leva a ICP-Brasil. */
function apontarCa(falsa) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-'));
  const arquivo = path.join(dir, 'ca.pem');
  fs.writeFileSync(arquivo, falsa.ca);
  const antes = process.env.NETWORK_SEFAZ_CA;
  process.env.NETWORK_SEFAZ_CA = arquivo;
  return () => {
    if (antes === undefined) delete process.env.NETWORK_SEFAZ_CA; else process.env.NETWORK_SEFAZ_CA = antes;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

test('SEFAZ: envelope, compactação e identidade de quem transmite', { skip: !temOpenssl() && 'openssl não disponível' }, async (t) => {
  const falsa = await sefazFalsa.iniciar((p) => (p.caminho.includes('Status')
    ? sefazFalsa.RESPOSTAS.statusNoAr()
    : sefazFalsa.RESPOSTAS.autorizada(/<chNFCom>(\d{44})<\/chNFCom>/.exec(p.xml)?.[1] ?? '0'.repeat(44))));
  const soltar = apontarCa(falsa);
  const api = await iniciar();
  t.after(async () => { soltar(); await falsa.fechar(); api.fechar(); });
  const c = await cenario(api, falsa);

  await t.test('o teste de conexão diz se o serviço está no ar', async () => {
    const r = await api.post('/fiscal/sefaz/testar', {}, c.admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.c_stat, '107');
    assert.equal(r.dados.no_ar, true);
    assert.match(r.dados.x_motivo, /Operacao/i);
  });

  await t.test('o envelope é SOAP 1.2 e NÃO leva cabeçalho', async () => {
    const pedido = falsa.recebidos.at(-1);
    assert.match(pedido.contentType, /application\/soap\+xml/);
    assert.ok(pedido.envelope.includes('http://www.w3.org/2003/05/soap-envelope'), 'namespace do SOAP 1.2');
    assert.ok(!/<\w*:?Header[\s>]/.test(pedido.envelope), 'o manual diz que não há cabeçalho SOAP');
  });

  await t.test('A NOTA VAI COMPACTADA EM GZIP, como a recepção exige', async () => {
    const nota = await c.emitir('10');
    await api.post(`/fiscal/nfcom/${nota.id}/transmitir`, {}, c.admin);
    const pedido = falsa.recebidos.at(-1);
    assert.equal(pedido.comprimido, true, 'o conteúdo precisa chegar em GZip + Base64');
    assert.ok(pedido.xml.includes('<infNFCom'), 'e descompactar no XML da nota');
    assert.ok(pedido.xml.includes(nota.chave));
  });

  await t.test('a consulta de status vai SEM compactação', async () => {
    await api.post('/fiscal/sefaz/testar', {}, c.admin);
    const pedido = falsa.recebidos.at(-1);
    assert.equal(pedido.comprimido, false);
    assert.ok(pedido.xml.includes('<consStatServNFCom'));
  });

  await t.test('O CERTIFICADO DO PROVEDOR VAI COMO IDENTIDADE DE QUEM TRANSMITE', async () => {
    // É o que a SEFAZ usa para saber quem está do outro lado. Se não for enviado, nada é autorizado.
    const pedido = falsa.recebidos.at(-1);
    const cert = pedido.certificadoCliente;
    assert.ok(cert && Object.keys(cert).length, 'o cliente precisa apresentar certificado');
    assert.match(String(cert.subject?.CN ?? ''), /PROVEDOR TESTE LTDA/);
  });
});

test('SEFAZ: o que a resposta determina', { skip: !temOpenssl() && 'openssl não disponível' }, async (t) => {
  let resposta = () => sefazFalsa.RESPOSTAS.statusNoAr();
  const falsa = await sefazFalsa.iniciar((p) => resposta(p));
  const soltar = apontarCa(falsa);
  const api = await iniciar();
  t.after(async () => { soltar(); await falsa.fechar(); api.fechar(); });
  const c = await cenario(api, falsa);
  const chaveDe = (p) => /<chNFCom>(\d{44})<\/chNFCom>/.exec(p.xml)?.[1] ?? '0'.repeat(44);

  await t.test('cStat 100 autoriza e guarda o protocolo INTEIRO, como veio', async () => {
    resposta = (p) => sefazFalsa.RESPOSTAS.autorizada(chaveDe(p), '141260000012345');
    const nota = await c.emitir('11');
    const r = await api.post(`/fiscal/nfcom/${nota.id}/transmitir`, {}, c.admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.situacao, 'autorizada');
    assert.equal(r.dados.protocolo, '141260000012345');
    assert.ok(r.dados.autorizada_em);
    const completa = (await api.get(`/fiscal/nfcom/${nota.id}`, c.admin)).dados;
    assert.ok(completa.xml_protocolo.includes('<protNFCom'), 'o protocolo é a prova: guardado como veio');
    assert.ok(completa.xml_protocolo.includes('141260000012345'));
  });

  await t.test('rejeição NÃO vira autorização, e o motivo fica legível', async () => {
    resposta = () => sefazFalsa.RESPOSTAS.rejeitada('539', 'Rejeicao: Duplicidade de NFCom');
    const nota = await c.emitir('12');
    const r = await api.post(`/fiscal/nfcom/${nota.id}/transmitir`, {}, c.admin);
    assert.equal(r.dados.situacao, 'rejeitada');
    assert.equal(r.dados.c_stat, '539');
    assert.match(r.dados.x_motivo, /Duplicidade/);
    assert.equal(r.dados.protocolo, null);
    assert.equal(r.dados.autorizada_em, null);
  });

  await t.test('denegada é denegada, não rejeitada: são coisas diferentes', async () => {
    resposta = () => sefazFalsa.RESPOSTAS.denegada();
    const nota = await c.emitir('13');
    const r = await api.post(`/fiscal/nfcom/${nota.id}/transmitir`, {}, c.admin);
    assert.equal(r.dados.situacao, 'denegada');
    assert.equal(r.dados.c_stat, '302');
  });

  await t.test('NOTA AUTORIZADA NÃO É TRANSMITIDA DE NOVO', async () => {
    resposta = (p) => sefazFalsa.RESPOSTAS.autorizada(chaveDe(p));
    const nota = await c.emitir('14');
    await api.post(`/fiscal/nfcom/${nota.id}/transmitir`, {}, c.admin);
    const r = await api.post(`/fiscal/nfcom/${nota.id}/transmitir`, {}, c.admin);
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /já está autorizada/);
  });

  await t.test('a consulta é a autoridade: resolve nota presa sem emitir outra', async () => {
    const nota = await c.emitir('15');
    // Transmissão que falha na rede deixa a nota como estava — nada foi decidido na SEFAZ.
    const antes = (await api.get(`/fiscal/nfcom/${nota.id}`, c.admin)).dados;
    assert.equal(antes.situacao, 'assinada');
    resposta = (p) => sefazFalsa.RESPOSTAS.autorizada(chaveDe(p), '141260000055555');
    const r = await api.post(`/fiscal/nfcom/${nota.id}/consultar`, {}, c.admin);
    assert.equal(r.dados.c_stat, '100');
    assert.equal(r.dados.nota.situacao, 'autorizada', 'o que a SEFAZ diz vale');
    assert.equal(r.dados.nota.protocolo, '141260000055555');
  });

  await t.test('FALHA DE ENVELOPE ENSINA O QUE FAZER', async () => {
    /*
     * Este é o ponto do código que não pôde ser conferido contra o WSDL (o servidor da SEFAZ usa cadeia
     * ICP-Brasil e não abriu do ambiente onde isto foi escrito). Se o nome do elemento estiver errado,
     * a mensagem precisa dizer isso, e não deixar o operador diante de um erro mudo.
     */
    resposta = () => sefazFalsa.falhaSoap('Server did not recognize the value of element nfcomDadosMsg.');
    const nota = await c.emitir('16');
    const r = await api.post(`/fiscal/nfcom/${nota.id}/transmitir`, {}, c.admin);
    assert.equal(r.status, 502);
    assert.match(r.dados.erro, /elemento ou o namespace do envelope/);
    assert.match(r.dados.erro, /WSDL/);
    const depois = (await api.get(`/fiscal/nfcom/${nota.id}`, c.admin)).dados;
    assert.equal(depois.situacao, 'assinada', 'a nota volta ao estado anterior: a SEFAZ não decidiu nada');
  });
});

test('SEFAZ: cancelamento é evento, não apagamento', { skip: !temOpenssl() && 'openssl não disponível' }, async (t) => {
  let resposta = () => sefazFalsa.RESPOSTAS.statusNoAr();
  const falsa = await sefazFalsa.iniciar((p) => resposta(p));
  const soltar = apontarCa(falsa);
  const api = await iniciar();
  t.after(async () => { soltar(); await falsa.fechar(); api.fechar(); });
  const c = await cenario(api, falsa);
  const chaveDe = (p) => /<chNFCom>(\d{44})<\/chNFCom>/.exec(p.xml)?.[1] ?? '0'.repeat(44);

  const autorizar = async (dia) => {
    resposta = (p) => sefazFalsa.RESPOSTAS.autorizada(chaveDe(p), '141260000077777');
    const nota = await c.emitir(dia);
    await api.post(`/fiscal/nfcom/${nota.id}/transmitir`, {}, c.admin);
    return nota;
  };

  await t.test('só se cancela nota autorizada', async () => {
    const nota = await c.emitir('20');
    const r = await api.post(`/fiscal/nfcom/${nota.id}/cancelar`, { justificativa: 'Erro no valor cobrado do cliente' }, c.admin);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /Só se cancela nota autorizada/);
  });

  await t.test('justificativa curta é recusada', async () => {
    const nota = await autorizar('21');
    const r = await api.post(`/fiscal/nfcom/${nota.id}/cancelar`, { justificativa: 'errei' }, c.admin);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /15 caracteres/);
  });

  await t.test('o evento vai assinado, com o Id de 55 caracteres e o protocolo da nota', async () => {
    const nota = await autorizar('22');
    resposta = () => sefazFalsa.RESPOSTAS.eventoRegistrado(nota.chave);
    const r = await api.post(`/fiscal/nfcom/${nota.id}/cancelar`, { justificativa: 'Cobrança emitida com o plano errado' }, c.admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.cancelada, true);

    const pedido = falsa.recebidos.at(-1);
    assert.ok(pedido.xml.includes('<eventoNFCom'));
    assert.ok(pedido.xml.includes('<tpEvento>110111</tpEvento>'), 'o cancelamento é o evento 110111');
    assert.ok(pedido.xml.includes('<descEvento>Cancelamento</descEvento>'));
    assert.ok(pedido.xml.includes('<nProt>141260000077777</nProt>'), 'leva o protocolo de autorização da nota');
    const id = /Id="(ID[^"]+)"/.exec(pedido.xml)[1];
    assert.equal(id.length, 55, 'ID + tpEvento + chave + sequência em três dígitos');
    assert.equal(id, `ID110111${nota.chave}001`);
    assert.ok(pedido.xml.includes('<SignatureValue>'), 'o evento também é assinado');
    assert.equal(pedido.comprimido, false, 'o evento vai sem compactação');
  });

  await t.test('A NOTA CANCELADA CONTINUA LÁ, com o evento ao lado', async () => {
    const lista = (await api.get('/fiscal/nfcom?situacao=cancelada', c.admin)).dados;
    assert.ok(lista.itens.length >= 1);
    const completa = (await api.get(`/fiscal/nfcom/${lista.itens[0].id}`, c.admin)).dados;
    assert.ok(completa.xml, 'o XML da nota não é apagado');
    assert.ok(completa.protocolo, 'nem o protocolo de autorização');
    assert.equal(completa.eventos.length, 1);
    assert.equal(completa.eventos[0].situacao, 'registrado');
    assert.equal(completa.eventos[0].tipo, '110111');
    assert.ok(completa.eventos[0].xml.includes('<evCancNFCom>'));
    assert.match(completa.eventos[0].justificativa, /plano errado/);
  });

  await t.test('evento rejeitado NÃO cancela a nota', async () => {
    const nota = await autorizar('23');
    resposta = () => sefazFalsa.RESPOSTAS.eventoRejeitado();
    const r = await api.post(`/fiscal/nfcom/${nota.id}/cancelar`, { justificativa: 'Teste de rejeição do evento' }, c.admin);
    assert.equal(r.dados.cancelada, false);
    assert.equal(r.dados.c_stat, '573');
    assert.equal(r.dados.nota.situacao, 'autorizada', 'a nota segue autorizada');
    assert.equal(r.dados.evento.situacao, 'rejeitado');
  });
});

test('SEFAZ: recusas sem rede', async (t) => {
  await t.test('autorizador sem endereço confirmado recusa DIZENDO POR QUÊ', () => {
    assert.throws(() => sefaz.endereco({ autorizador: 'MG', ambiente: 2 }, 'recepcao'),
      /autoriza a NFCom por conta própria.*configure-o antes de transmitir/s);
  });

  await t.test('endereço informado pelo provedor tem precedência', () => {
    const url = sefaz.endereco({ autorizador: 'MG', ambiente: 2, urls: JSON.stringify({ recepcao: 'https://nfcom.sefaz.mg.gov.br/x' }) }, 'recepcao');
    assert.equal(url, 'https://nfcom.sefaz.mg.gov.br/x');
  });

  await t.test('SVRS tem endereço de homologação e de produção, e são diferentes', () => {
    const h = sefaz.endereco({ autorizador: 'SVRS', ambiente: 2 }, 'recepcao');
    const p = sefaz.endereco({ autorizador: 'SVRS', ambiente: 1 }, 'recepcao');
    assert.ok(h.includes('homologacao'));
    assert.ok(!p.includes('homologacao'));
  });

  await t.test('falha de TLS vira explicação da cadeia ICP-Brasil, não um erro cru', () => {
    const msg = sefaz.traduzirFalha(new Error('unable to get local issuer certificate'));
    assert.match(msg, /ICP-Brasil/);
    assert.match(msg, /NODE_EXTRA_CA_CERTS|instale a cadeia/);
  });

  await t.test('o envelope é montado com o elemento e o namespace do serviço', () => {
    const e = sefaz.envelope('recepcao', 'CONTEUDO');
    assert.ok(e.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(e.includes('<nfcomDadosMsg xmlns="http://www.portalfiscal.inf.br/nfcom/wsdl/NFComRecepcao">CONTEUDO</nfcomDadosMsg>'));
    assert.ok(!e.includes('Header'));
  });

  await t.test('resposta sem cStat é recusada em vez de interpretada', () => {
    assert.throws(() => sefaz.lerRetorno({ status: 200, corpo: '<retNFCom></retNFCom>' }), /sem o código de situação/);
  });

  await t.test('gzip e base64 fecham a volta', () => {
    const texto = '<infNFCom>teste</infNFCom>';
    const ida = zlib.gzipSync(Buffer.from(texto, 'utf8')).toString('base64');
    assert.equal(zlib.gunzipSync(Buffer.from(ida, 'base64')).toString('utf8'), texto);
  });

  await t.test('a situação sai do código que a SEFAZ devolveu, e de mais nada', () => {
    assert.equal(transmissao.situacaoPor('100'), 'autorizada');
    assert.equal(transmissao.situacaoPor('302'), 'denegada');
    assert.equal(transmissao.situacaoPor('110'), 'denegada');
    assert.equal(transmissao.situacaoPor('539'), 'rejeitada');
    assert.equal(transmissao.situacaoPor('999'), 'rejeitada');
  });
});
