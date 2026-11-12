'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Central de multas: as multas dos veículos (consulta automática ou cadastro com a notificação), o cruzamento com o
 * rastreamento (onde o veículo estava, a velocidade e quem dirigia no horário) e a indicação do condutor.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const v = require('./validacao');
const fotos = require('./fotos');

const GRAVIDADES = { leve: ['Leve', 3], media: ['Média', 4], grave: ['Grave', 5], gravissima: ['Gravíssima', 7] };
const SITUACOES = {
  notificada: 'Notificada', condutor_indicado: 'Condutor indicado', em_recurso: 'Em recurso', a_pagar: 'A pagar', paga: 'Paga', cancelada: 'Cancelada',
};
const texto = (x, max) => (x === undefined || x === null || String(x).trim() === '' ? null : String(x).trim().slice(0, max));
const dataOuNulo = (x) => (texto(x, 10) && /^\d{4}-\d{2}-\d{2}$/.test(texto(x, 10)) ? texto(x, 10) : null);
const placaLimpa = (p) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function normalizar(db, empresaId, d) {
  const placa = placaLimpa(d.placa);
  v.exigir(/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa), 'Informe a placa do veículo.');
  const veic = db.prepare('SELECT id FROM veiculos WHERE empresa_id = ? AND placa = ?').get(empresaId, placa);
  const ocorrida = Date.parse(d.ocorrida_em ?? '');
  v.exigir(Number.isFinite(ocorrida), 'Informe a data e a hora da infração.');
  const gravidade = d.gravidade ? v.opcao(d.gravidade, 'a gravidade', Object.keys(GRAVIDADES)) : null;
  const valor = d.valor_centavos === undefined || d.valor_centavos === null || d.valor_centavos === '' ? null : v.inteiro(d.valor_centavos, 'o valor', { min: 0, max: 100_000_000 });
  return {
    placa, veiculo_id: veic?.id ?? null, auto_infracao: texto(d.auto_infracao, 40), orgao: texto(d.orgao, 80), infracao_codigo: texto(d.infracao_codigo, 20),
    descricao: v.texto(d.descricao, 'a descrição da infração', 300), gravidade, pontos: d.pontos ? v.inteiro(d.pontos, 'os pontos', { min: 0, max: 40 }) : (gravidade ? GRAVIDADES[gravidade][1] : null),
    valor_centavos: valor, ocorrida_em: new Date(ocorrida).toISOString(), local_texto: texto(d.local_texto, 200), municipio: texto(d.municipio, 80),
    prazo_indicacao: dataOuNulo(d.prazo_indicacao), vencimento: dataOuNulo(d.vencimento), observacao: texto(d.observacao, 500), sem_hora: d.sem_hora ? 1 : 0,
  };
}

