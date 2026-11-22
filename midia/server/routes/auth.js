'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { agora, lerConfig } = require('../db');
const { emitirToken } = require('../auth');
const { hashSenha, verificarSenha, gastarTempo } = require('../lib/senha');

// Senha errada este número de vezes seguidas trava a conta por um tempo (não importa de onde venha).
const MAX_FALHAS = 8;
const BLOQUEIO_MINUTOS = 15;
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const email = require('../lib/email');
const v = require('../lib/validacao');

/** Guardamos só o resumo do código do link (nunca o código em si). */
const hashCodigo = (codigo) => crypto.createHash('sha256').update(String(codigo)).digest('hex');

const publico = (u) => ({
  id: u.id, nome: u.nome, email: u.email, perfil: u.perfil,
  anunciante_id: u.anunciante_id ?? null, anunciante_nome: u.anunciante_nome ?? null,
  local_id: u.local_id ?? null, local_nome: u.local_nome ?? null,
  empresa_id: u.empresa_id ?? null, empresa_nome: u.empresa_nome ?? null,
});

/** Login e a própria conta. Não há cadastro aberto: a equipe cria os acessos do anunciante e do lojista. */
module.exports = (db, autenticado) => {
  const r = Router();

  r.post('/login', (req, res) => {
    const u = db.prepare(`SELECT u.*, a.nome AS anunciante_nome, a.status AS anunciante_status, l.nome AS local_nome, l.status AS local_status,
        e.nome AS empresa_nome, e.ativo AS empresa_ativa
      FROM usuarios u LEFT JOIN anunciantes a ON a.id = u.anunciante_id LEFT JOIN locais l ON l.id = u.local_id
      LEFT JOIN empresas e ON e.id = u.empresa_id WHERE u.email = ?`)
      .get(String(req.body.email ?? '').trim());
    const senha = String(req.body.senha ?? '');
    const falhou = () => {
      registrar(db, req, 'login_falhou', { email: String(req.body.email ?? '').slice(0, 160) });
      throw new ErroNegocio('E-mail ou senha incorretos.', 401);
    };
    if (!u) { gastarTempo(senha); falhou(); }
    if (u.bloqueado_ate && u.bloqueado_ate > agora()) {
      throw new ErroNegocio(`Muitas tentativas com senha errada. Aguarde ${BLOQUEIO_MINUTOS} minutos ou use "Esqueci minha senha".`, 429);
    }
    if (!verificarSenha(senha, u.senha_hash)) {
      const falhas = u.falhas + 1;
      const trava = falhas >= MAX_FALHAS ? new Date(Date.now() + BLOQUEIO_MINUTOS * 60_000).toISOString() : null;
      db.prepare('UPDATE usuarios SET falhas = ?, bloqueado_ate = ? WHERE id = ?').run(trava ? 0 : falhas, trava, u.id);
      if (trava) registrar(db, { usuario: u, ip: req.ip }, 'conta_bloqueada', { minutos: BLOQUEIO_MINUTOS });
      falhou();
    }
    if (!u.ativo) throw new ErroNegocio('Usuário desativado. Fale com a equipe.', 403);
    if (u.anunciante_id && u.anunciante_status !== 'ativo') throw new ErroNegocio('Anunciante inativo. Fale com a equipe.', 403);
    if (u.local_id && u.local_status === 'encerrado') throw new ErroNegocio('Ponto encerrado. Fale com a equipe.', 403);
    if (u.empresa_id && u.empresa_ativa === 0) throw new ErroNegocio('Empresa desativada. Fale com o administrador do sistema.', 403);
    db.prepare('UPDATE usuarios SET ultimo_acesso = ?, falhas = 0, bloqueado_ate = NULL WHERE id = ?').run(agora(), u.id);
    registrar(db, { usuario: u, ip: req.ip }, 'login');
    res.json({ token: emitirToken(u), usuario: publico(u) });
  });

  r.get('/me', autenticado, (req, res) => res.json({ usuario: publico(req.usuario) }));

  /**
   * "Esqueci minha senha": manda um link de uso único, válido por uma hora.
   * A resposta é sempre a mesma, exista ou não a conta — assim ninguém descobre quem tem acesso à plataforma.
   */
  r.post('/recuperar', async (req, res) => {
    const alvo = String(req.body.email ?? '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM usuarios WHERE email = ? AND ativo = 1').get(alvo);
    const resposta = { ok: true, aviso: 'Se existir uma conta com esse e-mail, o link chega em alguns minutos.' };
    // Conferido antes de olhar a conta: a resposta é a mesma, exista o e-mail ou não.
    if (!email.configurado()) throw new ErroNegocio('O envio de e-mails não está configurado. Peça uma senha nova à equipe.', 503);
    if (!u) {
      registrar(db, req, 'senha_recuperar_desconhecido', { email: alvo.slice(0, 160) });
      return res.json(resposta);
    }
    const codigo = crypto.randomBytes(32).toString('base64url');
    db.prepare('UPDATE senha_pedidos SET usado_em = ? WHERE usuario_id = ? AND usado_em IS NULL').run(agora(), u.id);
    db.prepare('INSERT INTO senha_pedidos (usuario_id, codigo_hash, expira_em, ip, criado_em) VALUES (?, ?, ?, ?, ?)')
      .run(u.id, hashCodigo(codigo), new Date(Date.now() + 3_600_000).toISOString(), req.ip ?? null, agora());

    const cfg = lerConfig(db);
    await email.enviar({
      para: u.email,
      assunto: 'Criar uma nova senha',
      plataforma: cfg.nome_plataforma,
      titulo: 'Criar uma nova senha',
      linhas: [`Olá, ${u.nome}. Alguém pediu uma nova senha para a sua conta.`,
        'O link abaixo vale por uma hora e só funciona uma vez. Se não foi você, pode ignorar — sua senha continua a mesma.'],
      botao: { texto: 'Criar nova senha', url: email.linkPainel(`#/nova-senha/${codigo}`) },
    });
    registrar(db, { usuario: u, ip: req.ip }, 'senha_recuperar_enviado');
    res.json(resposta);
  });

  /** Troca a senha com o código do e-mail. */
  r.post('/nova-senha', (req, res) => {
    const codigo = String(req.body.codigo ?? '');
    const senha = v.senha(req.body.senha);
    const pedido = db.prepare(`SELECT p.*, u.email, u.nome FROM senha_pedidos p JOIN usuarios u ON u.id = p.usuario_id
      WHERE p.codigo_hash = ? AND p.usado_em IS NULL`).get(hashCodigo(codigo));
    if (!pedido || pedido.expira_em < agora()) throw new ErroNegocio('Este link não vale mais. Peça outro na tela de entrada.', 410);
    db.prepare('UPDATE usuarios SET senha_hash = ?, sessao_versao = sessao_versao + 1, falhas = 0, bloqueado_ate = NULL WHERE id = ?').run(hashSenha(senha), pedido.usuario_id);
    db.prepare('UPDATE senha_pedidos SET usado_em = ? WHERE id = ?').run(agora(), pedido.id);
    registrar(db, { usuario: { id: pedido.usuario_id }, ip: req.ip }, 'senha_trocada_por_link');
    res.json({ ok: true, email: pedido.email });
  });

  r.post('/senha', autenticado, (req, res) => {
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body.atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 422);
    db.prepare('UPDATE usuarios SET senha_hash = ?, sessao_versao = sessao_versao + 1 WHERE id = ?').run(hashSenha(v.senha(req.body.nova)), req.usuario.id);
    registrar(db, req, 'senha_alterada');
    // Os outros aparelhos saem; quem trocou continua com um acesso novo.
    res.json({ token: emitirToken(db.prepare('SELECT id, sessao_versao FROM usuarios WHERE id = ?').get(req.usuario.id)) });
  });

  return r;
};
