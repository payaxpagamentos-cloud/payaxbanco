import { api } from '../api.js';
import { html, raw, $, $$, modal, dadosForm, toast, centavos, valorMoedaInput, opcoes, hoje, moeda, data, dataHora, status, confirmar, numero } from '../ui.js';

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

export const APROVACAO = {
  dispensada: null,
  conferencia: html`<span class="badge warn">Em conferência</span>`,
  pendente: html`<span class="badge warn">Aguardando aprovação</span>`,
  aprovada: html`<span class="badge ok">Aprovado</span>`,
  recusada: html`<span class="badge danger">Recusado</span>`,
};
export const TIPOS_DOC = [
  { id: 'nota', nome: 'Nota fiscal' }, { id: 'boleto', nome: 'Boleto' }, { id: 'comprovante', nome: 'Comprovante' },
  { id: 'contrato', nome: 'Contrato' }, { id: 'extrato', nome: 'Extrato' }, { id: 'outro', nome: 'Outro' },
];
export const tamanho = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${numero(Math.round(b / 1024))} kB` : `${(b / 1048576).toFixed(1).replace('.', ',')} MB`);

/** Linhas de rateio (centro + %), com soma ao vivo. */
function blocoRateio(centros, itens = []) {
  const linha = (i = {}) => html`<div class="row rateio-linha" style="margin-bottom:6px">
    <select name="rateio_centro" style="flex:1">${opcoes(centros, { selecionado: i.centro_custo_id, vazio: 'Centro de custo' })}</select>
    <input name="rateio_pct" type="number" min="0.01" max="100" step="0.01" placeholder="%" value="${i.percentual ? i.percentual / 100 : ''}" style="width:100px">
    <button type="button" class="btn sm" data-remover-rateio>×</button></div>`;
  return html`<div id="rateio" class="${itens.length ? '' : 'hidden'}" style="margin-top:8px">
    <div id="rateio-linhas">${(itens.length ? itens : [{}, {}]).map(linha)}</div>
    <div class="row"><button type="button" class="btn sm" id="mais-rateio">+ Centro</button><span class="small" id="rateio-soma"></span></div>
    <template id="modelo-rateio">${linha()}</template></div>`;
}

function ligarRateio(el) {
  const area = $('#rateio', el);
  if (!area) return;
  const soma = () => {
    const t = $$('[name=rateio_pct]', el).reduce((a, i) => a + (Number(i.value) || 0), 0);
    $('#rateio-soma', el).textContent = `Soma: ${t.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
    $('#rateio-soma', el).className = `small ${Math.abs(t - 100) < 0.001 ? 'pos' : 'neg'}`;
  };
  $('#usar-rateio', el)?.addEventListener('change', (e) => {
    area.classList.toggle('hidden', !e.target.checked);
    $('[name=centro_custo_id]', el).disabled = e.target.checked;
  });
  $('#mais-rateio', el).addEventListener('click', () => { $('#rateio-linhas', el).append($('#modelo-rateio', el).content.cloneNode(true)); });
  el.addEventListener('click', (e) => { if (e.target.matches('[data-remover-rateio]')) { e.target.closest('.rateio-linha').remove(); soma(); } });
  el.addEventListener('input', soma);
  soma();
}

