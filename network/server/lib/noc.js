'use strict';

const { agora } = require('../db');
const rede = require('./rede');

const NOMES_METRICA = {
  disponibilidade: 'Equipamento sem resposta', latencia_ms: 'Latência elevada', perda_pacotes_pct: 'Perda de pacotes', optical_rx_dbm: 'Degradação óptica',
  interface_status: 'Interface indisponível', utilizacao_pct: 'Enlace degradado',
};
const SEV_CTO = { critica: 'indisponivel', alta: 'atencao', media: 'atencao', baixa: 'atencao' };

const evento = (db, incidenteId, tipo, detalhes, usuarioId = null, em = agora()) =>
  db.prepare('INSERT INTO incidente_eventos (incidente_id, tipo, detalhes, usuario_id, em) VALUES (?, ?, ?, ?, ?)')
    .run(incidenteId, tipo, typeof detalhes === 'string' ? detalhes : JSON.stringify(detalhes), usuarioId, em);

/** POPs acima (que alimentam) o ativo, pelas ligações ativas. */
const ancestrais = (db, ativoId) => (ativoId ? rede.percurso(db, ativoId).passos.slice(1).map((p) => p.id) : []);

/** Ativos possivelmente afetados por um incidente: as CTOs da PON, as do equipamento, ou o ativo e seus dependentes. */
function ativosAfetados(db, inc) {
  const ids = new Set();
  if (inc.equipamento_id) {
    const p = [inc.organizacao_id, inc.equipamento_id];
    let f = "organizacao_id = ? AND equipamento_id = ? AND tipo = 'cto' AND ativo = 1";
    if (inc.ponto) { f += ' AND pon = ?'; p.push(inc.ponto); }
    for (const c of db.prepare(`SELECT id FROM ativos_rede WHERE ${f}`).all(...p)) ids.add(c.id);
  }
  if (inc.ativo_id && !inc.ponto) {
    ids.add(inc.ativo_id);
    for (const d of rede.descendentes(db, inc.ativo_id)) ids.add(d);
  }
  return [...ids];
}

/** Impacto do incidente e dos incidentes correlacionados abaixo dele, sem contar o mesmo cliente duas vezes. */
function impacto(db, inc) {
  const filhos = db.prepare("SELECT * FROM incidentes WHERE incidente_pai_id = ? AND status <> 'resolvido'").all(inc.id);
  const r = rede.impacto(db, [inc, ...filhos].flatMap((i) => ativosAfetados(db, i)));
  return { ...r, ctos: r.ctos.length, incidentes_relacionados: filhos.length,
    observacao: r.clientes_unicos === 0 && r.portas_ocupadas > 0 ? 'Sem referência de cliente nas portas: considere "portas ocupadas", não clientes offline.' : null };
}

/**
 * Correlação por dependência. Um incidente aberto P (sem ponto específico) explica o incidente I quando:
 *  (a) P é do mesmo equipamento e I é de um ponto dele (ex.: OLT fora explica a PON);
 *  (b) o ativo de P alimenta, direta ou indiretamente, o ativo de I (POP/CEO acima);
 *  (c) P é um incidente do próprio ativo (sem equipamento) e I é de um equipamento desse ativo.
 * A correlação é "provável" até o operador confirmar ou corrigir; os eventos de cada incidente continuam auditáveis.
 */
function explica(db, p, i, ancestraisDeI) {
  if (p.id === i.id || p.ponto) return false;
  if (i.ponto && p.equipamento_id && p.equipamento_id === i.equipamento_id) return true;
  if (p.ativo_id && ancestraisDeI.includes(p.ativo_id)) return true;
  return Boolean(p.ativo_id && !p.equipamento_id && i.equipamento_id && p.ativo_id === i.ativo_id);
}

