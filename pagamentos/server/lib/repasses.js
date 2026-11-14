'use strict';

/*
 * Repasse: o dinheiro do cliente indo para a conta dele por PIX, assim que cai na conta da PAY AX.
 *
 * A PAY AX não guarda dinheiro de cliente. Quando o banco credita um pagamento na nossa conta, a
 * tarifa sai e o resto segue para o cliente na rodada de repasse seguinte:
 *   - pago por PIX (Bolepix): o crédito é na hora, e o repasse sai logo depois da baixa;
 *   - pago pelo código de barras: no dia em que o banco credita (data de crédito do retorno, ou o
 *     prazo de compensação do contrato, PAYAX_DIAS_CREDITO_BOLETO).
 * A rodada acontece a cada ciclo da rotina (15 minutos), todos os dias: PIX não fecha no fim de semana.
 *
 * Não existe saque, valor mínimo nem fila de aprovação — tudo isso deixaria dinheiro parado.
 * Cliente sem chave PIX não emite boleto: o dinheiro não teria para onde ir.
 *
 * Um repasse sempre leva TUDO o que está liberado:
 *     liberado (créditos − tarifas) − tarifa do repasse = valor do PIX
 * Se o PIX falhar, entra um estorno (nada é apagado) e a rodada seguinte tenta de novo; a falha
 * aparece no painel e na tela de Conformidade.
 */
