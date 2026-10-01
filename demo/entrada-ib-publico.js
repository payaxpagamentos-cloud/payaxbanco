/* Demo pública do Internet Banking: o IB é a página principal (sem acesso ao Banqueiro da equipe). */
import { faixaDemo } from './backend.js';

window.PAYAX_RAIZ = '';
window.PAYAX_SITE = null;
faixaDemo(null);
import('../public/ib/js/app.js');
