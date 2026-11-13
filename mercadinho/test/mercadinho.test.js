'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { hoje, competencia, somarMeses } = require('../server/lib/datas');

/** Cadastra um produto com saldo inicial e devolve o registro criado. */
async function produto(app, token, dados) {
  const r = await app.post('/produtos', { unidade: 'un', categoria_id: 1, ...dados }, token);
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return r.dados;
}

test('login, perfis e permissões', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());

  const errado = await app.post('/auth/login', { email: 'admin@mercadinho.com.br', senha: 'errada' });
  assert.equal(errado.status, 401);

  const admin = await app.login();
  const { token: caixa } = await app.criarUsuario(admin, { nome: 'Ana Caixa', email: 'ana@mercadinho.com.br', perfil: 'caixa' });
  const { token: estoquista } = await app.criarUsuario(admin, { nome: 'Beto Estoque', email: 'beto@mercadinho.com.br', perfil: 'estoque' });

  // O caixa opera o PDV, mas não vê o financeiro nem mexe no cadastro de produtos.
  assert.equal((await app.get('/pdv/venda', caixa)).status, 200);
  assert.equal((await app.get('/financeiro/resumo', caixa)).status, 403);
  assert.equal((await app.post('/produtos', { nome: 'X', preco: '1,00' }, caixa)).status, 403);
  // O estoquista cadastra produtos, mas não abre caixa.
  assert.equal((await app.post('/caixa/abrir', { abertura: '100,00' }, estoquista)).status, 403);
  assert.equal((await app.get('/produtos', estoquista)).status, 200);
  // Sem token, nada.
  assert.equal((await app.get('/produtos')).status, 401);
});

test('cadastro de produto, estoque e custo médio', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();

  const arroz = await produto(app, admin, { nome: 'Arroz 5kg', codigo_barras: '7891000053508', preco: '29,90', custo: '21,00', estoque: '10', estoque_minimo: '4' });
  assert.equal(arroz.estoque_mil, 10_000);
  assert.equal(arroz.preco_centavos, 2990);
  assert.equal(arroz.margem_bp, 4238);

  // Código de barras repetido é recusado.
  const repetido = await app.post('/produtos', { nome: 'Outro', codigo_barras: '7891000053508', preco: '1,00' }, admin);
  assert.equal(repetido.status, 409);
  // Dígito verificador errado também.
  const invalido = await app.post('/produtos', { nome: 'Outro', codigo_barras: '7891000053509', preco: '1,00' }, admin);
  assert.equal(invalido.status, 422);

  // Entrada a um custo maior puxa o custo médio para cima.
  const entrada = await app.post('/estoque/entrada', { produto_id: arroz.id, quantidade: '5', custo: '25,00' }, admin);
  assert.equal(entrada.status, 201);
  assert.equal(entrada.dados.saldo_mil, 15_000);
  assert.equal((await app.get(`/produtos/${arroz.id}`, admin)).dados.custo_centavos, 2233);

  // Perda sai do estoque e aparece no relatório de perdas.
  await app.post('/estoque/perda', { produto_id: arroz.id, quantidade: '1', motivo: 'Pacote rasgado' }, admin);
  assert.equal((await app.get(`/produtos/${arroz.id}`, admin)).dados.estoque_mil, 14_000);
  const perdas = await app.get(`/relatorios/perdas?de=${hoje()}&ate=${hoje()}`, admin);
  assert.equal(perdas.dados.length, 1);
  assert.equal(perdas.dados[0].valor_centavos, 2233);

  // Produto no mínimo entra nos alertas.
  await app.post('/estoque/ajuste', { produto_id: arroz.id, contado: '3' }, admin);
  const alertas = await app.get('/estoque/alertas', admin);
  assert.equal(alertas.dados.estoque_baixo.length, 1);
});

