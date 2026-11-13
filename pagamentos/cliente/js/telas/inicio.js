import { api, ir, pode } from '../app.js';
import {
  el, montar, kpi, cartao, tabela, dinheiro, numero, data, selo, icone, aviso, R
} from '../../comum/ui.js';
import { barrasPorDia, agendaLiberacao, barraSplit } from '../../comum/graficos.js';

/** Tela inicial: saldo em destaque, o que está por vir e o que precisa de atenção. */
export default async function inicio({ alvo }) {
  const d = await api.get('/painel');
  const l = d.liquidacoes;

  const cartaoSaldo = el('div', { class: 'saldo' },
    el('div', {},
      el('div', { class: 'titulo' }, 'Saldo disponível'),
      el('div', { class: 'valor' }, dinheiro(d.saldo.disponivel_centavos))),
    el('div', { class: 'linhas' },
      el('div', { class: 'linha' }, el('span', {}, `A liberar (D+${d.cliente.retencao_dias} útil)`), el('strong', {}, dinheiro(d.saldo.a_liberar_centavos))),
      el('div', { class: 'linha' }, el('span', {}, 'Recebido no mês'), el('strong', {}, dinheiro(l.bruto_centavos))),
      el('div', { class: 'linha' }, el('span', {}, 'Já repassado no mês'), el('strong', {}, dinheiro(l.repassado_centavos)))),
    el('div', { class: 'acoes' },
      pode('repasses.solicitar') && d.disponivel.sacavel_centavos > 0
        ? el('a', { class: 'botao', href: '#/repasses' }, icone('pix'), 'Transferir para minha conta') : null,
      pode('boletos.emitir') ? el('a', { class: 'botao sec', href: '#/boletos?novo=1' }, icone('mais'), 'Emitir boleto') : null,
      el('a', { class: 'botao sec', href: '#/extrato' }, icone('lista'), 'Ver extrato')));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, `Olá, ${d.cliente.nome_fantasia || d.cliente.razao_social}`),
        el('p', {}, `Movimento de ${data(d.periodo.de)} a ${data(d.periodo.ate)}`))),

    d.cliente.situacao !== 'ativo' ? aviso(`A sua conta está com situação "${d.cliente.situacao}". Fale com o seu gerente.`, 'aviso') : null,
    cartaoSaldo,

    el('div', { class: 'grade kpis', style: 'margin-top:14px' },
      kpi({ rotulo: 'Boletos emitidos no mês', valor: numero(d.boletos.emitidos), apoio: dinheiro(d.boletos.valor_emitido_centavos), ic: 'boleto' }),
      kpi({ rotulo: 'Pagos', valor: numero(d.boletos.liquidados), apoio: dinheiro(d.boletos.valor_liquidado_centavos), tom: 'positivo', ic: 'ok' }),
      kpi({ rotulo: 'A vencer', valor: numero(d.boletos.a_vencer), apoio: 'aguardando pagamento', ic: 'relogio' }),
      kpi({ rotulo: 'Vencidos em aberto', valor: numero(d.vencidos.titulos), apoio: dinheiro(d.vencidos.valor_centavos),
        tom: d.vencidos.titulos ? 'negativo' : '', ic: 'alerta' })),

    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao('O que entrou por dia', barrasPorDia({ dados: d.serie.map((s) => ({ data: s.data, valor: s.bruto_centavos, titulos: s.titulos })) })),
      cartao('Quando o seu saldo é liberado', agendaLiberacao({ dados: d.agenda }))),

    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao('O que foi descontado no mês', l.bruto_centavos
        ? el('div', {},
          barraSplit({
            total: l.bruto_centavos,
            partes: [
              { rotulo: 'Líquido para você', valor: l.liquido_centavos },
              { rotulo: 'Tarifa bancária', valor: l.tarifa_banco_centavos + l.tarifa_emissao_centavos },
              { rotulo: 'Comissão PayAx', valor: l.comissao_centavos },
            ],
          }),
          el('p', { style: 'margin-top:10px;color:var(--texto-2);font-size:13px' },
            `A sua tabela: ${d.preco.percentual_texto} sobre o valor pago (mínimo ${dinheiro(d.preco.comissao_minima_centavos)}) + ${dinheiro(d.preco.tarifa_liquidacao_centavos)} de tarifa por título pago.`))
        : el('p', { class: 'vazio' }, 'Nenhum título pago no período.')),
      cartao('Próximos vencimentos', tabela({
        colunas: [
          { titulo: 'Vencimento', conteudo: (x) => data(x.vencimento) },
          { titulo: 'Títulos', dir: true, conteudo: (x) => numero(x.titulos) },
          { titulo: 'Valor', dir: true, conteudo: (x) => el('strong', {}, dinheiro(x.valor_centavos)) },
        ],
        itens: d.proximos_vencimentos,
        vazio: 'Nenhum boleto a vencer.',
        aoClicar: (x) => ir(`#/boletos?situacao=a_vencer&de=${x.vencimento}&ate=${x.vencimento}`),
      }))),

    d.repasses.length
      ? el('div', { style: 'margin-top:14px' }, cartao('Últimos repasses', tabela({
        colunas: [
          { titulo: 'Quando', conteudo: (r) => data(r.criado_em?.slice(0, 10)) },
          { titulo: 'Valor', dir: true, conteudo: (r) => el('strong', {}, dinheiro(r.valor_liquido_centavos)) },
          { titulo: 'Chave PIX', conteudo: (r) => r.pix_chave },
          { titulo: 'Situação', conteudo: (r) => selo(r.situacao, R.situacaoRepasse) },
        ],
        itens: d.repasses,
        aoClicar: () => ir('#/repasses'),
      })))
      : null,
  );
}
