import { api, sessao } from './api.js';
import { el, $, limpar, icone, marca, iniciais, toast, acao, lerForm, campo, marcar, formModal, modal, repetir, linkWhatsApp, PERFIS } from './ui.js';
import { TELAS_EQUIPE } from './painel.js';
import { carregarEmpresas } from './comum.js';
import { TELAS_ANUNCIANTE, TELAS_LOJISTA } from './portais.js';

const raiz = $('#app');
let pararTela = null;
let pararSaude = null;
let empresasCarregadas = false;
let nomePlataforma = 'Vai Mídia';
let slogan = 'Sua marca em movimento.';
// WhatsApp da empresa: vira o botão "Falar com a equipe" nos portais do anunciante e do ponto.
let whatsappEquipe = '';

// [rota, rótulo, ícone, perfis que veem (vazio = todos do grupo), submenus [rota, rótulo, perfis?]]
const MENUS = {
  // Na ordem do trabalho: cada etapa tem um título, e dentro dela os itens seguem a sequência em que
  // se faz (primeiro o anunciante, depois o criativo, depois a campanha…). Itens que começam com "#" são títulos.
  equipe: [
    ['resumo', 'Visão geral', 'dashboard'],
    ['#anuncio', '1 · Cliente e anúncio'],
    ['anunciantes', 'Anunciantes e agências', 'anunciantes'], ['criativos', 'Criativos', 'midias'],
    ['campanhas', 'Campanhas', 'campanhas'], ['programacao', 'Programação', 'grade'],
    ['#telas', '2 · Telas'],
    // Comunicado é recado do próprio ponto: fica dentro de Pontos.
    ['grupo-pontos', 'Pontos', 'pontos', null, [['pontos', 'Pontos'], ['comunicados', 'Comunicados']]],
    ['telas', 'TVs', 'telas'],
    ['#vendas', '3 · Vendas'],
    ['crm', 'CRM', 'anunciantes', null, [
      ['funil', 'Funil'], ['propostas', 'Propostas'], ['produtos', 'Produtos', ['master']], ['emails', 'E-mail'],
    ]],
    ['inventario', 'Inventário', 'ocupacao'],
    ['#acompanhar', '4 · Acompanhar'],
    ['relatorios', 'Relatórios', 'relatorios'],
    ['financeiro', 'Financeiro', 'faturamento', null, [
      ['caixa', 'Fluxo de caixa'], ['receber', 'Contas a receber'], ['pagar', 'Contas a pagar'], ['faturamento', 'Faturamento'],
    ]],
    ['diagnostico', 'Diagnóstico', 'diagnostico'],
    ['#admin', 'Administração'],
    ['empresas', 'Empresas', 'pontos', ['master']],
    ['usuarios', 'Usuários', 'usuarios', ['master', 'administrador']], ['configuracoes', 'Configurações', 'configuracoes', ['master']],
    ['historico', 'Histórico', 'historico'],
  ],
  anunciante: [
    ['resumo', 'Minhas campanhas', 'dashboard'], ['campanhas', 'Campanhas', 'campanhas'], ['criativos', 'Meus criativos', 'midias'],
    ['prova', 'Prova de exibição', 'relatorios'], ['faturas', 'Faturas', 'faturamento'], ['rede', 'Onde meus anúncios passam', 'rede'],
  ],
  lojista: [
    ['resumo', 'Minhas TVs', 'telas'], ['comunicados', 'Comunicados', 'aprovacoes'], ['conteudo', 'Conteúdo próprio', 'midias'],
    ['repasses', 'Meu repasse', 'dinheiro'], ['relatorios', 'Exibições', 'relatorios'],
  ],
};

