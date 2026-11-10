import { api, qs, baixar } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, paginacao, abas, etqDe, etq, rotulo, opcoes, dataHora, desde, hora, dl, toast, carregar, carregando, formulario,
  pedirMotivo, botao, faixa, stat, vazio, bits, pacotes, bytes, valorMetrica, numero, modal, confirmar, duracaoMin } from '../ui.js';
import { graficoLinhas } from '../grafico.js';

const NOMES_PROTO = { 1: 'ICMP', 6: 'TCP', 17: 'UDP', 47: 'GRE', 58: 'ICMPv6' };
const proto = (k) => { const [p, porta] = String(k).split('/'); return `${NOMES_PROTO[p] ?? `Proto ${p}`}${porta !== undefined ? ` ${porta}` : ''}`; };
const EVENTOS = { inicio: 'Ataque detectado', fim: 'Ataque encerrado', encerrado_manual: 'Encerrado manualmente', mitigacao_ativa: 'Bloqueio ativado',
  mitigacao_aguardando_aprovacao: 'Bloqueio aguardando aprovação', mitigacao_aprovada: 'Bloqueio aprovado', mitigacao_recusada: 'Bloqueio recusado',
  mitigacao_retirada: 'Bloqueio retirado', mitigacao_bloqueada: 'Bloqueio impedido pelas proteções', mitigacao_prorrogada: 'Bloqueio prorrogado',
  mitigacao_estendida: 'Prazo do bloqueio estendido', mitigacao_erro: 'Bloqueio não gerado', comentario: 'Comentário' };

