import { api } from '../api.js';
import { html, $, $$, opcoes, toast, confirmar, data } from '../ui.js';
import { TIPOS_DOC, enviarDocumento, tamanho, detalheLancamento } from './comum.js';

/** Notas, boletos, contratos e comprovantes da empresa (enviados pela equipe ou pelo cliente no Portal). */
export default async function documentos({ alvo, ativo, base }) {
  const filtros = { tipo: '' };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Documentos</h1><p class="muted">Arquivos da empresa. Para ligar um documento a um lançamento, anexe pelo próprio lançamento.</p></div>
      <button class="btn primario" id="enviar">+ Enviar documento</button></div>
    <div class="card"><div class="filtros"><select class="campo" id="tipo">${opcoes(TIPOS_DOC, { vazio: 'Todos os tipos' })}</select></div><div class="table-wrap" id="tabela"></div></div>`);
  const carregar = async () => {
    const lista = await api.get(`${base}/documentos`, filtros);
    if (!ativo()) return;
    $('#tabela', alvo).innerHTML = String(html`<table><thead><tr><th>Arquivo</th><th>Tipo</th><th>Lançamento</th><th>Enviado por</th><th>Data</th><th></th></tr></thead><tbody>
      ${lista.length ? lista.map((d) => html`<tr><td><strong>${d.nome}</strong><div class="small muted">${tamanho(d.tamanho)}${d.descricao ? ` · ${d.descricao}` : ''}</div></td>
        <td>${TIPOS_DOC.find((t) => t.id === d.tipo)?.nome}</td>
        <td>${d.lancamento_id ? html`<a href="#" data-lanc="${d.lancamento_id}">${d.lancamento_tipo === 'receber' ? 'Receber' : 'Pagar'} · ${d.lancamento_descricao}</a>` : html`<span class="muted">—</span>`}</td>
        <td>${d.responsavel_nome ? html`${d.responsavel_nome} <span class="badge info">Cliente</span>` : d.usuario_nome ?? '—'}</td><td>${data(d.criado_em)}</td>
        <td class="right" style="white-space:nowrap"><button class="btn sm" data-baixar="${d.id}">Baixar</button> <button class="btn sm perigo" data-excluir="${d.id}">Excluir</button></td></tr>`)
        : html`<tr><td colspan="6" class="vazio">Nenhum documento.</td></tr>`}</tbody></table>`);
    $$('[data-baixar]', alvo).forEach((b) => b.addEventListener('click', () => api.baixar(`${base}/documentos/${b.dataset.baixar}/arquivo`).catch((err) => toast(err.message, 'erro'))));
    $$('[data-lanc]', alvo).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); detalheLancamento(base, a.dataset.lanc).catch((err) => toast(err.message, 'erro')); }));
    $$('[data-excluir]', alvo).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmar('Excluir documento', 'O arquivo é apagado do armazenamento. A exclusão fica na auditoria.', 'Excluir'))) return;
      try { await api.del(`${base}/documentos/${b.dataset.excluir}`); toast('Documento excluído.'); carregar(); } catch (err) { toast(err.message, 'erro'); }
    }));
  };
  $('#tipo', alvo).addEventListener('change', (e) => { filtros.tipo = e.target.value; carregar(); });
  $('#enviar', alvo).addEventListener('click', () => enviarDocumento(`${base}/documentos`, { tipoPadrao: 'contrato', aoEnviar: carregar }));
  await carregar();
}
