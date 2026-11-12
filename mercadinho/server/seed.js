'use strict';

/**
 * Dados de demonstração de um mercadinho de condomínio: equipe, fornecedores, produtos de prateleira,
 * moradores com conta, uma compra recebida e vendas dos últimos dias. Senha de todos: demo12345.
 * Não use em produção.
 */
const { abrir, agora, gravarConfig } = require('./db');
const { hashSenha } = require('./lib/senha');
const produtosLib = require('./lib/produtos');
const estoque = require('./lib/estoque');
const vendas = require('./lib/vendas');
const caixaLib = require('./lib/caixa');
const moradores = require('./lib/moradores');
const compras = require('./lib/compras');
const { hoje, somarDias } = require('./lib/datas');

const db = abrir();
const senha = hashSenha('demo12345');

const usuario = (nome, email, perfil) => {
  const u = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (u) return u.id;
  return Number(db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(nome, email, senha, perfil, agora()).lastInsertRowid);
};

if (db.prepare('SELECT COUNT(*) AS n FROM produtos').get().n > 0) {
  console.log('[Mercadinho] O banco já tem produtos: nada a fazer.');
  process.exit(0);
}

gravarConfig(db, 'nome_mercado', 'Mercadinho do Condomínio');
gravarConfig(db, 'condominio', 'Residencial Jardim das Acácias');
gravarConfig(db, 'endereco', 'Rua das Acácias, 120 — Térreo do Bloco A');
gravarConfig(db, 'pix_chave', 'mercadinho@acacias.com.br');
gravarConfig(db, 'pix_recebedor', 'MERCADINHO ACACIAS');

const gerente = usuario('Marina Gerente', 'gerente@mercadinho.com.br', 'gerente');
const operador = usuario('Ana Caixa', 'caixa@mercadinho.com.br', 'caixa');
usuario('Beto Estoque', 'estoque@mercadinho.com.br', 'estoque');

const fornecedor = (nome, cnpj, prazo) => Number(db.prepare(`INSERT INTO fornecedores (nome, cnpj, prazo_entrega_dias, prazo_pagamento_dias, criado_em)
  VALUES (?, ?, 2, ?, ?)`).run(nome, cnpj, prazo, agora()).lastInsertRowid);
const distribuidora = fornecedor('Distribuidora Central Alimentos', '11222333000181', 28);
const bebidas = fornecedor('Bebidas Rio Claro', '04252011000110', 14);
const padaria = fornecedor('Panificadora do Bairro', '19131243000197', 7);

const cat = Object.fromEntries(db.prepare('SELECT id, nome FROM categorias').all().map((c) => [c.nome, c.id]));

