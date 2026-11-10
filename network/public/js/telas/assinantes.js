import { api, qs } from '../api.js';
import { el, limpar, cabecalho, painel, tabela, paginacao, carregar, stat, faixa, dataHora, desde, bytes, numero, pode } from '../ui.js';

export default async function assinantes({ alvo, query, ir }) {
  let filtro = { busca: query.busca ?? '', ativas: query.ativas ?? '', pagina: 1 };
  const topo = el('div');
  const lista = el('div');
  const busca = el('input', { type: 'search', class: 'busca', placeholder: 'Login, IP ou MAC', value: filtro.busca, 'aria-label': 'Buscar sessões' });
  const ativas = el('select', { 'aria-label': 'Situação' }, [['', 'Todas as sessões'], ['1', 'Só conectados agora']].map(([v, r]) => el('option', { value: v, selected: v === filtro.ativas }, r)));
  let t = null;
  busca.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { filtro = { ...filtro, busca: busca.value.trim(), pagina: 1 }; desenhar(); }, 300); });
  ativas.addEventListener('change', () => { filtro = { ...filtro, ativas: ativas.value, pagina: 1 }; desenhar(); });
  limpar(alvo, cabecalho({ sobretitulo: 'Tráfego e segurança', titulo: 'Assinantes conectados',
    descricao: 'Sessões PPPoE/IPoE pela contabilidade RADIUS do BRAS: qual login usou qual IP, de quando a quando. Guardadas por pelo menos 1 ano (Marco Civil).' }),
  topo, el('div', { class: 'filtros' }, busca, ativas), lista);

  carregar(topo, () => Promise.all([api.get('/trafego/sessoes/resumo'), api.get('/trafego/fontes')]), ([r, f]) => el('div', {},
    !f.nas.length ? faixa(el('span', {}, 'Nenhum BRAS enviando contabilidade RADIUS. ', pode('ddos.configurar') ? el('a', { href: '#/fontes?aba=radius' }, 'Cadastrar BRAS') : null), 'info') : null,
    el('div', { class: 'stats' },
      stat({ rotulo: 'Conectados agora', ic: 'equipe', valor: numero(r.ativas), nota: `${r.por_nas.length} BRAS/NAS`, notaTipo: 'neutra' }),
      stat({ rotulo: 'Com IPv6', ic: 'globo', valor: r.ativas ? `${numero((r.com_ipv6 / r.ativas) * 100)}%` : '—', semDado: !r.ativas, nota: `${numero(r.com_ipv6)} sessões com prefixo IPv6`, notaTipo: 'neutra' }),
      ...r.por_nas.slice(0, 2).map((n) => stat({ rotulo: `NAS ${n.nas_ip}`, ic: 'servidor', valor: numero(n.n), nota: 'sessões ativas', notaTipo: 'neutra' })))));

  const desenhar = () => carregar(lista, () => api.get(`/trafego/sessoes${qs(filtro)}`), (l) => painel(null, el('div', {}, tabela([
    { titulo: 'Login', valor: (s) => el('div', {}, el('div', { class: 'forte' }, s.login), el('div', { class: 'fraco' }, [s.mac, s.nas_porta].filter(Boolean).join(' · '))) },
    { titulo: 'IP', valor: (s) => el('div', {}, s.ip ?? '—', s.ipv6_delegado || s.ipv6_prefixo ? el('div', { class: 'fraco' }, s.ipv6_delegado ?? s.ipv6_prefixo) : null) },
    { titulo: 'Início', valor: (s) => el('div', {}, dataHora(s.inicio), el('div', { class: 'fraco' }, s.fim ? '' : desde(s.inicio))) },
    { titulo: 'Fim', valor: (s) => (s.fim ? el('div', {}, dataHora(s.fim), s.motivo_fim ? el('div', { class: 'fraco' }, s.motivo_fim) : null) : el('span', { class: 'etq ok' }, 'Conectado')) },
    { titulo: 'Download / upload', valor: (s) => `${bytes(s.bytes_entrada)} / ${bytes(s.bytes_saida)}`, classe: 'num' },
    { titulo: 'NAS', valor: (s) => s.nas_ip },
  ], l.itens, { vazioTexto: filtro.busca ? 'Nenhuma sessão encontrada.' : 'Nenhuma sessão registrada ainda.', aoClicar: (s) => (s.ip ? ir(`#/trafego/ip/${encodeURIComponent(s.ip)}`) : null) }),
  paginacao(l, (p) => { filtro = { ...filtro, pagina: p }; desenhar(); })), { semCorpo: true }));
  desenhar();
}
