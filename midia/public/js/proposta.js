/**
 * Proposta comercial a partir de um circuito do inventário.
 * Monta uma folha pronta para imprimir ou salvar em PDF (o navegador faz o PDF, sem biblioteca):
 * a marca, o que o cliente compra, o que vai ao ar, quanto custa e até quando o preço vale.
 */
import { api, qs } from './api.js';
import {
  el, limpar, icone, toast, acao, modal, formModal, confirmar, perguntar, campo, escolha, area, lerForm, simbolo,
  inteiro, dinheiro, dataBr, dataHora, etiqueta, percentual, CATEGORIAS,
} from './ui.js';
import { cartao, indicador, tabela } from './comum.js';

const PERIODOS = { 1: '1 mês', 3: '3 meses', 6: '6 meses', 12: '12 meses' };

/** Pergunta as condições comerciais, guarda a proposta e abre a folha. */
export async function gerarProposta(circuitoId, nomeCircuito, recarregar = null) {
  const opcoes = await api.get('/painel/opcoes');
  return modal(`Proposta — ${nomeCircuito}`, (fechar) => {
    const ok = el('button', { class: 'btn primario largo' }, icone('relatorios'), 'Gerar proposta');
    const f = el('form', { class: 'form' },
      escolha('Cliente (opcional)', 'anunciante_id', { '': 'Proposta sem cliente definido', ...Object.fromEntries(opcoes.anunciantes.map((a) => [a.id, a.nome])) }, ''),
      el('div', { class: 'tres' },
        escolha('Período', 'meses', PERIODOS, '3'),
        campo('Desconto (%)', { name: 'desconto', type: 'number', min: 0, max: 50, step: '0.5', value: '0' }),
        campo('Proposta válida por (dias)', { name: 'validade_dias', type: 'number', min: 1, max: 180, value: '15' })),
      campo('Inserções por hora', { name: 'insercoes_hora', type: 'number', min: 1, max: 120, placeholder: 'o padrão do circuito' }),
      area('Observações (aparecem no fim da proposta)', { name: 'observacao', maxlength: 500 }, ''),
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), ok));

    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(ok, async () => {
        const d = lerForm(f);
        const guardada = await api.post('/painel/propostas', {
          circuito_id: circuitoId,
          anunciante_id: d.anunciante_id || null,
          meses: Number(d.meses),
          desconto_percentual: Math.round(Number(String(d.desconto).replace(',', '.')) * 100) || 0,
          validade_dias: Number(d.validade_dias),
          insercoes_hora: d.insercoes_hora ? Number(d.insercoes_hora) : undefined,
          observacao: d.observacao,
        });
        fechar();
        toast(`Proposta ${guardada.numero} guardada.`);
        abrirFolha(guardada.folha, d.observacao, guardada);
        if (recarregar) recarregar();
      });
    });
    return [f];
  });
}

const bloco = (rotulo, valor, nota) => el('div', { class: 'bloco' },
  el('div', { class: 'valor' }, valor), el('div', { class: 'rotulo' }, rotulo), nota ? el('div', { class: 'nota' }, nota) : null);

