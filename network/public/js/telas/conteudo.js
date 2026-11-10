import { api, qs } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, abas, carregar, faixa, stat, vazio, bits, bytes, numero, toast, formulario, confirmar, dataHora } from '../ui.js';
import { graficoLinhas, minigrafico } from '../grafico.js';
import { MARCAS } from '../marcas.js';
import { navTrafego } from '../nav-trafego.js';

const PERIODOS = [[1, '1 h'], [6, '6 h'], [24, '24 h'], [168, '7 dias'], [720, '30 dias']];
const CORES = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `var(--s${i})`);
const pct = (x) => (x === null || x === undefined ? '—' : `${numero(x * 100, x < 0.1 ? 1 : 0)}%`);

/** Principais conteúdos (de onde vem o tráfego), pelo ASN do lado remoto de cada flow. */
export default async function conteudo({ alvo, query }) {
  let horas = Number(query.horas) || 24;
  let direcao = query.direcao ?? 'entrada';
  let aba = query.aba === 'catalogo' ? 'catalogo' : 'ranking';
  const filtros = el('div', { class: 'filtros' });
  const barra = el('div');
  const corpo = el('div');
  limpar(alvo, cabecalho({ sobretitulo: 'Tráfego da rede', titulo: 'Conteúdo',
    descricao: 'Quais conteúdos e redes os clientes mais consomem, pelo ASN de origem de cada flow (o mesmo que o roteador usa no BGP). O flow mostra a rede de origem, não o site ou o vídeo.' }),
  navTrafego('conteudo'), barra, filtros, corpo);

  const trocar = (id) => { aba = id; barra.replaceChildren(abas([['ranking', 'Principais conteúdos'], ['catalogo', 'Catálogo']], aba, trocar)); desenharFiltros(); TELAS[aba](); };
  const desenharFiltros = () => {
    if (aba !== 'ranking') { filtros.replaceChildren(); return; }
    limpar(filtros,
      el('div', { class: 'alternador', role: 'group', 'aria-label': 'Período' }, PERIODOS.map(([h, r]) =>
        el('button', { type: 'button', 'aria-pressed': String(h === horas), onclick: () => { horas = h; desenharFiltros(); TELAS.ranking(); } }, r))),
      el('div', { class: 'alternador', role: 'group', 'aria-label': 'Direção' }, [['entrada', 'Download'], ['saida', 'Upload']].map(([d, r]) =>
        el('button', { type: 'button', 'aria-pressed': String(d === direcao), onclick: () => { direcao = d; desenharFiltros(); TELAS.ranking(); } }, r))));
  };

  const TELAS = {
    ranking: () => carregar(corpo, () => api.get(`/trafego/conteudo${qs({ horas, direcao })}`), (d) => {
      const cor = new Map(d.series.filter((x) => x.chave !== 'demais').map((x, i) => [x.chave, CORES[i]]));
      cor.set('demais', 'var(--s-outros)');
      const primeiro = d.itens.find((x) => x.chave !== 'outros' && x.chave !== 'desconhecido');
      const semDados = !d.itens.length;
      return el('div', {},
        !d.base_asn ? faixa(el('span', {}, 'Base IP → ASN não importada: só aparece o conteúdo dos flows que já trazem o ASN (src_as/dst_as) ou dos prefixos do catálogo. ',
          el('button', { class: 'botao fantasma pequeno', onclick: () => trocar('catalogo') }, 'Como importar')), 'info') : null,
        el('div', { class: 'stats' },
          stat({ rotulo: direcao === 'entrada' ? 'Download no período' : 'Upload no período', ic: 'grafico', valor: bytes(d.total_bytes), semDado: semDados,
            nota: semDados ? 'Sem flows no período' : `média de ${bits((d.total_bytes * 8) / (horas * 3600))}`, notaTipo: 'neutra' }),
          stat({ rotulo: 'Maior conteúdo', ic: 'camadas', valor: primeiro ? pct(primeiro.participacao) : '—', semDado: !primeiro, nota: primeiro?.nome ?? 'Sem dados', notaTipo: 'neutra' }),
          stat({ rotulo: 'Reconhecido no catálogo', ic: 'ok', valor: pct(d.cobertura.catalogo), semDado: d.cobertura.catalogo === null,
            nota: `${pct(d.cobertura.asn)} com ASN fora do catálogo`, notaTipo: 'neutra' }),
          stat({ rotulo: 'Sem identificação', ic: 'info', valor: pct(d.cobertura.desconhecido), semDado: d.cobertura.desconhecido === null,
            nota: d.base_asn ? `Base ASN de ${dataHora(d.base_asn.importado_em)}` : 'Sem base ASN', notaTipo: d.cobertura.desconhecido > 0.2 ? 'aviso' : 'neutra' })),
        el('section', { class: 'cartoes-conteudo', 'aria-label': 'Os 6 maiores conteúdos' },
          d.itens.slice(0, 6).map((x) => cartaoConteudo(x, cor.get(x.chave) ?? 'var(--s-outros)', d.series.find((sr) => sr.chave === x.chave)?.pontos ?? [], d.comparavel))),
        listaTop(d, cor, TELAS.ranking),
        el('div', {},
          painel('Consumo ao longo do tempo', graficoLinhas({ series: d.series.map((x) => ({ nome: x.nome, cor: cor.get(x.chave), pontos: x.pontos })), formatoY: bits, empilhado: true, altura: 280,
            formatoX: (t) => (horas <= 24 ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })),
            vazio: 'Sem flows no período.' }), { rodape: [el('span', {}, `Os 8 maiores conteúdos, empilhados; média de ${d.passo_min >= 60 ? `${d.passo_min / 60} h` : `${d.passo_min} min`} por ponto.`)] }),
          painel('Fluxo: conteúdo → clientes', diagramaFluxo(d.fluxo, cor), { rodape: [el('span', {}, direcao === 'entrada'
            ? 'Para qual grupo de clientes vai cada conteúdo. Passe o mouse numa faixa para ver o volume.' : 'De qual grupo de clientes sai o tráfego para cada destino.')] })));
    }),
    catalogo: () => carregar(corpo, () => api.get('/trafego/conteudos'), (c) => el('div', {},
      painel('Base IP → ASN', el('div', { style: 'display:grid;gap:8px' },
        c.base_asn ? el('p', {}, `Importada em ${dataHora(c.base_asn.importado_em)} (${c.base_asn.origem}): ${numero(c.base_asn.faixas)} faixas de endereços.`)
          : el('p', {}, 'Nenhuma base importada. Sem ela, o conteúdo depende do ASN que o roteador exporta no flow (src_as/dst_as).'),
        el('p', { class: 'fraco' }, 'Para importar ou atualizar (uma vez por semana), no servidor:'),
        el('code', { class: 'comando' }, 'wget https://iptoasn.com/data/ip2asn-combined.tsv.gz && npm run importar-asn -- ip2asn-combined.tsv.gz'),
        el('p', { class: 'fraco' }, 'O coletor passa a usar a base nova em até 10 segundos.'))),
      painel('Catálogo de conteúdos', tabela([
        { titulo: 'Conteúdo', valor: (x) => el('div', { class: 'nome-conteudo' }, logoConteudo(x, 28), el('div', {}, el('div', { class: 'forte' }, x.nome), el('div', { class: 'fraco' }, `${c.categorias[x.categoria]}${x.padrao ? ' · catálogo inicial' : ''}${x.ativo ? '' : ' · desativado'}`))) },
        { titulo: 'Reconhecido por', valor: (x) => el('div', { class: 'filtros', style: 'margin:0;gap:6px' }, x.regras.length ? x.regras.map((r) => el('span', { class: 'etq neutra sem-ponto' },
          r.tipo === 'asn' ? `AS${r.valor}` : r.valor,
          pode('ddos.configurar') ? el('button', { class: 'botao-icone', style: 'width:18px;height:18px;border:0', 'aria-label': `Remover ${r.valor}`, onclick: async (e) => {
            e.stopPropagation();
            if (await confirmar('Remover regra', `${r.tipo === 'asn' ? `AS${r.valor}` : r.valor} deixa de contar como ${x.nome} a partir do próximo minuto.`, 'Remover')) {
              await api.post(`/trafego/conteudos/${x.id}/regras/${r.id}/remover`, {}); TELAS.catalogo();
            } } }, icone('fechar')) : null)) : el('span', { class: 'fraco' }, 'Sem regras')) },
        { titulo: '', valor: (x) => (pode('ddos.configurar') ? el('button', { class: 'botao fantasma pequeno', onclick: (e) => { e.stopPropagation(); novaRegra(x, TELAS.catalogo); } }, icone('mais'), 'ASN ou prefixo') : '') },
      ], c.itens, { aoClicar: pode('ddos.configurar') ? (x) => editarConteudo(x, c.categorias, TELAS.catalogo) : null }), {
        semCorpo: true, acoes: [pode('ddos.configurar') ? el('button', { class: 'botao secundario pequeno', onclick: () => editarConteudo(null, c.categorias, TELAS.catalogo) }, icone('mais'), 'Novo conteúdo') : null],
        rodape: [el('span', {}, 'O catálogo inicial usa ASNs públicos conhecidos: confira e complete com os da sua região (ex.: caches locais, provedores de jogos). Prefixo vence ASN. Mudanças valem a partir do próximo minuto.')] }))),
  };
  trocar(aba);
}

