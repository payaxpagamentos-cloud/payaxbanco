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

  await t.test('proposta comercial sai do circuito com números do que está cadastrado', async () => {
    const p = (await api.get(`/painel/circuitos/${circuito}/proposta?anunciante_id=${anunciante}&meses=6&desconto_percentual=1000&validade_dias=20`, master)).dados;

    assert.equal(p.anunciante.nome, 'Construtora Aurora');
    assert.equal(p.circuito.telas, 2, 'os dois condomínios do circuito');
    assert.equal(p.circuito.unidades, 96 + 128);
    assert.equal(p.pontos.length, 2);
    assert.equal(p.valida_ate, dia(20));

    // O condomínio tem horário 00:00–23:59, então são ~24 h por dia no ar.
    const jardim = p.pontos.find((x) => x.nome.startsWith('Edifício Jardim'));
    assert.ok(jardim.horas_dia >= 23.9, `horas no ar por dia: ${jardim.horas_dia}`);
    assert.equal(jardim.insercoes_mes, Math.round(1 * 8 * jardim.horas_dia * 30), '1 tela × 8 por hora × horas × 30 dias');
    assert.equal(p.veiculacao.insercoes_mes, p.pontos.reduce((t, x) => t + x.insercoes_mes, 0));
    assert.equal(p.veiculacao.insercoes_periodo, p.veiculacao.insercoes_mes * 6);

    // 8 inserções por hora de 12 s = 96 s de 3600, ou seja, 2,67% do tempo de tela.
    assert.equal(p.veiculacao.share_percentual, Math.round((8 * 12 / 3600) * 10_000));

    assert.equal(p.investimento.tabela_mes_centavos, 350_000);
    assert.equal(p.investimento.mes_centavos, 315_000, '10% de desconto');
    assert.equal(p.investimento.total_centavos, 315_000 * 6);
    assert.equal(p.investimento.cpm_centavos, Math.round(315_000 / (p.veiculacao.impactos_mes / 1000)));

    assert.equal((await api.get('/painel/circuitos/9999/proposta', master)).status, 404);
    assert.equal((await api.get(`/painel/circuitos/${circuito}/proposta?meses=99`, master)).status, 422);
  });

  await t.test('a proposta fica guardada e, aceita, vira contrato e campanha', async () => {
    const nova = await api.post('/painel/propostas', {
      circuito_id: circuito, anunciante_id: anunciante, meses: 6, desconto_percentual: 1000, validade_dias: 20,
      observacao: 'Produção da peça incluída.',
    }, master);
    assert.equal(nova.status, 201, JSON.stringify(nova.dados));
    const p = nova.dados;
    assert.match(p.numero, /^P-\d{4}-001$/);
    assert.equal(p.status, 'rascunho');
    assert.equal(p.mes_centavos, 315_000, '10% de desconto sobre os 3.500,00 de tabela');
    assert.equal(p.total_centavos, 315_000 * 6);
    assert.equal(p.folha.circuito.telas, 2, 'a folha guarda o cálculo do dia');

    const funil = (await api.get('/painel/propostas', master)).dados;
    assert.equal(funil.totais.rascunho, 1);
    assert.equal(funil.totais.na_mesa_centavos, 0, 'rascunho ainda não está na mesa do cliente');

    assert.equal((await api.post(`/painel/propostas/${p.id}/aceitar`, {}, master)).status, 200, 'aceitar direto do rascunho é permitido');
    const aceita = (await api.get(`/painel/propostas/${p.id}`, master)).dados;
    assert.equal(aceita.status, 'aceita');

    // O contrato nasceu com o que foi vendido, e a campanha com as telas do circuito.
    const contrato = (await api.get(`/painel/contratos/${aceita.contrato_id}`, master)).dados;
    assert.equal(contrato.valor_centavos, 315_000);
    assert.equal(contrato.anunciante, 'Construtora Aurora');
    assert.equal(contrato.campanhas.length, 1);
    const campanha = (await api.get(`/painel/campanhas/${aceita.campanha_id}`, master)).dados;
    assert.equal(campanha.status, 'rascunho', 'falta o criativo: quem aprova é a equipe');
    assert.equal(campanha.valor_centavos, 315_000);
    assert.equal(campanha.alvos.length, 1, 'herdou o alvo do circuito');

    assert.equal((await api.post(`/painel/propostas/${p.id}/aceitar`, {}, master)).status, 409, 'não aceita duas vezes');
    assert.equal((await api.del(`/painel/propostas/${p.id}`, {}, master)).status, 409, 'proposta que virou contrato não se apaga');

    const depois = (await api.get('/painel/propostas', master)).dados;
    assert.equal(depois.totais.aceitas, 1);
    assert.equal(depois.totais.fechado_centavos, 315_000 * 6);
    assert.equal(depois.totais.conversao_percentual, 10_000, '1 de 1 respondida');
  });

  await t.test('a proposta tem um link público para mandar no WhatsApp', async () => {
    const p = (await api.post('/painel/propostas', { circuito_id: circuito, anunciante_id: anunciante, meses: 3 }, master)).dados;
    assert.match(p.link_token, /^[0-9a-f]{32}$/, 'o link nasce com a proposta e é difícil de adivinhar');
    assert.equal(p.aberturas, 0);

    // Quem recebe o link vê a folha, sem login.
    const publica = (await api.get(`/publico/proposta/${p.link_token}`)).dados;
    assert.equal(publica.numero, p.numero);
    assert.equal(publica.expirada, false);
    assert.equal(publica.folha.circuito.nome, 'Residencial Campinas');
    assert.ok(!JSON.stringify(publica).includes('link_token'), 'a página pública não devolve o próprio token');

    // E a equipe sabe que ele abriu (e quando).
    const depois = (await api.get(`/painel/propostas/${p.id}`, master)).dados;
    assert.equal(depois.aberturas, 1);
    assert.ok(depois.aberta_em);

    assert.equal((await api.get('/publico/proposta/naoexiste')).status, 404);
    await api.post(`/painel/propostas/${p.id}/recusar`, { motivo: 'desistiu' }, master);
    assert.equal((await api.get(`/publico/proposta/${p.link_token}`)).status, 410, 'proposta recusada sai do ar');
  });

  await t.test('o WhatsApp da empresa chega a quem abre a proposta e o site', async () => {
    await api.put('/painel/configuracoes', { whatsapp: '19999990000' }, master);
    assert.equal((await api.get('/publico')).dados.whatsapp, '19999990000', 'o site e os portais pegam o número daqui');

    const p = (await api.post('/painel/propostas', { circuito_id: circuito, anunciante_id: anunciante, meses: 1 }, master)).dados;
    assert.equal((await api.get(`/publico/proposta/${p.link_token}`)).dados.whatsapp, '19999990000',
      'quem abre a proposta pelo link responde pelo WhatsApp dali mesmo');

    await api.put('/painel/configuracoes', { whatsapp: '' }, master);
    assert.equal((await api.get('/publico')).dados.whatsapp, null, 'sem número cadastrado, nada de WhatsApp aparece');
  });

  await t.test('a folha guardada não muda quando a rede muda', async () => {
    const p = (await api.post('/painel/propostas', { circuito_id: circuito, meses: 1 }, master)).dados;
    const telasNaEpoca = p.folha.circuito.telas;

    // Entra um condomínio novo, que o circuito alcança pela regra de categoria.
    const novo = (await api.post('/painel/locais', { nome: 'Edifício Depois', categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP', publico_dia: 500 }, master)).dados.id;
    await api.post('/painel/telas', { local_id: novo, nome: 'Hall', orientacao: 'retrato' }, master);

    const relida = (await api.get(`/painel/propostas/${p.id}`, master)).dados;
    assert.equal(relida.folha.circuito.telas, telasNaEpoca, 'reimprimir mostra o que foi oferecido, não o inventário de hoje');
    const agora = (await api.get(`/painel/circuitos/${circuito}/proposta`, master)).dados;
    assert.equal(agora.circuito.telas, telasNaEpoca + 1, 'a prévia de hoje já conta a tela nova');

    assert.equal((await api.post(`/painel/propostas/${p.id}/aceitar`, {}, master)).status, 422, 'sem cliente não dá para fazer contrato');
    assert.equal((await api.post(`/painel/propostas/${p.id}/recusar`, { motivo: 'Ficou para o ano que vem' }, master)).dados.status, 'recusada');
    assert.equal((await api.post(`/painel/propostas/${p.id}/reabrir`, {}, master)).dados.status, 'rascunho');
    assert.equal((await api.del(`/painel/propostas/${p.id}`, {}, master)).status, 204);
  });
});

/** Os avisos automáticos: é o que faz a equipe saber da queda antes do síndico ligar. */
test('Avisos por e-mail: tela fora do ar, fatura vencida e fila parada', async (t) => {
  const { iniciar: iniciarApi, png: imagem, dia: diaRel } = require('./helpers');
  const email = require('../server/lib/email');
  const avisos = require('../server/lib/avisos');
  const { manutencao } = require('../server/lib/monitor');

  const api = await iniciarApi();
  t.after(api.fechar);
  const master = await api.login();
  email.caixaTeste.length = 0;

  const ponto = (await api.post('/painel/locais', { nome: 'Edifício Aviso', categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP' }, master)).dados.id;
  const tela = (await api.post('/painel/telas', { local_id: ponto, nome: 'Elevador' }, master)).dados.id;

  await t.test('tela que para de responder vira e-mail para a equipe — uma vez por queda', async () => {
    // A tela pareia, responde e some (o último contato fica para trás).
    const tv = api.aparelho();
    const reg = await tv.registrar();
    await api.post('/painel/telas/parear', { codigo: reg.dados.codigo, tela_id: tela }, master);
    tv.usar((await tv.pareamento(reg.dados.codigo)).dados.token);
    await tv.batida({});

    api.db.prepare("UPDATE telas SET ultimo_contato = ? WHERE id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), tela);
    manutencao(api.db);

    const r = await avisos.telasForaDoAr(api.db);
    assert.equal(r.enviados, 1);
    const aviso = email.caixaTeste.at(-1);
    assert.match(aviso.assunto, /Tela fora do ar: Edifício Aviso/);
    assert.ok(aviso.para.includes('master@midia.com.br'), 'vai para quem opera a rede');

    const repetido = await avisos.telasForaDoAr(api.db);
    assert.equal(repetido.enviados, 0, 'a mesma queda não vira e-mail toda hora');
  });

  await t.test('fatura vencida avisa o anunciante e resume para a equipe', async () => {
    const anunciante = (await api.post('/painel/anunciantes', { nome: 'Loja Atrasada', email: 'financeiro@lojaatrasada.com.br' }, master)).dados.id;
    api.db.prepare(`INSERT INTO faturas (anunciante_id, competencia, vencimento, valor_centavos, criado_em)
      VALUES (?, '2026-09', ?, 120000, ?)`).run(anunciante, diaRel(-10), new Date().toISOString());

    email.caixaTeste.length = 0;
    const r = await avisos.faturasVencidas(api.db);
    assert.equal(r.enviados, 1);
    assert.ok(email.caixaTeste.some((m) => m.para.includes('financeiro@lojaatrasada.com.br')), 'o anunciante é avisado');
    assert.ok(email.caixaTeste.some((m) => /vencida/i.test(m.assunto) && m.para.includes('master@midia.com.br')), 'a equipe recebe o resumo');

    email.caixaTeste.length = 0;
    assert.equal((await avisos.faturasVencidas(api.db)).enviados, 0, 'é um aviso por dia, não a cada hora');
  });

  await t.test('fila de aprovação parada há mais de um dia vira aviso', async () => {
    const anunciante = (await api.post('/painel/anunciantes', { nome: 'Nova Marca' }, master)).dados.id;
    const m = await api.enviarArquivo(`/painel/midias?nome=Parado&anunciante_id=${anunciante}`, imagem(800, 600), master);
    api.db.prepare('UPDATE midias SET criado_em = ? WHERE id = ?').run(new Date(Date.now() - 48 * 3_600_000).toISOString(), m.dados.id);

    email.caixaTeste.length = 0;
    assert.equal((await avisos.filaDeAprovacao(api.db)).enviados, 1);
    assert.match(email.caixaTeste.at(-1).assunto, /esperando aprovação/);
  });

  await t.test('desligar os avisos nas configurações para tudo', async () => {
    await api.put('/painel/configuracoes', { avisos_email: 0 }, master);
    email.caixaTeste.length = 0;
    const r = await avisos.rodar(api.db);
    assert.equal(r.ligado, false);
    assert.equal(email.caixaTeste.length, 0);
  });

  await t.test('o painel diz se o e-mail está de pé e manda um teste', async () => {
    const c = (await api.get('/painel/configuracoes', master)).dados;
    assert.equal(c.email.configurado, true, 'no modo de teste o envio está ligado');
    assert.ok(c.email.equipe >= 1);
    const teste = await api.post('/painel/configuracoes/email-teste', { para: 'quem.opera@exemplo.com' }, master);
    assert.equal(teste.status, 200);
    assert.equal(teste.dados.enviado, true);
  });
});

/** Recuperação de senha: o síndico que esquece a senha não pode depender de telefonar para a equipe. */
test('Esqueci minha senha: link de uso único por e-mail', async (t) => {
  const { iniciar: iniciarApi } = require('./helpers');
  const email = require('../server/lib/email');
  const api = await iniciarApi();
  t.after(api.fechar);
  const master = await api.login();
  email.caixaTeste.length = 0;

  const ponto = (await api.post('/painel/locais', { nome: 'Edifício Senha', categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP' }, master)).dados.id;
  await api.post(`/painel/locais/${ponto}/acesso`, { nome: 'Síndica Rita', email: 'rita@edificiosenha.com.br' }, master);

  await t.test('pedir o link não revela se a conta existe', async () => {
    const existe = await api.post('/auth/recuperar', { email: 'rita@edificiosenha.com.br' });
    const naoExiste = await api.post('/auth/recuperar', { email: 'ninguem@lugar-nenhum.com' });
    assert.equal(existe.status, 200);
    assert.deepEqual(existe.dados, naoExiste.dados, 'mesma resposta nos dois casos');
    assert.equal(email.caixaTeste.length, 1, 'só quem existe recebe e-mail');
  });

  await t.test('o link troca a senha uma vez só', async () => {
    const link = /#\/nova-senha\/([A-Za-z0-9_-]+)/.exec(email.caixaTeste.at(-1).html);
    assert.ok(link, 'o e-mail traz o link com o código');
    const codigo = link[1];

    assert.equal((await api.post('/auth/nova-senha', { codigo, senha: 'curta' })).status, 422);
    const r = await api.post('/auth/nova-senha', { codigo, senha: 'senha-nova-da-rita' });
    assert.equal(r.status, 200);
    assert.equal(r.dados.email, 'rita@edificiosenha.com.br');

    const tk = await api.login('rita@edificiosenha.com.br', 'senha-nova-da-rita');
    assert.ok(tk, 'entra com a senha nova');
    assert.equal((await api.post('/auth/nova-senha', { codigo, senha: 'outra-senha-qualquer' })).status, 410, 'o mesmo link não serve de novo');
  });

  await t.test('link vencido não vale', async () => {
    await api.post('/auth/recuperar', { email: 'rita@edificiosenha.com.br' });
    const codigo = /#\/nova-senha\/([A-Za-z0-9_-]+)/.exec(email.caixaTeste.at(-1).html)[1];
    api.db.prepare("UPDATE senha_pedidos SET expira_em = ? WHERE usado_em IS NULL").run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await api.post('/auth/nova-senha', { codigo, senha: 'mais-uma-senha' })).status, 410);
  });

  await t.test('pedir de novo invalida o link anterior', async () => {
    await api.post('/auth/recuperar', { email: 'rita@edificiosenha.com.br' });
    const antigo = /#\/nova-senha\/([A-Za-z0-9_-]+)/.exec(email.caixaTeste.at(-1).html)[1];
    await api.post('/auth/recuperar', { email: 'rita@edificiosenha.com.br' });
    assert.equal((await api.post('/auth/nova-senha', { codigo: antigo, senha: 'senha-do-link-velho' })).status, 410);
  });
});

/** Contratos na ficha do cliente e o financeiro em duas pontas: o que entra e o que sai. */
test('Financeiro: contrato do cliente, contas a receber e contas a pagar', async (t) => {
  const { iniciar: iniciarApi, dia: diaRel } = require('./helpers');
  const api = await iniciarApi();
  t.after(api.fechar);
  const master = await api.login();
  let cliente, contrato, ponto;

  await t.test('contrato fica na ficha do cliente e amarra as campanhas dele', async () => {
    cliente = (await api.post('/painel/anunciantes', { nome: 'Construtora Horizonte', email: 'financeiro@horizonte.com.br' }, master)).dados.id;
    const outro = (await api.post('/painel/anunciantes', { nome: 'Outro Cliente' }, master)).dados.id;

    const c = await api.post('/painel/contratos', {
      anunciante_id: cliente, numero: '2026-014', objeto: 'Veiculação no circuito residencial',
      inicio: diaRel(-30), fim: diaRel(335), cobranca: 'mensal', valor_centavos: 350_000, vencimento_dia: 10,
      reajuste: 'IPCA a cada 12 meses', renovacao_automatica: true,
    }, master);
    assert.equal(c.status, 201, JSON.stringify(c.dados));
    contrato = c.dados.id;
    assert.equal(c.dados.status, 'ativo');
    assert.equal((await api.post('/painel/contratos', { anunciante_id: cliente, numero: '2026-014', inicio: diaRel(0) }, master)).status, 409,
      'número de contrato não se repete');

    const campanha = (await api.post('/painel/campanhas', {
      anunciante_id: cliente, nome: 'Lançamento', inicio: diaRel(-10), cobranca: 'mensal', valor_centavos: 350_000,
    }, master)).dados.id;
    assert.equal((await api.post(`/painel/contratos/${contrato}/campanhas`, { campanha_id: campanha }, master)).status, 200);

    const doOutro = (await api.post('/painel/campanhas', { anunciante_id: outro, nome: 'De outro', inicio: diaRel(0), cobranca: 'cortesia' }, master)).dados.id;
    assert.equal((await api.post(`/painel/contratos/${contrato}/campanhas`, { campanha_id: doOutro }, master)).status, 422,
      'campanha de outro cliente não entra no contrato');

    const ficha = (await api.get(`/painel/anunciantes/${cliente}`, master)).dados;
    assert.equal(ficha.contratos.length, 1);
    assert.equal(ficha.contratos[0].campanhas, 1);
    assert.equal(ficha.campanhas[0].contrato, '2026-014', 'a campanha mostra o contrato dela');
  });

  await t.test('contas a receber: faturas com atraso por faixa', async () => {
    const inserir = api.db.prepare(`INSERT INTO faturas (anunciante_id, contrato_id, competencia, vencimento, valor_centavos, status, pago_em, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    inserir.run(cliente, contrato, '2026-08', diaRel(-100), 350_000, 'aberta', null, new Date().toISOString());
    inserir.run(cliente, contrato, '2026-09', diaRel(-40), 350_000, 'aberta', null, new Date().toISOString());
    inserir.run(cliente, contrato, '2026-10', diaRel(-5), 350_000, 'paga', diaRel(-4), new Date().toISOString());
    inserir.run(cliente, contrato, '2026-11', diaRel(5), 350_000, 'aberta', null, new Date().toISOString());

    const d = (await api.get('/painel/contas-a-receber', master)).dados;
    assert.equal(d.totais.aberto_centavos, 1_050_000);
    assert.equal(d.totais.atrasado_centavos, 700_000, 'as duas vencidas');
    assert.equal(d.totais.recebido_centavos, 350_000);
    assert.equal(d.totais.vence_em_7_centavos, 350_000, 'a que vence daqui a 5 dias');
    assert.equal(d.totais.clientes_em_atraso, 1);
    assert.equal(d.atraso.de_31_a_60, 350_000);
    assert.equal(d.atraso.mais_de_90, 350_000);
    assert.equal(d.itens.find((f) => f.competencia === '2026-08').dias_atraso, 100);
    assert.equal(d.itens[0].contrato, '2026-014', 'a fatura mostra de qual contrato veio');

    const so = (await api.get('/painel/contas-a-receber?status=paga', master)).dados;
    assert.equal(so.itens.length, 1);
  });

  await t.test('o financeiro do cliente aparece na ficha dele', async () => {
    const ficha = (await api.get(`/painel/anunciantes/${cliente}`, master)).dados;
    assert.equal(ficha.financeiro.aberto_centavos, 1_050_000);
    assert.equal(ficha.financeiro.atrasado_centavos, 700_000);
    assert.equal(ficha.financeiro.recebido_centavos, 350_000);
    assert.equal(ficha.financeiro.proxima.competencia, '2026-08', 'a mais antiga em aberto é a próxima a cobrar');
    assert.equal(ficha.pagamentos.length, 1);
    assert.equal(ficha.pagamentos[0].pago_em, diaRel(-4));
  });

  await t.test('contas a pagar junta repasse do ponto com despesa da operação', async () => {
    ponto = (await api.post('/painel/locais', { nome: 'Edifício Pagar', categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP' }, master)).dados.id;
    api.db.prepare(`INSERT INTO repasses (local_id, competencia, tipo, base_centavos, comissao_percentual, valor_centavos, criado_em)
      VALUES (?, '2026-10', 'fixo', 0, 0, 30000, ?)`).run(ponto, new Date().toISOString());

    const nova = await api.post('/painel/despesas', {
      descricao: 'Internet do Edifício Pagar', fornecedor: 'Provedor X', categoria: 'internet',
      local_id: ponto, vencimento: diaRel(-3), valor_centavos: 12_000, repete_meses: 2,
    }, master);
    assert.equal(nova.status, 201);
    assert.equal(nova.dados.criadas, 3, 'repetir cria uma conta por mês');

    const d = (await api.get('/painel/contas-a-pagar', master)).dados;
    assert.equal(d.itens.filter((x) => x.tipo === 'repasse').length, 1);
    assert.equal(d.itens.filter((x) => x.tipo === 'despesa').length, 3);
    assert.equal(d.totais.repasses_centavos, 30_000);
    assert.equal(d.totais.despesas_centavos, 36_000);
    // Atrasado = a primeira parcela da internet (venceu há 3 dias) + o repasse de 2026-10, que vence no dia 10 do mês seguinte.
    const repasseVencido = d.itens.find((x) => x.tipo === 'repasse').atrasada ? 30_000 : 0;
    assert.equal(d.totais.atrasado_centavos, 12_000 + repasseVencido);

    const atrasada = d.itens.find((x) => x.tipo === 'despesa' && x.atrasada);
    assert.equal((await api.post(`/painel/despesas/${atrasada.id}/pagar`, { pago_em: diaRel(0) }, master)).dados.status, 'paga');
    assert.equal((await api.post(`/painel/despesas/${atrasada.id}/pagar`, {}, master)).status, 409, 'não paga duas vezes');
    assert.equal((await api.post(`/painel/despesas/${atrasada.id}/estornar`, {}, master)).dados.status, 'aberta');

    const repasse = d.itens.find((x) => x.tipo === 'repasse');
    assert.equal((await api.post(`/painel/repasses/${repasse.id}/pagar`, {}, master)).dados.status, 'pago');
    const depois = (await api.get('/painel/contas-a-pagar?status=aberta', master)).dados;
    assert.ok(!depois.itens.some((x) => x.tipo === 'repasse'), 'repasse pago sai da lista de abertas');
  });

  await t.test('fluxo de caixa junta o que entrou com o que saiu', async () => {
    // No período: a fatura de 2026-10 (recebida há 4 dias), a despesa paga hoje e o repasse pago hoje.
    const de = diaRel(-10);
    const ate = diaRel(0);
    const d = (await api.get(`/painel/fluxo-caixa?de=${de}&ate=${ate}`, master)).dados;

    assert.equal(d.realizado.recebido_centavos, 350_000, 'a fatura paga há 4 dias');
    assert.equal(d.realizado.pago_centavos, 30_000, 'o repasse de 30,00 pago hoje (a despesa foi estornada)');
    assert.equal(d.realizado.saldo_centavos, 320_000);
    assert.equal(d.previsto.a_receber_centavos, 0, 'as faturas em aberto vencem fora deste período');
    assert.equal(d.projetado_centavos, d.realizado.saldo_centavos + d.previsto.saldo_centavos);

    const entrada = d.movimentos.find((m) => m.tipo === 'entrada');
    assert.match(entrada.descricao, /^Fatura 2026-10/);
    assert.equal(d.saidas_por_categoria[0].categoria, 'repasse');
    assert.ok(d.por_mes.some((m) => m.entrou === 350_000), 'a série mensal traz o mês do recebimento');

    const csv = await api.get(`/painel/fluxo-caixa?de=${de}&ate=${ate}&csv=1`, master);
    assert.match(csv.dados.split('\r\n')[0], /Data;Tipo;Origem/);
    assert.match(csv.dados, /Entrada;fatura/);
    assert.match(csv.dados, /-300,00/, 'a saída sai com sinal negativo na planilha');
  });

  await t.test('o anunciante vê o contrato dele no portal, só para ler', async () => {
    const acesso = await api.post(`/painel/anunciantes/${cliente}/acesso`, { nome: 'Dona do contrato', email: 'contrato@exemplo.com' }, master);
    const tk = await api.login('contrato@exemplo.com', acesso.dados.senha_provisoria);

    const d = (await api.get('/anunciante/faturas', tk)).dados;
    assert.equal(d.contratos.length, 1);
    const c = d.contratos[0];
    assert.equal(c.numero, '2026-014');
    assert.equal(c.vencimento_dia, 10);
    assert.ok(c.inicio && 'reajuste' in c && 'renovacao_automatica' in c, 'vigência, reajuste e renovação aparecem');
    assert.equal(c.campanhas, 1);
    assert.equal(d.itens[0].contrato, '2026-014', 'cada fatura mostra de qual contrato veio');

    // Só para ler: o portal não tem rota de escrita de contrato, e o contrato de outro cliente não aparece.
    assert.equal((await api.post('/anunciante/contratos', { numero: 'X' }, tk)).status, 404);
    assert.ok(d.contratos.every((x) => x.numero === '2026-014'));
  });

  await t.test('nota fiscal: o painel registra o número, não emite a nota', async () => {
    const fatura = (await api.get('/painel/contas-a-receber?status=paga', master)).dados.itens[0];
    assert.equal(fatura.nf_numero, null, 'nasce sem nota');

    const faltando = (await api.get('/painel/notas-fiscais?emitida=nao', master)).dados;
    assert.equal(faltando.emissao_automatica, false, 'a emissão depende de certificado digital e da prefeitura');
    assert.equal(faltando.totais.sem_nota, faltando.itens.length);
    assert.match(faltando.itens[0].servico, /Veicula..o de publicidade em m.dia digital indoor — \w+\/\d{4}/);

    assert.equal((await api.put(`/painel/faturas/${fatura.id}/nota`, { nf_numero: '2026/0001', nf_link: 'ftp://x' }, master)).status, 422,
      'link precisa ser http(s)');
    const nota = await api.put(`/painel/faturas/${fatura.id}/nota`, {
      nf_numero: '2026/0001', nf_emitida_em: diaRel(-3), nf_link: 'https://nfse.campinas.sp.gov.br/nota/2026-0001',
    }, master);
    assert.equal(nota.status, 200);
    assert.equal(nota.dados.nf_numero, '2026/0001');

    const comNota = (await api.get('/painel/contas-a-receber?nota=sim', master)).dados;
    assert.equal(comNota.itens.length, 1);
    assert.ok((await api.get('/painel/contas-a-receber?nota=nao', master)).dados.itens.every((f) => !f.nf_numero));

    const csv = await api.get('/painel/notas-fiscais?emitida=nao&csv=1', master);
    assert.match(csv.dados.split('\r\n')[0], /Compet.ncia;Tomador;CNPJ \/ CPF;E-mail;Discrimina..o do servi.o/);
    assert.ok(!csv.dados.includes('2026/0001'), 'a planilha do contador traz só o que ainda falta emitir');

    assert.equal((await api.del(`/painel/faturas/${fatura.id}/nota`, {}, master)).dados.nf_numero, null);
  });

  await t.test('contas a receber e a pagar saem em CSV', async () => {
    const receber = await api.get('/painel/contas-a-receber?csv=1', master);
    assert.match(receber.headers.get('content-type'), /text\/csv/);
    assert.match(receber.dados.split('\r\n')[0], /Compet.ncia;Cliente;Ag.ncia;Contrato/);
    assert.match(receber.dados, /3500,00/);

    const pagar = await api.get('/painel/contas-a-pagar?csv=1', master);
    assert.match(pagar.dados.split('\r\n')[0], /Vencimento;Tipo;Descri..o/);
    assert.match(pagar.dados, /Repasse ao ponto/);
  });
});

/**
 * A tela do condomínio não vive só de anúncio: o que faz o morador olhar de novo amanhã é a
 * informação útil — o que vem pela frente no prédio e a temperatura de hoje.
 */
test('Conteúdo útil na tela: agenda do prédio e clima do dia', async (t) => {
  const { iniciar: iniciarApi, dia: diaRel } = require('./helpers');
  const api = await iniciarApi();
  t.after(api.fechar);
  const master = await api.login();
  const grade = require('../server/lib/grade');
  const clima = require('../server/lib/clima');

  const ponto = (await api.post('/painel/locais', {
    nome: 'Edifício Agenda', categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP', publico_dia: 600,
  }, master)).dados.id;
  const tela = (await api.post('/painel/telas', { local_id: ponto, nome: 'Elevador', orientacao: 'retrato', layout: 'dividida' }, master)).dados.id;

  await t.test('comunicado com data entra na agenda, em ordem', async () => {
    const criar = (titulo, dias, hora) => api.post('/painel/comunicados', {
      local_id: ponto, titulo, texto: 'Detalhes com o síndico.', tipo: 'assembleia',
      inicio: diaRel(0), fim: diaRel(20), evento_em: diaRel(dias), evento_hora: hora,
    }, master);
    assert.equal((await criar('Assembleia geral', 7, '19:00')).status, 201);
    await criar('Dedetização', 3, '08:00');
    await criar('Já passou', -2, null);
    await api.post('/painel/comunicados', {
      local_id: ponto, titulo: 'Sem data', texto: 'Recado solto.', inicio: diaRel(0), fim: diaRel(20),
    }, master);

    const g = grade.montar(api.db, grade.buscarTela(api.db, tela));
    assert.equal(g.agenda.length, 2, 'o que já passou e o que não tem data ficam de fora');
    assert.equal(g.agenda[0].titulo, 'Dedetização', 'em ordem de data');
    assert.equal(g.agenda[0].hora, '08:00');
    assert.equal(g.agenda[1].titulo, 'Assembleia geral');
    assert.equal(g.comunicados.length, 4, 'todos continuam girando como comunicado');

    assert.equal((await api.post('/painel/comunicados', {
      local_id: ponto, titulo: 'Data errada', texto: 'x', inicio: diaRel(0), fim: diaRel(2), evento_em: '12/12/2026',
    }, master)).status, 422);
  });

  await t.test('o clima só aparece quando está ligado e com dado fresco', async () => {
    const g = () => grade.montar(api.db, grade.buscarTela(api.db, tela));
    assert.equal(g().clima, null, 'vem desligado de fábrica');

    api.db.prepare(`INSERT INTO clima (cidade, uf, temperatura, maxima, minima, codigo, atualizado_em)
      VALUES ('Campinas', 'SP', 27.4, 31, 19, 3, ?)`).run(new Date().toISOString());
    assert.equal(g().clima, null, 'mesmo com dado guardado, desligado não vai para a tela');

    await api.put('/painel/configuracoes', { clima_ligado: 1 }, master);
    const c = g().clima;
    assert.equal(c.temperatura, 27, 'arredonda para a tela');
    assert.equal(c.descricao, 'Nublado');
    assert.equal(c.maxima, 31);
    assert.equal(c.cidade, 'Campinas');

    // Dado velho não é mostrado como "agora".
    api.db.prepare("UPDATE clima SET atualizado_em = ? WHERE cidade = 'Campinas'")
      .run(new Date(Date.now() - 5 * 3_600_000).toISOString());
    assert.equal(g().clima, null);
  });

  await t.test('a temperatura não muda a versão da grade (a TV não rebaixa a programação à toa)', async () => {
    await api.put('/painel/configuracoes', { clima_ligado: 1 }, master);
    const agora = new Date().toISOString();
    const gravar = (temp) => api.db.prepare(`INSERT INTO clima (cidade, uf, temperatura, maxima, minima, codigo, atualizado_em)
      VALUES ('Campinas', 'SP', ?, 30, 18, 0, ?) ON CONFLICT (cidade, uf) DO UPDATE SET temperatura = excluded.temperatura,
        atualizado_em = excluded.atualizado_em`).run(temp, agora);

    gravar(21);
    const antes = grade.montar(api.db, grade.buscarTela(api.db, tela));
    gravar(28);
    const depois = grade.montar(api.db, grade.buscarTela(api.db, tela));
    assert.equal(depois.versao, antes.versao, 'a versão é a mesma');
    assert.equal(depois.clima.temperatura, 28, 'mas a tela recebe a temperatura nova na próxima batida');
  });

  await t.test('sem internet, o clima some e nada trava', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('sem rede'));
    try {
      assert.equal(await clima.atualizarCidade(api.db, 'Valinhos', 'SP'), null);
      const r = await clima.atualizar(api.db);
      assert.equal(r.ligado, true, 'tentou, não quebrou');
    } finally {
      globalThis.fetch = original;
    }
  });
});

/** O portal do ponto tem de dizer a verdade sobre o que foi combinado com aquele ponto. */
test('Portal do ponto mostra a contrapartida combinada, não um valor que não existe', async (t) => {
  const { iniciar: iniciarApi } = require('./helpers');
  const api = await iniciarApi();
  t.after(api.fechar);
  const master = await api.login();

  const criar = async (nome, repasse) => {
    const ponto = (await api.post('/painel/locais', { nome, categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP', ...repasse }, master)).dados.id;
    const acesso = await api.post(`/painel/locais/${ponto}/acesso`, { nome: 'Responsável', email: `${nome.toLowerCase().replace(/\W/g, '')}@exemplo.com` }, master);
    return api.login(acesso.dados.id && `${nome.toLowerCase().replace(/\W/g, '')}@exemplo.com`, acesso.dados.senha_provisoria);
  };

  const semRepasse = await criar('Sem Repasse', { repasse_tipo: 'nenhum' });
  const comFixo = await criar('Com Fixo', { repasse_tipo: 'fixo', repasse_fixo_centavos: 30_000 });
  const comComissao = await criar('Com Comissao', { repasse_tipo: 'comissao', comissao_percentual: 20 });

  const ponto = async (tk) => (await api.get('/ponto/resumo', tk)).dados.ponto;
  assert.equal((await ponto(semRepasse)).repasse_tipo, 'nenhum', 'o portal sabe que este ponto não recebe dinheiro');
  assert.equal((await ponto(comFixo)).repasse_fixo_centavos, 30_000, 'e sabe o valor combinado quando é fixo');
  assert.equal((await ponto(comComissao)).comissao_percentual, 2000);
});

/**
 * O contrato é o que sustenta a receita: ele vence, reajusta e renova. Se o sistema não cuidar disso,
 * o dinheiro some devagar — contrato que acabou e ninguém viu, reajuste que ninguém aplicou.
 */
test('Contrato avisa, reajusta e renova — e leva as campanhas junto', async (t) => {
  const { iniciar: iniciarApi, dia: diaRel } = require('./helpers');
  const api = await iniciarApi();
  t.after(api.fechar);
  const master = await api.login();
  const contratos = require('../server/lib/contratos');

  const cliente = (await api.post('/painel/anunciantes', { nome: 'Rede Bom Dia' }, master)).dados.id;
  // Começou há 13 meses: já passou da data do reajuste anual e está a 5 dias do fim.
  const criar = async (extra) => (await api.post('/painel/contratos', {
    anunciante_id: cliente, numero: extra.numero, inicio: diaRel(-395), fim: diaRel(5),
    cobranca: 'mensal', valor_centavos: 200_000, status: 'ativo', reajuste: 'IPCA a cada 12 meses', ...extra,
  }, master)).dados;

  await t.test('o que está na data aparece como pendência, no painel e no diagnóstico', async () => {
    const c = await criar({ numero: 'C-100' });
    assert.equal(c.reajuste_em, diaRel(-30), 'o próximo reajuste conta do início do contrato');
    assert.equal(c.reajuste_vencido, true);
    assert.equal(c.dias_para_fim, 5);

    const p = (await api.get('/painel/contratos/pendencias', master)).dados;
    assert.equal(p.reajustar.length, 1);
    assert.equal(p.vencendo.length, 1, 'vence dentro do prazo de aviso');
    assert.equal(p.vencidos.length, 0);

    const d = (await api.get('/painel/diagnostico', master)).dados;
    const check = (nome) => d.verificacoes.find((x) => x.nome === nome);
    assert.equal(check('Contratos vencendo').ok, false);
    assert.equal(check('Reajustes na data').ok, false);
  });

  await t.test('o reajuste sobe o contrato e as campanhas dele (é da campanha que a fatura nasce)', async () => {
    const c = await criar({ numero: 'C-200' });
    const mensal = (await api.post('/painel/campanhas', {
      anunciante_id: cliente, nome: 'Mensal', inicio: diaRel(-30), fim: diaRel(5), cobranca: 'mensal', valor_centavos: 100_000,
    }, master)).dados.id;
    const porCpm = (await api.post('/painel/campanhas', {
      anunciante_id: cliente, nome: 'Por CPM', inicio: diaRel(-30), cobranca: 'cpm', cpm_centavos: 2000,
    }, master)).dados.id;
    for (const id of [mensal, porCpm]) await api.post(`/painel/contratos/${c.id}/campanhas`, { campanha_id: id }, master);

    const r = (await api.post(`/painel/contratos/${c.id}/reajuste`, { percentual: 1000, indice: 'IPCA 10%' }, master)).dados;
    assert.equal(r.reajuste.de_centavos, 200_000);
    assert.equal(r.reajuste.para_centavos, 220_000, '10% em cima de 2.000,00');
    assert.equal(r.reajuste.campanhas, 2);
    assert.equal((await api.get(`/painel/campanhas/${mensal}`, master)).dados.valor_centavos, 110_000);
    assert.equal((await api.get(`/painel/campanhas/${porCpm}`, master)).dados.cpm_centavos, 2200, 'campanha por CPM reajusta o CPM');

    const depois = (await api.get(`/painel/contratos/${c.id}`, master)).dados;
    assert.equal(depois.reajuste_vencido, false, 'a data do próximo reajuste anda para a frente');
    assert.equal(depois.reajustes.length, 1);
    assert.equal(depois.reajustes[0].indice, 'IPCA 10%');

    assert.equal((await api.post(`/painel/contratos/${c.id}/reajuste`, { percentual: 0 }, master)).status, 422);
  });

  await t.test('renovar estende o contrato e as campanhas que acabavam com ele', async () => {
    const c = await criar({ numero: 'C-300' });
    const junto = (await api.post('/painel/campanhas', {
      anunciante_id: cliente, nome: 'Acaba com o contrato', inicio: diaRel(-10), fim: diaRel(5), cobranca: 'cortesia',
    }, master)).dados.id;
    const propria = (await api.post('/painel/campanhas', {
      anunciante_id: cliente, nome: 'Prazo próprio', inicio: diaRel(-10), fim: diaRel(2), cobranca: 'cortesia',
    }, master)).dados.id;
    for (const id of [junto, propria]) await api.post(`/painel/contratos/${c.id}/campanhas`, { campanha_id: id }, master);

    const r = (await api.post(`/painel/contratos/${c.id}/renovar`, { meses: 12 }, master)).dados;
    assert.equal(r.renovacao.campanhas, 1, 'só a que terminava junto');
    assert.equal(r.fim, r.renovacao.ate);
    assert.equal((await api.get(`/painel/campanhas/${junto}`, master)).dados.fim, r.renovacao.ate);
    assert.equal((await api.get(`/painel/campanhas/${propria}`, master)).dados.fim, diaRel(2), 'campanha de prazo próprio não muda');
    assert.equal((await api.get(`/painel/contratos/${c.id}`, master)).dados.renovacoes, 1);
  });

  await t.test('sozinho: renova o que é automático e reajusta só quem tem percentual fixo', async () => {
    // Vigência de um ano redondo que terminou ontem: renova por mais um ano.
    const automatico = await criar({ numero: 'C-400', inicio: diaRel(-366), fim: diaRel(-1), renovacao_automatica: 1, reajuste_percentual: 500 });
    const manual = await criar({ numero: 'C-500', renovacao_automatica: 0 });

    const r = contratos.rodarAutomatico(api.db);
    assert.equal(r.renovados.length, 1);
    assert.equal(r.renovados[0].numero, 'C-400');
    assert.equal(r.reajustados.length, 1, 'o sem percentual fixo espera a equipe — ninguém quer sistema inventando aumento');
    assert.equal(r.reajustados[0].numero, 'C-400');
    assert.equal(r.reajustados[0].para_centavos, 210_000, '5% em cima de 2.000,00');

    const depois = (await api.get(`/painel/contratos/${automatico.id}`, master)).dados;
    assert.equal(depois.renovacoes, 1);
    assert.equal(depois.fim, somarMeses12(diaRel(-1)));
    assert.equal(depois.reajustes[0].automatico, 1);

    // Rodar de novo não faz nada: as datas já andaram.
    const denovo = contratos.rodarAutomatico(api.db);
    assert.equal(denovo.renovados.length + denovo.reajustados.length, 0);
    assert.equal((await api.get(`/painel/contratos/${manual.id}`, master)).dados.valor_centavos, 200_000);
  });

  await t.test('o aviso por e-mail sai uma vez por dia com os três grupos', async () => {
    const avisos = require('../server/lib/avisos');
    const email = require('../server/lib/email');
    email.caixaTeste.length = 0;
    await api.put('/painel/configuracoes', { avisos_email: 1 }, master);

    const r = await avisos.contratosParaCuidar(api.db);
    assert.equal(r.enviados, 1);
    const msg = email.caixaTeste.at(-1);
    assert.match(msg.assunto, /Contratos para cuidar/);
    assert.match(msg.html, /C-100/);

    assert.equal((await avisos.contratosParaCuidar(api.db)).enviados, 0, 'não repete no mesmo dia');
  });
});

/** Soma 12 meses a uma data, como o contrato faz ao renovar. */
function somarMeses12(data) {
  const [a, m, d] = data.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1 + 12, Math.min(d, 28))).toISOString().slice(0, 10);
}

/**
 * O CRM é o que acontece antes de existir cliente: com quem estamos falando, o que ficou combinado
 * para hoje e o que disso virou contrato. Inclusive o que chega pelo formulário do site.
 */
test('CRM: do lead ao contrato, sem redigitar nada', async (t) => {
  const { iniciar: iniciarApi, dia: diaRel } = require('./helpers');
  const api = await iniciarApi();
  t.after(api.fechar);
  const master = await api.login();

  // Um circuito para a proposta ter o que vender.
  const ponto = (await api.post('/painel/locais', {
    nome: 'Edifício Funil', categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP', publico_dia: 800,
  }, master)).dados.id;
  await api.post('/painel/telas', { local_id: ponto, nome: 'Elevador', orientacao: 'retrato' }, master);
  const circuito = (await api.post('/painel/circuitos', {
    nome: 'Residencial', valor_mes_centavos: 300_000, insercoes_hora: 6,
    alvos: [{ tipo: 'categoria', valor: 'condominio_residencial' }],
  }, master)).dados.id;

  let lead;

  await t.test('o formulário do site cai no funil como lead', async () => {
    const r = await api.post('/contato', {
      nome: 'Padaria do Bairro', tipo: 'anunciante', contato: 'Dona Ana', telefone: '19999990000',
      cidade: 'Campinas', mensagem: 'Quero anunciar nos prédios perto da padaria.',
    });
    assert.equal(r.status, 201);
    assert.match(r.dados.mensagem, /Recebemos/);

    assert.equal((await api.post('/contato', { nome: 'Sem contato' })).status, 422, 'sem e-mail nem telefone não dá para responder');

    const d = (await api.get('/painel/crm/funil', master)).dados;
    const novo = d.etapas.find((e) => e.etapa === 'novo');
    assert.equal(novo.total, 1);
    lead = novo.itens[0];
    assert.equal(lead.origem, 'site');
    assert.equal(lead.nome, 'Padaria do Bairro');

    const ficha = (await api.get(`/painel/crm/leads/${lead.id}`, master)).dados;
    assert.match(ficha.interacoes[0].texto, /Quero anunciar nos prédios/, 'a mensagem do site vira a primeira anotação');
  });

  await t.test('a conversa anda e o próximo passo fica marcado', async () => {
    const r = await api.post(`/painel/crm/leads/${lead.id}/interacoes`, {
      tipo: 'ligacao', texto: 'Falei com a Ana. Pediu proposta de 3 meses.',
      proximo_passo: 'Enviar proposta', proximo_em: diaRel(2),
    }, master);
    assert.equal(r.status, 201);
    assert.equal(r.dados.proximo_em, diaRel(2));
    assert.equal(r.dados.interacoes.length, 2);

    await api.patch(`/painel/crm/leads/${lead.id}`, { etapa: 'contato', valor_estimado_centavos: 300_000 }, master);
    const ficha = (await api.get(`/painel/crm/leads/${lead.id}`, master)).dados;
    assert.equal(ficha.etapa, 'contato');
    assert.ok(ficha.interacoes.some((i) => i.tipo === 'etapa'), 'a mudança de etapa entra no histórico');

    assert.equal((await api.patch(`/painel/crm/leads/${lead.id}`, { etapa: 'ganho' }, master)).status, 422,
      'ganhar é uma ação, não uma edição de campo');
  });

  await t.test('atrasado aparece em destaque e some quando a data é remarcada', async () => {
    await api.patch(`/painel/crm/leads/${lead.id}`, { proximo_em: diaRel(-3) }, master);
    const d = (await api.get('/painel/crm/funil', master)).dados;
    assert.equal(d.totais.atrasados, 1);
    assert.equal(d.agenda[0].id, lead.id);
    assert.equal(d.agenda[0].atrasado, true);

    await api.patch(`/painel/crm/leads/${lead.id}`, { proximo_em: diaRel(2) }, master);
    assert.equal((await api.get('/painel/crm/funil', master)).dados.totais.atrasados, 0);
  });

  await t.test('a proposta nasce do lead e o funil anda sozinho', async () => {
    const p = await api.post('/painel/propostas', { circuito_id: circuito, lead_id: lead.id, meses: 3 }, master);
    assert.equal(p.status, 201, JSON.stringify(p.dados));
    assert.equal(p.dados.lead_id, lead.id);

    const ficha = (await api.get(`/painel/crm/leads/${lead.id}`, master)).dados;
    assert.equal(ficha.etapa, 'proposta', 'gerar proposta move o lead de etapa');
    assert.equal(ficha.propostas_lista.length, 1);

    // Aceitar fecha o lead, cria o cliente e o contrato — tudo a partir do que já estava no CRM.
    const aceita = (await api.post(`/painel/propostas/${p.dados.id}/aceitar`, {}, master)).dados;
    assert.equal(aceita.status, 'aceita');
    const depois = (await api.get(`/painel/crm/leads/${lead.id}`, master)).dados;
    assert.equal(depois.etapa, 'ganho');
    assert.equal(depois.cliente, 'Padaria do Bairro', 'o cliente nasceu do lead');
    const contrato = (await api.get(`/painel/contratos/${aceita.contrato_id}`, master)).dados;
    assert.equal(contrato.anunciante, 'Padaria do Bairro');
    assert.equal(contrato.valor_centavos, 300_000);

    assert.equal((await api.del(`/painel/crm/leads/${lead.id}`, {}, master)).status, 409, 'lead ganho é a origem de um cliente');
  });

  await t.test('um condomínio que pede tela vira ponto na rede', async () => {
    const r = await api.post('/contato', { nome: 'Edifício Interessado', tipo: 'ponto', email: 'sindico@exemplo.com', cidade: 'Valinhos' });
    assert.equal(r.status, 201);
    const funil = (await api.get('/painel/crm/funil?tipo=ponto', master)).dados;
    const novo = funil.etapas.find((e) => e.etapa === 'novo').itens[0];

    const ganho = (await api.post(`/painel/crm/leads/${novo.id}/ganhar`, {}, master)).dados;
    assert.equal(ganho.etapa, 'ganho');
    assert.equal(ganho.ponto, 'Edifício Interessado');
    const pontos = (await api.get('/painel/locais', master)).dados.itens;
    assert.ok(pontos.some((p) => p.nome === 'Edifício Interessado'), 'o ponto entrou na rede para a equipe completar o cadastro');
  });

  await t.test('perder guarda o motivo, e reabrir traz de volta', async () => {
    const novo = (await api.post('/painel/crm/leads', {
      nome: 'Academia Teste', tipo: 'anunciante', telefone: '1933330000', origem: 'prospeccao', valor_estimado_centavos: 80_000,
    }, master)).dados;
    assert.equal(novo.etapa, 'novo');

    const perdido = (await api.post(`/painel/crm/leads/${novo.id}/perder`, { motivo: 'Fechou com o concorrente' }, master)).dados;
    assert.equal(perdido.etapa, 'perdido');
    assert.equal(perdido.motivo, 'Fechou com o concorrente');
    assert.ok(perdido.interacoes.some((i) => i.texto.includes('Fechou com o concorrente')));

    assert.equal((await api.post(`/painel/crm/leads/${novo.id}/reabrir`, {}, master)).dados.etapa, 'contato');
    assert.equal((await api.del(`/painel/crm/leads/${novo.id}`, {}, master)).status, 204);
  });
});

/** O site é a porta de entrada: tem de abrir, falar com a API certa e transformar visita em lead. */
test('Site do Vai Mídia: abre na raiz e o formulário vira lead', async (t) => {
  const { iniciar: iniciarApi } = require('./helpers');
  const api = await iniciarApi();
  t.after(api.fechar);
  const raiz = api.base.replace(/\/midia\/api$/, '');

  await t.test('a raiz do domínio serve o site, já com o endereço da API', async () => {
    const r = await fetch(`${raiz}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Sua marca no<br><span>centro da atenção\.<\/span>/, 'o visual aprovado está no ar');
    assert.match(html, /<body[^>]*data-api="\/midia\/api\/"/, 'o site não precisa sair procurando a API');
    assert.match(html, /id="painel-link"/, 'quem já é cliente chega ao painel pelo rodapé');

    // O painel continua no lugar dele, e o site também responde em /midia/site/.
    assert.equal((await fetch(`${raiz}/midia/`)).status, 200);
    assert.equal((await fetch(`${raiz}/midia/site/`)).status, 200);
    assert.equal((await fetch(`${raiz}/css/styles.css`)).status, 200, 'os arquivos do site saem na raiz');
    assert.equal((await fetch(`${raiz}/assets/layout-aprovado.webp`)).status, 200);
    assert.equal((await fetch(`${raiz}/assets/VAI_MIDIA_Portfolio_Comercial.pdf`)).status, 200, 'o portfólio baixa pelo site');
  });

  await t.test('os números da rede são agregados, sem nome de ninguém', async () => {
    const master = await api.login();
    const ponto = (await api.post('/painel/locais', {
      nome: 'Edifício Secreto', categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP', publico_dia: 1000,
    }, master)).dados.id;
    await api.post('/painel/telas', { local_id: ponto, nome: 'Hall' }, master);

    const d = (await api.get('/publico/rede')).dados;
    assert.equal(d.telas, 1);
    assert.equal(d.pontos, 1);
    assert.equal(d.cidades, 1);
    assert.equal(d.publico_mes, 30_000);
    assert.ok(!JSON.stringify(d).includes('Secreto'), 'nenhum nome de ponto vai para o site');
  });
});