// nome, código de barras, categoria, preço, custo, estoque, mínimo, fornecedor, pesável, validade
const PRODUTOS = [
  ['Arroz branco tipo 1 - 5 kg', '7891000053508', 'Mercearia', '28,90', '21,50', 24, 6, distribuidora],
  ['Feijão carioca 1 kg', '7896006710011', 'Mercearia', '8,90', '6,20', 30, 8, distribuidora],
  ['Açúcar refinado 1 kg', '7891910000197', 'Mercearia', '5,49', '3,80', 28, 8, distribuidora],
  ['Café torrado e moído 500 g', '7896089012347', 'Mercearia', '21,90', '16,00', 18, 6, distribuidora],
  ['Óleo de soja 900 ml', '7891107101621', 'Mercearia', '7,89', '5,70', 20, 6, distribuidora],
  ['Macarrão espaguete 500 g', '7896005800010', 'Mercearia', '4,99', '3,20', 36, 10, distribuidora],
  ['Molho de tomate 340 g', '7896102500011', 'Mercearia', '3,49', '2,10', 40, 12, distribuidora],
  ['Sal refinado 1 kg', '7896110000015', 'Mercearia', '3,29', '1,90', 15, 5, distribuidora],
  ['Água mineral 1,5 L', '7891910000203', 'Bebidas', '3,99', '2,20', 48, 12, bebidas],
  ['Refrigerante cola 2 L', '7894900011517', 'Bebidas', '10,90', '7,40', 36, 12, bebidas],
  ['Suco de uva integral 1 L', '7896102511109', 'Bebidas', '16,90', '11,80', 12, 4, bebidas],
  ['Cerveja lata 350 ml', '7891991010016', 'Bebidas', '4,49', '2,95', 72, 24, bebidas],
  ['Energético 473 ml', '7896112500100', 'Bebidas', '9,90', '6,50', 18, 6, bebidas],
  ['Leite integral 1 L', '7891000100103', 'Frios e laticínios', '5,79', '4,10', 36, 12, distribuidora, false, 45],
  ['Manteiga com sal 200 g', '7891000315507', 'Frios e laticínios', '14,90', '10,90', 10, 4, distribuidora, false, 60],
  ['Queijo mussarela fatiado - kg', null, 'Frios e laticínios', '46,90', '33,00', 3, 1, distribuidora, true, 20],
  ['Presunto cozido fatiado - kg', null, 'Frios e laticínios', '38,90', '27,50', 3, 1, distribuidora, true, 20],
  ['Iogurte morango 170 g', '7891025104285', 'Frios e laticínios', '3,29', '2,10', 30, 12, distribuidora, false, 25],
  ['Pão francês - kg', null, 'Padaria', '18,90', '11,00', 6, 2, padaria, true, 2],
  ['Pão de forma 500 g', '7891000244708', 'Padaria', '9,90', '6,80', 12, 4, padaria, false, 12],
  ['Bolo caseiro fatia', null, 'Padaria', '6,50', '3,40', 10, 3, padaria, false, 4],
  ['Banana prata - kg', null, 'Hortifrúti', '7,90', '4,60', 12, 4, distribuidora, true, 6],
  ['Tomate - kg', null, 'Hortifrúti', '9,90', '6,20', 10, 4, distribuidora, true, 7],
  ['Batata - kg', null, 'Hortifrúti', '6,90', '4,30', 15, 5, distribuidora, true, 15],
  ['Cebola - kg', null, 'Hortifrúti', '5,90', '3,50', 12, 4, distribuidora, true, 20],
  ['Pizza congelada calabresa', '7891515400101', 'Congelados', '24,90', '17,50', 8, 3, distribuidora, false, 120],
  ['Sorvete pote 1,5 L', '7891025115007', 'Congelados', '27,90', '19,90', 6, 2, distribuidora, false, 180],
  ['Chocolate ao leite 90 g', '7891008123456', 'Doces e salgadinhos', '7,49', '4,90', 24, 8, distribuidora],
  ['Salgadinho de milho 110 g', '7892840812348', 'Doces e salgadinhos', '8,90', '5,80', 20, 6, distribuidora],
  ['Biscoito recheado 130 g', '7891000315729', 'Doces e salgadinhos', '3,99', '2,45', 30, 10, distribuidora],
  ['Detergente neutro 500 ml', '7891024136706', 'Limpeza', '3,19', '1,85', 24, 8, distribuidora],
  ['Sabão em pó 1 kg', '7891150080324', 'Limpeza', '19,90', '14,20', 10, 4, distribuidora],
  ['Papel higiênico 4 rolos', '7896110195063', 'Limpeza', '12,90', '8,90', 18, 6, distribuidora],
  ['Água sanitária 1 L', '7891035100116', 'Limpeza', '5,49', '3,30', 14, 5, distribuidora],
  ['Sabonete 90 g', '7891150016903', 'Higiene', '3,49', '2,05', 30, 10, distribuidora],
  ['Creme dental 90 g', '7891024141236', 'Higiene', '7,90', '5,10', 16, 6, distribuidora],
  ['Papel toalha 2 rolos', '7896110195070', 'Higiene', '10,90', '7,40', 12, 4, distribuidora],
];

const criados = [];
for (const [nome, codigo, categoria, preco, custo, estoqueInicial, minimo, fornecedorId, pesavel = false, validadeDias = null] of PRODUTOS) {
  criados.push(produtosLib.criar(db, {
    nome, codigo_barras: codigo, categoria_id: cat[categoria], fornecedor_id: fornecedorId,
    unidade: pesavel ? 'kg' : 'un', pesavel, preco, custo, estoque: estoqueInicial, estoque_minimo: minimo,
    controla_validade: validadeDias !== null,
    validade: validadeDias === null ? null : somarDias(hoje(), validadeDias),
  }, { id: gerente }));
}
const porNome = Object.fromEntries(criados.map((p) => [p.nome, p]));

