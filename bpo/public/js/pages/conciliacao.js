import { api } from '../api.js';
import { html, $, $$, moeda, moedaSinal, numero, data, status, opcoes, modal, dadosForm, toast, confirmar, debounce, icone } from '../ui.js';
import { cadastrosDaEmpresa } from './comum.js';

/** Lê o arquivo respeitando a codificação dos bancos (OFX costuma vir em Windows-1252). */
async function lerArquivo(arquivo) {
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const cabeca = new TextDecoder('latin1').decode(bytes.slice(0, 400));
  const latin = /CHARSET:\s*(1252|ISO-?8859-?1)|encoding="(windows-1252|iso-8859-1)"/i.test(cabeca);
  if (latin) return new TextDecoder('windows-1252').decode(bytes);
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  // Sem declaração e com caracteres inválidos em UTF-8: provavelmente Windows-1252 (CSV exportado do Excel).
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(bytes) : utf8;
}

export default async function conciliacao({ alvo, ativo, base, empresa }) {
  const cad = await cadastrosDaEmpresa(base);
  if (!ativo()) return;
  if (!cad.contas.length) {
    alvo.innerHTML = String(html`<div class="card vazio">Cadastre uma conta bancária em <a href="#/e/${empresa.id}/cadastros">Cadastros</a> para importar extratos.</div>`);
    return;
  }
  const estado = { conta: cad.contas[0].id, status: 'pendente' };
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Conciliação bancária</h1><p class="muted">Importe o extrato (OFX ou CSV) e case cada linha com os lançamentos.</p></div>
      <div class="row"><button class="btn" id="auto">Conciliar automaticamente</button><button class="btn primario" id="importar">${icone('upload')} Importar extrato</button></div></div>
    <div class="card"><div class="filtros">
      <select class="campo" id="conta" aria-label="Conta bancária">${opcoes(cad.contas, { rotulo: 'descricao', selecionado: estado.conta })}</select>
      <div class="chips" id="status">${[['pendente', 'A conciliar'], ['conciliado', 'Conciliados'], ['ignorado', 'Ignorados'], ['todos', 'Todos']].map(([v, r]) =>
        html`<button class="chip ${v === 'pendente' ? 'ativo' : ''}" data-status="${v}">${r}</button>`)}</div>
    </div></div>
    <div class="grid grid-4" id="resumo" style="margin-top:16px"></div>
    <div class="grid grid-2-1" style="margin-top:16px;align-items:start">
      <div class="card"><div class="card-head"><h2>Extrato do banco</h2><span class="small muted" id="qtd"></span></div><div id="itens"></div></div>
      <div class="card"><div class="card-head"><h2>No sistema, sem extrato</h2><span class="small muted">No período do extrato</span></div><div class="table-wrap" id="livres"></div></div>
    </div>`);

  const carregar = async () => {
    const p = await api.get(`${base}/conciliacao`, { conta_bancaria_id: estado.conta, status: estado.status });
    if (!ativo()) return;
    const r = p.resumo;
    const periodo = r.primeira_data ? `de ${data(r.primeira_data)} a ${data(r.ultima_data)}` : 'nenhum extrato importado';
    $('#resumo', alvo).innerHTML = String(html`
      <div class="card kpi ${r.pendentes ? 'vermelho' : 'verde'}"><div class="rotulo">A conciliar</div><div class="valor">${numero(r.pendentes ?? 0)}</div>
        <div class="sub">${numero(r.conciliados ?? 0)} conciliada(s) · ${numero(r.ignorados ?? 0)} ignorada(s)</div></div>
      <div class="card kpi azul"><div class="rotulo">Movimento pelo extrato</div><div class="valor">${moeda(r.extrato_centavos)}</div><div class="sub">Período ${periodo}</div></div>
      <div class="card kpi"><div class="rotulo">Movimento no sistema</div><div class="valor">${moeda(r.sistema_centavos)}</div><div class="sub">Mesmo período: baixas, transferências e ajustes</div></div>
      <div class="card kpi ${r.diferenca_centavos ? 'vermelho' : 'verde'}"><div class="rotulo">Diferença do período</div><div class="valor">${moeda(r.diferenca_centavos)}</div>
        <div class="sub">${r.diferenca_centavos ? 'Concilie as linhas pendentes dos dois lados' : 'Sistema e banco batem'}</div></div>`);
    $('#qtd', alvo).textContent = `${numero(p.itens.length)} linha(s)`;
    $('#itens', alvo).innerHTML = String(p.itens.length ? html`${p.itens.map((x) => html`
      <div class="conc-item ${x.status !== 'pendente' ? 'feito' : ''}" data-x="${x.id}">
        <div><strong>${data(x.data)}</strong><div class="small muted">${x.documento ?? ''}</div></div>
        <div>${x.descricao ?? html`<span class="muted">Sem histórico</span>`}
          ${x.status === 'conciliado' ? html`<div class="small muted">↔ ${x.movimento_descricao} (${data(x.movimento_data)})</div>` : ''}</div>
        <div class="valor">${moedaSinal(x.valor_centavos)}</div>
        <div class="acoes">
          ${x.status === 'pendente' ? html`
            ${x.sugestoes.movimentos.map((m) => html`<div class="sugestao"><span>Já lançado:</span><strong>${m.descricao}</strong><span class="muted">${data(m.data)}</span>
              <button class="btn sm primario" data-mov="${m.id}">Conciliar</button></div>`)}
            ${x.sugestoes.abertos.slice(0, 3).map((l) => html`<div class="sugestao"><span>Em aberto:</span><strong>${l.descricao}</strong>
              <span class="muted">${l.contato_nome ? `${l.contato_nome} · ` : ''}venc. ${data(l.vencimento)}</span>
              <button class="btn sm primario" data-lanc="${l.id}">${x.valor_centavos > 0 ? 'Receber' : 'Pagar'} e conciliar</button></div>`)}
            <button class="btn sm" data-buscar>Buscar lançamento</button>
            <button class="btn sm" data-criar>Criar lançamento</button>
            <button class="btn sm" data-ignorar>Ignorar</button>`
          : html`${status(x.status)} <button class="btn sm" data-desfazer>Desfazer</button>`}
        </div>
      </div>`)}` : html`<div class="vazio">${estado.status === 'pendente' ? 'Nada a conciliar nesta conta. Importe um extrato novo.' : 'Nenhuma linha.'}</div>`);
    $('#livres', alvo).innerHTML = String(html`<table><tbody>
      ${p.nao_conciliados.length ? p.nao_conciliados.map((m) => html`<tr><td class="small" style="white-space:nowrap">${data(m.data)}</td>
        <td>${m.descricao}<div class="small muted">${{ baixa: 'Baixa', transferencia: 'Transferência', ajuste: 'Ajuste' }[m.origem]}</div></td><td class="num">${moedaSinal(m.valor_centavos)}</td></tr>`)
        : html`<tr><td class="vazio">Todos os movimentos do sistema estão no extrato.</td></tr>`}</tbody></table>`);

    const executar = async (fn, msg) => { try { await fn(); toast(msg); carregar(); } catch (err) { toast(err.message, 'erro'); } };
    $$('.conc-item', alvo).forEach((el) => {
      const x = p.itens.find((i) => i.id === Number(el.dataset.x));
      $$('[data-mov]', el).forEach((b) => b.addEventListener('click', () => executar(() => api.post(`${base}/extrato/${x.id}/conciliar`, { movimento_id: Number(b.dataset.mov) }), 'Conciliado.')));
      $$('[data-lanc]', el).forEach((b) => b.addEventListener('click', () => executar(() => api.post(`${base}/extrato/${x.id}/conciliar`, { lancamento_id: Number(b.dataset.lanc) }), 'Baixado e conciliado.')));
      $('[data-ignorar]', el)?.addEventListener('click', () => executar(() => api.post(`${base}/extrato/${x.id}/ignorar`), 'Linha ignorada.'));
      $('[data-desfazer]', el)?.addEventListener('click', async () => {
        if (await confirmar('Desfazer conciliação', 'A linha volta para "a conciliar". A baixa, se houver, continua registrada no lançamento.', 'Desfazer')) executar(() => api.post(`${base}/extrato/${x.id}/desfazer`), 'Conciliação desfeita.');
      });
      $('[data-criar]', el)?.addEventListener('click', () => criar(x));
      $('[data-buscar]', el)?.addEventListener('click', () => buscar(x));
    });
  };

  // Tarifas, rendimentos e recebimentos sem título: cria o lançamento já baixado e conciliado.
  const criar = (x) => {
    const tipo = x.valor_centavos > 0 ? 'receita' : 'despesa';
    modal({
      titulo: `Criar lançamento de ${tipo}`,
      corpo: html`<p style="margin-top:0">${data(x.data)} · ${x.descricao ?? ''} · <strong>${moeda(Math.abs(x.valor_centavos))}</strong></p><div class="form">
        <div class="c12"><label>Descrição</label><input name="descricao" value="${x.descricao ?? ''}" required></div>
        <div class="c6"><label>Categoria</label><select name="categoria_id" required>${opcoes(cad.categorias.filter((c) => c.tipo === tipo), { vazio: 'Selecione' })}</select></div>
        <div class="c6"><label>${tipo === 'receita' ? 'Cliente' : 'Fornecedor'}</label><select name="contato_id">${opcoes(cad.contatos, { vazio: 'Não informado' })}</select></div>
        <div class="c6"><label>Centro de custo</label><select name="centro_custo_id">${opcoes(cad.centros, { vazio: 'Nenhum' })}</select></div>
        <div class="c6"><label>Competência</label><input name="competencia" type="date" value="${x.data}"></div></div>`,
      rotuloEnviar: 'Lançar e conciliar',
      aoEnviar: async (form, fechar) => {
        const d = dadosForm(form);
        await api.post(`${base}/extrato/${x.id}/lancar`, { ...d, contato_id: d.contato_id || null, centro_custo_id: d.centro_custo_id || null });
        fechar(); toast('Lançado e conciliado.'); carregar();
      },
    });
  };

  // Procura qualquer conta em aberto do mesmo tipo (a diferença de valor vira juros ou desconto).
  const buscar = (x) => {
    const tipo = x.valor_centavos > 0 ? 'receber' : 'pagar';
    const { el, fechar } = modal({
      titulo: 'Buscar conta em aberto', grande: true,
      corpo: html`<p style="margin-top:0">Extrato: ${data(x.data)} · ${x.descricao ?? ''} · <strong>${moeda(Math.abs(x.valor_centavos))}</strong>.
        Se o valor for diferente, a diferença vira juros (a maior) ou desconto (a menor).</p>
        <input id="busca-lanc" placeholder="Descrição, documento ou contato"><div class="table-wrap" id="res-lanc" style="margin-top:12px"></div>`,
    });
    const listar = async (busca = '') => {
      const r = await api.get(`${base}/lancamentos`, { tipo, status: 'aberto', busca, limite: 30 });
      $('#res-lanc', el).innerHTML = String(html`<table><tbody>${r.itens.length ? r.itens.map((l) => html`<tr>
        <td>${data(l.vencimento)}</td><td>${l.descricao}<div class="small muted">${l.contato_nome ?? ''}</div></td><td class="num">${moeda(l.valor_centavos)}</td>
        <td class="right"><button class="btn sm primario" data-escolher="${l.id}">Escolher</button></td></tr>`) : html`<tr><td class="vazio">Nenhuma conta em aberto.</td></tr>`}</tbody></table>`);
      $$('[data-escolher]', el).forEach((b) => b.addEventListener('click', async () => {
        try {
          await api.post(`${base}/extrato/${x.id}/conciliar`, { lancamento_id: Number(b.dataset.escolher) });
          fechar(); toast('Baixado e conciliado.'); carregar();
        } catch (err) { toast(err.message, 'erro'); }
      }));
    };
    $('#busca-lanc', el).addEventListener('input', debounce((e) => listar(e.target.value)));
    listar();
  };

  $('#conta', alvo).addEventListener('change', (e) => { estado.conta = e.target.value; carregar(); });
  $$('[data-status]', alvo).forEach((b) => b.addEventListener('click', () => {
    estado.status = b.dataset.status;
    $$('[data-status]', alvo).forEach((x) => x.classList.toggle('ativo', x === b));
    carregar();
  }));
  $('#auto', alvo).addEventListener('click', async () => {
    try {
      const r = await api.post(`${base}/extrato/automatica`, { conta_bancaria_id: Number(estado.conta) });
      toast(`${r.conciliados} linha(s) conciliada(s) automaticamente. ${r.pendentes} para revisar.`);
      carregar();
    } catch (err) { toast(err.message, 'erro'); }
  });
  $('#importar', alvo).addEventListener('click', () => {
    let conteudo = null;
    let nome = null;
    const { el } = modal({
      titulo: 'Importar extrato',
      corpo: html`<div class="form">
        <div class="c12"><label>Conta bancária</label><select name="conta_bancaria_id">${opcoes(cad.contas, { rotulo: 'descricao', selecionado: estado.conta })}</select></div>
        <div class="c12"><label class="zona-arquivo" id="zona">${icone('upload')}<div id="zona-texto"><strong>Escolha o arquivo OFX ou CSV</strong><br>
          <span class="small">CSV: data; histórico; valor (negativo para saídas); documento opcional</span></div>
          <input type="file" id="arquivo" accept=".ofx,.csv,.txt" hidden></label></div>
      </div><p class="small muted">Linhas já importadas nesta conta são ignoradas: pode importar o mesmo período de novo sem duplicar.</p>`,
      rotuloEnviar: 'Importar',
      aoEnviar: async (form, fechar) => {
        if (!conteudo) throw new Error('Escolha o arquivo do extrato.');
        const d = dadosForm(form);
        const r = await api.post(`${base}/extrato/importar`, { conta_bancaria_id: Number(d.conta_bancaria_id), conteudo, arquivo: nome });
        fechar();
        estado.conta = d.conta_bancaria_id;
        $('#conta', alvo).value = d.conta_bancaria_id;
        toast(`${r.importados} linha(s) importada(s)${r.duplicados ? `, ${r.duplicados} já existiam` : ''}.`);
        carregar();
      },
    });
    const zona = $('#zona', el);
    const usar = async (f) => {
      if (!f) return;
      if (f.size > 4 * 1024 * 1024) { toast('Arquivo maior que 4 MB.', 'erro'); return; }
      conteudo = await lerArquivo(f);
      nome = f.name;
      $('#zona-texto', el).innerHTML = String(html`<strong>${f.name}</strong><br><span class="small">${numero(Math.ceil(f.size / 1024))} kB · pronto para importar</span>`);
    };
    $('#arquivo', el).addEventListener('change', (e) => usar(e.target.files[0]));
    zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('arrastando'); });
    zona.addEventListener('dragleave', () => zona.classList.remove('arrastando'));
    zona.addEventListener('drop', (e) => { e.preventDefault(); zona.classList.remove('arrastando'); usar(e.dataTransfer.files[0]); });
  });
  await carregar();
}
