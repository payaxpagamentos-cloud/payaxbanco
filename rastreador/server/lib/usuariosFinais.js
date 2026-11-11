'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

// Usuário final (dono do veículo): entra no app do cliente e vê só os veículos, o plano, os seguros e o atendimento dele.
const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hashSenha } = require('./senha');
const rel = require('./relatorios');
const v = require('./validacao');

const resumo = (uf) => ({ id: uf.id, nome: uf.nome, email: uf.email, cpf: uf.cpf, telefone: uf.telefone, ativo: !!uf.ativo, ultimo_acesso: uf.ultimo_acesso, tem_senha: !!uf.senha_hash });
const senhaValida = (s) => { const t = String(s ?? ''); v.exigir(t.length >= 6, 'A senha deve ter ao menos 6 caracteres.'); return t; };

function buscar(db, empresaId, id) {
  const uf = db.prepare('SELECT * FROM usuarios_finais WHERE id = ? AND empresa_id = ?').get(Number(id), Number(empresaId));
  if (!uf) throw naoEncontrado('Usuário');
  return { ...resumo(uf), veiculos: db.prepare('SELECT veiculo_id FROM usuario_final_veiculos WHERE usuario_final_id = ?').all(uf.id).map((r) => r.veiculo_id) };
}
function listar(db, empresaId) {
  return db.prepare('SELECT * FROM usuarios_finais WHERE empresa_id = ? ORDER BY nome').all(Number(empresaId))
    .map((uf) => ({ ...resumo(uf), veiculos: db.prepare('SELECT veiculo_id FROM usuario_final_veiculos WHERE usuario_final_id = ?').all(uf.id).map((r) => r.veiculo_id) }));
}

function campos(d) {
  const nome = v.texto(d.nome, 'o nome', 80);
  const email = d.email && String(d.email).trim() ? v.email(d.email) : null;
  const cpf = d.cpf && String(d.cpf).trim() ? v.digitos(d.cpf) : null;
  const telefone = d.telefone && String(d.telefone).trim() ? v.telefone(d.telefone) : null;
  v.exigir(email || cpf, 'Informe ao menos o e-mail ou o CPF para o acesso.');
  if (cpf) v.exigir(v.cpfValido(cpf), 'CPF inválido.');
  return { nome, email, cpf, telefone };
}
const conflito = (e) => (String(e.message || '').includes('idx_uf_email') ? new ErroNegocio('Já existe um usuário com esse e-mail.', 409)
  : String(e.message || '').includes('idx_uf_cpf') ? new ErroNegocio('Já existe um usuário com esse CPF nesta empresa.', 409) : e);

/** Vincula os veículos (só os da própria empresa) ao usuário final, substituindo os anteriores. */
function vincular(db, empresaId, ufId, veiculoIds) {
  const daEmpresa = new Set(db.prepare('SELECT id FROM veiculos WHERE empresa_id = ?').all(Number(empresaId)).map((r) => r.id));
  const alvo = [...new Set((Array.isArray(veiculoIds) ? veiculoIds : []).map(Number).filter((n) => daEmpresa.has(n)))];
  db.prepare('DELETE FROM usuario_final_veiculos WHERE usuario_final_id = ?').run(Number(ufId));
  const ins = db.prepare('INSERT INTO usuario_final_veiculos (usuario_final_id, veiculo_id) VALUES (?, ?)');
  for (const id of alvo) ins.run(Number(ufId), id);
}

