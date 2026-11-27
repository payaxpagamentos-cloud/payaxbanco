#!/usr/bin/env node
'use strict';

/**
 * Põe nos canais os logos que vieram prontos em `logos-canais/`.
 *
 *   node scripts/logos-arquivos.js              # mostra o que faria
 *   node scripts/logos-arquivos.js --gravar     # aplica
 *   node scripts/logos-arquivos.js --gravar --forcar   # troca também quem já tem logo
 *
 * Existe porque treze canais não têm logo em lista pública nenhuma — procurados um a um — e as
 * artes oficiais chegaram do fornecedor. Subir treze arquivos à mão pelo painel funciona, mas é
 * trabalho repetido a cada reinstalação; aqui eles vão junto com a plataforma.
 *
 * As marcas pertencem aos respectivos titulares (ver logos-canais/FONTES.txt). Estão aqui para
 * identificar o canal na grade, que é o mesmo uso que qualquer guia de programação faz.
 */

const fs = require('node:fs');
const path = require('node:path');
const { abrir, agora } = require('../server/db');
const midia = require('../server/lib/midia');
const logos = require('../server/lib/logos');

/**
 * Arquivo → nome do canal no banco.
 *
 * O casamento é por nome exato e não por aproximação de propósito: "Record" casaria com Record
 * News, e trocar o logo do canal errado é pior que não ter logo. Canal que não existir com esse
 * nome é relatado no fim, não adivinhado.
 */
const MAPA = {
  '01-chaves.png': 'Chaves',
  '02-chapolin.png': 'Chapolin',
  '03-mtv-pop.png': 'MTV Pop',
  '04-a-fazenda-camera-1.png': 'A Fazenda · Câmera 1',
  '05-a-fazenda-camera-2.png': 'A Fazenda · Câmera 2',
  '06-a-fazenda-camera-3.png': 'A Fazenda · Câmera 3',
  '07-reality.png': 'Reality',
  '08-classicos.png': 'Clássicos',
  '09-animes.png': 'Animes',
  '10-sabor-e-arte.png': 'Sabor & Arte',
  '11-record.png': 'Record',
  '12-tv-cultura.png': 'TV Cultura',
  '13-rede-tv.png': 'RedeTV!',
};

const PASTA = path.join(__dirname, '..', 'logos-canais');
const gravar = process.argv.includes('--gravar');
const forcar = process.argv.includes('--forcar');

if (!fs.existsSync(PASTA)) {
  console.error(`Não achei a pasta ${PASTA}. Ela vem dentro do pacote da plataforma.`);
  process.exit(1);
}

const db = abrir();
const porNome = db.prepare('SELECT id, slug, nome, logo_midia_id FROM canais WHERE nome = ?');

let aplicados = 0;
let pulados = 0;
const semCanal = [];
const semArquivo = [];

for (const [arquivo, nome] of Object.entries(MAPA)) {
  const caminho = path.join(PASTA, arquivo);
  if (!fs.existsSync(caminho)) { semArquivo.push(arquivo); continue; }
  const canal = porNome.get(nome);
  if (!canal) { semCanal.push(nome); continue; }
  // Logo de demonstração (o quadrado com as iniciais que a instalação cria) não conta como
  // logo: é exatamente o que estas artes vêm substituir.
  if (canal.logo_midia_id && !forcar && !logos.ehDeDemonstracao(db, canal.logo_midia_id)) {
    console.log(`  já tinha   ${nome}`); pulados += 1; continue;
  }
  if (!gravar) { console.log(`  aplicaria  ${nome.padEnd(22)} ← ${arquivo}`); aplicados += 1; continue; }

  const imagem = midia.salvarImagem(db, { id: null, nome: 'logos' }, fs.readFileSync(caminho), { nome: `logo-${canal.slug}` });
  db.prepare('UPDATE canais SET logo_midia_id = ?, atualizado_em = ? WHERE id = ?').run(imagem.id, agora(), canal.id);
  // A claridade decide se a tela põe fundo claro atrás do logo: logo escuro sobre fundo preto
  // some, e metade das marcas de emissora é escura.
  logos.medirDoCanal(db, canal.id);
  console.log(`  \x1b[32mok\x1b[0m         ${nome}`);
  aplicados += 1;
}

console.log(`\n${aplicados} logo(s) ${gravar ? 'aplicado(s)' : 'a aplicar'}${pulados ? `, ${pulados} já tinha(m)` : ''}.`);
if (semCanal.length) {
  console.log(`\nEstes canais não existem com esse nome exato no banco: ${semCanal.join(', ')}`);
  console.log('Confira o nome no painel (Canais) — o casamento é exato de propósito, para não trocar o logo do canal errado.');
}
if (semArquivo.length) console.log(`\nArquivos que faltaram na pasta: ${semArquivo.join(', ')}`);
if (!gravar && aplicados) console.log('\nPara aplicar: node scripts/logos-arquivos.js --gravar');
db.close();
