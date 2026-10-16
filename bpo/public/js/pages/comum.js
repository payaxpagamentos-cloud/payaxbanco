import { api } from '../api.js';
import { html, raw, $, modal, dadosForm, toast, centavos, valorMoedaInput, opcoes, hoje, moeda, data, status, confirmar } from '../ui.js';

/** Cadastros da empresa usados nos formulários (só os ativos). */
export async function cadastrosDaEmpresa(base) {
  const [cat, contatos, centros, contas] = await Promise.all([
    api.get(`${base}/categorias`), api.get(`${base}/contatos`), api.get(`${base}/centros`), api.get(`${base}/contas-bancarias`),
  ]);
  return {
    categorias: cat.itens.filter((c) => c.ativo),
    grupos: cat.grupos,
    contatos: contatos.filter((c) => c.ativo),
    centros: centros.filter((c) => c.ativo),
    contas: contas.filter((c) => c.ativo),
  };
}

export const recarregar = () => window.dispatchEvent(new Event('bpo:recarregar'));

/** Formulário de conta a pagar/receber. */
function formLancamento(tipo, l, cad, { novo }) {
  const cats = cad.categorias.filter((c) => c.tipo === (tipo === 'receber' ? 'receita' : 'despesa'));
  const contatos = cad.contatos.filter((c) => c.tipo === 'ambos' || c.tipo === (tipo === 'receber' ? 'cliente' : 'fornecedor'));
  return html`<div class="form">
    <div class="c8"><label>Descrição</label><input name="descricao" required value="${l.descricao ?? ''}"></div>
    <div class="c4"><label>Valor ${novo ? 'total ' : ''}(R$)</label><input name="valor" class="moeda" inputmode="numeric" required value="${valorMoedaInput(l.valor_centavos ?? 0)}"></div>
    <div class="c6"><label>${tipo === 'receber' ? 'Cliente' : 'Fornecedor'}</label><select name="contato_id">${opcoes(contatos, { selecionado: l.contato_id, vazio: 'Não informado' })}</select></div>
    <div class="c6"><label>Categoria</label><select name="categoria_id" required>${opcoes(cats, { selecionado: l.categoria_id, vazio: 'Selecione' })}</select></div>
    <div class="c4"><label>Vencimento${novo ? ' (1ª parcela)' : ''}</label><input name="vencimento" type="date" required value="${l.vencimento ?? hoje()}"></div>
    <div class="c4"><label>Competência</label><input name="competencia" type="date" value="${l.competencia ?? ''}"><div class="ajuda">Mês da DRE. Em branco: o vencimento.</div></div>
    ${novo ? html`<div class="c4"><label>Parcelas</label><input name="parcelas" type="number" min="1" max="120" value="1"></div>` : html`<div class="c4"><label>Nº documento</label><input name="documento" value="${l.documento ?? ''}"></div>`}
    <div class="c4"><label>Centro de custo</label><select name="centro_custo_id">${opcoes(cad.centros, { selecionado: l.centro_custo_id, vazio: 'Nenhum' })}</select></div>
    <div class="c4"><label>Conta prevista</label><select name="conta_bancaria_id">${opcoes(cad.contas, { selecionado: l.conta_bancaria_id, rotulo: 'descricao', vazio: 'A definir' })}</select></div>
    ${novo ? html`<div class="c4"><label>Nº documento</label><input name="documento" placeholder="NF, boleto…"></div>` : ''}
    <div class="c12"><label>Observações</label><textarea name="observacoes" style="min-height:60px">${l.observacoes ?? ''}</textarea></div>
    ${novo ? html`<div class="c12"><label style="display:flex;gap:8px;align-items:center;font-weight:600;color:var(--text)"><input type="checkbox" name="baixar" style="width:16px;height:16px"> Já foi ${tipo === 'receber' ? 'recebido' : 'pago'} (baixa na data do vencimento, na conta prevista)</label></div>` : ''}
  </div>`;
}

