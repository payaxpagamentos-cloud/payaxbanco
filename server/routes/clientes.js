'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { hashSenha } = require('../lib/senha');
const { permitir } = require('../auth');
const { naoEncontrado, ErroNegocio } = require('../lib/erros');
const v = require('../lib/validacao');
const { registrar } = require('../lib/auditoria');
const { paginacao } = require('../lib/paginacao');

const CAMPOS = ['tipo','nome','documento','email','telefone','data_nascimento','renda_mensal_centavos',
  'cep','logradouro','numero','complemento','bairro','cidade','uf','status','observacoes'];

function normalizar(body, atual = {}) {
  const d = { ...atual, ...body };
  const c = {
    tipo: d.tipo,
    nome: v.texto(d.nome, 150),
    documento: v.digitos(d.documento),
    email: v.texto(d.email, 150)?.toLowerCase() ?? null,
    telefone: v.digitos(d.telefone) || null,
    data_nascimento: v.texto(d.data_nascimento, 10),
    renda_mensal_centavos: Number(d.renda_mensal_centavos ?? 0),
    cep: v.digitos(d.cep) || null,
    logradouro: v.texto(d.logradouro, 150),
    numero: v.texto(d.numero, 20),
    complemento: v.texto(d.complemento, 80),
    bairro: v.texto(d.bairro, 80),
    cidade: v.texto(d.cidade, 80),
    uf: v.texto(d.uf, 2)?.toUpperCase() ?? null,
    status: d.status || 'ativo',
    observacoes: v.texto(d.observacoes, 1000),
  };
  v.exigir(['PF','PJ'].includes(c.tipo), 'Tipo de cliente deve ser PF ou PJ.');
  v.exigir(c.nome && c.nome.length >= 3, 'Informe o nome completo / razão social.');
  v.exigir(c.tipo === 'PF' ? v.cpfValido(c.documento) : v.cnpjValido(c.documento),
    c.tipo === 'PF' ? 'CPF inválido.' : 'CNPJ inválido.');
  v.exigir(!c.email || v.emailValido(c.email), 'E-mail inválido.');
  v.exigir(!c.telefone || (c.telefone.length >= 10 && c.telefone.length <= 11), 'Telefone deve ter DDD + número.');
  v.exigir(!c.data_nascimento || v.dataValida(c.data_nascimento), 'Data de nascimento/fundação inválida.');
  v.exigir(Number.isInteger(c.renda_mensal_centavos) && c.renda_mensal_centavos >= 0, 'Renda/faturamento inválido.');
  v.exigir(!c.cep || c.cep.length === 8, 'CEP deve ter 8 dígitos.');
  v.exigir(!c.uf || v.UFS.includes(c.uf), 'UF inválida.');
  v.exigir(['ativo','inativo','bloqueado'].includes(c.status), 'Status inválido.');
  return c;
}

