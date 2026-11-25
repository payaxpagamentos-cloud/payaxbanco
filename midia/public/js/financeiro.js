/** Relatórios, fechamento do mês (faturas dos anunciantes) e repasses aos lojistas. */
import { api, qs, baixar } from './api.js';
import {
  el, limpar, icone, toast, acao, modal, formModal, confirmar, perguntar, campo, escolha, area, lerForm, centavos, reaisCampo,
  inteiro, dinheiro, duracao, dataBr, dataHora, etiquetaDe, etiqueta, percentual, competenciaTexto, abrirWhatsApp,
  STATUS_FATURA, STATUS_REPASSE, COBRANCA, REPASSES,
} from './ui.js';
import { cartao, indicador, tabela, vazio } from './comum.js';
import { barrasComparadas, pizza, CORES } from './graficos.js';

const hojeLocal = () => new Date().toLocaleDateString('en-CA');
const diasAtras = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };
const competenciaAtual = () => hojeLocal().slice(0, 7);
const primeiroDoMes = () => `${competenciaAtual()}-01`;
const ultimoDoMes = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0).toLocaleDateString('en-CA'); };
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
    const receber = await api.get('/painel/contas-a-receber');
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({ rotulo: `Previsto em ${competenciaTexto(d.competencia)}`, valor: dinheiro(d.total_centavos), ic: 'dinheiro', cor: 'verde', nota: `${d.previa.length} anunciantes` }),
        indicador({ rotulo: 'Repasse aos pontos', valor: dinheiro(d.repasses.reduce((t, r) => t + r.valor_centavos, 0)), ic: 'repasses', cor: 'laranja', nota: `${d.repasses.length} pontos` }),
        indicador({ rotulo: 'Faturas em aberto', valor: dinheiro(receber.totais.aberto_centavos), ic: 'faturamento', cor: receber.totais.atrasado_centavos ? 'vermelho' : 'azul', nota: `${dinheiro(receber.totais.atrasado_centavos)} atrasado` }),
        indicador({ rotulo: 'Recebido (tudo)', valor: dinheiro(receber.totais.recebido_centavos), ic: 'ok', cor: 'verde' })),

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

      cartao(`Faturas de ${competenciaTexto(d.competencia)}`,
        el('p', { class: 'pequeno mudo', style: 'margin-top:-8px' }, 'A lista completa, com baixa e cobrança, fica em Contas a receber.'),
        tabela([
          [(f) => f.anunciante, 'Anunciante'],
          [(f) => dinheiro(f.valor_centavos), 'Valor', 'num dir'],
          [(f) => dataBr(f.vencimento), 'Vencimento'],
          [(f) => etiquetaDe(STATUS_FATURA, f.status), 'Situação'],
        ], d.faturas, { aoClicar: (f) => abrirFatura(f.id, pintar), vazioTexto: 'Esta competência ainda não foi fechada.' })),
      cartao('Repasses gerados', tabela([
        [(x) => x.local, 'Ponto'],
        [(x) => (x.tipo === 'fixo' ? 'Valor fixo' : percentual(x.comissao_percentual)), 'Combinado', 'num dir'],
        [(x) => dinheiro(x.base_centavos), 'Receita das telas', 'num dir'],
        [(x) => el('strong', {}, dinheiro(x.valor_centavos)), 'Repasse', 'num dir'],
      ], d.repasses, { vazioTexto: 'Nenhum repasse nesta competência.' })));
  };

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      campo('Competência', { type: 'month', value: estado.competencia, max: competenciaAtual(), onchange: (e) => { estado.competencia = e.target.value || mesAnterior(); pintar(); } })),
    corpo);
  await pintar();
}

/**
 * Nota fiscal da fatura. A emissão da NFS-e sai do sistema da prefeitura (exige certificado digital),
 * então o painel guarda o número, a data e o link da nota — e mostra quais faturas ainda estão sem.
 */
