'use strict';

const { transacao } = require('../db');
const { daEmpresa } = require('./acesso');
const lanc = require('./lancamentos');
const v = require('./validacao');
const { hoje, somarDias, diferencaDias } = require('./datas');

const CANAIS = ['lembrete', 'ligacao', 'email', 'whatsapp', 'visita', 'outro'];
const FAIXAS = [['1-30', 1, 30], ['31-60', 31, 60], ['61-90', 61, 90], ['90+', 91, Infinity]];

/** Promessas pendentes cujo título já foi pago passam a cumpridas automaticamente. */
function atualizarPromessas(db, empresaId) {
  db.prepare(`UPDATE promessas SET status = 'cumprida', resolvida_em = datetime('now')
    WHERE empresa_id = ? AND status = 'pendente' AND lancamento_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM lancamentos l WHERE l.id = promessas.lancamento_id AND l.status = 'pago')`).run(empresaId);
}

/**
 * Inadimplência: títulos a receber vencidos, por faixa de atraso e por cliente, com a última
 * interação de cobrança e a promessa pendente mais próxima.
 */
function painel(db, empresaId) {
  atualizarPromessas(db, empresaId);
  const dia = hoje();
  const vencidos = db.prepare(`SELECT l.*, c.nome AS contato_nome FROM lancamentos l LEFT JOIN contatos c ON c.id = l.contato_id
    WHERE l.empresa_id = ? AND l.tipo = 'receber' AND l.status = 'aberto' AND l.vencimento < ? ORDER BY l.vencimento`).all(empresaId, dia);
  const faixas = FAIXAS.map(([rotulo, de, ate]) => {
    const itens = vencidos.filter((l) => { const d = diferencaDias(dia, l.vencimento); return d >= de && d <= ate; });
    return { rotulo, quantidade: itens.length, total_centavos: itens.reduce((a, l) => a + l.valor_centavos, 0) };
  });
  const porContato = new Map();
  for (const l of vencidos) {
    const k = l.contato_id ?? 0;
    if (!porContato.has(k)) porContato.set(k, { contato_id: l.contato_id, nome: l.contato_nome ?? 'Sem cliente informado', titulos: 0, total_centavos: 0, maior_atraso: 0 });
    const c = porContato.get(k);
    c.titulos++;
    c.total_centavos += l.valor_centavos;
    c.maior_atraso = Math.max(c.maior_atraso, diferencaDias(dia, l.vencimento));
  }
  const ultima = db.prepare('SELECT canal, descricao, criado_em FROM cobranca_registros WHERE contato_id = ? ORDER BY id DESC LIMIT 1');
  const promessa = db.prepare("SELECT data_prometida, valor_centavos FROM promessas WHERE contato_id = ? AND status = 'pendente' ORDER BY data_prometida LIMIT 1");
  const devedores = [...porContato.values()].map((c) => ({
    ...c, ultima_interacao: c.contato_id ? ultima.get(c.contato_id) ?? null : null, promessa: c.contato_id ? promessa.get(c.contato_id) ?? null : null,
  })).sort((a, b) => b.total_centavos - a.total_centavos);

  // Taxa de inadimplência: vencido em aberto ÷ tudo o que venceu nos últimos 90 dias (pago ou não).
  const base = db.prepare(`SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM lancamentos WHERE empresa_id = ? AND tipo = 'receber'
    AND status <> 'cancelado' AND vencimento BETWEEN ? AND ?`).get(empresaId, somarDias(dia, -90), somarDias(dia, -1)).s;
  const vencido90 = vencidos.filter((l) => l.vencimento >= somarDias(dia, -90)).reduce((a, l) => a + l.valor_centavos, 0);
  const promessas = db.prepare(`SELECT p.*, c.nome AS contato_nome, u.nome AS usuario_nome FROM promessas p JOIN contatos c ON c.id = p.contato_id
    LEFT JOIN usuarios u ON u.id = p.usuario_id WHERE p.empresa_id = ? AND p.status = 'pendente' ORDER BY p.data_prometida`).all(empresaId)
    .map((p) => ({ ...p, atrasada: p.data_prometida < dia }));
  return {
    hoje: dia,
    total_vencido_centavos: vencidos.reduce((a, l) => a + l.valor_centavos, 0),
    titulos_vencidos: vencidos.length,
    taxa_90_dias: base ? vencido90 / base : null,
    faixas, devedores, promessas,
  };
}

