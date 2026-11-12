'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');

/** Prepara a loja: produtos, chave PIX e um terminal já pareado. */
async function comTerminal(app, { pix = true, conta = false } = {}) {
  const admin = await app.login();
  if (pix) await app.patch('/admin/config', { pix_chave: 'mercadinho@condominio.com.br' }, admin);
  // A compra na conta do morador vem desligada de fábrica: o terminal nasce com cartão e PIX.
  if (conta) await app.patch('/admin/config', { terminal_conta: true }, admin);
  const cafe = (await app.post('/produtos', { nome: 'Café 500g', codigo_barras: '7891000053508', preco: '21,90', custo: '15,00', estoque: '20', categoria_id: 1 }, admin)).dados;
  const agua = (await app.post('/produtos', { nome: 'Água 1,5L', preco: '3,99', custo: '2,20', estoque: '40', categoria_id: 2 }, admin)).dados;
  const criado = await app.post('/admin/terminais', { nome: 'Balcão do mercadinho' }, admin);
  assert.equal(criado.status, 201);
  const pareado = await app.post('/terminal/parear', { codigo: criado.dados.codigo });
  assert.equal(pareado.status, 201);
  return { admin, cafe, agua, terminal: criado.dados.terminal, codigo: criado.dados.codigo, token: pareado.dados.token };
}

test('terminal: pareamento, token próprio e separação do acesso da equipe', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const { admin, token, codigo } = await comTerminal(app);

  // Código errado não pareia.
  assert.equal((await app.post('/terminal/parear', { codigo: 'AAAA-BBBB' })).status, 401);

  // O token do terminal só abre as rotas do terminal.
  assert.equal((await app.get('/terminal/inicio', token)).status, 200);
  assert.equal((await app.get('/produtos', token)).status, 401);
  assert.equal((await app.get('/painel', token)).status, 401);
  // O token do terminal nem chega a ser uma sessão de usuário: cai antes de qualquer checagem de perfil.
  assert.equal((await app.get('/financeiro/resumo', token)).status, 401);
  // E a sessão da equipe não serve como terminal.
  assert.equal((await app.get('/terminal/inicio', admin)).status, 401);
  // Sem token nenhum, também não.
  assert.equal((await app.get('/terminal/inicio')).status, 401);

  // Desativado pela administração, o aparelho para na hora.
  const lista = await app.get('/admin/terminais', admin);
  assert.equal(lista.dados.length, 1);
  assert.ok(lista.dados[0].pareado_em);
  await app.patch(`/admin/terminais/${lista.dados[0].id}`, { ativo: false }, admin);
  assert.equal((await app.get('/terminal/inicio', token)).status, 403);
  // E o código antigo não pareia mais.
  assert.equal((await app.post('/terminal/parear', { codigo })).status, 401);
});

