/**
 * Relatório de veiculação — o "checking" que a agência pede todo mês.
 * Sai na mesma folha impressa da proposta: a marca, o que a campanha fez e a prova de exibição.
 * O PDF é o do navegador (Imprimir → Salvar como PDF); o CSV completo vai anexo quando pedem a prova inteira.
 */
import { api, qs, baixar } from './api.js';
import {
  el, icone, acao, modal, campo, escolha, lerForm, simbolo, toast,
  inteiro, duracao, dataBr, dataHora, diasTexto, faixaHorario, CATEGORIAS,
} from './ui.js';

const primeiroDoMes = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA');
const ultimoDoMes = (d = new Date()) => new Date(d.getFullYear(), d.getMonth() + 1, 0).toLocaleDateString('en-CA');
const mesPassado = () => { const d = new Date(); d.setMonth(d.getMonth() - 1, 1); return [primeiroDoMes(d), ultimoDoMes(d)]; };

/** Pergunta o período e abre a folha. */
export function relatorioDeVeiculacao(campanhaId, nomeCampanha) {
  const [dePassado, atePassado] = mesPassado();
  return modal(`Relatório de veiculação — ${nomeCampanha}`, (fechar) => {
    const ok = el('button', { class: 'btn primario largo' }, icone('relatorios'), 'Gerar relatório');
    const f = el('form', { class: 'form' },
      el('p', { class: 'mudo pequeno', style: 'margin:0' },
        'O período costuma ser o mês fechado — é o que a agência confere contra o PI.'),
      escolha('Período', 'atalho', { passado: 'Mês passado', atual: 'Mês atual', livre: 'Escolher as datas' }, 'passado'),
      el('div', { class: 'duas' },
        campo('De', { name: 'de', type: 'date', value: dePassado, required: true }),
        campo('Até', { name: 'ate', type: 'date', value: atePassado, required: true })),
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), ok));

    const [de, ate] = [f.querySelector('[name=de]'), f.querySelector('[name=ate]')];
    f.querySelector('[name=atalho]').addEventListener('change', (e) => {
      if (e.target.value === 'passado') [de.value, ate.value] = mesPassado();
      if (e.target.value === 'atual') [de.value, ate.value] = [primeiroDoMes(), ultimoDoMes()];
    });

    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(ok, async () => {
        const d = lerForm(f);
        const r = await api.get(`/painel/campanhas/${campanhaId}/veiculacao${qs({ de: d.de, ate: d.ate })}`);
        fechar();
        if (!r.resumo.insercoes) return toast('A campanha não teve exibição nesse período.', true);
        abrirFolhaVeiculacao(r);
      });
    });
    return [f];
  });
}

const bloco = (rotulo, valor, nota) => el('div', { class: 'bloco' },
  el('div', { class: 'valor' }, valor), el('div', { class: 'rotulo' }, rotulo), nota ? el('div', { class: 'nota' }, nota) : null);