function correlacionar(db, inc) {
  const abertos = db.prepare("SELECT * FROM incidentes WHERE organizacao_id = ? AND id <> ? AND status <> 'resolvido'").all(inc.organizacao_id, inc.id);
  const pai = abertos.filter((c) => !c.incidente_pai_id).sort((x, y) => x.inicio.localeCompare(y.inicio)).find((c) => explica(db, c, inc, ancestrais(db, inc.ativo_id)));
  if (pai) {
    db.prepare("UPDATE incidentes SET incidente_pai_id = ?, confianca_correlacao = 'provavel' WHERE id = ?").run(pai.id, inc.id);
    evento(db, inc.id, 'correlacionado', `Provavelmente explicado pelo incidente #${pai.id} (${pai.titulo}).`);
    return;
  }
  // Incidentes já abertos que este explica passam a ficar organizados sob ele (e os filhos deles também).
  for (const c of abertos) {
    if (c.incidente_pai_id && c.confianca_correlacao === 'confirmada') continue;
    if (!explica(db, inc, c, ancestrais(db, c.ativo_id))) continue;
    db.prepare("UPDATE incidentes SET incidente_pai_id = ?, confianca_correlacao = 'provavel' WHERE id = ? OR incidente_pai_id = ?").run(inc.id, c.id, c.id);
    evento(db, c.id, 'correlacionado', `Provavelmente explicado pelo incidente #${inc.id} (${inc.titulo}).`);
  }
}

/**
 * Quando um incidente é resolvido, os incidentes ainda abertos que estavam organizados abaixo dele voltam a ser principais
 * (sem pai), com um evento explicando: a falha que os explicava acabou, mas eles continuam acontecendo.
 */
function promoverFilhos(db, inc, usuarioId = null, em = agora()) {
  const filhos = db.prepare("SELECT id FROM incidentes WHERE incidente_pai_id = ? AND status <> 'resolvido'").all(inc.id);
  for (const f of filhos) {
    db.prepare('UPDATE incidentes SET incidente_pai_id = NULL, confianca_correlacao = NULL, atualizado_em = ? WHERE id = ?').run(agora(), f.id);
    evento(db, f.id, 'correlacao_encerrada', `O incidente #${inc.id} (${inc.titulo}) foi resolvido; este continua aberto e volta a ser principal.`, usuarioId, em);
  }
  return filhos.map((f) => f.id);
}

/** CTOs afetadas por outros incidentes ainda abertos da organização (a recuperação de um não as declara operacionais). */
function ctosEmOutrosIncidentes(db, org, excetoId) {
  const ids = new Set();
  for (const i of db.prepare("SELECT * FROM incidentes WHERE organizacao_id = ? AND id <> ? AND status <> 'resolvido'").all(org, excetoId)) {
    for (const a of ativosAfetados(db, i)) ids.add(a);
  }
  return ids;
}

const textoValor = (a) => `${Number(Number(a.valor).toFixed(2)).toLocaleString('pt-BR')}${a.unidade ? ` ${a.unidade}` : ''}`;
const quando = (iso, fuso) => new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso));

function inferirCtosDoIncidente(db, inc, eq, amostra, status, regra, texto, fuso = 'America/Sao_Paulo', ignorar = null) {
  const evid = `${texto}: ${NOMES_METRICA[amostra.metrica] ?? amostra.metrica} ${textoValor(amostra)} medido em ${eq.nome}${amostra.ponto ? ` · ${amostra.ponto}` : ''} `
    + `em ${quando(amostra.observado_em, fuso)} (amostra ${amostra.origem_evento_id}, regra "${regra.nome}" v${regra.versao}). Inferência pela topologia; não é medição da CTO.`;
  const ids = rede.inferirCtos(db, { organizacaoId: inc.organizacao_id, equipamentoId: eq.id, ponto: amostra.ponto, status, evidencia: evid, ignorar });
  if (ids.length) evento(db, inc.id, 'inferencia_cto', { ctos: ids, status, evidencia: evid });
}

/**
 * Aplica as regras do NOC a uma amostra persistida. Para cada regra: conta violações e recuperações seguidas (com histerese entre
 * o limiar e o limiar de recuperação), abre o incidente após N confirmações, atualiza o existente em eventos repetidos, reabre
 * dentro da janela de recorrência e resolve após N recuperações. Amostras mais antigas que a última processada só ficam gravadas.
 */
