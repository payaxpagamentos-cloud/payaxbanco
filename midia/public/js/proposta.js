/**
 * Proposta comercial a partir de um circuito do inventário.
 * Monta uma folha pronta para imprimir ou salvar em PDF (o navegador faz o PDF, sem biblioteca):
 * a marca, o que o cliente compra, o que vai ao ar, quanto custa e até quando o preço vale.
 */
import { api, qs } from './api.js';
import {
  el, icone, acao, modal, campo, escolha, area, lerForm, simbolo,
  inteiro, dinheiro, dataBr, percentual, CATEGORIAS,
} from './ui.js';

const PERIODOS = { 1: '1 mês', 3: '3 meses', 6: '6 meses', 12: '12 meses' };

/** Pergunta as condições comerciais e abre a folha da proposta. */
export async function gerarProposta(circuitoId, nomeCircuito) {
  const opcoes = await api.get('/painel/opcoes');
  return modal(`Proposta — ${nomeCircuito}`, (fechar) => {
    const ok = el('button', { class: 'btn primario largo' }, icone('relatorios'), 'Gerar proposta');
    const f = el('form', { class: 'form' },
      escolha('Cliente (opcional)', 'anunciante_id', { '': 'Proposta sem cliente definido', ...Object.fromEntries(opcoes.anunciantes.map((a) => [a.id, a.nome])) }, ''),
      el('div', { class: 'tres' },
        escolha('Período', 'meses', PERIODOS, '3'),
        campo('Desconto (%)', { name: 'desconto', type: 'number', min: 0, max: 50, step: '0.5', value: '0' }),
        campo('Proposta válida por (dias)', { name: 'validade_dias', type: 'number', min: 1, max: 180, value: '15' })),
      campo('Inserções por hora', { name: 'insercoes_hora', type: 'number', min: 1, max: 120, placeholder: 'o padrão do circuito' }),
      area('Observações (aparecem no fim da proposta)', { name: 'observacao', maxlength: 500 }, ''),
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), ok));

    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(ok, async () => {
        const d = lerForm(f);
        const p = await api.get(`/painel/circuitos/${circuitoId}/proposta${qs({
          anunciante_id: d.anunciante_id,
          meses: d.meses,
          desconto_percentual: Math.round(Number(String(d.desconto).replace(',', '.')) * 100) || 0,
          validade_dias: d.validade_dias,
          insercoes_hora: d.insercoes_hora,
        })}`);
        fechar();
        abrirFolha(p, d.observacao);
      });
    });
    return [f];
  });
}

const bloco = (rotulo, valor, nota) => el('div', { class: 'bloco' },
  el('div', { class: 'valor' }, valor), el('div', { class: 'rotulo' }, rotulo), nota ? el('div', { class: 'nota' }, nota) : null);

