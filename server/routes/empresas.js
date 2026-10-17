'use strict';

const { Router } = require('express');
const { permitir } = require('../auth');
const { transacao } = require('../db');
const { filtroCarteira, empresaPermitida } = require('../lib/acesso');
const { prepararEmpresa } = require('../lib/carteira');
const { registrar } = require('../lib/auditoria');
const { hoje } = require('../lib/datas');
const v = require('../lib/validacao');

const PLANOS = ['essencial', 'completo', 'premium'];
const STATUS = ['implantacao', 'ativa', 'suspensa', 'encerrada'];

function dadosEmpresa(db, corpo, atual = {}) {
  const d = { ...atual, ...corpo };
  const razao = v.texto(d.razao_social, 160);
  v.exigir(razao, 'Informe a razão social.');
  const cnpj = v.digitos(d.cnpj);
  v.exigir(v.cnpjValido(cnpj), 'CNPJ inválido.');
  const email = v.texto(d.email, 120);
  v.exigir(!email || v.emailValido(email), 'E-mail inválido.');
  const analista = v.id(d.analista_id);
  if (analista) v.exigir(db.prepare('SELECT 1 FROM usuarios WHERE id = ? AND ativo = 1').get(analista), 'Analista não encontrado.');
  v.exigir(PLANOS.includes(d.plano ?? 'essencial'), 'Plano inválido.');
  v.exigir(STATUS.includes(d.status ?? 'ativa'), 'Situação inválida.');
  const dia = Number(d.dia_vencimento ?? 10);
  v.exigir(Number.isInteger(dia) && dia >= 1 && dia <= 28, 'Dia de vencimento da mensalidade: de 1 a 28.');
  const inicio = v.data(d.inicio_contrato || hoje(), 'o início do contrato');
  const fim = d.fim_contrato ? v.data(d.fim_contrato, 'o fim do contrato') : null;
  v.exigir(!fim || fim >= inicio, 'O fim do contrato deve ser depois do início.');
  return {
    razao_social: razao, nome_fantasia: v.texto(d.nome_fantasia, 120), cnpj, email, telefone: v.digitos(d.telefone) || null,
    responsavel: v.texto(d.responsavel, 120), analista_id: analista, plano: d.plano ?? 'essencial',
    mensalidade_centavos: v.valorCentavos(d.mensalidade_centavos ?? 0, 'valor da mensalidade', { zero: true }),
    dia_vencimento: dia, inicio_contrato: inicio, fim_contrato: fim, status: d.status ?? 'ativa', observacoes: v.texto(d.observacoes, 2000),
  };
}

module.exports = (db) => {
  const r = Router();

  r.get('/', (req, res) => {
    const f = filtroCarteira(req.usuario);
    const filtros = [f.sql];
    const params = [...f.params];
    if (req.query.status) { filtros.push('e.status = ?'); params.push(req.query.status); }
    if (req.query.analista_id) { filtros.push('e.analista_id = ?'); params.push(Number(req.query.analista_id)); }
    if (req.query.busca) {
      filtros.push('(e.razao_social LIKE ? OR e.nome_fantasia LIKE ? OR e.cnpj LIKE ?)');
      const b = `%${req.query.busca}%`;
      params.push(b, b, `%${v.digitos(req.query.busca) || req.query.busca}%`);
    }
    const dia = hoje();
    res.json(db.prepare(`SELECT e.*, u.nome AS analista_nome,
        (SELECT COUNT(*) FROM tarefas t WHERE t.empresa_id = e.id AND t.status = 'aberta' AND t.vencimento < ?) AS tarefas_atrasadas,
        (SELECT COUNT(*) FROM lancamentos l WHERE l.empresa_id = e.id AND l.status = 'aberto' AND l.vencimento < ?) AS lancamentos_vencidos,
        (SELECT COUNT(*) FROM extrato x WHERE x.empresa_id = e.id AND x.status = 'pendente') AS extrato_pendente
      FROM empresas e LEFT JOIN usuarios u ON u.id = e.analista_id
      WHERE ${filtros.join(' AND ')} ORDER BY e.status = 'encerrada', COALESCE(e.nome_fantasia, e.razao_social)`).all(dia, dia, ...params));
  });

  r.post('/', permitir('admin', 'supervisor'), (req, res) => {
    const d = dadosEmpresa(db, req.body);
    const id = transacao(db, () => {
      const x = db.prepare(`INSERT INTO empresas (razao_social, nome_fantasia, cnpj, email, telefone, responsavel, analista_id, plano,
        mensalidade_centavos, dia_vencimento, inicio_contrato, fim_contrato, status, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(d.razao_social, d.nome_fantasia, d.cnpj, d.email, d.telefone, d.responsavel, d.analista_id, d.plano, d.mensalidade_centavos,
          d.dia_vencimento, d.inicio_contrato, d.fim_contrato, d.status, d.observacoes);
      const novo = Number(x.lastInsertRowid);
      prepararEmpresa(db, novo, d.analista_id);
      return novo;
    });
    registrar(db, req, 'empresa_criada', { razao_social: d.razao_social, cnpj: d.cnpj }, id);
    res.status(201).json({ id });
  });

  r.get('/:id', (req, res) => {
    const e = empresaPermitida(db, req.usuario, req.params.id);
    const analista = e.analista_id ? db.prepare('SELECT id, nome FROM usuarios WHERE id = ?').get(e.analista_id) : null;
    res.json({ ...e, analista_nome: analista?.nome ?? null });
  });

  // Dados do contrato, analista e situação: só administrador e supervisor.
  r.patch('/:id', permitir('admin', 'supervisor'), (req, res) => {
    const atual = empresaPermitida(db, req.usuario, req.params.id);
    const d = dadosEmpresa(db, req.body, atual);
    db.prepare(`UPDATE empresas SET razao_social = ?, nome_fantasia = ?, cnpj = ?, email = ?, telefone = ?, responsavel = ?, analista_id = ?,
      plano = ?, mensalidade_centavos = ?, dia_vencimento = ?, inicio_contrato = ?, fim_contrato = ?, status = ?, observacoes = ? WHERE id = ?`)
      .run(d.razao_social, d.nome_fantasia, d.cnpj, d.email, d.telefone, d.responsavel, d.analista_id, d.plano, d.mensalidade_centavos,
        d.dia_vencimento, d.inicio_contrato, d.fim_contrato, d.status, d.observacoes, atual.id);
    const mudou = Object.keys(d).filter((k) => d[k] !== atual[k]);
    registrar(db, req, 'empresa_alterada', { campos: mudou }, atual.id);
    res.status(204).end();
  });

  return r;
};