module.exports = (db) => {
  const r = Router();

  r.get('/', (req, res) => {
    const { limite, offset, pagina } = paginacao(req.query);
    const filtros = [];
    const params = [];
    if (req.query.q) {
      filtros.push('(nome LIKE ? OR documento LIKE ? OR email LIKE ?)');
      const q = `%${String(req.query.q).trim()}%`;
      const qd = v.digitos(req.query.q);
      params.push(q, qd ? `%${qd}%` : q, q);
    }
    if (req.query.status) { filtros.push('status = ?'); params.push(req.query.status); }
    if (req.query.tipo) { filtros.push('tipo = ?'); params.push(req.query.tipo); }
    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM clientes ${where}`).get(...params);
    const itens = db.prepare(`
      SELECT cl.*, (SELECT COUNT(*) FROM contas c WHERE c.cliente_id = cl.id AND c.status <> 'encerrada') AS contas_ativas,
             (SELECT COALESCE(SUM(saldo_centavos),0) FROM contas c WHERE c.cliente_id = cl.id) AS saldo_total_centavos
      FROM clientes cl ${where} ORDER BY cl.nome LIMIT ? OFFSET ?`).all(...params, limite, offset);
    res.json({ itens, total, pagina, limite });
  });

  r.get('/:id', (req, res) => {
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
    if (!cliente) throw naoEncontrado('Cliente');
    cliente.contas = db.prepare('SELECT * FROM contas WHERE cliente_id = ? ORDER BY aberta_em').all(cliente.id);
    cliente.emprestimos = db.prepare('SELECT * FROM emprestimos WHERE cliente_id = ? ORDER BY criado_em DESC').all(cliente.id);
    res.json(cliente);
  });

  r.post('/', permitir('admin', 'gerente', 'operador'), (req, res) => {
    const c = normalizar(req.body ?? {});
    if (db.prepare('SELECT 1 FROM clientes WHERE documento = ?').get(c.documento)) {
      throw new ErroNegocio('Já existe cliente com este documento.', 409);
    }
    const cols = CAMPOS.join(', ');
    const res1 = db.prepare(`INSERT INTO clientes (${cols}) VALUES (${CAMPOS.map(() => '?').join(', ')})`)
      .run(...CAMPOS.map((k) => c[k]));
    const id = Number(res1.lastInsertRowid);
    registrar(db, req, 'criar', 'cliente', id, { nome: c.nome, documento: c.documento });
    res.status(201).json(db.prepare('SELECT * FROM clientes WHERE id = ?').get(id));
  });

  r.put('/:id', permitir('admin', 'gerente', 'operador'), (req, res) => {
    const atual = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
    if (!atual) throw naoEncontrado('Cliente');
    const c = normalizar(req.body ?? {}, atual);
    v.exigir(c.documento === atual.documento && c.tipo === atual.tipo, 'Documento e tipo do cliente não podem ser alterados.');
    if (c.status !== atual.status && req.usuario.perfil === 'operador') {
      throw new ErroNegocio('Apenas gerentes podem alterar o status do cliente.', 403);
    }
    db.prepare(`UPDATE clientes SET ${CAMPOS.map((k) => `${k} = ?`).join(', ')}, atualizado_em = datetime('now') WHERE id = ?`)
      .run(...CAMPOS.map((k) => c[k]), atual.id);
    const mudancas = Object.fromEntries(CAMPOS.filter((k) => c[k] !== atual[k]).map((k) => [k, c[k]]));
    registrar(db, req, 'atualizar', 'cliente', atual.id, mudancas);
    res.json(db.prepare('SELECT * FROM clientes WHERE id = ?').get(atual.id));
  });

  // ---------- Internet Banking do cliente ----------
  const statusIb = (clienteId) => db.prepare(`SELECT status, precisa_trocar_senha, (pin_hash IS NOT NULL) AS tem_pin, limite_diario_centavos,
      ultimo_acesso, bloqueado_ate, criado_em FROM acessos_cliente WHERE cliente_id = ?`).get(clienteId) ?? null;
  const senhaProvisoria = () => {
    const letras = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
    const bytes = crypto.randomBytes(10);
    return [...bytes].map((b, i) => (i % 3 === 2 ? String(b % 10) : letras[b % letras.length])).join('');
  };
  const clienteAtivo = (id) => {
    const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
    if (!c) throw naoEncontrado('Cliente');
    return c;
  };

  r.get('/:id/internet-banking', (req, res) => res.json(statusIb(clienteAtivo(req.params.id).id)));

  r.post('/:id/internet-banking', permitir('admin', 'gerente', 'operador'), (req, res) => {
    const c = clienteAtivo(req.params.id);
    if (c.status !== 'ativo') throw new ErroNegocio('Só clientes ativos podem ter Internet Banking.', 409);
    if (statusIb(c.id)) throw new ErroNegocio('Internet Banking já habilitado. Use “Redefinir senha”.', 409);
    const senha = senhaProvisoria();
    db.prepare('INSERT INTO acessos_cliente (cliente_id, senha_hash) VALUES (?, ?)').run(c.id, hashSenha(senha));
    registrar(db, req, 'ib_habilitar', 'cliente', c.id);
    res.status(201).json({ ...statusIb(c.id), senha_provisoria: senha });
  });

  r.post('/:id/internet-banking/redefinir-senha', permitir('admin', 'gerente', 'operador'), (req, res) => {
    const c = clienteAtivo(req.params.id);
    if (!statusIb(c.id)) throw naoEncontrado('Acesso ao Internet Banking');
    const senha = senhaProvisoria();
    db.prepare(`UPDATE acessos_cliente SET senha_hash = ?, pin_hash = NULL, precisa_trocar_senha = 1, tentativas = 0, tentativas_pin = 0,
      bloqueado_ate = NULL WHERE cliente_id = ?`).run(hashSenha(senha), c.id);
    registrar(db, req, 'ib_redefinir_senha', 'cliente', c.id);
    res.json({ ...statusIb(c.id), senha_provisoria: senha });
  });

  r.patch('/:id/internet-banking', permitir('admin', 'gerente'), (req, res) => {
    const c = clienteAtivo(req.params.id);
    const atual = statusIb(c.id);
    if (!atual) throw naoEncontrado('Acesso ao Internet Banking');
    const status = req.body?.status ?? atual.status;
    const limite = req.body?.limite_diario_centavos === undefined ? atual.limite_diario_centavos : Number(req.body.limite_diario_centavos);
    v.exigir(['ativo', 'bloqueado'].includes(status), 'Status inválido.');
    v.exigir(Number.isInteger(limite) && limite >= 0 && limite <= 100_000_000, 'Limite diário inválido.');
    db.prepare('UPDATE acessos_cliente SET status = ?, limite_diario_centavos = ?, tentativas = 0, tentativas_pin = 0, bloqueado_ate = NULL WHERE cliente_id = ?')
      .run(status, limite, c.id);
    registrar(db, req, 'ib_atualizar', 'cliente', c.id, { status, limite_diario_centavos: limite });
    res.json(statusIb(c.id));
  });

  r.delete('/:id', permitir('admin'), (req, res) => {
    const atual = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
    if (!atual) throw naoEncontrado('Cliente');
    if (db.prepare('SELECT 1 FROM contas WHERE cliente_id = ?').get(atual.id) || statusIb(atual.id)) {
      throw new ErroNegocio('Cliente possui contas ou acesso ao Internet Banking. Inative-o em vez de excluir.', 409);
    }
    db.prepare('DELETE FROM clientes WHERE id = ?').run(atual.id);
    registrar(db, req, 'excluir', 'cliente', atual.id, { nome: atual.nome });
    res.status(204).end();
  });

  return r;
};
