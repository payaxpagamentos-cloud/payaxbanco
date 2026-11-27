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
 * Faixa de numeração de cada tema. A TV aberta fica de 2 a 13 (acima), e cada tema ganha a sua
 * faixa com folga para crescer: entrar um canal novo em Esportes não empurra Filmes para baixo.
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
  GLOBO_HD: 'RedeGlobo.br',
  SBT: 'SBTNacional.br',
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

  // Número: a TV aberta pelo nome; o resto na faixa do tema, na ordem da lista do fornecedor.
  const proximo = Object.fromEntries(BLOCOS);
  const usados = new Set(Object.values(NUMERO_ABERTA));
  const semNumero = [];
  for (const c of prontos) {
    const fixo = NUMERO_ABERTA[c.nome];
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
  montar, lerLista, bonito, categoriaDe, classificacaoDe, NUMERO_ABERTA, BLOCOS, NOMES, ID_PUBLICO,
};
