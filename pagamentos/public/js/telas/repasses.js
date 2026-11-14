import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, paginacao, kpi, campo, lerForm, confirmar, toast, acao, aviso, selo,
  dinheiro, numero, data, dataHora, hojeIso, documento, R, icone
} from '../../comum/ui.js';

/** As duas formas de o dinheiro chegar ao cliente: PIX enviado pela PAY AX, ou crédito feito pelo próprio banco. */
const abas = (ativa) => el('div', { class: 'abas' },
  el('button', { class: ativa === 'pix' ? 'ativa' : '', onclick: () => ir('#/repasses') }, 'PIX da PAY AX'),
  el('button', { class: ativa === 'banco' ? 'ativa' : '', onclick: () => ir('#/repasses?ver=banco') }, 'Creditado pelo banco (rateio)'));

/**
 * Repasses: o dinheiro de cada cliente saindo por PIX assim que o banco credita.
 * Não há fila de aprovação nem saque — a rotina repassa a cada ciclo. Aqui a equipe acompanha
 * e age só na exceção: PIX que falhou (a rotina tenta de novo sozinha) ou repasse antigo pendente.
 */
export default async function repasses({ alvo, query, recarregar }) {
  if (query.ver === 'banco') return creditadoPeloBanco({ alvo, query });
  const filtros = { situacao: query.situacao ?? '', de: query.de ?? '', ate: query.ate ?? '', pagina: Number(query.pagina) || 1 };
  const d = await api.get(`/repasses${qs(filtros)}`);
  const porSituacao = Object.fromEntries(d.resumo.map((r) => [r.situacao, r]));
  const q = (s) => porSituacao[s] ?? { quantidade: 0, valor_centavos: 0 };

  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/repasses${qs({ ...filtros, ...lerForm(form), pagina: 1 })}`); } },
    campo({ nome: 'situacao', rotulo: 'Situação', tipo: 'select', valor: filtros.situacao,
      opcoes: [['', 'Todas'], ...Object.entries(R.situacaoRepasse).map(([k, [t]]) => [k, t])] }),
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: filtros.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: filtros.ate }),
    el('button', { class: 'botao', type: 'submit' }, 'Filtrar'),
    el('button', { class: 'botao sec', type: 'button', onclick: (e) => acao(e.currentTarget, () => api.baixar(`/repasses/export.csv${qs(filtros)}`, 'repasses.csv')) }, icone('baixar'), 'CSV'));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Repasses'), el('p', {}, 'O valor de cada cliente saindo por PIX assim que o banco credita — nada fica parado na nossa conta')),
      pode('repasses.enviar') ? el('div', { class: 'acoes' },
        el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, async () => {
          const r = await api.post('/repasses/rotina', {});
          toast(`Rodada concluída: ${r.enviados} enviado(s), ${r.falhas} falha(s).`, r.falhas ? 'erro' : 'ok');
          recarregar();
        }) }, icone('atualizar'), 'Repassar agora')) : null),

    abas('pix'),
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Em envio', valor: numero(q('aprovado').quantidade + q('enviado').quantidade),
        apoio: dinheiro(q('aprovado').valor_centavos + q('enviado').valor_centavos), menor: true, ic: 'troca' }),
      kpi({ rotulo: 'Confirmados', valor: numero(q('confirmado').quantidade), apoio: dinheiro(q('confirmado').valor_centavos), menor: true, tom: 'positivo', ic: 'ok' }),
      kpi({ rotulo: 'Com falha', valor: numero(q('falhou').quantidade), apoio: dinheiro(q('falhou').valor_centavos), menor: true, tom: q('falhou').quantidade ? 'negativo' : '', ic: 'alerta' })),

    el('div', { style: 'margin-top:14px' }, form),
    tabela({
      colunas: [
        { titulo: '#', conteudo: (r) => r.id },
        { titulo: 'Cliente', conteudo: (r) => el('span', {}, el('span', { class: 'forte' }, r.nome_fantasia || r.razao_social),
          el('span', { class: 'sub' }, r.pix_chave ?? `banco ${r.destino_banco} · ag. ${r.destino_agencia} · conta ${r.destino_conta}`)) },
        { titulo: 'Criado', conteudo: (r) => dataHora(r.criado_em) },
        { titulo: 'Líquido', dir: true, conteudo: (r) => el('span', {}, el('strong', {}, dinheiro(r.valor_liquido_centavos)),
          r.taxa_centavos ? el('span', { class: 'sub' }, `bruto ${dinheiro(r.valor_centavos)}`) : null) },
        { titulo: 'Situação', conteudo: (r) => el('span', {}, selo(r.situacao, R.situacaoRepasse),
          r.erro ? el('span', { class: 'sub' }, r.erro) : r.end_to_end ? el('span', { class: 'sub num' }, r.end_to_end) : null) },
        { titulo: '', dir: true, conteudo: (r) => el('div', { style: 'display:flex;gap:6px;justify-content:flex-end' },
          r.situacao === 'aguardando_aprovacao' && pode('repasses.aprovar')
            ? el('button', { class: 'botao pequeno', onclick: (e) => { e.stopPropagation(); acao(e.currentTarget, async () => {
              await api.post(`/repasses/${r.id}/aprovar`, {});
              await api.post(`/repasses/${r.id}/enviar`, {}).catch(() => null);
              toast('Repasse aprovado e enviado.', 'ok');
              recarregar();
            }); } }, 'Aprovar e enviar') : null,
          r.situacao === 'aprovado' && pode('repasses.enviar')
            ? el('button', { class: 'botao pequeno', onclick: (e) => { e.stopPropagation(); acao(e.currentTarget, async () => {
              await api.post(`/repasses/${r.id}/enviar`, {});
              toast('Repasse enviado.', 'ok');
              recarregar();
            }); } }, 'Enviar') : null,
          ['aguardando_aprovacao', 'aprovado', 'falhou'].includes(r.situacao) && pode('repasses.aprovar')
            ? el('button', { class: 'botao sec pequeno', onclick: async (e) => {
              e.stopPropagation();
              const c = await confirmar({ titulo: 'Cancelar repasse', texto: 'O valor é estornado e sai de novo na próxima rodada de repasse.', confirmarTexto: 'Cancelar repasse', perigo: true, campoMotivo: true });
              if (c) acao(e.currentTarget, async () => { await api.post(`/repasses/${r.id}/cancelar`, c); toast('Repasse cancelado.'); recarregar(); });
            } }, 'Cancelar') : null) },
      ],
      itens: d.itens,
      vazio: 'Nenhum repasse com esses filtros.',
      aoClicar: (r) => ir(`#/clientes/${r.cliente_id}/repasses`),
      rodape: paginacao(d, (p) => ir(`#/repasses${qs({ ...filtros, pagina: p })}`)),
    }),
  );
}

