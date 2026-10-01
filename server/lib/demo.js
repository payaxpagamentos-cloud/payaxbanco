'use strict';

/* Dados de demonstração: clientes, contas, PIX, movimentos e empréstimos. */
const { transacao } = require('../db');
const { proximoNumero, novoGrupo, lancar } = require('./conta');
const { simular } = require('./financeiro');
const { hashSenha, hashNumerica } = require('./senha');
const ouvidoria = require('./ouvidoria');

const CLIENTES = [
  ['PF', 'João Pedro Souza', '52998224725', 'joao.souza@email.com', '11987654321', '1990-04-12', 850000, 'São Paulo', 'SP'],
  ['PF', 'Carlos Eduardo Lima', '11144477735', 'carlos.lima@email.com', '21998765432', '1985-09-30', 1200000, 'Rio de Janeiro', 'RJ'],
  ['PF', 'Fernanda Oliveira', '39053344705', 'fernanda.o@email.com', '31991234567', '1978-01-22', 2300000, 'Belo Horizonte', 'MG'],
  ['PF', 'Rafael Martins', '15350946056', 'rafael.martins@email.com', '41996543210', '1995-11-03', 480000, 'Curitiba', 'PR'],
  ['PJ', 'Padaria Pão Dourado Ltda', '11222333000181', 'financeiro@paodourado.com.br', '1133224455', '2012-06-01', 9500000, 'Campinas', 'SP'],
  ['PJ', 'TechNova Soluções S.A.', '45997418000153', 'contato@technova.com.br', '4830219988', '2018-03-15', 48000000, 'Florianópolis', 'SC'],
];