function salvarArquivos(db, empresaId, multaId, lista) {
  const arquivos = fotos.conferir(lista, { pdf: true });
  if (!arquivos.length) return;
  const pasta = path.join(config.fotosDir, String(empresaId));
  fs.mkdirSync(pasta, { recursive: true });
  for (const f of arquivos) {
    const nome = `multa-${multaId}-${crypto.randomBytes(8).toString('hex')}.${f.extensao}`;
    fs.writeFileSync(path.join(pasta, nome), f.buffer);
    db.prepare('INSERT INTO multa_arquivos (empresa_id, multa_id, arquivo, tipo, tamanho, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(empresaId, multaId, path.join(String(empresaId), nome), f.tipo, f.buffer.length, agora());
  }
}

function criar(db, empresaId, d, { usuarioId = null, fonte = 'manual' } = {}) {
  const x = normalizar(db, empresaId, d);
  if (x.auto_infracao) {
    const ja = db.prepare('SELECT id FROM multas WHERE empresa_id = ? AND auto_infracao = ?').get(empresaId, x.auto_infracao);
    if (ja) throw new ErroNegocio(`Essa multa (auto ${x.auto_infracao}) já está cadastrada.`, 409);
  }
  // Quem dirigia no horário (check-in pelo QR, senão o motorista fixo) já vem sugerido como condutor.
  const sugerido = x.veiculo_id ? condutorNoHorario(db, x.veiculo_id, x.ocorrida_em) : null;
  return transacao(db, () => {
    const id = Number(db.prepare(`INSERT INTO multas (empresa_id, veiculo_id, placa, auto_infracao, orgao, infracao_codigo, descricao, gravidade, pontos, valor_centavos,
      ocorrida_em, local_texto, municipio, prazo_indicacao, vencimento, motorista_id, fonte, observacao, criada_por, criada_em, sem_hora)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId, x.veiculo_id, x.placa, x.auto_infracao, x.orgao, x.infracao_codigo,
      x.descricao, x.gravidade, x.pontos, x.valor_centavos, x.ocorrida_em, x.local_texto, x.municipio, x.prazo_indicacao, x.vencimento,
      sugerido?.motorista_id ?? null, fonte, x.observacao, usuarioId, agora(), x.sem_hora).lastInsertRowid);
    salvarArquivos(db, empresaId, id, d.arquivos);
    return id;
  });
}

function atualizar(db, empresaId, id, d) {
  const m = db.prepare('SELECT * FROM multas WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!m) throw new ErroNegocio('Multa não encontrada.', 404);
  const x = normalizar(db, empresaId, { ...m, valor_centavos: m.valor_centavos, ...d });
  const situacao = d.situacao ? v.opcao(d.situacao, 'a situação', Object.keys(SITUACOES)) : m.situacao;
  let motorista = m.motorista_id;
  if (d.motorista_id !== undefined) {
    motorista = d.motorista_id ? Number(d.motorista_id) : null;
    if (motorista) v.exigir(db.prepare('SELECT 1 FROM motoristas WHERE id = ? AND empresa_id = ?').get(motorista, empresaId), 'Motorista não encontrado.');
  }
  transacao(db, () => {
    db.prepare(`UPDATE multas SET veiculo_id = ?, placa = ?, auto_infracao = ?, orgao = ?, infracao_codigo = ?, descricao = ?, gravidade = ?, pontos = ?,
      valor_centavos = ?, ocorrida_em = ?, local_texto = ?, municipio = ?, prazo_indicacao = ?, vencimento = ?, observacao = ?, situacao = ?, motorista_id = ?,
      atualizada_em = ? WHERE id = ?`).run(x.veiculo_id, x.placa, x.auto_infracao, x.orgao, x.infracao_codigo, x.descricao, x.gravidade, x.pontos, x.valor_centavos,
      x.ocorrida_em, x.local_texto, x.municipio, x.prazo_indicacao, x.vencimento, x.observacao, situacao, motorista, agora(), m.id);
    salvarArquivos(db, empresaId, m.id, d.arquivos);
  });
}

function remover(db, empresaId, id) {
  const lista = db.prepare('SELECT a.arquivo FROM multa_arquivos a JOIN multas m ON m.id = a.multa_id WHERE m.id = ? AND m.empresa_id = ?').all(Number(id), empresaId);
  const r = transacao(db, () => {
    db.prepare('DELETE FROM multa_arquivos WHERE multa_id = ? AND empresa_id = ?').run(Number(id), empresaId);
    return db.prepare('DELETE FROM multas WHERE id = ? AND empresa_id = ?').run(Number(id), empresaId).changes;
  });
  if (!r) throw new ErroNegocio('Multa não encontrada.', 404);
  for (const a of lista) fs.rm(path.resolve(config.fotosDir, a.arquivo), { force: true }, () => {});
}

const CAMPOS = `m.*, v.descricao AS veiculo_descricao, mo.nome AS motorista, e.nome AS empresa,
  (SELECT COUNT(*) FROM multa_arquivos a WHERE a.multa_id = m.id) AS arquivos`;
const FROM = 'FROM multas m JOIN empresas e ON e.id = m.empresa_id LEFT JOIN veiculos v ON v.id = m.veiculo_id LEFT JOIN motoristas mo ON mo.id = m.motorista_id';

/** Lista com filtros: empresa, veículos (app do cliente), motorista (app do motorista), situação, período. */
function listar(db, { empresaId, veiculoIds, motoristaId, situacao, de, ate, limite = 500 } = {}) {
  const onde = ["e.status <> 'excluida'"];
  const p = [];
  if (empresaId) { onde.push('m.empresa_id = ?'); p.push(empresaId); }
  if (veiculoIds) { if (!veiculoIds.length) return []; onde.push(`m.veiculo_id IN (${veiculoIds.map(() => '?').join(',')})`); p.push(...veiculoIds); }
  if (motoristaId) { onde.push('m.motorista_id = ?'); p.push(motoristaId); }
  if (situacao) { onde.push('m.situacao = ?'); p.push(v.opcao(situacao, 'a situação', Object.keys(SITUACOES))); }
  if (de) { onde.push('m.ocorrida_em >= ?'); p.push(de); }
  if (ate) { onde.push('m.ocorrida_em < ?'); p.push(ate); }
  return db.prepare(`SELECT ${CAMPOS} ${FROM} WHERE ${onde.join(' AND ')} ORDER BY m.ocorrida_em DESC LIMIT ${Number(limite)}`).all(...p).map(comPrazo);
}

/** Dias até o prazo de indicação do condutor e o vencimento (negativo = passou). */
function comPrazo(m) {
  const dias = (d) => (d ? Math.ceil((Date.parse(`${d}T23:59:59-03:00`) - Date.now()) / 86_400_000) : null);
  return { ...m, dias_indicacao: dias(m.prazo_indicacao), dias_vencimento: dias(m.vencimento) };
}

/** Quem dirigia o veículo no instante: o check-in pelo QR (condutor) ou, sem ele, o motorista fixo. */
function condutorNoHorario(db, veiculoId, quando) {
  const c = db.prepare(`SELECT c.motorista_id, mo.nome FROM condutores c JOIN motoristas mo ON mo.id = c.motorista_id
    WHERE c.veiculo_id = ? AND c.inicio <= ? AND (c.fim IS NULL OR c.fim >= ?) ORDER BY c.inicio DESC LIMIT 1`).get(veiculoId, quando, quando);
  if (c) return { ...c, origem: 'check-in pelo QR code do veículo' };
  const f = db.prepare('SELECT v.motorista_id, mo.nome FROM veiculos v JOIN motoristas mo ON mo.id = v.motorista_id WHERE v.id = ?').get(veiculoId);
  return f ? { ...f, origem: 'motorista fixo do veículo' } : null;
}

/** Cruzamento com o rastreamento: a posição mais próxima do horário (até 15 min), a velocidade e quem dirigia. */
function cruzamento(db, m) {
  if (!m.veiculo_id) return { veiculo_cadastrado: false };
  const t = Date.parse(m.ocorrida_em);
  const janela = (min) => [new Date(t - min * 60_000).toISOString(), new Date(t + min * 60_000).toISOString()];
  const [de, ate] = janela(15);
  const pos = db.prepare(`SELECT lat, lng, velocidade_kmh, ignicao, gps_em FROM posicoes WHERE veiculo_id = ? AND gps_em BETWEEN ? AND ?
    ORDER BY ABS(julianday(gps_em) - julianday(?)) LIMIT 1`).get(m.veiculo_id, de, ate, m.ocorrida_em);
  const [de2, ate2] = janela(3);
  const vmax = db.prepare('SELECT MAX(velocidade_kmh) AS v FROM posicoes WHERE veiculo_id = ? AND gps_em BETWEEN ? AND ?').get(m.veiculo_id, de2, ate2)?.v ?? null;
  return {
    veiculo_cadastrado: true,
    posicao: pos ? { ...pos, diferenca_min: Math.round(Math.abs(Date.parse(pos.gps_em) - t) / 60_000) } : null,
    velocidade_max_kmh: vmax,
    condutor: condutorNoHorario(db, m.veiculo_id, m.ocorrida_em),
  };
}

function detalhe(db, id, { empresaId } = {}) {
  const m = db.prepare(`SELECT ${CAMPOS} ${FROM} WHERE m.id = ? ${empresaId ? 'AND m.empresa_id = ?' : ''}`).get(...[Number(id), ...(empresaId ? [empresaId] : [])]);
  if (!m) throw new ErroNegocio('Multa não encontrada.', 404);
  return { ...comPrazo(m), arquivos: db.prepare('SELECT id, tipo, tamanho, criado_em FROM multa_arquivos WHERE multa_id = ? ORDER BY id').all(m.id), cruzamento: cruzamento(db, m) };
}

function arquivo(db, empresaId, id) {
  const a = db.prepare(`SELECT * FROM multa_arquivos WHERE id = ? ${empresaId ? 'AND empresa_id = ?' : ''}`).get(...[Number(id), ...(empresaId ? [empresaId] : [])]);
  if (!a) return null;
  const completo = path.resolve(config.fotosDir, a.arquivo);
  if (!completo.startsWith(path.resolve(config.fotosDir) + path.sep) || !fs.existsSync(completo)) return null;
  return { caminho: completo, tipo: a.tipo, multa_id: a.multa_id, empresa_id: a.empresa_id };
}

/** Resumo para o topo da central: em aberto, valor a pagar, prazos de indicação vencendo em 7 dias, pontos do mês. */
function resumo(lista) {
  const aberto = lista.filter((m) => !['paga', 'cancelada'].includes(m.situacao));
  return {
    total: lista.length, em_aberto: aberto.length,
    valor_aberto_centavos: aberto.reduce((s, m) => s + (m.valor_centavos ?? 0), 0),
    indicar_7_dias: aberto.filter((m) => m.situacao === 'notificada' && m.dias_indicacao !== null && m.dias_indicacao >= 0 && m.dias_indicacao <= 7).length,
    sem_condutor: aberto.filter((m) => !m.motorista_id).length,
  };
}

module.exports = { GRAVIDADES, SITUACOES, criar, atualizar, remover, listar, detalhe, arquivo, resumo, cruzamento, condutorNoHorario, placaLimpa };
