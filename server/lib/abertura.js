'use strict';

/*
 * Abertura de conta pelo site: o interessado envia a proposta, a equipe analisa e aprova (cria cliente,
 * conta e acesso ao Internet Banking) ou recusa. Nada é criado automaticamente sem a análise humana.
 */
const crypto = require('node:crypto');
const { transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');
const { registrar } = require('./auditoria');
const { normalizar, inserirCliente } = require('./clientes');
const { proximoNumero, buscarConta } = require('./conta');
const { habilitarAcesso } = require('./acesso');

const STATUS = { em_analise: 'Em análise', aprovada: 'Aprovada', recusada: 'Não aprovada' };

function idade(dataIso) {
  const n = new Date(`${dataIso}T00:00:00Z`);
  const h = new Date();
  let anos = h.getUTCFullYear() - n.getUTCFullYear();
  if (h.getUTCMonth() < n.getUTCMonth() || (h.getUTCMonth() === n.getUTCMonth() && h.getUTCDate() < n.getUTCDate())) anos--;
  return anos;
}

function gerarProtocolo() {
  const dia = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `AB${dia}${String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

function criarProposta(db, req, body) {
  const d = body ?? {};
  const c = normalizar({ ...d, status: 'ativo', observacoes: null });
  // No site, contato, data e endereço são obrigatórios (na agência podem ser completados depois).
  v.exigir(c.email, 'Informe seu e-mail.');
  v.exigir(c.telefone, 'Informe seu celular com DDD.');
  v.exigir(c.data_nascimento, c.tipo === 'PF' ? 'Informe sua data de nascimento.' : 'Informe a data de fundação da empresa.');
  v.exigir(c.cep && c.logradouro && c.numero && c.bairro && c.cidade && c.uf, 'Preencha o endereço completo.');
  if (c.tipo === 'PF') v.exigir(idade(c.data_nascimento) >= 18, 'A abertura online é para maiores de 18 anos.');
  v.exigir(c.data_nascimento <= new Date().toISOString().slice(0, 10), 'Data inválida.');
  const tipoConta = d.tipo_conta ?? 'corrente';
  v.exigir(['corrente', 'pagamento'].includes(tipoConta), 'Tipo de conta inválido.');
  v.exigir(d.aceite_termos === true, 'É preciso aceitar os termos de abertura de conta.');
  v.exigir(d.aceite_privacidade === true, 'É preciso autorizar o uso dos seus dados para a análise (LGPD).');

  if (db.prepare('SELECT 1 FROM clientes WHERE documento = ?').get(c.documento)) {
    throw new ErroNegocio('Você já é cliente PAY AX. Acesse sua conta pelo Internet Banking.', 409);
  }
  const pendente = db.prepare("SELECT protocolo FROM propostas_conta WHERE documento = ? AND status = 'em_analise'").get(c.documento);
  if (pendente) throw new ErroNegocio(`Já existe uma proposta em análise para este documento (protocolo ${pendente.protocolo}).`, 409);

  const protocolo = gerarProtocolo();
  const r = db.prepare(`INSERT INTO propostas_conta (protocolo, tipo, documento, nome, email, telefone, tipo_conta, dados, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(protocolo, c.tipo, c.documento, c.nome, c.email, c.telefone, tipoConta, JSON.stringify(c), req.ip ?? null);
  registrar(db, req, 'proposta_abertura', 'proposta', Number(r.lastInsertRowid), { protocolo, tipo: c.tipo, nome: c.nome });
  return { protocolo, status: 'em_analise', status_texto: STATUS.em_analise, nome: c.nome };
}

/** Consulta pública: exige protocolo e documento juntos e devolve apenas a situação. */
function consultar(db, protocolo, documento) {
  const p = db.prepare('SELECT * FROM propostas_conta WHERE protocolo = ? AND documento = ?')
    .get(String(protocolo ?? '').trim().toUpperCase(), v.digitos(documento));
  if (!p) throw new ErroNegocio('Proposta não encontrada. Confira o protocolo e o documento.', 404);
  const mensagens = {
    em_analise: 'Sua proposta está em análise. Em breve entraremos em contato pelo e-mail e celular informados.',
    aprovada: 'Sua conta foi aprovada! Você receberá a senha provisória por um canal seguro para o primeiro acesso.',
    recusada: 'Não foi possível aprovar sua proposta neste momento.',
  };
  return { protocolo: p.protocolo, status: p.status, status_texto: STATUS[p.status], mensagem: mensagens[p.status], enviada_em: p.criado_em };
}

function listar(db, { status } = {}) {
  const params = [];
  let where = '';
  if (status) { where = 'WHERE p.status = ?'; params.push(status); }
  return db.prepare(`SELECT p.id, p.protocolo, p.tipo, p.documento, p.nome, p.email, p.telefone, p.tipo_conta, p.status, p.motivo,
      p.cliente_id, p.conta_id, p.criado_em, p.analisado_em, u.nome AS analisado_por
    FROM propostas_conta p LEFT JOIN usuarios u ON u.id = p.usuario_id ${where}
    ORDER BY CASE p.status WHEN 'em_analise' THEN 0 ELSE 1 END, p.id DESC LIMIT 300`).all(...params);
}

function detalhar(db, id) {
  const p = db.prepare('SELECT * FROM propostas_conta WHERE id = ?').get(id);
  if (!p) throw naoEncontrado('Proposta');
  return { ...p, dados: JSON.parse(p.dados) };
}

function exigirEmAnalise(p) {
  if (p.status !== 'em_analise') throw new ErroNegocio(`Esta proposta já foi ${p.status === 'aprovada' ? 'aprovada' : 'recusada'}.`, 409);
}

/** Aprova: cria cliente, conta e acesso ao Internet Banking numa única transação. */
function aprovar(db, req, id) {
  const p = detalhar(db, id);
  exigirEmAnalise(p);
  return transacao(db, () => {
    if (db.prepare('SELECT 1 FROM clientes WHERE documento = ?').get(p.documento)) {
      throw new ErroNegocio('Já existe cliente com este documento. Recuse a proposta ou trate pelo cadastro.', 409);
    }
    const clienteId = inserirCliente(db, { ...p.dados, status: 'ativo', observacoes: `Conta aberta pelo site (protocolo ${p.protocolo}).` });
    const { agencia, numero, digito } = proximoNumero(db);
    // Quem aprova sendo gerente passa a ser o gerente de relacionamento da conta.
    const gerenteId = req.usuario.perfil === 'gerente' ? req.usuario.id : null;
    const contaId = Number(db.prepare('INSERT INTO contas (cliente_id, tipo, agencia, numero, digito, limite_centavos, gerente_id) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(clienteId, p.tipo_conta, agencia, numero, digito, gerenteId).lastInsertRowid);
    const senha = habilitarAcesso(db, clienteId);
    db.prepare("UPDATE propostas_conta SET status = 'aprovada', cliente_id = ?, conta_id = ?, usuario_id = ?, analisado_em = datetime('now') WHERE id = ?")
      .run(clienteId, contaId, req.usuario.id, p.id);
    registrar(db, req, 'aprovar_abertura', 'cliente', clienteId, { protocolo: p.protocolo, conta: `${agencia}/${numero}-${digito}` });
    return { cliente_id: clienteId, conta: buscarConta(db, contaId), senha_provisoria: senha, documento: p.documento, nome: p.nome };
  });
}

function recusar(db, req, id, motivo) {
  const p = detalhar(db, id);
  exigirEmAnalise(p);
  const m = v.texto(motivo, 300);
  v.exigir(m, 'Informe o motivo da recusa (registro interno).');
  db.prepare("UPDATE propostas_conta SET status = 'recusada', motivo = ?, usuario_id = ?, analisado_em = datetime('now') WHERE id = ?").run(m, req.usuario.id, p.id);
  registrar(db, req, 'recusar_abertura', 'proposta', p.id, { protocolo: p.protocolo, motivo: m });
  return { ok: true };
}

module.exports = { criarProposta, consultar, listar, detalhar, aprovar, recusar, STATUS };
