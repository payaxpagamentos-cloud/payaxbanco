/* Internet Banking dentro da demo do site institucional (dist-site/ib/). */
import { faixaDemo } from './backend.js';

window.PAYAX_SITE = '../index.html';
faixaDemo({ href: '../index.html', rotulo: 'Voltar ao site' });
import('../public/ib/js/app.js');
