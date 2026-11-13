'use strict';

/*
 * Adaptador do ZOE Atende (pasta atendimento/), pela API de integração dele:
 *   GET <base>/api/integracao/custos?meses=12      (X-Api-Key: chave da empresa no ZOE Atende)
 *
 * O que vem de lá é o custo do WhatsApp: quanto foi gasto com a Meta, quanto deixou de ser gasto
 * pelas decisões da régua, o orçamento do mês e os meses já fechados — inclusive o valor que a
 * Meta cobrou de verdade, quando a gestão já lançou a fatura.
 *
 * Aqui dentro só se guarda e se mostra. Quem decide o que mandar e o que não mandar é o ZOE Atende;
 * o Manager é onde a gestão olha o número junto do resto da operação.
 */

const { agora, transacao } = require('../db');
const base = require('./base');

const TIPO = 'atendimento';
const INTERVALO_PADRAO_S = 900;

const urlBase = (cfg) => String(cfg.url_base ?? '').replace(/\/+$/, '');
const intervalo = (cfg) => Math.max(120, Number(cfg.intervalo_s) || INTERVALO_PADRAO_S);

// Milésimos de real (como o ZOE Atende conta, porque R$ 0,035 não cabe em centavos) para centavos.
const emCentavos = (milesimos) => Math.round(Number(milesimos ?? 0) / 10);

function exigirConfigurado(x) {
  if (!x || !x.config.url_base) throw new base.ErroConector('Informe o endereço do ZOE Atende.', 'nao_configurada', { permanente: true });
  const chave = base.segredoDe(x);
  if (!chave) throw new base.ErroConector('Informe a chave de API da empresa no ZOE Atende.', 'nao_configurada', { permanente: true });
  return chave;
}

/** Converte a resposta da API no que este banco guarda. Campo que não vier fica nulo, não zero. */
function normalizar(d) {
  if (!d || typeof d !== 'object' || !d.mes_corrente) throw new base.ErroConector('Formato inesperado da conta do WhatsApp.');
  const o = d.orcamento ?? {};
  const e = d.economia_em_andamento ?? {};
  return {
    estado: {
      empresa: d.empresa ?? null,
      mes: String(d.mes_corrente.mes),
      gasto_centavos: emCentavos(d.mes_corrente.gasto_milesimos),
      economia_centavos: emCentavos(d.mes_corrente.economia_milesimos),
      projecao_centavos: emCentavos(d.mes_corrente.projecao_milesimos),
      orcamento_centavos: emCentavos(o.mensal_milesimos),
      percentual: Number(o.percentual ?? 0),
      situacao: String(o.status ?? 'sem_teto'),
      projecao_estoura: o.projecao_estoura ? 1 : 0,
      avisos_esperando: Number(e.avisos_esperando_a_janela ?? 0),
      valor_em_risco_centavos: emCentavos(e.valor_em_risco_milesimos),
      avisos_salvos: Number(e.avisos_salvos_pela_janela ?? 0),
      precos: d.precos_milesimos ? JSON.stringify(d.precos_milesimos) : null,
    },
    meses: (Array.isArray(d.meses) ? d.meses : []).filter((m) => /^\d{4}-\d{2}$/.test(String(m.mes ?? ''))).map((m) => ({
      mes: String(m.mes),
      mensagens: Number(m.mensagens ?? 0),
      gasto_centavos: emCentavos(m.gasto_milesimos),
      economia_centavos: emCentavos(m.economia_milesimos),
      sem_otimizacao_centavos: emCentavos(m.sem_otimizacao_milesimos),
      orcamento_centavos: emCentavos(m.orcamento_milesimos),
      fatura_meta_centavos: m.fatura_meta_centavos === null || m.fatura_meta_centavos === undefined ? null : Number(m.fatura_meta_centavos),
      divergente: m.divergente ? 1 : 0,
      em_aberto: m.em_aberto ? 1 : 0,
      por_categoria: m.por_categoria ? JSON.stringify(m.por_categoria) : null,
    })),
  };
}

