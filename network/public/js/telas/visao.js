import { api } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, stat, tabela, etqDe, rotulo, dataHora, desde, data, hora, hoje, vazio, falha, carregando, km, placa, botao } from '../ui.js';
import { criarMapa } from '../mapa.js';
import { novoChamado } from './chamados.js';

const ICONE_ALERTA = { incidente: 'rede', manutencao: 'chave', veiculo: 'carro', documento: 'arquivo' };

export default async function visao({ alvo, ir, aoSair }) {
  const stats = el('div', { class: 'stats' }, carregando());
  const alertas = el('div', { class: 'painel-escuro', 'aria-live': 'polite' }, carregando());
  const corpoMapa = el('div', { class: 'mapa', role: 'region', 'aria-label': 'Mapa da operação' });
  const listaMapa = el('div', { class: 'lista-mapa', 'aria-label': 'Pontos do mapa' });
  const legenda = el('div', { class: 'mapa-legenda' });
  const chamados = el('div', {}, carregando());
  const agenda = el('div', {}, carregando());
  let camada = pode('rede.ver') ? 'rede' : 'frota';
  const alternador = el('div', { class: 'alternador', role: 'group', 'aria-label': 'Camada do mapa' });
  const rodapeMapa = el('span', {}, '');

  limpar(alvo,
    cabecalho({ sobretitulo: 'Centro de operações', titulo: 'Sua operação, em conexão.', descricao: 'Rede, equipes e veículos sob a mesma visão. Cada número mostra a fonte e o horário da coleta.',
      acoes: [el('span', { class: 'botao secundario', role: 'note' }, icone('calendario'), data(hoje())), pode('chamados.criar') ? botao('Novo chamado', async () => { const c = await novoChamado(); if (c) ir(`#/chamados/${c.id}`); }, { ic: 'mais' }) : null] }),
    stats,
    el('div', { class: 'grade principal-lateral' },
      (pode('rede.ver') || pode('rastreamento.ver')) ? painel('Mapa da operação', [corpoMapa, legenda, listaMapa], { semCorpo: true, acoes: [alternador], rodape: [rodapeMapa, el('span', {}, 'Clique num ponto para ver o detalhe')] }) : null,
      alertas),
    el('div', { class: 'grade principal-lateral' },
      pode('chamados.ver') ? painel('Chamados em andamento', chamados, { acoes: [el('a', { href: '#/chamados', class: 'botao fantasma pequeno' }, 'Ver todos', icone('seta'))] }) : null,
      pode('manutencao.ver') ? painel('Agenda da frota', agenda, { acoes: [el('a', { href: '#/manutencao', class: 'botao fantasma pequeno' }, 'Ver agenda', icone('seta'))] }) : null));

  let mapa = null;
  if (corpoMapa.isConnected) {
    mapa = await criarMapa(corpoMapa);
    aoSair(() => mapa.destruir());
  }

  async function desenharCamada() {
    if (!mapa) return;
    alternador.replaceChildren(...[['rede', 'Rede', 'rede', 'rede.ver'], ['frota', 'Frota', 'carro', 'rastreamento.ver']].filter((x) => pode(x[3]))
      .map(([id, r, ic]) => el('button', { 'aria-pressed': String(camada === id), onclick: () => { camada = id; desenharCamada(); } }, icone(ic), r)));
    try {
      if (camada === 'rede') {
        const m = await api.get('/rede/mapa');
        mapa.mostrarRede(m, (a) => ir(`#/rede/ativo/${a.id}`));
        legenda.replaceChildren(...[['#19724e', 'Operacional'], ['#d58b3a', 'Atenção'], ['#cf5b55', 'Indisponível'], ['#9aa691', 'Não avaliado']].map(([c, t]) => el('span', {}, el('i', { style: `background:${c}` }), t)),
          el('span', {}, 'Status com origem: inspeção ou inferência'));
        listaMapa.replaceChildren(...m.ativos.slice(0, 40).map((a) => el('button', { onclick: () => mapa.focar(`a${a.id}`) }, `${a.codigo} · ${rotulo('statusAtivo', a.status_operacional)}`)));
        rodapeMapa.textContent = m.ativos.length ? `${m.ativos.length} ativo(s) no mapa${m.sem_coordenadas.length ? ` · ${m.sem_coordenadas.length} sem coordenada` : ''}` : 'Nenhum ativo com coordenadas cadastrado.';
      } else {
        const m = await api.get('/rastreamento/mapa');
        mapa.mostrarFrota(m.veiculos, (v) => ir(`#/veiculos/${v.id}`));
        legenda.replaceChildren(el('span', {}, `Rastreador: ${rotulo('estadoIntegracao', m.conexao.estado)}`), m.conexao.ultimo_sucesso ? el('span', {}, `Última coleta ${dataHora(m.conexao.ultimo_sucesso)} (${desde(m.conexao.ultimo_sucesso)})`) : el('span', {}, 'Sem coleta'));
        const com = m.veiculos.filter((v) => v.lat !== null);
        listaMapa.replaceChildren(...com.map((v) => el('button', { onclick: () => mapa.focar(`v${v.id}`) }, `${placa(v.placa)} · ${rotulo('situacaoRastreio', v.situacao)} · ${desde(v.observado_em)}`)));
        rodapeMapa.textContent = `${com.length} de ${m.veiculos.length} veículo(s) com posição`;
      }
    } catch (err) {
      listaMapa.replaceChildren(falha(err, desenharCamada));
    }
  }

  async function atualizar() {
    let d;
    try { d = await api.get('/painel/resumo'); } catch (err) { limpar(stats, falha(err, atualizar)); return; }
    const i = d.indicadores;
    limpar(stats,
      i.disponibilidade ? stat({ rotulo: 'Disponibilidade da rede', ic: 'atividade', semDado: i.disponibilidade.valor === null,
        valor: i.disponibilidade.valor === null ? 'Sem coleta' : i.disponibilidade.valor.toLocaleString('pt-BR'), sufixo: i.disponibilidade.valor === null ? null : '%',
        nota: i.disponibilidade.valor === null ? 'Conecte um coletor de monitoramento' : `${i.disponibilidade.equipamentos} equipamento(s) · ${i.disponibilidade.periodo}`,
        notaTipo: i.disponibilidade.valor === null ? 'neutra' : '', fonte: i.disponibilidade.ultima_coleta ? `Medido · última coleta ${hora(i.disponibilidade.ultima_coleta)}` : 'Sem amostras nas últimas 24 h' }) : null,
      i.chamados ? stat({ rotulo: 'Chamados em aberto', ic: 'chamado', valor: String(i.chamados.abertos).padStart(2, '0'),
        nota: i.chamados.criticos ? `${i.chamados.criticos} com prioridade crítica` : i.chamados.atrasados ? `${i.chamados.atrasados} com prazo vencido` : 'Nenhum crítico',
        notaTipo: i.chamados.criticos || i.chamados.atrasados ? 'aviso' : '', fonte: `Chamados técnicos · ${hora(i.chamados.em)}` }) : null,
      i.tecnicos ? stat({ rotulo: 'Técnicos em campo', ic: 'equipe', valor: String(i.tecnicos.em_campo), sufixo: ` / ${i.tecnicos.ativos}`, nota: i.tecnicos.criterio, notaTipo: 'neutra',
        fonte: `Chamados em rota ou execução · ${hora(i.tecnicos.em)}` }) : null,
      i.frota ? stat({ rotulo: 'Veículos disponíveis', ic: 'carro', valor: String(i.frota.disponiveis), sufixo: ` / ${i.frota.total}`,
        nota: i.frota.em_oficina ? `${i.frota.em_oficina} em oficina` : 'Nenhum em oficina', notaTipo: i.frota.em_oficina ? 'aviso' : '', fonte: `Cadastro e restrições · ${hora(i.frota.em)}` }) : null);
    if (!stats.children.length) stats.remove();

    limpar(alertas, el('div', { class: 'sobretitulo' }, 'Atenção na operação'), el('h2', {}, 'Alertas prioritários', el('span', { class: 'contagem' }, String(d.alertas.length).padStart(2, '0'))),
      d.alertas.length ? d.alertas.slice(0, 5).map((a) => el('a', { class: `alerta ${a.criticidade}`, href: a.link },
        el('span', { class: 'icone-alerta' }, icone(ICONE_ALERTA[a.tipo] ?? 'alerta')),
        el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'alerta-titulo' }, a.titulo), a.evidencia ? el('div', { class: 'alerta-texto' }, a.evidencia) : null,
          a.detalhe ? el('div', { class: 'alerta-texto' }, a.detalhe) : null,
          el('div', { class: 'alerta-meta' }, el('span', { class: 'crit' }, `Prioridade ${rotulo('severidade', a.criticidade).toLowerCase()}`), el('span', {}, a.em ? desde(a.em) : a.responsavel ?? ''))))) :
        el('p', { class: 'vazio' }, 'Nenhum alerta registrado pelas fontes conectadas.'),
      pode('noc.ver') ? el('a', { class: 'botao secundario', href: '#/noc', style: 'margin-top:14px' }, 'Abrir Central NOC', icone('seta')) : null);

    if (d.chamados) {
      limpar(chamados, tabela([
        { titulo: 'Chamado', valor: (c) => el('div', {}, el('div', { class: 'forte' }, c.titulo), el('div', { class: 'fraco' }, `#${c.numero}${c.bairro ? ` · ${c.bairro}` : ''}`)) },
        { titulo: 'Prioridade', valor: (c) => el('span', {}, el('span', { class: `prioridade ${c.prioridade}` }), ' ', rotulo('prioridade', c.prioridade)) },
        { titulo: 'Técnico', valor: (c) => c.tecnico_nome ?? el('span', { class: 'fraco' }, 'Sem técnico') },
        { titulo: 'Situação', valor: (c) => etqDe('statusChamado', c.status) },
        { titulo: 'Prazo', valor: (c) => (c.prazo ? el('span', { class: Date.parse(c.prazo) < Date.now() ? 'forte' : '' }, dataHora(c.prazo)) : '—') },
      ], d.chamados, { vazioTexto: 'Nenhum chamado em andamento.', aoClicar: (c) => ir(`#/chamados/${c.id}`) }));
    }
    if (d.agenda_frota) {
      limpar(agenda, d.agenda_frota.length ? el('ul', { class: 'linha-tempo' }, d.agenda_frota.map((m) => el('li', {},
        el('strong', {}, `${placa(m.placa)} · ${rotulo('tipoManutencao', m.tipo)}`), el('div', {}, m.descricao),
        el('small', {}, [m.data_planejada ? data(m.data_planejada) : 'Sem data', m.km_planejado ? km(m.km_planejado) : null, m.fornecedor_nome, rotulo('statusManutencao', m.status)].filter(Boolean).join(' · ')))))
        : vazio('Nada agendado', 'Ordens de manutenção e lavagem aparecem aqui.'));
    }
  }

  await Promise.all([atualizar(), desenharCamada()]);
  const t = setInterval(atualizar, 60_000);
  aoSair(() => clearInterval(t));
}
