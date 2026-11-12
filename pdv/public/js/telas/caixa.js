import { api, baixar, qs } from '../api.js';
import {
  el, limpar, dinheiro, centavos, reaisCampo, campo, escolha, area, formModal, modal, perguntar, confirmar, toast, acao, icone,
  FORMAS, FORMAS_CURTAS, STATUS_CAIXA, etiquetaDe, dataHora, hojeLocal, somarDias, dataBr,
} from '../ui.js';

const FORMAS_LISTA = Object.keys(FORMAS);

/** Caixa: o caixa aberto de quem está no balcão e o histórico de caixas da empresa. */
export async function telaCaixa(ctx) {
  const base = `/empresas/${ctx.empresaId}`;
  const filtros = { de: somarDias(hojeLocal(), -7), ate: hojeLocal(), status: '' };
  const meu = el('div');
  const lista = el('div', { class: 'cartao' });
  limpar(ctx.conteudo, el('div', { class: 'coluna' }, meu, lista));

  async function carregarMeu() {
    const { caixa } = await api.get(`${base}/caixa/meu`);
    limpar(meu, caixa ? painelCaixa(caixa) : semCaixa());
  }

  function semCaixa() {
    const abrir = el('button', { class: 'btn primario' }, 'Abrir caixa');
    abrir.addEventListener('click', () => acao(abrir, async () => {
      const { pdvs } = await api.get(`${base}/cadastros/pdvs`);
      const livres = pdvs.filter((p) => p.ativo && !p.caixa_aberto_id);
      if (!livres.length) return toast('Nenhum PDV livre para abrir o caixa.', true);
      await formModal('Abrir caixa', () => [
        escolha('PDV', 'pdv_id', Object.fromEntries(livres.map((p) => [p.id, `${p.nome} · ${p.loja_nome}`])), livres[0].id),
        campo('Fundo de troco (R$)', { name: 'fundo', inputmode: 'decimal', value: '0,00' }),
        campo('Observação', { name: 'observacao', maxlength: 300 }),
      ], async (d) => {
        await api.post(`${base}/caixa`, { pdv_id: Number(d.pdv_id), fundo_centavos: centavos(d.fundo) ?? 0, observacao: d.observacao });
        toast('Caixa aberto.');
        await carregar();
      }, { rotulo: 'Abrir' });
    }));
    return el('div', { class: 'cartao' }, el('h2', {}, 'Você não tem caixa aberto'),
      el('p', { class: 'mudo' }, 'Abra o caixa com o fundo de troco para começar a receber no balcão.'),
      ctx.opera ? abrir : el('p', { class: 'mudo' }, 'Seu perfil não abre caixa.'));
  }

  function painelCaixa(caixa) {
    const r = caixa.resumo;
    const c = el('div', { class: 'cartao' },
      el('div', { class: 'linha entre' },
        el('div', {}, el('h2', { style: 'margin-bottom:2px' }, `${caixa.pdv_nome} · ${caixa.loja_nome}`),
          el('div', { class: 'pequeno mudo' }, `Aberto em ${dataHora(caixa.aberto_em)} por ${caixa.operador_nome}`)),
        etiquetaDe(STATUS_CAIXA, caixa.status)),
      el('div', { class: 'barra-conferencia', style: 'margin:14px 0' },
        faixa('Dinheiro na gaveta', r.dinheiro_em_caixa_centavos, 'ok'),
        faixa('Recebido no caixa', r.recebido_centavos),
        faixa('Fundo de troco', caixa.fundo_centavos),
        faixa('Sangrias', r.sangrias_centavos, r.sangrias_centavos ? 'aviso' : ''),
        faixa('Suprimentos', r.suprimentos_centavos),
        faixa('Recebimentos', r.recebimentos, '', String(r.recebimentos))),
      el('div', { class: 'barra-conferencia' }, FORMAS_LISTA.map((f) => faixa(FORMAS_CURTAS[f], r.por_forma[f]))));

    const botoes = el('div', { class: 'linha', style: 'gap:8px;margin-top:14px;flex-wrap:wrap' });
    if (caixa.status === 'aberto') {
      botoes.append(
        el('button', { class: 'btn', onclick: () => movimentar(caixa, 'sangria') }, 'Sangria'),
        el('button', { class: 'btn', onclick: () => movimentar(caixa, 'suprimento') }, 'Suprimento'),
        el('button', { class: 'btn primario', onclick: () => fechar(caixa) }, 'Fechar caixa'));
    }
    c.append(botoes);

    if (caixa.movimentos.length) {
      c.append(el('h3', { style: 'margin-top:18px' }, 'Sangrias e suprimentos'),
        el('table', { class: 'tabela' }, el('tbody', {}, caixa.movimentos.map((m) => el('tr', {},
          el('td', {}, dataHora(m.criado_em)),
          el('td', {}, m.tipo === 'sangria' ? 'Sangria' : 'Suprimento'),
          el('td', {}, m.motivo ?? '—'),
          el('td', { class: 'dir num' }, `${m.tipo === 'sangria' ? '−' : '+'} ${dinheiro(m.valor_centavos)}`))))));
    }
    if (caixa.recebimentos.length) {
      c.append(el('h3', { style: 'margin-top:18px' }, 'Recebimentos deste caixa'),
        el('table', { class: 'tabela' }, el('tbody', {}, caixa.recebimentos.slice(0, 20).map((x) => el('tr', {},
          el('td', {}, `#${x.numero}`),
          el('td', {}, x.cliente_nome),
          el('td', {}, dataHora(x.criado_em)),
          el('td', { class: 'dir num' }, x.status === 'cancelado' ? el('s', {}, dinheiro(x.valor_centavos)) : dinheiro(x.valor_centavos)))))));
    }
    return c;
  }

  const faixa = (rotulo, valor, tipo = '', texto = null) => el('div', { class: `faixa ${tipo}` },
    el('div', { class: 'rotulo' }, rotulo), el('div', { class: 'valor' }, texto ?? dinheiro(valor)));

  function movimentar(caixa, tipo) {
    formModal(tipo === 'sangria' ? 'Sangria (retirada de dinheiro)' : 'Suprimento (reforço de troco)', () => [
      campo('Valor (R$)', { name: 'valor', inputmode: 'decimal', required: true }),
      campo('Motivo', { name: 'motivo', maxlength: 200, required: true }),
    ], async (d) => {
      await api.post(`${base}/caixa/${caixa.id}/movimentos`, { tipo, valor_centavos: centavos(d.valor), motivo: d.motivo });
      toast(tipo === 'sangria' ? 'Sangria registrada.' : 'Suprimento registrado.');
      await carregar();
    }, { rotulo: 'Registrar' });
  }

  function fechar(caixa) {
    const r = caixa.resumo;
    const esperado = { ...r.por_forma, dinheiro: r.dinheiro_em_caixa_centavos };
    formModal('Fechamento do caixa', (form) => {
      const total = el('p', { class: 'mudo' }, '');
      const atualizar = () => {
        const soma = FORMAS_LISTA.reduce((s, f) => s + (centavos(form.querySelector(`[name=${f}]`).value) ?? 0), 0);
        const esperadoTotal = FORMAS_LISTA.reduce((s, f) => s + esperado[f], 0);
        const dif = soma - esperadoTotal;
        total.textContent = `Contado ${dinheiro(soma)} · esperado ${dinheiro(esperadoTotal)} · diferença ${dinheiro(dif)}`;
        total.className = dif === 0 ? 'mudo' : 'aviso';
      };
      setTimeout(atualizar, 0);
      form.addEventListener('input', atualizar);
      return [
        el('p', { class: 'mudo' }, 'Conte o dinheiro da gaveta e confira os valores das outras formas de pagamento.'),
        el('div', { class: 'duas' }, FORMAS_LISTA.map((f) => campo(`${FORMAS_CURTAS[f]} (esperado ${dinheiro(esperado[f])})`,
          { name: f, inputmode: 'decimal', value: reaisCampo(esperado[f]) }))),
        total,
        area('Observação', { name: 'observacao', maxlength: 300, rows: 2 }),
      ];
    }, async (d) => {
      const contagem = Object.fromEntries(FORMAS_LISTA.map((f) => [f, centavos(d[f]) ?? 0]));
      const fechado = await api.post(`${base}/caixa/${caixa.id}/fechar`, { contagem, observacao: d.observacao });
      toast(fechado.diferenca_centavos === 0 ? 'Caixa fechado sem diferença.' : `Caixa fechado com diferença de ${dinheiro(fechado.diferenca_centavos)}.`,
        fechado.diferenca_centavos !== 0);
      await carregar();
    }, { rotulo: 'Fechar caixa', largo: true });
  }

  // ---------- Histórico ----------
  async function carregarLista() {
    const { caixas } = await api.get(`${base}/caixa${qs(filtros)}`);
    const corpo = el('tbody', {}, caixas.map((c) => el('tr', { class: 'clicavel', onclick: () => abrirDetalhe(c.id) },
      el('td', {}, dataBr(c.data), el('div', { class: 'pequeno mudo' }, `#${c.id}`)),
      el('td', {}, c.pdv_nome, el('div', { class: 'pequeno mudo' }, c.loja_nome)),
      el('td', {}, c.operador_nome),
      el('td', { class: 'num dir' }, dinheiro(c.resumo.recebido_centavos)),
      el('td', { class: 'num dir' }, dinheiro(c.resumo.dinheiro_em_caixa_centavos)),
      el('td', { class: 'num dir' }, c.diferenca_centavos === null ? '—'
        : el('span', { class: c.diferenca_centavos === 0 ? '' : 'aviso' }, dinheiro(c.diferenca_centavos))),
      el('td', { class: 'dir' }, etiquetaDe(STATUS_CAIXA, c.status)))));
    limpar(lista,
      el('div', { class: 'linha entre' }, el('h2', {}, 'Caixas'),
        el('button', { class: 'btn', onclick: () => baixar(`${base}/caixa/exportar.csv${qs(filtros)}`, `caixas-${filtros.de}.csv`) }, icone('baixar'), 'CSV')),
      el('div', { class: 'filtros livre' },
        campo('De', { type: 'date', value: filtros.de, onchange: (e) => { filtros.de = e.target.value; carregarLista(); } }),
        campo('Até', { type: 'date', value: filtros.ate, onchange: (e) => { filtros.ate = e.target.value; carregarLista(); } }),
        escolha('Situação', 'status', { '': 'Todas', aberto: 'Abertos', fechado: 'Fechados', conferido: 'Conferidos' }, filtros.status,
          { onchange: (e) => { filtros.status = e.target.value; carregarLista(); } })),
      caixas.length ? el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {}, ['Data', 'PDV', 'Operador', 'Recebido', 'Dinheiro', 'Diferença', ''].map((t) => el('th', {}, t)))), corpo)
        : el('p', { class: 'mudo' }, 'Nenhum caixa no período.'));
  }

  async function abrirDetalhe(id) {
    const c = await api.get(`${base}/caixa/${id}`);
    await modal(`Caixa ${c.id} · ${c.pdv_nome}`, (fecharModal) => {
      const partes = [painelCaixa(c)];
      if (c.contagem) {
        partes.push(el('h3', {}, 'Contagem do fechamento'), el('table', { class: 'tabela' }, el('tbody', {},
          FORMAS_LISTA.map((f) => el('tr', {}, el('td', {}, FORMAS_CURTAS[f]),
            el('td', { class: 'num dir' }, dinheiro(c.contagem.contado[f])),
            el('td', { class: 'num dir mudo' }, `esperado ${dinheiro(c.contagem.esperado[f])}`))))));
      }
      const acoes = el('div', { class: 'linha entre', style: 'margin-top:12px' }, el('button', { class: 'btn', onclick: () => fecharModal(null) }, 'Fechar'));
      if (ctx.supervisiona && c.status === 'fechado') {
        acoes.append(el('button', { class: 'btn', onclick: () => acao(null, async () => {
          const motivo = await perguntar('Reabrir caixa', 'Motivo da reabertura');
          if (!motivo) return;
          await api.post(`${base}/caixa/${c.id}/reabrir`, { motivo });
          toast('Caixa reaberto.');
          fecharModal(null);
          carregar();
        }) }, 'Reabrir'));
        acoes.append(el('button', { class: 'btn primario', onclick: () => acao(null, async () => {
          if (!await confirmar('Conferir caixa', 'Confirma que o dinheiro foi recolhido e os valores batem?')) return;
          await api.post(`${base}/caixa/${c.id}/conferir`, {});
          toast('Caixa conferido.');
          fecharModal(null);
          carregar();
        }) }, 'Marcar como conferido'));
      }
      partes.push(acoes);
      return partes;
    }, { largo: true });
  }

  async function carregar() {
    await Promise.all([carregarMeu(), carregarLista()]);
  }
  await carregar();
}