test('venda no PDV: caixa, pagamento em dinheiro, estoque e cancelamento', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const refri = await produto(app, admin, { nome: 'Refrigerante 2L', preco: '9,50', custo: '6,00', estoque: '24' });

  // Sem caixa aberto não há venda.
  assert.equal((await app.post('/pdv/venda', {}, admin)).status, 409);

  const caixa = await app.post('/caixa/abrir', { abertura: '100,00' }, admin);
  assert.equal(caixa.status, 201);
  assert.equal(caixa.dados.dinheiro_esperado_centavos, 10_000);

  const venda = (await app.post('/pdv/venda', {}, admin)).dados;
  const comItem = await app.post(`/pdv/vendas/${venda.id}/itens`, { codigo: 'Refrigerante', quantidade: 3 }, admin);
  assert.equal(comItem.status, 201);
  assert.equal(comItem.dados.total_centavos, 2850);

  // Bipar de novo soma na mesma linha.
  const maisUm = await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: refri.id }, admin);
  assert.equal(maisUm.dados.itens.length, 1);
  assert.equal(maisUm.dados.total_centavos, 3800);

  // Desconto de R$ 3,00.
  const comDesconto = await app.patch(`/pdv/vendas/${venda.id}`, { desconto: '3,00' }, admin);
  assert.equal(comDesconto.dados.total_centavos, 3500);

  // A soma dos pagamentos precisa bater com o total.
  const errado = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'dinheiro', valor: '30,00' }] }, admin);
  assert.equal(errado.status, 422);

  const paga = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'dinheiro', valor: '35,00', recebido: '50,00' }] }, admin);
  assert.equal(paga.status, 200);
  assert.equal(paga.dados.status, 'paga');
  assert.equal(paga.dados.pagamentos[0].troco_centavos, 1500);
  assert.equal(paga.dados.custo_centavos, 2400);

  // O estoque desceu 4 unidades.
  assert.equal((await app.get(`/produtos/${refri.id}`, admin)).dados.estoque_mil, 20_000);

  // O caixa conhece a venda.
  const resumo = await app.get('/caixa/atual', admin);
  assert.equal(resumo.dados.vendas, 1);
  assert.equal(resumo.dados.por_forma.dinheiro, 3500);
  assert.equal(resumo.dados.dinheiro_esperado_centavos, 13_500);

  // Sangria maior que o caixa é recusada; a válida reduz o esperado.
  assert.equal((await app.post(`/caixa/${resumo.dados.caixa.id}/movimento`, { tipo: 'sangria', valor: '500,00', motivo: 'cofre' }, admin)).status, 409);
  const sangrado = await app.post(`/caixa/${resumo.dados.caixa.id}/movimento`, { tipo: 'sangria', valor: '100,00', motivo: 'Retirada para o cofre' }, admin);
  assert.equal(sangrado.dados.dinheiro_esperado_centavos, 3500);

  // Cancelar devolve o estoque e tira o dinheiro da conta do caixa (o valor volta para o cliente).
  const cancelada = await app.post(`/pdv/vendas/${venda.id}/cancelar`, { motivo: 'Cliente desistiu' }, admin);
  assert.equal(cancelada.dados.status, 'cancelada');
  assert.equal((await app.get(`/produtos/${refri.id}`, admin)).dados.estoque_mil, 24_000);
  const depois = await app.get('/caixa/atual', admin);
  assert.equal(depois.dados.vendas, 0);
  assert.equal(depois.dados.canceladas, 1);
  assert.equal(depois.dados.dinheiro_esperado_centavos, 0);

  // Fechamento com sobra de R$ 5,00 na gaveta.
  const fechado = await app.post(`/caixa/${resumo.dados.caixa.id}/fechar`, { informado: '5,00' }, admin);
  assert.equal(fechado.status, 200);
  assert.equal(fechado.dados.caixa.esperado_centavos, 0);
  assert.equal(fechado.dados.caixa.diferenca_centavos, 500);
  assert.equal(fechado.dados.caixa.status, 'fechado');
  // Caixa fechado não aceita novas vendas.
  assert.equal((await app.post('/pdv/venda', {}, admin)).status, 409);
});

