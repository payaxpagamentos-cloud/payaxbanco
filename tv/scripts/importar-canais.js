#!/usr/bin/env node
'use strict';

/**
 * Importa a lista de canais do fornecedor, no formato em que ela chega.
 *
 *   node scripts/importar-canais.js scripts/canais-fornecedor.txt            # confere e mostra
 *   node scripts/importar-canais.js scripts/canais-fornecedor.txt --gravar   # grava no banco
 *   node scripts/importar-canais.js scripts/canais-fornecedor.txt --gravar --ligar
 *
 * O arquivo é o texto recebido, sem edição nenhuma:
 *
 *   001 - TV_APARECIDA
 *   Input: srt://1.2.3.4:5000?streamid=#!::r=TV_APARECIDA,m=request latency=2000
 *
 * Os canais entram DESLIGADOS por padrão. É de propósito: canal no ar sem ninguém ter testado
 * o sinal é reclamação de assinante na certa. Teste no painel e ligue depois, ou passe --ligar
 * quando já tiver conferido.
 *
 * A regra de nome, tema, classificação e número está em server/lib/canais-fornecedor.js.
 * Os logos vêm depois: `node scripts/logos-canais.js`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { abrir, agora, slug } = require('../server/db');
const fornecedor = require('../server/lib/canais-fornecedor');

const arquivo = process.argv[2];
const gravar = process.argv.includes('--gravar');
const ligar = process.argv.includes('--ligar');

if (!arquivo) {
  console.error('Uso: node scripts/importar-canais.js <arquivo da lista | -> [--gravar] [--ligar]');
  console.error('Dentro do Docker, com a lista vindo do servidor:');
  console.error('  docker compose exec -T app node scripts/importar-canais.js - --gravar < scripts/canais-fornecedor.txt');
  process.exit(1);
}

// Confere e acerta tudo ANTES de gravar: lista com um endereço torto não pode entrar pela
// metade no banco.
// "-" lê da entrada padrão: assim a lista pode vir do servidor sem estar dentro da imagem.
const texto = arquivo === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(arquivo), 'utf8');
const { canais, recusados } = fornecedor.montar(texto);
if (!canais.length) {
  console.error('Não encontrei nenhum canal nesse arquivo. Confira o formato.');
  process.exit(1);
}

const porCategoria = canais.reduce((t, c) => ({ ...t, [c.categoria]: (t[c.categoria] ?? 0) + 1 }), {});
console.log(`Lista: ${canais.length + recusados.length} canal(is) lido(s), ${canais.length} válido(s), ${recusados.length} recusado(s).\n`);
console.log('Por tema e faixa de número:');
for (const [cat, n] of Object.entries(porCategoria).sort((a, b) => b[1] - a[1])) {
  const doTema = canais.filter((c) => c.categoria === cat);
  console.log(`  ${String(n).padStart(3)}  ${cat.padEnd(14)} ${doTema[0].numero}–${doTema[doTema.length - 1].numero}`);
}

const abertos = canais.filter((c) => c.categoria === 'aberta');
if (abertos.length) {
  console.log('\nTV aberta (números de São Paulo):');
  for (const c of abertos) console.log(`  ${String(c.numero).padStart(3)}  ${c.nome}`);
}

const corrigidos = canais.filter((c) => c.endereco !== c.endereco_original);
if (corrigidos.length) {
  console.log(`\n${corrigidos.length} endereço(s) corrigido(s) na leitura. Exemplo:`);
  console.log(`  veio : ${corrigidos[0].endereco_original}`);
  console.log(`  vai  : ${corrigidos[0].endereco}`);
  console.log('  (espaço virou "&", e latency em milissegundos virou microssegundos, que é o que o conversor usa)');
}

const comIdade = canais.filter((c) => c.classificacao > 0);
if (comIdade.length) {
  console.log('\nCom classificação de partida (some do perfil infantil):');
  for (const c of comIdade) console.log(`  ${c.nome} — ${c.classificacao} anos`);
}
if (recusados.length) {
  console.log('\nRecusados:');
  for (const r of recusados) console.log(`  ${r.ordem} ${r.nome}: ${r.erro}`);
}

if (!gravar) {
  console.log('\nNada foi gravado. Rode de novo com --gravar para criar os canais.');
  process.exit(0);
}

const db = abrir();
let criados = 0;
let atualizados = 0;
let sobraram = [];

db.exec('BEGIN');
try {
  // O número que este canal vai receber pode estar com outro canal agora (numeração antiga, de
  // uma importação anterior). Como o número é único, a numeração inteira sai do caminho primeiro
  // — vira negativa — e só então cada canal recebe o seu.
  const existentes = new Map(db.prepare('SELECT id, slug FROM canais').all().map((c) => [c.slug, c.id]));
  if (existentes.size) db.prepare('UPDATE canais SET numero = -numero WHERE numero > 0').run();

  for (const c of canais) {
    const chave = slug(c.nome);
    const id = existentes.get(chave);
    if (id) {
      db.prepare(`UPDATE canais SET numero = ?, nome = ?, categoria = ?, fonte = 'rtmp', url_hls = ?,
          classificacao = ?, ordem = ?, id_publico = COALESCE(?, id_publico), atualizado_em = ? WHERE id = ?`)
        .run(c.numero, c.nome, c.categoria, c.endereco, c.classificacao, c.numero, c.id_publico, agora(), id);
      atualizados += 1;
      continue;
    }
    db.prepare(`INSERT INTO canais (numero, nome, slug, categoria, fonte, url_hls, observacao, relay, classificacao, ordem, id_publico, ativo, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, 'rtmp', ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run(c.numero, c.nome, chave, c.categoria, c.endereco,
        `Sinal do fornecedor (SRT). Identificador na origem: ${c.bruto}.`, c.classificacao, c.numero,
        c.id_publico, ligar ? 1 : 0, agora(), agora());
    criados += 1;
  }

  // Canal que ficou com número negativo não está nesta lista: vai para a faixa 900+, onde não
  // atrapalha a numeração nova, em vez de ser apagado por conta própria.
  sobraram = db.prepare('SELECT id, nome FROM canais WHERE numero < 0').all();
  let livre = 900;
  for (const s of sobraram) {
    while (db.prepare('SELECT 1 FROM canais WHERE numero = ?').get(livre)) livre += 1;
    db.prepare('UPDATE canais SET numero = ?, ordem = ? WHERE id = ?').run(livre, livre, s.id);
    livre += 1;
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('\nNada foi gravado — a importação inteira voltou atrás:', err.message);
  process.exit(1);
}

console.log(`\n${criados} canal(is) criado(s), ${atualizados} atualizado(s).`);
if (sobraram.length) {
  console.log(`\nAtenção: ${sobraram.length} canal(is) já cadastrado(s) não estão nesta lista e foram para a faixa 900+:`);
  for (const s of sobraram) console.log(`  ${s.nome}`);
}
console.log(ligar
  ? 'Entraram LIGADOS. Confira cada um em Canais → Testar antes de avisar os assinantes.'
  : 'Entraram DESLIGADOS. No painel: Canais → Testar em cada um, e ligue os que responderem.');
console.log('Agora os logos: node scripts/logos-canais.js');
db.close();
