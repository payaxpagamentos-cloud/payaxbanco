'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Créditos da central de multas: cada empresa tem um saldo em reais; cada consulta desconta o preço de venda do tipo
 * (definido pelo master por empresa, ou o padrão), e volta se a consulta falhar. Recarga por PIX: o sistema gera o código com
 * o valor; o master confirma o pagamento e o crédito entra na hora.
 */
const { agora, lerConfig, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const pix = require('./pix');

const TIPOS = ['completa', 'renainf', 'resumida'];

function precos(db, empresaId) {
  const cfg = lerConfig(db);
  const e = db.prepare('SELECT multas_preco_completa, multas_preco_renainf, multas_preco_resumida FROM empresas WHERE id = ?').get(empresaId) ?? {};
  return Object.fromEntries(TIPOS.map((t) => [t, e[`multas_preco_${t}`] ?? cfg[`multas_preco_${t}`]]));
}
const saldo = (db, empresaId) => db.prepare('SELECT multas_credito_centavos AS s FROM empresas WHERE id = ?').get(empresaId)?.s ?? 0;

/** Lança no extrato e atualiza o saldo (dentro de uma transação). */
function lancar(db, empresaId, { tipo, valor, descricao = null, consultaId = null, pixId = null, usuarioId = null }) {
  return transacao(db, () => {
    const novo = saldo(db, empresaId) + valor;
    db.prepare('UPDATE empresas SET multas_credito_centavos = ? WHERE id = ?').run(novo, empresaId);
    db.prepare(`INSERT INTO multas_creditos (empresa_id, tipo, valor_centavos, saldo_centavos, descricao, consulta_id, pix_id, usuario_id, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId, tipo, valor, novo, descricao, consultaId, pixId, usuarioId, agora());
    return novo;
  });
}

/** Desconta a consulta; sem saldo, a consulta não roda. */
function debitarConsulta(db, empresaId, { tipo, placa, consultaId, usuarioId }) {
  const valor = precos(db, empresaId)[tipo] ?? 0;
  return transacao(db, () => {
    const s = saldo(db, empresaId);
    if (valor > s) {
      throw new ErroNegocio(`Crédito insuficiente para a consulta (${(valor / 100).toFixed(2).replace('.', ',')}; saldo ${(s / 100).toFixed(2).replace('.', ',')}). Adicione crédito na Central de multas.`, 402);
    }
    if (valor > 0) lancar(db, empresaId, { tipo: 'consulta', valor: -valor, descricao: `Consulta ${tipo} · ${placa}`, consultaId, usuarioId });
    return valor;
  });
}

/** Consulta que falhou: o valor volta para o saldo (uma vez só). */
function estornarConsulta(db, empresaId, consultaId) {
  const cobrado = db.prepare("SELECT -valor_centavos AS v, descricao FROM multas_creditos WHERE consulta_id = ? AND tipo = 'consulta'").get(consultaId);
  if (!cobrado || db.prepare("SELECT 1 FROM multas_creditos WHERE consulta_id = ? AND tipo = 'estorno'").get(consultaId)) return 0;
  lancar(db, empresaId, { tipo: 'estorno', valor: cobrado.v, descricao: `Estorno (a consulta não foi concluída) · ${String(cobrado.descricao ?? '').replace(/^Consulta /, '')}`, consultaId });
  return cobrado.v;
}

const extrato = (db, empresaId, limite = 50) => db.prepare(`SELECT c.id, c.tipo, c.valor_centavos, c.saldo_centavos, c.descricao, c.criado_em, u.nome AS usuario
  FROM multas_creditos c LEFT JOIN usuarios u ON u.id = c.usuario_id WHERE c.empresa_id = ? ORDER BY c.id DESC LIMIT ${Number(limite)}`).all(empresaId);

// ---------- PIX ----------
const cobranca = (db, id) => db.prepare('SELECT p.*, e.nome AS empresa FROM pix_cobrancas p JOIN empresas e ON e.id = p.empresa_id WHERE p.id = ?').get(Number(id));
const pixConfigurado = (db) => Boolean(lerConfig(db).pix_chave);

function criarPix(db, empresaId, valorCentavos, usuarioId) {
  const v = Number(valorCentavos);
  if (!Number.isInteger(v) || v < 1000 || v > 1_000_000) throw new ErroNegocio('Escolha um valor entre R$ 10,00 e R$ 10.000,00.', 422);
  const cfg = lerConfig(db);
  if (!cfg.pix_chave) throw new ErroNegocio('A recarga por PIX ainda não foi configurada pelo suporte.', 422);
  const id = Number(db.prepare("INSERT INTO pix_cobrancas (empresa_id, valor_centavos, txid, copia_cola, usuario_id, criado_em) VALUES (?, ?, '', '', ?, ?)")
    .run(empresaId, v, usuarioId, agora()).lastInsertRowid);
  const txid = `MULTAS${empresaId}R${id}`;
  const codigo = pix.copiaECola({ chave: cfg.pix_chave, nome: cfg.pix_nome || cfg.nome_plataforma, cidade: cfg.pix_cidade, valorCentavos: v, txid });
  db.prepare('UPDATE pix_cobrancas SET txid = ?, copia_cola = ? WHERE id = ?').run(txid, codigo, id);
  return cobranca(db, id);
}

function informarPix(db, empresaId, id) {
  const c = cobranca(db, id);
  if (!c || c.empresa_id !== empresaId) throw new ErroNegocio('Recarga não encontrada.', 404);
  if (c.status === 'pendente') db.prepare("UPDATE pix_cobrancas SET status = 'informado', informado_em = ? WHERE id = ?").run(agora(), c.id);
  return cobranca(db, id);
}

/** O master confirma que o PIX caiu: o crédito entra na hora (uma vez só). */
function confirmarPix(db, id, usuarioId) {
  return transacao(db, () => {
    const c = cobranca(db, id);
    if (!c) throw new ErroNegocio('Recarga não encontrada.', 404);
    if (c.status === 'pago') throw new ErroNegocio('Essa recarga já foi confirmada.', 409);
    if (c.status === 'cancelado') throw new ErroNegocio('Essa recarga foi cancelada.', 409);
    db.prepare("UPDATE pix_cobrancas SET status = 'pago', pago_em = ?, confirmado_por = ? WHERE id = ?").run(agora(), usuarioId, c.id);
    lancar(db, c.empresa_id, { tipo: 'recarga', valor: c.valor_centavos, descricao: `Recarga PIX ${c.txid}`, pixId: c.id, usuarioId });
    return cobranca(db, id);
  });
}
function cancelarPix(db, id) {
  const c = cobranca(db, id);
  if (!c) throw new ErroNegocio('Recarga não encontrada.', 404);
  if (c.status === 'pago') throw new ErroNegocio('Recarga já confirmada não pode ser cancelada (use um ajuste).', 409);
  db.prepare("UPDATE pix_cobrancas SET status = 'cancelado' WHERE id = ?").run(c.id);
  return cobranca(db, id);
}
const cobrancas = (db, { empresaId = null, abertas = false, limite = 50 } = {}) => db.prepare(`SELECT p.id, p.empresa_id, e.nome AS empresa, p.valor_centavos, p.txid, p.status,
  p.criado_em, p.informado_em, p.pago_em, u.nome AS usuario FROM pix_cobrancas p JOIN empresas e ON e.id = p.empresa_id LEFT JOIN usuarios u ON u.id = p.usuario_id
  WHERE 1 = 1 ${empresaId ? 'AND p.empresa_id = ?' : ''} ${abertas ? "AND p.status IN ('pendente','informado')" : ''} ORDER BY p.id DESC LIMIT ${Number(limite)}`)
  .all(...(empresaId ? [empresaId] : []));

module.exports = { TIPOS, precos, saldo, lancar, debitarConsulta, estornarConsulta, extrato, pixConfigurado, criarPix, informarPix, confirmarPix, cancelarPix, cobrancas, cobranca };
