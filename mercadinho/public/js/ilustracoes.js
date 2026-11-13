/**
 * Desenho do produto quando ele ainda não tem foto de verdade.
 * Escolhe pelo nome ("Cerveja lata 350 ml" vira a lata, "Leite integral" vira a caixinha); se o nome não
 * disser nada, usa o desenho da categoria; e, por último, a sacola da loja. Foto cadastrada sempre vence.
 * Os desenhos ficam em public/img/ilustracoes (SVG: leves e nítidos em qualquer tamanho, da miniatura à TV).
 */
const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// A ordem importa: o mais específico primeiro ("água sanitária" antes de "água", "pão de forma" antes de "pão").
const PELO_NOME = [
  [/agua sanitaria|cloro|alvejante/, 'galao-sanitaria'],
  [/energetico/, 'lata-energetico'],
  [/cerveja|chopp/, 'lata-cerveja'],
  [/molho|extrato de tomate|atum|sardinha/, 'lata-molho'],
  [/(refrigerante|\brefri\b|guarana|cola\b|soda|tonica).*\blata\b|\blata\b.*(refrigerante|guarana|cola\b|soda)/, 'lata-refri'],
  [/refrigerante|\brefri\b|guarana|cola\b/, 'garrafa-refri'],
  [/suco|nectar/, 'garrafa-suco'],
  [/oleo|azeite|vinagre/, 'garrafa-oleo'],
  [/\bagua\b/, 'garrafa-agua'],
  [/chocolate|bombom/, 'chocolate'],
  [/leite condensado|creme de leite|doce de leite/, 'lata-molho'],
  [/iogurte|bebida lactea/, 'pote-iogurte'],
  [/sorvete|acai/, 'pote-sorvete'],
  [/\bleite\b/, 'caixa-leite'],
  [/queijo|mussarela|muzarela|requeijao/, 'queijo'],
  [/presunto|mortadela|salame|peito de peru/, 'presunto'],
  [/manteiga|margarina/, 'manteiga'],
  [/pao de forma|pao de sanduiche/, 'pao-forma'],
  [/\bpao\b|baguete|bisnaga/, 'pao-frances'],
  [/bolo|torta/, 'bolo'],
  [/banana/, 'banana'],
  [/tomate/, 'tomate'],
  [/salgadinho|chips|batata frita|batata palha/, 'pacote-salgadinho'],
  [/batata|mandioca|aipim|cenoura/, 'batata'],
  [/cebola|alho/, 'cebola'],
  [/\b(maca|macas|laranja|limao|pera|fruta|frutas|uva|mamao|manga|abacaxi|melancia|morango)\b/, 'maca'],
  [/arroz/, 'pacote-arroz'],
  [/feijao|lentilha|grao de bico/, 'pacote-feijao'],
  [/acucar/, 'pacote-acucar'],
  [/\bsal\b/, 'pacote-sal'],
  [/\bcafe\b/, 'pacote-cafe'],
  [/macarrao|espaguete|massa|lasanha|miojo/, 'pacote-macarrao'],
  [/biscoito|bolacha|wafer/, 'pacote-biscoito'],
  [/pizza|lasanha congelada/, 'pizza'],
  [/sabonete/, 'sabonete'],
  [/creme dental|pasta de dente|escova de dente/, 'creme-dental'],
  [/papel/, 'papel'],
  [/sabao|lava roupa/, 'sabao-po'],
  [/detergente|desinfetante|limpador|amaciante|multiuso/, 'detergente'],
];

const PELA_CATEGORIA = [
  [/bebida/, 'garrafa-agua'],
  [/congelad/, 'pote-sorvete'],
  [/doce|salgadinho|snack/, 'pacote-salgadinho'],
  [/frio|laticinio/, 'queijo'],
  [/higiene|perfumaria/, 'sabonete'],
  [/hortifruti|feira|fruta|verdura/, 'maca'],
  [/limpeza/, 'detergente'],
  [/mercearia/, 'pacote-arroz'],
  [/padaria/, 'pao-frances'],
];

export function nomeDaIlustracao(produto) {
  const nome = semAcento(produto?.nome ?? produto?.descricao);
  const categoria = semAcento(produto?.categoria);
  return PELO_NOME.find(([r]) => r.test(nome))?.[1] ?? PELA_CATEGORIA.find(([r]) => r.test(categoria))?.[1] ?? 'sacola';
}

/** Endereço do desenho, relativo à raiz do sistema (ex.: "/mercadobinho"). */
export const ilustracaoDe = (produto, raiz) => `${raiz}/img/ilustracoes/${nomeDaIlustracao(produto)}.svg`;
