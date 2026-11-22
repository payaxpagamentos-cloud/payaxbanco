'use strict';

const { agora, lerConfig } = require('../db');
const { hoje, local, somarDias, minutosDe } = require('./datas');

let ultimoExpurgo = 0;

/** A TV está online? Depende do último contato e do intervalo de batida configurado. */
const estaOnline = (tela, cfg, ref = Date.now()) =>
  Boolean(tela.ultimo_contato) && ref - Date.parse(tela.ultimo_contato) < cfg.offline_minutos * 60_000;

/** O ponto está aberto agora (pelo horário cadastrado)? Sem horário cadastrado, conta como aberto. */
function pontoAberto(db, localId, instante = new Date()) {
  const l = local(instante);
  const h = db.prepare('SELECT abre, fecha FROM local_horarios WHERE local_id = ? AND dia_semana = ?').get(localId, l.diaSemana);
  if (!db.prepare('SELECT 1 FROM local_horarios WHERE local_id = ? LIMIT 1').get(localId)) return true;
  if (!h) return false;
  const m = minutosDe(l.hhmm);
  return minutosDe(h.abre) <= minutosDe(h.fecha)
    ? m >= minutosDe(h.abre) && m < minutosDe(h.fecha)
    : m >= minutosDe(h.abre) || m < minutosDe(h.fecha);
}

/**
 * Rotina de minuto a minuto: anota as TVs que caíram, encerra campanhas com período vencido,
 * ativa as que começaram, limpa códigos de pareamento vencidos e apaga avisos expirados.
 */
function manutencao(db) {
  const cfg = lerConfig(db);
  const data = hoje();
  const corte = new Date(Date.now() - cfg.offline_minutos * 60_000).toISOString();

  // Caiu: estava respondendo e parou. Registra o evento uma única vez (o último evento da tela não é 'offline').
  const caidas = db.prepare(`SELECT t.id, t.nome, t.ultimo_contato FROM telas t
    WHERE t.status = 'ativa' AND t.pareada_em IS NOT NULL AND (t.ultimo_contato IS NULL OR t.ultimo_contato < ?)
      AND COALESCE((SELECT e.tipo FROM telas_eventos e WHERE e.tela_id = t.id ORDER BY e.id DESC LIMIT 1), '') <> 'offline'`).all(corte);
  for (const t of caidas) {
    db.prepare("INSERT INTO telas_eventos (tela_id, tipo, detalhe, criado_em) VALUES (?, 'offline', ?, ?)")
      .run(t.id, t.ultimo_contato ? `Último contato em ${t.ultimo_contato}` : 'Nunca contatou depois do pareamento', agora());
  }

  const encerradas = db.prepare("UPDATE campanhas SET status = 'encerrada' WHERE status IN ('ativa','pausada') AND fim IS NOT NULL AND fim < ?").run(data).changes;
  const iniciadas = db.prepare("UPDATE campanhas SET status = 'ativa' WHERE status = 'aguardando' AND aprovada_em IS NOT NULL AND inicio <= ? AND (fim IS NULL OR fim >= ?)")
    .run(data, data).changes;
  const codigos = db.prepare('DELETE FROM pareamentos WHERE expira_em < ? AND (tela_id IS NULL OR entregue_em IS NOT NULL)').run(agora()).changes;
  const avisos = db.prepare('UPDATE telas SET aviso = NULL, aviso_ate = NULL WHERE aviso IS NOT NULL AND aviso_ate IS NOT NULL AND aviso_ate < ?').run(agora()).changes;

  // Expurgo da prova de exibição detalhada (o resumo por dia fica). Roda no máximo uma vez por hora.
  let expurgadas = 0;
  if (cfg.prova_dias > 0 && Date.now() - ultimoExpurgo > 3_600_000) {
    ultimoExpurgo = Date.now();
    expurgadas = db.prepare('DELETE FROM exibicoes WHERE data < ?').run(somarDias(data, -cfg.prova_dias)).changes;
  }

  return { offline: caidas, encerradas, iniciadas, codigos, avisos, expurgadas };
}