test('venda no cartão pela maquininha: aprovação, recebível e reuso bloqueado', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const cafe = await produto(app, admin, { nome: 'Café 500g', preco: '22,00', custo: '15,00', estoque: '10' });
  await app.post('/caixa/abrir', { abertura: '0,00' }, admin);

  const maquininhas = await app.get('/pdv/maquininhas', admin);
  assert.equal(maquininhas.dados.length, 1);
  const maquininha_id = maquininhas.dados[0].id;

  const venda = (await app.post('/pdv/venda', {}, admin)).dados;
  await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: cafe.id, quantidade: 2 }, admin);

  const cobranca = await app.post(`/pdv/vendas/${venda.id}/cartao`, { maquininha_id, forma: 'credito', parcelas: 2 }, admin);
  assert.equal(cobranca.status, 201);
  assert.equal(cobranca.dados.status, 'aprovada');
  assert.equal(cobranca.dados.valor_centavos, 4400);
  // Crédito parcelado: taxa de 4,49% e líquido a receber em 30 dias.
  assert.equal(cobranca.dados.taxa_centavos, 198);
  assert.equal(cobranca.dados.liquido_centavos, 4202);

  // O recebível líquido já está no contas a receber.
  const receber = await app.get('/financeiro/lancamentos?tipo=receber', admin);
  assert.equal(receber.dados.length, 1);
  assert.equal(receber.dados[0].valor_centavos, 4202);
  assert.equal(receber.dados[0].categoria, 'Cartão');

  // Valor diferente do cobrado não fecha a venda.
  const divergente = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'credito', valor: '40,00', transacao_id: cobranca.dados.id }] }, admin);
  assert.equal(divergente.status, 422);

  const paga = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'credito', valor: '44,00', transacao_id: cobranca.dados.id }] }, admin);
  assert.equal(paga.status, 200);

  // A mesma cobrança não pode pagar outra venda.
  const outra = (await app.post('/pdv/venda', {}, admin)).dados;
  await app.post(`/pdv/vendas/${outra.id}/itens`, { produto_id: cafe.id, quantidade: 2 }, admin);
  const reuso = await app.post(`/pdv/vendas/${outra.id}/finalizar`, { pagamentos: [{ forma: 'credito', valor: '44,00', transacao_id: cobranca.dados.id }] }, admin);
  assert.equal(reuso.status, 409);

  // Cartão sem cobrança aprovada também não passa.
  const semCobranca = await app.post(`/pdv/vendas/${outra.id}/finalizar`, { pagamentos: [{ forma: 'debito', valor: '44,00' }] }, admin);
  assert.equal(semCobranca.status, 422);

  // Débito não aceita parcelamento.
  const debitoParcelado = await app.post(`/pdv/vendas/${outra.id}/cartao`, { maquininha_id, forma: 'debito', parcelas: 3 }, admin);
  assert.equal(debitoParcelado.status, 422);
});

