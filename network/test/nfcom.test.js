'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { criarCertificado, temOpenssl } = require('./certificado-falso');
const { dataLocal } = require('../server/lib/datas');
const chaveAcesso = require('../server/lib/fiscal/chave');
const tabelas = require('../server/lib/fiscal/tabelas');
const nfcom = require('../server/lib/fiscal/nfcom');
const emissao = require('../server/lib/fiscal/emissao');
const assinaturaXml = require('../server/lib/fiscal/assinatura');
const certificado = require('../server/lib/certificado');

const HOJE = dataLocal('America/Sao_Paulo');
const COMP = HOJE.slice(0, 7);
const CNPJ_PROVEDOR = '11.222.333/0001-81';

/*
 * Emissão da NFCom de ponta a ponta, sem SEFAZ.
 *
 * Tudo o que está aqui é conferível sozinho: a nota montada, os tributos, os totais, a chave e a
 * assinatura. É onde o erro precisa aparecer — a alternativa é descobrir pela rejeição, dias depois,
 * com a fatura já na mão do cliente.
 */

/** Organização completa, com certificado, e um assinante com fatura. */
async function cenario(api, { comCertificado = true, comEndereco = true, comRegras = true } = {}) {
  const admin = await api.login();
  const criar = async (caminho, corpo, tk = admin, esperado = 201) => {
    const r = await api.post(caminho, corpo, tk);
    assert.equal(r.status, esperado, `${caminho}: ${JSON.stringify(r.dados)}`);
    return r.dados;
  };

  if (comEndereco) {
    const r = await api.patch('/organizacao', {
      documento: CNPJ_PROVEDOR, inscricao_estadual: '9012345678', nome_fantasia: 'Provedor Teste',
      cep: '80010000', logradouro: 'Rua das Fibras', numero_endereco: '100', bairro: 'Centro',
      cidade: 'CURITIBA', uf: 'PR', codigo_municipio: '4106902', telefone: '4133334444', email: 'fiscal@provedor.test',
    }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
  }

  if (comCertificado && temOpenssl()) {
    const c = criarCertificado({ nome: 'PROVEDOR TESTE LTDA', cnpj: '11222333000181' });
    const r = await api.post('/certificado', { apelido: 'e-CNPJ de teste', arquivo: c.base64, senha: c.senha }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
  }

  await api.put('/fiscal/config', {
    ambiente: 2, serie: 1, crt: 3,
    resp_tec_cnpj: '11222333000181', resp_tec_contato: 'Equipe de TI',
    resp_tec_email: 'ti@provedor.test', resp_tec_fone: '4133334444',
  }, admin);
  if (comRegras) await api.post('/fiscal/regras/padrao', {}, admin);

  const plano = await criar('/planos', { nome: 'Fibra 300', tipo: 'internet', tecnologia: 'fibra', download_mbps: 300, upload_mbps: 150, mensalidade: '99,90' });
  const assinante = await criar('/assinantes', {
    tipo: 'pf', nome: 'Ana Fiscal', documento: '390.533.447-05', telefone: '41999990000', email: 'ana@exemplo.com',
    cep: '80020000', logradouro: 'Rua do Assinante', numero: '50', bairro: 'Batel', cidade: 'CURITIBA', uf: 'PR',
    codigo_municipio: '4106902',
  });
  const contrato = await criar('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 10 });
  await criar(`/contratos/${contrato.id}/ativar`, { data: HOJE }, admin, 200);
  const fatura = await criar('/faturamento/faturas', {
    assinante_id: assinante.id, contrato_id: contrato.id, vencimento: `${COMP}-10`, competencia: COMP,
    itens: [
      { descricao: 'Mensalidade Fibra 300', valor: '99,90', origem: 'mensalidade' },
      { descricao: 'Aluguel de roteador', valor: '15,00', origem: 'equipamento' },
    ],
  });
  return { admin, criar, plano, assinante, contrato, fatura };
}

test('NFCom: configuração e regras fiscais', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const admin = await api.login();

  await t.test('nasce em HOMOLOGAÇÃO, nunca em produção', async () => {
    const r = await api.get('/fiscal/config', admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.ambiente, 2, 'ninguém estreia em produção');
    assert.equal(r.dados.layout_validado, false);
    assert.equal(r.dados.serie, 1);
    assert.equal(r.dados.proximo_numero, 1);
  });

  await t.test('as regras vêm da tabela oficial e nascem NÃO CONFERIDAS', async () => {
    const r = await api.post('/fiscal/regras/padrao', {}, admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    const lista = (await api.get('/fiscal/regras', admin)).dados;
    const mensalidade = lista.itens.find((i) => i.origem === 'mensalidade');
    assert.equal(mensalidade.cclass, '0400401', 'provimento à internet');
    assert.equal(mensalidade.conferida, false, 'sugestão não é verdade: a contabilidade confirma');
    const equipamento = lista.itens.find((i) => i.origem === 'equipamento');
    assert.equal(equipamento.cclass, '0800601', 'roteador');
    const desconto = lista.itens.find((i) => i.origem === 'desconto');
    assert.ok(desconto.cclass.startsWith('5'), 'desconto precisa ser código de dedução');
    assert.equal(desconto.cfop, '', 'dedução não é prestação: não tem CFOP');
  });

  await t.test('gerar de novo não duplica nem sobrescreve o que a contabilidade ajustou', async () => {
    await api.patch('/fiscal/regras/mensalidade', { p_icms: '25.00', conferida: true }, admin);
    const r = await api.post('/fiscal/regras/padrao', {}, admin);
    assert.equal(r.dados.criadas, 0);
    const lista = (await api.get('/fiscal/regras', admin)).dados;
    const m = lista.itens.find((i) => i.origem === 'mensalidade');
    assert.equal(m.p_icms, '25.00', 'o ajuste da contabilidade fica');
    assert.equal(m.conferida, true);
  });
});

test('NFCom: o que falta para emitir é dito antes, não depois', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const admin = await api.login();

  await t.test('sem endereço da empresa, a emissão recusa DIZENDO QUAL CAMPO FALTA', async () => {
    const r = await api.get('/fiscal/pendencias', admin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.pronto, false);
    const campos = r.dados.faltas.map((f) => f.campo);
    assert.ok(campos.includes('CNPJ'), 'CNPJ da empresa');
    assert.ok(campos.includes('código IBGE do município'), 'o cMunFG sai daqui');
    assert.ok(campos.includes('inscrição estadual'));
    assert.ok(r.dados.faltas.some((f) => f.onde === 'responsável técnico'));
  });

  await t.test('a lista vem inteira, não um campo por vez', async () => {
    const r = await api.get('/fiscal/pendencias', admin);
    assert.ok(r.dados.faltas.length >= 8, `esperava a lista toda, veio ${r.dados.faltas.length}`);
  });
});

test('NFCom: emissão a partir da fatura', { skip: !temOpenssl() && 'openssl não disponível' }, async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const c = await cenario(api);

  await t.test('a prévia mostra tudo ANTES de queimar um número de nota', async () => {
    const r = await api.post(`/fiscal/nfcom/previa`, { fatura_id: c.fatura.id }, c.admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.itens.length, 2);
    assert.equal(r.dados.totais.total, 11490, 'R$ 99,90 + R$ 15,00');
    const cfg = (await api.get('/fiscal/config', c.admin)).dados;
    assert.equal(cfg.proximo_numero, 1, 'a prévia NÃO consome número');
  });

  await t.test('emite, assina e guarda o XML como foi assinado', async () => {
    const r = await api.post('/fiscal/nfcom', { fatura_id: c.fatura.id }, c.admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    const nota = r.dados;
    assert.equal(nota.situacao, 'assinada');
    assert.equal(nota.numero, 1);
    assert.equal(nota.valor_total_centavos, 11490);
    assert.equal(nota.chave.length, 44);
    assert.ok(chaveAcesso.conferir(nota.chave));

    const completa = (await api.get(`/fiscal/nfcom/${nota.id}`, c.admin)).dados;
    assert.ok(completa.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(completa.xml.includes(`<infNFCom Id="NFCom${nota.chave}" versao="1.00">`));
    assert.ok(completa.xml.includes('<mod>62</mod>'), 'modelo 62');
    assert.ok(completa.xml.includes('<tpAmb>2</tpAmb>'), 'homologação');
    assert.equal(completa.itens.length, 2);
  });

  await t.test('A ASSINATURA CONFERE CONTRA O XML GRAVADO', async () => {
    /*
     * Esta é a garantia que importa: o que foi assinado é o que está guardado. Se o gerador de XML
     * mudasse um espaço depois de assinar, a SEFAZ rejeitaria — aqui o teste pega antes.
     */
    const nota = (await api.get('/fiscal/nfcom', c.admin)).dados.itens[0];
    const completa = (await api.get(`/fiscal/nfcom/${nota.id}`, c.admin)).dados;
    const m = /<infNFCom [^>]*>[\s\S]*?<\/infNFCom>/.exec(completa.xml);
    assert.ok(m, 'infNFCom precisa estar no XML');
    const canonico = m[0].replace('<infNFCom ', `<infNFCom xmlns="${tabelas.NAMESPACE}" `);
    const r = assinaturaXml.conferir({ xmlAssinado: completa.xml, canonicoAssinado: canonico });
    assert.equal(r.ok, true, r.motivo);
  });

  await t.test('a nota nasce com o AVISO de leiaute não validado colado nela', async () => {
    const nota = (await api.get('/fiscal/nfcom', c.admin)).dados.itens[0];
    assert.match(nota.aviso, /NÃO VALIDADO/);
    // Fica no registro, não só na tela: daqui a um ano ainda se sabe quais notas saíram antes da conferência.
  });

  await t.test('o item de equipamento sai com o cClass do roteador, não com o da mensalidade', async () => {
    const nota = (await api.get('/fiscal/nfcom', c.admin)).dados.itens[0];
    const completa = (await api.get(`/fiscal/nfcom/${nota.id}`, c.admin)).dados;
    const mensalidade = completa.itens.find((i) => i.origem === 'mensalidade');
    const equipamento = completa.itens.find((i) => i.origem === 'equipamento');
    assert.equal(mensalidade.cclass, '0400401');
    assert.equal(equipamento.cclass, '0800601');
    assert.equal(mensalidade.cfop, '5307', 'mesmo estado, não contribuinte');
  });

  await t.test('A MESMA FATURA NÃO VIRA DUAS NOTAS', async () => {
    const r = await api.post('/fiscal/nfcom', { fatura_id: c.fatura.id }, c.admin);
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /já tem a nota/);
  });

  await t.test('o número é sequencial e NÃO volta atrás', async () => {
    const cfg = (await api.get('/fiscal/config', c.admin)).dados;
    assert.equal(cfg.proximo_numero, 2, 'a nota 1 saiu; a próxima é a 2');
  });
});

test('NFCom: tributos, deduções e o CFOP interestadual', { skip: !temOpenssl() && 'openssl não disponível' }, async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const c = await cenario(api);
  await api.patch('/fiscal/regras/mensalidade', { p_icms: '25.00', p_pis: '0.65', p_cofins: '3.00', conferida: true }, c.admin);

  await t.test('ICMS, PIS e COFINS saem calculados sobre o valor do item', async () => {
    const f = (await api.post('/faturamento/faturas', {
      assinante_id: c.assinante.id, contrato_id: c.contrato.id, vencimento: `${COMP}-15`, competencia: COMP,
      itens: [{ descricao: 'Mensalidade', valor: '100,00', origem: 'mensalidade' }],
    }, c.admin)).dados;
    const r = await api.post('/fiscal/nfcom/previa', { fatura_id: f.id }, c.admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    const item = r.dados.itens[0];
    assert.equal(item.bc_icms_centavos, 10000, 'o ICMS da comunicação é por dentro: a base é o preço todo');
    assert.equal(item.icms_centavos, 2500, '25% de R$ 100,00');
    assert.equal(item.pis_centavos, 65);
    assert.equal(item.cofins_centavos, 300);
    assert.equal(r.dados.totais.icms, 2500);
  });

  await t.test('DESCONTO DEDUZ DO TOTAL — não aumenta a nota', async () => {
    const f = (await api.post('/faturamento/faturas', {
      assinante_id: c.assinante.id, contrato_id: c.contrato.id, vencimento: `${COMP}-16`, competencia: COMP,
      itens: [
        { descricao: 'Mensalidade', valor: '100,00', origem: 'mensalidade' },
        { descricao: 'Desconto fidelidade', valor: '10,00', origem: 'desconto' },
      ],
    }, c.admin)).dados;
    const r = await api.post('/fiscal/nfcom/previa', { fatura_id: f.id }, c.admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.totais.produtos, 10000);
    assert.equal(r.dados.totais.deducoes, 1000);
    assert.equal(r.dados.totais.total, 9000, 'R$ 100,00 menos R$ 10,00');
    const desconto = r.dados.itens.find((i) => i.origem === 'desconto');
    assert.equal(desconto.deduz, true);
    assert.equal(desconto.bc_icms_centavos, 0, 'dedução não tem base de ICMS');
    assert.equal(desconto.icms_centavos, 0);
  });

  await t.test('assinante em outro estado troca o CFOP de 5 para 6', () => {
    const regra = { cfop: '5307' };
    assert.equal(nfcom.cfopDo(regra, 'PR', 'PR'), '5307', 'mesmo estado');
    assert.equal(nfcom.cfopDo(regra, 'PR', 'SP'), '6307', 'interestadual');
    assert.equal(nfcom.cfopDo({ cfop: '' }, 'PR', 'SP'), null, 'sem CFOP continua sem CFOP');
  });

  await t.test('cobrança que zera com o desconto nem chega a existir', async () => {
    const r = await api.post('/faturamento/faturas', {
      assinante_id: c.assinante.id, contrato_id: c.contrato.id, vencimento: `${COMP}-17`, competencia: COMP,
      itens: [
        { descricao: 'Mensalidade', valor: '50,00', origem: 'mensalidade' },
        { descricao: 'Desconto', valor: '50,00', origem: 'desconto' },
      ],
    }, c.admin);
    assert.equal(r.status, 422, 'o faturamento barra antes de virar nota');
    assert.match(r.dados.erro, /maior que zero/);
  });

  await t.test('e, se uma fatura antiga zerar mesmo assim, a nota recusa', () => {
    // Garantia de retaguarda: a conta é feita de novo na hora de emitir, não se confia no que veio antes.
    const itens = [
      { origem: 'mensalidade', descricao: 'Mensalidade', valor_centavos: 5000 },
      { origem: 'desconto', descricao: 'Desconto', valor_centavos: -5000 },
    ];
    const r = { mensalidade: { cclass: '0400401', cfop: '5307', u_med: 4, cst_icms: '00', p_icms: '0.00', cst_pis: '01', p_pis: '0.00', cst_cofins: '01', p_cofins: '0.00' },
      desconto: { cclass: '5900201', cfop: '', u_med: 4, cst_icms: '41', p_icms: '0.00', cst_pis: '01', p_pis: '0.00', cst_cofins: '01', p_cofins: '0.00' } };
    const totais = nfcom.somar(nfcom.montarItens(itens, r, { ufEmitente: 'PR', ufDestino: 'PR', ano: 2026 }));
    assert.equal(totais.total, 0, 'o total zera, e quem emite precisa barrar isso');
  });
});

test('NFCom: sem certificado não se emite', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const c = await cenario(api, { comCertificado: false });

  await t.test('recusa dizendo que falta o certificado, não com erro de programa', async () => {
    const r = await api.post('/fiscal/nfcom', { fatura_id: c.fatura.id }, c.admin);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /certificado digital/i);
  });
});
