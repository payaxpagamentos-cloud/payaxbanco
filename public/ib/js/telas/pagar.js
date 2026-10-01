import { api } from '../api.js';
import { html, $, $$, moeda, data, dataHora, mascaraMoeda, centavos, dadosForm } from '../../../js/ui.js';
import { estado, carregarResumo, seletorConta, limiteRestante, confirmarComPin, mostrarComprovante, linhaRecibo } from '../comum.js';

const SITUACAO = { processando: 'Processando', concluido: 'Pago', falhou: 'Não realizado' };

export default async function pagar(alvo) {
  await carregarResumo();
  const exemplos = estado.me?.ambiente_teste ? await api.get('/pagamentos/exemplos').catch(() => []) : [];
  const historico = await api.get('/pagamentos');
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Pagar contas</h1><p class="muted">Boletos e contas de consumo (água, luz, telefone, tributos).</p></div></div>
    <div class="grid grid-2-1">
      <div class="card card-body" id="area">
        <form id="fl" class="stack" novalidate>
          <div><label for="linha">Código de barras ou linha digitável</label>
            <textarea id="linha" name="linha" rows="3" inputmode="numeric" placeholder="Digite ou cole os números do boleto" style="min-height:80px"></textarea></div>
          ${exemplos.length ? html`<div><div class="small muted" style="margin-bottom:6px">Exemplos para teste:</div><div class="chips">${exemplos.map((x) => html`<button type="button" class="chip" data-linha="${x.linha}">${x.rotulo}</button>`)}</div></div>` : ''}
          <div class="erro-form hidden" id="erro"></div>
          <button class="btn primario" type="submit">Continuar</button>
        </form>
      </div>
      <div class="card"><div class="card-head"><h2>Pagamentos recentes</h2></div>
        ${historico.length ? historico.slice(0, 8).map((p) => html`<button type="button" class="lanc" ${p.transacao_id ? html`data-comprovante="${p.transacao_id}"` : ''}>
          <span class="txt"><strong>${p.tipo === 'boleto' ? 'Boleto' : 'Conta de consumo'}</strong><span>${dataHora(p.criado_em)} · ${SITUACAO[p.status]}</span></span>
          <span class="vl">${moeda(p.valor_centavos)}</span></button>`) : html`<div class="vazio">Nenhum pagamento ainda.</div>`}
      </div>
    </div>`);
  const fl = $('#fl', alvo);
  $$('[data-linha]', alvo).forEach((b) => b.addEventListener('click', () => { fl.linha.value = b.dataset.linha; }));
  $$('[data-comprovante]', alvo).forEach((b) => b.addEventListener('click', () => mostrarComprovante(b.dataset.comprovante)));
  fl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#erro', alvo);
    erro.classList.add('hidden');
    try {
      const b = await api.post('/pagamentos/consultar', { linha: fl.linha.value });
      revisar($('#area', alvo), b, () => pagar(alvo));
    } catch (err) { erro.textContent = err.message; erro.classList.remove('hidden'); }
  });
}

function revisar(el, b, recomecar) {
  const semValor = !b.valor_centavos;
  el.innerHTML = String(html`
    <div class="recibo" style="margin-bottom:14px">
      ${linhaRecibo('Tipo', b.tipo === 'boleto' ? `Boleto · banco ${b.banco}` : 'Conta de consumo / tributo')}
      ${linhaRecibo('Código', html`<span class="mono small">${b.linha_formatada}</span>`)}
      ${linhaRecibo('Vencimento', b.vencimento ? data(b.vencimento) : null)}
      ${semValor ? '' : linhaRecibo('Valor', moeda(b.valor_centavos))}
    </div>
    ${b.vencido ? html`<div class="card card-body small" style="background:var(--warn-bg);color:var(--warn);border:0;margin-bottom:14px">Boleto vencido. O beneficiário pode cobrar juros e multa à parte.</div>` : ''}
    <form id="fp" class="stack" novalidate>
      <div>${seletorConta()}</div>
      ${semValor ? html`<div><label for="valor-p">Valor a pagar</label><input id="valor-p" name="valor" class="moeda valor-grande" inputmode="numeric" value="0,00"></div>` : ''}
      ${limiteRestante()}
      <div class="erro-form hidden" id="erro"></div>
      <div class="row"><button type="button" class="btn" id="voltar">Voltar</button><button class="btn primario" type="submit" style="flex:1">Pagar</button></div>
    </form>`);
  const fp = $('#fp', el);
  if (semValor) mascaraMoeda(fp.valor);
  $('#voltar', el).onclick = recomecar;
  fp.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = dadosForm(fp);
    const valor = semValor ? centavos(d.valor) : b.valor_centavos;
    const erro = $('#erro', el);
    if (valor <= 0) { erro.textContent = 'Informe o valor a pagar.'; erro.classList.remove('hidden'); return; }
    const r = await confirmarComPin({
      titulo: 'Confirmar pagamento',
      resumo: html`<div class="recibo">${linhaRecibo('Valor', moeda(valor))}${linhaRecibo('Vencimento', b.vencimento ? data(b.vencimento) : null)}</div>`,
      executar: (pin) => api.post('/pagamentos', { conta_id: Number(d.conta_id), linha: b.linha_digitavel, valor_centavos: semValor ? valor : undefined, pin }),
    });
    if (!r) return;
    await mostrarComprovante(r.transacao_id, { sucesso: true });
    recomecar();
  });
}
