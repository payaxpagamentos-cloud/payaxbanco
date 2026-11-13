'use strict';

const ixcTools = require('../ia/ferramentas-ixc');

/**
 * A vida inteira do cliente num lugar só: o que o IXC sabe (tempo de casa, plano, pagamento, chamados,
 * conexão) junto com o que a plataforma sabe (conversas, avaliações, ouvidorias, desbloqueios).
 *
 * Daqui saem três coisas, nesta ordem de importância para quem vai atender:
 *   1. RISCO  — 0 a 100: a chance de perder este cliente, com CADA fator explicado;
 *   2. VALOR  — A, B ou C: quanto ele vale, para saber o quanto brigar por ele;
 *   3. LINHA DO TEMPO — tudo que aconteceu, em ordem, numa lista só.
 *
 * O score é de propósito TRANSPARENTE: nada de caixa-preta. Cada ponto tem um porquê escrito, porque
 * quem está do outro lado precisa decidir em 30 segundos se oferece desconto — e precisa saber por quê.
 */

const hoje = () => new Date().toISOString().slice(0, 10);
const diasEntre = (a, b = hoje()) => (a ? Math.round((Date.parse(`${String(b).slice(0, 10)}T12:00:00Z`) - Date.parse(`${String(a).slice(0, 10)}T12:00:00Z`)) / 86_400_000) : null);
const mesesEntre = (a) => { const d = diasEntre(a); return d === null ? null : Math.floor(d / 30); };
const reais = (c) => ((c ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------- Fatores de risco ----------

/**
 * Cada fator devolve { nome, pontos, detalhe }. Pontos positivos AUMENTAM o risco de perder o cliente;
 * negativos reduzem. O total é cortado entre 0 e 100.
 */
const FATORES = [
  {
    nome: 'Pediu cancelamento antes',
    calcular: ({ ouvidorias }) => {
      const cancelamentos = ouvidorias.filter((o) => o.tipo === 'cancelamento');
      if (!cancelamentos.length) return null;
      const recente = cancelamentos.some((o) => diasEntre(o.aberta_em) <= 180);
      return {
        pontos: recente ? 30 : 15,
        detalhe: `${cancelamentos.length} pedido(s) de cancelamento${recente ? ', sendo um nos últimos 6 meses' : ''}`,
      };
    },
  },
  {
    nome: 'Reclamação formal',
    calcular: ({ ouvidorias }) => {
      const formais = ouvidorias.filter((o) => ['procon', 'anatel'].includes(o.tipo));
      const reclamacoes = ouvidorias.filter((o) => o.tipo === 'reclamacao');
      if (!formais.length && !reclamacoes.length) return null;
      return {
        pontos: formais.length ? 25 : Math.min(18, reclamacoes.length * 7),
        detalhe: formais.length
          ? `${formais.length} reclamação(ões) em Procon/Anatel`
          : `${reclamacoes.length} reclamação(ões) registrada(s) na ouvidoria`,
      };
    },
  },
  {
    nome: 'Problemas técnicos recentes',
    calcular: ({ chamados }) => {
      const noventaDias = chamados.filter((c) => diasEntre(c.aberto_em) <= 90);
      if (noventaDias.length < 2) return null;
      return {
        pontos: Math.min(22, noventaDias.length * 5),
        detalhe: `${noventaDias.length} chamados técnicos nos últimos 90 dias`,
      };
    },
  },
  {
    nome: 'Insatisfação no atendimento',
    calcular: ({ csat }) => {
      if (csat.avaliacoes < 1) return null;
      if (csat.media >= 4) return { pontos: -8, detalhe: `avaliou o atendimento com ${csat.media.toLocaleString('pt-BR')} de 5` };
      if (csat.media >= 3) return null;
      return { pontos: 15, detalhe: `avaliou o atendimento com ${csat.media.toLocaleString('pt-BR')} de 5` };
    },
  },
  {
    nome: 'Cliente novo',
    calcular: ({ tempo_casa_meses: meses }) => {
      if (meses === null) return null;
      if (meses < 3) return { pontos: 14, detalhe: `está há ${meses} mês(es) na base — o período de maior cancelamento` };
      if (meses < 6) return { pontos: 7, detalhe: `está há ${meses} meses na base` };
      if (meses >= 24) return { pontos: -12, detalhe: `está há ${Math.floor(meses / 12)} ano(s) na base` };
      if (meses >= 12) return { pontos: -6, detalhe: `está há ${meses} meses na base` };
      return null;
    },
  },
  {
    nome: 'Conta em atraso',
    calcular: ({ faturas_abertas: abertas }) => {
      const vencidas = abertas.filter((f) => f.vencida);
      if (!vencidas.length) return null;
      const pior = Math.max(...vencidas.map((f) => f.dias_atraso));
      return {
        pontos: pior > 60 ? 20 : pior > 30 ? 12 : 6,
        detalhe: `${vencidas.length} fatura(s) vencida(s), a mais antiga há ${pior} dias`,
      };
    },
  },
  {
    nome: 'Histórico de pagamento',
    calcular: ({ pagamento }) => {
      if (pagamento.avaliadas < 3) return null;
      if (pagamento.pontualidade >= 90) return { pontos: -10, detalhe: `paga em dia (${pagamento.pontualidade}% das faturas)` };
      if (pagamento.pontualidade >= 70) return null;
      return { pontos: 10, detalhe: `atrasa com frequência (só ${pagamento.pontualidade}% em dia, média de ${pagamento.atraso_medio_dias} dias)` };
    },
  },
  {
    nome: 'Conexão instável',
    calcular: ({ conexao }) => {
      if (!conexao || conexao.online === null) return null;
      if (conexao.online === false && conexao.dias_offline !== null && conexao.dias_offline >= 1) {
        return { pontos: 12, detalhe: `sem conectar há ${conexao.dias_offline} dia(s)` };
      }
      return null;
    },
  },
  {
    nome: 'Dificuldade financeira',
    calcular: ({ desbloqueios }) => {
      if (desbloqueios < 2) return null;
      return { pontos: 8, detalhe: `usou ${desbloqueios} desbloqueios de confiança` };
    },
  },
];

/** Calcula o risco somando os fatores que se aplicam. Devolve a nota, a faixa e os porquês. */
function calcularRisco(dados) {
  const aplicados = [];
  for (const f of FATORES) {
    const r = f.calcular(dados);
    if (r && r.pontos) aplicados.push({ nome: f.nome, pontos: r.pontos, detalhe: r.detalhe });
  }
  const bruto = aplicados.reduce((s, f) => s + f.pontos, 0);
  const nota = Math.max(0, Math.min(100, bruto));
  const faixa = nota >= 60 ? 'alto' : nota >= 30 ? 'medio' : 'baixo';
  return {
    nota,
    faixa,
    // Primeiro o que mais pesa, para quem lê de relance.
    fatores: aplicados.sort((a, b) => b.pontos - a.pontos),
    aumentam: aplicados.filter((f) => f.pontos > 0),
    reduzem: aplicados.filter((f) => f.pontos < 0),
  };
}

/**
 * Valor do cliente: A, B ou C. Olha o que ele paga, há quanto tempo e se paga direito.
 * Serve para a pergunta "vale a pena oferecer desconto para segurar?".
 */
function calcularValor({ mensalidade_centavos: mrr, tempo_casa_meses: meses, pagamento, faturas_abertas: abertas }) {
  const pontos = [];
  let nota = 0;
  if (mrr >= 15_000) { nota += 3; pontos.push(`mensalidade de ${reais(mrr)}`); }
  else if (mrr >= 10_000) { nota += 2; pontos.push(`mensalidade de ${reais(mrr)}`); }
  else if (mrr > 0) { nota += 1; pontos.push(`mensalidade de ${reais(mrr)}`); }

  if (meses !== null) {
    if (meses >= 36) { nota += 3; pontos.push(`${Math.floor(meses / 12)} anos de casa`); }
    else if (meses >= 12) { nota += 2; pontos.push(`${meses} meses de casa`); }
    else if (meses >= 6) { nota += 1; }
  }

  if (pagamento.avaliadas >= 3) {
    if (pagamento.pontualidade >= 90) { nota += 2; pontos.push('sempre paga em dia'); }
    else if (pagamento.pontualidade < 60) { nota -= 2; pontos.push('atrasa com frequência'); }
  }
  const vencidas = abertas.filter((f) => f.vencida).length;
  if (vencidas >= 2) { nota -= 2; pontos.push(`${vencidas} faturas vencidas agora`); }

  const classe = nota >= 6 ? 'A' : nota >= 3 ? 'B' : 'C';
  // Quanto a empresa deixa de faturar por ano se perder este cliente.
  return { classe, nota, perda_anual_centavos: (mrr ?? 0) * 12, porques: pontos };
}

/**
 * A recomendação que o atendente de retenção lê primeiro. Cruza valor e risco e diz o que fazer —
 * sem decidir por ele: quem autoriza desconto é gente, nunca o bot.
 */
function recomendar(risco, valor, dados) {
  const inadimplente = dados.faturas_abertas.some((f) => f.vencida && f.dias_atraso > 30);
  if (valor.classe === 'A' && risco.faixa !== 'baixo') {
    return {
      prioridade: 'alta',
      texto: `Cliente classe A com risco ${risco.faixa}. Perder este contrato custa ${reais(valor.perda_anual_centavos)} por ano. `
        + 'Vale escutar com calma, resolver a causa e, se a política permitir, oferecer retenção.',
    };
  }
  if (inadimplente && risco.faixa === 'alto') {
    return {
      prioridade: 'media',
      texto: 'Risco alto, mas com fatura vencida há mais de 30 dias. Antes de qualquer oferta, trate o financeiro: '
        + 'desconto para quem está inadimplente costuma virar prejuízo em dobro.',
    };
  }
  if (risco.faixa === 'alto') {
    return { prioridade: 'media', texto: `Risco alto (classe ${valor.classe}). Entenda a causa antes de falar de preço — na maioria das vezes o problema é técnico, não valor.` };
  }
  if (risco.faixa === 'medio') {
    return {
      prioridade: 'normal',
      texto: valor.classe === 'A'
        ? 'Risco médio num cliente bom. Resolver bem o que ele trouxe é o que mais segura cliente — melhor do que qualquer desconto.'
        : 'Risco médio. Resolver bem o que ele trouxe é o que mais segura cliente.',
    };
  }
  return { prioridade: 'baixa', texto: 'Risco baixo. Atendimento normal — não há sinal de que este cliente esteja pensando em sair.' };
}

// ---------- Montagem da ficha ----------

/** O que a plataforma sabe sozinha, sem o IXC. */
function dadosLocais(db, empresaId, contatoId) {
  const conversas = db.prepare(`SELECT id, estado, assunto, intencao, resolvida_por, motivo_transferencia, aberta_em, encerrada_em, csat_nota, csat_comentario
    FROM conversas WHERE contato_id = ? ORDER BY aberta_em DESC LIMIT 100`).all(contatoId);
  const avaliadas = conversas.filter((c) => c.csat_nota);
  const ouvidorias = db.prepare(`SELECT id, protocolo, tipo, assunto, status, desfecho, retido, prioridade, aberta_em, resolvida_em
    FROM ouvidoria WHERE contato_id = ? ORDER BY aberta_em DESC`).all(contatoId);
  const desbloqueios = Number(db.prepare(`SELECT COUNT(*) AS n FROM ixc_acoes
    WHERE empresa_id = ? AND contato_id = ? AND tipo = 'desbloqueio' AND sucesso = 1`).all(empresaId, contatoId)[0].n);
  const chamadosLocais = db.prepare('SELECT protocolo, assunto, status, criado_em FROM chamados WHERE contato_id = ? ORDER BY id DESC LIMIT 50').all(contatoId);
  return {
    conversas,
    ouvidorias,
    desbloqueios,
    chamados_locais: chamadosLocais,
    csat: {
      avaliacoes: avaliadas.length,
      media: avaliadas.length ? Number((avaliadas.reduce((s, c) => s + c.csat_nota, 0) / avaliadas.length).toFixed(2)) : null,
    },
  };
}

/** O que o IXC sabe. Se ele não responder, a ficha sai mesmo assim, marcada como incompleta. */
async function dadosIxc(db, empresaId, ixcClienteId) {
  if (!ixcClienteId || !ixcTools.configurado(db, empresaId)) return { disponivel: false, motivo: 'integração com o IXC não configurada' };
  const ixc = ixcTools.clienteIxc(db, empresaId);
  try {
    const [cadastro, contratos, abertas, historico, chamados, logins] = await Promise.all([
      ixc.clientePorId(ixcClienteId),
      ixc.contratos(ixcClienteId),
      ixc.faturasAbertas(ixcClienteId),
      ixc.historicoFaturas(ixcClienteId, { meses: 12 }).catch(() => []),
      ixc.historicoChamados(ixcClienteId, { meses: 6 }).catch(() => []),
      ixc.logins(ixcClienteId).catch(() => []),
    ]);
    return { disponivel: true, cadastro, contratos, faturas_abertas: abertas, historico_faturas: historico, chamados, logins };
  } catch (err) {
    return { disponivel: false, motivo: err.message };
  }
}

/** Pontualidade de pagamento a partir do histórico. */
function medirPagamento(historico) {
  const pagas = historico.filter((f) => f.paga);
  if (!pagas.length) return { avaliadas: 0, pontualidade: null, atraso_medio_dias: null };
  const emDia = pagas.filter((f) => f.dias_atraso_no_pagamento <= 2).length;
  const atrasadas = pagas.filter((f) => f.dias_atraso_no_pagamento > 2);
  return {
    avaliadas: pagas.length,
    pontualidade: Math.round((emDia / pagas.length) * 100),
    atraso_medio_dias: atrasadas.length ? Math.round(atrasadas.reduce((s, f) => s + f.dias_atraso_no_pagamento, 0) / atrasadas.length) : 0,
  };
}

/** A linha do tempo: tudo que aconteceu com este cliente, do mais novo para o mais antigo. */
function montarLinhaDoTempo({ local, ixc }) {
  const eventos = [];
  const add = (quando, tipo, titulo, detalhe = null, extra = {}) => {
    if (!quando) return;
    eventos.push({ quando: String(quando).length === 10 ? `${quando}T12:00:00.000Z` : quando, tipo, titulo, detalhe, ...extra });
  };

  for (const c of local.conversas) {
    const comoTerminou = { ia: 'resolvida pela atendente virtual', humano: 'resolvida pela equipe', cliente: 'o cliente se despediu', abandono: 'o cliente parou de responder' };
    add(c.aberta_em, 'conversa', c.assunto || c.intencao || 'Conversa no WhatsApp',
      c.encerrada_em ? comoTerminou[c.resolvida_por] ?? null : 'em aberto', { conversa_id: c.id, csat: c.csat_nota });
    if (c.motivo_transferencia) add(c.aberta_em, 'transferencia', 'Passou para a equipe', c.motivo_transferencia, { conversa_id: c.id });
  }
  for (const o of local.ouvidorias) {
    add(o.aberta_em, 'ouvidoria', `Ouvidoria: ${TIPOS_OUVIDORIA[o.tipo] ?? o.tipo}`, o.assunto, { ouvidoria_id: o.id, protocolo: o.protocolo });
    if (o.resolvida_em) add(o.resolvida_em, 'ouvidoria', `Ouvidoria encerrada (${o.status})`, o.desfecho, { ouvidoria_id: o.id, retido: o.retido });
  }
  for (const ch of local.chamados_locais) add(ch.criado_em, 'chamado', `Chamado ${ch.protocolo}`, ch.assunto);

  if (ixc.disponivel) {
    for (const c of ixc.contratos ?? []) {
      add(c.ativado_em, 'contrato', 'Virou cliente', `${c.plano ?? 'contrato'}${c.mensalidade_centavos ? ` · ${reais(c.mensalidade_centavos)}/mês` : ''}`);
      add(c.cancelado_em, 'contrato', 'Contrato cancelado', c.motivo_cancelamento);
    }
    for (const ch of ixc.chamados ?? []) {
      add(ch.aberto_em, 'tecnico', `Chamado técnico ${ch.protocolo}`, ch.assunto);
      add(ch.fechado_em, 'tecnico', `Chamado ${ch.protocolo} fechado`);
    }
    for (const f of ixc.historico_faturas ?? []) {
      if (f.paga) {
        add(f.pagamento, 'pagamento', `Pagou ${reais(f.valor_centavos)}`,
          f.dias_atraso_no_pagamento > 2 ? `com ${f.dias_atraso_no_pagamento} dias de atraso` : 'em dia');
      }
    }
    for (const f of ixc.faturas_abertas ?? []) {
      if (f.vencida) add(f.vencimento, 'atraso', `Fatura de ${reais(f.valor_centavos)} venceu`, `${f.dias_atraso} dias em atraso`);
    }
  }
  return eventos.sort((a, b) => String(b.quando).localeCompare(String(a.quando))).slice(0, 200);
}

const TIPOS_OUVIDORIA = {
  reclamacao: 'Reclamação', cancelamento: 'Cancelamento', procon: 'Procon', anatel: 'Anatel', elogio: 'Elogio', sugestao: 'Sugestão',
};

/**
 * A ficha completa. `contatoId` é obrigatório; o id do cliente no IXC vem do contato ou da conversa.
 * Nunca falha por causa do IXC: sem ele, a ficha sai com o que a plataforma sabe e avisa que está incompleta.
 */
async function ficha(db, empresaId, contatoId, { ixcClienteId = null } = {}) {
  const contato = db.prepare('SELECT * FROM contatos WHERE id = ? AND empresa_id = ?').get(contatoId, empresaId);
  if (!contato) return null;
  const local = dadosLocais(db, empresaId, contatoId);
  const ixc = await dadosIxc(db, empresaId, ixcClienteId ?? contato.codigo_externo);

  const contratoAtivo = (ixc.contratos ?? []).find((c) => c.ativo) ?? (ixc.contratos ?? [])[0] ?? null;
  const pagamento = medirPagamento(ixc.historico_faturas ?? []);
  const login = (ixc.logins ?? [])[0] ?? null;
  const conexao = login ? {
    online: login.online,
    dias_offline: login.online ? 0 : diasEntre(String(login.ultima_conexao ?? '').slice(0, 10)),
    ultima_conexao: login.ultima_conexao,
    sinal: login.sinal,
  } : null;

  const dados = {
    tempo_casa_meses: contratoAtivo?.ativado_em ? mesesEntre(contratoAtivo.ativado_em) : (contato.primeiro_contato_em ? mesesEntre(contato.primeiro_contato_em) : null),
    mensalidade_centavos: contratoAtivo?.mensalidade_centavos ?? 0,
    faturas_abertas: ixc.faturas_abertas ?? [],
    historico_faturas: ixc.historico_faturas ?? [],
    chamados: ixc.chamados ?? [],
    conexao,
    pagamento,
    csat: local.csat,
    ouvidorias: local.ouvidorias,
    desbloqueios: local.desbloqueios,
  };

  const risco = calcularRisco(dados);
  const valor = calcularValor(dados);

  return {
    contato: {
      id: contato.id, nome: contato.nome ?? contato.nome_perfil, telefone: contato.telefone,
      documento: contato.documento, email: contato.email, codigo_externo: contato.codigo_externo,
      observacoes: contato.observacoes, cliente_desde: contato.primeiro_contato_em,
    },
    provedor: {
      disponivel: ixc.disponivel,
      motivo: ixc.motivo ?? null,
      cliente_id: ixcClienteId ?? contato.codigo_externo ?? null,
      nome: ixc.cadastro?.razao ?? null,
      contratos: ixc.contratos ?? [],
      contrato_ativo: contratoAtivo,
      conexao,
    },
    resumo: {
      tempo_casa_meses: dados.tempo_casa_meses,
      mensalidade: reais(dados.mensalidade_centavos),
      mensalidade_centavos: dados.mensalidade_centavos,
      plano: contratoAtivo?.plano ?? null,
      acesso: contratoAtivo?.acesso ?? null,
      faturas_vencidas: dados.faturas_abertas.filter((f) => f.vencida).length,
      total_em_aberto: reais(dados.faturas_abertas.reduce((s, f) => s + f.valor_centavos, 0)),
      pontualidade: pagamento.pontualidade,
      chamados_90_dias: dados.chamados.filter((c) => diasEntre(c.aberto_em) <= 90).length,
      conversas: local.conversas.length,
      ouvidorias: local.ouvidorias.length,
      csat_medio: local.csat.media,
      desbloqueios: local.desbloqueios,
    },
    risco,
    valor,
    recomendacao: recomendar(risco, valor, dados),
    linha_do_tempo: montarLinhaDoTempo({ local, ixc }),
  };
}

module.exports = { ficha, calcularRisco, calcularValor, recomendar, medirPagamento, montarLinhaDoTempo, FATORES, TIPOS_OUVIDORIA, diasEntre, mesesEntre };