const SUBTITULOS = {
  resumo: 'O que está acontecendo na rede agora', telas: 'Aparelhos instalados, estado e programação de cada um',
  pontos: 'Condomínios, prédios, comércios, academias e clínicas onde as TVs estão instaladas',
  comunicados: 'Recados do próprio ponto que entram entre os anúncios',
  anunciantes: 'Quem paga pela publicidade e as agências que compram a mídia',
  inventario: 'O que a rede tem para vender: circuitos, pontos, telas e audiência', campanhas: 'O que vai ao ar, onde, quando e por quanto',
  criativos: 'Imagens e vídeos que vão para as telas', programacao: 'Como fica o loop de cada TV e quanto ainda cabe de publicidade',
  relatorios: 'Inserções, impactos e a prova de exibição', faturamento: 'Fechamento do mês e faturas dos anunciantes',
  repasses: 'Comissão dos lojistas sobre a receita das telas', diagnostico: 'Verificações da rede e das TVs',
  usuarios: 'Quem acessa o painel e os portais',
  empresas: 'As empresas que usam o sistema, cada uma com os próprios dados', configuracoes: 'Empresa, TVs e sistema',
  produtos: 'A tabela de preços da rede: o ponto de partida das propostas e do faturamento',
  receber: 'Faturas dos anunciantes: o que entra, o que está vencendo e o que atrasou',
  pagar: 'Repasses aos pontos e despesas da operação: o que sai',
  funil: 'O funil: com quem estamos falando, o que ficou combinado e o que virou contrato',
  propostas: 'O papel que sai do funil e volta como contrato',
  emails: 'A conversa por e-mail com quem está no funil, do lado de dentro do sistema',
  historico: 'Registro de quem fez o quê', prova: 'Cada vez que seu anúncio foi ao ar', faturas: 'Seu contrato, as faturas e o PIX para pagamento',
  rede: 'Pontos e telas onde a publicidade pode passar', conteudo: 'Imagens e vídeos do seu ponto na TV', conta: 'Sua conta',
};

const grupo = (perfil) => (['master', 'administrador', 'operador'].includes(perfil) ? 'equipe' : perfil);

window.addEventListener('midia:sair', () => desenhar());
window.addEventListener('hashchange', () => desenhar());
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-usuario, .usuario')) document.querySelector('.menu-usuario')?.classList.add('oculto'); });

const rota = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
const ir = (tela) => { location.hash = `#/${tela}`; };

