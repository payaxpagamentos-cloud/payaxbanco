'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, dia } = require('./helpers');
const { gerarBoletoBancario } = require('../server/lib/boleto');
const { lembretesAutomaticos } = require('../server/lib/avisos');
const { caixaTeste } = require('../server/lib/email');
const { somarMeses } = require('../server/lib/datas');

const EMPRESA = { razao_social: 'Mercado Bom Preço Ltda', nome_fantasia: 'Bom Preço', cnpj: '11.222.333/0001-81', inicio_contrato: dia(-120) };

const nfe = ({ chave = '35260106990590000123550010000012341000012345', emit = '06990590000123', dest = '11222333000181', dups = true, protocolo = true } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00">
<ide><natOp>VENDA DE MERCADORIA</natOp><serie>1</serie><nNF>1234</nNF><dhEmi>${dia(-2)}T10:00:00-03:00</dhEmi></ide>
<emit><CNPJ>${emit}</CNPJ><xNome>DISTRIBUIDORA SOL &amp; MAR LTDA</xNome><xFant>Sol e Mar</xFant></emit>
<dest><CNPJ>${dest}</CNPJ><xNome>MERCADO BOM PRECO LTDA</xNome></dest>
<total><ICMSTot><vNF>1500.00</vNF></ICMSTot></total>
${dups ? `<cobr><fat><nFat>1234</nFat><vLiq>1500.00</vLiq></fat><dup><nDup>001</nDup><dVenc>${dia(28)}</dVenc><vDup>750.00</vDup></dup><dup><nDup>002</nDup><dVenc>${dia(58)}</dVenc><vDup>750.00</vDup></dup></cobr>` : ''}
</infNFe></NFe>${protocolo ? `<protNFe><infProt><chNFe>${chave}</chNFe><cStat>100</cStat></infProt></protNFe>` : ''}</nfeProc>`;

test('Finalização: NF-e, boleto e e-mails', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  let empresa, conta, cats;
  const base = () => `/empresas/${empresa}`;
  const cat = (nome) => cats.find((c) => c.nome === nome).id;

  await t.test('preparação', async () => {
    empresa = (await api.post('/empresas', EMPRESA)).dados.id;
    cats = (await api.get(`${base()}/categorias`)).dados.itens;
    conta = (await api.post(`${base()}/contas-bancarias`, { descricao: 'Movimento', banco: 'Itaú', saldo_inicial_centavos: 1_000_000, data_saldo_inicial: dia(-120) })).dados.id;
  });

  await t.test('NF-e: prévia, lançamento por duplicata, XML anexado e sem duplicar', async () => {
    const previa = await api.post(`${base()}/integracoes/nfe`, { conteudo: nfe(), previa: true });
    assert.equal(previa.status, 200, JSON.stringify(previa.dados));
    assert.equal(previa.dados.tipo, 'pagar');
    assert.equal(previa.dados.contato.nome, 'DISTRIBUIDORA SOL & MAR LTDA');
    assert.equal(previa.dados.parcelas.length, 2);
    assert.equal((await api.post(`${base()}/integracoes/nfe`, { conteudo: nfe() })).status, 422, 'exige categoria');
    const r = await api.post(`${base()}/integracoes/nfe`, { conteudo: nfe(), categoria_id: cat('Compra de mercadorias'), conta_bancaria_id: conta });
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.ids.length, 2);
    const l = (await api.get(`${base()}/lancamentos/${r.dados.ids[0]}`)).dados;
    assert.equal(l.valor_centavos, 75_000);
    assert.equal(l.vencimento, dia(28));
    assert.equal(l.competencia, dia(-2));
    assert.equal(l.contato_nome, 'Sol e Mar');
    assert.equal(l.documentos[0].nome, `NFe${r.dados.chave}.xml`);
    assert.equal((await api.post(`${base()}/integracoes/nfe`, { conteudo: nfe(), categoria_id: cat('Compra de mercadorias') })).status, 409);
    // Nota emitida pela empresa vira conta a receber.
    const venda = await api.post(`${base()}/integracoes/nfe`, { conteudo: nfe({ chave: '35260111222333000181550010000000101000000101', emit: '11222333000181', dest: '06990590000123', dups: false }),
      categoria_id: cat('Venda de produtos') });
    assert.equal(venda.status, 201, JSON.stringify(venda.dados));
    assert.equal(venda.dados.tipo, 'receber');
    assert.equal((await api.get(`${base()}/lancamentos/${venda.dados.ids[0]}`)).dados.vencimento, require('../server/lib/datas').somarDias(dia(-2), 30));
    // De outra empresa, sem protocolo ou que não é NF-e.
    assert.equal((await api.post(`${base()}/integracoes/nfe`, { conteudo: nfe({ chave: '35260100000000000000550010000000011000000011', dest: '06990590000123' }), categoria_id: cat('Compra de mercadorias') })).status, 422);
    const semProt = await api.post(`${base()}/integracoes/nfe`, { conteudo: nfe({ chave: '35260106990590000123550010000099991000099999', protocolo: false }), categoria_id: cat('Compra de mercadorias') });
    assert.equal(semProt.status, 422);
    assert.equal(semProt.dados.detalhes.sem_protocolo, true);
    assert.equal((await api.post(`${base()}/integracoes/nfe`, { conteudo: '<xml>nada</xml>' })).status, 422);
  });

  await t.test('boleto: linha digitável preenche valor e vencimento e fica no lançamento', async () => {
    const b = gerarBoletoBancario({ banco: '341', valorCentavos: 23_456, vencimento: dia(10) });
    const lido = await api.get(`/utilidades/boleto?linha=${b.linha_digitavel}`);
    assert.equal(lido.dados.valor_centavos, 23_456);
    assert.equal(lido.dados.vencimento, dia(10));
    assert.equal((await api.get('/utilidades/boleto?linha=12345')).status, 422);
    const errado = b.linha_digitavel.slice(0, 46) + ((Number(b.linha_digitavel[46]) + 1) % 10);
    assert.equal((await api.get(`/utilidades/boleto?linha=${errado}`)).status, 422);
    const r = await api.post(`${base()}/lancamentos`, { tipo: 'pagar', descricao: 'Boleto fornecedor', valor_centavos: 23_456, vencimento: dia(10),
      categoria_id: cat('Serviços terceirizados'), codigo_barras: b.linha_digitavel });
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal((await api.get(`${base()}/lancamentos/${r.dados.ids[0]}`)).dados.codigo_barras, b.linha_digitavel);
  });

  await t.test('e-mail: acesso ao Portal, aviso de aprovação, lembrete, automáticos e relatório', async () => {
    const r = await api.post(`${base()}/responsaveis`, { nome: 'Marta Lima', email: 'marta@bompreco.com.br', acesso_portal: true, pode_aprovar: true, recebe_relatorios: true, enviar_email: true });
    assert.equal(r.dados.email_enviado, true);
    const acesso = caixaTeste.find((m) => m.tipo === 'acesso_portal');
    assert.match(acesso.mensagem.html, new RegExp(r.dados.senha_provisoria));
    assert.match(acesso.mensagem.html, /http:\/\/bpo\.teste\/portal\//);

    // Aprovação: conferido → e-mail ao aprovador.
    await api.patch(`${base()}/aprovacoes/config`, { aprovacao_ativa: true, aprovacao_acima_centavos: 0 });
    const a = await api.post('/usuarios', { nome: 'Ana', email: 'ana@ativabpo.com.br', senha: 'senha-forte-1', perfil: 'analista' });
    await api.patch(`/empresas/${empresa}`, { analista_id: a.dados.id });
    const analista = await api.login('ana@ativabpo.com.br', 'senha-forte-1');
    const pg = (await api.post(`${base()}/lancamentos`, { tipo: 'pagar', descricao: 'Reforma da loja', valor_centavos: 90_000, vencimento: dia(5), categoria_id: cat('Outras despesas') }, analista)).dados.ids[0];
    await api.post(`${base()}/aprovacoes/${pg}/conferir`, {}, analista);
    await new Promise((ok) => setTimeout(ok, 50));
    assert.ok(caixaTeste.some((m) => m.tipo === 'aprovacao' && m.para === 'marta@bompreco.com.br' && /Reforma da loja/.test(m.mensagem.html)));

    // Lembrete de cobrança por e-mail (precisa do e-mail do cliente).
    const cliente = (await api.post(`${base()}/contatos`, { tipo: 'cliente', nome: 'Padaria Sol', email: 'contas@padariasol.com.br' })).dados.id;
    const semEmail = (await api.post(`${base()}/contatos`, { tipo: 'cliente', nome: 'Cliente sem e-mail' })).dados.id;
    const t1 = (await api.post(`${base()}/lancamentos`, { tipo: 'receber', descricao: 'Fornecimento', valor_centavos: 40_000, vencimento: dia(-7), categoria_id: cat('Venda de produtos'), contato_id: cliente })).dados.ids[0];
    const t2 = (await api.post(`${base()}/lancamentos`, { tipo: 'receber', descricao: 'Outro', valor_centavos: 1_000, vencimento: dia(-7), categoria_id: cat('Venda de produtos'), contato_id: semEmail })).dados.ids[0];
    assert.equal((await api.post(`${base()}/cobranca/lembretes/${t1}/email`)).status, 200);
    assert.equal((await api.post(`${base()}/cobranca/lembretes/${t2}/email`)).status, 422);
    const ficha = (await api.get(`${base()}/cobranca/clientes/${cliente}`)).dados;
    assert.match(ficha.historico[0].descricao, /e-mail para contas@padariasol/);

    // Automáticos: 7 dias de atraso é um marco; um por título por dia.
    await api.patch(`${base()}/cobranca/config`, { lembrete_auto: true, lembrete_dias_antes: 3 });
    const t3 = (await api.post(`${base()}/lancamentos`, { tipo: 'receber', descricao: 'Mensalidade', valor_centavos: 5_000, vencimento: dia(3), categoria_id: cat('Venda de produtos'), contato_id: cliente })).dados.ids[0];
    const auto = await lembretesAutomaticos(api.db);
    assert.equal(auto.enviados, 1, 't3 (3 dias antes); t1 já recebeu hoje');
    assert.ok(caixaTeste.some((m) => m.tipo === 'lembrete' && /Lembrete de vencimento/.test(m.assunto)));
    assert.equal((await lembretesAutomaticos(api.db)).enviados, 0);
    void t3;

    // Relatório do mês: envia e conclui a etapa "envio" do fechamento.
    const mes = somarMeses(dia(), -1).slice(0, 7);
    const rel = await api.post(`${base()}/fechamento/enviar-relatorio`, { mes });
    assert.equal(rel.status, 200, JSON.stringify(rel.dados));
    assert.deepEqual(rel.dados.destinatarios, ['marta@bompreco.com.br']);
    const f = (await api.get(`${base()}/fechamento?mes=${mes}`)).dados;
    assert.match(f.etapas.find((e) => e.chave === 'envio').concluida.observacao, /marta@bompreco/);

    // Teste e situação em Segurança.
    assert.equal((await api.post('/seguranca/email-teste', { para: 'ti@ativabpo.com.br' })).status, 200);
    const seg = (await api.get('/seguranca')).dados.email;
    assert.equal(seg.configurado, true);
    assert.ok(seg.enviados_24h >= 6);
  });
});
