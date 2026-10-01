/* Demo pública do Internet Banking: o IB é a página principal (sem acesso ao Banqueiro da equipe). */
import { faixaDemo } from './backend.js';

window.PAYAX_RAIZ = '';
// Site institucional publicado (o botão "Acessar minha conta" de lá traz o cliente para cá).
window.PAYAX_SITE = 'https://claude.ai/artifact/VPrPvkc1rzD3jJUiBv6t4Z';
faixaDemo(null);
import('../public/ib/js/app.js');