/** A folha em si: ocupa a tela inteira e é o único elemento que vai para a impressora. */
export function abrirFolha(p, observacao, guardada = null) {
  const i = p.investimento;
  const vendido = p.veiculacao;
  const fechar = () => { folha.remove(); document.body.style.overflow = ''; };
  const folha = el('div', { class: 'folha-proposta' },
    el('div', { class: 'acoes-folha' },
      el('button', { class: 'btn primario', onclick: () => window.print() }, icone('baixar'), 'Imprimir / salvar em PDF'),
      el('button', { class: 'btn', onclick: fechar }, 'Fechar')),

    el('article', { class: 'folha' },
      el('header', {},
        el('div', { class: 'marca-folha' }, el('span', { class: 'simbolo' }, simbolo()),
          el('div', {}, el('strong', {}, p.plataforma.nome.toUpperCase()), el('div', { class: 'slogan' }, p.plataforma.slogan))),
        el('div', { class: 'dir' },
          el('div', { class: 'titulo-doc' }, `Proposta comercial${guardada ? ` ${guardada.numero}` : ''}`),
          el('div', { class: 'pequeno mudo' }, `Emitida em ${dataBr(p.emitida_em)} · válida até ${dataBr(p.valida_ate)}`))),

      el('h1', {}, p.circuito.nome),
      p.anunciante
        ? el('p', { class: 'para' }, `Para ${p.anunciante.nome}`, p.anunciante.contato ? ` · a/c ${p.anunciante.contato}` : '')
        : null,
      p.circuito.descricao ? el('p', { class: 'resumo' }, p.circuito.descricao) : null,

      el('h2', {}, 'A rede que o seu anúncio alcança'),
      el('div', { class: 'blocos' },
        bloco('Telas', inteiro(p.circuito.telas), `${inteiro(p.circuito.paisagem)} deitadas · ${inteiro(p.circuito.retrato)} em pé`),
        bloco('Pontos', inteiro(p.circuito.pontos), `${inteiro(p.circuito.cidades)} cidade(s)`),
        bloco('Pessoas por mês', inteiro(p.circuito.publico_mes), `${inteiro(p.circuito.publico_dia)} por dia`),
        p.circuito.unidades ? bloco('Unidades atendidas', inteiro(p.circuito.unidades), 'apartamentos, salas e lojas') : null),

      el('h2', {}, 'O que vai ao ar'),
      el('div', { class: 'blocos' },
        bloco('Inserções por mês', inteiro(vendido.insercoes_mes), `${vendido.insercoes_hora} por hora em cada tela`),
        bloco('No período', inteiro(vendido.insercoes_periodo), `${i.meses} ${i.meses === 1 ? 'mês' : 'meses'}`),
        bloco('Pessoas alcançadas/mês', inteiro(vendido.impactos_mes), 'estimativa pelo fluxo de cada ponto'),
        bloco('Espaço na tela', percentual(vendido.share_percentual), `cada anúncio fica ${vendido.duracao_s}s no ar`)),

      el('h2', {}, 'Onde o anúncio passa'),
      el('table', { class: 'tabela-folha' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Ponto'), el('th', {}, 'Ambiente'), el('th', {}, 'Cidade'),
          el('th', { class: 'dir' }, 'Telas'), el('th', { class: 'dir' }, 'Pessoas/dia'), el('th', { class: 'dir' }, 'Inserções/mês'))),
        el('tbody', {}, p.pontos.map((x) => el('tr', {},
          el('td', {}, el('div', {}, x.nome), x.posicoes.length ? el('div', { class: 'pequeno mudo' }, x.posicoes.join(' · ')) : null),
          el('td', {}, CATEGORIAS[x.categoria] ?? x.categoria),
          el('td', {}, `${x.cidade}/${x.uf}`),
          el('td', { class: 'dir num' }, inteiro(x.telas)),
          el('td', { class: 'dir num' }, inteiro(x.publico_dia)),
          el('td', { class: 'dir num' }, inteiro(x.insercoes_mes))))),
        el('tfoot', {}, el('tr', {},
          el('td', { colspan: 3 }, 'Total'),
          el('td', { class: 'dir num' }, inteiro(p.circuito.telas)),
          el('td', { class: 'dir num' }, inteiro(p.circuito.publico_dia)),
          el('td', { class: 'dir num' }, inteiro(vendido.insercoes_mes))))),

      el('h2', {}, 'Investimento'),
      el('table', { class: 'tabela-folha investimento' },
        el('tbody', {},
          el('tr', {}, el('td', {}, 'Tabela mensal'), el('td', { class: 'dir num' }, dinheiro(i.tabela_mes_centavos))),
          i.desconto_percentual
            ? el('tr', {}, el('td', {}, `Desconto de ${percentual(i.desconto_percentual)}`),
              el('td', { class: 'dir num' }, `- ${dinheiro(i.tabela_mes_centavos - i.mes_centavos)}`))
            : null,
          el('tr', { class: 'forte' }, el('td', {}, 'Por mês'), el('td', { class: 'dir num' }, dinheiro(i.mes_centavos))),
          el('tr', { class: 'forte' }, el('td', {}, `Total do período (${i.meses} ${i.meses === 1 ? 'mês' : 'meses'})`),
            el('td', { class: 'dir num' }, dinheiro(i.total_centavos))),
          el('tr', {}, el('td', {}, 'Custo por mil pessoas alcançadas (CPM)'), el('td', { class: 'dir num' }, dinheiro(i.cpm_centavos))))),

      observacao ? el('div', { class: 'observacao' }, observacao) : null,

      el('h2', {}, 'Como funciona'),
      el('ul', { class: 'condicoes' },
        el('li', {}, 'O anúncio entra no carrossel das telas do circuito e se alterna com os demais anunciantes ao longo de todo o horário de funcionamento do ponto.'),
        el('li', {}, 'Criativos em imagem (JPG ou PNG) ou vídeo (MP4), na orientação da tela. A produção da peça pode ser feita pela nossa equipe.'),
        el('li', {}, 'Todo mês o anunciante recebe a prova de exibição: data, hora e tela de cada vez que o anúncio foi ao ar.'),
        el('li', {}, 'As pessoas alcançadas são uma estimativa do fluxo de cada ponto pela fatia de tempo de tela contratada, não uma medição individual.'),
        el('li', {}, `Proposta válida até ${dataBr(p.valida_ate)}. Faturamento mensal, com nota fiscal de serviço.`)),

      el('footer', {}, `${p.plataforma.nome} · ${p.plataforma.slogan}`)));

  // Enquanto a folha está aberta, o painel atrás não rola (e o Esc fecha).
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', function esc(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', esc);
    fechar();
  });
  document.body.append(folha);
  folha.scrollTop = 0;
}