/** Formulário de conta a pagar/receber. */
function formLancamento(tipo, l, cad, { novo, rateio = [] }) {
  const cats = cad.categorias.filter((c) => c.tipo === (tipo === 'receber' ? 'receita' : 'despesa'));
  const contatos = cad.contatos.filter((c) => c.tipo === 'ambos' || c.tipo === (tipo === 'receber' ? 'cliente' : 'fornecedor'));
  return html`<div class="form">
    <div class="c8"><label>Descrição</label><input name="descricao" required value="${l.descricao ?? ''}"></div>
    <div class="c4"><label>Valor ${novo ? '(total se parcelado) ' : ''}(R$)</label><input name="valor" class="moeda" inputmode="numeric" required value="${valorMoedaInput(l.valor_centavos ?? 0)}"></div>
    <div class="c6"><label>${tipo === 'receber' ? 'Cliente' : 'Fornecedor'}</label><select name="contato_id">${opcoes(contatos, { selecionado: l.contato_id, vazio: 'Não informado' })}</select></div>
    <div class="c6"><label>Categoria</label><select name="categoria_id" required>${opcoes(cats, { selecionado: l.categoria_id, vazio: 'Selecione' })}</select></div>
    <div class="c4"><label>Vencimento${novo ? ' (1º)' : ''}</label><input name="vencimento" type="date" required value="${l.vencimento ?? hoje()}"></div>
    <div class="c4"><label>Competência</label><input name="competencia" type="date" value="${l.competencia ?? ''}"><div class="ajuda">Mês da DRE. Em branco: o vencimento.</div></div>
    <div class="c4"><label>Nº documento</label><input name="documento" value="${l.documento ?? ''}" placeholder="NF, boleto…"></div>
    ${tipo === 'pagar' ? html`<div class="c12"><label>Linha digitável do boleto (opcional)</label><input name="codigo_barras" id="linha-boleto" inputmode="numeric" value="${l.codigo_barras ?? ''}" placeholder="Cole a linha digitável: valor e vencimento são preenchidos sozinhos">
      <div class="ajuda" id="boleto-info"></div></div>` : ''}
    ${novo ? html`<div class="c4"><label>Repetição</label><select name="modo" id="modo">
        <option value="unico">Lançamento único</option><option value="parcelas">Parcelado (divide o valor)</option><option value="recorrente">Recorrente mensal (repete o valor)</option></select></div>
      <div class="c4 hidden" id="campo-qtd"><label id="rotulo-qtd">Quantidade</label><input name="quantidade" type="number" min="2" max="120" value="12"></div>` : ''}
    <div class="c4"><label>Conta prevista</label><select name="conta_bancaria_id">${opcoes(cad.contas, { selecionado: l.conta_bancaria_id, rotulo: 'descricao', vazio: 'A definir' })}</select></div>
    <div class="c12"><label>Centro de custo</label>
      <div class="row"><select name="centro_custo_id" style="flex:1" ${rateio.length ? 'disabled' : ''}>${opcoes(cad.centros, { selecionado: l.centro_custo_id, vazio: 'Nenhum' })}</select>
        ${cad.centros.length > 1 ? html`<label style="display:flex;gap:6px;align-items:center;margin:0;color:var(--text)"><input type="checkbox" id="usar-rateio" style="width:16px;height:16px" ${rateio.length ? 'checked' : ''}> Ratear entre centros</label>` : ''}</div>
      ${cad.centros.length > 1 ? blocoRateio(cad.centros, rateio) : ''}</div>
    <div class="c12"><label>Observações</label><textarea name="observacoes" style="min-height:60px">${l.observacoes ?? ''}</textarea></div>
    ${novo ? html`<div class="c12"><label style="display:flex;gap:8px;align-items:center;font-weight:600;color:var(--text)"><input type="checkbox" name="baixar" style="width:16px;height:16px"> Já foi ${tipo === 'receber' ? 'recebido' : 'pago'} (baixa na data do vencimento, na conta prevista)</label></div>` : ''}
  </div>`;
}

function ligarForm(el) {
  ligarRateio(el);
  // Boleto: lê a linha digitável e preenche valor e vencimento.
  const linha = $('#linha-boleto', el);
  linha?.addEventListener('change', async () => {
    const info = $('#boleto-info', el);
    if (!linha.value.trim()) { info.textContent = ''; return; }
    try {
      const b = await api.get('/utilidades/boleto', { linha: linha.value });
      if (b.valor_centavos) { const v = $('[name=valor]', el); v.value = valorMoedaInput(b.valor_centavos); v.dispatchEvent(new Event('input')); }
      if (b.vencimento) $('[name=vencimento]', el).value = b.vencimento;
      info.className = 'ajuda pos';
      info.textContent = `Boleto válido${b.banco ? ` · banco ${b.banco}` : ''}${b.valor_centavos ? ` · ${moeda(b.valor_centavos)}` : ''}${b.vencimento ? ` · vence ${data(b.vencimento)}` : ''}`;
    } catch (err) { info.className = 'ajuda neg'; info.textContent = err.message; }
  });
  const modo = $('#modo', el);
  if (modo) modo.addEventListener('change', () => {
    $('#campo-qtd', el).classList.toggle('hidden', modo.value === 'unico');
    $('#rotulo-qtd', el).textContent = modo.value === 'parcelas' ? 'Número de parcelas' : 'Repetir por (meses)';
  });
}