/** Logo da empresa (ícone na cor oficial) ou, sem logo, as iniciais do nome. */
function logoConteudo(x, tamanho = 44) {
  const m = x.marca ? MARCAS[x.marca] : null;
  if (m) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', m.d);
    svg.append(p);
    return el('span', { class: 'logo-marca', style: `--marca:${m.cor};width:${tamanho}px;height:${tamanho}px`, title: m.titulo }, svg);
  }
  const iniciais = x.asn ? 'AS' : x.chave === 'desconhecido' ? '?' : String(x.nome).replace(/\(.*\)/, '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  return el('span', { class: 'logo-marca iniciais', style: `width:${tamanho}px;height:${tamanho}px`, 'aria-hidden': 'true' }, iniciais);
}

function cartaoConteudo(x, cor, pontos, comparavel) {
  const variacao = !comparavel ? el('span', { class: 'variacao neutra' }, 'sem histórico') : x.variacao === null ? el('span', { class: 'variacao neutra' }, 'novo')
    : el('span', { class: `variacao ${x.variacao > 0.15 ? 'sobe' : x.variacao < -0.15 ? 'desce' : 'neutra'}`, title: 'Comparado com o período anterior' },
      `${x.variacao >= 0 ? '▲' : '▼'} ${numero(Math.abs(x.variacao) * 100)}%`);
  return el('article', { class: 'cartao-conteudo' },
    el('div', { class: 'cc-topo' }, logoConteudo(x),
      el('div', { class: 'cc-nome' }, el('span', { class: 'cc-posicao' }, `${x.posicao}º`), el('strong', {}, x.nome),
        el('small', {}, x.catalogado ? rotuloCategoria(x.categoria) : x.asn ? 'ASN fora do catálogo' : 'Sem identificação')), variacao),
    el('div', { class: 'cc-valores' }, el('div', { class: 'cc-volume' }, bytes(x.bytes)), el('div', { class: 'cc-pct' }, pct(x.participacao))),
    el('div', { class: 'barra-uso', title: `${pct(x.participacao)} do total` }, el('span', { style: `width:${Math.max(1, x.participacao * 100)}%;background:${cor}` })),
    el('div', { class: 'cc-rodape' }, el('span', {}, 'Média ', el('strong', {}, bits(x.media_bps))), el('span', {}, 'Pico ', el('strong', {}, bits(x.pico_bps)))),
    pontos.length > 1 ? minigrafico(pontos, cor) : null);
}

