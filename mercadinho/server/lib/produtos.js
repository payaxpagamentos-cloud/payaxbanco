'use strict';

const { agora, lerConfig } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');
const { hoje } = require('./datas');

const CAMPOS = `p.id, p.codigo_barras, p.nome, p.categoria_id, p.fornecedor_id, p.unidade, p.pesavel, p.preco_centavos,
  p.custo_centavos, p.estoque_mil, p.estoque_minimo_mil, p.controla_validade, p.foto, p.oferta_preco_centavos, p.oferta_ate,
  p.ativo, p.criado_em, p.atualizado_em,
  c.nome AS categoria, c.cor AS categoria_cor, f.nome AS fornecedor`;
const JUNCOES = 'FROM produtos p LEFT JOIN categorias c ON c.id = p.categoria_id LEFT JOIN fornecedores f ON f.id = p.fornecedor_id';

/** Margem do preço sobre o custo, em pontos-base (custo 1000 e preço 1500 => 5000 = 50%). */
const margemBp = (preco, custo) => (custo > 0 ? Math.round(((preco - custo) / custo) * 10_000) : null);

/**
 * A oferta vale se tem preço menor que o normal e a data ainda não passou (o último dia conta).
 * É a única regra de preço: a venda, o terminal e a vitrine passam todos por aqui.
 */
function emOferta(p, dia = hoje()) {
  return p?.oferta_preco_centavos != null && p.oferta_preco_centavos < p.preco_centavos && (!p.oferta_ate || dia <= p.oferta_ate);
}
const precoVigente = (p, dia = hoje()) => (emOferta(p, dia) ? p.oferta_preco_centavos : p.preco_centavos);

const comMargem = (p) => (p ? {
  ...p,
  margem_bp: margemBp(p.preco_centavos, p.custo_centavos),
  em_oferta: emOferta(p),
  preco_vigente_centavos: precoVigente(p),
} : p);

function listar(db, { busca = '', categoria_id = null, fornecedor_id = null, situacao = 'ativos', ordem = 'nome', limite = 500 } = {}) {
  const where = [];
  const p = [];
  if (situacao === 'ativos') where.push('p.ativo = 1');
  if (situacao === 'inativos') where.push('p.ativo = 0');
  if (categoria_id) { where.push('p.categoria_id = ?'); p.push(categoria_id); }
  if (fornecedor_id) { where.push('p.fornecedor_id = ?'); p.push(fornecedor_id); }
  if (situacao === 'baixo') where.push('p.ativo = 1 AND p.estoque_minimo_mil > 0 AND p.estoque_mil <= p.estoque_minimo_mil');
  const texto = String(busca ?? '').trim();
  if (texto) { where.push('(p.nome LIKE ? OR p.codigo_barras LIKE ?)'); p.push(`%${texto}%`, `${texto}%`); }
  const ordens = { nome: 'p.nome', estoque: 'p.estoque_mil, p.nome', preco: 'p.preco_centavos DESC', recentes: 'p.id DESC' };
  return db.prepare(`SELECT ${CAMPOS} ${JUNCOES} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${ordens[ordem] ?? ordens.nome} LIMIT ?`).all(...p, limite).map(comMargem);
}

const obter = (db, id) => comMargem(db.prepare(`SELECT ${CAMPOS} ${JUNCOES} WHERE p.id = ?`).get(id));

/** Busca do PDV: código de barras exato primeiro; se não achar, procura pelo nome. */
function buscarParaVenda(db, termo) {
  const t = String(termo ?? '').trim();
  if (!t) return [];
  const codigo = v.digitos(t);
  if (codigo.length >= 4) {
    const exato = db.prepare(`SELECT ${CAMPOS} ${JUNCOES} WHERE p.codigo_barras = ? AND p.ativo = 1`).get(codigo);
    if (exato) return [comMargem(exato)];
  }
  return db.prepare(`SELECT ${CAMPOS} ${JUNCOES} WHERE p.ativo = 1 AND (p.nome LIKE ? OR p.codigo_barras LIKE ?) ORDER BY p.nome LIMIT 20`)
    .all(`%${t}%`, `${t}%`).map(comMargem);
}