test('conta do morador: limite, fiado, fatura do mês e recebimento', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const leite = await produto(app, admin, { nome: 'Leite 1L', preco: '5,00', custo: '3,50', estoque: '100' });
  await app.post('/caixa/abrir', { abertura: '0,00' }, admin);

  const morador = (await app.post('/moradores', { nome: 'Carla Souza', bloco: 'B', unidade: '304', telefone: '11988887777', limite: '50,00' }, admin)).dados;
  assert.equal(morador.limite_centavos, 5000);

  const venda = (await app.post('/pdv/venda', { morador_id: morador.id }, admin)).dados;
  await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: leite.id, quantidade: 4 }, admin);

  // Acima do limite, o fiado é barrado.
  const estourou = await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: leite.id, quantidade: 8 }, admin);
  assert.equal(estourou.status, 201);
  const recusada = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'fiado', valor: '60,00' }] }, admin);
  assert.equal(recusada.status, 409);
  assert.match(recusada.dados.erro, /Limite/);

  await app.patch(`/pdv/vendas/${venda.id}/itens/${(await app.get(`/pdv/vendas/${venda.id}`, admin)).dados.itens[0].id}`, { quantidade: 6 }, admin);
  const paga = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'fiado', valor: '30,00' }] }, admin);
  assert.equal(paga.status, 200);

  const ficha = await app.get(`/moradores/${morador.id}`, admin);
  assert.equal(ficha.dados.saldo_centavos, 3000);
  assert.equal(ficha.dados.disponivel_centavos, 2000);
  assert.equal(ficha.dados.consumo_do_mes.compras, 1);

  // Fecha o mês atual e gera a fatura.
  const fechamento = await app.post('/moradores/faturas/fechar', { competencia: competencia() }, admin);
  assert.equal(fechamento.dados.faturas, 1);
  assert.equal(fechamento.dados.vencimento, `${somarMeses(competencia(), 1)}-10`);

  const faturas = await app.get('/moradores/faturas?status=aberta', admin);
  assert.equal(faturas.dados.length, 1);
  assert.equal(faturas.dados[0].valor_centavos, 3000);

  // Rodar de novo não duplica.
  assert.equal((await app.post('/moradores/faturas/fechar', { competencia: competencia() }, admin)).dados.faturas, 0);

  // Recebendo o valor, a fatura é quitada e o saldo zera.
  const recebido = await app.post(`/moradores/${morador.id}/receber`, { valor: '30,00', forma: 'pix' }, admin);
  assert.equal(recebido.dados.saldo_centavos, 0);
  assert.equal((await app.get('/moradores/faturas?status=paga', admin)).dados.length, 1);

  // O portal do morador mostra a própria conta.
  await app.post(`/moradores/${morador.id}/acesso`, { email: 'carla@condominio.com', senha: 'moradora123' }, admin);
  const tokenMorador = await app.login('carla@condominio.com', 'moradora123');
  const minhaConta = await app.get('/moradores/minha-conta', tokenMorador);
  assert.equal(minhaConta.status, 200);
  assert.equal(minhaConta.dados.morador.id, morador.id);
  assert.equal(minhaConta.dados.compras.length, 1);
  // E não enxerga o resto do sistema.
  assert.equal((await app.get('/produtos', tokenMorador)).status, 403);
  assert.equal((await app.get('/painel', tokenMorador)).status, 403);
});

test('compras: pedido, recebimento, custo médio, validade e contas a pagar', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();

  const fornecedor = (await app.post('/produtos/fornecedores', { nome: 'Distribuidora Central', cnpj: '11222333000181', prazo_pagamento_dias: 7 }, admin)).dados;
  const iogurte = await produto(app, admin, { nome: 'Iogurte 170g', preco: '3,50', custo: '2,00', estoque: '10', controla_validade: true, estoque_minimo: '20' });

  const compra = (await app.post('/compras', {
    fornecedor_id: fornecedor.id, parcelas: 2, numero_nota: '12345',
    itens: [{ produto_id: iogurte.id, quantidade: '30', custo: '2,40', validade: '2027-01-31', preco_venda: '3,90' }],
  }, admin)).dados;
  assert.equal(compra.total_centavos, 7200);
  assert.equal(compra.status, 'rascunho');

  assert.equal((await app.post(`/compras/${compra.id}/enviar`, {}, admin)).dados.status, 'enviada');

  const recebida = await app.post(`/compras/${compra.id}/receber`, { itens: [{ item_id: compra.itens[0].id, recebido: '28' }] }, admin);
  assert.equal(recebida.status, 200);
  assert.equal(recebida.dados.status, 'recebida');
  assert.equal(recebida.dados.total_centavos, 6720);

  const atualizado = (await app.get(`/produtos/${iogurte.id}`, admin)).dados;
  assert.equal(atualizado.estoque_mil, 38_000);
  assert.equal(atualizado.preco_centavos, 390); // preço de venda atualizado no recebimento
  assert.equal(atualizado.custo_centavos, 229); // custo médio: (10 × R$ 2,00 + 28 × R$ 2,40) / 38 = R$ 2,29
  assert.equal(atualizado.lotes.length, 1);
  assert.equal(atualizado.lotes[0].qtd_mil, 28_000);

  // Duas parcelas em contas a pagar, a primeira no prazo do fornecedor.
  const pagar = await app.get('/financeiro/lancamentos?tipo=pagar', admin);
  assert.equal(pagar.dados.length, 2);
  assert.equal(pagar.dados[0].valor_centavos + pagar.dados[1].valor_centavos, 6720);
  assert.equal(pagar.dados[0].categoria, 'Mercadorias');

  // Recebida não pode ser recebida de novo.
  assert.equal((await app.post(`/compras/${compra.id}/receber`, {}, admin)).status, 409);

  // Baixa da primeira parcela.
  const baixado = await app.post(`/financeiro/lancamentos/${pagar.dados[0].id}/baixar`, { forma: 'pix' }, admin);
  assert.equal(baixado.dados.status, 'pago');
  assert.equal((await app.get('/financeiro/resumo', admin)).dados.pagar.aberto_centavos, pagar.dados[1].valor_centavos);
});

