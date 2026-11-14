import { api, ir, pode } from '../app.js';
import {
  el, montar, kpi, cartao, tabela, dinheiro, numero, data, selo, icone, R, aviso
} from '../../comum/ui.js';
import { barrasPorDia, barraSplit } from '../../comum/graficos.js';
import { cartaoPainel, acoesRapidas } from '../../comum/componentes.js';

/** Visão geral da plataforma: o que entrou, quanto ficou conosco e o que precisa de ação. */
export default async function visao({ alvo }) {
  const d = await api.get('/painel');
  const l = d.liquidacoes;

  const aguardando = d.alertas.find((a) => a.tipo === 'repasses_aprovacao')?.quantidade ?? 0;

  const alertas = d.alertas.length
    ? cartao('Precisa de atenção', el('div', { class: 'alertas' }, d.alertas.map((a) => el('div', { class: `alerta-item ${a.severidade}` },
      icone(a.severidade === 'erro' ? 'alerta' : a.severidade === 'aviso' ? 'relogio' : 'info'),
      el('span', {}, a.texto, a.valor_centavos ? ` · ${dinheiro(a.valor_centavos)}` : ''),
      a.tipo.startsWith('repasses') ? el('a', { class: 'botao sec pequeno', href: '#/repasses' }, 'Ver repasses')
        : a.tipo === 'boletos_falha' ? el('a', { class: 'botao sec pequeno', href: '#/boletos?situacao=falha' }, 'Ver boletos')
          : a.tipo === 'sem_conta' ? el('a', { class: 'botao sec pequeno', href: '#/contas' }, 'Cadastrar conta')
            : a.tipo.startsWith('conformidade') ? el('a', { class: 'botao sec pequeno', href: '#/conformidade' }, 'Ver conformidade') : null))))
    : null;

  // Os atalhos são os da equipe, não os do cliente: o que se faz todo dia neste painel.
  const atalhos = acoesRapidas([
    pode('boletos.emitir') ? { ic: 'mais', titulo: 'Emitir boleto', descricao: 'Para um cliente', href: '#/boletos?novo=1' } : null,
    pode('repasses.ver') ? { ic: 'troca', titulo: 'Repasses', descricao: aguardando ? `${numero(aguardando)} aguardando você` : 'Nada pendente', href: '#/repasses' } : null,
    pode('conciliacao.ver') ? { ic: 'cofre', titulo: 'Conciliação', descricao: 'Remessa e retorno', href: '#/conciliacao' } : null,
    pode('relatorios.ver') ? { ic: 'relatorio', titulo: 'Relatórios', descricao: 'Fechar o mês', href: '#/relatorios' } : null,
  ]);

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Visão geral'),
        el('p', {}, `Movimento de ${data(d.periodo.de)} a ${data(d.periodo.ate)}`))),

    // O cartão de destaque é o mesmo do Internet Bank. Lá mostra o saldo do cliente;
    // aqui, a posição da plataforma no período.
    cartaoPainel({
      rotulo: 'Recebido no período',
      valor: dinheiro(l.bruto_centavos),
      apoio: `${numero(l.titulos)} título(s) liquidado(s)`,
      canto: el('div', {}, 'Hoje', el('strong', {}, data(d.hoje))),
      itens: [
        ['Nossa receita', dinheiro(l.receita_centavos)],
        ...(d.pode_ver_margem ? [['Margem', dinheiro(l.margem_centavos)]] : []),
        ['Saldo dos clientes', dinheiro(d.saldo_clientes.disponivel_centavos)],
        ['A liberar', dinheiro(d.saldo_clientes.a_liberar_centavos)],
        ['Repassado no período', dinheiro(l.repassado_centavos)],
      ],
    }),

    atalhos,

    el('div', { class: 'grade kpis', style: 'margin-top:20px' },
      kpi({ rotulo: 'Boletos emitidos', valor: numero(d.boletos.emitidos), apoio: dinheiro(d.boletos.valor_emitido_centavos), menor: true, ic: 'boleto' }),
      kpi({ rotulo: 'Em aberto a vencer', valor: numero(d.boletos.a_vencer), apoio: 'aguardando pagamento', menor: true, ic: 'relogio' }),
      kpi({ rotulo: 'Vencidos em aberto', valor: numero(d.vencidos_total.titulos), apoio: `${dinheiro(d.vencidos_total.valor_centavos)} · todos os períodos`, menor: true, tom: d.vencidos_total.titulos ? 'negativo' : '', ic: 'alerta' }),
      kpi({ rotulo: 'Clientes ativos', valor: numero(d.clientes.por_situacao?.ativo ?? 0), apoio: `${numero(d.clientes.total)} no total`, menor: true, ic: 'pessoas' }),
    ),

    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao('Entradas por dia (últimos 30 dias)',
        barrasPorDia({ dados: d.serie.map((s) => ({ data: s.data, valor: s.bruto_centavos, titulos: s.titulos })) })),
      cartao('Como o recebido foi dividido no período', l.bruto_centavos
        ? el('div', {},
          barraSplit({
            total: l.bruto_centavos,
            partes: [
              { rotulo: 'Líquido dos clientes', valor: l.liquido_cliente_centavos },
              { rotulo: 'Tarifa bancária', valor: l.tarifa_banco_centavos },
              { rotulo: 'Tarifa PAY AX', valor: l.comissao_centavos },
            ],
          }),
          el('p', { style: 'margin-top:10px;color:var(--texto-2);font-size:13px' },
            `Cada R$ 100 recebidos devolvem ${dinheiro(Math.round((l.liquido_cliente_centavos / l.bruto_centavos) * 10000))} ao cliente `
            + `e deixam ${dinheiro(Math.round((l.receita_centavos / l.bruto_centavos) * 10000))} conosco, já descontado o que o banco cobra.`))
        : el('p', { class: 'vazio' }, 'Nenhum título liquidado no período.')),
    ),

    alertas ? el('div', { style: 'margin-top:14px' }, alertas) : null,

    el('div', { style: 'margin-top:14px' },
      cartao('Maiores clientes no período', tabela({
        colunas: [
          { titulo: 'Cliente', conteudo: (c) => el('span', { class: 'forte' }, c.nome_fantasia || c.razao_social) },
          { titulo: 'Títulos liquidados', dir: true, conteudo: (c) => numero(c.titulos) },
          { titulo: 'Recebido', dir: true, conteudo: (c) => el('strong', {}, dinheiro(c.bruto_centavos)) },
        ],
        itens: d.maiores_clientes.filter((c) => c.bruto_centavos > 0),
        vazio: 'Nenhum recebimento no período.',
        aoClicar: pode('clientes.ver') ? (c) => ir(`#/clientes/${c.id}`) : null,
      }))),
  );
}
