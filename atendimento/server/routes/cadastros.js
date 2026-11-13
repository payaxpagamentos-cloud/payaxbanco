'use strict';

const express = require('express');
const { agora, auditar } = require('../db');
const { exigirAdminEmpresa } = require('../auth');
const { naoEncontrado } = require('../lib/erros');
const empresasLib = require('../lib/empresas');
const ferramentasLib = require('../ia/ferramentas');
const filasLib = require('../lib/filas');
const wa = require('../lib/whatsapp');
const config = require('../config');
const v = require('../lib/validacao');

/** Cadastros do dia a dia da empresa: número de WhatsApp, chamados, respostas rápidas, etiquetas e chaves de API. */
module.exports = function rotasCadastros(db) {
  const r = express.Router();

  // ---------- Números de WhatsApp (Cloud API) ----------
  r.get('/numeros', (req, res) => {
    const base = config.basePath || '';
    res.json({
      itens: db.prepare('SELECT * FROM numeros WHERE empresa_id = ? ORDER BY id').all(req.empresa.id).map(empresasLib.numeroPublico),
      // O que a empresa precisa colar no painel da Meta.
      webhook: {
        url: `${process.env.ATEND_URL_PUBLICA ?? 'https://SEU-DOMINIO'}${base}/api/webhook`,
        campos: ['messages'],
        instrucoes: 'No app da Meta, em WhatsApp > Configuração, informe este endereço de callback e o token de verificação do número. '
          + 'Assine o campo "messages". O App secret fica em Configurações do app > Básico.',
      },
    });
  });

  r.post('/numeros', exigirAdminEmpresa, (req, res, next) => {
    try {
      const n = empresasLib.salvarNumero(db, req.empresa.id, req.body ?? {});
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'cadastrou número de WhatsApp', alvo: n.telefone, ip: req.ip });
      res.status(201).json(empresasLib.numeroPublico(n));
    } catch (err) { next(err); }
  });

  r.patch('/numeros/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const n = empresasLib.salvarNumero(db, req.empresa.id, req.body ?? {}, { id: Number(req.params.id) });
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'alterou número de WhatsApp', alvo: n.telefone, ip: req.ip });
      res.json(empresasLib.numeroPublico(n));
    } catch (err) { next(err); }
  });

  /** Confere com a Meta se o token e o Phone number ID funcionam. */
  r.get('/numeros/:id/situacao', async (req, res, next) => {
    try {
      const n = db.prepare('SELECT * FROM numeros WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!n) throw naoEncontrado('Número');
      res.json(await wa.situacao(n));
    } catch (err) { next(err); }
  });

  // ---------- Chamados ----------
  r.get('/chamados', (req, res) => {
    const onde = ['ch.empresa_id = ?'];
    const args = [req.empresa.id];
    if (req.query.status) { onde.push('ch.status = ?'); args.push(v.opcao(req.query.status, 'a situação', ['aberto', 'andamento', 'resolvido', 'cancelado'])); }
    if (req.query.busca) { onde.push('(ch.protocolo LIKE ? OR ch.assunto LIKE ? OR ct.telefone LIKE ? OR ct.nome LIKE ?)'); const t = `%${String(req.query.busca).trim()}%`; args.push(t, t, t, t); }
    res.json({
      itens: db.prepare(`SELECT ch.*, ct.telefone, COALESCE(ct.nome, ct.nome_perfil) AS contato_nome, f.nome AS fila_nome, u.nome AS usuario_nome
        FROM chamados ch JOIN contatos ct ON ct.id = ch.contato_id
        LEFT JOIN filas f ON f.id = ch.fila_id LEFT JOIN usuarios u ON u.id = ch.usuario_id
        WHERE ${onde.join(' AND ')} ORDER BY ch.id DESC LIMIT 200`).all(...args),
    });
  });

  r.post('/chamados', (req, res, next) => {
    try {
      const d = req.body ?? {};
      const contato = db.prepare('SELECT * FROM contatos WHERE id = ? AND empresa_id = ?').get(Number(d.contato_id), req.empresa.id);
      if (!contato) throw naoEncontrado('Contato');
      const protocolo = ferramentasLib.gerarProtocolo(db, req.empresa.id);
      const id = Number(db.prepare(`INSERT INTO chamados (empresa_id, conversa_id, contato_id, protocolo, assunto, descricao, fila_id, aberto_por, usuario_id, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'atendente', ?, ?)`)
        .run(req.empresa.id, d.conversa_id ? Number(d.conversa_id) : null, contato.id, protocolo,
          v.texto(d.assunto, 'o assunto', 160), v.opcional(d.descricao, 'a descrição', 4000),
          d.fila_id ? (filasLib.buscar(db, req.empresa.id, d.fila_id)?.id ?? null) : null, req.usuario.id, agora()).lastInsertRowid);
      res.status(201).json(db.prepare('SELECT * FROM chamados WHERE id = ?').get(id));
    } catch (err) { next(err); }
  });

  r.patch('/chamados/:id', (req, res, next) => {
    try {
      const ch = db.prepare('SELECT * FROM chamados WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!ch) throw naoEncontrado('Chamado');
      const d = req.body ?? {};
      const status = d.status === undefined ? ch.status : v.opcao(d.status, 'a situação', ['aberto', 'andamento', 'resolvido', 'cancelado']);
      if (['resolvido', 'cancelado'].includes(status) && status !== ch.status) v.exigir(d.resolucao ?? ch.resolucao, 'Escreva o que foi feito para fechar o chamado.');
      db.prepare('UPDATE chamados SET status = ?, assunto = ?, descricao = ?, fila_id = ?, resolucao = ?, usuario_id = ?, atualizado_em = ? WHERE id = ?')
        .run(status, d.assunto === undefined ? ch.assunto : v.texto(d.assunto, 'o assunto', 160),
          d.descricao === undefined ? ch.descricao : v.opcional(d.descricao, 'a descrição', 4000),
          d.fila_id === undefined ? ch.fila_id : (d.fila_id ? (filasLib.buscar(db, req.empresa.id, d.fila_id)?.id ?? null) : null),
          d.resolucao === undefined ? ch.resolucao : v.opcional(d.resolucao, 'a resolução', 4000), req.usuario.id, agora(), ch.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'alterou chamado', alvo: ch.protocolo, detalhe: status, ip: req.ip });
      res.json(db.prepare('SELECT * FROM chamados WHERE id = ?').get(ch.id));
    } catch (err) { next(err); }
  });

  // ---------- Respostas rápidas ----------
  r.get('/respostas-rapidas', (req, res) => res.json({
    itens: db.prepare('SELECT * FROM respostas_rapidas WHERE empresa_id = ? ORDER BY atalho').all(req.empresa.id).map((x) => ({ ...x, ativa: Boolean(x.ativa) })),
  }));

  const atalhoValido = (a) => {
    const t = String(a ?? '').trim().toLowerCase().replace(/^\//, '');
    v.exigir(/^[a-z0-9][a-z0-9-]{1,28}$/.test(t), 'Atalho inválido (letras minúsculas, números e -, de 2 a 29 caracteres).');
    return t;
  };

  r.post('/respostas-rapidas', (req, res, next) => {
    try {
      const d = req.body ?? {};
      const id = Number(db.prepare('INSERT INTO respostas_rapidas (empresa_id, atalho, titulo, texto, criada_em) VALUES (?, ?, ?, ?, ?)')
        .run(req.empresa.id, atalhoValido(d.atalho), v.texto(d.titulo, 'o título', 80), v.texto(d.texto, 'o texto', 4000), agora()).lastInsertRowid);
      res.status(201).json(db.prepare('SELECT * FROM respostas_rapidas WHERE id = ?').get(id));
    } catch (err) { next(err); }
  });

  r.patch('/respostas-rapidas/:id', (req, res, next) => {
    try {
      const atual = db.prepare('SELECT * FROM respostas_rapidas WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!atual) throw naoEncontrado('Resposta rápida');
      const d = req.body ?? {};
      db.prepare('UPDATE respostas_rapidas SET atalho = ?, titulo = ?, texto = ?, ativa = ? WHERE id = ?')
        .run(d.atalho === undefined ? atual.atalho : atalhoValido(d.atalho),
          d.titulo === undefined ? atual.titulo : v.texto(d.titulo, 'o título', 80),
          d.texto === undefined ? atual.texto : v.texto(d.texto, 'o texto', 4000),
          d.ativa === undefined ? atual.ativa : (v.booleano(d.ativa) ? 1 : 0), atual.id);
      res.json(db.prepare('SELECT * FROM respostas_rapidas WHERE id = ?').get(atual.id));
    } catch (err) { next(err); }
  });

  r.delete('/respostas-rapidas/:id', (req, res, next) => {
    try {
      const x = db.prepare('SELECT id FROM respostas_rapidas WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!x) throw naoEncontrado('Resposta rápida');
      db.prepare('DELETE FROM respostas_rapidas WHERE id = ?').run(x.id);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---------- Etiquetas ----------
  const CORES = ['azul', 'verde', 'roxo', 'laranja', 'vermelho', 'ciano', 'cinza'];

  r.get('/etiquetas', (req, res) => res.json({
    itens: db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM conversa_etiquetas ce WHERE ce.etiqueta_id = e.id) AS usos
      FROM etiquetas e WHERE e.empresa_id = ? ORDER BY e.nome`).all(req.empresa.id),
    cores: CORES,
  }));

  r.post('/etiquetas', (req, res, next) => {
    try {
      const d = req.body ?? {};
      const id = Number(db.prepare('INSERT INTO etiquetas (empresa_id, nome, cor, criada_em) VALUES (?, ?, ?, ?)')
        .run(req.empresa.id, v.texto(d.nome, 'o nome da etiqueta', 40), v.opcao(d.cor ?? 'azul', 'a cor', CORES), agora()).lastInsertRowid);
      res.status(201).json(db.prepare('SELECT * FROM etiquetas WHERE id = ?').get(id));
    } catch (err) { next(err); }
  });

  r.delete('/etiquetas/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const e = db.prepare('SELECT id FROM etiquetas WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!e) throw naoEncontrado('Etiqueta');
      db.prepare('DELETE FROM etiquetas WHERE id = ?').run(e.id);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---------- Chaves de API (integração com o sistema da empresa) ----------
  r.get('/chaves', exigirAdminEmpresa, (req, res) => res.json({
    itens: db.prepare('SELECT id, nome, prefixo, ativa, ultimo_uso, criada_em FROM chaves_api WHERE empresa_id = ? ORDER BY id DESC').all(req.empresa.id)
      .map((c) => ({ ...c, ativa: Boolean(c.ativa) })),
    guia: {
      base: `${process.env.ATEND_URL_PUBLICA ?? 'https://SEU-DOMINIO'}${config.basePath || ''}/api/integracao`,
      cabecalho: 'Authorization: Bearer <chave>',
      rotas: [
        'GET  /conversas            — conversas abertas e encerradas',
        'GET  /conversas/:id        — a conversa com o histórico',
        'POST /mensagens            — envia mensagem (telefone + texto na janela de 24 h, ou template fora dela)',
        'POST /contatos             — cria ou atualiza o contato (nome, documento, e-mail, código no sistema)',
        'GET  /chamados             — chamados abertos pela ZOE',
        'PATCH /chamados/:protocolo — atualiza a situação e a resolução de um chamado',
      ],
    },
  }));

  r.post('/chaves', exigirAdminEmpresa, (req, res, next) => {
    try {
      const nova = empresasLib.criarChaveApi(db, req.empresa.id, req.body?.nome ?? 'Integração');
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'gerou chave de API', alvo: nova.prefixo, ip: req.ip });
      // A chave em claro aparece uma única vez.
      res.status(201).json(nova);
    } catch (err) { next(err); }
  });

  r.delete('/chaves/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const c = db.prepare('SELECT * FROM chaves_api WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!c) throw naoEncontrado('Chave');
      db.prepare('UPDATE chaves_api SET ativa = 0 WHERE id = ?').run(c.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'revogou chave de API', alvo: c.prefixo, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // Sem 404 aqui: este roteador é montado em '/' dentro do painel da empresa e as rotas
  // definidas depois dele (relatórios, CSV) ainda precisam ser alcançadas. Quem fecha é a api.js.
  return r;
};
