import { api, pode } from '../app.js';
import { el, montar, cartao, selo, icone, data, modal, campo, lerForm, acao, toast, aviso } from '../../comum/ui.js';
import { cartaoPainel } from '../../comum/componentes.js';

/*
 * Conformidade: as regras legais e normativas que o sistema segue.
 *
 * As AUTOMÁTICAS são verificadas pelo servidor toda vez que esta tela abre: ele testa a trava
 * (tenta o proibido e espera ser barrado) e varre os dados. As de ACOMPANHAMENTO dependem de
 * alguém de fora — o administrador registra a situação, o responsável e o prazo.
 */

const SITUACAO = {
  fora: ['Fora da norma', 'erro'],
  atencao: ['Atenção', 'aviso'],
  pendente: ['Pendente', 'neutra'],
  em_andamento: ['Em andamento', 'info'],
  ok: ['Atendida', 'ok'],
  nao_se_aplica: ['Não se aplica', 'neutra'],
};
// Problema primeiro: é o que a tela existe para mostrar.
const ORDEM = ['fora', 'atencao', 'pendente', 'em_andamento', 'ok', 'nao_se_aplica'];
const porGravidade = (a, b) => ORDEM.indexOf(a.situacao) - ORDEM.indexOf(b.situacao) || Number(b.prazo_vencido) - Number(a.prazo_vencido);

const OPCOES = [['pendente', 'Pendente'], ['em_andamento', 'Em andamento'], ['atendida', 'Atendida'], ['nao_se_aplica', 'Não se aplica']];

export default async function conformidade({ alvo, recarregar }) {
  const d = await api.get('/conformidade');
  const r = d.resumo;
  // O administrador tem '*'; conformidade.editar não está em nenhum outro perfil.
  const podeEditar = pode('conformidade.editar') || pode('*');
  const hora = new Date(d.verificado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  montar(alvo,
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Conformidade'),
        el('p', {}, 'As regras legais e normativas que o sistema segue. As automáticas são conferidas pelo próprio sistema a cada abertura desta tela.')),
      el('div', { class: 'acoes' },
        el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, recarregar) }, icone('atualizar'), 'Verificar agora'))),

    cartaoPainel({
      rotulo: 'Regras atendidas',
      valor: `${r.ok} de ${r.total}`,
      apoio: `Verificado às ${hora}`,
      itens: [
        ['Fora da norma', String(r.fora)],
        ['Atenção', String(r.atencao)],
        ['Pendentes', String(r.pendente + r.em_andamento)],
        ['Prazos vencidos', String(r.prazos_vencidos)],
      ],
    }),

    r.fora
      ? el('div', { style: 'margin-top:16px' }, aviso(
        `Fora da norma: ${d.grupos.flatMap((g) => g.regras).filter((x) => x.situacao === 'fora').map((x) => x.titulo).join(' · ')}. `
        + 'Cada uma está no topo do seu grupo, com o que precisa ser feito.', 'erro'))
      : null,

    ...d.grupos.map((g) => el('div', { style: 'margin-top:16px' },
      cartao(g.titulo, el('div', { class: 'regras' }, [...g.regras].sort(porGravidade).map((x) => regra(x, { podeEditar, recarregar })))))),
  );
}

function regra(x, { podeEditar, recarregar }) {
  const automatica = x.tipo === 'automatica';
  return el('article', { class: `regra ${x.situacao}` },
    el('div', { class: 'regra-topo' },
      selo(x.situacao, SITUACAO),
      el('strong', {}, x.titulo),
      el('span', { class: 'regra-tipo' }, automatica ? 'Verificação automática' : 'Acompanhamento'),
      !automatica && podeEditar
        ? el('button', { class: 'botao sec pequeno', onclick: () => atualizar(x, recarregar) }, 'Atualizar')
        : null),
    el('div', { class: 'regra-norma' }, x.norma),
    el('p', { class: 'regra-exige' }, x.exige),
    automatica
      ? el('div', { class: 'regra-agora' }, icone(x.situacao === 'ok' ? 'ok' : x.situacao === 'fora' ? 'alerta' : 'info'), el('span', {}, x.detalhe))
      : acompanhamento(x));
}

function acompanhamento(x) {
  const partes = [
    x.responsavel ? ['Responsável', x.responsavel] : null,
    x.prazo ? ['Prazo', `${data(x.prazo)}${x.prazo_vencido ? ' — vencido' : ''}`] : null,
    x.atualizado_em ? ['Atualizado', `${data(x.atualizado_em)}${x.atualizado_por ? ` por ${x.atualizado_por}` : ''}`] : null,
  ].filter(Boolean);
  return el('div', { class: 'regra-agora' },
    partes.length
      ? el('div', { class: 'regra-meta' }, partes.map(([r, v]) => el('span', { class: r === 'Prazo' && x.prazo_vencido ? 'vencido' : '' }, el('b', {}, `${r}: `), v)))
      : null,
    x.observacao ? el('p', { class: 'regra-obs' }, x.observacao) : null,
    !x.atualizado_em ? el('p', { class: 'regra-obs sem-registro' }, 'Ninguém registrou nada ainda.') : null);
}

function atualizar(x, recarregar) {
  const form = el('form', { class: 'form-grade', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'situacao', rotulo: 'Situação', tipo: 'select', opcoes: OPCOES, valor: x.situacao_registrada ?? 'pendente' }),
    campo({ nome: 'responsavel', rotulo: 'Responsável', valor: x.responsavel ?? '', atributos: { maxlength: 80 } }),
    campo({ nome: 'prazo', rotulo: 'Prazo', tipo: 'date', valor: x.prazo ?? '' }),
    campo({ nome: 'observacao', rotulo: 'Observação', tipo: 'textarea', valor: x.observacao ?? '',
      ajuda: 'O que foi feito, o que falta, onde está o documento (parecer, e-mail do banco).', atributos: { maxlength: 1000, rows: 4 } }));
  const salvar = el('button', { class: 'botao', type: 'button' }, 'Salvar');
  const m = modal({
    titulo: x.titulo,
    corpo: [el('p', { class: 'regra-norma' }, x.norma), form],
    acoes: [el('button', { class: 'botao sec', type: 'button', onclick: () => m.fechar() }, 'Cancelar'), salvar],
  });
  salvar.addEventListener('click', () => acao(salvar, async () => {
    await api.put(`/conformidade/${x.id}`, lerForm(form));
    m.fechar();
    toast('Situação registrada. A mudança ficou na auditoria.', 'ok');
    await recarregar();
  }));
}
