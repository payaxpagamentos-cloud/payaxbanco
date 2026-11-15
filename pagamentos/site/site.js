/*
 * Site PAY AX (payax.com.br): página pública com o acesso da Área do Cliente no topo.
 * O login usa as mesmas rotas da Área do Cliente (/cliente/api/auth/...), inclusive a verificação em
 * duas etapas, e grava a sessão no mesmo lugar que ela — ao entrar, o cliente cai direto no painel.
 */
import { letreiro } from '/comum/marca.js';

/**
 * Contato comercial e de atendimento. CONFIRMAR com a PAY AX antes de publicar.
 * E-mail e WhatsApp (só dígitos, com DDI e DDD, ex.: '5513999999999'); vazio = não aparece.
 */
const CONTATO = { email: 'contato@payax.com.br', whatsapp: '' };

const SESSAO = 'payax.cliente';
const $ = (s) => document.querySelector(s);
const SVG = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONE = {
  seta: SVG('<path d="M5 12h14m-5-5 5 5-5 5"/>'),
  olho: SVG('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  olhoFechado: SVG('<path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.4 5.3A9.6 9.6 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-3.2 4M6.2 7.2A18 18 0 0 0 2 12s4 7 10 7a9.7 9.7 0 0 0 3.5-.6"/>'),
};

/** Ilustrações das soluções (vetor, em degradê ciano, no lugar dos ícones de vidro da arte). */
const grad = (id) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7ff6ff"/><stop offset="1" stop-color="#14b8c8"/></linearGradient></defs>`;
const ILUSTRA = {
  pix: `<svg viewBox="0 0 64 64" aria-hidden="true">${grad('gp')}<g fill="url(#gp)" stroke="#d9fdff" stroke-opacity=".7" stroke-width="1.2">
    <rect x="23" y="5" width="18" height="18" rx="4" transform="rotate(45 32 14)"/><rect x="5" y="23" width="18" height="18" rx="4" transform="rotate(45 14 32)"/>
    <rect x="41" y="23" width="18" height="18" rx="4" transform="rotate(45 50 32)"/><rect x="23" y="41" width="18" height="18" rx="4" transform="rotate(45 32 50)"/></g></svg>`,
  boletos: `<svg viewBox="0 0 64 64" aria-hidden="true">${grad('gb')}<rect x="6" y="12" width="52" height="40" rx="7" fill="url(#gb)" opacity=".28" stroke="#4fd8e4" stroke-width="1.5"/>
    <g fill="#0f5864">${[12, 17, 20, 25, 28, 31, 36, 39, 44, 48].map((x, i) => `<rect x="${x}" y="19" width="${i % 3 === 0 ? 3 : 2}" height="26" rx="1"/>`).join('')}</g></svg>`,
  cobrancas: `<svg viewBox="0 0 64 64" aria-hidden="true">${grad('gc')}<rect x="10" y="6" width="34" height="44" rx="6" fill="url(#gc)" opacity=".3" stroke="#4fd8e4" stroke-width="1.5"/>
    <g stroke="#0f5864" stroke-width="3" stroke-linecap="round"><path d="M18 18h18M18 26h18M18 34h10"/></g>
    <circle cx="45" cy="45" r="13" fill="url(#gc)" stroke="#d9fdff" stroke-width="1.2"/><path d="m38.5 45 4.5 4.5 8.5-9" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  conciliacao: `<svg viewBox="0 0 64 64" aria-hidden="true">${grad('gk')}<g stroke="#d9fdff" stroke-opacity=".7" stroke-width="1.2">
    <path d="M32 40 6 28l26-12 26 12z" fill="url(#gk)" opacity=".55"/><path d="M32 32 6 20 32 8l26 12z" fill="url(#gk)" opacity=".8"/>
    <path d="M32 48 6 36l4-2 22 10 22-10 4 2z" fill="url(#gk)" opacity=".4"/></g></svg>`,
};

/** O que cada solução faz — fiel ao que o sistema entrega hoje. */
const DETALHES = {
  pix: ['Pix', ['Boletos com QR Code Pix (Bolepix): o pagador escolhe entre o código de barras e o Pix.',
    'Pago por Pix, o valor cai no mesmo dia e segue para a conta da sua empresa já sem a tarifa — sem pedir saque.']],
  boletos: ['Boletos', ['Boletos registrados no Bradesco, com a sua empresa identificada no boleto como beneficiário final.',
    'Emissão avulsa ou importada do sistema da sua empresa; multa e juros dentro do Código de Defesa do Consumidor.']],
  cobrancas: ['Cobranças', ['Acompanhe cada título: em aberto, vencido, pago ou baixado, com o histórico de cada etapa.',
    'Na Área do Cliente: extrato, transferências, relatórios e o boleto de cada pagador num link.']],
  conciliacao: ['Conciliação', ['O retorno do banco é processado sozinho: o pagamento é baixado na hora e o valor segue para a sua empresa.',
    'Integrado ao sistema de gestão (hoje, IXC Provedor): o título é baixado lá também, sem digitação.']],
  integracoes: ['Integrações', ['Importação automática dos títulos do sistema de gestão da sua empresa e baixa nele quando o boleto é pago.',
    'Sistemas homologados hoje: IXC Provedor. Novos sistemas entram após homologação pela PAY AX.']],
};
const CARTOES = [
  ['pix', 'Pix', 'Agilidade nos recebimentos.'],
  ['boletos', 'Boletos', 'Organize suas cobranças.'],
  ['cobrancas', 'Cobranças', 'Acompanhe cada etapa.'],
  ['conciliacao', 'Conciliação', 'Clareza sobre os recebimentos.'],
];

// ---------------------------------------------------------------- Janela (detalhes, contato, ajuda)
const janela = $('#janela');
function abrir(titulo, paragrafos) {
  $('#janela-titulo').textContent = titulo;
  $('#janela-corpo').replaceChildren(...paragrafos.map((t) => {
    if (t instanceof Node) return t;
    const p = document.createElement('p'); p.textContent = t; return p;
  }));
  janela.showModal();
}
janela.addEventListener('click', (e) => { if (e.target === janela) janela.close(); });

function contato() {
  const itens = [];
  if (CONTATO.whatsapp) {
    const a = Object.assign(document.createElement('a'), { href: `https://wa.me/${CONTATO.whatsapp}`, target: '_blank', rel: 'noopener', textContent: 'Conversar pelo WhatsApp' });
    a.className = 'botao claro'; itens.push(a);
  }
  if (CONTATO.email) {
    const a = Object.assign(document.createElement('a'), { href: `mailto:${CONTATO.email}`, textContent: CONTATO.email });
    a.className = 'contato-email'; itens.push(a);
  }
  abrir('Fale com a PAY AX', ['Conte o que a sua empresa precisa: um especialista retorna com a melhor forma de começar.', ...itens]);
}

