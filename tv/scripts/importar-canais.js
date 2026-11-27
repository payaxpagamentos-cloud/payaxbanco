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
 * O logo de cada emissora é buscado depois, pelo painel ("Buscar logos das emissoras") ou por
 * `node scripts/logos-canais.js` — o servidor precisa de internet para isso.
 */

const fs = require('node:fs');
const path = require('node:path');
const { abrir, agora, slug } = require('../server/db');
const aovivo = require('../server/lib/aovivo');

const arquivo = process.argv[2];
const gravar = process.argv.includes('--gravar');
const ligar = process.argv.includes('--ligar');

if (!arquivo) {
  console.error('Uso: node scripts/importar-canais.js <arquivo da lista> [--gravar] [--ligar]');
  process.exit(1);
}

/**
 * Categoria de cada canal, pelo nome. A ordem importa: a primeira regra que casar vence, então
 * o que é mais específico vem antes (DISCOVERY_KIDS é infantil, não documentário).
 */
const REGRAS = [
  [/KIDS|BABY|ZOOMOO|NICK|GLOOB|CARTOON|RA_TIM_BUM|ANIMES|CHAVES|CHAPOLIN/, 'infantil'],
  [/NEWS|CNN|CANAL_UOL|JOVEM_PAN/, 'noticias'],
  [/SPORTV|ESPN|PREMIERE|COMBATE|BAND_SPORTS|FISH_TV/, 'esportes'],
  [/DISCOVERY|ANIMAL_PLANET|HISTORY|NAT_GEO|CURTA/, 'documentarios'],
  [/COMEDY_CENTRAL/, 'variedades'],
  [/MTV|BIS|MUSIC/, 'musica'],
  [/APARECIDA|REDE_VIDA|NOVO_TEMPO|CANCAO_NOVA|RECORD_NEWS_GOSPEL/, 'religioso'],
  [/HBO|TELE_CINE|MEGAPIX|CINEMAX|TCM|SPACE|PARAMOUNT|UNIVERSAL_PREMIERE|STUDIO_UNIVERSAL|FILM_E_ARTS|CANAL_BRASIL|AMC|EURO_CHANNEL|CLASSICOS/, 'filmes'],
  [/UNIVERSAL_REALITY|REALITY/, 'variedades'],
  [/TNT|AXN|SONY|WARNER|UNIVERSAL|USA|LIFE_TIME|ADULT_SWIM|NOVELAS|SERIES/, 'series'],
  [/GLOBO_HD|^SBT$|^RECORD$|REDE_TV|GAZETA|^BAND$|TV_CULTURA/, 'aberta'],
];
const categoriaDe = (nome) => REGRAS.find(([re]) => re.test(nome))?.[1] ?? 'variedades';

/**
 * Nomes que a regra geral não acerta. São marcas: "Telecine" é uma palavra só, e o "E" do meio
 * de "Film & Arts" é o "&" do nome, não a letra E.
 */
const NOMES = {
  TELE_CINE_PREMIUM: 'Telecine Premium',
  TELE_CINE_TOUCH: 'Telecine Touch',
  TELE_CINE_PIPOCA: 'Telecine Pipoca',
  TELE_CINE_ACTION: 'Telecine Action',
  TELE_CINE_FUN: 'Telecine Fun',
  TELE_CINE_CULT: 'Telecine Cult',
  FILM_E_ARTS: 'Film&Arts',
  SABOR_E_ARTE: 'Sabor & Arte',
  DISCOVERY_HOME_E_HEALTH: 'Discovery Home & Health',
  SPORTV: 'SporTV',
  SPORTV_2: 'SporTV 2',
  SPORTV_3: 'SporTV 3',
  GLOBO_HD: 'Globo',
  REDE_TV: 'RedeTV!',
  LIFE_TIME: 'Lifetime',
  'CURTA!': 'Curta!',
  E: 'E!',
  OFF: 'Canal OFF',
  USA: 'USA Network',
  SPACE_HD: 'Space',
  GLOBO_PLAY_NOVELAS: 'Globoplay Novelas',
  PREMIERE_CLUBES: 'Premiere Clubes',
  ESPN_EXTRA: 'ESPN Extra',
  FAZENDA1: 'A Fazenda · Câmera 1',
  FAZENDA2: 'A Fazenda · Câmera 2',
  FAZENDA3: 'A Fazenda · Câmera 3',
  TV_RA_TIM_BUM: 'TV Rá-Tim-Bum',
  JOVEM_PAN_NEWS: 'Jovem Pan News',
  CANAL_UOL: 'Canal UOL',
  ANIMES: 'Animes',
  CLASSICOS: 'Clássicos',
  NOVO_TEMPO: 'Novo Tempo',
  ZOOMOO: 'ZooMoo',
  WOOHOO: 'WooHoo',
  HGTV: 'HGTV',
};