export default async function ddos({ alvo, params, query, ir, aoSair }) {
  if (params[0] === 'ataque' && params[1]) return detalhe(alvo, Number(params[1]), ir, aoSair);
  const lista = [['painel', 'Painel'], ['externo', 'Externo'], ['saida', 'Saindo da rede'], ['bloqueios', 'Bloqueios'], ['grupos', 'Grupos e limites'],
    ['nunca', 'Nunca bloquear'], ['config', 'Configuração']];
  let aba = query.aba ?? 'painel';
  const corpo = el('div');
  const barra = el('div');
  let timer = null;
  aoSair(() => clearInterval(timer));
  const trocar = (id) => { aba = id; clearInterval(timer); barra.replaceChildren(abas(lista, aba, trocar)); TELAS[aba](); };
  limpar(alvo, cabecalho({ sobretitulo: 'Tráfego e segurança', titulo: 'Anti-DDoS',
    descricao: 'Ataques detectados nos flows a cada 5 s (médias de 5, 10 e 60 s), bloqueio por BGP com aprovação e as proteções: lista "nunca bloquear", limite de ações e retirada automática.',
    acoes: [pode('ddos.operar') ? botao('Bloquear IP', () => novoBloqueio(() => trocar('bloqueios')), { ic: 'escudo', tipo: 'secundario' }) : null] }), barra, corpo);

  const listaAtaques = (direcao) => (filtro = { status: 'todos', pagina: 1 }) => {
    const sel = el('select', { 'aria-label': 'Situação' }, [['todos', 'Todos'], ['ativos', 'Em andamento'], ['encerrados', 'Encerrados']]
      .map(([v, r]) => el('option', { value: v, selected: v === filtro.status }, r)));
    sel.addEventListener('change', () => listaAtaques(direcao)({ ...filtro, status: sel.value, pagina: 1 }));
    const area = el('div');
    limpar(corpo, el('div', { class: 'filtros' }, sel), area);
    carregar(area, () => api.get(`/ddos/ataques${qs({ ...filtro, direcao })}`), (l) => painel(null, el('div', {}, tabelaAtaques(l.itens, ir,
      direcao === 'saida' ? 'Nenhum assinante ou equipamento atacando para fora foi registrado.' : 'Nenhum ataque registrado.'),
    paginacao(l, (p) => listaAtaques(direcao)({ ...filtro, pagina: p }))), { semCorpo: true }));
  };

  const TELAS = {
    painel: () => {
      const atualizar = () => carregar(corpo, () => Promise.all([api.get('/ddos/resumo'), api.get('/ddos/mitigacoes?status=vigentes&por_pagina=20')]), ([r, m]) => {
        const n = (s) => r.mitigacoes.find((x) => x.status === s)?.n ?? 0;
        const h24 = (d) => r.ultimas_24h.find((x) => x.direcao === d)?.n ?? 0;
        const borda = r.exportadores.filter((e) => e.papel === 'borda' && e.ativo);
        return el('div', {},
          !borda.length ? faixa(el('span', {}, 'Nenhum roteador de borda cadastrado: a detecção depende dos flows. ', pode('ddos.configurar') ? el('a', { href: '#/fontes' }, 'Cadastrar roteador') : null), 'info') : null,
          borda.some((e) => e.estado !== 'conectada') ? faixa(`Sem flows recentes de ${borda.filter((e) => e.estado !== 'conectada').map((e) => e.nome).join(', ')}: a detecção desses roteadores está parada.`, 'erro', 'alerta') : null,
          !r.grupos ? faixa(el('span', {}, 'Nenhum grupo de IPs protegido. ', pode('ddos.configurar') ? el('button', { class: 'botao fantasma pequeno', onclick: () => trocar('grupos') }, 'Cadastrar os blocos do provedor') : null), 'info') : null,
          el('div', { class: 'stats' },
            stat({ rotulo: 'Ataques em andamento', ic: 'raio', valor: String(r.ativos.length), nota: `${r.ativos.filter((a) => a.severidade === 'critica').length} crítico(s)`, notaTipo: r.ativos.length ? 'erro' : 'neutra',
              fonte: `Atualizado às ${hora(r.gerado_em)}` }),
            stat({ rotulo: 'Últimas 24 h', ic: 'alerta', valor: String(h24('entrada') + h24('saida')), nota: `${h24('entrada')} de fora · ${h24('saida')} saindo da rede`, notaTipo: 'neutra' }),
            stat({ rotulo: 'Bloqueios ativos', ic: 'escudo', valor: String(n('ativa')), nota: `${n('aguardando_aprovacao')} aguardando aprovação`, notaTipo: n('aguardando_aprovacao') ? 'aviso' : 'neutra' }),
            stat({ rotulo: 'Entrada agora', ic: 'grafico', valor: r.trafego.entrada ? bits(r.trafego.entrada.bps) : '—', semDado: !r.trafego.entrada,
              nota: r.trafego.saida ? `${bits(r.trafego.saida.bps)} de saída` : 'Sem medição no último minuto', notaTipo: 'neutra' })),
          el('div', { class: 'grade principal-lateral' },
            painel('Ataques em andamento', tabelaAtaques(r.ativos, ir, 'Nenhum ataque em andamento.'), { semCorpo: true }),
            painel('Bloqueios vigentes', m.itens.length ? el('div', { class: 'lista-bloqueios' }, m.itens.map((x) => cartaoBloqueio(x, atualizar)))
              : vazio('Nenhum bloqueio ativo ou pendente.'), { acoes: [el('button', { class: 'botao fantasma pequeno', onclick: () => trocar('bloqueios') }, 'Ver todos', icone('seta'))] })));
      });
      atualizar();
      timer = setInterval(atualizar, 15_000);
    },
    externo: listaAtaques('entrada'),
    saida: listaAtaques('saida'),
    bloqueios: (filtro = { status: 'vigentes', pagina: 1 }) => {
      const sel = el('select', { 'aria-label': 'Situação' }, [['vigentes', 'Ativos e pendentes'], ['ativa', 'Ativos'], ['aguardando_aprovacao', 'Aguardando aprovação'],
        ['bloqueada', 'Impedidos pelas proteções'], ['retirada', 'Retirados'], ['recusada', 'Recusados'], ['todas', 'Todos']].map(([v, r]) => el('option', { value: v, selected: v === filtro.status }, r)));
      sel.addEventListener('change', () => TELAS.bloqueios({ status: sel.value, pagina: 1 }));
      const area = el('div');
      limpar(corpo, el('div', { class: 'filtros' }, sel), area);
      carregar(area, () => api.get(`/ddos/mitigacoes${qs(filtro)}`), (l) => painel(null, el('div', {}, tabela([
        { titulo: 'Ação', valor: (x) => el('div', {}, el('div', { class: 'forte' }, x.descricao), el('div', { class: 'fraco' },
          [x.ataque_numero ? `ataque #${x.ataque_numero}` : 'pedido manual', x.origem === 'automatica' ? 'automática' : x.solicitante].filter(Boolean).join(' · '))) },
        { titulo: 'Situação', valor: (x) => el('div', {}, etqDe('statusMitigacao', x.status), x.motivo && x.status === 'bloqueada' ? el('div', { class: 'fraco' }, x.motivo) : null) },
        { titulo: 'Aprovado por', valor: (x) => x.aprovador ?? (x.origem === 'automatica' && x.ativada_em ? 'Automático' : '—') },
        { titulo: 'Vigência', valor: (x) => (x.ativada_em ? el('div', {}, `${dataHora(x.ativada_em)} →`, el('div', { class: 'fraco' }, x.retirada_em ? `${dataHora(x.retirada_em)} (${x.retirado_por ?? 'automático'})` : `expira ${dataHora(x.expira_em)}`)) : '—') },
        { titulo: '', valor: (x) => acoesBloqueio(x, () => TELAS.bloqueios(filtro)) },
      ], l.itens, { vazioTexto: 'Nenhum bloqueio.' }), paginacao(l, (p) => TELAS.bloqueios({ ...filtro, pagina: p }))), { semCorpo: true,
        rodape: [el('span', {}, 'O Manager Network não entra nos roteadores: o ExaBGP do provedor lê os anúncios ativos e os aplica na sessão BGP (Fontes e avisos → BGP).')] }));
    },
    grupos: () => carregar(corpo, () => api.get('/ddos/grupos'), (gs) => el('div', {},
      pode('ddos.configurar') ? el('div', { class: 'filtros' }, botao('Novo grupo', () => editarGrupo(null, () => TELAS.grupos()), { ic: 'mais', tipo: 'secundario' })) : null,
      gs.length ? gs.map((g) => painelGrupo(g, () => TELAS.grupos())) : vazio('Nenhum grupo de IPs.', 'Cadastre os blocos do provedor (ex.: Clientes residenciais, Corporativos, Servidores) com os limites de cada um.'))),
    nunca: () => carregar(corpo, () => api.get('/ddos/nunca-bloquear'), (l) => painel('Nunca bloquear', tabela([
      { titulo: 'IP ou bloco', valor: (x) => el('span', { class: 'forte' }, x.prefixo) }, { titulo: 'Motivo', valor: (x) => x.motivo },
      { titulo: 'Incluído', valor: (x) => `${dataHora(x.criado_em)} · ${x.criado_por_nome ?? '—'}` },
      { titulo: '', valor: (x) => (pode('ddos.configurar') ? el('button', { class: 'botao fantasma pequeno', onclick: () => pedirMotivo('Remover da lista', 'Motivo da remoção',
        async (m) => { await api.post(`/ddos/nunca-bloquear/${x.id}/remover`, { motivo: m }); toast('Removido.'); TELAS.nunca(); }) }, 'Remover') : '') },
    ], l, { vazioTexto: 'Lista vazia. Inclua os DNS do provedor, a gerência, o next-hop de blackhole e clientes que não podem ser bloqueados.' }), {
      semCorpo: true,
      acoes: [pode('ddos.configurar') ? botao('Incluir', () => formulario('Nunca bloquear', [
        { nome: 'prefixo', rotulo: 'IP ou bloco', obrigatorio: true, placeholder: '203.0.113.53 ou 203.0.113.0/28', inteiro: true },
        { nome: 'motivo', rotulo: 'Motivo', obrigatorio: true, placeholder: 'DNS recursivo do provedor', inteiro: true }],
      { enviar: async (d) => { const r = await api.post('/ddos/nunca-bloquear', d); toast(r.acoes_retiradas?.length ? `Incluído. ${r.acoes_retiradas.length} bloqueio(s) ativo(s) retirado(s).` : 'Incluído.'); TELAS.nunca(); } }),
      { ic: 'mais', tipo: 'secundario pequeno' }) : null],
      rodape: [el('span', {}, 'Nenhuma ação (automática ou manual) é ativada se atingir um item da lista. Bloqueios ativos que passarem a atingir a lista são retirados na hora.')] })),
    config: () => carregar(corpo, () => Promise.all([api.get('/ddos/config'), api.get('/ddos/bgp')]), ([c, bgp]) => el('div', { class: 'grade duas' },
      painel('Detecção e proteções', dl([
        ['Confirmação', `${c.confirmacoes} avaliação(ões) seguidas (a cada 5 s)`], ['Encerramento', `${c.encerrar_apos_s} s abaixo de ${Math.round(c.fator_recuperacao * 100)}% do limite`],
        ['Ações simultâneas', `no máximo ${c.max_acoes_simultaneas}`], ['Duração do bloqueio', `${c.duracao_padrao_min} min (máximo ${c.max_duracao_min} min)`],
        ['Retenção', `${c.retencao_minuto_dias} dias por minuto · ${c.retencao_hora_dias} dias por hora · sessões ${c.retencao_sessoes_dias} dias`]]),
      { acoes: [pode('ddos.configurar') ? botao('Editar', () => editarConfig(c, () => TELAS.config()), { tipo: 'secundario pequeno' }) : null],
        rodape: [el('span', {}, 'Sessões por pelo menos 1 ano: o Marco Civil da Internet exige guardar os registros de conexão.')] }),
      painel('Sessão BGP (ExaBGP)', el('div', {}, dl([
        ['Blackhole', `next-hop ${c.bgp_next_hop_blackhole} / ${c.bgp_next_hop_blackhole_v6} · community ${c.bgp_community_blackhole}`],
        ['Limpeza em linha', c.bgp_next_hop_limpeza ? `next-hop ${c.bgp_next_hop_limpeza}${c.bgp_community_limpeza ? ` · community ${c.bgp_community_limpeza}` : ''} · /${c.limpeza_prefixo_v4} e /${c.limpeza_prefixo_v6}` : 'Não configurada'],
        ['FlowSpec', c.flowspec_acao === 'discard' ? 'Descartar o tráfego do ataque' : `Limitar a ${bits(c.flowspec_taxa_bps)}`],
        ['Anúncios ativos', String(bgp.anuncios.length)]]),
      bgp.anuncios.length ? el('div', { style: 'margin-top:12px;display:grid;gap:6px' }, bgp.anuncios.map((a) => el('code', { class: 'comando' }, a.anunciar))) : null),
      { rodape: [el('span', {}, 'Instalação do ExaBGP e token de leitura: Fontes e avisos → BGP.')] }))),
  };
  trocar(lista.some(([id]) => id === aba) ? aba : 'painel');
}

