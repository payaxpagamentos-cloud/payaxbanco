import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import { el, cartao, tabela, paginacao, kpi, campo, lerForm, confirmar, toast, acao, aviso, selo,
  dinheiro, numero, dataHora, documento, R, icone } from '../../comum/ui.js';

/** Fila de repasses: aprovar o que passou do limite, enviar e acompanhar o PIX. */
export default async function repasses({ alvo, query, recarregar }) {
  const filtros = { situacao: query.situacao ?? '', de: query.de ?? '', ate: query.ate ?? '', pagina: Number(query.pagina) || 1 };
  const d = await api.get(`/repasses${qs(filtros)}`);
  const porSituacao = Object.fromEntries(d.resumo.map((r) => [r.situacao, r]));
  const q = (s) => porSituacao[s] ?? { quantidade: 0, valor_centavos: 0 };

  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/repasses${qs({ ...filtros, ...lerForm(form), pagina: 1 })}`); } },
    campo({ nome: 'situacao', rotulo: 'Situação', tipo: 'select', valor: filtros.situacao,
      opcoes: [['', 'Todas'], ...Object.entries(R.situacaoRepasse).map(([k, [t]]) => [k, t])] }),
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: filtros.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: filtros.ate }),
    el('button', { class: 'botao', type: 'submit' }, 'Filtrar'),
    el('button', { class: 'botao sec', type: 'button', onclick: (e) => acao(e.currentTarget, () => api.baixar(`/repasses/export.csv${qs(filtros)}`, 'repasses.csv')) }, icone('baixar'), 'CSV'));

  alvo.append(
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Repasses'), el('p', {}, 'O líquido da conta gráfica de cada cliente saindo por PIX')),
      pode('repasses.enviar') ? el('div', { class: 'acoes' },
        el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, async () => {
          const r = await api.post('/repasses/rotina', {});
          toast(`Rotina concluída: ${r.enviados} enviado(s), ${r.aguardando} aguardando aprovação, ${r.falhas} falha(s).`, r.falhas ? 'erro' : 'ok');
          recarregar();
        }) }, icone('atualizar'), 'Rodar rotina agora')) : null),

    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Aguardando aprovação', valor: numero(q('aguardando_aprovacao').quantidade), apoio: dinheiro(q('aguardando_aprovacao').valor_centavos), tom: q('aguardando_aprovacao').quantidade ? 'negativo' : '', ic: 'relogio' }),
      kpi({ rotulo: 'Aprovados a enviar', valor: numero(q('aprovado').quantidade), apoio: dinheiro(q('aprovado').valor_centavos), menor: true, ic: 'troca' }),
      kpi({ rotulo: 'Confirmados', valor: numero(q('confirmado').quantidade), apoio: dinheiro(q('confirmado').valor_centavos), menor: true, tom: 'positivo', ic: 'ok' }),
      kpi({ rotulo: 'Com falha', valor: numero(q('falhou').quantidade), apoio: dinheiro(q('falhou').valor_centavos), menor: true, tom: q('falhou').quantidade ? 'negativo' : '', ic: 'alerta' })),

    el('div', { style: 'margin-top:14px' }, form),
    tabela({
      colunas: [
        { titulo: '#', conteudo: (r) => r.id },
        { titulo: 'Cliente', conteudo: (r) => el('span', {}, el('span', { class: 'forte' }, r.nome_fantasia || r.razao_social),
          el('span', { class: 'sub' }, `${r.pix_chave} · ${r.automatico ? 'automático' : 'manual'}`)) },
        { titulo: 'Criado', conteudo: (r) => dataHora(r.criado_em) },
        { titulo: 'Líquido', dir: true, conteudo: (r) => el('span', {}, el('strong', {}, dinheiro(r.valor_liquido_centavos)),
          r.taxa_centavos ? el('span', { class: 'sub' }, `bruto ${dinheiro(r.valor_centavos)}`) : null) },
        { titulo: 'Situação', conteudo: (r) => el('span', {}, selo(r.situacao, R.situacaoRepasse),
          r.erro ? el('span', { class: 'sub' }, r.erro) : r.end_to_end ? el('span', { class: 'sub num' }, r.end_to_end) : null) },
        { titulo: '', dir: true, conteudo: (r) => el('div', { style: 'display:flex;gap:6px;justify-content:flex-end' },
          r.situacao === 'aguardando_aprovacao' && pode('repasses.aprovar')
            ? el('button', { class: 'botao pequeno', onclick: (e) => { e.stopPropagation(); acao(e.currentTarget, async () => {
              await api.post(`/repasses/${r.id}/aprovar`, {});
              await api.post(`/repasses/${r.id}/enviar`, {}).catch(() => null);
              toast('Repasse aprovado e enviado.', 'ok');
              recarregar();
            }); } }, 'Aprovar e enviar') : null,
          r.situacao === 'aprovado' && pode('repasses.enviar')
            ? el('button', { class: 'botao pequeno', onclick: (e) => { e.stopPropagation(); acao(e.currentTarget, async () => {
              await api.post(`/repasses/${r.id}/enviar`, {});
              toast('Repasse enviado.', 'ok');
              recarregar();
            }); } }, 'Enviar') : null,
          ['aguardando_aprovacao', 'aprovado', 'falhou'].includes(r.situacao) && pode('repasses.aprovar')
            ? el('button', { class: 'botao sec pequeno', onclick: async (e) => {
              e.stopPropagation();
              const c = await confirmar({ titulo: 'Cancelar repasse', texto: 'O valor volta para o saldo disponível do cliente como estorno.', confirmarTexto: 'Cancelar repasse', perigo: true, campoMotivo: true });
              if (c) acao(e.currentTarget, async () => { await api.post(`/repasses/${r.id}/cancelar`, c); toast('Repasse cancelado.'); recarregar(); });
            } }, 'Cancelar') : null) },
      ],
      itens: d.itens,
      vazio: 'Nenhum repasse com esses filtros.',
      aoClicar: (r) => ir(`#/clientes/${r.cliente_id}/repasses`),
      rodape: paginacao(d, (p) => ir(`#/repasses${qs({ ...filtros, pagina: p })}`)),
    }),
  );
}
