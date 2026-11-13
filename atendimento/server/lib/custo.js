'use strict';

const { lerConfig } = require('../db');

/**
 * O que cada mensagem custa na Meta — e, mais importante, o que dá para não gastar.
 *
 * A Meta cobra por mensagem ENTREGUE, por categoria:
 *
 *   serviço       R$ 0,00   o cliente falou primeiro e você responde dentro de 24 h. Ilimitado.
 *   utilidade     R$ 0,035  você inicia sobre algo que ele já contratou: boleto, aviso de manutenção.
 *   autenticação  R$ 0,03   código de verificação.
 *   marketing     R$ 0,32   você inicia para vender: upgrade, promoção, reativação.
 *
 * Três decisões derrubam a conta de um provedor, nesta ordem de impacto:
 *
 *   1. Responder DENTRO da janela de 24 h em vez de disparar template. Suporte, segunda via e
 *      desbloqueio viram serviço — de graça. É por isso que a ZOE resolver no WhatsApp é duplamente
 *      barato: economiza o atendente e economiza a mensagem.
 *   2. Mandar como utilidade o que é utilidade. Um lembrete de fatura disparado como marketing custa
 *      9 vezes mais pelo mesmo texto.
 *   3. Não disparar para quem não precisa: quem já pagou, quem pediu para não receber, quem já está
 *      conversando com a equipe e quem recebeu o mesmo aviso ontem.
 *
 * Preços em MILÉSIMOS DE REAL (R$ 0,035 = 35), porque centavos não comportam a tabela da Meta.
 */

const CATEGORIAS = {
  servico: { nome: 'Serviço', explicacao: 'O cliente falou primeiro e a resposta saiu dentro de 24 h.', chave: null },
  utilidade: { nome: 'Utilidade', explicacao: 'Aviso sobre algo que o cliente já contratou (fatura, manutenção).', chave: 'wa_preco_utilidade' },
  autenticacao: { nome: 'Autenticação', explicacao: 'Código de verificação.', chave: 'wa_preco_autenticacao' },
  marketing: { nome: 'Marketing', explicacao: 'Oferta, promoção ou reativação.', chave: 'wa_preco_marketing' },
};

const LISTA = Object.keys(CATEGORIAS);

/** Preço de uma categoria, em milésimos de real, com os valores que o master cadastrou. */
function preco(db, categoria) {
  const c = CATEGORIAS[categoria];
  if (!c?.chave) return 0;
  return Number(lerConfig(db)[c.chave] ?? 0);
}

const precos = (db) => Object.fromEntries(LISTA.map((k) => [k, preco(db, k)]));

/**
 * Qual a categoria de uma mensagem que está saindo.
 * A regra é a da Meta: o que vale é se a janela de 24 h está aberta, não o tipo da mensagem.
 */
function classificar({ janelaAberta, template = false, categoriaDoTemplate = null }) {
  // Dentro da janela, qualquer mensagem livre é serviço — de graça.
  if (janelaAberta && !template) return 'servico';
  // Template dentro da janela também é cobrado pela categoria dele (a Meta cobra o template).
  if (template) return LISTA.includes(categoriaDoTemplate) && categoriaDoTemplate !== 'servico' ? categoriaDoTemplate : 'utilidade';
  // Fora da janela sem template a Meta recusa: a plataforma nem tenta (envio.js barra antes).
  return 'utilidade';
}

const custoDe = (db, categoria) => preco(db, categoria);

