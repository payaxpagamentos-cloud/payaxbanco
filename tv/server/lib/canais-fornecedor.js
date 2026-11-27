'use strict';

/**
 * Lista de canais do fornecedor: lê o texto como ele chega e monta os canais da plataforma.
 *
 * Fica aqui, e não no script, porque é regra de negócio: nome que o assinante lê na tela,
 * tema, classificação indicativa e número do canal. O script de importação só chama isto.
 */

const aovivo = require('./aovivo');

/**
 * Números da TV aberta em São Paulo. É o que a casa já tem na cabeça: 5 é a Globo, 4 é o SBT.
 * Mudar isso é mudar o hábito de quem assiste, então estes números são fixos pelo nome.
 */
const NUMERO_ABERTA = {
  'TV Cultura': 2,
  SBT: 4,
  Globo: 5,
  Record: 7,
  'RedeTV!': 9,
  Gazeta: 11,
  Band: 13,
};

/**
 * Número de cada canal fechado na grade da Claro/NET São Paulo.
 *
 * É a numeração que o assinante da região já tem na cabeça: 39 é SporTV, 40 é GloboNews. Foi
 * levantada da grade publicada da operadora, não de memória — numerar mais de cem canais no
 * chute custa mais caro do que deixá-los numa faixa temática qualquer.
 *
 * A TV ABERTA não entra aqui: ela segue NUMERO_ABERTA, com os números da antena (5 é a Globo),
 * que é o que a casa usa. Na grade da Claro os abertos ficam em 16-22; a operação escolheu os
 * da antena. Nenhum canal fechado cai entre 2 e 13, então os dois padrões convivem.
 *
 * Os canais que não existem na grade da Claro (Nickelodeon, MTV e Comedy Central saíram de lá;
 * Chaves, Chapolin e as câmeras da Fazenda nunca foram canais de cabo) ocupam lacunas da faixa
 * do próprio tema, para ficarem junto dos parceiros.
 *
 * A chave é o nome como o fornecedor manda, que não muda de uma lista para outra.
 */
const NUMERO_SP = {
  COMBATE: 33,
  OFF: 35,
  ESPN_EXTRA: 36,
  SPORTV_3: 37,
  SPORTV_2: 38,
  SPORTV: 39,
  GLOBO_NEWS: 40,
  MULTISHOW: 42,
  GLOBO_PLAY_NOVELAS: 43,
  SBT_NEWS: 45,
  REALITY: 46,
  COMEDY_CENTRAL: 47,
  FAZENDA1: 48,
  FAZENDA2: 49,
  E: 50,
  FAZENDA3: 51,
  TLC: 52,
  FOOD_NETWORK: 54,
  DISCOVERY_HOME_E_HEALTH: 55,
  'CURTA!': 56,
  FISH_TV: 58,
  HGTV: 60,
  WOOHOO: 65,
  ESPN: 70,
  ESPN_2: 71,
  ESPN_4: 73,
  BAND_SPORTS: 75,
  CNN_BRASIL: 77,
  RECORD_NEWS: 78,
  BAND_NEWS: 79,
  DISCOVERY_CHANNEL: 81,
  ANIMAL_PLANET: 82,
  HISTORY: 83,
  DISCOVERY_TURBO: 84,
  DISCOVERY_SCIENCE: 85,
  GLOOBINHO: 99,
  DISCOVERY_KIDS: 100,
  GLOOB: 101,
  BABY_TV: 102,
  ZOOMOO: 103,
  CARTOON_NETWORK: 104,
  ANIMES: 105,
  NICK_JR: 106,
  NICKELODEON: 107,
  CARTOONITO: 108,
  TV_RA_TIM_BUM: 109,
  CHAVES: 110,
  CHAPOLIN: 111,
  BIS: 120,
  MTV_POP: 121,
  MTV: 124,
  UNIVERSAL_TV: 130,
  WARNER_CHANNEL: 132,
  SONY_CHANNEL: 133,
  AXN: 135,
  TNT_NOVELAS: 136,
  DISCOVERY_ID: 139,
  USA: 140,
  LIFE_TIME: 141,
  AMC: 145,
  CLASSICOS: 146,
  FILM_E_ARTS: 148,
  CANAL_BRASIL: 150,
  TNT: 151,
  MEGAPIX: 152,
  SPACE_HD: 154,
  CINEMAX: 155,
  STUDIO_UNIVERSAL: 157,
  TCM: 159,
  TELE_CINE_PREMIUM: 161,
  TELE_CINE_ACTION: 162,
  TELE_CINE_TOUCH: 163,
  TELE_CINE_FUN: 164,
  TELE_CINE_PIPOCA: 165,
  TELE_CINE_CULT: 166,
  UNIVERSAL_REALITY: 170,
  HBO: 171,
  HBO_2: 172,
  HBO_PLUS: 173,
  HBO_FAMILY: 175,
  HBO_SIGNATURE: 176,
  HBO_POP: 177,
  HBO_MUNDI: 178,
  HBO_XTREME: 179,
  REDE_VIDA: 193,
  TV_APARECIDA: 195,
  PREMIERE_CLUBES: 221,
  PREMIERE_2: 222,
  PREMIERE_3: 223,
  PREMIERE_4: 224,
  PREMIERE_5: 225,
  PREMIERE_6: 226,
  PREMIERE_7: 227,
  CANAL_UOL: 549,
  SABOR_E_ARTE: 561,
  ESPN_6: 569,
  ESPN_3: 572,
  JOVEM_PAN_NEWS: 576,
  DISCOVERY_THEATER: 592,
  DISCOVERY_WORLD: 593,
  HISTORY_2: 594,
  ADULT_SWIM: 642,
  TNT_SERIES: 643,
  EURO_CHANNEL: 647,
  UNIVERSAL_PREMIERE: 669,
  NOVO_TEMPO: 684,
  PARAMOUNT: 711,
  PARAMOUNT_2: 712,
  PARAMOUNT_3: 713,
};

