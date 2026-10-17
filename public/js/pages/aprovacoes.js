import { api } from '../api.js';
import { html, raw, $, $$, moeda, data, modal, dadosForm, toast, centavos, valorMoedaInput, confirmar } from '../ui.js';
import { gestor, usuarioAtual } from '../contexto.js';
import { APROVACAO, detalheLancamento } from './comum.js';

const ABAS = [['abertas', 'Em andamento'], ['aprovada', 'Aprovados'], ['recusada', 'Recusados']];

/**
 * Aprovação de pagamentos: conferência pela equipe e autorização por quem tem alçada (equipe ou
 * responsável da empresa, pelo Portal).
 */
export default async function aprovacoes({ alvo, ativo, base, empresa }) {
  let aba = 'abertas';
  const selecionados = new Set();
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Aprovação de pagamentos</h1><p class="muted">Solicitação → conferência pela equipe → autorização por quem tem alçada → pagamento.</p></div>
      ${gestor() ? html`<button class="btn" id="config">Regras de aprovação</button>` : ''}</div>
    <div id="regra"></div>
    <div class="tabs">${ABAS.map(([k, r]) => html`<button data-aba="${k}" class="${k === aba ? 'ativo' : ''}">${r}</button>`)}</div>
    <div class="card"><div class="table-wrap" id="tabela"></div></div>
    <div class="selecao-lote hidden" id="lote"><span id="lote-info"></span><div class="row"><button class="btn sm" id="lote-conferir">Conferir selecionados</button>
      <button class="btn sm ouro" id="lote-aprovar">Aprovar selecionados</button></div></div>`);

  const carregar = async () => {
    const r = await api.get(`${base}/aprovacoes`, { status: aba });
    if (!ativo()) return;
    const alcada = r.minha_alcada_centavos;
    const textoAlcada = alcada === -1 ? 'sem limite' : alcada === 0 ? 'você não aprova pagamentos (pode conferir)' : `até ${moeda(alcada)}`;
    $('#regra', alvo).innerHTML = String(html`<div class="card card-body" style="margin-bottom:16px;box-shadow:none;background:${r.config.aprovacao_ativa ? 'var(--info-bg)' : 'var(--warn-bg)'};border:0">
      ${r.config.aprovacao_ativa ? html`<strong>Aprovação ativa</strong> para pagamentos acima de ${moeda(r.config.aprovacao_acima_centavos)}. Sua alçada: ${textoAlcada}. Quem lançou não aprova o próprio pagamento.`
        : html`<strong>Aprovação desligada nesta empresa:</strong> os pagamentos podem ser baixados direto.${gestor() ? ' Ligue em "Regras de aprovação".' : ''}`}</div>`);
    selecionados.clear();
    $('#tabela', alvo).innerHTML = String(html`<table><thead><tr>${aba === 'abertas' ? html`<th class="sel"><input type="checkbox" id="todos" aria-label="Selecionar todos"></th>` : ''}
      <th>Vencimento</th><th>Pagamento</th><th>Lançado por</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead><tbody>
      ${r.itens.length ? r.itens.map((l) => html`<tr class="clicavel" data-id="${l.id}">
        ${aba === 'abertas' ? html`<td class="sel"><input type="checkbox" data-sel="${l.id}" aria-label="Selecionar"></td>` : ''}
        <td>${data(l.vencimento)}</td>
        <td><strong>${l.descricao}</strong><div class="small muted">${l.contato_nome ?? 'Sem fornecedor'} · ${l.categoria_nome}${l.documentos ? ` · ${l.documentos} documento(s)` : ' · sem documento'}</div></td>
        <td class="small">${l.criado_por_nome ?? 'Integração / Portal'}</td>
        <td class="num"><strong>${moeda(l.valor_centavos)}</strong></td>
        <td>${APROVACAO[l.aprovacao]}${l.status === 'pago' ? html` <span class="badge ok">Pago</span>` : ''}</td>
        <td class="right" style="white-space:nowrap">
          ${l.aprovacao === 'conferencia' ? html`<button class="btn sm" data-conferir="${l.id}">Conferir</button>` : ''}
          ${l.aprovacao === 'pendente' ? html`<button class="btn sm perigo" data-recusar="${l.id}">Recusar</button> <button class="btn sm primario" data-aprovar="${l.id}"
            ${raw(l.criado_por === usuarioAtual().id ? 'disabled title="Você lançou este pagamento"' : '')}>Aprovar</button>` : ''}</td></tr>`)
        : html`<tr><td colspan="7" class="vazio">${aba === 'abertas' ? 'Nenhum pagamento aguardando conferência ou aprovação.' : 'Nada por aqui.'}</td></tr>`}
      </tbody></table>`);
    const lote = () => {
      $('#lote', alvo).classList.toggle('hidden', !selecionados.size);
      const soma = r.itens.filter((l) => selecionados.has(l.id)).reduce((a, l) => a + l.valor_centavos, 0);
      $('#lote-info', alvo).textContent = `${selecionados.size} selecionado(s) · ${moeda(soma)}`;
    };
    $$('[data-sel]', alvo).forEach((c) => c.addEventListener('change', () => { c.checked ? selecionados.add(Number(c.dataset.sel)) : selecionados.delete(Number(c.dataset.sel)); lote(); }));
    $('#todos', alvo)?.addEventListener('change', (e) => $$('[data-sel]', alvo).forEach((c) => { c.checked = e.target.checked; c.dispatchEvent(new Event('change')); }));
    $$('tr[data-id]', alvo).forEach((tr) => tr.addEventListener('click', (e) => {
      if (e.target.closest('button, input')) return;
      detalheLancamento(base, tr.dataset.id).catch((err) => toast(err.message, 'erro'));
    }));
    const agir = (sel, fn) => $$(sel, alvo).forEach((b) => b.addEventListener('click', fn(b)));
    agir('[data-conferir]', (b) => () => comentar('Conferir pagamento', 'Confirme que o documento, o valor e os dados de pagamento conferem.', false,
      (c) => api.post(`${base}/aprovacoes/${b.dataset.conferir}/conferir`, { comentario: c }), 'Conferido. Enviado para aprovação.'));
    agir('[data-aprovar]', (b) => () => comentar('Aprovar pagamento', 'Autoriza o pagamento. Fica registrado com seu nome.', false,
      (c) => api.post(`${base}/aprovacoes/${b.dataset.aprovar}/aprovar`, { comentario: c }), 'Pagamento aprovado.'));
    agir('[data-recusar]', (b) => () => comentar('Recusar pagamento', 'Explique o motivo: ele aparece para a equipe e para o cliente.', true,
      (c) => api.post(`${base}/aprovacoes/${b.dataset.recusar}/recusar`, { comentario: c }), 'Pagamento recusado.'));
  };

  const comentar = (titulo, texto, obrigatorio, fn, sucesso) => modal({
    titulo,
    corpo: html`<p style="margin-top:0">${texto}</p><label>Comentário${obrigatorio ? '' : ' (opcional)'}</label><textarea name="comentario" ${obrigatorio ? 'required' : ''}></textarea>`,
    rotuloEnviar: titulo.split(' ')[0],
    aoEnviar: async (form, fechar) => { await fn(dadosForm(form).comentario); fechar(); toast(sucesso); carregar(); window.dispatchEvent(new Event('bpo:contadores')); },
  });

  const emLote = async (acao) => {
    if (!(await confirmar(acao === 'conferir' ? 'Conferir em lote' : 'Aprovar em lote', `${selecionados.size} pagamento(s). Se algum não puder, nenhum é processado.`))) return;
    try {
      const r = await api.post(`${base}/aprovacoes/lote`, { ids: [...selecionados], acao });
      toast(`${r.processados} pagamento(s) ${acao === 'conferir' ? 'conferidos' : 'aprovados'}.`);
      carregar();
      window.dispatchEvent(new Event('bpo:contadores'));
    } catch (err) { toast(err.message, 'erro'); }
  };
  $('#lote-conferir', alvo).addEventListener('click', () => emLote('conferir'));
  $('#lote-aprovar', alvo).addEventListener('click', () => emLote('aprovar'));
  $$('[data-aba]', alvo).forEach((b) => b.addEventListener('click', () => {
    aba = b.dataset.aba;
    $$('[data-aba]', alvo).forEach((x) => x.classList.toggle('ativo', x === b));
    carregar();
  }));
  $('#config', alvo)?.addEventListener('click', () => modal({
    titulo: 'Regras de aprovação',
    corpo: html`<div class="form">
      <div class="c12"><label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="ativa" style="width:16px;height:16px" ${empresa.aprovacao_ativa ? 'checked' : ''}> Exigir aprovação para pagamentos desta empresa</label></div>
      <div class="c6"><label>Somente acima de (R$)</label><input name="acima" class="moeda" inputmode="numeric" value="${valorMoedaInput(empresa.aprovacao_acima_centavos ?? 0)}"></div>
      <div class="c12 small muted">Quem aprova: usuários da equipe com alçada (definida em Usuários) e responsáveis da empresa com permissão de aprovar no Portal (em Contrato e responsáveis). Vale para os pagamentos lançados daqui em diante.</div></div>`,
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      await api.patch(`${base}/aprovacoes/config`, { aprovacao_ativa: Boolean(d.ativa), aprovacao_acima_centavos: centavos(d.acima) });
      fechar(); toast('Regras salvas.'); window.dispatchEvent(new Event('bpo:recarregar'));
    },
  }));
  await carregar();
}