/** Em reais, para mostrar na tela. */
const emReais = (milesimos) => (Number(milesimos ?? 0) / 1000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * O que a empresa gastou e o que deixou de gastar no período.
 * `economia` soma o que teria sido cobrado se cada decisão tivesse sido a mais cara.
 */
function resumo(db, empresaId, { de, ate }) {
  const { intervalo } = require('./datas');
  const [inicio, fim] = intervalo(de, ate);
  const p = precos(db);

  const porCategoria = db.prepare(`SELECT categoria, COUNT(*) AS mensagens, SUM(custo_milesimos) AS custo
    FROM mensagens WHERE empresa_id = ? AND direcao = 'saida' AND status IN ('enviada','entregue','lida')
      AND categoria IS NOT NULL AND criada_em >= ? AND criada_em < ?
    GROUP BY categoria`).all(empresaId, inicio, fim);

  const gasto = porCategoria.reduce((s, x) => s + Number(x.custo ?? 0), 0);
  const servico = porCategoria.find((x) => x.categoria === 'servico')?.mensagens ?? 0;

  // Economia da régua: o que ela pulou e o que mandou pela janela em vez de template.
  // Os dois casos ficam separados porque cada um é uma decisão diferente, e porque
  // um disparo que foi pela janela também gravou uma mensagem de serviço: se somássemos
  // os dois lados, o mesmo real apareceria duas vezes na tela.
  const daRegua = db.prepare(`SELECT
      SUM(CASE WHEN status = 'pulado' THEN 1 ELSE 0 END) AS pulados,
      SUM(CASE WHEN status = 'pulado' THEN economia_milesimos ELSE 0 END) AS economia_pulados,
      SUM(CASE WHEN status = 'enviado' AND categoria = 'servico' THEN 1 ELSE 0 END) AS pela_janela,
      SUM(CASE WHEN status = 'enviado' AND categoria = 'servico' THEN economia_milesimos ELSE 0 END) AS economia_janela,
      SUM(custo_milesimos) AS custo
    FROM disparos WHERE empresa_id = ? AND criado_em >= ? AND criado_em < ?`).get(empresaId, inicio, fim);

  const pulados = Number(daRegua?.pulados ?? 0);
  const peloCanalAberto = Number(daRegua?.pela_janela ?? 0);
  const economiaPulados = Number(daRegua?.economia_pulados ?? 0);
  const economiaJanelaRegua = Number(daRegua?.economia_janela ?? 0);

  // Toda mensagem de serviço é uma que NÃO virou utilidade: a economia silenciosa do
  // atendimento no WhatsApp. Descontamos as que a régua já contou como dela.
  const servicoEspontaneo = Math.max(0, Number(servico) - peloCanalAberto);
  const economiaServico = servicoEspontaneo * p.utilidade;
  const economiaRegua = economiaPulados + economiaJanelaRegua;

  return {
    periodo: { de, ate },
    precos: p,
    por_categoria: LISTA.map((k) => {
      const linha = porCategoria.find((x) => x.categoria === k);
      return {
        categoria: k, nome: CATEGORIAS[k].nome, explicacao: CATEGORIAS[k].explicacao,
        preco_milesimos: p[k], mensagens: Number(linha?.mensagens ?? 0), custo_milesimos: Number(linha?.custo ?? 0),
      };
    }),
    mensagens: porCategoria.reduce((s, x) => s + Number(x.mensagens), 0),
    gasto_milesimos: gasto,
    economia_milesimos: economiaServico + economiaRegua,
    economia: {
      por_janela_de_servico: { mensagens: servicoEspontaneo, milesimos: economiaServico },
      pela_regua: {
        pulados, milesimos: economiaRegua,
        pulados_milesimos: economiaPulados,
        pela_janela: peloCanalAberto, pela_janela_milesimos: economiaJanelaRegua,
      },
    },
    // O que a conta seria sem nenhuma das decisões: tudo como template de utilidade.
    sem_otimizacao_milesimos: gasto + economiaServico + economiaRegua,
  };
}

/** Projeção simples do mês, a partir do ritmo até aqui. */
function projecao(db, empresaId) {
  const { hoje, inicioMes } = require('./datas');
  const r = resumo(db, empresaId, { de: inicioMes(), ate: hoje() });
  const dia = Number(hoje().slice(8, 10));
  const diasNoMes = new Date(Number(hoje().slice(0, 4)), Number(hoje().slice(5, 7)), 0).getDate();
  return {
    ...r,
    dia,
    dias_no_mes: diasNoMes,
    projecao_milesimos: dia > 0 ? Math.round((r.gasto_milesimos / dia) * diasNoMes) : 0,
    projecao_sem_otimizacao_milesimos: dia > 0 ? Math.round((r.sem_otimizacao_milesimos / dia) * diasNoMes) : 0,
  };
}

module.exports = { CATEGORIAS, LISTA, preco, precos, classificar, custoDe, emReais, resumo, projecao };
