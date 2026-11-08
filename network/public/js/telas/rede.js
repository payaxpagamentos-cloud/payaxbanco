import { api, abrirAnexo, qs } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, paginacao, abas, etqDe, etq, rotulo, opcoes, dataHora, dl, toast, acao, carregar, carregando, formulario, modal,
  pedirMotivo, botao, faixa, vazio } from '../ui.js';
import { criarMapa } from '../mapa.js';

export default async function rede({ alvo, params, query, ir, aoSair }) {
  if (params[0] === 'ativo' && params[1]) return detalhe(alvo, Number(params[1]), ir);
  const lista = [['mapa', 'Mapa'], ['cto', 'CTOs'], ['ceo', 'Caixas de emenda'], ['pop', 'POPs e OLTs'], ['cabos', 'Cabos']];
  let aba = query.busca ? 'cto' : query.aba ?? 'mapa';
  const filtro = { busca: query.busca ?? '', status_operacional: '', bairro: '', pagina: 1 };
  const corpo = el('div');
  const barra = el('div');
  const trocar = (id) => { aba = id; filtro.pagina = 1; barra.replaceChildren(abas(lista, aba, trocar)); desenhar(); };
  limpar(alvo, cabecalho({ sobretitulo: 'Infraestrutura', titulo: 'Rede óptica',
    descricao: 'CTOs, caixas de emenda, POPs, cabos e ligações. CTO e CEO são passivas: a situação mostra a origem (inspeção manual ou inferência pelo equipamento ativo).',
    acoes: [pode('rede.editar') ? botao('Novo ativo', () => novoAtivo((a) => ir(`#/rede/ativo/${a.id}`)), { ic: 'mais' }) : null] }), barra, corpo);

  let mapa = null;
  aoSair(() => mapa?.destruir());
  async function desenhar() {
    mapa?.destruir();
    mapa = null;
    if (aba === 'mapa') {
      const area = el('div', { class: 'mapa alto', role: 'region', 'aria-label': 'Mapa da rede' });
      const lista2 = el('div', { class: 'lista-mapa' });
      const rodape = el('span', {}, '');
      limpar(corpo, painel(null, [area, el('div', { class: 'mapa-legenda' }, [['#19724e', 'Operacional'], ['#d58b3a', 'Atenção'], ['#cf5b55', 'Indisponível'], ['#9aa691', 'Não avaliado']]
        .map(([c, t]) => el('span', {}, el('i', { style: `background:${c}` }), t)), el('span', {}, 'Linhas: ligações ativas cadastradas')), lista2], { semCorpo: true, rodape: [rodape] }));
      mapa = await criarMapa(area);
      try {
        const m = await api.get('/rede/mapa');
        mapa.mostrarRede(m, (a) => ir(`#/rede/ativo/${a.id}`));
        lista2.replaceChildren(...m.ativos.map((a) => el('button', { onclick: () => mapa.focar(`a${a.id}`) }, `${a.codigo} · ${rotulo('statusAtivo', a.status_operacional)}`)));
        rodape.textContent = m.sem_coordenadas.length ? `${m.sem_coordenadas.length} ativo(s) sem coordenada: ${m.sem_coordenadas.map((x) => x.codigo).join(', ')}` : `${m.ativos.length} ativo(s) georreferenciado(s)`;
        if (!m.ativos.length) lista2.replaceChildren(vazio('Nenhum ativo com coordenadas.', 'Cadastre POPs, caixas e CTOs com latitude e longitude.'));
      } catch (err) { lista2.replaceChildren(el('div', { class: 'falha' }, err.message)); }
      return;
    }
    if (aba === 'cabos') {
      return carregar(corpo, () => api.get('/rede/cabos'), (l) => painel(null, tabela([{ titulo: 'Cabo', valor: (c) => c.codigo }, { titulo: 'Fibras', valor: (c) => c.fibras, classe: 'num' },
        { titulo: 'Tipo', valor: (c) => c.tipo ?? '—' }, { titulo: 'Comprimento', valor: (c) => (c.comprimento_m ? `${c.comprimento_m} m` : '—'), classe: 'num' }], l, { vazioTexto: 'Nenhum cabo cadastrado.' }),
      { acoes: [pode('rede.editar') ? botao('Novo cabo', () => formulario('Novo cabo', [{ nome: 'codigo', rotulo: 'Código', obrigatorio: true }, { nome: 'fibras', rotulo: 'Fibras', tipo: 'number', obrigatorio: true },
        { nome: 'tipo', rotulo: 'Tipo', placeholder: 'AS-80, drop…' }, { nome: 'comprimento_m', rotulo: 'Comprimento (m)', tipo: 'number' }],
      { enviar: async (d) => { await api.post('/rede/cabos', { ...d, comprimento_m: d.comprimento_m || null }); toast('Cabo salvo.'); desenhar(); } }), { tipo: 'secundario pequeno', ic: 'mais' }) : null] }));
    }
    const busca = el('input', { type: 'search', class: 'busca', placeholder: 'Código, nome ou endereço', value: filtro.busca, 'aria-label': 'Buscar ativos' });
    const status = el('select', { 'aria-label': 'Situação' }, el('option', { value: '' }, 'Todas as situações'), opcoes('statusAtivo').map(([v, r]) => el('option', { value: v, selected: v === filtro.status_operacional }, r)));
    const area = el('div');
    busca.addEventListener('input', () => { filtro.busca = busca.value; filtro.pagina = 1; clearTimeout(busca.t); busca.t = setTimeout(listar, 300); });
    status.addEventListener('change', () => { filtro.status_operacional = status.value; filtro.pagina = 1; listar(); });
    limpar(corpo, el('div', { class: 'filtros' }, busca, status), area);
    function listar() {
      return carregar(area, () => api.get(`/rede/ativos${qs({ ...filtro, tipo: aba })}`), (l) => painel(null, tabela([
        { titulo: 'Código', valor: (a) => el('div', {}, el('div', { class: 'forte' }, a.codigo), el('div', { class: 'fraco' }, [a.nome, a.bairro].filter(Boolean).join(' · '))) },
        { titulo: 'Endereço', valor: (a) => a.endereco ?? el('span', { class: 'fraco' }, a.lat === null ? 'Sem coordenada' : '—') },
        aba === 'cto' ? { titulo: 'Ocupação', valor: (a) => el('div', {}, `${a.portas.ocupadas}/${a.portas.total}`, el('div', { class: 'fraco' }, `${a.portas.reservadas} reserv. · ${a.portas.defeito} defeito`)), classe: 'num' } : null,
        aba === 'cto' ? { titulo: 'OLT / PON', valor: (a) => [a.equipamento_nome, a.pon].filter(Boolean).join(' · ') || '—' } : null,
        aba !== 'pop' ? { titulo: 'Alimentado por', valor: (a) => a.alimentado_por ?? el('span', { class: 'fraco' }, 'Sem ligação') } : null,
        { titulo: 'Situação', valor: (a) => el('div', {}, etqDe('statusAtivo', a.status_operacional), el('div', { class: 'fraco' }, rotulo('origemStatus', a.status_origem))) },
      ].filter(Boolean), l.itens, { vazioTexto: 'Nenhum ativo encontrado.', aoClicar: (a) => ir(`#/rede/ativo/${a.id}`), pagina: paginacao(l, (p) => { filtro.pagina = p; listar(); }) }),
      { semCorpo: true, acoes: aba === 'pop' && pode('rede.editar') ? [botao('Equipamentos', () => equipamentos(), { tipo: 'secundario pequeno' })] : [] }));
    }
    listar();
  }
  trocar(lista.some(([id]) => id === aba) ? aba : 'mapa');
}

