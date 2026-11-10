import { api, qs } from '../api.js';
import { el, limpar, icone, pode, cabecalho, tabela, faixa, bits, pacotes, numero, toast, formulario } from '../ui.js';
import { graficoLinhas, minigrafico, medidor } from '../grafico.js';
import { navTrafego } from '../nav-trafego.js';

const INTERVALOS = [[5, 'Últimos 5 min'], [15, 'Últimos 15 min'], [60, 'Última 1 h'], [360, 'Últimas 6 h']];
const ATUALIZAR = [[5, 'A cada 5 s'], [10, 'A cada 10 s'], [30, 'A cada 30 s'], [0, 'Pausado']];
const PREF = 'network.consumo';
const lerPref = () => { try { return JSON.parse(localStorage.getItem(PREF)) ?? {}; } catch { return {}; } };
const salvarPref = (x) => { try { localStorage.setItem(PREF, JSON.stringify(x)); } catch { /* sem armazenamento */ } };
const horaSeg = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const horaMin = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Consumo em tempo real: painel no estilo Grafana com somas de 5 s gravadas pelo coletor. */
export default async function consumo({ alvo, query, aoSair }) {
  const pref = lerPref();
  let minutos = Number(query.minutos) || pref.minutos || 15;
  let cada = pref.cada ?? 5;
  let grupoId = query.grupo_id ?? pref.grupo_id ?? '';
  let timer = null;
  let ativo = true;
  aoSair(() => { ativo = false; clearTimeout(timer); });

  const grupos = await api.get('/ddos/grupos').catch(() => []);
  const ponto = el('span', { class: 'ao-vivo', 'aria-hidden': 'true' });
  const quando = el('small', {}, '');
  const sel = (opcoes, valor, rotulo, aoMudar) => {
    const s = el('select', { 'aria-label': rotulo }, opcoes.map(([v, r]) => el('option', { value: v, selected: String(v) === String(valor) }, r)));
    s.addEventListener('change', () => aoMudar(s.value));
    return s;
  };
  const guardar = () => salvarPref({ minutos, cada, grupo_id: grupoId });
  const corpo = el('div');
  const painel = el('section', { class: 'grafana', 'aria-label': 'Consumo em tempo real' },
    el('div', { class: 'gf-barra' },
      el('div', { class: 'gf-titulo' }, ponto, el('span', {}, 'Consumo'), quando),
      sel([['', 'Todos os grupos'], ...grupos.map((g) => [g.id, g.nome])], grupoId, 'Grupo de IPs', (x) => { grupoId = x; guardar(); atualizar(); }),
      sel(INTERVALOS, minutos, 'Período', (x) => { minutos = Number(x); guardar(); atualizar(); }),
      sel(ATUALIZAR, cada, 'Atualização', (x) => { cada = Number(x); guardar(); agendar(); }),
      el('button', { type: 'button', class: 'gf-botao', onclick: () => atualizar(), title: 'Atualizar agora' }, icone('atualizar'), 'Atualizar')),
    corpo);
  limpar(alvo, cabecalho({ sobretitulo: 'Tráfego da rede', titulo: 'Consumo',
    descricao: 'Consumo em tempo real dos blocos protegidos, medido pelos flows dos roteadores de borda (somas de 5 s). Clique na legenda para isolar uma série.' }),
  navTrafego('consumo'), painel);

  function agendar() {
    clearTimeout(timer);
    ponto.classList.toggle('pausado', !cada);
    if (cada && ativo) timer = setTimeout(atualizar, cada * 1000);
  }

  async function atualizar() {
    clearTimeout(timer);
    let d;
    try {
      d = await api.get(`/trafego/tempo-real${qs({ minutos, grupo_id: grupoId })}`);
    } catch (err) {
      if (!corpo.childElementCount) limpar(corpo, el('div', { class: 'falha' }, err.message));
      else quando.textContent = `· sem conexão (${err.message})`;
      agendar();
      return;
    }
    if (!ativo) return;
    desenhar(d);
    quando.textContent = `· atualizado às ${horaSeg(d.gerado_em)}`;
    agendar();
  }

  function desenhar(d) {
    const fx = minutos <= 60 ? horaSeg : horaMin;
    const s = d.serie;
    const ult = s.at(-1);
    const serie = (k) => s.map((p) => [p.em, p[k]]);
    const semBorda = !d.exportadores.length;
    const parados = d.exportadores.filter((e) => e.ativo && e.estado !== 'conectada');
    const stat = (titulo, valor, sub, pontos, cor) => el('div', { class: 'gf-painel gf-stat c2' }, el('h3', {}, titulo), el('div', { class: 'valor' }, valor),
      el('div', { class: 'sub' }, sub), minigrafico(pontos, cor));
    const max = (k) => s.reduce((m, p) => Math.max(m, p[k]), 0);
    const cap = d.capacidade_bps;
    const usoAtual = cap && ult ? (ult.entrada_bps) / cap : null;
    const medidorPainel = cap
      ? el('div', { class: 'gf-painel gf-stat medidor-painel c2' }, el('h3', {}, 'Uso da capacidade', el('small', {}, bits(cap))), medidor(usoAtual, { rotulo: 'Uso da capacidade' }),
        el('div', { class: 'sub' }, `pico do período ${numero((max('entrada_bps') / cap) * 100)}%`))
      : el('div', { class: 'gf-painel gf-stat c2' }, el('h3', {}, 'Uso da capacidade'), el('div', { class: 'sub', style: 'margin:8px 0' }, 'Informe a capacidade dos links de borda para ver o medidor.'),
        pode('ddos.configurar') ? el('button', { type: 'button', class: 'gf-botao', onclick: definirCapacidade }, 'Informar capacidade') : null);
    const top = (lista) => tabela([
      { titulo: 'IP', valor: (x) => el('div', {}, el('div', {}, x.ip), el('div', { class: 'fraco' }, [x.login, x.grupo_nome].filter(Boolean).join(' · '))) },
      { titulo: 'Agora', valor: (x) => el('div', {}, bits(x.bps), el('div', { class: 'barra-uso' }, el('span', { style: `width:${Math.max(2, (x.bps / (lista[0]?.bps || 1)) * 100)}%` }))), classe: 'num' },
      { titulo: 'Pacotes', valor: (x) => pacotes(x.pps), classe: 'num' },
    ], lista.slice(0, 8), { vazioTexto: 'Sem tráfego nos últimos 10 s.', aoClicar: (x) => { location.hash = `#/trafego/ip/${encodeURIComponent(x.ip)}`; } });
    let dirTop = 'entrada';
    const caixaTop = el('div');
    const desenharTop = () => limpar(caixaTop, top(d.top[dirTop]));
    desenharTop();
    const grafico = (opts) => graficoLinhas({ formatoX: fx, vazio: semBorda ? 'Aguardando flows dos roteadores de borda.' : 'Sem medições no período.', ...opts });

    limpar(corpo,
      semBorda ? faixa(el('span', {}, 'Nenhum roteador de borda cadastrado. ', pode('ddos.configurar') ? el('a', { href: '#/fontes' }, 'Cadastrar roteador') : null), 'info') : null,
      parados.length ? faixa(`Sem flows recentes de ${parados.map((e) => e.nome).join(', ')}: o consumo abaixo está incompleto.`, 'erro', 'alerta') : null,
      el('div', { class: 'gf-grade' },
        stat('Entrada', ult ? bits(ult.entrada_bps) : '—', `máx. ${bits(max('entrada_bps'))}`, serie('entrada_bps'), 'var(--s1)'),
        stat('Saída', ult ? bits(ult.saida_bps) : '—', `máx. ${bits(max('saida_bps'))}`, serie('saida_bps'), 'var(--s2)'),
        stat('Pacotes na entrada', ult ? pacotes(ult.entrada_pps) : '—', `máx. ${pacotes(max('entrada_pps'))}`, serie('entrada_pps'), 'var(--s3)'),
        stat('Fluxos na entrada', ult ? pacotes(ult.entrada_fps, 'fluxos/s') : '—', `máx. ${pacotes(max('entrada_fps'), 'fluxos/s')}`, serie('entrada_fps'), 'var(--s7)'),
        stat('UDP na entrada', ult && ult.entrada_bps ? `${numero((ult.udp_bps / ult.entrada_bps) * 100)}%` : '—', ult ? bits(ult.udp_bps) : 'sem medição', serie('udp_bps'), 'var(--s4)'),
        medidorPainel,
        el('div', { class: 'gf-painel c12' }, el('h3', {}, 'Tráfego', el('small', {}, `bits/s · média de ${d.passo_s} s`)),
          grafico({ series: [{ nome: 'Entrada', cor: 'var(--s1)', pontos: serie('entrada_bps') }, { nome: 'Saída', cor: 'var(--s2)', pontos: serie('saida_bps') }],
            formatoY: bits, altura: 260, preencher: 'todas', legendaTabela: true, referencia: cap ? { valor: cap, rotulo: `capacidade ${bits(cap)}` } : null })),
        el('div', { class: 'gf-painel c6' }, el('h3', {}, 'Protocolos na entrada', el('small', {}, 'bits/s, empilhado')),
          grafico({ series: [{ nome: 'TCP', cor: 'var(--s1)', pontos: serie('tcp_bps') }, { nome: 'UDP', cor: 'var(--s2)', pontos: serie('udp_bps') },
            { nome: 'ICMP', cor: 'var(--s3)', pontos: serie('icmp_bps') }, { nome: 'Outros', cor: 'var(--s-outros)', pontos: serie('outros_bps') }], formatoY: bits, empilhado: true, altura: 230, largura: 460 })),
        el('div', { class: 'gf-painel c6' }, el('h3', {}, 'Entrada por grupo de IPs', el('small', {}, 'bits/s')),
          grafico({ series: d.grupos.slice(0, 8).map((g, i) => ({ nome: g.nome, cor: `var(--s${i + 1})`, pontos: g.pontos })), formatoY: bits, preencher: 'nenhuma', altura: 230, largura: 460,
            vazio: 'Sem grupos com tráfego no período.' })),
        el('div', { class: 'gf-painel c6' }, el('h3', {}, 'Pacotes por segundo'),
          grafico({ series: [{ nome: 'Entrada', cor: 'var(--s1)', pontos: serie('entrada_pps') }, { nome: 'Saída', cor: 'var(--s2)', pontos: serie('saida_pps') }],
            formatoY: (x) => pacotes(x), preencher: 'nenhuma', altura: 230, largura: 460 })),
        el('div', { class: 'gf-painel c6' }, el('h3', {}, 'Maiores consumidores agora', el('div', { class: 'alternador', role: 'group', 'aria-label': 'Direção' },
          ...[['entrada', 'Download'], ['saida', 'Upload']].map(([v, r]) => {
            const b = el('button', { type: 'button', 'aria-pressed': String(v === dirTop) }, r);
            b.addEventListener('click', () => { dirTop = v; b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); desenharTop(); });
            return b;
          }))), caixaTop)),
      el('div', { class: 'gf-rodape' }, el('span', {}, 'Fonte: flows dos roteadores de borda. Volumes estimados pela taxa de amostragem.'),
        el('span', {}, `Resolução de ${d.passo_s} s · somas de 5 s guardadas por 6 h; períodos maiores em `, el('a', { href: '#/trafego' }, 'Visão geral'), '.')));
  }

  async function definirCapacidade() {
    const cfg = await api.get('/ddos/config');
    formulario('Capacidade dos links de borda', [
      { nome: 'gbps', rotulo: 'Capacidade total (Gbps)', tipo: 'decimal', obrigatorio: true, valor: cfg.capacidade_bps ? String(cfg.capacidade_bps / 1e9).replace('.', ',') : '',
        ajuda: 'Soma dos links de trânsito, PTT e CDN que entram na borda. Ex.: 2 × 10 Gbps = 20.' },
    ], { enviar: async (x) => {
      await api.put('/ddos/config', { versao: cfg.versao, capacidade_bps: Number(x.gbps.replace(/\./g, '').replace(',', '.')) * 1e9 });
      toast('Capacidade salva.');
      atualizar();
    } });
  }

  limpar(corpo, el('div', { class: 'carregando' }, 'Carregando…'));
  atualizar();
}

