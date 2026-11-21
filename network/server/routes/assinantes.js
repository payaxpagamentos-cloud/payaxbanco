'use strict';

const { Router } = require('express');
const { agora, proximoNumero } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, like, conferirVersao, csv } = require('../lib/http');
const { dataLocal } = require('../lib/datas');
const { endereco } = require('../lib/enderecos');
const ficha = require('../lib/ficha');
const portal = require('../lib/portal');
const v = require('../lib/validacao');


function dadosAssinante(b, atual = {}) {
  const val = (k, f) => (b[k] !== undefined ? f(b[k]) : atual[k] ?? null);
  const tipo = val('tipo', (x) => v.opcao(x, 'o tipo', ['pf', 'pj'])) ?? 'pf';
  const documento = val('documento', (x) => {
    const t = v.digitos(x);
    v.exigir(t, tipo === 'pj' ? 'Informe o CNPJ.' : 'Informe o CPF.');
    v.exigir(tipo === 'pj' ? v.cnpjValido(t) : v.cpfValido(t), `${tipo === 'pj' ? 'CNPJ' : 'CPF'} inválido: confira os dígitos.`);
    return t;
  });
  v.exigir(tipo === 'pj' ? documento?.length === 14 : documento?.length === 11, `O documento não combina com o tipo (${tipo === 'pj' ? 'CNPJ tem 14 dígitos' : 'CPF tem 11 dígitos'}).`);
  return {
    tipo,
    nome: val('nome', (x) => v.texto(x, tipo === 'pj' ? 'a razão social' : 'o nome', 160)),
    nome_fantasia: val('nome_fantasia', (x) => v.opcional(x, 'o nome fantasia', 160)),
    documento,
    identidade: val('identidade', (x) => v.opcional(x, tipo === 'pj' ? 'a inscrição estadual' : 'o RG', 40)),
    nascimento: val('nascimento', (x) => v.dataOpcional(x, 'a data de nascimento')),
    email: val('email', (x) => (x ? v.email(x) : null)),
    telefone: val('telefone', (x) => (x ? v.telefone(x) : null)),
    telefone2: val('telefone2', (x) => (x ? v.telefone(x) : null)),
    ...endereco(b, atual),
    observacoes: val('observacoes', (x) => v.opcional(x, 'as observações', 1000)),
    consentimento_em: b.consentimento !== undefined ? (v.booleano(b.consentimento) ? atual.consentimento_em ?? agora() : null) : atual.consentimento_em ?? null,
  };
}

