import { api } from '../api.js';
import { html, $, $$, dataHora, toast, modal, dadosForm, confirmar, hoje, somarMeses, fimMes, numero, icone } from '../ui.js';
import { gestor } from '../contexto.js';

/** Integrações disponíveis (e as que dependem de credenciamento ou de parceiros). */
const CANAIS = [
  ['Bancos', 'Extrato por arquivo OFX ou CSV, em Conciliação bancária. Funciona com todos os bancos.', 'ok'],
  ['Bancos (API / Open Finance)', 'Leitura automática do extrato direto do banco. Depende de credenciamento com cada banco ou com um agregador de Open Finance.', 'nao'],
  ['Sistemas de gestão (ERP)', 'API com chave por empresa para enviar lançamentos e consultar saldos, e importação de lançamentos por CSV.', 'ok'],
  ['Contabilidade', 'Exportação das baixas em partidas dobradas (débito, crédito, valor, histórico) com os códigos contábeis das categorias e das contas.', 'ok'],
  ['Cobrança por WhatsApp e e-mail', 'Lembretes com o texto pronto, abertos no WhatsApp ou no e-mail do analista, com registro do envio.', 'ok'],
  ['Envio automático de cobrança', 'Disparo automático por WhatsApp Business, SMS ou e-mail. Depende de contrato com um provedor de mensagens.', 'nao'],
  ['Emissão de boletos e PIX cobrança', 'Geração de cobranças registradas. Depende da integração bancária da conta da empresa.', 'nao'],
];

