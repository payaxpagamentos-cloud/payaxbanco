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
  'coverage.ranges.name': 60,
  'coverage.ranges.start': 9,
  'coverage.ranges.end': 9
};

// Campos que aceitam quebra de linha e quantas linhas no máximo.
// Todos os outros campos de texto são de uma linha só.
export const LINHAS = { 'services.title': 2, 'faqs.answer': 8 };

// Quantidade máxima de itens em listas.
export const QUANTIDADE = { banners: 8, plans: 12, features: 4, faqs: 12 };

// Preço máximo exibível sem estourar o cartão (R$ 9.999,99).
export const PRECO_MAXIMO = 9999.99;

// Guia das imagens do banner, mostrado no painel ao lado de cada campo de imagem.
// medida: tamanho ideal em pixels. minima: abaixo disso o painel não aceita o envio.
export const IMAGENS = {
  banner: { nome: 'Banner para computador', medida: [1920, 1080], minima: [1600, 900], formato: 'horizontal (16:9)', pesoIdeal: '300 a 600 KB',
    dica: 'O lado esquerdo fica escurecido para o texto do banner. Deixe pessoas e produtos na metade direita da foto.' },
  bannerCelular: { nome: 'Banner para celular', medida: [1080, 1440], minima: [720, 960], formato: 'vertical (3:4)', pesoIdeal: '150 a 350 KB',
    dica: 'No celular a foto aparece no alto e o texto embaixo dela. Deixe o assunto principal no centro, na parte de cima.' }
};
export const TIPOS_DE_IMAGEM = ['image/jpeg', 'image/webp', 'image/png'];
export const GUIA_QUALIDADE = [
  'Formato: JPG ou WebP para fotos (qualidade de 80% a 90% ao exportar). PNG só para artes com áreas lisas.',
  'Tamanho máximo do arquivo: 8 MB. Arquivos menores deixam o site mais rápido.',
  'Cores em sRGB (padrão da internet). Evite CMYK, que fica com cores apagadas.',
  'Não coloque texto, preço ou logo dentro da imagem: use os campos do banner, que se ajustam a cada tela.',
  'A foto sempre preenche o mesmo espaço do banner; o que sobrar das bordas é recortado automaticamente.'
];
export const IMAGEM_MINIMA = Object.fromEntries(Object.entries(IMAGENS).map(([k, v]) => [k, v.minima]));

// Logo da empresa: fixo, não é alterado pelo painel.
export const LOGO = '/assets/logo.svg';

// Cores fixas da identidade visual. Não são editáveis pelo painel.
export const CORES = { accent: '#ff9300', background: '#0a192c' };

export const chaveDoCampo = caminho => String(caminho).replace(/\.\d+(?=\.|$)/g, '');
export const limiteDe = caminho => LIMITES[chaveDoCampo(caminho)];
