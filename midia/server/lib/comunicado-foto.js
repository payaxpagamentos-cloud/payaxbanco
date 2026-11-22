'use strict';

/**
 * Foto do comunicado: a imagem que cobre o espaço do recado na TV (a assembleia, o elevador em
 * manutenção, a fachada). Sem foto, a TV desenha uma ilustração do tipo do recado — nunca fica só texto.
 */
const fs = require('node:fs');
const arquivos = require('./arquivos');
const { naoEncontrado } = require('./erros');
const { registrar } = require('./auditoria');

/** Troca a foto (arquivo no corpo). `onde` filtra o comunicado (o ponto só mexe nos dele). */
function salvar(db, req, c, acao) {
  if (!c) throw naoEncontrado('Comunicado');
  // Foto de celular passa fácil de 3 MB: o limite aqui é maior que o do logo.
  const img = arquivos.salvarImagem(req.body, 8 * 1024 * 1024);
  db.prepare('UPDATE comunicados SET imagem_arquivo = ?, imagem_mime = ? WHERE id = ?').run(img.arquivo, img.mime, c.id);
  if (c.imagem_arquivo) arquivos.remover({ arquivo: c.imagem_arquivo });
  registrar(db, req, acao, { id: c.id, bytes: img.bytes });
  return { ok: true, largura: img.largura ?? null, altura: img.altura ?? null };
}

function remover(db, req, c, acao) {
  if (!c?.imagem_arquivo) throw naoEncontrado('Foto do comunicado');
  db.prepare('UPDATE comunicados SET imagem_arquivo = NULL, imagem_mime = NULL WHERE id = ?').run(c.id);
  arquivos.remover({ arquivo: c.imagem_arquivo });
  registrar(db, req, acao, { id: c.id });
}

function enviar(res, c) {
  if (!c?.imagem_arquivo) throw naoEncontrado('Foto do comunicado');
  res.set({ 'Content-Type': c.imagem_mime, 'Cache-Control': 'private, max-age=86400' });
  fs.createReadStream(arquivos.caminho({ arquivo: c.imagem_arquivo })).pipe(res);
}

module.exports = { salvar, remover, enviar };