// ================================================================ O funil: as propostas guardadas
const STATUS_PROPOSTA = {
  rascunho: ['Rascunho', ''], enviada: ['Na mesa do cliente', 'info'], aceita: ['Aceita', 'ok'], recusada: ['Recusada', 'erro'],
};

/**
 * Tela de Propostas: o que foi oferecido, o que está esperando resposta e o que virou contrato.
 * Cada linha reimprime a folha do dia em que foi feita — não o inventário de hoje.
 */
export async function propostas(ctx) {
  const estado = { status: '' };
  const corpo = el('div', { class: 'coluna' });
  const opcoes = await api.get('/painel/opcoes');

  const pintar = async () => {
    const d = await api.get(`/painel/propostas${qs(estado)}`);
    const t = d.totais;
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({
          rotulo: 'Na mesa do cliente', valor: dinheiro(t.na_mesa_centavos), ic: 'relatorios', cor: 'azul',
          nota: `${t.enviadas} proposta(s) enviada(s)${t.expiradas ? ` · ${t.expiradas} com prazo vencido` : ''}`,
        }),
        indicador({ rotulo: 'Fechado', valor: dinheiro(t.fechado_centavos), ic: 'ok', cor: 'verde', nota: `${t.aceitas} aceita(s)` }),
        indicador({
          rotulo: 'Conversão', valor: percentual(t.conversao_percentual), ic: 'dashboard', cor: 'roxo',
          nota: `${t.aceitas} de ${t.aceitas + t.recusadas} respondidas`,
        }),
        indicador({ rotulo: 'Rascunhos', valor: inteiro(t.rascunho), ic: 'editar', cor: 'laranja', nota: 'ainda não foram ao cliente' })),

      cartao('Propostas', tabela([
        [(p) => el('div', {}, el('div', {}, p.numero), el('div', { class: 'pequeno mudo' }, p.circuito ?? '—')), 'Proposta'],
        [(p) => p.anunciante ?? el('span', { class: 'mudo' }, 'sem cliente definido'), 'Cliente'],
        [(p) => `${p.meses} ${p.meses === 1 ? 'mês' : 'meses'}`, 'Período'],
        [(p) => el('div', {}, el('div', {}, dinheiro(p.total_centavos)),
          el('div', { class: 'pequeno mudo' }, `${dinheiro(p.mes_centavos)}/mês${p.desconto_percentual ? ` · ${percentual(p.desconto_percentual)} off` : ''}`)), 'Valor', 'num dir'],
        [(p) => (p.expirada ? etiqueta(`Prazo venceu em ${dataBr(p.valida_ate)}`, 'aviso') : etiqueta(...STATUS_PROPOSTA[p.status] ?? [p.status, ''])), 'Situação'],
        [(p) => (p.contrato_numero ? el('span', {}, `contrato ${p.contrato_numero}`) : dataBr(p.criado_em.slice(0, 10))), 'Resultado'],
      ], d.itens, {
        aoClicar: (p) => abrirProposta(p.id, pintar),
        vazioTexto: 'Nenhuma proposta ainda. Elas nascem no Inventário, em cada circuito.',
      })));
  };

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      escolha('Situação', 'status', { '': 'Todas', rascunho: 'Rascunhos', enviada: 'Na mesa do cliente', aceita: 'Aceitas', recusada: 'Recusadas' }, '',
        { onchange: (e) => { estado.status = e.target.value; pintar(); } }),
      escolha('Circuito', 'circuito', { '': 'Todos', ...Object.fromEntries((opcoes.circuitos ?? []).map((c) => [c.id, c.nome])) }, '',
        { onchange: (e) => { estado.circuito_id = e.target.value; pintar(); } })),
    corpo);
  await pintar();
}

