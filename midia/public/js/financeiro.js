/** Relatórios, fechamento do mês (faturas dos anunciantes) e repasses aos lojistas. */
import { api, qs, baixar } from './api.js';
import {
  el, limpar, icone, toast, acao, modal, formModal, confirmar, perguntar, campo, escolha, lerForm,
  inteiro, dinheiro, duracao, dataBr, dataHora, etiquetaDe, etiqueta, percentual, competenciaTexto,
  STATUS_FATURA, STATUS_REPASSE, COBRANCA, REPASSES,
} from './ui.js';
import { cartao, indicador, tabela, vazio } from './comum.js';

const hojeLocal = () => new Date().toLocaleDateString('en-CA');
const diasAtras = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };
const competenciaAtual = () => hojeLocal().slice(0, 7);
const mesAnterior = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toLocaleDateString('en-CA').slice(0, 7); };

// ---------------------------------------------------------------- Relatórios
export async function relatorios(ctx) {
  const opcoes = await api.get('/painel/opcoes');
  const estado = { aba: 'campanhas', de: diasAtras(29), ate: hojeLocal(), campanha_id: '', tela_id: '', anunciante_id: '', local_id: '', pagina: 1 };
  const corpo = el('div', { class: 'cartao' });

  const ABAS = { campanhas: 'Por campanha', telas: 'Por TV', pontos: 'Por ponto', prova: 'Prova de exibição' };

  const pintar = async () => {
    limpar(corpo, el('p', { class: 'mudo' }, 'Carregando…'));
    const base = { de: estado.de, ate: estado.ate };
    if (estado.aba === 'campanhas') {
      const d = await api.get(`/painel/relatorios/campanhas${qs({ ...base, anunciante_id: estado.anunciante_id })}`);
      limpar(corpo, tabela([
        [(c) => el('div', {}, el('div', {}, c.campanha), el('div', { class: 'pequeno mudo' }, c.anunciante)), 'Campanha'],
        [(c) => COBRANCA[c.cobranca], 'Cobrança'],
        [(c) => inteiro(c.insercoes), 'Inserções', 'num dir'],
        [(c) => duracao(c.segundos), 'Tempo no ar', 'num dir'],
        [(c) => inteiro(c.telas), 'TVs', 'num dir'],
        [(c) => inteiro(c.pontos), 'Pontos', 'num dir'],
        [(c) => inteiro(c.impactos), 'Impactos', 'num dir'],
      ], d.itens, { vazioTexto: 'Nenhuma exibição no período.' }));
    } else if (estado.aba === 'telas') {
      const d = await api.get(`/painel/relatorios/telas${qs(base)}`);
      limpar(corpo, tabela([
        [(t) => el('div', {}, el('div', {}, t.tela), el('div', { class: 'pequeno mudo' }, `${t.local} · ${t.cidade}`)), 'TV'],
        [(t) => inteiro(t.insercoes), 'Inserções', 'num dir'],
        [(t) => inteiro(t.insercoes_pagas), 'De publicidade', 'num dir'],
        [(t) => duracao(t.segundos), 'Tempo no ar', 'num dir'],
        [(t) => `${t.ocupacao}%`, 'Ocupação', 'num dir'],
        [(t) => inteiro(t.campanhas), 'Campanhas', 'num dir'],
        [(t) => inteiro(t.dias), 'Dias com exibição', 'num dir'],
      ], d.itens, { vazioTexto: 'Nenhuma exibição no período.' }));
    } else if (estado.aba === 'pontos') {
      const d = await api.get(`/painel/relatorios/pontos${qs(base)}`);
      limpar(corpo, tabela([
        [(p) => el('div', {}, el('div', {}, p.local), el('div', { class: 'pequeno mudo' }, `${p.cidade}/${p.uf}`)), 'Ponto'],
        [(p) => inteiro(p.telas), 'TVs', 'num dir'],
        [(p) => inteiro(p.publico_dia), 'Público/dia', 'num dir'],
        [(p) => inteiro(p.insercoes), 'Inserções', 'num dir'],
        [(p) => inteiro(p.impactos), 'Impactos', 'num dir'],
        [(p) => percentual(p.comissao_percentual), 'Comissão', 'num dir'],
      ], d.itens, { vazioTexto: 'Nenhuma exibição no período.' }));
    } else {
      const d = await api.get(`/painel/relatorios/prova${qs({ ...base, campanha_id: estado.campanha_id, tela_id: estado.tela_id, pagina: estado.pagina, limite: 200 })}`);
      limpar(corpo,
        el('p', { class: 'pequeno mudo' }, `${inteiro(d.total)} exibições no período · ${duracao(d.segundos)} de tela`),
        tabela([
          [(e) => dataHora(e.exibida_em), 'Data e hora'],
          [(e) => el('div', {}, el('div', {}, e.tela), el('div', { class: 'pequeno mudo' }, `${e.local} · ${e.cidade}`)), 'TV'],
          [(e) => e.anunciante, 'Anunciante'],
          [(e) => e.campanha, 'Campanha'],
          [(e) => e.midia ?? '—', 'Criativo'],
          [(e) => `${e.duracao_s}s`, 'Duração', 'num dir'],
        ], d.itens, { vazioTexto: 'Nenhuma exibição no período.' }),
        d.total > 200 ? el('div', { class: 'paginacao' },
          el('button', { class: 'btn pequeno', disabled: estado.pagina <= 1, onclick: () => { estado.pagina--; pintar(); } }, 'Anteriores'),
          el('span', { class: 'pequeno mudo' }, `Página ${estado.pagina} de ${Math.ceil(d.total / 200)}`),
          el('button', { class: 'btn pequeno', disabled: estado.pagina >= Math.ceil(d.total / 200), onclick: () => { estado.pagina++; pintar(); } }, 'Próximas')) : null);
    }
  };

  const abas = el('div', { class: 'linha' }, Object.entries(ABAS).map(([k, rotulo]) => el('button', {
    class: `btn pequeno${estado.aba === k ? ' primario' : ''}`,
    onclick: (e) => { estado.aba = k; estado.pagina = 1; for (const b of e.target.parentElement.children) b.classList.remove('primario'); e.target.classList.add('primario'); pintar(); },
  }, rotulo)));

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      campo('De', { type: 'date', value: estado.de, onchange: (e) => { estado.de = e.target.value; pintar(); } }),
      campo('Até', { type: 'date', value: estado.ate, onchange: (e) => { estado.ate = e.target.value; pintar(); } }),
      escolha('Anunciante', 'anunciante_id', { '': 'Todos', ...Object.fromEntries(opcoes.anunciantes.map((a) => [a.id, a.nome])) }, '',
        { onchange: (e) => { estado.anunciante_id = e.target.value; pintar(); } }),
      escolha('TV', 'tela_id', { '': 'Todas', ...Object.fromEntries(opcoes.telas.map((t) => [t.id, `${t.local_nome} — ${t.nome}`])) }, '',
        { onchange: (e) => { estado.tela_id = e.target.value; pintar(); } }),
      el('button', {
        class: 'btn', onclick: (e) => acao(e.target, async () => {
          const rota = { campanhas: 'campanhas', telas: 'telas', pontos: 'pontos', prova: 'prova' }[estado.aba];
          await baixar(`/painel/relatorios/${rota}${qs({ de: estado.de, ate: estado.ate, anunciante_id: estado.anunciante_id, tela_id: estado.tela_id, csv: 1 })}`,
            `${rota}-${estado.de}-${estado.ate}.csv`);
        }),
      }, icone('baixar'), 'Baixar CSV')),
    el('div', { class: 'coluna' }, abas, corpo));
  await pintar();
}