async function desenhar() {
  pararTela?.();
  pararTela = null;
  // Link de nova senha, vindo do e-mail: vale mesmo sem sessão.
  const [primeiro, codigo] = rota();
  if (primeiro === 'nova-senha' && codigo) { pararSaude?.(); pararSaude = null; return telaNovaSenha(codigo); }
  const s = sessao.get();
  if (!s?.token) { pararSaude?.(); pararSaude = null; return telaEntrada(); }
  const u = s.usuario;
  const g = grupo(u.perfil);
  const menu = MENUS[g];
  const telas = { equipe: TELAS_EQUIPE, anunciante: TELAS_ANUNCIANTE, lojista: TELAS_LOJISTA }[g];
  const [nome, ...resto] = rota();
  const pode = (perfis) => !perfis || perfis.includes(u.perfil);
  const item = menu.find(([k, , , perfis, subs]) => (k === nome || subs?.some(([sk, , ps]) => sk === nome && pode(ps))) && pode(perfis));
  // Um grupo (só submenus) leva para a primeira tela dele.
  if (item?.[4] && item[0] === nome && item[4][0][0] !== nome) return ir(item[4][0][0]);
  if (!item || !telas[nome]) return ir(menu[0][4]?.[0][0] ?? menu[0][0]);

  const conteudo = el('main', { class: 'conteudo' });
  let recolhida = false;
  try { recolhida = localStorage.getItem('midia.menu') === 'recolhido'; } catch { /* padrão */ }
  const casca = el('div', { class: `casca${recolhida ? ' recolhida' : ''}` });

  const visiveis = menu.filter(([, , , perfis]) => !perfis || perfis.includes(u.perfil))
    // Título de etapa só aparece se tiver algum item visível embaixo dele.
    .filter(([k], i, l) => !k.startsWith('#') || (l[i + 1] && !l[i + 1][0].startsWith('#')));
  const itens = visiveis.map(([k, rotulo, ic, , subs]) => {
    if (k.startsWith('#')) return el('div', { class: 'secao-menu' }, rotulo);
    const aberto = k === nome || subs?.some(([sk]) => sk === nome);
    const link = el('a', { class: `item${aberto ? ' on' : ''}`, href: `#/${subs ? subs[0][0] : k}`, title: rotulo }, icone(ic), el('span', { class: 'rotulo' }, rotulo));
    if (!subs) return link;
    // Na lateral do computador, o submenu do grupo aberto aparece embaixo dele. No menu do celular, todos
    // começam fechados: tocar no grupo abre (ou fecha) o submenu ali mesmo, sem trocar de tela.
    const sub = el('div', { class: `grupo-sub${aberto ? '' : ' fechado'}` },
      subs.filter(([, , ps]) => pode(ps)).map(([sk, sr]) => el('a', { class: `sub${sk === nome ? ' on' : ''}`, href: `#/${sk}` }, sr)));
    link.classList.add('grupo');
    link.append(el('span', { class: 'seta-grupo' }, icone('abaixo')));
    link.addEventListener('click', (e) => {
      if (!lateral.classList.contains('aberta')) return;
      e.preventDefault();
      link.classList.toggle('expandido');
    });
    return [link, sub];
  });

  // No celular a lateral vira uma barra com a marca e o botão Menu, que abre a lista inteira (com os submenus).
  const botaoMenu = el('button', { class: 'abrir-menu', type: 'button', 'aria-expanded': 'false', onclick: () => {
    const aberta = lateral.classList.toggle('aberta');
    botaoMenu.setAttribute('aria-expanded', String(aberta));
    limpar(botaoMenu, icone(aberta ? 'fechar' : 'menu'), el('span', {}, aberta ? 'Fechar' : 'Menu'));
    document.documentElement.classList.toggle('menu-aberto', aberta);
  } }, icone('menu'), el('span', {}, 'Menu'));
  document.documentElement.classList.remove('menu-aberto');
  const lateral = el('nav', { class: 'lateral', 'aria-label': 'Menu' },
    el('div', { class: 'topo-lateral' }, marca(nomePlataforma), el('button', { class: 'recolher', title: 'Recolher menu', onclick: () => {
      casca.classList.toggle('recolhida');
      try { localStorage.setItem('midia.menu', casca.classList.contains('recolhida') ? 'recolhido' : 'aberto'); } catch { /* ignora */ }
    } }, icone('seta')), botaoMenu),
    itens,
    // Quem está no portal não tem com quem falar dentro do sistema: este botão resolve isso.
    whatsappEquipe && grupo(u.perfil) !== 'equipe'
      ? el('a', {
        class: 'falar-equipe', target: '_blank', rel: 'noopener',
        href: linkWhatsApp(whatsappEquipe, `Olá! Sou ${u.anunciante_nome ?? u.local_nome ?? u.nome} e queria falar com a equipe.`),
      }, icone('enviar'), el('span', { class: 'rotulo' }, 'Falar com a equipe'))
      : null);

  const subtitulo = SUBTITULOS[nome] ? el('p', { class: 'subtitulo' }, SUBTITULOS[nome]) : null;
  const vinculo = u.anunciante_nome ?? u.local_nome ?? u.empresa_nome ?? null;
  // Dentro de um grupo, o título é o da tela e a trilha mostra de onde ela vem.
  const dentroDeGrupo = item[4] && item[0] !== nome;
  const tituloTela = dentroDeGrupo ? item[4].find(([sk]) => sk === nome)[1] : item[1];
  const topo = el('header', { class: 'topo' },
    el('div', {},
      dentroDeGrupo ? el('div', { class: 'trilha' }, item[1]) : (vinculo ? el('div', { class: 'trilha' }, vinculo) : null),
      el('h1', { style: 'margin:0' }, tituloTela), subtitulo),
    ferramentas(u));
  // Véu atrás da gaveta do menu no celular: tocar fora fecha.
  const veu = el('div', { class: 'veu-menu', onclick: () => botaoMenu.click() });
  casca.append(lateral, veu, el('div', { class: 'principal' }, topo, conteudo));
  // A tela inteira é redesenhada a cada troca. Sem guardar onde o menu estava, ele volta para o
  // começo e quem tem muitos itens perde a referência do que acabou de clicar.
  const rolagemMenu = $('.lateral')?.scrollTop ?? 0;
  limpar(raiz, casca);
  lateral.scrollTop = rolagemMenu;
  // Se o item aberto ficou fora da vista (menu longo, tela baixa), ele é trazido para o meio.
  const ativo = lateral.querySelector('a.item.on');
  if (ativo && (ativo.offsetTop < lateral.scrollTop || ativo.offsetTop + ativo.offsetHeight > lateral.scrollTop + lateral.clientHeight)) {
    lateral.scrollTop = Math.max(0, ativo.offsetTop - lateral.clientHeight / 2);
  }
  // E a tela nova começa do alto, não no meio da rolagem da tela anterior.
  window.scrollTo({ top: 0 });
  document.title = `${tituloTela} · ${nomePlataforma}`;

  // O master escolhe a empresa dos cadastros novos: a lista vem uma vez por sessão.
  if (u.perfil === 'master' && !empresasCarregadas) { empresasCarregadas = true; await carregarEmpresas(); }
  const ctx = {
    usuario: u,
    conteudo,
    master: u.perfil === 'master',
    equipe: g === 'equipe',
    parametros: resto,
    parar: (fn) => { pararTela = fn; },
    ir,
  };
  try {
    await telas[nome](ctx);
  } catch (err) {
    limpar(conteudo, el('p', { class: 'aviso erro' }, err.message));
  }
}

