import { api } from '../api.js';
import { html, raw, $, $$, moeda, dataHora, toast, mascaraMoeda, centavos, confirmar, modal, dadosForm } from '../../../js/ui.js';
import limites from './limites.js';
import { estado, carregarResumo, rotuloConta, seletorConta, limiteRestante, confirmarComPin, mostrarComprovante, linhaRecibo } from '../comum.js';

const ABAS = [['enviar', 'Enviar'], ['receber', 'Receber'], ['chaves', 'Minhas chaves'], ['limites', 'Meus limites']];

export default async function pix(alvo, sub = 'enviar') {
  await carregarResumo();
  const aba = ABAS.some(([k]) => k === sub) ? sub : 'enviar';
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>PIX</h1><p class="muted">Transferências instantâneas, 24 horas por dia.</p></div></div>
    <div class="tabs">${ABAS.map(([k, r]) => html`<button class="${k === aba ? 'ativo' : ''}" data-aba="${k}">${r}</button>`)}</div>
    <div id="aba"></div>`);
  $$('[data-aba]', alvo).forEach((b) => b.addEventListener('click', () => { location.hash = `#/pix/${b.dataset.aba}`; }));
  const el = $('#aba', alvo);
  if (aba === 'enviar') return enviar(el);
  if (aba === 'receber') return receber(el);
  if (aba === 'limites') return limites(el);
  return chaves(el);
}

async function enviar(el) {
  const favs = (await api.get('/favorecidos').catch(() => [])).filter((f) => f.tipo === 'pix');
  el.innerHTML = String(html`<div class="card card-body" style="max-width:560px">
    <div class="passos"><span class="feito"></span><span></span><span></span></div>
    <form id="f1" class="stack" novalidate>
      ${favs.length ? html`<div><div class="small muted" style="margin-bottom:6px">Seus favorecidos</div><div class="chips">${favs.map((f) => html`<button type="button" class="chip" data-fav="${f.chave}">${f.apelido || f.nome || f.chave}</button>`)}</div></div>` : ''}
      <div><label for="chave">Para quem você quer enviar?</label><input id="chave" name="chave" placeholder="CPF/CNPJ, e-mail, celular ou chave aleatória" autocomplete="off" required></div>
      <div class="erro-form hidden" id="erro"></div>
      <button class="btn primario" type="submit">Continuar</button>
    </form></div>`);
  const f1 = $('#f1', el);
  $$('[data-fav]', el).forEach((b) => b.addEventListener('click', () => { f1.chave.value = b.dataset.fav; f1.requestSubmit(); }));
  setTimeout(() => f1.chave.focus(), 30);
  f1.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#erro', el);
    erro.classList.add('hidden');
    try {
      const dest = await api.post('/pix/destinatario', { chave: f1.chave.value });
      passoValor(el, dest, f1.chave.value);
    } catch (err) { erro.textContent = err.message; erro.classList.remove('hidden'); }
  });
}