/** Verificações para a tela de Diagnóstico do painel. */
function diagnostico(db, { empresaId = null } = {}) {
  const cfg = lerConfig(db);
  const data = hoje();
  const um = (sql, ...p) => db.prepare(sql).get(...p);
  const todos = (sql, ...p) => db.prepare(sql).all(...p);
  // Empresa: cada uma vê os problemas dela; o que é do servidor (backup, e-mail) só o master vê.
  const E = empresaId;
  const ep = E == null ? [] : [E];
  const locE = (col = 'l.empresa_id') => (E == null ? '' : ` AND ${col} = ?`);
  const anunE = (col = 'anunciante_id') => (E == null ? '' : ` AND ${col} IN (SELECT id FROM anunciantes WHERE empresa_id = ?)`);

  const telas = todos(`SELECT t.*, l.nome AS local_nome FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.status = 'ativa'${locE()}`, ...ep);
  const offline = telas.filter((t) => t.pareada_em && !estaOnline(t, cfg));
  const semParear = telas.filter((t) => !t.pareada_em);
  const semGrade = telas.filter((t) => t.pareada_em && !t.grade_versao);

  const verificacoes = [
    { nome: 'Banco de dados', ok: Boolean(um('SELECT 1 AS x')?.x), detalhe: 'Leitura e escrita respondendo.' },
    { nome: 'TVs offline', ok: !offline.length, detalhe: offline.length ? `${offline.length} sem contato há mais de ${cfg.offline_minutos} min: ${offline.slice(0, 6).map((t) => `${t.nome} (${t.local_nome})`).join(', ')}` : 'Todas as TVs pareadas estão respondendo.' },
    { nome: 'TVs instaladas e não pareadas', ok: !semParear.length, detalhe: semParear.length ? `${semParear.length} aguardando o código de pareamento: ${semParear.slice(0, 6).map((t) => t.nome).join(', ')}` : 'Nenhuma pendente.' },
    { nome: 'TVs sem programação', ok: !semGrade.length, detalhe: semGrade.length ? `${semGrade.length} pareadas ainda sem baixar a grade.` : 'Todas com programação baixada.' },
  ];

  const desatualizadas = telas.filter((t) => t.pareada_em && t.versao_player && t.versao_player !== require('../config').playerVersao);
  verificacoes.push({
    nome: 'Telas com player antigo',
    ok: !desatualizadas.length,
    detalhe: desatualizadas.length
      ? `${desatualizadas.length} rodando versão anterior: ${desatualizadas.slice(0, 6).map((t) => `${t.nome} (${t.versao_player})`).join(', ')}. `
        + 'Mande recarregar pelo painel, em TVs.'
      : `Todas na versão publicada (${require('../config').playerVersao}).`,
  });

  const semMidia = todos(`SELECT c.id, c.nome FROM campanhas c WHERE c.status IN ('ativa','aguardando')
    AND NOT EXISTS (SELECT 1 FROM campanha_midias cm JOIN midias m ON m.id = cm.midia_id WHERE cm.campanha_id = c.id AND m.status = 'aprovada')${anunE('c.anunciante_id')}`, ...ep);
  verificacoes.push({ nome: 'Campanhas sem criativo aprovado', ok: !semMidia.length, detalhe: semMidia.length ? `${semMidia.length}: ${semMidia.slice(0, 6).map((c) => c.nome).join(', ')}` : 'Toda campanha no ar tem criativo aprovado.' });

  const pendentes = um(`SELECT COUNT(*) AS n FROM midias WHERE status = 'pendente'${locE('empresa_id')}`, ...ep).n;
  verificacoes.push({ nome: 'Mídias aguardando aprovação', ok: !pendentes, detalhe: pendentes ? `${pendentes} esperando revisão da equipe.` : 'Nada na fila.' });

  const vencendo = todos(`SELECT nome, validade_ate FROM midias WHERE status = 'aprovada' AND validade_ate IS NOT NULL AND validade_ate BETWEEN ? AND ?${locE('empresa_id')}`, data, somarDias(data, 7), ...ep);
  verificacoes.push({ nome: 'Criativos vencendo em 7 dias', ok: !vencendo.length, detalhe: vencendo.length ? vencendo.slice(0, 6).map((m) => `${m.nome} (até ${m.validade_ate})`).join(', ') : 'Nenhum.' });

  const acabando = todos(`SELECT nome, fim FROM campanhas WHERE status = 'ativa' AND fim IS NOT NULL AND fim BETWEEN ? AND ?${anunE()}`, data, somarDias(data, 7), ...ep);
  verificacoes.push({ nome: 'Campanhas terminando em 7 dias', ok: !acabando.length, detalhe: acabando.length ? acabando.slice(0, 6).map((c) => `${c.nome} (até ${c.fim})`).join(', ') : 'Nenhuma.' });

  const semTela = todos(`SELECT nome FROM locais WHERE status = 'ativo' AND NOT EXISTS (SELECT 1 FROM telas t WHERE t.local_id = locais.id AND t.status <> 'inativa')${locE('empresa_id')}`, ...ep);
  verificacoes.push({ nome: 'Pontos sem TV ativa', ok: !semTela.length, detalhe: semTela.length ? semTela.slice(0, 6).map((l) => l.nome).join(', ') : 'Todos os pontos ativos têm TV.' });

  // Contrato que acaba sem ninguém ver é receita que cai sozinha; reajuste esquecido é desconto que o cliente nem pediu.
  const ciclo = require('./contratos').pendencias(db, null, E ?? null);
  verificacoes.push({
    nome: 'Contratos vencendo',
    ok: !ciclo.vencendo.length && !ciclo.vencidos.length,
    detalhe: ciclo.vencendo.length || ciclo.vencidos.length
      ? [...ciclo.vencidos.map((c) => `${c.numero} (${c.anunciante}) venceu em ${c.fim}`),
        ...ciclo.vencendo.map((c) => `${c.numero} (${c.anunciante}) vence em ${c.fim}`)].slice(0, 6).join(', ')
      : `Nenhum contrato ativo termina nos próximos ${ciclo.aviso_dias} dias.`,
  });
  verificacoes.push({
    nome: 'Reajustes na data',
    ok: !ciclo.reajustar.length,
    detalhe: ciclo.reajustar.length
      ? `${ciclo.reajustar.length} contrato(s) chegaram na data do reajuste: ${ciclo.reajustar.slice(0, 6).map((c) => `${c.numero} (${c.anunciante})`).join(', ')}. `
        + 'O sistema aplica sozinho os que têm percentual fixo; os demais esperam a equipe informar quanto.'
      : 'Nenhum reajuste pendente.',
  });

  const faturas = um(`SELECT COUNT(*) AS n, COALESCE(SUM(valor_centavos), 0) AS v FROM faturas WHERE status = 'aberta' AND vencimento < ?${anunE()}`, data, ...ep);
  verificacoes.push({ nome: 'Faturas vencidas', ok: !faturas.n, detalhe: faturas.n ? `${faturas.n} em atraso, somando R$ ${(faturas.v / 100).toFixed(2)}.` : 'Nenhuma fatura vencida.' });

  // Daqui para baixo é o servidor e a configuração da rede: assunto do master.
  if (E != null) {
    return { verificacoes, telas: { total: telas.length, online: telas.filter((t) => estaOnline(t, cfg)).length, offline: offline.length, sem_parear: semParear.length } };
  }

  const b = require('./backup').situacao();
  verificacoes.push({
    nome: 'Backup do banco',
    ok: !b.atrasado,
    detalhe: b.ultima
      ? `Última cópia em ${new Date(b.ultima.criado_em).toLocaleString('pt-BR')} (${b.copias} guardadas, a cada ${b.intervalo_horas} h).`
      : 'Nenhuma cópia ainda. O backup roda sozinho depois que o servidor fica algumas horas no ar.',
  });
  verificacoes.push({
    nome: 'Espelho dos arquivos das mídias',
    ok: Boolean(b.espelho),
    detalhe: b.espelho
      ? `Os vídeos e imagens são copiados para ${b.espelho}.`
      : 'Desligado: o backup guarda só o banco. Configure MIDIA_ESPELHO (outro disco ou volume) para os arquivos '
        + 'das campanhas também terem cópia — sem isso, perder o disco perde as peças.',
  });

  const email = require('./email');
  const avisosLigados = lerConfig(db).avisos_email;
  verificacoes.push({
    nome: 'Avisos por e-mail',
    ok: email.configurado() && Boolean(avisosLigados),
    detalhe: !email.configurado()
      ? 'SMTP não configurado (MIDIA_SMTP_HOST): ninguém é avisado quando uma tela cai ou uma fatura vence.'
      : (avisosLigados ? 'Ligados: tela fora do ar, fatura vencida e fila de aprovação parada.' : 'SMTP configurado, mas os avisos estão desligados nas Configurações.'),
  });

  // Caixa de entrada do CRM: o servidor de e-mail da casa e a fila de quem está esperando resposta.
  const caixa = require('./caixa').estado();
  const esperando = um(`SELECT COUNT(*) AS n FROM emails e WHERE e.direcao = 'entrada' AND e.arquivado_em IS NULL
    AND NOT EXISTS (SELECT 1 FROM emails r WHERE r.direcao = 'saida' AND r.thread = e.thread AND r.recebido_em > e.recebido_em)`).n;
  verificacoes.push({
    nome: 'Servidor de e-mail (caixa do CRM)',
    ok: caixa.configurado ? caixa.ouvindo : true,
    detalhe: !caixa.configurado
      ? 'Desligado (MIDIA_EMAIL_DOMINIOS vazio): o CRM só guarda o que sai daqui. Veja o README para ligar o recebimento.'
      : (caixa.ouvindo
        ? `Recebendo para ${caixa.dominios.join(', ')} na porta ${caixa.porta}.`
        : `Configurado para ${caixa.dominios.join(', ')}, mas não subiu${caixa.erro ? `: ${caixa.erro}` : ''}.`),
  });
  verificacoes.push({
    nome: 'E-mails esperando resposta',
    ok: esperando < 5,
    detalhe: esperando ? `${esperando} mensagem(ns) sem retorno na caixa do CRM.` : 'Ninguém esperando.',
  });

  const semPix = !lerConfig(db).pix_chave;
  verificacoes.push({ nome: 'PIX das faturas', ok: !semPix, detalhe: semPix ? 'Chave PIX não configurada: as faturas saem sem o código de pagamento.' : 'Chave configurada.' });

  return { verificacoes, telas: { total: telas.length, online: telas.filter((t) => estaOnline(t, cfg)).length, offline: offline.length, sem_parear: semParear.length } };
}

/** Tempo no ar da TV nos últimos dias, a partir das batidas (uma por minuto, no máximo). */
function uptime(db, telaId, dias = 7) {
  const cfg = lerConfig(db);
  const de = somarDias(hoje(), -dias + 1);
  const batidas = db.prepare("SELECT data, COUNT(*) AS n FROM exibicoes WHERE tela_id = ? AND data >= ? GROUP BY data").all(telaId, de);
  const eventos = db.prepare('SELECT tipo, detalhe, criado_em FROM telas_eventos WHERE tela_id = ? AND criado_em >= ? ORDER BY id DESC LIMIT 50')
    .all(telaId, `${de}T00:00:00.000Z`);
  const tela = db.prepare('SELECT * FROM telas WHERE id = ?').get(telaId);
  return { online: tela ? estaOnline(tela, cfg) : false, dias: batidas, eventos };
}

module.exports = { estaOnline, pontoAberto, manutencao, diagnostico, uptime };
