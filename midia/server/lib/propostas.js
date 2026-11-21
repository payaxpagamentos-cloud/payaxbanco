'use strict';

const { agora, lerConfig, transacao } = require('../db');
const { hoje, somarDias, somarMesesData, minutosDe } = require('./datas');
const { ErroNegocio } = require('./erros');
const grade = require('./grade');

/**
 * Proposta comercial: o cálculo e o que acontece depois dela.
 *
 * Duas decisões que valem explicação:
 *
 * 1. A proposta guarda a FOLHA DO DIA (o JSON inteiro do cálculo). A rede muda toda semana — entra um
 *    prédio, sai uma tela — e reimprimir uma proposta de dois meses atrás tem de mostrar o que foi
 *    oferecido ao cliente, não o inventário de hoje. Sem isso, a proposta impressa e a arquivada
 *    divergem, e quem fica sem resposta é o vendedor na frente do cliente.
 *
 * 2. Aceitar a proposta cria contrato e campanha a partir dela. Redigitar o que já foi combinado é
 *    onde nasce a diferença entre o que foi vendido e o que vai ao ar.
 */

/** Telas que o circuito alcança (as regras do circuito aplicadas ao inventário de agora). */
function telasDoCircuito(db, circuitoId) {
  const alvos = db.prepare('SELECT tipo, valor FROM circuito_alvos WHERE circuito_id = ?').all(circuitoId);
  const telas = db.prepare(`SELECT t.id, t.nome, t.orientacao, t.posicao, l.id AS local_id, l.nome AS local_nome, l.categoria, l.cidade, l.uf,
      l.publico_dia, l.unidades FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.status = 'ativa' AND l.status = 'ativo'`).all();
  return telas.filter((t) => grade.alvoBate(alvos, t));
}

/** O circuito com a audiência somada — o público do ponto conta uma vez, mesmo com várias telas nele. */
function resumoCircuito(db, c) {
  const telas = telasDoCircuito(db, c.id);
  const pontos = new Set(telas.map((t) => t.local_id));
  const publico = [...pontos].reduce((t, id) => t + (telas.find((x) => x.local_id === id)?.publico_dia ?? 0), 0);
  return {
    ...c,
    telas: telas.length,
    pontos: pontos.size,
    cidades: new Set(telas.map((t) => t.cidade)).size,
    publico_dia: publico,
    publico_mes: publico * 30,
    retrato: telas.filter((t) => t.orientacao === 'retrato').length,
    paisagem: telas.filter((t) => t.orientacao === 'paisagem').length,
    lista: telas,
  };
}

const inteiro = (valor, padrao, min, max) => {
  const n = valor === undefined || valor === '' || valor === null ? padrao : Number(valor);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new ErroNegocio(`Valor fora do permitido (${min} a ${max}).`, 422);
  }
  return n;
};

/**
 * Monta a folha da proposta. Os números de entrega saem do que está cadastrado: horário de
 * funcionamento de cada ponto, inserções por hora e duração padrão do criativo.
 */