function ferramentas(u) {
  const tema = document.documentElement.dataset.tema || 'claro';
  const trocar = (t) => {
    document.documentElement.dataset.tema = t;
    try { localStorage.setItem('midia.tema', t); } catch { /* ignora */ }
    for (const b of document.querySelectorAll('[data-tema-btn]')) b.classList.toggle('on', b.dataset.temaBtn === t);
  };
  const menu = el('div', { class: 'menu-usuario oculto' },
    el('div', { class: 'quem' }, el('strong', {}, u.nome), el('div', { class: 'pequeno mudo' }, u.email), el('div', { class: 'pequeno mudo' }, PERFIS[u.perfil])),
    // No celular os botões de tema saem do topo (não cabem ao lado do título) e ficam aqui.
    el('button', { class: 'so-celular', onclick: () => { menu.classList.add('oculto'); trocar(document.documentElement.dataset.tema === 'escuro' ? 'claro' : 'escuro'); } },
      tema === 'escuro' ? 'Usar tema claro' : 'Usar tema escuro'),
    el('button', { onclick: () => { menu.classList.add('oculto'); alterarSenha(); } }, 'Alterar senha'),
    el('button', { onclick: () => { menu.classList.add('oculto'); duasEtapas(); } }, 'Verificação em duas etapas'),
    el('button', { onclick: () => { sessao.limpar(); location.hash = ''; desenhar(); } }, 'Sair'));
  const status = el('span', { class: 'status-sistema', title: 'Conexão com o servidor' }, 'Sistema Online');
  pararSaude?.();
  pararSaude = repetir(async () => {
    try {
      await api.get('/saude');
      status.className = 'status-sistema';
      status.textContent = 'Sistema Online';
    } catch {
      status.className = 'status-sistema erro';
      status.textContent = 'Sem conexão';
    }
  }, 30_000);
  return el('div', { class: 'ferramentas' }, status,
    el('button', { class: tema === 'claro' ? 'on' : '', title: 'Tema claro', dataset: { temaBtn: 'claro' }, onclick: () => trocar('claro') }, icone('sol')),
    el('button', { class: tema === 'escuro' ? 'on' : '', title: 'Tema escuro', dataset: { temaBtn: 'escuro' }, onclick: () => trocar('escuro') }, icone('lua')),
    el('button', { class: 'usuario', title: u.nome, onclick: () => menu.classList.toggle('oculto') },
      el('span', { class: 'avatar' }, iniciais(u.nome)), el('span', { class: 'nome' }, u.nome), icone('abaixo')),
    menu);
}

/**
 * Verificação em duas etapas: além da senha, um código de 6 números do aplicativo autenticador do
 * celular. Quem roubar só a senha não entra.
 */