/**
 * Faixa de numeração de cada tema. Só serve de reserva: é para canal que não está nem em
 * NUMERO_ABERTA nem em NUMERO_SP — uma lista nova do fornecedor, por exemplo.
 */
const BLOCOS = [
  ['noticias', 20],
  ['esportes', 40],
  ['filmes', 70],
  ['series', 100],
  ['infantil', 120],
  ['documentarios', 140],
  ['variedades', 160],
  ['musica', 180],
  ['religioso', 190],
  ['local', 200],
];

/**
 * Tema de cada canal, pelo nome. A ordem importa: a primeira regra que casar vence, então o que
 * é mais específico vem antes (DISCOVERY_KIDS é infantil, não documentário).
 */
const REGRAS = [
  [/KIDS|BABY|ZOOMOO|NICK|GLOOB|CARTOON|RA_TIM_BUM|ANIMES|CHAVES|CHAPOLIN/, 'infantil'],
  [/NEWS|CNN|CANAL_UOL|JOVEM_PAN/, 'noticias'],
  [/SPORTV|ESPN|PREMIERE|COMBATE|BAND_SPORTS|FISH_TV/, 'esportes'],
  [/DISCOVERY|ANIMAL_PLANET|HISTORY|NAT_GEO|CURTA/, 'documentarios'],
  [/COMEDY_CENTRAL/, 'variedades'],
  [/MTV|BIS|MUSIC/, 'musica'],
  [/APARECIDA|REDE_VIDA|NOVO_TEMPO|CANCAO_NOVA/, 'religioso'],
  [/HBO|TELE_CINE|MEGAPIX|CINEMAX|TCM|SPACE|PARAMOUNT|UNIVERSAL_PREMIERE|STUDIO_UNIVERSAL|FILM_E_ARTS|CANAL_BRASIL|AMC|EURO_CHANNEL|CLASSICOS/, 'filmes'],
  [/UNIVERSAL_REALITY|REALITY/, 'variedades'],
  [/TNT|AXN|SONY|WARNER|UNIVERSAL|USA|LIFE_TIME|ADULT_SWIM|NOVELAS|SERIES/, 'series'],
  [/GLOBO_HD|^SBT$|^RECORD$|REDE_TV|GAZETA|^BAND$|TV_CULTURA/, 'aberta'],
];
const categoriaDe = (nome) => REGRAS.find(([re]) => re.test(nome))?.[1] ?? 'variedades';