function popularDemo(db) {
  transacao(db, () => {
    const usuarios = [['Gabriela Gerente', 'gerente@payax.com.br', 'gerente'], ['Otávio Operador', 'operador@payax.com.br', 'operador'],
      ['Olívia Ouvidoria', 'ouvidoria@payax.com.br', 'ouvidoria'], ['Marcos Andrade', 'marcos@payax.com.br', 'gerente']];
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
    for (const [documento, senha] of [['52998224725', '135790'], ['11222333000181', '975310']]) {
      const c = db.prepare('SELECT id FROM clientes WHERE documento = ?').get(documento);
      db.prepare('INSERT INTO acessos_cliente (cliente_id, senha_hash, pin_hash, precisa_trocar_senha, limite_diario_centavos) VALUES (?, ?, ?, 0, ?)')
        .run(c.id, hashNumerica(senha), hashNumerica('246810'), 1_000_000);
    }
    // Favorecidos do João (cadastrados pela equipe): um PIX e uma conta PAY AX.
    const joao = db.prepare("SELECT id FROM clientes WHERE documento = '52998224725'").get().id;
    const technova = db.prepare("SELECT cl.nome, cl.documento FROM clientes cl WHERE documento = '45997418000153'").get();
    db.prepare("INSERT INTO favorecidos (cliente_id, tipo, apelido, nome, documento, chave, usuario_id) VALUES (?, 'pix', 'TechNova', ?, ?, 'contato@technova.com.br', ?)")
      .run(joao, technova.nome, technova.documento, adminId);
    const padaria = db.prepare("SELECT c.id, cl.nome, cl.documento FROM contas c JOIN clientes cl ON cl.id = c.cliente_id WHERE cl.documento = '11222333000181'").get();
    db.prepare("INSERT INTO favorecidos (cliente_id, tipo, apelido, nome, documento, conta_id, usuario_id) VALUES (?, 'conta', 'Padaria', ?, ?, ?, ?)")
      .run(joao, padaria.nome, padaria.documento, padaria.id, adminId);
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
    // Relacionamento: carteiras dos gerentes e conversas de exemplo (minutos atrás).
    const usuario = (email) => db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email).id;
    const gabriela = usuario('gerente@payax.com.br');
    const marcos = usuario('marcos@payax.com.br');
    const clienteDoc = (doc) => db.prepare('SELECT id FROM clientes WHERE documento = ?').get(doc).id;
    const carteiras = { [gabriela]: ['52998224725', '39053344705', '11222333000181'], [marcos]: ['11144477735', '15350946056', '45997418000153'] };
    for (const [g, docs] of Object.entries(carteiras)) {
      for (const doc of docs) db.prepare('UPDATE contas SET gerente_id = ? WHERE cliente_id = ?').run(Number(g), clienteDoc(doc));
    }
    const msg = (doc, gerente, autor, minutosAtras, texto, lida = true) => db.prepare(`INSERT INTO mensagens (cliente_id, gerente_id, autor, usuario_id, texto, lida_em, criado_em)
      VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now', ?) END, datetime('now', ?))`)
      .run(clienteDoc(doc), gerente, autor, autor === 'gerente' ? gerente : null, texto, lida ? 1 : 0, `-${Math.max(0, minutosAtras - 5)} minutes`, `-${minutosAtras} minutes`);
    const dia = 24 * 60;
    msg('52998224725', gabriela, 'cliente', 2 * dia + 300, 'Olá, Gabriela! Vou viajar no mês que vem. Consigo aumentar meu limite diário do PIX?');
    msg('52998224725', gabriela, 'gerente', 2 * dia + 275, 'Olá, João! Consigo sim. Aumentei seu limite diário para R$ 10.000,00. Boa viagem!');
    msg('52998224725', gabriela, 'cliente', 2 * dia + 260, 'Perfeito, obrigado!');
    msg('52998224725', gabriela, 'gerente', 2 * dia + 250, 'Por nada! Qualquer coisa, estou por aqui.');
    msg('39053344705', gabriela, 'gerente', 5 * dia + 120, 'Olá, Fernanda! Sou a Gabriela, sua gerente na PAY AX. Temos uma condição especial de crédito com parcelas fixas. Quer conhecer?');
    msg('39053344705', gabriela, 'cliente', 4 * dia + 900, 'Oi, Gabriela. Tenho interesse, mas só no mês que vem.');
    msg('39053344705', gabriela, 'gerente', 4 * dia + 860, 'Combinado! Te procuro no começo do mês.');
    msg('11222333000181', gabriela, 'cliente', 95, 'Bom dia! Preciso gerar QR Code de cobrança para os clientes da padaria. Como faço?', false);
    msg('45997418000153', marcos, 'cliente', dia + 400, 'Marcos, conseguimos receber PIX de clientes de outros bancos direto na conta da TechNova?');
    msg('45997418000153', marcos, 'gerente', dia + 280, 'Consegue sim! Pelo Internet Banking, em PIX → Receber, você gera o QR Code com ou sem valor.');
    msg('15350946056', marcos, 'gerente', 3 * dia, 'Olá, Rafael! Vi seu pedido de encerramento. Posso entender o motivo e ver se conseguimos ajudar?');

    // Limite diário: João pediu aumento há 6 horas (entra em vigor em 18 horas); antes, uma redução.
    const idJoao = clienteDoc('52998224725');
    db.prepare(`INSERT INTO pedidos_limite (cliente_id, valor_atual_centavos, valor_novo_centavos, status, efetiva_em, concluido_em, criado_em)
      VALUES (?, 1500000, 1000000, 'efetivado', datetime('now', '-10 days'), datetime('now', '-10 days'), datetime('now', '-10 days'))`).run(idJoao);
    db.prepare(`INSERT INTO pedidos_limite (cliente_id, valor_atual_centavos, valor_novo_centavos, status, efetiva_em, criado_em)
      VALUES (?, 1000000, 2000000, 'agendado', datetime('now', '+18 hours'), datetime('now', '-6 hours'))`).run(idJoao);

    // Ouvidoria: um bloqueio pedido pela gerente e um encerramento pedido pelo cliente, aguardando análise.
    const gerente = db.prepare("SELECT id FROM usuarios WHERE email = 'gerente@payax.com.br'").get();
    const contaDe = (documento) => db.prepare("SELECT c.id, c.cliente_id FROM contas c JOIN clientes cl ON cl.id = c.cliente_id WHERE cl.documento = ? AND c.tipo = 'corrente'").get(documento);
    const carlos = contaDe('11144477735');
    ouvidoria.criar(db, { usuario: gerente }, { tipo: 'bloquear_conta', clienteId: carlos.cliente_id, contaId: carlos.id, dados: { status: 'bloqueada' },
      motivo: 'Cliente ligou informando perda do celular e suspeita de acesso indevido. Bloqueio preventivo até confirmar as últimas operações.', origem: 'equipe' });
    const rafael = contaDe('15350946056') ?? db.prepare("SELECT c.id, c.cliente_id FROM contas c JOIN clientes cl ON cl.id = c.cliente_id WHERE cl.documento = '15350946056'").get();
    ouvidoria.criar(db, { cliente: { id: rafael.cliente_id } }, { tipo: 'encerrar_conta', clienteId: rafael.cliente_id, contaId: rafael.id, dados: { status: 'encerrada' },
      motivo: 'Vou usar outro banco', origem: 'cliente' });
  });
}

module.exports = { popularDemo };
