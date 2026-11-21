/**
 * CRM: o que acontece antes de existir cliente.
 *
 * O quadro mostra em que pé está cada conversa e, acima de tudo, **o que ficou combinado para hoje**.
 * Lead sem próximo passo marcado é lead que morre numa coluna — por isso ele aparece em destaque.
 * As propostas vivem na segunda aba: é o papel que sai do funil e volta como contrato.
 */
import { api, qs } from './api.js';
import {
  el, limpar, icone, toast, acao, modal, formModal, confirmar, perguntar, campo, escolha, area, lerForm, centavos, reaisCampo,
  inteiro, dinheiro, dataBr, dataHora, etiqueta, percentual, pessoa,
} from './ui.js';
import { cartao, indicador, tabela, vazio } from './comum.js';
import { propostas, gerarProposta } from './proposta.js';

const ETAPAS = {
  novo: 'Novo', contato: 'Contato feito', proposta: 'Proposta', negociacao: 'Negociação', ganho: 'Ganho', perdido: 'Perdido',
};
const ABERTAS = ['novo', 'contato', 'proposta', 'negociacao'];
const TIPOS = { anunciante: 'Quer anunciar', ponto: 'Quer tela no prédio' };
const ORIGENS = { site: 'Site', indicacao: 'Indicação', prospeccao: 'Prospecção', evento: 'Evento', outro: 'Outro' };
const INTERACOES = {
  nota: 'Anotação', ligacao: 'Ligação', email: 'E-mail', whatsapp: 'WhatsApp', reuniao: 'Reunião', visita: 'Visita', etapa: 'Mudança de etapa',
};
const hojeLocal = () => new Date().toLocaleDateString('en-CA');
const emDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

export async function crm(ctx) {
  const estado = { aba: 'funil', tipo: '', origem: '', responsavel_id: '', busca: '' };
  const corpo = el('div', { class: 'coluna' });
  const opcoes = await api.get('/painel/opcoes');

  const pintar = async () => {
    if (estado.aba === 'propostas') return propostas({ conteudo: corpo });
    const d = await api.get(`/painel/crm/funil${qs({ tipo: estado.tipo, origem: estado.origem, responsavel_id: estado.responsavel_id, busca: estado.busca })}`);
    const t = d.totais;
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({
          rotulo: 'No funil', valor: dinheiro(t.no_funil_centavos), ic: 'dinheiro', cor: 'azul',
          nota: `${inteiro(t.abertos)} conversa(s) em aberto`,
        }),
        indicador({
          rotulo: 'Para hoje', valor: inteiro(t.para_hoje), ic: 'relogio', cor: t.atrasados ? 'vermelho' : 'verde',
          nota: t.atrasados ? `${t.atrasados} com data vencida` : 'nada atrasado',
        }),
        indicador({
          rotulo: 'Ganho no mês', valor: dinheiro(t.ganho_mes_centavos), ic: 'ok', cor: 'verde',
          nota: `${inteiro(t.ganhos_mes)} lead(s) fechado(s)`,
        }),
        indicador({
          rotulo: 'Conversão', valor: percentual(t.conversao_percentual), ic: 'dashboard', cor: 'roxo',
          nota: t.sem_proximo_passo ? `${t.sem_proximo_passo} sem próximo passo` : 'todos com próximo passo',
        })),

      d.agenda.length
        ? cartao('O que está combinado para hoje', tabela([
          [(l) => el('div', {}, el('div', {}, l.nome), el('div', { class: 'pequeno mudo' }, l.proximo_passo ?? 'sem descrição')), 'Lead'],
          [(l) => (l.atrasado ? etiqueta(`Era ${dataBr(l.proximo_em)}`, 'erro') : etiqueta('Hoje', 'ok')), 'Quando'],
          [(l) => l.responsavel ?? '—', 'Com quem'],
          [(l) => dinheiro(l.valor_estimado_centavos), 'Valor', 'num dir'],
        ], d.agenda, { aoClicar: (l) => abrirLead(l.id, pintar) }))
        : null,

      el('div', { class: 'funil' }, d.etapas.map((coluna) => colunaDoFunil(coluna, pintar))));
  };

  const abas = el('div', { class: 'linha' }, Object.entries({ funil: 'Funil', propostas: 'Propostas' }).map(([k, rotulo]) => el('button', {
    class: `btn pequeno${estado.aba === k ? ' primario' : ''}`,
    onclick: (e) => {
      estado.aba = k;
      for (const b of e.target.parentElement.children) b.classList.toggle('primario', b === e.target);
      filtros.hidden = k !== 'funil';
      pintar();
    },
  }, rotulo)));

  const filtros = el('div', { class: 'filtros livre' },
    campo('Buscar', { placeholder: 'Nome, contato, cidade…', oninput: (e) => { estado.busca = e.target.value; clearTimeout(filtros.t); filtros.t = setTimeout(pintar, 350); } }),
    escolha('Tipo', 'tipo', { '': 'Todos', ...TIPOS }, '', { onchange: (e) => { estado.tipo = e.target.value; pintar(); } }),
    escolha('Origem', 'origem', { '': 'Todas', ...ORIGENS }, '', { onchange: (e) => { estado.origem = e.target.value; pintar(); } }),
    escolha('Responsável', 'responsavel_id', { '': 'Todos', ...Object.fromEntries((opcoes.equipe ?? []).map((u) => [u.id, u.nome])) }, '',
      { onchange: (e) => { estado.responsavel_id = e.target.value; pintar(); } }),
    el('button', { class: 'btn primario', onclick: () => editarLead(null, opcoes, pintar) }, icone('mais'), 'Novo lead'));

  limpar(ctx.conteudo, abas, filtros, corpo);
  await pintar();
}