/** Assinantes: as pessoas e as empresas atendidas. */
module.exports = (db) => {
  const r = Router();
  const hoje = (req) => dataLocal(req.usuario.fuso);
  const buscar = (req, id) => {
    const x = db.prepare('SELECT * FROM assinantes WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Assinante não encontrado.', 404);
    return x;
  };

  // ---------------- Assinantes ----------------
  r.get('/', exigir('assinantes.ver'), (req, res) => {
    const f = ['a.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.busca) {
      const t = String(req.query.busca).trim();
      f.push("(a.nome LIKE ? ESCAPE '\\' OR a.nome_fantasia LIKE ? ESCAPE '\\' OR a.documento LIKE ? ESCAPE '\\' OR a.codigo = ?)");
      p.push(like(t), like(t), like(v.digitos(t) || t), Number(t.replace(/\D/g, '')) || -1);
    }
    if (req.query.situacao) { f.push('a.situacao = ?'); p.push(String(req.query.situacao)); }
    if (req.query.bairro) { f.push("a.bairro LIKE ? ESCAPE '\\'"); p.push(like(req.query.bairro)); }
    const sql = `SELECT a.*, (SELECT COUNT(*) FROM contratos c WHERE c.assinante_id = a.id AND c.situacao <> 'cancelado') AS contratos_ativos,
      (SELECT COUNT(*) FROM contratos c WHERE c.assinante_id = a.id AND c.situacao = 'bloqueado') AS contratos_bloqueados,
      (SELECT COALESCE(SUM(fa.valor_centavos - fa.pago_centavos), 0) FROM faturas fa WHERE fa.assinante_id = a.id AND fa.situacao IN ('aberta','parcial')) AS saldo_centavos,
      (SELECT COUNT(*) FROM faturas fa WHERE fa.assinante_id = a.id AND fa.situacao IN ('aberta','parcial') AND fa.vencimento < ?) AS faturas_vencidas
      FROM assinantes a WHERE ${f.join(' AND ')} ORDER BY a.nome`;
    res.json(listaPaginada(db, sql, [hoje(req), ...p], req.query, { padrao: 50 }));
  });

  r.post('/', exigir('assinantes.editar'), (req, res) => {
    const d = dadosAssinante(req.body ?? {});
    v.exigir(d.nome, 'Informe o nome.');
    const existente = db.prepare('SELECT id, nome, codigo FROM assinantes WHERE organizacao_id = ? AND documento = ?').get(req.org, d.documento);
    if (existente) throw new ErroNegocio(`Este ${d.tipo === 'pj' ? 'CNPJ' : 'CPF'} já é do assinante ${existente.codigo} · ${existente.nome}.`, 409);
    const codigo = proximoNumero(db, req.org, 'assinante');
    const id = Number(db.prepare(`INSERT INTO assinantes (organizacao_id, codigo, tipo, nome, nome_fantasia, documento, identidade, nascimento, email, telefone, telefone2,
      cep, logradouro, numero, complemento, bairro, cidade, uf, latitude, longitude, observacoes, consentimento_em, criado_por, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.org, codigo, d.tipo, d.nome, d.nome_fantasia, d.documento, d.identidade, d.nascimento, d.email, d.telefone, d.telefone2, d.cep, d.logradouro,
        d.numero, d.complemento, d.bairro, d.cidade, d.uf, d.latitude, d.longitude, d.observacoes, d.consentimento_em, req.usuario.id, agora()).lastInsertRowid);
    registrar(db, req, 'assinante_criado', { recurso: 'assinante', recursoId: id, depois: { codigo, ...d } });
    res.status(201).json(buscar(req, id));
  });

  /*
   * Ficha do assinante: a resposta traz TUDO que se sabe do cliente — cadastro, contratos com o serviço no
   * equipamento, faturas com itens e baixas, bloqueios, confianças, o que a régua já fez, chamados e uma linha
   * do tempo unificada. É uma chamada só porque é uma conversa só: quem atende precisa do todo ao mesmo tempo.
   * Cada seção respeita a permissão de quem pediu, e o que ficou de fora vem em `secoes_ocultas`.
   */
  /* ---------------- Acesso ao portal ---------------- */

  /**
   * Gera o código de primeiro acesso (ou de redefinição) do assinante.
   *
   * O código aparece UMA vez, nesta resposta, e depois só existe em hash. Quem o entrega ao cliente é a
   * equipe, pelo canal que já usa com ele — enquanto não houver provedor de mensagens, não há como o
   * sistema enviar, e fingir que envia seria pior do que dizer que não envia.
   */
  r.post('/:id/portal/convite', exigir('assinantes.editar'), (req, res) => {
    const a = buscar(req, req.params.id);
    const motivo = v.opcao(req.body?.motivo ?? 'primeiro_acesso', 'o motivo', ['primeiro_acesso', 'redefinir']);
    const convite = portal.criarConvite(db, { org: req.org, assinanteId: a.id, motivo, usuarioId: req.usuario.id });
    // O código NÃO vai para a auditoria: lá fica só o fato de ter sido gerado, e por quem.
    registrar(db, req, 'portal_convite_gerado', { recurso: 'assinante', recursoId: a.id, depois: { motivo, expira_em: convite.expira_em } });
    res.status(201).json({
      ...convite,
      aviso: `Entregue este código ao assinante pelo canal que vocês já usam. Ele vale ${convite.horas} horas, serve uma vez `
        + 'e não poderá ser visto de novo.',
    });
  });

  r.get('/:id/portal', exigir('assinantes.ver'), (req, res) => {
    const a = buscar(req, req.params.id);
    res.json(portal.situacaoDoAcesso(db, a.id));
  });

  r.delete('/:id/portal', exigir('assinantes.editar'), (req, res) => {
    const a = buscar(req, req.params.id);
    const r2 = portal.desativar(db, a.id);
    registrar(db, req, 'portal_acesso_desativado', { recurso: 'assinante', recursoId: a.id, depois: r2 });
    res.json({ ...r2, aviso: 'O assinante não entra mais no portal, e qualquer convite em aberto foi cancelado.' });
  });

  r.get('/:id', exigir('assinantes.ver'), (req, res) => {
    res.json(ficha.montar(db, { org: req.org, assinante: buscar(req, req.params.id), perfil: req.usuario.perfil, hoje: hoje(req) }));
  });

  r.patch('/:id', exigir('assinantes.editar'), (req, res) => {
    const antes = buscar(req, req.params.id);
    conferirVersao(antes.versao, req.body?.versao);
    const d = dadosAssinante(req.body ?? {}, antes);
    if (d.documento !== antes.documento && db.prepare('SELECT 1 FROM assinantes WHERE organizacao_id = ? AND documento = ? AND id <> ?').get(req.org, d.documento, antes.id)) {
      throw new ErroNegocio('Já existe outro assinante com este documento.', 409);
    }
    db.prepare(`UPDATE assinantes SET tipo = ?, nome = ?, nome_fantasia = ?, documento = ?, identidade = ?, nascimento = ?, email = ?, telefone = ?, telefone2 = ?,
      cep = ?, logradouro = ?, numero = ?, complemento = ?, bairro = ?, cidade = ?, uf = ?, latitude = ?, longitude = ?, observacoes = ?, consentimento_em = ?,
      versao = versao + 1 WHERE id = ?`).run(d.tipo, d.nome, d.nome_fantasia, d.documento, d.identidade, d.nascimento, d.email, d.telefone, d.telefone2, d.cep,
      d.logradouro, d.numero, d.complemento, d.bairro, d.cidade, d.uf, d.latitude, d.longitude, d.observacoes, d.consentimento_em, antes.id);
    registrar(db, req, 'assinante_alterado', { recurso: 'assinante', recursoId: antes.id, antes, depois: d });
    res.json(buscar(req, antes.id));
  });

  r.get('/csv/lista', exigir('assinantes.ver'), (req, res) => {
    const linhas = [['Código', 'Tipo', 'Nome', 'Documento', 'Telefone', 'Cidade', 'UF', 'Bairro', 'Situação', 'Contratos ativos', 'Saldo em aberto (R$)']];
    const itens = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM contratos c WHERE c.assinante_id = a.id AND c.situacao <> 'cancelado') AS ativos,
      (SELECT COALESCE(SUM(f.valor_centavos - f.pago_centavos), 0) FROM faturas f WHERE f.assinante_id = a.id AND f.situacao IN ('aberta','parcial')) AS saldo
      FROM assinantes a WHERE a.organizacao_id = ? ORDER BY a.codigo`).all(req.org);
    for (const x of itens) {
      linhas.push([x.codigo, x.tipo === 'pj' ? 'PJ' : 'PF', x.nome, x.documento, x.telefone, x.cidade, x.uf, x.bairro, x.situacao, x.ativos, (x.saldo / 100).toFixed(2).replace('.', ',')]);
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="assinantes-${hoje(req)}.csv"` }).send(csv(linhas));
  });

  return r;
};
