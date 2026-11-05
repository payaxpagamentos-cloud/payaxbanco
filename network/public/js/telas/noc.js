import { api, qs } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, paginacao, abas, etqDe, etq, rotulo, opcoes, dataHora, desde, hora, dl, toast, carregar, carregando, formulario,
  pedirMotivo, botao, faixa, stat, vazio, duracaoMin, fonteHorario, numero } from '../ui.js';

const METRICAS = [['disponibilidade', 'Disponibilidade (1 responde, 0 não)'], ['latencia_ms', 'Latência (ms)'], ['perda_pacotes_pct', 'Perda de pacotes (%)'],
  ['optical_rx_dbm', 'Potência óptica recebida (dBm)'], ['interface_status', 'Interface (1 ativa, 0 inativa)'], ['utilizacao_pct', 'Utilização do enlace (%)']];

export default async function noc({ alvo, params, query, ir, aoSair }) {
  if (params[0] === 'incidente' && params[1]) return detalhe(alvo, Number(params[1]), ir);
  const lista = [['saude', 'Saúde da rede'], ['incidentes', 'Incidentes'], ['externos', 'Serviços externos'], ['historico', 'Histórico'], ['regras', 'Regras']];
  let aba = query.aba ?? 'saude';
  const corpo = el('div');
  const barra = el('div');
  let timer = null;
  aoSair(() => clearInterval(timer));
  const trocar = (id) => { aba = id; clearInterval(timer); barra.replaceChildren(abas(lista, aba, trocar)); TELAS[aba](); };
  limpar(alvo, cabecalho({ sobretitulo: 'Monitoramento', titulo: 'Central NOC',
    descricao: 'Falhas medidas pela coleta própria da rede, impacto pela topologia e contexto externo. Indício externo não confirma causa; sem dados não significa normal.',
    acoes: [el('a', { class: 'botao secundario', href: '#/tv' }, icone('tv'), 'Modo TV'),
      pode('noc.operar') ? botao('Registrar incidente', () => novoIncidente((i) => ir(`#/noc/incidente/${i.id}`)), { ic: 'mais' }) : null] }), barra, corpo);

  const TELAS = {
    saude: () => {
      const atualizar = () => carregar(corpo, () => Promise.all([api.get('/noc/resumo'), api.get('/noc/incidentes?principais=1&por_pagina=8')]), ([r, inc]) => {
        const d = r.disponibilidade;
        const f = r.fontes;
        return el('div', {},
          f.monitoramento.estado === 'nao_configurada' ? faixa(el('span', {}, 'Nenhum coletor de monitoramento configurado: a disponibilidade e os incidentes automáticos dependem da coleta própria da rede. ',
            pode('integracoes.ver') ? el('a', { href: '#/integracoes' }, 'Configurar coletor') : null), 'info') : null,
          el('div', { class: 'stats' },
            stat({ rotulo: 'Disponibilidade medida', ic: 'atividade', semDado: d.valor === null, valor: d.valor === null ? 'Sem coleta' : numero(d.valor, 2), sufixo: d.valor === null ? null : '%',
              nota: d.valor === null ? 'Sem amostras nas últimas 24 h' : `${d.equipamentos} equipamento(s) · ${d.amostras} amostras · 24 h`, notaTipo: 'neutra',
              fonte: d.ultima_coleta ? `Fonte ${d.fonte} · ${dataHora(d.ultima_coleta)}` : null }),
            stat({ rotulo: 'Incidentes principais', ic: 'alerta', valor: String(r.incidentes.principais), nota: `${r.incidentes.abertos} abertos ao todo · ${r.incidentes.sem_reconhecimento} sem reconhecimento`,
              notaTipo: r.incidentes.sem_reconhecimento ? 'aviso' : 'neutra', fonte: `Atualizado às ${hora(r.gerado_em)}` }),
            stat({ rotulo: 'Críticos', ic: 'sinal', valor: String(r.incidentes.por_severidade.critica), nota: `${r.incidentes.por_severidade.alta} de severidade alta`, notaTipo: r.incidentes.por_severidade.critica ? 'erro' : 'neutra' }),
            stat({ rotulo: 'Resolvidos em 24 h', ic: 'ok', valor: String(r.resolvidos_24h), nota: 'Com recuperação confirmada ou evidência manual', notaTipo: 'neutra' })),
          el('div', { class: 'grade principal-lateral' },
            painel('Incidentes principais', listaIncidentes(inc.itens, ir), { semCorpo: true, acoes: [el('button', { class: 'botao fantasma pequeno', onclick: () => trocar('incidentes') }, 'Ver todos', icone('seta'))] }),
            painel('Fontes de dados', dl([
              ['Monitoramento', fonteHorario(f.monitoramento.estado, f.monitoramento.ultimo_recebimento, null)],
              ['Rastreador', fonteHorario(f.rastreador.estado, f.rastreador.ultimo_sucesso, null)],
              ['Downdetector', fonteHorario(f.downdetector.estado, f.downdetector.ultimo_sucesso, null)],
            ]), { rodape: [el('span', {}, 'Estado da conexão ≠ estado do serviço: uma fonte pode estar fora com a rede normal.')] })));
      });
      atualizar();
      timer = setInterval(atualizar, 30_000);
    },
    incidentes: (filtro = { status: 'abertos', severidade: '', pagina: 1 }) => {
      const sel = el('select', { 'aria-label': 'Situação' }, [['abertos', 'Abertos'], ['aberto', 'Sem reconhecimento'], ['em_atendimento', 'Em atendimento'], ['resolvido', 'Resolvidos'], ['todos', 'Todos']]
        .map(([v, r]) => el('option', { value: v, selected: v === filtro.status }, r)));
      const sev = el('select', { 'aria-label': 'Severidade' }, el('option', { value: '' }, 'Todas as severidades'), opcoes('severidade').map(([v, r]) => el('option', { value: v, selected: v === filtro.severidade }, r)));
      const area = el('div');
      sel.addEventListener('change', () => TELAS.incidentes({ ...filtro, status: sel.value, pagina: 1 }));
      sev.addEventListener('change', () => TELAS.incidentes({ ...filtro, severidade: sev.value, pagina: 1 }));
      limpar(corpo, el('div', { class: 'filtros' }, sel, sev), area);
      carregar(area, () => api.get(`/noc/incidentes${qs(filtro)}`), (l) => painel(null, el('div', {}, listaIncidentes(l.itens, ir), paginacao(l, (p) => TELAS.incidentes({ ...filtro, pagina: p }))), { semCorpo: true }));
    },
    externos: () => carregar(corpo, () => api.get('/noc/servicos-externos'), (s) => el('div', {},
      s.estado === 'nao_configurada' ? faixa(el('span', {}, 'Downdetector não conectado: é necessário acesso autorizado à API (Enterprise) e os recursos do contrato. Sem acesso, consulte o ',
        el('a', { href: s.site_oficial, target: '_blank', rel: 'noopener' }, 'site oficial', icone('externo')), '. Nenhum dado é exibido aqui sem coleta real.'), 'info')
        : el('div', { class: 'filtros' }, fonteHorario(s.estado, s.ultimo_sucesso, 'Downdetector'), s.ultimo_erro ? el('span', { class: 'fraco' }, `Último erro: ${s.ultimo_erro}${s.erro_id ? ` (ID ${s.erro_id})` : ''}`) : null),
      s.servicos.length ? el('div', { class: 'cartoes' }, s.servicos.map((x) => el('div', { class: 'cartao-servico' },
        el('h3', {}, x.nome), x.ultima ? etqDe('sinal', x.ultima.sinal) : etq('Sem dados', 'neutra'),
        el('div', { class: 'numero' }, x.ultima?.relatos ?? '—'), el('small', {}, x.ultima?.relatos !== null && x.ultima?.relatos !== undefined ? 'relatos no período informado pela fonte' : 'volume não informado'),
        x.ultima?.baseline !== null && x.ultima?.baseline !== undefined ? el('small', {}, `Referência: ${x.ultima.baseline}`) : null,
        el('small', {}, `Região: ${x.regiao ?? x.ultima?.regiao ?? 'não informada'}`),
        x.ultima?.periodo_inicio ? el('small', {}, `Período: ${x.ultima.periodo_inicio} a ${x.ultima.periodo_fim ?? '—'}`) : null,
        el('small', {}, x.ultima ? `Coletado ${dataHora(x.ultima.coletado_em)} (${desde(x.ultima.coletado_em)})` : 'Ainda sem coleta'),
        x.desatualizada ? etq('Desatualizado', 'aviso') : null)))
        : s.estado !== 'nao_configurada' ? vazio('Nenhum serviço acompanhado.', 'Cadastre os serviços em Integrações.') : null,
      el('p', { class: 'fraco', style: 'margin-top:14px' }, s.observacao))),
    historico: (filtro = { pagina: 1 }) => carregar(corpo, () => api.get(`/noc/historico${qs(filtro)}`), (l) => painel(null, tabela([
      { titulo: 'Incidente', valor: (i) => el('div', {}, el('div', { class: 'forte' }, i.titulo), el('div', { class: 'fraco' }, `#${i.id} · ${i.origem}${i.recorrencias ? ` · ${i.recorrencias} recorrência(s)` : ''}`)) },
      { titulo: 'Severidade', valor: (i) => etqDe('severidade', i.severidade) }, { titulo: 'Início', valor: (i) => dataHora(i.inicio) },
      { titulo: 'Reconhecido em', valor: (i) => duracaoMin(i.reconhecimento_min) }, { titulo: 'Fim', valor: (i) => dataHora(i.resolvido_em) }, { titulo: 'Duração', valor: (i) => duracaoMin(i.duracao_min) },
      { titulo: 'Causa', valor: (i) => (i.causa_provavel ? `${i.causa_provavel}${i.causa_confirmada ? ' (confirmada)' : ' (provável)'}` : '—') },
    ], l.itens, { vazioTexto: 'Nenhum incidente resolvido ainda.', aoClicar: (i) => ir(`#/noc/incidente/${i.id}`), pagina: paginacao(l, (p) => TELAS.historico({ pagina: p })) }), { semCorpo: true })),
    regras: () => carregar(corpo, () => Promise.all([api.get('/noc/regras'), api.get('/rede/equipamentos').catch(() => [])]), ([l, equips]) => painel('Regras de monitoramento', tabela([
      { titulo: 'Regra', valor: (x) => el('div', {}, el('div', { class: 'forte' }, x.nome), el('div', { class: 'fraco' }, `${x.metrica} · v${x.versao}${x.equipamento_nome ? ` · só ${x.equipamento_nome}` : ' · todos os equipamentos'}`)) },
      { titulo: 'Dispara', valor: (x) => `${x.comparacao === 'menor' ? '<' : '>'} ${x.limiar}` }, { titulo: 'Recupera', valor: (x) => `${x.comparacao === 'menor' ? '≥' : '≤'} ${x.limiar_recuperacao}` },
      { titulo: 'Confirmações', valor: (x) => x.confirmacoes, classe: 'num' }, { titulo: 'Severidade', valor: (x) => etqDe('severidade', x.severidade) },
      { titulo: 'Situação', valor: (x) => (x.ativa ? etq('Ativa', 'ok') : etq('Desativada', 'neutra')) },
    ], l, { aoClicar: pode('noc.regras') ? (x) => regra(x, equips, () => TELAS.regras()) : null }),
    { acoes: [pode('noc.regras') ? botao('Nova regra', () => regra(null, equips, () => TELAS.regras()), { ic: 'mais', tipo: 'secundario pequeno' }) : null],
      rodape: [el('span', {}, 'Limiar depende do equipamento, porta e política: não há valor universal. A versão e os valores medidos ficam guardados em cada incidente.')] })),
  };
  trocar(lista.some(([id]) => id === aba) ? aba : 'saude');
}

