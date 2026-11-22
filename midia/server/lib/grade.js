'use strict';

const crypto = require('node:crypto');
const { lerConfig } = require('../db');
const { local, dentroDaJanela, minutosDe } = require('./datas');

/**
 * Programação de uma TV: a sequência de criativos que o player roda em loop.
 *
 * Como a grade é montada:
 *  1. entram as campanhas ativas cujo período, dias da semana e faixa de horário batem com o momento,
 *     que têm alvo compatível com a tela (ou nenhum alvo = todas) e ao menos um criativo aprovado e no prazo;
 *  2. cada campanha recebe um número de inserções no loop proporcional às inserções por hora contratadas
 *     (sempre pelo menos uma por criativo, para todos irem ao ar);
 *  3. se o loop passar do tempo máximo, as campanhas de menor prioridade perdem inserções;
 *     se ficar curto demais, o conteúdo institucional e o do próprio ponto completam;
 *  4. as inserções são espalhadas pelo loop (nunca duas do mesmo anunciante em sequência, quando dá).
 *
 * O resultado é determinístico: a mesma situação gera a mesma versão, e o player só baixa de novo quando ela muda.
 */

/** Tela com os dados do ponto que a programação usa (inclusive a identidade que vai no comunicado). */
const SQL_TELA = `SELECT t.*, l.categoria, l.cidade, l.uf, l.nome AS local_nome, l.administradora, l.assinatura, l.logo_arquivo
  FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.id = ?`;

const SQL_CAMPANHAS = `SELECT c.*, a.nome AS anunciante_nome FROM campanhas c JOIN anunciantes a ON a.id = c.anunciante_id
  WHERE c.status = 'ativa' AND a.status = 'ativo' AND c.inicio <= ? AND (c.fim IS NULL OR c.fim >= ?)`;

const SQL_CRIATIVOS = `SELECT m.id, m.nome, m.tipo, m.mime, m.sha256, m.orientacao, m.bytes, COALESCE(cm.duracao_s, m.duracao_s) AS duracao_s, cm.ordem
  FROM campanha_midias cm JOIN midias m ON m.id = cm.midia_id
  WHERE cm.campanha_id = ? AND m.status = 'aprovada' AND (m.validade_ate IS NULL OR m.validade_ate >= ?)
  ORDER BY cm.ordem, m.id`;

// Comunicados do ponto no ar hoje (a contrapartida do condomínio): todos entram pelo menos uma vez no loop.
const SQL_COMUNICADOS = `SELECT id, titulo, texto, tipo, duracao_s FROM comunicados
  WHERE local_id = ? AND status = 'aprovado' AND inicio <= ? AND fim >= ?
  ORDER BY (tipo = 'urgente') DESC, id`;

// Agenda do ponto: o que ainda vai acontecer (assembleia, dedetização, entrega), para a tela mostrar
// ao morador o que vem pela frente — a parte da tela que ele procura por vontade própria.
const SQL_AGENDA = `SELECT titulo, tipo, evento_em, evento_hora FROM comunicados
  WHERE local_id = ? AND status = 'aprovado' AND evento_em IS NOT NULL AND evento_em >= ?
  ORDER BY evento_em, COALESCE(evento_hora, '00:00') LIMIT 4`;

// Institucional: primeiro o conteúdo do próprio ponto, depois o da plataforma (anunciante_id e local_id nulos).
const SQL_INSTITUCIONAL = `SELECT m.id, m.nome, m.tipo, m.mime, m.sha256, m.orientacao, m.bytes, m.duracao_s, m.local_id
  FROM midias m
  WHERE m.uso = 'institucional' AND m.status = 'aprovada' AND (m.validade_ate IS NULL OR m.validade_ate >= ?)
    AND (m.local_id IS NULL OR m.local_id = ?)
  ORDER BY (m.local_id IS NULL), m.id`;

/** A campanha pode ir nesta tela? Sem alvos, vai em todas. */
function alvoBate(alvos, tela) {
  if (!alvos.length) return true;
  return alvos.some((a) => {
    if (a.tipo === 'tela') return Number(a.valor) === tela.id;
    if (a.tipo === 'local') return Number(a.valor) === tela.local_id;
    if (a.tipo === 'categoria') return a.valor === tela.categoria;
    if (a.tipo === 'cidade') return String(a.valor).toLowerCase() === String(tela.cidade ?? '').toLowerCase();
    return false;
  });
}

const noPrazo = (c, data) => c.inicio <= data && (!c.fim || c.fim >= data);
const noDia = (c, diaSemana) => String(c.dias_semana).includes(String(diaSemana));
const naHora = (c, hhmm) => dentroDaJanela(hhmm, c.hora_inicio, c.hora_fim);

