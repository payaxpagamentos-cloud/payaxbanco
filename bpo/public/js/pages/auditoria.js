import { api } from '../api.js';
import { html, $, dataHora, paginacao, debounce } from '../ui.js';

export default async function auditoria({ alvo, ativo }) {
  const filtros = { pagina: 1, acao: '' };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Auditoria</h1><p class="muted">Todas as ações da equipe, com usuário, empresa, data e IP.</p></div></div>
    <div class="card"><div class="filtros"><input class="busca" id="acao" placeholder="Filtrar por ação (ex.: baixa, extrato, empresa)"></div>
      <div class="table-wrap" id="tabela"></div><div id="pag"></div></div>`);
  const carregar = async () => {
    const r = await api.get('/auditoria', filtros);
    if (!ativo()) return;
    $('#tabela', alvo).innerHTML = String(html`<table><thead><tr><th>Data</th><th>Usuário</th><th>Empresa</th><th>Ação</th><th>Detalhes</th><th>IP</th></tr></thead><tbody>
      ${r.itens.length ? r.itens.map((a) => html`<tr><td class="small" style="white-space:nowrap">${dataHora(a.criado_em)}</td><td>${a.usuario_nome ?? '—'}</td>
        <td>${a.empresa_nome ?? '—'}</td><td><span class="badge info">${a.acao.replace(/_/g, ' ')}</span></td>
        <td class="small mono" style="max-width:420px;word-break:break-word">${a.detalhes}</td><td class="small">${a.ip ?? ''}</td></tr>`)
        : html`<tr><td colspan="6" class="vazio">Nenhum registro.</td></tr>`}</tbody></table>`);
    $('#pag', alvo).replaceChildren(paginacao(r, (p) => { filtros.pagina = p; carregar(); }));
  };
  $('#acao', alvo).addEventListener('input', debounce((e) => { filtros.acao = e.target.value; filtros.pagina = 1; carregar(); }));
  await carregar();
}