/** Uma coluna do quadro, com os cartões dos leads daquela etapa. */
function colunaDoFunil(coluna, recarregar) {
  const fechada = coluna.etapa === 'ganho' || coluna.etapa === 'perdido';
  return el('div', { class: `coluna-funil ${coluna.etapa}${fechada ? ' fechada' : ''}` },
    el('div', { class: 'cabeca-coluna' },
      el('strong', {}, ETAPAS[coluna.etapa]),
      el('span', { class: 'conta' }, inteiro(coluna.total))),
    coluna.valor_centavos ? el('div', { class: 'valor-coluna' }, dinheiro(coluna.valor_centavos)) : null,
    el('div', { class: 'cartoes' }, coluna.itens.length
      ? coluna.itens.map((l) => cartaoDoLead(l, recarregar))
      : el('p', { class: 'mudo pequeno', style: 'margin:6px 2px' }, fechada ? '—' : 'Nada nesta etapa.')));
}

function cartaoDoLead(l, recarregar) {
  return el('button', { class: `cartao-lead${l.atrasado ? ' atrasado' : ''}`, onclick: () => abrirLead(l.id, recarregar) },
    el('div', { class: 'linha entre' },
      el('strong', {}, l.nome),
      l.tipo === 'ponto' ? icone('pontos') : null),
    el('div', { class: 'pequeno mudo' }, [l.cidade, l.origem === 'site' ? 'veio do site' : ORIGENS[l.origem]].filter(Boolean).join(' · ')),
    l.valor_estimado_centavos ? el('div', { class: 'valor' }, dinheiro(l.valor_estimado_centavos)) : null,
    l.proximo_em
      ? el('div', { class: `proximo${l.atrasado ? ' tarde' : ''}` }, icone('relogio'), `${dataBr(l.proximo_em)} · ${l.proximo_passo ?? 'retomar'}`)
      : (ABERTAS.includes(l.etapa) ? el('div', { class: 'proximo pendente' }, 'sem próximo passo') : null),
    l.responsavel ? el('div', { class: 'pequeno mudo' }, l.responsavel) : null);
}