/** Campanhas que podem ir ao ar nesta tela neste momento, já com os criativos. */
function elegiveis(db, tela, { data, hhmm, diaSemana }) {
  const alvosPor = new Map();
  for (const a of db.prepare('SELECT campanha_id, tipo, valor FROM campanha_alvos').all()) {
    if (!alvosPor.has(a.campanha_id)) alvosPor.set(a.campanha_id, []);
    alvosPor.get(a.campanha_id).push(a);
  }
  const jaHoje = new Map(db.prepare('SELECT campanha_id, insercoes FROM resumo_dia WHERE data = ? AND tela_id = ?').all(data, tela.id)
    .map((r) => [r.campanha_id, r.insercoes]));

  const lista = [];
  for (const c of db.prepare(SQL_CAMPANHAS).all(data, data)) {
    if (!noDia(c, diaSemana) || !naHora(c, hhmm)) continue;
    if (!alvoBate(alvosPor.get(c.id) ?? [], tela)) continue;
    if (c.limite_dia > 0 && (jaHoje.get(c.id) ?? 0) >= c.limite_dia) continue;
    let criativos = db.prepare(SQL_CRIATIVOS).all(c.id, data);
    if (!criativos.length) continue;
    // Se a campanha tem criativo na orientação da TV, só esses vão ao ar nela.
    const naOrientacao = criativos.filter((m) => !m.orientacao || m.orientacao === tela.orientacao);
    if (naOrientacao.length) criativos = naOrientacao;
    lista.push({ campanha: c, criativos });
  }
  return lista;
}

const NOMES_DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const dataBr = (d) => (d ? d.split('-').reverse().join('/') : '');

/**
 * Por que a campanha está (ou não está) passando AGORA.
 *
 * Campanha "no ar" no painel não quer dizer anúncio na TV: ela pode estar fora do dia, fora do horário,
 * sem criativo aprovado ou sem TV escolhida — e de fora não dá para ver nada disso. Este diagnóstico
 * aplica as MESMAS regras que montam o loop da TV (elegiveis), então o motivo que ele dá é o motivo real.
 */
function porQueNaoPassa(db, campanhaId, instante = new Date()) {
  const { data, hhmm, diaSemana } = local(instante);
  const c = db.prepare(`SELECT c.*, a.status AS anunciante_status FROM campanhas c JOIN anunciantes a ON a.id = c.anunciante_id
    WHERE c.id = ?`).get(campanhaId);
  if (!c) return null;
  const motivos = [];

  if (c.status !== 'ativa') {
    const situacao = { rascunho: 'rascunho', aguardando: 'aguardando aprovação', pausada: 'pausada', encerrada: 'encerrada', recusada: 'recusada' }[c.status] ?? c.status;
    motivos.push(`A campanha está ${situacao} — só campanha no ar vai para as TVs.`);
  }
  if (c.anunciante_status !== 'ativo') motivos.push('O anunciante está inativo.');
  if (c.inicio > data) motivos.push(`Ainda não começou: começa em ${dataBr(c.inicio)}.`);
  if (c.fim && c.fim < data) motivos.push(`Já terminou: o último dia foi ${dataBr(c.fim)}.`);
  if (!noDia(c, diaSemana)) {
    const dias = String(c.dias_semana).split('').map(Number).sort().map((d) => NOMES_DIAS[d]);
    // "no domingo", "na segunda"; com vários dias, a lista corrida: "segunda, terça e sábado".
    const quando = dias.length === 1
      ? `${['domingo', 'sábado'].includes(dias[0]) ? 'no' : 'na'} ${dias[0]}`
      : `${dias.slice(0, -1).join(', ')} e ${dias.at(-1)}`;
    motivos.push(`Hoje é ${NOMES_DIAS[diaSemana]}, e a campanha só passa ${quando}.`);
  }
  if (!naHora(c, hhmm)) motivos.push(`Fora do horário: agora são ${hhmm}, e ela passa das ${c.hora_inicio} às ${c.hora_fim}.`);

  const criativos = db.prepare(`SELECT m.status, m.validade_ate FROM campanha_midias cm JOIN midias m ON m.id = cm.midia_id
    WHERE cm.campanha_id = ?`).all(campanhaId);
  const validos = criativos.filter((m) => m.status === 'aprovada' && (!m.validade_ate || m.validade_ate >= data));
  if (!criativos.length) motivos.push('Nenhum criativo na campanha.');
  else if (!validos.length) {
    const pendentes = criativos.filter((m) => m.status === 'pendente').length;
    const vencidos = criativos.filter((m) => m.status === 'aprovada' && m.validade_ate && m.validade_ate < data).length;
    motivos.push(`Nenhum criativo pode ir ao ar${pendentes ? `: ${pendentes} aguardando aprovação (aprove em Criativos)` : ''}`
      + `${vencidos ? `${pendentes ? ',' : ':'} ${vencidos} com a validade vencida` : ''}.`);
  }

  const alvos = db.prepare('SELECT tipo, valor FROM campanha_alvos WHERE campanha_id = ?').all(campanhaId);
  const telas = db.prepare(`SELECT t.*, l.categoria, l.cidade, l.uf FROM telas t JOIN locais l ON l.id = t.local_id
    WHERE t.status = 'ativa' AND l.status = 'ativo'`).all().filter((t) => alvoBate(alvos, t));
  if (!telas.length) motivos.push('Nenhuma TV escolhida em "Onde passa" (ou as escolhidas estão inativas).');
  else if (!telas.some((t) => t.pareada_em)) motivos.push('As TVs escolhidas ainda não foram pareadas com um aparelho.');

  if (c.limite_dia > 0 && telas.length) {
    const hoje = db.prepare('SELECT tela_id, insercoes FROM resumo_dia WHERE data = ? AND campanha_id = ?').all(data, campanhaId);
    if (telas.every((t) => (hoje.find((h) => h.tela_id === t.id)?.insercoes ?? 0) >= c.limite_dia)) {
      motivos.push(`Já bateu o limite de ${c.limite_dia} inserções por TV hoje; volta amanhã.`);
    }
  }
  return { passando: motivos.length === 0, motivos, telas: telas.length, agora: `${NOMES_DIAS[diaSemana]}, ${hhmm}` };
}

