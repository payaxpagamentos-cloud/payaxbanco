// Limites de conteúdo do painel.
// Cada espaço do site tem um tamanho fixo no desenho. Estes limites garantem que
// nenhum texto, lista ou imagem enviada pelo painel empurre, entorte ou quebre o layout.
// O mesmo arquivo é usado pelo painel (contador e bloqueio na digitação) e pelo
// servidor (recusa ao salvar), então os dois nunca discordam.
//
// Chave: caminho do campo sem o número do item (ex.: "banners.title" vale para todos os banners).

export const LIMITES = {
  // Marca e contatos
  'brand.name': 40,
  'brand.tagline': 40,
  'seo.title': 70,
  'seo.description': 160,
  'contact.phone': 20,
  'contact.email': 80,
  'contact.address': 120,

  // Banners
  'hero.badge': 32,
  'banners.eyebrow': 32,
  'banners.title': 24,
  'banners.highlight': 22,
  'banners.subtitle': 80,
  'banners.primaryLabel': 20,
  'banners.secondaryLabel': 20,

  // Planos
  'plansSection.title': 44,
  'plansSection.subtitle': 80,
  'plansSection.note': 140,
  'plans.label': 20,
  'plans.name': 12,
  'plans.description': 40,
  'plans.priceSuffix': 8,
  'plans.terms': 120,
  'plans.features': 40,
  'plans.button': 20,

  // Textos
  'services.title': 40,
  'services.description': 80,
  'services.first': 28,
  'services.second': 28,
  'coverage.title': 44,
  'coverage.subtitle': 80,
  'customer.title': 30,
  'customer.account': 20,
  'customer.invoice': 20,
  'customer.support': 20,
  'faqs.question': 110,
  'faqs.answer': 600,
  'coverage.ranges.name': 60
};

// Campos que aceitam quebra de linha e quantas linhas no máximo.
// Todos os outros campos de texto são de uma linha só.
export const LINHAS = { 'services.title': 2, 'faqs.answer': 8 };

// Quantidade máxima de itens em listas.
export const QUANTIDADE = { banners: 8, plans: 12, features: 4, faqs: 12 };

// Preço máximo exibível sem estourar o cartão (R$ 9.999,99).
export const PRECO_MAXIMO = 9999.99;

// Tamanho mínimo recomendado das imagens (o painel avisa quando a imagem é menor).
export const IMAGEM_MINIMA = { banner: [1600, 800], bannerCelular: [700, 900], logo: [300, 80] };

// Cores fixas da identidade visual. Não são editáveis pelo painel.
export const CORES = { accent: '#ff9300', background: '#0a192c' };

export const chaveDoCampo = caminho => String(caminho).replace(/\.\d+(?=\.|$)/g, '');
export const limiteDe = caminho => LIMITES[chaveDoCampo(caminho)];
