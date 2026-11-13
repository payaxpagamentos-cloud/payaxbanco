'use strict';

/*
 * Repasse: o líquido da conta gráfica indo para a conta do cliente por PIX.
 *
 * O valor pedido é o que SAI do saldo. Dele descontamos a tarifa do repasse; o resto é o PIX enviado:
 *     valor (debitado do saldo) − tarifa = valor líquido transferido
 *
 * O saldo é debitado no momento da solicitação (o dinheiro fica comprometido). Se o repasse falhar ou for
 * cancelado, entra um estorno — nada é apagado.
 */
const config = require('../config');
const { transacao, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const datas = require('./datas');
const razao = require('./razao');
const precos = require('./precos');
const { criarBanco } = require('./bradesco');
const { contaDe, credenciaisDaConta } = require('./boletos');

const hoje = () => datas.dataLocal(config.fusoPadrao);
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** O que o cliente pode sacar agora e qual seria a tarifa. */
function disponivel(db, cliente, data = hoje()) {
  const s = razao.saldo(db, cliente.id, data);
  const preco = precos.vigente(db, cliente.id, data);
  const taxa = preco.tarifa_repasse_centavos ?? 0;
  const pendente = db.prepare("SELECT IFNULL(SUM(valor_centavos), 0) AS v FROM repasses WHERE cliente_id = ? AND situacao IN ('aguardando_aprovacao','aprovado','enviado')").get(cliente.id).v;
  return {
    ...s,
    taxa_repasse_centavos: taxa,
    em_transito_centavos: pendente,
    sacavel_centavos: Math.max(0, s.disponivel_centavos),
    liquido_se_sacar_tudo_centavos: Math.max(0, s.disponivel_centavos - taxa),
  };
}

/** Confere se o cliente tem conta de destino cadastrada. */
function destinoDe(cliente) {
  if (!cliente.pix_chave) throw new ErroNegocio('O cliente não tem chave PIX cadastrada para receber o repasse.', 409);
  return {
    pix_tipo: cliente.pix_tipo,
    pix_chave: cliente.pix_chave,
    titular_nome: cliente.pix_titular ?? cliente.razao_social,
    titular_documento: cliente.pix_documento ?? cliente.cnpj,
  };
}

/**
 * Cria o repasse e debita o saldo. Devolve o repasse já com a situação:
 * 'aprovado' quando está dentro do limite de aprovação automática do cliente; senão 'aguardando_aprovacao'.
 */
function solicitar(db, cliente, { valor_centavos, automatico = false }, { usuario = null, usuarioCliente = null } = {}) {
  return transacao(db, () => {
    const data = hoje();
    const d = disponivel(db, cliente, data);
    const valor = Number(valor_centavos);
    if (!Number.isInteger(valor) || valor <= 0) throw new ErroNegocio('Valor do repasse inválido.', 422);
    if (valor > d.disponivel_centavos) {
      throw new ErroNegocio(`Saldo disponível insuficiente: ${brl(d.disponivel_centavos)} (pedido: ${brl(valor)}).`, 409);
    }
    const taxa = d.taxa_repasse_centavos;
    const liquido = valor - taxa;
    if (liquido <= 0) throw new ErroNegocio(`O valor precisa ser maior que a tarifa do repasse (${brl(taxa)}).`, 422);
    const destino = destinoDe(cliente);

    // Dentro do limite do cliente, segue direto; acima dele, espera a conferência da nossa equipe.
    const dentroDoLimite = valor <= cliente.repasse_limite_aprovacao_centavos && cliente.repasse_limite_aprovacao_centavos > 0;
    const situacao = dentroDoLimite ? 'aprovado' : 'aguardando_aprovacao';

    const r = db.prepare(`INSERT INTO repasses (cliente_id, valor_centavos, taxa_centavos, valor_liquido_centavos, meio,
        pix_tipo, pix_chave, titular_nome, titular_documento, situacao, automatico, solicitado_por, solicitado_por_cliente,
        aprovado_por, aprovado_em, criado_em)
      VALUES (?, ?, ?, ?, 'pix', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(cliente.id, valor, taxa, liquido, destino.pix_tipo, destino.pix_chave, destino.titular_nome, destino.titular_documento,
        situacao, automatico ? 1 : 0, usuario?.id ?? null, usuarioCliente?.id ?? null,
        dentroDoLimite && usuario ? usuario.id : null, dentroDoLimite ? agora() : null, agora());

    razao.lancar(db, { cliente_id: cliente.id, repasse_id: r.id, tipo: 'repasse', valor_centavos: -liquido,
      descricao: `Repasse PIX #${r.id} · ${destino.pix_chave}`, data_competencia: data, data_liberacao: data, criado_por: usuario?.id ?? null });
    razao.lancar(db, { cliente_id: cliente.id, repasse_id: r.id, tipo: 'taxa_repasse', valor_centavos: -taxa,
      descricao: `Tarifa do repasse #${r.id}`, data_competencia: data, data_liberacao: data, criado_por: usuario?.id ?? null });

    return r;
  });
}

function aprovar(db, id, usuario) {
  const r = db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
  if (!r) throw naoEncontrado('Repasse');
  if (r.situacao !== 'aguardando_aprovacao') throw new ErroNegocio(`Repasse já está como ${r.situacao}.`, 409);
  db.prepare("UPDATE repasses SET situacao = 'aprovado', aprovado_por = ?, aprovado_em = ?, versao = versao + 1 WHERE id = ?")
    .run(usuario.id, agora(), id);
  return db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
}

/** Devolve o valor ao saldo do cliente (falha no PIX ou cancelamento). */
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
 * Rotina diária: para cada cliente ativo com repasse automático e saldo acima do mínimo, cria e envia o repasse.
 * O que passar do limite de aprovação do cliente fica esperando a nossa equipe.
 */
async function rotinaAutomatica(db, { usuario = null } = {}) {
  const data = hoje();
  const clientes = db.prepare("SELECT * FROM clientes WHERE situacao = 'ativo' AND repasse_automatico = 1 AND pix_chave IS NOT NULL").all();
  const resultado = { data, criados: 0, enviados: 0, aguardando: 0, falhas: 0, detalhes: [] };
  for (const c of clientes) {
    const d = disponivel(db, c, data);
    if (d.disponivel_centavos < Math.max(c.repasse_minimo_centavos, d.taxa_repasse_centavos + 1)) continue;
    let r;
    try {
      r = solicitar(db, c, { valor_centavos: d.disponivel_centavos, automatico: true }, { usuario });
      resultado.criados += 1;
    } catch (err) {
      resultado.falhas += 1;
      resultado.detalhes.push({ cliente_id: c.id, erro: err.message });
      continue;
    }
    if (r.situacao !== 'aprovado') {
      resultado.aguardando += 1;
      resultado.detalhes.push({ cliente_id: c.id, repasse_id: r.id, situacao: r.situacao });
      continue;
    }
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

module.exports = { disponivel, solicitar, aprovar, cancelar, enviar, rotinaAutomatica, destinoDe };
