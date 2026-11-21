/** Visão geral da rede: o que está no ar agora, o movimento dos últimos dias e o que precisa de atenção. */
import { api } from './api.js';
import { el, limpar, inteiro, dinheiro, duracao, icone, repetir, competenciaTexto } from './ui.js';
import { cartao, indicador, tabela, vazio } from './comum.js';
import { pizza, barras, CORES } from './graficos.js';

export async function visao(ctx) {
  const pintar = async () => {
    const d = await api.get('/painel/resumo');
    const tvs = d.telas;
    const alertas = d.alertas ?? [];

    const grade = el('div', { class: 'grade-dash' },
      el('div', { class: 'c3' }, indicador({
        rotulo: 'TVs no ar agora', valor: `${inteiro(tvs.online)} de ${inteiro(tvs.total)}`, ic: 'telas', cor: tvs.offline ? 'laranja' : 'verde',
        nota: tvs.offline ? `${tvs.offline} sem contato${tvs.sem_parear ? ` · ${tvs.sem_parear} a parear` : ''}` : (tvs.sem_parear ? `${tvs.sem_parear} aguardando pareamento` : 'Todas respondendo'),
      })),
      el('div', { class: 'c3' }, indicador({
        rotulo: 'Inserções hoje', valor: inteiro(d.hoje.insercoes), ic: 'tocar', cor: 'azul',
        nota: `${inteiro(d.hoje.insercoes_pagas)} de publicidade · ${duracao(d.hoje.segundos)} de tela`,
      })),
      el('div', { class: 'c3' }, indicador({
        rotulo: 'Campanhas no ar', valor: inteiro(d.campanhas.ativas), ic: 'campanhas', cor: 'roxo',
        nota: [d.campanhas.aguardando ? `${d.campanhas.aguardando} aguardando aprovação` : null, d.campanhas.pausadas ? `${d.campanhas.pausadas} pausadas` : null]
          .filter(Boolean).join(' · ') || 'Nada na fila',
      })),
      el('div', { class: 'c3' }, indicador({
        rotulo: `Receita prevista (${competenciaTexto(d.competencia)})`, valor: dinheiro(d.mes.receita_prevista_centavos), ic: 'dinheiro', cor: 'verde',
        nota: `${inteiro(d.mes.impactos)} impactos no mês · ${d.mes.anunciantes} anunciantes`,
      })),

      el('div', { class: 'c8' }, cartao('Inserções por dia (últimos 14 dias)',
        d.por_dia.length
          ? el('div', {},
            barras(d.por_dia.map((x) => ({ rotulo: x.data, valor: x.insercoes, titulo: `${new Date(`${x.data}T12:00:00`).toLocaleDateString('pt-BR')}: ${inteiro(x.insercoes)} inserções em ${x.telas} TVs` }))),
            el('div', { class: 'loop-legenda' },
              el('span', {}, new Date(`${d.por_dia[0].data}T12:00:00`).toLocaleDateString('pt-BR')),
              el('span', {}, new Date(`${d.por_dia.at(-1).data}T12:00:00`).toLocaleDateString('pt-BR'))))
          : vazio('Sem exibições registradas ainda.'))),

      el('div', { class: 'c4' }, cartao('Publicidade x institucional (hoje)',
        pizza([
          { rotulo: 'Publicidade', valor: d.hoje.insercoes_pagas, cor: CORES.roxo },
          { rotulo: 'Institucional', valor: Math.max(0, d.hoje.insercoes - d.hoje.insercoes_pagas), cor: CORES.cinza },
        ], { formato: inteiro, lado: true, vazio: 'Sem exibições hoje.', centro: { valor: inteiro(d.hoje.insercoes), rotulo: 'inserções' } }))),

      el('div', { class: 'c4' }, cartao('A rede',
        el('div', {},
          linha('Pontos ativos', inteiro(d.pontos.total)),
          linha('Cidades', inteiro(d.pontos.cidades)),
          linha('Público estimado por dia', inteiro(d.publico_dia)),
          linha('Criativos aguardando aprovação', inteiro(d.midias_pendentes)),
          linha('Faturas abertas', `${inteiro(d.faturas.abertas)} · ${dinheiro(d.faturas.aberto_centavos)}`),
          linha('Faturas atrasadas', inteiro(d.faturas.atrasadas)),
          linha('Repasses a pagar', `${inteiro(d.repasses.a_pagar)} · ${dinheiro(d.repasses.valor_centavos)}`)))),

      el('div', { class: 'c8' }, cartao(`Campanhas do mês (${competenciaTexto(d.competencia)})`, tabela([
        [(c) => el('div', {}, el('div', {}, c.campanha), el('div', { class: 'pequeno mudo' }, c.anunciante)), 'Campanha'],
        [(c) => inteiro(c.insercoes), 'Inserções', 'num dir'],
        [(c) => inteiro(c.impactos), 'Impactos', 'num dir'],
        [(c) => inteiro(c.telas), 'TVs', 'num dir'],
      ], d.top_campanhas, { vazioTexto: 'Nenhuma campanha exibida neste mês.' }))),

      el('div', { class: 'c6' }, cartao('Pontos que mais exibiram', tabela([
        [(p) => el('div', {}, el('div', {}, p.local), el('div', { class: 'pequeno mudo' }, `${p.cidade} · ${inteiro(p.publico_dia)} pessoas/dia`)), 'Ponto'],
        [(p) => inteiro(p.insercoes), 'Inserções', 'num dir'],
        [(p) => inteiro(p.impactos), 'Impactos', 'num dir'],
      ], d.top_pontos, { vazioTexto: 'Sem exibições no mês.' }))),

      el('div', { class: 'c6' }, cartao('Precisa de atenção',
        alertas.length
          ? el('div', { class: 'checagens' }, alertas.map((a) => el('div', { class: 'checagem falha' },
            el('span', { class: 'marca-ok' }, '!'), el('div', {}, el('strong', {}, a.nome), el('p', {}, a.detalhe)))))
          : el('p', { class: 'aviso ok' }, 'Tudo em ordem: TVs respondendo, campanhas com criativo aprovado e nada vencendo.'))),
    );
    limpar(ctx.conteudo, grade);
  };

  await pintar();
  ctx.parar(repetir(pintar, 60_000));
}

const linha = (rotulo, valor) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, rotulo), el('strong', { class: 'num' }, valor));