function calcular(db, circuitoId, opcoes = {}) {
  const c = db.prepare('SELECT * FROM circuitos WHERE id = ?').get(circuitoId);
  if (!c) throw new ErroNegocio('Circuito não encontrado.', 404);
  const resumo = resumoCircuito(db, c);
  const conf = lerConfig(db);
  const meses = inteiro(opcoes.meses, 3, 1, 36);
  const desconto = inteiro(opcoes.desconto_percentual, 0, 0, 5000);
  const validadeDias = inteiro(opcoes.validade_dias, 15, 1, 180);
  const insercoesHora = inteiro(opcoes.insercoes_hora, c.insercoes_hora, 1, 120);
  const anunciante = opcoes.anunciante_id
    ? db.prepare('SELECT id, nome, documento, contato, email FROM anunciantes WHERE id = ?').get(Number(opcoes.anunciante_id)) ?? null
    : null;

  // Horas no ar por dia em cada ponto: a média da semana pelo horário cadastrado (sem horário, 12 h).
  const horasPorPonto = new Map();
  for (const localId of new Set(resumo.lista.map((t) => t.local_id))) {
    const dias = db.prepare('SELECT abre, fecha FROM local_horarios WHERE local_id = ?').all(localId);
    const horas = dias.length
      ? dias.reduce((t, d) => t + Math.max(0, (minutosDe(d.fecha) - minutosDe(d.abre)) / 60), 0) / 7
      : 12;
    horasPorPonto.set(localId, Math.round(horas * 10) / 10);
  }

  // Um ponto entra uma vez na audiência, mas cada tela exibe: a fatia do tempo de tela é o que vira impacto.
  const fatia = Math.min(1, (insercoesHora * conf.duracao_imagem_s) / 3600);
  const pontos = [...new Map(resumo.lista.map((t) => [t.local_id, t])).values()].map((t) => {
    const telas = resumo.lista.filter((x) => x.local_id === t.local_id);
    const horas = horasPorPonto.get(t.local_id);
    return {
      nome: t.local_nome,
      categoria: t.categoria,
      cidade: t.cidade,
      uf: t.uf,
      unidades: t.unidades,
      publico_dia: t.publico_dia,
      telas: telas.length,
      posicoes: [...new Set(telas.map((x) => x.posicao).filter(Boolean))],
      horas_dia: horas,
      insercoes_mes: Math.round(telas.length * insercoesHora * horas * 30),
      impactos_mes: Math.round(t.publico_dia * fatia * 30),
    };
  }).sort((a, b) => b.publico_dia - a.publico_dia || a.nome.localeCompare(b.nome));

  const insercoesMes = pontos.reduce((t, p) => t + p.insercoes_mes, 0);
  const impactosMes = pontos.reduce((t, p) => t + p.impactos_mes, 0);
  const tabelaMes = c.valor_mes_centavos || resumo.telas * conf.mensalidade_tela_centavos;
  const mesComDesconto = Math.round((tabelaMes * (10_000 - desconto)) / 10_000);

  return {
    emitida_em: hoje(),
    valida_ate: somarDias(hoje(), validadeDias),
    validade_dias: validadeDias,
    plataforma: { nome: conf.nome_plataforma, slogan: conf.slogan },
    anunciante,
    circuito: {
      id: c.id,
      nome: c.nome,
      descricao: c.descricao,
      telas: resumo.telas,
      pontos: resumo.pontos,
      cidades: resumo.cidades,
      paisagem: resumo.paisagem,
      retrato: resumo.retrato,
      publico_dia: resumo.publico_dia,
      publico_mes: resumo.publico_mes,
      unidades: pontos.reduce((t, p) => t + (p.unidades ?? 0), 0),
    },
    veiculacao: {
      insercoes_hora: insercoesHora,
      duracao_s: conf.duracao_imagem_s,
      insercoes_mes: insercoesMes,
      insercoes_periodo: insercoesMes * meses,
      impactos_mes: impactosMes,
      impactos_periodo: impactosMes * meses,
      // Quanto do tempo de tela é do anunciante (o resto fica com os outros, o institucional e a marca).
      share_percentual: Math.round(fatia * 10_000),
    },
    investimento: {
      meses,
      tabela_mes_centavos: tabelaMes,
      desconto_percentual: desconto,
      mes_centavos: mesComDesconto,
      total_centavos: mesComDesconto * meses,
      // CPM efetivo: o que o cliente paga por mil pessoas alcançadas, pelo mesmo cálculo de impactos
      // que o relatório vai mostrar depois — a proposta não promete o que o relatório desmente.
      cpm_centavos: impactosMes ? Math.round(mesComDesconto / (impactosMes / 1000)) : 0,
      cpm_tabela_centavos: c.cpm_centavos,
    },
    pontos,
  };
}

/** Número da proposta no ano: P-2026-001, P-2026-002… */
function proximoNumero(db) {
  const ano = hoje().slice(0, 4);
  const ultimo = db.prepare("SELECT numero FROM propostas WHERE numero LIKE ? ORDER BY numero DESC LIMIT 1").get(`P-${ano}-%`);
  const n = ultimo ? Number(ultimo.numero.split('-').at(-1)) + 1 : 1;
  return `P-${ano}-${String(n).padStart(3, '0')}`;
}

