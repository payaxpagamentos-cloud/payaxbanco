import { api, sessao } from './api.js';
import { el, $, limpar, icone, iniciais, pode, usuario, toast, modal, formulario } from './ui.js';

// [rota, rótulo, ícone, permissão, módulo]
const MENU = [
  ['Operação', [
    ['visao', 'Visão geral', 'painel', 'painel.ver', () => import('./telas/visao.js')],
    ['noc', 'Central NOC', 'atividade', 'noc.ver', () => import('./telas/noc.js')],
    ['rede', 'Rede óptica', 'rede', 'rede.ver', () => import('./telas/rede.js')],
    ['chamados', 'Chamados técnicos', 'chamado', 'chamados.ver', () => import('./telas/chamados.js')],
    ['panorama', 'Panorama', 'pino', 'panorama.ver', () => import('./telas/panorama.js')],
    ['provisionamento', 'Provisionamento', 'servidor', ['contratos.ver', 'faturamento.ver'], () => import('./telas/provisionamento.js')],
    ['equipe', 'Equipe e comissões', 'equipe', ['equipe.ver', 'comissoes.ver'], () => import('./telas/equipe.js')],
  ]],
  ['Assinantes e financeiro', [
    ['assinantes', 'Assinantes', 'pessoa', 'assinantes.ver', () => import('./telas/assinantes.js')],
    ['contratos', 'Contratos', 'arquivo', 'contratos.ver', () => import('./telas/contratos.js')],
    ['faturamento', 'Faturamento', 'dinheiro', 'faturamento.ver', () => import('./telas/faturamento.js')],
    ['cobranca', 'Cobrança e bloqueios', 'cadeado', 'cobranca.ver', () => import('./telas/cobranca.js')],
    ['bancos', 'Cobrança bancária', 'recibo', 'faturamento.ver', () => import('./telas/cobrancas.js')],
    ['planos', 'Planos', 'camadas', 'contratos.ver', () => import('./telas/planos.js')],
  ]],
  ['Gestão de frota', [
    ['veiculos', 'Veículos', 'carro', 'frota.ver', () => import('./telas/veiculos.js')],
    ['manutencao', 'Manutenção e lavagem', 'chave', 'manutencao.ver', () => import('./telas/manutencao.js')],
    ['combustivel', 'Abastecimentos', 'combustivel', 'combustivel.ver', () => import('./telas/combustivel.js')],
    ['rastreamento', 'Rastreamento', 'pino', 'rastreamento.ver', () => import('./telas/rastreamento.js')],
  ]],
  ['Sistema', [
    ['integracoes', 'Integrações', 'plugue', 'integracoes.ver', () => import('./telas/integracoes.js')],
    ['admin', 'Organização e acessos', 'escudo', 'usuarios.gerenciar', () => import('./telas/admin.js')],
  ]],
];
const ROTAS = Object.fromEntries(MENU.flatMap(([, itens]) => itens).map(([rota, r, ic, perm, mod]) => [rota, { rotulo: r, ic, perm, mod }]));
const permitido = (perm) => [].concat(perm).some(pode);

const raiz = $('#app');
let limpeza = [];
const EFEITOS = 'network.efeitos';
const efeitosPausados = () => { try { return localStorage.getItem(EFEITOS) === 'pausados'; } catch { return false; } };
document.documentElement.classList.toggle('sem-efeitos', efeitosPausados());

window.addEventListener('hashchange', () => desenhar());
window.addEventListener('network:sair', () => desenhar());

