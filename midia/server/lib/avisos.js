'use strict';

const { agora, lerConfig } = require('../db');
const { hoje } = require('./datas');
const { estaOnline } = require('./monitor');
const contratos = require('./contratos');
const email = require('./email');

/**
 * Avisos automáticos por e-mail. A ideia é simples: quem opera a rede não deveria descobrir que uma tela
 * caiu porque o síndico ligou reclamando. Rodam de hora em hora e cada assunto é avisado uma vez só
 * (a tabela `avisos` guarda o que já foi dito).
 */
const jaAvisou = (db, chave) => Boolean(db.prepare('SELECT 1 FROM avisos WHERE chave = ?').get(chave));
const marcar = (db, chave) => db.prepare('INSERT OR REPLACE INTO avisos (chave, criado_em) VALUES (?, ?)').run(chave, agora());

/** E-mails de quem opera a plataforma. */
const equipe = (db) => db.prepare("SELECT email FROM usuarios WHERE perfil IN ('master','operador') AND ativo = 1").all().map((u) => u.email);

const ligado = (db) => email.configurado() && Boolean(lerConfig(db).avisos_email);

/** Telas que caíram: um aviso por queda (volta a avisar se cair de novo depois de voltar). */
async function telasForaDoAr(db) {
  const cfg = lerConfig(db);
  const telas = db.prepare(`SELECT t.*, l.nome AS local_nome FROM telas t JOIN locais l ON l.id = t.local_id
    WHERE t.status = 'ativa' AND t.pareada_em IS NOT NULL`).all();
  const caidas = telas.filter((t) => !estaOnline(t, cfg));
  const novas = [];
  for (const t of caidas) {
    // A chave carrega o último contato: uma queda nova (outro horário) vira um aviso novo.
    const chave = `tela-offline:${t.id}:${t.ultimo_contato ?? 'nunca'}`;
    if (jaAvisou(db, chave)) continue;
    marcar(db, chave);
    novas.push(t);
  }
  if (!novas.length) return { enviados: 0 };
  const r = await email.enviar({
    para: equipe(db),
    assunto: novas.length === 1 ? `Tela fora do ar: ${novas[0].local_nome} — ${novas[0].nome}` : `${novas.length} telas fora do ar`,
    plataforma: cfg.nome_plataforma,
    titulo: novas.length === 1 ? 'Uma tela parou de responder' : `${novas.length} telas pararam de responder`,
    linhas: [`Sem contato há mais de ${cfg.offline_minutos} minutos. Vale conferir a energia do aparelho e a internet do ponto.`],
    tabela: novas.map((t) => [`${t.local_nome} — ${t.nome}`, t.ultimo_contato ? `último contato ${new Date(t.ultimo_contato).toLocaleString('pt-BR')}` : 'nunca respondeu']),
    botao: { texto: 'Abrir o painel', url: email.linkPainel('#/telas') },
  });
  return { enviados: r.enviado ? novas.length : 0 };
}

/** Faturas vencidas: uma vez por dia, para o anunciante e um resumo para a equipe. */
async function faturasVencidas(db) {
  const cfg = lerConfig(db);
  const data = hoje();
  const chaveDia = `faturas-vencidas:${data}`;
  if (jaAvisou(db, chaveDia)) return { enviados: 0 };

  const vencidas = db.prepare(`SELECT f.*, a.nome AS anunciante, a.email FROM faturas f JOIN anunciantes a ON a.id = f.anunciante_id
    WHERE f.status = 'aberta' AND f.vencimento < ? ORDER BY f.vencimento`).all(data);
  marcar(db, chaveDia);
  if (!vencidas.length) return { enviados: 0 };

  const reais = (c) => `R$ ${((c ?? 0) / 100).toFixed(2).replace('.', ',')}`;
  let enviados = 0;
  for (const f of vencidas.filter((x) => x.email)) {
    const r = await email.enviar({
      para: f.email,
      assunto: `Fatura ${f.competencia} em aberto`,
      plataforma: cfg.nome_plataforma,
      titulo: 'Sua fatura está em aberto',
      linhas: [`A fatura de ${f.competencia} venceu em ${new Date(`${f.vencimento}T12:00:00`).toLocaleDateString('pt-BR')} e consta como não paga.`,
        'Se o pagamento já foi feito, é só desconsiderar — pode levar um dia para a baixa aparecer.'],
      tabela: [['Competência', f.competencia], ['Vencimento', new Date(`${f.vencimento}T12:00:00`).toLocaleDateString('pt-BR')], ['Valor', reais(f.valor_centavos)]],
      botao: { texto: 'Ver a fatura e o PIX', url: email.linkPainel('#/faturas') },
    });
    if (r.enviado) enviados++;
  }
  const total = vencidas.reduce((t, f) => t + f.valor_centavos, 0);
  await email.enviar({
    para: equipe(db),
    assunto: `${vencidas.length} fatura(s) vencida(s) — ${reais(total)}`,
    plataforma: cfg.nome_plataforma,
    titulo: 'Faturas vencidas',
    linhas: ['Resumo do dia. Os anunciantes com e-mail cadastrado já foram avisados.'],
    tabela: vencidas.map((f) => [`${f.anunciante} — ${f.competencia}`, reais(f.valor_centavos)]),
    botao: { texto: 'Abrir o faturamento', url: email.linkPainel('#/faturamento') },
  });
  return { enviados };
}

