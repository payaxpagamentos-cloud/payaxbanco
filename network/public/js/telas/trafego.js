import { api, qs, baixar } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, carregar, carregando, faixa, stat, vazio, dataHora, hora, bits, pacotes, bytes, etqDe } from '../ui.js';
import { graficoLinhas } from '../grafico.js';
import { navTrafego } from '../nav-trafego.js';

const PERIODOS = [[1, '1 h'], [6, '6 h'], [24, '24 h'], [168, '7 dias'], [720, '30 dias']];
const formatoX = (horas) => (t) => (horas <= 24 ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  : new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }));

export default async function trafego({ alvo, params, query, ir, aoSair }) {
  if (params[0] === 'ip' && params[1]) return fichaIp(alvo, params[1], ir);
  let horas = Number(query.horas) || 24;
  let grupoId = query.grupo_id ?? '';
  const corpo = el('div');
  const filtros = el('div', { class: 'filtros' });
  let timer = null;
  aoSair(() => clearInterval(timer));
  limpar(alvo, cabecalho({ sobretitulo: 'Tráfego e segurança', titulo: 'Tráfego da rede',
    descricao: 'Entrada e saída dos blocos protegidos, medidas pelos flows dos roteadores de borda. Volumes são estimativas pela taxa de amostragem.' }), navTrafego('trafego'), filtros, corpo);

  const grupos = await api.get('/ddos/grupos').catch(() => []);
  const desenharFiltros = () => {
    const sel = el('select', { 'aria-label': 'Grupo de IPs', onchange: (e) => { grupoId = e.target.value; atualizar(); } },
      el('option', { value: '' }, 'Todos os grupos'), grupos.map((g) => el('option', { value: g.id, selected: String(g.id) === String(grupoId) }, g.nome)));
    limpar(filtros, el('div', { class: 'alternador', role: 'group', 'aria-label': 'Período' }, PERIODOS.map(([h, r]) =>
      el('button', { type: 'button', 'aria-pressed': String(h === horas), onclick: () => { horas = h; desenharFiltros(); atualizar(); } }, r))), sel);
  };
  const atualizar = () => carregar(corpo, () => Promise.all([api.get(`/trafego/resumo${qs({ horas, grupo_id: grupoId })}`), api.get('/trafego/fontes'),
    api.get(`/trafego/top${qs({ direcao: 'entrada', horas: Math.min(horas, 720) })}`), api.get(`/trafego/top${qs({ direcao: 'saida', horas: Math.min(horas, 720) })}`)]),
  ([r, fontes, topE, topS]) => {
    const borda = fontes.exportadores.filter((e) => e.papel === 'borda' && e.ativo);
    const semFonte = !borda.length;
    const parados = borda.filter((e) => e.estado === 'desatualizada');
    const serie = (k) => r.serie.map((p) => [Date.parse(p.em), p[k]]);
    const listaTop = (t, titulo, dir) => painel(titulo, tabela([
      { titulo: 'IP', valor: (x) => el('div', {}, el('div', { class: 'forte' }, x.ip), x.login ? el('div', { class: 'fraco' }, x.login) : null) },
      { titulo: 'Grupo', valor: (x) => x.grupo_nome ?? '—' },
      { titulo: 'Volume', valor: (x) => bytes(x.bytes), classe: 'num' },
      { titulo: 'Média', valor: (x) => bits((x.bytes * 8) / (Math.min(horas, 720) * 3600)), classe: 'num' },
    ], t.itens.slice(0, 10), { vazioTexto: 'Sem tráfego registrado no período.', aoClicar: (x) => ir(`#/trafego/ip/${encodeURIComponent(x.ip)}`) }), {
      semCorpo: true, acoes: [el('button', { class: 'botao fantasma pequeno', onclick: () => baixar(`/trafego/top${qs({ direcao: dir, horas: Math.min(horas, 720), limite: 200, formato: 'csv' })}`, `top-${dir}.csv`) },
        icone('baixar'), 'CSV')] });
    return el('div', {},
      semFonte ? faixa(el('span', {}, 'Nenhum roteador de borda enviando flows: sem eles não há medição de tráfego nem detecção de ataques. ',
        pode('ddos.configurar') ? el('a', { href: '#/fontes' }, 'Cadastrar roteador') : 'Peça ao administrador para cadastrar.'), 'info') : null,
      parados.length ? faixa(`Sem flows recentes de: ${parados.map((e) => `${e.nome} (último ${dataHora(e.ultimo_pacote)})`).join(', ')}. Os números abaixo podem estar incompletos.`, 'erro', 'alerta') : null,
      el('div', { class: 'stats' },
        stat({ rotulo: 'Entrada agora', ic: 'baixar', valor: r.atual ? bits(r.atual.entrada_bps) : '—', semDado: !r.atual, nota: r.atual ? pacotes(r.atual.entrada_pps) : 'Sem medição', notaTipo: 'neutra',
          fonte: r.atual ? `Média de ${r.passo_min} min · ${hora(r.atual.em)}` : null }),
        stat({ rotulo: 'Saída agora', ic: 'seta', valor: r.atual ? bits(r.atual.saida_bps) : '—', semDado: !r.atual, nota: r.atual ? pacotes(r.atual.saida_pps) : 'Sem medição', notaTipo: 'neutra' }),
        stat({ rotulo: 'Pico de entrada', ic: 'sinal', valor: r.pico_entrada.em ? bits(r.pico_entrada.valor) : '—', semDado: !r.pico_entrada.em,
          nota: r.pico_entrada.em ? `às ${dataHora(r.pico_entrada.em)}` : 'Sem medição', notaTipo: 'neutra' }),
        stat({ rotulo: 'Volume no período', ic: 'grafico', valor: bytes(r.totais.entrada?.bytes ?? 0), nota: `${bytes(r.totais.saida?.bytes ?? 0)} de saída`, notaTipo: 'neutra',
          fonte: r.totais.entrada?.bytes ? `UDP ${Math.round(((r.totais.entrada.udp ?? 0) / r.totais.entrada.bytes) * 100)}% · TCP ${Math.round(((r.totais.entrada.tcp ?? 0) / r.totais.entrada.bytes) * 100)}%` : null })),
      painel('Entrada e saída (bits/s)', graficoLinhas({ series: [{ nome: 'Entrada', cor: 'var(--verde)', pontos: serie('entrada_bps') }, { nome: 'Saída', cor: 'var(--laranja)', pontos: serie('saida_bps') }],
        formatoY: bits, formatoX: formatoX(horas), vazio: semFonte ? 'Aguardando flows dos roteadores.' : 'Sem tráfego registrado no período.' }),
      { rodape: [el('span', {}, `Cada ponto é a média de ${r.passo_min} min. Use as setas do teclado sobre o gráfico para ler os valores.`)] }),
      el('div', { class: 'grade duas' }, listaTop(topE, 'IPs que mais recebem', 'entrada'), listaTop(topS, 'IPs que mais enviam', 'saida')),
      r.grupos.length ? painel('Por grupo de IPs', tabela([{ titulo: 'Grupo', valor: (g) => g.nome }, { titulo: 'Direção', valor: (g) => (g.direcao === 'entrada' ? 'Entrada' : 'Saída') },
        { titulo: 'Volume', valor: (g) => bytes(g.bytes), classe: 'num' }], r.grupos), { semCorpo: true }) : null);
  });
  desenharFiltros();
  atualizar();
  timer = setInterval(atualizar, 60_000);
}