/**
 * Classificação indicativa de partida. Canal adulto não pode nascer liberado: com 18 aqui, ele
 * some do perfil infantil e pede a senha no perfil adulto, sem ninguém precisar lembrar disso.
 */
const CLASSIFICACAO = [
  [/WOOHOO|SEXY|PLAYBOY|VENUS|HOT$/, 18],
  [/ADULT_SWIM/, 16],
  [/COMBATE|UFC/, 14],
];
const classificacaoDe = (nome) => CLASSIFICACAO.find(([re]) => re.test(nome))?.[1] ?? 0;

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
  CLASSICOS: 'Clássicos',
  ZOOMOO: 'ZooMoo',
  WOOHOO: 'WooHoo',
  HGTV: 'HGTV',
  NICK_JR: 'Nick Jr.',
  DISCOVERY_ID: 'Discovery ID',
  HISTORY_2: 'History 2',
  MTV_POP: 'MTV Pop',
  BIS: 'Bis',
};

/**
 * Identificador do canal na lista pública (iptv-org), para os casos em que o nome sozinho não
 * resolve ou resolve errado. Com o identificador na mão não há adivinhação.
 *
 * Alguns exemplos de por que isto existe:
 *   - "Globo" casava com a Globo de PORTUGAL, que tem outro logo;
 *   - "SBT" não existe com esse nome: a lista chama de "SBT Nacional";
 *   - "Discovery ID" é registrado pelo nome antigo, "Investigation Discovery";
 *   - "Premiere 2" é "Premiere FC 2";
 *   - marcas pan-regionais só existem como feed latino ("Studio Universal Latin America").
 *
 * A chave é o nome como o fornecedor manda, que não muda.
 */
const ID_PUBLICO = {
  // TV aberta: são os sete canais que o assinante vê primeiro na lista, então nenhum deles pode
  // depender de casar pelo nome. "Record" sozinho casava com Record News, Record RS e uma dúzia
  // de praças; "Gazeta" com a Gazeta do Acre e a de Alagoas. Identificador fixo resolve.
  TV_CULTURA: 'TVCultura.br',
  GLOBO_HD: 'RedeGlobo.br',
  SBT: 'SBTNacional.br',
  RECORD: 'Record.br',
  REDE_TV: 'RedeTV.br',
  GAZETA: 'TVGazeta.br',
  BAND: 'Band.br',
  NOVO_TEMPO: 'TVNovoTempo.br',
  HBO_PLUS: 'HBOPlus.br',
  DISCOVERY_ID: 'InvestigationDiscovery.br',
  DISCOVERY_HOME_E_HEALTH: 'DiscoveryHomeHealthLatinAmerica.mx',
  STUDIO_UNIVERSAL: 'StudioUniversalLatinAmerica.us',
  UNIVERSAL_TV: 'UniversalTVLatinAmerica.us',
  LIFE_TIME: 'LifetimeLatinAmerica.us',
  TNT_SERIES: 'TNTSeriesLatinAmerica.us',
  ESPN_6: 'ESPN6LatinAmerica.us',
  PREMIERE_CLUBES: 'PremiereClubes.br',
  PREMIERE_2: 'PremiereFC2.br',
  PREMIERE_3: 'PremiereFC3.br',
  PREMIERE_4: 'PremiereFC4.br',
  PREMIERE_5: 'PremiereFC5.br',
  PREMIERE_6: 'PremiereFC6.br',
  PREMIERE_7: 'PremiereFC7.br',
  // Os três são o mesmo selo (Paramount+), e é esse o logo que a lista pública tem.
  PARAMOUNT: 'ParamountPlusApresenta.br',
  PARAMOUNT_2: 'ParamountPlusApresenta.br',
  PARAMOUNT_3: 'ParamountPlusApresenta.br',
};

/** Siglas que continuam em maiúscula ao montar o nome. */
const SIGLAS = new Set(['TV', 'HBO', 'TNT', 'AXN', 'MTV', 'ESPN', 'CNN', 'SBT', 'TCM', 'AMC',
  'USA', 'HD', 'TLC', 'HGTV', 'BIS', 'OFF', 'E', 'ID', 'UOL', 'NBA', 'PFC', 'AMC']);

