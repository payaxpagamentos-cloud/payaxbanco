'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { daEmpresa } = require('./acesso');
const v = require('./validacao');

const TIPOS = ['nota', 'boleto', 'contrato', 'comprovante', 'extrato', 'outro'];
// Só formatos de documento; o download é sempre como anexo, nunca exibido pelo navegador.
const EXTENSOES = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'xml', 'txt', 'csv', 'ofx', 'xlsx', 'xls', 'docx', 'doc', 'odt', 'ods', 'zip'];

function nomeSeguro(nome) {
  const limpo = path.basename(String(nome ?? '')).replace(/[^\p{L}\p{N} ._()-]/gu, '_').trim().slice(0, 120);
  return limpo || 'arquivo';
}

/** Grava o arquivo em disco (nome aleatório, fora da pasta pública) e o registro no banco. */
function salvar(db, empresaId, conteudo, { nome, tipo, lancamento_id: lancamentoId, descricao }, autor) {
  v.exigir(Buffer.isBuffer(conteudo) && conteudo.length, 'Arquivo vazio.');
  if (conteudo.length > config.tamanhoMaximoArquivo) throw new ErroNegocio('Arquivo maior que o permitido.', 413);
  const arquivoNome = nomeSeguro(nome);
  const ext = arquivoNome.includes('.') ? arquivoNome.split('.').pop().toLowerCase() : '';
  v.exigir(EXTENSOES.includes(ext), `Formato não aceito. Use: ${EXTENSOES.join(', ')}.`);
  v.exigir(TIPOS.includes(tipo ?? 'outro'), 'Tipo de documento inválido.');
  if (lancamentoId) daEmpresa(db, 'lancamentos', v.id(lancamentoId), empresaId, 'Lançamento');
  const relativo = path.join(String(empresaId), `${crypto.randomUUID()}.${ext}`);
  const destino = path.join(config.arquivosDir, relativo);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, conteudo, { flag: 'wx' });
  const sha = crypto.createHash('sha256').update(conteudo).digest('hex');
  try {
    const r = db.prepare(`INSERT INTO documentos (empresa_id, lancamento_id, tipo, nome, tamanho, sha256, arquivo, descricao, enviado_por_usuario, enviado_por_responsavel)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId, v.id(lancamentoId), tipo ?? 'outro', arquivoNome, conteudo.length, sha, relativo,
      v.texto(descricao, 300), autor.usuario_id ?? null, autor.responsavel_id ?? null);
    return Number(r.lastInsertRowid);
  } catch (err) {
    fs.rmSync(destino, { force: true });
    throw err;
  }
}

function listar(db, empresaId, { lancamento_id: lancamentoId, tipo } = {}) {
  const filtros = ['d.empresa_id = ?'];
  const params = [empresaId];
  if (lancamentoId) { filtros.push('d.lancamento_id = ?'); params.push(Number(lancamentoId)); }
  if (tipo) { filtros.push('d.tipo = ?'); params.push(tipo); }
  return db.prepare(`SELECT d.id, d.lancamento_id, d.tipo, d.nome, d.tamanho, d.descricao, d.criado_em, u.nome AS usuario_nome, r.nome AS responsavel_nome,
      l.descricao AS lancamento_descricao, l.tipo AS lancamento_tipo
    FROM documentos d LEFT JOIN usuarios u ON u.id = d.enviado_por_usuario LEFT JOIN responsaveis r ON r.id = d.enviado_por_responsavel
    LEFT JOIN lancamentos l ON l.id = d.lancamento_id WHERE ${filtros.join(' AND ')} ORDER BY d.id DESC LIMIT 500`).all(...params);
}

function buscar(db, empresaId, id) {
  const d = db.prepare('SELECT * FROM documentos WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!d) throw naoEncontrado('Documento');
  return d;
}

/** Envia o arquivo como anexo, conferindo a integridade (SHA-256) gravada no envio. */
function enviar(res, d) {
  const caminho = path.join(config.arquivosDir, d.arquivo);
  if (!fs.existsSync(caminho)) throw new ErroNegocio('Arquivo não encontrado no armazenamento.', 410);
  const conteudo = fs.readFileSync(caminho);
  if (crypto.createHash('sha256').update(conteudo).digest('hex') !== d.sha256) throw new ErroNegocio('Arquivo corrompido ou alterado no armazenamento.', 409);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(d.nome)}"; filename*=UTF-8''${encodeURIComponent(d.nome)}`,
    'Cache-Control': 'no-store',
  });
  res.send(conteudo);
}

function excluir(db, empresaId, id) {
  const d = buscar(db, empresaId, id);
  db.prepare('DELETE FROM documentos WHERE id = ?').run(d.id);
  fs.rmSync(path.join(config.arquivosDir, d.arquivo), { force: true });
  return d;
}

module.exports = { TIPOS, EXTENSOES, salvar, listar, buscar, enviar, excluir };
