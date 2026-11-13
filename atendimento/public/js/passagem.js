/**
 * A passagem de bastão da ZOE para a pessoa: quem é o cliente, o que ele pediu, o que a ZOE já
 * fez e o que pede atenção. Aparece em dois lugares:
 *   - no painel lateral da conversa (qualquer canal), no lugar do antigo "A ZOE passou assim";
 *   - num aviso que abre sozinho, em qualquer tela, quando uma ligação é atendida no ramal de
 *     quem está logado. O atendente lê enquanto diz "alô".
 */
import {api} from './api.js';
import {el, icone, hora, modal, telefone as formatarTelefone} from './ui.js';

const NOMES = { cpf3: 'três primeiros do CPF', nascimento: 'data de nascimento', documento: 'documento' };

/** O cartão da passagem. `completo` mostra também o diálogo (usado no aviso da ligação). */
export function cartaoPassagem(p, { completo = false } = {}) {
  const c = p.cliente;
  const lista = (itens, classe) => el('ul', { class: `passagem-lista ${classe}` }, itens.map((t) => el('li', {}, t)));
  return el('div', { class: `passagem${completo ? ' completa' : ''}` },
    el('div', { class: 'passagem-topo' },
      el('h3', {}, icone('robo'), p.canal === 'telefone' ? 'A ZOE passou a ligação' : 'A ZOE passou assim'),
      p.fila ? el('span', { class: 'etiqueta' }, p.fila) : null),

    el('div', { class: 'passagem-quem' },
      el('strong', {}, c.nome ?? 'Cliente sem nome'),
      el('span', { class: 'pequeno mudo' }, [formatarTelefone(String(c.telefone ?? '').replace(/^55/, '')), c.documento, c.contrato ? `contrato ${c.contrato}` : null].filter(Boolean).join(' · ')),
      el('span', { class: `etiqueta ${c.identidade_confirmada ? 'ok' : 'aviso'}` },
        c.identidade_confirmada ? `Identidade confirmada${c.identidade_metodo ? ` (${NOMES[c.identidade_metodo] ?? c.identidade_metodo})` : ''}` : 'Identidade não confirmada')),

    p.atencao.length ? el('div', { class: 'passagem-atencao' }, icone('alerta'), lista(p.atencao, 'atencao')) : null,

    p.pediu || p.motivo ? el('div', { class: 'passagem-bloco' },
      p.pediu ? el('p', {}, el('small', {}, p.canal === 'telefone' ? 'O cliente disse' : 'O cliente escreveu'), `“${p.pediu}”`) : null,
      p.motivo ? el('p', {}, el('small', {}, 'Por que veio para a equipe'), p.motivo) : null) : null,

    p.ja_fez.length ? el('div', { class: 'passagem-bloco' }, el('small', {}, 'A ZOE já fez — não precisa repetir'), lista(p.ja_fez, 'feito'))
      : el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'A ZOE não chegou a fazer nada no sistema.'),

    p.resumo && p.resumo !== p.pediu ? el('p', { class: 'passagem-resumo' }, p.resumo) : null,

    completo && p.dialogo.length ? el('details', { class: 'passagem-dialogo', open: p.dialogo.length <= 8 },
      el('summary', {}, `A conversa (${p.dialogo.length} fala${p.dialogo.length === 1 ? '' : 's'})`),
      el('ol', {}, p.dialogo.map((d) => el('li', { class: d.quem },
        el('small', {}, `${d.quem === 'cliente' ? 'Cliente' : d.quem === 'zoe' ? 'ZOE' : 'Equipe'} · ${hora(d.em)}`),
        el('span', {}, d.texto))))) : null);
}

/**
 * Fica perguntando ao servidor se uma ligação acabou de ser atendida no ramal desta pessoa. Roda
 * mesmo com a aba em segundo plano — é justamente quando o atendente está em outra janela que o
 * telefone toca — e, nesse caso, pisca o título da aba.
 */
export function vigiarLigacoes(empresaId, { abrirConversa, intervaloMs = 4000 } = {}) {
  let parado = false;
  let timer;
  let aberta = null;
  let piscar = null;
  let tituloAntes = null;

  const pararDePiscar = () => {
    if (!piscar) return;
    clearInterval(piscar);
    piscar = null;
    document.title = tituloAntes;
  };
  const chamarAtencao = (nome) => {
    if (document.visibilityState === 'visible' || piscar) return;
    tituloAntes = document.title;
    let alterna = false;
    piscar = setInterval(() => { alterna = !alterna; document.title = alterna ? `☎ ${nome ?? 'Ligação'} — ZOE` : tituloAntes; }, 900);
  };
  const aoVoltar = () => { if (document.visibilityState === 'visible') pararDePiscar(); };
  document.addEventListener('visibilitychange', aoVoltar);

  const ciclo = async () => {
    if (parado) return;
    try {
      if (!aberta) {
        const { passagem } = await api.get(`/empresas/${empresaId}/ligacoes/para-mim`);
        if (passagem) mostrar(passagem);
      }
    } catch { /* próxima volta */ }
    if (!parado) timer = setTimeout(ciclo, intervaloMs);
  };

  function mostrar(p) {
    aberta = p.conversa_id;
    // Marca como vista na hora: se a pessoa recarregar a página, o aviso não volta.
    api.post(`/empresas/${empresaId}/conversas/${p.conversa_id}/passagem-vista`, {}).catch(() => {});
    chamarAtencao(p.cliente.nome);
    modal(`Ligação no seu ramal${p.ramal ? ` ${p.ramal}` : ''}`, (fechar) => [
      cartaoPassagem(p, { completo: true }),
      el('div', { class: 'linha entre', style: 'margin-top:12px' },
        el('button', { class: 'btn', type: 'button', onclick: () => fechar() }, 'Fechar'),
        el('button', { class: 'btn primario', type: 'button', onclick: () => { fechar(); abrirConversa?.(p.conversa_id); } }, 'Abrir a conversa')),
    ], { largo: true }).then(() => { aberta = null; pararDePiscar(); });
  }

  ciclo();
  return () => { parado = true; clearTimeout(timer); pararDePiscar(); document.removeEventListener('visibilitychange', aoVoltar); };
}