function passoValor(el, dest, chaveDigitada) {
  el.innerHTML = String(html`<div class="card card-body" style="max-width:560px">
    <div class="passos"><span class="feito"></span><span class="feito"></span><span></span></div>
    <div class="destinatario"><span class="avatar">${(dest.nome ?? '?')[0]}</span><div><strong>${dest.nome ?? dest.chave}</strong>
      <div class="small muted">${dest.interno ? `${dest.documento} · ${dest.instituicao}` : `Chave ${dest.chave} · ${dest.instituicao}`}</div></div></div>
    <form id="f2" class="stack" style="margin-top:16px" novalidate>
      <div>${seletorConta()}</div>
      <div><label for="valor">Valor</label><input id="valor" name="valor" class="moeda valor-grande" inputmode="numeric" value="0,00">${limiteRestante()}</div>
      <div><label for="descricao">Mensagem (opcional)</label><input id="descricao" name="descricao" maxlength="140"></div>
      <div class="erro-form hidden" id="erro"></div>
      <div class="row"><button class="btn" type="button" id="voltar">Voltar</button><button class="btn primario" type="submit" style="flex:1">Revisar PIX</button></div>
    </form></div>`);
  const f2 = $('#f2', el);
  mascaraMoeda(f2.valor);
  setTimeout(() => f2.valor.focus(), 30);
  $('#voltar', el).onclick = () => enviar(el);
  f2.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#erro', el);
    erro.classList.add('hidden');
    const valor = centavos(f2.valor.value);
    if (valor <= 0) { erro.textContent = 'Informe um valor maior que zero.'; erro.classList.remove('hidden'); return; }
    const d = dadosForm(f2);
    const r = await confirmarComPin({
      titulo: 'Confirmar PIX',
      resumo: html`<div class="recibo">${linhaRecibo('Valor', moeda(valor))}${linhaRecibo('Para', dest.nome ?? dest.chave)}${linhaRecibo('Instituição', dest.instituicao)}${linhaRecibo('Chave', dest.chave)}${linhaRecibo('Mensagem', d.descricao)}</div>`,
      executar: (pin) => api.post('/pix', { conta_id: Number(d.conta_id), chave: chaveDigitada, valor_centavos: valor, descricao: d.descricao, pin }),
    });
    if (!r) return;
    await mostrarComprovante(r.transacao_id, { sucesso: true });
    await carregarResumo();
    enviar(el);
  });
}

function receber(el) {
  el.innerHTML = String(html`<div class="grid grid-2">
    <div class="card card-body"><h2>Cobrar com QR Code</h2><p class="muted small" style="margin:4px 0 14px">Gere um QR Code com valor. Quem pagar pode usar qualquer banco.</p>
      <form id="fq" class="stack" novalidate>
        <div><label for="conta-rec">Receber na conta</label><select id="conta-rec" name="conta_id">${estado.resumo.contas.filter((c) => c.status === 'ativa').map((c) => html`<option value="${c.id}" ${c.id === estado.contaId ? 'selected' : ''}>${rotuloConta(c)}</option>`)}</select></div>
        <div><label for="valor-rec">Valor</label><input id="valor-rec" name="valor" class="moeda valor-grande" inputmode="numeric" value="0,00"></div>
        <div class="erro-form hidden" id="erro"></div>
        <button class="btn primario" type="submit">Gerar QR Code</button>
      </form></div>
    <div class="card card-body" id="qr-area"><h2>Suas chaves</h2><p class="muted small" style="margin:4px 0 0">Para receber sem valor definido, informe uma das suas chaves PIX ao pagador.</p><div id="chaves-rec" style="margin-top:10px"></div></div>
  </div>`);
  const fq = $('#fq', el);
  mascaraMoeda(fq.valor);
  api.get('/pix/chaves').then((ks) => {
    $('#chaves-rec', el).innerHTML = String(ks.length ? html`${ks.map((k) => html`<div class="destinatario" style="margin-bottom:8px"><span class="badge info">${k.tipo.toUpperCase()}</span><span class="mono small" style="word-break:break-all">${k.chave}</span></div>`)}`
      : html`<p class="small">Você ainda não tem chaves. <a href="#/pix/chaves">Cadastrar agora</a></p>`);
  });
  fq.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#erro', el);
    erro.classList.add('hidden');
    try {
      const valor = centavos(fq.valor.value);
      if (valor <= 0) throw new Error('Informe um valor maior que zero.');
      const c = await api.post('/pix/cobrancas', { conta_id: Number(fq.conta_id.value), valor_centavos: valor });
      mostrarQr(c);
    } catch (err) { erro.textContent = err.message; erro.classList.remove('hidden'); }
  });
}