function blocoNota(f, recarregar) {
  const registrar = () => formModal(f.nf_numero ? 'Alterar a nota fiscal' : 'Registrar a nota fiscal', () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
      'Emita a NFS-e no sistema da prefeitura e anote aqui o número, para o financeiro saber o que já foi para o contador.'),
    el('div', { class: 'duas' },
      campo('Número da nota', { name: 'nf_numero', value: f.nf_numero ?? '', required: true, maxlength: 40 }),
      campo('Emitida em', { name: 'nf_emitida_em', type: 'date', value: f.nf_emitida_em ?? hojeLocal(), required: true })),
    campo('Link da nota (opcional)', { name: 'nf_link', value: f.nf_link ?? '', maxlength: 500, placeholder: 'https://…' }),
  ], async (form) => {
    await api.put(`/painel/faturas/${f.id}/nota`, lerForm(form));
    toast('Nota registrada.');
    recarregar();
  });

  if (f.status === 'cancelada') return null;
  return el('div', { class: 'cartao raso', style: 'margin-top:14px' },
    el('div', { class: 'linha entre' },
      el('div', {},
        el('strong', {}, 'Nota fiscal'),
        el('div', { class: 'pequeno mudo' }, f.nf_numero
          ? `Nº ${f.nf_numero} · emitida em ${dataBr(f.nf_emitida_em)}`
          : 'Ainda não emitida para esta fatura.')),
      el('div', { class: 'linha' },
        f.nf_link ? el('a', { class: 'btn pequeno', href: f.nf_link, target: '_blank', rel: 'noopener' }, 'Abrir nota') : null,
        el('button', { class: `btn pequeno ${f.nf_numero ? '' : 'primario'}`, onclick: registrar }, f.nf_numero ? 'Alterar' : 'Registrar nota'),
        f.nf_numero ? el('button', {
          class: 'icone-btn', title: 'Remover o registro da nota', onclick: (e) => acao(e.target, async () => {
            if (!await confirmar('Remover a nota', 'O número da nota sai da fatura. A nota emitida na prefeitura não é afetada.')) return;
            await api.del(`/painel/faturas/${f.id}/nota`);
            toast('Registro removido.');
            recarregar();
          }),
        }, icone('lixeira')) : null)));
}

/**
 * Cobrança no WhatsApp: a mesma coisa que o e-mail automático diz, no canal em que o cliente responde.
 * Quando a fatura tem PIX, o código copia e cola vai junto — é o que resolve o pagamento na hora,
 * sem o cliente precisar abrir o portal.
 */
