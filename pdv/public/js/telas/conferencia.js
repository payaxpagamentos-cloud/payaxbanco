import { api, baixar, qs } from '../api.js';
import {
  el, limpar, dinheiro, inteiro, campo, escolha, modal, perguntar, toast, acao, icone,
  FORMAS_CURTAS, STATUS_IXC, CONFERENCIA, etiqueta, etiquetaDe, dataBr, dataHora, hojeLocal, somarDias, documento,
} from '../ui.js';

/**
 * Conferência: o que o PDV recebeu no período × o que o IXC registrou.
 * Mostra o total por forma de pagamento, por operador e por maquininha, o que ainda falta baixar e as divergências.
 */
export async function telaConferencia(ctx) {
  const base = `/empresas/${ctx.empresaId}`;
  const filtros = { de: hojeLocal(), ate: hojeLocal() };
  const resumo = el('div', { class: 'coluna' });
  const divergencias = el('div', { class: 'cartao' });
  const detalhe = el('div', { class: 'cartao' });
  limpar(ctx.conteudo, el('div', { class: 'coluna' }, resumo, divergencias, detalhe));

  const faixa = (rotulo, valor, tipo = '', texto = null) => el('div', { class: `faixa ${tipo}` },
    el('div', { class: 'rotulo' }, rotulo), el('div', { class: 'valor' }, texto ?? dinheiro(valor)));

  async function carregar() {
    const dados = await api.get(`${base}/conferencia${qs(filtros)}`);
    const t = dados.totais;
    const botaoConferir = el('button', { class: 'btn primario' }, icone('conferencia'), 'Conferir com o IXC');
    botaoConferir.addEventListener('click', () => acao(botaoConferir, async () => {
      const r = await api.post(`${base}/conferencia/conferir`, { de: filtros.de, ate: filtros.ate, somente_pendentes: false });
      toast(r.divergentes ? `${r.conferidos} conferido(s) e ${r.divergentes} divergente(s).` : `${r.conferidos} recebimento(s) conferido(s) com o IXC.`, !!r.divergentes);
      await carregar();
    }));
    const botaoFila = el('button', { class: 'btn' }, icone('sincronizar'), 'Enviar baixas pendentes');
    botaoFila.addEventListener('click', () => acao(botaoFila, async () => {
      const r = await api.post(`${base}/conferencia/fila`, {});
      toast(`${r.baixados} baixa(s) feita(s) no IXC${r.erros ? `, ${r.erros} com erro` : ''}.`, !!r.erros);
      await carregar();
    }));

    limpar(resumo,
      el('div', { class: 'cartao' },
        el('div', { class: 'linha entre', style: 'flex-wrap:wrap;gap:8px' },
          el('div', { class: 'filtros livre', style: 'margin:0' },
            campo('De', { type: 'date', value: filtros.de, onchange: (e) => { filtros.de = e.target.value; carregar(); } }),
            campo('Até', { type: 'date', value: filtros.ate, onchange: (e) => { filtros.ate = e.target.value; carregar(); } }),
            el('div', { class: 'linha', style: 'gap:6px;align-items:flex-end' },
              el('button', { class: 'btn pequeno', onclick: () => { filtros.de = hojeLocal(); filtros.ate = hojeLocal(); carregar(); } }, 'Hoje'),
              el('button', { class: 'btn pequeno', onclick: () => { filtros.de = somarDias(hojeLocal(), -1); filtros.ate = filtros.de; carregar(); } }, 'Ontem'),
              el('button', { class: 'btn pequeno', onclick: () => { filtros.de = somarDias(hojeLocal(), -29); filtros.ate = hojeLocal(); carregar(); } }, '30 dias'))),
          el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' },
            el('button', { class: 'btn', onclick: () => baixar(`${base}/conferencia/exportar.csv${qs(filtros)}`, `conferencia-${filtros.de}.csv`) }, icone('baixar'), 'CSV'),
            ctx.supervisiona ? botaoFila : null, ctx.supervisiona ? botaoConferir : null)),
        el('div', { class: 'barra-conferencia', style: 'margin-top:14px' },
          faixa('Recebido no PDV', t.total_centavos, '', `${dinheiro(t.total_centavos)}`),
          faixa('Baixado no IXC', t.baixados_centavos, t.a_confirmar_centavos ? '' : 'ok'),
          faixa('Falta confirmar', t.a_confirmar_centavos, t.a_confirmar_centavos ? 'erro' : 'ok'),
          faixa('Sem fatura (avulso)', 0, '', inteiro(t.avulsos)),
          faixa('Cancelados', t.cancelados_centavos, t.cancelados ? 'aviso' : ''),
          faixa('Divergências abertas', 0, dados.divergencias_abertas ? 'erro' : 'ok', inteiro(dados.divergencias_abertas))),
        el('div', { class: 'barra-conferencia', style: 'margin-top:8px' },
          faixa('Recebimentos', 0, '', inteiro(t.recebimentos)),
          faixa('Conferidos', 0, 'ok', inteiro(t.conferidos)),
          faixa('Divergentes', 0, t.divergentes ? 'erro' : '', inteiro(t.divergentes)),
          faixa('Não conferidos', 0, t.nao_conferidos ? 'aviso' : '', inteiro(t.nao_conferidos)),
          faixa('Multa e juros', t.acrescimos_centavos),
          faixa('Descontos', t.descontos_centavos))),
      el('div', { class: 'grade' },
        quadro('Por forma de pagamento', dados.por_forma.map((f) => [FORMAS_CURTAS[f.forma] ?? f.forma, `${f.quantidade}×`, dinheiro(f.total_centavos)])),
        quadro('Por operador', dados.por_operador.map((o) => [o.nome, `${o.quantidade}×`, dinheiro(o.total_centavos)])),
        quadro('Por maquininha', dados.por_terminal.map((m) => [m.nome, `${m.quantidade}×`, dinheiro(m.total_centavos)])),
        quadro('Por dia', dados.por_dia.map((d) => [dataBr(d.data), `${d.quantidade}×`, dinheiro(d.total_centavos)]))));

    await Promise.all([carregarDivergencias(dados.tipos), carregarRecebimentos()]);
  }

  const quadro = (titulo, linhas) => el('div', { class: 'cartao' }, el('h2', {}, titulo),
    linhas.length ? el('table', { class: 'tabela' }, el('tbody', {}, linhas.map((l) => el('tr', {},
      el('td', {}, l[0]), el('td', { class: 'pequeno mudo' }, l[1]), el('td', { class: 'num dir' }, l[2])))))
      : el('p', { class: 'mudo' }, 'Nada no período.'));

  async function carregarDivergencias(tipos) {
    const { itens } = await api.get(`${base}/conferencia/divergencias${qs({ de: filtros.de, ate: filtros.ate, status: 'aberta' })}`);
    limpar(divergencias, el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, `Divergências em aberto (${itens.length})`),
      el('a', { class: 'pequeno mudo', href: '#', onclick: (e) => { e.preventDefault(); verResolvidas(tipos); } }, 'ver resolvidas')));
    if (!itens.length) return divergencias.append(el('p', { class: 'mudo' }, 'Tudo o que o PDV recebeu bate com o IXC neste período.'));
    divergencias.append(el('table', { class: 'tabela' },
      el('thead', {}, el('tr', {}, ['Data', 'O que aconteceu', 'Recebimento', 'PDV', 'IXC', ''].map((x) => el('th', {}, x)))),
      el('tbody', {}, itens.map((d) => el('tr', {},
        el('td', {}, dataBr(d.data)),
        el('td', {}, el('strong', {}, tipos[d.tipo] ?? d.tipo), el('div', { class: 'pequeno mudo' }, d.detalhes)),
        el('td', {}, d.recebimento_numero ? `#${d.recebimento_numero}` : '—', el('div', { class: 'pequeno mudo' }, d.cliente_nome ?? '')),
        el('td', { class: 'num dir' }, d.valor_pdv_centavos === null ? '—' : dinheiro(d.valor_pdv_centavos)),
        el('td', { class: 'num dir' }, d.valor_ixc_centavos === null ? '—' : dinheiro(d.valor_ixc_centavos)),
        el('td', { class: 'dir' }, ctx.supervisiona
          ? el('div', { class: 'linha', style: 'gap:6px;justify-content:flex-end' },
            el('button', { class: 'btn pequeno', onclick: () => resolver(d, 'resolvida') }, 'Resolver'),
            el('button', { class: 'btn pequeno', onclick: () => resolver(d, 'ignorada') }, 'Ignorar'))
          : null))))));
  }

  function resolver(d, status) {
    acao(null, async () => {
      const resolucao = await perguntar(status === 'resolvida' ? 'Resolver divergência' : 'Ignorar divergência', 'Explique o que foi feito (fica registrado)');
      if (!resolucao) return;
      await api.post(`${base}/conferencia/divergencias/${d.id}/resolver`, { status, resolucao });
      toast('Divergência encerrada.');
      await carregar();
    });
  }

  async function verResolvidas(tipos) {
    const { itens } = await api.get(`${base}/conferencia/divergencias${qs({ de: filtros.de, ate: filtros.ate, status: 'todas' })}`);
    await modal('Divergências do período', (fechar) => [
      el('table', { class: 'tabela' }, el('thead', {}, el('tr', {}, ['Data', 'Tipo', 'Situação', 'Explicação'].map((x) => el('th', {}, x)))),
        el('tbody', {}, itens.map((d) => el('tr', {},
          el('td', {}, dataBr(d.data)),
          el('td', {}, tipos[d.tipo] ?? d.tipo),
          el('td', {}, etiqueta(d.status, d.status === 'aberta' ? 'erro' : d.status === 'resolvida' ? 'ok' : '')),
          el('td', { class: 'pequeno' }, d.resolucao ?? d.detalhes, d.resolvido_em ? el('div', { class: 'mudo' }, `${d.resolvido_por_nome ?? ''} · ${dataHora(d.resolvido_em)}`) : null))))),
      el('div', { class: 'linha entre', style: 'margin-top:12px' }, el('button', { class: 'btn', onclick: () => fechar(null) }, 'Fechar')),
    ], { largo: true });
  }

  async function carregarRecebimentos() {
    const dados = await api.get(`${base}/conferencia/recebimentos${qs({ ...filtros, limite: 200 })}`);
    limpar(detalhe, el('h2', {}, 'Recebimentos do período'),
      dados.itens.length ? el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {}, ['Nº', 'Data', 'Cliente', 'Formas', 'Valor', 'Baixa no IXC', 'Conferência'].map((x) => el('th', {}, x)))),
        el('tbody', {}, dados.itens.map((x) => el('tr', {},
          el('td', {}, `#${x.numero}`),
          el('td', {}, dataBr(x.data)),
          el('td', {}, x.status === 'cancelado' ? el('s', {}, x.cliente_nome) : x.cliente_nome,
            el('div', { class: 'pequeno mudo' }, [documento(x.cliente_documento), x.operador_nome].filter(Boolean).join(' · '))),
          el('td', { class: 'pequeno' }, x.formas.map((f) => FORMAS_CURTAS[f] ?? f).join(' + ')),
          el('td', { class: 'num dir' }, dinheiro(x.valor_centavos)),
          el('td', {}, x.status === 'cancelado' ? etiqueta('Cancelado', '') : etiquetaDe(STATUS_IXC, x.ixc_status)),
          el('td', {}, etiquetaDe(CONFERENCIA, x.conferencia))))))
        : el('p', { class: 'mudo' }, 'Nenhum recebimento no período.'));
  }

  await carregar();
}
