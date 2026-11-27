export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = text => { throw new HttpError(400, text); };
function string(value, name, max = 240, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`Confira o campo ${name}.`);
  return value.trim();
}
function bool(v) { return v === true; }
function list(v, name, limit = 40) { if (!Array.isArray(v) || v.length > limit) fail(`Lista inválida: ${name}.`); return v; }
export function safeUrl(value, image = false) {
  const text = string(value, 'link', 1600);
  if (!text) return '';
  if (text.startsWith('/') && !text.startsWith('//') && !/[\\\s<>"']/.test(text) && !text.includes('..')) return text;
  if (!image && /^#[a-z0-9-]+$/i.test(text)) return text;
  try { const u = new URL(text); if (u.protocol === 'https:' && !u.username && !u.password) return u.href; } catch {}
  fail('Use um link HTTPS ou um caminho interno válido.');
}
export function validateConfig(c) {
  if (!c || typeof c !== 'object') fail('Conteúdo inválido.');
  const b = c.brand || {}, contact = c.contact || {}, section = c.plansSection || {};
  const color = (v, name) => { if (!/^#[\da-f]{6}$/i.test(v)) fail(`Cor inválida: ${name}.`); return v; };
  const id = v => { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(v)) fail('Identificador inválido.'); return v; };
  const unique = values => { if (new Set(values.map(v => v.id)).size !== values.length) fail('Existem itens com identificadores repetidos.'); return values; };
  const interval = v => Number.isInteger(v) && v >= 4000 && v <= 20000 ? v : 6500;
  const banners = unique(list(c.banners, 'banners', 20).map(v => ({ id: id(v.id), active: bool(v.active), eyebrow: string(v.eyebrow, 'etiqueta'), title: string(v.title, 'título', 90, true), highlight: string(v.highlight, 'destaque', 80), subtitle: string(v.subtitle, 'descrição'), image: safeUrl(v.image, true), mobileImage: safeUrl(v.mobileImage || '', true), imagePosition: /^\d{1,3}% \d{1,3}%$/.test(v.imagePosition) ? v.imagePosition : '65% 50%', primaryLabel: string(v.primaryLabel, 'botão principal', 48), primaryUrl: safeUrl(v.primaryUrl), secondaryLabel: string(v.secondaryLabel, 'botão secundário', 48), secondaryUrl: safeUrl(v.secondaryUrl) })));
  const plans = unique(list(c.plans, 'planos', 40).map(v => {
    if (v.price !== null && (!Number.isFinite(v.price) || v.price < 0 || v.price > 100000)) fail('Preço inválido. Use um número ou deixe vazio.');
    return { id: id(v.id), active: bool(v.active), featured: bool(v.featured), label: string(v.label, 'etiqueta'), name: string(v.name, 'nome do plano', 70, true), description: string(v.description, 'descrição'), price: v.price === null ? null : Math.round(v.price * 100) / 100, priceSuffix: string(v.priceSuffix, 'período', 32), terms: string(v.terms, 'condições', 300), features: list(v.features, 'benefícios', 8).map(s => string(s, 'benefício', 100)), button: string(v.button, 'botão', 48, true) };
  }));
  if (!banners.some(v => v.active)) fail('Mantenha ao menos um banner ativo.');
  if (!plans.some(v => v.active)) fail('Mantenha ao menos um plano ativo.');
  const ranges = list(c.coverage?.ranges, 'cobertura', 300).map(v => {
    if (!/^\d{8}$/.test(v.start) || !/^\d{8}$/.test(v.end) || v.start > v.end) fail('Confira o intervalo de CEPs.');
    return { name: string(v.name, 'região', 120, true), start: v.start, end: v.end };
  });
  const whatsapp = string(contact.whatsapp, 'WhatsApp', 20).replace(/\D/g, '');
  if (whatsapp && !/^\d{10,15}$/.test(whatsapp)) fail('Confira o WhatsApp com DDI e DDD.');
  const email = string(contact.email, 'e-mail', 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('E-mail inválido.');
  return {
    brand: { name: string(b.name, 'empresa', 80, true), tagline: string(b.tagline, 'slogan'), logo: safeUrl(b.logo, true), accent: color(b.accent, 'destaque'), background: color(b.background, 'fundo') },
    seo: { title: string(c.seo?.title, 'título da página', 120, true), description: string(c.seo?.description, 'descrição de busca', 320) },
    contact: { whatsapp, email, phone: string(contact.phone, 'telefone', 50), address: string(contact.address, 'endereço', 240), portalUrl: safeUrl(contact.portalUrl), invoiceUrl: safeUrl(contact.invoiceUrl), supportUrl: safeUrl(contact.supportUrl), privacyUrl: safeUrl(contact.privacyUrl) },
    hero: { autoplay: bool(c.hero?.autoplay), interval: interval(c.hero?.interval), badge: string(c.hero?.badge, 'texto no banner', 120) }, banners, plans,
    plansSection: { title: string(section.title, 'título dos planos', 100, true), subtitle: string(section.subtitle, 'subtítulo'), note: string(section.note, 'observação', 320), autoplay: bool(section.autoplay), interval: interval(section.interval) },
    services: { title: string(c.services?.title, 'título do atendimento', 120), description: string(c.services?.description, 'descrição do atendimento'), first: string(c.services?.first, 'primeiro serviço', 80), second: string(c.services?.second, 'segundo serviço', 80) },
    coverage: { title: string(c.coverage?.title, 'título de cobertura', 120), subtitle: string(c.coverage?.subtitle, 'texto de cobertura'), strict: bool(c.coverage?.strict), ranges },
    customer: { title: string(c.customer?.title, 'título do cliente', 100), account: string(c.customer?.account, 'minha conta', 48), invoice: string(c.customer?.invoice, 'fatura', 48), support: string(c.customer?.support, 'suporte', 48) },
    faqs: list(c.faqs, 'perguntas', 30).map(v => ({ question: string(v.question, 'pergunta', 200, true), answer: string(v.answer, 'resposta', 1500, true) }))
  };
}
export function validateLead(body) {
  const name = string(body.name, 'nome', 100, true), phone = string(body.phone, 'telefone', 30).replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(phone)) fail('Informe um telefone válido com DDD.');
  const cep = string(body.cep || '', 'CEP', 12).replace(/\D/g, '');
  if (cep && !/^\d{8}$/.test(cep)) fail('Informe um CEP com 8 dígitos.');
  if (body.consent !== true) fail('Autorize o contato para enviar.');
  return { name, phone, cep, plan: string(body.plan || '', 'plano', 100) };
}
