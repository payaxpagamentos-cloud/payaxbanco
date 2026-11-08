'use strict';

const { Router, raw } = require('express');
const config = require('../config');
const { autenticarPortal, emitirTokenPortal, emitirDesafio2fa, lerToken } = require('../auth');
const { verificarSenha, hashSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { resumoEmpresa } = require('../lib/resumo');
const aprov = require('../lib/aprovacao');
const docs = require('../lib/documentos');
const rel = require('../lib/relatorios');
const lanc = require('../lib/lancamentos');
const dois = require('../lib/doisfatores');
const msgs = require('./mensagens');
const v = require('../lib/validacao');

const HASH_FALSO = hashSenha('senha-inexistente');
const publico = (r, e) => ({ id: r.id, nome: r.nome, email: r.email, cargo: r.cargo, pode_aprovar: Boolean(r.pode_aprovar),
  limite_aprovacao_centavos: r.limite_aprovacao_centavos, totp_ativo: Boolean(r.totp_ativo), precisa_trocar_senha: Boolean(r.precisa_trocar_senha),
  empresa: e && { id: e.id, nome: e.nome_fantasia || e.razao_social, razao_social: e.razao_social, cnpj: e.cnpj } });

/** Portal do Cliente: o responsável da empresa vê os números, aprova pagamentos, envia documentos e conversa com a equipe. */
module.exports = (db) => {
  const r = Router();
  const auth = autenticarPortal(db);
  const empresaDe = (resp) => db.prepare('SELECT * FROM empresas WHERE id = ?').get(resp.empresa_id);

  r.post('/auth/login', (req, res) => {
    const email = v.texto(req.body.email, 120);
    const x = email && db.prepare(`SELECT r.* FROM responsaveis r JOIN empresas e ON e.id = r.empresa_id
      WHERE r.email = ? COLLATE NOCASE AND r.acesso_portal = 1 AND r.ativo = 1 AND e.status IN ('ativa','implantacao')`).get(email);
    const ok = verificarSenha(String(req.body.senha ?? ''), x?.senha_hash ?? HASH_FALSO);
    if (!x || !ok) {
      registrar(db, { ip: req.ip, responsavel: x }, 'portal_login_falhou', { email });
      throw new ErroNegocio('E-mail ou senha incorretos.', 401);
    }
    if (x.totp_ativo) return res.json({ precisa_2fa: true, desafio: emitirDesafio2fa(x.id, 'portal') });
    entrar(req, res, x);
  });
  r.post('/auth/2fa/login', (req, res) => {
    const d = lerToken(req.body.desafio, '2fa-portal');
    if (!d) throw new ErroNegocio('Tempo esgotado. Entre com a senha novamente.', 401);
    const x = db.prepare('SELECT * FROM responsaveis WHERE id = ? AND acesso_portal = 1 AND ativo = 1').get(d.sub);
    if (!x || !dois.conferir(db, 'responsaveis', x.id, req.body.codigo)) throw new ErroNegocio('Código inválido.', 401);
    entrar(req, res, x);
  });
  function entrar(req, res, x) {
    db.prepare("UPDATE responsaveis SET ultimo_acesso = datetime('now') WHERE id = ?").run(x.id);
    registrar(db, { ip: req.ip, responsavel: x }, 'portal_login');
    res.json({ token: emitirTokenPortal(x), responsavel: publico(x, empresaDe(x)) });
  }

  r.get('/auth/me', auth, (req, res) => res.json({ responsavel: publico(req.responsavel, req.empresa) }));
  // Troca de senha (obrigatória no primeiro acesso, com a senha provisória).
  r.post('/auth/senha', (req, res, next) => {
    const d = lerToken((req.get('authorization') || '').slice(7), 'portal');
    const x = d && db.prepare('SELECT * FROM responsaveis WHERE id = ? AND acesso_portal = 1 AND ativo = 1').get(d.sub);
    if (!x) return next(new ErroNegocio('Sessão expirada. Entre novamente.', 401));
    if (!verificarSenha(String(req.body.senha_atual ?? ''), x.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 422);
    const nova = String(req.body.nova_senha ?? '');
    v.exigir(nova.length >= 8 && /\d/.test(nova) && /[a-zA-Z]/.test(nova), 'A nova senha deve ter 8 caracteres ou mais, com letras e números.');
    v.exigir(nova !== req.body.senha_atual, 'A nova senha deve ser diferente da atual.');
    db.prepare('UPDATE responsaveis SET senha_hash = ?, precisa_trocar_senha = 0 WHERE id = ?').run(hashSenha(nova), x.id);
    registrar(db, { ip: req.ip, responsavel: x }, 'portal_senha_alterada');
    res.status(204).end();
  });
  r.post('/auth/2fa/iniciar', auth, async (req, res) => res.json(await dois.iniciar(db, 'responsaveis', req.responsavel, req.responsavel.email)));
  r.post('/auth/2fa/ativar', auth, (req, res) => {
    dois.ativar(db, 'responsaveis', req.responsavel, req.body.codigo);
    registrar(db, req, 'portal_2fa_ativada');
    res.status(204).end();
  });
  r.post('/auth/2fa/desativar', auth, (req, res) => {
    dois.desativar(db, 'responsaveis', req.responsavel.id, req.body.senha, req.body.codigo);
    registrar(db, req, 'portal_2fa_desativada');
    res.status(204).end();
  });

  r.use(auth);
  const eid = (req) => req.empresa.id;

  r.get('/resumo', (req, res) => {
    const x = resumoEmpresa(db, eid(req));
    res.json({ ...x, mensagens_nao_lidas: db.prepare("SELECT COUNT(*) AS n FROM mensagens WHERE empresa_id = ? AND autor = 'equipe' AND lida_em IS NULL").get(eid(req)).n });
  });

  // Aprovações: o que aguarda a autorização da empresa.
  r.get('/aprovacoes', (req, res) => {
    const itens = aprov.fila(db, eid(req), req.query.status || 'pendente').map((l) => ({ ...l, dentro_do_limite: aprov.cabe(req.responsavel.limite_aprovacao_centavos, l.valor_centavos) }));
    res.json({ pode_aprovar: Boolean(req.responsavel.pode_aprovar), limite_centavos: req.responsavel.limite_aprovacao_centavos, itens });
  });
  r.get('/aprovacoes/:id', (req, res) => {
    const l = lanc.buscar(db, eid(req), req.params.id);
    v.exigir(l.tipo === 'pagar', 'Lançamento inválido.');
    res.json({ ...l, historico: aprov.historico(db, l.id), documentos: docs.listar(db, eid(req), { lancamento_id: l.id }) });
  });
  for (const [rota, aprovar] of [['aprovar', true], ['recusar', false]]) {
    r.post(`/aprovacoes/:id/${rota}`, (req, res) => {
      aprov.decidir(db, { responsavel: req.responsavel }, eid(req), req.params.id, aprovar, req.body.comentario);
      registrar(db, req, aprovar ? 'portal_pagamento_aprovado' : 'portal_pagamento_recusado', { id: Number(req.params.id), comentario: req.body.comentario });
      res.status(204).end();
    });
  }

  // Documentos: o cliente envia notas, boletos e contratos; baixa os da empresa.
  r.get('/documentos', (req, res) => res.json(docs.listar(db, eid(req), req.query)));
  r.post('/documentos', raw({ type: () => true, limit: config.tamanhoMaximoArquivo }), (req, res) => {
    const id = docs.salvar(db, eid(req), req.body, { ...req.query, lancamento_id: req.query.lancamento_id || null }, { responsavel_id: req.responsavel.id });
    registrar(db, req, 'portal_documento_enviado', { id, nome: req.query.nome, tipo: req.query.tipo });
    res.status(201).json({ id });
  });
  r.get('/documentos/:id/arquivo', (req, res) => docs.enviar(res, docs.buscar(db, eid(req), req.params.id)));

  // Relatórios (somente leitura).
  r.get('/dre', (req, res) => res.json(rel.dre(db, eid(req), req.query)));
  r.get('/fluxo-caixa', (req, res) => res.json(rel.fluxoCaixa(db, eid(req), req.query)));
  r.get('/lancamentos', (req, res) => {
    const tipo = req.query.tipo === 'receber' ? 'receber' : 'pagar';
    res.json(db.prepare(`SELECT l.id, l.tipo, l.descricao, l.valor_centavos, l.vencimento, l.status, l.pago_em, l.aprovacao, c.nome AS contato_nome
      FROM lancamentos l LEFT JOIN contatos c ON c.id = l.contato_id WHERE l.empresa_id = ? AND l.tipo = ? AND l.status = 'aberto'
      ORDER BY l.vencimento LIMIT 200`).all(eid(req), tipo).map((l) => ({ ...l, situacao: lanc.situacao(l) })));
  });

  r.get('/mensagens', (req, res) => res.json(msgs.listar(db, eid(req), 'cliente')));
  r.post('/mensagens', (req, res) => res.status(201).json({ id: msgs.enviar(db, eid(req), 'cliente', req.responsavel.id, req.body.texto) }));

  return r;
};