/** A folha em si: ocupa a tela inteira e é o único elemento que vai para a impressora. */
function abrirFolha(p, observacao) {
  const i = p.investimento;
  const vendido = p.veiculacao;
  const fechar = () => { folha.remove(); document.body.style.overflow = ''; };
  const folha = el('div', { class: 'folha-proposta' },
    el('div', { class: 'acoes-folha' },
      el('button', { class: 'btn primario', onclick: () => window.print() }, icone('baixar'), 'Imprimir / salvar em PDF'),
      el('button', { class: 'btn', onclick: fechar }, 'Fechar')),

    el('article', { class: 'folha' },
      el('header', {},
        el('div', { class: 'marca-folha' }, el('span', { class: 'simbolo' }, simbolo()),
          el('div', {}, el('strong', {}, p.plataforma.nome.toUpperCase()), el('div', { class: 'slogan' }, p.plataforma.slogan))),
        el('div', { class: 'dir' },
          el('div', { class: 'titulo-doc' }, 'Proposta comercial'),
          el('div', { class: 'pequeno mudo' }, `Emitida em ${dataBr(p.emitida_em)} · válida até ${dataBr(p.valida_ate)}`))),

      el('h1', {}, p.circuito.nome),
      p.anunciante
        ? el('p', { class: 'para' }, `Para ${p.anunciante.nome}`, p.anunciante.contato ? ` · a/c ${p.anunciante.contato}` : '')
        : null,
      p.circuito.descricao ? el('p', { class: 'resumo' }, p.circuito.descricao) : null,

      el('h2', {}, 'A rede que o seu anúncio alcança'),
      el('div', { class: 'blocos' },
        bloco('Telas', inteiro(p.circuito.telas), `${inteiro(p.circuito.paisagem)} deitadas · ${inteiro(p.circuito.retrato)} em pé`),
        bloco('Pontos', inteiro(p.circuito.pontos), `${inteiro(p.circuito.cidades)} cidade(s)`),
        bloco('Pessoas por mês', inteiro(p.circuito.publico_mes), `${inteiro(p.circuito.publico_dia)} por dia`),
        p.circuito.unidades ? bloco('Unidades atendidas', inteiro(p.circuito.unidades), 'apartamentos, salas e lojas') : null),

      el('h2', {}, 'O que vai ao ar'),
      el('div', { class: 'blocos' },
        bloco('Inserções por mês', inteiro(vendido.insercoes_mes), `${vendido.insercoes_hora} por hora em cada tela`),
        bloco('No período', inteiro(vendido.insercoes_periodo), `${i.meses} ${i.meses === 1 ? 'mês' : 'meses'}`),
        bloco('Pessoas alcançadas/mês', inteiro(vendido.impactos_mes), 'estimativa pelo fluxo de cada ponto'),
        bloco('Espaço na tela', percentual(vendido.share_percentual), `cada anúncio fica ${vendido.duracao_s}s no ar`)),

      el('h2', {}, 'Onde o anúncio passa'),
      el('table', { class: 'tabela-folha' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Ponto'), el('th', {}, 'Ambiente'), el('th', {}, 'Cidade'),
          el('th', { class: 'dir' }, 'Telas'), el('th', { class: 'dir' }, 'Pessoas/dia'), el('th', { class: 'dir' }, 'Inserções/mês'))),
        el('tbody', {}, p.pontos.map((x) => el('tr', {},
          el('td', {}, el('div', {}, x.nome), x.posicoes.length ? el('div', { class: 'pequeno mudo' }, x.posicoes.join(' · ')) : null),
          el('td', {}, CATEGORIAS[x.categoria] ?? x.categoria),
          el('td', {}, `${x.cidade}/${x.uf}`),
          el('td', { class: 'dir num' }, inteiro(x.telas)),
          el('td', { class: 'dir num' }, inteiro(x.publico_dia)),
          el('td', { class: 'dir num' }, inteiro(x.insercoes_mes))))),
        el('tfoot', {}, el('tr', {},
          el('td', { colspan: 3 }, 'Total'),
          el('td', { class: 'dir num' }, inteiro(p.circuito.telas)),
          el('td', { class: 'dir num' }, inteiro(p.circuito.publico_dia)),
          el('td', { class: 'dir num' }, inteiro(vendido.insercoes_mes))))),

      el('h2', {}, 'Investimento'),
      el('table', { class: 'tabela-folha investimento' },
        el('tbody', {},
          el('tr', {}, el('td', {}, 'Tabela mensal'), el('td', { class: 'dir num' }, dinheiro(i.tabela_mes_centavos))),
          i.desconto_percentual
            ? el('tr', {}, el('td', {}, `Desconto de ${percentual(i.desconto_percentual)}`),
              el('td', { class: 'dir num' }, `- ${dinheiro(i.tabela_mes_centavos - i.mes_centavos)}`))
            : null,
          el('tr', { class: 'forte' }, el('td', {}, 'Por mês'), el('td', { class: 'dir num' }, dinheiro(i.mes_centavos))),
          el('tr', { class: 'forte' }, el('td', {}, `Total do período (${i.meses} ${i.meses === 1 ? 'mês' : 'meses'})`),
            el('td', { class: 'dir num' }, dinheiro(i.total_centavos))),
          el('tr', {}, el('td', {}, 'Custo por mil pessoas alcançadas (CPM)'), el('td', { class: 'dir num' }, dinheiro(i.cpm_centavos))))),

      observacao ? el('div', { class: 'observacao' }, observacao) : null,

      el('h2', {}, 'Como funciona'),
      el('ul', { class: 'condicoes' },
        el('li', {}, 'O anúncio entra no carrossel das telas do circuito e se alterna com os demais anunciantes ao longo de todo o horário de funcionamento do ponto.'),
        el('li', {}, 'Criativos em imagem (JPG ou PNG) ou vídeo (MP4), na orientação da tela. A produção da peça pode ser feita pela nossa equipe.'),
        el('li', {}, 'Todo mês o anunciante recebe a prova de exibição: data, hora e tela de cada vez que o anúncio foi ao ar.'),
        el('li', {}, 'As pessoas alcançadas são uma estimativa do fluxo de cada ponto pela fatia de tempo de tela contratada, não uma medição individual.'),
        el('li', {}, `Proposta válida até ${dataBr(p.valida_ate)}. Faturamento mensal, com nota fiscal de serviço.`)),

      el('footer', {}, `${p.plataforma.nome} · ${p.plataforma.slogan}`)));

  // Enquanto a folha está aberta, o painel atrás não rola (e o Esc fecha).
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', function esc(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', esc);
    fechar();
  });
  document.body.append(folha);
  folha.scrollTop = 0;
}