/** Títulos a receber que vencem nos próximos `dias` ou já venceram, com o texto do lembrete pronto. */
function lembretes(db, empresa, dias = 3) {
  const dia = hoje();
  const itens = db.prepare(`SELECT l.id, l.descricao, l.valor_centavos, l.vencimento, l.documento, c.id AS contato_id, c.nome AS contato_nome,
      c.email, c.telefone,
      (SELECT MAX(r.criado_em) FROM cobranca_registros r WHERE r.lancamento_id = l.id AND r.canal = 'lembrete') AS ultimo_lembrete
    FROM lancamentos l JOIN contatos c ON c.id = l.contato_id
    WHERE l.empresa_id = ? AND l.tipo = 'receber' AND l.status = 'aberto' AND l.vencimento <= ? ORDER BY l.vencimento LIMIT 300`)
    .all(empresa.id, somarDias(dia, dias));
  const nome = empresa.nome_fantasia || empresa.razao_social;
  const reais = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const br = (d) => d.split('-').reverse().join('/');
  return itens.map((l) => {
    const atraso = diferencaDias(dia, l.vencimento);
    const quando = atraso > 0 ? `venceu em ${br(l.vencimento)} (${atraso} dia(s) em atraso)` : atraso === 0 ? 'vence hoje' : `vence em ${br(l.vencimento)}`;
    const texto = `Olá, ${l.contato_nome}! Aqui é do financeiro da ${nome}. Lembramos que o pagamento de ${reais(l.valor_centavos)}`
      + ` referente a "${l.descricao}"${l.documento ? ` (documento ${l.documento})` : ''} ${quando}.`
      + `${empresa.chave_pix_cobranca ? ` Chave PIX para pagamento: ${empresa.chave_pix_cobranca}.` : ''}`
      + ' Se já pagou, por favor desconsidere esta mensagem. Obrigado!';
    return { ...l, atraso, texto };
  });
}