const config = require('../config');
const { transacao, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const datas = require('./datas');
const razao = require('./razao');
const precos = require('./precos');
const { criarBanco } = require('./bradesco');
const { contaDe, credenciaisDaConta } = require('./boletos');
const contaDestino = require('./contaDestino');

const hoje = () => datas.dataLocal(config.fusoPadrao);
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Onde está o dinheiro do cliente agora:
 *   a_liberar_centavos  — pago, mas o banco ainda não creditou na nossa conta (compensação);
 *   disponivel_centavos — creditado, esperando a rodada de repasse (minutos);
 *   em_transito_centavos — PIX já enviado, esperando a confirmação do banco.
 */
function disponivel(db, cliente, data = hoje()) {
  const s = razao.saldo(db, cliente.id, data);
  const preco = precos.vigente(db, cliente.id, data);
  const taxa = preco.tarifa_repasse_centavos ?? 0;
  const pendente = db.prepare("SELECT IFNULL(SUM(valor_liquido_centavos), 0) AS v FROM repasses WHERE cliente_id = ? AND situacao IN ('aguardando_aprovacao','aprovado','enviado')").get(cliente.id).v;
  return {
    ...s,
    taxa_repasse_centavos: taxa,
    em_transito_centavos: pendente,
  };
}

/** Resumo para o cliente: o que está a caminho e o que já foi para a conta dele. */
function resumoCliente(db, cliente, data = hoje()) {
  const d = disponivel(db, cliente, data);
  // PIX confirmados + o que o banco creditou direto na conta do cliente (rateio de crédito).
  const soma = (de) => db.prepare(`SELECT IFNULL(SUM(valor_liquido_centavos), 0) AS v FROM repasses
    WHERE cliente_id = ? AND situacao = 'confirmado' AND substr(confirmado_em, 1, 10) >= ?`).get(cliente.id, de).v
    + db.prepare(`SELECT IFNULL(-SUM(valor_centavos), 0) AS v FROM lancamentos
      WHERE cliente_id = ? AND tipo = 'repasse' AND repasse_id IS NULL AND data_liberacao BETWEEN ? AND ?`).get(cliente.id, de, data).v;
  return {
    a_compensar_centavos: d.a_liberar_centavos,
    a_caminho_centavos: Math.max(0, d.disponivel_centavos) + d.em_transito_centavos,
    transferido_hoje_centavos: soma(data),
    transferido_mes_centavos: soma(datas.primeiroDiaMes(data)),
    taxa_repasse_centavos: d.taxa_repasse_centavos,
    chave_pix: contaDestino.descrever(cliente),
    destino: contaDestino.descrever(cliente),
    meio_entrega: contaDestino.meioAtual(db, cliente),
  };
}

/**
 * Para onde vai o PIX: a conta de destino cadastrada (pelos dados da conta, sem chave) ou, em
 * cadastros antigos, a chave PIX.
 */
function destinoDe(cliente) {
  if (contaDestino.temConta(cliente)) {
    return {
      pix_tipo: 'conta', pix_chave: null,
      banco: cliente.destino_banco, ispb: cliente.destino_ispb,
      agencia: cliente.destino_agencia, conta: `${cliente.destino_conta}${cliente.destino_conta_dv ? `-${cliente.destino_conta_dv}` : ''}`,
      tipo_conta: cliente.destino_tipo ?? 'corrente',
      titular_nome: cliente.destino_titular ?? cliente.razao_social,
      titular_documento: cliente.destino_documento ?? cliente.cnpj,
      descricao: contaDestino.descrever(cliente),
    };
  }
  if (!cliente.pix_chave) throw new ErroNegocio('O cliente não tem conta de destino nem chave PIX cadastrada.', 409);
  return {
    pix_tipo: cliente.pix_tipo, pix_chave: cliente.pix_chave,
    titular_nome: cliente.pix_titular ?? cliente.razao_social,
    titular_documento: cliente.pix_documento ?? cliente.cnpj,
    descricao: `chave ${cliente.pix_chave}`,
  };
}

/** Cria o repasse de TUDO o que está liberado, já aprovado. Devolve null se não há o que repassar. */
function criar(db, cliente, { usuario = null } = {}) {
  return transacao(db, () => {
    const data = hoje();
    const d = disponivel(db, cliente, data);
    const valor = d.disponivel_centavos;
    const taxa = d.taxa_repasse_centavos;
    const liquido = valor - taxa;
    if (liquido <= 0) return null;
    const destino = destinoDe(cliente);

    const r = db.prepare(`INSERT INTO repasses (cliente_id, valor_centavos, taxa_centavos, valor_liquido_centavos, meio,
        pix_tipo, pix_chave, titular_nome, titular_documento, destino_banco, destino_agencia, destino_conta,
        situacao, automatico, solicitado_por, aprovado_por, aprovado_em, criado_em)
      VALUES (?, ?, ?, ?, 'pix', ?, ?, ?, ?, ?, ?, ?, 'aprovado', 1, ?, ?, ?, ?) RETURNING *`)
      .get(cliente.id, valor, taxa, liquido, destino.pix_tipo, destino.pix_chave, destino.titular_nome, destino.titular_documento,
        destino.banco ?? null, destino.agencia ?? null, destino.conta ?? null,
        usuario?.id ?? null, usuario?.id ?? null, agora(), agora());

    razao.lancar(db, { cliente_id: cliente.id, repasse_id: r.id, tipo: 'repasse', valor_centavos: -liquido,
      descricao: `Repasse PIX #${r.id} · ${destino.descricao}`, data_competencia: data, data_liberacao: data, criado_por: usuario?.id ?? null });
    if (taxa) {
      razao.lancar(db, { cliente_id: cliente.id, repasse_id: r.id, tipo: 'taxa_repasse', valor_centavos: -taxa,
        descricao: `Tarifa do repasse #${r.id}`, data_competencia: data, data_liberacao: data, criado_por: usuario?.id ?? null });
    }
    return r;
  });
}

/** Repassa agora tudo o que está liberado para um cliente. Devolve o repasse (ou null). */
async function repassar(db, cliente, { usuario = null } = {}) {
  if (cliente.bloqueio_repasse) throw new ErroNegocio('Os repasses deste cliente estão suspensos por ordem legal (tela PLD).', 409);
  const r = criar(db, cliente, { usuario });
  if (!r) return null;
  return enviar(db, r.id, { usuario });
}

/** Atalho para quem acabou de dar baixa num título: repassa o cliente dele, se já houver crédito. */
async function repassarCliente(db, clienteId) {
  const c = db.prepare(`SELECT * FROM clientes WHERE id = ? AND situacao <> 'encerrado' AND bloqueio_repasse IS NULL
    AND (pix_chave IS NOT NULL OR destino_conta IS NOT NULL)`).get(clienteId);
  if (!c) return null;
  return repassar(db, c);
}

function aprovar(db, id, usuario) {
  const r = db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
  if (!r) throw naoEncontrado('Repasse');
  if (r.situacao !== 'aguardando_aprovacao') throw new ErroNegocio(`Repasse já está como ${r.situacao}.`, 409);
  db.prepare("UPDATE repasses SET situacao = 'aprovado', aprovado_por = ?, aprovado_em = ?, versao = versao + 1 WHERE id = ?")
    .run(usuario.id, agora(), id);
  return db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
}

/** Devolve o valor ao registro do cliente (falha no PIX ou cancelamento); a próxima rodada tenta de novo. */
function devolverAoSaldo(db, r, motivo, usuario = null) {
  const data = hoje();
  razao.lancar(db, { cliente_id: r.cliente_id, repasse_id: r.id, tipo: 'estorno', valor_centavos: r.valor_liquido_centavos,
    descricao: `Estorno do repasse #${r.id} · ${motivo}`, data_competencia: data, data_liberacao: data, criado_por: usuario?.id ?? null });
  if (r.taxa_centavos) {
    razao.lancar(db, { cliente_id: r.cliente_id, repasse_id: r.id, tipo: 'estorno', valor_centavos: r.taxa_centavos,
      descricao: `Estorno da tarifa do repasse #${r.id}`, data_competencia: data, data_liberacao: data, criado_por: usuario?.id ?? null });
  }
}

function cancelar(db, id, motivo, usuario) {
  return transacao(db, () => {
    const r = db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
    if (!r) throw naoEncontrado('Repasse');
    if (!['aguardando_aprovacao', 'aprovado', 'falhou'].includes(r.situacao)) {
      throw new ErroNegocio(`Repasse ${r.situacao} não pode ser cancelado.`, 409);
    }
    if (r.situacao !== 'falhou') devolverAoSaldo(db, r, motivo ?? 'cancelado pela equipe', usuario);
    db.prepare("UPDATE repasses SET situacao = 'cancelado', erro = ?, versao = versao + 1 WHERE id = ?").run(motivo ?? null, id);
    return db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
  });
}

/** Envia o PIX pelo banco. Falha devolve o valor ao saldo e deixa o motivo registrado. */
async function enviar(db, id, { usuario = null } = {}) {
  const r = db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
  if (!r) throw naoEncontrado('Repasse');
  if (r.situacao === 'confirmado' || r.situacao === 'enviado') return r;
  if (r.situacao !== 'aprovado') throw new ErroNegocio('O repasse precisa estar aprovado para ser enviado.', 409);

  const conta = contaDe(db);
  db.prepare("UPDATE repasses SET situacao = 'enviado', enviado_em = ?, versao = versao + 1 WHERE id = ?").run(agora(), id);
  try {
    const banco = criarBanco(conta, credenciaisDaConta(db, conta.id));
    const resp = await banco.pagarPix({
      chave: r.pix_chave,
      tipo_chave: r.pix_tipo,
      // PIX pelos dados da conta, quando não há chave: banco (ISPB), agência, conta e tipo.
      conta: r.destino_conta ? {
        banco: r.destino_banco, ispb: contaDestino.BANCOS[r.destino_banco]?.ispb ?? null, agencia: r.destino_agencia,
        conta: r.destino_conta, titular: r.titular_nome, documento: r.titular_documento,
      } : null,
      valor_centavos: r.valor_liquido_centavos,
      descricao: `PAY AX repasse ${r.id}`,
      documento_titular: r.titular_documento,
    });
    db.prepare(`UPDATE repasses SET situacao = ?, end_to_end = ?, confirmado_em = ?, versao = versao + 1 WHERE id = ?`)
      .run(resp.situacao === 'confirmado' ? 'confirmado' : 'enviado', resp.end_to_end ?? null,
        resp.situacao === 'confirmado' ? agora() : null, id);
  } catch (err) {
    transacao(db, () => {
      devolverAoSaldo(db, r, `falha no envio: ${err.message}`, usuario);
      db.prepare("UPDATE repasses SET situacao = 'falhou', erro = ?, versao = versao + 1 WHERE id = ?").run(String(err.message).slice(0, 300), id);
    });
    throw new ErroNegocio(`Não foi possível enviar o repasse: ${err.message}`, 502);
  }
  return db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
}

/**
 * Rodada de repasse: todo cliente com dinheiro liberado recebe agora. Roda a cada ciclo da rotina.
 * Repasse que falhou (PIX recusado) foi estornado e entra de novo aqui.
 */
async function rotinaAutomatica(db, { usuario = null } = {}) {
  const data = hoje();
  // Cliente com repasse suspenso por ordem legal fica de fora (a única exceção ao repasse imediato).
  const clientes = db.prepare(`SELECT * FROM clientes WHERE situacao <> 'encerrado' AND bloqueio_repasse IS NULL
    AND (pix_chave IS NOT NULL OR destino_conta IS NOT NULL)`).all();
  const resultado = { data, criados: 0, enviados: 0, falhas: 0, detalhes: [] };
  for (const c of clientes) {
    let r;
    try {
      r = criar(db, c, { usuario });
    } catch (err) {
      resultado.falhas += 1;
      resultado.detalhes.push({ cliente_id: c.id, erro: err.message });
      continue;
    }
    if (!r) continue;
    resultado.criados += 1;
    try {
      const enviado = await enviar(db, r.id, { usuario });
      resultado.enviados += 1;
      resultado.detalhes.push({ cliente_id: c.id, repasse_id: r.id, situacao: enviado.situacao, valor_centavos: enviado.valor_liquido_centavos });
    } catch (err) {
      resultado.falhas += 1;
      resultado.detalhes.push({ cliente_id: c.id, repasse_id: r.id, erro: err.message });
    }
  }
  return resultado;
}

/**
 * Dinheiro de cliente que já devia ter saído: creditado antes de hoje e ainda conosco.
 * É o que a Conformidade vigia — o creditado hoje está, no máximo, esperando a rodada.
 *
 * Conta o saldo liberado ATÉ AGORA (com os repasses de hoje já descontados) e limita ao que foi
 * liberado antes de hoje: assim um crédito de ontem repassado hoje cedo não aparece como parado.
 */
function parados(db, data = hoje(), { suspensos = false } = {}) {
  return db.prepare(`SELECT c.id, COALESCE(c.nome_fantasia, c.razao_social) AS cliente, COALESCE(c.pix_chave, c.destino_conta) AS pix_chave, c.bloqueio_repasse,
      SUM(CASE WHEN l.data_liberacao <= ? THEN l.valor_centavos ELSE 0 END) AS ate_agora,
      SUM(CASE WHEN l.data_liberacao < ? THEN l.valor_centavos ELSE 0 END) AS antes_de_hoje
    FROM lancamentos l JOIN clientes c ON c.id = l.cliente_id
    WHERE c.bloqueio_repasse IS ${suspensos ? 'NOT NULL' : 'NULL'}
    GROUP BY c.id`).all(data, data)
    .map((x) => ({ id: x.id, cliente: x.cliente, pix_chave: x.pix_chave, motivo: x.bloqueio_repasse,
      valor_centavos: Math.min(x.ate_agora, x.antes_de_hoje) }))
    .filter((x) => x.valor_centavos > 0);
}

/** Valor retido por ordem legal: não é "dinheiro parado", é cumprimento de ordem — aparece à parte. */
const retidosPorOrdem = (db, data = hoje()) => parados(db, data, { suspensos: true });

module.exports = { disponivel, resumoCliente, criar, repassar, repassarCliente, aprovar, cancelar, enviar, rotinaAutomatica, parados, retidosPorOrdem, destinoDe };