export default async function integracoes({ alvo, ativo, base, empresa }) {
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Integrações</h1><p class="muted">Conexões com bancos, sistemas de gestão, contabilidade e canais de cobrança.</p></div></div>
    <div class="card"><div class="table-wrap"><table><tbody>${CANAIS.map(([nome, desc, st]) => html`<tr><td style="width:240px"><strong>${nome}</strong></td><td class="small">${desc}</td>
      <td class="right">${st === 'ok' ? html`<span class="badge ok">Disponível</span>` : html`<span class="badge">Depende de credenciamento</span>`}</td></tr>`)}</tbody></table></div></div>
    <div class="grid grid-2" style="margin-top:16px;align-items:start">
      <div class="card"><div class="card-head"><h2>Chaves de API (ERP)</h2>${gestor() ? html`<button class="btn sm primario" id="nova-chave">+ Nova chave</button>` : ''}</div><div id="chaves"></div>
        <div class="card-body small muted" style="border-top:1px solid var(--border)">
          <strong>Como usar:</strong> <code>POST /api/integracao/v1/lancamentos</code> com o cabeçalho <code>Authorization: Bearer bpo_…</code> e o corpo
          <code>{"tipo":"pagar","descricao":"NF 123","valor_centavos":15000,"vencimento":"AAAA-MM-DD","categoria":"Compra de mercadorias","contato":"Fornecedor","contato_documento":"CNPJ"}</code>
          (ou <code>{"lancamentos":[…]}</code> para vários). Também: <code>GET /empresa</code>, <code>GET /categorias</code>, <code>GET /lancamentos?desde=AAAA-MM-DD</code>.</div></div>
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Importar lançamentos (CSV do ERP)</h2></div><div class="card-body">
          <p class="small muted" style="margin-top:0">Colunas: <code>tipo; descrição; valor; vencimento; competência; categoria; contato; CPF/CNPJ do contato; documento</code>. Tipo: pagar ou receber.
            A categoria precisa existir no plano de contas; contatos novos são criados. Se uma linha tiver erro, nada é importado.</p>
          <label class="zona-arquivo" id="zona-csv">${icone('upload')}<div id="zona-csv-texto"><strong>Escolha o arquivo CSV</strong></div><input type="file" id="arquivo-csv" accept=".csv,.txt" hidden></label></div></div>
        <div class="card"><div class="card-head"><h2>Exportação contábil</h2></div><div class="card-body">
          <div class="row"><div><label>De</label><input type="date" id="ctb-de" value="${somarMeses(hoje(), -1)}"></div><div><label>Até</label><input type="date" id="ctb-ate" value="${fimMes(somarMeses(hoje(), -1))}"></div>
            <button class="btn" id="ctb-ver" style="align-self:end">Conferir</button><button class="btn primario" id="ctb-csv" style="align-self:end">Baixar CSV</button></div>
          <div id="ctb-res" class="small" style="margin-top:12px">Os códigos contábeis ficam em Cadastros (plano de contas e contas bancárias).</div></div></div>
      </div>
    </div>`);

  const carregarChaves = async () => {
    const lista = await api.get(`${base}/integracoes/chaves`);
    if (!ativo()) return;
    $('#chaves', alvo).innerHTML = String(html`<div class="table-wrap"><table><tbody>${lista.length ? lista.map((c) => html`<tr>
      <td><strong>${c.nome}</strong><div class="small muted mono">bpo_${c.prefixo}_…</div></td>
      <td class="small">${c.revogada_em ? html`<span class="badge">Revogada</span>` : c.ultimo_uso ? `Último uso ${dataHora(c.ultimo_uso)}` : 'Nunca usada'}</td>
      <td class="right">${!c.revogada_em && gestor() ? html`<button class="btn sm perigo" data-revogar="${c.id}">Revogar</button>` : ''}</td></tr>`)
      : html`<tr><td class="vazio">Nenhuma chave criada.</td></tr>`}</tbody></table></div>`);
    $$('[data-revogar]', alvo).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmar('Revogar chave', 'O sistema que usa esta chave deixa de conseguir enviar lançamentos.', 'Revogar'))) return;
      try { await api.del(`${base}/integracoes/chaves/${b.dataset.revogar}`); toast('Chave revogada.'); carregarChaves(); } catch (err) { toast(err.message, 'erro'); }
    }));
  };
  $('#nova-chave', alvo)?.addEventListener('click', () => modal({
    titulo: 'Nova chave de API',
    corpo: html`<label>Nome (qual sistema vai usar)</label><input name="nome" required placeholder="Ex.: ERP Omie">`,
    rotuloEnviar: 'Criar chave',
    aoEnviar: async (form, fechar) => {
      const c = await api.post(`${base}/integracoes/chaves`, dadosForm(form));
      fechar();
      carregarChaves();
      const { el } = modal({ titulo: 'Chave criada', corpo: html`<div class="alerta aviso">Copie agora: a chave não aparece de novo.</div>
        <input readonly value="${c.chave}" class="mono" id="chave-criada"><p class="small muted">Use como <code>Authorization: Bearer ${c.chave.slice(0, 18)}…</code>. Vale só para ${empresa.nome_fantasia || empresa.razao_social}.</p>` });
      $('#chave-criada', el).addEventListener('focus', (ev) => ev.target.select());
    },
  }));

  $('#arquivo-csv', alvo).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    const conteudo = utf8.includes('�') ? new TextDecoder('windows-1252').decode(bytes) : utf8;
    $('#zona-csv-texto', alvo).innerHTML = String(html`<strong>${f.name}</strong> · importando…`);
    try {
      const r = await api.post(`${base}/integracoes/lancamentos/importar`, { conteudo, arquivo: f.name });
      $('#zona-csv-texto', alvo).innerHTML = String(html`<strong>${f.name}</strong> · <span class="pos">${numero(r.importados)} lançamento(s) importado(s)</span>`);
      toast(`${r.importados} lançamento(s) importado(s).`);
    } catch (err) {
      $('#zona-csv-texto', alvo).innerHTML = String(html`<strong>${f.name}</strong> · <span class="neg">${err.message}</span>`);
    }
    e.target.value = '';
  });

  const periodo = () => ({ de: $('#ctb-de', alvo).value, ate: $('#ctb-ate', alvo).value });
  $('#ctb-ver', alvo).addEventListener('click', async () => {
    try {
      const r = await api.get(`${base}/integracoes/contabil`, periodo());
      $('#ctb-res', alvo).innerHTML = String(html`<strong>${numero(r.quantidade)} lançamento(s) contábil(eis)</strong> no período.
        ${r.sem_codigo.length ? html`<div class="alerta aviso" style="margin-top:8px">Sem código contábil (sai entre colchetes): ${r.sem_codigo.join('; ')}.</div>` : html` <span class="pos">Todos com código contábil.</span>`}`);
    } catch (err) { toast(err.message, 'erro'); }
  });
  $('#ctb-csv', alvo).addEventListener('click', () => api.baixar(`${base}/integracoes/contabil.csv`, periodo()).catch((err) => toast(err.message, 'erro')));
  await carregarChaves();
}