/** Os 10 maiores em lista (com opção de ver a lista completa). */
function listaTop(d, cor, recarregar) {
  let completa = false;
  const caixa = el('div');
  const desenhar = () => {
    const linhas = completa ? d.itens : d.itens.slice(0, 10);
    limpar(caixa, painel(completa ? `Todos os conteúdos (${d.itens.length})` : 'Top 10', tabela([
      { titulo: '#', valor: (x) => `${x.posicao}º`, classe: 'num' },
      { titulo: 'Conteúdo', valor: (x) => el('div', { class: 'nome-conteudo' }, logoConteudo(x, 28),
        el('div', {}, el('div', { class: 'forte' }, x.nome), el('div', { class: 'fraco' }, x.catalogado ? rotuloCategoria(x.categoria) : x.asn ? 'ASN fora do catálogo' : ''))) },
      { titulo: 'Volume', valor: (x) => bytes(x.bytes), classe: 'num' },
      { titulo: 'Participação', valor: (x) => el('div', { style: 'min-width:120px' }, pct(x.participacao), el('div', { class: 'barra-uso' }, el('span', { style: `width:${Math.max(1, x.participacao * 100)}%;background:${cor.get(x.chave) ?? 'var(--s-outros)'}` }))) },
      { titulo: 'Média', valor: (x) => bits(x.media_bps), classe: 'num' },
      { titulo: 'Pico', valor: (x) => bits(x.pico_bps), classe: 'num' },
      { titulo: 'Período anterior', valor: (x) => (!d.comparavel ? el('span', { class: 'fraco' }, 'sem histórico') : x.variacao === null ? el('span', { class: 'fraco' }, 'novo') : el('span', { class: x.variacao > 0.15 ? 'forte' : '' },
        `${x.variacao >= 0 ? '▲' : '▼'} ${numero(Math.abs(x.variacao) * 100)}%`)), classe: 'num' },
      { titulo: '', valor: (x) => (x.asn && pode('ddos.configurar') ? el('button', { class: 'botao fantasma pequeno', onclick: (e) => { e.stopPropagation(); catalogar(x, recarregar); } }, 'Catalogar') : '') },
    ], linhas, { vazioTexto: 'Sem flows no período. O consumo por conteúdo começa a aparecer no primeiro minuto de coleta.' }), {
      semCorpo: true,
      acoes: [d.itens.length > 10 ? el('button', { class: 'botao fantasma pequeno', onclick: () => { completa = !completa; desenhar(); } },
        completa ? 'Mostrar só o top 10' : `Ver lista completa (${d.itens.length})`) : null],
      rodape: [el('span', {}, 'Volumes estimados pela amostragem dos roteadores. CDNs compartilhadas (Akamai, Cloudflare, AWS) entregam vários serviços e aparecem pelo nome da CDN.')] }));
  };
  desenhar();
  return caixa;
}