function mostrarQr(c) {
  const simulador = estado.me?.ambiente_teste;
  const { el, fechar } = modal({
    titulo: `Receber ${moeda(c.valor_centavos)}`,
    corpo: html`<div class="stack" style="align-items:center;text-align:center">
      <div class="qr-pix">${raw(c.qr_svg)}</div>
      <div style="width:100%;text-align:left"><label for="copia">PIX copia e cola</label>
        <div class="row" style="flex-wrap:nowrap"><input id="copia" readonly value="${c.pix_copia_e_cola}" class="mono small"><button type="button" class="btn" id="copiar">Copiar</button></div>
        <div class="ajuda">Válido até ${dataHora(c.expira_em)}. O valor entra na sua conta assim que o pagamento for confirmado.</div></div></div>`,
    rodape: html`<div class="modal-foot">${simulador ? html`<button class="btn ouro" id="simular">Simular pagamento (teste)</button>` : ''}<button class="btn primario" data-cancelar>Fechar</button></div>`,
  });
  $('#copiar', el).onclick = async () => {
    try { await navigator.clipboard.writeText(c.pix_copia_e_cola); toast('Código copiado.'); } catch { $('#copia', el).select(); toast('Selecione e copie o código.'); }
  };
  const s = $('#simular', el);
  if (s) s.onclick = async () => {
    s.disabled = true;
    try {
      await api.post(`/pix/cobrancas/${c.txid}/simular-pagamento`);
      fechar();
      toast(`Você recebeu ${moeda(c.valor_centavos)}.`);
      await carregarResumo();
    } catch (err) { toast(err.message, 'erro'); s.disabled = false; }
  };
}

async function chaves(el) {
  const ks = await api.get('/pix/chaves');
  const pj = estado.me.documento.length === 14;
  el.innerHTML = String(html`<div class="card" style="max-width:720px">
    <div class="card-head"><h2>Minhas chaves PIX</h2><button class="btn sm primario" id="nova">+ Cadastrar chave</button></div>
    ${ks.length ? ks.map((k) => html`<div class="lanc" style="cursor:default"><span class="badge info">${k.tipo.toUpperCase()}</span>
      <span class="txt"><strong class="mono" style="word-break:break-all">${k.chave}</strong><span>Conta ${k.numero}-${k.digito}</span></span>
      <button class="btn sm perigo" data-excluir="${k.id}">Excluir</button></div>`)
      : html`<div class="vazio">Cadastre uma chave para receber PIX com facilidade.</div>`}
  </div>`);
  $$('[data-excluir]', el).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmar('Excluir chave', 'Você deixará de receber PIX por esta chave. Continuar?', 'Excluir'))) return;
    try { await api.del(`/pix/chaves/${b.dataset.excluir}`); toast('Chave excluída.'); chaves(el); } catch (err) { toast(err.message, 'erro'); }
  }));
  $('#nova', el).onclick = () => modal({
    titulo: 'Cadastrar chave PIX',
    rotuloEnviar: 'Cadastrar',
    corpo: html`<div class="form">
      <div class="c12"><label for="conta-k">Conta</label><select id="conta-k" name="conta_id">${estado.resumo.contas.filter((c) => c.status === 'ativa').map((c) => html`<option value="${c.id}">${rotuloConta(c)}</option>`)}</select></div>
      <div class="c12"><label for="tipo-k">Tipo de chave</label><select id="tipo-k" name="tipo">
        <option value="${pj ? 'cnpj' : 'cpf'}">${pj ? 'CNPJ' : 'CPF'}</option><option value="email">E-mail</option><option value="telefone">Celular</option><option value="aleatoria">Chave aleatória</option></select></div>
      <div class="c12" id="campo-k" hidden><label for="valor-k">Chave</label><input id="valor-k" name="chave"></div></div>`,
    aoAbrir: (m) => {
      const t = $('#tipo-k', m);
      t.onchange = () => { $('#campo-k', m).hidden = !['email', 'telefone'].includes(t.value); };
    },
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      await api.post('/pix/chaves', { conta_id: Number(d.conta_id), tipo: d.tipo, chave: d.chave });
      fechar(); toast('Chave cadastrada.'); chaves(el);
    },
  });
}