function processarAmostra(db, org, amostra, eq) {
  const organizacao = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(org);
  const regras = db.prepare('SELECT * FROM regras_monitoramento WHERE organizacao_id = ? AND ativa = 1 AND metrica = ? AND (equipamento_id IS NULL OR equipamento_id = ?)')
    .all(org, amostra.metrica, eq.id);
  const resultado = [];
  for (const regra of regras) {
    const ponto = amostra.ponto ?? '';
    db.prepare('INSERT OR IGNORE INTO alvo_estado (organizacao_id, regra_id, equipamento_id, ponto) VALUES (?, ?, ?, ?)').run(org, regra.id, eq.id, ponto);
    const est = db.prepare('SELECT * FROM alvo_estado WHERE regra_id = ? AND equipamento_id = ? AND ponto = ?').get(regra.id, eq.id, ponto);
    if (est.ultima_amostra_em && amostra.observado_em <= est.ultima_amostra_em) { resultado.push({ regra: regra.id, acao: 'fora_de_ordem' }); continue; }
    const viola = regra.comparacao === 'menor' ? amostra.valor < regra.limiar : amostra.valor > regra.limiar;
    const recuperado = regra.comparacao === 'menor' ? amostra.valor >= regra.limiar_recuperacao : amostra.valor <= regra.limiar_recuperacao;
    const violacoes = viola ? est.violacoes + 1 : 0;
    const recuperacoes = !viola && recuperado ? est.recuperacoes + 1 : 0;
    db.prepare('UPDATE alvo_estado SET violacoes = ?, recuperacoes = ?, ultima_amostra_em = ? WHERE regra_id = ? AND equipamento_id = ? AND ponto = ?')
      .run(violacoes, recuperacoes, amostra.observado_em, regra.id, eq.id, ponto);
    const chave = `r${regra.id}:e${eq.id}:${ponto}`;
    const aberto = db.prepare("SELECT * FROM incidentes WHERE organizacao_id = ? AND chave_dedup = ? AND status <> 'resolvido'").get(org, chave);
    const medida = { valor: amostra.valor, unidade: amostra.unidade, em: amostra.observado_em, amostra: amostra.origem_evento_id };

    if (viola && aberto) {
      const ev = JSON.parse(aberto.evidencias || '{}');
      ev.medicoes = [...(ev.medicoes ?? []), medida].slice(-20);
      db.prepare('UPDATE incidentes SET ultima_observacao = ?, evidencias = ?, atualizado_em = ? WHERE id = ?').run(amostra.observado_em, JSON.stringify(ev), agora(), aberto.id);
      resultado.push({ regra: regra.id, acao: 'atualizado', incidente: aberto.id });
    } else if (viola && violacoes >= regra.confirmacoes) {
      const janela = new Date(Date.parse(amostra.observado_em) - organizacao.janela_recorrencia_min * 60_000).toISOString();
      const recente = db.prepare("SELECT * FROM incidentes WHERE organizacao_id = ? AND chave_dedup = ? AND status = 'resolvido' AND resolvido_em >= ? ORDER BY resolvido_em DESC LIMIT 1")
        .get(org, chave, janela);
      const evidencias = { regra: { id: regra.id, nome: regra.nome, versao: regra.versao, comparacao: regra.comparacao, limiar: regra.limiar,
        limiar_recuperacao: regra.limiar_recuperacao, confirmacoes: regra.confirmacoes }, fonte: amostra.fonte, alvo: amostra.alvo_id, ponto: amostra.ponto ?? null, medicoes: [medida] };
      let id;
      if (recente) {
        id = recente.id;
        const ev = JSON.parse(recente.evidencias || '{}');
        ev.medicoes = [...(ev.medicoes ?? []), medida].slice(-20);
        db.prepare(`UPDATE incidentes SET status = 'aberto', resolvido_em = NULL, resolvido_por = NULL, resolucao = NULL, recorrencias = recorrencias + 1,
          ultima_observacao = ?, evidencias = ?, atualizado_em = ? WHERE id = ?`).run(amostra.observado_em, JSON.stringify(ev), agora(), id);
        evento(db, id, 'recorrencia', `Voltou a falhar ${Math.round((Date.parse(amostra.observado_em) - Date.parse(recente.resolvido_em)) / 60_000)} min após a recuperação.`, null, amostra.observado_em);
      } else {
        const titulo = `${regra.nome} · ${eq.nome}${amostra.ponto ? ` ${amostra.ponto}` : ''}`;
        id = Number(db.prepare(`INSERT INTO incidentes (organizacao_id, chave_dedup, origem, regra_id, regra_versao, equipamento_id, ativo_id, ponto, titulo, metrica, severidade,
          primeira_observacao, ultima_observacao, inicio, evidencias, criado_em, atualizado_em) VALUES (?, ?, 'monitoramento', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(org, chave, regra.id, regra.versao, eq.id, eq.ativo_id, amostra.ponto ?? null, titulo, amostra.metrica, regra.severidade, amostra.observado_em,
            amostra.observado_em, amostra.observado_em, JSON.stringify(evidencias), agora(), agora()).lastInsertRowid);
        evento(db, id, 'aberto', `${violacoes} amostra(s) seguidas ${regra.comparacao === 'menor' ? 'abaixo' : 'acima'} de ${regra.limiar}${amostra.unidade ? ` ${amostra.unidade}` : ''}.`, null, amostra.observado_em);
        correlacionar(db, db.prepare('SELECT * FROM incidentes WHERE id = ?').get(id));
      }
      inferirCtosDoIncidente(db, { id, organizacao_id: org }, eq, amostra, SEV_CTO[regra.severidade], regra, 'Indício de falha', organizacao.fuso);
      resultado.push({ regra: regra.id, acao: recente ? 'reaberto' : 'aberto', incidente: id });
    } else if (aberto && recuperacoes >= regra.confirmacoes && aberto.origem === 'monitoramento') {
      db.prepare(`UPDATE incidentes SET status = 'resolvido', resolvido_em = ?, resolucao = 'automatica', ultima_observacao = ?, atualizado_em = ? WHERE id = ?`)
        .run(amostra.observado_em, amostra.observado_em, agora(), aberto.id);
      evento(db, aberto.id, 'resolvido', `Recuperação confirmada em ${recuperacoes} amostra(s) ${regra.comparacao === 'menor' ? 'a partir de' : 'até'} ${regra.limiar_recuperacao}. Duração: ${Math.round((Date.parse(amostra.observado_em) - Date.parse(aberto.inicio)) / 60_000)} min.`, null, amostra.observado_em);
      promoverFilhos(db, aberto, null, amostra.observado_em);
      // CTOs que outro incidente aberto ainda cobre (ex.: a PON que continua ruim) não passam a "operacional".
      inferirCtosDoIncidente(db, aberto, eq, amostra, 'operacional', regra, 'Recuperação confirmada', organizacao.fuso, ctosEmOutrosIncidentes(db, org, aberto.id));
      resultado.push({ regra: regra.id, acao: 'resolvido', incidente: aberto.id });
    } else {
      resultado.push({ regra: regra.id, acao: viola ? 'aguardando_confirmacao' : 'normal' });
    }
  }
  return resultado;
}

/** Disponibilidade medida nas últimas 24 h: fração das amostras "disponibilidade" com resposta, por equipamento e média. */
function disponibilidadeMedida(db, org) {
  const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
  const linhas = db.prepare(`SELECT equipamento_id, AVG(CASE WHEN valor >= 1 THEN 1.0 ELSE 0.0 END) AS frac, COUNT(*) AS n, MAX(observado_em) AS ultima, MAX(fonte) AS fonte
    FROM amostras WHERE organizacao_id = ? AND metrica = 'disponibilidade' AND observado_em >= ? GROUP BY equipamento_id`).all(org, desde);
  if (!linhas.length) return { valor: null, amostras: 0, equipamentos: 0, ultima_coleta: null, periodo: '24 h', fonte: null };
  return { valor: Math.round((linhas.reduce((a, l) => a + l.frac, 0) / linhas.length) * 10000) / 100, amostras: linhas.reduce((a, l) => a + l.n, 0),
    equipamentos: linhas.length, ultima_coleta: linhas.map((l) => l.ultima).sort().at(-1), periodo: '24 h', fonte: [...new Set(linhas.map((l) => l.fonte))].join(', ') };
}

module.exports = { processarAmostra, impacto, ativosAfetados, correlacionar, promoverFilhos, disponibilidadeMedida, evento, NOMES_METRICA };