/** Espalha as inserções pelo loop: cada uma ganha uma posição fracionária e a ordem sai dela. */
function espalhar(blocos) {
  const slots = [];
  for (const b of blocos) {
    for (let j = 0; j < b.insercoes; j++) {
      slots.push({ pos: (j + 0.5) / b.insercoes, bloco: b, criativo: b.criativos[j % b.criativos.length] });
    }
  }
  slots.sort((x, y) => x.pos - y.pos || y.bloco.prioridade - x.bloco.prioridade || x.bloco.chave.localeCompare(y.bloco.chave));
  // Dois do mesmo anunciante em sequência: troca o segundo pelo próximo diferente.
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].bloco.anunciante !== slots[i - 1].bloco.anunciante) continue;
    const t = slots.findIndex((s, k) => k > i && s.bloco.anunciante !== slots[i - 1].bloco.anunciante
      && (k + 1 >= slots.length || slots[k + 1].bloco.anunciante !== slots[i].bloco.anunciante));
    if (t > i) [slots[i], slots[t]] = [slots[t], slots[i]];
  }
  return slots;
}

/** Próximo instante (ISO) em que a grade pode mudar: começo ou fim de faixa de horário de alguma campanha, ou a virada do dia. */
function validaAte(db, instante, { data, hhmm }) {
  const agoraMin = minutosDe(hhmm);
  const marcos = new Set([24 * 60]);
  for (const c of db.prepare("SELECT hora_inicio, hora_fim FROM campanhas WHERE status = 'ativa' AND inicio <= ? AND (fim IS NULL OR fim >= ?)").all(data, data)) {
    for (const h of [c.hora_inicio, c.hora_fim]) if (minutosDe(h) > agoraMin) marcos.add(minutosDe(h));
  }
  const proximo = Math.min(...marcos);
  return new Date(Date.parse(instante instanceof Date ? instante.toISOString() : instante) + (proximo - agoraMin) * 60_000).toISOString();
}

/**
 * Monta a grade da tela. Devolve os itens em ordem, a versão (muda quando a programação muda) e o resumo por anunciante.
 * `tela` precisa trazer também categoria e cidade do ponto.
 */
