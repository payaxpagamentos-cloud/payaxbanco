import { el, limpar, icone, iniciais, inteiro, porcento, marca, modal, formModal, confirmar, campo, toast, desde } from './ui.js';
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

/**
 * Monta o painel em `alvo`. `buscar()` devolve os dados (pela sessão ou pelo link da TV).
 * Devolve a função que para tudo (troca de tela).
 */
export function montarPainel(alvo, { buscar, tv = false, aoFalhar = null }) {
  const relogioEl = el('strong', { class: 'av-relogio' });
  const dataEl = el('small', { class: 'av-data' });
  const estado = el('span', { class: 'av-vivo' }, el('i'), 'Ao vivo');
  const nome = el('span', { class: 'av-empresa' });
  const corpo = el('div', { class: 'av-conteudo' }, el('div', { class: 'av-carregando' }, 'Carregando o painel…'));
  const raiz = el('div', { class: `aovivo${tv ? ' tv' : ''}` },
    el('header', { class: 'av-topo' },
      el('div', { class: 'av-ident' }, marca('ZOE'), nome),
      el('div', { class: 'av-hora-certa' }, estado, el('span', { class: 'av-quando' }, relogioEl, dataEl))),
    corpo);
  limpar(alvo, raiz);

  let recebidoEm = Date.now();
  let ultimoOk = 0;
  let parado = false;
  let timer = null;

  const desenhar = (d) => {
    nome.textContent = d.empresa.nome;
    limpar(corpo,
      kpis(d),
      alertas(d),
      el('div', { class: 'av-grade' }, filas(d), esperando(d), el('div', { class: 'av-coluna' }, equipe(d), telefone(d))),
      hoje(d));
    tique(raiz, recebidoEm);
    // Na TV a altura é fixa: o bloco que não coube inteiro ganha um esmaecido embaixo, em vez de cortar uma linha ao meio.
    for (const b of raiz.querySelectorAll('.av-corpo-bloco')) b.classList.toggle('transborda', b.scrollHeight > b.clientHeight + 2);
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
  return { raiz, parar };
}

// ---------- Dentro do sistema: menu "Ao vivo" ----------

/** Endereço da página da TV, com o link da tela no fragmento (#): o fragmento não vai para o servidor nem para os logs. */
const enderecoTv = (base, chave) => `${location.origin}${base}/tv.html#k=${chave}`;

export async function telaAoVivo(ctx) {
  const { raiz, parar } = montarPainel(ctx.conteudo, { buscar: () => api.get(`/empresas/${ctx.empresaId}/ao-vivo`) });
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
    const ok = await formModal('Novo link de TV', () => [
      campo('Nome da tela (para você reconhecer)', { name: 'nome', required: true, maxlength: 80, value: 'TV da supervisão' }),
    ], async (d) => { criada = await api.post(`/empresas/${ctx.empresaId}/telas-tv`, d); return true; }, { rotulo: 'Criar link' });
    if (!ok || !criada) return;
    const url = enderecoTv(BASE, criada.chave);
    modal('Link da TV criado', (fechar) => [
      el('p', { class: 'mudo', style: 'margin-top:0' }, 'Abra este endereço no navegador da TV (ou do computador ligado nela) e deixe em tela cheia (F11). '
        + 'Copie agora: por segurança, o link completo não aparece de novo.'),
      el('div', { class: 'segredo' }, url),
      el('div', { class: 'rodape-modal' },
        el('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard?.writeText(url).then(() => toast('Link copiado.'), () => toast('Não foi possível copiar: selecione e copie à mão.', true)) }, 'Copiar link'),
        el('button', { class: 'btn primario', type: 'button', onclick: () => fechar() }, 'Pronto')),
    ], { largo: 'medio' });
  };

  ctx.acoes(
    el('button', { class: 'btn', type: 'button', onclick: links }, icone('tv'), 'Links de TV'),
    el('button', { class: 'btn primario', type: 'button', onclick: () => raiz.requestFullscreen?.().catch(() => toast('O navegador não deixou abrir em tela cheia.', true)) },
      icone('tela-cheia'), 'Tela cheia'));
}
