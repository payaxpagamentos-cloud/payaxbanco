import { api } from '../api.js';
import { html, $, moeda, dataHora, modal, toast, dadosForm } from '../../../js/ui.js';
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
  $('#senha', alvo).onclick = () => modal({
    titulo: 'Alterar senha de acesso',
    corpo: html`<div class="form"><div class="c12"><label for="sa">Senha atual</label><input id="sa" name="senha_atual" type="password" autocomplete="current-password"></div>
      <div class="c6"><label for="ns">Nova senha</label><input id="ns" name="nova_senha" type="password" autocomplete="new-password"></div>
      <div class="c6"><label for="cs">Confirmar</label><input id="cs" name="conf" type="password" autocomplete="new-password"></div>
      <div class="c12 ajuda">Mínimo de 8 caracteres, com letras e números.</div></div>`,
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      if (d.nova_senha !== d.conf) throw new Error('As senhas não conferem.');
      await api.post('/auth/senha', d);
      fechar(); toast('Senha alterada.');
    },
  });
  $('#pin', alvo).onclick = () => modal({
    titulo: 'Alterar senha de transação',
    corpo: html`<div class="form"><div class="c12"><label for="sp">Senha de acesso</label><input id="sp" name="senha" type="password" autocomplete="current-password"></div>
      <div class="c6"><label for="np">Nova senha de transação</label><input id="np" name="novo_pin" type="password" inputmode="numeric" maxlength="6" class="pin"></div>
      <div class="c6"><label for="cp">Confirmar</label><input id="cp" name="conf" type="password" inputmode="numeric" maxlength="6" class="pin"></div></div>`,
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      if (d.novo_pin !== d.conf) throw new Error('As senhas de transação não conferem.');
      await api.post('/auth/pin', d);
      fechar(); toast('Senha de transação alterada.');
    },
  });
}