/** A ficha do lead: o que se sabe, o que já foi conversado e o que fazer agora. */
async function abrirLead(id, recarregar) {
  const l = await api.get(`/painel/crm/leads/${id}`);
  const opcoes = await api.get('/painel/opcoes');
  const atualizar = async (fechar) => { fechar(); await recarregar(); abrirLead(id, recarregar); };

  await modal(l.nome, (fechar) => [
    el('div', { class: 'linha entre' },
      el('div', { class: 'linha' },
        etiqueta(ETAPAS[l.etapa], l.etapa === 'ganho' ? 'ok' : (l.etapa === 'perdido' ? 'erro' : 'info')),
        el('span', { class: 'mudo pequeno' }, `${TIPOS[l.tipo]} · ${ORIGENS[l.origem]}`)),
      l.valor_estimado_centavos ? el('strong', { style: 'font-size:20px' }, dinheiro(l.valor_estimado_centavos)) : null),

    el('div', { class: 'dados', style: 'margin:16px 0' },
      l.contato ? el('div', {}, el('span', { class: 'rotulo' }, 'Falar com'), el('span', {}, l.contato)) : null,
      l.email ? el('div', {}, el('span', { class: 'rotulo' }, 'E-mail'), el('span', {}, l.email)) : null,
      l.telefone ? el('div', {}, el('span', { class: 'rotulo' }, 'Telefone'), el('span', {}, l.telefone)) : null,
      l.cidade ? el('div', {}, el('span', { class: 'rotulo' }, 'Cidade'), el('span', {}, `${l.cidade}${l.uf ? `/${l.uf}` : ''}`)) : null,
      el('div', {}, el('span', { class: 'rotulo' }, 'Responsável'), el('span', {}, l.responsavel ?? 'ninguém ainda')),
      el('div', {}, el('span', { class: 'rotulo' }, 'Próximo passo'),
        el('span', { style: l.atrasado ? 'color:var(--erro);font-weight:700' : null },
          l.proximo_em ? `${dataBr(l.proximo_em)} — ${l.proximo_passo ?? 'retomar'}` : 'não marcado')),
      l.cliente ? el('div', {}, el('span', { class: 'rotulo' }, 'Virou o cliente'), el('span', {}, l.cliente)) : null,
      l.ponto ? el('div', {}, el('span', { class: 'rotulo' }, 'Virou o ponto'), el('span', {}, l.ponto)) : null),

    l.mensagem ? el('p', { class: 'aviso' }, `Pelo site: "${l.mensagem}"`) : null,
    l.motivo ? el('p', { class: 'aviso' }, `Perdido: ${l.motivo}`) : null,
    l.observacao ? el('p', { class: 'mudo' }, l.observacao) : null,

    // Avançar de etapa é o gesto mais comum: fica à mão, sem abrir formulário.
    ABERTAS.includes(l.etapa)
      ? el('div', { class: 'linha', style: 'margin-bottom:14px' },
        el('span', { class: 'mudo pequeno' }, 'Mover para:'),
        ...ABERTAS.filter((e) => e !== l.etapa).map((e) => el('button', {
          class: 'btn pequeno', onclick: (ev) => acao(ev.target, async () => {
            await api.patch(`/painel/crm/leads/${l.id}`, { etapa: e });
            toast(`Movido para ${ETAPAS[e]}.`);
            atualizar(fechar);
          }),
        }, ETAPAS[e])))
      : null,

    l.propostas_lista.length
      ? el('div', {},
        el('h3', {}, 'Propostas'),
        tabela([
          [(p) => p.numero, 'Número'],
          [(p) => dinheiro(p.total_centavos), 'Valor', 'num dir'],
          [(p) => p.status, 'Situação'],
          [(p) => (p.contrato_id ? 'virou contrato' : `vale até ${dataBr(p.valida_ate)}`), 'Resultado'],
        ], l.propostas_lista))
      : null,

    el('h3', {}, 'Conversas'),
    el('div', { class: 'linha', style: 'margin-bottom:10px' },
      el('button', { class: 'btn pequeno primario', onclick: () => { fechar(); registrarConversa(l, () => recarregar()); } }, icone('mais'), 'Anotar conversa'),
      ABERTAS.includes(l.etapa)
        ? el('button', { class: 'btn pequeno', onclick: () => { fechar(); gerarProposta(null, l.nome, () => recarregar(), { lead: l }); } }, icone('relatorios'), 'Gerar proposta')
        : null),
    l.interacoes.length
      ? el('ul', { class: 'linha-tempo' }, l.interacoes.map((i) => el('li', {},
        el('div', { class: 'quando' }, dataHora(i.criado_em)),
        el('div', {}, el('strong', {}, INTERACOES[i.tipo] ?? i.tipo), el('div', {}, i.texto),
          i.quem ? el('div', { class: 'pequeno mudo' }, i.quem) : null))))
      : vazio('Nenhuma conversa anotada ainda.'),

    el('div', { class: 'linha entre', style: 'margin-top:18px' },
      el('div', { class: 'linha' },
        el('button', { class: 'btn', onclick: () => { fechar(); editarLead(l, opcoes, () => recarregar()); } }, icone('editar'), 'Editar'),
        ABERTAS.includes(l.etapa)
          ? el('button', {
            class: 'btn primario', onclick: (e) => acao(e.target, async () => {
              const texto = l.tipo === 'anunciante'
                ? 'Vai nascer o cadastro do cliente a partir deste lead. Depois é só criar a campanha.'
                : 'Vai nascer o cadastro do ponto a partir deste lead. Confira a categoria e a contrapartida depois.';
              if (!await confirmar('Ganhamos!', texto, 'Ganhar')) return;
              const r = await api.post(`/painel/crm/leads/${l.id}/ganhar`, {});
              toast(r.cliente ? `Cliente ${r.cliente} criado.` : (r.ponto ? `Ponto ${r.ponto} criado.` : 'Lead ganho.'));
              atualizar(fechar);
            }),
          }, icone('ok'), 'Ganhamos')
          : null,
        ABERTAS.includes(l.etapa)
          ? el('button', {
            class: 'btn perigo', onclick: (e) => acao(e.target, async () => {
              const motivo = await perguntar('Perdemos', 'O que aconteceu? (preço, prazo, concorrente, sumiu…)');
              if (!motivo) return;
              await api.post(`/painel/crm/leads/${l.id}/perder`, { motivo });
              toast('Lead marcado como perdido.');
              atualizar(fechar);
            }),
          }, 'Perdemos')
          : null,
        !ABERTAS.includes(l.etapa)
          ? el('button', {
            class: 'btn', onclick: (e) => acao(e.target, async () => {
              await api.post(`/painel/crm/leads/${l.id}/reabrir`, {});
              toast('Lead reaberto.');
              atualizar(fechar);
            }),
          }, 'Reabrir')
          : null),
      el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

/** Anotar o que foi conversado — e já marcar o próximo passo, que é o que faz o funil andar. */
function registrarConversa(l, recarregar) {
  return formModal(`Conversa com ${l.nome}`, () => [
    escolha('Como foi', 'tipo', { ligacao: 'Ligação', whatsapp: 'WhatsApp', email: 'E-mail', reuniao: 'Reunião', visita: 'Visita', nota: 'Anotação' }, 'ligacao'),
    area('O que ficou combinado', { name: 'texto', required: true, maxlength: 500, placeholder: 'Ex.: Falei com o síndico. Pediu proposta para 6 meses até sexta.' }, ''),
    el('div', { class: 'duas' },
      campo('Próximo passo', { name: 'proximo_passo', maxlength: 160, value: l.proximo_passo ?? '', placeholder: 'Ex.: Enviar proposta' }),
      campo('Quando', { name: 'proximo_em', type: 'date', value: l.proximo_em ?? emDias(3) })),
    el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Lead sem próximo passo marcado é lead que some. Deixe sempre uma data.'),
  ], async (d) => {
    await api.post(`/painel/crm/leads/${l.id}/interacoes`, d);
    toast('Conversa anotada.');
    recarregar();
  });
}

/** Cadastro do lead: o mínimo para conseguir voltar a falar com a pessoa. */
function editarLead(l, opcoes, recarregar) {
  return formModal(l ? `Editar ${l.nome}` : 'Novo lead', () => [
    el('div', { class: 'duas' },
      campo('Empresa ou condomínio', { name: 'nome', value: l?.nome ?? '', required: true, maxlength: 120, autofocus: !l }),
      escolha('O que quer', 'tipo', TIPOS, l?.tipo ?? 'anunciante')),
    el('div', { class: 'tres' },
      campo('Falar com', { name: 'contato', value: l?.contato ?? '', maxlength: 120 }),
      campo('E-mail', { name: 'email', type: 'email', value: l?.email ?? '' }),
      campo('Telefone', { name: 'telefone', value: l?.telefone ?? '', maxlength: 20 })),
    el('div', { class: 'tres' },
      campo('Cidade', { name: 'cidade', value: l?.cidade ?? '', maxlength: 80 }),
      campo('UF', { name: 'uf', value: l?.uf ?? '', maxlength: 2, placeholder: 'SP' }),
      escolha('Origem', 'origem', ORIGENS, l?.origem ?? 'prospeccao')),
    el('div', { class: 'tres' },
      campo('Valor estimado por mês (R$)', { name: 'valor', value: reaisCampo(l?.valor_estimado_centavos), inputmode: 'decimal' }),
      campo('Próximo passo', { name: 'proximo_passo', value: l?.proximo_passo ?? '', maxlength: 160, placeholder: 'Ex.: Ligar para o síndico' }),
      campo('Quando', { name: 'proximo_em', type: 'date', value: l?.proximo_em ?? emDias(2) })),
    escolha('Responsável', 'responsavel_id', { '': 'Ninguém ainda', ...Object.fromEntries((opcoes.equipe ?? []).map((u) => [u.id, u.nome])) }, l?.responsavel_id ?? ''),
    area('Observação', { name: 'observacao', maxlength: 500 }, l?.observacao ?? ''),
    l ? null : area('Primeira anotação (opcional)', { name: 'nota', maxlength: 500, placeholder: 'Ex.: Indicação do síndico do Jardim das Acácias.' }, ''),
  ], async (d) => {
    const corpo = { ...d, valor_estimado_centavos: centavos(d.valor) ?? 0 };
    delete corpo.valor;
    if (l) await api.patch(`/painel/crm/leads/${l.id}`, corpo);
    else await api.post('/painel/crm/leads', corpo);
    toast(l ? 'Lead atualizado.' : 'Lead criado.');
    recarregar();
  }, { largo: true });
}