function tabelaAtaques(itens, ir, vazioTexto) {
  return tabela([
    { titulo: 'Ataque', valor: (a) => el('div', {}, el('div', { class: 'forte' }, `#${a.numero} · ${a.alvo_tipo === 'grupo' ? `grupo ${a.grupo_nome ?? ''}` : a.alvo}`),
      el('div', { class: 'fraco' }, [a.vetor, a.alvo_tipo === 'ip' ? a.grupo_nome : null].filter(Boolean).join(' · '))) },
    { titulo: 'Direção', valor: (a) => etqDe('direcaoAtaque', a.direcao) },
    { titulo: 'Severidade', valor: (a) => etqDe('severidade', a.severidade) },
    { titulo: 'Pico', valor: (a) => el('div', {}, bits(a.pico_bps), el('div', { class: 'fraco' }, pacotes(a.pico_pps))), classe: 'num' },
    { titulo: 'Início', valor: (a) => el('div', {}, dataHora(a.inicio), el('div', { class: 'fraco' }, a.status === 'ativo' ? desde(a.inicio) : `fim ${hora(a.fim)}`)) },
    { titulo: 'Situação', valor: (a) => el('div', {}, etqDe('statusAtaque', a.status), a.mitigacoes_ativas ? el('div', { class: 'fraco' }, `${a.mitigacoes_ativas} bloqueio(s) ativo(s)`) : null) },
  ], itens, { vazioTexto, aoClicar: (a) => ir(`#/ddos/ataque/${a.id}`) });
}

