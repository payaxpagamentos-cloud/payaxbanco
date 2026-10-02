'use strict';

/*
 * Situação de cada serviço da plataforma, como numa página de status: no ar, degradado ou fora do ar.
 * Cada teste rápido (a cada PAYAX_MONITOR_INTERVALO_MIN minutos e em toda verificação completa) grava uma linha por
 * serviço em monitor_servicos. Daí saem há quanto tempo o serviço está no ar, a disponibilidade e os incidentes.
 */

/** Serviços monitorados e as funções (testes de seguranca.verificarFuncoes) que compõem cada um. */
const SERVICOS = [
  { chave: 'banqueiro', nome: 'Banqueiro', descricao: 'Sistema da equipe: cadastros, contas, Ouvidoria e gestão', funcoes: ['telas_banqueiro', 'login_equipe', 'alcadas', 'ouvidoria'] },
  { chave: 'internet_banking', nome: 'Internet Banking', descricao: 'Acesso dos clientes: saldo, PIX, pagamentos e limites', funcoes: ['telas_ib', 'teclado', 'limites', 'boletos', 'pix_qr'] },
  { chave: 'site', nome: 'Site institucional', descricao: 'Página pública da PAY AX com a entrada do Internet Banking', funcoes: ['telas_site'] },
  { chave: 'api', nome: 'Servidor e API', descricao: 'Aplicação que atende o Banqueiro, o Internet Banking e o site', funcoes: [] },
  { chave: 'banco_dados', nome: 'Banco de dados', descricao: 'Clientes, contas, saldos e transações', funcoes: ['banco'] },
  { chave: 'bradesco', nome: 'Integração Bradesco', descricao: 'PIX, transferências e pagamentos pelo BaaS', funcoes: ['bradesco'] },
  { chave: 'antifraude', nome: 'Antifraude', descricao: 'Análise de transações e acessos fora do padrão', funcoes: ['antifraude'] },
  { chave: 'backup', nome: 'Backup', descricao: 'Cópias de segurança do banco de dados', funcoes: [] },
];
const PORCHAVE = new Map(SERVICOS.map((s) => [s.chave, s]));
const RETENCAO_DIAS = 31;