/** TV_APARECIDA -> TV Aparecida. HBO_2 -> HBO 2. Nome que a pessoa lê na tela. */
const bonito = (bruto) => NOMES[bruto.toUpperCase()] ?? bruto.split('_').filter(Boolean).map((p) => {
  const limpo = p.replace(/!$/, '');
  if (SIGLAS.has(limpo.toUpperCase())) return limpo.toUpperCase() + (p.endsWith('!') ? '!' : '');
  if (/^\d+$/.test(p)) return p;
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}).join(' ');

/** Lê o arquivo do fornecedor. Aceita o formato como ele chega, com ou sem "Input:". */
function lerLista(texto) {
  const canais = [];
  let atual = null;
  for (const linha of String(texto).split(/\r?\n/)) {
    const cabecalho = /^\s*(\d{1,4})\s*[-–]\s*(.+?)\s*$/.exec(linha);
    if (cabecalho && !/^\s*input\s*:/i.test(linha)) {
      if (atual?.endereco) canais.push(atual);
      atual = { ordemNaLista: Number(cabecalho[1]), bruto: cabecalho[2].trim(), endereco: null };
      continue;
    }
    const endereco = /^\s*(?:input\s*:\s*)?((?:srt|rtmp|rtmps|rtsp|udp):\/\/.+?)\s*$/i.exec(linha);
    if (endereco && atual && !atual.endereco) atual.endereco = endereco[1];
  }
  if (atual?.endereco) canais.push(atual);
  return canais;
}

/**
 * Monta os canais a partir do texto: nome, tema, classificação, endereço conferido e número.
 *
 * O número é o que o assinante digita no controle, então segue o costume: TV aberta nos números
 * de São Paulo, e cada tema na sua faixa, na ordem em que o fornecedor mandou.
 */
function montar(texto) {
  const prontos = [];
  const recusados = [];
  for (const c of lerLista(texto)) {
    try {
      const nome = bonito(c.bruto);
      prontos.push({
        nome,
        bruto: c.bruto,
        id_publico: ID_PUBLICO[c.bruto.toUpperCase()] ?? null,
        categoria: categoriaDe(c.bruto.toUpperCase()),
        classificacao: classificacaoDe(c.bruto.toUpperCase()),
        endereco: aovivo.conferirEndereco(c.endereco),
        endereco_original: c.endereco,
        ordemNaLista: c.ordemNaLista,
      });
    } catch (err) {
      recusados.push({ ordem: c.ordemNaLista, nome: c.bruto, erro: err.message });
    }
  }

  // Número: a TV aberta pelos números da antena; o fechado pela grade da Claro São Paulo.
  // Quem não estiver em nenhuma das duas cai na faixa do tema, que é a reserva.
  const proximo = Object.fromEntries(BLOCOS);
  const usados = new Set([...Object.values(NUMERO_ABERTA), ...Object.values(NUMERO_SP)]);
  const semNumero = [];
  for (const c of prontos) {
    const fixo = NUMERO_ABERTA[c.nome] ?? NUMERO_SP[c.bruto.toUpperCase()] ?? NUMERO_SP[c.bruto];
    if (fixo) { c.numero = fixo; continue; }
    semNumero.push(c);
  }
  // Dentro de cada faixa, mantém a ordem em que o fornecedor listou.
  semNumero.sort((a, b) => a.ordemNaLista - b.ordemNaLista);
  for (const c of semNumero) {
    const inicio = proximo[c.categoria] ?? 200;
    let n = inicio;
    while (usados.has(n)) n += 1;
    c.numero = n;
    usados.add(n);
    proximo[c.categoria] = n + 1;
  }
  prontos.sort((a, b) => a.numero - b.numero);
  return { canais: prontos, recusados };
}

module.exports = {
  montar, lerLista, bonito, categoriaDe, classificacaoDe, NUMERO_ABERTA, NUMERO_SP, BLOCOS, NOMES, ID_PUBLICO,
};
