import { api } from '../api.js';
import { html, $, moeda, dataHora, modal, toast } from '../../../js/ui.js';
import { tecladoPares, criarSenhaNova } from '../teclado.js';
import { estado, carregarResumo, rotuloConta } from '../comum.js';

export default async function perfil(alvo, sair) {
  await carregarResumo();
  const me = estado.me;
  const l = estado.resumo.limite;
  alvo.innerHTML = String(html`
    <div class="page-head"><div><h1>Meu perfil</h1></div></div>
    <div class="grid grid-2">
      <div class="card card-body"><dl class="dl" style="grid-template-columns:1fr">
        <div><dt>Nome</dt><dd>${me.nome}</dd></div><div><dt>${me.documento.length === 11 ? 'CPF' : 'CNPJ'}</dt><dd>${me.documento_mascarado}</dd></div>
        <div><dt>Contas</dt><dd>${estado.resumo.contas.map((c) => html`<div>${rotuloConta(c)}</div>`)}</dd></div>
        <div><dt>Limite diário (PIX, transferências e pagamentos)</dt><dd>${moeda(l.limite_centavos)} <span class="small muted">· para alterar, fale com a PAY AX</span></dd></div>
        <div><dt>Acesso anterior</dt><dd>${dataHora(me.ultimo_acesso)}</dd></div></dl></div>
      <div class="card card-body stack"><h2>Segurança</h2>
        <button class="btn" id="senha">Alterar senha de acesso</button>
        <button class="btn" id="pin">Alterar senha de transação</button>
        <button class="btn perigo" id="sair">Sair</button>
        <p class="small muted" style="margin:0">A PAY AX nunca pede sua senha por telefone, e-mail ou mensagem. Sua sessão é encerrada após 10 minutos sem uso.</p></div>
    </div>`);
  $('#sair', alvo).onclick = sair;
  $('#senha', alvo).onclick = () => trocar('senha');
  $('#pin', alvo).onclick = () => trocar('pin');
}

/** Troca de senha: confirma a senha de acesso atual no teclado de pares e cria a nova no teclado simples. */
function trocar(qual) {
  const ehPin = qual === 'pin';
  const nome = ehPin ? 'senha de transação' : 'senha de acesso';
  let teclado;
  let atual;
  const { el, fechar } = modal({
    titulo: `Alterar ${nome}`,
    corpo: html`<div class="erro-form hidden" id="erro-troca"></div><div id="etapa-troca"></div>`,
    rodape: html`<div class="modal-foot"><button class="btn" data-cancelar>Cancelar</button><button class="btn primario" id="continuar">Continuar</button></div>`,
    aoAbrir: (m) => { teclado = tecladoPares($('#etapa-troca', m), { rotulo: 'Para continuar, digite sua senha de acesso atual' }); },
  });
  const erro = $('#erro-troca', el);
  const continuar = $('#continuar', el);
  continuar.onclick = async () => {
    if (!teclado.completo()) { erro.textContent = 'Digite os 6 números da senha de acesso.'; erro.classList.remove('hidden'); return; }
    atual = teclado.valor();
    erro.classList.add('hidden');
    continuar.hidden = true;
    const nova = await criarSenhaNova($('#etapa-troca', el), { rotulo: `nova ${nome}` });
    $('#etapa-troca', el).innerHTML = '<div class="carregando">Salvando…</div>';
    try {
      if (ehPin) await api.post('/auth/pin', { senha: atual, novo_pin: nova });
      else await api.post('/auth/senha', { senha_atual: atual, nova_senha: nova });
      fechar();
      toast(`${ehPin ? 'Senha de transação' : 'Senha de acesso'} alterada.`);
    } catch (err) {
      erro.textContent = err.message;
      erro.classList.remove('hidden');
      continuar.hidden = false;
      teclado = tecladoPares($('#etapa-troca', el), { rotulo: 'Digite sua senha de acesso atual' });
    }
  };
}