/** A proposta guardada: o que foi oferecido e o que fazer com ela agora. */
async function abrirProposta(id, recarregar) {
  const p = await api.get(`/painel/propostas/${id}`);
  const i = p.folha.investimento;
  await modal(`Proposta ${p.numero}`, (fechar) => [
    el('div', { class: 'linha entre' },
      el('div', { class: 'linha' },
        p.expirada ? etiqueta(`Prazo venceu em ${dataBr(p.valida_ate)}`, 'aviso') : etiqueta(...STATUS_PROPOSTA[p.status] ?? [p.status, '']),
        el('span', { class: 'mudo pequeno' }, `${p.circuito} · ${p.anunciante ?? 'sem cliente definido'}`)),
      el('strong', { style: 'font-size:20px' }, dinheiro(p.total_centavos))),

    el('div', { class: 'dados', style: 'margin:16px 0' },
      el('div', {}, el('span', { class: 'rotulo' }, 'Período'), el('span', {}, `${i.meses} ${i.meses === 1 ? 'mês' : 'meses'}`)),
      el('div', {}, el('span', { class: 'rotulo' }, 'Por mês'), el('span', {}, dinheiro(i.mes_centavos))),
      i.desconto_percentual ? el('div', {}, el('span', { class: 'rotulo' }, 'Desconto'), el('span', {}, percentual(i.desconto_percentual))) : null,
      el('div', {}, el('span', { class: 'rotulo' }, 'Telas'), el('span', {}, `${inteiro(p.folha.circuito.telas)} em ${inteiro(p.folha.circuito.pontos)} ponto(s)`)),
      el('div', {}, el('span', { class: 'rotulo' }, 'Inserções/mês'), el('span', {}, inteiro(p.folha.veiculacao.insercoes_mes))),
      el('div', {}, el('span', { class: 'rotulo' }, 'Feita em'), el('span', {}, dataHora(p.criado_em))),
      p.enviada_em ? el('div', {}, el('span', { class: 'rotulo' }, 'Enviada em'), el('span', {}, dataBr(p.enviada_em))) : null,
      p.respondida_em ? el('div', {}, el('span', { class: 'rotulo' }, 'Respondida em'), el('span', {}, dataBr(p.respondida_em))) : null),

    p.motivo ? el('p', { class: 'aviso' }, `Recusada: ${p.motivo}`) : null,
    p.contrato_numero
      ? el('p', { class: 'aviso ok' }, `Virou o contrato ${p.contrato_numero} e a campanha "${p.campanha_nome}" (ainda em rascunho, esperando o criativo).`)
      : null,
    el('p', { class: 'pequeno mudo' },
      'A folha reimprime o cálculo do dia em que a proposta foi feita — a rede muda, o que foi oferecido ao cliente não.'),

    el('div', { class: 'linha entre', style: 'margin-top:18px' },
      el('div', { class: 'linha' },
        el('button', { class: 'btn', onclick: () => { fechar(); abrirFolha(p.folha, p.observacao, p); } }, icone('relatorios'), 'Ver a folha'),
        p.status === 'rascunho'
          ? el('button', {
            class: 'btn primario', onclick: (e) => acao(e.target, async () => {
              await api.post(`/painel/propostas/${p.id}/enviar`, {});
              toast('Marcada como enviada ao cliente.');
              fechar();
              recarregar();
            }),
          }, icone('enviar'), 'Marcar como enviada')
          : null,
        p.status === 'enviada'
          ? el('button', { class: 'btn primario', onclick: () => { fechar(); aceitarProposta(p, recarregar); } }, icone('ok'), 'Cliente aceitou')
          : null,
        p.status === 'enviada'
          ? el('button', {
            class: 'btn perigo', onclick: (e) => acao(e.target, async () => {
              const motivo = await perguntar('Recusada', 'O que o cliente disse? (preço, prazo, outro fornecedor…)');
              if (!motivo) return;
              await api.post(`/painel/propostas/${p.id}/recusar`, { motivo });
              toast('Proposta marcada como recusada.');
              fechar();
              recarregar();
            }),
          }, 'Cliente recusou')
          : null,
        p.status === 'recusada'
          ? el('button', {
            class: 'btn', onclick: (e) => acao(e.target, async () => {
              await api.post(`/painel/propostas/${p.id}/reabrir`, {});
              toast('De volta a rascunho.');
              fechar();
              recarregar();
            }),
          }, 'Reabrir')
          : null,
        p.status !== 'aceita'
          ? el('button', {
            class: 'icone-btn', title: 'Excluir', onclick: (e) => acao(e.target, async () => {
              if (!await confirmar('Excluir a proposta', `A proposta ${p.numero} some do funil. O número não é reaproveitado.`)) return;
              await api.del(`/painel/propostas/${p.id}`);
              toast('Proposta excluída.');
              fechar();
              recarregar();
            }),
          }, icone('lixo'))
          : null),
      el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

/** Aceitar: o contrato e a campanha nascem da proposta, sem ninguém redigitar o que foi combinado. */
function aceitarProposta(p, recarregar) {
  return api.get('/painel/opcoes').then((opcoes) => formModal(`Fechado! Proposta ${p.numero}`, () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
      `Vão nascer um contrato de ${p.meses} ${p.meses === 1 ? 'mês' : 'meses'} por ${dinheiro(p.mes_centavos)}/mês e uma campanha `
      + `no circuito ${p.circuito}, com as telas dele. A campanha entra como rascunho: falta o criativo.`),
    p.anunciante_id
      ? null
      : escolha('Cliente', 'anunciante_id', Object.fromEntries(opcoes.anunciantes.map((a) => [a.id, a.nome])), '', { required: true }),
    campo('Início da vigência', { name: 'inicio', type: 'date', value: new Date().toLocaleDateString('en-CA'), required: true }),
  ], async (d) => {
    const r = await api.post(`/painel/propostas/${p.id}/aceitar`, d);
    toast(`Contrato ${r.criado.numero} e campanha criados.`);
    recarregar();
  }));
}
