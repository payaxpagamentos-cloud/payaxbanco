/** Assistente da frota: botão fixo no canto das telas da empresa, com a conversa guardada enquanto a página estiver aberta. */
import { api } from './api.js';
import { el, limpar, icone } from './ui.js';

const conversas = new Map(); // empresaId → [{ papel, texto }]
const situacoes = new Map(); // empresaId → { dados, em }
let aberto = false;
const SUGESTOES = [
  'Onde estão meus veículos agora?',
  'Quem dirigiu pior este mês e por quê?',
  'Quanto gastei de combustível este mês?',
  'Teve algum alerta de segurança esta semana?',
];

async function situacao(empresaId) {
  const s = situacoes.get(empresaId);
  if (s && Date.now() - s.em < 5 * 60_000) return s.dados;
  const dados = await api.get(`/empresas/${empresaId}/assistente`);
  situacoes.set(empresaId, { dados, em: Date.now() });
  return dados;
}

/** Texto da resposta com **negrito**, listas com "- " e links clicáveis, montado sem HTML vindo de fora. */
function formatar(texto) {
  const bloco = el('div', { class: 'texto-assistente' });
  let lista = null;
  const linha = (t) => {
    const partes = [];
    const re = /(\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g;
    let ultimo = 0;
    for (const m of t.matchAll(re)) {
      if (m.index > ultimo) partes.push(t.slice(ultimo, m.index));
      const x = m[0];
      partes.push(x.startsWith('**') ? el('strong', {}, x.slice(2, -2)) : el('a', { href: x, target: '_blank', rel: 'noopener' }, x.includes('google.com/maps') ? 'abrir no mapa' : x));
      ultimo = m.index + x.length;
    }
    if (ultimo < t.length) partes.push(t.slice(ultimo));
    return partes;
  };
  for (const l of String(texto).split('\n')) {
    const item = /^\s*[-•*]\s+(.*)$/.exec(l);
    if (item) {
      if (!lista) { lista = el('ul'); bloco.append(lista); }
      lista.append(el('li', {}, linha(item[1])));
    } else {
      lista = null;
      if (l.trim()) bloco.append(el('p', {}, linha(l)));
    }
  }
  return bloco;
}

export async function montarAssistente(raiz, ctx) {
  let s;
  try { s = await situacao(ctx.empresaId); } catch { return; }
  if (!s.ligado) return;
  const conversa = conversas.get(ctx.empresaId) ?? [];
  conversas.set(ctx.empresaId, conversa);

  const mensagens = el('div', { class: 'assistente-mensagens', 'aria-live': 'polite' });
  const restantes = el('span', { class: 'pequeno' });
  const entrada = el('textarea', { rows: 1, maxlength: 2000, placeholder: 'Pergunte sobre a sua frota…', 'aria-label': 'Pergunta ao assistente' });
  const enviar = el('button', { class: 'btn primario', type: 'submit', title: 'Enviar', 'aria-label': 'Enviar' }, icone('navegacao'));
  const form = el('form', { class: 'assistente-form' }, entrada, enviar);
  const painel = el('section', { class: `assistente-painel${aberto ? '' : ' oculto'}`, role: 'dialog', 'aria-label': 'Assistente da frota' },
    el('header', {}, el('div', {}, el('strong', {}, 'Assistente'), restantes),
      el('div', { class: 'linha', style: 'gap:2px' },
        el('button', { class: 'icone-btn', type: 'button', title: 'Nova conversa', onclick: () => { conversa.length = 0; desenhar(); } }, icone('historico')),
        el('button', { class: 'icone-btn', type: 'button', title: 'Fechar', onclick: () => alternar(false) }, icone('fechar')))),
    mensagens, form,
    el('p', { class: 'assistente-rodape' }, 'Só consulta os dados da sua empresa. Para bloquear ou mandar comandos, use os botões do painel.'));
  const botao = el('button', { class: `assistente-botao${aberto ? ' aberto' : ''}`, type: 'button', title: 'Assistente da frota', 'aria-label': 'Abrir o assistente' },
    icone('pergunta'), el('span', {}, 'Assistente'));

  const atualizarRestantes = () => { restantes.textContent = `${s.restantes} de ${s.limite} perguntas hoje`; };
  function alternar(estado = !aberto) {
    aberto = estado;
    painel.classList.toggle('oculto', !aberto);
    botao.classList.toggle('aberto', aberto);
    if (aberto) { entrada.focus(); mensagens.scrollTop = mensagens.scrollHeight; }
  }
  function desenhar(pensando = false, erro = null) {
    limpar(mensagens,
      conversa.length ? null : el('div', { class: 'assistente-boas-vindas' },
        el('p', {}, 'Pergunte sobre a frota: onde um veículo estava, trajetos, alertas, nota dos motoristas, custos e manutenção.'),
        el('div', { class: 'chips' }, SUGESTOES.map((t) => el('button', { type: 'button', class: 'chip', onclick: () => perguntar(t) }, t)))),
      conversa.map((m) => el('div', { class: `bolha ${m.papel}` }, m.papel === 'assistente' ? formatar(m.texto) : m.texto)),
      pensando ? el('div', { class: 'bolha assistente pensando' }, el('span'), el('span'), el('span')) : null,
      erro ? el('div', { class: 'bolha erro' }, erro) : null);
    mensagens.scrollTop = mensagens.scrollHeight;
  }
  async function perguntar(texto) {
    const pergunta = texto.trim();
    if (!pergunta || enviar.disabled) return;
    const historico = conversa.slice();
    conversa.push({ papel: 'usuario', texto: pergunta });
    entrada.value = '';
    enviar.disabled = true;
    desenhar(true);
    try {
      const r = await api.post(`/empresas/${ctx.empresaId}/assistente`, { pergunta, historico });
      conversa.push({ papel: 'assistente', texto: r.resposta });
      Object.assign(s, { restantes: r.restantes, limite: r.limite });
      situacoes.set(ctx.empresaId, { dados: s, em: Date.now() });
      atualizarRestantes();
      desenhar();
    } catch (err) {
      conversa.pop();
      entrada.value = pergunta;
      desenhar(false, err.message);
    } finally {
      enviar.disabled = false;
      if (aberto) entrada.focus();
    }
  }
  botao.addEventListener('click', () => alternar());
  form.addEventListener('submit', (e) => { e.preventDefault(); perguntar(entrada.value); });
  entrada.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); perguntar(entrada.value); } });
  entrada.addEventListener('input', () => { entrada.style.height = 'auto'; entrada.style.height = `${Math.min(120, entrada.scrollHeight)}px`; });
  atualizarRestantes();
  desenhar();
  raiz.append(botao, painel);
}
