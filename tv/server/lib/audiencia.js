'use strict';

const config = require('../config');
const { hoje, somarDias, intervalo, competencia } = require('./datas');

/**
 * Audiência e números da operação. A base é a tabela de sessões do player: cada tela aberta
 * registra o que assistiu e por quanto tempo.
 */

const minutos = (segundos) => Math.round((segundos ?? 0) / 60);

/** Telas assistindo neste instante (o "ao vivo" da operação). */
function assistindoAgora(db) {
  const corte = new Date(Date.now() - config.sessaoPlayerSegundos * 1000).toISOString();
  const linhas = db.prepare(`SELECT s.id, s.tipo, s.dispositivo, s.iniciada_em, s.segundos, s.qualidade,
      u.nome AS assinante, pf.nome AS perfil, c.nome AS canal, t.nome AS titulo, e.nome AS episodio, e.numero AS episodio_numero
    FROM sessoes_player s JOIN usuarios u ON u.id = s.usuario_id JOIN perfis pf ON pf.id = s.perfil_id
    LEFT JOIN canais c ON c.id = s.canal_id LEFT JOIN titulos t ON t.id = s.titulo_id LEFT JOIN episodios e ON e.id = s.episodio_id
    WHERE s.encerrada_em IS NULL AND s.ultimo_ping >= ? ORDER BY s.iniciada_em DESC LIMIT 200`).all(corte);
  return linhas.map((s) => ({ ...s, o_que: s.canal ?? (s.episodio ? `${s.titulo} · ep. ${s.episodio_numero}` : s.titulo) ?? 'Trailer' }));
}

/** Indicadores do painel da operação. */
function painel(db) {
  const hj = hoje();
  const [inicioHoje, fimHoje] = intervalo(hj, hj);
  const umaConta = (sql, ...p) => db.prepare(sql).get(...p);
  const assinaturas = db.prepare('SELECT status, COUNT(*) AS n FROM assinaturas GROUP BY status').all();
  const porStatus = Object.fromEntries(assinaturas.map((a) => [a.status, a.n]));
  const mrr = umaConta(`SELECT COALESCE(SUM(CASE WHEN p.periodicidade = 'anual' THEN p.preco_centavos / 12 ELSE p.preco_centavos END), 0) AS total
    FROM assinaturas a JOIN planos p ON p.id = a.plano_id WHERE a.status = 'ativa'`).total;
  const audienciaHoje = umaConta('SELECT COALESCE(SUM(segundos), 0) AS s, COUNT(*) AS n FROM sessoes_player WHERE iniciada_em >= ? AND iniciada_em < ?', inicioHoje, fimHoje);
  const faturas = umaConta(`SELECT COUNT(*) AS n, COALESCE(SUM(valor_centavos), 0) AS total FROM faturas WHERE status = 'aberta'`);
  const vencidas = umaConta(`SELECT COUNT(*) AS n, COALESCE(SUM(valor_centavos), 0) AS total FROM faturas WHERE status = 'aberta' AND vencimento < ?`, hj);
  const recebidoMes = umaConta(`SELECT COALESCE(SUM(valor_centavos), 0) AS total FROM faturas WHERE status = 'paga' AND substr(paga_em, 1, 7) = ?`, competencia(hj)).total;
  return {
    assinantes: {
      ativos: porStatus.ativa ?? 0,
      pendentes: porStatus.pendente ?? 0,
      suspensos: porStatus.suspensa ?? 0,
      cancelados: porStatus.cancelada ?? 0,
      novos_no_mes: umaConta("SELECT COUNT(*) AS n FROM assinaturas WHERE substr(criada_em, 1, 7) = ?", competencia(hj)).n,
      cancelados_no_mes: umaConta("SELECT COUNT(*) AS n FROM assinaturas WHERE cancelada_em IS NOT NULL AND substr(cancelada_em, 1, 7) = ?", competencia(hj)).n,
      contas: umaConta("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'assinante'").n,
    },
    receita: { mrr_centavos: mrr, recebido_no_mes_centavos: recebidoMes, a_receber_centavos: faturas.total, faturas_abertas: faturas.n,
      vencidas_n: vencidas.n, vencidas_centavos: vencidas.total },
    audiencia: { telas_agora: assistindoAgora(db).length, sessoes_hoje: audienciaHoje.n, minutos_hoje: minutos(audienciaHoje.s) },
    conteudo: {
      canais: umaConta('SELECT COUNT(*) AS n FROM canais WHERE ativo = 1').n,
      canais_fora_do_ar: umaConta("SELECT COUNT(*) AS n FROM canais WHERE ativo = 1 AND sinal_status = 'falha'").n,
      titulos_publicados: umaConta("SELECT COUNT(*) AS n FROM titulos WHERE situacao = 'publicado'").n,
      titulos_rascunho: umaConta("SELECT COUNT(*) AS n FROM titulos WHERE situacao = 'rascunho'").n,
      episodios: umaConta("SELECT COUNT(*) AS n FROM episodios WHERE situacao = 'publicado'").n,
      programas_na_grade: umaConta('SELECT COUNT(*) AS n FROM programas WHERE fim > ?', new Date().toISOString()).n,
      enviando: umaConta("SELECT COUNT(*) AS n FROM midias WHERE status = 'enviando'").n,
    },
  };
}

