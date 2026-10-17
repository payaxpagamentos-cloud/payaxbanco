'use strict';

const { transacao, lerConfig, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { intervalo, local } = require('./datas');
const v = require('./validacao');

const FORMA = { pix: 'PIX', cartao: 'cartão', empresa: 'empresa' };

/**
 * Crédito da corrida finalizada na conta do motorista: o valor final menos a taxa da plataforma.
 * Tudo é pago à plataforma antes (ou faturado à empresa), então o motorista só tem valores a receber.
 */
function creditarCorrida(db, c) {
  if (!c.valor_motorista_centavos) return;
  db.prepare(`INSERT INTO lancamentos_motorista (motorista_id, corrida_id, tipo, descricao, valor_centavos, criado_em)
    VALUES (?, ?, 'corrida', ?, ?, ?)`).run(c.motorista_id, c.id, `Corrida #${c.id} (${FORMA[c.forma_pagamento]}): ${(c.valor_final_centavos / 100).toFixed(2).replace('.', ',')} menos a taxa`,
    c.valor_motorista_centavos, agora());
}

const saldo = (db, motoristaId) =>
  db.prepare('SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM lancamentos_motorista WHERE motorista_id = ?').get(motoristaId).s;

const extrato = (db, motoristaId, limite = 100) =>
  db.prepare('SELECT * FROM lancamentos_motorista WHERE motorista_id = ? ORDER BY id DESC LIMIT ?').all(motoristaId, limite);

/** Ganhos do motorista no período (dias locais): corridas, valor bruto, taxa, líquido e quanto recebeu em mãos. */
function ganhos(db, motoristaId, de, ate) {
  const [ini, fim] = intervalo(de, ate);
  const corridas = db.prepare(`SELECT id, origem_endereco, destino_endereco, finalizada_em, forma_pagamento, pagamento_status, valor_final_centavos,
      taxa_plataforma_centavos, valor_motorista_centavos, distancia_percorrida_m, duracao_real_s, nota_do_passageiro
    FROM corridas WHERE motorista_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ? ORDER BY finalizada_em DESC`).all(motoristaId, ini, fim);
  const soma = (f) => corridas.reduce((acc, c) => acc + f(c), 0);
  return {
    de, ate, corridas,
    total_corridas: corridas.length,
    bruto_centavos: soma((c) => c.valor_final_centavos),
    taxa_centavos: soma((c) => c.taxa_plataforma_centavos),
    liquido_centavos: soma((c) => c.valor_motorista_centavos),
    distancia_m: soma((c) => c.distancia_percorrida_m),
    tempo_s: soma((c) => c.duracao_real_s ?? 0),
  };
}

/** Motoristas com saldo diferente de zero (negativo só por ajuste manual), do maior para o menor. */
const saldos = (db) => db.prepare(`SELECT m.usuario_id AS motorista_id, u.nome, m.chave_pix, SUM(l.valor_centavos) AS saldo_centavos
  FROM lancamentos_motorista l JOIN motoristas m ON m.usuario_id = l.motorista_id JOIN usuarios u ON u.id = m.usuario_id
  GROUP BY m.usuario_id HAVING SUM(l.valor_centavos) <> 0 ORDER BY saldo_centavos DESC`).all();

/**
 * Gera um repasse pendente para cada motorista com saldo a receber acima do mínimo (ou só os informados).
 * O valor sai do saldo na hora; se o repasse for cancelado, volta.
 */
function gerarRepasses(db, usuario, motoristaIds) {
  const { repasse_minimo_centavos: minimo } = lerConfig(db);
  return transacao(db, () => {
    const gerados = [];
    const ignorados = [];
    for (const s of saldos(db)) {
      if (motoristaIds && !motoristaIds.includes(s.motorista_id)) continue;
      if (s.saldo_centavos < minimo) { if (motoristaIds) ignorados.push({ motorista_id: s.motorista_id, motivo: 'saldo abaixo do mínimo' }); continue; }
      if (!s.chave_pix) { ignorados.push({ motorista_id: s.motorista_id, motivo: 'sem chave PIX cadastrada' }); continue; }
      const pendente = db.prepare("SELECT 1 FROM repasses WHERE motorista_id = ? AND status = 'pendente'").get(s.motorista_id);
      if (pendente) { ignorados.push({ motorista_id: s.motorista_id, motivo: 'já tem repasse pendente' }); continue; }
      const r = db.prepare(`INSERT INTO repasses (motorista_id, valor_centavos, chave_pix, criado_em, criado_por) VALUES (?, ?, ?, ?, ?)`)
        .run(s.motorista_id, s.saldo_centavos, s.chave_pix, agora(), usuario.id);
      const id = Number(r.lastInsertRowid);
      db.prepare(`INSERT INTO lancamentos_motorista (motorista_id, repasse_id, tipo, descricao, valor_centavos, criado_em, criado_por)
        VALUES (?, ?, 'repasse', ?, ?, ?, ?)`).run(s.motorista_id, id, `Repasse #${id} para a chave PIX ${s.chave_pix}`, -s.saldo_centavos, agora(), usuario.id);
      gerados.push({ id, motorista_id: s.motorista_id, nome: s.nome, valor_centavos: s.saldo_centavos });
    }
    return { gerados, ignorados };
  });
}

function repasse(db, id) {
  const r = db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
  if (!r) throw naoEncontrado('Repasse');
  return r;
}

/** Marca o repasse como pago, com o identificador da transferência (ex.: E2E do PIX). */
function pagarRepasse(db, usuario, id, identificador) {
  const r = repasse(db, id);
  if (r.status !== 'pendente') throw new ErroNegocio('Repasse já concluído ou cancelado.', 409);
  db.prepare(`UPDATE repasses SET status = 'pago', concluido_em = ?, concluido_por = ?, identificador = ? WHERE id = ?`)
    .run(agora(), usuario.id, v.texto(identificador, 'o identificador da transferência', 100), id);
}

function cancelarRepasse(db, usuario, id, motivo) {
  transacao(db, () => {
    const r = repasse(db, id);
    if (r.status !== 'pendente') throw new ErroNegocio('Só repasses pendentes podem ser cancelados.', 409);
    db.prepare(`UPDATE repasses SET status = 'cancelado', concluido_em = ?, concluido_por = ?, motivo = ? WHERE id = ?`)
      .run(agora(), usuario.id, v.texto(motivo, 'o motivo', 300), id);
    db.prepare(`INSERT INTO lancamentos_motorista (motorista_id, repasse_id, tipo, descricao, valor_centavos, criado_em, criado_por)
      VALUES (?, ?, 'estorno_repasse', ?, ?, ?, ?)`).run(r.motorista_id, id, `Repasse #${id} cancelado: valor devolvido ao saldo`, r.valor_centavos, agora(), usuario.id);
  });
}

/** Ajuste manual na conta do motorista (positivo ou negativo), com motivo. */
function ajustar(db, usuario, motoristaId, valor, motivo) {
  const n = v.inteiro(valor, 'o valor', { min: -10_000_000, max: 10_000_000 });
  v.exigir(n !== 0, 'Informe um valor diferente de zero.');
  db.prepare(`INSERT INTO lancamentos_motorista (motorista_id, tipo, descricao, valor_centavos, criado_em, criado_por) VALUES (?, 'ajuste', ?, ?, ?, ?)`)
    .run(motoristaId, `Ajuste: ${v.texto(motivo, 'o motivo', 200)}`, n, agora(), usuario.id);
}

/** Relatório da central por dia local: corridas, faturamento, taxa e divisão por forma de pagamento. */
function relatorio(db, de, ate) {
  const [ini, fim] = intervalo(de, ate);
  const corridas = db.prepare(`SELECT c.*, u.nome AS motorista_nome FROM corridas c LEFT JOIN usuarios u ON u.id = c.motorista_id
    WHERE (c.finalizada_em >= ? AND c.finalizada_em < ?) OR (c.cancelada_em >= ? AND c.cancelada_em < ?)`).all(ini, fim, ini, fim);
  const dias = new Map();
  const motoristas = new Map();
  const formas = { pix: 0, cartao: 0, empresa: 0 };
  const tot = { finalizadas: 0, canceladas: 0, bruto_centavos: 0, taxa_centavos: 0, motoristas_centavos: 0, complementos_pendentes_centavos: 0, faturado_empresas_centavos: 0 };
  for (const c of corridas) {
    const dia = local(c.finalizada_em ?? c.cancelada_em).data;
    const d = dias.get(dia) ?? { data: dia, finalizadas: 0, canceladas: 0, bruto_centavos: 0, taxa_centavos: 0 };
    if (c.status === 'cancelada') {
      d.canceladas++;
      tot.canceladas++;
    } else if (c.status === 'finalizada') {
      d.finalizadas++;
      d.bruto_centavos += c.valor_final_centavos;
      d.taxa_centavos += c.taxa_plataforma_centavos;
      tot.finalizadas++;
      tot.bruto_centavos += c.valor_final_centavos;
      tot.taxa_centavos += c.taxa_plataforma_centavos;
      tot.motoristas_centavos += c.valor_motorista_centavos;
      if (c.forma_pagamento === 'empresa') tot.faturado_empresas_centavos += c.valor_final_centavos;
      formas[c.forma_pagamento] += c.valor_final_centavos;
      const m = motoristas.get(c.motorista_id) ?? { motorista_id: c.motorista_id, nome: c.motorista_nome, corridas: 0, bruto_centavos: 0 };
      m.corridas++;
      m.bruto_centavos += c.valor_final_centavos;
      motoristas.set(c.motorista_id, m);
    }
    dias.set(dia, d);
  }
  // Cobranças do período: complementos ainda a pagar e estornos devolvidos aos passageiros.
  const cob = (tipo, status) => db.prepare(`SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM cobrancas WHERE tipo = ? AND status = ? AND criada_em >= ? AND criada_em < ?`)
    .get(tipo, status, ini, fim).s;
  tot.complementos_pendentes_centavos = cob('complemento', 'pendente');
  return {
    de, ate, ...tot,
    estornos_centavos: cob('estorno', 'concluida'),
    estornos_pendentes_centavos: cob('estorno', 'pendente'),
    ticket_medio_centavos: tot.finalizadas ? Math.round(tot.bruto_centavos / tot.finalizadas) : 0,
    por_forma_centavos: formas,
    por_dia: [...dias.values()].sort((a, b) => a.data.localeCompare(b.data)),
    ranking_motoristas: [...motoristas.values()].sort((a, b) => b.bruto_centavos - a.bruto_centavos).slice(0, 20),
  };
}

const reais = (c) => (c / 100).toFixed(2).replace('.', ',');
const dataBr = (iso) => local(iso).data.split('-').reverse().join('/');
const csv = (t) => (/[;"\n]/.test(String(t)) ? `"${String(t).replace(/"/g, '""')}"` : String(t));

/**
 * Exportação para o Ativa BPO Financeiro (Integrações → importar lançamentos por CSV):
 * tipo; descrição; valor; vencimento; competência; categoria; contato; CPF/CNPJ; documento.
 * Taxas da plataforma do período entram como "receber"; repasses pagos aos motoristas, como "pagar".
 * As categorias precisam existir no plano de contas da empresa no BPO (padrão: as do plano inicial).
 */
function exportarBpo(db, de, ate, { categoriaReceita = 'Prestação de serviços', categoriaDespesa = 'Serviços terceirizados' } = {}) {
  const [ini, fim] = intervalo(de, ate);
  const linhas = [['tipo', 'descrição', 'valor', 'vencimento', 'competência', 'categoria', 'contato', 'CPF/CNPJ', 'documento']];
  const corridas = db.prepare(`SELECT c.id, c.finalizada_em, c.forma_pagamento, c.taxa_plataforma_centavos, c.valor_final_centavos, u.nome, m.cpf
    FROM corridas c JOIN motoristas m ON m.usuario_id = c.motorista_id JOIN usuarios u ON u.id = c.motorista_id
    WHERE c.status = 'finalizada' AND c.finalizada_em >= ? AND c.finalizada_em < ? ORDER BY c.id`).all(ini, fim);
  for (const c of corridas) {
    if (!c.taxa_plataforma_centavos) continue;
    const d = dataBr(c.finalizada_em);
    linhas.push(['receber', `Taxa da plataforma - corrida #${c.id} (${FORMA[c.forma_pagamento]})`, reais(c.taxa_plataforma_centavos), d, d,
      categoriaReceita, c.nome, c.cpf, `CORRIDA-${c.id}`]);
  }
  const repasses = db.prepare(`SELECT r.*, u.nome, m.cpf FROM repasses r JOIN motoristas m ON m.usuario_id = r.motorista_id JOIN usuarios u ON u.id = r.motorista_id
    WHERE r.status = 'pago' AND r.concluido_em >= ? AND r.concluido_em < ? ORDER BY r.id`).all(ini, fim);
  for (const r of repasses) {
    const d = dataBr(r.concluido_em);
    linhas.push(['pagar', `Repasse ao motorista - PIX ${r.identificador}`, reais(r.valor_centavos), d, d, categoriaDespesa, r.nome, r.cpf, `REPASSE-${r.id}`]);
  }
  return `${linhas.map((l) => l.map(csv).join(';')).join('\r\n')}\r\n`;
}

module.exports = { creditarCorrida, saldo, extrato, ganhos, saldos, gerarRepasses, repasse, pagarRepasse, cancelarRepasse, ajustar, relatorio, exportarBpo };
