'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { transacao, lerConfig, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hoje, competencia, somarDias, somarMeses } = require('./datas');
const { copiaECola } = require('./pix');
const v = require('./validacao');

/** Acesso de quem trabalha na plataforma: assiste tudo para conferir sinal e conteúdo, sem assinatura. */
const ACESSO_OPERACAO = {
  ativa: true, operacao: true, nivel: 9, telas: 10, perfis_max: 10, qualidade: '4k', downloads: true, canais_ao_vivo: true,
  plano: { nome: 'Acesso da operação', slug: 'operacao' }, assinatura: null, motivo: null,
};

const planoDe = (db, id) => db.prepare('SELECT * FROM planos WHERE id = ?').get(Number(id));

/** Planos à venda (ou todos, para o painel). */
const listarPlanos = (db, { todos = false } = {}) => db.prepare(`SELECT * FROM planos ${todos ? '' : 'WHERE ativo = 1'} ORDER BY ordem, preco_centavos`).all();

/** Assinatura viva (pendente, ativa ou suspensa) da conta. */
const assinaturaDe = (db, usuarioId) => db.prepare("SELECT * FROM assinaturas WHERE usuario_id = ? AND status <> 'cancelada'").get(Number(usuarioId));

/**
 * O que esta conta pode assistir agora. `ativa` libera o catálogo; `nivel` decide o conteúdo
 * exclusivo de planos superiores; `telas` é o limite de telas simultâneas.
 */
function acessoDe(db, usuario) {
  if (usuario.perfil !== 'assinante') return ACESSO_OPERACAO;
  const a = assinaturaDe(db, usuario.id);
  if (!a) return { ativa: false, motivo: 'sem_assinatura', nivel: 0, telas: 0, perfis_max: 1, qualidade: 'sd', downloads: false, canais_ao_vivo: false, assinatura: null, plano: null };
  const plano = planoDe(db, a.plano_id);
  const vencido = !a.acesso_ate || a.acesso_ate < hoje();
  const ativa = a.status === 'ativa' && !vencido;
  const motivo = ativa ? null : a.status === 'pendente' ? 'aguardando_pagamento' : a.status === 'suspensa' ? 'suspensa' : 'vencida';
  return {
    ativa,
    motivo,
    operacao: false,
    nivel: ativa ? plano.nivel : 0,
    telas: plano.telas,
    perfis_max: plano.perfis_max,
    qualidade: plano.qualidade,
    downloads: Boolean(plano.downloads),
    canais_ao_vivo: Boolean(plano.canais_ao_vivo),
    assinatura: a,
    plano,
  };
}

const MOTIVOS = {
  sem_assinatura: 'Escolha um plano para assistir.',
  aguardando_pagamento: 'Estamos aguardando a confirmação do seu pagamento.',
  suspensa: 'Sua assinatura está suspensa por fatura em aberto. Pague para voltar a assistir.',
  vencida: 'Sua assinatura venceu. Renove para voltar a assistir.',
};

/** Barra o conteúdo de quem não tem assinatura ativa (402: a tela leva para os planos). */
function exigirAcesso(db, usuario) {
  const acesso = acessoDe(db, usuario);
  if (!acesso.ativa) throw new ErroNegocio(MOTIVOS[acesso.motivo] ?? MOTIVOS.sem_assinatura, 402, { motivo: acesso.motivo });
  return acesso;
}

/** PIX copia e cola da fatura (vazio quando a operação ainda não cadastrou a chave). */
function pixDaFatura(db, fatura) {
  const c = lerConfig(db);
  if (!c.pix_chave) return null;
  return copiaECola({
    chave: c.pix_chave,
    recebedor: c.pix_recebedor || config.marca,
    cidade: c.pix_cidade,
    valorCentavos: fatura.valor_centavos,
    txid: fatura.txid,
    descricao: `${config.marca} ${fatura.competencia}`,
  });
}