test('inventário acerta o estoque e registra a diferença', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const sabao = await produto(app, admin, { nome: 'Sabão em pó 1kg', preco: '18,00', custo: '12,00', estoque: '20' });

  const inventario = (await app.post('/estoque/inventarios', { descricao: 'Contagem de novembro' }, admin)).dados;
  assert.equal(inventario.itens.length, 1);
  assert.equal(inventario.itens[0].esperado_mil, 20_000);

  await app.patch(`/estoque/inventarios/${inventario.id}/itens/${sabao.id}`, { contado: '17' }, admin);
  const aplicado = await app.post(`/estoque/inventarios/${inventario.id}/aplicar`, {}, admin);
  assert.equal(aplicado.dados.status, 'aplicado');
  assert.equal(aplicado.dados.ajustes, 1);
  assert.equal(aplicado.dados.diferenca_centavos, -3600);
  assert.equal((await app.get(`/produtos/${sabao.id}`, admin)).dados.estoque_mil, 17_000);
  // Inventário encerrado não aceita nova contagem.
  assert.equal((await app.patch(`/estoque/inventarios/${inventario.id}/itens/${sabao.id}`, { contado: '10' }, admin)).status, 409);
});

test('relatórios e DRE do mês', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const pao = await produto(app, admin, { nome: 'Pão francês', preco: '2,00', custo: '1,00', estoque: '100', pesavel: true, unidade: 'kg' });
  const suco = await produto(app, admin, { nome: 'Suco de uva 1L', preco: '12,00', custo: '7,00', estoque: '30' });
  await app.post('/caixa/abrir', { abertura: '0,00' }, admin);

  for (const [produtoId, qtd] of [[pao.id, '0,350'], [suco.id, 2], [suco.id, 1]]) {
    const venda = (await app.post('/pdv/venda', {}, admin)).dados;
    await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: produtoId, quantidade: qtd }, admin);
    const total = (await app.get(`/pdv/vendas/${venda.id}`, admin)).dados.total_centavos;
    const r = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'dinheiro', valor: (total / 100).toFixed(2) }] }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
  }

  const vendas = await app.get(`/relatorios/vendas?de=${hoje()}&ate=${hoje()}`, admin);
  assert.equal(vendas.dados.vendas, 3);
  assert.equal(vendas.dados.total_centavos, 70 + 2400 + 1200);
  assert.equal(vendas.dados.ticket_medio_centavos, Math.round(3670 / 3));

  const top = await app.get(`/relatorios/mais-vendidos?de=${hoje()}&ate=${hoje()}`, admin);
  assert.equal(top.dados[0].nome, 'Suco de uva 1L');
  assert.equal(top.dados[0].qtd_mil, 3000);

  const abc = await app.get(`/relatorios/abc?de=${hoje()}&ate=${hoje()}`, admin);
  assert.equal(abc.dados[0].classe, 'A'); // o campeão de faturamento é sempre classe A
  assert.equal(abc.dados.at(-1).classe, 'C');

  const dre = await app.get(`/financeiro/dre?competencia=${competencia()}`, admin);
  assert.equal(dre.dados.receita_liquida_centavos, 3670);
  assert.equal(dre.dados.cmv_centavos, 35 + 1400 + 700);
  assert.equal(dre.dados.lucro_bruto_centavos, 3670 - 2135);

  // Exportação em CSV.
  const csv = await app.get(`/relatorios/csv/mais-vendidos?de=${hoje()}&ate=${hoje()}`, admin);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(csv.dados, /Produto;Categoria/);
  assert.match(csv.dados, /Suco de uva 1L/);
});

