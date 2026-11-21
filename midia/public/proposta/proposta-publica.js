/**
 * A proposta vista por quem recebeu o link (no WhatsApp, por e-mail, como for).
 *
 * É a mesma folha do painel, sem login e sem nada do sistema em volta: o cliente abre no celular,
 * lê e salva em PDF ali mesmo, pelo "imprimir" do próprio navegador. O link é aleatório e só mostra
 * esta proposta — nenhum outro dado da rede vem junto.
 */
import { el, limpar, icone } from '../js/ui.js';
import { BASE } from '../js/api.js';
import { montarFolha } from '../js/proposta.js';

const pagina = document.getElementById('pagina');
const token = new URLSearchParams(location.search).get('p');

const recado = (titulo, texto) => limpar(pagina, el('div', { class: 'cartao', style: 'max-width:520px;margin:48px auto;text-align:center' },
  el('h2', {}, titulo),
  el('p', { class: 'mudo' }, texto)));

(async () => {
  if (!token) return recado('Link incompleto', 'Peça o link da proposta de novo a quem enviou.');
  try {
    const r = await fetch(`${BASE}/api/publico/proposta/${encodeURIComponent(token)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro ?? 'não foi possível abrir');

    document.title = `Proposta ${d.numero} — ${d.folha.plataforma.nome}`;
    limpar(pagina,
      el('div', { class: 'acoes-folha' },
        el('button', { class: 'btn primario', onclick: () => window.print() }, icone('baixar'), 'Salvar em PDF / imprimir')),
      // A proposta continua visível depois do prazo, mas com o aviso: preço vencido não vira surpresa.
      d.expirada
        ? el('p', { class: 'aviso aviso-validade' },
          `O prazo desta proposta terminou em ${new Date(`${d.valida_ate}T12:00:00`).toLocaleDateString('pt-BR')}. `
          + 'Fale com a gente para atualizar os valores.')
        : null,
      montarFolha(d.folha, d.observacao, { numero: d.numero }));
  } catch (err) {
    recado('Proposta não encontrada', `${err.message}. O link pode ter sido digitado errado ou a proposta foi cancelada.`);
  }
})();