/** Uma coleta: lê a conta do WhatsApp e regrava o estado e os meses. */
async function coletar(db, org) {
  const x = base.ler(db, org, TIPO);
  const inicio = Date.now();
  try {
    const chave = exigirConfigurado(x);
    const meses = Math.min(60, Math.max(1, Number(x.config.meses) || 12));
    const dados = await base.buscarJson(`${urlBase(x.config)}/api/integracao/custos?meses=${meses}`, { 'X-Api-Key': chave });
    const n = normalizar(dados);

    transacao(db, () => {
      const e = n.estado;
      db.prepare(`INSERT INTO custo_whatsapp_estado
          (organizacao_id, empresa, mes, gasto_centavos, economia_centavos, projecao_centavos, orcamento_centavos,
           percentual, situacao, projecao_estoura, avisos_esperando, valor_em_risco_centavos, avisos_salvos, precos, atualizado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (organizacao_id) DO UPDATE SET
          empresa = excluded.empresa, mes = excluded.mes, gasto_centavos = excluded.gasto_centavos,
          economia_centavos = excluded.economia_centavos, projecao_centavos = excluded.projecao_centavos,
          orcamento_centavos = excluded.orcamento_centavos, percentual = excluded.percentual,
          situacao = excluded.situacao, projecao_estoura = excluded.projecao_estoura,
          avisos_esperando = excluded.avisos_esperando, valor_em_risco_centavos = excluded.valor_em_risco_centavos,
          avisos_salvos = excluded.avisos_salvos, precos = excluded.precos, atualizado_em = excluded.atualizado_em`)
        .run(org, e.empresa, e.mes, e.gasto_centavos, e.economia_centavos, e.projecao_centavos, e.orcamento_centavos,
          e.percentual, e.situacao, e.projecao_estoura, e.avisos_esperando, e.valor_em_risco_centavos, e.avisos_salvos,
          e.precos, agora());

      for (const m of n.meses) {
        db.prepare(`INSERT INTO custos_whatsapp
            (organizacao_id, mes, mensagens, gasto_centavos, economia_centavos, sem_otimizacao_centavos,
             orcamento_centavos, fatura_meta_centavos, divergente, em_aberto, por_categoria, atualizado_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (organizacao_id, mes) DO UPDATE SET
            mensagens = excluded.mensagens, gasto_centavos = excluded.gasto_centavos,
            economia_centavos = excluded.economia_centavos, sem_otimizacao_centavos = excluded.sem_otimizacao_centavos,
            orcamento_centavos = excluded.orcamento_centavos, fatura_meta_centavos = excluded.fatura_meta_centavos,
            divergente = excluded.divergente, em_aberto = excluded.em_aberto,
            por_categoria = excluded.por_categoria, atualizado_em = excluded.atualizado_em`)
          .run(org, m.mes, m.mensagens, m.gasto_centavos, m.economia_centavos, m.sem_otimizacao_centavos,
            m.orcamento_centavos, m.fatura_meta_centavos, m.divergente, m.em_aberto, m.por_categoria, agora());
      }
    });

    // A leitura funcionou: a integração está conectada. Orçamento estourado e fatura divergente
    // são problemas do negócio, não da conexão — marcá-los como "parcial" aqui faria a tela de
    // integrações acusar defeito num conector que está perfeito, e a gestão deixaria de confiar nela.
    // Esses dois avisos aparecem na tela de Custo do WhatsApp, que é onde se age sobre eles.
    base.registrarResultado(db, org, TIPO, { inicio, itens: n.meses.length, parcial: false, intervaloS: intervalo(x.config) });
    return { meses: n.meses.length, situacao: n.estado.situacao, gasto_centavos: n.estado.gasto_centavos };
  } catch (err) {
    base.registrarResultado(db, org, TIPO, { inicio, erro: err, intervaloS: intervalo(x?.config ?? {}) });
    throw err;
  }
}

/** O que a tela e a API do Manager leem: a foto de agora e os meses, do mais recente ao mais antigo. */
function ler(db, org, { meses = 12 } = {}) {
  const estado = db.prepare('SELECT * FROM custo_whatsapp_estado WHERE organizacao_id = ?').get(org) ?? null;
  const lista = db.prepare('SELECT * FROM custos_whatsapp WHERE organizacao_id = ? ORDER BY mes DESC LIMIT ?')
    .all(org, Math.min(60, Math.max(1, Number(meses))));
  const json = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
  return {
    estado: estado ? { ...estado, precos: json(estado.precos), projecao_estoura: Boolean(estado.projecao_estoura) } : null,
    meses: lista.map((m) => ({
      ...m,
      por_categoria: json(m.por_categoria),
      divergente: Boolean(m.divergente),
      em_aberto: Boolean(m.em_aberto),
      diferenca_centavos: m.fatura_meta_centavos === null ? null : Number(m.fatura_meta_centavos) - Number(m.gasto_centavos),
    })),
  };
}

module.exports = { TIPO, coletar, ler, normalizar, intervalo, INTERVALO_PADRAO_S };
