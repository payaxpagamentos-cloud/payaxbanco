import { api } from '../api.js';
import { html, $, moeda, paginacao } from '../../../js/ui.js';
import { estado, carregarResumo, contaAtual, rotuloConta, listaLancamentos, ligarComprovantes } from '../comum.js';

const PERIODOS = [[7, '7 dias'], [30, '30 dias'], [90, '90 dias']];
const SENTIDOS = [['', 'Tudo'], ['entradas', 'Entradas'], ['saidas', 'Saídas']];

export default async function extrato(alvo) {
  if (!estado.resumo) await carregarResumo();
  const filtro = { dias: 30, sentido: '', pagina: 1 };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Extrato</h1><p class="muted" id="conta-rot"></p></div>
      ${estado.resumo.contas.length > 1 ? html`<select id="conta" style="width:auto">${estado.resumo.contas.map((c) => html`<option value="${c.id}" ${c.id === estado.contaId ? 'selected' : ''}>${rotuloConta(c)}</option>`)}</select>` : ''}</div>
    <div class="card">
      <div class="filtros" style="justify-content:space-between">
        <div class="chips" id="periodos">${PERIODOS.map(([d, r]) => html`<button class="chip ${d === 30 ? 'ativo' : ''}" data-dias="${d}">${r}</button>`)}</div>
        <div class="chips" id="sentidos">${SENTIDOS.map(([s, r]) => html`<button class="chip ${s === '' ? 'ativo' : ''}" data-sentido="${s}">${r}</button>`)}</div>
      </div>
      <div id="lista"></div>
    </div>`);
  async function carregar() {
    const c = contaAtual();
    $('#conta-rot', alvo).textContent = `${rotuloConta(c)} · saldo ${estado.ocultarSaldo ? '•••••' : moeda(c.saldo_centavos)}`;
    const inicio = new Date(Date.now() - filtro.dias * 86_400_000).toISOString().slice(0, 10);
    const r = await api.get(`/contas/${c.id}/extrato`, { inicio, sentido: filtro.sentido, pagina: filtro.pagina, limite: 30 });
    const lista = $('#lista', alvo);
    lista.innerHTML = String(listaLancamentos(r.itens, { agruparPorDia: true }));
    if (r.total > r.limite) lista.append(paginacao(r, (p) => { filtro.pagina = p; carregar(); }));
    ligarComprovantes(lista);
  }
  const marcar = (grupo, botao) => { grupo.querySelectorAll('.chip').forEach((b) => b.classList.toggle('ativo', b === botao)); };
  $('#periodos', alvo).addEventListener('click', (e) => { const b = e.target.closest('[data-dias]'); if (!b) return; marcar($('#periodos', alvo), b); filtro.dias = Number(b.dataset.dias); filtro.pagina = 1; carregar(); });
  $('#sentidos', alvo).addEventListener('click', (e) => { const b = e.target.closest('[data-sentido]'); if (!b) return; marcar($('#sentidos', alvo), b); filtro.sentido = b.dataset.sentido; filtro.pagina = 1; carregar(); });
  const sel = $('#conta', alvo);
  if (sel) sel.onchange = () => { estado.contaId = Number(sel.value); filtro.pagina = 1; carregar(); };
  await carregar();
}