async function duasEtapas() {
  const eu = (await api.get('/auth/me')).usuario;
  if (eu.duas_etapas) {
    return formModal('Verificação em duas etapas', () => [
      el('p', { class: 'aviso ok' }, 'Está ligada: para entrar, o sistema pede a senha e o código do aplicativo.'),
      campo('Para desligar, digite sua senha', { name: 'senha', type: 'password', required: true, autocomplete: 'current-password' }),
    ], async (d) => { await api.post('/auth/duas-etapas/desligar', d); toast('Verificação em duas etapas desligada.'); }, { rotulo: 'Desligar' });
  }
  const inicio = await api.post('/auth/duas-etapas/iniciar');
  let reserva = null;
  await formModal('Ligar a verificação em duas etapas', () => [
    el('p', { class: 'mudo' }, '1. Instale um aplicativo autenticador no celular (Google Authenticator, Microsoft Authenticator ou Authy).'),
    el('p', { class: 'mudo' }, '2. No aplicativo, adicione uma conta lendo este código — ou digitando a chave abaixo.'),
    el('div', { style: 'text-align:center' }, el('img', { src: inicio.qr, alt: 'Código para o aplicativo', width: 200, height: 200, style: 'border-radius:12px;background:#fff;padding:6px' })),
    el('div', { style: 'display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap' },
      el('code', { style: 'word-break:break-all' }, inicio.segredo),
      el('button', { type: 'button', class: 'btn pequeno', onclick: () => { navigator.clipboard?.writeText(inicio.segredo); toast('Chave copiada.'); } }, 'Copiar chave')),
    campo('3. Digite o código de 6 números que o aplicativo mostra', { name: 'codigo', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 7, placeholder: '000000' }),
  ], async (d) => { reserva = (await api.post('/auth/duas-etapas/ativar', d)).codigos_reserva; }, { rotulo: 'Ligar' });
  if (!reserva) return;
  await modal('Guarde estes códigos de reserva', (fechar) => [
    el('p', { class: 'aviso' }, 'Se perder o celular, cada código abaixo entra no lugar do código do aplicativo, uma vez só. Anote ou tire um print e guarde em lugar seguro. Eles não aparecem de novo.'),
    el('pre', { style: 'font-size:16px;line-height:1.7;text-align:center;margin:0' }, reserva.join('\n')),
    el('div', { class: 'acoes' },
      el('button', { type: 'button', class: 'btn', onclick: () => { navigator.clipboard?.writeText(reserva.join('\n')); toast('Códigos copiados.'); } }, 'Copiar'),
      el('button', { type: 'button', class: 'btn primario', onclick: () => fechar() }, 'Já guardei')),
  ]);
  toast('Verificação em duas etapas ligada.');
}

function alterarSenha() {
  formModal('Alterar senha', () => [
    campo('Senha atual', { name: 'atual', type: 'password', required: true, autocomplete: 'current-password' }),
    campo('Nova senha (mínimo 10 caracteres)', { name: 'nova', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }),
  ], async (d) => {
    const r = await api.post('/auth/senha', d);
    if (r?.token) sessao.trocarToken(r.token);
    toast('Senha alterada. Os outros aparelhos foram desconectados.');
  });
}

/**
 * A casca das telas de entrada: a fotografia da rede ocupando a janela e o cartão de vidro por cima.
 * Vale para o login e para a criação de senha nova, para as duas serem a mesma casa.
 */
function cascaDeEntrada(...dentro) {
  return el('div', { class: 'entrada' },
    el('div', { class: 'cartao' },
      marca(nomePlataforma),
      ...dentro.flat(Infinity).filter(Boolean)),
    slogan ? el('p', { class: 'assinatura' }, slogan) : null);
}

