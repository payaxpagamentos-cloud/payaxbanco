'use strict';

const crypto = require('node:crypto');
const { transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const v = require('./validacao');
const lanc = require('./lancamentos');
const { valorTexto, dataTexto } = require('./extrato');

// ---------- Chaves de API (sistemas de gestão enviando lançamentos) ----------
// Formato: bpo_<prefixo>_<segredo>. Só o SHA-256 do segredo fica gravado; a chave aparece uma única vez.
const hashChave = (s) => crypto.createHash('sha256').update(s).digest('hex');

function criarChave(db, req, empresaId, nome) {
  const n = v.texto(nome, 80);
  v.exigir(n, 'Dê um nome à chave (ex.: "ERP Omie").');
  const prefixo = crypto.randomBytes(6).toString('hex');
  const segredo = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO chaves_api (empresa_id, nome, prefixo, hash, criado_por) VALUES (?, ?, ?, ?, ?)').run(empresaId, n, prefixo, hashChave(segredo), req.usuario.id);
  return { chave: `bpo_${prefixo}_${segredo}`, prefixo };
}

/** Middleware da API de integração: identifica a empresa pela chave. */
const autenticarChave = (db) => (req, _res, next) => {
  const m = /^Bearer bpo_([0-9a-f]{12})_([A-Za-z0-9_-]{20,})$/.exec(req.get('authorization') || '');
  const c = m && db.prepare('SELECT * FROM chaves_api WHERE prefixo = ? AND revogada_em IS NULL').get(m[1]);
  if (!c || !crypto.timingSafeEqual(Buffer.from(hashChave(m[2])), Buffer.from(c.hash))) return next(new ErroNegocio('Chave de API inválida ou revogada.', 401));
  const empresa = db.prepare("SELECT * FROM empresas WHERE id = ? AND status IN ('ativa','implantacao')").get(c.empresa_id);
  if (!empresa) return next(new ErroNegocio('Empresa sem contrato ativo.', 403));
  db.prepare("UPDATE chaves_api SET ultimo_uso = datetime('now') WHERE id = ?").run(c.id);
  req.empresa = empresa;
  req.chaveApi = c;
  next();
};

/**
 * Converte um lançamento vindo de fora: categoria pelo id ou pelo nome; contato pelo id, ou pelo
 * CPF/CNPJ (criado se não existir, com o nome informado).
 */
function resolverExterno(db, empresaId, item) {
  const corpo = { ...item };
  if (!corpo.categoria_id && corpo.categoria) {
    const c = db.prepare('SELECT id FROM categorias WHERE empresa_id = ? AND nome = ? COLLATE NOCASE AND ativo = 1').get(empresaId, String(corpo.categoria).trim());
    v.exigir(c, `Categoria "${corpo.categoria}" não existe no plano de contas da empresa.`);
    corpo.categoria_id = c.id;
  }
  if (!corpo.contato_id && (corpo.contato_documento || corpo.contato)) {
    const doc = v.documentoOpcional(corpo.contato_documento);
    let c = doc ? db.prepare('SELECT id FROM contatos WHERE empresa_id = ? AND documento = ?').get(empresaId, doc)
      : db.prepare('SELECT id FROM contatos WHERE empresa_id = ? AND nome = ? COLLATE NOCASE').get(empresaId, String(corpo.contato).trim());
    if (!c) {
      const nome = v.texto(corpo.contato, 160) || doc;
      v.exigir(nome, 'Informe o nome do contato.');
      const r = db.prepare('INSERT INTO contatos (empresa_id, tipo, nome, documento) VALUES (?, ?, ?, ?)')
        .run(empresaId, corpo.tipo === 'receber' ? 'cliente' : 'fornecedor', nome, doc);
      c = { id: Number(r.lastInsertRowid) };
    }
    corpo.contato_id = c.id;
  }
  return corpo;
}

/** Cria vários lançamentos de uma vez (API ou CSV). Tudo ou nada; os erros indicam a linha. */
function criarEmLote(db, req, empresaId, itens) {
  v.exigir(Array.isArray(itens) && itens.length, 'Nenhum lançamento enviado.');
  v.exigir(itens.length <= 1000, 'Máximo de 1.000 lançamentos por envio.');
  return transacao(db, () => itens.flatMap((item, i) => {
    try {
      return lanc.criar(db, req, empresaId, resolverExterno(db, empresaId, item));
    } catch (err) {
      if (err instanceof ErroNegocio) throw new ErroNegocio(`Linha ${item._linha ?? i + 1}: ${err.message}`, err.status);
      throw err;
    }
  }));
}

/**
 * CSV de lançamentos exportado de um sistema de gestão:
 * tipo; descrição; valor; vencimento; competência; categoria; contato; CPF/CNPJ; documento
 * Tipo: "pagar"/"receber" (ou "P"/"R", "despesa"/"receita"). Cabeçalho é ignorado.
 */
function lerCsvLancamentos(conteudo) {
  const linhas = String(conteudo).split(/\r?\n/);
  const sep = linhas.some((l) => l.includes(';')) ? ';' : ',';
  const itens = [];
  linhas.forEach((linha, i) => {
    if (!linha.trim()) return;
    const c = linha.split(sep).map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
    const t = (c[0] || '').toLowerCase();
    const tipo = ['pagar', 'p', 'despesa', 'saida', 'saída'].includes(t) ? 'pagar' : ['receber', 'r', 'receita', 'entrada'].includes(t) ? 'receber' : null;
    if (!tipo) {
      if (i === 0) return; // cabeçalho
      throw new ErroNegocio(`Linha ${i + 1}: tipo deve ser "pagar" ou "receber".`, 422);
    }
    const valor = Math.abs(valorTexto(c[2]));
    if (!valor) throw new ErroNegocio(`Linha ${i + 1}: valor inválido.`, 422);
    const vencimento = dataTexto(c[3]);
    if (!vencimento) throw new ErroNegocio(`Linha ${i + 1}: vencimento inválido.`, 422);
    itens.push({ _linha: i + 1, tipo, descricao: c[1], valor_centavos: valor, vencimento, competencia: dataTexto(c[4]) || undefined,
      categoria: c[5], contato: c[6] || undefined, contato_documento: c[7] || undefined, documento: c[8] || undefined });
  });
  v.exigir(itens.length, 'Nenhum lançamento encontrado no arquivo.');
  return itens;
}

/**
 * Exportação contábil (partidas dobradas) das baixas do período, pelo código contábil das categorias e
 * das contas bancárias: pagamento debita a despesa e credita o banco; recebimento, o inverso.
 * Transferências entre contas também saem. Juros e descontos vão no valor pago.
 */
function exportacaoContabil(db, empresaId, de, ate) {
  v.data(de, 'a data inicial');
  v.data(ate, 'a data final');
  const baixas = db.prepare(`SELECT m.data, m.valor_centavos, m.descricao, m.origem, m.grupo, cb.conta_contabil AS banco_conta, cb.descricao AS banco_nome,
      cat.conta_contabil AS categoria_conta, cat.nome AS categoria_nome, ct.nome AS contato_nome, l.documento
    FROM movimentos m JOIN contas_bancarias cb ON cb.id = m.conta_bancaria_id LEFT JOIN lancamentos l ON l.id = m.lancamento_id
    LEFT JOIN categorias cat ON cat.id = l.categoria_id LEFT JOIN contatos ct ON ct.id = l.contato_id
    WHERE m.empresa_id = ? AND m.data BETWEEN ? AND ? ORDER BY m.data, m.id`).all(empresaId, de, ate);
  const linhas = [];
  const semCodigo = new Set();
  const transf = new Map();
  for (const b of baixas) {
    if (b.origem === 'transferencia') {
      // Junta as duas pernas: débito no destino, crédito na origem.
      const t = transf.get(b.grupo) ?? { data: b.data, descricao: b.descricao };
      if (b.valor_centavos > 0) t.debito = b.banco_conta || `[${b.banco_nome}]`; else t.credito = b.banco_conta || `[${b.banco_nome}]`;
      t.valor = Math.abs(b.valor_centavos);
      transf.set(b.grupo, t);
      if (!b.banco_conta) semCodigo.add(`Conta bancária: ${b.banco_nome}`);
      continue;
    }
    const banco = b.banco_conta || `[${b.banco_nome}]`;
    const contrapartida = b.categoria_conta || `[${b.categoria_nome ?? 'Ajuste de saldo'}]`;
    if (!b.banco_conta) semCodigo.add(`Conta bancária: ${b.banco_nome}`);
    if (!b.categoria_conta) semCodigo.add(`Categoria: ${b.categoria_nome ?? 'Ajuste de saldo'}`);
    const entrada = b.valor_centavos > 0;
    const historico = [b.descricao, b.contato_nome, b.documento && `Doc. ${b.documento}`].filter(Boolean).join(' - ');
    linhas.push({ data: b.data, debito: entrada ? banco : contrapartida, credito: entrada ? contrapartida : banco, valor_centavos: Math.abs(b.valor_centavos), historico });
  }
  for (const t of transf.values()) linhas.push({ data: t.data, debito: t.debito, credito: t.credito, valor_centavos: t.valor, historico: t.descricao });
  linhas.sort((a, b) => a.data.localeCompare(b.data));
  return { linhas, sem_codigo: [...semCodigo].sort() };
}

module.exports = { criarChave, autenticarChave, criarEmLote, lerCsvLancamentos, exportacaoContabil, resolverExterno };