const MORADORES = [
  ['Carla Souza', 'A', '101', '11988880001', '50,00'],
  ['Roberto Lima', 'A', '204', '11988880002', null],
  ['Fernanda Dias', 'B', '302', '11988880003', '80,00'],
  ['Marcos Pereira', 'B', '405', '11988880004', null],
  ['Juliana Alves', 'C', '107', '11988880005', '150,00'],
  ['Seu Antônio (portaria)', '-', 'Portaria', '11988880006', '20,00'],
];
const moradoresCriados = MORADORES.map(([nome, bloco, unidade, telefone, limite]) => moradores.criar(db, {
  nome, bloco, unidade, telefone, email: null, documento: null,
  limite_centavos: limite ? Math.round(Number(limite.replace(',', '.')) * 100) : null, fiado_liberado: 1, observacao: null,
}));

// Acesso ao portal para a primeira moradora.
db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, morador_id, criado_em) VALUES (?, ?, ?, 'morador', ?, ?)")
  .run(moradoresCriados[0].nome, 'moradora@demo.com', senha, moradoresCriados[0].id, agora());

// Uma compra já recebida da distribuidora (entra no estoque e abre as contas a pagar).
const compra = compras.criar(db, {
  fornecedor_id: bebidas, parcelas: 2, numero_nota: '4521', observacao: 'Reposição semanal de bebidas',
  itens: [
    { produto_id: porNome['Refrigerante cola 2 L'].id, qtd_mil: 24_000, custo_centavos: 730 },
    { produto_id: porNome['Cerveja lata 350 ml'].id, qtd_mil: 48_000, custo_centavos: 290 },
    { produto_id: porNome['Água mineral 1,5 L'].id, qtd_mil: 24_000, custo_centavos: 215 },
  ],
  usuario_id: gerente, previsao: null, frete_centavos: 0, desconto_centavos: 0,
});
compras.receber(db, compra.id, { usuario_id: gerente, numero_nota: '4521', itens: [] });

// Um pedido em aberto, esperando o fornecedor.
compras.enviar(db, compras.criar(db, {
  fornecedor_id: distribuidora, parcelas: 1, numero_nota: null, previsao: somarDias(hoje(), 2), observacao: 'Pedido da semana',
  itens: [
    { produto_id: porNome['Arroz branco tipo 1 - 5 kg'].id, qtd_mil: 12_000, custo_centavos: 2150 },
    { produto_id: porNome['Feijão carioca 1 kg'].id, qtd_mil: 20_000, custo_centavos: 620 },
  ],
  usuario_id: gerente, frete_centavos: 0, desconto_centavos: 0,
}).id);

// Contas fixas do mês.
const contaFixa = (descricao, categoria, valor, dia) => db.prepare(`INSERT INTO lancamentos (tipo, descricao, categoria, valor_centavos, vencimento, criado_em, criado_por)
  VALUES ('pagar', ?, ?, ?, ?, ?, ?)`).run(descricao, categoria, valor, `${hoje().slice(0, 7)}-${dia}`, agora(), gerente);
contaFixa('Energia elétrica da loja', 'Energia', 38_000, '15');
contaFixa('Internet e maquininha', 'Internet e telefone', 12_990, '10');
contaFixa('Rateio do espaço com o condomínio', 'Rateio do condomínio', 60_000, '05');
contaFixa('Embalagens e sacolas', 'Embalagens', 18_000, '20');