test('estoque insuficiente e configurações da loja', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const agua = await produto(app, admin, { nome: 'Água 500ml', preco: '3,00', custo: '1,50', estoque: '2' });
  await app.post('/caixa/abrir', { abertura: '0,00' }, admin);

  const venda = (await app.post('/pdv/venda', {}, admin)).dados;
  await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: agua.id, quantidade: 5 }, admin);
  const semEstoque = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'dinheiro', valor: '15,00' }] }, admin);
  assert.equal(semEstoque.status, 409);
  assert.match(semEstoque.dados.erro, /Estoque insuficiente/);

  // Liberando o estoque negativo, a venda passa (útil enquanto o cadastro é ajustado).
  await app.patch('/admin/config', { permitir_estoque_negativo: true }, admin);
  const passou = await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'dinheiro', valor: '15,00' }] }, admin);
  assert.equal(passou.status, 200);
  assert.equal((await app.get(`/produtos/${agua.id}`, admin)).dados.estoque_mil, -3000);

  // Configuração desconhecida é recusada.
  assert.equal((await app.patch('/admin/config', { qualquer_coisa: '1' }, admin)).status, 422);
});

test('PIX copia e cola com o valor da venda', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const bolacha = await produto(app, admin, { nome: 'Bolacha recheada', preco: '4,50', custo: '2,80', estoque: '50' });
  await app.post('/caixa/abrir', { abertura: '0,00' }, admin);
  const venda = (await app.post('/pdv/venda', {}, admin)).dados;
  await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: bolacha.id, quantidade: 2 }, admin);

  // Sem chave cadastrada, o sistema avisa.
  assert.equal((await app.post(`/pdv/vendas/${venda.id}/pix`, {}, admin)).status, 409);

  await app.patch('/admin/config', { pix_chave: 'mercadinho@condominio.com.br', pix_recebedor: 'MERCADINHO CONDOMINIO', pix_cidade: 'SAO PAULO' }, admin);
  const pix = await app.post(`/pdv/vendas/${venda.id}/pix`, {}, admin);
  assert.equal(pix.status, 200);
  assert.equal(pix.dados.valor_centavos, 900);
  assert.match(pix.dados.copia_e_cola, /^000201/);
  assert.match(pix.dados.copia_e_cola, /mercadinho@condominio\.com\.br/);
  assert.match(pix.dados.copia_e_cola, /54049\.00/);
  assert.match(pix.dados.qrcode, /^data:image\/png;base64,/);
});

test('relatório diário respeita o fuso do mercadinho (venda da noite não vai para o dia seguinte)', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const agua = await produto(app, admin, { nome: 'Água com gás 500ml', preco: '4,00', custo: '2,00', estoque: '20' });
  await app.post('/caixa/abrir', { abertura: '0,00' }, admin);

  const venda = (await app.post('/pdv/venda', {}, admin)).dados;
  await app.post(`/pdv/vendas/${venda.id}/itens`, { produto_id: agua.id, quantidade: 2 }, admin);
  await app.post(`/pdv/vendas/${venda.id}/finalizar`, { pagamentos: [{ forma: 'dinheiro', valor: '8,00' }] }, admin);

  // 12/11 às 01:30 UTC é 11/11 às 22:30 em São Paulo: a venda é do dia 11.
  app.db.prepare("UPDATE vendas SET criada_em = ?, fechada_em = ? WHERE id = ?")
    .run('2026-11-12T01:30:00.000Z', '2026-11-12T01:30:00.000Z', venda.id);

  const noDia11 = await app.get('/relatorios/vendas?de=2026-11-11&ate=2026-11-11', admin);
  assert.equal(noDia11.dados.vendas, 1);
  assert.equal(noDia11.dados.por_dia[0].dia, '2026-11-11');
  assert.equal(noDia11.dados.por_hora[0].hora, 22);

  const noDia12 = await app.get('/relatorios/vendas?de=2026-11-12&ate=2026-11-12', admin);
  assert.equal(noDia12.dados.vendas, 0);

  // O fluxo de caixa agrupa pelo mesmo dia local.
  const fluxo = await app.get('/financeiro/fluxo?de=2026-11-01&ate=2026-11-30', admin);
  assert.equal(fluxo.dados.dias.find((d) => d.dia === '2026-11-11')?.vendas, 800);
});