/** Fila de aprovação parada há mais de um dia: criativos e comunicados esperando a equipe. */
async function filaDeAprovacao(db) {
  const cfg = lerConfig(db);
  const chaveDia = `fila-parada:${hoje()}`;
  if (jaAvisou(db, chaveDia)) return { enviados: 0 };
  const ontem = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const midias = db.prepare("SELECT COUNT(*) AS n FROM midias WHERE status = 'pendente' AND criado_em < ?").get(ontem).n;
  const comunicados = db.prepare("SELECT COUNT(*) AS n FROM comunicados WHERE status = 'pendente' AND criado_em < ?").get(ontem).n;
  marcar(db, chaveDia);
  if (!midias && !comunicados) return { enviados: 0 };
  const r = await email.enviar({
    para: equipe(db),
    assunto: 'Tem coisa esperando aprovação há mais de um dia',
    plataforma: cfg.nome_plataforma,
    titulo: 'Fila de aprovação parada',
    linhas: ['Nada disso vai ao ar antes de alguém aprovar.'],
    tabela: [...(midias ? [['Criativos de anunciantes', String(midias)]] : []), ...(comunicados ? [['Comunicados de pontos', String(comunicados)]] : [])],
    botao: { texto: 'Abrir o painel', url: email.linkPainel('#/criativos') },
  });
  return { enviados: r.enviado ? 1 : 0 };
}

/**
 * Contratos: o que vence, o que já venceu e o que está na data do reajuste. Uma vez por dia.
 * É o aviso que evita o pior silêncio do negócio — o contrato que acabou e ninguém percebeu.
 */
async function contratosParaCuidar(db) {
  const cfg = lerConfig(db);
  const chaveDia = `contratos:${hoje()}`;
  if (jaAvisou(db, chaveDia)) return { enviados: 0 };
  const p = contratos.pendencias(db);
  marcar(db, chaveDia);
  if (!p.vencendo.length && !p.vencidos.length && !p.reajustar.length) return { enviados: 0 };

  const dia = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR');
  const linhas = [];
  if (p.vencidos.length) linhas.push(`${p.vencidos.length} contrato(s) já passaram da data de término e continuam ativos.`);
  if (p.vencendo.length) linhas.push(`${p.vencendo.length} contrato(s) vencem nos próximos ${p.aviso_dias} dias.`);
  if (p.reajustar.length) linhas.push(`${p.reajustar.length} contrato(s) estão na data do reajuste combinado.`);

  const r = await email.enviar({
    para: equipe(db),
    assunto: `Contratos para cuidar: ${p.vencidos.length + p.vencendo.length} vencendo, ${p.reajustar.length} para reajustar`,
    plataforma: cfg.nome_plataforma,
    titulo: 'Contratos pedindo atenção',
    linhas,
    tabela: [
      ...p.vencidos.map((c) => [`${c.anunciante} — ${c.numero}`, `venceu em ${dia(c.fim)}`]),
      ...p.vencendo.map((c) => [`${c.anunciante} — ${c.numero}`, `vence em ${dia(c.fim)} (${c.dias_para_fim} dia(s))`]),
      ...p.reajustar.map((c) => [`${c.anunciante} — ${c.numero}`, `reajuste desde ${dia(c.reajuste_em)}${c.reajuste ? ` — ${c.reajuste}` : ''}`]),
    ],
    botao: { texto: 'Abrir os contratos', url: email.linkPainel('#/contratos') },
  });
  return { enviados: r.enviado ? 1 : 0 };
}

/** Roda todos os avisos (chamado de hora em hora pelo servidor). */
async function rodar(db) {
  if (!ligado(db)) return { ligado: false, enviados: 0 };
  const partes = await Promise.all([telasForaDoAr(db), faturasVencidas(db), filaDeAprovacao(db), contratosParaCuidar(db)]);
  return { ligado: true, enviados: partes.reduce((t, p) => t + p.enviados, 0) };
}

module.exports = { rodar, telasForaDoAr, faturasVencidas, filaDeAprovacao, contratosParaCuidar, equipe, ligado };