// ---------------------------------------------------------------- Faturamento
export async function faturamento(ctx) {
  const estado = { competencia: mesAnterior() };
  const corpo = el('div', { class: 'coluna' });

  const pintar = async () => {
    const d = await api.get(`/painel/faturamento${qs({ competencia: estado.competencia })}`);
    const faturas = await api.get('/painel/faturas');
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({ rotulo: `Previsto em ${competenciaTexto(d.competencia)}`, valor: dinheiro(d.total_centavos), ic: 'dinheiro', cor: 'verde', nota: `${d.previa.length} anunciantes` }),
        indicador({ rotulo: 'Repasse aos pontos', valor: dinheiro(d.repasses.reduce((t, r) => t + r.valor_centavos, 0)), ic: 'repasses', cor: 'laranja', nota: `${d.repasses.length} pontos` }),
        indicador({ rotulo: 'Faturas em aberto', valor: dinheiro(faturas.totais.aberto_centavos), ic: 'faturamento', cor: faturas.totais.atrasadas ? 'vermelho' : 'azul', nota: `${faturas.totais.atrasadas} atrasadas` }),
        indicador({ rotulo: 'Recebido (tudo)', valor: dinheiro(faturas.totais.pago_centavos), ic: 'ok', cor: 'verde' })),

      cartao(`Prévia do fechamento — ${competenciaTexto(d.competencia)}`,
        el('p', { class: 'pequeno mudo', style: 'margin-top:-8px' },
          'Calculada agora a partir do que foi exibido. Fechar o mês grava as faturas e os repasses; faturas já pagas não são alteradas.'),
        tabela([
          [(f) => el('div', {}, el('div', {}, f.anunciante), f.agencia ? el('div', { class: 'pequeno mudo' }, `via ${f.agencia}`) : null), 'Anunciante'],
          [(f) => el('div', {}, f.itens.map((i) => el('div', { class: 'pequeno mudo' }, `${i.descricao} — ${inteiro(i.insercoes)} inserções`))), 'Campanhas'],
          [(f) => inteiro(f.itens.reduce((t, i) => t + i.impactos, 0)), 'Impactos', 'num dir'],
          [(f) => dinheiro(f.bruto_centavos), 'Bruto', 'num dir'],
          [(f) => (f.comissao_agencia_centavos ? `- ${dinheiro(f.comissao_agencia_centavos)}` : '—'), 'Agência', 'num dir'],
          [(f) => el('strong', {}, dinheiro(f.valor_centavos)), 'Líquido', 'num dir'],
        ], d.previa, { vazioTexto: 'Nada a faturar nesta competência.' }),
        el('div', { class: 'linha entre', style: 'margin-top:14px' },
          el('span', { class: 'pequeno mudo' }, d.gravados ? `${d.gravados} fatura(s) já gravada(s) nesta competência.` : 'Competência ainda não fechada.'),
          el('button', {
            class: 'btn primario', onclick: (e) => acao(e.target, async () => {
              if (!await confirmar('Fechar a competência', `Gerar as faturas e os repasses de ${competenciaTexto(d.competencia)}?`, 'Fechar o mês')) return;
              const r = await api.post('/painel/faturamento/gerar', { competencia: estado.competencia });
              toast(`${r.geradas} fatura(s) e ${r.repasses} repasse(s) gravados. Vencimento: ${dataBr(r.vencimento)}.`);
              pintar();
            }),
          }, icone('ok'), 'Fechar o mês'))),

      cartao('Faturas', tabela([
        [(f) => f.anunciante, 'Anunciante'],
        [(f) => competenciaTexto(f.competencia), 'Competência'],
        [(f) => dinheiro(f.valor_centavos), 'Valor', 'num dir'],
        [(f) => el('span', { style: f.atrasada ? 'color:var(--erro);font-weight:700' : null }, dataBr(f.vencimento)), 'Vencimento'],
        [(f) => (f.atrasada ? etiqueta('Atrasada', 'erro') : etiquetaDe(STATUS_FATURA, f.status)), 'Situação'],
        [(f) => (f.pago_em ? dataBr(f.pago_em) : '—'), 'Pagamento'],
      ], faturas.itens, { aoClicar: (f) => abrirFatura(f.id, pintar), vazioTexto: 'Nenhuma fatura gerada.' })));
  };

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      campo('Competência', { type: 'month', value: estado.competencia, max: competenciaAtual(), onchange: (e) => { estado.competencia = e.target.value || mesAnterior(); pintar(); } })),
    corpo);
  await pintar();
}

