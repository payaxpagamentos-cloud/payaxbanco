'use strict';

const QRCode = require('qrcode');
const totp = require('./totp');
const { ErroNegocio } = require('./erros');
const { verificarSenha } = require('./senha');

/** 2FA por aplicativo, igual para a equipe (usuarios) e para o Portal (responsaveis). */
const TABELAS = { usuarios: 'usuarios', responsaveis: 'responsaveis' };

const config = (db, chave, padrao = null) => db.prepare('SELECT valor FROM configuracoes WHERE chave = ?').get(chave)?.valor ?? padrao;
const exigidaEquipe = (db) => config(db, 'exigir_2fa_equipe') === '1';

/** Gera um segredo novo (ainda inativo) e devolve o QR Code para o aplicativo. */
async function iniciar(db, tabela, registro, conta) {
  if (registro.totp_ativo) throw new ErroNegocio('A autenticação em duas etapas já está ativa.', 422);
  const segredo = totp.novoSegredo();
  db.prepare(`UPDATE ${TABELAS[tabela]} SET totp_segredo = ?, totp_ativo = 0, totp_ultimo_passo = NULL WHERE id = ?`).run(segredo, registro.id);
  const uri = totp.uri(segredo, conta);
  return { segredo, uri, qr_svg: await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
}

/** Confere o código e grava o passo usado (o mesmo código não serve duas vezes). */
function conferir(db, tabela, id, codigo) {
  const r = db.prepare(`SELECT totp_segredo, totp_ultimo_passo FROM ${TABELAS[tabela]} WHERE id = ?`).get(id);
  const passo = totp.verificar(r?.totp_segredo, codigo, r?.totp_ultimo_passo ?? null);
  if (passo === null) return false;
  db.prepare(`UPDATE ${TABELAS[tabela]} SET totp_ultimo_passo = ? WHERE id = ?`).run(passo, id);
  return true;
}

function ativar(db, tabela, registro, codigo) {
  const r = db.prepare(`SELECT totp_segredo, totp_ativo FROM ${TABELAS[tabela]} WHERE id = ?`).get(registro.id);
  if (r.totp_ativo) throw new ErroNegocio('A autenticação em duas etapas já está ativa.', 422);
  if (!r.totp_segredo) throw new ErroNegocio('Inicie a configuração primeiro.', 422);
  if (!conferir(db, tabela, registro.id, codigo)) throw new ErroNegocio('Código inválido. Confira o horário do celular e tente de novo.', 422);
  db.prepare(`UPDATE ${TABELAS[tabela]} SET totp_ativo = 1 WHERE id = ?`).run(registro.id);
}

/** Desativar exige a senha e um código atual. */
function desativar(db, tabela, id, senha, codigo) {
  const r = db.prepare(`SELECT senha_hash, totp_ativo FROM ${TABELAS[tabela]} WHERE id = ?`).get(id);
  if (!r.totp_ativo) throw new ErroNegocio('A autenticação em duas etapas não está ativa.', 422);
  if (!verificarSenha(String(senha ?? ''), r.senha_hash)) throw new ErroNegocio('Senha incorreta.', 422);
  if (!conferir(db, tabela, id, codigo)) throw new ErroNegocio('Código inválido.', 422);
  db.prepare(`UPDATE ${TABELAS[tabela]} SET totp_ativo = 0, totp_segredo = NULL, totp_ultimo_passo = NULL WHERE id = ?`).run(id);
}

module.exports = { iniciar, conferir, ativar, desativar, exigidaEquipe, config };
