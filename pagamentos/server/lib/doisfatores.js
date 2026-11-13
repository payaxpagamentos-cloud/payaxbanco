'use strict';

/*
 * Autenticação em duas etapas por aplicativo (TOTP), igual para a equipe e para o Internet Bank.
 * Quem aprova e envia repasse movimenta dinheiro de terceiros: uma senha só é pouco.
 */
const QRCode = require('qrcode');
const totp = require('./totp');
const { ErroNegocio } = require('./erros');
const { verificarSenha } = require('./senha');
const { agora } = require('../db');

const TABELAS = { equipe: 'usuarios', cliente: 'usuarios_cliente' };
const tabela = (tipo) => TABELAS[tipo] ?? TABELAS.equipe;

const parametro = (db, chave, padrao = null) => db.prepare('SELECT valor FROM parametros WHERE chave = ?').get(chave)?.valor ?? padrao;
const gravarParametro = (db, chave, valor) => db.prepare(
  'INSERT INTO parametros (chave, valor, atualizado_em) VALUES (?, ?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em',
).run(chave, valor, agora());

/** A equipe é obrigada a usar 2FA? (ligado pelo administrador em Segurança.) */
const exigidaEquipe = (db) => parametro(db, 'exigir_2fa_equipe') === '1';
const definirExigencia = (db, exigir) => gravarParametro(db, 'exigir_2fa_equipe', exigir ? '1' : '0');

/** Gera um segredo novo (ainda inativo) e devolve o QR Code para o aplicativo. */
async function iniciar(db, tipo, registro, conta) {
  if (registro.totp_ativo) throw new ErroNegocio('A autenticação em duas etapas já está ativa.', 422);
  const segredo = totp.novoSegredo();
  db.prepare(`UPDATE ${tabela(tipo)} SET totp_segredo = ?, totp_ativo = 0, totp_ultimo_passo = NULL WHERE id = ?`).run(segredo, registro.id);
  const uri = totp.uri(segredo, conta);
  return { segredo, uri, qr_svg: await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
}

/** Confere o código e grava o passo usado — o mesmo código não serve duas vezes. */
function conferir(db, tipo, id, codigo) {
  const r = db.prepare(`SELECT totp_segredo, totp_ultimo_passo FROM ${tabela(tipo)} WHERE id = ?`).get(id);
  const passo = totp.verificar(r?.totp_segredo, codigo, r?.totp_ultimo_passo ?? null);
  if (passo === null) return false;
  db.prepare(`UPDATE ${tabela(tipo)} SET totp_ultimo_passo = ? WHERE id = ?`).run(passo, id);
  return true;
}

function ativar(db, tipo, registro, codigo) {
  const r = db.prepare(`SELECT totp_segredo, totp_ativo FROM ${tabela(tipo)} WHERE id = ?`).get(registro.id);
  if (r.totp_ativo) throw new ErroNegocio('A autenticação em duas etapas já está ativa.', 422);
  if (!r.totp_segredo) throw new ErroNegocio('Inicie a configuração primeiro.', 422);
  if (!conferir(db, tipo, registro.id, codigo)) throw new ErroNegocio('Código inválido. Confira o horário do celular e tente de novo.', 422);
  db.prepare(`UPDATE ${tabela(tipo)} SET totp_ativo = 1 WHERE id = ?`).run(registro.id);
}

/** Desligar exige a senha E um código atual: só quem tem o celular na mão desliga. */
function desativar(db, tipo, id, senha, codigo) {
  const r = db.prepare(`SELECT senha_hash, totp_ativo FROM ${tabela(tipo)} WHERE id = ?`).get(id);
  if (!r?.totp_ativo) throw new ErroNegocio('A autenticação em duas etapas não está ativa.', 422);
  if (!verificarSenha(String(senha ?? ''), r.senha_hash)) throw new ErroNegocio('Senha incorreta.', 422);
  if (!conferir(db, tipo, id, codigo)) throw new ErroNegocio('Código inválido.', 422);
  db.prepare(`UPDATE ${tabela(tipo)} SET totp_ativo = 0, totp_segredo = NULL, totp_ultimo_passo = NULL WHERE id = ?`).run(id);
}

/** O administrador redefine o 2FA de quem perdeu o celular (fica registrado na auditoria). */
function redefinir(db, tipo, id) {
  const r = db.prepare(`UPDATE ${tabela(tipo)} SET totp_ativo = 0, totp_segredo = NULL, totp_ultimo_passo = NULL WHERE id = ?`).run(id);
  if (!r.changes) throw new ErroNegocio('Usuário não encontrado.', 404);
}

module.exports = { iniciar, conferir, ativar, desativar, redefinir, exigidaEquipe, definirExigencia, parametro, gravarParametro };