function corpoLancamento(form, tipo) {
  const d = dadosForm(form);
  const corpo = {
    tipo, descricao: d.descricao, valor_centavos: centavos(d.valor), contato_id: d.contato_id || null, categoria_id: d.categoria_id || null,
    vencimento: d.vencimento, competencia: d.competencia || undefined, centro_custo_id: d.centro_custo_id || null,
    conta_bancaria_id: d.conta_bancaria_id || null, documento: d.documento || null, observacoes: d.observacoes || null,
  };
  if ('codigo_barras' in d) corpo.codigo_barras = d.codigo_barras.trim() || null;
  if (d.modo === 'parcelas') corpo.parcelas = Number(d.quantidade);
  if (d.modo === 'recorrente') corpo.repeticoes = Number(d.quantidade);
  const usarRateio = $('#usar-rateio', form)?.checked;
  corpo.rateio = usarRateio
    ? $$('.rateio-linha', form).map((l) => ({ centro_custo_id: $('[name=rateio_centro]', l).value, percentual: Number($('[name=rateio_pct]', l).value) }))
      .filter((r) => r.centro_custo_id && r.percentual)
    : [];
  if (d.baixar) {
    if (!corpo.conta_bancaria_id) throw new Error('Para lançar já baixado, escolha a conta prevista.');
    if (d.modo && d.modo !== 'unico') throw new Error('Lançamento parcelado ou recorrente não pode ser baixado na criação.');
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
    aoAbrir: ligarForm,
    aoEnviar: async (form, fechar) => {
      const r = await api.post(`${base}/lancamentos`, corpoLancamento(form, tipo));
      fechar();
      toast(r.ids.length > 1 ? `${r.ids.length} lançamentos criados.` : 'Lançamento criado.');
      recarregar();
    },
  });
}

/** Baixa (pagamento ou recebimento): total ou parcial, com juros e desconto. */
export async function baixar(base, l, contas) {
  const lista = contas ?? (await api.get(`${base}/contas-bancarias`)).filter((c) => c.ativo);
  const verbo = l.tipo === 'receber' ? 'recebido' : 'pago';
  const { el } = modal({
    titulo: l.tipo === 'receber' ? 'Registrar recebimento' : 'Registrar pagamento',
    corpo: html`<p style="margin-top:0"><strong>${l.descricao}</strong> · vencimento ${data(l.vencimento)} · em aberto ${moeda(l.valor_centavos)}</p>
      <div class="form">
        <div class="c6"><label>Data</label><input name="data" type="date" required value="${hoje()}"></div>
        <div class="c6"><label>Conta</label><select name="conta_bancaria_id" required>${opcoes(lista, { selecionado: l.conta_bancaria_id, rotulo: 'descricao', vazio: 'Selecione' })}</select></div>
        <div class="c6"><label>Valor do título baixado agora (R$)</label><input name="principal" class="moeda" inputmode="numeric" value="${valorMoedaInput(l.valor_centavos)}">
          <div class="ajuda">Menor que o valor em aberto: baixa parcial, o saldo continua em aberto.</div></div>
        <div class="c3"><label>Juros / multa</label><input name="juros" class="moeda" inputmode="numeric" value="0,00"></div>
        <div class="c3"><label>Desconto</label><input name="desconto" class="moeda" inputmode="numeric" value="0,00"></div>
        <div class="c12"><div class="card card-body" style="box-shadow:none;background:var(--surface-2)"><span class="muted">Valor ${verbo}:</span> <strong id="total-baixa">${moeda(l.valor_centavos)}</strong>
          <span class="small muted" id="saldo-baixa"></span></div></div>
      </div>`,
    rotuloEnviar: 'Confirmar baixa',
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      const principal = centavos(d.principal);
      await api.post(`${base}/lancamentos/${l.id}/baixa`, { data: d.data, conta_bancaria_id: d.conta_bancaria_id, juros_centavos: centavos(d.juros),
        desconto_centavos: centavos(d.desconto), valor_principal_centavos: principal });
      fechar();
      toast(principal < l.valor_centavos ? `Baixa parcial registrada. Saldo de ${moeda(l.valor_centavos - principal)} continua em aberto.` : 'Baixa registrada.');
      recarregar();
    },
  });
  const atualizar = () => {
    const principal = centavos($('[name=principal]', el).value);
    $('#total-baixa', el).textContent = moeda(principal + centavos($('[name=juros]', el).value) - centavos($('[name=desconto]', el).value));
    $('#saldo-baixa', el).textContent = principal < l.valor_centavos ? `· saldo em aberto depois: ${moeda(l.valor_centavos - principal)}` : '';
  };
  // A máscara de moeda troca o valor no beforeinput (sem disparar input): recalcula logo depois.
  ['input', 'beforeinput', 'paste'].forEach((ev) => el.addEventListener(ev, () => setTimeout(atualizar)));
}

