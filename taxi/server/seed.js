'use strict';

/**
 * Dados de demonstração: um passageiro (autorizado a pedir por uma empresa) e três motoristas aprovados e online no centro de São Paulo.
 * Senha de todos: demo12345. Não use em produção.
 */
const { abrir, agora } = require('./db');
const { hashSenha } = require('./lib/senha');

const db = abrir();
const senha = hashSenha('demo12345');
const usuario = (nome, email, telefone, perfil) => {
  const u = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (u) return u.id;
  return Number(db.prepare('INSERT INTO usuarios (nome, email, telefone, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nome, email, telefone, senha, perfil, agora()).lastInsertRowid);
};

usuario('Paula Passageira', 'passageiro@demo.com', '11990000001', 'passageiro');
const MOTORISTAS = [
  ['João Silva', 'joao@demo.com', '11990000010', '52998224725', '12345678900', 'ABC1D23', 'Toyota Corolla', 'Prata', 2022, 'executivo', -23.5489, -46.6388],
  ['Maria Souza', 'maria@demo.com', '11990000011', '16899535009', '24681357982', 'BRA2E19', 'Chevrolet Spin', 'Branco', 2021, 'comum', -23.5558, -46.6396],
  ['Pedro Santos', 'pedro@demo.com', '11990000012', '11144477735', '00000001901', 'FHM3C45', 'Fiat Cronos', 'Preto', 2023, 'comum', -23.5615, -46.6560],
];
for (const [nome, email, tel, cpf, cnh, placa, modelo, cor, ano, cat, lat, lng] of MOTORISTAS) {
  const id = usuario(nome, email, tel, 'motorista');
  if (db.prepare('SELECT 1 FROM motoristas WHERE usuario_id = ?').get(id)) continue;
  db.prepare(`INSERT INTO motoristas (usuario_id, cpf, cnh, cnh_validade, chave_pix, situacao, online, lat, lng, posicao_em, analisado_em)
    VALUES (?, ?, ?, '2031-12-31', ?, 'aprovado', 1, ?, ?, ?, ?)`).run(id, cpf, cnh, email, lat, lng, agora(), agora());
  const v = db.prepare(`INSERT INTO veiculos (motorista_id, placa, marca_modelo, cor, ano, categoria, situacao, criado_em) VALUES (?, ?, ?, ?, ?, ?, 'aprovado', ?)`)
    .run(id, placa, modelo, cor, ano, cat, agora());
  db.prepare('UPDATE motoristas SET veiculo_id = ? WHERE usuario_id = ?').run(Number(v.lastInsertRowid), id);
}
db.prepare("UPDATE configuracoes SET valor = 'pix@apptaxi.com.br' WHERE chave = 'pix_chave' AND valor = ''").run();
// Empresa de exemplo com a passageira autorizada a pedir pela empresa (faturado).
if (!db.prepare('SELECT 1 FROM empresas').get()) {
  const e = Number(db.prepare(`INSERT INTO empresas (razao_social, cnpj, email_financeiro, limite_mensal_centavos, criada_em) VALUES (?, ?, ?, ?, ?)`)
    .run('Padaria Pão Quente Ltda', '11222333000181', 'financeiro@paoquente.com.br', 500000, agora()).lastInsertRowid);
  const p = db.prepare('SELECT id FROM usuarios WHERE email = ?').get('passageiro@demo.com').id;
  db.prepare(`INSERT INTO empresa_usuarios (empresa_id, usuario_id, centro_custo, autorizado_em) VALUES (?, ?, 'Comercial', ?)`).run(e, p, agora());
}
console.log('[APP Táxi] Demonstração pronta. Passageiro: passageiro@demo.com · Motoristas: joao@, maria@, pedro@demo.com · senha demo12345');