const rotaAtual = () => {
  const [caminho, busca = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const partes = caminho.split('/').filter(Boolean).map(decodeURIComponent);
  return { rota: partes[0] || 'visao', params: partes.slice(1), query: Object.fromEntries(new URLSearchParams(busca)) };
};
export const ir = (hash) => { location.hash = hash; };

async function desenhar() {
  for (const f of limpeza) { try { f(); } catch { /* ignora */ } }
  limpeza = [];
  for (const m of document.querySelectorAll('.modal-fundo')) m.remove();
  const s = sessao.get();
  if (!s?.token) return telaEntrada();
  let { rota, params, query } = rotaAtual();
  if (rota === 'tv') return telaTv();
  if (!ROTAS[rota] || !permitido(ROTAS[rota].perm)) {
    const primeira = Object.entries(ROTAS).find(([, x]) => permitido(x.perm))?.[0];
    if (!primeira) return limpar(raiz, el('p', { class: 'vazio' }, 'Seu perfil não tem acesso a nenhum módulo.'));
    if (rota !== primeira) { history.replaceState(null, '', `#/${primeira}`); ({ rota, params, query } = rotaAtual()); rota = primeira; }
  }
  const principal = el('main', { id: 'conteudo', tabindex: '-1' });
  limpar(raiz, estrutura(rota, principal));
  try {
    const mod = await ROTAS[rota].mod();
    await mod.default({ alvo: principal, params, query, ir, aoSair: (f) => limpeza.push(f), recarregar: () => desenhar() });
  } catch (err) {
    console.error(err);
    limpar(principal, el('div', { class: 'falha' }, `Não foi possível abrir a tela: ${err.message}`));
  }
}

function estrutura(rota, principal) {
  const u = usuario();
  const menu = el('aside', { class: 'menu', id: 'menu', 'aria-label': 'Menu principal' });
  const fundo = el('div', { class: 'fundo-menu', hidden: true, onclick: () => alternarMenu(false) });
  const alternarMenu = (abrir) => {
    menu.classList.toggle('aberto', abrir);
    fundo.hidden = !abrir;
    if (abrir) menu.querySelector('a')?.focus();
  };
  menu.append(
    el('a', { class: 'marca', href: '#/visao' }, simbolo(), el('span', { class: 'marca-texto' }, 'manager', el('small', {}, 'PROVEDOR'))),
    el('div', { class: 'contexto' }, el('span', { class: 'logo' }, iniciais(u.organizacao_nome)), el('div', {}, el('strong', {}, u.organizacao_nome), el('small', {}, u.perfil_nome))),
  );
  for (const [grupo, itens] of MENU) {
    const vis = itens.filter(([, , , perm]) => permitido(perm));
    if (!vis.length) continue;
    menu.append(el('div', { class: 'grupo-menu' }, grupo), el('nav', { 'aria-label': grupo }, vis.map(([r, rot, ic]) =>
      el('a', { class: `link-menu${r === rota ? ' ativo' : ''}`, href: `#/${r}`, 'aria-current': r === rota ? 'page' : null, onclick: () => alternarMenu(false) }, icone(ic), rot))));
  }
  menu.append(el('div', { class: 'menu-rodape' },
    u.demonstracao ? el('div', { class: 'selo-demo' }, 'Ambiente demonstrativo', el('small', {}, 'Dados fictícios, separados da operação real')) : null,
    el('button', { class: 'perfil', onclick: () => menuConta() }, el('span', { class: 'avatar' }, iniciais(u.nome)), el('div', {}, el('strong', {}, u.nome), el('small', {}, u.email)))));

  const pausar = el('button', { class: 'botao-icone', title: 'Pausar efeitos visuais', 'aria-pressed': String(efeitosPausados()), onclick: () => {
    const p = !efeitosPausados();
    try { localStorage.setItem(EFEITOS, p ? 'pausados' : 'ativos'); } catch { /* ignora */ }
    document.documentElement.classList.toggle('sem-efeitos', p);
    pausar.setAttribute('aria-pressed', String(p));
    pausar.replaceChildren(icone(p ? 'tocar' : 'pausa'));
    toast(p ? 'Efeitos visuais pausados.' : 'Efeitos visuais ativos.');
  } }, icone(efeitosPausados() ? 'tocar' : 'pausa'));
  const busca = el('input', { type: 'search', placeholder: 'Buscar assinante, CPF/CNPJ, CTO, chamado ou placa', 'aria-label': 'Buscar na operação' });
  busca.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !busca.value.trim()) return;
    const t = busca.value.trim();
    const digitos = t.replace(/\D/g, '');
    const parar = (hash) => ir(hash);
    if (/^[A-Za-z]{3}-?\d[A-Za-z0-9]\d{2}$/.test(t) && permitido('frota.ver')) parar(`#/veiculos?busca=${encodeURIComponent(t)}`);
    // CPF ou CNPJ completo leva direto ao assinante.
    else if ((digitos.length === 11 || digitos.length === 14) && permitido('assinantes.ver')) parar(`#/assinantes?busca=${encodeURIComponent(digitos)}`);
    else if (/^#?\d+$/.test(t) && permitido('chamados.ver')) parar(`#/chamados?busca=${encodeURIComponent(t.replace('#', ''))}`);
    else if (/^[A-Za-zÀ-ú\s.]+$/.test(t) && permitido('assinantes.ver')) parar(`#/assinantes?busca=${encodeURIComponent(t)}`);
    else if (permitido('rede.ver')) parar(`#/rede?busca=${encodeURIComponent(t)}`);
  });
  const sino = el('button', { class: 'botao-icone', title: 'Alertas prioritários', 'aria-label': 'Alertas prioritários', onclick: () => ir(permitido('noc.ver') ? '#/noc' : '#/visao') }, icone('sino'));
  const topo = el('header', { class: 'topo' },
    el('button', { class: 'botao-icone abrir-menu', 'aria-label': 'Abrir menu', 'aria-controls': 'menu', onclick: () => alternarMenu(!menu.classList.contains('aberto')) }, icone('menu')),
    el('div', { class: 'caminho' }, el('span', {}, u.organizacao_nome), el('span', { class: 'sep' }, '/'), el('strong', {}, ROTAS[rota]?.rotulo ?? '')),
    el('div', { class: 'topo-acoes' }, permitido(['rede.ver', 'chamados.ver', 'frota.ver', 'assinantes.ver']) ? el('label', { class: 'busca-topo' }, icone('busca'), busca) : null,
      permitido('noc.ver') ? el('a', { class: 'botao-icone', href: '#/tv', title: 'Painel TV do NOC', 'aria-label': 'Painel TV do NOC' }, icone('tv')) : null, pausar, sino));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.classList.contains('aberto')) alternarMenu(false); }, { once: true });
  return el('div', { class: 'app' }, el('a', { class: 'sr', href: '#conteudo' }, 'Ir para o conteúdo'), menu, fundo, el('div', { class: 'principal' }, topo, principal));
}


