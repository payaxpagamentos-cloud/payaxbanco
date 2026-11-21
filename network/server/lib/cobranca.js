'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const { dataLocal, diasEntre, somarDias, dataBr } = require('./datas');
const fat = require('./faturamento');

/*
 * Régua de cobrança, bloqueio e desbloqueio.
 *
 * Decisões que valem para todo o módulo:
 * - Quem corta o serviço é sempre uma regra identificada, nunca "o sistema": o bloqueio guarda a regra, a fatura que
 *   o originou e o dia, e aparece no histórico do contrato.
 * - A carência é uma garantia, não uma sugestão: uma regra que mande bloquear antes dela só vale quando a carência
 *   do contrato (ou da organização) terminar.
 * - A régua nunca executa a mesma regra duas vezes na mesma fatura (chave única em regua_eventos). Por isso ela
 *   também não depende de rodar todo dia: quando volta a rodar, pega o que ficou atrás sem repetir o que já fez.
 * - Cancelar contrato nunca é automático. A régua, no máximo, indica o contrato para cancelamento e registra isso.
 * - Avisar não envia nada por conta própria: o aviso fica pronto como 'pendente_envio' e a operação despacha pelo
 *   canal que tiver contratado (e-mail, WhatsApp). O envio fica registrado em quem e quando.
 */

/** Carência efetiva: a do contrato quando definida, senão a da organização. */
const carenciaDe = (contrato, organizacao) => (contrato.carencia_dias === null || contrato.carencia_dias === undefined
  ? organizacao.carencia_bloqueio_dias : contrato.carencia_dias);

/** Bloqueio em vigor do contrato (o que não tem fim). */
const bloqueioAberto = (db, contratoId) => db.prepare('SELECT * FROM bloqueios WHERE contrato_id = ? AND fim IS NULL ORDER BY id DESC').get(contratoId);

/** Desbloqueio de confiança em vigor: concedido, não encerrado e dentro do prazo. */
const confiancaVigente = (db, contratoId, hoje) => db.prepare(`SELECT * FROM confiancas
  WHERE contrato_id = ? AND encerrada_em IS NULL AND ate >= ? ORDER BY id DESC`).get(contratoId, hoje);