/** O olho que mostra a senha digitada: evita a terceira tentativa errada por causa do teclado. */
function campoSenha(rotulo, attrs) {
  const entrada = el('input', { type: 'password', ...attrs });
  const botao = el('button', {
    type: 'button', class: 'ver-senha', 'aria-pressed': 'false', 'aria-label': 'Mostrar senha', title: 'Mostrar senha',
    onclick: () => {
      const mostrando = entrada.type === 'text';
      entrada.type = mostrando ? 'password' : 'text';
      botao.setAttribute('aria-pressed', String(!mostrando));
      botao.setAttribute('aria-label', mostrando ? 'Mostrar senha' : 'Esconder senha');
      entrada.focus();
    },
  }, el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    el('path', { d: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z' }),
    el('circle', { cx: '12', cy: '12', r: '3' }),
    el('path', { class: 'corte', d: 'm4 4 16 16' })));
  return el('label', { class: 'campo senha-campo' }, rotulo, entrada, botao);
}

function telaEntrada() {
  const lembradoAntes = Boolean(sessao.emailLembrado());
  const f = el('form', { class: 'form' },
    campo('E-mail', {
      name: 'email', type: 'email', autocomplete: 'username', required: true,
      placeholder: 'seuemail@empresa.com.br', value: sessao.emailLembrado(),
    }),
    campoSenha('Senha', { name: 'senha', autocomplete: 'current-password', required: true, placeholder: '••••••' }),
    el('label', { class: 'campo', id: 'campo-codigo', hidden: true }, el('span', {}, 'Código do aplicativo autenticador'),
      el('input', { name: 'codigo', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, placeholder: '000000' })),
    el('div', { class: 'opcoes' },
      marcar('Lembrar de mim', { name: 'lembrar', checked: lembradoAntes }),
      el('button', { type: 'button', class: 'link-texto', onclick: esqueciSenha }, 'Esqueci minha senha')),
    el('button', { class: 'btn primario' }, 'Entrar'));

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button.primario'), async () => {
      const d = lerForm(f);
      const r = await api.post('/auth/login', { email: d.email, senha: d.senha, codigo: d.codigo || undefined });
      // A conta tem verificação em duas etapas: mostra o campo do código e espera a pessoa digitar.
      if (r.precisa_codigo) {
        const c = f.querySelector('#campo-codigo');
        c.hidden = false;
        c.querySelector('input').focus();
        toast('Digite o código do aplicativo autenticador (ou um código de reserva).');
        return;
      }
      // Marcou "lembrar": a sessão sobrevive a fechar o navegador e o e-mail volta preenchido.
      sessao.set(r, { lembrar: d.lembrar });
      sessao.lembrarEmail(d.lembrar ? d.email : '');
      // Quem chegou por um endereço que já aponta para uma tela (ex.: mail.dominio → E-mail) cai nela depois de entrar.
      if (rota()[0] !== 'emails') location.hash = '';
      desenhar();
    });
  });

  limpar(raiz, cascaDeEntrada(
    el('h1', {}, 'Bem-vindo'),
    el('p', { class: 'abertura' }, 'Acesse sua conta.'),
    f));
  f.querySelector('input').focus();
}

/** Pede o link de nova senha (a resposta é a mesma exista ou não a conta). */
const esqueciSenha = () => formModal('Esqueci minha senha', () => [
  el('p', { class: 'mudo', style: 'margin:0' }, 'Informe o e-mail da sua conta. Se existir, chega um link para criar uma senha nova.'),
  campo('E-mail', { name: 'email', type: 'email', required: true, autocomplete: 'username' }),
], async (d) => {
  const r = await api.post('/auth/recuperar', d);
  toast(r.aviso);
}, { rotulo: 'Enviar o link' });

/** Tela aberta pelo link do e-mail. */
function telaNovaSenha(codigo) {
  const f = el('form', { class: 'form' },
    campoSenha('Nova senha (mínimo 10 caracteres)', { name: 'senha', required: true, minlength: 10, autocomplete: 'new-password' }),
    campoSenha('Repita a nova senha', { name: 'repetir', required: true, minlength: 10, autocomplete: 'new-password' }),
    el('button', { class: 'btn primario' }, 'Salvar e entrar'));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(f.querySelector('button'), async () => {
      const d = lerForm(f);
      if (d.senha !== d.repetir) throw new Error('As duas senhas precisam ser iguais.');
      const r = await api.post('/auth/nova-senha', { codigo, senha: d.senha });
      const entrada = await api.post('/auth/login', { email: r.email, senha: d.senha });
      sessao.set(entrada);
      location.hash = '';
      toast('Senha trocada.');
      desenhar();
    });
  });
  limpar(raiz, cascaDeEntrada(
    el('h1', {}, 'Nova senha'),
    el('p', { class: 'abertura' }, 'O link do e-mail vale por uma hora e só funciona uma vez.'), f));
  f.querySelector('input').focus();
}

api.get('/publico').then((p) => {
  nomePlataforma = p.nome || 'Vai Mídia';
  slogan = p.slogan ?? '';
  whatsappEquipe = p.whatsapp ?? '';
}).catch(() => {}).finally(desenhar);