function menuConta() {
  modal('Minha conta', (fechar) => [
    el('p', { style: 'margin-bottom:14px;color:var(--texto-2)' }, `${usuario().nome} · ${usuario().perfil_nome}`),
    el('div', { class: 'form-acoes', style: 'justify-content:flex-start' },
      el('button', { class: 'botao secundario', onclick: () => { fechar(); trocarSenha(); } }, 'Trocar senha'),
      el('button', { class: 'botao perigo', onclick: () => { sessao.limpar(); fechar(); desenhar(); } }, icone('sair'), 'Sair')),
  ]);
}

const trocarSenha = () => formulario('Trocar senha', [
  { nome: 'atual', rotulo: 'Senha atual', tipo: 'password', obrigatorio: true, inteiro: true, autocomplete: 'current-password' },
  { nome: 'nova', rotulo: 'Nova senha', tipo: 'password', obrigatorio: true, inteiro: true, ajuda: 'Pelo menos 8 caracteres.', autocomplete: 'new-password' },
], { enviar: async (d) => { await api.post('/auth/senha', d); toast('Senha alterada.'); } });

// Guarda só o e-mail, e só se a pessoa pedir. Senha e token nunca entram aqui.
const EMAIL_LEMBRADO = 'network.email';
const OLHO_ABERTO = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>';
const OLHO_FECHADO = '<path d="m3 3 18 18M10.5 5.1c.5-.1 1-.1 1.5-.1 6.5 0 10 7 10 7a19 19 0 0 1-3.1 3.8M6.1 6.1C3.4 8.1 2 12 2 12s3.5 7 10 7a11 11 0 0 0 5.4-1.4M10 10a2.8 2.8 0 0 0 4 4"/>';
const traco = (d) => ({ fill: 'none', stroke: 'currentColor', 'stroke-width': d });

