'use strict';

/*
 * CRM da abertura de conta (Backoffice → Abertura de contas): funil, análise, proposta comercial e aprovação.
 * Abrir um documento fica na auditoria: é dado pessoal de terceiro.
 */
const express = require('express');
const { exigir } = require('../auth');
const { podeEquipe } = require('../lib/permissoes');
const auditoria = require('../lib/auditoria');
const abertura = require('../lib/abertura');
const { listaPaginada } = require('../lib/http');
const { corpoCliente } = require('./clientes');
const ativacaoLib = require('../lib/ativacao');
const contaInterna = require('../lib/contaInterna');
const { ErroNegocio } = require('../lib/erros');

const validarCadastro = (d) => corpoCliente(d, { novo: true });

module.exports = (db) => {
  const r = express.Router();
  const completo = (s) => ({
    ...abertura.formatar(s, { validarCadastro }),
    interacoes: abertura.interacoes(db, s.id),
    sms: db.prepare("SELECT id, destino, situacao, erro, criado_em FROM sms_mensagens WHERE referencia_tipo = 'abertura' AND referencia_id = ? ORDER BY id DESC")
      .all(s.id).map((m) => ({ ...m, destino: require('../lib/sms').mascarar(m.destino) })),
  });
  const auditar = (req, acao, id, depois = null) => auditoria.registrar(db, req, { acao, entidade: 'abertura', entidade_id: Number(id), depois });

  /** Funil: os pedidos em aberto (todas as etapas) e a contagem de cada situação. */
  r.get('/funil', exigir('aberturas.ver'), (_req, res) => {
    const itens = db.prepare(`SELECT s.*, r.nome AS responsavel_nome FROM solicitacoes_abertura s LEFT JOIN usuarios r ON r.id = s.responsavel_id
      WHERE s.situacao IN (${abertura.ABERTAS.map(() => '?').join(',')}) ORDER BY s.atualizado_em DESC LIMIT 1000`).all(...abertura.ABERTAS);
    const contagem = Object.fromEntries(db.prepare('SELECT situacao, COUNT(*) AS n FROM solicitacoes_abertura GROUP BY situacao').all().map((x) => [x.situacao, x.n]));
    res.json({
      etapas: abertura.ETAPAS.map(([chave, rotulo]) => ({ chave, rotulo })),
      itens: itens.map((s) => {
        const f = abertura.formatar(s, { validarCadastro });
        return { id: f.id, protocolo: f.protocolo, situacao: f.situacao, origem: f.origem, cnpj: f.cnpj, razao_social: f.razao_social,
          nome_fantasia: f.empresa.nome_fantasia, responsavel_nome: f.responsavel_nome, criado_em: f.criado_em, atualizado_em: f.atualizado_em,
          financeiro: f.financeiro.nome, pendencias: f.pendencias.length, tem_proposta: Boolean(f.proposta) };
      }),
      contagem,
    });
  });

  /** Lista com filtro (inclui os concluídos). */
  r.get('/', exigir('aberturas.ver'), (req, res) => {
    const cond = [];
    const p = [];
    if (req.query.situacao) { cond.push('s.situacao = ?'); p.push(String(req.query.situacao)); }
    if (req.query.busca) {
      const d = String(req.query.busca).replace(/\D/g, '');
      cond.push('(s.razao_social LIKE ? OR s.cnpj LIKE ?)');
      p.push(`%${String(req.query.busca).replace(/[%_]/g, '')}%`, `%${d || '@'}%`);
    }
    const sql = `SELECT s.*, u.nome AS analisado_por_nome, r.nome AS responsavel_nome FROM solicitacoes_abertura s
      LEFT JOIN usuarios u ON u.id = s.analisado_por LEFT JOIN usuarios r ON r.id = s.responsavel_id
      ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY s.id DESC`;
    const lista = listaPaginada(db, sql, p, req.query);
    const contagem = Object.fromEntries(db.prepare('SELECT situacao, COUNT(*) AS n FROM solicitacoes_abertura GROUP BY situacao').all().map((x) => [x.situacao, x.n]));
    res.json({ ...lista, itens: lista.itens.map((s) => abertura.formatar(s)), contagem });
  });

  /** Quem pode ser responsável por um pedido (equipe ativa com acesso ao CRM). */
  r.get('/equipe', exigir('aberturas.ver'), (_req, res) => {
    res.json(db.prepare("SELECT id, nome, perfil FROM usuarios WHERE ativo = 1 AND perfil IN ('admin','financeiro','operacao') ORDER BY nome").all());
  });

  /** Contato cadastrado pela equipe (prospecção). */
  r.post('/', exigir('aberturas.editar'), (req, res) => {
    const s = abertura.criarContato(db, req.body ?? {}, req.usuario);
    auditar(req, 'abertura.contato_criado', s.id, { cnpj: s.cnpj, razao_social: s.razao_social });
    res.status(201).json(completo(s));
  });

  r.get('/:id', exigir('aberturas.ver'), (req, res) => res.json(completo(abertura.buscar(db, req.params.id))));

  r.get('/:id/arquivo/:indice', exigir('aberturas.ver'), (req, res) => {
    const a = abertura.arquivo(db, req.params.id, req.params.indice);
    auditar(req, 'abertura.documento_aberto', req.params.id, { documento: a.nome });
    res.set('Content-Type', a.mime);
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(a.nome)}"`);
    res.set('Cache-Control', 'no-store');
    res.sendFile(a.caminho);
  });

  r.put('/:id/dados', exigir('aberturas.editar'), (req, res) => {
    const s = abertura.editarDados(db, req.params.id, req.body ?? {}, req.usuario, { podeDestino: podeEquipe(req.usuario.perfil, 'repasses.aprovar') });
    auditar(req, 'abertura.dados_alterados', s.id);
    res.json(completo(s));
  });

  r.post('/:id/documentos', exigir('aberturas.editar'), (req, res) => {
    const s = abertura.anexar(db, req.params.id, req.body ?? {}, req.usuario);
    auditar(req, 'abertura.documento_anexado', s.id, { tipo: req.body?.tipo });
    res.status(201).json(completo(s));
  });

  r.put('/:id/etapa', exigir('aberturas.editar'), (req, res) => {
    const s = abertura.mover(db, req.params.id, req.body?.etapa, req.usuario);
    auditar(req, 'abertura.etapa', s.id, { etapa: s.situacao });
    res.json(completo(s));
  });

  r.put('/:id/responsavel', exigir('aberturas.editar'), (req, res) => {
    const s = abertura.atribuir(db, req.params.id, req.body?.usuario_id ?? req.usuario.id, req.usuario);
    auditar(req, 'abertura.responsavel', s.id, { responsavel_id: s.responsavel_id });
    res.json(completo(s));
  });

  r.post('/:id/interacoes', exigir('aberturas.editar'), (req, res) => {
    res.status(201).json(abertura.interagir(db, req.params.id, req.body ?? {}, req.usuario));
  });

  r.put('/:id/checklist/:chave', exigir('aberturas.editar'), (req, res) => {
    const s = abertura.marcar(db, req.params.id, req.params.chave, Boolean(req.body?.feito), req.usuario);
    auditar(req, 'abertura.checklist', s.id, { item: req.params.chave, feito: Boolean(req.body?.feito) });
    res.json(completo(s));
  });

  // Tarifas e limites: quem pode mexer em preços.
  r.put('/:id/proposta', exigir('precos.editar'), (req, res) => {
    const s = abertura.definirProposta(db, req.params.id, req.body ?? {}, req.usuario);
    auditar(req, 'abertura.proposta', s.id, JSON.parse(s.proposta));
    res.json(completo(s));
  });

  r.post('/:id/aprovar', exigir('aberturas.aprovar'), (req, res) => {
    const out = abertura.aprovar(db, req.params.id, req.usuario, { validarCadastro });
    auditoria.registrar(db, req, { acao: 'abertura.aprovada', entidade: 'abertura', entidade_id: Number(req.params.id), cliente_id: out.cliente_id,
      depois: { cliente_id: out.cliente_id, acesso: out.acesso?.email ?? null } });
    if (out.acesso) {
      auditoria.registrar(db, req, { acao: 'acesso.criado', entidade: 'usuario_cliente', entidade_id: out.acesso.id, cliente_id: out.cliente_id,
        depois: { nome: out.acesso.nome, email: out.acesso.email, perfil: 'admin' } });
    }
    res.json(out);
  });

  /** Novo link de ativação para o responsável financeiro de uma conta já aberta (o anterior deixa de valer). */
  r.post('/:id/ativacao', exigir('aberturas.editar', 'acessos.gerenciar'), (req, res) => {
    const s = abertura.buscar(db, req.params.id);
    if (s.situacao !== 'aprovada' || !s.cliente_id) throw new ErroNegocio('O link de ativação sai depois que a conta é aberta.', 409);
    const email = JSON.parse(s.dados || '{}').financeiro?.email;
    const u = db.prepare('SELECT id FROM usuarios_cliente WHERE cliente_id = ? AND email = ?').get(s.cliente_id, email)
      ?? db.prepare("SELECT id FROM usuarios_cliente WHERE cliente_id = ? AND perfil = 'admin' ORDER BY id LIMIT 1").get(s.cliente_id);
    if (!u) throw new ErroNegocio('A conta não tem acesso de administrador: crie um em Clientes → Acessos.', 409);
    const out = ativacaoLib.gerar(db, u.id, { criadoPor: req.usuario.id, solicitacaoId: s.id });
    const c = db.prepare('SELECT agencia_interna, conta_interna, conta_interna_dv FROM clientes WHERE id = ?').get(s.cliente_id);
    auditar(req, 'abertura.link_ativacao', s.id, { email: out.email, expira_em: out.expira_em });
    db.prepare('INSERT INTO abertura_interacoes (solicitacao_id, tipo, texto, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?)')
      .run(s.id, 'sistema', `Novo link de ativação gerado para ${out.email} por ${req.usuario.nome} (o anterior deixou de valer).`, req.usuario.id, new Date().toISOString());
    res.status(201).json({ ...out, protocolo: abertura.protocolo(s.id), conta: contaInterna.formatar(c.agencia_interna, c.conta_interna, c.conta_interna_dv) });
  });

  /** Reenvia o SMS com o protocolo para o celular do responsável financeiro. */
  r.post('/:id/sms', exigir('aberturas.editar'), async (req, res) => {
    const r2 = await abertura.avisarProtocolo(db, req.params.id, req.usuario);
    auditar(req, 'abertura.sms_reenviado', req.params.id, { situacao: r2.situacao });
    res.json({ ...r2, pedido: completo(abertura.buscar(db, req.params.id)) });
  });

  r.post('/:id/recusar', exigir('aberturas.aprovar'), (req, res) => {
    const s = abertura.recusar(db, req.params.id, req.body?.motivo, req.usuario);
    auditar(req, 'abertura.recusada', s.id, { motivo: s.motivo });
    res.json(completo(s));
  });

  return r;
};