function listaIncidentes(itens, ir) {
  return tabela([
    { titulo: 'Incidente', valor: (i) => el('div', {}, el('div', { class: 'forte' }, i.titulo), el('div', { class: 'fraco' }, [`#${i.id}`, i.ativo_codigo, i.origem === 'manual' ? 'registro manual' : 'monitoramento',
      i.relacionados ? `${i.relacionados} relacionado(s)` : null, i.incidente_pai_id ? `abaixo do #${i.incidente_pai_id}` : null].filter(Boolean).join(' · '))) },
    { titulo: 'Severidade', valor: (i) => etqDe('severidade', i.severidade) },
    { titulo: 'Impacto', valor: (i) => (i.impacto ? el('div', {}, `${i.impacto.portas_ocupadas} porta(s) ocupada(s)`, i.impacto.clientes_unicos ? el('div', { class: 'fraco' }, `${i.impacto.clientes_unicos} cliente(s) único(s)`) : null) : '—') },
    { titulo: 'Desde', valor: (i) => el('div', {}, desde(i.inicio), el('div', { class: 'fraco' }, `última obs. ${hora(i.ultima_observacao)}`)) },
    { titulo: 'Responsável', valor: (i) => i.responsavel_nome ?? '—' },
    { titulo: 'Situação', valor: (i) => etqDe('statusIncidente', i.status) },
  ], itens, { vazioTexto: 'Nenhum incidente registrado pelas fontes.', aoClicar: (i) => ir(`#/noc/incidente/${i.id}`) });
}