function abrirFolhaVeiculacao(r) {
  const c = r.campanha;
  const fechar = () => { folha.remove(); document.body.style.overflow = ''; };
  const folha = el('div', { class: 'folha-proposta' },
    el('div', { class: 'acoes-folha' },
      el('button', { class: 'btn primario', onclick: () => window.print() }, icone('baixar'), 'Imprimir / salvar em PDF'),
      el('button', {
        class: 'btn', onclick: (e) => acao(e.target, () => baixar(
          `/painel/campanhas/${c.id}/veiculacao${qs({ de: r.periodo.de, ate: r.periodo.ate, csv: 1 })}`,
          `veiculacao-${r.periodo.de}-${r.periodo.ate}.csv`,
        )),
      }, icone('baixar'), 'Prova completa em CSV'),
      el('button', { class: 'btn', onclick: fechar }, 'Fechar')),

    el('article', { class: 'folha' },
      el('header', {},
        el('div', { class: 'marca-folha' }, el('span', { class: 'simbolo' }, simbolo()),
          el('div', {}, el('strong', {}, r.plataforma.nome.toUpperCase()), el('div', { class: 'slogan' }, r.plataforma.slogan))),
        el('div', { class: 'dir' },
          el('div', { class: 'titulo-doc' }, 'Relatório de veiculação'),
          el('div', { class: 'pequeno mudo' }, `${dataBr(r.periodo.de)} a ${dataBr(r.periodo.ate)}`))),

      el('h1', {}, c.nome),
      el('p', { class: 'para' }, c.anunciante, c.agencia ? ` · agência ${c.agencia}` : '', c.pi ? ` · PI ${c.pi}` : ''),
      el('p', { class: 'resumo' },
        `Veiculação de ${dataBr(c.inicio)}${c.fim ? ` a ${dataBr(c.fim)}` : ' em diante'}`
        + `${c.circuito ? `, no circuito ${c.circuito}` : ''}. ${diasTexto(c.dias_semana)}, ${faixaHorario(c.hora_inicio, c.hora_fim)}.`),

      el('h2', {}, 'O que foi ao ar no período'),
      el('div', { class: 'blocos' },
        bloco('Inserções', inteiro(r.resumo.insercoes), `${inteiro(r.resumo.dias)} dia(s) com exibição`),
        bloco('Tempo no ar', duracao(r.resumo.segundos), `${c.insercoes_hora} inserções/hora contratadas`),
        bloco('Telas', inteiro(r.resumo.telas), `em ${inteiro(r.resumo.pontos)} ponto(s)`),
        bloco('Pessoas alcançadas', inteiro(r.resumo.impactos), 'estimativa pelo fluxo de cada ponto')),

      el('h2', {}, 'Por ponto'),
      el('div', { class: 'rolagem' }, el('table', { class: 'tabela-folha' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Ponto'), el('th', {}, 'Ambiente'), el('th', {}, 'Cidade'),
          el('th', { class: 'dir' }, 'Telas'), el('th', { class: 'dir' }, 'Inserções'), el('th', { class: 'dir' }, 'Tempo'),
          el('th', { class: 'dir' }, 'Pessoas'))),
        el('tbody', {}, r.por_ponto.map((x) => el('tr', {},
          el('td', {}, x.local),
          el('td', {}, CATEGORIAS[x.categoria] ?? x.categoria),
          el('td', {}, `${x.cidade}/${x.uf}`),
          el('td', { class: 'dir num' }, inteiro(x.telas)),
          el('td', { class: 'dir num' }, inteiro(x.insercoes)),
          el('td', { class: 'dir num' }, duracao(x.segundos)),
          el('td', { class: 'dir num' }, inteiro(x.impactos))))),
        el('tfoot', {}, el('tr', {},
          el('td', { colspan: 3 }, 'Total'),
          el('td', { class: 'dir num' }, inteiro(r.resumo.telas)),
          el('td', { class: 'dir num' }, inteiro(r.resumo.insercoes)),
          el('td', { class: 'dir num' }, duracao(r.resumo.segundos)),
          el('td', { class: 'dir num' }, inteiro(r.resumo.impactos)))))),

      r.criativos.length
        ? el('div', {},
          el('h2', {}, 'Criativos exibidos'),
          el('div', { class: 'rolagem' }, el('table', { class: 'tabela-folha' },
            el('thead', {}, el('tr', {}, el('th', {}, 'Criativo'), el('th', {}, 'Tipo'), el('th', { class: 'dir' }, 'Inserções'), el('th', { class: 'dir' }, 'Tempo'))),
            el('tbody', {}, r.criativos.map((m) => el('tr', {},
              el('td', {}, m.nome), el('td', {}, m.tipo === 'video' ? 'Vídeo' : 'Imagem'),
              el('td', { class: 'dir num' }, inteiro(m.insercoes)), el('td', { class: 'dir num' }, duracao(m.segundos))))))))
        : null,

      el('h2', {}, 'Prova de exibição'),
      el('p', { class: 'resumo' },
        'Cada vez que o anúncio foi ao ar é registrada pela própria TV, com data, hora e tela. '
        + `Abaixo, as últimas ${r.amostra.length} de ${inteiro(r.resumo.insercoes)} inserções; a lista completa vai no arquivo em anexo.`),
      el('div', { class: 'rolagem' }, el('table', { class: 'tabela-folha' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Data e hora'), el('th', {}, 'Ponto'), el('th', {}, 'TV'), el('th', {}, 'Criativo'), el('th', { class: 'dir' }, 'Duração'))),
        el('tbody', {}, r.amostra.map((x) => el('tr', {},
          el('td', {}, dataHora(x.exibida_em)),
          el('td', {}, `${x.local} — ${x.cidade}/${x.uf}`),
          el('td', {}, x.tela),
          el('td', {}, x.midia ?? '—'),
          el('td', { class: 'dir num' }, `${x.duracao_s}s`)))))),

      el('footer', {}, `${r.plataforma.nome} · ${r.plataforma.slogan} · relatório gerado em ${dataBr(new Date().toLocaleDateString('en-CA'))}`)));

  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', function esc(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', esc);
    fechar();
  });
  document.body.append(folha);
}
