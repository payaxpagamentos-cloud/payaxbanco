'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { exigir } = require('../auth');
const { hashSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { PERFIS, P } = require('../lib/permissoes');
const { listaPaginada } = require('../lib/http');
const v = require('../lib/validacao');

const FUSOS = ['America/Sao_Paulo', 'America/Manaus', 'America/Cuiaba', 'America/Rio_Branco', 'America/Noronha', 'America/Belem', 'America/Fortaleza',
  'America/Recife', 'America/Bahia', 'America/Porto_Velho', 'America/Boa_Vista', 'America/Campo_Grande'];

/** Percentual digitado ("2", "2,5") guardado em centésimos de ponto (2,5% → 250). */
function percentual(valor, nome, maximo) {
  const n = v.numero(valor, nome, { min: 0, max: maximo });
  return Math.round(n * 100);
}

/** Dados da organização, usuários e histórico de auditoria. */
module.exports = (db) => {
  const r = Router();

  r.get('/', (req, res) => {
    res.json({ ...db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org), perfis: PERFIS, matriz: P, fusos: FUSOS });
  });

  r.patch('/', exigir('organizacao.editar'), (req, res) => {
    const antes = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org);
    const b = req.body ?? {};
    const d = {
      nome: b.nome !== undefined ? v.texto(b.nome, 'o nome', 120) : antes.nome,
      fuso: b.fuso !== undefined ? v.opcao(b.fuso, 'o fuso', FUSOS) : antes.fuso,
      aprovacao_manutencao_centavos: b.aprovacao_manutencao !== undefined ? v.centavos(b.aprovacao_manutencao, 'o limite de aprovação') : antes.aprovacao_manutencao_centavos,
      janela_recorrencia_min: b.janela_recorrencia_min !== undefined ? v.inteiro(b.janela_recorrencia_min, 'a janela de recorrência', { max: 1440 }) : antes.janela_recorrencia_min,
      desatualizado_min: b.desatualizado_min !== undefined ? v.inteiro(b.desatualizado_min, 'o tempo de desatualização', { min: 1, max: 1440 }) : antes.desatualizado_min,
      reserva_porta_horas: b.reserva_porta_horas !== undefined ? v.inteiro(b.reserva_porta_horas, 'a validade da reserva', { min: 1, max: 720 }) : antes.reserva_porta_horas,
      // Faturamento e cobrança. A carência vale sobre qualquer regra da régua: nenhuma bloqueia antes dela.
      dia_vencimento_padrao: b.dia_vencimento_padrao !== undefined ? v.inteiro(b.dia_vencimento_padrao, 'o dia de vencimento padrão', { min: 1, max: 28 }) : antes.dia_vencimento_padrao,
      carencia_bloqueio_dias: b.carencia_bloqueio_dias !== undefined ? v.inteiro(b.carencia_bloqueio_dias, 'a carência antes do bloqueio', { max: 180 }) : antes.carencia_bloqueio_dias,
      multa_atraso_pct_centesimos: b.multa_atraso_pct !== undefined ? percentual(b.multa_atraso_pct, 'a multa por atraso', 20) : antes.multa_atraso_pct_centesimos,
      juros_mes_pct_centesimos: b.juros_mes_pct !== undefined ? percentual(b.juros_mes_pct, 'os juros ao mês', 20) : antes.juros_mes_pct_centesimos,
      pro_rata: b.pro_rata !== undefined ? (v.booleano(b.pro_rata) ? 1 : 0) : antes.pro_rata,
      confianca_dias: b.confianca_dias !== undefined ? v.inteiro(b.confianca_dias, 'o prazo do desbloqueio de confiança', { max: 90 }) : antes.confianca_dias,
      confianca_max_ano: b.confianca_max_ano !== undefined ? v.inteiro(b.confianca_max_ano, 'o limite de confiança por ano', { max: 24 }) : antes.confianca_max_ano,
      // Provisionamento: o corte no equipamento acompanha o bloqueio comercial?
      provisionamento_automatico: b.provisionamento_automatico !== undefined ? (v.booleano(b.provisionamento_automatico) ? 1 : 0) : antes.provisionamento_automatico,
      corte_automatico: b.corte_automatico !== undefined ? (v.booleano(b.corte_automatico) ? 1 : 0) : antes.corte_automatico,
      reconciliacao_horas: b.reconciliacao_horas !== undefined ? v.inteiro(b.reconciliacao_horas, 'o intervalo de reconciliação', { max: 720 }) : antes.reconciliacao_horas,
    };
    db.prepare(`UPDATE organizacoes SET nome = ?, fuso = ?, aprovacao_manutencao_centavos = ?, janela_recorrencia_min = ?, desatualizado_min = ?,
      reserva_porta_horas = ?, dia_vencimento_padrao = ?, carencia_bloqueio_dias = ?, multa_atraso_pct_centesimos = ?, juros_mes_pct_centesimos = ?,
      pro_rata = ?, confianca_dias = ?, confianca_max_ano = ?, provisionamento_automatico = ?, corte_automatico = ?, reconciliacao_horas = ? WHERE id = ?`)
      .run(d.nome, d.fuso, d.aprovacao_manutencao_centavos, d.janela_recorrencia_min, d.desatualizado_min, d.reserva_porta_horas, d.dia_vencimento_padrao,
        d.carencia_bloqueio_dias, d.multa_atraso_pct_centesimos, d.juros_mes_pct_centesimos, d.pro_rata, d.confianca_dias, d.confianca_max_ano,
        d.provisionamento_automatico, d.corte_automatico, d.reconciliacao_horas, req.org);
    registrar(db, req, 'organizacao_alterada', { recurso: 'organizacao', recursoId: req.org, antes, depois: d });
    res.json(db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org));
  });

  r.get('/usuarios', exigir('usuarios.gerenciar'), (req, res) => {
    res.json(db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.ativo, u.ultimo_acesso, u.criado_em, t.id AS tecnico_id FROM usuarios u
      LEFT JOIN tecnicos t ON t.usuario_id = u.id WHERE u.organizacao_id = ? ORDER BY u.nome`).all(req.org));
  });

  r.post('/usuarios', exigir('usuarios.gerenciar'), (req, res) => {
    const b = req.body ?? {};
    const email = v.email(b.email);
    if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Já existe um usuário com este e-mail.', 409);
    const d = { nome: v.texto(b.nome, 'o nome', 120), email, perfil: v.opcao(b.perfil, 'o perfil', Object.keys(PERFIS)) };
    const id = Number(db.prepare('INSERT INTO usuarios (organizacao_id, nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.org, d.nome, d.email, hashSenha(v.senha(b.senha)), d.perfil, agora()).lastInsertRowid);
    registrar(db, req, 'usuario_criado', { recurso: 'usuario', recursoId: id, depois: d });
    res.status(201).json({ id, ...d });
  });

  r.patch('/usuarios/:id', exigir('usuarios.gerenciar'), (req, res) => {
    const u = db.prepare('SELECT id, nome, perfil, ativo FROM usuarios WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!u) throw new ErroNegocio('Usuário não encontrado.', 404);
    const b = req.body ?? {};
    const d = {
      nome: b.nome !== undefined ? v.texto(b.nome, 'o nome', 120) : u.nome,
      perfil: b.perfil !== undefined ? v.opcao(b.perfil, 'o perfil', Object.keys(PERFIS)) : u.perfil,
      ativo: b.ativo !== undefined ? (v.booleano(b.ativo) ? 1 : 0) : u.ativo,
    };
    if (u.id === req.usuario.id && (d.perfil !== 'admin' || !d.ativo)) throw new ErroNegocio('Você não pode remover o próprio acesso de administrador.', 422);
    db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ? WHERE id = ?').run(d.nome, d.perfil, d.ativo, u.id);
    if (b.senha) db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(b.senha)), u.id);
    registrar(db, req, 'usuario_alterado', { recurso: 'usuario', recursoId: u.id, antes: u, depois: { ...d, senha_redefinida: Boolean(b.senha) } });
    res.json({ id: u.id, ...d });
  });

  r.get('/auditoria', exigir('auditoria.ver'), (req, res) => {
    const f = ['a.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.recurso) { f.push('a.recurso = ?'); p.push(String(req.query.recurso)); }
    if (req.query.recurso_id) { f.push('a.recurso_id = ?'); p.push(Number(req.query.recurso_id)); }
    if (req.query.acao) { f.push('a.acao = ?'); p.push(String(req.query.acao)); }
    res.json(listaPaginada(db, `SELECT a.*, u.nome AS usuario_nome FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE ${f.join(' AND ')} ORDER BY a.id DESC`, p, req.query));
  });

  return r;
};