// ---------------------------------------------------------------- Montagem
$('#logo').append(letreiro({ altura: 40 }));
$('#cartoes').append(...CARTOES.map(([id, titulo, texto], i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `cartao${i === 0 ? ' destaque' : ''}`;
  b.dataset.detalhe = id;
  b.innerHTML = `<span class="ilustra">${ILUSTRA[id]}</span><strong>${titulo}</strong><span class="texto">${texto}</span><span class="ir">${ICONE.seta}</span>`;
  return b;
}));
document.querySelectorAll('.seta').forEach((s) => { s.innerHTML = ICONE.seta; });
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-detalhe]');
  if (d) { const [t, ps] = DETALHES[d.dataset.detalhe]; abrir(t, ps); return; }
  if (e.target.closest('[data-contato]')) contato();
});

// ---------------------------------------------------------------- Acesso da Área do Cliente
const form = $('#acesso');
const senha = $('#senha');
const olho = $('#olho');
const msg = $('#mensagem');
let desafio = null;
olho.innerHTML = ICONE.olho;
olho.addEventListener('click', () => {
  const mostrar = senha.type === 'password';
  senha.type = mostrar ? 'text' : 'password';
  olho.innerHTML = mostrar ? ICONE.olhoFechado : ICONE.olho;
  olho.setAttribute('aria-label', mostrar ? 'Ocultar a senha' : 'Mostrar a senha');
});
$('#esqueci').addEventListener('click', () => abrir('Esqueci minha senha',
  ['Peça ao administrador do acesso da sua empresa (Cadastro e acessos → Acessos) ou ao seu gerente de conta PAY AX para gerar uma senha provisória. Você troca por uma sua no primeiro acesso.']));

async function postar(caminho, corpo) {
  const r = await fetch(`/cliente/api${caminho}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || 'Não foi possível entrar. Tente de novo.');
  return d;
}
function entrarNoPainel(d) {
  try { localStorage.setItem(SESSAO, JSON.stringify(d)); } catch { /* sem armazenamento: o painel pede login de novo */ }
  location.href = '/cliente/#/inicio';
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const botoes = form.querySelectorAll('button[type=submit]');
  botoes.forEach((b) => { b.disabled = true; });
  msg.textContent = '';
  try {
    if (!desafio) {
      const email = $('#email').value.trim();
      if (!email || !senha.value) throw new Error('Informe o e-mail e a senha.');
      const d = await postar('/auth/login', { email, senha: senha.value });
      if (d.precisa_2fa) {
        desafio = d.desafio;
        $('#acesso-campos').hidden = true;
        $('#acesso-codigo').hidden = false;
        msg.textContent = 'Digite o código do seu aplicativo de autenticação.';
        $('#codigo').focus();
        return;
      }
      entrarNoPainel(d);
    } else {
      entrarNoPainel(await postar('/auth/2fa', { desafio, codigo: $('#codigo').value.replace(/\D/g, '') }));
    }
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('erro');
    // Verificação vencida (5 minutos): volta para e-mail e senha.
    if (desafio && /expirou/i.test(err.message)) {
      desafio = null;
      $('#acesso-campos').hidden = false;
      $('#acesso-codigo').hidden = true;
    }
  } finally {
    botoes.forEach((b) => { b.disabled = false; });
  }
});
$('#codigo').addEventListener('input', (e) => { if (e.target.value.replace(/\D/g, '').length === 6) form.requestSubmit(); });
