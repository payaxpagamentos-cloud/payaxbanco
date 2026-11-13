import { api, ir, pode } from '../app.js';
import { el, kpi, cartao, tabela, dinheiro, numero, data, selo, icone, R, aviso } from '../../comum/ui.js';
import { barrasPorDia, barraSplit } from '../../comum/graficos.js';

/** Visão geral da plataforma: o que entrou, quanto ficou conosco e o que precisa de ação. */
export default async function visao({ alvo }) {
  const d = await api.get('/painel');
  const l = d.liquidacoes;

  const alertas = d.alertas.length
    ? cartao('Precisa de atenção', el('div', { class: 'alertas' }, d.alertas.map((a) => el('div', { class: `alerta-item ${a.severidade}` },
      icone(a.severidade === 'erro' ? 'alerta' : a.severidade === 'aviso' ? 'relogio' : 'info'),
      el('span', {}, a.texto, a.valor_centavos ? ` · ${dinheiro(a.valor_centavos)}` : ''),
      a.tipo.startsWith('repasses') ? el('a', { class: 'botao sec pequeno', href: '#/repasses' }, 'Ver repasses')
        : a.tipo === 'boletos_falha' ? el('a', { class: 'botao sec pequeno', href: '#/boletos?situacao=falha' }, 'Ver boletos')
          : a.tipo === 'sem_conta' ? el('a', { class: 'botao sec pequeno', href: '#/contas' }, 'Cadastrar conta') : null))))
    : null;

  alvo.append(
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Visão geral'),
        el('p', {}, `Movimento de ${data(d.periodo.de)} a ${data(d.periodo.ate)} · hoje ${data(d.hoje)}`))),

    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Recebido no período', valor: dinheiro(l.bruto_centavos), apoio: `${numero(l.titulos)} título(s) liquidado(s)`, tom: 'destaque', ic: 'dinheiro' }),
      kpi({ rotulo: 'Nossa receita', valor: dinheiro(l.receita_centavos), apoio: `Comissão ${dinheiro(l.comissao_centavos)} + tarifas ${dinheiro(l.tarifa_banco_centavos + l.tarifa_emissao_centavos)}`, tom: 'positivo', ic: 'relatorio' }),
      kpi({ rotulo: 'Margem (receita − custo do banco)', valor: dinheiro(l.margem_centavos), apoio: `Custo do banco ${dinheiro(l.custo_banco_centavos)}`, ic: 'banco' }),
      kpi({ rotulo: 'Saldo dos clientes', valor: dinheiro(d.saldo_clientes.disponivel_centavos), apoio: `${dinheiro(d.saldo_clientes.a_liberar_centavos)} a liberar`, ic: 'cofre' }),
    ),

    el('div', { class: 'grade kpis', style: 'margin-top:14px' },
      kpi({ rotulo: 'Boletos emitidos', valor: numero(d.boletos.emitidos), apoio: dinheiro(d.boletos.valor_emitido_centavos), menor: true, ic: 'boleto' }),
      kpi({ rotulo: 'Em aberto a vencer', valor: numero(d.boletos.a_vencer), apoio: 'aguardando pagamento', menor: true, ic: 'relogio' }),
      kpi({ rotulo: 'Vencidos', valor: numero(d.boletos.vencidos), apoio: dinheiro(d.boletos.valor_vencido_centavos), menor: true, tom: d.boletos.vencidos ? 'negativo' : '', ic: 'alerta' }),
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
              { rotulo: 'Comissão PayAx', valor: l.comissao_centavos },
            ],
          }),
          el('p', { style: 'margin-top:10px;color:var(--texto-2);font-size:13px' },
            `De ${dinheiro(l.bruto_centavos)} recebidos, ${dinheiro(l.receita_centavos)} ficaram com a PayAx e ${dinheiro(l.repassado_centavos)} já foram repassados.`))
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