/** Envio de documento (opcionalmente ligado a um lançamento). `rota`: rota de documentos da API. */
export function enviarDocumento(rota, { lancamentoId, aoEnviar, tipoPadrao = 'nota' } = {}) {
  let arquivo = null;
  const { el } = modal({
    titulo: 'Enviar documento',
    corpo: html`<div class="form">
      <div class="c6"><label>Tipo</label><select name="tipo">${opcoes(TIPOS_DOC, { selecionado: tipoPadrao })}</select></div>
      <div class="c6"><label>Descrição (opcional)</label><input name="descricao"></div>
      <div class="c12"><label class="zona-arquivo" id="zona-doc"><div id="zona-doc-texto"><strong>Escolha o arquivo</strong><br>
        <span class="small">PDF, imagem, XML, planilha ou documento · até 10 MB</span></div><input type="file" id="arquivo-doc" hidden></label></div></div>`,
    rotuloEnviar: 'Enviar',
    aoEnviar: async (form, fechar) => {
      if (!arquivo) throw new Error('Escolha o arquivo.');
      const d = dadosForm(form);
      await api.enviarArquivo(rota, { nome: arquivo.name, tipo: d.tipo, descricao: d.descricao, lancamento_id: lancamentoId }, arquivo);
      fechar();
      toast('Documento enviado.');
      aoEnviar?.();
    },
  });
  const usar = (f) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { toast('Arquivo maior que 10 MB.', 'erro'); return; }
    arquivo = f;
    $('#zona-doc-texto', el).innerHTML = String(html`<strong>${f.name}</strong><br><span class="small">${tamanho(f.size)}</span>`);
  };
  const zona = $('#zona-doc', el);
  $('#arquivo-doc', el).addEventListener('change', (e) => usar(e.target.files[0]));
  zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('arrastando'); });
  zona.addEventListener('dragleave', () => zona.classList.remove('arrastando'));
  zona.addEventListener('drop', (e) => { e.preventDefault(); zona.classList.remove('arrastando'); usar(e.dataTransfer.files[0]); });
}

/** Lista de documentos com botão de download (ligue com ligarDownloads). */
export function listaDocumentos(docs) {
  return html`${docs.length ? html`<div class="table-wrap"><table><tbody>${docs.map((d) => html`<tr>
    <td><strong>${d.nome}</strong><div class="small muted">${TIPOS_DOC.find((t) => t.id === d.tipo)?.nome} · ${tamanho(d.tamanho)} · ${dataHora(d.criado_em)} · ${d.responsavel_nome ? `cliente (${d.responsavel_nome})` : d.usuario_nome ?? ''}</div></td>
    <td class="right"><button class="btn sm" data-baixar-doc="${d.id}">Baixar</button></td></tr>`)}</tbody></table></div>`
    : html`<p class="muted small" style="margin:0">Nenhum documento.</p>`}`;
}
export function ligarDownloads(el, rotaArquivo) {
  $$('[data-baixar-doc]', el).forEach((b) => b.addEventListener('click', () => api.baixar(rotaArquivo(b.dataset.baixarDoc)).catch((err) => toast(err.message, 'erro'))));
}