/**
 * Classificação indicativa de partida. Canal adulto não pode nascer liberado: com 18 aqui, ele
 * some do perfil infantil e pede a senha no perfil adulto, sem ninguém precisar lembrar disso.
 * O resto fica em 0 (livre) e a operação ajusta canal a canal.
 */
const CLASSIFICACAO = [
  [/WOOHOO|SEXY|PLAYBOY|VENUS|HOT$/, 18],
  [/ADULT_SWIM/, 16],
  [/COMBATE|UFC/, 14],
];
const classificacaoDe = (nome) => CLASSIFICACAO.find(([re]) => re.test(nome))?.[1] ?? 0;

/** TV_APARECIDA -> TV Aparecida. HBO_2 -> HBO 2. Nome que a pessoa lê na tela. */
const SIGLAS = new Set(['TV', 'HBO', 'TNT', 'AXN', 'MTV', 'ESPN', 'CNN', 'SBT', 'TCM', 'AMC',
  'USA', 'HD', 'TLC', 'HGTV', 'BIS', 'OFF', 'E', 'ID', 'UOL', 'NBA', 'PFC']);
const bonito = (bruto) => NOMES[bruto.toUpperCase()] ?? bruto.split('_').filter(Boolean).map((p) => {
  const limpo = p.replace(/!$/, '');
  if (SIGLAS.has(limpo.toUpperCase())) return limpo.toUpperCase() + (p.endsWith('!') ? '!' : '');
  if (/^\d+$/.test(p)) return p;
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}).join(' ');

/** Lê o arquivo do fornecedor. Aceita o formato como ele chega, com ou sem "Input:". */
function lerLista(texto) {
  const linhas = texto.split(/\r?\n/);
  const canais = [];
  let atual = null;
  for (const linha of linhas) {
    const cabecalho = /^\s*(\d{1,4})\s*[-–]\s*(.+?)\s*$/.exec(linha);
    if (cabecalho && !/^\s*input\s*:/i.test(linha)) {
      if (atual?.endereco) canais.push(atual);
      atual = { numero: Number(cabecalho[1]), bruto: cabecalho[2].trim(), endereco: null };
      continue;
    }
    const endereco = /^\s*(?:input\s*:\s*)?((?:srt|rtmp|rtmps|rtsp|udp):\/\/.+?)\s*$/i.exec(linha);
    if (endereco && atual && !atual.endereco) atual.endereco = endereco[1];
  }
  if (atual?.endereco) canais.push(atual);
  return canais;
}

const texto = fs.readFileSync(path.resolve(arquivo), 'utf8');
const lidos = lerLista(texto);
if (!lidos.length) {
  console.error('Não encontrei nenhum canal nesse arquivo. Confira o formato.');
  process.exit(1);
}

