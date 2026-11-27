export const seed = {
  brand: { name: 'LK TECH', tagline: 'Sua vida mais conectada.', logo: '/assets/logo.svg', accent: '#ff9300', background: '#0a192c' },
  seo: { title: 'LK TECH | Sua vida mais conectada', description: 'Conheça as opções de internet fibra da LK TECH e consulte a disponibilidade para o seu endereço.' },
  contact: { whatsapp: '', email: '', phone: '', address: '', portalUrl: '', invoiceUrl: '', supportUrl: '', privacyUrl: '' },
  hero: { autoplay: true, interval: 6500, badge: 'Sua vida mais conectada.' },
  banners: [{ id: 'principal', active: true, eyebrow: 'INTERNET FIBRA LK TECH', title: 'Conecte o seu', highlight: 'próximo passo.', subtitle: 'Internet para todos os seus momentos.', image: '/assets/hero-casal.jpg', mobileImage: '', imagePosition: '65% 50%', primaryLabel: 'Conhecer planos', primaryUrl: '#planos', secondaryLabel: 'Ver cobertura', secondaryUrl: '#cobertura' }],
  plansSection: { title: 'A conexão ideal para você.', subtitle: 'Deslize e encontre o plano ideal para você.', note: 'Exemplos de planos. Consulte ofertas e disponibilidade.', autoplay: false, interval: 6000 },
  plans: [
    { id: 'fibra-500', active: true, featured: false, label: 'INTERNET FIBRA', name: '500 MEGA', description: 'Para a sua casa', price: null, priceSuffix: '/mês', terms: '', features: [], button: 'Consultar plano' },
    { id: 'fibra-700', active: true, featured: true, label: 'INTERNET FIBRA', name: '700 MEGA', description: 'Para o seu dia a dia', price: null, priceSuffix: '/mês', terms: '', features: [], button: 'Consultar plano' },
    { id: 'fibra-900', active: true, featured: false, label: 'INTERNET FIBRA', name: '900 MEGA', description: 'Mais possibilidades', price: null, priceSuffix: '/mês', terms: '', features: [], button: 'Consultar plano' },
    { id: 'fibra-100', active: true, featured: false, label: 'INTERNET FIBRA', name: '100 MEGA', description: 'Para começar a se conectar', price: null, priceSuffix: '/mês', terms: '', features: [], button: 'Consultar plano' }
  ],
  services: { title: 'Mais perto.\nMais simples.', description: 'Conte com a LK TECH no seu dia a dia.', first: 'Atendimento próximo', second: 'Facilidade para você' },
  coverage: { title: 'Sua próxima conexão começa aqui.', subtitle: 'Consulte a disponibilidade na sua região.', strict: false, ranges: [] },
  customer: { title: 'Já é cliente?', account: 'Minha conta', invoice: 'Segunda via', support: 'Suporte técnico' },
  faqs: []
};
