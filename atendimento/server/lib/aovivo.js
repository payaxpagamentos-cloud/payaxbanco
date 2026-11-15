'use strict';

const { hoje, intervalo, local } = require('./datas');
const { dentroHorario } = require('./filas');
const { resumo } = require('./relatorios');

/**
 * Painel ao vivo da supervisão (a TV na parede): o que está acontecendo agora, quem está esperando,
 * como está cada pessoa da equipe e como vai o dia. Tudo de uma consulta só, para atualizar a cada
 * poucos segundos sem pesar no servidor.
 *
 * Dados de cliente vão reduzidos ao mínimo (primeiro nome e o final do telefone): a tela fica à vista
 * de quem passa pela sala.
 */

// Meta de espera na fila do WhatsApp. Passou disso, a fila fica vermelha na TV.
const META_ESPERA_S = 5 * 60;
// Meta do nível de serviço: conversa assumida pela equipe em até 2 minutos depois de chegar na fila.
const META_ASSUMIR_S = 2 * 60;
// Sem pedir nada ao servidor há mais que isto, a pessoa não está com o painel aberto.
const ONLINE_MS = 3 * 60_000;

const segundosDesde = (iso, agora) => (iso ? Math.max(0, Math.round((agora - Date.parse(iso)) / 1000)) : 0);
/** "•••• 4321": o suficiente para a equipe reconhecer, sem expor o número na parede. */
const finalFone = (t) => { const d = String(t ?? '').replace(/\D/g, ''); return d.length >= 4 ? `•••• ${d.slice(-4)}` : '—'; };
const primeiroNome = (nome) => String(nome ?? '').trim().split(/\s+/)[0] || null;

