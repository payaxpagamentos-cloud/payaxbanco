import { criarApi } from '../comum/api.js';
import { el, $, limpar, icone, iniciais, toast, modal, campo, lerForm, acao, aviso } from '../comum/ui.js';
import { formularioDesafio, blocoDoisFatores } from '../comum/doisfatores.js';
import { marcaMenu, marcaEntrada } from '../comum/marca.js';

export const api = criarApi({
  base: new URL('..', import.meta.url).pathname.replace(/\/$/, ''),
  chave: 'payax.cliente',
  evento: 'payax:sair',
});
export const usuario = () => api.sessao.get()?.usuario ?? null;
export const pode = (p) => Boolean(usuario()?.permissoes?.includes(p));
export const ir = (hash) => { location.hash = hash; };

const MENU = [
  ['Minha conta', [
    ['inicio', 'Início', 'painel', 'painel.ver', () => import('./telas/inicio.js')],
    ['boletos', 'Meus boletos', 'boleto', 'boletos.ver', () => import('./telas/boletos.js')],
    ['extrato', 'Extrato', 'lista', 'razao.ver', () => import('./telas/extrato.js')],
    ['repasses', 'Repasses', 'troca', 'repasses.ver', () => import('./telas/repasses.js')],
  ]],
  ['Gestão', [
    ['relatorios', 'Relatórios', 'relatorio', 'relatorios.ver', () => import('./telas/relatorios.js')],
    ['cadastro', 'Cadastro e acessos', 'config', 'cadastro.ver', () => import('./telas/cadastro.js')],
  ]],
];
const ROTAS = Object.fromEntries(MENU.flatMap(([, itens]) => itens).map(([rota, rotulo, ic, perm, mod]) => [rota, { rotulo, ic, perm, mod }]));
const permitido = (perm) => [].concat(perm).some(pode);

const raiz = $('#app');
let limpeza = [];
window.addEventListener('hashchange', () => desenhar());
window.addEventListener('payax:sair', () => desenhar());

