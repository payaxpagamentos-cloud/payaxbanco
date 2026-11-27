#!/usr/bin/env node
'use strict';

/**
 * Desenha uma marca tipográfica para canal que não tem logo em lugar nenhum.
 *
 *   node scripts/logos-tipograficos.js              # só desenha, em data/logos-gerados/
 *   node scripts/logos-tipograficos.js --gravar     # desenha e põe nos canais
 *   node scripts/logos-tipograficos.js --forcar     # refaz mesmo quem já tem logo
 *
 * Existe porque dez canais do catálogo do fornecedor não existem em lista pública nenhuma —
 * procurados um a um. Sem logo, eles aparecem na grade como um quadrado com o número, e a tela
 * fica com cara de inacabada bem no meio dos outros cem canais que têm a arte da emissora.
 *
 * O que ISTO É: o nome do canal bem desenhado, no estilo da plataforma. É o que boa parte dos
 * guias de programação faz quando não tem a arte oficial.
 *
 * O que ISTO NÃO É: imitação da marca de ninguém. Chaves e Chapolin são da Televisa, MTV Pop é
 * da Paramount, A Fazenda é da Record. Recriar a marca delas sairia errado e é risco que não
 * vale a pena correr — quando o fornecedor mandar as artes oficiais, troque por elas no painel.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('../server/config');

const LADO = 512;
const FUNDO = '#101014';     // o mesmo tom do cartão, para o logo não virar um selo colado
const CLARO = '#FFFFFF';

/**
 * Como cada canal é escrito. `linhas` sai uma embaixo da outra; a segunda ganha o destaque.
 * Nome curto em duas linhas lê melhor a 62px do que um nome comprido numa linha só.
 */
const MARCAS = [
  // Palavra inteira numa linha só. Quebrar no meio ("CHA / VES", "ANI / MES") deixa a letra
  // maior, mas lê como duas sílabas soltas e tem cara de improviso — o contrário do que uma
  // marca precisa fazer. Duas linhas só quando o nome é mesmo de duas partes.
  { nome: 'Clássicos',            linhas: ['CLÁSSICOS'],       cor: '#C9A227' },
  { nome: 'Animes',               linhas: ['ANIMES'],          cor: '#A855F7' },
  { nome: 'Chaves',               linhas: ['CHAVES'],          cor: '#F2B705' },
  { nome: 'Chapolin',             linhas: ['CHAPOLIN'],        cor: '#E54B17' },
  { nome: 'Sabor & Arte',         linhas: ['SABOR', '& ARTE'], cor: '#E50914' },
  { nome: 'Reality',              linhas: ['REALITY'],         cor: '#EC4899' },
  { nome: 'MTV Pop',              linhas: ['MTV', 'POP'],      cor: '#D946EF' },
  { nome: 'A Fazenda · Câmera 1', linhas: ['FAZENDA', '1'],    cor: '#2FA84F' },
  { nome: 'A Fazenda · Câmera 2', linhas: ['FAZENDA', '2'],    cor: '#2FA84F' },
  { nome: 'A Fazenda · Câmera 3', linhas: ['FAZENDA', '3'],    cor: '#2FA84F' },
];

/**
 * Tamanho da letra que faz a linha caber na largura útil.
 *
 * Em DejaVu Sans Bold, letra maiúscula ocupa cerca de 0,70 do tamanho da fonte em largura. Sem
 * esta conta, nome comprido vaza para fora do quadrado e nome curto fica perdido no meio dele.
 */
const tamanhoQueCabe = (texto, largura = 450) => {
  // O teto é o que mantém o CONJUNTO coerente. Sem ele, "MTV" (3 letras) saía do tamanho de um
  // cartaz e "CLÁSSICOS" (9) ficava minúsculo ao lado — dez marcas que não parecem da mesma
  // família. Número solto é exceção: ele é a informação do canal e precisa de destaque.
  const teto = texto.length <= 2 ? 180 : 108;
  return Math.min(teto, Math.floor(largura / Math.max(1, texto.length * 0.70)));
};

