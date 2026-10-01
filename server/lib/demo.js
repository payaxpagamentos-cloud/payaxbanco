'use strict';

/* Dados de demonstração: clientes, contas, PIX, movimentos e empréstimos. */
const { transacao } = require('../db');
const { proximoNumero, novoGrupo, lancar } = require('./conta');
const { simular } = require('./financeiro');
const { hashSenha } = require('./senha');

const CLIENTES = [
  ['PF', 'Ana Beatriz Souza', '52998224725', 'ana.souza@email.com', '11987654321', '1990-04-12', 850000, 'São Paulo', 'SP'],
  ['PF', 'Carlos Eduardo Lima', '11144477735', 'carlos.lima@email.com', '21998765432', '1985-09-30', 1200000, 'Rio de Janeiro', 'RJ'],
  ['PF', 'Fernanda Oliveira', '39053344705', 'fernanda.o@email.com', '31991234567', '1978-01-22', 2300000, 'Belo Horizonte', 'MG'],
  ['PF', 'Rafael Martins', '15350946056', 'rafael.martins@email.com', '41996543210', '1995-11-03', 480000, 'Curitiba', 'PR'],
  ['PJ', 'Padaria Pão Dourado Ltda', '11222333000181', 'financeiro@paodourado.com.br', '1133224455', '2012-06-01', 9500000, 'Campinas', 'SP'],
  ['PJ', 'TechNova Soluções S.A.', '45997418000153', 'contato@technova.com.br', '4830219988', '2018-03-15', 48000000, 'Florianópolis', 'SC'],
];

function popularDemo(db) {
  transacao(db, () => {
    const usuarios = [['Gabriela Gerente', 'gerente@payax.com.br', 'gerente'], ['Otávio Operador', 'operador@payax.com.br', 'operador']];
    for (const [nome, email, perfil] of usuarios) {
      if (!db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) {
        db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)').run(nome, email, hashSenha('payax2026'), perfil);
      }
    }
    const adminId = db.prepare("SELECT id FROM usuarios WHERE perfil = 'admin' ORDER BY id").get().id;
    const contas = [];
    for (const [tipo, nome, documento, email, telefone, nasc, renda, cidade, uf] of CLIENTES) {
      const cli = db.prepare(`INSERT INTO clientes (tipo, nome, documento, email, telefone, data_nascimento, renda_mensal_centavos, cidade, uf)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tipo, nome, documento, email, telefone, nasc, renda, cidade, uf);
      const clienteId = Number(cli.lastInsertRowid);
      const tiposConta = tipo === 'PJ' ? ['corrente'] : ['corrente', 'poupanca'];
      for (const t of tiposConta) {
        const { agencia, numero, digito } = proximoNumero(db);
        const limite = t === 'corrente' ? Math.round(renda * 0.5) : 0;
        const c = db.prepare('INSERT INTO contas (cliente_id, tipo, agencia, numero, digito, limite_centavos) VALUES (?, ?, ?, ?, ?, ?)')
          .run(clienteId, t, agencia, numero, digito, limite);
        contas.push({ id: Number(c.lastInsertRowid), tipo: t, documento, email, renda });
      }
    }
    const correntes = contas.filter((c) => c.tipo === 'corrente');
    for (const c of correntes) {
      db.prepare('INSERT INTO chaves_pix (conta_id, tipo, chave) VALUES (?, ?, ?)').run(c.id, c.documento.length === 11 ? 'cpf' : 'cnpj', c.documento);
      db.prepare('INSERT INTO chaves_pix (conta_id, tipo, chave) VALUES (?, ?, ?)').run(c.id, 'email', c.email);
    }
    // Movimentações dos últimos 14 dias.
    let semente = 42;
    const aleatorio = () => (semente = (semente * 16807) % 2147483647) / 2147483647;
    for (let dia = 13; dia >= 0; dia--) {
      for (const c of contas) {
        const quando = `datetime('now', '-${dia} days', '-${Math.floor(aleatorio() * 8)} hours')`;
        const deposito = Math.round(c.renda * (0.05 + aleatorio() * 0.25));
        lancar(db, { contaId: c.id, tipo: 'deposito', valor: deposito, descricao: 'Depósito', grupo: novoGrupo(), usuarioId: adminId });
        if (aleatorio() > 0.5) {
          const saque = Math.round(deposito * aleatorio() * 0.6) || 100;
          lancar(db, { contaId: c.id, tipo: 'saque', valor: -saque, descricao: 'Saque', grupo: novoGrupo(), usuarioId: adminId });
        }
        db.exec(`UPDATE transacoes SET criado_em = ${quando} WHERE id IN (SELECT id FROM transacoes WHERE conta_id = ${c.id} AND criado_em >= datetime('now', '-1 minute'))`);
      }
    }
    for (let i = 0; i < correntes.length; i++) {
      const origem = correntes[i];
      const destino = correntes[(i + 1) % correntes.length];
      const grupo = novoGrupo();
      const valor = 15000 + i * 2500;
      lancar(db, { contaId: origem.id, tipo: 'pix_enviado', valor: -valor, descricao: 'PIX', contraparteId: destino.id, grupo, usuarioId: adminId });
      lancar(db, { contaId: destino.id, tipo: 'pix_recebido', valor, descricao: 'PIX', contraparteId: origem.id, grupo, usuarioId: adminId });
    }
    // Acesso ao Internet Banking para dois clientes de exemplo.
    for (const [documento, senha] of [['52998224725', 'Cliente2026'], ['11222333000181', 'Empresa2026']]) {
      const c = db.prepare('SELECT id FROM clientes WHERE documento = ?').get(documento);
      db.prepare('INSERT INTO acessos_cliente (cliente_id, senha_hash, pin_hash, precisa_trocar_senha, limite_diario_centavos) VALUES (?, ?, ?, 0, ?)')
        .run(c.id, hashSenha(senha), hashSenha('246810'), 1_000_000);
    }
    // Empréstimos.
    for (const [idx, valor, taxa, n] of [[0, 1500000, 0.0189, 12], [4, 8000000, 0.0149, 24]]) {
      const conta = correntes[idx];
      const cliente = db.prepare('SELECT cliente_id FROM contas WHERE id = ?').get(conta.id).cliente_id;
      const sim = simular(valor, taxa, n);
      const e = db.prepare(`INSERT INTO emprestimos (conta_id, cliente_id, valor_centavos, taxa_mensal, num_parcelas, valor_parcela_centavos, usuario_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(conta.id, cliente, valor, taxa, n, sim.valor_parcela_centavos, adminId);
      for (const p of sim.cronograma) {
        db.prepare('INSERT INTO parcelas (emprestimo_id, numero, vencimento, valor_centavos) VALUES (?, ?, ?, ?)').run(e.lastInsertRowid, p.numero, p.vencimento, p.valor_centavos);
      }
      lancar(db, { contaId: conta.id, tipo: 'emprestimo_credito', valor, descricao: `Crédito empréstimo #${e.lastInsertRowid}`, grupo: novoGrupo(), usuarioId: adminId });
    }
  });
}

module.exports = { popularDemo };