function dados(db, d, { novo = true } = {}) {
  const campos = {};
  if (novo || d.nome !== undefined) campos.nome = v.texto(d.nome, 'o nome do produto', 120);
  if (novo || d.codigo_barras !== undefined) campos.codigo_barras = d.codigo_barras === null || String(d.codigo_barras ?? '').trim() === '' ? null : v.codigoBarras(d.codigo_barras);
  if (novo || d.unidade !== undefined) campos.unidade = v.opcao(d.unidade ?? 'un', 'a unidade', ['un', 'kg', 'l', 'cx', 'pct']);
  if (novo || d.preco_centavos !== undefined || d.preco !== undefined) campos.preco_centavos = d.preco_centavos !== undefined ? v.inteiro(d.preco_centavos, 'o preço') : v.centavos(d.preco, 'o preço de venda');
  if (novo || d.custo !== undefined || d.custo_centavos !== undefined) {
    campos.custo_centavos = d.custo_centavos !== undefined ? v.inteiro(d.custo_centavos, 'o custo') : (v.centavosOpcional(d.custo, 'o custo') ?? 0);
  }
  if (novo || d.estoque_minimo !== undefined) campos.estoque_minimo_mil = d.estoque_minimo === undefined || d.estoque_minimo === null || d.estoque_minimo === '' ? 0 : v.quantidade(d.estoque_minimo, 'o estoque mínimo', { min: 0 });
  if (novo || d.categoria_id !== undefined) campos.categoria_id = d.categoria_id ? v.inteiro(d.categoria_id, 'a categoria', { min: 1 }) : null;
  if (novo || d.fornecedor_id !== undefined) campos.fornecedor_id = d.fornecedor_id ? v.inteiro(d.fornecedor_id, 'o fornecedor', { min: 1 }) : null;
  if (novo || d.pesavel !== undefined) campos.pesavel = d.pesavel ? 1 : 0;
  if (novo || d.controla_validade !== undefined) campos.controla_validade = d.controla_validade ? 1 : 0;
  if (d.ativo !== undefined) campos.ativo = d.ativo ? 1 : 0;
  if (campos.pesavel && campos.unidade === 'un') campos.unidade = 'kg';
  // Oferta: preço vazio retira a oferta (e a data junto).
  if (d.oferta_preco !== undefined || d.oferta_preco_centavos !== undefined) {
    const vazio = (x) => x === null || x === undefined || String(x).trim() === '';
    campos.oferta_preco_centavos = d.oferta_preco_centavos !== undefined
      ? (vazio(d.oferta_preco_centavos) ? null : v.inteiro(d.oferta_preco_centavos, 'o preço da oferta', { min: 1 }))
      : (vazio(d.oferta_preco) ? null : v.centavos(d.oferta_preco, 'o preço da oferta', { min: 1 }));
    if (campos.oferta_preco_centavos === null) campos.oferta_ate = null;
  }
  if (d.oferta_ate !== undefined && campos.oferta_ate !== null) campos.oferta_ate = v.dataOpcional(d.oferta_ate, 'o fim da oferta');
  return campos;
}

/** A oferta tem que baixar o preço; data no passado não faz sentido ao gravar. */
function conferirOferta(campos, atual = {}) {
  const oferta = campos.oferta_preco_centavos !== undefined ? campos.oferta_preco_centavos : atual.oferta_preco_centavos;
  const preco = campos.preco_centavos ?? atual.preco_centavos;
  if (oferta != null && oferta >= preco) throw new ErroNegocio('O preço da oferta precisa ser menor que o preço normal.', 422);
  if (campos.oferta_ate && campos.oferta_ate < hoje()) throw new ErroNegocio('A data final da oferta já passou.', 422);
}

function criar(db, d, usuario) {
  const campos = dados(db, d, { novo: true });
  conferirOferta(campos);
  if (campos.codigo_barras && db.prepare('SELECT 1 FROM produtos WHERE codigo_barras = ?').get(campos.codigo_barras)) {
    throw new ErroNegocio('Já existe um produto com este código de barras.', 409);
  }
  const estoqueInicial = d.estoque === undefined || d.estoque === null || d.estoque === '' ? 0 : v.quantidade(d.estoque, 'o estoque inicial', { min: 0 });
  const colunas = Object.keys(campos);
  const r = db.prepare(`INSERT INTO produtos (${colunas.join(', ')}, criado_em, atualizado_em) VALUES (${colunas.map(() => '?').join(', ')}, ?, ?)`)
    .run(...colunas.map((c) => campos[c]), agora(), agora());
  const id = Number(r.lastInsertRowid);
  if (estoqueInicial > 0) {
    require('./estoque').movimentar(db, {
      produto_id: id, tipo: 'entrada', qtd_mil: estoqueInicial, custo_centavos: campos.custo_centavos,
      validade: v.dataOpcional(d.validade, 'a validade'), observacao: 'Estoque inicial do cadastro', usuario_id: usuario?.id ?? null,
    });
  }
  return obter(db, id);
}

function atualizar(db, id, d) {
  const atual = db.prepare('SELECT * FROM produtos WHERE id = ?').get(id);
  if (!atual) throw naoEncontrado('Produto');
  const campos = dados(db, d, { novo: false });
  conferirOferta(campos, atual);
  if (campos.codigo_barras && db.prepare('SELECT 1 FROM produtos WHERE codigo_barras = ? AND id <> ?').get(campos.codigo_barras, id)) {
    throw new ErroNegocio('Já existe um produto com este código de barras.', 409);
  }
  const colunas = Object.keys(campos);
  if (colunas.length) {
    db.prepare(`UPDATE produtos SET ${colunas.map((c) => `${c} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`).run(...colunas.map((c) => campos[c]), agora(), id);
  }
  return obter(db, id);
}

/** Preço sugerido a partir do custo e da margem padrão, arredondado para terminar em 0,90 ou 0,50. */
function precoSugerido(db, custo_centavos) {
  const { margem_padrao_bp } = lerConfig(db);
  const bruto = Math.round(custo_centavos * (1 + margem_padrao_bp / 10_000));
  const dezenas = Math.floor(bruto / 100) * 100;
  for (const terminacao of [90, 50]) if (dezenas + terminacao >= bruto) return dezenas + terminacao;
  return dezenas + 190;
}

module.exports = { listar, obter, buscarParaVenda, criar, atualizar, precoSugerido, margemBp, emOferta, precoVigente };
