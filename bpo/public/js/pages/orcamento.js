import { api } from '../api.js';
import { html, $, $$, moeda, pct, rotuloMes, toast, modal, dadosForm, centavos, valorMoedaInput, hoje, mascaraMoeda } from '../ui.js';

/** Orçamento por categoria e mês e comparação com o realizado (competência). */
export default async function orcamento({ alvo, ativo, base }) {
  const anoAtual = Number(hoje().slice(0, 4));
  const estado = { ano: anoAtual, aba: 'comparativo' };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Orçamento × realizado</h1><p class="muted">Metas mensais por categoria comparadas com o realizado pela competência.</p></div>
      <div class="row"><select id="ano" class="campo" style="width:auto">${[anoAtual - 1, anoAtual, anoAtual + 1].map((a) => html`<option ${a === anoAtual ? 'selected' : ''}>${a}</option>`)}</select>
        <button class="btn" id="sugerir">Sugerir pela média</button></div></div>
    <div class="tabs"><button data-aba="comparativo" class="ativo">Comparativo</button><button data-aba="editar">Editar orçamento</button></div>
    <div id="orc"></div>`);

  const carregar = async () => {
    const o = await api.get(`${base}/orcamento`, { ano: estado.ano });
    if (!ativo()) return;
    const ate = estado.ano < anoAtual ? 12 : estado.ano > anoAtual ? 0 : Number(hoje().slice(5, 7));
    const ytd = (l, campo) => l.valores.slice(0, ate).reduce((a, x) => a + x[campo], 0);
    if (estado.aba === 'comparativo') {
      const linha = (l) => {
        const orc = ytd(l, 'orcado');
        const real = ytd(l, 'realizado');
        const variacao = real - orc;
        const ruim = l.tipo === 'despesa' ? variacao > 0 : variacao < 0;
        return html`<tr><td>${l.nome}</td><td class="num">${moeda(orc)}</td><td class="num">${moeda(real)}</td>
          <td class="num ${orc || real ? (ruim ? 'var-ruim' : 'var-boa') : ''}">${variacao > 0 ? '+' : ''}${moeda(variacao)}</td>
          <td class="num">${orc ? pct(real / orc) : '—'}</td><td class="num muted">${moeda(l.orcado)}</td></tr>`;
      };
      const bloco = (tipo, titulo) => {
        const ls = o.linhas.filter((l) => l.tipo === tipo && (l.orcado || l.realizado));
        const to = ls.reduce((a, l) => a + ytd(l, 'orcado'), 0);
        const tr = ls.reduce((a, l) => a + ytd(l, 'realizado'), 0);
        return html`<tr class="subtotal"><td>${titulo}</td><td class="num">${moeda(to)}</td><td class="num">${moeda(tr)}</td><td class="num">${moeda(tr - to)}</td><td class="num">${to ? pct(tr / to) : '—'}</td><td></td></tr>
          ${ls.length ? ls.map(linha) : html`<tr><td colspan="6" class="muted small">Sem orçamento nem realizado.</td></tr>`}`;
      };
      const rec = o.linhas.filter((l) => l.tipo === 'receita');
      const des = o.linhas.filter((l) => l.tipo === 'despesa');
      const res = (campo) => rec.reduce((a, l) => a + ytd(l, campo), 0) - des.reduce((a, l) => a + ytd(l, campo), 0);
      $('#orc', alvo).innerHTML = String(html`
        <div class="grid grid-3"><div class="card kpi azul"><div class="rotulo">Resultado orçado ${ate ? `(jan–${rotuloMes(`${estado.ano}-${String(ate).padStart(2, '0')}`).slice(0, 3)})` : ''}</div><div class="valor">${moeda(res('orcado'))}</div></div>
          <div class="card kpi ${res('realizado') >= res('orcado') ? 'verde' : 'vermelho'}"><div class="rotulo">Resultado realizado</div><div class="valor">${moeda(res('realizado'))}</div></div>
          <div class="card kpi"><div class="rotulo">Diferença</div><div class="valor">${moeda(res('realizado') - res('orcado'))}</div><div class="sub">Itens fora da DRE não entram</div></div></div>
        <div class="card" style="margin-top:16px"><div class="table-wrap"><table class="tabela-num orc"><thead><tr><th>Categoria</th><th class="num">Orçado no período</th><th class="num">Realizado</th>
          <th class="num">Variação</th><th class="num">% atingido</th><th class="num">Orçado no ano</th></tr></thead><tbody>
          ${bloco('receita', 'Receitas')}${bloco('despesa', 'Despesas')}</tbody></table></div>
          <div class="card-body small muted">Período: de janeiro até o mês atual (ano corrente) ou o ano inteiro (anos passados). Em vermelho: receita abaixo ou despesa acima do orçado.</div></div>`);
    } else {
      $('#orc', alvo).innerHTML = String(html`<div class="card"><div class="card-head"><h2>Valores mensais (R$)</h2><button class="btn primario" id="salvar">Salvar orçamento</button></div>
        <div class="table-wrap"><table class="tabela-num orc"><thead><tr><th>Categoria</th>${o.meses.map((m) => html`<th class="num">${rotuloMes(m)}</th>`)}<th class="num">Ano</th></tr></thead><tbody>
          ${['receita', 'despesa'].map((tipo) => html`<tr class="subtotal"><td colspan="14">${tipo === 'receita' ? 'Receitas' : 'Despesas'}</td></tr>
            ${o.linhas.filter((l) => l.tipo === tipo).map((l) => html`<tr data-cat="${l.id}"><td>${l.nome}<div class="small muted">média realizada: ${moeda(l.realizado / Math.max(1, ate))}</div></td>
              ${l.valores.map((x) => html`<td><input class="moeda" inputmode="numeric" data-mes="${x.mes}" value="${valorMoedaInput(x.orcado)}"></td>`)}
              <td class="num"><strong data-total>${moeda(l.orcado)}</strong></td></tr>`)}`)}
        </tbody></table></div>
        <div class="card-body small muted">Dica: Ctrl+Enter num campo copia o valor para os meses seguintes da mesma categoria.</div></div>`);
      $$('input.moeda', alvo).forEach(mascaraMoeda);
      $$('tr[data-cat]', alvo).forEach((tr) => {
        const somar = () => setTimeout(() => { $('[data-total]', tr).textContent = moeda($$('input', tr).reduce((a, i) => a + centavos(i.value), 0)); });
        tr.addEventListener('beforeinput', somar);
        tr.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('input')) {
            const inputs = $$('input', tr);
            inputs.slice(inputs.indexOf(e.target) + 1).forEach((i) => { i.value = e.target.value; });
            somar();
          }
        });
      });
      $('#salvar', alvo).addEventListener('click', async () => {
        const itens = $$('tr[data-cat]', alvo).flatMap((tr) => $$('input', tr).map((i) => ({ categoria_id: Number(tr.dataset.cat), mes: i.dataset.mes, valor_centavos: centavos(i.value) })));
        try { await api.put(`${base}/orcamento`, { itens }); toast('Orçamento salvo.'); } catch (err) { toast(err.message, 'erro'); }
      });
    }
  };
  $('#ano', alvo).addEventListener('change', (e) => { estado.ano = Number(e.target.value); carregar(); });
  $$('[data-aba]', alvo).forEach((b) => b.addEventListener('click', () => {
    estado.aba = b.dataset.aba;
    $$('[data-aba]', alvo).forEach((x) => x.classList.toggle('ativo', x === b));
    carregar();
  }));
  $('#sugerir', alvo).addEventListener('click', () => modal({
    titulo: `Sugerir orçamento de ${estado.ano}`,
    corpo: html`<p style="margin-top:0">Preenche todos os meses de ${estado.ano} com a média mensal realizada nos últimos 3 meses, por categoria, com o reajuste informado. Substitui os valores existentes dessas categorias.</p>
      <label>Reajuste (%)</label><input name="reajuste" type="number" step="0.1" value="0">`,
    rotuloEnviar: 'Preencher',
    aoEnviar: async (form, fechar) => {
      const r = await api.post(`${base}/orcamento/sugerir`, { ano: estado.ano, reajuste: Number(dadosForm(form).reajuste) });
      fechar(); toast(`${r.categorias} categoria(s) preenchida(s).`); carregar();
    },
  }));
  await carregar();
}
