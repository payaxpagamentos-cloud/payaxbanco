import { api } from '../api.js';
import { el, limpar, cabecalho, painel, tabela, dataHora, desde, carregar, stat, faixa, dinheiro, numero, etq, botao } from '../ui.js';

/**
 * O custo do WhatsApp para a gestão.
 *
 * A conta é feita no ZOE Atende; aqui ela aparece ao lado do resto da operação. A pergunta que a
 * tela responde, de cima para baixo: quanto vai custar este mês, quanto deixamos de gastar, e a
 * fatura da Meta bateu com a nossa conta?
 */

const SITUACOES = {
  sem_teto: ['Sem teto definido', 'neutra'],
  ok: ['Dentro do orçamento', 'ok'],
  atencao: ['Passou da metade', 'info'],
  critico: ['Perto do teto', 'aviso'],
  estourado: ['Teto atingido', 'erro'],
};

const mes = (m) => {
  const nomes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  return `${nomes[Number(String(m).slice(5, 7)) - 1] ?? m} de ${String(m).slice(0, 4)}`;
};

export default async function custos({ alvo }) {
  limpar(alvo, cabecalho({
    sobretitulo: 'Operação',
    titulo: 'Custo do WhatsApp',
    descricao: 'O que a Meta cobra por mensagem, o que a régua deixou de gastar e se a fatura bateu com a nossa conta. '
      + 'Os números são lidos do ZOE Atende pela integração.',
  }), el('div', { id: 'corpo-custos' }));

  const corpo = alvo.querySelector('#corpo-custos');
  await carregar(corpo, () => api.get('/custos/whatsapp?meses=12'), (d) => {
    if (!d.estado) {
      return painel(null, el('div', {},
        faixa('Nenhum dado lido ainda. Ligue a integração com o ZOE Atende em Sistema › Integrações: informe o endereço e a chave de API da empresa.', 'info', 'plugue'),
        el('p', { class: 'fraco' }, 'A leitura acontece sozinha a cada 15 minutos depois de configurada.')));
    }

    const e = d.estado;
    const [rotuloSit, tipoSit] = SITUACOES[e.situacao] ?? SITUACOES.sem_teto;
    const a = d.acumulado;
    const economiaPct = a.sem_otimizacao_centavos ? (a.economia_centavos / a.sem_otimizacao_centavos) * 100 : 0;

    return el('div', {},
      e.situacao === 'estourado'
        ? faixa('O orçamento do mês foi atingido. No ZOE Atende, até virar o mês só sai mensagem grátis — '
          + 'o atendimento continua normal, as cobranças por template esperam.', 'aviso', 'alerta')
        : null,
      a.divergentes
        ? faixa(`${a.divergentes} mês(es) com a fatura da Meta divergindo da conta do sistema em mais de 5%. `
          + 'Vale conferir o preço cadastrado e se há mensagem saindo por fora.', 'erro', 'alerta')
        : null,

      el('div', { class: 'stats' },
        stat({ rotulo: 'Gasto no mês', valor: dinheiro(e.gasto_centavos), ic: 'dinheiro',
          nota: e.orcamento_centavos ? `de ${dinheiro(e.orcamento_centavos)} aprovados` : 'sem teto definido',
          notaTipo: e.situacao === 'estourado' ? 'erro' : '' }),
        stat({ rotulo: 'Projeção do mês', valor: dinheiro(e.projecao_centavos), ic: 'relogio',
          nota: e.projecao_estoura ? 'neste ritmo, estoura o teto' : 'neste ritmo, dentro do teto',
          notaTipo: e.projecao_estoura ? 'aviso' : 'ok' }),
        stat({ rotulo: 'Deixou de gastar no mês', valor: dinheiro(e.economia_centavos), ic: 'ok',
          nota: 'janela de 24 h, réguas que não dispararam e avisos que esperaram' }),
        stat({ rotulo: 'Esperando a janela', valor: numero(e.avisos_esperando), ic: 'relogio',
          nota: `${dinheiro(e.valor_em_risco_centavos)} em jogo · ${numero(e.avisos_salvos)} já salvos` })),

      painel('Orçamento', el('div', {},
        el('div', { class: 'linha-entre' },
          el('div', {}, el('strong', {}, dinheiro(e.gasto_centavos)),
            el('span', { class: 'fraco' }, e.orcamento_centavos ? ` de ${dinheiro(e.orcamento_centavos)}` : ' (sem teto)')),
          etq(rotuloSit, tipoSit)),
        e.orcamento_centavos
          ? el('div', { class: 'barra-custo' }, el('div', { class: `cheia ${tipoSit}`, style: `width:${Math.min(100, e.percentual)}%` }))
          : null,
        el('p', { class: 'fraco' },
          `${numero(e.percentual, 1)}% do orçamento usado. O teto é definido no ZOE Atende e vale para mensagem paga: `
          + 'atendimento e janela de 24 h nunca param.')),
        { rodape: el('span', { class: 'fraco' }, `Lido do ZOE Atende ${desde(e.atualizado_em)} · ${dataHora(e.atualizado_em)}`) }),

      painel(`Últimos ${a.meses} meses fechados`, el('div', {},
        el('div', { class: 'stats compactos' },
          stat({ rotulo: 'Pago à Meta', valor: dinheiro(a.gasto_centavos), ic: 'dinheiro' }),
          stat({ rotulo: 'Deixou de gastar', valor: dinheiro(a.economia_centavos), ic: 'ok',
            nota: `${numero(economiaPct, 0)}% do que seria a conta cheia` }),
          stat({ rotulo: 'Conferidos com a fatura', valor: `${a.conferidos}/${a.meses}`, ic: 'documento',
            nota: a.divergentes ? `${a.divergentes} divergente(s)` : 'sem divergência',
            notaTipo: a.divergentes ? 'erro' : 'ok' })),
        tabela([
          { titulo: 'Mês', valor: (m) => el('div', {}, el('div', { class: 'forte' }, mes(m.mes)),
            m.em_aberto ? el('div', { class: 'fraco' }, 'em aberto') : null) },
          { titulo: 'Mensagens', valor: (m) => numero(m.mensagens), classe: 'num' },
          { titulo: 'Nossa conta', valor: (m) => dinheiro(m.gasto_centavos), classe: 'num' },
          { titulo: 'Fatura da Meta', valor: (m) => (m.fatura_meta_centavos === null ? '—' : dinheiro(m.fatura_meta_centavos)), classe: 'num' },
          { titulo: 'Diferença', classe: 'num',
            valor: (m) => (m.diferenca_centavos === null ? '—'
              : el('strong', { class: m.divergente ? 'texto-erro' : 'texto-ok' },
                `${m.diferenca_centavos > 0 ? '+' : ''}${dinheiro(m.diferenca_centavos)}`)) },
          { titulo: 'Economia', valor: (m) => dinheiro(m.economia_centavos), classe: 'num' },
          { titulo: '', valor: (m) => (m.em_aberto ? etq('Em aberto', 'neutra')
            : m.fatura_meta_centavos === null ? etq('Não conferido', 'aviso')
              : m.divergente ? etq('Divergente', 'erro') : etq('Conferido', 'ok')) },
        ], d.meses, { vazioTexto: 'Nenhum mês lido ainda.' })),
        { rodape: el('span', { class: 'fraco' },
          'A fatura da Meta é lançada no ZOE Atende, em Mensagens ativas › Orçamento e fechamento. '
          + 'Diferença acima de 5% aparece como divergente.') }),

      painel('Preço por mensagem, por categoria da Meta',
        e.precos
          ? tabela([
            { titulo: 'Categoria', valor: (c) => c.nome },
            { titulo: 'Quando se aplica', valor: (c) => el('span', { class: 'fraco' }, c.quando) },
            { titulo: 'Preço', valor: (c) => (c.milesimos ? `R$ ${numero(c.milesimos / 1000, 3)}` : etq('Grátis', 'ok')), classe: 'num' },
          ], [
            { nome: 'Serviço', quando: 'o cliente falou primeiro e a resposta saiu em até 24 h', milesimos: e.precos.servico ?? 0 },
            { nome: 'Utilidade', quando: 'aviso sobre algo que o cliente já contratou (fatura, manutenção)', milesimos: e.precos.utilidade ?? 0 },
            { nome: 'Autenticação', quando: 'código de verificação', milesimos: e.precos.autenticacao ?? 0 },
            { nome: 'Marketing', quando: 'oferta, promoção ou reativação', milesimos: e.precos.marketing ?? 0 },
          ])
          : el('p', { class: 'fraco' }, 'Preços ainda não lidos.')),
    );
  });
}
