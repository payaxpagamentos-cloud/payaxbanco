import { api } from '../api.js';
import { html, $, dataHora, toast, icone } from '../ui.js';

/** Conversa com a empresa cliente (o cliente responde pelo Portal). `lado`: quem está escrevendo aqui. */
export function chat(alvo, { rota, lado, titulo, vazio }) {
  alvo.innerHTML = String(html`<div class="card chat"><div class="card-head"><h2>${titulo}</h2><button class="btn sm" id="atualizar">Atualizar</button></div>
    <div class="chat-msgs" id="msgs"></div>
    <form class="chat-form" id="form-msg"><textarea name="texto" rows="2" placeholder="Escreva sua mensagem…" required></textarea>
      <button class="btn primario" type="submit">${icone('enviar')} Enviar</button></form></div>`);
  const carregar = async () => {
    const lista = await api.get(rota);
    $('#msgs', alvo).innerHTML = String(lista.length ? html`${lista.map((m) => html`<div class="msg ${m.autor === lado ? 'minha' : ''}">
      <div class="balao">${m.texto}</div><div class="small muted">${m.autor_nome ?? ''} · ${dataHora(m.criado_em)}${m.autor === lado && m.lida_em ? ' · lida' : ''}</div></div>`)}`
      : html`<div class="vazio">${vazio}</div>`);
    const caixa = $('#msgs', alvo);
    caixa.scrollTop = caixa.scrollHeight;
  };
  $('#form-msg', alvo).addEventListener('submit', async (e) => {
    e.preventDefault();
    const texto = e.target.texto.value.trim();
    if (!texto) return;
    try { await api.post(rota, { texto }); e.target.reset(); carregar(); } catch (err) { toast(err.message, 'erro'); }
  });
  $('#form-msg textarea', alvo).addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#form-msg', alvo).requestSubmit(); });
  $('#atualizar', alvo).addEventListener('click', carregar);
  return carregar();
}

export default async function mensagens({ alvo, base, empresa }) {
  await chat(alvo, { rota: `${base}/mensagens`, lado: 'equipe', titulo: `Conversa com ${empresa.nome_fantasia || empresa.razao_social}`,
    vazio: 'Nenhuma mensagem. O cliente escreve pelo Portal do Cliente.' });
  window.dispatchEvent(new Event('bpo:contadores'));
}