function registrarContato(db, req, empresaId, corpo) {
  const contato = daEmpresa(db, 'contatos', v.id(corpo.contato_id), empresaId, 'Cliente');
  v.exigir(contato, 'Informe o cliente.');
  if (corpo.lancamento_id) daEmpresa(db, 'lancamentos', v.id(corpo.lancamento_id), empresaId, 'Lançamento');
  v.exigir(CANAIS.includes(corpo.canal), 'Canal inválido.');
  const descricao = v.texto(corpo.descricao, 1000);
  v.exigir(descricao, 'Descreva o contato.');
  const r = db.prepare('INSERT INTO cobranca_registros (empresa_id, contato_id, lancamento_id, canal, descricao, usuario_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(empresaId, contato.id, v.id(corpo.lancamento_id), corpo.canal, descricao, req.usuario.id);
  return Number(r.lastInsertRowid);
}

function registrarPromessa(db, req, empresaId, corpo) {
  const contato = daEmpresa(db, 'contatos', v.id(corpo.contato_id), empresaId, 'Cliente');
  v.exigir(contato, 'Informe o cliente.');
  if (corpo.lancamento_id) daEmpresa(db, 'lancamentos', v.id(corpo.lancamento_id), empresaId, 'Lançamento');
  const data = v.data(corpo.data_prometida, 'a data prometida');
  const valor = v.valorCentavos(corpo.valor_centavos);
  return transacao(db, () => {
    const r = db.prepare('INSERT INTO promessas (empresa_id, contato_id, lancamento_id, data_prometida, valor_centavos, observacao, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(empresaId, contato.id, v.id(corpo.lancamento_id), data, valor, v.texto(corpo.observacao, 500), req.usuario.id);
    db.prepare("INSERT INTO cobranca_registros (empresa_id, contato_id, lancamento_id, canal, descricao, usuario_id) VALUES (?, ?, ?, 'outro', ?, ?)")
      .run(empresaId, contato.id, v.id(corpo.lancamento_id), `Promessa de pagamento de ${(valor / 100).toFixed(2).replace('.', ',')} para ${data.split('-').reverse().join('/')}.`, req.usuario.id);
    return Number(r.lastInsertRowid);
  });
}

function resolverPromessa(db, empresaId, id, status) {
  v.exigir(['cumprida', 'quebrada'].includes(status), 'Situação inválida.');
  const p = daEmpresa(db, 'promessas', v.id(id), empresaId, 'Promessa');
  v.exigir(p.status === 'pendente', 'Promessa já resolvida.');
  db.prepare("UPDATE promessas SET status = ?, resolvida_em = datetime('now') WHERE id = ?").run(status, p.id);
}

/**
 * Acordo (renegociação): os títulos vencidos escolhidos são cancelados e substituídos por novas
 * parcelas no valor acordado (com juros ou desconto embutidos), ligadas ao acordo.
 */
function acordo(db, req, empresaId, corpo) {
  const contato = daEmpresa(db, 'contatos', v.id(corpo.contato_id), empresaId, 'Cliente');
  v.exigir(contato, 'Informe o cliente.');
  const ids = Array.isArray(corpo.lancamento_ids) ? corpo.lancamento_ids.map(Number) : [];
  v.exigir(ids.length, 'Selecione os títulos renegociados.');
  const valor = v.valorCentavos(corpo.valor_centavos, 'valor do acordo');
  const parcelas = Number(corpo.parcelas ?? 1);
  v.exigir(Number.isInteger(parcelas) && parcelas >= 1 && parcelas <= 60, 'Parcelas do acordo: de 1 a 60.');
  const primeiro = v.data(corpo.primeiro_vencimento, 'o primeiro vencimento');
  return transacao(db, () => {
    const titulos = ids.map((id) => lanc.buscar(db, empresaId, id));
    for (const t of titulos) {
      v.exigir(t.tipo === 'receber' && t.status === 'aberto', `Título #${t.id} não está em aberto.`);
      v.exigir(t.contato_id === contato.id, `Título #${t.id} é de outro cliente.`);
    }
    const original = titulos.reduce((a, t) => a + t.valor_centavos, 0);
    const r = db.prepare(`INSERT INTO acordos (empresa_id, contato_id, valor_original_centavos, valor_acordo_centavos, parcelas, primeiro_vencimento, observacao, usuario_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId, contato.id, original, valor, parcelas, primeiro, v.texto(corpo.observacao, 500), req.usuario.id);
    const acordoId = Number(r.lastInsertRowid);
    for (const t of titulos) lanc.cancelar(db, empresaId, t.id);
    db.prepare(`UPDATE lancamentos SET renegociado_acordo_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(acordoId, ...ids);
    const categoria = titulos[0].categoria_id;
    const novos = lanc.criar(db, req, empresaId, {
      tipo: 'receber', descricao: `Acordo #${acordoId} — ${contato.nome}`, valor_centavos: valor, parcelas, vencimento: primeiro,
      // A receita continua na competência de hoje: a diferença para o original é ajuste da negociação.
      competencia: hoje(), categoria_id: categoria, contato_id: contato.id, conta_bancaria_id: titulos[0].conta_bancaria_id,
      observacoes: `Renegociação dos títulos ${ids.map((i) => `#${i}`).join(', ')} (original ${(original / 100).toFixed(2).replace('.', ',')}).`,
    }, { acordo_id: acordoId });
    db.prepare("INSERT INTO cobranca_registros (empresa_id, contato_id, canal, descricao, usuario_id) VALUES (?, ?, 'outro', ?, ?)")
      .run(empresaId, contato.id, `Acordo #${acordoId}: ${titulos.length} título(s) renegociado(s) em ${parcelas} parcela(s).`, req.usuario.id);
    return { acordo_id: acordoId, lancamentos: novos, valor_original_centavos: original };
  });
}

/** Ficha de cobrança do cliente: títulos em aberto, histórico, promessas e acordos. */
function ficha(db, empresaId, contatoId) {
  atualizarPromessas(db, empresaId);
  const contato = daEmpresa(db, 'contatos', v.id(contatoId), empresaId, 'Cliente');
  const dia = hoje();
  return {
    contato,
    // Vencidos e os que vencem nos próximos 30 dias.
    titulos: db.prepare(`SELECT * FROM lancamentos WHERE empresa_id = ? AND contato_id = ? AND tipo = 'receber' AND status = 'aberto' AND vencimento <= ? ORDER BY vencimento`)
      .all(empresaId, contato.id, somarDias(dia, 30)).map((l) => ({ ...l, situacao: lanc.situacao(l, dia), atraso: Math.max(0, diferencaDias(dia, l.vencimento)) })),
    historico: db.prepare(`SELECT r.*, u.nome AS usuario_nome FROM cobranca_registros r LEFT JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.contato_id = ? ORDER BY r.id DESC LIMIT 100`).all(contato.id),
    promessas: db.prepare('SELECT * FROM promessas WHERE contato_id = ? ORDER BY id DESC LIMIT 50').all(contato.id),
    acordos: db.prepare('SELECT * FROM acordos WHERE contato_id = ? ORDER BY id DESC').all(contato.id),
  };
}

module.exports = { CANAIS, painel, lembretes, registrarContato, registrarPromessa, resolverPromessa, acordo, ficha };
