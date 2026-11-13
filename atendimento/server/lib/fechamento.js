'use strict';

const { agora, transacao } = require('../db');
const { hoje, somarDias } = require('./datas');
const { ErroNegocio, naoEncontrado } = require('./erros');
const custo = require('./custo');
const orcamento = require('./orcamento');
const v = require('./validacao');

/**
 * O fechamento do mês — onde o número para de ser estimativa.
 *
 * Durante o mês a tela soma as mensagens uma a uma. No dia 1º o mês anterior é fechado numa
 * linha que não muda mais: quantas mensagens, por categoria, o que foi gasto, o que deixou de
 * ser gasto e qual era o orçamento. Depois a gestão lança o valor que a Meta cobrou de verdade
 * e o sistema mostra a diferença.
 *
 * Essa conferência é o que separa um painel bonito de um controle de custo. Se a nossa conta e
 * a fatura da Meta divergirem, ou o preço cadastrado está velho, ou mensagem está saindo por
 * fora do sistema — e nos dois casos a gestão precisa saber, não descobrir no extrato.
 */

const mesAnterior = (ref = hoje()) => somarDias(`${ref.slice(0, 7)}-01`, -1).slice(0, 7);
const ehMesValido = (mes) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes));

/**
 * Fecha um mês. Idempotente: fechar de novo recalcula, a menos que a fatura da Meta já tenha
 * sido lançada — a partir daí a linha está conferida e não se mexe mais nela.
 */
function fechar(db, empresaId, mes = mesAnterior()) {
  v.exigir(ehMesValido(mes), 'Informe o mês no formato AAAA-MM.');
  v.exigir(mes <= hoje().slice(0, 7), 'Não é possível fechar um mês que ainda não começou.');
  const existente = db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? AND mes = ?').get(empresaId, mes);
  if (existente?.conferido_em) return { ...publico(existente), recalculado: false };

  const inicio = `${mes}-01`;
  const fim = `${somarDias(inicio, 31).slice(0, 7)}-01`;
  const r = custo.resumo(db, empresaId, { de: inicio, ate: somarDias(fim, -1) });
  const e = db.prepare('SELECT orcamento_milesimos FROM empresas WHERE id = ?').get(empresaId);

  const linha = transacao(db, () => {
    db.prepare(`INSERT INTO custos_mensais
        (empresa_id, mes, mensagens, por_categoria, gasto_milesimos, economia_milesimos, sem_otimizacao_milesimos, orcamento_milesimos, fechado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (empresa_id, mes) DO UPDATE SET
        mensagens = excluded.mensagens, por_categoria = excluded.por_categoria,
        gasto_milesimos = excluded.gasto_milesimos, economia_milesimos = excluded.economia_milesimos,
        sem_otimizacao_milesimos = excluded.sem_otimizacao_milesimos,
        orcamento_milesimos = excluded.orcamento_milesimos, fechado_em = excluded.fechado_em`)
      .run(empresaId, mes, r.mensagens, JSON.stringify(r.por_categoria), r.gasto_milesimos,
        r.economia_milesimos, r.sem_otimizacao_milesimos, Number(e?.orcamento_milesimos ?? 0), agora());
    return db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? AND mes = ?').get(empresaId, mes);
  });
  return { ...publico(linha), recalculado: Boolean(existente) };
}

