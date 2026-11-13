/**
 * A ficha 360° do cliente: a vida inteira dele numa tela só, com o risco de perder e o valor que ele
 * tem — para quem vai atender decidir em 30 segundos se briga pelo cliente e com o quê.
 *
 * O score é mostrado SEMPRE com os porquês. Um número sozinho não ajuda ninguém a decidir.
 */
import { api } from './api.js';
import { el, limpar, icone, modal, toast, inteiro, porcento, dataHora, desde, estrelas, telefone as formatarTelefone, iniciais } from './ui.js';
import { cartao, tabela, td } from './comum.js';

const FAIXA = { alto: ['Risco alto', 'vermelho'], medio: ['Risco médio', 'laranja'], baixo: ['Risco baixo', 'verde'] };
const CLASSE = { A: ['Cliente A', 'verde'], B: ['Cliente B', 'azul'], C: ['Cliente C', 'cinza'] };
const ICONE_EVENTO = {
  conversa: 'conversa', transferencia: 'transferir', ouvidoria: 'alerta', chamado: 'chamados',
  tecnico: 'chamados', pagamento: 'dinheiro', atraso: 'alerta', contrato: 'empresas',
};

/** O medidor de risco: a nota grande, a faixa e a barra. */
function medidor(risco) {
  const [rotulo, cor] = FAIXA[risco.faixa] ?? ['Risco', 'cinza'];
  return el('div', { class: `medidor ${cor}` },
    el('div', { class: 'nota' }, el('strong', {}, inteiro(risco.nota)), el('small', {}, '/100')),
    el('div', { class: 'corpo' },
      el('strong', {}, rotulo),
      el('div', { class: 'trilho' }, el('span', { style: `width:${risco.nota}%` })),
      el('small', { class: 'mudo' }, 'chance de perder este cliente')));
}

/** Os fatores do score, cada um com o quanto pesou e por quê. */
const listaFatores = (fatores, aumenta) => (fatores.length
  ? el('ul', { class: 'fatores' }, fatores.map((f) => el('li', { class: aumenta ? 'sobe' : 'desce' },
    el('span', { class: 'peso' }, `${aumenta ? '+' : ''}${f.pontos}`),
    el('div', {}, el('strong', {}, f.nome), el('div', { class: 'pequeno mudo' }, f.detalhe)))))
  : el('p', { class: 'mudo pequeno', style: 'margin:0' }, aumenta ? 'Nenhum sinal de risco.' : 'Nada que reduza o risco.'));

/** A linha do tempo: tudo que aconteceu, do mais novo para o mais antigo. */
const linhaDoTempo = (eventos) => (eventos.length
  ? el('ol', { class: 'linha-tempo' }, eventos.map((e) => el('li', { class: `evento ${e.tipo}` },
    el('span', { class: 'ponto' }, icone(ICONE_EVENTO[e.tipo] ?? 'relogio')),
    el('div', { class: 'conteudo-evento' },
      el('div', { class: 'linha entre' },
        el('strong', {}, e.titulo),
        el('small', { class: 'mudo' }, dataHora(e.quando))),
      e.detalhe ? el('div', { class: 'pequeno mudo' }, e.detalhe) : null,
      e.csat ? estrelas(e.csat) : null))))
  : el('p', { class: 'mudo', style: 'margin:0' }, 'Nada registrado ainda.'));

