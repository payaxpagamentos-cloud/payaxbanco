import { api, ir } from '../app.js';
import { qs } from '../../comum/api.js';
import { el, montar, tabela, paginacao, kpi, aviso, selo, dinheiro, data, dataHora, R } from '../../comum/ui.js';

/**
 * Transferências para a conta do cliente.
 *
 * Não há botão de "transferir": a PAY AX não guarda dinheiro. O valor de cada pagamento chega à conta
 * da empresa já sem a tarifa — creditado pelo próprio banco (rateio de crédito, conta Bradesco) ou
 * por PIX assim que o banco credita (demais bancos). Esta tela mostra esse caminho e o histórico.
 */
export default async function repasses({ alvo, query }) {
  const d = await api.get(`/repasses${qs({ pagina: Number(query.pagina) || 1 })}`);
  const t = d.transferencias;
  const peloBanco = t.meio_entrega === 'rateio';

  montar(alvo,
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Transferências'),
      el('p', {}, peloBanco
        ? 'Cada pagamento é creditado pelo próprio Bradesco na sua conta, já sem a tarifa. Não precisa pedir.'
        : 'Cada pagamento vai para a sua conta por PIX assim que o banco credita, já sem a tarifa. Não precisa pedir.'))),

    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Transferido hoje', valor: dinheiro(t.transferido_hoje_centavos), tom: 'destaque', ic: peloBanco ? 'banco' : 'pix' }),
      kpi({ rotulo: 'Transferido no mês', valor: dinheiro(t.transferido_mes_centavos), ic: 'ok' }),
      kpi({ rotulo: 'A caminho da sua conta', valor: dinheiro(t.a_caminho_centavos), apoio: 'creditado, saindo agora', ic: 'troca' }),
      kpi({ rotulo: 'Em compensação no banco', valor: dinheiro(t.a_compensar_centavos), apoio: 'pago pelo código de barras; o banco credita no próximo dia útil', ic: 'relogio' })),

    el('div', { style: 'margin-top:14px' },
      t.destino
        ? aviso(`Destino: ${t.destino}${peloBanco ? ' — crédito feito pelo próprio banco' : ' — por PIX'}. Para trocar, fale com o seu gerente de conta — por segurança, só a PAY AX altera o destino, e só para conta da própria empresa.`, 'info')
        : aviso('A sua empresa ainda não tem conta de destino cadastrada. Sem ela não é possível emitir boletos: fale com o seu gerente de conta.', 'erro')),

    el('div', { style: 'margin-top:14px' }, tabela({
      colunas: [
        { titulo: 'Data', conteudo: (r) => dataHora(r.criado_em) },
        { titulo: 'Valor transferido', dir: true, conteudo: (r) => el('span', {}, el('strong', {}, dinheiro(r.valor_liquido_centavos)),
          r.taxa_centavos ? el('span', { class: 'sub' }, `tarifa do PIX ${dinheiro(r.taxa_centavos)}`) : null) },
        { titulo: 'Como', conteudo: (r) => (r.meio === 'rateio'
          ? el('span', {}, 'Crédito do banco', el('span', { class: 'sub' }, `rateio · boleto ${r.nosso_numero ?? ''}`))
          : el('span', {}, 'PIX', el('span', { class: 'sub' }, r.pix_chave ?? `banco ${r.destino_banco} · ag. ${r.destino_agencia} · conta ${r.destino_conta}`))) },
        { titulo: 'Situação', conteudo: (r) => el('span', {}, selo(r.situacao, R.situacaoRepasse),
          r.meio === 'rateio' ? null : r.end_to_end ? el('span', { class: 'sub num' }, r.end_to_end) : r.erro ? el('span', { class: 'sub' }, `${r.erro} — nova tentativa automática`) : null) },
        { titulo: 'Na sua conta', conteudo: (r) => (r.meio === 'rateio'
          ? el('span', {}, data(r.confirmado_em), el('span', { class: 'sub' }, 'crédito do Bradesco'))
          : r.confirmado_em ? dataHora(r.confirmado_em) : '—') },
      ],
      itens: d.itens,
      vazio: 'Nenhuma transferência ainda. Elas aparecem aqui assim que o primeiro pagamento for creditado.',
      rodape: paginacao(d, (p) => ir(`#/repasses${qs({ pagina: p })}`)),
    })),
  );
}