/** Registra um passo do ciclo de vida do contrato. */
function registrarEvento(db, contrato, { evento, de = null, para = null, motivo = null, origem = 'usuario', usuarioId = null }) {
  db.prepare(`INSERT INTO contrato_eventos (organizacao_id, contrato_id, evento, de, para, motivo, origem, usuario_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(contrato.organizacao_id, contrato.id, evento, de, para, motivo, origem, usuarioId, agora());
}

/** Troca a situação do contrato e registra o passo com a situação anterior. */
function mudarSituacao(db, contrato, { para, evento, motivo = null, origem = 'usuario', usuarioId = null }) {
  db.prepare('UPDATE contratos SET situacao = ?, versao = versao + 1 WHERE id = ?').run(para, contrato.id);
  registrarEvento(db, contrato, { evento, de: contrato.situacao, para, motivo, origem, usuarioId });
}

/**
 * Bloqueia o serviço do contrato. Recusa contrato cancelado, ainda em implantação ou já bloqueado.
 * Com desbloqueio de confiança em vigor, o bloqueio por inadimplência é recusado até o prazo terminar.
 */
function bloquear(db, { contrato, tipo, motivo, origem = 'usuario', regraId = null, faturaId = null, usuarioId = null, hoje }) {
  if (contrato.situacao === 'cancelado') throw new ErroNegocio('Contrato cancelado: não há serviço para bloquear.', 422);
  if (contrato.situacao === 'em_implantacao') throw new ErroNegocio('Contrato ainda em implantação: ative antes de bloquear.', 422);
  const aberto = bloqueioAberto(db, contrato.id);
  if (aberto) throw new ErroNegocio(`Este contrato já está bloqueado desde ${dataBr(aberto.inicio)} (${aberto.motivo}).`, 409);
  const confianca = confiancaVigente(db, contrato.id, hoje);
  if (confianca && tipo === 'inadimplencia') {
    throw new ErroNegocio(`Desbloqueio de confiança em vigor até ${dataBr(confianca.ate)}: o bloqueio por inadimplência só volta depois dessa data.`, 409);
  }
  const t = agora();
  const id = Number(db.prepare(`INSERT INTO bloqueios (organizacao_id, contrato_id, tipo, motivo, origem, regra_id, fatura_id, inicio, criado_por, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(contrato.organizacao_id, contrato.id, tipo, motivo, origem, regraId, faturaId, t, usuarioId, t).lastInsertRowid);
  mudarSituacao(db, contrato, { para: 'bloqueado', evento: 'bloqueado', motivo, origem, usuarioId });
  return { bloqueio_id: id, inicio: t };
}

/** Libera o serviço: encerra o bloqueio em vigor com o motivo e devolve o contrato para ativo. */
function desbloquear(db, { contrato, motivo, origem = 'usuario', usuarioId = null }) {
  const aberto = bloqueioAberto(db, contrato.id);
  if (!aberto) throw new ErroNegocio('Este contrato não está bloqueado.', 422);
  db.prepare('UPDATE bloqueios SET fim = ?, motivo_liberacao = ?, liberado_por = ? WHERE id = ?').run(agora(), motivo, usuarioId, aberto.id);
  mudarSituacao(db, contrato, { para: 'ativo', evento: 'desbloqueado', motivo, origem, usuarioId });
  return { bloqueio_id: aberto.id };
}

/**
 * Desbloqueio de confiança: devolve o serviço por um prazo mesmo com a fatura em aberto.
 * Exige bloqueio por inadimplência em vigor e respeita o limite por ano do contrato.
 */
function concederConfianca(db, { organizacao, contrato, dias, motivo = null, usuarioId = null, hoje }) {
  if (!organizacao.confianca_dias) throw new ErroNegocio('O desbloqueio de confiança está desligado nos parâmetros da operação.', 422);
  const aberto = bloqueioAberto(db, contrato.id);
  if (!aberto) throw new ErroNegocio('Este contrato não está bloqueado.', 422);
  if (aberto.tipo !== 'inadimplencia') throw new ErroNegocio('A confiança vale para bloqueio por inadimplência; este bloqueio é de outro tipo.', 422);
  const prazo = dias ?? organizacao.confianca_dias;
  if (prazo < 1 || prazo > organizacao.confianca_dias) {
    throw new ErroNegocio(`O prazo da confiança vai de 1 a ${organizacao.confianca_dias} dia(s) nesta operação.`, 422);
  }
  if (organizacao.confianca_max_ano > 0) {
    const usadas = db.prepare("SELECT COUNT(*) AS n FROM confiancas WHERE contrato_id = ? AND inicio >= ?").get(contrato.id, `${hoje.slice(0, 4)}-01-01`).n;
    if (usadas >= organizacao.confianca_max_ano) {
      throw new ErroNegocio(`Este contrato já usou ${usadas} desbloqueio(s) de confiança em ${hoje.slice(0, 4)} (limite de ${organizacao.confianca_max_ano}).`, 409);
    }
  }
  const ate = somarDias(hoje, prazo);
  const id = Number(db.prepare(`INSERT INTO confiancas (organizacao_id, contrato_id, bloqueio_id, inicio, ate, motivo, concedida_por, criada_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(contrato.organizacao_id, contrato.id, aberto.id, hoje, ate, motivo, usuarioId, agora()).lastInsertRowid);
  desbloquear(db, { contrato, motivo: `Desbloqueio de confiança até ${dataBr(ate)}${motivo ? ` · ${motivo}` : ''}`, origem: 'usuario', usuarioId });
  return { confianca_id: id, ate, dias: prazo };
}

/** Há fatura vencida em aberto neste contrato? */
const temVencida = (db, contratoId, hoje) => Boolean(db.prepare(`SELECT 1 FROM faturas
  WHERE contrato_id = ? AND situacao IN ('aberta','parcial') AND vencimento < ? LIMIT 1`).get(contratoId, hoje));

/**
 * Chamado quando uma fatura é quitada: se não resta nenhuma fatura vencida no contrato, encerra a confiança como
 * paga e libera o bloqueio por inadimplência. Bloqueio técnico, a pedido ou administrativo não é liberado por pagamento.
 */
function aoQuitar(db, { contrato, hoje, usuarioId = null }) {
  if (!contrato || temVencida(db, contrato.id, hoje)) return { desbloqueado: false, motivo: 'Ainda há fatura vencida em aberto.' };
  const confianca = db.prepare('SELECT * FROM confiancas WHERE contrato_id = ? AND encerrada_em IS NULL ORDER BY id DESC').get(contrato.id);
  if (confianca) db.prepare("UPDATE confiancas SET encerrada_em = ?, encerramento = 'pago' WHERE id = ?").run(agora(), confianca.id);
  const aberto = bloqueioAberto(db, contrato.id);
  if (!aberto || aberto.tipo !== 'inadimplencia') return { desbloqueado: false, motivo: aberto ? `Bloqueio de outro tipo (${aberto.tipo}) continua.` : 'Contrato não estava bloqueado.' };
  desbloquear(db, { contrato: db.prepare('SELECT * FROM contratos WHERE id = ?').get(contrato.id), motivo: 'Fatura quitada: desbloqueio automático.', origem: 'sistema', usuarioId });
  return { desbloqueado: true };
}

/**
 * Confianças vencidas: se a fatura continua vencida em aberto, encerra como expirada e bloqueia de novo;
 * se o assinante pagou no prazo, encerra como paga.
 */
function expirarConfiancas(db, org, hoje) {
  const vencidas = db.prepare('SELECT * FROM confiancas WHERE organizacao_id = ? AND encerrada_em IS NULL AND ate < ?').all(org, hoje);
  const resultado = { expiradas: 0, bloqueios: 0, quitadas: 0 };
  for (const c of vencidas) {
    const contrato = db.prepare('SELECT * FROM contratos WHERE id = ?').get(c.contrato_id);
    const devendo = temVencida(db, c.contrato_id, hoje);
    db.prepare('UPDATE confiancas SET encerrada_em = ?, encerramento = ? WHERE id = ?').run(agora(), devendo ? 'expirada' : 'pago', c.id);
    if (!devendo) { resultado.quitadas += 1; continue; }
    resultado.expiradas += 1;
    if (contrato.situacao === 'ativo' && !bloqueioAberto(db, contrato.id)) {
      bloquear(db, { contrato, tipo: 'inadimplencia', motivo: `Prazo do desbloqueio de confiança terminou em ${dataBr(c.ate)} com fatura em aberto.`,
        origem: 'sistema', faturaId: null, hoje });
      resultado.bloqueios += 1;
    }
  }
  return resultado;
}

/**
 * Executa a régua para o dia informado.
 *
 * Uma regra alcança a fatura quando o atraso já chegou ao dia dela (`dias_atraso >= regra.dias`), e não só no dia
 * exato — assim um dia sem rodar não deixa o aviso ou o corte para trás. Regra de aviso antes do vencimento
 * (dias negativo) só vale enquanto a fatura não venceu, para não mandar "vence em 3 dias" para quem já está em atraso.
 */
function aplicarRegua(db, org, hoje, { usuarioId = null } = {}) {
  const organizacao = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(org);
  const regras = db.prepare('SELECT * FROM regua_regras WHERE organizacao_id = ? AND ativa = 1 ORDER BY dias, id').all(org);
  const faturas = db.prepare(`SELECT f.*, c.situacao AS contrato_situacao, c.carencia_dias, c.numero AS contrato_numero, a.nome AS assinante_nome
    FROM faturas f JOIN contratos c ON c.id = f.contrato_id JOIN assinantes a ON a.id = f.assinante_id
    WHERE f.organizacao_id = ? AND f.situacao IN ('aberta','parcial') ORDER BY f.vencimento`).all(org);
  const feito = db.prepare('SELECT 1 FROM regua_eventos WHERE regra_id = ? AND fatura_id = ?');
  const gravar = db.prepare(`INSERT INTO regua_eventos (organizacao_id, regra_id, fatura_id, contrato_id, acao, canal, resultado, detalhe, dias_atraso, executado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const resumo = { hoje, avisos: 0, bloqueios: 0, indicacoes: 0, ignoradas: 0, eventos: [] };

  for (const regra of regras) {
    for (const f of faturas) {
      if (feito.get(regra.id, f.id)) continue;
      const atraso = diasEntre(f.vencimento, hoje);
      if (atraso < regra.dias) continue;
      if (regra.dias < 0 && atraso > 0) continue;
      const contrato = db.prepare('SELECT * FROM contratos WHERE id = ?').get(f.contrato_id);
      let resultado = 'executada';
      let detalhe = null;

      if (contrato.situacao === 'cancelado' || contrato.situacao === 'em_implantacao') {
        resultado = 'ignorada';
        detalhe = `Contrato ${contrato.situacao.replace('_', ' ')}.`;
      } else if (regra.acao === 'avisar') {
        resultado = regra.canal === 'sistema' ? 'executada' : 'pendente_envio';
        detalhe = regra.canal === 'sistema' ? 'Aviso registrado na cobrança.' : `Aviso pronto para envio por ${regra.canal}.`;
      } else if (regra.acao === 'bloquear') {
        const carencia = carenciaDe(contrato, organizacao);
        const confianca = confiancaVigente(db, contrato.id, hoje);
        if (atraso < carencia) {
          // A carência segura o corte: a regra volta a tentar quando ela terminar (nada é gravado agora).
          continue;
        } else if (confianca) {
          resultado = 'ignorada';
          detalhe = `Desbloqueio de confiança em vigor até ${dataBr(confianca.ate)}.`;
        } else if (bloqueioAberto(db, contrato.id)) {
          resultado = 'ignorada';
          detalhe = 'Contrato já bloqueado.';
        } else if (contrato.situacao === 'suspenso') {
          resultado = 'ignorada';
          detalhe = 'Contrato suspenso a pedido.';
        } else {
          bloquear(db, { contrato, tipo: 'inadimplencia', origem: 'regua', regraId: regra.id, faturaId: f.id, usuarioId, hoje,
            motivo: `${regra.nome}: fatura ${f.numero} com ${atraso} dia(s) de atraso (carência de ${carencia} dia(s)).` });
          detalhe = `Serviço bloqueado pela fatura ${f.numero}.`;
          resumo.bloqueios += 1;
        }
      } else if (regra.acao === 'indicar_cancelamento') {
        registrarEvento(db, contrato, { evento: 'indicado_para_cancelamento', origem: 'regua', usuarioId,
          motivo: `${regra.nome}: fatura ${f.numero} com ${atraso} dia(s) de atraso. O cancelamento depende de decisão da operação.` });
        detalhe = 'Contrato indicado para cancelamento (nenhum cancelamento foi feito).';
        resumo.indicacoes += 1;
      }

      gravar.run(org, regra.id, f.id, f.contrato_id, regra.acao, regra.canal, resultado, detalhe, atraso, agora());
      if (resultado === 'ignorada') resumo.ignoradas += 1;
      else if (regra.acao === 'avisar') resumo.avisos += 1;
      resumo.eventos.push({ regra: regra.nome, acao: regra.acao, fatura: f.numero, assinante: f.assinante_nome, dias_atraso: atraso, resultado, detalhe });
    }
  }
  return resumo;
}

/** Rotina diária da cobrança: expira confianças e aplica a régua, registrando a execução. */
function rotinaDiaria(db, org, hoje) {
  const inicio = Date.now();
  const em = agora();
  return transacao(db, () => {
    const confiancas = expirarConfiancas(db, org, hoje);
    const regua = aplicarRegua(db, org, hoje);
    const itens = confiancas.expiradas + confiancas.quitadas + regua.eventos.length;
    db.prepare(`INSERT INTO sincronizacoes (organizacao_id, tipo, iniciado_em, terminado_em, resultado, itens, duracao_ms)
      VALUES (?, 'cobranca', ?, ?, ?, ?, ?)`).run(org, em, agora(),
      `Régua: ${regua.avisos} aviso(s), ${regua.bloqueios} bloqueio(s), ${regua.indicacoes} indicação(ões). Confiança: ${confiancas.expiradas} expirada(s), ${confiancas.bloqueios} bloqueio(s).`,
      itens, Date.now() - inicio);
    return { hoje, confiancas, regua };
  });
}

/** A rotina de hoje já rodou nesta organização? (data no fuso da operação) */
function rotinaPendente(db, org, fuso) {
  const hoje = dataLocal(fuso);
  const ultima = db.prepare("SELECT iniciado_em FROM sincronizacoes WHERE organizacao_id = ? AND tipo = 'cobranca' ORDER BY id DESC LIMIT 1").get(org);
  return !ultima || dataLocal(fuso, ultima.iniciado_em) < hoje ? hoje : null;
}

/**
 * Inadimplência por faixa de atraso (aging) e os devedores. O saldo é o que falta de cada fatura;
 * o total devido já inclui multa e juros no dia consultado.
 */
function inadimplencia(db, org, hoje) {
  const organizacao = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(org);
  const abertas = db.prepare(`SELECT f.*, a.id AS assinante, a.nome AS assinante_nome, a.codigo AS assinante_codigo, a.telefone, c.numero AS contrato_numero, c.situacao AS contrato_situacao
    FROM faturas f JOIN assinantes a ON a.id = f.assinante_id LEFT JOIN contratos c ON c.id = f.contrato_id
    WHERE f.organizacao_id = ? AND f.situacao IN ('aberta','parcial') AND f.vencimento < ? ORDER BY f.vencimento`).all(org, hoje);
  const faixas = { '1-30': { faturas: 0, saldo_centavos: 0 }, '31-60': { faturas: 0, saldo_centavos: 0 }, '61-90': { faturas: 0, saldo_centavos: 0 }, '90+': { faturas: 0, saldo_centavos: 0 } };
  const porAssinante = new Map();
  let saldoTotal = 0;
  let devidoTotal = 0;
  for (const f of abertas) {
    const e = fat.encargos(f, organizacao, hoje);
    const faixa = e.dias_atraso <= 30 ? '1-30' : e.dias_atraso <= 60 ? '31-60' : e.dias_atraso <= 90 ? '61-90' : '90+';
    faixas[faixa].faturas += 1;
    faixas[faixa].saldo_centavos += e.saldo_centavos;
    saldoTotal += e.saldo_centavos;
    devidoTotal += e.total_devido_centavos;
    const atual = porAssinante.get(f.assinante) ?? { assinante_id: f.assinante, codigo: f.assinante_codigo, nome: f.assinante_nome, telefone: f.telefone,
      faturas: 0, saldo_centavos: 0, devido_centavos: 0, atraso_dias: 0, bloqueado: false };
    atual.faturas += 1;
    atual.saldo_centavos += e.saldo_centavos;
    atual.devido_centavos += e.total_devido_centavos;
    atual.atraso_dias = Math.max(atual.atraso_dias, e.dias_atraso);
    atual.bloqueado = atual.bloqueado || f.contrato_situacao === 'bloqueado';
    porAssinante.set(f.assinante, atual);
  }
  // Taxa de inadimplência: o que está vencido sobre o que foi faturado nos últimos 12 meses.
  const faturado = db.prepare(`SELECT COALESCE(SUM(valor_centavos), 0) AS v FROM faturas
    WHERE organizacao_id = ? AND situacao <> 'cancelada' AND vencimento >= ?`).get(org, somarDias(hoje, -365)).v;
  return { hoje, faturas: abertas.length, saldo_centavos: saldoTotal, devido_centavos: devidoTotal, faixas,
    taxa_pct: faturado ? Math.round((saldoTotal / faturado) * 10_000) / 100 : null,
    devedores: [...porAssinante.values()].sort((a, b) => b.devido_centavos - a.devido_centavos) };
}

module.exports = { carenciaDe, bloqueioAberto, confiancaVigente, registrarEvento, mudarSituacao, bloquear, desbloquear, concederConfianca,
  temVencida, aoQuitar, expirarConfiancas, aplicarRegua, rotinaDiaria, rotinaPendente, inadimplencia };
