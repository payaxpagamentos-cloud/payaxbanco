import { api } from '../api.js';
import { html, $, dataHora, paginacao, debounce } from '../ui.js';

const ENTIDADES = { cliente: 'Cliente', conta: 'Conta', transacao: 'Transação', chave_pix: 'Chave PIX', emprestimo: 'Empréstimo', usuario: 'Usuário' };
const LINK = { cliente: 'clientes', conta: 'contas', emprestimo: 'emprestimos' };

function detalhes(json) {
  if (!json) return '';
  try {
    return Object.entries(JSON.parse(json)).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
  } catch { return json; }
}

export default async function auditoria({ alvo, ativo }) {
  const filtro = { q: '', entidade: '', pagina: 1 };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Auditoria</h1><p class="muted">Trilha imutável de todas as ações realizadas no sistema.</p></div></div>
    <div class="card"><div class="filtros"><div class="busca"><input type="search" id="q" placeholder="Buscar por ação, usuário ou detalhe"></div>
      <div class="campo"><select id="ent"><option value="">Todas as entidades</option>${Object.entries(ENTIDADES).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div></div>
      <div id="tabela"></div></div>`);
  async function carregar() {
    const r = await api.get('/auditoria', { ...filtro, limite: 30 });
    if (!ativo()) return;
    const t = $('#tabela', alvo);
    t.innerHTML = String(html`<div class="table-wrap"><table>
      <thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Entidade</th><th>Detalhes</th><th>IP</th></tr></thead><tbody>
      ${r.itens.length ? r.itens.map((a) => html`<tr><td class="small">${dataHora(a.criado_em)}</td><td>${a.usuario_nome ?? '—'}</td>
        <td><span class="badge info">${a.acao.replace(/_/g, ' ')}</span></td>
        <td>${ENTIDADES[a.entidade] ?? a.entidade} ${a.entidade_id ? (LINK[a.entidade] ? html`<a href="#/${LINK[a.entidade]}/${a.entidade_id}">#${a.entidade_id}</a>` : `#${a.entidade_id}`) : ''}</td>
        <td class="small muted" style="max-width:420px;word-break:break-word">${detalhes(a.detalhes)}</td><td class="small mono">${a.ip ?? ''}</td></tr>`)
        : html`<tr><td colspan="6" class="vazio">Nenhum registro.</td></tr>`}</tbody></table></div>`);
    t.append(paginacao(r, (p) => { filtro.pagina = p; carregar(); }));
  }
  $('#q', alvo).addEventListener('input', debounce((e) => { filtro.q = e.target.value; filtro.pagina = 1; carregar(); }));
  $('#ent', alvo).addEventListener('change', (e) => { filtro.entidade = e.target.value; filtro.pagina = 1; carregar(); });
  await carregar();
}
