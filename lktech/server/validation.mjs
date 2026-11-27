import { LIMITES, LINHAS, QUANTIDADE, PRECO_MAXIMO, CORES, LOGO } from '../public/limites.js';
import { seed } from './seed.mjs';
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = text => { throw new HttpError(400, text); };
function string(value, name, max = 240, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`Confira o campo ${name}.`);
  return value.trim();
}
// Texto de um espaço do site: limite pelo caminho do campo, uma linha só (salvo os listados em LINHAS).
function texto(value, caminho, name, required = false) {
  const max = LIMITES[caminho];
  if (typeof value !== 'string') fail(`Confira o campo ${name}.`);
  const linhas = LINHAS[caminho] || 1;
  let limpo = linhas > 1
    ? value.replace(/\r/g, '').split('\n').map(v => v.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
    : value.replace(/\s+/g, ' ').trim();
  if (limpo.split('\n').length > linhas) fail(`O campo ${name} aceita no máximo ${linhas} linhas.`);
  if (required && !limpo) fail(`Preencha o campo ${name}.`);
  if (max && limpo.length > max) fail(`O campo ${name} aceita até ${max} caracteres (agora tem ${limpo.length}). Encurte o texto para não desalinhar o site.`);
  return limpo;
}
function posicao(v) { const m = /^(\d{1,3})% (\d{1,3})%$/.exec(v || ''); return m && +m[1] <= 100 && +m[2] <= 100 ? v : '65% 50%'; }
function bool(v) { return v === true; }
function list(v, name, limit = 40) { if (!Array.isArray(v)) fail(`Lista inválida: ${name}.`); if (v.length > limit) fail(`Use no máximo ${limit} ${name}, para manter o site organizado.`); return v; }
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
  const id = v => { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(v)) fail('Identificador inválido.'); return v; };
  const unique = values => { if (new Set(values.map(v => v.id)).size !== values.length) fail('Existem itens com identificadores repetidos.'); return values; };
  const interval = v => Number.isInteger(v) && v >= 4000 && v <= 20000 ? v : 6500;
  const banners = unique(list(c.banners, 'banners', QUANTIDADE.banners).map(v => ({ id: id(v.id), active: bool(v.active), eyebrow: texto(v.eyebrow, 'banners.eyebrow', 'etiqueta do banner'), title: texto(v.title, 'banners.title', 'título do banner', true), highlight: texto(v.highlight, 'banners.highlight', 'trecho em laranja'), subtitle: texto(v.subtitle, 'banners.subtitle', 'descrição do banner'), image: safeUrl(v.image, true), mobileImage: safeUrl(v.mobileImage || '', true), imagePosition: posicao(v.imagePosition), primaryLabel: texto(v.primaryLabel, 'banners.primaryLabel', 'botão principal'), primaryUrl: safeUrl(v.primaryUrl), secondaryLabel: texto(v.secondaryLabel, 'banners.secondaryLabel', 'botão secundário'), secondaryUrl: safeUrl(v.secondaryUrl) })));
  const plans = unique(list(c.plans, 'planos', QUANTIDADE.plans).map(v => {
    if (v.price !== null && (!Number.isFinite(v.price) || v.price < 0 || v.price > PRECO_MAXIMO)) fail('Preço inválido. Use um valor de 0 a 9.999,99 ou deixe vazio.');
    return { id: id(v.id), active: bool(v.active), featured: bool(v.featured), label: texto(v.label, 'plans.label', 'etiqueta do plano'), name: texto(v.name, 'plans.name', 'nome do plano', true), description: texto(v.description, 'plans.description', 'descrição do plano'), price: v.price === null ? null : Math.round(v.price * 100) / 100, priceSuffix: texto(v.priceSuffix, 'plans.priceSuffix', 'período do preço'), terms: texto(v.terms, 'plans.terms', 'condições da oferta'), features: list(v.features, 'benefícios', QUANTIDADE.features).map(s => texto(s, 'plans.features', 'benefício')), button: texto(v.button, 'plans.button', 'botão do plano', true) };
  }));
  if (!banners.some(v => v.active)) fail('Mantenha ao menos um banner ativo.');
  if (!plans.some(v => v.active)) fail('Mantenha ao menos um plano ativo.');
  const ranges = list(c.coverage?.ranges, 'cobertura', 300).map(v => {
    const start = String(v.start ?? '').replace(/\D/g, ''), end = String(v.end ?? '').replace(/\D/g, '');
    const nome = typeof v.name === 'string' && v.name.trim() ? ` da região “${v.name.trim().slice(0, 60)}”` : '';
    if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) fail(`Confira os CEPs${nome}: use 8 dígitos, por exemplo 01000-000.`);
    if (start > end) fail(`Confira os CEPs${nome}: o CEP inicial deve ser menor que o final.`);
    return { name: texto(v.name, 'coverage.ranges.name', 'região', true), start, end };
  });
  const whatsapp = string(contact.whatsapp, 'WhatsApp', 20).replace(/\D/g, '');
  if (whatsapp && !/^\d{10,15}$/.test(whatsapp)) fail('Confira o WhatsApp com DDI e DDD.');
  const email = texto(contact.email, 'contact.email', 'e-mail');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('E-mail inválido.');
  return {
    brand: { name: texto(b.name, 'brand.name', 'nome da empresa', true), tagline: texto(b.tagline, 'brand.tagline', 'slogan'), logo: LOGO, accent: CORES.accent, background: CORES.background },
    seo: { title: texto(c.seo?.title, 'seo.title', 'título da página', true), description: texto(c.seo?.description, 'seo.description', 'descrição para buscadores') },
    contact: { whatsapp, email, phone: texto(contact.phone, 'contact.phone', 'telefone'), address: texto(contact.address, 'contact.address', 'endereço'), portalUrl: safeUrl(contact.portalUrl), invoiceUrl: safeUrl(contact.invoiceUrl), supportUrl: safeUrl(contact.supportUrl), privacyUrl: safeUrl(contact.privacyUrl) },
    hero: { autoplay: bool(c.hero?.autoplay), interval: interval(c.hero?.interval), badge: texto(c.hero?.badge, 'hero.badge', 'texto do cartão sobre a foto') }, banners, plans,
    plansSection: { title: texto(section.title, 'plansSection.title', 'título dos planos', true), subtitle: texto(section.subtitle, 'plansSection.subtitle', 'subtítulo dos planos'), note: texto(section.note, 'plansSection.note', 'observação dos planos'), autoplay: bool(section.autoplay), interval: interval(section.interval) },
    services: { title: texto(c.services?.title, 'services.title', 'título do atendimento'), description: texto(c.services?.description, 'services.description', 'descrição do atendimento'), first: texto(c.services?.first, 'services.first', 'primeiro atalho'), second: texto(c.services?.second, 'services.second', 'segundo atalho') },
    coverage: { title: texto(c.coverage?.title, 'coverage.title', 'título da cobertura'), subtitle: texto(c.coverage?.subtitle, 'coverage.subtitle', 'texto da cobertura'), strict: bool(c.coverage?.strict), ranges },
    customer: { title: texto(c.customer?.title, 'customer.title', 'título “Já é cliente?”'), account: texto(c.customer?.account, 'customer.account', 'Minha conta'), invoice: texto(c.customer?.invoice, 'customer.invoice', 'Segunda via'), support: texto(c.customer?.support, 'customer.support', 'Suporte') },
    faqs: list(c.faqs, 'perguntas', QUANTIDADE.faqs).map(v => ({ question: texto(v.question, 'faqs.question', 'pergunta', true), answer: texto(v.answer, 'faqs.answer', 'resposta', true) }))
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

// Ajusta um conteúdo qualquer (inclusive antigo, gravado antes das regras atuais) para caber
// no desenho do site: completa o que falta com o conteúdo inicial, encurta textos longos,
// corta listas no máximo permitido e fixa cores e logo. Nunca lança erro.
export function ajustarAosLimites(entrada) {
  const c = entrada && typeof entrada === 'object' ? structuredClone(entrada) : {};
  const base = structuredClone(seed);
  for (const [secao, padrao] of Object.entries(base)) {
    if (Array.isArray(padrao)) { if (!Array.isArray(c[secao])) c[secao] = padrao; }
    else if (!c[secao] || typeof c[secao] !== 'object' || Array.isArray(c[secao])) c[secao] = padrao;
    else c[secao] = { ...padrao, ...c[secao] };
  }
  if (!Array.isArray(c.coverage.ranges)) c.coverage.ranges = [];
  const corta = (texto, caminho) => {
    const linhas = LINHAS[caminho] || 1;
    let limpo = linhas > 1
      ? texto.replace(/\r/g, '').split('\n').map(v => v.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, linhas).join('\n')
      : texto.replace(/\s+/g, ' ').trim();
    const max = LIMITES[caminho];
    return max && limpo.length > max ? limpo.slice(0, max).trimEnd() : limpo;
  };
  const percorre = (valor, caminho) => {
    if (typeof valor === 'string') return LIMITES[caminho] ? corta(valor, caminho) : valor;
    if (Array.isArray(valor)) {
      const nome = caminho.split('.').at(-1);
      const lista = QUANTIDADE[nome] ? valor.slice(0, QUANTIDADE[nome]) : valor;
      return lista.map(v => percorre(v, caminho));
    }
    if (valor && typeof valor === 'object') { for (const k of Object.keys(valor)) valor[k] = percorre(valor[k], caminho ? `${caminho}.${k}` : k); return valor; }
    return valor;
  };
  percorre(c, '');
  for (const p of c.plans) if (p && p.price !== null && !(Number.isFinite(p.price) && p.price >= 0 && p.price <= PRECO_MAXIMO)) p.price = null;
  for (const p of c.plans) if (p && !Array.isArray(p.features)) p.features = [];
  c.brand.accent = CORES.accent; c.brand.background = CORES.background; c.brand.logo = LOGO;
  return c;
}