/** Lança o valor que a Meta cobrou e congela o mês. Em centavos, como vem na fatura. */
function conferir(db, empresaId, mes, { valor_centavos, observacao = null, usuario = null }) {
  v.exigir(ehMesValido(mes), 'Informe o mês no formato AAAA-MM.');
  const linha = db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? AND mes = ?').get(empresaId, mes)
    ?? (fechar(db, empresaId, mes) && db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? AND mes = ?').get(empresaId, mes));
  if (!linha) throw naoEncontrado('Fechamento do mês');
  const valor = v.inteiro(valor_centavos, 'o valor da fatura da Meta', { min: 0, max: 100_000_000 });
  db.prepare('UPDATE custos_mensais SET fatura_meta_centavos = ?, observacao = ?, conferido_em = ?, conferido_por = ? WHERE id = ?')
    .run(valor, v.opcional(observacao, 'a observação', 1000), agora(), usuario?.nome ?? null, linha.id);
  return publico(db.prepare('SELECT * FROM custos_mensais WHERE id = ?').get(linha.id));
}

/** Abre um mês já conferido para lançar de novo (erro de digitação na fatura, por exemplo). */
function reabrir(db, empresaId, mes) {
  const linha = db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? AND mes = ?').get(empresaId, mes);
  if (!linha) throw naoEncontrado('Fechamento do mês');
  if (!linha.conferido_em) throw new ErroNegocio('Este mês ainda não foi conferido.');
  db.prepare('UPDATE custos_mensais SET fatura_meta_centavos = NULL, conferido_em = NULL, conferido_por = NULL WHERE id = ?').run(linha.id);
  return fechar(db, empresaId, mes);
}

/** A linha como o painel e o Manager a leem, já com a diferença calculada. */
function publico(l) {
  if (!l) return null;
  const nosso = Math.round(Number(l.gasto_milesimos) / 10); // milésimos de real → centavos
  const meta = l.fatura_meta_centavos === null || l.fatura_meta_centavos === undefined ? null : Number(l.fatura_meta_centavos);
  return {
    mes: l.mes,
    mensagens: Number(l.mensagens),
    por_categoria: (() => { try { return JSON.parse(l.por_categoria); } catch { return []; } })(),
    gasto_milesimos: Number(l.gasto_milesimos),
    gasto_centavos: nosso,
    economia_milesimos: Number(l.economia_milesimos),
    sem_otimizacao_milesimos: Number(l.sem_otimizacao_milesimos),
    orcamento_milesimos: Number(l.orcamento_milesimos),
    estourou_orcamento: Boolean(l.orcamento_milesimos && Number(l.gasto_milesimos) > Number(l.orcamento_milesimos)),
    fatura_meta_centavos: meta,
    diferenca_centavos: meta === null ? null : meta - nosso,
    // Mais de 5% de diferença não é arredondamento: é preço velho ou mensagem saindo por fora.
    divergente: meta === null ? null : Math.abs(meta - nosso) > Math.max(100, Math.round(nosso * 0.05)),
    conferido_em: l.conferido_em,
    conferido_por: l.conferido_por,
    observacao: l.observacao,
    fechado_em: l.fechado_em,
  };
}

/** Os últimos N meses fechados, do mais recente para o mais antigo, com o mês corrente em aberto. */
function serie(db, empresaId, { meses = 12 } = {}) {
  const fechados = db.prepare('SELECT * FROM custos_mensais WHERE empresa_id = ? ORDER BY mes DESC LIMIT ?')
    .all(empresaId, Math.min(60, Math.max(1, Number(meses)))).map(publico);
  const mesCorrente = hoje().slice(0, 7);
  const aberto = fechados.some((x) => x.mes === mesCorrente) ? null : (() => {
    const r = custo.resumo(db, empresaId, { de: `${mesCorrente}-01`, ate: hoje() });
    const o = orcamento.estado(db, empresaId);
    return {
      mes: mesCorrente, mensagens: r.mensagens, por_categoria: r.por_categoria,
      gasto_milesimos: r.gasto_milesimos, gasto_centavos: Math.round(r.gasto_milesimos / 10),
      economia_milesimos: r.economia_milesimos, sem_otimizacao_milesimos: r.sem_otimizacao_milesimos,
      orcamento_milesimos: o.orcamento_milesimos, estourou_orcamento: o.status === 'estourado',
      fatura_meta_centavos: null, diferenca_centavos: null, divergente: null,
      conferido_em: null, conferido_por: null, observacao: null, fechado_em: null,
      em_aberto: true, projecao_milesimos: o.projecao_milesimos,
    };
  })();
  return { meses: [...(aberto ? [aberto] : []), ...fechados] };
}

/** Fecha o mês anterior de todas as empresas ativas. Chamado pelo agendador no dia 1º. */
function fecharTodas(db, { mes = mesAnterior() } = {}) {
  const feitos = [];
  for (const e of db.prepare("SELECT id, nome FROM empresas WHERE status = 'ativa'").all()) {
    try { feitos.push({ empresa: e.nome, ...fechar(db, e.id, mes) }); } catch (err) { feitos.push({ empresa: e.nome, erro: err.message }); }
  }
  return feitos;
}

module.exports = { fechar, conferir, reabrir, serie, fecharTodas, mesAnterior, publico };