function aoVivo(db, empresaId, { instante = new Date() } = {}) {
  const agora = instante.getTime();
  const [iniHoje, fimHoje] = intervalo(hoje(), hoje());
  const empresa = db.prepare('SELECT id, nome, telefonia_ativa, limite_canais FROM empresas WHERE id = ?').get(empresaId);

  // ---------- Agora ----------
  const estado = db.prepare(`SELECT
      COALESCE(SUM(estado = 'bot'), 0) AS com_zoe,
      COALESCE(SUM(estado = 'bot' AND canal = 'telefone'), 0) AS com_zoe_telefone,
      COALESCE(SUM(estado = 'aguardando'), 0) AS na_fila,
      COALESCE(SUM(estado = 'humano'), 0) AS com_equipe
    FROM conversas WHERE empresa_id = ? AND estado <> 'encerrada'`).get(empresaId);

  // ---------- Equipe ----------
  const pessoas = db.prepare(`SELECT u.id, u.nome, u.disponivel, u.max_simultaneas, u.ramal, u.visto_em,
      (SELECT COUNT(*) FROM conversas c WHERE c.atendente_id = u.id AND c.estado = 'humano') AS atendendo,
      (SELECT COUNT(*) FROM conversas c WHERE c.atendente_id = u.id AND c.resolvida_por = 'humano'
        AND c.encerrada_em >= ? AND c.encerrada_em < ?) AS encerradas_hoje,
      (SELECT MIN(c.assumida_em) FROM conversas c WHERE c.atendente_id = u.id AND c.estado = 'humano') AS atendendo_desde
    FROM usuarios u WHERE u.empresa_id = ? AND u.ativo = 1 AND u.perfil IN ('atendente','cliente')`).all(iniHoje, fimHoje, empresaId);

  // Ligação em curso de cada ramal (só com a telefonia ligada).
  const ligacoes = new Map();
  if (empresa.telefonia_ativa) {
    for (const l of db.prepare(`SELECT r.numero, c.inicio, c.atendida_em, c.direcao FROM pabx_chamadas c JOIN pabx_ramais r ON r.id = c.ramal_id
      WHERE c.empresa_id = ? AND c.fim IS NULL ORDER BY c.inicio`).all(empresaId)) {
      if (!ligacoes.has(l.numero)) ligacoes.set(l.numero, l);
    }
  }

  const equipe = pessoas.map((p) => {
    const online = Boolean(p.visto_em) && agora - Date.parse(p.visto_em) < ONLINE_MS;
    const ligacao = p.ramal ? ligacoes.get(p.ramal) : null;
    // Uma situação só por pessoa, na ordem do que a supervisão precisa enxergar primeiro.
    let situacao = 'ausente';
    if (ligacao) situacao = 'em_ligacao';
    else if (p.atendendo > 0) situacao = p.atendendo >= p.max_simultaneas ? 'lotado' : 'atendendo';
    else if (p.disponivel && online) situacao = 'livre';
    else if (online) situacao = 'pausa';
    return {
      id: p.id,
      nome: p.nome,
      situacao,
      online,
      disponivel: Boolean(p.disponivel),
      atendendo: p.atendendo,
      capacidade: p.max_simultaneas,
      encerradas_hoje: p.encerradas_hoje,
      ramal: p.ramal,
      desde_s: ligacao ? segundosDesde(ligacao.atendida_em ?? ligacao.inicio, agora) : segundosDesde(p.atendendo_desde, agora),
    };
  });
  const ORDEM = { em_ligacao: 0, lotado: 1, atendendo: 2, livre: 3, pausa: 4, ausente: 5 };
  equipe.sort((a, b) => ORDEM[a.situacao] - ORDEM[b.situacao] || b.atendendo - a.atendendo || a.nome.localeCompare(b.nome, 'pt-BR'));

  // ---------- Filas ----------
  // "Livre" na fila é o mesmo "livre" da equipe: disponível, com o painel aberto e com vaga (quem está lotado não conta).
  const livres = new Set(equipe.filter((p) => p.situacao === 'livre').map((p) => p.id));
  const membros = db.prepare(`SELECT fu.fila_id, u.id FROM fila_usuarios fu
    JOIN usuarios u ON u.id = fu.usuario_id AND u.ativo = 1 JOIN filas f ON f.id = fu.fila_id WHERE f.empresa_id = ?`).all(empresaId);
  const filas = db.prepare(`SELECT f.*, COUNT(c.id) AS aguardando, MIN(c.transferida_em) AS mais_antiga,
      (SELECT COUNT(*) FROM conversas h WHERE h.fila_id = f.id AND h.estado = 'humano') AS em_atendimento
    FROM filas f LEFT JOIN conversas c ON c.fila_id = f.id AND c.estado = 'aguardando'
    WHERE f.empresa_id = ? AND f.ativa = 1 GROUP BY f.id ORDER BY f.ordem, f.nome`).all(empresaId).map((f) => {
    const daFila = membros.filter((m) => m.fila_id === f.id);
    const espera = segundosDesde(f.mais_antiga, agora);
    return {
      id: f.id,
      nome: f.nome,
      aberta: dentroHorario(f, instante),
      aguardando: f.aguardando,
      em_atendimento: f.em_atendimento,
      espera_s: espera,
      atendentes: daFila.length,
      disponiveis: daFila.filter((m) => livres.has(m.id)).length,
      nivel: f.aguardando === 0 ? 'ok' : espera >= META_ESPERA_S ? 'critico' : espera >= META_ESPERA_S / 2 ? 'atencao' : 'ok',
    };
  });

  // ---------- Quem está esperando ----------
  const esperando = db.prepare(`SELECT c.id, c.canal, c.prioridade, c.transferida_em, c.assunto, f.nome AS fila,
      COALESCE(ct.nome, ct.nome_perfil) AS nome, ct.telefone
    FROM conversas c JOIN contatos ct ON ct.id = c.contato_id LEFT JOIN filas f ON f.id = c.fila_id
    WHERE c.empresa_id = ? AND c.estado = 'aguardando'
    ORDER BY CASE c.prioridade WHEN 'alta' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, c.transferida_em LIMIT 12`).all(empresaId)
    .map((c) => ({
      id: c.id,
      cliente: primeiroNome(c.nome) ?? 'Cliente',
      telefone: finalFone(c.telefone),
      canal: c.canal,
      fila: c.fila ?? 'Sem fila',
      assunto: c.assunto ? String(c.assunto).slice(0, 60) : null,
      prioridade: c.prioridade,
      espera_s: segundosDesde(c.transferida_em, agora),
    }));

  // ---------- Hoje ----------
  const dia = resumo(db, { empresaId, de: hoje(), ate: hoje() });
  const sla = db.prepare(`SELECT COUNT(*) AS assumidas,
      COALESCE(SUM((julianday(assumida_em) - julianday(transferida_em)) * 86400 <= ?), 0) AS no_prazo
    FROM conversas WHERE empresa_id = ? AND transferida_em IS NOT NULL AND assumida_em >= ? AND assumida_em < ?`)
    .get(META_ASSUMIR_S, empresaId, iniHoje, fimHoje);
  const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, zoe: 0, equipe: 0 }));
  for (const c of db.prepare('SELECT aberta_em, transferida_em FROM conversas WHERE empresa_id = ? AND aberta_em >= ? AND aberta_em < ?')
    .all(empresaId, iniHoje, fimHoje)) {
    porHora[local(c.aberta_em).hora][c.transferida_em ? 'equipe' : 'zoe']++;
  }

  // ---------- Telefone ----------
  let telefone = null;
  if (empresa.telefonia_ativa) {
    const t = db.prepare(`SELECT
        COALESCE(SUM(direcao = 'entrada'), 0) AS recebidas,
        COALESCE(SUM(direcao = 'entrada' AND status = 'atendida'), 0) AS atendidas,
        COALESCE(SUM(direcao = 'entrada' AND status IN ('nao_atendida','ocupado','falha')), 0) AS perdidas,
        COALESCE(SUM(direcao = 'saida'), 0) AS realizadas,
        COALESCE(ROUND(AVG(CASE WHEN status = 'atendida' AND fim IS NOT NULL THEN duracao_s END)), 0) AS tma_s
      FROM pabx_chamadas WHERE empresa_id = ? AND inicio >= ? AND inicio < ?`).get(empresaId, iniHoje, fimHoje);
    const ramais = db.prepare('SELECT COALESCE(SUM(online = 1), 0) AS online, COUNT(*) AS total FROM pabx_ramais WHERE empresa_id = ? AND ativo = 1').get(empresaId);
    const emCurso = db.prepare(`SELECT c.direcao, c.origem, c.destino, c.status, c.inicio, c.atendida_em, r.numero AS ramal, r.nome AS ramal_nome
      FROM pabx_chamadas c LEFT JOIN pabx_ramais r ON r.id = c.ramal_id WHERE c.empresa_id = ? AND c.fim IS NULL ORDER BY c.inicio LIMIT 50`).all(empresaId);
    telefone = {
      em_curso: emCurso.length,
      canais: empresa.limite_canais,
      tocando: emCurso.filter((c) => !c.atendida_em).length,
      recebidas: t.recebidas,
      atendidas: t.atendidas,
      perdidas: t.perdidas,
      realizadas: t.realizadas,
      tma_s: t.tma_s,
      taxa_atendimento: t.recebidas ? Number(((t.atendidas / t.recebidas) * 100).toFixed(1)) : null,
      ramais_online: ramais.online,
      ramais_total: ramais.total,
      chamadas: emCurso.slice(0, 8).map((c) => ({
        direcao: c.direcao,
        cliente: finalFone(c.direcao === 'saida' ? c.destino : c.origem),
        ramal: c.ramal_nome ? `${c.ramal} · ${c.ramal_nome}` : (c.ramal ?? 'ZOE / URA'),
        atendida: Boolean(c.atendida_em),
        duracao_s: segundosDesde(c.atendida_em ?? c.inicio, agora),
      })),
    };
  }

  // ---------- Alertas ----------
  // O que pede ação da supervisão agora, do mais grave para o menos.
  const alertas = [];
  for (const f of filas) {
    if (f.aguardando > 0 && f.disponiveis === 0) {
      alertas.push({ nivel: 'critico', texto: `${f.nome}: ${f.aguardando} esperando e ninguém disponível` });
    } else if (f.nivel === 'critico') {
      alertas.push({ nivel: 'critico', texto: `${f.nome}: espera passou de ${Math.round(META_ESPERA_S / 60)} min` });
    }
    if (f.aguardando > 0 && !f.aberta) alertas.push({ nivel: 'atencao', texto: `${f.nome} está fora do horário com ${f.aguardando} na fila` });
  }
  if (telefone && telefone.canais > 0 && telefone.em_curso >= Math.ceil(telefone.canais * 0.9)) {
    alertas.push({ nivel: telefone.em_curso >= telefone.canais ? 'critico' : 'atencao', texto: `Telefone com ${telefone.em_curso} de ${telefone.canais} canais em uso` });
  }
  if (estado.na_fila > 0 && !equipe.some((p) => p.online)) alertas.push({ nivel: 'critico', texto: 'Ninguém da equipe está com o painel aberto' });
  alertas.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'critico' ? -1 : 1));

  return {
    atualizado_em: new Date(agora).toISOString(),
    empresa: { id: empresa.id, nome: empresa.nome },
    metas: { espera_s: META_ESPERA_S, assumir_s: META_ASSUMIR_S },
    agora: {
      com_zoe: estado.com_zoe,
      com_zoe_telefone: estado.com_zoe_telefone,
      na_fila: estado.na_fila,
      com_equipe: estado.com_equipe,
      maior_espera_s: Math.max(0, ...filas.map((f) => f.espera_s)),
      equipe_online: equipe.filter((p) => p.online).length,
      equipe_livre: equipe.filter((p) => p.situacao === 'livre').length,
      equipe_total: equipe.length,
    },
    filas,
    esperando,
    equipe,
    hoje: {
      conversas: dia.conversas,
      encerradas: dia.encerradas,
      resolvidas_zoe: dia.resolvidas_ia + dia.resolvidas_cliente,
      resolvidas_equipe: dia.resolvidas_humano,
      abandonadas: dia.abandonadas,
      transferidas: dia.transferidas,
      taxa_zoe: dia.taxa_resolucao_ia,
      primeira_resposta_s: dia.primeira_resposta_s,
      espera_fila_s: dia.espera_fila_s,
      csat_medio: dia.csat_medio,
      avaliacoes: dia.avaliacoes,
      nivel_servico: sla.assumidas ? Number(((sla.no_prazo / sla.assumidas) * 100).toFixed(1)) : null,
      assumidas: sla.assumidas,
      por_hora: porHora,
      hora_atual: local(instante).hora,
    },
    telefone,
    alertas,
  };
}

module.exports = { aoVivo, META_ESPERA_S, META_ASSUMIR_S };
