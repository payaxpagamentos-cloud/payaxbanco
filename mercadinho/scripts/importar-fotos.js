'use strict';

/**
 * Importa as fotos dos produtos de uma pasta, em lote.
 *
 *   node scripts/importar-fotos.js ./minhas-fotos
 *   node scripts/importar-fotos.js ./minhas-fotos --forcar     (troca as fotos que já existem)
 *
 * O nome de cada arquivo diz a qual produto ele pertence. Vale qualquer um destes:
 *   7891000053508.jpg   — código de barras
 *   12.png              — id do produto
 *   arroz-branco-5kg.jpg — nome do produto (acentos, espaços e maiúsculas não importam)
 *
 * Aceita JPEG, PNG e WebP. A imagem é guardada como está: reduza antes se as fotos forem enormes
 * (o terminal carrega mais rápido com fotos de até ~800 px).
 */

const fs = require('node:fs');
const path = require('node:path');
const { abrir, agora } = require('../server/db');
const fotos = require('../server/lib/fotos');
const config = require('../server/config');

const pasta = process.argv[2];
const forcar = process.argv.includes('--forcar');
if (!pasta) {
  console.error('Uso: node scripts/importar-fotos.js <pasta com as fotos> [--forcar]');
  process.exit(1);
}
if (!fs.existsSync(pasta)) {
  console.error(`Pasta não encontrada: ${pasta}`);
  process.exit(1);
}

/** Tira acentos, pontuação e espaços, para comparar nomes de arquivo com nomes de produto. */
const simplificar = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const db = abrir();
const produtos = db.prepare('SELECT id, nome, codigo_barras, foto FROM produtos').all();
const porCodigo = new Map(produtos.filter((p) => p.codigo_barras).map((p) => [p.codigo_barras, p]));
const porId = new Map(produtos.map((p) => [String(p.id), p]));
const porNome = new Map(produtos.map((p) => [simplificar(p.nome), p]));

const EXTENSOES = ['.jpg', '.jpeg', '.png', '.webp'];
const arquivos = fs.readdirSync(pasta).filter((a) => EXTENSOES.includes(path.extname(a).toLowerCase()));
if (!arquivos.length) {
  console.error(`Nenhuma imagem (${EXTENSOES.join(', ')}) em ${pasta}.`);
  process.exit(1);
}

const resultado = { importadas: 0, trocadas: 0, mantidas: 0, semProduto: [], recusadas: [] };

for (const arquivo of arquivos) {
  const base = path.basename(arquivo, path.extname(arquivo)).trim();
  const produto = porCodigo.get(base.replace(/\D/g, '')) ?? porId.get(base) ?? porNome.get(simplificar(base));
  if (!produto) {
    resultado.semProduto.push(arquivo);
    continue;
  }
  if (produto.foto && !forcar) {
    resultado.mantidas += 1;
    continue;
  }
  try {
    const nome = fotos.guardar(fs.readFileSync(path.join(pasta, arquivo)), produto.id, produto.foto);
    db.prepare('UPDATE produtos SET foto = ?, atualizado_em = ? WHERE id = ?').run(nome, agora(), produto.id);
    if (produto.foto) resultado.trocadas += 1;
    else resultado.importadas += 1;
    console.log(`  ${arquivo}  ->  ${produto.nome}`);
  } catch (err) {
    resultado.recusadas.push(`${arquivo}: ${err.message}`);
  }
}

console.log(`\n[Mercadinho] ${resultado.importadas} foto(s) importada(s), ${resultado.trocadas} trocada(s), ${resultado.mantidas} mantida(s).`);
if (resultado.semProduto.length) {
  console.log(`\nSem produto correspondente (${resultado.semProduto.length}):`);
  for (const a of resultado.semProduto) console.log(`  ${a}`);
  console.log('Renomeie o arquivo com o código de barras, o id ou o nome exato do produto.');
}
if (resultado.recusadas.length) {
  console.log(`\nRecusadas (${resultado.recusadas.length}):`);
  for (const a of resultado.recusadas) console.log(`  ${a}`);
}
const semFoto = db.prepare("SELECT COUNT(*) AS n FROM produtos WHERE ativo = 1 AND (foto IS NULL OR foto = '')").get().n;
console.log(`\nAinda sem foto: ${semFoto} produto(s) ativo(s). As fotos ficam em ${config.fotosDir}.`);