test('terminal: cliente monta o carrinho e paga no PIX', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const { admin, cafe, token } = await comTerminal(app);

  const inicio = await app.get('/terminal/inicio', token);
  assert.equal(inicio.dados.formas.pix, true);
  assert.equal(inicio.dados.formas.debito, true);
  assert.equal(inicio.dados.formas.credito, true);
  // De fábrica o terminal não vende na conta do morador.
  assert.equal(inicio.dados.formas.fiado, false);
  assert.equal(inicio.dados.mercado.nome, 'Mercado Binho');

  // Começa sem compra na tela.
  assert.equal((await app.get('/terminal/venda', token)).dados, null);
  const venda = (await app.post('/terminal/venda', {}, token)).dados;

  // Bipa pelo código de barras e depois escolhe pelo nome.
  const comCafe = await app.post(`/terminal/venda/${venda.id}/itens`, { codigo: '7891000053508' }, token);
  assert.equal(comCafe.status, 201);
  assert.equal(comCafe.dados.total_centavos, 2190);
  const comAgua = await app.post(`/terminal/venda/${venda.id}/itens`, { codigo: 'Água', quantidade: 2 }, token);
  assert.equal(comAgua.dados.total_centavos, 2190 + 798);

  // O cliente muda de ideia e tira uma água.
  const item = comAgua.dados.itens.find((i) => i.descricao.startsWith('Água'));
  const menos = await app.patch(`/terminal/venda/${venda.id}/itens/${item.id}`, { quantidade: 1 }, token);
  assert.equal(menos.dados.total_centavos, 2190 + 399);

  const pix = await app.post(`/terminal/venda/${venda.id}/pix`, {}, token);
  assert.equal(pix.status, 200);
  assert.equal(pix.dados.valor_centavos, 2589);
  assert.match(pix.dados.copia_e_cola, /mercadinho@condominio\.com\.br/);
  assert.match(pix.dados.qrcode, /^data:image\/png;base64,/);

  // Dinheiro não existe no terminal: não há quem dê troco.
  const dinheiro = await app.post(`/terminal/venda/${venda.id}/finalizar`, { pagamentos: [{ forma: 'dinheiro', valor: '25,89' }] }, token);
  assert.equal(dinheiro.status, 422);

  const paga = await app.post(`/terminal/venda/${venda.id}/finalizar`, { pagamentos: [{ forma: 'pix', valor: '25,89' }] }, token);
  assert.equal(paga.status, 200, JSON.stringify(paga.dados));
  assert.equal(paga.dados.status, 'paga');
  assert.equal(paga.dados.origem, 'autoatendimento');

  // Baixou do estoque e a tela do terminal volta a ficar livre.
  assert.equal((await app.get(`/produtos/${cafe.id}`, admin)).dados.estoque_mil, 19_000);
  assert.equal((await app.get('/terminal/venda', token)).dados, null);

  // O cupom continua disponível para quem acabou de comprar.
  const cupom = await app.get(`/terminal/venda/${paga.dados.id}/cupom`, token);
  assert.equal(cupom.dados.venda.total_centavos, 2589);

  // A gestão vê o PIX na lista de conferência e marca como conferido.
  const pendentes = await app.get('/pdv/conferencia?pendentes=1', admin);
  assert.equal(pendentes.dados.length, 1);
  assert.equal(pendentes.dados[0].terminal, 'Balcão do mercadinho');
  const conferido = await app.post(`/pdv/pagamentos/${pendentes.dados[0].id}/conferir`, {}, admin);
  assert.ok(conferido.dados.conferido_em);
  assert.equal((await app.get('/pdv/conferencia?pendentes=1', admin)).dados.length, 0);
});

test('terminal: compra na conta do morador com senha', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const { admin, cafe, token } = await comTerminal(app, { conta: true });
  const morador = (await app.post('/moradores', { nome: 'Carla Souza', bloco: 'B', unidade: '304', limite: '50,00' }, admin)).dados;

  const venda = (await app.post('/terminal/venda', {}, token)).dados;
  await app.post(`/terminal/venda/${venda.id}/itens`, { produto_id: cafe.id }, token);

  // O cliente digita a unidade e vê só quem mora nela.
  const naUnidade = await app.get('/terminal/unidade/304/moradores', token);
  assert.equal(naUnidade.dados.length, 1);
  assert.equal(naUnidade.dados[0].nome, 'Carla Souza');
  assert.equal(naUnidade.dados[0].pode_usar, false); // ainda sem senha cadastrada
  assert.equal((await app.get('/terminal/unidade/999/moradores', token)).status, 404);

  // Sem senha definida, a conta não pode ser usada.
  assert.equal((await app.post(`/terminal/venda/${venda.id}/conta`, { morador_id: morador.id, pin: '1234' }, token)).status, 409);

  // A gestão define a senha (e recusa senhas fracas).
  assert.equal((await app.post(`/moradores/${morador.id}/pin`, { pin: '1111' }, admin)).status, 422);
  assert.equal((await app.post(`/moradores/${morador.id}/pin`, { pin: '12' }, admin)).status, 422);
  assert.equal((await app.post(`/moradores/${morador.id}/pin`, { pin: '4703' }, admin)).status, 200);
  assert.equal((await app.get(`/moradores/${morador.id}`, admin)).dados.tem_pin, true);
  assert.equal((await app.get('/terminal/unidade/304/moradores', token)).dados[0].pode_usar, true);

  // Senha errada não passa e, depois de cinco tentativas, a conta trava por um tempo.
  assert.equal((await app.post(`/terminal/venda/${venda.id}/conta`, { morador_id: morador.id, pin: '0000' }, token)).status, 401);
  for (let i = 0; i < 4; i++) await app.post(`/terminal/venda/${venda.id}/conta`, { morador_id: morador.id, pin: '0000' }, token);
  const travado = await app.post(`/terminal/venda/${venda.id}/conta`, { morador_id: morador.id, pin: '4703' }, token);
  assert.equal(travado.status, 429);
  assert.match(travado.dados.erro, /tentativas/i);
});

