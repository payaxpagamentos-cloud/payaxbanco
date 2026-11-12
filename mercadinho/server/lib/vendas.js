'use strict';

const { agora, transacao, lerConfig } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const estoque = require('./estoque');
const moradores = require('./moradores');
const caixaLib = require('./caixa');
const { hoje } = require('./datas');

const FORMAS = ['dinheiro', 'pix', 'debito', 'credito', 'fiado'];

const venda = (db, id) => db.prepare(`SELECT v.*, u.nome AS operador, t.nome AS terminal, m.nome AS morador, m.bloco, m.unidade
  FROM vendas v LEFT JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN terminais t ON t.id = v.terminal_id
  LEFT JOIN moradores m ON m.id = v.morador_id WHERE v.id = ?`).get(id);

const itens = (db, venda_id) => db.prepare(`SELECT i.*, p.unidade, p.pesavel, p.codigo_barras FROM venda_itens i
  JOIN produtos p ON p.id = i.produto_id WHERE i.venda_id = ? ORDER BY i.id`).all(venda_id);

const pagamentos = (db, venda_id) => db.prepare(`SELECT pg.*, t.nsu, t.bandeira, t.status AS transacao_status FROM pagamentos pg
  LEFT JOIN transacoes_cartao t ON t.id = pg.transacao_id WHERE pg.venda_id = ? ORDER BY pg.id`).all(venda_id);

/** Venda completa: cabeçalho, itens, pagamentos e quanto ainda falta receber. */
function obter(db, id) {
  const v = venda(db, id);
  if (!v) throw naoEncontrado('Venda');
  const lista = itens(db, id);
  const pagos = pagamentos(db, id);
  const recebido = pagos.reduce((s, p) => s + p.valor_centavos, 0);
  return { ...v, itens: lista, pagamentos: pagos, recebido_centavos: recebido, falta_centavos: Math.max(0, v.total_centavos - recebido) };
}

function exigirAberta(db, id) {
  const v = venda(db, id);
  if (!v) throw naoEncontrado('Venda');
  if (v.status !== 'aberta') throw new ErroNegocio('Esta venda já foi finalizada ou cancelada.', 409);
  return v;
}

/** Recalcula subtotal, desconto e total a partir dos itens. */
function recalcular(db, venda_id) {
  const v = venda(db, venda_id);
  const soma = db.prepare('SELECT COALESCE(SUM(total_centavos), 0) AS total FROM venda_itens WHERE venda_id = ?').get(venda_id).total;
  const desconto = Math.min(v.desconto_centavos, soma);
  db.prepare('UPDATE vendas SET subtotal_centavos = ?, desconto_centavos = ?, total_centavos = ? WHERE id = ?').run(soma, desconto, soma - desconto, venda_id);
  return obter(db, venda_id);
}

/**
 * Abre uma venda (ou reaproveita a que já está aberta): no caixa do operador, quando é o atendimento,
 * ou no terminal do balcão, quando é o próprio cliente registrando a compra.
 */