const ETAPA = { solicitado: 'Lançado', conferido: 'Conferido', aprovado: 'Aprovado', recusado: 'Recusado', reaberto: 'Reaberto para conferência' };
export const historicoAprovacao = (lista) => html`<ul class="linha-tempo">${lista.map((a) => html`<li class="${a.etapa}">
  <strong>${ETAPA[a.etapa]}</strong> · ${a.usuario_nome ?? (a.responsavel_nome ? `${a.responsavel_nome} (cliente)` : 'sistema')} · <span class="muted">${dataHora(a.criado_em)}</span>
  ${a.comentario ? html`<div class="small">${a.comentario}</div>` : ''}</li>`)}</ul>`;

/** Detalhe de um lançamento com as ações possíveis. */
export async function detalheLancamento(base, id) {
  const [l, cad] = await Promise.all([api.get(`${base}/lancamentos/${id}`), cadastrosDaEmpresa(base)]);
  const bloqueado = l.tipo === 'pagar' && !['dispensada', 'aprovada'].includes(l.aprovacao);
  const { el, fechar } = modal({
    titulo: `${l.tipo === 'receber' ? 'Conta a receber' : 'Conta a pagar'} · ${l.descricao}`,
    grande: true,
    corpo: html`<div class="row" style="justify-content:space-between;margin-bottom:14px"><div class="row">${status(l.situacao)} ${APROVACAO[l.aprovacao] ?? ''}</div>
        ${l.total_parcelas > 1 ? html`<span class="badge">${l.recorrente ? 'Recorrente' : 'Parcela'} ${l.parcela} de ${l.total_parcelas}</span>` : ''}</div>
      <dl class="dl">
        <div><dt>Valor</dt><dd class="num">${moeda(l.valor_centavos)}</dd></div>
        <div><dt>Vencimento</dt><dd>${data(l.vencimento)}</dd></div>
        <div><dt>Competência</dt><dd>${data(l.competencia)}</dd></div>
        <div><dt>${l.tipo === 'receber' ? 'Cliente' : 'Fornecedor'}</dt><dd>${l.contato_nome ?? '—'}</dd></div>
        <div><dt>Categoria</dt><dd>${l.categoria_nome ?? '—'}</dd></div>
        <div><dt>Centro de custo</dt><dd>${l.rateio.length ? l.rateio.map((r) => `${r.nome} ${(r.percentual / 100).toLocaleString('pt-BR')}%`).join(' · ') : l.centro_nome ?? '—'}</dd></div>
        <div><dt>Conta</dt><dd>${l.conta_nome ?? '—'}</dd></div>
        <div><dt>Documento</dt><dd>${l.documento ?? '—'}</dd></div>
        ${l.status === 'pago' ? html`
          <div><dt>Baixado em</dt><dd>${data(l.pago_em)}</dd></div>
          <div><dt>Valor ${l.tipo === 'receber' ? 'recebido' : 'pago'}</dt><dd class="num">${moeda(l.valor_pago_centavos)}</dd></div>
          <div><dt>Juros / desconto</dt><dd class="num">${moeda(l.juros_centavos)} / ${moeda(l.desconto_centavos)}</dd></div>
          <div><dt>Conciliação</dt><dd>${l.extrato ? html`<span class="badge ok">Conciliado</span> <span class="small muted">${data(l.extrato.data)}</span>` : html`<span class="badge warn">Não conciliado</span>`}</dd></div>` : ''}
      </dl>
      ${l.codigo_barras ? html`<div class="boleto-linha"><div><span class="small muted">Linha digitável do boleto</span><div class="mono">${l.codigo_barras.replace(/^(\d{5})(\d{5})(\d{5})(\d{6})(\d{5})(\d{6})(\d)(\d{14})$/, '$1.$2 $3.$4 $5.$6 $7 $8')}</div></div>
        <button class="btn sm" id="copiar-boleto">Copiar</button></div>` : ''}
      ${l.chave_nfe ? html`<p class="small muted">NF-e: <span class="mono">${l.chave_nfe}</span></p>` : ''}
      ${l.origem ? html`<p class="small muted">Saldo da baixa parcial do lançamento #${l.origem.id}.</p>` : ''}
      ${l.saldos.length ? html`<p class="small muted">Baixa parcial: saldo de ${moeda(l.saldos.reduce((a, s) => a + s.valor_centavos, 0))} no lançamento ${l.saldos.map((s) => `#${s.id}`).join(', ')}.</p>` : ''}
      ${l.observacoes ? html`<p class="small" style="white-space:pre-wrap">${l.observacoes}</p>` : ''}
      ${l.aprovacoes.length ? html`<h3 style="margin:18px 0 8px">Aprovação</h3>${historicoAprovacao(l.aprovacoes)}` : ''}
      <div class="row" style="justify-content:space-between;margin:18px 0 8px"><h3 style="margin:0">Documentos e comprovantes</h3><button class="btn sm" id="anexar">+ Anexar</button></div>
      ${listaDocumentos(l.documentos)}
      ${l.parcelas.length > 1 ? html`<h3 style="margin:18px 0 8px">${l.recorrente ? 'Recorrência' : 'Parcelas'}</h3><div class="table-wrap"><table><tbody>
        ${l.parcelas.map((p) => html`<tr ${raw(p.id === l.id ? 'style="background:var(--info-bg)"' : '')}><td>${p.parcela}/${p.total_parcelas}</td><td>${data(p.vencimento)}</td><td class="num">${moeda(p.valor_centavos)}</td><td>${status(p.status)}</td></tr>`)}
      </tbody></table></div>` : ''}`,
    rodape: html`<div class="modal-foot">
      ${l.status === 'aberto' ? html`<button class="btn perigo" data-acao="cancelar">Cancelar lançamento</button><button class="btn" data-acao="editar">Editar</button>
        <button class="btn primario" data-acao="baixar" ${bloqueado ? 'disabled' : ''} title="${bloqueado ? 'Aguardando aprovação' : ''}">${l.tipo === 'receber' ? 'Receber' : 'Pagar'}</button>` : ''}
      ${l.status === 'pago' ? html`<button class="btn perigo" data-acao="estornar">Estornar baixa</button>` : ''}
      <button class="btn" data-cancelar>Fechar</button></div>`,
  });
  ligarDownloads(el, (d) => `${base}/documentos/${d}/arquivo`);
  $('#copiar-boleto', el)?.addEventListener('click', () => navigator.clipboard?.writeText(l.codigo_barras).then(() => toast('Linha digitável copiada.')).catch(() => toast('Não foi possível copiar.', 'erro')));
  $('#anexar', el).addEventListener('click', () => { fechar(); enviarDocumento(`${base}/documentos`, { lancamentoId: l.id, tipoPadrao: l.status === 'pago' ? 'comprovante' : 'nota', aoEnviar: () => detalheLancamento(base, l.id) }); });
  const acao = (nome, fn) => $(`[data-acao=${nome}]`, el)?.addEventListener('click', fn);
  acao('baixar', () => { fechar(); baixar(base, l, cad.contas); });
  acao('editar', () => {
    fechar();
    modal({
      titulo: 'Editar lançamento', grande: true, corpo: formLancamento(l.tipo, l, cad, { novo: false, rateio: l.rateio }), aoAbrir: ligarForm,
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

/** Importação do XML da NF-e: prévia do que será lançado e confirmação. */
export async function importarNfe(base) {
  const cad = await cadastrosDaEmpresa(base);
  let conteudo = null;
  let previa = null;
  const { el } = modal({
    titulo: 'Importar NF-e (XML)', grande: true,
    corpo: html`<p class="muted" style="margin-top:0">Nota de compra (a empresa é a destinatária) vira conta a pagar ao fornecedor; nota de venda (a empresa emitiu) vira conta a receber.
      As duplicatas da nota viram as parcelas e o XML fica anexado.</p>
      <label class="zona-arquivo" id="zona-nfe"><div id="zona-nfe-texto"><strong>Escolha o arquivo XML da NF-e</strong></div><input type="file" id="arquivo-nfe" accept=".xml" hidden></label>
      <div id="previa-nfe" style="margin-top:14px"></div>`,
    rotuloEnviar: 'Lançar NF-e',
    aoEnviar: async (form, fechar) => {
      if (!previa) throw new Error('Escolha o XML da NF-e.');
      const d = dadosForm(form);
      const r = await api.post(`${base}/integracoes/nfe`, { conteudo, categoria_id: d.categoria_id, conta_bancaria_id: d.conta_bancaria_id || null,
        centro_custo_id: d.centro_custo_id || null, vencimento: d.vencimento || undefined, aceitar_sem_protocolo: Boolean(d.sem_protocolo) });
      fechar();
      toast(`NF-e lançada: ${r.ids.length} ${r.tipo === 'pagar' ? 'conta(s) a pagar' : 'conta(s) a receber'}.`);
      recarregar();
    },
  });
  const mostrar = (p) => {
    const tipoCat = p.tipo === 'pagar' ? 'despesa' : 'receita';
    $('#previa-nfe', el).innerHTML = String(html`
      ${p.ja_lancada ? html`<div class="alerta perigo">Esta NF-e já foi lançada (lançamento #${p.ja_lancada}).</div>` : ''}
      <dl class="dl"><div><dt>Lança como</dt><dd>${p.tipo === 'pagar' ? 'Contas a pagar' : 'Contas a receber'}</dd></div>
        <div><dt>${p.tipo === 'pagar' ? 'Fornecedor' : 'Cliente'}</dt><dd>${p.contato?.fantasia || p.contato?.nome || '—'}${p.contato_existente ? '' : html` <span class="badge info">novo</span>`}</dd></div>
        <div><dt>NF-e</dt><dd>${p.numero}${p.serie ? `/${p.serie}` : ''} · ${data(p.emissao)}</dd></div><div><dt>Valor total</dt><dd>${moeda(p.valor_centavos)}</dd></div></dl>
      <div class="table-wrap" style="margin:12px 0"><table><tbody>${p.parcelas.map((x, i) => html`<tr><td>${x.numero ? `Duplicata ${x.numero}` : `Parcela ${i + 1}`}</td><td>${data(x.vencimento)}</td><td class="num">${moeda(x.valor_centavos)}</td></tr>`)}</tbody></table></div>
      <div class="form">
        <div class="c6"><label>Categoria</label><select name="categoria_id" required>${opcoes(cad.categorias.filter((c) => c.tipo === tipoCat), { vazio: 'Selecione' })}</select></div>
        <div class="c6"><label>Conta prevista</label><select name="conta_bancaria_id">${opcoes(cad.contas, { rotulo: 'descricao', vazio: 'A definir' })}</select></div>
        <div class="c6"><label>Centro de custo</label><select name="centro_custo_id">${opcoes(cad.centros, { vazio: 'Nenhum' })}</select></div>
        ${p.duplicatas.length ? '' : html`<div class="c6"><label>Vencimento (a nota não traz duplicatas)</label><input type="date" name="vencimento" value="${p.parcelas[0].vencimento}"></div>`}
        ${p.autorizada ? '' : html`<div class="c12"><label class="linha-check"><input type="checkbox" name="sem_protocolo"> O XML não traz a autorização da SEFAZ. Lançar mesmo assim.</label></div>`}
      </div>`);
  };
  $('#arquivo-nfe', el).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    conteudo = await f.text();
    $('#zona-nfe-texto', el).innerHTML = String(html`<strong>${f.name}</strong> · lendo…`);
    try {
      previa = await api.post(`${base}/integracoes/nfe`, { conteudo, previa: true });
      $('#zona-nfe-texto', el).innerHTML = String(html`<strong>${f.name}</strong>`);
      mostrar(previa);
    } catch (err) {
      previa = null;
      $('#zona-nfe-texto', el).innerHTML = String(html`<strong>${f.name}</strong> · <span class="neg">${err.message}</span>`);
      $('#previa-nfe', el).innerHTML = '';
    }
  });
}
