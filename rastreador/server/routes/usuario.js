'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const { Router } = require('express');
const { agora } = require('../db');
const { emitirTokenUsuarioFinal, autenticarUsuarioFinal } = require('../auth');
const { verificarSenha } = require('../lib/senha');
const { ErroNegocio } = require('../lib/erros');
const v = require('../lib/validacao');
const uf = require('../lib/usuariosFinais');
const seg = require('../lib/seguros');

/** App do cliente (usuário final): entra com e-mail ou CPF + senha e acompanha os veículos, o plano, os seguros e o atendimento. */
module.exports = (db) => {
  const r = Router();
  const autenticado = autenticarUsuarioFinal(db);

  r.post('/login', (req, res) => {
    const id = String(req.body.identificador ?? req.body.email ?? req.body.cpf ?? '').trim();
    const senha = String(req.body.senha ?? '');
    const q = 'SELECT uf.*, e.status AS es FROM usuarios_finais uf JOIN empresas e ON e.id = uf.empresa_id WHERE uf.ativo = 1 AND uf.senha_hash IS NOT NULL AND ';
    let lista = [];
    if (id.includes('@')) lista = db.prepare(`${q}uf.email = ?`).all(id.toLowerCase());
    else { const cpf = v.digitos(id); if (cpf) lista = db.prepare(`${q}uf.cpf = ?`).all(cpf); }
    const u = lista.find((x) => x.es === 'ativa' && verificarSenha(senha, x.senha_hash));
    if (!u) throw new ErroNegocio('E-mail/CPF ou senha incorretos. Fale com a empresa que fez o seu cadastro.', 401);
    db.prepare('UPDATE usuarios_finais SET ultimo_acesso = ? WHERE id = ?').run(agora(), u.id);
    res.json({ token: emitirTokenUsuarioFinal(u), usuario: { nome: u.nome } });
  });

  r.get('/painel', autenticado, (req, res) => res.json(uf.painel(db, req.usuarioFinal)));

  // Multas dos veículos do cliente.
  r.get('/multas', autenticado, (req, res) => {
    const multas = require('../lib/multas');
    const ids = db.prepare('SELECT veiculo_id FROM usuario_final_veiculos WHERE usuario_final_id = ?').all(req.usuarioFinal.id).map((x) => x.veiculo_id);
    res.json({ situacoes: multas.SITUACOES, multas: multas.listar(db, { empresaId: req.usuarioFinal.empresa_id, veiculoIds: ids }).map((m) => ({
      id: m.id, placa: m.placa, descricao: m.descricao, orgao: m.orgao, gravidade: m.gravidade, pontos: m.pontos, valor_centavos: m.valor_centavos,
      ocorrida_em: m.ocorrida_em, local_texto: m.local_texto, municipio: m.municipio, situacao: m.situacao, vencimento: m.vencimento, dias_vencimento: m.dias_vencimento })) });
  });

  // Seguros disponíveis para a empresa (para o cliente pedir um novo).
  r.get('/seguros', autenticado, (req, res) => res.json({
    tipos: seg.portfolioEmpresa(db, req.usuarioFinal.empresa_id)
      .map((t) => ({ id: t.id, nome: t.nome, descricao: t.descricao, icone: t.icone, preco_venda_centavos: t.preco_venda_centavos })),
  }));

  // O cliente solicita um seguro; nasce 'pendente' para a empresa tratar.
  r.post('/seguros/solicitar', autenticado, (req, res) => {
    const u = req.usuarioFinal;
    const t = seg.tipo(db, Number(req.body.tipo_id));
    v.exigir(t.ativo && seg.idsPortfolio(db, u.empresa_id).has(t.id), 'Esse seguro não está disponível.');
    let veiculoId = null;
    if (req.body.veiculo_id) {
      const ok = db.prepare('SELECT 1 FROM usuario_final_veiculos WHERE usuario_final_id = ? AND veiculo_id = ?').get(u.id, Number(req.body.veiculo_id));
      if (!ok) throw new ErroNegocio('Veículo não encontrado.', 404);
      veiculoId = Number(req.body.veiculo_id);
    }
    const margem = db.prepare('SELECT margem_percent FROM empresa_seguros WHERE empresa_id = ? AND tipo_id = ?').get(u.empresa_id, t.id)?.margem_percent ?? 0;
    const venda = seg.precoVenda(t.custo_centavos, margem);
    // Evita pedidos repetidos: um pedido pendente do mesmo seguro por cliente.
    const jaPediu = db.prepare("SELECT 1 FROM seguros_contratacoes WHERE usuario_final_id = ? AND tipo_id = ? AND status = 'pendente'").get(u.id, t.id);
    if (jaPediu) throw new ErroNegocio('Você já pediu esse seguro. A empresa vai confirmar em breve.', 409);
    db.prepare(`INSERT INTO seguros_contratacoes (empresa_id, tipo_id, usuario_id, veiculo_id, usuario_final_id, status, custo_centavos, margem_percent, valor_centavos, observacao, criada_em)
      VALUES (?,?,NULL,?,?,'pendente',?,?,?,?,?)`).run(u.empresa_id, t.id, veiculoId, u.id, t.custo_centavos, margem, venda, `Solicitado pelo app do cliente (${u.nome})`, agora());
    res.status(201).json({ ok: true });
  });

  return r;
};