async function novoIncidente(depois) {
  const [ativos, equips] = await Promise.all([api.get('/rede/ativos?por_pagina=200').then((x) => x.itens).catch(() => []), api.get('/rede/equipamentos').catch(() => [])]);
  return formulario('Registrar incidente', [
    { nome: 'titulo', rotulo: 'Título', obrigatorio: true, inteiro: true, placeholder: 'Rompimento de fibra na Av. Kennedy' },
    { nome: 'severidade', rotulo: 'Severidade', tipo: 'select', obrigatorio: true, opcoes: opcoes('severidade') },
    { nome: 'ativo_id', rotulo: 'Ativo afetado', tipo: 'select', vazio: 'Não identificado', opcoes: ativos.map((a) => [a.id, `${a.codigo} · ${rotulo('tipoAtivo', a.tipo)}`]) },
    { nome: 'equipamento_id', rotulo: 'Equipamento', tipo: 'select', vazio: 'Nenhum', opcoes: equips.map((e) => [e.id, e.nome]) },
    { nome: 'causa_provavel', rotulo: 'Causa provável', inteiro: true },
    { nome: 'descricao', rotulo: 'Descrição / evidência inicial', tipo: 'textarea', inteiro: true },
  ], { largo: true, enviar: async (d) => { const r = await api.post('/noc/incidentes', { ...d, ativo_id: d.ativo_id || null, equipamento_id: d.equipamento_id || null }); toast('Incidente registrado.'); depois(r); return r; } });
}