function cobrarNoWhatsApp(f, pix = null) {
  const vencida = f.status === 'aberta' && f.vencimento < hojeLocal();
  const texto = `Olá, ${f.anunciante}! ${vencida ? 'Passando para lembrar da' : 'Segue a'} fatura de `
    + `${competenciaTexto(f.competencia)} da veiculação: ${dinheiro(f.valor_centavos)}, com vencimento em ${dataBr(f.vencimento)}.`
    + (pix?.codigo ? `\n\nPIX copia e cola:\n${pix.codigo}` : '')
    + '\n\nQualquer dúvida é só responder por aqui.';
  return abrirWhatsApp(f.anunciante_telefone ?? f.telefone, texto,
    'Este cliente não tem telefone cadastrado. Inclua o número na ficha dele para cobrar por WhatsApp.');
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
    blocoNota(f, async () => { fechar(); await recarregar(); abrirFatura(f.id, recarregar); }),
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
        f.status === 'aberta' ? el('button', {
          class: 'btn', title: 'Abre o WhatsApp do cliente com a cobrança e o PIX prontos',
          onclick: () => cobrarNoWhatsApp(f, f.pix),
        }, icone('enviar'), 'Cobrar no WhatsApp') : null,
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

// ================================================================ Fluxo de caixa
const CORES_SAIDA = [CORES.marca, CORES.oliva, CORES.azul, CORES.amarelo, CORES.cinza, CORES.vermelho, CORES.verde, CORES.grafite];

/**
 * O que entrou e o que saiu, junto: o realizado é pela data do pagamento e o previsto, pela do vencimento.
 * É a resposta para "quanto sobra no fim do mês", que contas a pagar e a receber só davam separadas.
 */
export async function fluxoCaixa(ctx) {
  const estado = { de: primeiroDoMes(), ate: ultimoDoMes() };
  const corpo = el('div', { class: 'coluna' });

  const pintar = async () => {
    limpar(corpo, el('p', { class: 'mudo' }, 'Carregando…'));
    const d = await api.get(`/painel/fluxo-caixa${qs(estado)}`);
    const saldo = d.realizado.saldo_centavos;
    const sinal = (c) => `${c < 0 ? '−' : ''}${dinheiro(Math.abs(c))}`;

    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({ rotulo: 'Entrou no período', valor: dinheiro(d.realizado.recebido_centavos), ic: 'faturamento', cor: 'verde' }),
        indicador({ rotulo: 'Saiu no período', valor: dinheiro(d.realizado.pago_centavos), ic: 'repasses', cor: 'laranja' }),
        indicador({
          rotulo: 'Saldo realizado', valor: sinal(saldo), ic: saldo >= 0 ? 'ok' : 'erro', cor: saldo >= 0 ? 'verde' : 'vermelho',
          nota: 'pelo que foi pago e recebido',
        }),
        indicador({
          rotulo: 'Projetado', valor: sinal(d.projetado_centavos), ic: 'relogio', cor: d.projetado_centavos >= 0 ? 'azul' : 'vermelho',
          nota: 'se tudo em aberto for pago no prazo',
        })),

      cartao('Ainda em aberto no período', tabela([
        [(x) => x.rotulo, 'Previsto'],
        [(x) => el('span', { style: x.cor ? `color:${x.cor};font-weight:700` : null }, x.valor), 'Valor', 'num dir'],
      ], [
        { rotulo: 'A receber (faturas em aberto que vencem no período)', valor: dinheiro(d.previsto.a_receber_centavos) },
        { rotulo: 'A pagar (repasses e despesas que vencem no período)', valor: dinheiro(d.previsto.a_pagar_centavos) },
        { rotulo: 'Saldo previsto', valor: sinal(d.previsto.saldo_centavos), cor: d.previsto.saldo_centavos >= 0 ? null : 'var(--erro)' },
      ]),
      el('p', { class: 'pequeno mudo' },
        `Nos próximos 30 dias: ${dinheiro(d.proximos.receber_centavos)} a receber e ${dinheiro(d.proximos.pagar_centavos)} a pagar.`)),

      el('div', { class: 'grade-dash' },
        el('div', { class: 'c7' }, cartao('Entrou e saiu, mês a mês', d.por_mes.length
          ? barrasComparadas(d.por_mes.map((m) => ({ rotulo: competenciaTexto(m.competencia).replace(/ de \d{4}$/, ''), a: m.entrou, b: m.saiu })),
            { formato: (c) => dinheiro(c) })
          : vazio('Sem movimento registrado ainda.'))),
        el('div', { class: 'c5' }, cartao('Para onde foi o dinheiro', d.saidas_por_categoria.length
          ? pizza(d.saidas_por_categoria.map((c, i) => ({
            rotulo: c.categoria === 'repasse' ? 'Repasse aos pontos' : (CATEGORIAS_DESPESA[c.categoria] ?? c.categoria),
            valor: c.valor_centavos, cor: CORES_SAIDA[i % CORES_SAIDA.length],
          })), { formato: (c) => dinheiro(c), lado: true })
          : vazio('Nenhuma saída paga no período.')))),

      cartao('Movimentos do caixa', tabela([
        [(x) => dataBr(x.data), 'Data'],
        [(x) => etiqueta(x.tipo === 'entrada' ? 'Entrada' : 'Saída', x.tipo === 'entrada' ? 'ok' : 'aviso'), 'Tipo'],
        [(x) => el('div', {}, el('div', {}, x.descricao), x.quem ? el('div', { class: 'pequeno mudo' }, x.quem) : null), 'Lançamento'],
        [(x) => el('span', { style: `font-weight:700;color:${x.tipo === 'entrada' ? 'var(--ok)' : 'var(--text-2)'}` },
          `${x.tipo === 'entrada' ? '+' : '−'} ${dinheiro(x.valor_centavos)}`), 'Valor', 'num dir'],
      ], d.movimentos, { vazioTexto: 'Nenhum pagamento ou recebimento no período.' })));
  };

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      campo('De', { type: 'date', value: estado.de, onchange: (e) => { estado.de = e.target.value; pintar(); } }),
      campo('Até', { type: 'date', value: estado.ate, onchange: (e) => { estado.ate = e.target.value; pintar(); } }),
      el('button', {
        class: 'btn', onclick: (e) => acao(e.target, () => baixar(`/painel/fluxo-caixa${qs({ ...estado, csv: 1 })}`, `fluxo-de-caixa-${estado.de}-${estado.ate}.csv`)),
      }, icone('baixar'), 'Baixar CSV')),
    corpo);
  await pintar();
}

