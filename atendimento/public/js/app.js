import { api, sessao } from './api.js';
import { el, $, limpar, icone, marca, iniciais, toast, acao, campo, formModal, repetir, PERFIS, pl } from './ui.js';
import { TELAS_MASTER } from './master.js';
import { iniciarTelefone, pararTelefone } from './telefone.js';
import { TELAS_EMPRESA } from './empresa.js';
import { vigiarLigacoes } from './passagem.js';

const raiz = $('#app');
let pararTela = null;
let nomePlataforma = 'ZOE Atende';
const nomesEmpresa = new Map();

const PLATAFORMA = ['master', 'suporte'];

/** O que esta pessoa pode. Vem do servidor no login; o master tem tudo. */
const pode = (u, permissao) => u?.perfil === 'master' || (u?.permissoes ?? []).includes(permissao);

/** Pessoa sem nenhuma tela liberada: melhor dizer isso do que piscar entre telas vazias. */
const semAcesso = (u) => el('div', { class: 'entrada' },
  el('div', { class: 'cartao', style: 'max-width:420px;text-align:center' },
    el('h2', {}, 'Sem acesso a nenhuma tela'),
    el('p', { class: 'mudo' }, `${u.nome}, seu usuário existe mas não tem permissão para abrir nada ainda. `
      + 'Peça a quem administra a empresa para liberar o que você precisa em Usuários.'),
    el('button', { class: 'btn', onclick: () => { sessao.limpar(); location.hash = ''; location.reload(); } }, 'Sair')));

// [rota, rótulo, ícone, permissão exigida (vazio = qualquer pessoa autenticada)]
const MENU_MASTER = [
  ['dashboard', 'Dashboard', 'dashboard'], ['empresas', 'Empresas', 'empresas'], ['telefonia', 'Telefonia', 'telefone'], ['relatorios', 'Relatórios', 'relatorios'],
  ['usuarios', 'Usuários', 'equipe', ['master']], ['seguranca', 'Segurança', 'seguranca', ['master']],
  ['diagnostico', 'Diagnóstico', 'diagnostico'], ['configuracoes', 'Configurações', 'configuracoes', ['master']],
];
// Cada item do menu da empresa pede uma permissão. Quem não tem, não vê — e, mais importante,
// a rota correspondente também recusa no servidor. Esconder o menu nunca foi permissão.
const MENU_EMPRESA = [
  ['caixa', 'Atendimentos', 'caixa', 'atendimentos.ver'],
  ['dashboard', 'Dashboard', 'dashboard', 'atendimentos.ver'],
  // Painel da supervisão: o atendimento acontecendo agora, para acompanhar (e para a TV da sala).
  ['aovivo', 'Ao vivo', 'tv', 'relatorios.ver'],
  ['ia', 'ZOE', 'ia', 'zoe.ver'],
  ['ouvidoria', 'Ouvidoria', 'alerta', 'ouvidoria.ver'],
  ['contatos', 'Contatos', 'contatos', 'cliente.ver'],
  ['chamados', 'Chamados', 'chamados', 'chamados.ver'],
  ['custos', 'Centro de Custo', 'dinheiro', 'custos.ver'],
  ['filas', 'Filas', 'filas', 'filas.ver'],
  // Só aparece com a telefonia ligada para a empresa (o master liga).
  ['telefonia', 'Telefonia', 'telefone', 'telefonia.ver'],
  ['equipe', 'Usuários', 'equipe', 'usuarios.ver'],
  ['relatorios', 'Relatórios', 'relatorios', 'relatorios.ver'],
  ['configuracoes', 'Configurações', 'configuracoes', 'configuracoes.ver'],
  ['integracoes', 'Integrações', 'integracoes', 'integracoes.ver'],
];

