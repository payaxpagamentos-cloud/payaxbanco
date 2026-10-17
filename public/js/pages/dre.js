import { api } from '../api.js';
import { html, $, $$, moeda, pct, rotuloMes, opcoes, toast, hoje, somarMeses, fimMes } from '../ui.js';

export default async function dre({ alvo, ativo, base }) {
  const centros = (await api.get(`${base}/centros`)).filter((c) => c.ativo);
  if (!ativo()) return;
  const dia = hoje();
  const filtros = { de: `${dia.slice(0, 4)}-01-01`, ate: fimMes(dia), regime: 'competencia', centro_custo_id: '' };
  const atalhos = [
    ['ano', 'Ano atual', () => [`${dia.slice(0, 4)}-01-01`, fimMes(dia)]],
    ['12m', 'Últimos 12 meses', () => [somarMeses(dia, -11), fimMes(dia)]],
    ['mes', 'Mês atual', () => [`${dia.slice(0, 7)}-01`, fimMes(dia)]],
    ['ant', 'Mês anterior', () => [somarMeses(dia, -1), fimMes(somarMeses(dia, -1))]],
  ];
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>DRE gerencial</h1><p class="muted">Demonstração do resultado pelas categorias do plano de contas. Clique em um grupo para ver as categorias.</p></div>
      <div class="row"><button class="btn" id="imprimir">Imprimir / PDF</button><button class="btn" id="csv">Exportar CSV</button></div></div>
    <div class="card"><div class="filtros">
      <div><label>De</label><input type="date" data-f="de" value="${filtros.de}"></div>
      <div><label>Até</label><input type="date" data-f="ate" value="${filtros.ate}"></div>
      <div><label>Regime</label><select data-f="regime"><option value="competencia">Competência</option><option value="caixa">Caixa (pela baixa)</option></select></div>
      <div><label>Centro de custo</label><select data-f="centro_custo_id">${opcoes(centros, { vazio: 'Todos' })}</select></div>
      <div style="align-self:end" class="chips">${atalhos.map(([k, r]) => html`<button class="chip" data-atalho="${k}">${r}</button>`)}</div>
    </div></div>
    <div id="conteudo-dre"></div>`);

  const carregar = async () => {
    let d;
    try { d = await api.get(`${base}/dre`, filtros); } catch (err) { toast(err.message, 'erro'); return; }
    if (!ativo()) return;
    const ind = d.indicadores;
    const sinalTexto = (l) => (l.tipo === 'grupo' ? (l.sinal < 0 ? '(−) ' : '(+) ') : '= ');
    const valor = (l, v) => {
      const n = l.tipo === 'grupo' ? l.sinal * v : v;
      return html`<span class="${n < 0 ? 'neg' : ''}">${v ? moeda(n) : '—'}</span>`;
    };
    const vertical = (v) => (ind.receita_bruta ? pct(v / ind.receita_bruta) : '—');
    $('#conteudo-dre', alvo).innerHTML = String(html`
      <div class="grid grid-4" style="margin-top:16px">
        <div class="card kpi azul"><div class="rotulo">Receita bruta</div><div class="valor">${moeda(ind.receita_bruta)}</div><div class="sub">${d.regime === 'caixa' ? 'Regime de caixa' : 'Regime de competência'}</div></div>
        <div class="card kpi"><div class="rotulo">Margem bruta</div><div class="valor">${ind.margem_bruta === null ? '—' : pct(ind.margem_bruta)}</div><div class="sub">Lucro bruto ÷ receita bruta</div></div>
        <div class="card kpi"><div class="rotulo">Margem operacional</div><div class="valor">${ind.margem_operacional === null ? '—' : pct(ind.margem_operacional)}</div><div class="sub">Resultado operacional ÷ receita bruta</div></div>
        <div class="card kpi ${ind.lucro_liquido < 0 ? 'vermelho' : 'verde'}"><div class="rotulo">Lucro líquido</div><div class="valor">${moeda(ind.lucro_liquido)}</div>
          <div class="sub">Margem líquida ${ind.margem_liquida === null ? '—' : pct(ind.margem_liquida)}</div></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="table-wrap"><table class="tabela-num"><thead><tr><th>Linha</th>${d.meses.map((m) => html`<th class="num">${rotuloMes(m)}</th>`)}<th class="num">Total</th><th class="num">AV %</th></tr></thead><tbody>
        ${d.linhas.map((l, i) => html`
          <tr class="${l.tipo === 'subtotal' ? `subtotal${l.destaque ? ' destaque' : ''}` : 'grupo'}" data-grupo="${i}">
            <td>${sinalTexto(l)}${l.rotulo}</td>${d.meses.map((m) => html`<td class="num">${valor(l, l.valores[m])}</td>`)}
            <td class="num"><strong>${valor(l, l.total)}</strong></td><td class="num small">${vertical(l.tipo === 'grupo' ? l.sinal * l.total : l.total)}</td></tr>
          ${(l.categorias ?? []).map((c) => html`<tr class="cat oculto" data-de="${i}"><td>${c.nome}</td>${d.meses.map((m) => html`<td class="num">${valor(l, c.valores[m])}</td>`)}
            <td class="num">${valor(l, c.total)}</td><td class="num small">${vertical(l.sinal * c.total)}</td></tr>`)}`)}
      </tbody></table></div></div>
      ${d.fora_dre.categorias.length ? html`<div class="card" style="margin-top:16px"><div class="card-head"><h2>Fora da DRE</h2><span class="small muted">Aportes, empréstimos, investimentos e distribuição de lucros: afetam o caixa, não o resultado</span></div>
        <div class="table-wrap"><table class="tabela-num"><thead><tr><th>Categoria</th>${d.meses.map((m) => html`<th class="num">${rotuloMes(m)}</th>`)}<th class="num">Total</th></tr></thead><tbody>
          ${d.fora_dre.categorias.map((c) => html`<tr><td>${c.nome}</td>${d.meses.map((m) => html`<td class="num ${c.valores[m] < 0 ? 'neg' : ''}">${c.valores[m] ? moeda(c.valores[m]) : '—'}</td>`)}<td class="num"><strong>${moeda(c.total)}</strong></td></tr>`)}
        </tbody></table></div></div>` : ''}
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Resultado por centro de custo</h2><span class="small muted">Departamentos, unidades ou projetos, com os rateios aplicados</span></div>
        <div class="table-wrap" id="centros-res"><div class="carregando">Carregando…</div></div></div>`);
    api.get(`${base}/resultado-centros`, { de: filtros.de, ate: filtros.ate, regime: filtros.regime }).then((r) => {
      if (!ativo()) return;
      $('#centros-res', alvo).innerHTML = String(html`<table class="tabela-num"><thead><tr><th>Centro de custo</th><th class="num">Receitas</th><th class="num">Despesas</th><th class="num">Resultado</th><th class="num">Margem</th></tr></thead><tbody>
        ${r.linhas.length ? r.linhas.map((c) => html`<tr><td>${c.nome}</td><td class="num">${moeda(c.receitas_centavos)}</td><td class="num">${moeda(c.despesas_centavos)}</td>
          <td class="num ${c.resultado_centavos < 0 ? 'neg' : ''}"><strong>${moeda(c.resultado_centavos)}</strong></td><td class="num">${c.receitas_centavos ? pct(c.resultado_centavos / c.receitas_centavos) : '—'}</td></tr>`)
          : html`<tr><td colspan="5" class="vazio">Sem lançamentos no período.</td></tr>`}</tbody></table>`);
    }).catch(() => {});
    $$('tr.grupo', alvo).forEach((tr) => tr.addEventListener('click', () => {
      tr.classList.toggle('aberto');
      $$(`tr[data-de="${tr.dataset.grupo}"]`, alvo).forEach((c) => c.classList.toggle('oculto', !tr.classList.contains('aberto')));
    }));
  };
  $$('[data-f]', alvo).forEach((el) => el.addEventListener('change', () => { filtros[el.dataset.f] = el.value; carregar(); }));
  $$('[data-atalho]', alvo).forEach((b) => b.addEventListener('click', () => {
    [filtros.de, filtros.ate] = atalhos.find(([k]) => k === b.dataset.atalho)[2]();
    $('[data-f=de]', alvo).value = filtros.de;
    $('[data-f=ate]', alvo).value = filtros.ate;
    carregar();
  }));
  $('#imprimir', alvo).addEventListener('click', () => { $$('tr.grupo', alvo).forEach((tr) => { tr.classList.add('aberto'); $$(`tr[data-de="${tr.dataset.grupo}"]`, alvo).forEach((c) => c.classList.remove('oculto')); }); window.print(); });
  $('#csv', alvo).addEventListener('click', () => api.baixar(`${base}/dre.csv`, filtros).catch((err) => toast(err.message, 'erro')));
  await carregar();
}