// ================================================================ Contas a receber
/** As faturas dos anunciantes: o que entra, o que vence e o que já atrasou (com as faixas de atraso). */
export async function contasAReceber(ctx) {
  const estado = { status: '', anunciante_id: '', de: '', ate: '', nota: '' };
  const corpo = el('div', { class: 'coluna' });
  const opcoes = await api.get('/painel/opcoes');

  const pintar = async () => {
    const d = await api.get(`/painel/contas-a-receber${qs(estado)}`);
    const a = d.atraso;
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({ rotulo: 'Em aberto', valor: dinheiro(d.totais.aberto_centavos), ic: 'faturamento', cor: 'azul' }),
        indicador({
          rotulo: 'Atrasado', valor: dinheiro(d.totais.atrasado_centavos), ic: 'erro',
          cor: d.totais.atrasado_centavos ? 'vermelho' : 'verde',
          nota: d.totais.clientes_em_atraso ? `${d.totais.clientes_em_atraso} cliente(s)` : 'ninguém em atraso',
        }),
        indicador({ rotulo: 'Vence em 7 dias', valor: dinheiro(d.totais.vence_em_7_centavos), ic: 'relogio', cor: 'laranja' }),
        indicador({ rotulo: 'Já recebido', valor: dinheiro(d.totais.recebido_centavos), ic: 'ok', cor: 'verde' }),
        indicador({
          rotulo: 'Faturas sem nota', valor: inteiro(d.totais.sem_nota), ic: 'relatorios', cor: d.totais.sem_nota ? 'laranja' : 'verde',
          nota: 'NFS-e emitida na prefeitura',
        })),

      d.totais.atrasado_centavos
        ? cartao('Atraso por faixa', tabela([
          [(x) => x.faixa, 'Faixa'],
          [(x) => dinheiro(x.valor), 'Valor', 'num dir'],
        ], [
          { faixa: 'Até 30 dias', valor: a.ate_30 }, { faixa: '31 a 60 dias', valor: a.de_31_a_60 },
          { faixa: '61 a 90 dias', valor: a.de_61_a_90 }, { faixa: 'Mais de 90 dias', valor: a.mais_de_90 },
        ].filter((x) => x.valor > 0)))
        : null,

      cartao('Faturas', tabela([
        [(f) => el('div', {}, el('div', {}, f.anunciante),
          el('div', { class: 'pequeno mudo' }, [f.agencia ? `via ${f.agencia}` : null, f.contrato ? `contrato ${f.contrato}` : null].filter(Boolean).join(' · ') || '—')), 'Cliente'],
        [(f) => competenciaTexto(f.competencia), 'Competência'],
        [(f) => dinheiro(f.valor_centavos), 'Valor', 'num dir'],
        [(f) => el('span', { style: f.atrasada ? 'color:var(--erro);font-weight:700' : null }, dataBr(f.vencimento)), 'Vencimento'],
        [(f) => (f.atrasada ? etiqueta(`${f.dias_atraso} dia(s) de atraso`, 'erro') : etiquetaDe(STATUS_FATURA, f.status)), 'Situação'],
        [(f) => (f.pago_em ? dataBr(f.pago_em) : '—'), 'Recebido em'],
        [(f) => (f.nf_numero ? etiqueta(`NF ${f.nf_numero}`, 'ok') : etiqueta('Sem nota')), 'Nota fiscal'],
        [(f) => (f.status === 'aberta'
          ? el('button', {
            class: 'btn pequeno', title: 'Cobrar este cliente no WhatsApp',
            onclick: (e) => { e.stopPropagation(); cobrarNoWhatsApp(f); },
          }, icone('enviar'), 'Cobrar')
          : ''), '', 'acoes'],
      ], d.itens, { aoClicar: (f) => abrirFatura(f.id, pintar), vazioTexto: 'Nenhuma fatura. Elas nascem no fechamento do mês, em Faturamento.' })));
  };

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      escolha('Situação', 'status', { '': 'Todas', aberta: 'Em aberto', paga: 'Recebidas' }, '', { onchange: (e) => { estado.status = e.target.value; pintar(); } }),
      escolha('Cliente', 'anunciante_id', { '': 'Todos', ...Object.fromEntries(opcoes.anunciantes.map((x) => [x.id, x.nome])) }, '',
        { onchange: (e) => { estado.anunciante_id = e.target.value; pintar(); } }),
      campo('Vencimento de', { type: 'date', onchange: (e) => { estado.de = e.target.value; pintar(); } }),
      campo('até', { type: 'date', onchange: (e) => { estado.ate = e.target.value; pintar(); } }),
      escolha('Nota fiscal', 'nota', { '': 'Todas', nao: 'Sem nota emitida', sim: 'Com nota' }, '',
        { onchange: (e) => { estado.nota = e.target.value; pintar(); } }),
      el('button', {
        class: 'btn', onclick: (e) => acao(e.target, () => baixar(`/painel/contas-a-receber${qs({ ...estado, csv: 1 })}`, `contas-a-receber-${hojeLocal()}.csv`)),
      }, icone('baixar'), 'Baixar CSV'),
      el('button', {
        class: 'btn', title: 'Planilha com tomador, CNPJ, descrição do serviço e valor — o que o contador precisa para emitir as notas',
        onclick: (e) => acao(e.target, () => baixar(`/painel/notas-fiscais${qs({ competencia: '', emitida: 'nao', csv: 1 })}`, `notas-a-emitir-${hojeLocal()}.csv`)),
      }, icone('baixar'), 'Notas a emitir')),
    corpo);
  await pintar();
}