const rotuloCategoria = (c) => ({ video: 'Vídeo e streaming', redes_sociais: 'Redes sociais', jogos: 'Jogos', nuvem_cdn: 'Nuvem e CDN', musica: 'Música', comunicacao: 'Comunicação',
  software: 'Software e atualizações', outros: 'Outros' }[c] ?? c);

/** Diagrama de fluxo (Sankey): conteúdos à esquerda, grupos de clientes à direita, faixas proporcionais ao volume. */
function diagramaFluxo(fluxo, cor) {
  if (!fluxo.length) return vazio('Sem dados no período.');
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const somar = (chave) => [...fluxo.reduce((m, f) => m.set(f[chave], (m.get(f[chave]) ?? 0) + f.bytes), new Map())].sort((a, b) => b[1] - a[1]);
  const esq = somar('origem');
  const dir = somar('grupo_id');
  const nomeEsq = new Map(fluxo.map((f) => [f.origem, f.origem_nome]));
  const nomeDir = new Map(fluxo.map((f) => [f.grupo_id, f.grupo_nome]));
  const total = esq.reduce((a, x) => a + x[1], 0) || 1;
  const L = 760; const A = Math.max(280, Math.max(esq.length, dir.length) * 34); const G = 6; const NW = 12; const XE = 225; const XD = L - 215;
  const escala = (A - G * (Math.max(esq.length, dir.length) - 1)) / total;
  const posicoes = (lista) => { let y = 0; return new Map(lista.map(([k, v]) => { const p = { y, h: Math.max(2, v * escala), usado: 0 }; y += p.h + G; return [k, p]; })); };
  const pe = posicoes(esq);
  const pd = posicoes(dir);
  const svg = s('svg', { viewBox: `0 0 ${L} ${A}`, class: 'fluxo-diagrama', role: 'img', 'aria-label': 'Fluxo do tráfego de cada conteúdo para os grupos de clientes' });
  const ordenado = [...fluxo].sort((a, b) => esq.findIndex((x) => x[0] === a.origem) - esq.findIndex((x) => x[0] === b.origem) || b.bytes - a.bytes);
  for (const f of ordenado) {
    const a = pe.get(f.origem); const b = pd.get(f.grupo_id);
    const h = Math.max(1, f.bytes * escala);
    const y1 = a.y + a.usado; const y2 = b.y + b.usado;
    a.usado += h; b.usado += h;
    const x1 = XE + NW; const x2 = XD; const m = (x1 + x2) / 2;
    const d = `M${x1},${y1}C${m},${y1} ${m},${y2} ${x2},${y2}L${x2},${y2 + h}C${m},${y2 + h} ${m},${y1 + h} ${x1},${y1 + h}Z`;
    const p = s('path', { d, class: 'fita', fill: cor.get(f.origem) ?? 'var(--s-outros)', tabindex: '0' });
    const t = s('title'); t.textContent = `${f.origem_nome} → ${f.grupo_nome}: ${bytes(f.bytes)} (${numero((f.bytes / total) * 100, 1)}%)`;
    p.append(t);
    svg.append(p);
  }
  for (const [k, v] of esq) {
    const p = pe.get(k);
    svg.append(s('rect', { x: XE, y: p.y, width: NW, height: p.h, rx: 3, class: 'no', fill: cor.get(k) ?? 'var(--s-outros)' }));
    const t = s('text', { x: XE - 8, y: p.y + p.h / 2 + 4, 'text-anchor': 'end' }); t.textContent = `${encurtar(nomeEsq.get(k))} · ${numero((v / total) * 100)}%`; svg.append(t);
  }
  for (const [k, v] of dir) {
    const p = pd.get(k);
    svg.append(s('rect', { x: XD, y: p.y, width: NW, height: p.h, rx: 3, class: 'no', fill: 'var(--texto-3)' }));
    const t = s('text', { x: XD + NW + 8, y: p.y + p.h / 2 + 4 }); t.textContent = `${encurtar(nomeDir.get(k))} · ${numero((v / total) * 100)}%`; svg.append(t);
  }
  return svg;
}
const encurtar = (t) => (String(t).length > 26 ? `${String(t).slice(0, 25)}…` : String(t));

