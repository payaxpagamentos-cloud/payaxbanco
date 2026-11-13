'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { agora, transacao } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const { limitar, registrarRecusa } = require('../lib/limitador');
const ixcTools = require('../ia/ferramentas-ixc');
const cham = require('./chamadas');
const { inicioMes, intervalo, hoje } = require('../lib/datas');
const v = require('../lib/validacao');
const uraLib = require('./ura');
const uraAtendimento = require('./ura-atendimento');

/**
 * API da central telefônica (Asterisk, FreeSWITCH etc.) em /api/central: a configuração (ramais,
 * números, filas, URAs), o início e o fim das chamadas (a base da tarifação), o registro dos ramais
 * e o uso de TTS/STT. Autenticada pela chave de escopo "central" (só a equipe da plataforma cria):
 * a chave de integração comum da empresa não informa chamadas.
 */
module.exports = (db) => {
  const r = Router();
  r.use(limitar({ janelaMs: 60_000, maximo: 3000, todos: true }));

  r.use((req, _res, next) => {
    const auth = req.get('authorization') || '';
    const chave = String(req.get('x-api-key') || (auth.startsWith('Bearer ') ? auth.slice(7) : '')).trim();
    const hash = chave ? crypto.createHash('sha256').update(chave).digest('hex') : null;
    const k = hash ? db.prepare(`SELECT c.id, c.empresa_id FROM chaves_api c JOIN empresas e ON e.id = c.empresa_id
      WHERE c.chave_hash = ? AND c.ativa = 1 AND c.escopo = 'central' AND e.status <> 'excluida'`).get(hash) : null;
    if (!k) {
      registrarRecusa(db, req.ip, 'central: chave inválida ou sem escopo de central');
      return next(new ErroNegocio('Chave da central inválida ou revogada.', 401));
    }
    db.prepare('UPDATE chaves_api SET ultimo_uso = ? WHERE id = ?').run(agora(), k.id);
    req.empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(k.empresa_id);
    if (!req.empresa.telefonia_ativa) return next(new ErroNegocio('A telefonia não está ligada para esta empresa.', 403));
    next();
  });

  /**
   * Configuração completa da empresa para a central telefônica montar o plano de discagem.
   * A rota de saída vai sem usuário e senha: o tronco é da plataforma (várias empresas usam o
   * mesmo) e a credencial dele fica só na configuração da central, nunca numa resposta da API —
   * com ela, quem tem a chave discaria direto pela operadora, sem passar pela tarifação.
   */
  r.get('/config', (req, res) => {
    const e = req.empresa;
    const t = e.tronco_id ? db.prepare('SELECT id, nome, host, porta, prefixo, canais, ativo FROM pabx_troncos WHERE id = ?').get(e.tronco_id) : null;
    const filas = db.prepare('SELECT id, nome, estrategia, espera_maxima_s FROM filas WHERE empresa_id = ?').all(e.id);
    const membros = db.prepare('SELECT r.numero FROM pabx_fila_ramais fr JOIN pabx_ramais r ON r.id = fr.ramal_id WHERE fr.fila_id = ? AND r.ativo = 1 ORDER BY r.numero');
    res.json({
      empresa: { id: e.id, nome: e.nome, status: e.status, limite_canais: e.limite_canais, gravar_chamadas: Boolean(e.gravar_chamadas) },
      terminacao: t && t.ativo ? t : null,
      ramais: db.prepare('SELECT id, numero, nome, senha_sip, gravar FROM pabx_ramais WHERE empresa_id = ? AND ativo = 1 ORDER BY numero').all(e.id)
        .map((x) => ({ ...x, usuario_sip: `${e.id}_${x.numero}`, gravar: Boolean(x.gravar) })),
      numeros: db.prepare('SELECT id, numero, destino_tipo, destino_id FROM pabx_numeros WHERE empresa_id = ?').all(e.id),
      filas: filas.map((f) => ({ ...f, ramais: membros.all(f.id).map((m) => m.numero) })),
      uras: db.prepare('SELECT id, nome, mensagem, opcoes FROM pabx_uras WHERE empresa_id = ?').all(e.id).map((u) => ({ ...u, opcoes: JSON.parse(u.opcoes) })),
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
    const x = db.prepare('SELECT id, ativo FROM pabx_ramais WHERE empresa_id = ? AND numero = ?').get(req.empresa.id, String(req.params.numero));
    if (!x) throw new ErroNegocio('Ramal não encontrado.', 404);
    const online = req.body.online === undefined ? true : v.booleano(req.body.online);
    db.prepare('UPDATE pabx_ramais SET online = ?, registro_em = ?, registro_ip = COALESCE(?, registro_ip), registro_agente = COALESCE(?, registro_agente) WHERE id = ?')
      .run(online && x.ativo ? 1 : 0, agora(), req.body.ip ? String(req.body.ip).slice(0, 45) : null, req.body.agente ? String(req.body.agente).slice(0, 120) : null, x.id);
    res.json({ ok: true, ativo: Boolean(x.ativo) });
  });

  // ---------- URA ----------
  /**
   * A ligação chegou numa URA: a central pergunta o que falar.
   *
   * Numa URA clássica devolve a mensagem e as teclas de sempre. Numa inteligente, consulta o
   * IXC pelo número que ligou e abre pelo motivo mais provável daquela pessoa — sem dizer nada
   * do contrato antes de a identidade ser confirmada.
   */
  r.post('/ura/:id/atender', async (req, res, next) => {
    try {
      const ura = uraLib.buscar(db, req.empresa.id, Number(req.params.id));
      // O IXC é o da ZOE (ZOE › Provedor): um cadastro só para o WhatsApp, a ligação e a URA.
      const ixc = ixcTools.clienteIxc(db, req.empresa.id);
      res.json(await uraAtendimento.atender(db, req.empresa, ura, {
        telefone: req.body?.telefone ? v.digitos(req.body.telefone) : null, ixc,
        // O uid amarra o cliente reconhecido a esta ligação; sem ele a URA não reconhece ninguém.
        uid: req.body?.uid ? v.texto(req.body.uid, 'o uid da ligação', 120) : null,
      }));
    } catch (err) { next(err); }
  });

  /**
   * O cliente digitou os três primeiros do CPF/CNPJ: o servidor confere contra o cadastro do
   * cliente que o /atender reconheceu nesta ligação (uid). Só com o código certo a URA fala do
   * contrato. A central não manda o cliente — não há como escolher de quem é a ligação.
   */
  r.post('/ura/:id/confirmado', async (req, res, next) => {
    try {
      const ura = uraLib.buscar(db, req.empresa.id, Number(req.params.id));
      const uid = v.texto(req.body?.uid, 'o uid da ligação', 120);
      const ixc = ixcTools.clienteIxc(db, req.empresa.id);
      res.json(await uraAtendimento.confirmar(db, req.empresa, ura, {
        uid, codigo: String(req.body?.codigo ?? ''), ixc,
      }));
    } catch (err) { next(err); }
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
      const atual = db.prepare('SELECT COALESCE(SUM(quantidade),0) AS n FROM pabx_uso_recursos WHERE empresa_id = ? AND recurso = ? AND criado_em >= ?').get(e.id, recurso, ini).n;
      if (atual + quantidade > limite) throw new ErroNegocio(`Limite mensal de ${recurso.toUpperCase()} atingido (${atual}/${limite}).`, 429);
      db.prepare('INSERT INTO pabx_uso_recursos (empresa_id, recurso, quantidade, criado_em) VALUES (?, ?, ?, ?)').run(e.id, recurso, quantidade, agora());
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
    const c = db.prepare('SELECT * FROM pabx_campanhas WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), e.id);
    if (!c) throw new ErroNegocio('Campanha não encontrada.', 404);
    if (c.status !== 'ativa') return res.json({ status: c.status, contatos: [] });
    const contatos = transacao(db, () => {
      const ocupados = db.prepare("SELECT COUNT(*) AS n FROM pabx_campanha_contatos WHERE campanha_id = ? AND status = 'discando'").get(c.id).n;
      const livresEmpresa = e.limite_canais - cham.emCurso(db, e.id);
      const qtd = Math.max(0, Math.min(c.canais - ocupados, livresEmpresa, Number(req.body.maximo) || Infinity));
      if (!qtd) return [];
      const lista = db.prepare(`SELECT id, nome, telefone, tentativas FROM pabx_campanha_contatos WHERE campanha_id = ? AND tentativas < ?
        AND status IN ('pendente','nao_atendido','ocupado','falha') ORDER BY tentativas, id LIMIT ?`).all(c.id, c.tentativas_max, qtd);
      const marcar = db.prepare("UPDATE pabx_campanha_contatos SET status = 'discando', tentativas = tentativas + 1, ultima_tentativa = ? WHERE id = ?");
      for (const x of lista) marcar.run(agora(), x.id);
      return lista.map((x) => ({ ...x, tentativas: x.tentativas + 1 }));
    });
    const fila = c.fila_id ? db.prepare('SELECT id, nome FROM filas WHERE id = ?').get(c.fila_id) : null;
    res.json({ status: c.status, fila, contatos });
  });

  return r;
};