// Confere e acerta cada endereço ANTES de gravar qualquer coisa: lista com um endereço torto
// não pode entrar pela metade no banco.
const prontos = [];
const recusados = [];
for (const c of lidos) {
  try {
    prontos.push({
      numero: c.numero,
      nome: bonito(c.bruto),
      bruto: c.bruto,
      categoria: categoriaDe(c.bruto.toUpperCase()),
      classificacao: classificacaoDe(c.bruto.toUpperCase()),
      endereco: aovivo.conferirEndereco(c.endereco),
      endereco_original: c.endereco,
    });
  } catch (err) {
    recusados.push({ numero: c.numero, nome: c.bruto, erro: err.message });
  }
}

const porCategoria = prontos.reduce((t, c) => ({ ...t, [c.categoria]: (t[c.categoria] ?? 0) + 1 }), {});
console.log(`Lista: ${lidos.length} canal(is) lido(s), ${prontos.length} válido(s), ${recusados.length} recusado(s).\n`);
console.log('Por categoria:');
for (const [cat, n] of Object.entries(porCategoria).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${cat}`);

const corrigidos = prontos.filter((c) => c.endereco !== c.endereco_original);
if (corrigidos.length) {
  console.log(`\n${corrigidos.length} endereço(s) corrigido(s) na leitura. Exemplo:`);
  console.log(`  veio : ${corrigidos[0].endereco_original}`);
  console.log(`  vai  : ${corrigidos[0].endereco}`);
  console.log('  (espaço virou "&", e latency em milissegundos virou microssegundos, que é o que o conversor usa)');
}
const comIdade = prontos.filter((c) => c.classificacao > 0);
if (comIdade.length) {
  console.log('\nCom classificação de partida (some do perfil infantil):');
  for (const c of comIdade) console.log(`  ${c.nome} — ${c.classificacao} anos`);
}
if (recusados.length) {
  console.log('\nRecusados:');
  for (const r of recusados) console.log(`  ${r.numero} ${r.nome}: ${r.erro}`);
}

if (!gravar) {
  console.log('\nNada foi gravado. Rode de novo com --gravar para criar os canais.');
  console.log('Os 10 primeiros ficariam assim:');
  for (const c of prontos.slice(0, 10)) console.log(`  ${String(c.numero).padStart(3)}  ${c.nome.padEnd(26)} ${c.categoria}`);
  process.exit(0);
}

const db = abrir();
let criados = 0;
let atualizados = 0;
const transacao = db.prepare('SELECT 1'); // só para garantir que o banco abriu
transacao.get();

db.exec('BEGIN');
try {
  for (const c of prontos) {
    const ja = db.prepare('SELECT id FROM canais WHERE numero = ? OR slug = ?').get(c.numero, slug(c.nome));
    if (ja) {
      db.prepare(`UPDATE canais SET nome = ?, categoria = ?, fonte = 'rtmp', url_hls = ?, atualizado_em = ? WHERE id = ?`)
        .run(c.nome, c.categoria, c.endereco, agora(), ja.id);
      atualizados += 1;
      continue;
    }
    db.prepare(`INSERT INTO canais (numero, nome, slug, categoria, fonte, url_hls, observacao, relay, classificacao, ordem, ativo, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, 'rtmp', ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(c.numero, c.nome, slug(c.nome), c.categoria, c.endereco,
        `Sinal do fornecedor (SRT). Identificador na origem: ${c.bruto}.`, c.classificacao, c.numero, ligar ? 1 : 0, agora(), agora());
    criados += 1;
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('\nNada foi gravado — a importação inteira voltou atrás:', err.message);
  process.exit(1);
}

console.log(`\n${criados} canal(is) criado(s), ${atualizados} atualizado(s).`);
console.log(ligar
  ? 'Entraram LIGADOS. Confira cada um em Canais → Testar antes de avisar os assinantes.'
  : 'Entraram DESLIGADOS. No painel: Canais → Testar em cada um, e ligue os que responderem.');
console.log('Para os logos: painel → Canais → "Buscar logos das emissoras" (o servidor precisa de internet).');
db.close();