const SITUACAO_RATEIO = {
  efetuado: ['Creditado pelo banco', 'ok'],
  a_confirmar: ['A confirmar no extrato', 'erro'],
  nao_efetuado: ['Banco não creditou: foi por PIX', 'aviso'],
};

/**
 * Creditado pelo banco: no rateio o dinheiro do cliente não passa pela PAY AX, e mesmo assim a equipe
 * enxerga tudo — o banco informa no arquivo de retorno, boleto a boleto, quanto creditou ao cliente e
 * em que dia, e declara no fim do arquivo o total de rateios. Aqui ficam as duas coisas.
 */
async function creditadoPeloBanco({ alvo, query }) {
  const filtros = { ver: 'banco', situacao: query.situacao ?? '', de: query.de ?? '', ate: query.ate ?? '', pagina: Number(query.pagina) || 1 };
  const d = await api.get(`/repasses/rateios${qs({ ...filtros, ver: undefined })}`);
  const r = d.resumo;
  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/repasses${qs({ ...filtros, ...lerForm(form), pagina: 1 })}`); } },
    campo({ nome: 'situacao', rotulo: 'Situação', tipo: 'select', valor: filtros.situacao,
      opcoes: [['', 'Todas'], ...Object.entries(SITUACAO_RATEIO).map(([k, [t]]) => [k, t])] }),
    campo({ nome: 'de', rotulo: 'Pago de', tipo: 'date', valor: filtros.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: filtros.ate }),
    el('button', { class: 'botao', type: 'submit' }, 'Filtrar'));

  const situacao = (x) => {
    if (x.rateio_situacao === 'efetuado' && x.rateio_credito_em > hojeIso()) return selo('aguardando', { aguardando: [`Crédito em ${data(x.rateio_credito_em)}`, 'info'] });
    return selo(x.rateio_situacao ?? 'a_confirmar', SITUACAO_RATEIO);
  };

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Repasses'),
        el('p', {}, 'No rateio, o próprio Bradesco credita o cliente: o dinheiro não passa pela PAY AX. O banco informa no arquivo de retorno quanto creditou e quando — é o que aparece aqui.'))),
    abas('banco'),
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Creditado pelo banco hoje', valor: dinheiro(r.creditado_hoje.valor_centavos), apoio: `${numero(r.creditado_hoje.quantidade)} boleto(s)`, tom: 'destaque', ic: 'banco' }),
      kpi({ rotulo: 'No mês', valor: dinheiro(r.creditado_mes.valor_centavos), apoio: `${numero(r.creditado_mes.quantidade)} boleto(s)`, ic: 'ok' }),
      kpi({ rotulo: 'Aguardando o crédito do banco', valor: dinheiro(r.aguardando_credito.valor_centavos), apoio: 'rateio feito, cai na data informada', menor: true, ic: 'relogio' }),
      kpi({ rotulo: 'A confirmar no extrato', valor: numero(r.a_confirmar.quantidade), apoio: r.por_pix_mes.quantidade ? `${r.por_pix_mes.quantidade} foram por PIX no mês` : 'banco não informou', menor: true,
        tom: r.a_confirmar.quantidade ? 'negativo' : '', ic: 'alerta' })),

    el('div', { style: 'margin-top:14px' }, form),
    tabela({
      colunas: [
        { titulo: 'Boleto', conteudo: (x) => el('span', {}, el('span', { class: 'num forte', style: 'white-space:nowrap' }, `${x.nosso_numero}-${x.nosso_numero_dv}`),
          el('span', { class: 'sub' }, `pago em ${data(x.pago_em)}`)) },
        { titulo: 'Cliente', conteudo: (x) => el('span', {}, el('span', { class: 'forte' }, x.nome_fantasia || x.razao_social),
          x.destino ? el('span', { class: 'sub' }, `Bradesco · ag. ${x.destino.agencia}${x.destino.agencia_dv ? `-${x.destino.agencia_dv}` : ''} · c/c ${x.destino.conta}${x.destino.conta_dv ? `-${x.destino.conta_dv}` : ''}`) : null) },
        { titulo: 'Pago', dir: true, conteudo: (x) => dinheiro(x.pago_valor_centavos) },
        { titulo: 'Tarifa PAY AX', dir: true, conteudo: (x) => dinheiro(x.tarifa_payax_centavos) },
        { titulo: 'Creditado ao cliente', dir: true, conteudo: (x) => {
          if (x.rateio_valor_centavos == null) return '—';
          if (x.rateio_situacao === 'a_confirmar') return el('span', {}, dinheiro(x.rateio_valor_centavos), el('span', { class: 'sub' }, 'previsto, não confirmado'));
          return el('strong', {}, dinheiro(x.rateio_valor_centavos));
        } },
        { titulo: 'Situação', conteudo: (x) => el('span', {}, situacao(x),
          x.rateio_credito_em && x.rateio_credito_em <= hojeIso() ? el('span', { class: 'sub' }, `creditado em ${data(x.rateio_credito_em)}`) : null,
          x.rateio_motivo ? el('span', { class: 'sub' }, x.rateio_motivo) : null) },
      ],
      itens: d.itens,
      vazio: 'Nenhum boleto pago com rateio nesse período.',
      aoClicar: (x) => ir(`#/boletos/${x.id}`),
      rodape: paginacao(d, (p) => ir(`#/repasses${qs({ ...filtros, pagina: p })}`)),
    }),

    el('div', { style: 'margin-top:14px' }, cartao('Conferência dos arquivos do banco', el('div', {},
      el('p', { class: 'regra-exige', style: 'margin-bottom:10px' }, 'No fim de cada arquivo de retorno o banco declara o total de rateios que fez. O sistema soma boleto a boleto e compara: se não bater, a Conformidade acusa.'),
      tabela({
        colunas: [
          { titulo: 'Arquivo', conteudo: (a) => el('span', {}, a.nome, el('span', { class: 'sub' }, dataHora(a.processado_em))) },
          { titulo: 'Banco declarou', dir: true, conteudo: (a) => el('span', {}, dinheiro(a.rateio_total_centavos ?? 0), el('span', { class: 'sub' }, `${a.rateio_quantidade ?? 0} rateio(s)`)) },
          { titulo: 'Somamos', dir: true, conteudo: (a) => el('span', {}, dinheiro(a.rateio_lido_centavos ?? 0), el('span', { class: 'sub' }, `${a.rateio_lido_quantidade ?? 0} rateio(s)`)) },
          { titulo: '', conteudo: (a) => selo(a.confere ? 'confere' : 'diverge', { confere: ['Confere', 'ok'], diverge: ['Não confere', 'erro'] }) },
        ],
        itens: d.arquivos,
        vazio: 'Nenhum arquivo com rateio ainda.',
      })))),
  );
}