function montar(db, tela, instante = new Date()) {
  const cfg = lerConfig(db);
  const l = local(instante);
  const momento = { data: l.data, hhmm: l.hhmm, diaSemana: l.diaSemana };

  const blocos = elegiveis(db, tela, momento).map(({ campanha, criativos }) => ({
    chave: `c${campanha.id}`,
    campanha_id: campanha.id,
    campanha_nome: campanha.nome,
    anunciante_id: campanha.anunciante_id,
    anunciante: campanha.anunciante_nome,
    prioridade: campanha.prioridade,
    insercoes_hora: campanha.insercoes_hora,
    criativos,
    insercoes: 0,
  }));

  // Inserções por loop proporcionais às inserções/hora contratadas, com pelo menos uma por criativo.
  if (blocos.length) {
    const unidade = Math.min(...blocos.map((b) => b.insercoes_hora));
    for (const b of blocos) b.insercoes = Math.max(b.criativos.length, Math.round(b.insercoes_hora / unidade));
  }
  // Tempo que o bloco ocupa no loop: as inserções giram entre os criativos da campanha (1ª, 2ª, 3ª, 1ª…).
  const duracaoBloco = (b) => Array.from({ length: b.insercoes }, (_, j) => b.criativos[j % b.criativos.length].duracao_s).reduce((t, d) => t + d, 0);
  const total = () => blocos.reduce((t, b) => t + duracaoBloco(b), 0);

  // Loop grande demais: quem tem menor prioridade perde inserções primeiro (nunca abaixo de um criativo cada).
  let guarda = 500;
  while (total() > cfg.bloco_maximo_s && guarda-- > 0) {
    const alvo = blocos.filter((b) => b.insercoes > b.criativos.length)
      .sort((x, y) => x.prioridade - y.prioridade || y.insercoes - x.insercoes)[0]
      ?? blocos.filter((b) => b.insercoes > 1).sort((x, y) => x.prioridade - y.prioridade || y.insercoes - x.insercoes)[0];
    if (!alvo) break;
    alvo.insercoes--;
  }

  const slots = espalhar(blocos);
  const vendido = slots.reduce((t, s) => t + s.criativo.duracao_s, 0);

  const comunicados = db.prepare(SQL_COMUNICADOS).all(tela.local_id, momento.data, momento.data);
  const agenda = db.prepare(SQL_AGENDA).all(tela.local_id, momento.data);
  const clima = require('./clima').doPonto(db, { cidade: tela.cidade, uf: tela.uf });
  // Tela dividida (o padrão de elevador): o comunicado fica parado na sua metade enquanto a publicidade gira na outra.
  // Tela cheia: o comunicado entra no meio do carrossel, como mais um item.
  const dividida = tela.layout === 'dividida';
  const institucional = db.prepare(SQL_INSTITUCIONAL).all(momento.data, tela.local_id)
    .filter((m) => !m.orientacao || m.orientacao === tela.orientacao);
  const preenchimento = dividida ? [] : comunicados.map((c) => ({ comunicado: c }));
  let tempo = vendido + preenchimento.reduce((t, p) => t + p.comunicado.duracao_s, 0);
  const minimo = slots.length ? cfg.bloco_minimo_s : Math.max(cfg.bloco_minimo_s, 1);
  if (institucional.length) {
    for (let i = 0; tempo < minimo && i < 60; i++) {
      const m = institucional[i % institucional.length];
      preenchimento.push({ midia: m });
      tempo += m.duracao_s;
    }
  }
  // Sobrou espaço (ou a tela ainda não tem nada): entra a tela da própria rede, desenhada pelo player.
  if (cfg.marca_preenche) {
    for (let i = 0; tempo < minimo && i < 30; i++) {
      preenchimento.push({ marca: { duracao_s: cfg.marca_duracao_s } });
      tempo += cfg.marca_duracao_s;
    }
  }

  // O institucional é intercalado: entra a cada N inserções vendidas (ou sozinho, quando não há publicidade).
  const itens = [];
  if (preenchimento.length && slots.length) {
    const passo = Math.max(1, Math.round(slots.length / preenchimento.length));
    let f = 0;
    slots.forEach((s, i) => {
      itens.push(s);
      if ((i + 1) % passo === 0 && f < preenchimento.length) itens.push(preenchimento[f++]);
    });
    while (f < preenchimento.length) itens.push(preenchimento[f++]);
  } else if (slots.length) {
    itens.push(...slots);
  } else {
    itens.push(...preenchimento);
  }

  const lista = itens.map((it, i) => {
    const ordem = i + 1;
    // Comunicado do ponto: o player desenha na hora, não existe arquivo para baixar.
    if (it.comunicado) {
      const c = it.comunicado;
      return {
        ordem,
        formato: 'comunicado',
        comunicado_id: c.id,
        midia_id: null,
        nome: c.titulo,
        titulo: c.titulo,
        texto: c.texto,
        tipo: c.tipo,
        duracao_s: c.duracao_s,
        campanha_id: null,
        campanha: null,
        anunciante_id: null,
        anunciante: null,
        local: tela.local_nome ?? null,
      };
    }
    // Tela da própria rede: o player desenha com o nome e a frase da plataforma.
    if (it.marca) {
      return {
        ordem,
        formato: 'marca',
        midia_id: null,
        comunicado_id: null,
        nome: cfg.nome_plataforma,
        duracao_s: it.marca.duracao_s,
        campanha_id: null,
        campanha: null,
        anunciante_id: null,
        anunciante: null,
      };
    }
    const m = it.midia ?? it.criativo;
    return {
      ordem,
      formato: 'midia',
      midia_id: m.id,
      comunicado_id: null,
      nome: m.nome,
      tipo: m.tipo,
      mime: m.mime,
      duracao_s: m.duracao_s,
      bytes: m.bytes ?? null,
      campanha_id: it.criativo ? it.bloco.campanha_id : null,
      campanha: it.criativo ? it.bloco.campanha_nome : null,
      anunciante_id: it.criativo ? it.bloco.anunciante_id : null,
      anunciante: it.criativo ? it.bloco.anunciante : null,
      url: `midia/${m.id}?v=${String(m.sha256).slice(0, 12)}`,
    };
  });

  const duracao = lista.reduce((t, i) => t + i.duracao_s, 0);
  const porAnunciante = [...blocos].filter((b) => b.insercoes > 0).map((b) => {
    const segundos = slots.filter((s) => s.bloco === b).reduce((t, s) => t + s.criativo.duracao_s, 0);
    return {
      campanha_id: b.campanha_id,
      campanha: b.campanha_nome,
      anunciante_id: b.anunciante_id,
      anunciante: b.anunciante,
      insercoes_loop: slots.filter((s) => s.bloco === b).length,
      segundos,
      share: duracao ? Math.round((segundos / duracao) * 1000) / 10 : 0,
      insercoes_hora: duracao ? Math.round((slots.filter((s) => s.bloco === b).length * 3600) / duracao) : 0,
      contratado_hora: b.insercoes_hora,
    };
  }).sort((a, b) => b.segundos - a.segundos);

  const assinatura = JSON.stringify([
    lista.map((i) => [i.formato, i.midia_id, i.comunicado_id, i.duracao_s, i.campanha_id, i.texto ?? '']),
    dividida ? comunicados.map((c) => [c.id, c.titulo, c.texto, c.tipo, c.duracao_s]) : [],
    agenda.map((a) => [a.titulo, a.evento_em, a.evento_hora]),
    tela.layout, tela.som, tela.relogio, tela.legenda ?? '',
    (tela.aviso_ate && tela.aviso_ate < new Date().toISOString()) ? '' : (tela.aviso ?? ''),
  ]);

  return {
    versao: crypto.createHash('sha256').update(assinatura).digest('hex').slice(0, 16),
    layout: dividida ? 'dividida' : 'cheia',
    // Na tela dividida, estes comunicados giram na zona própria (fora do carrossel de publicidade).
    comunicados: dividida ? comunicados.map((c) => ({
      comunicado_id: c.id, titulo: c.titulo, texto: c.texto, tipo: c.tipo, duracao_s: c.duracao_s,
    })) : [],
    // A agenda e o clima acompanham a tela dividida (zona do condomínio) e a faixa.
    // O clima fica fora da assinatura da versão: a temperatura muda sozinha e não deve
    // obrigar a TV a baixar a programação de novo.
    agenda: agenda.map((a) => ({ titulo: a.titulo, tipo: a.tipo, em: a.evento_em, hora: a.evento_hora })),
    clima,
    ponto: {
      nome: tela.local_nome ?? null,
      administradora: tela.administradora ?? null,
      assinatura: tela.assinatura ?? (tela.local_nome ? `Administração / Síndico — ${tela.local_nome}` : null),
      logo: Boolean(tela.logo_arquivo),
    },
    gerada_em: new Date(instante).toISOString(),
    valida_ate: validaAte(db, instante, momento),
    duracao_s: duracao,
    vendido_s: vendido,
    institucional_s: duracao - vendido,
    ocupacao: duracao ? Math.round((vendido / duracao) * 1000) / 10 : 0,
    itens: lista,
    campanhas: porAnunciante,
    sem_conteudo: !lista.length,
  };
}

/** Grade de uma tela pelo id (busca a tela com os dados do ponto). */
function montarPorTela(db, telaId, instante = new Date()) {
  const tela = db.prepare(SQL_TELA).get(telaId);
  return tela ? montar(db, tela, instante) : null;
}

/** A tela com tudo que a programação precisa (usado pelas rotas). */
const buscarTela = (db, telaId) => db.prepare(SQL_TELA).get(telaId);

module.exports = { montar, montarPorTela, buscarTela, elegiveis, alvoBate, espalhar, noPrazo, noDia, naHora, porQueNaoPassa, SQL_TELA };