function acoesBloqueio(x, depois, alinhar = 'flex-end') {
  if (!pode('ddos.operar')) return '';
  const acoes = [];
  if (x.status === 'aguardando_aprovacao') {
    acoes.push(el('button', { class: 'botao pequeno', onclick: async () => {
      if (!await confirmar('Aprovar bloqueio', `${x.descricao}. O ExaBGP vai anunciar a regra e o tráfego será ${x.tipo === 'limpeza' ? 'desviado para a limpeza' : 'bloqueado'} por ${x.duracao_min} min.`, 'Aprovar')) return;
      try { await api.post(`/ddos/mitigacoes/${x.id}/aprovar`, { versao: x.versao }); toast('Bloqueio ativado.'); } catch (err) { toast(err.message, true); }
      depois();
    } }, 'Aprovar'));
    acoes.push(el('button', { class: 'botao fantasma pequeno', onclick: () => pedirMotivo('Recusar bloqueio', 'Motivo', async (m) => { await api.post(`/ddos/mitigacoes/${x.id}/recusar`, { motivo: m, versao: x.versao }); depois(); }) }, 'Recusar'));
  }
  if (x.status === 'ativa') {
    acoes.push(el('button', { class: 'botao fantasma pequeno', onclick: () => formulario('Prorrogar bloqueio', [{ nome: 'minutos', rotulo: 'Mais quantos minutos', tipo: 'number', valor: 30, obrigatorio: true }],
      { enviar: async (d) => { await api.post(`/ddos/mitigacoes/${x.id}/prorrogar`, { minutos: Number(d.minutos) }); toast('Prazo prorrogado.'); depois(); } }) }, 'Prorrogar'));
    acoes.push(el('button', { class: 'botao perigo pequeno', onclick: () => pedirMotivo('Retirar bloqueio', 'Motivo', async (m) => { await api.post(`/ddos/mitigacoes/${x.id}/retirar`, { motivo: m, versao: x.versao }); toast('Bloqueio retirado.'); depois(); }) }, 'Retirar'));
  }
  if (['ativa', 'aguardando_aprovacao'].includes(x.status)) {
    acoes.push(el('button', { class: 'botao fantasma pequeno', title: 'Comandos BGP', onclick: () => modal('Comandos BGP (ExaBGP)', (fechar) => [
      el('p', { class: 'fraco' }, 'Anunciar:'), el('code', { class: 'comando' }, x.comandos.anunciar), el('p', { class: 'fraco', style: 'margin-top:10px' }, 'Retirar:'), el('code', { class: 'comando' }, x.comandos.retirar),
      el('div', { class: 'form-acoes' }, el('button', { class: 'botao', onclick: () => fechar() }, 'Fechar'))]) }, 'BGP'));
  }
  return el('div', { style: `display:flex;gap:6px;flex-wrap:wrap;justify-content:${alinhar}` }, acoes);
}

