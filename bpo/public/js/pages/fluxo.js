import { api } from '../api.js';
import { html, raw, $, moeda, moedaCurta, data, rotuloMes, opcoes, toast, hoje, inicioMes, fimMes, somarMeses } from '../ui.js';

const COR = { entrada: '#1F8BFF', saida: '#19E3FF', previsto: 0.45, saldo: '#071A3C' };

/** Barras de entradas e saídas (cheias: realizado; claras: previsto) e linha do saldo final. */
function grafico(periodos, agrupar) {
  const W = 760, H = 260, M = { t: 14, r: 14, b: 30, l: 70 };
  const valores = periodos.flatMap((p) => [p.entradas_realizadas + p.entradas_previstas, p.saidas_realizadas + p.saidas_previstas, p.saldo_final, p.saldo_inicial]);
  const max = Math.max(1, ...valores);
  const min = Math.min(0, ...valores);
  const y = (v) => M.t + (H - M.t - M.b) * (1 - (v - min) / (max - min));
  const larg = (W - M.l - M.r) / periodos.length;
  const b = Math.max(2, Math.min(28, larg / 2 - 4));
  const passo = Math.ceil(periodos.length / 12);
  const grade = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = min + (max - min) * f;
    return `<line class="grade" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${M.l - 8}" y="${y(v) + 4}" text-anchor="end">R$ ${moedaCurta(v)}</text>`;
  }).join('');
  const rot = (p) => (agrupar === 'dia' ? `${p.periodo.slice(8, 10)}/${p.periodo.slice(5, 7)}` : rotuloMes(p.periodo));
  const barra = (x, base, valor, cor, opac) => (valor > 0 ? `<rect x="${x}" y="${y(base + valor)}" width="${b}" height="${y(base) - y(base + valor)}" fill="${cor}" fill-opacity="${opac}"/>` : '');
  const barras = periodos.map((p, i) => {
    const x = M.l + i * larg + larg / 2;
    const dica = `${rot(p)}: entradas ${moeda(p.entradas_realizadas)} + previstas ${moeda(p.entradas_previstas)} · saídas ${moeda(p.saidas_realizadas)} + previstas ${moeda(p.saidas_previstas)} · saldo ${moeda(p.saldo_final)}`;
    return `<g><title>${dica}</title>
      ${barra(x - b - 1, 0, p.entradas_realizadas, COR.entrada, 1)}${barra(x - b - 1, p.entradas_realizadas, p.entradas_previstas, COR.entrada, COR.previsto)}
      ${barra(x + 1, 0, p.saidas_realizadas, COR.saida, 1)}${barra(x + 1, p.saidas_realizadas, p.saidas_previstas, COR.saida, COR.previsto)}
      ${i % passo === 0 ? `<text x="${x}" y="${H - 9}" text-anchor="middle">${rot(p)}</text>` : ''}</g>`;
  }).join('');
  const linha = periodos.map((p, i) => `${i ? 'L' : 'M'}${M.l + i * larg + larg / 2},${y(p.saldo_final)}`).join(' ');
  const pontos = periodos.map((p, i) => `<circle cx="${M.l + i * larg + larg / 2}" cy="${y(p.saldo_final)}" r="3" fill="${COR.saldo}"/>`).join('');
  const zero = min < 0 ? `<line x1="${M.l}" x2="${W - M.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--danger)" stroke-dasharray="4 4"/>` : '';
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Fluxo de caixa">${grade}${zero}${barras}
    <path d="${linha}" fill="none" stroke="${COR.saldo}" stroke-width="2"/>${pontos}</svg>`);
}

export default async function fluxo({ alvo, ativo, base }) {
  const contas = (await api.get(`${base}/contas-bancarias`)).filter((c) => c.ativo);
  if (!ativo()) return;
  const dia = hoje();
  const filtros = { de: inicioMes(somarMeses(dia, -2)), ate: fimMes(somarMeses(dia, 3)), agrupar: 'mes', conta_bancaria_id: '' };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Fluxo de caixa</h1><p class="muted">Realizado pelas baixas nas contas; previsto pelas contas em aberto. Vencidos não pagos entram em hoje.</p></div></div>
    <div class="card"><div class="filtros">
      <div><label>De</label><input type="date" data-f="de" value="${filtros.de}"></div>
      <div><label>Até</label><input type="date" data-f="ate" value="${filtros.ate}"></div>
      <div><label>Agrupar</label><select data-f="agrupar"><option value="mes">Por mês</option><option value="dia">Por dia (até 92 dias)</option></select></div>
      <div><label>Conta</label><select data-f="conta_bancaria_id">${opcoes(contas, { rotulo: 'descricao', vazio: 'Todas (consolidado)' })}</select></div>
    </div></div>
    <div id="conteudo-fluxo"></div>`);

  const carregar = async () => {
    let f;
    try { f = await api.get(`${base}/fluxo-caixa`, filtros); } catch (err) { toast(err.message, 'erro'); return; }
    if (!ativo()) return;
    const ps = f.periodos;
    const rot = (p) => (f.agrupar === 'dia' ? data(p.periodo) : rotuloMes(p.periodo));
    const atual = (p) => (f.agrupar === 'dia' ? p.periodo === f.hoje : p.periodo === f.hoje.slice(0, 7));
    const linha = (rotulo, campo, classe = '', fmt = moeda) => html`<tr class="${classe}"><td>${rotulo}</td>${ps.map((p) => html`<td class="num">${fmt(p[campo])}</td>`)}</tr>`;
    const negativo = ps.find((p) => p.saldo_final < 0);
    $('#conteudo-fluxo', alvo).innerHTML = String(html`
      ${negativo ? html`<div class="card card-body" style="margin-top:16px;background:var(--danger-bg);border:0;color:var(--danger)"><strong>Atenção:</strong> o saldo projetado fica negativo em ${rot(negativo)} (${moeda(negativo.saldo_final)}).</div>` : ''}
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Entradas, saídas e saldo</h2>
        <div class="legenda"><span><i style="background:${COR.entrada}"></i>Entradas</span><span><i style="background:${COR.saida}"></i>Saídas</span>
          <span><i style="background:${COR.entrada};opacity:.45"></i>Previsto</span><span><i style="background:${COR.saldo};border-radius:50%"></i>Saldo final</span></div></div>
        <div class="card-body">${grafico(ps, f.agrupar)}</div></div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Demonstrativo</h2><span class="small muted">Saldo inicial em ${data(f.de)}: ${moeda(f.saldo_inicial)}</span></div>
        <div class="table-wrap"><table class="tabela-num"><thead><tr><th></th>${ps.map((p) => html`<th class="num" ${raw(atual(p) ? 'style="color:var(--azul-texto)"' : '')}>${rot(p)}</th>`)}</tr></thead><tbody>
          ${linha('Saldo inicial', 'saldo_inicial', 'subtotal')}
          ${linha('(+) Entradas realizadas', 'entradas_realizadas')}
          ${linha('(+) Entradas previstas', 'entradas_previstas')}
          ${linha('(−) Saídas realizadas', 'saidas_realizadas')}
          ${linha('(−) Saídas previstas', 'saidas_previstas')}
          ${linha('Vencidos lançados em hoje (líquido)', 'atrasados', 'cat')}
          ${linha('Resultado do período', 'resultado', 'subtotal')}
          <tr class="subtotal destaque"><td>Saldo final</td>${ps.map((p) => html`<td class="num ${p.saldo_final < 0 ? 'neg' : ''}">${moeda(p.saldo_final)}</td>`)}</tr>
        </tbody></table></div></div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Por categoria</h2><span class="small muted">Realizado + previsto; saídas negativas</span></div>
        <div class="table-wrap"><table class="tabela-num"><thead><tr><th>Categoria</th>${ps.map((p) => html`<th class="num">${rot(p)}</th>`)}<th class="num">Total</th></tr></thead><tbody>
          ${f.categorias.length ? f.categorias.map((c) => html`<tr><td>${c.nome}</td>${ps.map((p) => html`<td class="num ${c.valores[p.periodo] < 0 ? 'neg' : ''}">${c.valores[p.periodo] ? moeda(c.valores[p.periodo]) : '—'}</td>`)}
            <td class="num"><strong>${moeda(c.total)}</strong></td></tr>`) : html`<tr><td colspan="${ps.length + 2}" class="vazio">Sem movimentação no período.</td></tr>`}
        </tbody></table></div></div>`);
  };
  alvo.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => { filtros[el.dataset.f] = el.value; carregar(); }));
  await carregar();
}
