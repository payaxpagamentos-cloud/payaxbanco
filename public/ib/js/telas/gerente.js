import { api } from '../api.js';
import { html, $, iniciais, toast } from '../../../js/ui.js';
import { baloes, rolarFim } from '../../../js/chat.js';
import { atualizarAvisoGerente } from '../comum.js';

/** Meu gerente: nome do gerente de relacionamento e conversa com ele (sem gerente: Atendimento PAY AX). */
export default async function gerente(alvo) {
  const { gerentes } = await api.get('/gerente');
  let atual = gerentes[0] ?? null;

  async function desenhar() {
    const conv = await api.get('/mensagens', atual ? { gerente_id: atual.id } : {});
    const nome = atual?.nome ?? 'Atendimento PAY AX';
    const primeiro = atual ? nome.split(' ')[0] : 'Atendimento';
    alvo.innerHTML = String(html`
      <div class="page-head"><div><h1>Meu gerente</h1><p class="muted">Converse com quem cuida da sua conta na PAY AX.</p></div></div>
      <div class="card card-body gerente-cartao">
        <span class="avatar grande">${atual ? iniciais(nome) : 'PA'}</span>
        <div><div class="small muted">${atual ? 'Seu gerente de relacionamento' : 'Sua conta ainda não tem um gerente definido'}</div>
          <strong class="gerente-nome">${nome}</strong>
          <div class="small muted">Respostas em dias úteis, no horário comercial. Não envie senhas nem códigos por aqui.</div></div>
        ${gerentes.length > 1 ? html`<select id="ger" aria-label="Gerente">${gerentes.map((g) => html`<option value="${g.id}" ${g.id === atual.id ? 'selected' : ''}>${g.nome}</option>`)}</select>` : ''}
      </div>
      <div class="card card-body" style="margin-top:16px">
        <div class="chat-lista" id="chat-lista">${baloes(conv.mensagens, { lado: 'cliente', nomeOutro: primeiro })}</div>
        <form class="chat-envio" id="chat-form" novalidate>
          <textarea id="chat-texto" maxlength="2000" placeholder="Escreva sua mensagem para ${primeiro}…" aria-label="Mensagem"></textarea>
          <button class="btn primario" type="submit">Enviar</button></form>
      </div>`);
    rolarFim($('#chat-lista', alvo));
    atualizarAvisoGerente();
    const sel = $('#ger', alvo);
    if (sel) sel.onchange = () => { atual = gerentes.find((g) => g.id === Number(sel.value)); desenhar(); };
    const texto = $('#chat-texto', alvo);
    texto.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#chat-form', alvo).requestSubmit(); });
    $('#chat-form', alvo).addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!texto.value.trim()) return;
      const botao = e.target.querySelector('button');
      botao.disabled = true;
      try {
        await api.post('/mensagens', { texto: texto.value, ...(atual ? { gerente_id: atual.id } : {}) });
        toast('Mensagem enviada.');
        await desenhar();
        $('#chat-texto', alvo)?.focus();
      } catch (err) { toast(err.message, 'erro'); botao.disabled = false; }
    });
  }
  await desenhar();
}
