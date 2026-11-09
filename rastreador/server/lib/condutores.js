'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const crypto = require('node:crypto');
const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');

/**
 * Quem está com o veículo. O motorista escaneia o QR code colado no veículo (com a câmera do celular) e assume o veículo:
 * a nota e o custo passam a contar para ele daquele momento em diante. Sem registro, vale o motorista fixo do cadastro.
 */

/** Código secreto do QR do veículo (criado na primeira vez). */
function codigoQr(db, veiculo) {
  if (veiculo.codigo_qr) return veiculo.codigo_qr;
  const c = crypto.randomBytes(9).toString('base64url');
  db.prepare('UPDATE veiculos SET codigo_qr = ? WHERE id = ?').run(c, veiculo.id);
  return c;
}
/** Troca o código (o QR antigo deixa de valer, ex.: etiqueta perdida). */
function novoCodigoQr(db, veiculo) {
  db.prepare('UPDATE veiculos SET codigo_qr = NULL WHERE id = ?').run(veiculo.id);
  return codigoQr(db, { ...veiculo, codigo_qr: null });
}

const atual = (db, veiculoId) => db.prepare(`SELECT c.*, m.nome FROM condutores c JOIN motoristas m ON m.id = c.motorista_id
  WHERE c.veiculo_id = ? AND c.fim IS NULL`).get(veiculoId) ?? null;

function veiculoPorCodigo(db, empresaId, codigo) {
  const v = typeof codigo === 'string' && /^[\w-]{8,20}$/.test(codigo)
    ? db.prepare('SELECT * FROM veiculos WHERE empresa_id = ? AND codigo_qr = ? AND ativo = 1').get(empresaId, codigo) : null;
  if (!v) throw new ErroNegocio('QR code não reconhecido. Confira se é um veículo da sua empresa.', 404);
  return v;
}

/** O motorista assume o veículo: fecha quem estava com ele e o veículo que o motorista tinha antes. */
function assumir(db, motorista, veiculo) {
  transacao(db, () => {
    const t = agora();
    db.prepare('UPDATE condutores SET fim = ? WHERE fim IS NULL AND (veiculo_id = ? OR motorista_id = ?)').run(t, veiculo.id, motorista.id);
    db.prepare('INSERT INTO condutores (empresa_id, veiculo_id, motorista_id, inicio) VALUES (?, ?, ?, ?)').run(veiculo.empresa_id, veiculo.id, motorista.id, t);
  });
}
const devolver = (db, motorista) => db.prepare('UPDATE condutores SET fim = ? WHERE motorista_id = ? AND fim IS NULL').run(agora(), motorista.id).changes > 0;

/** Veículos com o motorista: o que ele assumiu pelo QR e os que têm ele como motorista fixo (quando ninguém assumiu). */
function veiculosDo(db, motorista) {
  return db.prepare(`SELECT v.*, c.inicio AS assumido_em FROM veiculos v LEFT JOIN condutores c ON c.veiculo_id = v.id AND c.fim IS NULL
    WHERE v.ativo = 1 AND v.empresa_id = ? AND (c.motorista_id = ? OR (c.id IS NULL AND v.motorista_id = ?)) ORDER BY c.inicio IS NULL, v.placa`)
    .all(motorista.empresa_id, motorista.id, motorista.id);
}
function doMotorista(db, motorista, veiculoId) {
  const lista = veiculosDo(db, motorista);
  const v = veiculoId ? lista.find((x) => x.id === Number(veiculoId)) : lista[0];
  if (!v) throw new ErroNegocio(veiculoId ? 'Este veículo não está com você.' : 'Nenhum veículo está com você. Escaneie o QR code do veículo.', 422);
  return v;
}

/** Trechos do período [ini, fim) com o motorista de cada um; onde não há registro, o motorista fixo do cadastro. */
function trechos(db, veiculo, ini, fim) {
  const rows = db.prepare(`SELECT motorista_id, inicio, COALESCE(fim, ?) AS ate FROM condutores
    WHERE veiculo_id = ? AND inicio < ? AND COALESCE(fim, ?) > ? ORDER BY inicio`).all(fim, veiculo.id, fim, fim, ini);
  const lista = [];
  let t = ini;
  for (const r of rows) {
    const a = r.inicio > t ? r.inicio : t;
    const b = r.ate < fim ? r.ate : fim;
    if (a > t) lista.push({ motorista_id: veiculo.motorista_id, inicio: t, fim: a });
    if (b > a) lista.push({ motorista_id: r.motorista_id, inicio: a, fim: b });
    if (b > t) t = b;
  }
  if (t < fim) lista.push({ motorista_id: veiculo.motorista_id, inicio: t, fim });
  return lista;
}

module.exports = { codigoQr, novoCodigoQr, atual, veiculoPorCodigo, assumir, devolver, veiculosDo, doMotorista, trechos };
