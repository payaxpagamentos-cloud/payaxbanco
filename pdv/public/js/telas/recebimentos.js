import { api, baixar, qs } from '../api.js';
import {
  el, limpar, dinheiro, campo, escolha, modal, perguntar, toast, acao, icone,
  FORMAS_CURTAS, STATUS_IXC, CONFERENCIA, ORIGENS, etiqueta, etiquetaDe, dataHora, dataBr, hojeLocal, somarDias, documento,
} from '../ui.js';

/** Tudo o que passou pelo PDV, com a situação da baixa no IXC e o comprovante de cada atendimento. */
export async function telaRecebimentos(ctx) {
  const base = `/empresas/${ctx.empresaId}`;
  const filtros = { de: somarDias(hojeLocal(), -7), ate: hojeLocal(), busca: '', ixc_status: '', status: '', origem: '', limite: 200 };
  const topo = el('div', { class: 'cartao' });
  const tabela = el('div', { class: 'cartao' });
  limpar(ctx.conteudo, el('div', { class: 'coluna' }, topo, tabela));

  async function carregar() {
    const dados = await api.get(`${base}/recebimentos${qs(filtros)}`);
    limpar(topo,
      el('div', { class: 'linha entre' },
        el('div', {}, el('h2', { style: 'margin:0' }, `${dados.quantidade} recebimento(s) · ${dinheiro(dados.total_centavos)}`),
          el('div', { class: 'pequeno mudo' }, dados.cancelados ? `${dados.cancelados} cancelado(s) no período` : 'Nenhum cancelamento no período')),
        el('button', { class: 'btn', onclick: () => baixar(`${base}/recebimentos/exportar.csv${qs(filtros)}`, `recebimentos-${filtros.de}.csv`) }, icone('baixar'), 'CSV')),
      el('div', { class: 'filtros livre' },
        campo('De', { type: 'date', value: filtros.de, onchange: (e) => { filtros.de = e.target.value; carregar(); } }),
        campo('Até', { type: 'date', value: filtros.ate, onchange: (e) => { filtros.ate = e.target.value; carregar(); } }),
        campo('Cliente, CPF/CNPJ ou nº', { value: filtros.busca, onchange: (e) => { filtros.busca = e.target.value; carregar(); } }),
        escolha('Baixa no IXC', 'ixc', { '': 'Todas', pendente: 'Aguardando', erro: 'Com erro', parcial: 'Parcial', baixado: 'Baixada', manual: 'Manual', avulso: 'Sem fatura' },
          filtros.ixc_status, { onchange: (e) => { filtros.ixc_status = e.target.value; carregar(); } }),
        escolha('Situação', 'status', { '': 'Todas', confirmado: 'Confirmados', cancelado: 'Cancelados' }, filtros.status,
          { onchange: (e) => { filtros.status = e.target.value; carregar(); } }),
        escolha('Origem', 'origem', { '': 'Balcão e tela do cliente', balcao: 'Balcão', autoatendimento: 'Tela do cliente' }, filtros.origem,
          { onchange: (e) => { filtros.origem = e.target.value; carregar(); } })));

    limpar(tabela, dados.itens.length ? el('table', { class: 'tabela' },
      el('thead', {}, el('tr', {}, ['Nº', 'Data', 'Cliente', 'Formas', 'Valor', 'Baixa no IXC', 'Conferência'].map((t) => el('th', {}, t)))),
      el('tbody', {}, dados.itens.map((x) => el('tr', { class: 'clicavel', onclick: () => abrir(x.id) },
        el('td', {}, `#${x.numero}`),
        el('td', {}, dataBr(x.data), el('div', { class: 'pequeno mudo' }, dataHora(x.criado_em).slice(-5))),
        el('td', {}, x.status === 'cancelado' ? el('s', {}, x.cliente_nome) : x.cliente_nome,
          el('div', { class: 'pequeno mudo' }, [documento(x.cliente_documento), x.origem === 'autoatendimento' ? 'Tela do cliente' : x.operador_nome].filter(Boolean).join(' · '))),
        el('td', { class: 'pequeno' }, x.formas.map((f) => FORMAS_CURTAS[f] ?? f).join(' + ')),
        el('td', { class: 'num dir' }, x.status === 'cancelado' ? el('s', {}, dinheiro(x.valor_centavos)) : dinheiro(x.valor_centavos)),
        el('td', {}, x.status === 'cancelado' ? etiqueta('Cancelado', '') : etiquetaDe(STATUS_IXC, x.ixc_status)),
        el('td', {}, etiquetaDe(CONFERENCIA, x.conferencia))))))
      : el('p', { class: 'mudo' }, 'Nenhum recebimento com esses filtros.'));
  }

  async function abrir(id) {
    const r = await api.get(`${base}/recebimentos/${id}`);
    await modal(`Recebimento ${r.numero}`, (fechar) => {
      const partes = [
        el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' },
          r.status === 'cancelado' ? etiqueta('Cancelado', 'erro') : etiqueta('Confirmado', 'ok'),
          etiquetaDe(STATUS_IXC, r.ixc_status), etiquetaDe(CONFERENCIA, r.conferencia)),
        el('p', { class: 'pequeno mudo' }, `${dataHora(r.criado_em)} · ${r.loja_nome}${r.pdv_nome ? ` · ${r.pdv_nome}` : ''} · ${r.operador_nome} · ${ORIGENS[r.origem] ?? 'Balcão'}`),
        el('h3', {}, r.cliente_nome),
        el('p', { class: 'pequeno mudo' }, [documento(r.cliente_documento), r.cliente_ixc_id ? `código ${r.cliente_ixc_id}` : null].filter(Boolean).join(' · ')),
        el('table', { class: 'tabela' }, el('thead', {}, el('tr', {}, ['Fatura', 'Vencimento', 'Valor', 'Multa/juros', 'Desconto', 'Total', 'Baixa'].map((t) => el('th', {}, t)))),
          el('tbody', {}, r.titulos.map((t) => el('tr', {},
            el('td', {}, t.fatura_ixc_id ? `Fatura ${t.fatura_ixc_id}` : (t.descricao ?? 'Avulso')),
            el('td', {}, t.vencimento ? dataBr(t.vencimento) : '—'),
            el('td', { class: 'num dir' }, dinheiro(t.valor_centavos)),
            el('td', { class: 'num dir' }, dinheiro(t.acrescimo_centavos)),
            el('td', { class: 'num dir' }, dinheiro(t.desconto_centavos)),
            el('td', { class: 'num dir' }, dinheiro(t.total_centavos)),
            el('td', {}, etiquetaDe(STATUS_IXC, t.ixc_status), t.ixc_erro ? el('div', { class: 'pequeno aviso' }, t.ixc_erro) : null,
              t.ixc_situacao ? el('div', { class: 'pequeno mudo' }, `IXC: ${t.ixc_situacao}${t.ixc_valor_centavos !== null ? ` · ${dinheiro(t.ixc_valor_centavos)}` : ''}`) : null))))),
        el('h3', { style: 'margin-top:14px' }, 'Pagamento'),
        el('table', { class: 'tabela' }, el('tbody', {}, r.pagamentos.map((p) => el('tr', {},
          el('td', {}, FORMAS_CURTAS[p.forma] + (p.parcelas > 1 ? ` ${p.parcelas}x` : ''),
            el('div', { class: 'pequeno mudo' }, [p.terminal_nome, p.bandeira, p.nsu ? `NSU ${p.nsu}` : null, p.autorizacao ? `aut. ${p.autorizacao}` : null,
              p.cartao_final ? `final ${p.cartao_final}` : null].filter(Boolean).join(' · '))),
          el('td', { class: 'num dir' }, dinheiro(p.valor_centavos)))))),
        el('div', { class: 'linha entre', style: 'margin-top:8px' }, el('strong', {}, 'Total'), el('strong', {}, dinheiro(r.valor_centavos))),
        r.troco_centavos ? el('div', { class: 'linha entre pequeno mudo' }, el('span', {}, 'Troco'), el('span', {}, dinheiro(r.troco_centavos))) : null,
        r.observacao ? el('p', { class: 'pequeno mudo' }, r.observacao) : null,
        r.status === 'cancelado' ? el('p', { class: 'aviso' }, `Cancelado por ${r.cancelado_por_nome} em ${dataHora(r.cancelado_em)}: ${r.motivo_cancelamento}`) : null,
        r.ixc_erro ? el('p', { class: 'aviso' }, `IXC: ${r.ixc_erro}`) : null,
        r.divergencias.length ? el('p', { class: 'aviso' }, `${r.divergencias.length} divergência(s) em aberto na conferência.`) : null,
      ];

      const acoes = el('div', { class: 'linha entre', style: 'margin-top:14px;flex-wrap:wrap;gap:8px' },
        el('button', { class: 'btn', onclick: () => fechar(null) }, 'Fechar'));
      const direita = el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' });
      direita.append(el('button', { class: 'btn', onclick: () => verComprovante(r) }, icone('imprimir'), 'Comprovante'));
      if (['pendente', 'erro', 'parcial'].includes(r.ixc_status) && r.status === 'confirmado') {
        direita.append(el('button', { class: 'btn', onclick: (e) => acao(e.target, async () => {
          const novo = await api.post(`${base}/recebimentos/${r.id}/baixa`, {});
          toast(novo.ixc_status === 'baixado' ? 'Baixado no IXC.' : `IXC: ${novo.ixc_erro ?? novo.ixc_status}`, novo.ixc_status !== 'baixado');
          fechar(null);
          carregar();
        }) }, icone('sincronizar'), 'Tentar baixa agora'));
        if (ctx.supervisiona) {
          direita.append(el('button', { class: 'btn', onclick: () => acao(null, async () => {
            const motivo = await perguntar('Baixa feita no IXC', 'Como a baixa foi feita? (fica registrado)');
            if (!motivo) return;
            await api.post(`${base}/recebimentos/${r.id}/baixa-manual`, { motivo });
            toast('Marcado como baixado no IXC.');
            fechar(null);
            carregar();
          }) }, 'Marcar baixa manual'));
        }
      }
      if (ctx.supervisiona && r.status === 'confirmado') {
        direita.append(el('button', { class: 'btn', onclick: () => acao(null, async () => {
          const conferido = await api.post(`${base}/recebimentos/${r.id}/conferir`, {});
          toast(conferido.conferencia === 'conferido' ? 'Confere com o IXC.' : 'A conferência encontrou divergência.', conferido.conferencia !== 'conferido');
          fechar(null);
          carregar();
        }) }, 'Conferir no IXC'));
        direita.append(el('button', { class: 'btn perigo', onclick: () => acao(null, async () => {
          const motivo = await perguntar('Cancelar recebimento', 'Motivo do cancelamento');
          if (!motivo) return;
          const cancelado = await api.post(`${base}/recebimentos/${r.id}/cancelar`, { motivo });
          toast(cancelado.aviso ?? 'Recebimento cancelado.', !!cancelado.aviso);
          fechar(null);
          carregar();
        }) }, 'Cancelar recebimento'));
      }
      acoes.append(direita);
      partes.push(acoes);
      return partes;
    }, { largo: true });
  }

  async function verComprovante(r) {
    const { texto } = await api.get(`${base}/recebimentos/${r.id}/comprovante`);
    await modal(`Comprovante ${r.numero}`, (fechar) => [
      el('pre', { class: 'comprovante' }, texto),
      el('div', { class: 'linha entre', style: 'margin-top:12px' },
        el('button', { class: 'btn', onclick: () => fechar(null) }, 'Fechar'),
        el('button', { class: 'btn primario', onclick: () => window.print() }, icone('imprimir'), 'Imprimir')),
    ], { largo: true });
  }

  await carregar();
}