/** Cria a fatura do ciclo e já guarda o PIX copia e cola. */
function gerarFatura(db, assinatura, plano, { vencimento, descricao }) {
  const comp = competencia(vencimento);
  const existente = db.prepare('SELECT * FROM faturas WHERE assinatura_id = ? AND competencia = ?').get(assinatura.id, comp);
  if (existente) return existente;
  const txid = `TV${String(assinatura.id).padStart(5, '0')}${comp.replace('-', '')}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const r = db.prepare(`INSERT INTO faturas (assinatura_id, usuario_id, competencia, descricao, valor_centavos, vencimento, txid, criada_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(assinatura.id, assinatura.usuario_id, comp, descricao ?? `Plano ${plano.nome} · ${comp}`,
    plano.preco_centavos, vencimento, txid, agora());
  const fatura = db.prepare('SELECT * FROM faturas WHERE id = ?').get(Number(r.lastInsertRowid));
  const pix = pixDaFatura(db, fatura);
  if (pix) {
    db.prepare('UPDATE faturas SET pix_copia_cola = ? WHERE id = ?').run(pix, fatura.id);
    fatura.pix_copia_cola = pix;
  }
  return fatura;
}

/** Contrata um plano: cria a assinatura pendente e a primeira fatura (vence hoje). */
function contratar(db, usuario, planoId) {
  return transacao(db, () => {
    const plano = planoDe(db, planoId);
    if (!plano || !plano.ativo) throw naoEncontrado('Plano');
    const atual = assinaturaDe(db, usuario.id);
    if (atual && atual.status === 'ativa') throw new ErroNegocio('Você já tem uma assinatura ativa. Troque de plano em Minha conta.', 409);
    let assinatura = atual;
    if (assinatura) {
      db.prepare("UPDATE assinaturas SET plano_id = ?, cancelar_no_fim = 0, atualizada_em = ? WHERE id = ?").run(plano.id, agora(), assinatura.id);
      assinatura = db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(assinatura.id);
    } else {
      const r = db.prepare('INSERT INTO assinaturas (usuario_id, plano_id, criada_em, atualizada_em) VALUES (?, ?, ?, ?)')
        .run(usuario.id, plano.id, agora(), agora());
      assinatura = db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(Number(r.lastInsertRowid));
    }
    const fatura = gerarFatura(db, assinatura, plano, { vencimento: hoje(), descricao: `Plano ${plano.nome} · adesão` });
    return { assinatura, plano, fatura };
  });
}

/** Paga a fatura: libera o acesso até o fim do ciclo e agenda a próxima cobrança. */
function confirmarPagamento(db, faturaId, { usuarioId = null, operadorId = null } = {}) {
  return transacao(db, () => {
    const f = db.prepare('SELECT * FROM faturas WHERE id = ?').get(Number(faturaId));
    if (!f) throw naoEncontrado('Fatura');
    if (usuarioId && f.usuario_id !== usuarioId) throw naoEncontrado('Fatura');
    if (f.status === 'paga') return { fatura: f, assinatura: db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(f.assinatura_id) };
    if (f.status === 'cancelada') throw new ErroNegocio('Esta fatura foi cancelada. Gere uma nova cobrança.', 409);
    db.prepare("UPDATE faturas SET status = 'paga', paga_em = ?, confirmada_por = ? WHERE id = ?").run(agora(), operadorId, f.id);
    const a = db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(f.assinatura_id);
    const plano = planoDe(db, a.plano_id);
    const meses = plano.periodicidade === 'anual' ? 12 : 1;
    // Soma o ciclo ao que ainda falta vencer (quem paga adiantado não perde dias).
    const base = a.acesso_ate && a.acesso_ate > hoje() ? a.acesso_ate : hoje();
    const ate = somarMeses(base, meses);
    db.prepare(`UPDATE assinaturas SET status = 'ativa', inicio = COALESCE(inicio, ?), acesso_ate = ?, proxima_cobranca = ?, motivo = NULL, atualizada_em = ?
      WHERE id = ?`).run(hoje(), ate, ate, agora(), a.id);
    return { fatura: db.prepare('SELECT * FROM faturas WHERE id = ?').get(f.id), assinatura: db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(a.id) };
  });
}

/** Troca de plano: vale na próxima cobrança; se a assinatura ainda não foi paga, vale agora (refaz a fatura). */
function trocarPlano(db, usuario, planoId) {
  return transacao(db, () => {
    const plano = planoDe(db, planoId);
    if (!plano || !plano.ativo) throw naoEncontrado('Plano');
    const a = assinaturaDe(db, usuario.id);
    if (!a) throw new ErroNegocio('Você ainda não tem assinatura. Escolha um plano.', 409);
    if (a.plano_id === plano.id) return { assinatura: a, plano, fatura: null, quando: 'sem_mudanca' };
    db.prepare('UPDATE assinaturas SET plano_id = ?, cancelar_no_fim = 0, atualizada_em = ? WHERE id = ?').run(plano.id, agora(), a.id);
    const atualizada = db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(a.id);
    if (a.status === 'ativa') {
      // Telas e qualidade do novo plano valem na hora; a diferença de preço entra na próxima fatura.
      return { assinatura: atualizada, plano, fatura: null, quando: 'proxima_cobranca' };
    }
    const aberta = db.prepare("SELECT * FROM faturas WHERE assinatura_id = ? AND status = 'aberta' ORDER BY id DESC").get(a.id);
    if (aberta) db.prepare("UPDATE faturas SET status = 'cancelada' WHERE id = ?").run(aberta.id);
    const fatura = gerarFatura(db, atualizada, plano, { vencimento: hoje(), descricao: `Plano ${plano.nome} · adesão` });
    return { assinatura: atualizada, plano, fatura, quando: 'agora' };
  });
}

/** Cancelamento: por padrão o acesso vai até o fim do período já pago. */
function cancelar(db, usuario, { motivo = null, imediato = false } = {}) {
  return transacao(db, () => {
    const a = assinaturaDe(db, usuario.id);
    if (!a) throw new ErroNegocio('Não há assinatura para cancelar.', 409);
    const abertas = db.prepare("SELECT id FROM faturas WHERE assinatura_id = ? AND status = 'aberta'").all(a.id);
    const fim = imediato || a.status !== 'ativa' || !a.acesso_ate || a.acesso_ate < hoje();
    if (fim) {
      db.prepare("UPDATE assinaturas SET status = 'cancelada', cancelada_em = ?, motivo = ?, cancelar_no_fim = 0, proxima_cobranca = NULL, atualizada_em = ? WHERE id = ?")
        .run(agora(), v.opcional(motivo, 'o motivo', 300), agora(), a.id);
      for (const f of abertas) db.prepare("UPDATE faturas SET status = 'cancelada' WHERE id = ?").run(f.id);
    } else {
      db.prepare('UPDATE assinaturas SET cancelar_no_fim = 1, motivo = ?, proxima_cobranca = NULL, atualizada_em = ? WHERE id = ?')
        .run(v.opcional(motivo, 'o motivo', 300), agora(), a.id);
      for (const f of abertas) db.prepare("UPDATE faturas SET status = 'cancelada' WHERE id = ?").run(f.id);
    }
    return db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(a.id);
  });
}

/** Desfaz o cancelamento agendado (enquanto o acesso não terminou). */
function reativar(db, usuario) {
  const a = assinaturaDe(db, usuario.id);
  if (!a) throw new ErroNegocio('Não há assinatura para reativar. Escolha um plano.', 409);
  if (!a.cancelar_no_fim) throw new ErroNegocio('Sua assinatura já está ativa.', 409);
  db.prepare('UPDATE assinaturas SET cancelar_no_fim = 0, motivo = NULL, proxima_cobranca = ?, atualizada_em = ? WHERE id = ?').run(a.acesso_ate, agora(), a.id);
  return db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(a.id);
}

/**
 * Rotina de cobrança (roda sozinha de hora em hora):
 * gera a fatura do próximo ciclo, suspende quem passou da carência e encerra o cancelamento agendado.
 */
function rodarCobranca(db) {
  const c = lerConfig(db);
  const hj = hoje();
  const limiteGeracao = somarDias(hj, c.antecedencia_fatura_dias);
  const resultado = { faturas: 0, suspensas: 0, encerradas: 0 };

  transacao(db, () => {
    // 1) Próxima fatura de quem continua assinando.
    const aRenovar = db.prepare(`SELECT * FROM assinaturas WHERE status = 'ativa' AND cancelar_no_fim = 0 AND proxima_cobranca IS NOT NULL AND proxima_cobranca <= ?`).all(limiteGeracao);
    for (const a of aRenovar) {
      const plano = planoDe(db, a.plano_id);
      const antes = db.prepare('SELECT COUNT(*) AS n FROM faturas WHERE assinatura_id = ?').get(a.id).n;
      gerarFatura(db, a, plano, { vencimento: a.proxima_cobranca, descricao: `Plano ${plano.nome} · ${competencia(a.proxima_cobranca)}` });
      if (db.prepare('SELECT COUNT(*) AS n FROM faturas WHERE assinatura_id = ?').get(a.id).n > antes) resultado.faturas += 1;
    }

    // 2) Suspende quem tem fatura vencida além da carência (o acesso para, o cadastro fica).
    const vencidas = db.prepare(`SELECT DISTINCT a.id FROM assinaturas a JOIN faturas f ON f.assinatura_id = a.id
      WHERE a.status = 'ativa' AND f.status = 'aberta' AND f.vencimento < ?`).all(somarDias(hj, -c.carencia_dias));
    for (const { id } of vencidas) {
      db.prepare("UPDATE assinaturas SET status = 'suspensa', atualizada_em = ? WHERE id = ?").run(agora(), id);
      resultado.suspensas += 1;
    }

    // 3) Cancelamento agendado: quando o período pago termina, a assinatura se encerra.
    const aEncerrar = db.prepare(`SELECT id FROM assinaturas WHERE cancelar_no_fim = 1 AND status IN ('ativa','suspensa') AND (acesso_ate IS NULL OR acesso_ate < ?)`).all(hj);
    for (const { id } of aEncerrar) {
      db.prepare("UPDATE assinaturas SET status = 'cancelada', cancelada_em = ?, atualizada_em = ? WHERE id = ?").run(agora(), agora(), id);
      resultado.encerradas += 1;
    }
  });
  return resultado;
}

/** Faturas da conta (as mais novas primeiro). */
const faturasDe = (db, usuarioId, limite = 24) => db.prepare(`SELECT f.*, p.nome AS plano_nome FROM faturas f
  JOIN assinaturas a ON a.id = f.assinatura_id JOIN planos p ON p.id = a.plano_id
  WHERE f.usuario_id = ? ORDER BY f.id DESC LIMIT ?`).all(Number(usuarioId), limite);

/** Resumo da assinatura para as telas (sem expor dados internos). */
function resumo(db, usuario) {
  const acesso = acessoDe(db, usuario);
  const a = acesso.assinatura;
  const aberta = a ? db.prepare("SELECT * FROM faturas WHERE assinatura_id = ? AND status = 'aberta' ORDER BY vencimento LIMIT 1").get(a.id) : null;
  return {
    ativa: acesso.ativa,
    operacao: Boolean(acesso.operacao),
    motivo: acesso.motivo,
    aviso: acesso.ativa ? null : MOTIVOS[acesso.motivo] ?? null,
    plano: acesso.plano ? { id: acesso.plano.id, nome: acesso.plano.nome, slug: acesso.plano.slug, preco_centavos: acesso.plano.preco_centavos,
      telas: acesso.telas, perfis_max: acesso.perfis_max, qualidade: acesso.qualidade, downloads: acesso.downloads, canais_ao_vivo: acesso.canais_ao_vivo } : null,
    status: a?.status ?? null,
    acesso_ate: a?.acesso_ate ?? null,
    proxima_cobranca: a?.proxima_cobranca ?? null,
    cancelar_no_fim: Boolean(a?.cancelar_no_fim),
    fatura_aberta: aberta ? { id: aberta.id, competencia: aberta.competencia, descricao: aberta.descricao, valor_centavos: aberta.valor_centavos,
      vencimento: aberta.vencimento, pix_copia_cola: aberta.pix_copia_cola, txid: aberta.txid } : null,
  };
}

module.exports = {
  ACESSO_OPERACAO, MOTIVOS, listarPlanos, assinaturaDe, acessoDe, exigirAcesso, contratar, confirmarPagamento, trocarPlano,
  cancelar, reativar, rodarCobranca, faturasDe, resumo, gerarFatura, pixDaFatura, planoDe,
};
