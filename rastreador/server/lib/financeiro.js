'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Financeiro da Gestão de Frota: contas a pagar e a receber (com parcelas e contas que se repetem todo mês), contas e caixas com
 * saldo, transferências, categorias, fluxo de caixa e resultado por categoria.
 *
 * Ligação com a frota: ordens de serviço concluídas, documentos com valor (IPVA, licenciamento, seguro) e multas podem virar
 * contas a pagar com um toque. Cada uma entra uma vez só; ao dar a baixa, o documento fica pago e a multa fica paga lá também.
 * Os valores são sempre em centavos e as datas, o dia local (AAAA-MM-DD).
 */
const crypto = require('node:crypto');
const { transacao, agora } = require('../db');
const v = require('./validacao');
const { ErroNegocio } = require('./erros');
const { hoje, somarDias } = require('./datas');

const TIPOS_CONTA = { caixa: 'Caixa (dinheiro)', banco: 'Conta bancária', cartao: 'Cartão', outro: 'Outro' };
const FORMAS = { pix: 'PIX', boleto: 'Boleto', transferencia: 'Transferência', dinheiro: 'Dinheiro', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito', cheque: 'Cheque', outro: 'Outro' };
const CATEGORIAS_PADRAO = {
  despesa: ['Combustível', 'Manutenção e oficina', 'Pneus', 'IPVA e licenciamento', 'Seguro', 'Multas', 'Pedágio e estacionamento', 'Salários e encargos', 'Aluguel', 'Impostos e taxas', 'Outras despesas'],
  receita: ['Fretes', 'Serviços prestados', 'Locação de veículos', 'Outras receitas'],
};
const ROTULO = { pagar: { um: 'conta a pagar', feito: 'paga' }, receber: { um: 'conta a receber', feito: 'recebida' } };

// ---------- Apoio ----------
const valor = (x, nome = 'o valor') => v.inteiro(x, nome, { min: 1, max: 100_000_000_00 });
const dataDe = (x, nome) => v.data(String(x ?? '').slice(0, 10), nome);
function umDa(tabela, nome) {
  return (db, empresaId, id) => {
    const x = Number.isInteger(Number(id)) ? db.prepare(`SELECT * FROM ${tabela} WHERE id = ? AND empresa_id = ?`).get(Number(id), empresaId) : null;
    if (!x) throw new ErroNegocio(`${nome} não encontrada.`, 404);
    return x;
  };
}
const contaDa = umDa('fin_contas', 'Conta');
const categoriaDa = umDa('fin_categorias', 'Categoria');
const lancamentoDo = umDa('fin_lancamentos', 'Conta');
/** Soma n meses a uma data, mantendo o dia (dia 31 num mês de 30 vira o último dia do mês). */
function somarMeses(data, n) {
  const [a, m, d] = data.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  return `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}

/** Primeiro uso: cria as categorias de referência e a conta "Caixa" (o gestor renomeia e acrescenta o que quiser). */
function preparar(db, empresaId) {
  if (db.prepare('SELECT 1 FROM fin_categorias WHERE empresa_id = ? LIMIT 1').get(empresaId)) return;
  transacao(db, () => {
    const cat = db.prepare('INSERT INTO fin_categorias (empresa_id, nome, tipo) VALUES (?, ?, ?)');
    for (const [tipo, nomes] of Object.entries(CATEGORIAS_PADRAO)) for (const nome of nomes) cat.run(empresaId, nome, tipo);
    if (!db.prepare('SELECT 1 FROM fin_contas WHERE empresa_id = ? LIMIT 1').get(empresaId)) {
      db.prepare("INSERT INTO fin_contas (empresa_id, nome, tipo, criado_em) VALUES (?, 'Caixa', 'caixa', ?)").run(empresaId, agora());
    }
  });
}

// ---------- Contas e caixas ----------
function saldoDaConta(db, conta) {
  const mov = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN tipo = 'receber' THEN valor_pago_centavos ELSE 0 END), 0) AS entrou,
      COALESCE(SUM(CASE WHEN tipo = 'pagar' THEN valor_pago_centavos ELSE 0 END), 0) AS saiu
    FROM fin_lancamentos WHERE conta_id = ? AND status = 'pago'`).get(conta.id);
  const tr = db.prepare(`SELECT COALESCE(SUM(CASE WHEN para_conta_id = ? THEN valor_centavos ELSE 0 END), 0) AS veio,
      COALESCE(SUM(CASE WHEN de_conta_id = ? THEN valor_centavos ELSE 0 END), 0) AS foi FROM fin_transferencias WHERE de_conta_id = ? OR para_conta_id = ?`)
    .get(conta.id, conta.id, conta.id, conta.id);
  return conta.saldo_inicial_centavos + mov.entrou - mov.saiu + tr.veio - tr.foi;
}
function listarContas(db, empresaId) {
  preparar(db, empresaId);
  return db.prepare('SELECT * FROM fin_contas WHERE empresa_id = ? ORDER BY ativo DESC, nome').all(empresaId)
    .map((c) => ({ ...c, nome_tipo: TIPOS_CONTA[c.tipo], saldo_centavos: saldoDaConta(db, c) }));
}
function salvarConta(db, empresaId, d, id) {
  const atual = id ? contaDa(db, empresaId, id) : null;
  const x = {
    nome: v.texto(d.nome ?? atual?.nome, 'o nome da conta', 60),
    tipo: v.opcao(d.tipo ?? atual?.tipo ?? 'banco', 'o tipo da conta', Object.keys(TIPOS_CONTA)),
    // O saldo inicial pode ser negativo (conta que começa no cheque especial).
    saldo: d.saldo_inicial_centavos !== undefined && d.saldo_inicial_centavos !== '' ? v.inteiro(d.saldo_inicial_centavos, 'o saldo inicial', { min: -100_000_000_00, max: 100_000_000_00 }) : atual?.saldo_inicial_centavos ?? 0,
    ativo: d.ativo !== undefined ? (v.booleano(d.ativo) ? 1 : 0) : atual?.ativo ?? 1,
  };
  if (atual) {
    db.prepare('UPDATE fin_contas SET nome = ?, tipo = ?, saldo_inicial_centavos = ?, ativo = ? WHERE id = ?').run(x.nome, x.tipo, x.saldo, x.ativo, atual.id);
    return atual.id;
  }
  return Number(db.prepare('INSERT INTO fin_contas (empresa_id, nome, tipo, saldo_inicial_centavos, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(empresaId, x.nome, x.tipo, x.saldo, x.ativo, agora()).lastInsertRowid);
}
function transferir(db, empresaId, d, usuarioId) {
  const de = contaDa(db, empresaId, d.de_conta_id);
  const para = contaDa(db, empresaId, d.para_conta_id);
  v.exigir(de.id !== para.id, 'Escolha duas contas diferentes.');
  return Number(db.prepare('INSERT INTO fin_transferencias (empresa_id, de_conta_id, para_conta_id, valor_centavos, data, observacao, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(empresaId, de.id, para.id, valor(d.valor_centavos), d.data ? dataDe(d.data, 'a data') : hoje(), v.opcional(d.observacao, 'a observação', 200), usuarioId ?? null, agora()).lastInsertRowid);
}
function listarTransferencias(db, empresaId) {
  return db.prepare(`SELECT t.*, a.nome AS de_nome, b.nome AS para_nome FROM fin_transferencias t JOIN fin_contas a ON a.id = t.de_conta_id JOIN fin_contas b ON b.id = t.para_conta_id
    WHERE t.empresa_id = ? ORDER BY t.data DESC, t.id DESC LIMIT 100`).all(empresaId);
}
function excluirTransferencia(db, empresaId, id) {
  const ok = db.prepare('DELETE FROM fin_transferencias WHERE id = ? AND empresa_id = ?').run(Number(id), empresaId);
  if (!ok.changes) throw new ErroNegocio('Transferência não encontrada.', 404);
}

// ---------- Categorias ----------
function listarCategorias(db, empresaId) {
  preparar(db, empresaId);
  return db.prepare('SELECT * FROM fin_categorias WHERE empresa_id = ? ORDER BY tipo, ativo DESC, nome').all(empresaId);
}
function salvarCategoria(db, empresaId, d, id) {
  const atual = id ? categoriaDa(db, empresaId, id) : null;
  const nome = v.texto(d.nome ?? atual?.nome, 'o nome da categoria', 60);
  // O tipo não muda depois de criada: as contas já lançadas nela mudariam de lado no resultado.
  const tipo = atual ? atual.tipo : v.opcao(d.tipo, 'o tipo da categoria', ['receita', 'despesa']);
  const ativo = d.ativo !== undefined ? (v.booleano(d.ativo) ? 1 : 0) : atual?.ativo ?? 1;
  if (atual) { db.prepare('UPDATE fin_categorias SET nome = ?, ativo = ? WHERE id = ?').run(nome, ativo, atual.id); return atual.id; }
  return Number(db.prepare('INSERT INTO fin_categorias (empresa_id, nome, tipo, ativo) VALUES (?, ?, ?, ?)').run(empresaId, nome, tipo, ativo).lastInsertRowid);
}
/** Categoria pelo nome de referência (para o que vem da frota); se o gestor renomeou ou apagou, fica sem categoria. */
const categoriaPorNome = (db, empresaId, nome) => db.prepare("SELECT id FROM fin_categorias WHERE empresa_id = ? AND nome = ? AND tipo = 'despesa' AND ativo = 1").get(empresaId, nome)?.id ?? null;

// ---------- Contas a pagar e a receber ----------
/** Situação na tela: paga/recebida, cancelada, vencida (em aberto com o vencimento passado), vence hoje ou em aberto. */
function situacao(l, dia = hoje()) {
  if (l.status !== 'aberto') return l.status;
  return l.vencimento < dia ? 'vencido' : l.vencimento === dia ? 'hoje' : 'aberto';
}
const COLUNAS = `l.*, c.nome AS categoria, ct.nome AS conta, v.placa, f.nome AS fornecedor`;
const JUNCOES = `fin_lancamentos l LEFT JOIN fin_categorias c ON c.id = l.categoria_id LEFT JOIN fin_contas ct ON ct.id = l.conta_id
  LEFT JOIN veiculos v ON v.id = l.veiculo_id LEFT JOIN frota_fornecedores f ON f.id = l.fornecedor_id`;

function listar(db, empresaId, { tipo, status = 'aberto', de, ate, veiculoId, busca } = {}) {
  preparar(db, empresaId);
  const dia = hoje();
  const onde = ['l.empresa_id = ?', 'l.tipo = ?'];
  const p = [empresaId, v.opcao(tipo, 'o tipo', ['pagar', 'receber'])];
  if (status === 'aberto') onde.push("l.status = 'aberto'");
  else if (status === 'vencido') { onde.push("l.status = 'aberto' AND l.vencimento < ?"); p.push(dia); }
  else if (status === 'pago') onde.push("l.status = 'pago'");
  else onde.push("l.status <> 'cancelado'");
  // Nas pagas, o período olha o dia do pagamento; nas outras, o vencimento.
  const campo = status === 'pago' ? 'l.pago_em' : 'l.vencimento';
  if (de) { onde.push(`${campo} >= ?`); p.push(dataDe(de, 'o início do período')); }
  if (ate) { onde.push(`${campo} <= ?`); p.push(dataDe(ate, 'o fim do período')); }
  if (veiculoId) { onde.push('l.veiculo_id = ?'); p.push(Number(veiculoId)); }
  if (busca) { onde.push('(l.descricao LIKE ? OR l.pessoa LIKE ? OR l.documento LIKE ?)'); const b = `%${String(busca).slice(0, 60)}%`; p.push(b, b, b); }
  const itens = db.prepare(`SELECT ${COLUNAS} FROM ${JUNCOES} WHERE ${onde.join(' AND ')} ORDER BY ${status === 'pago' ? 'l.pago_em DESC' : 'l.vencimento'}, l.id LIMIT 1000`).all(...p)
    .map((l) => ({ ...l, situacao: situacao(l, dia) }));
  const soma = (f) => itens.filter(f).reduce((s, x) => s + (x.status === 'pago' ? x.valor_pago_centavos : x.valor_centavos), 0);
  return { itens, totais: { quantidade: itens.length, total_centavos: soma(() => true), vencido_centavos: soma((x) => x.situacao === 'vencido'), hoje_centavos: soma((x) => x.situacao === 'hoje') } };
}

function dados(db, empresaId, d, atual) {
  const tipo = atual?.tipo ?? v.opcao(d.tipo, 'o tipo', ['pagar', 'receber']);
  const categoria = d.categoria_id !== undefined ? (d.categoria_id === '' || d.categoria_id === null ? null : categoriaDa(db, empresaId, d.categoria_id)) : undefined;
  if (categoria) v.exigir(categoria.tipo === (tipo === 'pagar' ? 'despesa' : 'receita'), tipo === 'pagar' ? 'Escolha uma categoria de despesa.' : 'Escolha uma categoria de receita.');
  const dono = (tabela, nome, id) => {
    if (id === '' || id === null) return null;
    const x = db.prepare(`SELECT id FROM ${tabela} WHERE id = ? AND empresa_id = ?`).get(Number(id), empresaId);
    v.exigir(x, `${nome} não encontrado.`);
    return x.id;
  };
  return {
    tipo,
    descricao: v.texto(d.descricao ?? atual?.descricao, 'a descrição', 160),
    pessoa: d.pessoa !== undefined ? v.opcional(d.pessoa, tipo === 'pagar' ? 'o fornecedor' : 'o cliente', 120) : atual?.pessoa ?? null,
    fornecedor_id: d.fornecedor_id !== undefined ? dono('frota_fornecedores', 'Fornecedor', d.fornecedor_id) : atual?.fornecedor_id ?? null,
    veiculo_id: d.veiculo_id !== undefined ? dono('veiculos', 'Veículo', d.veiculo_id) : atual?.veiculo_id ?? null,
    categoria_id: categoria === undefined ? atual?.categoria_id ?? null : categoria?.id ?? null,
    documento: d.documento !== undefined ? v.opcional(d.documento, 'o número do documento', 40) : atual?.documento ?? null,
    valor_centavos: d.valor_centavos !== undefined || !atual ? valor(d.valor_centavos) : atual.valor_centavos,
    vencimento: d.vencimento !== undefined || !atual ? dataDe(d.vencimento, 'o vencimento') : atual.vencimento,
    observacao: d.observacao !== undefined ? v.opcional(d.observacao, 'a observação', 300) : atual?.observacao ?? null,
  };
}
const INSERIR = `INSERT INTO fin_lancamentos (empresa_id, tipo, descricao, pessoa, fornecedor_id, veiculo_id, categoria_id, documento, valor_centavos, vencimento, parcela, parcelas, grupo,
  observacao, origem, origem_id, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Nova conta. `modo`: 'unica' (padrão); 'parcelado' divide o valor em N parcelas mensais (o resto dos centavos vai na última);
 * 'recorrente' repete o mesmo valor por N meses (aluguel, mensalidade).
 */
function criar(db, empresaId, d, usuarioId) {
  preparar(db, empresaId);
  const x = dados(db, empresaId, d);
  const modo = v.opcao(d.modo ?? 'unica', 'o modo', ['unica', 'parcelado', 'recorrente']);
  const n = modo === 'unica' ? 1 : v.inteiro(d.parcelas, modo === 'parcelado' ? 'o número de parcelas' : 'o número de meses', { min: 2, max: 60 });
  const grupo = n > 1 ? crypto.randomBytes(6).toString('hex') : null;
  const cada = modo === 'parcelado' ? Math.floor(x.valor_centavos / n) : x.valor_centavos;
  v.exigir(cada >= 1, 'O valor é pequeno demais para tantas parcelas.');
  return transacao(db, () => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const centavos = modo === 'parcelado' && i === n - 1 ? x.valor_centavos - cada * (n - 1) : cada;
      ids.push(Number(db.prepare(INSERIR).run(empresaId, x.tipo, x.descricao, x.pessoa, x.fornecedor_id, x.veiculo_id, x.categoria_id, x.documento, centavos, somarMeses(x.vencimento, i),
        i + 1, n, grupo, x.observacao, 'manual', null, usuarioId ?? null, agora()).lastInsertRowid));
    }
    return ids;
  });
}

function editar(db, empresaId, id, d) {
  const atual = lancamentoDo(db, empresaId, id);
  v.exigir(atual.status === 'aberto', `Esta conta já foi ${ROTULO[atual.tipo].feito}. Estorne a baixa para alterar.`);
  const x = dados(db, empresaId, d, atual);
  db.prepare(`UPDATE fin_lancamentos SET descricao = ?, pessoa = ?, fornecedor_id = ?, veiculo_id = ?, categoria_id = ?, documento = ?, valor_centavos = ?, vencimento = ?, observacao = ? WHERE id = ?`)
    .run(x.descricao, x.pessoa, x.fornecedor_id, x.veiculo_id, x.categoria_id, x.documento, x.valor_centavos, x.vencimento, x.observacao, atual.id);
}

/** Baixa: a conta foi paga (ou recebida) em tal dia, por tal conta/caixa, pelo valor efetivo (com juros ou desconto). */
function baixar(db, empresaId, id, d) {
  const l = lancamentoDo(db, empresaId, id);
  v.exigir(l.status === 'aberto', l.status === 'pago' ? `Esta conta já foi ${ROTULO[l.tipo].feito}.` : 'Esta conta foi cancelada.');
  const conta = contaDa(db, empresaId, d.conta_id);
  v.exigir(conta.ativo, 'Esta conta/caixa está desativada.');
  const dia = d.data ? dataDe(d.data, 'a data') : hoje();
  v.exigir(dia <= hoje(), 'A data da baixa não pode ser no futuro.');
  const pago = d.valor_pago_centavos !== undefined && d.valor_pago_centavos !== '' ? valor(d.valor_pago_centavos, 'o valor pago') : l.valor_centavos;
  const forma = d.forma ? v.opcao(d.forma, 'a forma de pagamento', Object.keys(FORMAS)) : null;
  transacao(db, () => {
    db.prepare("UPDATE fin_lancamentos SET status = 'pago', pago_em = ?, valor_pago_centavos = ?, conta_id = ?, forma = ? WHERE id = ?").run(dia, pago, conta.id, forma, l.id);
    // O que veio da frota recebe a baixa lá também.
    if (l.origem === 'documento') db.prepare('UPDATE frota_documentos SET pago = 1 WHERE id = ? AND empresa_id = ?').run(l.origem_id, empresaId);
    if (l.origem === 'multa') db.prepare("UPDATE multas SET situacao = 'paga', atualizada_em = ? WHERE id = ? AND empresa_id = ? AND situacao <> 'cancelada'").run(agora(), l.origem_id, empresaId);
  });
}

function estornar(db, empresaId, id) {
  const l = lancamentoDo(db, empresaId, id);
  v.exigir(l.status === 'pago', 'Só dá para estornar uma conta que já teve baixa.');
  transacao(db, () => {
    db.prepare("UPDATE fin_lancamentos SET status = 'aberto', pago_em = NULL, valor_pago_centavos = NULL, conta_id = NULL, forma = NULL WHERE id = ?").run(l.id);
    if (l.origem === 'documento') db.prepare('UPDATE frota_documentos SET pago = 0 WHERE id = ? AND empresa_id = ?').run(l.origem_id, empresaId);
    if (l.origem === 'multa') db.prepare("UPDATE multas SET situacao = 'a_pagar', atualizada_em = ? WHERE id = ? AND empresa_id = ? AND situacao = 'paga'").run(agora(), l.origem_id, empresaId);
  });
}

/** Exclui a conta em aberto. `todas`: também as outras parcelas em aberto do mesmo lançamento. */
function excluir(db, empresaId, id, { todas = false } = {}) {
  const l = lancamentoDo(db, empresaId, id);
  v.exigir(l.status === 'aberto', `Esta conta já foi ${ROTULO[l.tipo].feito}. Estorne a baixa antes de excluir.`);
  if (todas && l.grupo) return db.prepare("DELETE FROM fin_lancamentos WHERE empresa_id = ? AND grupo = ? AND status = 'aberto'").run(empresaId, l.grupo).changes;
  return db.prepare('DELETE FROM fin_lancamentos WHERE id = ?').run(l.id).changes;
}

// ---------- O que a frota gerou e ainda não está no contas a pagar ----------
function pendenciasDaFrota(db, empresaId) {
  const ja = (origem) => `NOT EXISTS (SELECT 1 FROM fin_lancamentos l WHERE l.empresa_id = x.empresa_id AND l.origem = '${origem}' AND l.origem_id = x.id AND l.status <> 'cancelado')`;
  const dia = hoje();
  const os = db.prepare(`SELECT x.id, x.numero, x.descricao, x.total_centavos, x.concluida_em, x.veiculo_id, x.fornecedor_id, v.placa, f.nome AS fornecedor FROM frota_os x
    JOIN veiculos v ON v.id = x.veiculo_id LEFT JOIN frota_fornecedores f ON f.id = x.fornecedor_id
    WHERE x.empresa_id = ? AND x.status = 'concluida' AND x.total_centavos > 0 AND ${ja('os')} ORDER BY x.concluida_em DESC LIMIT 200`).all(empresaId)
    .map((o) => ({ origem: 'os', origem_id: o.id, descricao: `OS #${o.numero} · ${o.descricao}`, placa: o.placa, pessoa: o.fornecedor, valor_centavos: o.total_centavos, vencimento: dia, grupo: 'Ordens de serviço concluídas' }));
  const tiposDoc = require('./gestaoFrota').TIPOS_DOCUMENTO;
  const docs = db.prepare(`SELECT x.id, x.tipo, x.descricao, x.valor_centavos, x.vencimento, x.veiculo_id, v.placa FROM frota_documentos x JOIN veiculos v ON v.id = x.veiculo_id
    WHERE x.empresa_id = ? AND x.pago = 0 AND x.valor_centavos > 0 AND ${ja('documento')} ORDER BY x.vencimento LIMIT 200`).all(empresaId)
    .map((d) => ({ origem: 'documento', origem_id: d.id, descricao: [tiposDoc[d.tipo] ?? d.tipo, d.descricao].filter(Boolean).join(' · '), placa: d.placa, pessoa: null, valor_centavos: d.valor_centavos, vencimento: d.vencimento, grupo: 'Documentos a pagar' }));
  const multas = db.prepare(`SELECT x.id, x.descricao, x.valor_centavos, x.vencimento, x.orgao, x.placa FROM multas x
    WHERE x.empresa_id = ? AND x.situacao IN ('notificada','condutor_indicado','a_pagar') AND x.valor_centavos > 0 AND ${ja('multa')} ORDER BY x.vencimento LIMIT 200`).all(empresaId)
    .map((m) => ({ origem: 'multa', origem_id: m.id, descricao: `Multa · ${m.descricao}`, placa: m.placa, pessoa: m.orgao, valor_centavos: m.valor_centavos, vencimento: m.vencimento ?? dia, grupo: 'Multas a pagar' }));
  return [...os, ...docs, ...multas];
}

/** Traz para o contas a pagar os itens escolhidos (cada um entra uma vez; o que já entrou é ignorado). */
function importarDaFrota(db, empresaId, itens, usuarioId) {
  preparar(db, empresaId);
  const pend = new Map(pendenciasDaFrota(db, empresaId).map((x) => [`${x.origem}:${x.origem_id}`, x]));
  const CATEGORIA = { os: 'Manutenção e oficina', multa: 'Multas' };
  const catDoc = (id) => {
    const t = db.prepare('SELECT tipo FROM frota_documentos WHERE id = ?').get(id)?.tipo;
    return t === 'seguro' ? 'Seguro' : ['ipva', 'licenciamento'].includes(t) ? 'IPVA e licenciamento' : 'Impostos e taxas';
  };
  let n = 0;
  transacao(db, () => {
    for (const it of Array.isArray(itens) ? itens.slice(0, 500) : []) {
      const x = pend.get(`${it?.origem}:${Number(it?.origem_id)}`);
      if (!x) continue;
      pend.delete(`${x.origem}:${x.origem_id}`);
      const ref = x.origem === 'os' ? db.prepare('SELECT veiculo_id, fornecedor_id FROM frota_os WHERE id = ?').get(x.origem_id)
        : x.origem === 'documento' ? db.prepare('SELECT veiculo_id, NULL AS fornecedor_id FROM frota_documentos WHERE id = ?').get(x.origem_id)
          : db.prepare('SELECT veiculo_id, NULL AS fornecedor_id FROM multas WHERE id = ?').get(x.origem_id);
      db.prepare(INSERIR).run(empresaId, 'pagar', x.descricao.slice(0, 160), x.pessoa, ref?.fornecedor_id ?? null, ref?.veiculo_id ?? null,
        categoriaPorNome(db, empresaId, x.origem === 'documento' ? catDoc(x.origem_id) : CATEGORIA[x.origem]), null, x.valor_centavos, x.vencimento, 1, 1, null, null, x.origem, x.origem_id, usuarioId ?? null, agora());
      n++;
    }
  });
  return n;
}

// ---------- Resumo, fluxo de caixa e resultado ----------
function resumo(db, empresaId) {
  preparar(db, empresaId);
  const dia = hoje();
  const contas = listarContas(db, empresaId).filter((c) => c.ativo);
  const aberto = db.prepare(`SELECT tipo, COALESCE(SUM(valor_centavos), 0) AS total, COALESCE(SUM(CASE WHEN vencimento < ? THEN valor_centavos ELSE 0 END), 0) AS vencido,
      COALESCE(SUM(CASE WHEN vencimento BETWEEN ? AND ? THEN valor_centavos ELSE 0 END), 0) AS prox7, COUNT(*) AS n
    FROM fin_lancamentos WHERE empresa_id = ? AND status = 'aberto' GROUP BY tipo`).all(dia, dia, somarDias(dia, 7), empresaId);
  const de = (t) => aberto.find((x) => x.tipo === t) ?? { total: 0, vencido: 0, prox7: 0, n: 0 };
  const mes = dia.slice(0, 7);
  const realizado = db.prepare(`SELECT tipo, COALESCE(SUM(valor_pago_centavos), 0) AS total FROM fin_lancamentos WHERE empresa_id = ? AND status = 'pago' AND substr(pago_em, 1, 7) = ? GROUP BY tipo`).all(empresaId, mes);
  const feito = (t) => realizado.find((x) => x.tipo === t)?.total ?? 0;
  // Fluxo: 3 meses para trás (o que entrou e saiu) e 3 para a frente (o que está previsto), com o saldo acumulado.
  const meses = [];
  const saldoHoje = contas.reduce((s, c) => s + c.saldo_centavos, 0);
  const porMes = db.prepare(`SELECT substr(CASE WHEN status = 'pago' THEN pago_em ELSE vencimento END, 1, 7) AS m, tipo, status, COALESCE(SUM(CASE WHEN status = 'pago' THEN valor_pago_centavos ELSE valor_centavos END), 0) AS total
    FROM fin_lancamentos WHERE empresa_id = ? AND status <> 'cancelado' GROUP BY m, tipo, status`).all(empresaId);
  const pega = (m, tipo, status) => porMes.filter((x) => x.m === m && x.tipo === tipo && x.status === status).reduce((s, x) => s + x.total, 0);
  // O que venceu e ainda está em aberto entra na previsão do mês atual (vai ter de ser pago ou recebido agora).
  const atrasado = (tipo) => porMes.filter((x) => x.m < mes && x.tipo === tipo && x.status === 'aberto').reduce((s, x) => s + x.total, 0);
  let acumulado = saldoHoje;
  for (let i = -3; i <= 3; i++) {
    const m = somarMeses(`${mes}-01`, i).slice(0, 7);
    const linha = { mes: m, recebido_centavos: pega(m, 'receber', 'pago'), pago_centavos: pega(m, 'pagar', 'pago'),
      a_receber_centavos: pega(m, 'receber', 'aberto') + (i === 0 ? atrasado('receber') : 0), a_pagar_centavos: pega(m, 'pagar', 'aberto') + (i === 0 ? atrasado('pagar') : 0), saldo_previsto_centavos: null };
    if (i >= 0) { acumulado += linha.a_receber_centavos - linha.a_pagar_centavos; linha.saldo_previsto_centavos = acumulado; }
    meses.push(linha);
  }
  const proximos = db.prepare(`SELECT ${COLUNAS} FROM ${JUNCOES} WHERE l.empresa_id = ? AND l.status = 'aberto' AND l.vencimento <= ? ORDER BY l.vencimento, l.id LIMIT 12`).all(empresaId, somarDias(dia, 15))
    .map((l) => ({ ...l, situacao: situacao(l, dia) }));
  return {
    saldo_centavos: saldoHoje, contas,
    pagar: { aberto_centavos: de('pagar').total, vencido_centavos: de('pagar').vencido, proximos7_centavos: de('pagar').prox7, quantidade: de('pagar').n },
    receber: { aberto_centavos: de('receber').total, vencido_centavos: de('receber').vencido, proximos7_centavos: de('receber').prox7, quantidade: de('receber').n },
    mes: { recebido_centavos: feito('receber'), pago_centavos: feito('pagar'), resultado_centavos: feito('receber') - feito('pagar') },
    meses, proximos, pendencias_frota: pendenciasDaFrota(db, empresaId).length,
  };
}

/** Resultado do período pelo que foi efetivamente pago e recebido (regime de caixa), por categoria. */
function resultado(db, empresaId, de, ate) {
  preparar(db, empresaId);
  const linhas = db.prepare(`SELECT l.tipo, COALESCE(c.nome, 'Sem categoria') AS categoria, COALESCE(SUM(l.valor_pago_centavos), 0) AS total, COUNT(*) AS n
    FROM fin_lancamentos l LEFT JOIN fin_categorias c ON c.id = l.categoria_id
    WHERE l.empresa_id = ? AND l.status = 'pago' AND l.pago_em BETWEEN ? AND ? GROUP BY l.tipo, categoria ORDER BY total DESC`).all(empresaId, de, ate);
  const receitas = linhas.filter((x) => x.tipo === 'receber').map(({ categoria, total, n }) => ({ categoria, total_centavos: total, quantidade: n }));
  const despesas = linhas.filter((x) => x.tipo === 'pagar').map(({ categoria, total, n }) => ({ categoria, total_centavos: total, quantidade: n }));
  const soma = (l) => l.reduce((s, x) => s + x.total_centavos, 0);
  const porVeiculo = db.prepare(`SELECT v.placa, v.descricao, COALESCE(SUM(CASE WHEN l.tipo = 'receber' THEN l.valor_pago_centavos ELSE 0 END), 0) AS receita,
      COALESCE(SUM(CASE WHEN l.tipo = 'pagar' THEN l.valor_pago_centavos ELSE 0 END), 0) AS despesa
    FROM fin_lancamentos l JOIN veiculos v ON v.id = l.veiculo_id WHERE l.empresa_id = ? AND l.status = 'pago' AND l.pago_em BETWEEN ? AND ? GROUP BY v.id ORDER BY v.placa`).all(empresaId, de, ate)
    .map((x) => ({ placa: x.placa, descricao: x.descricao, receita_centavos: x.receita, despesa_centavos: x.despesa, resultado_centavos: x.receita - x.despesa }));
  return { de, ate, receitas, despesas, receita_centavos: soma(receitas), despesa_centavos: soma(despesas), resultado_centavos: soma(receitas) - soma(despesas), veiculos: porVeiculo };
}

module.exports = {
  TIPOS_CONTA, FORMAS, somarMeses, situacao,
  listarContas, salvarConta, transferir, listarTransferencias, excluirTransferencia, listarCategorias, salvarCategoria,
  listar, criar, editar, baixar, estornar, excluir, pendenciasDaFrota, importarDaFrota, resumo, resultado,
};