function cartaoBloqueio(x, depois) {
  return el('div', { class: 'item-bloqueio', style: 'border-bottom:1px solid var(--borda);padding:10px 0;display:grid;gap:6px' },
    el('div', {}, el('div', { class: 'forte' }, x.descricao), el('div', { class: 'fraco' }, x.status === 'ativa' ? `Ativo desde ${hora(x.ativada_em)} · expira ${hora(x.expira_em)}`
      : `Pedido ${desde(x.solicitada_em)}${x.ataque_numero ? ` · ataque #${x.ataque_numero}` : ''}`)),
    el('div', {}, etqDe('statusMitigacao', x.status)), acoesBloqueio(x, depois, 'flex-start'));
}

function novoBloqueio(depois) {
  return formulario('Bloquear IP', [
    { nome: 'alvo', rotulo: 'IP ou bloco', obrigatorio: true, placeholder: '203.0.113.10', inteiro: true },
    { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', vazio: false, opcoes: opcoes('tipoMitigacao'), ajuda: 'Blackhole descarta TODO o tráfego do IP; FlowSpec só o que casa com a regra; limpeza desvia o bloco.' },
    { nome: 'protocolo', rotulo: 'FlowSpec: protocolo', tipo: 'select', vazio: 'Qualquer', opcoes: [[17, 'UDP'], [6, 'TCP'], [1, 'ICMP']] },
    { nome: 'porta_origem', rotulo: 'FlowSpec: porta de origem', tipo: 'number', placeholder: '53' },
    { nome: 'duracao_min', rotulo: 'Duração (min)', tipo: 'number', placeholder: 'padrão da configuração' },
    { nome: 'motivo', rotulo: 'Motivo', obrigatorio: true, inteiro: true },
  ], { largo: true, rotuloEnviar: 'Bloquear', enviar: async (d) => {
    const r = await api.post('/ddos/mitigacoes', { ...d, protocolo: d.protocolo || undefined, porta_origem: d.porta_origem === '' ? undefined : d.porta_origem, duracao_min: d.duracao_min || undefined });
    toast(r.status === 'bloqueada' ? `Não ativado: ${r.motivo}` : r.existente ? 'Já havia um bloqueio igual vigente.' : 'Bloqueio ativado.', r.status === 'bloqueada');
    depois();
  } });
}

function painelGrupo(g, depois) {
  const conf = pode('ddos.configurar');
  return painel(g.nome, el('div', {},
    el('p', { class: 'fraco', style: 'margin-bottom:10px' }, `${g.descricao ? `${g.descricao} · ` : ''}Ao detectar ataque: ${rotulo('modoMitigacao', g.mitigacao_modo)}${g.mitigacao_modo !== 'desligada' ? ` (${rotulo('tipoMitigacao', g.mitigacao_tipo)}${g.mitigacao_duracao_min ? `, ${g.mitigacao_duracao_min} min` : ''})` : ''}${g.ativo ? '' : ' · GRUPO DESATIVADO'}`),
    el('div', { class: 'filtros', style: 'margin-bottom:12px' }, g.prefixos.length ? g.prefixos.map((p) => el('span', { class: 'etq neutra sem-ponto' }, p.prefixo,
      conf ? el('button', { class: 'botao-icone', style: 'width:20px;height:20px;border:0', 'aria-label': `Remover ${p.prefixo}`, onclick: async () => {
        if (await confirmar('Remover bloco', `${p.prefixo} deixa de ser protegido e medido neste grupo.`, 'Remover')) { await api.post(`/ddos/grupos/${g.id}/prefixos/${p.id}/remover`, {}); depois(); } } }, icone('fechar')) : null))
      : el('span', { class: 'fraco' }, 'Sem blocos: cadastre os prefixos do grupo.'),
    conf ? el('button', { class: 'botao fantasma pequeno', onclick: () => formulario(`Bloco em ${g.nome}`, [{ nome: 'prefixo', rotulo: 'Prefixo', obrigatorio: true, placeholder: '203.0.113.0/24 ou 2001:db8:100::/40', inteiro: true }],
      { enviar: async (d) => { await api.post(`/ddos/grupos/${g.id}/prefixos`, d); depois(); } }) }, icone('mais'), 'Bloco') : null),
    tabela([
      { titulo: 'Limite', valor: (l) => el('div', {}, el('div', { class: 'forte' }, `${rotulo('metricaDdos', l.metrica)} > ${valorMetrica(l.metrica, l.limite)}`),
        el('div', { class: 'fraco' }, `${rotulo('escopoLimite', l.escopo)} · ${l.direcao === 'entrada' ? 'entrada' : 'saída'} · média de ${l.janela_s} s`)) },
      { titulo: 'Severidade', valor: (l) => etqDe('severidade', l.severidade) },
      { titulo: 'Situação', valor: (l) => (l.ativo ? etq('Ativo', 'ok') : etq('Desligado', 'neutra')) },
    ], g.limites, { vazioTexto: 'Sem limites: o grupo é medido, mas nenhum ataque é detectado.', aoClicar: conf ? (l) => editarLimite(g, l, depois) : null })),
  { acoes: conf ? [botao('Limite', () => editarLimite(g, null, depois), { ic: 'mais', tipo: 'secundario pequeno' }),
    !g.limites.length ? botao('Usar limites sugeridos', async () => { const r = await api.post(`/ddos/grupos/${g.id}/limites-sugeridos`, {}); toast(`${r.criados} limite(s) criado(s). Ajuste ao tráfego normal da sua rede.`); depois(); }, { tipo: 'secundario pequeno' }) : null,
    botao('Editar', () => editarGrupo(g, depois), { tipo: 'secundario pequeno' })] : [] });
}

function editarGrupo(g, depois) {
  return formulario(g ? `Editar ${g.nome}` : 'Novo grupo de IPs', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: g?.nome, placeholder: 'Clientes residenciais', inteiro: true },
    { nome: 'descricao', rotulo: 'Descrição', valor: g?.descricao, inteiro: true },
    !g ? { nome: 'prefixos', rotulo: 'Blocos (um por linha)', tipo: 'textarea', placeholder: '203.0.113.0/24\n2001:db8:100::/40', inteiro: true } : null,
    { nome: 'mitigacao_modo', rotulo: 'Ao detectar ataque', tipo: 'select', vazio: false, valor: g?.mitigacao_modo ?? 'manual', opcoes: opcoes('modoMitigacao') },
    { nome: 'mitigacao_tipo', rotulo: 'Tipo de bloqueio', tipo: 'select', vazio: false, valor: g?.mitigacao_tipo ?? 'flowspec', opcoes: opcoes('tipoMitigacao') },
    { nome: 'mitigacao_duracao_min', rotulo: 'Duração do bloqueio (min)', tipo: 'number', valor: g?.mitigacao_duracao_min, placeholder: 'padrão da configuração' },
    g ? { nome: 'ativo', rotulo: 'Grupo ativo', tipo: 'checkbox', valor: g.ativo } : null,
  ], { largo: true, enviar: async (d) => {
    const corpo = { ...d, mitigacao_duracao_min: d.mitigacao_duracao_min || null };
    if (g) await api.patch(`/ddos/grupos/${g.id}`, { ...corpo, versao: g.versao });
    else await api.post('/ddos/grupos', { ...corpo, prefixos: (d.prefixos ?? '').split(/\s+/).filter(Boolean) });
    toast('Grupo salvo.');
    depois();
  } });
}

function editarLimite(g, l, depois) {
  return formulario(l ? 'Editar limite' : `Novo limite em ${g.nome}`, [
    { nome: 'direcao', rotulo: 'Direção', tipo: 'select', vazio: false, valor: l?.direcao ?? 'entrada', opcoes: [['entrada', 'Entrada (ataque de fora)'], ['saida', 'Saída (assinante atacando)']] },
    { nome: 'escopo', rotulo: 'Vale para', tipo: 'select', vazio: false, valor: l?.escopo ?? 'ip', opcoes: opcoes('escopoLimite') },
    { nome: 'metrica', rotulo: 'Métrica', tipo: 'select', vazio: false, valor: l?.metrica ?? 'bps', opcoes: opcoes('metricaDdos') },
    { nome: 'limite', rotulo: 'Limite', tipo: 'decimal', obrigatorio: true, valor: l?.limite, ajuda: 'Em bits/s ou pacotes/s. Ex.: 1000000000 = 1 Gbps.' },
    { nome: 'janela_s', rotulo: 'Média de', tipo: 'select', vazio: false, valor: l?.janela_s ?? 10, opcoes: [[5, '5 segundos'], [10, '10 segundos'], [60, '60 segundos']] },
    { nome: 'severidade', rotulo: 'Severidade', tipo: 'select', vazio: false, valor: l?.severidade ?? 'alta', opcoes: opcoes('severidade') },
    l ? { nome: 'ativo', rotulo: 'Limite ativo', tipo: 'checkbox', valor: l.ativo } : null,
  ], { largo: true, enviar: async (d) => {
    const corpo = { ...d, limite: d.limite.replace(/\./g, '').replace(',', '.'), janela_s: Number(d.janela_s) };
    await (l ? api.patch(`/ddos/limites/${l.id}`, corpo) : api.post(`/ddos/grupos/${g.id}/limites`, corpo));
    toast('Limite salvo.');
    depois();
  } });
}

function editarConfig(c, depois) {
  return formulario('Configuração do Anti-DDoS', [
    { tipo: 'secao', rotulo: 'Detecção' },
    { nome: 'confirmacoes', rotulo: 'Avaliações para confirmar', tipo: 'number', valor: c.confirmacoes, ajuda: 'Cada avaliação a cada 5 s.' },
    { nome: 'encerrar_apos_s', rotulo: 'Encerrar após (s) normalizado', tipo: 'number', valor: c.encerrar_apos_s },
    { nome: 'fator_recuperacao', rotulo: 'Normalizado abaixo de (fração do limite)', tipo: 'decimal', valor: String(c.fator_recuperacao).replace('.', ',') },
    { tipo: 'secao', rotulo: 'Proteções' },
    { nome: 'max_acoes_simultaneas', rotulo: 'Ações simultâneas (máx.)', tipo: 'number', valor: c.max_acoes_simultaneas },
    { nome: 'duracao_padrao_min', rotulo: 'Duração padrão (min)', tipo: 'number', valor: c.duracao_padrao_min },
    { nome: 'max_duracao_min', rotulo: 'Duração máxima (min)', tipo: 'number', valor: c.max_duracao_min },
    { tipo: 'secao', rotulo: 'BGP' },
    { nome: 'bgp_next_hop_blackhole', rotulo: 'Next-hop do blackhole (IPv4)', valor: c.bgp_next_hop_blackhole },
    { nome: 'bgp_next_hop_blackhole_v6', rotulo: 'Next-hop do blackhole (IPv6)', valor: c.bgp_next_hop_blackhole_v6 },
    { nome: 'bgp_community_blackhole', rotulo: 'Community do blackhole', valor: c.bgp_community_blackhole, ajuda: 'RFC 7999: 65535:666. Confirme com a operadora de trânsito.' },
    { nome: 'bgp_next_hop_limpeza', rotulo: 'Next-hop da limpeza em linha', valor: c.bgp_next_hop_limpeza ?? '' },
    { nome: 'bgp_community_limpeza', rotulo: 'Community da limpeza', valor: c.bgp_community_limpeza ?? '' },
    { nome: 'limpeza_prefixo_v4', rotulo: 'Bloco desviado IPv4 (/)', tipo: 'number', valor: c.limpeza_prefixo_v4 },
    { nome: 'limpeza_prefixo_v6', rotulo: 'Bloco desviado IPv6 (/)', tipo: 'number', valor: c.limpeza_prefixo_v6 },
    { nome: 'flowspec_acao', rotulo: 'FlowSpec', tipo: 'select', vazio: false, valor: c.flowspec_acao, opcoes: [['discard', 'Descartar'], ['rate-limit', 'Limitar a uma taxa']] },
    { nome: 'flowspec_taxa_bps', rotulo: 'Taxa do FlowSpec (bits/s)', tipo: 'number', valor: c.flowspec_taxa_bps ?? '' },
    { tipo: 'secao', rotulo: 'Retenção (dias)' },
    { nome: 'retencao_minuto_dias', rotulo: 'Detalhe por minuto', tipo: 'number', valor: c.retencao_minuto_dias },
    { nome: 'retencao_hora_dias', rotulo: 'Resumo por hora', tipo: 'number', valor: c.retencao_hora_dias },
    { nome: 'retencao_sessoes_dias', rotulo: 'Sessões (mín. 366)', tipo: 'number', valor: c.retencao_sessoes_dias },
  ], { largo: true, enviar: async (d) => {
    const num = (k) => (d[k] === '' ? null : Number(d[k]));
    await api.put('/ddos/config', { ...d, versao: c.versao, fator_recuperacao: d.fator_recuperacao.replace(',', '.'),
      ...Object.fromEntries(['confirmacoes', 'encerrar_apos_s', 'max_acoes_simultaneas', 'duracao_padrao_min', 'max_duracao_min', 'limpeza_prefixo_v4', 'limpeza_prefixo_v6',
        'flowspec_taxa_bps', 'retencao_minuto_dias', 'retencao_hora_dias', 'retencao_sessoes_dias'].map((k) => [k, num(k)])) });
    toast('Configuração salva.');
    depois();
  } });
}

async function detalhe(alvo, id, ir, aoSair) {
  const recarregar = () => detalhe(alvo, id, ir, aoSair);
  limpar(alvo, carregando());
  let a;
  try { a = await api.get(`/ddos/ataques/${id}`); } catch (err) { limpar(alvo, el('div', { class: 'falha' }, err.message)); return; }
  if (a.status === 'ativo') { const t = setTimeout(recarregar, 15_000); aoSair(() => clearTimeout(t)); }
  const total = a.total_bytes || a.origens.reduce((s, o) => s + o.bytes, 0) || 1;
  const pct = (b) => `${numero((b / total) * 100, 1)}%`;
  const barra = (b) => el('div', { class: 'barra-uso', title: pct(b) }, el('span', { style: `width:${Math.min(100, (b / total) * 100)}%` }));
  const detalheEvento = (d) => {
    if (!d) return '';
    try { const x = JSON.parse(d); return x.descricao ?? x.motivo ?? (x.medido ? `${valorMetrica(x.metrica, x.medido)} acima de ${valorMetrica(x.metrica, x.limite)} (média de ${x.janela_s} s)` : ''); } catch { return d; }
  };
  limpar(alvo,
    el('a', { href: `#/ddos?aba=${a.direcao === 'saida' ? 'saida' : 'externo'}`, class: 'botao fantasma pequeno', style: 'margin-bottom:10px' }, icone('voltar'), 'Anti-DDoS'),
    cabecalho({ sobretitulo: `Ataque #${a.numero} · ${rotulo('direcaoAtaque', a.direcao)}`, titulo: `${a.vetor ?? 'Ataque'} em ${a.alvo_tipo === 'grupo' ? `grupo ${a.grupo?.nome ?? ''}` : a.alvo}`,
      descricao: `Início ${dataHora(a.inicio)}${a.fim ? ` · fim ${dataHora(a.fim)}` : ' · em andamento'}`,
      acoes: [
        botao('Relatório PDF', () => baixar(`/ddos/ataques/${a.id}/pdf`, `ataque-${a.numero}.pdf`), { ic: 'arquivo', tipo: 'secundario' }),
        a.alvo_tipo === 'ip' ? el('a', { class: 'botao secundario', href: `#/trafego/ip/${encodeURIComponent(a.alvo)}` }, icone('grafico'), 'Ficha do IP') : null,
        pode('ddos.operar') && a.alvo_tipo === 'ip' && a.direcao === 'entrada' ? botao('Bloquear', () => formulario('Bloquear o alvo', [
          { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', vazio: false, valor: a.grupo?.mitigacao_tipo ?? 'flowspec', opcoes: opcoes('tipoMitigacao'),
            ajuda: 'FlowSpec usa o vetor detectado (protocolo e porta de origem). Blackhole descarta todo o tráfego do IP.' },
          { nome: 'duracao_min', rotulo: 'Duração (min)', tipo: 'number', placeholder: 'padrão' }],
        { rotuloEnviar: 'Bloquear', enviar: async (d) => { const r = await api.post(`/ddos/ataques/${a.id}/mitigar`, { tipo: d.tipo, duracao_min: d.duracao_min || undefined });
          toast(r.status === 'bloqueada' ? `Não ativado: ${r.motivo}` : 'Bloqueio ativado.', r.status === 'bloqueada'); recarregar(); } }), { ic: 'escudo' }) : null,
        pode('ddos.operar') ? botao('Comentar', () => formulario('Comentário', [{ nome: 'texto', rotulo: 'Comentário', tipo: 'textarea', obrigatorio: true, inteiro: true }],
          { enviar: async (d) => { await api.post(`/ddos/ataques/${a.id}/comentar`, d); recarregar(); } }), { tipo: 'secundario' }) : null,
        pode('ddos.operar') && a.status === 'ativo' ? botao('Encerrar', () => pedirMotivo('Encerrar ataque', 'Motivo', async (m) => { await api.post(`/ddos/ataques/${a.id}/encerrar`, { motivo: m }); recarregar(); },
          { ajuda: 'Se o tráfego continuar acima do limite, a detecção abre um novo ataque.' }), { tipo: 'perigo' }) : null] }),
    a.direcao === 'saida' && a.assinante ? faixa(`Assinante no início do ataque: ${a.assinante.login}${a.assinante.mac ? ` (${a.assinante.mac})` : ''} · NAS ${a.assinante.nas_ip}.`, '', 'equipe') : null,
    el('div', { class: 'stats' },
      stat({ rotulo: 'Pico', ic: 'sinal', valor: bits(a.pico_bps), nota: pacotes(a.pico_pps), notaTipo: 'neutra' }),
      stat({ rotulo: a.status === 'ativo' ? 'Agora' : 'Duração', ic: 'relogio', valor: a.status === 'ativo' ? bits(a.atual_bps) : duracaoMin((Date.parse(a.fim) - Date.parse(a.inicio)) / 60_000),
        nota: a.status === 'ativo' ? pacotes(a.atual_pps) : `${dataHora(a.inicio)} → ${hora(a.fim)}`, notaTipo: 'neutra' }),
      stat({ rotulo: 'Limite violado', ic: 'alerta', valor: valorMetrica(a.metrica, a.limite), nota: `${rotulo('metricaDdos', a.metrica)} · média de ${a.janela_s} s`, notaTipo: 'neutra' }),
      stat({ rotulo: a.direcao === 'saida' ? 'Destinos distintos' : 'Origens distintas', ic: 'globo', valor: String(a.origens.length >= 10 ? '10+' : a.origens.length), nota: `Volume estimado ${bytes(a.total_bytes)}`, notaTipo: 'neutra' })),
    el('div', { class: 'grade principal-lateral' },
      el('div', {},
        painel('Tráfego no alvo', graficoLinhas({ series: [{ nome: 'Tráfego', cor: 'var(--vermelho)', pontos: a.serie.map((s) => [Date.parse(s.em), s.bps]) }], formatoY: bits, altura: 220,
          formatoX: (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          referencia: a.metrica === 'bps' ? { valor: a.limite, rotulo: `limite ${bits(a.limite)}` } : null, vazio: 'Medições a cada 10 s aparecem aqui.' })),
        el('div', { class: 'grade duas' },
          painel(a.direcao === 'saida' ? 'Principais destinos' : 'Principais origens', tabela([{ titulo: 'Endereço', valor: (o) => o.chave }, { titulo: 'Volume', valor: (o) => el('div', {}, bytes(o.bytes), barra(o.bytes)), classe: 'num' }],
            a.origens, { vazioTexto: 'Sem captura.' }), { semCorpo: true }),
          painel('Portas e protocolos', el('div', {},
            tabela([{ titulo: 'Porta de origem', valor: (o) => proto(o.chave) }, { titulo: 'Volume', valor: (o) => pct(o.bytes), classe: 'num' }], a.portas_origem.slice(0, 5), { vazioTexto: 'Sem portas (ICMP/GRE ou fragmentos).' }),
            tabela([{ titulo: 'Porta de destino', valor: (o) => proto(o.chave) }, { titulo: 'Volume', valor: (o) => pct(o.bytes), classe: 'num' }], a.portas_destino.slice(0, 5), { vazioTexto: '' }),
            el('p', { class: 'fraco', style: 'padding:10px 16px' }, `Protocolos: ${a.protocolos.map((p) => `${NOMES_PROTO[p.chave] ?? p.chave} ${pct(p.bytes)}`).join(' · ') || '—'}`)), { semCorpo: true })),
        painel('Linha do tempo', el('ul', { class: 'linha-tempo' }, a.eventos.map((e) => el('li', {}, el('strong', {}, EVENTOS[e.tipo] ?? e.tipo.replaceAll('_', ' ')),
          detalheEvento(e.detalhes) ? ` — ${detalheEvento(e.detalhes)}` : '', el('small', {}, `${dataHora(e.em, { segundos: true })} · ${e.usuario_nome ?? 'Sistema'}`)))))),
      el('div', {},
        painel('Situação', dl([['Situação', etqDe('statusAtaque', a.status)], ['Severidade', etqDe('severidade', a.severidade)], ['Direção', etqDe('direcaoAtaque', a.direcao)],
          ['Grupo', a.grupo?.nome], ['Política do grupo', a.grupo ? `${rotulo('modoMitigacao', a.grupo.mitigacao_modo)} · ${rotulo('tipoMitigacao', a.grupo.mitigacao_tipo)}` : null],
          a.motivo_encerramento ? ['Encerramento', a.motivo_encerramento] : null])),
        painel('Bloqueios', a.mitigacoes.length ? el('div', {}, a.mitigacoes.map((m) => cartaoBloqueio(m, recarregar))) : vazio('Nenhum bloqueio para este ataque.')),
        a.anteriores.length ? painel('Ataques anteriores ao mesmo alvo', tabela([{ titulo: 'Ataque', valor: (x) => `#${x.numero} ${x.vetor ?? ''}` }, { titulo: 'Início', valor: (x) => dataHora(x.inicio) }],
          a.anteriores, { aoClicar: (x) => ir(`#/ddos/ataque/${x.id}`) }), { semCorpo: true }) : null)));
}
