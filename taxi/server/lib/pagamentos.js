'use strict';

const QRCode = require('qrcode');
const config = require('../config');
const { lerConfig, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const pix = require('./pix');

/**
 * Cobranças ao passageiro. Tudo é pago antes da viagem:
 * - 'corrida': o valor estimado, pago por PIX ou cartão; ao ser concluída, a chamada vai para os taxistas;
 * - 'complemento': no modelo taxímetro, o que passou do valor pago;
 * - 'estorno': devolução (corrida cancelada depois de paga, ou taxímetro abaixo do pago).
 *
 * Modo 'simulado' (testes): o passageiro aprova o pagamento na própria tela e os estornos saem na hora.
 * Modo 'manual': PIX na chave da plataforma, confirmado pela central; estornos feitos pela central; sem cartão.
 * Para cobrar e devolver automaticamente, ligue aqui um intermediador de pagamentos (PSP): criar a cobrança nele em
 * `criar`, receber a confirmação por webhook e chamar `concluir`.
 */
const modo = () => config.pagamentos;

function criar(db, corrida, tipo, valor, motivo = null) {
  if (tipo !== 'estorno' && corrida.forma_pagamento === 'cartao' && modo() === 'manual') {
    throw new ErroNegocio('Pagamento com cartão indisponível no momento. Use PIX.', 409);
  }
  const r = db.prepare(`INSERT INTO cobrancas (corrida_id, tipo, forma, valor_centavos, motivo, criada_em) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(corrida.id, tipo, corrida.forma_pagamento, valor, motivo, agora());
  const id = Number(r.lastInsertRowid);
  // No modo simulado o estorno é imediato; no manual fica para a central devolver.
  if (tipo === 'estorno' && modo() === 'simulado') concluir(db, id, null, `SIMULADO-${id}`);
  return id;
}

function buscar(db, id) {
  const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(id);
  if (!c) throw naoEncontrado('Cobrança');
  return c;
}

/** Conclui a cobrança (pagamento recebido ou estorno devolvido) e atualiza a corrida. */
function concluir(db, id, usuarioId, identificador) {
  const cob = buscar(db, id);
  if (cob.status !== 'pendente') throw new ErroNegocio('Esta cobrança já foi concluída ou cancelada.', 409);
  db.prepare(`UPDATE cobrancas SET status = 'concluida', concluida_em = ?, concluida_por = ?, identificador = ? WHERE id = ?`)
    .run(agora(), usuarioId, identificador ?? null, id);
  const c = db.prepare('SELECT * FROM corridas WHERE id = ?').get(cob.corrida_id);
  if (cob.tipo === 'corrida') {
    if (c.status !== 'aguardando_pagamento') return; // pagamento atrasado de corrida já expirada: a central devolve
    db.prepare(`UPDATE corridas SET status = 'solicitada', solicitada_em = ?, valor_pago_centavos = ?, pagamento_status = 'pago' WHERE id = ?`)
      .run(agora(), cob.valor_centavos, c.id);
  } else if (cob.tipo === 'complemento') {
    db.prepare(`UPDATE corridas SET valor_pago_centavos = valor_pago_centavos + ?, pagamento_status = 'pago' WHERE id = ?`).run(cob.valor_centavos, c.id);
  }
}

const cancelarPendentes = (db, corridaId) =>
  db.prepare(`UPDATE cobrancas SET status = 'cancelada', concluida_em = ? WHERE corrida_id = ? AND status = 'pendente' AND tipo <> 'estorno'`).run(agora(), corridaId);

/** Cobrança pendente com o PIX copia e cola (e QR Code) para o passageiro pagar. */
async function paraPagar(db, cob) {
  const out = { id: cob.id, tipo: cob.tipo, forma: cob.forma, valor_centavos: cob.valor_centavos, modo: modo() };
  if (cob.forma === 'pix') {
    const cfg = lerConfig(db);
    if (!cfg.pix_chave) throw new ErroNegocio('PIX indisponível: a central ainda não cadastrou a chave PIX.', 409);
    out.copia_e_cola = pix.copiaECola({
      chave: cfg.pix_chave, recebedor: cfg.pix_recebedor, cidade: cfg.pix_cidade, valorCentavos: cob.valor_centavos,
      txid: `TAXI${cob.id}`, descricao: `Corrida ${cob.corrida_id}`,
    });
    out.qr_svg = await QRCode.toString(out.copia_e_cola, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  }
  return out;
}

module.exports = { modo, criar, buscar, concluir, cancelarPendentes, paraPagar };