// O master vê a plataforma inteira: os subtítulos dele falam disso, não da empresa.
const SUBTITULOS_MASTER = {
  dashboard: 'A plataforma agora e no mês, em todas as empresas',
  empresas: 'Empresas clientes da plataforma',
  telefonia: 'Telefonia por empresa, operadoras, números e faturamento',
  relatorios: 'Resolução da ZOE e da equipe em todas as empresas',
  usuarios: 'Quem acessa a plataforma e com qual perfil',
  seguranca: 'Acessos recusados, IPs bloqueados e o registro de atividades',
  diagnostico: 'Verificações da plataforma e a conexão de cada número com a Meta',
  configuracoes: 'Nome da plataforma, atendimento e preços de IA e da Meta',
};
const SUBTITULOS = {
  caixa: 'A ZOE resolve o que dá; aqui fica o que precisa de gente',
  dashboard: 'Como está o atendimento agora e no mês',
  aovivo: 'Filas, equipe e telefone em tempo real',
  ia: 'O que ela sabe, o que ela faz e quando ela chama a equipe',
  ouvidoria: 'Reclamação, cancelamento, Procon e Anatel — com protocolo, prazo e desfecho',
  contatos: 'Quem já falou com a sua empresa pelo WhatsApp',
  chamados: 'Pedidos registrados que não tinham solução na hora',
  custos: 'A conta da Meta, o orçamento do mês e o que você deixou de gastar',
  filas: 'Os departamentos que recebem o que a ZOE não resolve',
  equipe: 'Quem atende, com qual perfil e quantas conversas ao mesmo tempo',
  relatorios: 'Quanto a ZOE resolve e onde a equipe é necessária',
  configuracoes: 'Número de WhatsApp, respostas rápidas e etiquetas',
  integracoes: 'Chaves de API para o seu sistema conversar com a plataforma',
  empresas: 'Empresas clientes da plataforma',
  usuarios: 'Quem acessa a plataforma e com qual perfil',
  seguranca: 'Acessos recusados, IPs bloqueados e o registro de atividades',
  telefonia: 'Ramais, filas no telefone, URA, números e chamadas',
  diagnostico: 'Verificações da plataforma e a conexão de cada número com a Meta',
};

let pararSaude = null;
let telefoniaLigada = false;
// O aviso de ligação vive fora das telas: trocar de tela não pode perder uma ligação tocando.
let pararVigia = null;
let vigiaDe = null;
function vigiar(u, empresaId) {
  // Só quem atende pelo ramal: a equipe da plataforma visitando a empresa não recebe ligação.
  const chave = empresaId && !PLATAFORMA.includes(u.perfil) && pode(u, 'atendimentos.atender') ? `${u.id}:${empresaId}` : null;
  if (chave === vigiaDe) return;
  pararVigia?.();
  pararVigia = null;
  vigiaDe = chave;
  if (chave) {
    pararVigia = vigiarLigacoes(empresaId, {
      abrirConversa: (id) => { location.hash = `${link(empresaId, 'caixa')}?conversa=${id}`; },
    });
  }
}

window.addEventListener('atend:sair', () => desenhar());
window.addEventListener('hashchange', () => desenhar());
// Abas que rolam (celular): a escolhida desliza para o meio.
document.addEventListener('click', (e) => { e.target.closest?.('.abas .aba')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); });
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-usuario, .usuario')) document.querySelector('.menu-usuario')?.classList.add('oculto'); });

/** Rota atual: { empresaId, tela } a partir de #/tela ou #/empresa/ID/tela. */
function rota() {
  const partes = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  if (partes[0] === 'empresa' && /^\d+$/.test(partes[1] ?? '')) return { empresaId: Number(partes[1]), tela: partes[2] || 'caixa' };
  return { empresaId: null, tela: partes[0] || 'dashboard' };
}
const link = (empresaId, tela) => (empresaId ? `#/empresa/${empresaId}/${tela}` : `#/${tela}`);
const ir = (empresaId, tela) => { location.hash = link(empresaId, tela); };