test('terminal: conta do morador confere o limite e lança na fatura', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const { admin, cafe, token } = await comTerminal(app, { conta: true });
  const morador = (await app.post('/moradores', { nome: 'Roberto Lima', bloco: 'A', unidade: '202', limite: '30,00' }, admin)).dados;
  await app.post(`/moradores/${morador.id}/pin`, { pin: '2468' }, admin);

  const venda = (await app.post('/terminal/venda', {}, token)).dados;
  await app.post(`/terminal/venda/${venda.id}/itens`, { produto_id: cafe.id }, token);

  const identificado = await app.post(`/terminal/venda/${venda.id}/conta`, { morador_id: morador.id, pin: '2468' }, token);
  assert.equal(identificado.status, 200);
  assert.equal(identificado.dados.morador.nome, 'Roberto Lima');
  assert.equal(identificado.dados.morador.disponivel_centavos, 3000);

  const paga = await app.post(`/terminal/venda/${venda.id}/finalizar`, { pagamentos: [{ forma: 'fiado', valor: '21,90' }] }, token);
  assert.equal(paga.status, 200);

  const ficha = await app.get(`/moradores/${morador.id}`, admin);
  assert.equal(ficha.dados.saldo_centavos, 2190);
  assert.equal(ficha.dados.extrato[0].venda_id, venda.id);

  // Outra compra estoura o limite e é recusada no terminal.
  const outra = (await app.post('/terminal/venda', {}, token)).dados;
  await app.post(`/terminal/venda/${outra.id}/itens`, { produto_id: cafe.id }, token);
  await app.post(`/terminal/venda/${outra.id}/conta`, { morador_id: morador.id, pin: '2468' }, token);
  const recusada = await app.post(`/terminal/venda/${outra.id}/finalizar`, { pagamentos: [{ forma: 'fiado', valor: '21,90' }] }, token);
  assert.equal(recusada.status, 409);
  assert.match(recusada.dados.erro, /Limite/);
});

test('terminal: cartão na maquininha e compra de outro terminal fora de alcance', async (t) => {
  const app = await iniciar();
  t.after(() => app.fechar());
  const { admin, cafe, token } = await comTerminal(app);
  const maquininha_id = (await app.get('/terminal/inicio', token)).dados.maquininhas[0].id;

  const venda = (await app.post('/terminal/venda', {}, token)).dados;
  await app.post(`/terminal/venda/${venda.id}/itens`, { produto_id: cafe.id }, token);

  const cobranca = await app.post(`/terminal/venda/${venda.id}/cartao`, { maquininha_id, forma: 'debito' }, token);
  assert.equal(cobranca.status, 201);
  assert.equal(cobranca.dados.status, 'aprovada');
  const paga = await app.post(`/terminal/venda/${venda.id}/finalizar`, { pagamentos: [{ forma: 'debito', valor: '21,90', transacao_id: cobranca.dados.id }] }, token);
  assert.equal(paga.status, 200);
  assert.equal(paga.dados.pagamentos[0].forma, 'debito');

  // Um segundo terminal não enxerga a compra do primeiro.
  const outro = await app.post('/admin/terminais', { nome: 'Terminal 2' }, admin);
  const token2 = (await app.post('/terminal/parear', { codigo: outro.dados.codigo })).dados.token;
  const alheia = (await app.post('/terminal/venda', {}, token)).dados;
  assert.equal((await app.get(`/terminal/venda/${alheia.id}/cupom`, token2)).status, 404);
  assert.equal((await app.post(`/terminal/venda/${alheia.id}/itens`, { produto_id: cafe.id }, token2)).status, 404);

  // Carrinho esquecido no balcão é cancelado sozinho.
  app.db.prepare("UPDATE vendas SET criada_em = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(alheia.id);
  assert.equal(require('../server/lib/vendas').expirarAbandonadas(app.db), 1);
  assert.equal((await app.get('/terminal/venda', token)).dados, null);
});