async function abrirFatura(id, recarregar) {
  const f = await api.get(`/painel/faturas/${id}`);
  await modal(`Fatura ${competenciaTexto(f.competencia)} — ${f.anunciante}`, (fechar) => [
    el('div', { class: 'linha entre' },
      el('div', { class: 'linha' }, f.atrasada ? etiqueta('Atrasada', 'erro') : etiquetaDe(STATUS_FATURA, f.status),
        el('span', { class: 'mudo pequeno' }, `Vence em ${dataBr(f.vencimento)} · período ${dataBr(f.periodo.de)} a ${dataBr(f.periodo.ate)}`)),
      el('strong', { style: 'font-size:20px' }, dinheiro(f.valor_centavos))),
    f.agencia ? el('p', { class: 'mudo pequeno', style: 'margin:6px 0 0' }, `Agência: ${f.agencia}`) : null,
    el('table', { class: 'fatura-itens', style: 'margin:16px 0' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Campanha'), el('th', { class: 'dir' }, 'Inserções'), el('th', { class: 'dir' }, 'Impactos'), el('th', { class: 'dir' }, 'TVs'), el('th', { class: 'dir' }, 'Valor'))),
      el('tbody', {}, f.itens.map((i) => el('tr', {},
        el('td', {}, i.descricao), el('td', { class: 'dir num' }, inteiro(i.insercoes)), el('td', { class: 'dir num' }, inteiro(i.impactos)),
        el('td', { class: 'dir num' }, inteiro(i.telas)), el('td', { class: 'dir num' }, dinheiro(i.valor_centavos))))),
      el('tfoot', {},
        f.comissao_agencia_centavos ? el('tr', {}, el('td', { colspan: 4 }, 'Bruto'), el('td', { class: 'dir num' }, dinheiro(f.bruto_centavos))) : null,
        f.comissao_agencia_centavos ? el('tr', {}, el('td', { colspan: 4 }, 'Comissão de agência'), el('td', { class: 'dir num' }, `- ${dinheiro(f.comissao_agencia_centavos)}`)) : null,
        el('tr', {}, el('td', { colspan: 4 }, f.comissao_agencia_centavos ? 'Líquido' : 'Total'), el('td', { class: 'dir num' }, dinheiro(f.valor_centavos))))),
    f.pix ? el('div', { class: 'pix' },
      f.pix.qr ? el('img', { src: f.pix.qr, alt: 'QR Code do PIX' }) : el('div', {}),
      el('div', {}, el('strong', {}, 'PIX copia e cola'), el('div', { class: 'segredo', style: 'margin:8px 0' }, f.pix.codigo),
        el('button', {
          class: 'btn pequeno', onclick: () => { navigator.clipboard?.writeText(f.pix.codigo); toast('Código PIX copiado.'); },
        }, 'Copiar código'))) : null,
    f.observacao ? el('p', { class: 'aviso' }, f.observacao) : null,
    el('div', { class: 'linha entre', style: 'margin-top:18px' },
      el('div', { class: 'linha' },
        f.status === 'aberta' ? el('button', {
          class: 'btn primario', onclick: (e) => acao(e.target, async () => {
            const quando = await perguntar('Marcar como paga', 'Data do pagamento (AAAA-MM-DD)', { valor: hojeLocal() });
            if (!quando) return;
            await api.post(`/painel/faturas/${f.id}/pagar`, { pago_em: quando });
            toast('Fatura marcada como paga.');
            fechar();
            recarregar();
          }),
        }, icone('ok'), 'Marcar como paga') : null,
        f.status !== 'paga' ? el('button', {
          class: 'btn perigo', onclick: (e) => acao(e.target, async () => {
            const motivo = await perguntar('Cancelar fatura', 'Motivo');
            if (!motivo) return;
            await api.post(`/painel/faturas/${f.id}/cancelar`, { motivo });
            toast('Fatura cancelada.');
            fechar();
            recarregar();
          }),
        }, 'Cancelar fatura') : null),
      el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

// ---------------------------------------------------------------- Repasses
export async function repasses(ctx) {
  const estado = { status: '', competencia: '' };
  const corpo = el('div', { class: 'cartao' });

  const pintar = async () => {
    const d = await api.get(`/painel/repasses${qs(estado)}`);
    limpar(corpo,
      el('p', { class: 'pequeno mudo' }, `A pagar: ${dinheiro(d.total_centavos)}`),
      tabela([
        [(r) => el('div', {}, el('div', {}, r.local), el('div', { class: 'pequeno mudo' }, `${r.cidade ?? ''}${r.responsavel ? ` · ${r.responsavel}` : ''}`)), 'Ponto'],
        [(r) => competenciaTexto(r.competencia), 'Competência'],
        [(r) => dinheiro(r.base_centavos), 'Receita das TVs', 'num dir'],
        [(r) => (r.tipo === 'fixo' ? 'Valor fixo' : percentual(r.comissao_percentual)), 'Combinado', 'num dir'],
        [(r) => el('strong', {}, dinheiro(r.valor_centavos)), 'Repasse', 'num dir'],
        [(r) => etiquetaDe(STATUS_REPASSE, r.status), 'Situação'],
        [(r) => (r.pago_em ? dataBr(r.pago_em) : '—'), 'Pago em'],
        [(r) => (r.status === 'a_pagar' ? el('button', {
          class: 'btn pequeno primario', onclick: (e) => acao(e.target, async () => {
            if (!await confirmar('Marcar repasse como pago', `${r.local} — ${dinheiro(r.valor_centavos)} (${competenciaTexto(r.competencia)})`, 'Marcar como pago')) return;
            await api.post(`/painel/repasses/${r.id}/pagar`, {});
            toast('Repasse marcado como pago.');
            pintar();
          }),
        }, 'Pagar') : '—'), '', 'acoes'],
      ], d.itens, { vazioTexto: 'Nenhum repasse. Eles são criados quando o mês é fechado no Faturamento.' }));
  };

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      escolha('Situação', 'status', { '': 'Todos', a_pagar: 'A pagar', pago: 'Pagos' }, '', { onchange: (e) => { estado.status = e.target.value; pintar(); } }),
      campo('Competência', { type: 'month', onchange: (e) => { estado.competencia = e.target.value; pintar(); } })),
    corpo);
  await pintar();
}