async function desenhar() {
  pararTela?.();
  pararTela = null;
  const s = sessao.get();
  if (!s?.token) { pararSaude?.(); pararSaude = null; vigiar({}, null); pararTelefone(); return telaEntrada(); }
  const u = s.usuario;
  let { empresaId, tela } = rota();
  // Usuário de empresa fica sempre no painel da própria empresa.
  if (!PLATAFORMA.includes(u.perfil) && empresaId !== u.empresa_id) {
    history.replaceState(null, '', link(u.empresa_id, empresaId ? tela : 'caixa'));
    ({ empresaId, tela } = rota());
  }
  const menu = empresaId ? MENU_EMPRESA : MENU_MASTER;
  const telas = empresaId ? TELAS_EMPRESA : TELAS_MASTER;
  // A empresa (nome e o que está ligado para ela) vem antes do menu: a Telefonia só aparece ligada.
  let nomeEmpresa = null;
  if (empresaId) {
    let info = nomesEmpresa.get(empresaId);
    if (!info) {
      try {
        const e = await api.get(`/empresas/${empresaId}`);
        info = { nome: e.nome, telefonia: e.telefonia_ativa };
        nomesEmpresa.set(empresaId, info);
      } catch (err) {
        toast(err.message, true);
        return PLATAFORMA.includes(u.perfil) ? ir(null, 'empresas') : undefined;
      }
    }
    nomeEmpresa = info.nome;
    telefoniaLigada = Boolean(info.telefonia);
  }
  // O menu do master ainda é por perfil (a plataforma tem só dois); o da empresa, por permissão.
  const visivel = ([chave, , , exige]) => {
    if (chave === 'telefonia' && empresaId && !telefoniaLigada) return false;
    if (!exige) return true;
    return Array.isArray(exige) ? exige.includes(u.perfil) : pode(u, exige);
  };
  const item = menu.find((x) => x[0] === tela && visivel(x));
  const subtitulo = (empresaId ? SUBTITULOS : SUBTITULOS_MASTER)[tela];
  if (!item || !telas[tela]) {
    // Sem permissão para a tela pedida, abre a primeira que a pessoa pode ver — em vez de
    // mandá-la sempre para a caixa, que ela também pode não ter.
    const primeira = menu.find((x) => visivel(x) && telas[x[0]]);
    if (!primeira) return limpar(raiz, semAcesso(u));
    if (primeira[0] !== tela) return ir(empresaId, primeira[0]);
    return undefined;
  }

  vigiar(u, empresaId);
  // Telefone do navegador: para quem atende pela empresa com a telefonia ligada (o ramal vem de Usuários).
  if (empresaId && !PLATAFORMA.includes(u.perfil) && telefoniaLigada && pode(u, 'telefonia.softphone')) iniciarTelefone({ empresaId });
  else pararTelefone();
  const conteudo = el('main', { class: `conteudo${tela === 'caixa' ? ' cheio' : ''}` });
  let recolhida = false;
  try { recolhida = localStorage.getItem('atend.menu') === 'recolhido'; } catch { /* padrão */ }
  // `cheia`: a tela ocupa a altura da janela e rola por dentro (caixa de entrada), em vez de alongar a página.
  const casca = el('div', { class: `casca${recolhida ? ' recolhida' : ''}${tela === 'caixa' ? ' cheia' : ''}` });

  const itens = menu.filter(visivel).map(([k, rotulo, ic]) =>
    el('a', { class: `item${k === tela ? ' on' : ''}`, href: link(empresaId, k), title: rotulo }, icone(ic), el('span', { class: 'rotulo' }, rotulo)));

  const lateral = el('nav', { class: 'lateral', 'aria-label': 'Menu' },
    el('div', { class: 'topo-lateral' }, marca(nomePlataforma), el('button', { class: 'recolher', title: 'Recolher menu', onclick: () => {
      casca.classList.toggle('recolhida');
      try { localStorage.setItem('atend.menu', casca.classList.contains('recolhida') ? 'recolhido' : 'aberto'); } catch { /* ignora */ }
    } }, icone('seta'))),
    itens,
    empresaId && PLATAFORMA.includes(u.perfil) ? el('a', { class: 'item voltar', href: '#/empresas', title: 'Voltar ao master' }, icone('entrar'), el('span', { class: 'rotulo' }, 'Voltar ao master')) : null);

  const trilha = el('div', { class: 'trilha' });
  if (empresaId && PLATAFORMA.includes(u.perfil)) trilha.append(el('a', { href: '#/empresas' }, 'Empresas'), el('span', { class: 'sep' }, '/'), el('a', { href: link(empresaId, 'caixa') }, nomeEmpresa));

  // A ação principal da página (Nova fila, Novo usuário…) fica no topo, à direita do título.
  const acoesPagina = el('div', { class: 'acoes-pagina' });
  const topo = el('header', { class: 'topo' },
    el('div', {}, trilha, el('h1', { style: 'margin:0' }, item[1]), subtitulo ? el('p', { class: 'subtitulo' }, subtitulo) : null),
    acoesPagina, ferramentas(u, empresaId));
  casca.append(lateral, el('div', { class: 'principal' }, topo, conteudo));
  limpar(raiz, casca);
  // No celular o menu é uma faixa que rola: o item da tela aberta fica à vista.
  if (window.matchMedia?.('(max-width: 860px)').matches) lateral.querySelector('.item.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  document.title = `${item[1]} · ${nomeEmpresa ? `${nomeEmpresa} · ` : ''}${nomePlataforma}`;

  const ctx = {
    usuario: u, empresaId, nomeEmpresa, conteudo,
    master: PLATAFORMA.includes(u.perfil),
    soMaster: u.perfil === 'master',
    // Quem administra a empresa: a equipe da plataforma e o administrador da empresa.
    soAdmin: PLATAFORMA.includes(u.perfil) || u.perfil === 'cliente',
    somenteLeitura: u.perfil === 'supervisor',
    // A pergunta que as telas fazem daqui para a frente. O perfil continua existindo, mas é só
    // o ponto de partida das permissões — quem manda é o que a pessoa realmente tem.
    pode: (p) => pode(u, p),
    parar: (fn) => { pararTela = fn; },
    ir: (tela2, eid = empresaId) => ir(eid, tela2),
    acoes: (...itens) => limpar(acoesPagina, ...itens),
    renomearEmpresa: (id, nome) => nomesEmpresa.set(id, { ...(nomesEmpresa.get(id) ?? {}), nome }),
    // O master ligou/desligou a telefonia: o menu se refaz na próxima tela.
    esquecerEmpresa: (id) => nomesEmpresa.delete(id),
  };
  try {
    await telas[tela](ctx);
  } catch (err) {
    toast(err.message, true);
    limpar(conteudo, el('p', { class: 'mudo' }, err.message));
  }
  return undefined;
}

function ferramentas(u, empresaId) {
  const tema = document.documentElement.dataset.tema || 'claro';
  const trocar = (t) => {
    document.documentElement.dataset.tema = t;
    try { localStorage.setItem('atend.tema', t); } catch { /* ignora */ }
    for (const b of document.querySelectorAll('[data-tema-btn]')) b.classList.toggle('on', b.dataset.temaBtn === t);
  };
  const menu = el('div', { class: 'menu-usuario oculto' },
    el('div', { class: 'quem' }, el('strong', {}, u.nome), el('div', { class: 'pequeno mudo' }, u.email), el('div', { class: 'pequeno mudo' }, PERFIS[u.perfil])),
    el('button', { onclick: () => { menu.classList.add('oculto'); alterarSenha(); } }, 'Alterar senha'),
    el('button', { onclick: () => { sessao.limpar(); nomesEmpresa.clear(); location.hash = ''; desenhar(); } }, 'Sair'));

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

  return el('div', { class: 'ferramentas' },
    // O atendente entra e sai da distribuição por aqui: é a primeira coisa que ele faz no dia.
    ['atendente', 'cliente'].includes(u.perfil) && empresaId ? botaoDisponivel(u) : null,
    status,
    el('button', { class: tema === 'claro' ? 'on' : '', title: 'Tema claro', dataset: { temaBtn: 'claro' }, onclick: () => trocar('claro') }, icone('sol')),
    el('button', { class: tema === 'escuro' ? 'on' : '', title: 'Tema escuro', dataset: { temaBtn: 'escuro' }, onclick: () => trocar('escuro') }, icone('lua')),
    el('button', { class: 'usuario', title: u.nome, onclick: () => menu.classList.toggle('oculto') }, el('span', { class: 'avatar' }, iniciais(u.nome)), el('span', { class: 'nome' }, u.nome), icone('abaixo')),
    menu);
}

/** Botão de disponibilidade: ligado, o atendente recebe conversas da fila. */
function botaoDisponivel(u) {
  const b = el('button', { class: `disponivel${u.disponivel ? ' on' : ''}`, title: 'Receber conversas da fila' },
    el('i'), el('span', {}, u.disponivel ? 'Disponível' : 'Indisponível'));
  b.addEventListener('click', () => acao(b, async () => {
    const r = await api.post('/auth/disponivel', { disponivel: !u.disponivel });
    u.disponivel = r.disponivel;
    const s = sessao.get();
    if (s) { s.usuario.disponivel = r.disponivel; sessao.set(s); }
    b.classList.toggle('on', r.disponivel);
    b.querySelector('span').textContent = r.disponivel ? 'Disponível' : 'Indisponível';
    toast(r.disponivel
      ? (r.recebidas ? `Você está disponível e recebeu ${pl(r.recebidas, 'conversa(s) da fila')}.` : 'Você está disponível para receber conversas.')
      : 'Você saiu da distribuição de conversas.');
  }));
  return b;
}

function alterarSenha() {
  formModal('Alterar senha', () => [
    campo('Senha atual', { name: 'atual', type: 'password', required: true, autocomplete: 'current-password' }),
    campo('Nova senha (mínimo 8 caracteres)', { name: 'nova', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
  ], async (d) => {
    await api.post('/auth/senha', d);
    toast('Senha alterada.');
  });
}

const GUARDA_EMAIL = 'atend.email';

/**
 * Tela de entrada. À esquerda, a ZOE se apresenta (uma conversa de verdade, do jeito que ela atende);
 * à direita, o formulário. O erro aparece no próprio formulário, perto de onde a pessoa está olhando,
 * e não num aviso que some no canto da tela.
 */
function telaEntrada() {
  let lembrado = '';
  try { lembrado = localStorage.getItem(GUARDA_EMAIL) ?? ''; } catch { /* sem armazenamento */ }

  const email = el('input', { name: 'email', type: 'email', autocomplete: 'username', required: true, placeholder: 'voce@empresa.com.br', value: lembrado });
  const senha = el('input', { name: 'senha', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Sua senha' });
  const olho = el('button', { type: 'button', class: 'login-olho', title: 'Mostrar a senha', 'aria-label': 'Mostrar a senha' }, icone('olho'));
  olho.addEventListener('click', () => {
    const ver = senha.type === 'password';
    senha.type = ver ? 'text' : 'password';
    olho.title = ver ? 'Esconder a senha' : 'Mostrar a senha';
    olho.setAttribute('aria-label', olho.title);
    limpar(olho, icone(ver ? 'olho-fechado' : 'olho'));
    senha.focus();
  });
  const caps = el('small', { class: 'login-caps oculto', role: 'status' }, 'Caps Lock ligado');
  senha.addEventListener('keyup', (e) => caps.classList.toggle('oculto', !e.getModifierState?.('CapsLock')));
  const lembrar = el('input', { type: 'checkbox', name: 'lembrar', checked: Boolean(lembrado) });
  const erro = el('div', { class: 'login-erro oculto', role: 'alert' });
  const entrar = el('button', { class: 'btn primario login-botao', type: 'submit' }, el('span', {}, 'Entrar'), icone('entrar'));

  const campoLogin = (rotulo, ic, input, extra = null) => el('label', { class: 'login-campo' },
    el('span', { class: 'login-rotulo' }, rotulo),
    el('span', { class: 'login-entrada' }, icone(ic), input, extra));

  const f = el('form', { class: 'login-form', novalidate: true },
    campoLogin('E-mail', 'email', email),
    campoLogin('Senha', 'cadeado', senha, olho),
    el('div', { class: 'login-linha' }, el('label', { class: 'marcar' }, lembrar, 'Lembrar meu e-mail'), caps),
    erro,
    entrar);

  const mostrarErro = (texto) => { erro.textContent = texto; erro.classList.remove('oculto'); };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    erro.classList.add('oculto');
    if (!email.value.trim() || !senha.value) { mostrarErro('Preencha o e-mail e a senha.'); (email.value.trim() ? senha : email).focus(); return; }
    entrar.disabled = true;
    entrar.classList.add('carregando');
    entrar.firstChild.textContent = 'Entrando…';
    try {
      const r = await api.post('/auth/login', { email: email.value.trim(), senha: senha.value });
      try {
        if (lembrar.checked) localStorage.setItem(GUARDA_EMAIL, email.value.trim());
        else localStorage.removeItem(GUARDA_EMAIL);
      } catch { /* ignora */ }
      sessao.set(r);
      desenhar();
    } catch (err) {
      mostrarErro(err.status === 401 ? 'E-mail ou senha não conferem. Confira e tente de novo.' : err.message);
      senha.select();
      entrar.disabled = false;
      entrar.classList.remove('carregando');
      entrar.firstChild.textContent = 'Entrar';
    }
  });

  // A conversa da vitrine: como a ZOE atende, em quatro falas.
  const fala = (quem, texto, extra = null) => el('div', { class: `login-fala ${quem}` }, el('p', {}, texto), extra);
  const vitrine = el('section', { class: 'login-vitrine', 'aria-hidden': 'true' },
    el('div', { class: 'login-chat' },
      el('div', { class: 'login-chat-topo' }, el('span', { class: 'login-avatar' }, icone('ia')),
        el('span', {}, el('strong', {}, 'ZOE'), el('small', {}, 'online agora'))),
      fala('cliente', 'Oi, preciso da 2ª via da minha fatura'),
      fala('zoe', 'Claro! Confirma pra mim os 3 primeiros números do CPF do titular?'),
      fala('cliente', '123'),
      fala('zoe', 'Pronto, Joana! Te mandei o PIX de R$ 89,90 com vencimento em 20/11. 💙',
        el('span', { class: 'login-selo' }, icone('ok'), 'Resolvido pela ZOE em 38 s'))));

  const status = el('span', { class: 'login-status' }, el('i'), 'Verificando o sistema…');
  api.get('/saude').then(() => { status.className = 'login-status ok'; status.lastChild.textContent = 'Sistema online'; })
    .catch(() => { status.className = 'login-status erro'; status.lastChild.textContent = 'Sem conexão com o servidor'; });

  limpar(raiz, el('div', { class: 'login' },
    el('aside', { class: 'login-marca' },
      el('div', { class: 'login-marca-topo' }, marca(nomePlataforma)),
      el('div', { class: 'login-chamada' },
        el('h1', {}, 'A atendente que resolve antes de chamar alguém.'),
        el('p', {}, 'WhatsApp e telefone num lugar só. A ZOE atende, consulta o provedor e só passa para a equipe o que precisa de gente.'),
        el('ul', { class: 'login-pontos' },
          el('li', {}, icone('conversa'), 'WhatsApp e telefone com a mesma inteligência'),
          el('li', {}, icone('dinheiro'), '2ª via, PIX e cobrança dentro da janela grátis'),
          el('li', {}, icone('tv'), 'Supervisão ao vivo, na tela e na TV'))),
      vitrine,
      el('small', { class: 'login-rodape' }, `© ${new Date().getFullYear()} ${nomePlataforma}`)),
    el('main', { class: 'login-painel' },
      el('div', { class: 'login-caixa' },
        el('div', { class: 'login-marca-celular' }, marca(nomePlataforma)),
        el('h2', {}, 'Bem-vindo de volta'),
        el('p', { class: 'login-sub' }, 'Entre com o e-mail e a senha que você recebeu.'),
        f,
        el('p', { class: 'login-ajuda' }, 'Esqueceu a senha? Peça ao administrador da sua empresa para criar uma nova em Usuários.'),
        status))));
  (lembrado ? senha : email).focus();
}

api.get('/publico').then((p) => { nomePlataforma = p.nome || 'ZOE Atende'; }).catch(() => {}).finally(desenhar);