/**
 * Tela de entrada.
 *
 * Dois controles do desenho aprovado precisam de cuidado para não prometerem o que o sistema não faz:
 *
 * "Lembrar acesso" NÃO estende a sessão — o token vale 12 horas, e mudar isso seria decisão de segurança,
 * não de tela. O que ele faz é guardar o e-mail neste navegador, para o campo vir preenchido na próxima
 * vez. A tela diz isso quando a caixa é marcada, em vez de deixar a pessoa supor que ficará conectada.
 *
 * "Esqueci minha senha" não tem para onde ir: não existe recuperação por e-mail neste sistema, as contas
 * são criadas pelo administrador da organização. Em vez de um link morto ou de um formulário que não
 * manda nada, ele diz exatamente com quem falar.
 */
const SVGNS = 'http://www.w3.org/2000/svg';
/** Cria um SVG de verdade (createElement faria um elemento HTML desconhecido, que não desenha nada). */
function svg(viewBox, conteudo, attrs = {}) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('fill', 'none');
  s.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  s.innerHTML = conteudo;
  return s;
}

let proximoIdMarca = 0;
/**
 * Monograma M em fita, a marca do Manager Provedor.
 *
 * Os gradientes precisam de id, e dois SVGs com o mesmo id na mesma página fazem o segundo herdar o
 * primeiro — por isso cada instância numera os seus. O "N" do Network saiu daqui e de todos os outros
 * pontos: era a marca do sistema anterior.
 */
function simbolo(classe = 'marca-simbolo') {
  const n = (proximoIdMarca += 1);
  const fita = `fita${n}`;
  const dobra = `dobra${n}`;
  return svg('0 0 72 44', `
    <defs>
      <linearGradient id="${fita}" x1="6" y1="5" x2="65" y2="42" gradientUnits="userSpaceOnUse">
        <stop stop-color="#8ff0c2"/><stop offset=".4" stop-color="#29d78e"/><stop offset="1" stop-color="#009659"/>
      </linearGradient>
      <linearGradient id="${dobra}" x1="25" y1="12" x2="40" y2="39" gradientUnits="userSpaceOnUse">
        <stop stop-color="#087949"/><stop offset="1" stop-color="#004c34"/>
      </linearGradient>
    </defs>
    <path d="M3 39 16 8c1-3 3-5 7-5h5l12 29-6 11h-8L19 25l-6 15H4c-1 0-2 0-1-1Z" fill="url(#${fita})"/>
    <path d="m25 4 12 29 7-16 9 21-5 5H34L18 5c2-2 5-2 7-1Z" fill="url(#${dobra})"/>
    <path d="M36 34 48 8c1-3 3-5 6-5h7l12 37c0 1 0 2-2 2H59l-6-19-8 17c-2 4-7 4-9 2l-4-8h4Z" fill="url(#${fita})"/>
    <path d="M17 7c2-3 6-3 9-3m24 3c2-3 6-3 9-3" stroke="#c0ffdc" stroke-opacity=".55" stroke-width="1.2" stroke-linecap="round"/>`,
  { class: classe });
}

/* ---------------- Entrada ---------------- */