function corpoLancamento(form, tipo) {
  const d = dadosForm(form);
  const corpo = {
    tipo, descricao: d.descricao, valor_centavos: centavos(d.valor), contato_id: d.contato_id || null, categoria_id: d.categoria_id || null,
    vencimento: d.vencimento, competencia: d.competencia || undefined, centro_custo_id: d.centro_custo_id || null,
    conta_bancaria_id: d.conta_bancaria_id || null, documento: d.documento || null, observacoes: d.observacoes || null,
  };
  if (d.parcelas) corpo.parcelas = Number(d.parcelas);
  if (d.baixar) {
    if (!corpo.conta_bancaria_id) throw new Error('Para lançar já baixado, escolha a conta prevista.');
    corpo.baixar = true;
    corpo.baixa = { data: d.vencimento, conta_bancaria_id: corpo.conta_bancaria_id };
  }
  return corpo;
}

export async function novoLancamento(base, tipo) {
  const cad = await cadastrosDaEmpresa(base);
  modal({
    titulo: tipo === 'receber' ? 'Nova conta a receber' : 'Nova conta a pagar',
    grande: true,
    corpo: formLancamento(tipo, {}, cad, { novo: true }),
    rotuloEnviar: 'Lançar',
    aoEnviar: async (form, fechar) => {
      const r = await api.post(`${base}/lancamentos`, corpoLancamento(form, tipo));
      fechar();
      toast(r.ids.length > 1 ? `${r.ids.length} parcelas lançadas.` : 'Lançamento criado.');
      recarregar();
    },
  });
}

/** Baixa (pagamento ou recebimento) com juros e desconto. */
export async function baixar(base, l, contas) {
  const lista = contas ?? (await api.get(`${base}/contas-bancarias`)).filter((c) => c.ativo);
  const { el } = modal({
    titulo: l.tipo === 'receber' ? 'Registrar recebimento' : 'Registrar pagamento',
    corpo: html`<p style="margin-top:0"><strong>${l.descricao}</strong> · vencimento ${data(l.vencimento)} · ${moeda(l.valor_centavos)}</p>
      <div class="form">
        <div class="c6"><label>Data</label><input name="data" type="date" required value="${hoje()}"></div>
        <div class="c6"><label>Conta</label><select name="conta_bancaria_id" required>${opcoes(lista, { selecionado: l.conta_bancaria_id, rotulo: 'descricao', vazio: 'Selecione' })}</select></div>
        <div class="c4"><label>Juros / multa (R$)</label><input name="juros" class="moeda" inputmode="numeric" value="0,00"></div>
        <div class="c4"><label>Desconto (R$)</label><input name="desconto" class="moeda" inputmode="numeric" value="0,00"></div>
        <div class="c4"><label>Valor ${l.tipo === 'receber' ? 'recebido' : 'pago'}</label><input id="total-baixa" readonly value="${moeda(l.valor_centavos)}"></div>
      </div>`,
    rotuloEnviar: 'Confirmar baixa',
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      await api.post(`${base}/lancamentos/${l.id}/baixa`, { data: d.data, conta_bancaria_id: d.conta_bancaria_id, juros_centavos: centavos(d.juros), desconto_centavos: centavos(d.desconto) });
      fechar();
      toast('Baixa registrada.');
      recarregar();
    },
  });
  const atualizar = () => { $('#total-baixa', el).value = moeda(l.valor_centavos + centavos($('[name=juros]', el).value) - centavos($('[name=desconto]', el).value)); };
  // A máscara de moeda troca o valor no beforeinput (sem disparar input): recalcula logo depois.
  ['input', 'beforeinput', 'paste'].forEach((ev) => el.addEventListener(ev, () => setTimeout(atualizar)));
}

