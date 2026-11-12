'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const produtosLib = require('./produtos');
const estoque = require('./estoque');
const v = require('./validacao');

/**
 * Importação do catálogo por planilha (CSV). Pensada para a planilha que o mercadinho já tem:
 * separador ';' ou ',', número com vírgula decimal e cabeçalho em português, com ou sem acento.
 *
 * O caminho é sempre em duas etapas: primeiro `analisar` (que não grava nada e devolve linha a linha
 * o que vai acontecer) e só depois `aplicar`. Assim ninguém descobre um erro de planilha
 * depois de ter mexido no cadastro.
 */

/** Nomes aceitos para cada coluna. A comparação ignora acento, maiúscula e pontuação. */
const COLUNAS = {
  nome: ['nome', 'produto', 'descricao', 'descricaodoproduto'],
  codigo_barras: ['codigodebarras', 'codigobarras', 'codigo', 'ean', 'gtin', 'barras'],
  categoria: ['categoria', 'secao', 'setor', 'grupo'],
  fornecedor: ['fornecedor', 'distribuidor'],
  unidade: ['unidade', 'un', 'medida'],
  preco: ['preco', 'precodevenda', 'precovenda', 'venda', 'valor', 'valordevenda'],
  custo: ['custo', 'precodecusto', 'custounitario', 'compra'],
  estoque: ['estoque', 'estoqueatual', 'quantidade', 'qtd', 'saldo'],
  estoque_minimo: ['estoqueminimo', 'minimo', 'qtdminima', 'estoquemin'],
  pesavel: ['pesavel', 'porpeso', 'balanca'],
  validade: ['validade', 'vencimento'],
};

const simplificar = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const SIM = ['sim', 's', '1', 'true', 'verdadeiro', 'x'];

/** Descobre o separador olhando o cabeçalho: vence o que aparece mais vezes fora das aspas. */
function separadorDe(linha) {
  const contar = (sep) => linha.split('"').filter((_, i) => i % 2 === 0).join('').split(sep).length - 1;
  return [[';', contar(';')], ['\t', contar('\t')], [',', contar(',')]].sort((a, b) => b[1] - a[1])[0][1] > 0
    ? [[';', contar(';')], ['\t', contar('\t')], [',', contar(',')]].sort((a, b) => b[1] - a[1])[0][0]
    : ';';
}