/** Audiência por dia (minutos assistidos e telas abertas). */
function porDia(db, { de, ate }) {
  const [inicio, fim] = intervalo(de, ate);
  const linhas = db.prepare(`SELECT substr(iniciada_em, 1, 10) AS dia, COUNT(*) AS sessoes, COALESCE(SUM(segundos), 0) AS segundos,
      COUNT(DISTINCT usuario_id) AS contas
    FROM sessoes_player WHERE iniciada_em >= ? AND iniciada_em < ? GROUP BY dia ORDER BY dia`).all(inicio, fim);
  return linhas.map((l) => ({ ...l, minutos: minutos(l.segundos) }));
}

const topTitulos = (db, { de, ate, limite = 20 }) => {
  const [inicio, fim] = intervalo(de, ate);
  return db.prepare(`SELECT t.id, t.nome, t.tipo, COUNT(*) AS sessoes, COALESCE(SUM(s.segundos), 0) AS segundos, COUNT(DISTINCT s.usuario_id) AS contas
    FROM sessoes_player s JOIN titulos t ON t.id = s.titulo_id
    WHERE s.iniciada_em >= ? AND s.iniciada_em < ? GROUP BY t.id ORDER BY segundos DESC, sessoes DESC LIMIT ?`).all(inicio, fim, limite)
    .map((l) => ({ ...l, minutos: minutos(l.segundos) }));
};

const topCanais = (db, { de, ate, limite = 20 }) => {
  const [inicio, fim] = intervalo(de, ate);
  return db.prepare(`SELECT c.id, c.nome, c.numero, COUNT(*) AS sessoes, COALESCE(SUM(s.segundos), 0) AS segundos, COUNT(DISTINCT s.usuario_id) AS contas
    FROM sessoes_player s JOIN canais c ON c.id = s.canal_id
    WHERE s.iniciada_em >= ? AND s.iniciada_em < ? GROUP BY c.id ORDER BY segundos DESC, sessoes DESC LIMIT ?`).all(inicio, fim, limite)
    .map((l) => ({ ...l, minutos: minutos(l.segundos) }));
};

/** Por hora do dia: mostra o horário nobre da plataforma. */
const porHora = (db, { de, ate }) => {
  const [inicio, fim] = intervalo(de, ate);
  const linhas = db.prepare(`SELECT CAST(strftime('%H', iniciada_em, ?) AS INTEGER) AS hora, COUNT(*) AS sessoes, COALESCE(SUM(segundos), 0) AS segundos
    FROM sessoes_player WHERE iniciada_em >= ? AND iniciada_em < ? GROUP BY hora ORDER BY hora`)
    .all(`${-new Date().getTimezoneOffset() / 60} hours`, inicio, fim);
  const cheio = Array.from({ length: 24 }, (_, h) => ({ hora: h, sessoes: 0, segundos: 0, minutos: 0 }));
  for (const l of linhas) if (l.hora >= 0 && l.hora < 24) cheio[l.hora] = { ...l, minutos: minutos(l.segundos) };
  return cheio;
};

/** Dispositivos usados (aparelho informado pelo player). */
const porDispositivo = (db, { de, ate }) => {
  const [inicio, fim] = intervalo(de, ate);
  return db.prepare(`SELECT COALESCE(dispositivo, 'Não informado') AS dispositivo, COUNT(*) AS sessoes, COALESCE(SUM(segundos), 0) AS segundos
    FROM sessoes_player WHERE iniciada_em >= ? AND iniciada_em < ? GROUP BY dispositivo ORDER BY sessoes DESC LIMIT 20`).all(inicio, fim)
    .map((l) => ({ ...l, minutos: minutos(l.segundos) }));
};

/** Faturamento por competência (o que foi cobrado, pago e perdido). */
const financeiro = (db, { meses = 12 } = {}) => db.prepare(`SELECT competencia,
    COUNT(*) AS faturas,
    COALESCE(SUM(valor_centavos), 0) AS cobrado_centavos,
    COALESCE(SUM(CASE WHEN status = 'paga' THEN valor_centavos ELSE 0 END), 0) AS pago_centavos,
    COALESCE(SUM(CASE WHEN status = 'aberta' THEN valor_centavos ELSE 0 END), 0) AS aberto_centavos,
    COALESCE(SUM(CASE WHEN status = 'cancelada' THEN valor_centavos ELSE 0 END), 0) AS cancelado_centavos
  FROM faturas GROUP BY competencia ORDER BY competencia DESC LIMIT ?`).all(meses);

/** Resumo por plano: quantos assinantes e quanto cada plano traz. */
const porPlano = (db) => db.prepare(`SELECT p.id, p.nome, p.preco_centavos, p.telas, p.qualidade,
    COUNT(a.id) AS assinaturas,
    SUM(CASE WHEN a.status = 'ativa' THEN 1 ELSE 0 END) AS ativas,
    COALESCE(SUM(CASE WHEN a.status = 'ativa' THEN p.preco_centavos ELSE 0 END), 0) AS receita_centavos
  FROM planos p LEFT JOIN assinaturas a ON a.plano_id = p.id GROUP BY p.id ORDER BY p.ordem, p.preco_centavos`).all();

/** Período padrão dos relatórios: últimos 30 dias. */
const periodoPadrao = () => ({ de: somarDias(hoje(), -29), ate: hoje() });

module.exports = { minutos, assistindoAgora, painel, porDia, topTitulos, topCanais, porHora, porDispositivo, financeiro, porPlano, periodoPadrao };