async function novoAtivo(depois) {
  const equips = await api.get('/rede/equipamentos').catch(() => []);
  return formulario('Novo ativo da rede', [
    { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', obrigatorio: true, opcoes: opcoes('tipoAtivo') },
    { nome: 'codigo', rotulo: 'Código', obrigatorio: true, ajuda: 'Único na organização, ex.: CTO-OCN-024.' },
    { nome: 'nome', rotulo: 'Nome' }, { nome: 'bairro', rotulo: 'Bairro' },
    { nome: 'endereco', rotulo: 'Endereço', inteiro: true },
    { nome: 'lat', rotulo: 'Latitude', tipo: 'decimal', placeholder: '-24.0123' }, { nome: 'lng', rotulo: 'Longitude', tipo: 'decimal', placeholder: '-46.4321' },
    { nome: 'referencia_acesso', rotulo: 'Referência de acesso', inteiro: true },
    { nome: 'capacidade', rotulo: 'Capacidade (portas da CTO ou fibras da CEO)', tipo: 'number' },
    { nome: 'splitter', rotulo: 'Splitter (CTO)', placeholder: '1:16' }, { nome: 'bandejas', rotulo: 'Bandejas (CEO)', tipo: 'number' },
    { nome: 'equipamento_id', rotulo: 'OLT (CTO)', tipo: 'select', vazio: 'Nenhuma', opcoes: equips.filter((e) => e.tipo === 'olt').map((e) => [e.id, e.nome]) },
    { nome: 'pon', rotulo: 'PON (CTO)', placeholder: '1/1/4' },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', inteiro: true },
  ], { largo: true, rotuloEnviar: 'Cadastrar', enviar: async (d) => {
    const a = await api.post('/rede/ativos', { ...d, lat: d.lat.replace(',', '.') || null, lng: d.lng.replace(',', '.') || null, equipamento_id: d.equipamento_id || null, bandejas: d.bandejas || null });
    toast('Ativo cadastrado.');
    depois(a);
    return a;
  } });
}

async function equipamentos() {
  const [lista, pops] = await Promise.all([api.get('/rede/equipamentos'), api.get('/rede/ativos?tipo=pop&por_pagina=200')]);
  return formulario('Equipamentos ativos', [
    { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', obrigatorio: true, opcoes: opcoes('equipamento') }, { nome: 'nome', rotulo: 'Nome', obrigatorio: true },
    { nome: 'ativo_id', rotulo: 'POP', tipo: 'select', vazio: 'Nenhum', opcoes: pops.itens.map((p) => [p.id, p.codigo]) },
    { nome: 'monitoramento_id', rotulo: 'ID no monitoramento', ajuda: 'O mesmo target_id que o coletor envia.' },
    { nome: 'fabricante', rotulo: 'Fabricante' }, { nome: 'modelo', rotulo: 'Modelo' }, { nome: 'ip_gerencia', rotulo: 'IP de gerência', ajuda: 'Só referência: o sistema não acessa o equipamento.' },
  ], { largo: true, rotuloEnviar: 'Adicionar equipamento', antes: el('div', { style: 'margin-bottom:12px' }, tabela([{ titulo: 'Equipamento', valor: (e) => `${rotulo('equipamento', e.tipo)} · ${e.nome}` },
    { titulo: 'POP', valor: (e) => e.pop_codigo ?? '—' }, { titulo: 'ID no monitoramento', valor: (e) => e.monitoramento_id ?? '—' }], lista, { vazioTexto: 'Nenhum equipamento.' })),
  enviar: async (d) => { await api.post('/rede/equipamentos', { ...d, ativo_id: d.ativo_id || null }); toast('Equipamento salvo.'); } });
}

async function detalhe(alvo, id, ir) {
  const recarregar = () => detalhe(alvo, id, ir);
  limpar(alvo, carregando());
  let a;
  try { a = await api.get(`/rede/ativos/${id}`); } catch (err) { limpar(alvo, el('div', { class: 'falha' }, err.message)); return; }
  const passiva = a.tipo !== 'pop';
  limpar(alvo,
    el('a', { href: `#/rede?aba=${a.tipo}`, class: 'botao fantasma pequeno', style: 'margin-bottom:10px' }, icone('voltar'), 'Rede óptica'),
    cabecalho({ sobretitulo: rotulo('tipoAtivo', a.tipo), titulo: a.codigo, descricao: [a.nome, a.endereco, a.bairro].filter(Boolean).join(' · '),
      acoes: [
        pode('rede.portas') || pode('rede.editar') ? botao('Registrar inspeção', () => formulario('Inspeção de campo', [
          { nome: 'status_operacional', rotulo: 'Situação encontrada', tipo: 'select', obrigatorio: true, opcoes: opcoes('statusAtivo').filter(([v]) => v !== 'nao_avaliado') },
          { nome: 'evidencia', rotulo: 'Evidência (o que foi visto/medido, onde e como)', tipo: 'textarea', obrigatorio: true, inteiro: true }],
        { enviar: async (d) => { await api.post(`/rede/ativos/${a.id}/inspecao`, d); toast('Inspeção registrada.'); recarregar(); } }), { tipo: 'secundario', ic: 'ok' }) : null,
        pode('rede.editar') && !a.acima && a.tipo !== 'pop' ? botao('Ligar ao alimentador', () => ligar(a, recarregar), { tipo: 'secundario', ic: 'rede' }) : null,
        pode('rede.editar') ? botao('Editar', () => editar(a, recarregar), { tipo: 'secundario' }) : null,
        pode('chamados.criar') ? botao('Abrir chamado', async () => { const { novoChamado } = await import('./chamados.js'); const c = await novoChamado({ ativo_id: a.id, titulo: `Atendimento ${a.codigo}` }); if (c) ir(`#/chamados/${c.id}`); }, { ic: 'chamado' }) : null,
      ] }),
    a.incidentes.length ? faixa(el('span', {}, 'Incidente(s) aberto(s): ', a.incidentes.map((i, n) => [n ? ', ' : '', el('a', { href: `#/noc/incidente/${i.id}` }, `#${i.id} ${i.titulo}`)])), 'erro', 'alerta') : null,
    el('div', { class: 'grade principal-lateral' },
      el('div', {},
        a.tipo === 'cto' ? painel(`Portas (${a.portas.ocupadas}/${a.portas.total} ocupadas)`, portas(a, recarregar)) : null,
        a.tipo === 'ceo' ? painel('Bandejas e fusões', fusoes(a, recarregar)) : null,
        a.tipo === 'pop' ? painel('Equipamentos', tabela([{ titulo: 'Equipamento', valor: (e) => `${rotulo('equipamento', e.tipo)} · ${e.nome}` },
          { titulo: 'Fabricante / modelo', valor: (e) => [e.fabricante, e.modelo].filter(Boolean).join(' ') || '—' }, { titulo: 'ID no monitoramento', valor: (e) => e.monitoramento_id ?? 'Não vinculado' }],
        a.equipamentos, { vazioTexto: 'Nenhum equipamento neste POP.' }), { semCorpo: true }) : null,
        painel('Percurso até o POP', el('div', {}, el('div', { class: 'percurso' }, a.percurso.passos.flatMap((p, n) => [n ? el('span', { class: 'seta' }, '→') : null,
          el('a', { class: 'passo', href: `#/rede/ativo/${p.id}` }, `${p.codigo}`)]), a.percurso.trecho_desconhecido ? [el('span', { class: 'seta' }, '→'), el('span', { class: 'passo desconhecido' }, 'Trecho desconhecido')] : null),
          a.percurso.trecho_desconhecido ? el('p', { class: 'fraco', style: 'margin-top:8px' }, a.percurso.trecho_desconhecido) : null)),
        a.alimenta.length ? painel(`Alimenta ${a.alimenta.length} ativo(s)`, tabela([{ titulo: 'Ativo', valor: (x) => `${x.codigo} · ${rotulo('tipoAtivo', x.tipo)}` },
          { titulo: 'Cabo / fibras', valor: (x) => [x.cabo, x.fibras].filter(Boolean).join(' · ') || '—' }, { titulo: 'Desde', valor: (x) => dataHora(x.inicio) },
          { titulo: 'Situação', valor: (x) => etqDe('statusAtivo', x.status_operacional) }], a.alimenta, { aoClicar: (x) => ir(`#/rede/ativo/${x.id}`) }), { semCorpo: true }) : null,
        painel('Histórico', a.historico.length ? el('ul', { class: 'linha-tempo' }, a.historico.map((h) => el('li', {}, h.acao.replaceAll('_', ' '),
          el('small', {}, `${dataHora(h.criado_em)} · ${h.usuario_nome ?? 'Sistema'}`)))) : el('p', { class: 'fraco' }, 'Sem alterações registradas.'))),
      el('div', {},
        painel('Situação operacional', el('div', {}, dl([['Situação', etqDe('statusAtivo', a.status_operacional)], ['Origem', rotulo('origemStatus', a.status_origem)],
          ['Evidência', a.status_evidencia], ['Registrado em', dataHora(a.status_em)]]),
        passiva ? el('p', { class: 'fraco', style: 'margin-top:12px' }, 'Elemento passivo: não há ping nem sensor próprio. A situação vem de inspeção de campo ou de inferência a partir de OLT/ONUs e topologia.') : null)),
        painel('Dados', dl([['Código', a.codigo], ['Capacidade', a.capacidade], a.tipo === 'cto' ? ['Splitter', a.splitter] : null,
          a.equipamento ? ['OLT / PON', `${a.equipamento.nome}${a.pon ? ` · ${a.pon}` : ''}`] : null,
          ['Alimentado por', a.acima ? el('span', {}, el('a', { href: `#/rede/ativo/${a.acima.destino_id}` }, a.acima.destino_codigo),
            pode('rede.editar') ? [' ', el('button', { class: 'botao fantasma pequeno', onclick: () => encerrarLigacao(a.acima.id, recarregar) }, 'Encerrar ligação')] : null) : 'Sem ligação'],
          ['Coordenadas', a.lat !== null ? `${a.lat}, ${a.lng}` : 'Sem coordenada'], ['Referência de acesso', a.referencia_acesso], ['Observações', a.observacoes]])),
        painel('Impacto se este ativo falhar', dl([['CTOs abaixo', a.impacto.ctos.length], ['Portas ocupadas', a.impacto.portas_ocupadas],
          ['Clientes únicos', a.impacto.clientes_unicos ?? '—'], a.impacto.clientes_sem_referencia ? ['Portas sem referência de cliente', a.impacto.clientes_sem_referencia] : null])),
        a.historico_ligacoes.length ? painel('Ligações encerradas', el('ul', { class: 'linha-tempo' }, a.historico_ligacoes.map((l) => el('li', {}, `${l.origem_codigo} → ${l.destino_codigo}`,
          el('small', {}, `${dataHora(l.inicio)} a ${dataHora(l.fim)} · ${l.motivo_fim ?? ''}`))))) : null,
        a.anexos.length ? painel('Fotos e documentos', el('div', { class: 'miniaturas' }, a.anexos.map((x) => el('a', { href: '#', onclick: (e) => { e.preventDefault(); acao(null, () => abrirAnexo(x.id)); } }, icone('arquivo'), x.nome)))) : null)));
}

function portas(a, recarregar) {
  const ACOES = { livre: [['reservar', 'Reservar'], ['ocupar', 'Ocupar'], ['defeito', 'Marcar defeito']], reservada: [['ocupar', 'Ocupar'], ['liberar', 'Liberar reserva'], ['defeito', 'Marcar defeito']],
    ocupada: [['liberar', 'Liberar porta']], defeito: [['liberar', 'Voltar a livre']] };
  const abrir = (p) => modal(`Porta ${p.numero} · ${a.codigo}`, (fechar) => [
    dl([['Situação', etq(p.situacao, { livre: 'ok', reservada: 'aviso', ocupada: 'neutra', defeito: 'erro' }[p.situacao])], ['Cliente', p.cliente_ref], ['ONU', p.onu_ref],
      p.reserva_expira_em ? ['Reserva vale até', `${dataHora(p.reserva_expira_em)} · ${p.reservado_por_nome ?? ''}`] : null, ['Desde', dataHora(p.desde)], ['Observação', p.observacao]]),
    pode('rede.portas') ? el('div', { class: 'form-acoes' }, (ACOES[p.situacao] ?? []).map(([acaoP, r]) => botao(r, () => {
      const campos = {
        reservar: [{ nome: 'cliente_ref', rotulo: 'Cliente (opcional)' }, { nome: 'observacao', rotulo: 'Observação' }],
        ocupar: [{ nome: 'cliente_ref', rotulo: 'Cliente', obrigatorio: true, valor: p.cliente_ref }, { nome: 'onu_ref', rotulo: 'ONU' }],
        liberar: [{ nome: 'motivo', rotulo: 'Motivo', obrigatorio: true, inteiro: true }], defeito: [{ nome: 'motivo', rotulo: 'Defeito observado', obrigatorio: true, inteiro: true }],
      }[acaoP];
      return formulario(`${r} · porta ${p.numero}`, campos, { rotuloEnviar: r, enviar: async (d) => {
        await api.post(`/rede/portas/${p.id}/${acaoP}`, { ...d, versao: p.versao });
        toast('Porta atualizada.');
        fechar();
        recarregar();
      } });
    }, { tipo: acaoP === 'defeito' ? 'perigo' : 'secundario' }))) : null,
    el('div', { style: 'margin-top:14px' }, el('button', { class: 'botao fantasma pequeno', onclick: (e) => acao(e.currentTarget, async () => {
      const h = await api.get(`/rede/portas/${p.id}/historico`);
      e.target.closest('div').replaceChildren(el('ul', { class: 'linha-tempo' }, h.map((x) => el('li', {}, `${x.situacao_anterior ?? '—'} → ${x.situacao}${x.cliente_ref ? ` · ${x.cliente_ref}` : ''}${x.motivo ? ` · ${x.motivo}` : ''}`,
        el('small', {}, `${dataHora(x.em)} · ${x.usuario_nome ?? 'Sistema'}`)))));
    }) }, 'Ver histórico da porta')),
  ]);
  return el('div', {}, el('div', { class: 'portas' }, a.lista_portas.map((p) => el('button', { class: `porta ${p.situacao}`, onclick: () => abrir(p), 'aria-label': `Porta ${p.numero}: ${p.situacao}` },
    el('strong', {}, p.numero), p.situacao, p.cliente_ref ? el('div', { class: 'fraco' }, p.cliente_ref) : null))),
  el('p', { class: 'fraco', style: 'margin-top:10px' }, 'Ocupação derivada das portas. A mesma porta não aceita duas ligações; a reserva expira no prazo da organização.'));
}

function fusoes(a, recarregar) {
  const nova = async () => {
    const cabos = await api.get('/rede/cabos');
    return formulario('Registrar fusão', [
      { nome: 'bandeja_id', rotulo: 'Bandeja', tipo: 'select', obrigatorio: true, opcoes: a.bandejas.map((b) => [b.id, `Bandeja ${b.numero} (${b.capacidade})`]), inteiro: true },
      { tipo: 'secao', rotulo: 'Extremidade A' },
      { nome: 'a_cabo', rotulo: 'Cabo', tipo: 'select', obrigatorio: true, opcoes: cabos.map((c) => [c.id, `${c.codigo} (${c.fibras} fibras)`]) }, { nome: 'a_tubo', rotulo: 'Tubo', tipo: 'number', valor: 1 },
      { nome: 'a_fibra', rotulo: 'Fibra', tipo: 'number', obrigatorio: true }, { nome: 'a_cor', rotulo: 'Cor' },
      { tipo: 'secao', rotulo: 'Extremidade B' },
      { nome: 'b_cabo', rotulo: 'Cabo', tipo: 'select', obrigatorio: true, opcoes: cabos.map((c) => [c.id, `${c.codigo} (${c.fibras} fibras)`]) }, { nome: 'b_tubo', rotulo: 'Tubo', tipo: 'number', valor: 1 },
      { nome: 'b_fibra', rotulo: 'Fibra', tipo: 'number', obrigatorio: true }, { nome: 'b_cor', rotulo: 'Cor' },
      { nome: 'observacao', rotulo: 'Observação', inteiro: true },
    ], { largo: true, enviar: async (d) => {
      await api.post(`/rede/ativos/${a.id}/fusoes`, { bandeja_id: d.bandeja_id, observacao: d.observacao, a: { cabo_id: d.a_cabo, tubo: d.a_tubo, fibra: d.a_fibra, cor: d.a_cor },
        b: { cabo_id: d.b_cabo, tubo: d.b_tubo, fibra: d.b_fibra, cor: d.b_cor } });
      toast('Fusão registrada.');
      recarregar();
    } });
  };
  return el('div', {},
    a.bandejas.length ? null : faixa('Cadastre as bandejas desta caixa para registrar fusões.', 'info'),
    tabela([{ titulo: 'Bandeja', valor: (f) => f.bandeja, classe: 'num' }, { titulo: 'Extremidade A', valor: (f) => `${f.a_cabo} T${f.a_tubo} F${f.a_fibra}${f.a_cor ? ` (${f.a_cor})` : ''}` },
      { titulo: 'Extremidade B', valor: (f) => `${f.b_cabo} T${f.b_tubo} F${f.b_fibra}${f.b_cor ? ` (${f.b_cor})` : ''}` },
      { titulo: 'Situação', valor: (f) => (f.ativa ? etq('Ativa', 'ok') : el('span', {}, etq('Desfeita', 'neutra'), el('div', { class: 'fraco' }, f.motivo_fim))) },
      { titulo: '', valor: (f) => (f.ativa && pode('rede.editar') ? el('button', { class: 'botao fantasma pequeno', onclick: () => pedirMotivo('Desfazer fusão', 'Motivo', async (m) => {
        await api.post(`/rede/fusoes/${f.id}/desfazer`, { motivo: m }); recarregar(); }) }, 'Desfazer') : '') }], a.fusoes, { vazioTexto: 'Nenhuma fusão registrada.' }),
    pode('rede.editar') ? el('div', { class: 'form-acoes', style: 'justify-content:flex-start' },
      a.bandejas.length ? botao('Registrar fusão', nova, { tipo: 'secundario pequeno', ic: 'mais' }) : null,
      botao('Nova bandeja', () => formulario('Nova bandeja', [{ nome: 'numero', rotulo: 'Número', tipo: 'number', obrigatorio: true, valor: a.bandejas.length + 1 },
        { nome: 'capacidade', rotulo: 'Capacidade (fusões)', tipo: 'number', valor: 12 }], { enviar: async (d) => { await api.post(`/rede/ativos/${a.id}/bandejas`, d); recarregar(); } }),
      { tipo: 'secundario pequeno' })) : null);
}

async function ligar(a, recarregar) {
  const permitidos = { cto: ['ceo', 'cto', 'pop'], ceo: ['ceo', 'pop'], pop: ['pop'] }[a.tipo];
  const [ativos, cabos] = await Promise.all([api.get('/rede/ativos?por_pagina=200'), api.get('/rede/cabos')]);
  return formulario(`Ligar ${a.codigo} ao alimentador`, [
    { nome: 'destino_id', rotulo: 'Alimentado por', tipo: 'select', obrigatorio: true, inteiro: true,
      opcoes: ativos.itens.filter((x) => x.id !== a.id && permitidos.includes(x.tipo)).map((x) => [x.id, `${x.codigo} · ${rotulo('tipoAtivo', x.tipo)}`]) },
    { nome: 'cabo_id', rotulo: 'Cabo', tipo: 'select', vazio: 'Não informado', opcoes: cabos.map((c) => [c.id, c.codigo]) }, { nome: 'fibras', rotulo: 'Fibras usadas', placeholder: '3, 4' },
  ], { enviar: async (d) => { await api.post('/rede/enlaces', { origem_id: a.id, destino_id: d.destino_id, cabo_id: d.cabo_id || null, fibras: d.fibras }); toast('Ligação criada.'); recarregar(); } });
}

function encerrarLigacao(enlaceId, recarregar, confirmar = false) {
  return pedirMotivo('Encerrar ligação', 'Motivo', async (m) => {
    try {
      await api.post(`/rede/enlaces/${enlaceId}/encerrar`, { motivo: m, confirmar_dependentes: confirmar });
      toast('Ligação encerrada; o histórico foi mantido.');
      recarregar();
    } catch (err) {
      if (err.status === 409 && err.dados?.detalhes?.dependentes) {
        const d = err.dados.detalhes;
        const ok = await modal('Ligação com dependentes', (fechar) => [faixa(`${err.message} Dependentes: ${d.dependentes.map((x) => x.codigo).join(', ')}. Portas ocupadas abaixo: ${d.impacto.portas_ocupadas}.`, 'erro', 'alerta'),
          el('div', { class: 'form-acoes' }, el('button', { class: 'botao secundario', onclick: () => fechar(false) }, 'Voltar'), el('button', { class: 'botao perigo', onclick: () => fechar(true) }, 'Encerrar mesmo assim'))]);
        if (ok) { await api.post(`/rede/enlaces/${enlaceId}/encerrar`, { motivo: m, confirmar_dependentes: true }); toast('Ligação encerrada.'); recarregar(); }
        return;
      }
      throw err;
    }
  });
}

async function editar(a, recarregar) {
  const equips = a.tipo === 'cto' ? await api.get('/rede/equipamentos').catch(() => []) : [];
  return formulario(`Editar ${a.codigo}`, [
    { nome: 'nome', rotulo: 'Nome', valor: a.nome }, { nome: 'bairro', rotulo: 'Bairro', valor: a.bairro }, { nome: 'endereco', rotulo: 'Endereço', valor: a.endereco, inteiro: true },
    { nome: 'lat', rotulo: 'Latitude', tipo: 'decimal', valor: a.lat ?? '' }, { nome: 'lng', rotulo: 'Longitude', tipo: 'decimal', valor: a.lng ?? '' },
    a.tipo !== 'pop' ? { nome: 'capacidade', rotulo: 'Capacidade', tipo: 'number', valor: a.capacidade, ajuda: 'Não pode ficar abaixo das portas ocupadas ou reservadas.' } : null,
    a.tipo === 'cto' ? { nome: 'splitter', rotulo: 'Splitter', valor: a.splitter } : null,
    a.tipo === 'cto' ? { nome: 'equipamento_id', rotulo: 'OLT', tipo: 'select', vazio: 'Nenhuma', valor: a.equipamento_id, opcoes: equips.filter((e) => e.tipo === 'olt').map((e) => [e.id, e.nome]) } : null,
    a.tipo === 'cto' ? { nome: 'pon', rotulo: 'PON', valor: a.pon } : null,
    { nome: 'referencia_acesso', rotulo: 'Referência de acesso', valor: a.referencia_acesso, inteiro: true }, { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', valor: a.observacoes, inteiro: true },
  ], { largo: true, enviar: async (d) => {
    await api.patch(`/rede/ativos/${a.id}`, { ...d, lat: String(d.lat).replace(',', '.') || null, lng: String(d.lng).replace(',', '.') || null, equipamento_id: d.equipamento_id || null, versao: a.versao });
    toast('Ativo atualizado.');
    recarregar();
  } });
}
