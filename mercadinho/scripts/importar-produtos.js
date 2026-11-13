'use strict';

/**
 * Importa o catálogo de produtos de uma planilha CSV.
 *
 *   node scripts/importar-produtos.js catalogo.csv                      (só confere, não grava nada)
 *   node scripts/importar-produtos.js catalogo.csv --aplicar            (grava)
 *   node scripts/importar-produtos.js catalogo.csv --aplicar --estoque  (também acerta o estoque pelo da planilha)
 *   node scripts/importar-produtos.js --modelo > catalogo.csv           (gera um modelo para preencher)
 *
 * Colunas aceitas no cabeçalho (com ou sem acento, em qualquer ordem):
 *   nome · codigo_barras · categoria · fornecedor · unidade · preco · custo · estoque · estoque_minimo · pesavel · validade
 *
 * O produto é encontrado pelo código de barras e, na falta dele, pelo nome. O que já existe é
 * atualizado; o que não existe é criado. O estoque de quem já existe só muda com --estoque.
 */

const fs = require('node:fs');
const { abrir } = require('../server/db');
const importacao = require('../server/lib/importacao');

if (process.argv.includes('--modelo')) {
  process.stdout.write(`${importacao.MODELO}\n`);
  process.exit(0);
}

const arquivo = process.argv[2];
const aplicar = process.argv.includes('--aplicar');
const ajustar_estoque = process.argv.includes('--estoque');

if (!arquivo || arquivo.startsWith('--')) {
  console.error('Uso: node scripts/importar-produtos.js <planilha.csv> [--aplicar] [--estoque]');
  console.error('     node scripts/importar-produtos.js --modelo > catalogo.csv');
  process.exit(1);
}
if (!fs.existsSync(arquivo)) {
  console.error(`Arquivo não encontrado: ${arquivo}`);
  process.exit(1);
}

// Planilha do Excel costuma vir em UTF-8 (com BOM) ou Windows-1252: tenta o primeiro e cai no segundo.
const bytes = fs.readFileSync(arquivo);
let texto = bytes.toString('utf8');
if (texto.includes('�')) texto = new TextDecoder('windows-1252').decode(bytes);

const db = abrir();

try {
  const analise = importacao.analisar(db, texto, { ajustar_estoque });
  const { resumo } = analise;
  console.log(`\nPlanilha: ${arquivo}`);
  console.log(`Colunas lidas: ${analise.colunas.join(', ')}`);
  console.log(`Linhas: ${resumo.linhas}  ·  novos: ${resumo.criar}  ·  já existem: ${resumo.atualizar}  ·  com erro: ${resumo.erros}`);
  if (resumo.categorias_novas.length) console.log(`Categorias que serão criadas: ${resumo.categorias_novas.join(', ')}`);
  if (resumo.fornecedores_novos.length) console.log(`Fornecedores que serão criados: ${resumo.fornecedores_novos.join(', ')}`);

  const erros = analise.itens.filter((i) => i.acao === 'erro');
  if (erros.length) {
    console.log('\nLinhas com erro:');
    for (const e of erros) console.log(`  linha ${e.linha}: ${e.nome || '(sem nome)'} — ${e.erro}`);
  }
  const alteracoes = analise.itens.filter((i) => i.acao === 'atualizar' && i.mudancas.length);
  if (alteracoes.length) {
    console.log(`\nMudanças em produtos que já existem (${alteracoes.length}):`);
    for (const a of alteracoes.slice(0, 40)) console.log(`  ${a.nome}: ${a.mudancas.join(' · ')}`);
    if (alteracoes.length > 40) console.log(`  … e mais ${alteracoes.length - 40}.`);
  }

  if (!aplicar) {
    console.log('\nNada foi gravado. Confira o resumo acima e rode de novo com --aplicar.');
    process.exit(erros.length ? 1 : 0);
  }
  const feito = importacao.aplicar(db, texto, { ajustar_estoque, usuario_id: null });
  console.log(`\n[Mercadinho] ${feito.criados} produto(s) criado(s), ${feito.atualizados} atualizado(s), ${feito.estoque_ajustado} com estoque acertado.`);
  if (feito.categorias || feito.fornecedores) console.log(`Também foram criados ${feito.categorias} categoria(s) e ${feito.fornecedores} fornecedor(es).`);
  console.log('As fotos vão por fora: node scripts/importar-fotos.js <pasta das fotos>');
} catch (err) {
  console.error(`\nNão deu para importar: ${err.message}`);
  if (err.detalhes) for (const d of err.detalhes.slice(0, 20)) console.error(`  linha ${d.linha}: ${d.erro}`);
  process.exit(1);
}
