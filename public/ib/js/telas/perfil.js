import { api } from '../api.js';
import { html, $, moeda, dataHora, modal, toast, dadosForm } from '../../../js/ui.js';
import { tecladoPares, criarSenhaNova } from '../teclado.js';
import { estado, carregarResumo, rotuloConta, confirmarComPin, linhaRecibo } from '../comum.js';

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
        <div><dt>Gerente de relacionamento</dt><dd>${estado.resumo.gerentes.map((g) => g.nome).join(' · ') || 'Atendimento PAY AX'} <a class="small" href="#/gerente">· enviar mensagem</a></dd></div>
        <div><dt>Limite diário (PIX, transferências e pagamentos)</dt><dd>${moeda(l.limite_centavos)} <span class="small muted">· para alterar, fale com a PAY AX</span></dd></div>
        <div><dt>Acesso anterior</dt><dd>${dataHora(me.ultimo_acesso)}</dd></div></dl></div>
      <div class="card card-body stack"><h2>Segurança</h2>
        <button class="btn" id="senha">Alterar senha de acesso</button>
        <button class="btn" id="pin">Alterar senha de transação</button>
        <button class="btn perigo" id="sair">Sair</button>
        <p class="small muted" style="margin:0">A PAY AX nunca pede sua senha por telefone, e-mail ou mensagem. Sua sessão é encerrada após 10 minutos sem uso.</p></div>
    </div>
    <div class="card card-body stack" style="margin-top:16px" id="solicitacoes"><div class="row" style="justify-content:space-between">
      <div><h2>Encerramento de conta</h2><p class="small muted" style="margin:4px 0 0">O pedido é analisado pela Ouvidoria da PAY AX. Transfira o saldo antes de pedir.</p></div>
      <button class="btn perigo" id="encerrar">Solicitar encerramento</button></div>
      <div id="lista-sol"></div></div>`);
  $('#encerrar', alvo).onclick = () => pedirEncerramento(() => listarSolicitacoes(alvo));
  listarSolicitacoes(alvo);
  $('#sair', alvo).onclick = sair;
  $('#senha', alvo).onclick = () => trocar('senha');
  $('#pin', alvo).onclick = () => trocar('pin');
}

const SITUACAO = { em_analise: ['Em análise', 'warn'], aprovada: ['Concluída', 'ok'], recusada: ['Não aprovada', 'danger'], cancelada: ['Cancelada', ''] };

async function listarSolicitacoes(alvo) {
  const el = $('#lista-sol', alvo);
  try {
    const lista = await api.get('/solicitacoes');
    el.innerHTML = String(lista.length ? html`<div class="table-wrap"><table><thead><tr><th>Protocolo</th><th>Pedido</th><th>Conta</th><th>Aberto em</th><th>Situação</th></tr></thead><tbody>
      ${lista.map((s) => html`<tr><td class="mono small">${s.protocolo}</td><td>${s.tipo}</td><td class="mono small">${s.conta ?? '—'}</td><td class="small">${dataHora(s.criado_em)}</td>
        <td><span class="badge ${SITUACAO[s.status][1]}">${SITUACAO[s.status][0]}</span></td></tr>`)}</tbody></table></div>` : '');
  } catch { el.innerHTML = ''; }
}

const MOTIVOS = ['Vou usar outro banco', 'Não uso mais a conta', 'Insatisfação com o atendimento ou serviço', 'Tarifas', 'Outro motivo'];

function pedirEncerramento(aoConcluir) {
  const contas = estado.resumo.contas;
  modal({
    titulo: 'Solicitar encerramento de conta',
    rotuloEnviar: 'Continuar',
    corpo: html`<div class="stack" style="gap:12px">
      <div><label for="enc-conta">Conta</label><select id="enc-conta" name="conta_id">${contas.map((c) => html`<option value="${c.id}">${rotuloConta(c)} · saldo ${moeda(c.saldo_centavos)}</option>`)}</select></div>
      <div><label for="enc-motivo">Motivo</label><select id="enc-motivo" name="motivo">${MOTIVOS.map((m) => html`<option>${m}</option>`)}</select></div>
      <div><label for="enc-det">Conte mais (opcional)</label><textarea id="enc-det" name="detalhes" maxlength="500"></textarea></div>
      <p class="small muted" style="margin:0">Antes do encerramento, a conta precisa estar com saldo zerado e sem empréstimos em aberto. A Ouvidoria analisa o pedido e pode entrar em contato com você.</p></div>`,
    aoEnviar: async (form, fechar) => {
      const d = dadosForm(form);
      const conta = contas.find((c) => String(c.id) === d.conta_id);
      const motivo = d.detalhes?.trim() ? `${d.motivo}: ${d.detalhes.trim()}` : d.motivo;
      fechar();
      const r = await confirmarComPin({
        titulo: 'Confirmar pedido de encerramento',
        resumo: html`<div class="recibo">${linhaRecibo('Conta', rotuloConta(conta))}${linhaRecibo('Motivo', motivo)}</div>`,
        executar: (pin) => api.post('/solicitacoes/encerramento', { conta_id: conta.id, motivo, pin }),
      });
      if (!r) return;
      modal({
        titulo: 'Pedido enviado',
        corpo: html`<div class="sucesso"><p style="margin:0">Seu pedido de encerramento foi enviado para a Ouvidoria.</p>
          <div class="protocolo" style="margin-top:14px"><span>Protocolo</span><strong>${r.protocolo}</strong></div>
          <p class="small muted">Acompanhe a situação aqui em Meu perfil.</p></div>`,
        rodape: html`<div class="modal-foot"><button class="btn primario" data-cancelar>Entendi</button></div>`,
      });
      aoConcluir();
    },
  });
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