/** Detalhe de um lançamento com as ações possíveis. */
export async function detalheLancamento(base, id) {
  const [l, cad] = await Promise.all([api.get(`${base}/lancamentos/${id}`), cadastrosDaEmpresa(base)]);
  const { el, fechar } = modal({
    titulo: `${l.tipo === 'receber' ? 'Conta a receber' : 'Conta a pagar'} · ${l.descricao}`,
    grande: true,
    corpo: html`<div class="row" style="justify-content:space-between;margin-bottom:14px">${status(l.situacao)}
        ${l.total_parcelas > 1 ? html`<span class="badge">Parcela ${l.parcela} de ${l.total_parcelas}</span>` : ''}</div>
      <dl class="dl">
        <div><dt>Valor</dt><dd class="num">${moeda(l.valor_centavos)}</dd></div>
        <div><dt>Vencimento</dt><dd>${data(l.vencimento)}</dd></div>
        <div><dt>Competência</dt><dd>${data(l.competencia)}</dd></div>
        <div><dt>${l.tipo === 'receber' ? 'Cliente' : 'Fornecedor'}</dt><dd>${l.contato_nome ?? '—'}</dd></div>
        <div><dt>Categoria</dt><dd>${l.categoria_nome ?? '—'}</dd></div>
        <div><dt>Centro de custo</dt><dd>${l.centro_nome ?? '—'}</dd></div>
        <div><dt>Conta</dt><dd>${l.conta_nome ?? '—'}</dd></div>
        <div><dt>Documento</dt><dd>${l.documento ?? '—'}</dd></div>
        ${l.status === 'pago' ? html`
          <div><dt>Baixado em</dt><dd>${data(l.pago_em)}</dd></div>
          <div><dt>Valor ${l.tipo === 'receber' ? 'recebido' : 'pago'}</dt><dd class="num">${moeda(l.valor_pago_centavos)}</dd></div>
          <div><dt>Juros / desconto</dt><dd class="num">${moeda(l.juros_centavos)} / ${moeda(l.desconto_centavos)}</dd></div>
          <div><dt>Conciliação</dt><dd>${l.extrato ? html`<span class="badge ok">Conciliado</span> <span class="small muted">${data(l.extrato.data)} · ${l.extrato.descricao ?? ''}</span>` : html`<span class="badge warn">Não conciliado</span>`}</dd></div>` : ''}
      </dl>
      ${l.observacoes ? html`<p class="small" style="white-space:pre-wrap">${l.observacoes}</p>` : ''}
      ${l.parcelas.length > 1 ? html`<h3 style="margin:18px 0 8px">Parcelas</h3><div class="table-wrap"><table><tbody>
        ${l.parcelas.map((p) => html`<tr ${raw(p.id === l.id ? 'style="background:var(--info-bg)"' : '')}><td>${p.parcela}/${p.total_parcelas}</td><td>${data(p.vencimento)}</td><td class="num">${moeda(p.valor_centavos)}</td><td>${status(p.status)}</td></tr>`)}
      </tbody></table></div>` : ''}`,
    rodape: html`<div class="modal-foot">
      ${l.status === 'aberto' ? html`<button class="btn perigo" data-acao="cancelar">Cancelar lançamento</button><button class="btn" data-acao="editar">Editar</button><button class="btn primario" data-acao="baixar">${l.tipo === 'receber' ? 'Receber' : 'Pagar'}</button>` : ''}
      ${l.status === 'pago' ? html`<button class="btn perigo" data-acao="estornar">Estornar baixa</button>` : ''}
      <button class="btn" data-cancelar>Fechar</button></div>`,
  });
  const acao = (nome, fn) => $(`[data-acao=${nome}]`, el)?.addEventListener('click', fn);
  acao('baixar', () => { fechar(); baixar(base, l, cad.contas); });
  acao('editar', () => {
    fechar();
    modal({
      titulo: 'Editar lançamento', grande: true, corpo: formLancamento(l.tipo, l, cad, { novo: false }),
      aoEnviar: async (form, f2) => { const c = corpoLancamento(form, l.tipo); delete c.tipo; await api.patch(`${base}/lancamentos/${l.id}`, c); f2(); toast('Lançamento atualizado.'); recarregar(); },
    });
  });
  acao('cancelar', async () => {
    if (!(await confirmar('Cancelar lançamento', 'O lançamento deixa de contar no fluxo de caixa e na DRE.', 'Cancelar lançamento'))) return;
    try { await api.post(`${base}/lancamentos/${l.id}/cancelar`); fechar(); toast('Lançamento cancelado.'); recarregar(); } catch (err) { toast(err.message, 'erro'); }
  });
  acao('estornar', async () => {
    if (!(await confirmar('Estornar baixa', l.extrato ? 'A baixa será desfeita e a linha do extrato volta para "a conciliar".' : 'A baixa será desfeita e o lançamento volta a ficar em aberto.', 'Estornar'))) return;
    try { await api.post(`${base}/lancamentos/${l.id}/estorno`); fechar(); toast('Baixa estornada.'); recarregar(); } catch (err) { toast(err.message, 'erro'); }
  });
}