const quando = (t) => Date.parse(`${String(t).replace(' ', 'T')}Z`);
function duracao(s) {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

/** Situação atual de cada serviço a partir dos testes de função, do servidor e das conexões. */
function avaliar(_db, { funcoes, servidor, conexoes }) {
  const porId = new Map(funcoes.map((f) => [f.id, f]));
  const checagem = (id) => conexoes?.checagens?.find((c) => c.id === id);
  return SERVICOS.map((s) => {
    const lista = s.funcoes.map((id) => porId.get(id)).filter(Boolean);
    const falhas = lista.filter((f) => !f.ok);
    let status = falhas.length ? 'fora' : 'ok';
    let detalhe = falhas.length ? `Com falha: ${falhas.map((f) => `${f.nome} (${f.detalhe})`).join('; ')}` : lista.length === 1 ? lista[0].detalhe : `${lista.length} funções respondendo`;
    const ms = lista.reduce((t, f) => t + f.ms, 0);
    if (s.chave === 'api') {
      const avisos = [];
      const r = conexoes?.requisicoes;
      if (r?.s5xx) avisos.push(`${r.s5xx} erro(s) do servidor na última hora`);
      if (servidor?.ambiente === 'servidor') {
        const mem = 1 - servidor.memoria_livre_bytes / servidor.memoria_total_bytes;
        if (mem > 0.9) avisos.push(`memória em ${Math.round(mem * 100)}%`);
        if (servidor.disco && servidor.disco.livre_bytes / servidor.disco.total_bytes < 0.1) avisos.push('menos de 10% de disco livre');
      }
      status = avisos.length ? 'degradado' : 'ok';
      detalhe = avisos.length ? avisos.join(' · ') : servidor?.ativo_ha_s ? `Respondendo · processo no ar há ${duracao(servidor.ativo_ha_s)}` : 'Respondendo';
    }
    if (s.chave === 'bradesco' && status === 'ok' && conexoes?.banco?.pix_falhas_24h) {
      status = 'degradado';
      detalhe = `${conexoes.banco.pix_falhas_24h} PIX com falha nas últimas 24 h`;
    }
    if (s.chave === 'backup') {
      const c = checagem('backup');
      status = c?.ok ? 'ok' : 'degradado';
      detalhe = c?.detalhe ?? 'Sem informação';
    }
    return { chave: s.chave, status, detalhe, ms, funcoes: lista };
  });
}

function registrarPulso(db, lista) {
  const ins = db.prepare('INSERT INTO monitor_servicos (servico, status, ms, detalhe, funcoes) VALUES (?, ?, ?, ?, ?)');
  for (const s of lista) ins.run(s.chave, s.status, s.ms, s.detalhe, JSON.stringify(s.funcoes));
  db.prepare(`DELETE FROM monitor_servicos WHERE criado_em < datetime('now', '-${RETENCAO_DIAS} days')`).run();
}

/** Desde quando o serviço está na situação atual (no ar: desde a última queda; fora: desde que caiu). */
function desde(db, chave, status) {
  // Ordem pela sequência dos testes (id), que não depende de dois testes caírem no mesmo segundo.
  const id = (sql) => db.prepare(sql).get(chave)?.id ?? 0;
  const em = (sql, ref) => db.prepare(sql).get(chave, ref)?.em ?? null;
  if (status === 'fora') {
    const ultimoNoAr = id("SELECT MAX(id) AS id FROM monitor_servicos WHERE servico = ? AND status != 'fora'");
    return em("SELECT criado_em AS em FROM monitor_servicos WHERE servico = ? AND status = 'fora' AND id > ? ORDER BY id LIMIT 1", ultimoNoAr);
  }
  const ultimaQueda = id("SELECT MAX(id) AS id FROM monitor_servicos WHERE servico = ? AND status = 'fora'");
  return em("SELECT criado_em AS em FROM monitor_servicos WHERE servico = ? AND status != 'fora' AND id > ? ORDER BY id LIMIT 1", ultimaQueda);
}

function disponibilidade(db, chave, periodo) {
  const r = db.prepare(`SELECT COUNT(*) AS total, SUM(status != 'fora') AS no_ar FROM monitor_servicos WHERE servico = ? AND criado_em >= datetime('now', ?)`).get(chave, periodo);
  return r.total ? Math.round((r.no_ar / r.total) * 100000) / 1000 : null;
}

/** Cartões da página de status. */
function resumo(db) {
  return SERVICOS.map((s) => {
    const u = db.prepare('SELECT status, detalhe, ms, criado_em FROM monitor_servicos WHERE servico = ? ORDER BY id DESC LIMIT 1').get(s.chave);
    return {
      chave: s.chave, nome: s.nome, descricao: s.descricao,
      status: u?.status ?? null, detalhe: u?.detalhe ?? 'Ainda não verificado', ms: u?.ms ?? null, ultima_em: u?.criado_em ?? null,
      desde: u ? desde(db, s.chave, u.status) : null,
      disponibilidade_24h: disponibilidade(db, s.chave, '-1 day'),
      barras_24h: db.prepare(`SELECT strftime('%Y-%m-%d %H:00:00', criado_em) AS hora, MAX(CASE status WHEN 'fora' THEN 2 WHEN 'degradado' THEN 1 ELSE 0 END) AS pior
        FROM monitor_servicos WHERE servico = ? AND criado_em >= datetime('now', '-1 day') GROUP BY hora ORDER BY hora`).all(s.chave)
        .map((b) => ({ hora: b.hora, status: ['ok', 'degradado', 'fora'][b.pior] })),
    };
  });
}

/** Períodos fora do normal (degradado ou fora do ar) nos últimos 30 dias, do mais recente para o mais antigo. */
function incidentes(db, chave) {
  const linhas = db.prepare("SELECT status, detalhe, criado_em FROM monitor_servicos WHERE servico = ? AND criado_em >= datetime('now', '-30 days') ORDER BY id").all(chave);
  const lista = [];
  let atual = null;
  for (const l of linhas) {
    if (l.status !== 'ok') {
      if (!atual) { atual = { status: l.status, inicio: l.criado_em, fim: null, detalhe: l.detalhe }; lista.push(atual); } else if (l.status === 'fora') { atual.status = 'fora'; atual.detalhe = l.detalhe; }
    } else if (atual) { atual.fim = l.criado_em; atual = null; }
  }
  return lista.reverse().slice(0, 20).map((i) => ({ ...i, duracao_s: Math.round(((i.fim ? quando(i.fim) : Date.now()) - quando(i.inicio)) / 1000) }));
}

/** Tudo de um serviço: situação, há quanto tempo, disponibilidade, barras por hora (7 dias), incidentes e funções. */
function detalhe(db, chave) {
  const s = PORCHAVE.get(chave);
  if (!s) return null;
  const atual = resumo(db).find((x) => x.chave === chave);
  const ultimo = db.prepare('SELECT funcoes FROM monitor_servicos WHERE servico = ? ORDER BY id DESC LIMIT 1').get(chave);
  const est = db.prepare(`SELECT COUNT(*) AS n, AVG(ms) AS ms, MIN(criado_em) AS primeira FROM monitor_servicos WHERE servico = ? AND criado_em >= datetime('now', '-30 days')`).get(chave);
  const barras = db.prepare(`SELECT strftime('%Y-%m-%d %H:00:00', criado_em) AS hora, COUNT(*) AS n,
      MAX(CASE status WHEN 'fora' THEN 2 WHEN 'degradado' THEN 1 ELSE 0 END) AS pior
    FROM monitor_servicos WHERE servico = ? AND criado_em >= datetime('now', '-7 days') GROUP BY hora ORDER BY hora`).all(chave);
  return {
    ...atual,
    disponibilidade: { h24: disponibilidade(db, chave, '-1 day'), d7: disponibilidade(db, chave, '-7 days'), d30: disponibilidade(db, chave, '-30 days') },
    verificacoes_30d: est.n, ms_medio: est.ms === null ? null : Math.round(est.ms), monitorado_desde: est.primeira,
    barras: barras.map((b) => ({ hora: b.hora, n: b.n, status: ['ok', 'degradado', 'fora'][b.pior] })),
    incidentes: incidentes(db, chave),
    funcoes: ultimo?.funcoes ? JSON.parse(ultimo.funcoes) : [],
  };
}

module.exports = { SERVICOS, avaliar, registrarPulso, resumo, detalhe, incidentes, duracao };
