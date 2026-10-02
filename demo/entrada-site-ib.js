/* Internet Banking da demonstração do site institucional (dist-site/ib/), aberto por cima do site. */
import { faixaDemo } from './backend.js';

window.PAYAX_SITE = '../index.html';
// Mesma regra de EMBUTIDO em raiz.js (não importado aqui para que PAYAX_SITE seja lido depois de definido).
const embutido = window.parent !== window && (window.PAYAX_EMBUTIDO === true || new URLSearchParams(location.search).has('embutido'));
if (!embutido) faixaDemo({ href: '../index.html', rotulo: 'Voltar ao site' });
import('../public/ib/js/app.js');
