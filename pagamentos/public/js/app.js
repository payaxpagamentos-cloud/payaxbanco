import { criarApi } from '../comum/api.js';
import { el, $, limpar, icone, iniciais, toast, modal, campo, lerForm, acao, aviso, R } from '../comum/ui.js';
import { formularioDesafio, blocoDoisFatores } from '../comum/doisfatores.js';
import { marcaMenu } from '../comum/marca.js';
import { telaAcesso, formularioEntrada } from '../comum/acesso.js';

export const api = criarApi({
  base: new URL('..', import.meta.url).pathname.replace(/\/$/, ''),
  chave: 'payax.equipe',
  evento: 'payax:sair',
});
export const usuario = () => api.sessao.get()?.usuario ?? null;
export const pode = (p) => Boolean(usuario()?.permissoes?.includes(p));
export const ir = (hash) => { location.hash = hash; };

// [rota, rótulo, ícone, permissão, módulo]
const MENU = [
  ['Operação', [
    ['visao', 'Visão geral', 'painel', 'painel.ver', () => import('./telas/visao.js')],
    ['clientes', 'Clientes', 'pessoas', 'clientes.ver', () => import('./telas/clientes.js')],
    ['boletos', 'Boletos', 'boleto', 'boletos.ver', () => import('./telas/boletos.js')],
    ['repasses', 'Repasses', 'troca', 'repasses.ver', () => import('./telas/repasses.js')],
    ['conciliacao', 'Conciliação', 'cofre', 'conciliacao.ver', () => import('./telas/conciliacao.js')],
  ]],
  ['Gestão', [
    ['relatorios', 'Relatórios', 'relatorio', 'relatorios.ver', () => import('./telas/relatorios.js')],
    ['contas', 'Contas e preços', 'banco', 'precos.ver', () => import('./telas/contas.js')],
    ['integracoes', 'Integrações', 'plugue', 'integracoes.ver', () => import('./telas/integracoes.js')],
    ['conformidade', 'Conformidade', 'balanca', 'conformidade.ver', () => import('./telas/conformidade.js')],
    // PLD: só o administrador ('*'), por sigilo de lei. pld.ver serve para um perfil de compliance futuro.
    ['pld', 'PLD', 'busca', ['pld.ver', '*'], () => import('./telas/pld.js')],
    ['lgpd', 'LGPD', 'olho', ['lgpd.ver', '*'], () => import('./telas/lgpd.js')],
    ['admin', 'Segurança e usuários', 'escudo', 'auditoria.ver', () => import('./telas/admin.js')],
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
  return { rota: partes[0] || 'visao', params: partes.slice(1), query: Object.fromEntries(new URLSearchParams(busca)) };
};

async function desenhar() {
  for (const f of limpeza) { try { f(); } catch { /* ignora */ } }
  limpeza = [];
  for (const m of document.querySelectorAll('.modal-fundo')) m.remove();
  if (!api.sessao.get()?.token) return telaEntrada();
  if (usuario()?.senha_provisoria) return trocarSenhaObrigatoria();
  // Com a exigência ligada, não se trabalha sem a segunda etapa configurada.
  if (api.sessao.get()?.configurar_2fa && !usuario()?.totp_ativo) return configurarDoisFatoresObrigatorio();

  let { rota, params, query } = rotaAtual();
  if (!ROTAS[rota] || !permitido(ROTAS[rota].perm)) {
    const primeira = Object.entries(ROTAS).find(([, x]) => permitido(x.perm))?.[0];
    if (!primeira) return limpar(raiz, el('p', { class: 'vazio' }, 'Seu perfil não tem acesso a nenhuma tela.'));
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
    el('a', { class: 'marca', href: '#/visao' }, marcaMenu('PAGAMENTOS')),
    el('div', { class: 'contexto' }, el('span', { class: 'logo' }, 'BO'),
      el('div', {}, el('strong', {}, 'Backoffice'), el('small', {}, u.perfil_nome))),
  );
  for (const [grupo, itens] of MENU) {
    const vis = itens.filter(([, , , perm]) => permitido(perm));
    if (!vis.length) continue;
    menu.append(el('div', { class: 'grupo-menu' }, grupo), el('nav', { 'aria-label': grupo }, vis.map(([r, rot, ic]) =>
      el('a', { class: `link-menu${r === rota ? ' ativo' : ''}`, href: `#/${r}`, 'aria-current': r === rota ? 'page' : null, onclick: () => alternar(false) }, icone(ic), rot))));
  }
  menu.append(el('div', { class: 'menu-rodape' },
    el('button', { class: 'perfil', onclick: menuConta }, el('span', { class: 'avatar' }, iniciais(u.nome)),
      el('div', {}, el('strong', {}, u.nome), el('small', {}, u.email)))));

  const topo = el('header', { class: 'topo' },
    el('button', { class: 'botao-icone abrir-menu', 'aria-label': 'Abrir menu', 'aria-controls': 'menu', onclick: () => alternar(!menu.classList.contains('aberto')) }, icone('menu')),
    el('div', { class: 'caminho' }, el('span', {}, 'PAY AX'), el('span', { class: 'sep' }, '/'), el('strong', {}, ROTAS[rota]?.rotulo ?? '')),
    el('div', { class: 'topo-acoes' },
      pode('boletos.emitir') ? el('a', { class: 'botao', href: '#/boletos?novo=1' }, icone('mais'), 'Emitir boleto') : null));
  return el('div', { class: 'app' }, el('a', { class: 'sr', href: '#conteudo' }, 'Ir para o conteúdo'), menu, fundo,
    el('div', { class: 'principal' }, topo, principal));
}

function menuConta() {
  const u = usuario();
  const m = modal({
    titulo: 'Minha conta',
    corpo: [
      el('div', { class: 'pares' },
        el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Nome'), el('span', { class: 'val' }, u.nome)),
        el('div', { class: 'par' }, el('span', { class: 'rot' }, 'E-mail'), el('span', { class: 'val' }, u.email)),
        el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Perfil'), el('span', { class: 'val' }, u.perfil_nome))),
      el('hr', { style: 'border:0;border-top:1px solid var(--borda)' }),
      el('h3', { style: 'font-size:14px;margin-bottom:8px' }, 'Autenticação em duas etapas'),
      blocoDoisFatores(api, {
        ativo: Boolean(u.totp_ativo),
        exigido: Boolean(api.sessao.get()?.configurar_2fa) || Boolean(u.totp_ativo && api.sessao.get()?.exige_2fa),
        aoMudar: (ativo) => {
          const sess = api.sessao.get();
          api.sessao.set({ ...sess, usuario: { ...sess.usuario, totp_ativo: ativo }, configurar_2fa: false });
        },
      }),
      el('hr', { style: 'border:0;border-top:1px solid var(--borda)' }),
      formularioSenha(() => m.fechar()),
    ],
    acoes: [el('button', { class: 'botao sec', onclick: () => { api.sessao.limpar(); location.hash = ''; window.dispatchEvent(new CustomEvent('payax:sair')); } }, icone('sair'), 'Sair da conta')],
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

/** Moldura das telas de acesso desta área (arte da marca à esquerda, formulário à direita). */
const acessoBase = {
  area: 'BACKOFFICE',
  restrito: 'Acesso restrito à equipe PAY AX',
  ajuda: 'Problemas para entrar? Fale com o administrador do sistema PAY AX: ele pode conferir o seu acesso, gerar uma senha provisória ou redefinir a verificação em duas etapas.',
  privacidade: 'Privacidade',
};
const telaDeAcesso = (titulo, subtitulo, conteudo) => limpar(raiz, telaAcesso({ ...acessoBase, titulo, subtitulo, conteudo }));

function trocarSenhaObrigatoria() {
  telaDeAcesso('Defina uma senha', 'O seu acesso está com senha provisória. Escolha uma senha antes de continuar.', [formularioSenha(() => desenhar())]);
}

/** Tela de configuração obrigatória, quando o administrador exige 2FA da equipe. */
function configurarDoisFatoresObrigatorio() {
  telaDeAcesso('Proteja o seu acesso', null, [blocoDoisFatores(api, {
      ativo: false,
      exigido: true,
      aoMudar: () => {
        const sess = api.sessao.get();
        api.sessao.set({ ...sess, usuario: { ...sess.usuario, totp_ativo: true }, configurar_2fa: false });
        desenhar();
      },
    }),
    el('button', { class: 'botao sutil', onclick: () => { api.sessao.limpar(); desenhar(); } }, icone('sair'), 'Sair')]);
}

/** Segunda etapa do login. */
function telaDesafio(desafio) {
  telaDeAcesso('Verificação em duas etapas', null, [formularioDesafio(api, {
      desafio,
      aoEntrar: (d) => { api.sessao.set(d); location.hash = '#/visao'; desenhar(); },
      aoVoltar: () => telaEntrada(),
    })]);
}

function telaEntrada() {
  const form = formularioEntrada({
    placeholderEmail: 'Seu e-mail corporativo',
    esqueci: 'Peça ao administrador do sistema para gerar uma senha provisória (Segurança e usuários → Usuários). Você troca por uma sua no primeiro acesso.',
    entrar: async (dados) => {
      const d = await api.post('/auth/login', dados);
      if (d.precisa_2fa) return telaDesafio(d.desafio);
      api.sessao.set(d);
      location.hash = '#/visao';
      return desenhar();
    },
  });
  telaDeAcesso('Bem-vindo', 'Acesse sua operação PAY AX.', form);
}

desenhar();