// ================================================================ Contas a pagar
const CATEGORIAS_DESPESA = {
  internet: 'Internet do ponto', aparelho: 'Aparelho / TV', instalacao: 'Instalação', manutencao: 'Manutenção',
  aluguel_espaco: 'Aluguel de espaço', comissao: 'Comissão de venda', energia: 'Energia', software: 'Software',
  imposto: 'Imposto', outros: 'Outros',
};

/** O que a rede tem para pagar: os repasses aos pontos e as despesas da operação, numa lista só. */
export async function contasAPagar(ctx) {
  const estado = { status: '', tipo: '', de: '', ate: '' };
  const corpo = el('div', { class: 'coluna' });

  const pintar = async () => {
    const d = await api.get(`/painel/contas-a-pagar${qs(estado)}`);
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador({ rotulo: 'Em aberto', valor: dinheiro(d.totais.aberto_centavos), ic: 'repasses', cor: 'azul' }),
        indicador({ rotulo: 'Atrasado', valor: dinheiro(d.totais.atrasado_centavos), ic: 'erro', cor: d.totais.atrasado_centavos ? 'vermelho' : 'verde' }),
        indicador({ rotulo: 'Vence em 7 dias', valor: dinheiro(d.totais.vence_em_7_centavos), ic: 'relogio', cor: 'laranja' }),
        indicador({
          rotulo: 'Repasses aos pontos', valor: dinheiro(d.totais.repasses_centavos), ic: 'pontos', cor: 'roxo',
          nota: `despesas: ${dinheiro(d.totais.despesas_centavos)}`,
        })),

      cartao('Contas', tabela([
        [(x) => el('div', {}, el('div', {}, x.descricao),
          el('div', { class: 'pequeno mudo' }, x.tipo === 'repasse' ? 'Repasse ao ponto (do fechamento do mês)' : (CATEGORIAS_DESPESA[x.categoria] ?? x.categoria))), 'Conta'],
        [(x) => x.fornecedor ?? '—', 'Para quem'],
        [(x) => el('span', { style: x.atrasada ? 'color:var(--erro);font-weight:700' : null }, dataBr(x.vencimento)), 'Vencimento'],
        [(x) => dinheiro(x.valor_centavos), 'Valor', 'num dir'],
        [(x) => (x.status === 'paga' ? etiqueta(`Pago em ${dataBr(x.pago_em)}`, 'ok') : (x.atrasada ? etiqueta('Atrasada', 'erro') : etiqueta('Em aberto', 'info'))), 'Situação'],
        [(x) => el('div', { class: 'acoes' },
          x.status === 'aberta'
            ? el('button', {
              class: 'btn pequeno primario', onclick: (e) => acao(e.target, async () => {
                const quando = await perguntar('Marcar como paga', 'Data do pagamento (AAAA-MM-DD)', { valor: hojeLocal() });
                if (!quando) return;
                await api.post(`/painel/${x.tipo === 'repasse' ? 'repasses' : 'despesas'}/${x.id}/pagar`, { pago_em: quando });
                toast('Conta baixada.');
                pintar();
              }),
            }, 'Pagar')
            : (x.tipo === 'despesa'
              ? el('button', {
                class: 'btn pequeno', onclick: (e) => acao(e.target, async () => {
                  await api.post(`/painel/despesas/${x.id}/estornar`, {});
                  toast('Pagamento estornado.');
                  pintar();
                }),
              }, 'Estornar')
              : '—'),
          x.tipo === 'despesa' && x.status === 'aberta'
            ? el('button', { class: 'icone-btn', title: 'Editar', onclick: () => editarDespesa(x, pintar) }, icone('editar'))
            : null), '', 'acoes'],
      ], d.itens, { vazioTexto: 'Nada a pagar no período. Os repasses aparecem quando o mês é fechado.' })));
  };

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      escolha('Situação', 'status', { '': 'Todas', aberta: 'Em aberto', paga: 'Pagas' }, '', { onchange: (e) => { estado.status = e.target.value; pintar(); } }),
      escolha('Tipo', 'tipo', { '': 'Tudo', repasse: 'Repasses aos pontos', despesa: 'Despesas da operação' }, '', { onchange: (e) => { estado.tipo = e.target.value; pintar(); } }),
      campo('Vencimento de', { type: 'date', onchange: (e) => { estado.de = e.target.value; pintar(); } }),
      campo('até', { type: 'date', onchange: (e) => { estado.ate = e.target.value; pintar(); } }),
      el('button', {
        class: 'btn', onclick: (e) => acao(e.target, () => baixar(`/painel/contas-a-pagar${qs({ ...estado, csv: 1 })}`, `contas-a-pagar-${hojeLocal()}.csv`)),
      }, icone('baixar'), 'Baixar CSV'),
      el('button', { class: 'btn primario', onclick: () => editarDespesa(null, pintar) }, icone('mais'), 'Lançar despesa')),
    corpo);
  await pintar();
}