function telaEntrada() {
  const canvasEsfera = el('canvas', { id: 'entrada-esfera' });
  const lembrado = (() => { try { return localStorage.getItem(EMAIL_LEMBRADO) ?? ''; } catch { return ''; } })();

  const email = el('input', {
    class: 'm-input m-input-email', id: 'login-email', name: 'email', type: 'email', placeholder: 'Seu e-mail',
    autocomplete: 'username', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', maxlength: '254',
    required: true, value: lembrado,
  });
  const senha = el('input', {
    class: 'm-input m-input-password', id: 'login-senha', name: 'senha', type: 'password', placeholder: 'Sua senha',
    autocomplete: 'current-password', required: true,
  });
  const lembrar = el('input', { id: 'login-lembrar', type: 'checkbox', checked: Boolean(lembrado) });
  const olho = svg('0 0 24 24', OLHO_ABERTO, traco('1.6'));
  const verSenha = el('button', {
    class: 'm-toggle', type: 'button', 'aria-label': 'Mostrar senha', 'aria-pressed': 'false', 'aria-controls': 'login-senha',
    onclick: () => {
      const mostrar = senha.type === 'password';
      senha.type = mostrar ? 'text' : 'password';
      verSenha.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
      verSenha.setAttribute('aria-pressed', String(mostrar));
      olho.innerHTML = mostrar ? OLHO_FECHADO : OLHO_ABERTO;
    },
  }, olho);

  const estado = el('p', { class: 'm-status', id: 'login-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const dizer = (texto = '', tipo = 'info') => { estado.textContent = texto; estado.dataset.kind = tipo; };

  const rotuloBotao = el('span', {}, 'Entrar no Manager');
  const seta = svg('0 0 24 24', '<path d="M4 12h16m-6-6 6 6-6 6"/>', traco('1.6'));
  const girando = el('span', { class: 'm-spinner', 'aria-hidden': 'true', hidden: true });
  const campos = el('fieldset', { class: 'm-fieldset' });
  const enviar = el('button', { class: 'm-submit', type: 'submit' }, rotuloBotao, seta, girando);
  const form = el('form', { class: 'm-form', method: 'post', 'aria-describedby': 'login-nota', 'aria-busy': 'false' });

  let ocupado = false;
  const carregando = (ligado) => {
    ocupado = ligado;
    campos.disabled = ligado;
    enviar.disabled = ligado;
    form.setAttribute('aria-busy', String(ligado));
    rotuloBotao.textContent = ligado ? 'Aguarde…' : 'Entrar no Manager';
    seta.toggleAttribute('hidden', ligado);
    girando.hidden = !ligado;
  };

  campos.append(
    el('div', { class: 'm-field' },
      el('label', { class: 'm-label', for: 'login-email' }, 'E-mail'),
      el('div', { class: 'm-input-wrap' },
        svg('0 0 24 24', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>', { ...traco('1.6'), class: 'm-field-icon' }),
        email)),
    el('div', { class: 'm-field' },
      el('label', { class: 'm-label', for: 'login-senha' }, 'Senha'),
      el('div', { class: 'm-input-wrap' }, senha, verSenha)),
    el('div', { class: 'm-options' },
      el('label', { class: 'm-remember', for: 'login-lembrar' }, lembrar, 'Lembrar acesso'),
      el('button', {
        class: 'm-forgot', type: 'button',
        onclick: () => dizer('Não há recuperação por e-mail neste sistema: as contas são criadas pelo administrador da sua '
          + 'organização, e é com ele que a senha é redefinida.'),
      }, 'Esqueci minha senha')));

  // Marcar a caixa não pode deixar a pessoa supondo que ficará conectada: a sessão continua de 12 horas.
  lembrar.addEventListener('change', () => dizer(lembrar.checked
    ? 'Vamos guardar só o seu e-mail neste computador. A sessão continua expirando normalmente.' : ''));
  form.addEventListener('input', () => { if (estado.dataset.kind === 'error') dizer(); });

  form.append(campos, enviar, estado, el('noscript', {}, el('p', { class: 'm-status' }, 'Ative o JavaScript para entrar.')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ocupado) return;
    dizer();
    carregando(true);
    try {
      const r = await api.post('/auth/login', { email: email.value.trim(), senha: senha.value });
      try {
        if (lembrar.checked) localStorage.setItem(EMAIL_LEMBRADO, email.value.trim());
        else localStorage.removeItem(EMAIL_LEMBRADO);
      } catch { /* sem armazenamento: entra do mesmo jeito */ }
      sessao.set(r);
      desenhar();
    } catch (err) {
      // A mensagem é a do servidor ("E-mail ou senha incorretos", "Usuário desativado…"), não uma genérica.
      dizer(err.message || 'Não foi possível entrar. Confira seus dados e tente novamente.', 'error');
      carregando(false);
      senha.focus();
      senha.select();
    }
  });

  const marca = (classe) => el('div', { class: 'm-brand', 'aria-label': 'Manager Provedor' },
    simbolo(`m-mark ${classe}`), el('div', { class: 'm-wordmark', 'aria-hidden': 'true' }, el('strong', {}, 'manager'), el('span', {}, 'PROVEDOR')));

  const tela = el('div', { class: 'm-login-page' },
    el('div', { class: 'm-atmosphere', 'aria-hidden': 'true' }),
    el('div', { class: 'm-light-trail', 'aria-hidden': 'true' }),
    el('div', { class: 'm-shell' },
      el('header', { class: 'm-header' }, marca('')),
      el('main', { class: 'm-main' },
        el('section', { class: 'm-hero', 'aria-labelledby': 'entrada-titulo' },
          el('div', { class: 'm-hero-copy' },
            el('h1', { class: 'm-headline', id: 'entrada-titulo' },
              el('span', { class: 'm-line' }, 'O provedor inteiro'), el('span', { class: 'm-line' }, 'sob a mesma'), el('em', {}, 'visão.')),
            el('p', { class: 'm-hero-lead' }, 'Gestão, rede e operação em um só lugar.')),
          el('div', { class: 'm-sphere', 'aria-hidden': 'true' }, canvasEsfera),
          el('ul', { class: 'm-features', 'aria-label': 'Áreas do Manager' },
            [['Rede óptica', '<path d="M3 21 12 12m-5 5 1-9m3 5 7-2M6 18 4 12m8 0 2-7m1 5 5-5"/><circle cx="8" cy="5" r="2"/><circle cx="15" cy="3" r="2"/><circle cx="21" cy="4" r="2"/><circle cx="20" cy="11" r="2"/>'],
              ['Central NOC', '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 22h8m-6-5-1 5m5-5 1 5"/>'],
              ['Operação', '<path d="m12 2 10 6-10 6L2 8l10-6Zm-10 10 10 6 10-6M2 16l10 6 10-6"/>']]
              .map(([texto, caminho]) => el('li', {}, svg('0 0 24 24', caminho, traco('1.3')), texto)))),
        el('section', { class: 'm-login-card', 'aria-labelledby': 'entrada-cartao' },
          simbolo('m-mark m-card-mark'),
          el('h2', { class: 'm-card-title', id: 'entrada-cartao' }, 'Bem-vindo'),
          el('p', { class: 'm-card-subtitle' }, 'Acesse sua conta para continuar.'),
          form,
          el('p', { class: 'm-card-note', id: 'login-nota' }, 'Use o acesso da sua organização.'))),
      el('footer', { class: 'm-footer' }, `© ${new Date().getFullYear()} Manager Provedor`)));

  limpar(raiz, tela);
  // A esfera só começa depois de estar no documento: ela se dimensiona pelo tamanho real do elemento.
  // A esfera entra na mesma lista de limpeza das telas: ao sair do login, ela se desmonta sozinha.
  import('./esfera.js')
    .then(({ criarEsfera }) => { const parar = criarEsfera(canvasEsfera); limpeza.push(parar); })
    .catch(() => { /* sem esfera o login funciona igual: ela é decoração */ });
  (lembrado ? senha : email).focus();
}

/** Painel TV: leitura à distância, atualização periódica pelo backend, sem dados de clientes. */
async function telaTv() {
  if (!pode('noc.ver')) { ir('#/visao'); return; }
  const corpo = el('div');
  const sair = el('a', { class: 'botao secundario', href: '#/noc' }, icone('voltar'), 'Sair do modo TV');
  limpar(raiz, el('div', { class: 'modo-tv' }, el('div', { class: 'tv-cab' }, simbolo(), el('h1', {}, `NOC · ${usuario().organizacao_nome}`), sair), corpo));
  sair.focus();
  const { rotulo, dataHora, desde, hora } = await import('./ui.js');
  const atualizar = async () => {
    try {
      const d = await api.get('/noc/tv');
      const disp = d.disponibilidade;
      limpar(corpo,
        el('div', { class: 'tv-stats' },
          el('div', { class: 'tv-stat' }, el('span', {}, 'Disponibilidade medida'), el('strong', {}, disp.valor === null ? 'Sem coleta' : `${disp.valor.toLocaleString('pt-BR')}%`),
            el('small', {}, disp.valor === null ? 'Nenhuma amostra nas últimas 24 h' : `${disp.equipamentos} equipamento(s) · 24 h · última ${hora(disp.ultima_coleta)}`)),
          el('div', { class: 'tv-stat' }, el('span', {}, 'Incidentes abertos'), el('strong', {}, d.incidentes.length), el('small', {}, 'Principais, após correlação')),
          el('div', { class: 'tv-stat' }, el('span', {}, 'Críticos'), el('strong', {}, d.incidentes.filter((i) => i.severidade === 'critica').length), el('small', {}, 'Severidade crítica')),
          el('div', { class: 'tv-stat' }, el('span', {}, 'Chamados críticos'), el('strong', {}, d.chamados_criticos), el('small', {}, 'Em aberto'))),
        el('div', { class: 'tv-lista' }, d.incidentes.length ? d.incidentes.map((i) => el('div', { class: `tv-inc ${i.severidade}` }, el('span', { class: 'sev', 'aria-hidden': 'true' }),
          el('div', {}, i.titulo, el('small', {}, `${rotulo('severidade', i.severidade)} · ${rotulo('statusIncidente', i.status)}${i.bairro ? ` · ${i.bairro}` : ''}${i.relacionados ? ` · ${i.relacionados} relacionado(s)` : ''}${i.portas_ocupadas ? ` · ${i.portas_ocupadas} porta(s) ocupada(s)` : ''}`)),
          el('div', {}, desde(i.inicio)))) : el('div', { class: 'tv-inc' }, el('span', { class: 'sev' }), el('div', {}, 'Nenhum incidente aberto registrado pelas fontes.'), el('div', {}, ''))),
        el('div', { class: 'tv-fontes' },
          ...Object.entries({ Monitoramento: d.fontes.monitoramento, Rastreador: d.fontes.rastreador, Downdetector: d.fontes.downdetector }).map(([n, f]) =>
            el('span', {}, `${n}: ${rotulo('estadoIntegracao', f.estado)}${f.ultimo_sucesso || f.ultimo_recebimento ? ` · ${dataHora(f.ultimo_sucesso || f.ultimo_recebimento)}` : ''}`)),
          el('span', {}, `Atualizado às ${hora(d.gerado_em)} · nova consulta a cada 30 s`)));
    } catch (err) {
      corpo.prepend(el('div', { class: 'aviso-faixa erro' }, `Conexão perdida com o servidor (${err.message}). Os números acima podem estar desatualizados.`));
    }
  };
  await atualizar();
  const t = setInterval(atualizar, 30_000);
  limpeza.push(() => clearInterval(t));
  const esc = (e) => { if (e.key === 'Escape') ir('#/noc'); };
  document.addEventListener('keydown', esc);
  limpeza.push(() => document.removeEventListener('keydown', esc));
}

// Sessão: confere o usuário no servidor (perfil e permissões podem ter mudado).
(async () => {
  const s = sessao.get();
  if (s?.token) {
    try { sessao.set({ ...s, usuario: (await api.get('/auth/me')).usuario }); } catch { /* 401 já limpa a sessão */ }
  }
  desenhar();
})();
