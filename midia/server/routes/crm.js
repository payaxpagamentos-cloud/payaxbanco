'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { hoje } = require('../lib/datas');
const crm = require('../lib/crm');
const caixa = require('../lib/caixa');
const propostas = require('../lib/propostas');
const v = require('../lib/validacao');
const empresas = require('../lib/empresas');

/**
 * CRM e propostas: o caminho entre "alguém pediu uma proposta" e "existe um contrato".
 * As propostas continuam com as rotas delas (lib/propostas.js); aqui elas passam a poder nascer
 * de um lead e, quando aceitas, fecham o lead como ganho.
 */
module.exports = (db) => {
  const r = Router();

  const lerLead = (c, parcial = false) => {
    const d = {};
    const tem = (k) => c[k] !== undefined || !parcial;
    if (tem('nome')) d.nome = v.texto(c.nome, 'o nome', 120);
    if (tem('tipo')) d.tipo = v.opcao(c.tipo ?? 'anunciante', 'o tipo', ['anunciante', 'ponto']);
    if (c.contato !== undefined) d.contato = v.opcional(c.contato, 'o contato', 120);
    if (c.email !== undefined) d.email = c.email ? v.email(c.email) : null;
    if (c.telefone !== undefined) d.telefone = v.opcional(c.telefone, 'o telefone', 20);
    if (c.cidade !== undefined) d.cidade = v.opcional(c.cidade, 'a cidade', 80);
    if (c.uf !== undefined) d.uf = c.uf ? v.uf(c.uf) : null;
    if (tem('origem')) d.origem = v.opcao(c.origem ?? 'prospeccao', 'a origem', crm.ORIGENS);
    if (c.etapa !== undefined) d.etapa = v.opcao(c.etapa, 'a etapa', crm.ETAPAS);
    if (c.valor_estimado_centavos !== undefined) {
      d.valor_estimado_centavos = v.inteiro(c.valor_estimado_centavos, 'o valor estimado', { max: 1_000_000_000 });
    }
    if (c.proximo_passo !== undefined) d.proximo_passo = v.opcional(c.proximo_passo, 'o próximo passo', 160);
    if (c.proximo_em !== undefined) d.proximo_em = c.proximo_em ? v.data(c.proximo_em, 'a data do próximo passo') : null;
    if (c.observacao !== undefined) d.observacao = v.opcional(c.observacao, 'a observação', 500);
    if (c.responsavel_id !== undefined) {
      d.responsavel_id = c.responsavel_id === null || c.responsavel_id === '' ? null : Number(c.responsavel_id);
      if (d.responsavel_id && !db.prepare("SELECT 1 FROM usuarios WHERE id = ? AND perfil IN ('master','administrador','operador')").get(d.responsavel_id)) {
        throw new ErroNegocio('Responsável não encontrado.', 422);
      }
    }
    return d;
  };

  r.get('/crm/funil', (req, res) => res.json(crm.funil(db, { ...req.query, _empresa: empresas.empresaDe(req) })));

  r.get('/crm/leads/:id', (req, res) => res.json(crm.detalhe(db, Number(req.params.id))));

  r.post('/crm/leads', (req, res) => {
    const d = lerLead(req.body);
    const campos = { ...d, empresa_id: empresas.empresaParaGravar(db, req, req.body.empresa_id), criado_por: req.usuario.id, criado_em: agora(), atualizado_em: agora() };
    const id = Number(db.prepare(`INSERT INTO leads (${Object.keys(campos).join(', ')})
      VALUES (${Object.keys(campos).map(() => '?').join(', ')})`).run(...Object.values(campos)).lastInsertRowid);
    if (req.body.nota) crm.anotar(db, id, { texto: req.body.nota, usuarioId: req.usuario.id });
    registrar(db, req, 'lead_criado', { id, nome: d.nome, tipo: d.tipo });
    res.status(201).json(crm.detalhe(db, id));
  });

  r.patch('/crm/leads/:id', (req, res) => {
    const id = Number(req.params.id);
    const atual = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!atual) throw naoEncontrado('Lead');
    const d = lerLead(req.body, true);
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    if (d.etapa === 'ganho') throw new ErroNegocio('Para marcar como ganho, use a ação de ganhar o lead.', 422);
    db.prepare(`UPDATE leads SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`)
      .run(...Object.values(d), agora(), id);
    // A mudança de etapa entra no histórico: daqui a um mês ninguém lembra quando a conversa avançou.
    if (d.etapa && d.etapa !== atual.etapa) {
      crm.anotar(db, id, { tipo: 'etapa', texto: `Etapa: ${atual.etapa} → ${d.etapa}.`, usuarioId: req.usuario.id });
    }
    registrar(db, req, 'lead_alterado', { id, depois: d });
    res.json(crm.detalhe(db, id));
  });

  /** Uma conversa no histórico (e, se vier, o próximo passo combinado nela). */
  r.post('/crm/leads/:id/interacoes', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM leads WHERE id = ?').get(id)) throw naoEncontrado('Lead');
    crm.anotar(db, id, {
      tipo: v.opcao(req.body.tipo ?? 'nota', 'o tipo', crm.TIPOS_INTERACAO),
      texto: v.texto(req.body.texto, 'o texto', 500),
      usuarioId: req.usuario.id,
    });
    if (req.body.proximo_em !== undefined || req.body.proximo_passo !== undefined) {
      db.prepare('UPDATE leads SET proximo_passo = ?, proximo_em = ?, atualizado_em = ? WHERE id = ?').run(
        v.opcional(req.body.proximo_passo, 'o próximo passo', 160),
        req.body.proximo_em ? v.data(req.body.proximo_em, 'a data do próximo passo') : null,
        agora(), id,
      );
    }
    registrar(db, req, 'lead_interacao', { id });
    res.status(201).json(crm.detalhe(db, id));
  });

  r.post('/crm/leads/:id/ganhar', (req, res) => {
    const feito = crm.ganhar(db, Number(req.params.id), {
      usuarioId: req.usuario.id,
      criarCadastro: req.body.criar_cadastro !== false,
    });
    registrar(db, req, 'lead_ganho', { id: feito.id, anunciante_id: feito.anunciante_id, local_id: feito.local_id });
    res.json(feito);
  });

  r.post('/crm/leads/:id/perder', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM leads WHERE id = ?').get(id)) throw naoEncontrado('Lead');
    const motivo = v.texto(req.body.motivo, 'o motivo', 300);
    db.prepare("UPDATE leads SET etapa = 'perdido', motivo = ?, proximo_passo = NULL, proximo_em = NULL, atualizado_em = ? WHERE id = ?")
      .run(motivo, agora(), id);
    crm.anotar(db, id, { tipo: 'etapa', texto: `Perdido: ${motivo}`, usuarioId: req.usuario.id });
    registrar(db, req, 'lead_perdido', { id, motivo });
    res.json(crm.detalhe(db, id));
  });

  /** Reabre um lead perdido (ou ganho por engano) como novo contato. */
  r.post('/crm/leads/:id/reabrir', (req, res) => {
    const id = Number(req.params.id);
    const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!l) throw naoEncontrado('Lead');
    db.prepare("UPDATE leads SET etapa = 'contato', motivo = NULL, ganho_em = NULL, atualizado_em = ? WHERE id = ?").run(agora(), id);
    crm.anotar(db, id, { tipo: 'etapa', texto: 'Lead reaberto.', usuarioId: req.usuario.id });
    registrar(db, req, 'lead_reaberto', { id });
    res.json(crm.detalhe(db, id));
  });

  r.delete('/crm/leads/:id', (req, res) => {
    const id = Number(req.params.id);
    const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!l) throw naoEncontrado('Lead');
    if (l.etapa === 'ganho') throw new ErroNegocio('Lead ganho não é excluído: ele é a origem de um cliente.', 409);
    if (db.prepare('SELECT 1 FROM propostas WHERE lead_id = ?').get(id)) {
      throw new ErroNegocio('Este lead tem proposta. Marque como perdido em vez de excluir.', 409);
    }
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
    registrar(db, req, 'lead_excluido', { id, nome: l.nome });
    res.status(204).end();
  });

  // ----------------------------------------------------------------- Propostas (o papel que sai do funil)
  r.get('/propostas', (req, res) => res.json(propostas.listar(db, { ...req.query, _empresa: empresas.empresaDe(req) })));

  r.get('/propostas/:id', (req, res) => res.json(propostas.detalhe(db, Number(req.params.id))));

  r.post('/propostas', (req, res) => {
    const leadId = req.body.lead_id ? Number(req.body.lead_id) : null;
    if (leadId && !db.prepare('SELECT 1 FROM leads WHERE id = ?').get(leadId)) throw new ErroNegocio('Lead não encontrado.', 422);
    const p = propostas.criar(db, {
      circuito_id: Number(req.body.circuito_id),
      anunciante_id: req.body.anunciante_id || null,
      lead_id: leadId,
      meses: req.body.meses,
      desconto_percentual: req.body.desconto_percentual,
      validade_dias: req.body.validade_dias,
      insercoes_hora: req.body.insercoes_hora,
      observacao: v.opcional(req.body.observacao, 'a observação', 500),
    }, req.usuario.id);
    // Proposta feita é etapa de funil: o lead anda sozinho para "proposta".
    if (leadId) {
      const l = db.prepare('SELECT etapa FROM leads WHERE id = ?').get(leadId);
      if (['novo', 'contato'].includes(l.etapa)) {
        db.prepare("UPDATE leads SET etapa = 'proposta', atualizado_em = ? WHERE id = ?").run(agora(), leadId);
      }
      crm.anotar(db, leadId, { tipo: 'etapa', texto: `Proposta ${p.numero} gerada (${(p.total_centavos / 100).toFixed(2)}).`, usuarioId: req.usuario.id });
    }
    registrar(db, req, 'proposta_criada', { id: p.id, numero: p.numero, total_centavos: p.total_centavos, lead_id: leadId });
    res.status(201).json(p);
  });

  r.post('/propostas/:id/enviar', (req, res) => {
    const id = Number(req.params.id);
    const p = propostas.detalhe(db, id);
    if (p.status !== 'rascunho') throw new ErroNegocio('Só um rascunho pode ser enviado.', 409);
    db.prepare("UPDATE propostas SET status = 'enviada', enviada_em = ? WHERE id = ?").run(hoje(), id);
    if (p.lead_id) crm.anotar(db, p.lead_id, { tipo: 'email', texto: `Proposta ${p.numero} enviada ao cliente.`, usuarioId: req.usuario.id });
    registrar(db, req, 'proposta_enviada', { id, numero: p.numero });
    res.json(propostas.detalhe(db, id));
  });

  r.post('/propostas/:id/aceitar', (req, res) => {
    const p = propostas.detalhe(db, Number(req.params.id));
    // Sem cliente definido, mas vindo de um lead de anunciante: o lead vira cliente primeiro.
    let anuncianteId = req.body.anunciante_id ? Number(req.body.anunciante_id) : null;
    if (!anuncianteId && !p.anunciante_id && p.lead_id) {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(p.lead_id);
      if (lead?.tipo === 'anunciante') anuncianteId = crm.ganhar(db, p.lead_id, { usuarioId: req.usuario.id }).anunciante_id;
    }
    const feito = propostas.aceitar(db, p.id, {
      anuncianteId,
      inicio: req.body.inicio ? v.data(req.body.inicio, 'o início da vigência') : null,
      usuarioId: req.usuario.id,
    });
    if (feito.lead_id) {
      const lead = db.prepare('SELECT etapa FROM leads WHERE id = ?').get(feito.lead_id);
      if (lead && lead.etapa !== 'ganho') crm.ganhar(db, feito.lead_id, { usuarioId: req.usuario.id });
      crm.anotar(db, feito.lead_id, { tipo: 'etapa', texto: `Proposta ${feito.numero} aceita: contrato ${feito.criado.numero}.`, usuarioId: req.usuario.id });
    }
    registrar(db, req, 'proposta_aceita', { id: feito.id, numero: feito.numero, ...feito.criado });
    res.json(feito);
  });

  r.post('/propostas/:id/recusar', (req, res) => {
    const id = Number(req.params.id);
    const p = propostas.detalhe(db, id);
    if (p.status === 'aceita') throw new ErroNegocio('Proposta aceita não pode ser recusada.', 409);
    const motivo = v.texto(req.body.motivo, 'o motivo', 300);
    db.prepare("UPDATE propostas SET status = 'recusada', motivo = ?, respondida_em = ? WHERE id = ?").run(motivo, hoje(), id);
    if (p.lead_id) crm.anotar(db, p.lead_id, { tipo: 'nota', texto: `Proposta ${p.numero} recusada: ${motivo}`, usuarioId: req.usuario.id });
    registrar(db, req, 'proposta_recusada', { id, numero: p.numero, motivo });
    res.json(propostas.detalhe(db, id));
  });

  r.post('/propostas/:id/reabrir', (req, res) => {
    const id = Number(req.params.id);
    const p = propostas.detalhe(db, id);
    if (p.status === 'aceita') throw new ErroNegocio('Proposta aceita não volta para rascunho.', 409);
    db.prepare("UPDATE propostas SET status = 'rascunho', motivo = NULL, respondida_em = NULL, enviada_em = NULL WHERE id = ?").run(id);
    registrar(db, req, 'proposta_reaberta', { id, numero: p.numero });
    res.json(propostas.detalhe(db, id));
  });

  r.delete('/propostas/:id', (req, res) => {
    const id = Number(req.params.id);
    const p = propostas.detalhe(db, id);
    if (p.status === 'aceita') throw new ErroNegocio('Proposta aceita não é excluída: ela virou contrato.', 409);
    db.prepare('DELETE FROM propostas WHERE id = ?').run(id);
    registrar(db, req, 'proposta_excluida', { id, numero: p.numero });
    res.status(204).end();
  });

  /* ------------------------------------------------------------------ Caixa de entrada do CRM */

  /**
   * A conversa por e-mail fica aqui dentro, ligada ao lead. O que entra vem pelo servidor de e-mail da
   * plataforma (lib/smtp-servidor.js); o que sai vai pelo servidor de envio configurado.
   */
  r.get('/crm/emails', (req, res) => res.json(caixa.listar(db, {
    ...req.query, _empresa: empresas.empresaDe(req), _usuario: req.usuario.id,
    _operador: req.usuario.perfil === 'operador' ? req.usuario.id : null,
  })));

  // E-mail de endereço pessoal de outra pessoa: o operador não abre.
  r.use('/crm/emails/:id', (req, _res, next) => (caixa.podeVer(db, Number(req.params.id), req.usuario)
    ? next() : next(new ErroNegocio('Esta mensagem é da caixa de outra pessoa.', 403))));

  r.get('/crm/emails/:id', (req, res) => {
    const e = caixa.ler(db, Number(req.params.id));
    // Abrir é ler: a caixa não fica com número de não lidos que não corresponde à verdade.
    if (e.direcao === 'entrada' && !e.lido_em) return res.json(caixa.marcarLido(db, e.id));
    res.json(e);
  });

  r.get('/crm/emails/:id/anexo/:indice', (req, res) => {
    const a = caixa.anexo(db, Number(req.params.id), req.params.indice);
    res.set('Content-Type', a.mime || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${a.nome.replace(/[^\w.\- ]+/g, '_')}"`);
    res.send(a.conteudo);
  });

  r.get('/crm/emails/:id/original', (req, res) => {
    const o = caixa.original(db, Number(req.params.id));
    res.set('Content-Type', 'message/rfc822');
    res.set('Content-Disposition', `attachment; filename="${o.nome}"`);
    res.send(o.conteudo);
  });

  r.post('/crm/emails/:id/lido', (req, res) => res.json(caixa.marcarLido(db, Number(req.params.id), req.body.lido !== false)));

  r.delete('/crm/emails/:id', (req, res) => {
    const e = caixa.excluir(db, Number(req.params.id));
    registrar(db, req, 'email_excluido', { id: e.id, de: e.de, assunto: e.assunto });
    res.status(204).end();
  });

  r.post('/crm/emails/:id/arquivar', (req, res) => {
    const e = caixa.arquivar(db, Number(req.params.id), req.body.arquivado !== false);
    registrar(db, req, 'email_arquivado', { id: e.id, de: e.de });
    res.json(e);
  });

  r.post('/crm/emails/:id/lead', (req, res) => {
    const id = Number(req.params.id);
    const leadId = req.body.lead_id === null || req.body.lead_id === '' ? null : Number(req.body.lead_id);
    const e = caixa.vincularLead(db, id, leadId);
    registrar(db, req, 'email_vinculado', { id, lead_id: leadId });
    res.json(e);
  });

  r.post('/crm/emails/:id/virar-lead', (req, res) => {
    const tipo = v.opcao(req.body.tipo ?? 'anunciante', 'o tipo', ['anunciante', 'ponto']);
    const r2 = caixa.virarLead(db, Number(req.params.id), { usuarioId: req.usuario.id, tipo });
    registrar(db, req, 'lead_criado', { id: r2.lead_id, origem: 'e-mail' });
    res.status(201).json(r2);
  });

  r.post('/crm/emails', async (req, res) => {
    const e = await caixa.enviar(db, {
      para: req.body.para,
      assunto: v.opcional(req.body.assunto, 'o assunto', 200),
      texto: req.body.texto,
      responder_a: req.body.responder_a ?? null,
      lead_id: req.body.lead_id ?? null,
      usuarioId: req.usuario.id,
      empresa_id: empresas.empresaParaGravar(db, req),
      remetente: db.prepare("SELECT id, endereco, COALESCE(NULLIF(nome, ''), ?) AS nome, assinatura FROM enderecos_email WHERE usuario_id = ? AND ativo = 1 ORDER BY id LIMIT 1").get(req.usuario.nome, req.usuario.id) ?? null,
    });
    registrar(db, req, 'email_enviado', { id: e.id, para: e.para, assunto: e.assunto });
    res.status(201).json(e);
  });

  return r;
};