/** Lançamento de despesa, com repetição mensal para as contas que chegam todo mês. */
function editarDespesa(despesa, recarregar) {
  return api.get('/painel/opcoes').then((opcoes) => formModal(despesa ? 'Editar despesa' : 'Lançar despesa', () => [
    campo('Descrição', { name: 'descricao', value: despesa?.descricao ?? '', required: true, maxlength: 160, placeholder: 'Ex.: Internet do Edifício Jardim' }),
    el('div', { class: 'duas' },
      campo('Fornecedor', { name: 'fornecedor', value: despesa?.fornecedor ?? '', maxlength: 120 }),
      escolha('Categoria', 'categoria', CATEGORIAS_DESPESA, despesa?.categoria ?? 'outros')),
    el('div', { class: 'duas' },
      campo('Vencimento', { name: 'vencimento', type: 'date', value: despesa?.vencimento ?? hojeLocal(), required: true }),
      campo('Valor (R$)', { name: 'valor', value: reaisCampo(despesa?.valor_centavos), inputmode: 'decimal', required: true })),
    el('div', { class: 'duas' },
      escolha('Ponto (quando a conta é de um ponto)', 'local_id', { '': 'Nenhum', ...Object.fromEntries(opcoes.locais.map((l) => [l.id, l.nome])) }, despesa?.local_id ?? ''),
      despesa ? null : escolha('Repetir', 'repete_meses', { 0: 'Só esta', 2: 'Por 3 meses', 5: 'Por 6 meses', 11: 'Por 12 meses', 23: 'Por 24 meses' }, 0)),
    area('Observação', { name: 'observacao', maxlength: 300 }, despesa?.observacao ?? ''),
  ], async (d) => {
    const corpo = { ...d, valor_centavos: centavos(d.valor), repete_meses: Number(d.repete_meses ?? 0) };
    delete corpo.valor;
    if (despesa) await api.patch(`/painel/despesas/${despesa.id}`, corpo);
    else {
      const r = await api.post('/painel/despesas', corpo);
      toast(r.criadas > 1 ? `${r.criadas} contas lançadas (uma por mês).` : 'Despesa lançada.');
    }
    recarregar();
  }));
}
