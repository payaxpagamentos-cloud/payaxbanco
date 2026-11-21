'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, png, dia, limparArquivos } = require('./helpers');

/**
 * O modelo de rede em prédios: a contrapartida do condomínio não é dinheiro, é o espaço para os comunicados
 * do síndico na própria tela. E a venda é por circuito, muitas vezes por agência.
 */
test('Rede em condomínios: comunicados, circuitos e agência', async (t) => {
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); });
  const master = await api.login();
  let predio, mercado, elevador, caixa, anunciante, agencia, circuito, campanha, cartaz, sindico, comunicado;

  await t.test('condomínio entra como ponto sem repasse em dinheiro', async () => {
    const r = await api.post('/painel/locais', {
      nome: 'Edifício Jardim das Acácias', categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP', bairro: 'Cambuí',
      administradora: 'Administra Bem', unidades: 96, publico_dia: 940, repasse_tipo: 'nenhum',
      responsavel: 'Paulo Rocha', telefone: '19988881111',
      horarios: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dia_semana: d, abre: '00:00', fecha: '23:59' })),
    }, master);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    predio = r.dados.id;
    assert.equal(r.dados.repasse_tipo, 'nenhum');
    assert.equal(r.dados.unidades, 96);

    mercado = (await api.post('/painel/locais', {
      nome: 'Mercado Bom Preço', categoria: 'mercado', cidade: 'Campinas', uf: 'SP', publico_dia: 1800, repasse_tipo: 'comissao', comissao_percentual: 15,
    }, master)).dados.id;

    // Tela de elevador: em pé.
    const tela = await api.post('/painel/telas', { local_id: predio, nome: 'Elevador social 1', posicao: 'Elevador social', orientacao: 'retrato' }, master);
    assert.equal(tela.status, 201, JSON.stringify(tela.dados));
    elevador = tela.dados.id;
    assert.equal(tela.dados.posicao, 'Elevador social');
    caixa = (await api.post('/painel/telas', { local_id: mercado, nome: 'Fila do caixa', posicao: 'Fila do caixa' }, master)).dados.id;
  });

  await t.test('campanha vendida em circuito, por agência, com PI', async () => {
    anunciante = (await api.post('/painel/anunciantes', { nome: 'Construtora Aurora', documento: '11.222.333/0001-81' }, master)).dados.id;
    const ag = await api.post('/painel/agencias', { nome: 'Ponto Alto Publicidade', documento: '04.252.011/0001-10', comissao_percentual: 20 }, master);
    assert.equal(ag.status, 201, JSON.stringify(ag.dados));
    agencia = ag.dados.id;
    assert.equal(ag.dados.comissao_percentual, 2000);

    const c = await api.post('/painel/circuitos', {
      nome: 'Residencial Campinas', descricao: 'Elevadores e halls de condomínios em Campinas',
      valor_mes_centavos: 350_000, cpm_centavos: 2200, insercoes_hora: 8,
      alvos: [{ tipo: 'categoria', valor: 'condominio_residencial' }],
    }, master);
    assert.equal(c.status, 201, JSON.stringify(c.dados));
    circuito = c.dados.id;
    const detalhe = (await api.get(`/painel/circuitos/${circuito}`, master)).dados;
    assert.equal(detalhe.telas, 1, 'o circuito alcança só a tela do condomínio');
    assert.equal(detalhe.retrato, 1);
    assert.equal(detalhe.publico_dia, 940);

    cartaz = (await api.enviarArquivo(`/painel/midias?nome=Aurora+9x16&anunciante_id=${anunciante}`, png(1080, 1920), master)).dados.id;
    await api.post(`/painel/midias/${cartaz}/aprovacao`, { decisao: 'aprovar' }, master);

    const camp = await api.post('/painel/campanhas', {
      anunciante_id: anunciante, agencia_id: agencia, pi: 'PI-2026-4471', nome: 'Lançamento Residencial Aurora',
      inicio: dia(-1), fim: dia(30), cobranca: 'mensal', valor_centavos: 350_000, criativos: [{ midia_id: cartaz }],
    }, master);
    assert.equal(camp.status, 201, JSON.stringify(camp.dados));
    campanha = camp.dados.id;
    assert.equal(camp.dados.comissao_agencia_percentual, 2000, 'a comissão vem da agência');

    const aplicado = await api.post(`/painel/campanhas/${campanha}/circuito`, { circuito_id: circuito }, master);
    assert.equal(aplicado.status, 200, JSON.stringify(aplicado.dados));
    assert.equal(aplicado.dados.insercoes_hora, 8, 'as inserções vêm do circuito');
    assert.equal(aplicado.dados.telas_alcancadas, 1);
    assert.deepEqual(aplicado.dados.alvos.map((a) => `${a.tipo}:${a.valor}`), ['categoria:condominio_residencial']);

    await api.post(`/painel/campanhas/${campanha}/status`, { acao: 'enviar' }, master);
    assert.equal((await api.post(`/painel/campanhas/${campanha}/status`, { acao: 'aprovar' }, master)).dados.status, 'ativa');
  });

  await t.test('o síndico publica um comunicado e ele só entra na tela depois de aprovado', async () => {
    const acesso = await api.post(`/painel/locais/${predio}/acesso`, { nome: 'Paulo Rocha', email: 'paulo@acacias.com.br' }, master);
    sindico = await api.login('paulo@acacias.com.br', acesso.dados.senha_provisoria);

    const c = await api.post('/ponto/comunicados', {
      titulo: 'Assembleia geral dia 12', texto: 'Às 19h no salão de festas. Pauta: previsão orçamentária.',
      tipo: 'assembleia', inicio: dia(0), fim: dia(10),
    }, sindico);
    assert.equal(c.status, 201, JSON.stringify(c.dados));
    comunicado = c.dados.id;
    assert.equal(c.dados.status, 'pendente', 'por padrão, a equipe confere antes');

    const antes = (await api.get(`/painel/grade/${elevador}`, master)).dados;
    assert.ok(!antes.itens.some((i) => i.formato === 'comunicado'), 'comunicado pendente não vai para a tela');

    const fila = (await api.get('/painel/comunicados?status=pendente', master)).dados;
    assert.equal(fila.itens.length, 1);
    assert.equal(fila.itens[0].local_nome, 'Edifício Jardim das Acácias');

    assert.equal((await api.post(`/painel/comunicados/${comunicado}/aprovacao`, { decisao: 'aprovar' }, master)).dados.status, 'aprovado');

    const depois = (await api.get(`/painel/grade/${elevador}`, master)).dados;
    const item = depois.itens.find((i) => i.formato === 'comunicado');
    assert.ok(item, 'depois de aprovado, o comunicado entra no carrossel');
    assert.equal(item.titulo, 'Assembleia geral dia 12');
    assert.equal(item.midia_id, null, 'o player desenha o comunicado, não baixa arquivo');
    assert.ok(depois.itens.some((i) => i.campanha_id === campanha), 'a publicidade continua no loop');
    assert.notEqual(depois.versao, antes.versao, 'a grade muda de versão e a TV baixa de novo');

    // O comunicado é só daquele prédio.
    const noMercado = (await api.get(`/painel/grade/${caixa}`, master)).dados;
    assert.ok(!noMercado.itens.some((i) => i.formato === 'comunicado'), 'o recado do prédio não aparece em outro ponto');
  });

  await t.test('tela dividida: o comunicado sai do carrossel e fica na zona ao lado', async () => {
    // Antes: tela cheia, comunicado intercalado entre os anúncios.
    const cheia = (await api.get(`/painel/grade/${elevador}`, master)).dados;
    assert.ok(cheia.itens.some((i) => i.formato === 'comunicado'));
    assert.equal(cheia.layout, 'cheia');
    assert.deepEqual(cheia.comunicados, []);

    const r = await api.patch(`/painel/telas/${elevador}`, { layout: 'dividida' }, master);
    assert.equal(r.status, 200, JSON.stringify(r.dados));

    const dividida = (await api.get(`/painel/grade/${elevador}`, master)).dados;
    assert.equal(dividida.layout, 'dividida');
    assert.ok(!dividida.itens.some((i) => i.formato === 'comunicado'), 'o carrossel fica só com publicidade');
    assert.equal(dividida.comunicados.length, 1, 'o comunicado passa para a zona própria');
    assert.equal(dividida.comunicados[0].titulo, 'Assembleia geral dia 12');
    assert.equal(dividida.ponto.nome, 'Edifício Jardim das Acácias');
    assert.equal(dividida.ponto.assinatura, 'Administração / Síndico — Edifício Jardim das Acácias');
    assert.notEqual(dividida.versao, cheia.versao, 'mudar o layout muda a versão e a TV baixa de novo');
  });

  await t.test('logo da administradora aparece no comunicado', async () => {
    await api.patch(`/painel/locais/${predio}`, { administradora: 'Administra Bem', assinatura: 'Administração / Síndico — Acácias' }, master);
    const envio = await api.enviarArquivo(`/painel/locais/${predio}/logo`, png(420, 120), master);
    assert.equal(envio.status, 201, JSON.stringify(envio.dados));

    const g = (await api.get(`/painel/grade/${elevador}`, master)).dados;
    assert.equal(g.ponto.logo, true);
    assert.equal(g.ponto.administradora, 'Administra Bem');
    assert.equal(g.ponto.assinatura, 'Administração / Síndico — Acácias');

    const arquivo = await fetch(`${api.base}/painel/locais/${predio}/logo`, { headers: { Authorization: `Bearer ${master}` } });
    assert.equal(arquivo.status, 200);
    assert.equal(arquivo.headers.get('content-type'), 'image/png');

    // Texto não vale como logo.
    assert.equal((await api.enviarArquivo(`/painel/locais/${predio}/logo`, Buffer.from('não é imagem'), master)).status, 415);
  });

  await t.test('a TV exibe o comunicado e isso entra na prova de exibição', async () => {
    const tv = api.aparelho();
    const reg = await tv.registrar({ aparelho: 'Mini PC do elevador', largura: 1080, altura: 1920, versao: '1.0' });
    await api.post('/painel/telas/parear', { codigo: reg.dados.codigo, tela_id: elevador }, master);
    tv.usar((await tv.pareamento(reg.dados.codigo)).dados.token);

    const prog = await tv.programacao();
    // A tela agora é dividida: o comunicado vem na zona, não no carrossel.
    const item = prog.dados.grade.comunicados[0];
    assert.equal(item.texto, 'Às 19h no salão de festas. Pauta: previsão orçamentária.');
    assert.equal(prog.dados.grade.ponto.nome, 'Edifício Jardim das Acácias');
    assert.equal(prog.dados.grade.ponto.logo, true);

    const logo = await fetch(`${api.base}/player/logo`, { headers: { Authorization: `Bearer ${tv.token}` } });
    assert.equal(logo.status, 200, 'a TV baixa a logo da administradora');

    const agora = Date.now();
    const r = await tv.exibicoes([
      { comunicado_id: comunicado, exibida_em: new Date(agora - 60_000).toISOString(), duracao_s: 10 },
      { midia_id: cartaz, campanha_id: campanha, exibida_em: new Date(agora - 40_000).toISOString(), duracao_s: 12 },
      { comunicado_id: 9999, exibida_em: new Date(agora - 20_000).toISOString(), duracao_s: 10 },
    ]);
    assert.equal(r.dados.gravadas, 2);
    assert.equal(r.dados.ignoradas, 1, 'comunicado de outro ponto é descartado');

    const prova = (await api.get(`/painel/relatorios/prova?de=${dia(0)}&ate=${dia(0)}&tela_id=${elevador}`, master)).dados;
    assert.equal(prova.total, 2);
    assert.ok(prova.itens.some((x) => x.campanha === 'Institucional'), 'o comunicado aparece como exibição não vendida');
  });

  await t.test('fatura mostra bruto, comissão da agência e líquido; condomínio sem repasse não gera repasse', async () => {
    const competencia = dia(0).slice(0, 7);
    const previa = (await api.get(`/painel/faturamento?competencia=${competencia}`, master)).dados;
    const f = previa.previa[0];
    assert.equal(f.agencia, 'Ponto Alto Publicidade');
    assert.ok(f.bruto_centavos > 0);
    assert.equal(f.comissao_agencia_centavos, Math.round(f.bruto_centavos * 0.2));
    assert.equal(f.valor_centavos, f.bruto_centavos - f.comissao_agencia_centavos);

    const g = await api.post('/painel/faturamento/gerar', { competencia }, master);
    assert.equal(g.status, 201);
    assert.equal(g.dados.repasses, 0, 'o condomínio combinou sem repasse em dinheiro');

    const fatura = (await api.get(`/painel/faturas/${(await api.get('/painel/faturas', master)).dados.itens[0].id}`, master)).dados;
    assert.equal(fatura.agencia, 'Ponto Alto Publicidade');
    assert.match(fatura.itens[0].descricao, /PI-2026-4471/);
  });

  await t.test('condomínio com valor fixo por mês gera repasse mesmo sem comissão', async () => {
    const outro = (await api.post('/painel/locais', {
      nome: 'Residencial Vista Verde', categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP', publico_dia: 1240, unidades: 128,
      repasse_tipo: 'fixo', repasse_fixo_centavos: 30_000,
    }, master)).dados.id;
    const tela = (await api.post('/painel/telas', { local_id: outro, nome: 'Elevador', orientacao: 'retrato' }, master)).dados.id;

    // A tela precisa ter exibido alguma coisa no mês para o fixo ser devido.
    const tv = api.aparelho();
    const reg = await tv.registrar();
    await api.post('/painel/telas/parear', { codigo: reg.dados.codigo, tela_id: tela }, master);
    tv.usar((await tv.pareamento(reg.dados.codigo)).dados.token);
    await tv.exibicoes([{ midia_id: cartaz, campanha_id: campanha, exibida_em: new Date().toISOString(), duracao_s: 12 }]);

    const competencia = dia(0).slice(0, 7);
    const r = (await api.get(`/painel/faturamento?competencia=${competencia}`, master)).dados.repasses;
    const fixo = r.find((x) => x.local === 'Residencial Vista Verde');
    assert.ok(fixo, 'o ponto com valor fixo entra no repasse');
    assert.equal(fixo.tipo, 'fixo');
    assert.equal(fixo.valor_centavos, 30_000);
    assert.ok(!r.some((x) => x.local === 'Edifício Jardim das Acácias'), 'o ponto sem repasse continua de fora');
  });

  await t.test('inventário mostra a rede para o comercial vender', async () => {
    const inv = (await api.get('/painel/inventario', master)).dados;
    assert.equal(inv.totais.pontos, 3);
    assert.equal(inv.totais.unidades, 96 + 128);
    assert.ok(inv.itens.some((p) => p.posicoes.includes('Elevador social')));
    assert.equal(inv.circuitos[0].nome, 'Residencial Campinas');
    assert.equal(inv.circuitos[0].telas, 2, 'o circuito cresce sozinho quando entra um condomínio novo');

    const csv = await api.get('/painel/inventario?csv=1', master);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.dados, /Edifício Jardim das Acácias/);
  });
});