function criar(db, empresaId, d) {
  const x = campos(d);
  const senha = d.senha ? senhaValida(d.senha) : null;
  return transacao(db, () => {
    let id;
    try {
      ({ lastInsertRowid: id } = db.prepare('INSERT INTO usuarios_finais (empresa_id, nome, email, cpf, telefone, senha_hash, criado_em) VALUES (?,?,?,?,?,?,?)')
        .run(Number(empresaId), x.nome, x.email, x.cpf, x.telefone, senha ? hashSenha(senha) : null, agora()));
    } catch (e) { throw conflito(e); }
    vincular(db, empresaId, id, d.veiculos);
    return buscar(db, empresaId, id);
  });
}
function atualizar(db, empresaId, id, d) {
  buscar(db, empresaId, id);
  const x = campos(d);
  return transacao(db, () => {
    try {
      db.prepare('UPDATE usuarios_finais SET nome=?, email=?, cpf=?, telefone=?, ativo=? WHERE id=? AND empresa_id=?')
        .run(x.nome, x.email, x.cpf, x.telefone, v.booleano(d.ativo ?? true) ? 1 : 0, Number(id), Number(empresaId));
    } catch (e) { throw conflito(e); }
    if (d.senha) db.prepare('UPDATE usuarios_finais SET senha_hash=? WHERE id=?').run(hashSenha(senhaValida(d.senha)), Number(id));
    if (d.veiculos !== undefined) vincular(db, empresaId, id, d.veiculos);
    return buscar(db, empresaId, id);
  });
}
function definirSenha(db, empresaId, id, senha) {
  buscar(db, empresaId, id);
  db.prepare('UPDATE usuarios_finais SET senha_hash=? WHERE id=? AND empresa_id=?').run(hashSenha(senhaValida(senha)), Number(id), Number(empresaId));
}
function remover(db, empresaId, id) {
  buscar(db, empresaId, id);
  transacao(db, () => {
    db.prepare('DELETE FROM usuario_final_veiculos WHERE usuario_final_id = ?').run(Number(id));
    db.prepare('UPDATE seguros_contratacoes SET usuario_final_id = NULL WHERE usuario_final_id = ?').run(Number(id));
    db.prepare('DELETE FROM usuarios_finais WHERE id = ? AND empresa_id = ?').run(Number(id), Number(empresaId));
  });
}

/** Dados do app do cliente: veículos ao vivo, plano, seguros contratados e atendimento. */
function painel(db, uf) {
  const vinc = new Set(db.prepare('SELECT veiculo_id FROM usuario_final_veiculos WHERE usuario_final_id = ?').all(uf.id).map((r) => r.veiculo_id));
  const veiculos = rel.veiculosMapa(db, uf.empresa_id).filter((x) => vinc.has(x.id)).map((x) => ({
    id: x.id, placa: x.placa, descricao: x.descricao, tipo: x.tipo, situacao: x.situacao,
    velocidade_kmh: x.velocidade_kmh, ignicao: x.ignicao, tensao: x.tensao, bloqueado: !!x.bloqueado,
    lat: x.lat, lng: x.lng, posicao_em: x.posicao_em, comunicacao_em: x.comunicacao_em, modelo: x.rastreador_modelo,
  }));
  // plano_valor_centavos = o que a EMPRESA cobra do cliente final (não a mensalidade que a plataforma cobra da empresa).
  const emp = db.prepare('SELECT nome, plano_valor_centavos, plano_nome, atend_whatsapp, atend_telefone, atend_horario, telefone, email FROM empresas WHERE id = ?').get(uf.empresa_id);
  // Só os seguros DELE: os dos veículos vinculados a ele e os que ele mesmo pediu pelo app. Nunca os de outros clientes.
  const vids = [...vinc];
  const doVeiculo = vids.length ? `c.veiculo_id IN (${vids.map(() => '?').join(',')}) OR ` : '';
  const seguros = db.prepare(`SELECT c.id, c.status, c.valor_centavos, c.apolice_numero, c.criada_em, t.nome AS tipo_nome, t.icone AS tipo_icone, ve.placa AS veiculo_placa
    FROM seguros_contratacoes c JOIN seguros_tipos t ON t.id = c.tipo_id LEFT JOIN veiculos ve ON ve.id = c.veiculo_id
    WHERE c.empresa_id = ? AND (${doVeiculo}c.usuario_final_id = ?) AND c.status <> 'cancelada'
    ORDER BY c.criada_em DESC`).all(uf.empresa_id, ...vids, uf.id);
  return {
    usuario: { nome: uf.nome, empresa: emp.nome },
    veiculos,
    plano: { nome: emp.plano_nome || 'Rastreamento', mensalidade_centavos: emp.plano_valor_centavos ?? null, status: 'ativo' },
    seguros,
    atendimento: {
      whatsapp: emp.atend_whatsapp || null,
      telefone: emp.atend_telefone || emp.telefone || null,
      horario: emp.atend_horario || null,
      email: emp.email || null,
    },
  };
}

module.exports = { resumo, buscar, listar, criar, atualizar, definirSenha, remover, vincular, painel };
