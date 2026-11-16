'use strict';

/*
 * Ativação do acesso à Área do Cliente, pelo próprio cliente (acesso.payax.com.br).
 *
 * Depois de a conta ser aberta, a equipe manda um link ao responsável. Nele o cliente vê o protocolo do
 * pedido, o número da conta e o código do usuário (o e-mail com que ele entra) e cria a senha: digita a
 * dele ou aperta "Gerar" para o sistema sugerir uma forte. Ninguém da PAY AX vê a senha.
 *
 * Segurança:
 *   - o código do link tem 256 bits aleatórios e só o resumo SHA-256 dele fica guardado;
 *   - vale `config.ativacaoDias` dias e uma vez só; gerar outro cancela o anterior;
 *   - para criar a senha, o cliente confirma o CNPJ da empresa; 5 erros cancelam o link;
 *   - o código vai depois do "#" no endereço, para não aparecer em registro de servidor nem em "Referer".
 */
const crypto = require('node:crypto');
const config = require('../config');
const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const { hashSenha } = require('./senha');
const contaInterna = require('./contaInterna');

const MAX_TENTATIVAS = 5;
const resumo = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const so = (x) => String(x ?? '').replace(/\D/g, '');

/** Endereço da página de ativação (sem o código). */
function base() {
  if (config.acessoHosts.length) return `https://${config.acessoHosts[0]}/`;
  return `${config.urlPublica || ''}${config.basePath || ''}/ativar`;
}

/** Senha que o sistema nunca entrega a ninguém: o acesso só funciona depois de o cliente criar a dele. */
const senhaInutil = () => hashSenha(crypto.randomBytes(32).toString('base64url'));

/**
 * Gera o link de ativação de um acesso (cancela os anteriores ainda não usados). Devolve o link completo
 * — mostrado uma única vez à equipe — e a validade.
 */
function gerar(db, usuarioClienteId, { criadoPor = null, solicitacaoId = null } = {}) {
  const u = db.prepare('SELECT * FROM usuarios_cliente WHERE id = ?').get(usuarioClienteId);
  if (!u) throw new ErroNegocio('Acesso não encontrado.', 404);
  if (!u.ativo) throw new ErroNegocio('O acesso está desativado: reative antes de gerar o link.', 409);
  const token = crypto.randomBytes(32).toString('base64url');
  const expira = new Date(Date.now() + config.ativacaoDias * 86_400_000).toISOString();
  transacao(db, () => {
    db.prepare('UPDATE ativacoes_acesso SET cancelado_em = ? WHERE usuario_cliente_id = ? AND usado_em IS NULL AND cancelado_em IS NULL')
      .run(agora(), u.id);
    const sol = solicitacaoId ?? db.prepare('SELECT id FROM solicitacoes_abertura WHERE cliente_id = ? ORDER BY id DESC LIMIT 1').get(u.cliente_id)?.id ?? null;
    db.prepare(`INSERT INTO ativacoes_acesso (usuario_cliente_id, solicitacao_id, token_hash, criado_em, criado_por, expira_em)
      VALUES (?, ?, ?, ?, ?, ?)`).run(u.id, sol, resumo(token), agora(), criadoPor, expira);
  });
  return { link: `${base()}#t=${token}`, expira_em: expira, email: u.email, nome: u.nome };
}

/** Acha o link pelo código e confere se ainda vale. */
function valido(db, token) {
  if (!token || String(token).length < 20) throw new ErroNegocio('Link de ativação inválido.', 404);
  const a = db.prepare(`SELECT a.*, u.nome, u.email, u.ativo, u.cliente_id, c.razao_social, c.nome_fantasia, c.cnpj, c.situacao,
      c.agencia_interna, c.conta_interna, c.conta_interna_dv
    FROM ativacoes_acesso a JOIN usuarios_cliente u ON u.id = a.usuario_cliente_id JOIN clientes c ON c.id = u.cliente_id
    WHERE a.token_hash = ?`).get(resumo(token));
  if (!a) throw new ErroNegocio('Link de ativação inválido. Peça um novo à equipe PAY AX.', 404);
  if (a.usado_em) throw new ErroNegocio('Este link já foi usado: o acesso já está ativo. Entre com o seu e-mail e a senha que você criou.', 410);
  if (a.cancelado_em) throw new ErroNegocio('Este link foi substituído ou cancelado. Use o link mais recente enviado pela PAY AX.', 410);
  if (a.expira_em < agora()) throw new ErroNegocio('Este link venceu. Peça um novo à equipe PAY AX.', 410);
  if (!a.ativo || a.situacao === 'encerrado') throw new ErroNegocio('Este acesso não está disponível. Fale com a equipe PAY AX.', 410);
  return a;
}