function abrir(db, { usuario_id = null, terminal_id = null, caixa_id = null, morador_id = null, origem = 'pdv' }) {
  const existente = origem === 'autoatendimento'
    ? db.prepare("SELECT id FROM vendas WHERE terminal_id = ? AND status = 'aberta' ORDER BY id DESC").get(terminal_id)
    : db.prepare("SELECT id FROM vendas WHERE usuario_id = ? AND status = 'aberta' ORDER BY id DESC").get(usuario_id);
  if (existente) return obter(db, existente.id);
  if (origem === 'pdv') {
    const caixa = caixa_id ? caixaLib.exigirAberto(db, caixa_id) : caixaLib.abertoDo(db, usuario_id);
    if (!caixa) throw new ErroNegocio('Abra o caixa antes de registrar vendas.', 409);
    caixa_id = caixa.id;
  }
  const r = db.prepare('INSERT INTO vendas (caixa_id, usuario_id, terminal_id, morador_id, origem, criada_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(caixa_id, usuario_id, terminal_id, morador_id, origem, agora());
  return obter(db, Number(r.lastInsertRowid));
}

/**
 * Carrinho esquecido no terminal (o cliente desistiu e foi embora) é cancelado sozinho,
 * para o próximo não encontrar a compra de outra pessoa na tela.
 */
function expirarAbandonadas(db, minutos = 20) {
  const corte = new Date(Date.now() - minutos * 60_000).toISOString();
  const abertas = db.prepare("SELECT id FROM vendas WHERE origem = 'autoatendimento' AND status = 'aberta' AND criada_em < ?").all(corte);
  for (const v of abertas) cancelar(db, v.id, { motivo: 'Carrinho abandonado no terminal', usuario_id: null });
  return abertas.length;
}

/**
 * Adiciona o produto à venda. Repetir o mesmo produto, com o mesmo preço e sem desconto, soma na linha que já existe
 * (é o que o operador espera ao bipar duas vezes).
 */
function adicionarItem(db, venda_id, { produto_id, qtd_mil = 1000, preco_centavos = null, desconto_centavos = 0 }) {
  return transacao(db, () => {
    exigirAberta(db, venda_id);
    const p = db.prepare('SELECT * FROM produtos WHERE id = ?').get(produto_id);
    if (!p) throw naoEncontrado('Produto');
    if (!p.ativo) throw new ErroNegocio(`${p.nome} está inativo e não pode ser vendido.`, 409);
    if (!Number.isInteger(qtd_mil) || qtd_mil <= 0) throw new ErroNegocio('Quantidade inválida.', 422);
    if (!p.pesavel && qtd_mil % 1000 !== 0) throw new ErroNegocio(`${p.nome} é vendido por unidade: use quantidades inteiras.`, 422);

    const preco = preco_centavos ?? p.preco_centavos;
    const existente = desconto_centavos === 0
      ? db.prepare('SELECT * FROM venda_itens WHERE venda_id = ? AND produto_id = ? AND preco_centavos = ? AND desconto_centavos = 0').get(venda_id, produto_id, preco)
      : null;
    if (existente) {
      const qtd = existente.qtd_mil + qtd_mil;
      db.prepare('UPDATE venda_itens SET qtd_mil = ?, total_centavos = ? WHERE id = ?').run(qtd, Math.round((qtd * preco) / 1000), existente.id);
    } else {
      const total = Math.max(0, Math.round((qtd_mil * preco) / 1000) - desconto_centavos);
      db.prepare(`INSERT INTO venda_itens (venda_id, produto_id, descricao, qtd_mil, preco_centavos, desconto_centavos, total_centavos, custo_centavos)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(venda_id, produto_id, p.nome, qtd_mil, preco, desconto_centavos, total, p.custo_centavos);
    }
    return recalcular(db, venda_id);
  });
}

function alterarItem(db, venda_id, item_id, { qtd_mil = null, desconto_centavos = null, preco_centavos = null }) {
  return transacao(db, () => {
    exigirAberta(db, venda_id);
    const item = db.prepare('SELECT * FROM venda_itens WHERE id = ? AND venda_id = ?').get(item_id, venda_id);
    if (!item) throw naoEncontrado('Item');
    const qtd = qtd_mil ?? item.qtd_mil;
    const preco = preco_centavos ?? item.preco_centavos;
    const desconto = desconto_centavos ?? item.desconto_centavos;
    if (qtd <= 0) throw new ErroNegocio('Quantidade inválida.', 422);
    const bruto = Math.round((qtd * preco) / 1000);
    if (desconto > bruto) throw new ErroNegocio('O desconto do item é maior que o valor dele.', 422);
    db.prepare('UPDATE venda_itens SET qtd_mil = ?, preco_centavos = ?, desconto_centavos = ?, total_centavos = ? WHERE id = ?')
      .run(qtd, preco, desconto, bruto - desconto, item_id);
    return recalcular(db, venda_id);
  });
}

function removerItem(db, venda_id, item_id) {
  return transacao(db, () => {
    exigirAberta(db, venda_id);
    const r = db.prepare('DELETE FROM venda_itens WHERE id = ? AND venda_id = ?').run(item_id, venda_id);
    if (!r.changes) throw naoEncontrado('Item');
    return recalcular(db, venda_id);
  });
}

function definirMorador(db, venda_id, morador_id) {
  exigirAberta(db, venda_id);
  if (morador_id && !db.prepare('SELECT 1 FROM moradores WHERE id = ? AND ativo = 1').get(morador_id)) throw naoEncontrado('Morador');
  db.prepare('UPDATE vendas SET morador_id = ? WHERE id = ?').run(morador_id, venda_id);
  return obter(db, venda_id);
}

function aplicarDesconto(db, venda_id, desconto_centavos) {
  return transacao(db, () => {
    const v = exigirAberta(db, venda_id);
    if (desconto_centavos < 0) throw new ErroNegocio('Desconto inválido.', 422);
    if (desconto_centavos > v.subtotal_centavos) throw new ErroNegocio('O desconto não pode ser maior que a venda.', 422);
    db.prepare('UPDATE vendas SET desconto_centavos = ? WHERE id = ?').run(desconto_centavos, venda_id);
    return recalcular(db, venda_id);
  });
}

/** Confere cada pagamento informado: cartão precisa de transação aprovada e ainda não usada; fiado precisa de morador com limite. */
function validarPagamentos(db, v, lista) {
  if (!Array.isArray(lista) || !lista.length) throw new ErroNegocio('Informe como a venda foi paga.', 422);
  let soma = 0;
  let troco = 0;
  const conferidos = [];
  for (const p of lista) {
    const forma = p.forma;
    if (!FORMAS.includes(forma)) throw new ErroNegocio('Forma de pagamento inválida.', 422);
    const valor = Number(p.valor_centavos);
    if (!Number.isInteger(valor) || valor <= 0) throw new ErroNegocio('Valor de pagamento inválido.', 422);
    const item = { forma, valor_centavos: valor, recebido_centavos: null, troco_centavos: 0, parcelas: 1, transacao_id: null };

    if (forma === 'dinheiro') {
      const recebido = p.recebido_centavos === undefined || p.recebido_centavos === null ? valor : Number(p.recebido_centavos);
      if (!Number.isInteger(recebido) || recebido < valor) throw new ErroNegocio('O dinheiro recebido é menor que o valor do pagamento.', 422);
      item.recebido_centavos = recebido;
      item.troco_centavos = recebido - valor;
      troco += item.troco_centavos;
    }
    if (forma === 'debito' || forma === 'credito') {
      const t = db.prepare('SELECT * FROM transacoes_cartao WHERE id = ?').get(p.transacao_id);
      if (!t) throw new ErroNegocio('Passe o cartão na maquininha antes de finalizar.', 422);
      if (t.status !== 'aprovada') throw new ErroNegocio(`A cobrança no cartão está "${t.status}". Tente novamente na maquininha.`, 409);
      if (t.venda_id && t.venda_id !== v.id) throw new ErroNegocio('Esta cobrança no cartão é de outra venda.', 409);
      if (db.prepare('SELECT 1 FROM pagamentos WHERE transacao_id = ?').get(t.id)) throw new ErroNegocio('Esta cobrança no cartão já foi usada em outra venda.', 409);
      if (t.valor_centavos !== valor) throw new ErroNegocio('O valor cobrado no cartão é diferente do valor informado.', 422);
      if (t.forma !== forma) throw new ErroNegocio('A cobrança foi feita em outra forma de cartão.', 422);
      item.transacao_id = t.id;
      item.parcelas = t.parcelas;
    }
    if (forma === 'fiado') {
      if (!v.morador_id) throw new ErroNegocio('Escolha o morador para lançar na conta.', 422);
      moradores.conferirLimite(db, v.morador_id, valor);
    }
    soma += valor;
    conferidos.push(item);
  }
  if (soma !== v.total_centavos) throw new ErroNegocio('A soma dos pagamentos é diferente do total da venda.', 422);
  return { conferidos, troco };
}

/** Fecha a venda: confere os pagamentos, baixa o estoque, lança o fiado na conta do morador e grava o custo da venda. */
function finalizar(db, venda_id, { pagamentos: lista, usuario_id }) {
  return transacao(db, () => {
    const v = exigirAberta(db, venda_id);
    const linhas = itens(db, venda_id);
    if (!linhas.length) throw new ErroNegocio('A venda está sem itens.', 422);
    if (v.origem === 'pdv') caixaLib.exigirAberto(db, v.caixa_id);
    const { conferidos } = validarPagamentos(db, v, lista);

    let custoTotal = 0;
    for (const item of linhas) {
      const p = db.prepare('SELECT custo_centavos FROM produtos WHERE id = ?').get(item.produto_id);
      const custo = Math.round((item.qtd_mil * p.custo_centavos) / 1000);
      custoTotal += custo;
      db.prepare('UPDATE venda_itens SET custo_centavos = ? WHERE id = ?').run(p.custo_centavos, item.id);
      estoque.movimentar(db, { produto_id: item.produto_id, tipo: 'venda', qtd_mil: item.qtd_mil, venda_id, usuario_id, documento: `Venda #${venda_id}` });
    }

    for (const p of conferidos) {
      db.prepare(`INSERT INTO pagamentos (venda_id, forma, valor_centavos, recebido_centavos, troco_centavos, parcelas, transacao_id, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(venda_id, p.forma, p.valor_centavos, p.recebido_centavos, p.troco_centavos, p.parcelas, p.transacao_id, agora());
      if (p.transacao_id) db.prepare('UPDATE transacoes_cartao SET venda_id = ? WHERE id = ?').run(venda_id, p.transacao_id);
      if (p.forma === 'fiado') {
        moradores.lancar(db, { morador_id: v.morador_id, tipo: 'compra', descricao: `Compra no mercadinho (venda #${venda_id})`, valor_centavos: p.valor_centavos, venda_id, usuario_id });
      }
    }
    db.prepare("UPDATE vendas SET status = 'paga', custo_centavos = ?, fechada_em = ? WHERE id = ?").run(custoTotal, agora(), venda_id);
    return obter(db, venda_id);
  });
}

/** Cancela a venda. Se já estava paga, devolve o estoque, estorna a conta do morador e cancela as cobranças no cartão. */
function cancelar(db, venda_id, { motivo, usuario_id }) {
  return transacao(db, () => {
    const v = venda(db, venda_id);
    if (!v) throw naoEncontrado('Venda');
    if (v.status === 'cancelada') throw new ErroNegocio('Esta venda já foi cancelada.', 409);
    if (v.status === 'paga') {
      for (const item of itens(db, venda_id)) {
        estoque.movimentar(db, {
          produto_id: item.produto_id, tipo: 'devolucao', qtd_mil: item.qtd_mil, venda_id, usuario_id,
          documento: `Cancelamento da venda #${venda_id}`, observacao: motivo,
        });
      }
      for (const p of pagamentos(db, venda_id)) {
        if (p.forma === 'fiado' && v.morador_id) {
          moradores.lancar(db, { morador_id: v.morador_id, tipo: 'estorno', descricao: `Estorno da venda #${venda_id}`, valor_centavos: -p.valor_centavos, venda_id, usuario_id });
        }
        if (p.transacao_id) {
          db.prepare("UPDATE transacoes_cartao SET status = 'cancelada', mensagem = 'Venda cancelada', atualizada_em = ? WHERE id = ?").run(agora(), p.transacao_id);
          db.prepare("UPDATE lancamentos SET status = 'cancelado' WHERE transacao_id = ? AND status = 'aberto'").run(p.transacao_id);
        }
      }
    }
    db.prepare("UPDATE vendas SET status = 'cancelada', cancelada_em = ?, cancelada_por = ?, motivo_cancelamento = ? WHERE id = ?")
      .run(agora(), usuario_id, motivo, venda_id);
    return obter(db, venda_id);
  });
}

const listar = (db, { status = null, caixa_id = null, morador_id = null, de = null, ate = null, limite = 100 } = {}) => db.prepare(`
  SELECT v.*, u.nome AS operador, t.nome AS terminal, m.nome AS morador, m.bloco, m.unidade,
    (SELECT GROUP_CONCAT(DISTINCT pg.forma) FROM pagamentos pg WHERE pg.venda_id = v.id) AS formas
  FROM vendas v LEFT JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN terminais t ON t.id = v.terminal_id
  LEFT JOIN moradores m ON m.id = v.morador_id
  WHERE (? IS NULL OR v.status = ?) AND (? IS NULL OR v.caixa_id = ?) AND (? IS NULL OR v.morador_id = ?)
    AND (? IS NULL OR v.criada_em >= ?) AND (? IS NULL OR v.criada_em < ?)
  ORDER BY v.id DESC LIMIT ?`).all(status, status, caixa_id, caixa_id, morador_id, morador_id, de, de, ate, ate, limite);

/** Dados do cupom (não fiscal) entregue ao cliente. */
function cupom(db, venda_id) {
  const v = obter(db, venda_id);
  const cfg = lerConfig(db);
  return {
    mercado: { nome: cfg.nome_mercado, condominio: cfg.condominio, cnpj: cfg.cnpj, endereco: cfg.endereco },
    venda: v,
    emitido_em: agora(),
    data: hoje(),
    observacao: 'Documento sem valor fiscal.',
  };
}

module.exports = { abrir, expirarAbandonadas, obter, listar, itens, pagamentos, adicionarItem, alterarItem, removerItem, definirMorador, aplicarDesconto, finalizar, cancelar, cupom, recalcular, FORMAS };