const rotaAtual = () => {
  const [caminho, busca = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const partes = caminho.split('/').filter(Boolean).map(decodeURIComponent);
  return { rota: partes[0] || 'inicio', params: partes.slice(1), query: Object.fromEntries(new URLSearchParams(busca)) };
};

async function desenhar() {
  for (const f of limpeza) { try { f(); } catch { /* ignora */ } }
  limpeza = [];
  for (const m of document.querySelectorAll('.modal-fundo')) m.remove();
  if (!api.sessao.get()?.token) return telaEntrada();
  if (usuario()?.senha_provisoria) return trocarSenha();

  let { rota, params, query } = rotaAtual();
  if (!ROTAS[rota] || !permitido(ROTAS[rota].perm)) {
    const primeira = Object.entries(ROTAS).find(([, x]) => permitido(x.perm))?.[0] ?? 'inicio';
    if (rota !== primeira) { history.replaceState(null, '', `#/${primeira}`); rota = primeira; params = []; query = {}; }
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
  const fundo = el('div', { class: 'fundo-menu', hidden: true, onclick: () => alternar(false) });
  const alternar = (abrir) => { menu.classList.toggle('aberto', abrir); fundo.hidden = !abrir; };
  menu.append(
    el('a', { class: 'marca', href: '#/inicio' }, marcaMenu('INTERNET BANK')),
    el('div', { class: 'contexto' }, el('span', { class: 'logo' }, iniciais(u.cliente_nome)),
      el('div', {}, el('strong', {}, u.cliente_nome), el('small', {}, u.perfil_nome))));
  for (const [grupo, itens] of MENU) {
    const vis = itens.filter(([, , , perm]) => permitido(perm));
    if (!vis.length) continue;
    menu.append(el('div', { class: 'grupo-menu' }, grupo), el('nav', { 'aria-label': grupo }, vis.map(([r, rot, ic]) =>
      el('a', { class: `link-menu${r === rota ? ' ativo' : ''}`, href: `#/${r}`, 'aria-current': r === rota ? 'page' : null, onclick: () => alternar(false) }, icone(ic), rot))));
  }
  menu.append(el('div', { class: 'menu-rodape' },
    u.cliente_situacao !== 'ativo'
      ? el('div', { class: 'selo-ambiente' }, `Conta ${u.cliente_situacao}`, el('small', {}, 'Fale com o seu gerente de conta'))
      : null,
    el('button', { class: 'perfil', onclick: menuConta }, el('span', { class: 'avatar' }, iniciais(u.nome)),
      el('div', {}, el('strong', {}, u.nome), el('small', {}, u.email)))));

  const topo = el('header', { class: 'topo' },
    el('button', { class: 'botao-icone abrir-menu', 'aria-label': 'Abrir menu', 'aria-controls': 'menu', onclick: () => alternar(!menu.classList.contains('aberto')) }, icone('menu')),
    el('div', { class: 'caminho' }, el('span', {}, u.cliente_nome), el('span', { class: 'sep' }, '/'), el('strong', {}, ROTAS[rota]?.rotulo ?? '')),
    el('div', { class: 'topo-acoes' },
      pode('boletos.emitir') ? el('a', { class: 'botao', href: '#/boletos?novo=1' }, icone('mais'), 'Novo boleto') : null));
  // No celular, as quatro telas do dia a dia ficam na barra de baixo — é onde a mão alcança.
  const BAIXO = [
    ['inicio', 'Início', 'casa', 'painel.ver'],
    ['boletos', 'Boletos', 'boleto', 'boletos.ver'],
    ['extrato', 'Extrato', 'lista', 'razao.ver'],
    ['repasses', 'Transferir', 'pix', 'repasses.ver'],
  ].filter(([, , , perm]) => permitido(perm));
  const barra = el('nav', { class: 'barra-inferior', 'aria-label': 'Navegação principal' },
    BAIXO.map(([r, rot, ic]) => el('a', { class: r === rota ? 'ativo' : '', href: `#/${r}`, 'aria-current': r === rota ? 'page' : null },
      icone(ic), el('span', {}, rot))));

  return el('div', { class: 'app' }, el('a', { class: 'sr', href: '#conteudo' }, 'Ir para o conteúdo'), menu, fundo,
    el('div', { class: 'principal' }, topo, principal), barra);
}

function menuConta() {
  const u = usuario();
  const m = modal({
    titulo: 'Minha conta',
    corpo: [
      el('div', { class: 'pares' },
        el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Nome'), el('span', { class: 'val' }, u.nome)),
        el('div', { class: 'par' }, el('span', { class: 'rot' }, 'E-mail'), el('span', { class: 'val' }, u.email)),
        el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Empresa'), el('span', { class: 'val' }, u.cliente_nome)),
        el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Perfil'), el('span', { class: 'val' }, u.perfil_nome))),
      el('hr', { style: 'border:0;border-top:1px solid var(--borda)' }),
      el('h3', { style: 'font-size:14px;margin-bottom:8px' }, 'Autenticação em duas etapas'),
      blocoDoisFatores(api, {
        ativo: Boolean(u.totp_ativo),
        aoMudar: (ativo) => {
          const sess = api.sessao.get();
          api.sessao.set({ ...sess, usuario: { ...sess.usuario, totp_ativo: ativo } });
        },
      }),
      el('hr', { style: 'border:0;border-top:1px solid var(--borda)' }),
      formularioSenha(() => m.fechar()),
    ],
    acoes: [el('button', { class: 'botao sec', onclick: () => { api.sessao.limpar(); location.hash = ''; window.dispatchEvent(new CustomEvent('payax:sair')); } }, icone('sair'), 'Sair')],
  });
}

function formularioSenha(aoConcluir) {
  // O botão fica DENTRO do form: um submit fora dele não dispara o envio.
  const form = el('form', { onsubmit: (e) => { e.preventDefault(); enviar(botao); } },
    el('div', { class: 'linha-form' },
      campo({ nome: 'senha_atual', rotulo: 'Senha atual', tipo: 'password', obrigatorio: true }),
      campo({ nome: 'senha_nova', rotulo: 'Nova senha (mín. 8)', tipo: 'password', obrigatorio: true })));
  const botao = el('button', { class: 'botao', type: 'submit' }, 'Trocar senha');
  form.append(el('div', { style: 'margin-top:10px' }, botao));
  const enviar = (b) => acao(b, async () => {
    await api.post('/auth/senha', lerForm(form));
    const s = api.sessao.get();
    api.sessao.set({ ...s, usuario: { ...s.usuario, senha_provisoria: false } });
    toast('Senha alterada.', 'ok');
    aoConcluir?.();
  });
  return el('div', {}, el('h3', { style: 'font-size:14px;margin-bottom:8px' }, 'Trocar senha'), form);
}

function trocarSenha() {
  limpar(raiz, el('div', { class: 'tela-entrada' }, el('div', { class: 'tela-entrada-caixa' },
    marcaEntrada('INTERNET BANK'),
    el('h1', {}, 'Crie a sua senha'),
    el('p', { class: 'apoio' }, 'Você entrou com a senha provisória. Escolha uma senha sua para continuar.'),
    formularioSenha(() => desenhar()))));
}

/** Segunda etapa do login. */
function telaDesafio(desafio) {
  limpar(raiz, el('div', { class: 'tela-entrada' }, el('div', { class: 'tela-entrada-caixa' },
    marcaEntrada('INTERNET BANK'),
    el('h1', {}, 'Verificação em duas etapas'),
    formularioDesafio(api, {
      desafio,
      aoEntrar: (d) => { api.sessao.set(d); location.hash = '#/inicio'; desenhar(); },
      aoVoltar: () => telaEntrada(),
    }))));
}

function telaEntrada() {
  const form = el('form', { onsubmit: (e) => { e.preventDefault(); entrar(); } },
    el('div', { style: 'display:grid;gap:12px' },
      campo({ nome: 'email', rotulo: 'E-mail', tipo: 'email', obrigatorio: true, atributos: { autocomplete: 'username' } }),
      campo({ nome: 'senha', rotulo: 'Senha', tipo: 'password', obrigatorio: true, atributos: { autocomplete: 'current-password' } })));
  const botao = el('button', { class: 'botao', style: 'width:100%;justify-content:center', onclick: () => entrar() }, 'Entrar');
  const entrar = () => acao(botao, async () => {
    const d = await api.post('/auth/login', lerForm(form));
    if (d.precisa_2fa) return telaDesafio(d.desafio);
    api.sessao.set(d);
    location.hash = '#/inicio';
    return desenhar();
  });
  limpar(raiz, el('div', { class: 'tela-entrada' }, el('div', { class: 'tela-entrada-caixa' },
    marcaEntrada('INTERNET BANK'),
    el('h1', {}, 'Acesse a sua conta'),
    el('p', { class: 'apoio' }, 'Use o e-mail e a senha que a PAY AX enviou. Na primeira entrada você troca a senha.'),
    form, botao)));
  form.querySelector('input')?.focus();
}

desenhar();
