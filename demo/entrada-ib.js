/* Demo do Internet Banking (cliente). */
import { faixaDemo } from './backend.js';

window.PAYAX_SITE = null;

faixaDemo({ href: '../index.html', rotulo: 'Abrir Banqueiro (equipe)' });
import('../public/ib/js/app.js');
