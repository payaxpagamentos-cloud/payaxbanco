import { api, sessao } from './api.js';
import { el, $, limpar, icone, iniciais, pode, usuario, toast, modal, formulario, acao } from './ui.js';

// [rota, rótulo, ícone, permissão, módulo]
const MENU = [
  ['Operação', [
    ['visao', 'Visão geral', 'painel', 'painel.ver', () => import('./telas/visao.js')],
    ['noc', 'Central NOC', 'atividade', 'noc.ver', () => import('./telas/noc.js')],
    ['rede', 'Rede óptica', 'rede', 'rede.ver', () => import('./telas/rede.js')],
    ['chamados', 'Chamados técnicos', 'chamado', 'chamados.ver', () => import('./telas/chamados.js')],
    ['equipe', 'Equipe e comissões', 'equipe', ['equipe.ver', 'comissoes.ver'], () => import('./telas/equipe.js')],
  ]],
  ['Tráfego e segurança', [
    ['trafego', 'Tráfego da rede', 'grafico', 'trafego.ver', () => import('./telas/trafego.js')],
    ['consumo', 'Consumo', 'atividade', 'trafego.ver', () => import('./telas/consumo.js'), true],
    ['conteudo', 'Conteúdo', 'camadas', 'trafego.ver', () => import('./telas/conteudo.js'), true],
    ['ddos', 'Anti-DDoS', 'escudo', 'ddos.ver', () => import('./telas/ddos.js')],
    ['assinantes', 'Assinantes', 'pino', 'assinantes.ver', () => import('./telas/assinantes.js')],
  ]],
  ['Gestão de frota', [
    ['veiculos', 'Veículos', 'carro', 'frota.ver', () => import('./telas/veiculos.js')],
    ['manutencao', 'Manutenção e lavagem', 'chave', 'manutencao.ver', () => import('./telas/manutencao.js')],
    ['combustivel', 'Abastecimentos', 'combustivel', 'combustivel.ver', () => import('./telas/combustivel.js')],
    ['rastreamento', 'Rastreamento', 'pino', 'rastreamento.ver', () => import('./telas/rastreamento.js')],
  ]],
  ['Sistema', [
    ['integracoes', 'Integrações', 'plugue', 'integracoes.ver', () => import('./telas/integracoes.js')],
    ['fontes', 'Fontes e avisos', 'servidor', ['ddos.configurar', 'avisos.configurar'], () => import('./telas/fontes.js')],
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
    el('a', { class: 'marca', href: '#/visao' }, simbolo(), el('span', { class: 'marca-texto' }, 'manager', el('small', {}, 'NETWORK'))),
    el('div', { class: 'contexto' }, el('span', { class: 'logo' }, iniciais(u.organizacao_nome)), el('div', {}, el('strong', {}, u.organizacao_nome), el('small', {}, u.perfil_nome))),
  );
  for (const [grupo, itens] of MENU) {
    const vis = itens.filter(([, , , perm]) => permitido(perm));
    if (!vis.length) continue;
    menu.append(el('div', { class: 'grupo-menu' }, grupo), el('nav', { 'aria-label': grupo }, vis.map(([r, rot, ic, , , sub]) =>
      el('a', { class: `link-menu${sub ? ' sub' : ''}${r === rota ? ' ativo' : ''}`, href: `#/${r}`, 'aria-current': r === rota ? 'page' : null, onclick: () => alternarMenu(false) }, icone(ic), rot))));
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
  const busca = el('input', { type: 'search', placeholder: 'Buscar CTO, chamado ou placa', 'aria-label': 'Buscar na operação' });
  busca.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !busca.value.trim()) return;
    const t = busca.value.trim();
    if (/^[A-Za-z]{3}-?\d[A-Za-z0-9]\d{2}$/.test(t) && permitido('frota.ver')) ir(`#/veiculos?busca=${encodeURIComponent(t)}`);
    else if (/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+:[0-9a-f:]*$/i.test(t) && permitido('trafego.ver')) ir(`#/trafego/ip/${encodeURIComponent(t)}`);
    else if (/^#?\d+$/.test(t) && permitido('chamados.ver')) ir(`#/chamados?busca=${encodeURIComponent(t.replace('#', ''))}`);
    else if (permitido('rede.ver')) ir(`#/rede?busca=${encodeURIComponent(t)}`);
  });
  const sino = el('button', { class: 'botao-icone', title: 'Alertas prioritários', 'aria-label': 'Alertas prioritários', onclick: () => ir(permitido('noc.ver') ? '#/noc' : '#/visao') }, icone('sino'));
  const topo = el('header', { class: 'topo' },
    el('button', { class: 'botao-icone abrir-menu', 'aria-label': 'Abrir menu', 'aria-controls': 'menu', onclick: () => alternarMenu(!menu.classList.contains('aberto')) }, icone('menu')),
    el('div', { class: 'caminho' }, el('span', {}, u.organizacao_nome), el('span', { class: 'sep' }, '/'), el('strong', {}, ROTAS[rota]?.rotulo ?? '')),
    el('div', { class: 'topo-acoes' }, permitido(['rede.ver', 'chamados.ver', 'frota.ver']) ? el('label', { class: 'busca-topo' }, icone('busca'), busca) : null,
      permitido('noc.ver') ? el('a', { class: 'botao-icone', href: '#/tv', title: 'Painel TV do NOC', 'aria-label': 'Painel TV do NOC' }, icone('tv')) : null, pausar, sino));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.classList.contains('aberto')) alternarMenu(false); }, { once: true });
  return el('div', { class: 'app' }, el('a', { class: 'sr', href: '#conteudo' }, 'Ir para o conteúdo'), menu, fundo, el('div', { class: 'principal' }, topo, principal));
}