/** Texto dentro de SVG é XML: "SABOR & ARTE" com o & cru não abre, e o desenho inteiro falha. */
const paraXml = (t) => String(t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function svgDaMarca({ linhas, cor }) {
  const tamanhos = linhas.map((t) => tamanhoQueCabe(t));
  const ESPACO = 18;
  const BARRA = 30;
  // O bloco inteiro é centrado de uma vez — texto mais a barra. Centrar cada linha por si
  // deixaria o desenho caindo para um lado quando os tamanhos são diferentes.
  const alturaTexto = tamanhos.reduce((n, t) => n + t, 0) + ESPACO * (linhas.length - 1);
  const alturaBloco = alturaTexto + BARRA;
  let y = (LADO - alturaBloco) / 2 + tamanhos[0];
  const textos = linhas.map((t, i) => {
    if (i) y += tamanhos[i] + ESPACO;
    // A primeira linha é branca; a segunda, quando existe, leva a cor. Com uma linha só, a cor
    // fica por conta da barra — senão o nome inteiro colorido perde contraste no preto.
    return `  <text x="${LADO / 2}" y="${Math.round(y)}" text-anchor="middle" font-family="DejaVu Sans"
        font-weight="bold" font-size="${tamanhos[i]}" fill="${i ? cor : CLARO}" letter-spacing="-2">${paraXml(t)}</text>`;
  }).join('\n');
  const ultima = linhas[linhas.length - 1];
  const larguraBarra = Math.round(Math.min(300, Math.max(130, ultima.length * tamanhos[tamanhos.length - 1] * 0.6)));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LADO}" height="${LADO}" viewBox="0 0 ${LADO} ${LADO}">
  <rect width="${LADO}" height="${LADO}" rx="96" fill="${FUNDO}"/>
${textos}
  <rect x="${Math.round((LADO - larguraBarra) / 2)}" y="${Math.round(y + 28)}"
        width="${larguraBarra}" height="12" rx="6" fill="${cor}"/>
</svg>`;
}

/** SVG vira PNG pelo ffmpeg, que já está no servidor e lê SVG pelo librsvg. */
function desenhar(marca, destino) {
  const temporario = path.join(os.tmpdir(), `marca-${process.pid}-${Date.now()}.svg`);
  fs.writeFileSync(temporario, svgDaMarca(marca));
  try {
    execFileSync(config.ffmpeg, ['-v', 'error', '-y', '-i', temporario, '-vf', `scale=${LADO}:${LADO}`, destino],
      { timeout: 30_000 });
  } finally {
    try { fs.unlinkSync(temporario); } catch { /* já foi */ }
  }
  return fs.readFileSync(destino);
}

const gravar = process.argv.includes('--gravar');
const forcar = process.argv.includes('--forcar');
const pasta = path.join(path.dirname(config.dbFile ?? 'data/tv.db'), 'logos-gerados');
fs.mkdirSync(pasta, { recursive: true });

const db = gravar || forcar ? require('../server/db').abrir() : null;
const midia = gravar ? require('../server/lib/midia') : null;
const logos = gravar ? require('../server/lib/logos') : null;
const { agora } = require('../server/db');

let feitos = 0;
let pulados = 0;
const naoAchados = [];

const falharam = [];

for (const marca of MARCAS) {
  const arquivo = path.join(pasta, `${marca.nome.replace(/[^\w]+/g, '-').toLowerCase()}.png`);
  let conteudo;
  try {
    conteudo = desenhar(marca, arquivo);
  } catch (err) {
    // Uma marca que não sai não pode levar as outras nove junto.
    falharam.push(`${marca.nome}: ${String(err.stderr || err.message).split('\n')[0].slice(0, 120)}`);
    continue;
  }

  if (!gravar) { console.log(`  desenhado  ${marca.nome.padEnd(22)} ${arquivo}`); feitos += 1; continue; }

  const canal = db.prepare('SELECT id, slug, nome, logo_midia_id FROM canais WHERE nome = ?').get(marca.nome);
  if (!canal) { naoAchados.push(marca.nome); continue; }
  if (canal.logo_midia_id && !forcar) { console.log(`  já tinha   ${marca.nome}`); pulados += 1; continue; }

  const imagem = midia.salvarImagem(db, { id: null, nome: 'logos' }, conteudo, { nome: `logo-${canal.slug}` });
  db.prepare('UPDATE canais SET logo_midia_id = ?, atualizado_em = ? WHERE id = ?').run(imagem.id, agora(), canal.id);
  // A claridade decide se a tela põe fundo claro atrás do logo. Estas marcas já vêm com fundo
  // escuro próprio, então a medição evita que a tela pinte um fundo claro por cima.
  logos.medirDoCanal(db, canal.id);
  console.log(`  \x1b[32mok\x1b[0m         ${marca.nome}`);
  feitos += 1;
}

console.log(`\n${feitos} marca(s) ${gravar ? 'aplicada(s)' : 'desenhada(s) em ' + pasta}${pulados ? `, ${pulados} já tinha(m) logo` : ''}.`);
if (falharam.length) {
  console.log(`\n${falharam.length} marca(s) não saíram:`);
  for (const f of falharam) console.log(`  ${f}`);
}
if (naoAchados.length) {
  console.log(`\nNão encontrei estes canais pelo nome (confira no painel): ${naoAchados.join(', ')}`);
}
if (!gravar) console.log('Para aplicar nos canais: node scripts/logos-tipograficos.js --gravar');
console.log('\nQuando o fornecedor mandar as artes oficiais, troque por elas: painel → Canais → Editar → logo.');
db?.close();
