import { api } from '../api.js';
import { html, $, moeda, mascaraMoeda, centavos, dadosForm } from '../../../js/ui.js';
import { carregarResumo, seletorConta, limiteRestante, confirmarComPin, mostrarComprovante, linhaRecibo } from '../comum.js';

export default async function transferir(alvo) {
  await carregarResumo();
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Transferir</h1><p class="muted">Entre contas PAY AX, na hora. Para outros bancos, use o <a href="#/pix">PIX</a>.</p></div></div>
    <div class="card card-body" style="max-width:560px" id="area"></div>`);
  passoDestino($('#area', alvo));
}

function passoDestino(el) {
  el.innerHTML = String(html`<div class="passos"><span class="feito"></span><span></span></div>
    <form id="fd" class="form" novalidate>
      <div class="c4"><label for="ag">Agência</label><input id="ag" name="agencia" value="0001" inputmode="numeric"></div>
      <div class="c8"><label for="num">Conta com dígito</label><input id="num" name="numero" placeholder="100001-2" required></div>
      <div class="c12 erro-form hidden" id="erro"></div>
      <div class="c12"><button class="btn primario" type="submit" style="width:100%">Continuar</button></div>
    </form>`);
  const fd = $('#fd', el);
  setTimeout(() => fd.numero.focus(), 30);
  fd.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#erro', el);
    erro.classList.add('hidden');
    try {
      const dest = await api.post('/transferencias/destinatario', { agencia: fd.agencia.value, numero: fd.numero.value });
      passoValor(el, dest, fd.agencia.value, fd.numero.value);
    } catch (err) { erro.textContent = err.message; erro.classList.remove('hidden'); }
  });
}

function passoValor(el, dest, agencia, numero) {
  el.innerHTML = String(html`<div class="passos"><span class="feito"></span><span class="feito"></span></div>
    <div class="destinatario"><span class="avatar">${dest.nome[0]}</span><div><strong>${dest.nome}</strong><div class="small muted">${dest.documento} · PAY AX ${dest.conta}</div></div></div>
    <form id="fv" class="stack" style="margin-top:16px" novalidate>
      <div>${seletorConta()}</div>
      <div><label for="valor-t">Valor</label><input id="valor-t" name="valor" class="moeda valor-grande" inputmode="numeric" value="0,00">${limiteRestante()}</div>
      <div><label for="desc-t">Descrição (opcional)</label><input id="desc-t" name="descricao" maxlength="140"></div>
      <div class="erro-form hidden" id="erro"></div>
      <div class="row"><button class="btn" type="button" id="voltar">Voltar</button><button class="btn primario" type="submit" style="flex:1">Revisar</button></div>
    </form>`);
  const fv = $('#fv', el);
  mascaraMoeda(fv.valor);
  $('#voltar', el).onclick = () => passoDestino(el);
  fv.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = dadosForm(fv);
    const valor = centavos(d.valor);
    const erro = $('#erro', el);
    if (valor <= 0) { erro.textContent = 'Informe um valor maior que zero.'; erro.classList.remove('hidden'); return; }
    const r = await confirmarComPin({
      titulo: 'Confirmar transferência',
      resumo: html`<div class="recibo">${linhaRecibo('Valor', moeda(valor))}${linhaRecibo('Para', dest.nome)}${linhaRecibo('Conta', `PAY AX ${dest.conta}`)}${linhaRecibo('Descrição', d.descricao)}</div>`,
      executar: (pin) => api.post('/transferencias', { conta_id: Number(d.conta_id), destino_agencia: agencia, destino_numero: numero, valor_centavos: valor, descricao: d.descricao, pin }),
    });
    if (!r) return;
    await mostrarComprovante(r.transacao_id, { sucesso: true });
    passoDestino(el);
  });
}