function simbolo() {
  const s = icone('rede', 'marca-simbolo');
  s.innerHTML = '<path d="M7 26V10h5l12 16h5V10" stroke-width="3"/><circle cx="7" cy="27" r="3" fill="currentColor"/><circle cx="29" cy="9" r="3" fill="currentColor"/>';
  s.setAttribute('viewBox', '0 0 36 36');
  return s;
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

function telaEntrada() {
  const erro = el('div', { class: 'erro-form', role: 'alert', hidden: true });
  const email = el('input', { type: 'email', name: 'email', required: true, autocomplete: 'username', id: 'email' });
  const senha = el('input', { type: 'password', name: 'senha', required: true, autocomplete: 'current-password', id: 'senha' });
  const entrar = el('button', { type: 'submit', class: 'botao grande' }, 'Entrar');
  const form = el('form', {}, el('h2', {}, 'Entrar'), el('p', {}, 'Use o acesso criado pelo administrador da sua organização.'),
    el('label', { class: 'campo', for: 'email' }, el('span', {}, 'E-mail'), email), el('label', { class: 'campo', for: 'senha' }, el('span', {}, 'Senha'), senha), erro, entrar);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    erro.hidden = true;
    acao(entrar, async () => {
      try {
        const r = await api.post('/auth/login', { email: email.value.trim(), senha: senha.value });
        sessao.set(r);
        desenhar();
      } catch (err) { erro.textContent = err.message; erro.hidden = false; }
    });
  });
  const rede = icone('rede', 'rede');
  rede.setAttribute('stroke-width', '0.6');
  limpar(raiz, el('div', { class: 'entrada' },
    el('section', { class: 'entrada-marca' }, el('div', { class: 'marca' }, simbolo(), el('span', { class: 'marca-texto' }, 'manager', el('small', {}, 'NETWORK'))),
      el('div', {}, el('h1', {}, 'Rede, equipes e veículos sob a mesma visão.'), el('p', {}, 'Rede óptica, Central NOC, chamados técnicos, comissões, frota e rastreamento para provedores de internet.')),
      el('small', { style: 'color:#8fa996' }, 'Os dados exibidos vêm das fontes conectadas, com horário de coleta.'), rede),
    el('section', { class: 'entrada-form' }, form)));
  email.focus();
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
