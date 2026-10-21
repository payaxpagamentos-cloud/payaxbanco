'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const { lerChave } = require('../lib/contas');
const cham = require('../lib/chamadas');
const { inicioMes, intervalo, hoje } = require('../lib/datas');
const v = require('../lib/validacao');

/**
 * API usada pela central telefônica (Asterisk, FreeSWITCH etc.), autenticada pela chave da empresa no cabeçalho X-Api-Key.
 * Ela busca a configuração (ramais, números, filas, URAs) e informa as chamadas, o registro dos ramais e o uso de TTS/STT.
 */
module.exports = (db) => {
  const r = Router();

  r.use((req, _res, next) => {
    const auth = req.get('authorization') || '';
    const empresa = lerChave(db, req.get('x-api-key') || (auth.startsWith('Bearer ') ? auth.slice(7) : ''));
    if (!empresa) return next(new ErroNegocio('Chave de API inválida ou revogada.', 401));
    req.empresa = empresa;
    next();
  });

  /** Configuração completa da empresa para a central telefônica montar o plano de discagem. */
  r.get('/config', (req, res) => {
    const e = req.empresa;
    const t = e.tronco_id ? db.prepare('SELECT id, nome, host, porta, usuario, senha, prefixo, canais, ativo FROM troncos WHERE id = ?').get(e.tronco_id) : null;
    const filas = db.prepare('SELECT id, nome, estrategia, espera_maxima_s FROM filas WHERE empresa_id = ?').all(e.id);
    const membros = db.prepare('SELECT r.numero FROM fila_ramais fr JOIN ramais r ON r.id = fr.ramal_id WHERE fr.fila_id = ? AND r.ativo = 1 ORDER BY r.numero');
    res.json({
      empresa: { id: e.id, nome: e.nome, status: e.status, limite_canais: e.limite_canais, gravar_chamadas: Boolean(e.gravar_chamadas) },
      terminacao: t && t.ativo ? t : null,
      ramais: db.prepare('SELECT id, numero, nome, senha_sip, gravar FROM ramais WHERE empresa_id = ? AND ativo = 1 ORDER BY numero').all(e.id)
        .map((x) => ({ ...x, usuario_sip: `${e.id}_${x.numero}`, gravar: Boolean(x.gravar) })),
      numeros: db.prepare('SELECT id, numero, destino_tipo, destino_id FROM numeros WHERE empresa_id = ?').all(e.id),
      filas: filas.map((f) => ({ ...f, ramais: membros.all(f.id).map((m) => m.numero) })),
      uras: db.prepare('SELECT id, nome, mensagem, opcoes FROM uras WHERE empresa_id = ?').all(e.id).map((u) => ({ ...u, opcoes: JSON.parse(u.opcoes) })),
    });
  });

  // Chamadas: início, atendimento e fim, identificadas pelo uid da central telefônica (repetir a mesma mensagem não duplica).
  r.post('/chamadas', (req, res) => {
    const x = cham.iniciar(db, req.empresa, req.body);
    res.status(x.repetida ? 200 : 201).json(x);
  });
  r.post('/chamadas/:uid/atendida', (req, res) => res.json(cham.atender(db, req.empresa, req.params.uid, req.body)));
  r.post('/chamadas/:uid/fim', (req, res) => res.json(cham.encerrar(db, req.empresa, req.params.uid, req.body)));

  /** Registro do ramal (o telefone conectou ou desconectou). */
  r.post('/ramais/:numero/registro', (req, res) => {
    const x = db.prepare('SELECT id, ativo FROM ramais WHERE empresa_id = ? AND numero = ?').get(req.empresa.id, String(req.params.numero));
    if (!x) throw new ErroNegocio('Ramal não encontrado.', 404);
    const online = req.body.online === undefined ? true : v.booleano(req.body.online);
    db.prepare('UPDATE ramais SET online = ?, registro_em = ?, registro_ip = COALESCE(?, registro_ip), registro_agente = COALESCE(?, registro_agente) WHERE id = ?')
      .run(online && x.ativo ? 1 : 0, agora(), req.body.ip ? String(req.body.ip).slice(0, 45) : null, req.body.agente ? String(req.body.agente).slice(0, 120) : null, x.id);
    res.json({ ok: true, ativo: Boolean(x.ativo) });
  });

  /** Uso de texto para voz (TTS) ou voz para texto (STT), recusado acima do limite do mês. */
  r.post('/recursos', (req, res) => {
    const e = req.empresa;
    if (e.status !== 'ativa') throw new ErroNegocio('Empresa bloqueada.', 403);
    const recurso = v.opcao(req.body.recurso, 'o recurso', ['tts', 'stt']);
    const quantidade = v.inteiro(req.body.quantidade ?? 1, 'a quantidade', { min: 1, max: 1_000_000 });
    const [ini] = intervalo(inicioMes(), hoje());
    const limite = e[`${recurso}_limite`];
    const usado = transacao(db, () => {
      const atual = db.prepare('SELECT COALESCE(SUM(quantidade),0) AS n FROM uso_recursos WHERE empresa_id = ? AND recurso = ? AND criado_em >= ?').get(e.id, recurso, ini).n;
      if (atual + quantidade > limite) throw new ErroNegocio(`Limite mensal de ${recurso.toUpperCase()} atingido (${atual}/${limite}).`, 429);
      db.prepare('INSERT INTO uso_recursos (empresa_id, recurso, quantidade, criado_em) VALUES (?, ?, ?, ?)').run(e.id, recurso, quantidade, agora());
      return atual + quantidade;
    });
    res.status(201).json({ usado, limite });
  });

  /**
   * Discador: próximos contatos a ligar de uma campanha ativa (até o número de canais livres da campanha).
   * Os contatos voltam marcados como "discando"; o resultado vem no fim da chamada (com campanha_contato_id no início).
   */
  r.post('/campanhas/:id/proximos', (req, res) => {
    const e = req.empresa;
    if (e.status !== 'ativa') throw new ErroNegocio('Empresa bloqueada.', 403);
    const c = db.prepare('SELECT * FROM campanhas WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), e.id);
    if (!c) throw new ErroNegocio('Campanha não encontrada.', 404);
    if (c.status !== 'ativa') return res.json({ status: c.status, contatos: [] });
    const contatos = transacao(db, () => {
      const ocupados = db.prepare("SELECT COUNT(*) AS n FROM campanha_contatos WHERE campanha_id = ? AND status = 'discando'").get(c.id).n;
      const livresEmpresa = e.limite_canais - cham.emCurso(db, e.id);
      const qtd = Math.max(0, Math.min(c.canais - ocupados, livresEmpresa, Number(req.body.maximo) || Infinity));
      if (!qtd) return [];
      const lista = db.prepare(`SELECT id, nome, telefone, tentativas FROM campanha_contatos WHERE campanha_id = ? AND tentativas < ?
        AND status IN ('pendente','nao_atendido','ocupado','falha') ORDER BY tentativas, id LIMIT ?`).all(c.id, c.tentativas_max, qtd);
      const marcar = db.prepare("UPDATE campanha_contatos SET status = 'discando', tentativas = tentativas + 1, ultima_tentativa = ? WHERE id = ?");
      for (const x of lista) marcar.run(agora(), x.id);
      return lista.map((x) => ({ ...x, tentativas: x.tentativas + 1 }));
    });
    const fila = c.fila_id ? db.prepare('SELECT id, nome FROM filas WHERE id = ?').get(c.fila_id) : null;
    res.json({ status: c.status, fila, contatos });
  });

  return r;
};