function regra(x, equips, depois) {
  return formulario(x ? `Editar regra (cria a versão ${x.versao + 1})` : 'Nova regra', [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: x?.nome, inteiro: true },
    { nome: 'metrica', rotulo: 'Métrica', tipo: 'select', obrigatorio: true, valor: x?.metrica, opcoes: METRICAS },
    { nome: 'comparacao', rotulo: 'Dispara quando o valor fica', tipo: 'select', vazio: false, valor: x?.comparacao ?? 'menor', opcoes: [['menor', 'abaixo do limiar'], ['maior', 'acima do limiar']] },
    { nome: 'limiar', rotulo: 'Limiar', tipo: 'decimal', obrigatorio: true, valor: x?.limiar },
    { nome: 'limiar_recuperacao', rotulo: 'Limiar de recuperação', tipo: 'decimal', obrigatorio: true, valor: x?.limiar_recuperacao, ajuda: 'Do lado saudável do limiar (histerese).' },
    { nome: 'confirmacoes', rotulo: 'Amostras para confirmar', tipo: 'number', valor: x?.confirmacoes ?? 2 },
    { nome: 'severidade', rotulo: 'Severidade', tipo: 'select', obrigatorio: true, valor: x?.severidade, opcoes: opcoes('severidade') },
    { nome: 'equipamento_id', rotulo: 'Só para o equipamento', tipo: 'select', vazio: 'Todos', valor: x?.equipamento_id, opcoes: equips.map((e) => [e.id, e.nome]) },
    x ? { nome: 'ativa', rotulo: 'Regra ativa', tipo: 'checkbox', valor: x.ativa } : null,
  ], { largo: true, enviar: async (d) => {
    const corpo = { ...d, limiar: d.limiar.replace(',', '.'), limiar_recuperacao: d.limiar_recuperacao.replace(',', '.'), equipamento_id: d.equipamento_id || null };
    await (x ? api.patch(`/noc/regras/${x.id}`, corpo) : api.post('/noc/regras', corpo));
    toast('Regra salva.');
    depois();
  } });
}