/** O corpo da ficha, para usar em modal ou embutido numa tela. */
export function corpoDaFicha(f) {
  const r = f.resumo;
  const [classeRotulo, classeCor] = CLASSE[f.valor.classe] ?? ['Cliente', 'cinza'];
  const numero = (rotulo, valor, nota = null) => el('div', { class: 'numero-ficha' },
    el('small', {}, rotulo), el('strong', {}, valor), nota ? el('em', {}, nota) : null);

  return el('div', { class: 'ficha' },
    // Quem é, em uma linha.
    el('div', { class: 'cabecalho-ficha' },
      el('span', { class: 'avatar-contato grande' }, iniciais(f.contato.nome ?? f.contato.telefone)),
      el('div', {},
        el('strong', {}, f.contato.nome ?? formatarTelefone(String(f.contato.telefone).replace(/^55/, ''))),
        el('div', { class: 'pequeno mudo' },
          [formatarTelefone(String(f.contato.telefone).replace(/^55/, '')), f.contato.documento, f.provedor.cliente_id ? `IXC ${f.provedor.cliente_id}` : null]
            .filter(Boolean).join(' · '))),
      el('div', { class: 'linha', style: 'gap:6px;margin-left:auto' },
        el('span', { class: `etiqueta ${classeCor === 'verde' ? 'ok' : classeCor === 'cinza' ? '' : 'info'}` }, classeRotulo),
        r.acesso ? el('span', { class: `etiqueta ${r.acesso === 'liberado' ? 'ok' : 'erro'}` }, r.acesso.replace(/_/g, ' ')) : null)),

    // O que a pessoa precisa decidir, antes de tudo.
    el('div', { class: 'grade-2' },
      cartao(null, medidor(f.risco)),
      cartao(null, el('div', { class: 'valor-cliente' },
        el('div', {}, el('small', { class: 'mudo' }, 'Se este cliente sair, a empresa deixa de faturar'),
          el('strong', { class: 'perda' }, ((f.valor.perda_anual_centavos ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })),
          el('small', { class: 'mudo' }, 'por ano')),
        f.valor.porques.length ? el('div', { class: 'perguntas' }, f.valor.porques.map((p) => el('span', { class: 'etiqueta' }, p))) : null))),

    el('div', { class: `aviso-caixa ${f.recomendacao.prioridade === 'alta' ? 'aviso' : 'info'}` },
      icone(f.recomendacao.prioridade === 'alta' ? 'alerta' : 'ok'),
      el('div', {}, el('strong', {}, 'O que fazer: '), f.recomendacao.texto)),

    el('div', { class: 'grade-2' },
      cartao('O que aumenta o risco', listaFatores(f.risco.aumentam, true)),
      cartao('O que segura o cliente', listaFatores(f.risco.reduzem, false))),

    cartao('Em números', el('div', { class: 'numeros-ficha' },
      numero('Cliente há', r.tempo_casa_meses === null ? '—' : `${inteiro(r.tempo_casa_meses)} meses`, r.plano),
      numero('Mensalidade', r.mensalidade),
      numero('Pagamento em dia', r.pontualidade === null ? '—' : porcento(r.pontualidade)),
      numero('Em aberto', r.total_em_aberto, r.faturas_vencidas ? `${r.faturas_vencidas} vencida(s)` : 'nada vencido'),
      numero('Chamados (90 dias)', inteiro(r.chamados_90_dias)),
      numero('Conversas', inteiro(r.conversas)),
      numero('Ouvidorias', inteiro(r.ouvidorias)),
      numero('Satisfação', r.csat_medio === null ? '—' : `${r.csat_medio.toLocaleString('pt-BR')}/5`),
      numero('Desbloqueios', inteiro(r.desbloqueios)))),

    f.provedor.disponivel
      ? (f.provedor.contratos.length
        ? cartao('Contratos', tabela(['Plano', 'Situação do acesso', 'Desde', 'Endereço'], f.provedor.contratos.map((c) => el('tr', {},
          td(c.plano ?? '—'),
          td(el('span', { class: `etiqueta ${c.acesso === 'liberado' ? 'ok' : 'erro'}` }, (c.acesso ?? '—').replace(/_/g, ' '))),
          td(c.ativado_em ? dataHora(`${c.ativado_em}T12:00:00Z`).split(',')[0] : '—'),
          td(el('span', { class: 'pequeno' }, c.endereco ?? '—'))))))
        : null)
      : el('div', { class: 'aviso-caixa aviso' }, icone('alerta'), el('span', {},
        `A ficha está incompleta: ${f.provedor.motivo ?? 'o sistema do provedor não respondeu'}. Os números do contrato e do pagamento não entraram no score.`)),

    cartao('Linha do tempo', linhaDoTempo(f.linha_do_tempo)));
}

/** Abre a ficha numa janela. `origem`: '/conversas/ID/ficha' ou '/contatos/ID/ficha'. */
export async function abrirFicha(empresaId, origem) {
  let f;
  try {
    f = await api.get(`/empresas/${empresaId}${origem}`);
  } catch (err) {
    return toast(err.message, true);
  }
  return modal('Ficha do cliente', (fechar) => [
    corpoDaFicha(f),
    el('div', { class: 'linha entre', style: 'margin-top:14px' }, el('span'), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

export { FAIXA, CLASSE };
