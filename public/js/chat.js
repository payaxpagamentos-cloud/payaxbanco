import { html, dataHora } from './ui.js';

/**
 * Mensagens de uma conversa em balões. `lado`: quem está vendo ('cliente' ou 'gerente').
 * `meuNome`: na equipe, mensagens escritas por outra pessoa (ex.: o administrador vendo a conversa de um gerente) mostram o nome dela.
 */
export function baloes(mensagens, { lado, nomeOutro, meuNome }) {
  if (!mensagens.length) return html`<div class="chat-vazio">Nenhuma mensagem ainda. Escreva a primeira.</div>`;
  return html`${mensagens.map((m) => {
    const minha = m.autor === lado;
    const quem = minha ? (meuNome && m.usuario_nome && m.usuario_nome !== meuNome ? m.usuario_nome : 'Você') : (m.autor === 'gerente' ? (m.usuario_nome ?? nomeOutro) : nomeOutro);
    return html`<div class="msg ${minha ? 'minha' : 'dele'}"><div class="msg-balao">${m.texto}</div>
      <div class="msg-meta">${quem} · ${dataHora(m.criado_em)}${minha && m.lida_em ? ' · lida' : ''}</div></div>`;
  })}`;
}

/** Leva a lista de mensagens até a mais recente. */
export function rolarFim(el) {
  if (el) el.scrollTop = el.scrollHeight;
}

/** Formata minutos como "12 min", "2 h 5 min" ou "1 d 3 h". */
export function duracao(min) {
  if (min === null || min === undefined) return '—';
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  if (min < 1440) return `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;
  return `${Math.floor(min / 1440)} d ${Math.round((min % 1440) / 60)} h`;
}
