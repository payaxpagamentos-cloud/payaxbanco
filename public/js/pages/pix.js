import { api } from '../api.js';
import { semAlcada } from '../contexto.js';
import { html, $, $$, dataHora, confirmar, toast, debounce } from '../ui.js';
import { novaChavePix } from './contas.js';

export default async function pix({ alvo, ativo }) {
  let q = '';
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Chaves PIX</h1><p class="muted">Diretório interno de chaves PIX das contas PAY AX (máx. 5 por conta).</p></div>
      <button class="btn primario" id="nova" ${semAlcada('pix.chaves')}>+ Nova chave</button></div>
    <div class="card"><div class="filtros"><div class="busca"><input type="search" id="q" placeholder="Buscar por chave ou titular"></div></div><div id="tabela"></div></div>`);
  async function carregar() {
    const itens = await api.get('/pix', { q });
    if (!ativo()) return;
    $('#tabela', alvo).innerHTML = String(html`<div class="table-wrap"><table>
      <thead><tr><th>Tipo</th><th>Chave</th><th>Titular</th><th>Conta</th><th>Cadastro</th><th></th></tr></thead><tbody>
      ${itens.length ? itens.map((k) => html`<tr><td><span class="badge info">${k.tipo.toUpperCase()}</span></td><td class="mono" style="word-break:break-all">${k.chave}</td>
        <td>${k.cliente_nome}</td><td class="mono"><a href="#/contas/${k.conta_id}">${k.agencia} / ${k.numero}-${k.digito}</a></td><td class="small">${dataHora(k.criado_em)}</td>
        <td class="right"><button class="btn sm perigo" data-del="${k.id}">Remover</button></td></tr>`)
        : html`<tr><td colspan="6" class="vazio">Nenhuma chave encontrada.</td></tr>`}</tbody></table></div>`);
    $$('[data-del]', alvo).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmar('Remover chave PIX', 'Deseja remover esta chave PIX?', 'Remover'))) return;
      try { await api.del(`/pix/${b.dataset.del}`); toast('Chave removida.'); carregar(); } catch (e) { toast(e.message, 'erro'); }
    }));
  }
  $('#q', alvo).addEventListener('input', debounce((e) => { q = e.target.value; carregar(); }));
  $('#nova', alvo).onclick = () => novaChavePix(null, carregar);
  await carregar();
}