/** Vendas dos últimos dias, para os relatórios e o painel não nascerem vazios. */
const CESTAS = [
  [['Pão francês - kg', 350], ['Leite integral 1 L', 1000], ['Manteiga com sal 200 g', 1000]],
  [['Refrigerante cola 2 L', 1000], ['Salgadinho de milho 110 g', 2000]],
  [['Arroz branco tipo 1 - 5 kg', 1000], ['Feijão carioca 1 kg', 2000], ['Óleo de soja 900 ml', 1000]],
  [['Cerveja lata 350 ml', 6000], ['Chocolate ao leite 90 g', 1000]],
  [['Banana prata - kg', 1200], ['Tomate - kg', 800], ['Batata - kg', 2000]],
  [['Detergente neutro 500 ml', 2000], ['Papel higiênico 4 rolos', 1000], ['Sabonete 90 g', 3000]],
  [['Água mineral 1,5 L', 2000], ['Biscoito recheado 130 g', 2000]],
  [['Pizza congelada calabresa', 1000], ['Sorvete pote 1,5 L', 1000]],
];
const FORMAS = ['dinheiro', 'pix', 'debito', 'credito', 'fiado'];
const caixa = caixaLib.abrirCaixa(db, { usuario_id: operador, abertura_centavos: 20_000 });
let n = 0;
for (let diasAtras = 6; diasAtras >= 0; diasAtras--) {
  for (let i = 0; i < 3 + (diasAtras % 3); i++) {
    const cesta = CESTAS[n % CESTAS.length];
    const forma = FORMAS[n % FORMAS.length];
    const morador = forma === 'fiado' ? moradoresCriados[n % moradoresCriados.length] : null;
    const venda = vendas.abrir(db, { usuario_id: operador, caixa_id: caixa.id, morador_id: morador?.id ?? null });
    for (const [nome, qtd] of cesta) vendas.adicionarItem(db, venda.id, { produto_id: porNome[nome].id, qtd_mil: qtd });
    const atual = vendas.obter(db, venda.id);
    let transacao_id = null;
    if (forma === 'debito' || forma === 'credito') {
      const maquininha = db.prepare('SELECT id FROM maquininhas LIMIT 1').get().id;
      const t = db.prepare(`INSERT INTO transacoes_cartao (maquininha_id, venda_id, forma, parcelas, valor_centavos, taxa_centavos, liquido_centavos, status, nsu, bandeira, previsao_credito, criada_em, atualizada_em)
        VALUES (?, ?, ?, 1, ?, ?, ?, 'aprovada', ?, 'Visa', ?, ?, ?)`)
        .run(maquininha, venda.id, forma, atual.total_centavos, Math.round(atual.total_centavos * 0.0349),
          atual.total_centavos - Math.round(atual.total_centavos * 0.0349), String(100000 + n), somarDias(hoje(), 30), agora(), agora());
      transacao_id = Number(t.lastInsertRowid);
    }
    vendas.finalizar(db, venda.id, {
      pagamentos: [{ forma, valor_centavos: atual.total_centavos, recebido_centavos: forma === 'dinheiro' ? atual.total_centavos : null, transacao_id }],
      usuario_id: operador,
    });
    // Joga a venda para o dia certo (a demonstração precisa de histórico).
    const data = new Date(Date.now() - diasAtras * 86_400_000 - i * 3_600_000).toISOString();
    db.prepare('UPDATE vendas SET criada_em = ?, fechada_em = ? WHERE id = ?').run(data, data, venda.id);
    db.prepare('UPDATE pagamentos SET criado_em = ? WHERE venda_id = ?').run(data, venda.id);
    n++;
  }
}

// Alguns itens no fim do estoque e um lote vencendo, para a tela de alertas ter o que mostrar.
estoque.movimentar(db, { produto_id: porNome['Café torrado e moído 500 g'].id, tipo: 'perda', qtd_mil: 14_000, observacao: 'Acerto de inventário da semana', usuario_id: operador, permitirNegativo: true });
estoque.movimentar(db, { produto_id: porNome['Papel toalha 2 rolos'].id, tipo: 'perda', qtd_mil: 9000, observacao: 'Embalagens molhadas', usuario_id: operador, permitirNegativo: true });
db.prepare('UPDATE lotes SET validade = ? WHERE produto_id = ?').run(somarDias(hoje(), 3), porNome['Iogurte morango 170 g'].id);

console.log(`[Mercadinho] Demonstração pronta: ${criados.length} produtos, ${moradoresCriados.length} moradores e ${n} vendas.`);
console.log('[Mercadinho] Acessos (senha demo12345): gerente@mercadinho.com.br · caixa@mercadinho.com.br · estoque@mercadinho.com.br · moradora@demo.com');
console.log(`[Mercadinho] Administrador: ${require('./config').admin.email} (senha definida em MERCADO_ADMIN_SENHA).`);