async function detalhe(alvo, id, ir) {
  const recarregar = () => detalhe(alvo, id, ir);
  limpar(alvo, carregando());
  let i;
  try { i = await api.get(`/noc/incidentes/${id}`); } catch (err) { limpar(alvo, el('div', { class: 'falha' }, err.message)); return; }
  const act = (nome, corpo = {}) => api.post(`/noc/incidentes/${id}/${nome}`, corpo).then(recarregar);
  const ev = i.evidencias ?? {};
  const aberto = i.status !== 'resolvido';
  limpar(alvo,
    el('a', { href: '#/noc?aba=incidentes', class: 'botao fantasma pequeno', style: 'margin-bottom:10px' }, icone('voltar'), 'Central NOC'),
    cabecalho({ sobretitulo: `Incidente #${i.id} · ${i.origem === 'manual' ? 'registro manual' : 'monitoramento'}`, titulo: i.titulo,
      descricao: `Início ${dataHora(i.inicio)} · ${aberto ? `há ${duracaoMin(i.duracao_min)}` : `duração ${duracaoMin(i.duracao_min)}`}`,
      acoes: pode('noc.operar') ? [
        i.status === 'aberto' ? botao('Reconhecer', () => act('reconhecer'), { ic: 'ok' }) : null,
        ['aberto', 'reconhecido'].includes(i.status) ? botao('Em atendimento', () => act('atender'), { tipo: 'secundario' }) : null,
        aberto && pode('chamados.criar') ? botao('Abrir chamado', async () => { const { novoChamado } = await import('./chamados.js');
          const c = await novoChamado({ incidente_id: i.id, ativo_id: i.ativo_id, titulo: i.titulo, prioridade: i.severidade === 'critica' ? 'critica' : 'alta', tipo: 'reparo' }); if (c) ir(`#/chamados/${c.id}`); }, { tipo: 'secundario', ic: 'chamado' }) : null,
        botao('Causa', () => formulario('Causa do incidente', [{ nome: 'causa', rotulo: 'Causa', obrigatorio: true, valor: i.causa_provavel, inteiro: true },
          { nome: 'confirmada', rotulo: 'Causa confirmada por validação', tipo: 'checkbox', valor: i.causa_confirmada, inteiro: true },
          { nome: 'validacao', rotulo: 'Validação (obrigatória para confirmar)', tipo: 'textarea', inteiro: true }], { enviar: (d) => act('causa', d) }), { tipo: 'secundario' }),
        aberto ? botao('Resolver', () => pedirMotivo('Resolver incidente', 'Evidência da recuperação', (t) => act('resolver', { evidencia: t }),
          { ajuda: 'Concluir um chamado não basta: informe a medição ou a verificação que confirma a recuperação.' }), { tipo: 'perigo' }) : null,
      ] : [] }),
    i.pai ? faixa(el('span', {}, `Provavelmente explicado pelo incidente `, el('a', { href: `#/noc/incidente/${i.pai.id}` }, `#${i.pai.id} ${i.pai.titulo}`),
      ` (correlação ${i.confianca_correlacao}).`, pode('noc.operar') ? [' ', el('button', { class: 'botao fantasma pequeno', onclick: () => pedirMotivo('Desfazer correlação', 'Motivo', (m) => act('correlacao', { pai_id: null, motivo: m })) }, 'Corrigir')] : null), 'info') : null,
    el('div', { class: 'grade principal-lateral' },
      el('div', {},
        painel('Evidências', el('div', {},
          ev.regra ? dl([['Regra', `${ev.regra.nome} v${ev.regra.versao}`], ['Disparo', `${ev.regra.comparacao === 'menor' ? '<' : '>'} ${ev.regra.limiar} (recupera em ${ev.regra.limiar_recuperacao}, ${ev.regra.confirmacoes} confirmações)`],
            ['Fonte / alvo', `${ev.fonte} · ${ev.alvo}${ev.ponto ? ` · ${ev.ponto}` : ''}`]]) : ev.registro ? el('p', {}, ev.registro) : el('p', { class: 'fraco' }, 'Sem evidências registradas.'),
          ev.medicoes?.length ? el('div', { style: 'margin-top:12px' }, tabela([{ titulo: 'Medido em', valor: (m) => dataHora(m.em, { segundos: true }) },
            { titulo: 'Valor', valor: (m) => `${numero(m.valor, Number.isInteger(m.valor) ? 0 : 2)}${m.unidade ? ` ${m.unidade}` : ''}`, classe: 'num' }, { titulo: 'Amostra', valor: (m) => el('span', { class: 'fraco' }, m.amostra) }], [...ev.medicoes].reverse())) : null)),
        i.afetados.length ? painel('Ativos possivelmente afetados', tabela([{ titulo: 'Ativo', valor: (a) => `${a.codigo} · ${rotulo('tipoAtivo', a.tipo)}` }, { titulo: 'Bairro', valor: (a) => a.bairro ?? '—' },
          { titulo: 'Situação', valor: (a) => el('div', {}, etqDe('statusAtivo', a.status_operacional), el('div', { class: 'fraco' }, rotulo('origemStatus', a.status_origem))) }],
        i.afetados, { aoClicar: (a) => ir(`#/rede/ativo/${a.id}`) }), { semCorpo: true }) : null,
        i.relacionados.length ? painel('Incidentes relacionados (abaixo deste)', tabela([{ titulo: 'Incidente', valor: (r) => `#${r.id} ${r.titulo}` }, { titulo: 'Severidade', valor: (r) => etqDe('severidade', r.severidade) },
          { titulo: 'Situação', valor: (r) => etqDe('statusIncidente', r.status) }], i.relacionados, { aoClicar: (r) => ir(`#/noc/incidente/${r.id}`) }), { semCorpo: true }) : null,
        painel('Linha do tempo', el('ul', { class: 'linha-tempo' }, i.eventos.map((e) => el('li', {}, el('strong', {}, e.tipo.replaceAll('_', ' ')), e.detalhes ? ` — ${formatarDetalhe(e.detalhes)}` : '',
          el('small', {}, `${dataHora(e.em)} · ${e.usuario_nome ?? 'Sistema'}`)))))),
      el('div', {},
        painel('Situação', dl([['Situação', etqDe('statusIncidente', i.status)], ['Severidade', etqDe('severidade', i.severidade)], ['Primeira observação', dataHora(i.primeira_observacao)],
          ['Última observação', dataHora(i.ultima_observacao)], ['Reconhecido', i.reconhecido_em ? dataHora(i.reconhecido_em) : 'Não'], ['Resolvido', i.resolvido_em ? `${dataHora(i.resolvido_em)} (${i.resolucao})` : 'Não'],
          ['Recorrências', i.recorrencias], ['Equipamento', i.equipamento ? `${i.equipamento.nome}${i.ponto ? ` · ${i.ponto}` : ''}` : null], ['Ativo', i.ativo ? el('a', { href: `#/rede/ativo/${i.ativo.id}` }, i.ativo.codigo) : null],
          ['Causa', i.causa_provavel ? `${i.causa_provavel} (${i.causa_confirmada ? 'confirmada' : 'provável'})` : 'Não identificada']])),
        painel('Impacto provável', el('div', {}, dl([['CTOs', i.impacto.ctos], ['Portas ocupadas', i.impacto.portas_ocupadas], ['Clientes únicos', i.impacto.clientes_unicos ?? '—'],
          i.impacto.clientes_sem_referencia ? ['Portas sem referência de cliente', i.impacto.clientes_sem_referencia] : null, ['Incidentes relacionados', i.impacto.incidentes_relacionados]]),
        i.impacto.observacao ? el('p', { class: 'fraco', style: 'margin-top:10px' }, i.impacto.observacao) : el('p', { class: 'fraco', style: 'margin-top:10px' }, 'Cada cliente é contado uma vez, mesmo aparecendo por POP, CEO e CTO.'))),
        painel('Chamados', i.chamados.length ? tabela([{ titulo: 'Chamado', valor: (c) => `#${c.numero} ${c.titulo}` }, { titulo: 'Situação', valor: (c) => etqDe('statusChamado', c.status) }],
          i.chamados, { aoClicar: (c) => ir(`#/chamados/${c.id}`) }) : vazio('Nenhum chamado associado.')))));
}

function formatarDetalhe(d) {
  try { const x = JSON.parse(d); return x.evidencia ?? JSON.stringify(x); } catch { return d; }
}
