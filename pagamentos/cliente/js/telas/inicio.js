import { api, ir, pode } from '../app.js';
import { el, montar, cartao, tabela, dinheiro, numero, data, selo, icone, aviso, hojeIso, R } from '../../comum/ui.js';
import { barrasPorDia } from '../../comum/graficos.js';
import { cartaoConta, acoesRapidas, linhaTempo } from '../../comum/componentes.js';

/**
 * Tela inicial, no formato de banco: a conta primeiro, o que fazer logo em seguida,
 * e o movimento recente como linha do tempo — não como tabela.
 */
export default async function inicio({ alvo }) {
  const [d, extrato] = await Promise.all([
    api.get('/painel'),
    api.get('/conta/extrato?limite=120'),
  ]);
  const hoje = d.hoje ?? hojeIso();
  const l = d.liquidacoes;
  // O próximo crédito do banco: no dia em que cair, segue para a conta do cliente.
  const proximaLiberacao = d.agenda?.[0];

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, `Olá, ${d.cliente.nome_fantasia || d.cliente.razao_social}`),
        el('p', {}, d.cliente.situacao === 'ativo' ? 'Tudo certo com o seu cadastro.' : `Situação do cadastro: ${d.cliente.situacao}.`))),

    d.cliente.situacao !== 'ativo' ? aviso(`O seu cadastro está com situação "${d.cliente.situacao}". Fale com o seu gerente.`, 'aviso') : null,

    cartaoConta({ transferencias: d.transferencias, codigo: d.cliente.codigo }),

    proximaLiberacao
      ? el('div', { class: 'a-liberar' }, icone('relogio'),
        el('span', {}, 'Próximo crédito do banco: ', el('strong', {}, dinheiro(proximaLiberacao.valor_centavos)),
          ' — vai para a sua conta no mesmo dia'),
        el('span', { class: 'quando' }, data(proximaLiberacao.data)))
      : null,

    acoesRapidas([
      pode('boletos.emitir') ? { ic: 'boleto', titulo: 'Emitir boleto', descricao: 'Cobrar um cliente', href: '#/boletos?novo=1' } : null,
      pode('repasses.ver') ? { ic: 'pix', titulo: 'Transferências', descricao: 'O que foi para a sua conta', href: '#/repasses' } : null,
      { ic: 'lista', titulo: 'Extrato', descricao: 'Tudo que entrou e saiu', href: '#/extrato' },
      { ic: 'relatorio', titulo: 'Relatórios', descricao: 'Fechar o mês', href: '#/relatorios' },
    ]),

    el('div', { class: 'grade kpis', style: 'margin-top:18px' },
      kpiSimples('Boletos emitidos no mês', numero(d.boletos.emitidos), dinheiro(d.boletos.valor_emitido_centavos), 'boleto'),
      kpiSimples('Pagos', numero(d.boletos.liquidados), dinheiro(d.boletos.valor_liquidado_centavos), 'ok', 'positivo'),
      kpiSimples('A vencer', numero(d.boletos.a_vencer), 'aguardando pagamento', 'relogio'),
      kpiSimples('Vencidos em aberto', numero(d.vencidos.titulos), dinheiro(d.vencidos.valor_centavos), 'alerta', d.vencidos.titulos ? 'negativo' : '')),

    el('div', { class: 'grade duas', style: 'margin-top:18px' },
      cartao('Últimos movimentos',
        linhaTempo({
          lancamentos: [...extrato.itens].reverse(),
          hoje,
          limite: 6,
          aoAbrirBoleto: (id) => ir(`#/boletos/${id}`),
          vazio: 'Assim que alguém pagar um boleto seu, o movimento aparece aqui.',
        }),
        el('a', { class: 'botao sec', href: '#/extrato' }, icone('lista'), 'Ver o extrato completo')),

      el('div', { style: 'display:grid;gap:14px;align-content:start' },
        cartao('O que entrou por dia',
          barrasPorDia({ dados: d.serie.map((s) => ({ data: s.data, valor: s.bruto_centavos, titulos: s.titulos })), altura: 150 })),
        cartao('Próximos vencimentos', tabela({
          colunas: [
            { titulo: 'Vencimento', conteudo: (x) => data(x.vencimento) },
            { titulo: 'Títulos', dir: true, conteudo: (x) => numero(x.titulos) },
            { titulo: 'Valor', dir: true, conteudo: (x) => el('strong', {}, dinheiro(x.valor_centavos)) },
          ],
          itens: d.proximos_vencimentos.slice(0, 6),
          vazio: 'Nenhum boleto a vencer.',
          aoClicar: (x) => ir(`#/boletos?situacao=a_vencer&de=${x.vencimento}&ate=${x.vencimento}`),
        })))),

    l.bruto_centavos
      ? el('div', { style: 'margin-top:18px' }, cartao('O que a PAY AX cobrou no mês',
        el('div', { class: 'pares' },
          par('Você recebeu dos pagadores', dinheiro(l.bruto_centavos)),
          par('Tarifa bancária', dinheiro(l.tarifa_banco_centavos + l.tarifa_emissao_centavos)),
          par('Tarifa PAY AX', dinheiro(l.comissao_centavos)),
          par('Ficou para você', el('strong', {}, dinheiro(l.liquido_centavos))),
          par('Já transferido', dinheiro(l.repassado_centavos))),
        el('p', { style: 'margin-top:12px;color:var(--texto-3);font-size:12.5px' },
          `Sua tabela: ${d.preco.percentual_texto} sobre o valor pago (mínimo ${dinheiro(d.preco.comissao_minima_centavos)}) + ${dinheiro(d.preco.tarifa_liquidacao_centavos)} por título pago.`)))
      : null,
  );
}

const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));

const kpiSimples = (rotulo, valor, apoio, ic, tom = '') => el('div', { class: 'kpi' },
  el('div', { class: 'rotulo' }, icone(ic), rotulo),
  el('div', { class: `valor num${tom === 'positivo' ? ' positivo' : tom === 'negativo' ? ' negativo' : ''}` }, valor),
  el('div', { class: 'apoio' }, apoio));
