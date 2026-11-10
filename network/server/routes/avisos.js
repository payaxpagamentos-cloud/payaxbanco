'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada } = require('../lib/http');
const base = require('../conectores/base');
const avisos = require('../lib/avisos');
const v = require('../lib/validacao');

const SEV = ['critica', 'alta', 'media', 'baixa'];

/** Configuração por tipo. Os endereços de API têm padrão oficial; só mudam para servidor próprio (Bot API local, proxy). */
function validarConfig(tipo, c = {}) {
  const lista = (x, nome, re) => {
    const itens = [].concat(Array.isArray(x) ? x : String(x ?? '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean);
    if (!itens.length) throw new ErroNegocio(`Informe ${nome}.`, 422);
    if (itens.length > 20) throw new ErroNegocio(`No máximo 20 em ${nome}.`, 422);
    for (const i of itens) if (!re.test(i)) throw new ErroNegocio(`Valor inválido em ${nome}: ${i}`, 422);
    return itens;
  };
  const url = (x) => (x ? v.texto(x, 'o endereço da API', 300).replace(/\/+$/, '') : null);
  if (tipo === 'telegram') return { chats: lista(c.chats, 'os chats (IDs)', /^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/), url_api: url(c.url_api) };
  if (tipo === 'whatsapp') {
    return { numero_id: v.texto(c.numero_id, 'o ID do número (Phone Number ID)', 40), destinatarios: lista(c.destinatarios, 'os destinatários', /^\d{10,15}$/),
      modelo: v.opcional(c.modelo, 'o nome do modelo', 120), idioma: v.opcional(c.idioma, 'o idioma do modelo', 10) ?? 'pt_BR', url_api: url(c.url_api) };
  }
  return { url: v.texto(c.url, 'o endereço do webhook', 300) };
}

module.exports = (db) => {
  const r = Router();
  const canal = (req) => {
    const c = db.prepare('SELECT * FROM avisos_canais WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!c) throw new ErroNegocio('Canal não encontrado.', 404);
    return c;
  };
  const eventos = (x) => {
    const l = [].concat(x ?? []).map(String);
    for (const e of l) if (!avisos.EVENTOS[e] || e === 'teste') throw new ErroNegocio(`Evento desconhecido: ${e}`, 422);
    return [...new Set(l)];
  };
  const destino = async (tipo, cfg) => {
    const u = tipo === 'webhook' ? cfg.url : cfg.url_api || avisos.URL_PADRAO[tipo];
    try { await base.validarDestino(u); } catch (err) { throw new ErroNegocio(err.message, 422); }
  };

  r.get('/canais', exigir('avisos.configurar'), (req, res) => {
    res.json({ canais: db.prepare('SELECT * FROM avisos_canais WHERE organizacao_id = ? ORDER BY nome').all(req.org).map(avisos.publico), eventos: avisos.EVENTOS });
  });

  r.post('/canais', exigir('avisos.configurar'), async (req, res, next) => {
    try {
      const b = req.body ?? {};
      const tipo = v.opcao(b.tipo, 'o tipo', ['telegram', 'whatsapp', 'webhook']);
      const cfg = validarConfig(tipo, b.config);
      await destino(tipo, cfg);
      if (tipo !== 'webhook' && !b.segredo) throw new ErroNegocio(tipo === 'telegram' ? 'Informe o token do bot.' : 'Informe o token da API do WhatsApp.', 422);
      const t = agora();
      const id = Number(db.prepare(`INSERT INTO avisos_canais (organizacao_id, tipo, nome, config, segredo_cifrado, eventos, severidade_min, criado_em, atualizado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, tipo, v.texto(b.nome, 'o nome', 80), JSON.stringify(cfg), avisos.cifrarSegredo(b.segredo ? String(b.segredo).trim() : null),
        JSON.stringify(eventos(b.eventos ?? Object.keys(avisos.EVENTOS).filter((e) => e !== 'teste'))), v.opcao(b.severidade_min ?? 'baixa', 'a severidade mínima', SEV), t, t).lastInsertRowid);
      registrar(db, req, 'canal_aviso_criado', { recurso: 'canal_aviso', recursoId: id, depois: { tipo, config: cfg } });
      res.status(201).json(avisos.publico(db.prepare('SELECT * FROM avisos_canais WHERE id = ?').get(id)));
    } catch (err) { next(err); }
  });

  r.patch('/canais/:id', exigir('avisos.configurar'), async (req, res, next) => {
    try {
      const c = canal(req);
      const b = req.body ?? {};
      const cfg = b.config !== undefined ? validarConfig(c.tipo, b.config) : JSON.parse(c.config);
      if (b.config !== undefined) await destino(c.tipo, cfg);
      const segredo = b.segredo === undefined ? c.segredo_cifrado : avisos.cifrarSegredo(b.segredo ? String(b.segredo).trim() : null);
      if (c.tipo !== 'webhook' && !segredo) throw new ErroNegocio('Este canal precisa do token.', 422);
      db.prepare('UPDATE avisos_canais SET nome = ?, config = ?, segredo_cifrado = ?, eventos = ?, severidade_min = ?, ativo = ?, atualizado_em = ? WHERE id = ?').run(
        b.nome !== undefined ? v.texto(b.nome, 'o nome', 80) : c.nome, JSON.stringify(cfg), segredo, b.eventos !== undefined ? JSON.stringify(eventos(b.eventos)) : c.eventos,
        b.severidade_min !== undefined ? v.opcao(b.severidade_min, 'a severidade mínima', SEV) : c.severidade_min, b.ativo !== undefined ? (v.booleano(b.ativo) ? 1 : 0) : c.ativo,
        agora(), c.id);
      registrar(db, req, 'canal_aviso_alterado', { recurso: 'canal_aviso', recursoId: c.id, depois: { config: cfg, credencial_alterada: b.segredo !== undefined } });
      res.json(avisos.publico(db.prepare('SELECT * FROM avisos_canais WHERE id = ?').get(c.id)));
    } catch (err) { next(err); }
  });

  /** Envia uma mensagem de teste agora (sem fila), com o erro detalhado se falhar. */
  r.post('/canais/:id/testar', exigir('avisos.configurar'), async (req, res, next) => {
    try {
      const c = canal(req);
      try {
        await avisos.enviar(c, `${avisos.TITULO}\nMensagem de teste enviada por ${req.usuario.nome}. Se chegou, o canal está pronto.`);
        db.prepare('UPDATE avisos_canais SET ultimo_envio = ?, ultimo_erro = NULL WHERE id = ?').run(agora(), c.id);
        registrar(db, req, 'canal_aviso_testado', { recurso: 'canal_aviso', recursoId: c.id, depois: { ok: true } });
        res.json({ ok: true });
      } catch (err) {
        if (!(err instanceof base.ErroConector)) throw err;
        db.prepare('UPDATE avisos_canais SET ultimo_erro = ? WHERE id = ?').run(err.message, c.id);
        res.json({ ok: false, erro: err.message });
      }
    } catch (err) { next(err); }
  });

  r.get('/envios', exigir('avisos.configurar'), (req, res) => {
    res.json(listaPaginada(db, `SELECT e.id, e.canal_id, c.nome AS canal_nome, c.tipo, e.evento, e.recurso, e.recurso_id, e.texto, e.status, e.tentativas, e.erro, e.erro_id,
      e.criado_em, e.enviado_em FROM avisos_envios e JOIN avisos_canais c ON c.id = e.canal_id WHERE e.organizacao_id = ? AND e.texto <> '' ORDER BY e.id DESC`, [req.org], req.query));
  });

  return r;
};