async function fichaIp(alvo, ip, ir) {
  limpar(alvo, carregando());
  let d;
  try { d = await api.get(`/trafego/ip/${encodeURIComponent(ip)}`); } catch (err) { limpar(alvo, el('div', { class: 'falha' }, err.message)); return; }
  const por = (dir) => d.serie.filter((x) => x.direcao === dir).map((x) => [Date.parse(`${x.hora}:00Z`), (x.bytes * 8) / 3600]);
  limpar(alvo,
    el('a', { href: '#/trafego', class: 'botao fantasma pequeno', style: 'margin-bottom:10px' }, icone('voltar'), 'Tráfego'),
    cabecalho({ sobretitulo: `IPv${d.versao}${d.grupo?.nome ? ` · ${d.grupo.nome}` : ''}`, titulo: d.ip, descricao: 'Tráfego médio por hora nos últimos 7 dias, ataques e quem usou o endereço.' }),
    painel('Tráfego por hora (média em bits/s)', graficoLinhas({ series: [{ nome: 'Recebido', cor: 'var(--verde)', pontos: por('entrada') }, { nome: 'Enviado', cor: 'var(--laranja)', pontos: por('saida') }],
      formatoY: bits, formatoX: formatoX(168), vazio: 'Sem tráfego deste IP nos últimos 7 dias.' })),
    el('div', { class: 'grade duas' },
      painel('Ataques', tabela([{ titulo: 'Ataque', valor: (a) => el('div', {}, el('div', { class: 'forte' }, `#${a.numero} ${a.vetor ?? ''}`), el('div', { class: 'fraco' }, dataHora(a.inicio))) },
        { titulo: 'Direção', valor: (a) => etqDe('direcaoAtaque', a.direcao) }, { titulo: 'Pico', valor: (a) => bits(a.pico_bps), classe: 'num' },
        { titulo: 'Situação', valor: (a) => etqDe('statusAtaque', a.status) }], d.ataques, { vazioTexto: 'Nenhum ataque registrado para este IP.', aoClicar: (a) => ir(`#/ddos/ataque/${a.id}`) }), { semCorpo: true }),
      d.sessoes ? painel('Quem usou este IP (RADIUS)', tabela([{ titulo: 'Login', valor: (s) => el('div', {}, el('div', { class: 'forte' }, s.login), s.mac ? el('div', { class: 'fraco' }, s.mac) : null) },
        { titulo: 'Início', valor: (s) => dataHora(s.inicio) }, { titulo: 'Fim', valor: (s) => (s.fim ? dataHora(s.fim) : el('span', { class: 'etq ok' }, 'Conectado')) },
        { titulo: 'NAS', valor: (s) => s.nas_ip }], d.sessoes, { vazioTexto: 'Nenhuma sessão registrada com este IP.' }), { semCorpo: true })
        : painel('Quem usou este IP', el('p', { class: 'fraco' }, 'Seu perfil não vê dados de assinantes.'))));
}