function catalogar(x, depois) {
  api.get('/trafego/conteudos').then((c) => formulario(`Catalogar AS${x.asn}`, [
    { nome: 'conteudo_id', rotulo: 'Incluir no conteúdo', tipo: 'select', vazio: 'Criar um conteúdo novo', opcoes: c.itens.map((i) => [i.id, i.nome]), inteiro: true },
    { nome: 'nome', rotulo: 'Nome do conteúdo novo', valor: x.nome.replace(/^AS\d+ · /, ''), inteiro: true },
    { nome: 'categoria', rotulo: 'Categoria', tipo: 'select', vazio: false, valor: 'outros', opcoes: Object.entries(c.categorias) },
  ], { largo: true, rotuloEnviar: 'Catalogar', enviar: async (d) => {
    if (d.conteudo_id) await api.post(`/trafego/conteudos/${d.conteudo_id}/regras`, { tipo: 'asn', valor: x.asn });
    else await api.post('/trafego/conteudos', { nome: d.nome, categoria: d.categoria, regras: [{ tipo: 'asn', valor: x.asn }] });
    toast('Catalogado. O tráfego deste ASN passa a contar no conteúdo a partir do próximo minuto (o histórico continua como estava).');
    depois();
  } }));
}

function novaRegra(x, depois) {
  return formulario(`Reconhecer ${x.nome}`, [
    { nome: 'tipo', rotulo: 'Por', tipo: 'select', vazio: false, opcoes: [['asn', 'ASN'], ['prefixo', 'Prefixo (bloco de IPs)']] },
    { nome: 'valor', rotulo: 'ASN ou prefixo', obrigatorio: true, placeholder: '15169 ou 203.0.113.0/24', ajuda: 'Use prefixo para um cache dentro da sua rede (ex.: o servidor de cache de vídeo) ou um serviço sem ASN próprio.' },
  ], { enviar: async (d) => { await api.post(`/trafego/conteudos/${x.id}/regras`, d); toast('Regra incluída.'); depois(); } });
}

function editarConteudo(x, categorias, depois) {
  return formulario(x ? `Editar ${x.nome}` : 'Novo conteúdo', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: x?.nome, inteiro: true },
    { nome: 'categoria', rotulo: 'Categoria', tipo: 'select', vazio: false, valor: x?.categoria ?? 'outros', opcoes: Object.entries(categorias) },
    { nome: 'marca', rotulo: 'Logo', tipo: 'select', vazio: 'Iniciais do nome', valor: x?.marca ?? '', opcoes: Object.entries(MARCAS).map(([k, m]) => [k, m.titulo]) },
    !x ? { nome: 'asn', rotulo: 'ASN (opcional)', placeholder: '2906' } : null,
    x ? { nome: 'ativo', rotulo: 'Ativo', tipo: 'checkbox', valor: x.ativo } : null,
  ], { largo: true, enviar: async (d) => {
    if (x) await api.patch(`/trafego/conteudos/${x.id}`, { ...d, marca: d.marca || null });
    else await api.post('/trafego/conteudos', { nome: d.nome, categoria: d.categoria, marca: d.marca || null, regras: d.asn ? [{ tipo: 'asn', valor: d.asn }] : [] });
    toast('Conteúdo salvo.');
    depois();
  } });
}