const protocolo = (id) => (id ? `AB-${String(id).padStart(6, '0')}` : null);
const mascararCnpj = (c) => { const d = so(c); return d.length === 14 ? `${d.slice(0, 2)}.***.***/****-${d.slice(12)}` : '—'; };

/** O que a página mostra antes de criar a senha (sem dado que permita ativar sem saber o CNPJ). */
function consultar(db, token) {
  const a = valido(db, token);
  return {
    protocolo: protocolo(a.solicitacao_id),
    conta: contaInterna.formatar(a.agencia_interna, a.conta_interna, a.conta_interna_dv),
    empresa: a.nome_fantasia || a.razao_social,
    cnpj_mascarado: mascararCnpj(a.cnpj),
    nome: a.nome,
    codigo_usuario: a.email,
    expira_em: a.expira_em,
  };
}

/** Regra da senha criada pelo cliente: 8 a 128 caracteres, com letra e número. */
function conferirSenha(senha) {
  const s = String(senha ?? '');
  if (s.length < 8) throw new ErroNegocio('A senha precisa ter pelo menos 8 caracteres.', 422);
  if (s.length > 128) throw new ErroNegocio('Senha longa demais (máximo de 128 caracteres).', 422);
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw new ErroNegocio('Use letras e números na senha.', 422);
  return s;
}

/** Cria a senha e ativa o acesso. Devolve onde entrar. */
function ativar(db, token, { cnpj, senha, ip = null }) {
  const a = valido(db, token);
  if (so(cnpj) !== so(a.cnpj)) {
    const t = a.tentativas + 1;
    db.prepare(`UPDATE ativacoes_acesso SET tentativas = ?, cancelado_em = CASE WHEN ? >= ? THEN ? END WHERE id = ?`)
      .run(t, t, MAX_TENTATIVAS, agora(), a.id);
    if (t >= MAX_TENTATIVAS) throw new ErroNegocio('CNPJ não confere. Por segurança, este link foi cancelado: peça um novo à equipe PAY AX.', 410);
    throw new ErroNegocio(`O CNPJ não confere com o da empresa. Restam ${MAX_TENTATIVAS - t} tentativa(s).`, 422);
  }
  const s = conferirSenha(senha);
  transacao(db, () => {
    db.prepare('UPDATE usuarios_cliente SET senha_hash = ?, senha_provisoria = 0 WHERE id = ?').run(hashSenha(s), a.usuario_cliente_id);
    db.prepare('UPDATE ativacoes_acesso SET usado_em = ?, ip_uso = ? WHERE id = ?').run(agora(), ip, a.id);
  });
  return {
    codigo_usuario: a.email,
    entrar_em: config.siteHosts.length ? `https://${config.siteHosts[0]}/` : `${config.urlPublica || ''}${config.clientePath}/`,
    usuario_cliente_id: a.usuario_cliente_id,
    cliente_id: a.cliente_id,
  };
}

/** Cancela os links ainda não usados de um acesso (senha redefinida ou acesso desativado). */
const cancelar = (db, usuarioClienteId) => db.prepare('UPDATE ativacoes_acesso SET cancelado_em = ? WHERE usuario_cliente_id = ? AND usado_em IS NULL AND cancelado_em IS NULL')
  .run(agora(), usuarioClienteId).changes;

module.exports = { cancelar, gerar, consultar, ativar, conferirSenha, senhaInutil, base, MAX_TENTATIVAS };