/** Lê o CSV respeitando aspas e quebras de linha dentro do campo. */
function lerCsv(texto) {
  const limpo = String(texto ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!limpo) throw new ErroNegocio('A planilha está vazia.', 422);
  const sep = separadorDe(limpo.split('\n')[0]);
  const linhas = [];
  let campo = '';
  let atual = [];
  let aspas = false;
  for (let i = 0; i < limpo.length; i++) {
    const c = limpo[i];
    if (aspas) {
      if (c === '"' && limpo[i + 1] === '"') { campo += '"'; i++; } else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { atual.push(campo.trim()); campo = ''; } else if (c === '\n') { atual.push(campo.trim()); linhas.push(atual); atual = []; campo = ''; } else campo += c;
  }
  atual.push(campo.trim());
  linhas.push(atual);
  return { separador: sep, linhas: linhas.filter((l) => l.some((x) => x !== '')) };
}

/** Liga cada coluna da planilha a um campo conhecido. */
function mapearColunas(cabecalho) {
  const mapa = {};
  cabecalho.forEach((titulo, indice) => {
    const chave = simplificar(titulo);
    for (const [campo, nomes] of Object.entries(COLUNAS)) {
      if (nomes.includes(chave) && mapa[campo] === undefined) mapa[campo] = indice;
    }
  });
  if (mapa.nome === undefined && mapa.codigo_barras === undefined) {
    throw new ErroNegocio('A planilha precisa de uma coluna "nome" ou "código de barras" no cabeçalho.', 422);
  }
  return mapa;
}

const numero = (texto) => {
  const t = String(texto ?? '').replace(/[R$\s]/gi, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  return t === '' ? null : Number(t);
};

/**
 * Confere a planilha inteira sem gravar nada: diz, linha a linha, se o produto vai ser criado,
 * atualizado ou se tem erro — e o que exatamente muda em cada um.
 */
function analisar(db, texto, { ajustar_estoque = false } = {}) {
  const { linhas, separador } = lerCsv(texto);
  const mapa = mapearColunas(linhas[0]);
  const corpo = linhas.slice(1);
  if (!corpo.length) throw new ErroNegocio('A planilha só tem o cabeçalho.', 422);

  const categorias = db.prepare('SELECT id, nome FROM categorias').all();
  const fornecedores = db.prepare('SELECT id, nome FROM fornecedores').all();
  const acharCategoria = (nome) => categorias.find((c) => simplificar(c.nome) === simplificar(nome));
  const acharFornecedor = (nome) => fornecedores.find((f) => simplificar(f.nome) === simplificar(nome));
  const vistos = new Set();
  const itens = [];

  corpo.forEach((colunas, indice) => {
    const linha = indice + 2; // 1 é o cabeçalho
    const valor = (campo) => (mapa[campo] === undefined ? '' : (colunas[mapa[campo]] ?? '').trim());
    const erro = (mensagem) => itens.push({ linha, acao: 'erro', erro: mensagem, nome: valor('nome') || valor('codigo_barras') });

    try {
      const nome = valor('nome');
      const codigo = valor('codigo_barras') ? v.codigoBarras(valor('codigo_barras')) : null;
      if (!nome && !codigo) return erro('Linha sem nome e sem código de barras.');

      const chave = codigo ?? simplificar(nome);
      if (vistos.has(chave)) return erro('Repetido na planilha (o mesmo produto aparece mais de uma vez).');
      vistos.add(chave);

      const existente = codigo
        ? db.prepare('SELECT * FROM produtos WHERE codigo_barras = ?').get(codigo)
        : db.prepare('SELECT * FROM produtos').all().find((p) => simplificar(p.nome) === simplificar(nome));

      const preco = numero(valor('preco'));
      if (preco === null && !existente) return erro('Produto novo sem preço de venda.');
      if (preco !== null && !(preco >= 0)) return erro(`Preço inválido: "${valor('preco')}".`);
      const custo = numero(valor('custo'));
      if (custo !== null && !(custo >= 0)) return erro(`Custo inválido: "${valor('custo')}".`);
      const qtd = numero(valor('estoque'));
      if (qtd !== null && !(qtd >= 0)) return erro(`Estoque inválido: "${valor('estoque')}".`);
      const minimo = numero(valor('estoque_minimo'));

      const categoriaNome = valor('categoria');
      const fornecedorNome = valor('fornecedor');
      const unidade = simplificar(valor('unidade')).slice(0, 3);
      const pesavel = valor('pesavel') ? SIM.includes(simplificar(valor('pesavel'))) : null;
      const validade = valor('validade') ? v.dataOpcional(valor('validade').slice(0, 10), 'a validade') : null;

      itens.push({
        linha,
        acao: existente ? 'atualizar' : 'criar',
        produto_id: existente?.id ?? null,
        nome: nome || existente?.nome,
        codigo_barras: codigo,
        categoria: categoriaNome || null,
        categoria_nova: Boolean(categoriaNome && !acharCategoria(categoriaNome)),
        fornecedor: fornecedorNome || null,
        fornecedor_novo: Boolean(fornecedorNome && !acharFornecedor(fornecedorNome)),
        unidade: ['un', 'kg', 'l', 'cx', 'pct'].includes(unidade) ? unidade : null,
        pesavel,
        preco_centavos: preco === null ? null : Math.round(preco * 100),
        custo_centavos: custo === null ? null : Math.round(custo * 100),
        estoque_mil: qtd === null ? null : Math.round(qtd * 1000),
        estoque_minimo_mil: minimo === null ? null : Math.round(minimo * 1000),
        validade,
        // O que muda de verdade neste produto (para a equipe conferir antes de mandar gravar).
        mudancas: existente ? mudancasDe(existente, { preco, custo, minimo, qtd, ajustar_estoque }) : [],
      });
    } catch (err) {
      erro(err.message);
    }
  });

  return {
    separador,
    colunas: Object.keys(mapa),
    colunas_ignoradas: linhas[0].filter((titulo) => !Object.values(mapa).includes(linhas[0].indexOf(titulo))),
    itens,
    resumo: {
      linhas: corpo.length,
      criar: itens.filter((i) => i.acao === 'criar').length,
      atualizar: itens.filter((i) => i.acao === 'atualizar').length,
      erros: itens.filter((i) => i.acao === 'erro').length,
      categorias_novas: [...new Set(itens.filter((i) => i.categoria_nova).map((i) => i.categoria))],
      fornecedores_novos: [...new Set(itens.filter((i) => i.fornecedor_novo).map((i) => i.fornecedor))],
    },
  };
}

/** Lista curta do que muda num produto que já existe, em texto, para mostrar na conferência. */
function mudancasDe(atual, { preco, custo, minimo, qtd, ajustar_estoque }) {
  const reais = (c) => (c / 100).toFixed(2).replace('.', ',');
  const mudancas = [];
  if (preco !== null && Math.round(preco * 100) !== atual.preco_centavos) mudancas.push(`preço ${reais(atual.preco_centavos)} → ${preco.toFixed(2).replace('.', ',')}`);
  if (custo !== null && Math.round(custo * 100) !== atual.custo_centavos) mudancas.push(`custo ${reais(atual.custo_centavos)} → ${custo.toFixed(2).replace('.', ',')}`);
  if (minimo !== null && Math.round(minimo * 1000) !== atual.estoque_minimo_mil) mudancas.push(`mínimo ${atual.estoque_minimo_mil / 1000} → ${minimo}`);
  if (ajustar_estoque && qtd !== null && Math.round(qtd * 1000) !== atual.estoque_mil) mudancas.push(`estoque ${atual.estoque_mil / 1000} → ${qtd}`);
  return mudancas;
}

/**
 * Grava o que a conferência mostrou. Tudo numa transação: ou entra a planilha inteira, ou nada.
 * O estoque dos produtos que já existem só é mexido quando a equipe pede (`ajustar_estoque`).
 */
function aplicar(db, texto, { ajustar_estoque = false, criar_categorias = true, usuario_id = null } = {}) {
  const analise = analisar(db, texto, { ajustar_estoque });
  if (analise.resumo.erros) throw new ErroNegocio(`A planilha tem ${analise.resumo.erros} linha(s) com erro. Corrija antes de importar.`, 422, analise.itens.filter((i) => i.acao === 'erro'));

  return transacao(db, () => {
    const achar = (tabela, nome) => db.prepare(`SELECT id, nome FROM ${tabela}`).all().find((x) => simplificar(x.nome) === simplificar(nome));
    const garantirCategoria = (nome) => {
      if (!nome) return null;
      const existente = achar('categorias', nome);
      if (existente) return existente.id;
      if (!criar_categorias) return null;
      return Number(db.prepare('INSERT INTO categorias (nome) VALUES (?)').run(nome).lastInsertRowid);
    };
    const garantirFornecedor = (nome) => {
      if (!nome) return null;
      const existente = achar('fornecedores', nome);
      if (existente) return existente.id;
      if (!criar_categorias) return null;
      return Number(db.prepare('INSERT INTO fornecedores (nome, criado_em) VALUES (?, ?)').run(nome, agora()).lastInsertRowid);
    };

    const feito = { criados: 0, atualizados: 0, estoque_ajustado: 0, categorias: 0, fornecedores: 0 };
    const categoriasAntes = db.prepare('SELECT COUNT(*) AS n FROM categorias').get().n;
    const fornecedoresAntes = db.prepare('SELECT COUNT(*) AS n FROM fornecedores').get().n;

    for (const item of analise.itens) {
      const categoria_id = garantirCategoria(item.categoria);
      const fornecedor_id = garantirFornecedor(item.fornecedor);

      if (item.acao === 'criar') {
        produtosLib.criar(db, {
          nome: item.nome,
          codigo_barras: item.codigo_barras,
          categoria_id,
          fornecedor_id,
          unidade: item.unidade ?? (item.pesavel ? 'kg' : 'un'),
          pesavel: item.pesavel ?? false,
          preco_centavos: item.preco_centavos,
          custo_centavos: item.custo_centavos ?? 0,
          estoque: item.estoque_mil === null ? 0 : item.estoque_mil / 1000,
          estoque_minimo: (item.estoque_minimo_mil ?? 0) / 1000,
          controla_validade: Boolean(item.validade),
          validade: item.validade,
        }, { id: usuario_id });
        feito.criados += 1;
        continue;
      }

      const campos = {};
      if (item.nome) campos.nome = item.nome;
      if (item.preco_centavos !== null) campos.preco_centavos = item.preco_centavos;
      if (item.custo_centavos !== null) campos.custo_centavos = item.custo_centavos;
      if (item.estoque_minimo_mil !== null) campos.estoque_minimo_mil = item.estoque_minimo_mil;
      if (categoria_id) campos.categoria_id = categoria_id;
      if (fornecedor_id) campos.fornecedor_id = fornecedor_id;
      if (item.unidade) campos.unidade = item.unidade;
      if (item.pesavel !== null) campos.pesavel = item.pesavel ? 1 : 0;
      const colunas = Object.keys(campos);
      if (colunas.length) {
        db.prepare(`UPDATE produtos SET ${colunas.map((c) => `${c} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`)
          .run(...colunas.map((c) => campos[c]), agora(), item.produto_id);
      }
      if (ajustar_estoque && item.estoque_mil !== null) {
        const ajuste = estoque.ajustarPara(db, {
          produto_id: item.produto_id, contado_mil: item.estoque_mil,
          observacao: 'Importação de planilha', documento: 'IMPORTACAO', usuario_id,
        });
        if (ajuste) feito.estoque_ajustado += 1;
      }
      feito.atualizados += 1;
    }

    feito.categorias = db.prepare('SELECT COUNT(*) AS n FROM categorias').get().n - categoriasAntes;
    feito.fornecedores = db.prepare('SELECT COUNT(*) AS n FROM fornecedores').get().n - fornecedoresAntes;
    return { ...feito, resumo: analise.resumo };
  });
}

/** Modelo de planilha para quem está começando do zero. */
const MODELO = ['nome;codigo_barras;categoria;fornecedor;unidade;preco;custo;estoque;estoque_minimo;pesavel',
  'Arroz branco tipo 1 - 5 kg;7891000053508;Mercearia;Distribuidora Central;un;28,90;21,50;24;6;nao',
  'Banana prata - kg;;Hortifrúti;;kg;7,90;4,60;12;4;sim',
  'Refrigerante cola 2 L;7894900011517;Bebidas;Bebidas Rio Claro;un;10,90;7,40;36;12;nao'].join('\n');

module.exports = { lerCsv, mapearColunas, analisar, aplicar, MODELO, COLUNAS };
