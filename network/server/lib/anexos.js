'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const { sha256, assinar } = require('./cripto');
const { pode } = require('./permissoes');

/** Tipos aceitos, reconhecidos pelo conteúdo (assinatura do arquivo), não pelo nome ou pelo cabeçalho enviado. */
function detectarTipo(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (b.length >= 5 && b.subarray(0, 5).toString() === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

/** Grava o arquivo fora da pasta pública, com nome aleatório, e registra o anexo. */
function salvar(db, req, { recurso, recursoId = null, nome, conteudo }) {
  if (!Buffer.isBuffer(conteudo) || conteudo.length === 0) throw new ErroNegocio('Envie o arquivo.', 422);
  if (conteudo.length > config.arquivoMaxBytes) throw new ErroNegocio(`Arquivo maior que ${config.arquivoMaxBytes / 1048576} MB.`, 413);
  const tipo = detectarTipo(conteudo);
  if (!tipo) throw new ErroNegocio('Formato não aceito. Envie JPG, PNG, WEBP ou PDF.', 415);
  const arquivo = `${crypto.randomBytes(20).toString('hex')}.${tipo.ext}`;
  fs.mkdirSync(config.arquivos, { recursive: true });
  fs.writeFileSync(path.join(config.arquivos, arquivo), conteudo, { flag: 'wx', mode: 0o600 });
  const nomeLimpo = String(nome || `arquivo.${tipo.ext}`).replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 120);
  const r = db.prepare(`INSERT INTO anexos (organizacao_id, recurso, recurso_id, nome, mime, tamanho, sha256, arquivo, enviado_por, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.usuario.organizacao_id, recurso, recursoId, nomeLimpo, tipo.mime, conteudo.length, sha256(conteudo), arquivo, req.usuario.id, agora());
  return { id: Number(r.lastInsertRowid), nome: nomeLimpo, mime: tipo.mime, tamanho: conteudo.length };
}

/** O usuário pode abrir este anexo? Depende do recurso a que ele pertence (e, para o técnico, se o recurso é dele). */
function podeVer(db, usuario, a) {
  if (a.organizacao_id !== usuario.organizacao_id) return false;
  const p = usuario.perfil;
  switch (a.recurso) {
    case 'chamado': {
      if (!pode(p, 'chamados.ver')) return false;
      if (p !== 'tecnico') return true;
      return Boolean(db.prepare('SELECT 1 FROM chamados WHERE id = ? AND organizacao_id = ? AND (tecnico_id = ? OR id IN (SELECT chamado_id FROM chamado_equipe WHERE tecnico_id = ?))')
        .get(a.recurso_id, a.organizacao_id, usuario.tecnico_id ?? -1, usuario.tecnico_id ?? -1));
    }
    case 'abastecimento': return pode(p, 'combustivel.comprovantes') || a.enviado_por === usuario.id;
    case 'veiculo_documento': return pode(p, 'frota.documentos');
    case 'manutencao': return pode(p, 'manutencao.ver');
    case 'comissao_pagamento': return pode(p, 'comissoes.pagar');
    case 'ativo': return pode(p, 'rede.ver');
    default: return false;
  }
}

/** Link temporário (assinado) para abrir o arquivo no navegador sem enviar o token da sessão. */
function linkTemporario(a, usuarioId) {
  const exp = Math.floor(Date.now() / 1000) + config.linkAnexoSegundos;
  const dados = `${a.id}.${usuarioId}.${exp}`;
  return { url: `/api/arquivos/${a.id}?u=${usuarioId}&e=${exp}&s=${assinar(`anexo:${dados}`)}`, expira_em: new Date(exp * 1000).toISOString() };
}

function conferirLink(id, u, e, s) {
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const esperado = Buffer.from(assinar(`anexo:${Number(id)}.${Number(u)}.${exp}`));
  const recebido = Buffer.from(String(s ?? ''));
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}

/** Conteúdo do arquivo, conferido pelo SHA-256 gravado no envio. */
function conteudo(a) {
  const b = fs.readFileSync(path.join(config.arquivos, path.basename(a.arquivo)));
  if (sha256(b) !== a.sha256) throw new ErroNegocio('O arquivo foi alterado ou corrompido no armazenamento.', 500);
  return b;
}

/** Associa anexos enviados antes da criação do registro (recurso_id nulo) ao registro criado. */
function vincular(db, req, recurso, recursoId, anexoId) {
  if (!anexoId) return null;
  const a = db.prepare('SELECT * FROM anexos WHERE id = ? AND organizacao_id = ? AND recurso = ?').get(Number(anexoId), req.usuario.organizacao_id, recurso);
  if (!a) throw new ErroNegocio('Anexo não encontrado.', 422);
  if (a.recurso_id !== null && a.recurso_id !== recursoId) throw new ErroNegocio('Este anexo já pertence a outro registro.', 409);
  db.prepare('UPDATE anexos SET recurso_id = ? WHERE id = ?').run(recursoId, a.id);
  return a.id;
}

module.exports = { salvar, podeVer, linkTemporario, conferirLink, conteudo, detectarTipo, vincular };