/** Guarda a proposta com a folha calculada no dia. */
function criar(db, dados, usuarioId = null) {
  const folha = calcular(db, Number(dados.circuito_id), dados);
  const numero = proximoNumero(db);
  const titulo = folha.anunciante ? `${folha.circuito.nome} — ${folha.anunciante.nome}` : folha.circuito.nome;
  const id = Number(db.prepare(`INSERT INTO propostas (numero, anunciante_id, circuito_id, titulo, meses, desconto_percentual,
      insercoes_hora, mes_centavos, total_centavos, valida_ate, observacao, folha, criado_por, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    numero, folha.anunciante?.id ?? null, folha.circuito.id, titulo, folha.investimento.meses, folha.investimento.desconto_percentual,
    folha.veiculacao.insercoes_hora, folha.investimento.mes_centavos, folha.investimento.total_centavos, folha.valida_ate,
    dados.observacao ?? null, JSON.stringify({ ...folha, numero, observacao: dados.observacao ?? null }), usuarioId, agora(),
  ).lastInsertRowid);
  return detalhe(db, id);
}

/** A proposta guardada, com a folha do dia em que foi feita. */
function detalhe(db, id) {
  const p = db.prepare(`SELECT p.*, a.nome AS anunciante, ci.nome AS circuito, u.nome AS criado_por_nome,
      ct.numero AS contrato_numero, ca.nome AS campanha_nome
    FROM propostas p LEFT JOIN anunciantes a ON a.id = p.anunciante_id LEFT JOIN circuitos ci ON ci.id = p.circuito_id
    LEFT JOIN usuarios u ON u.id = p.criado_por LEFT JOIN contratos ct ON ct.id = p.contrato_id
    LEFT JOIN campanhas ca ON ca.id = p.campanha_id WHERE p.id = ?`).get(id);
  if (!p) throw new ErroNegocio('Proposta não encontrada.', 404);
  return { ...p, folha: JSON.parse(p.folha), expirada: p.status === 'enviada' && p.valida_ate < hoje() };
}

/**
 * Aceita a proposta: nasce o contrato com o que foi combinado e a campanha já apontando para o
 * circuito vendido. A campanha entra como rascunho — falta o criativo, e quem aprova é a equipe.
 */
function aceitar(db, id, { anuncianteId = null, inicio = null, usuarioId = null } = {}) {
  const p = detalhe(db, id);
  if (p.status === 'aceita') throw new ErroNegocio('Esta proposta já foi aceita.', 409);
  if (p.status === 'recusada') throw new ErroNegocio('Esta proposta foi recusada. Gere uma nova.', 409);
  const anunciante = anuncianteId ?? p.anunciante_id;
  if (!anunciante) throw new ErroNegocio('Informe o cliente para criar o contrato.', 422);
  if (!db.prepare('SELECT 1 FROM anunciantes WHERE id = ?').get(anunciante)) throw new ErroNegocio('Cliente não encontrado.', 422);

  const conf = lerConfig(db);
  const comeca = inicio ?? hoje();
  const termina = somarMesesData(comeca, p.meses);

  return transacao(db, () => {
    const ano = comeca.slice(0, 4);
    const ultimo = db.prepare('SELECT numero FROM contratos WHERE numero LIKE ? ORDER BY numero DESC LIMIT 1').get(`${ano}-%`);
    const seq = ultimo ? Number(ultimo.numero.split('-').at(-1)) + 1 : 1;
    const numeroContrato = `${ano}-${String(seq).padStart(3, '0')}`;

    const contratoId = Number(db.prepare(`INSERT INTO contratos (anunciante_id, numero, objeto, inicio, fim, cobranca, valor_centavos,
        vencimento_dia, reajuste, reajuste_meses, status, observacao, criado_por, criado_em)
      VALUES (?, ?, ?, ?, ?, 'mensal', ?, ?, ?, 12, 'ativo', ?, ?, ?)`).run(
      anunciante, numeroContrato, `Veiculação no circuito ${p.folha.circuito.nome}`, comeca, termina, p.mes_centavos,
      conf.vencimento_dia, 'A combinar', `Gerado da proposta ${p.numero}.`, usuarioId, agora(),
    ).lastInsertRowid);

    const campanhaId = Number(db.prepare(`INSERT INTO campanhas (anunciante_id, contrato_id, circuito_id, nome, status, inicio, fim,
        cobranca, valor_centavos, insercoes_hora, criada_por, criado_em)
      VALUES (?, ?, ?, ?, 'rascunho', ?, ?, 'mensal', ?, ?, ?, ?)`).run(
      anunciante, contratoId, p.circuito_id, p.folha.circuito.nome, comeca, termina, p.mes_centavos,
      p.insercoes_hora, usuarioId, agora(),
    ).lastInsertRowid);

    // A campanha herda as telas pelo circuito: os alvos do circuito viram os alvos dela.
    const alvos = db.prepare('SELECT tipo, valor FROM circuito_alvos WHERE circuito_id = ?').all(p.circuito_id);
    for (const a of alvos) {
      db.prepare('INSERT OR IGNORE INTO campanha_alvos (campanha_id, tipo, valor) VALUES (?, ?, ?)').run(campanhaId, a.tipo, a.valor);
    }

    db.prepare("UPDATE propostas SET status = 'aceita', respondida_em = ?, anunciante_id = ?, contrato_id = ?, campanha_id = ? WHERE id = ?")
      .run(hoje(), anunciante, contratoId, campanhaId, id);
    return { ...detalhe(db, id), criado: { contrato_id: contratoId, numero: numeroContrato, campanha_id: campanhaId, alvos: alvos.length } };
  });
}

/** O funil: quantas propostas estão em pé, quanto vale o que está na mesa e quanto virou contrato. */
function listar(db, filtros = {}) {
  const onde = [];
  const p = [];
  if (filtros.status) { onde.push('p.status = ?'); p.push(filtros.status); }
  if (filtros.anunciante_id) { onde.push('p.anunciante_id = ?'); p.push(Number(filtros.anunciante_id)); }
  if (filtros.circuito_id) { onde.push('p.circuito_id = ?'); p.push(Number(filtros.circuito_id)); }
  const itens = db.prepare(`SELECT p.id, p.numero, p.titulo, p.status, p.meses, p.desconto_percentual, p.mes_centavos, p.total_centavos,
      p.valida_ate, p.criado_em, p.enviada_em, p.respondida_em, p.contrato_id, p.campanha_id,
      a.nome AS anunciante, ci.nome AS circuito, ct.numero AS contrato_numero
    FROM propostas p LEFT JOIN anunciantes a ON a.id = p.anunciante_id LEFT JOIN circuitos ci ON ci.id = p.circuito_id
    LEFT JOIN contratos ct ON ct.id = p.contrato_id
    ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''} ORDER BY p.criado_em DESC`).all(...p)
    .map((x) => ({ ...x, expirada: x.status === 'enviada' && x.valida_ate < hoje() }));

  const soma = (f) => itens.filter(f).reduce((t, x) => t + x.total_centavos, 0);
  const respondidas = itens.filter((x) => x.status === 'aceita' || x.status === 'recusada').length;
  return {
    itens,
    totais: {
      rascunho: itens.filter((x) => x.status === 'rascunho').length,
      enviadas: itens.filter((x) => x.status === 'enviada').length,
      aceitas: itens.filter((x) => x.status === 'aceita').length,
      recusadas: itens.filter((x) => x.status === 'recusada').length,
      expiradas: itens.filter((x) => x.expirada).length,
      na_mesa_centavos: soma((x) => x.status === 'enviada' && !x.expirada),
      fechado_centavos: soma((x) => x.status === 'aceita'),
      // Taxa de conversão sobre as que já tiveram resposta: proposta parada não conta como perdida.
      conversao_percentual: respondidas ? Math.round((itens.filter((x) => x.status === 'aceita').length / respondidas) * 10_000) : 0,
    },
  };
}

module.exports = { telasDoCircuito, resumoCircuito, calcular, criar, detalhe, aceitar, listar, proximoNumero };
