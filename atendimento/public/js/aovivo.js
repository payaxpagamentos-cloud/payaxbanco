import { el, limpar, icone, iniciais, inteiro, porcento, marca, modal, formModal, confirmar, campo, escolha, toast, desde } from './ui.js';
import { api, BASE } from './api.js';

/**
 * Painel ao vivo da supervisão. O mesmo desenho serve dentro do sistema (menu "Ao vivo") e na TV
 * da sala (tv.html, com o link da tela). Busca os números a cada poucos segundos e, entre uma busca
 * e outra, os cronômetros (espera, ligação, relógio) andam sozinhos, segundo a segundo.
 */

const ATUALIZA_MS = 5000;
// Sem resposta do servidor por mais que isto, a tela avisa que os números podem estar velhos.
const VELHO_MS = 20_000;

const SITUACOES = {
  em_ligacao: ['Em ligação', 'ligacao'],
  lotado: ['Lotado', 'lotado'],
  atendendo: ['Atendendo', 'atendendo'],
  livre: ['Livre', 'livre'],
  pausa: ['Em pausa', 'pausa'],
  ausente: ['Ausente', 'ausente'],
};

/** 75 → "1:15"; 3700 → "1:01:40". */
export function relogio(s) {
  const t = Math.max(0, Math.floor(s ?? 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
/** Média de tempo, curta: "45s", "3 min", "1h 10". */
const tempo = (s) => {
  // Nulo, ou negativo por relógio desencontrado num registro antigo: melhor um traço do que um número absurdo.
  if (s === null || s === undefined || s < 0) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`;
};

/**
 * Cronômetro que anda sozinho: guarda o valor que veio do servidor e quando chegou.
 * `meta`: acima da metade fica amarelo, acima da meta fica vermelho.
 */
const cronometro = (segundos, { meta = null, classe = '' } = {}) =>
  el('span', { class: `av-crono ${classe}`, dataset: { base: String(segundos ?? 0), ...(meta ? { meta: String(meta) } : {}) } }, relogio(segundos));

function tique(raiz, recebidoEm) {
  const passou = (Date.now() - recebidoEm) / 1000;
  for (const c of raiz.querySelectorAll('.av-crono')) {
    const s = Number(c.dataset.base) + passou;
    c.textContent = relogio(s);
    if (c.dataset.meta) {
      const meta = Number(c.dataset.meta);
      c.classList.toggle('critico', s >= meta);
      c.classList.toggle('atencao', s >= meta / 2 && s < meta);
    }
  }
}

/** "Domingo, 15 de novembro" — só a primeira letra maiúscula. */
const dataLonga = (d) => { const t = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }); return t.charAt(0).toUpperCase() + t.slice(1); };

const bloco = (titulo, extra, ...conteudo) => el('section', { class: 'av-bloco' },
  el('header', {}, el('h2', {}, titulo), extra ? el('span', { class: 'av-extra' }, extra) : null), el('div', { class: 'av-corpo-bloco' }, conteudo));

function numeroGrande(rotulo, valor, nota, { tom = '', ic = null } = {}) {
  return el('div', { class: `av-kpi ${tom}` },
    el('div', { class: 'av-kpi-rotulo' }, ic ? icone(ic) : null, rotulo),
    el('div', { class: 'av-kpi-valor' }, valor),
    el('div', { class: 'av-kpi-nota' }, nota ?? ' '));
}

function kpis(d) {
  const a = d.agora;
  const fila = a.na_fila === 0 ? '' : a.maior_espera_s >= d.metas.espera_s ? 'critico' : a.maior_espera_s >= d.metas.espera_s / 2 ? 'atencao' : 'ativo';
  const ns = d.hoje.nivel_servico;
  const itens = [
    numeroGrande('Na fila agora', inteiro(a.na_fila),
      a.na_fila ? el('span', {}, 'maior espera ', cronometro(a.maior_espera_s, { meta: d.metas.espera_s })) : 'ninguém esperando',
      { tom: fila, ic: 'filas' }),
    numeroGrande('Com a ZOE', inteiro(a.com_zoe), a.com_zoe_telefone ? `${inteiro(a.com_zoe_telefone)} no telefone` : 'atendendo sozinha', { tom: 'zoe', ic: 'ia' }),
    numeroGrande('Com a equipe', inteiro(a.com_equipe), 'em atendimento agora', { ic: 'conversa' }),
    numeroGrande('Equipe livre', el('span', {}, inteiro(a.equipe_livre), el('small', {}, ` / ${inteiro(a.equipe_total)}`)),
      `${inteiro(a.equipe_online)} com o painel aberto`, { tom: a.equipe_livre === 0 && a.na_fila > 0 ? 'critico' : '', ic: 'equipe' }),
  ];
  if (d.telefone) {
    const t = d.telefone;
    itens.push(numeroGrande('Ligações agora', inteiro(t.em_curso),
      `${t.tocando ? `${inteiro(t.tocando)} tocando · ` : ''}${inteiro(t.em_curso)} de ${inteiro(t.canais)} canais`,
      { tom: t.canais && t.em_curso >= t.canais ? 'critico' : '', ic: 'telefone' }));
  } else {
    itens.push(numeroGrande('ZOE resolveu hoje', porcento(d.hoje.taxa_zoe), `${inteiro(d.hoje.resolvidas_zoe)} conversas sem a equipe`, { tom: 'zoe', ic: 'ok' }));
  }
  itens.push(numeroGrande('Assumidas em até 2 min', ns === null ? '—' : porcento(ns),
    d.hoje.assumidas ? `de ${inteiro(d.hoje.assumidas)} conversas hoje` : 'nenhuma passou pela fila hoje',
    { tom: ns === null ? '' : ns >= 80 ? 'bom' : ns >= 60 ? 'atencao' : 'critico', ic: 'relogio' }));
  return el('div', { class: 'av-kpis', style: `--n:${itens.length}` }, itens);
}

function alertas(d) {
  if (!d.alertas.length) return el('div', { class: 'av-alertas ok' }, el('span', { class: 'av-chip ok' }, icone('ok'), 'Tudo em dia: nenhuma fila fora da meta'));
  return el('div', { class: 'av-alertas' }, d.alertas.map((x) => el('span', { class: `av-chip ${x.nivel}` }, icone('alerta'), x.texto)));
}

function filas(d) {
  if (!d.filas.length) return bloco('Filas', null, el('p', { class: 'av-vazio' }, 'Nenhuma fila ativa.'));
  return bloco('Filas', `meta de espera: ${Math.round(d.metas.espera_s / 60)} min`,
    el('div', { class: 'av-tabela av-filas' },
      el('div', { class: 'av-linha cab' }, el('span', {}, 'Fila'), el('span', {}, 'Esperando'), el('span', {}, 'Maior espera'), el('span', {}, 'Atendendo'), el('span', {}, 'Livres')),
      d.filas.map((f) => el('div', { class: `av-linha ${f.nivel}` },
        el('span', { class: 'av-nome' }, el('i', { class: `av-ponto ${f.aberta ? 'aberta' : 'fechada'}`, title: f.aberta ? 'No horário' : 'Fora do horário' }), f.nome,
          f.aberta ? null : el('small', {}, 'fechada')),
        el('span', { class: 'av-num' }, inteiro(f.aguardando)),
        el('span', { class: 'av-num' }, f.aguardando ? cronometro(f.espera_s, { meta: d.metas.espera_s }) : '—'),
        el('span', { class: 'av-num' }, inteiro(f.em_atendimento)),
        el('span', { class: `av-num${f.aguardando && !f.disponiveis ? ' critico' : ''}` }, `${inteiro(f.disponiveis)}/${inteiro(f.atendentes)}`)))));
}

function esperando(d) {
  const lista = d.esperando;
  const total = d.agora.na_fila;
  return bloco('Esperando atendimento', total > lista.length ? `mostrando ${lista.length} de ${inteiro(total)}` : null,
    lista.length
      ? el('ol', { class: 'av-espera' }, lista.map((c, i) => el('li', { class: c.prioridade === 'alta' ? 'alta' : '' },
        el('span', { class: 'av-pos' }, String(i + 1)),
        el('span', { class: `av-canal c-${c.canal}`, title: c.canal === 'telefone' ? 'Telefone' : 'WhatsApp' }, icone(c.canal === 'telefone' ? 'telefone' : 'conversa')),
        el('span', { class: 'av-quem' }, el('strong', {}, c.cliente), el('small', {}, `${c.telefone} · ${c.fila}${c.assunto ? ` · ${c.assunto}` : ''}`)),
        c.prioridade === 'alta' ? el('span', { class: 'av-tag' }, 'Prioridade') : null,
        cronometro(c.espera_s, { meta: d.metas.espera_s, classe: 'grande' }))))
      : el('div', { class: 'av-vazio grande' }, icone('ok'), el('span', {}, 'Ninguém esperando. A fila está limpa.')));
}

function equipe(d) {
  const pessoas = d.equipe;
  const MAX = 24;
  const contagem = {};
  for (const p of pessoas) contagem[p.situacao] = (contagem[p.situacao] ?? 0) + 1;
  const resumo = ['em_ligacao', 'atendendo', 'lotado', 'livre', 'pausa', 'ausente'].filter((s) => contagem[s])
    .map((s) => el('span', { class: `av-mini ${SITUACOES[s][1]}` }, el('i'), `${contagem[s]} ${SITUACOES[s][0].toLowerCase()}`));
  return bloco('Equipe', el('span', { class: 'av-resumo' }, resumo),
    pessoas.length
      ? el('div', { class: 'av-equipe' }, pessoas.slice(0, MAX).map((p) => {
        const [rotulo, tom] = SITUACOES[p.situacao];
        const detalhe = p.situacao === 'em_ligacao' ? cronometro(p.desde_s)
          : ['atendendo', 'lotado'].includes(p.situacao) ? `${p.atendendo}/${p.capacidade}` : null;
        return el('div', { class: `av-pessoa ${tom}` },
          el('span', { class: 'av-avatar' }, iniciais(p.nome)),
          el('span', { class: 'av-dados' }, el('strong', {}, p.nome),
            el('small', {}, el('i'), rotulo, detalhe ? el('span', { class: 'av-sep' }, '·') : null, detalhe)),
          el('span', { class: 'av-feitas', title: 'Encerradas hoje' }, inteiro(p.encerradas_hoje)));
      }), pessoas.length > MAX ? el('div', { class: 'av-pessoa mais' }, `+${pessoas.length - MAX} pessoas`) : null)
      : el('p', { class: 'av-vazio' }, 'Nenhum atendente cadastrado.'));
}

function telefone(d) {
  const t = d.telefone;
  if (!t) return null;
  return bloco('Telefone', `${inteiro(t.ramais_online)}/${inteiro(t.ramais_total)} ramais online`,
    el('div', { class: 'av-tel-numeros' },
      el('div', {}, el('strong', {}, inteiro(t.recebidas)), el('small', {}, 'recebidas')),
      el('div', { class: 'bom' }, el('strong', {}, inteiro(t.atendidas)), el('small', {}, 'atendidas')),
      el('div', { class: t.perdidas ? 'critico' : '' }, el('strong', {}, inteiro(t.perdidas)), el('small', {}, 'perdidas')),
      el('div', {}, el('strong', {}, tempo(t.tma_s)), el('small', {}, 'duração média'))),
    t.chamadas.length
      ? el('ul', { class: 'av-chamadas' }, t.chamadas.map((c) => el('li', { class: c.atendida ? '' : 'tocando' },
        el('span', { class: `av-dir d-${c.direcao}` }, c.direcao === 'saida' ? '↗' : c.direcao === 'entrada' ? '↙' : '↔'),
        el('span', { class: 'av-quem' }, el('strong', {}, c.cliente), el('small', {}, c.atendida ? c.ramal : 'tocando…')),
        cronometro(c.duracao_s))))
      : el('p', { class: 'av-vazio' }, 'Nenhuma ligação agora.'));
}

function porHora(d) {
  const horas = d.hoje.por_hora;
  // A hora do servidor (fuso da empresa), não a do aparelho: a barra "agora" bate com os números.
  const agoraH = d.hoje.hora_atual ?? new Date().getHours();
  const max = Math.max(1, ...horas.map((h) => h.zoe + h.equipe));
  // Do primeiro movimento (ou 7h) até a hora atual: a TV não precisa de madrugada vazia.
  const primeira = Math.min(7, horas.findIndex((h) => h.zoe + h.equipe > 0) === -1 ? 7 : horas.findIndex((h) => h.zoe + h.equipe > 0));
  const ultima = Math.max(agoraH, primeira + 11);
  const vistas = horas.slice(primeira, Math.min(24, ultima + 1));
  return el('div', { class: 'av-horas' },
    el('div', { class: 'av-barras' }, vistas.map((h) => {
      const total = h.zoe + h.equipe;
      return el('div', { class: `av-hora${h.hora === agoraH ? ' agora' : ''}`, title: `${h.hora}h: ${total} conversas (${h.zoe} só com a ZOE)` },
        el('div', { class: 'av-pilha', style: `height:${(total / max) * 100}%` },
          total ? el('span', { class: 'av-valor' }, String(total)) : null,
          el('i', { class: 'equipe', style: `flex:${h.equipe}` }), el('i', { class: 'zoe', style: `flex:${h.zoe}` })),
        el('span', { class: 'av-h' }, `${h.hora}h`));
    })),
    el('div', { class: 'av-legenda' }, el('span', {}, el('i', { class: 'zoe' }), 'Só com a ZOE'), el('span', {}, el('i', { class: 'equipe' }), 'Passou pela equipe')));
}

function hoje(d) {
  const h = d.hoje;
  const item = (rotulo, valor, tom = '') => el('div', { class: `av-dia ${tom}` }, el('strong', {}, valor), el('small', {}, rotulo));
  return bloco('Hoje', `${inteiro(h.conversas)} conversas`,
    el('div', { class: 'av-dias' },
      item('ZOE resolveu', porcento(h.taxa_zoe), 'zoe'),
      item('Equipe resolveu', inteiro(h.resolvidas_equipe)),
      item('1ª resposta', tempo(h.primeira_resposta_s)),
      item('Espera na fila', tempo(h.espera_fila_s), h.espera_fila_s >= d.metas.espera_s ? 'critico' : ''),
      item('Abandonadas', inteiro(h.abandonadas), h.abandonadas ? 'atencao' : ''),
      item('Satisfação', h.csat_medio === null ? '—' : `${h.csat_medio.toLocaleString('pt-BR')} ★`, h.csat_medio !== null && h.csat_medio < 3.5 ? 'atencao' : '')),
    porHora(d));
}

// ---------- Visual clean ----------
// Só o essencial, para ler de longe: quatro (ou cinco) números grandes, uma linha de alerta, quem espera,
// como está a equipe e uma linha com o dia. Sem cartões, sem ícones, cor só onde pede atenção.

function cleanNumero(rotulo, valor, nota, tom = '') {
  return el('div', { class: `cl-num ${tom}` }, el('span', { class: 'cl-rotulo' }, rotulo), el('strong', {}, valor), el('small', {}, nota ?? '\u00a0'));
}

function desenharClean(d) {
  const a = d.agora;
  const meta = d.metas.espera_s;
  const tomFila = a.na_fila === 0 ? '' : a.maior_espera_s >= meta ? 'critico' : a.maior_espera_s >= meta / 2 ? 'atencao' : '';
  const hero = el('div', { class: 'cl-hero' },
    cleanNumero('Na fila', inteiro(a.na_fila), a.na_fila ? el('span', {}, 'maior espera ', cronometro(a.maior_espera_s, { meta })) : 'ninguém esperando', tomFila),
    cleanNumero('Com a ZOE', inteiro(a.com_zoe), 'atendendo sozinha', 'zoe'),
    cleanNumero('Com a equipe', inteiro(a.com_equipe), 'em atendimento'),
    cleanNumero('Livres', el('span', {}, inteiro(a.equipe_livre), el('em', {}, `/${inteiro(a.equipe_total)}`)), 'da equipe',
      a.equipe_livre === 0 && a.na_fila > 0 ? 'critico' : ''),
    d.telefone ? cleanNumero('Ligações', inteiro(d.telefone.em_curso), d.telefone.tocando ? `${inteiro(d.telefone.tocando)} tocando` : 'em curso',
      d.telefone.canais && d.telefone.em_curso >= d.telefone.canais ? 'critico' : '') : null);

  const [primeiro, ...outros] = d.alertas;
  const alerta = el('div', { class: `cl-alerta ${primeiro ? primeiro.nivel : 'ok'}` }, el('i'),
    primeiro ? primeiro.texto : 'Tudo em dia',
    outros.length ? el('small', {}, `+${outros.length} ${outros.length === 1 ? 'alerta' : 'alertas'}`) : null);

  const filasComGente = d.filas.filter((f) => f.aguardando > 0);
  const espera = el('section', { class: 'cl-col' },
    el('header', {}, el('h2', {}, 'Esperando'),
      el('span', { class: 'cl-filas' }, filasComGente.map((f) => el('span', { class: f.nivel }, f.nome, el('b', {}, inteiro(f.aguardando)))))),
    d.esperando.length
      ? el('ol', { class: 'cl-lista' }, d.esperando.slice(0, 7).map((c) => el('li', {},
        el('span', { class: 'cl-quem' }, el('strong', {}, c.cliente, c.prioridade === 'alta' ? el('i', { class: 'cl-alta', title: 'Prioridade alta' }) : null),
          el('small', {}, `${c.fila}${c.canal === 'telefone' ? ' · telefone' : ''}`)),
        cronometro(c.espera_s, { meta }))))
      : el('p', { class: 'cl-vazio' }, 'Ninguém esperando.'),
    a.na_fila > 7 ? el('p', { class: 'cl-mais' }, `e mais ${inteiro(a.na_fila - 7)} na fila`) : null);

  const pessoas = d.equipe.filter((p) => p.situacao !== 'ausente');
  const ausentes = d.equipe.length - pessoas.length;
  const equipe = el('section', { class: 'cl-col' },
    el('header', {}, el('h2', {}, 'Equipe'), ausentes ? el('span', { class: 'cl-filas' }, `${ausentes} ${ausentes === 1 ? 'ausente' : 'ausentes'}`) : null),
    pessoas.length
      ? el('ul', { class: 'cl-lista' }, pessoas.slice(0, 9).map((p) => {
        const [rotulo, tom] = SITUACOES[p.situacao];
        return el('li', { class: tom },
          el('span', { class: 'cl-quem' }, el('strong', {}, el('i', { class: 'cl-ponto' }), p.nome)),
          el('span', { class: 'cl-situacao' }, rotulo,
            p.situacao === 'em_ligacao' ? cronometro(p.desde_s) : ['atendendo', 'lotado'].includes(p.situacao) ? el('b', {}, `${p.atendendo}/${p.capacidade}`) : null));
      }))
      : el('p', { class: 'cl-vazio' }, 'Ninguém da equipe com o painel aberto.'),
    pessoas.length > 9 ? el('p', { class: 'cl-mais' }, `e mais ${pessoas.length - 9}`) : null);

  const h = d.hoje;
  const dado = (rotulo, valor, tom = '') => el('span', { class: `cl-dado ${tom}` }, el('b', {}, valor), rotulo);
  const horas = h.por_hora;
  const max = Math.max(1, ...horas.map((x) => x.zoe + x.equipe));
  const agoraH = h.hora_atual ?? new Date().getHours();
  const rodape = el('footer', { class: 'cl-rodape' },
    el('span', { class: 'cl-hoje' }, 'Hoje'),
    dado('conversas', inteiro(h.conversas)),
    dado('resolvidas pela ZOE', porcento(h.taxa_zoe), 'zoe'),
    dado('espera média', tempo(h.espera_fila_s), h.espera_fila_s >= meta ? 'critico' : ''),
    dado('assumidas em até 2 min', h.nivel_servico === null ? '—' : porcento(h.nivel_servico)),
    h.csat_medio !== null ? dado('satisfação', `${h.csat_medio.toLocaleString('pt-BR')}★`) : null,
    el('span', { class: 'cl-faisca', title: 'Conversas por hora' }, horas.slice(6, 24).map((x) =>
      el('i', { class: x.hora === agoraH ? 'agora' : '', style: `height:${Math.max(6, ((x.zoe + x.equipe) / max) * 100)}%` }))));

  return [hero, alerta, el('div', { class: 'cl-meio' }, espera, equipe), rodape];
}

/**
 * Monta o painel em `alvo`. `buscar()` devolve os dados (pela sessão ou pelo link da TV).
 * Devolve a função que para tudo (troca de tela).
 */
export function montarPainel(alvo, { buscar, tv = false, aoFalhar = null, visual = 'completo' }) {
  const relogioEl = el('strong', { class: 'av-relogio' });
  const dataEl = el('small', { class: 'av-data' });
  const estado = el('span', { class: 'av-vivo' }, el('i'), 'Ao vivo');
  const nome = el('span', { class: 'av-empresa' });
  const corpo = el('div', { class: 'av-conteudo' }, el('div', { class: 'av-carregando' }, 'Carregando o painel…'));
  const raiz = el('div', { class: `aovivo${tv ? ' tv' : ''}${visual === 'clean' ? ' clean' : ''}` },
    el('header', { class: 'av-topo' },
      el('div', { class: 'av-ident' }, marca('ZOE'), nome),
      el('div', { class: 'av-hora-certa' }, estado, el('span', { class: 'av-quando' }, relogioEl, dataEl))),
    corpo);
  limpar(alvo, raiz);

  let recebidoEm = Date.now();
  let ultimoOk = 0;
  let parado = false;
  let timer = null;

  let ultimo = null;
  const desenhar = (d) => {
    ultimo = d;
    nome.textContent = d.empresa.nome;
    if (visual === 'clean') limpar(corpo, desenharClean(d));
    else {
      limpar(corpo,
        kpis(d),
        alertas(d),
        el('div', { class: 'av-grade' }, filas(d), esperando(d), el('div', { class: 'av-coluna' }, equipe(d), telefone(d))),
        hoje(d));
    }
    tique(raiz, recebidoEm);
    // Na TV a altura é fixa: o bloco que não coube inteiro ganha um esmaecido embaixo, em vez de cortar uma linha ao meio.
    for (const b of raiz.querySelectorAll('.av-corpo-bloco, .cl-col')) b.classList.toggle('transborda', b.scrollHeight > b.clientHeight + 2);
  };

  const ciclo = async () => {
    if (parado) return;
    try {
      const d = await buscar();
      if (parado) return;
      recebidoEm = Date.now();
      ultimoOk = recebidoEm;
      desenhar(d);
    } catch (err) {
      if (aoFalhar?.(err) === 'parar') { parado = true; return; }
      if (!ultimoOk) limpar(corpo, el('div', { class: 'av-carregando erro' }, err.message || 'Não foi possível carregar o painel.'));
    }
    if (!parado) timer = setTimeout(ciclo, ATUALIZA_MS);
  };

  const segundo = setInterval(() => {
    const agora = new Date();
    relogioEl.textContent = agora.toLocaleTimeString('pt-BR');
    dataEl.textContent = dataLonga(agora);
    const velho = ultimoOk && Date.now() - ultimoOk > VELHO_MS;
    estado.classList.toggle('erro', Boolean(velho));
    estado.lastChild.textContent = velho ? 'Sem conexão — tentando de novo' : 'Ao vivo';
    if (ultimoOk) tique(raiz, recebidoEm);
  }, 1000);
  relogioEl.textContent = new Date().toLocaleTimeString('pt-BR');
  dataEl.textContent = dataLonga(new Date());

  // A TV volta do descanso de tela (ou a aba volta a aparecer): busca na hora, sem esperar o ciclo.
  const aoVoltar = () => { if (document.visibilityState === 'visible' && !parado) { clearTimeout(timer); ciclo(); } };
  document.addEventListener('visibilitychange', aoVoltar);
  ciclo();

  const parar = () => {
    parado = true;
    clearTimeout(timer);
    clearInterval(segundo);
    document.removeEventListener('visibilitychange', aoVoltar);
  };
  /** Troca o visual na hora, com os últimos números (sem esperar a próxima busca). */
  const trocarVisual = (v) => {
    visual = v === 'clean' ? 'clean' : 'completo';
    raiz.classList.toggle('clean', visual === 'clean');
    if (ultimo) desenhar(ultimo);
  };
  return { raiz, parar, trocarVisual };
}

// ---------- Dentro do sistema: menu "Ao vivo" ----------

/** Endereço da página da TV, com o link da tela no fragmento (#): o fragmento não vai para o servidor nem para os logs. */
const enderecoTv = (base, chave, visual) => `${location.origin}${base}/tv.html#k=${chave}${visual === 'clean' ? '&v=clean' : ''}`;

const GUARDA_VISUAL = 'atend.aovivo.visual';
const lerVisual = () => { try { return localStorage.getItem(GUARDA_VISUAL) === 'clean' ? 'clean' : 'completo'; } catch { return 'completo'; } };

export async function telaAoVivo(ctx) {
  let visual = lerVisual();
  const { raiz, parar, trocarVisual } = montarPainel(ctx.conteudo, { buscar: () => api.get(`/empresas/${ctx.empresaId}/ao-vivo`), visual });
  // Tela cheia: o painel ocupa o monitor inteiro com letras maiores, como na TV.
  const aoMudarTela = () => raiz.classList.toggle('tv', document.fullscreenElement === raiz);
  document.addEventListener('fullscreenchange', aoMudarTela);
  ctx.parar(() => { parar(); document.removeEventListener('fullscreenchange', aoMudarTela); if (document.fullscreenElement) document.exitFullscreen?.(); });

  const podeCriar = ctx.pode('configuracoes.editar') && !ctx.somenteLeitura;
  const links = async () => {
    const lista = await api.get(`/empresas/${ctx.empresaId}/telas-tv`);
    modal('Links de TV', (fechar) => [
      el('p', { class: 'mudo', style: 'margin-top:0' },
        'Um link de TV abre só este painel, sem login, para deixar a TV da sala ligada o dia todo. '
        + 'Ele não abre conversa nem mostra dados completos do cliente. Revogue quando a TV sair de uso.'),
      lista.length
        ? el('div', { class: 'av-links' }, lista.map((t) => el('div', { class: 'av-link' },
          el('span', {}, el('strong', {}, t.nome), el('small', { class: 'mudo' },
            `${t.ultimo_uso ? `visto ${desde(t.ultimo_uso)}` : 'ainda não aberto'}${t.criada_por ? ` · criado por ${t.criada_por}` : ''}`)),
          podeCriar ? el('button', { class: 'btn pequeno perigo', type: 'button', onclick: async () => {
            if (!await confirmar('Revogar link de TV', `A tela "${t.nome}" para de atualizar na hora.`, 'Revogar')) return;
            await api.del(`/empresas/${ctx.empresaId}/telas-tv/${t.id}`);
            toast('Link revogado.');
            fechar();
            links();
          } }, 'Revogar') : null)))
        : el('p', { class: 'mudo' }, 'Nenhum link de TV ativo.'),
      el('div', { class: 'rodape-modal' },
        el('button', { class: 'btn', type: 'button', onclick: () => fechar() }, 'Fechar'),
        podeCriar ? el('button', { class: 'btn primario', type: 'button', onclick: () => { fechar(); novo(); } }, icone('mais'), 'Novo link de TV') : null),
    ], { largo: 'medio' });
  };
  const novo = async () => {
    let criada = null;
    let escolhido = 'clean';
    const ok = await formModal('Novo link de TV', () => [
      campo('Nome da tela (para você reconhecer)', { name: 'nome', required: true, maxlength: 80, value: 'TV da supervisão' }),
      escolha('Visual', 'visual', { clean: 'Clean: só o essencial, números grandes', completo: 'Completo: filas, equipe, telefone e o dia' }, 'clean'),
    ], async (d) => { escolhido = d.visual; criada = await api.post(`/empresas/${ctx.empresaId}/telas-tv`, { nome: d.nome }); return true; }, { rotulo: 'Criar link' });
    if (!ok || !criada) return;
    const url = enderecoTv(BASE, criada.chave, escolhido);
    modal('Link da TV criado', (fechar) => [
      el('p', { class: 'mudo', style: 'margin-top:0' }, 'Abra este endereço no navegador da TV (ou do computador ligado nela) e deixe em tela cheia (F11). '
        + 'Copie agora: por segurança, o link completo não aparece de novo.'),
      el('div', { class: 'segredo' }, url),
      el('div', { class: 'rodape-modal' },
        el('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard?.writeText(url).then(() => toast('Link copiado.'), () => toast('Não foi possível copiar: selecione e copie à mão.', true)) }, 'Copiar link'),
        el('button', { class: 'btn primario', type: 'button', onclick: () => fechar() }, 'Pronto')),
    ], { largo: 'medio' });
  };

  // Completo ou clean: a escolha fica guardada neste navegador.
  const seletorVisual = el('div', { class: 'segmentado', role: 'group', 'aria-label': 'Visual do painel' },
    [['completo', 'Completo'], ['clean', 'Clean']].map(([v, rotulo]) => el('button', { class: `btn${visual === v ? ' on' : ''}`, type: 'button', dataset: { visual: v },
      onclick: () => {
        visual = v;
        try { localStorage.setItem(GUARDA_VISUAL, v); } catch { /* vale só agora */ }
        for (const b of seletorVisual.children) b.classList.toggle('on', b.dataset.visual === v);
        trocarVisual(v);
      } }, rotulo)));
  ctx.acoes(
    seletorVisual,
    el('button', { class: 'btn', type: 'button', onclick: links }, icone('tv'), 'Links de TV'),
    el('button', { class: 'btn primario', type: 'button', onclick: () => raiz.requestFullscreen?.().catch(() => toast('O navegador não deixou abrir em tela cheia.', true)) },
      icone('tela-cheia'), 'Tela cheia'));
}
