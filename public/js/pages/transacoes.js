import { api } from '../api.js';
import { pode } from '../contexto.js';
import { html, $, $$, moedaSinal, dataHora, TIPO_TRANSACAO, paginacao, debounce, toast, icone } from '../ui.js';
import { estornar } from './contas.js';

export default async function transacoes({ alvo, ativo }) {
  const filtro = { q: '', tipo: '', inicio: '', fim: '', pagina: 1 };
  const gestor = pode('operacoes.estornar');
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Transações</h1><p class="muted">Todos os lançamentos do banco, com filtros por período e tipo.</p></div>
      ${gestor ? html`<button class="btn" id="exportar">${icone('baixar')} Exportar CSV</button>` : ''}</div>
    <div class="card"><div class="filtros">
      <div class="busca"><input type="search" id="q" placeholder="Buscar por cliente, conta ou descrição"></div>
      <div class="campo"><select id="tipo"><option value="">Todos os tipos</option>${Object.entries(TIPO_TRANSACAO).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
      <div class="campo" style="min-width:140px"><input type="date" id="inicio" title="Data inicial"></div>
      <div class="campo" style="min-width:140px"><input type="date" id="fim" title="Data final"></div>
    </div><div id="tabela"></div></div>`);
  async function carregar() {
    const r = await api.get('/transacoes', { ...filtro, limite: 25 });
    if (!ativo()) return;
    const t = $('#tabela', alvo);
    t.innerHTML = String(html`<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Data</th><th>Cliente / Conta</th><th>Tipo</th><th>Descrição</th><th class="num">Valor</th><th>Operador</th>${gestor ? html`<th></th>` : ''}</tr></thead><tbody>
      ${r.itens.length ? r.itens.map((x) => html`<tr>
        <td class="muted small">${x.id}</td><td class="small">${dataHora(x.criado_em)}</td>
        <td><a href="#/contas/${x.conta_id}">${x.cliente_nome}</a><div class="small muted mono">${x.agencia} / ${x.conta}</div></td>
        <td>${TIPO_TRANSACAO[x.tipo] ?? x.tipo} ${x.estornada_em ? html`<span class="badge warn">estornada</span>` : ''} ${x.canal === 'internet_banking' ? html`<span class="badge info">IB</span>` : ''}</td>
        <td class="small">${x.descricao ?? ''}</td><td class="num">${moedaSinal(x.valor_centavos)}</td><td class="small">${x.usuario_nome ?? '—'}</td>
        ${gestor ? html`<td class="right">${!x.estornada_em && !['estorno', 'pagamento'].includes(x.tipo) && !x.tipo.startsWith('emprestimo') && !(x.tipo.startsWith('pix_') && !x.contraparte_conta_id) ? html`<button class="btn sm" data-estornar="${x.id}">Estornar</button>` : ''}</td>` : ''}</tr>`)
        : html`<tr><td colspan="8" class="vazio">Nenhuma transação encontrada.</td></tr>`}</tbody></table></div>`);
    t.append(paginacao(r, (p) => { filtro.pagina = p; carregar(); }));
    $$('[data-estornar]', t).forEach((b) => b.addEventListener('click', () => estornar(r.itens.find((x) => String(x.id) === b.dataset.estornar), carregar)));
  }
  const mudar = (campo) => (e) => { filtro[campo] = e.target.value; filtro.pagina = 1; carregar(); };
  $('#q', alvo).addEventListener('input', debounce(mudar('q')));
  $('#tipo', alvo).addEventListener('change', mudar('tipo'));
  $('#inicio', alvo).addEventListener('change', mudar('inicio'));
  $('#fim', alvo).addEventListener('change', mudar('fim'));
  const exp = $('#exportar', alvo);
  if (exp) exp.onclick = () => api.baixar('/relatorios/transacoes.csv', { ...filtro, pagina: undefined }).catch((e) => toast(e.message, 'erro'));
  await carregar();
}
