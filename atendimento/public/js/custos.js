/**
 * Centro de Custo: a conta da Meta e as réguas de mensagens ativas.
 *
 * Tela de administrador da empresa e da plataforma. Atendente e supervisor não entram aqui:
 * orçamento e fatura são decisão de quem responde pelo dinheiro.
 *
 * A tela foi feita em torno de uma pergunta: quanto a gente deixou de gastar? Por isso a economia
 * aparece do lado do gasto, e cada régua mostra quantas mensagens ela não precisou mandar.
 */
import { api, qs } from './api.js';
import {
  el, limpar, icone, toast, acao, confirmar, formModal, modal, campo, area, escolha, marcar,
  inteiro, porcento, dataHora, desde, repetir, lerNumero,
} from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo, vazio, seletor, filtroPeriodo } from './comum.js';

/**
 * Dinheiro em milésimos de real. Um preço da Meta não cabe em centavos — R$ 0,035 arredondado
 * para R$ 0,04 esconde exatamente o número que esta tela existe para mostrar. Então valores que
 * não fecham em centavo redondo saem com três casas.
 */
const reais = (milesimos) => {
  const m = Number(milesimos ?? 0);
  const casas = m % 10 === 0 ? 2 : 3;
  return (m / 1000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: casas, maximumFractionDigits: casas });
};
const GATILHOS = {
  dias_antes_vencimento: 'Dias ANTES do vencimento',
  no_vencimento: 'No dia do vencimento',
  dias_apos_vencimento: 'Dias DEPOIS do vencimento',
  manual: 'Só quando eu mandar',
};
const TIPOS = { cobranca: 'Cobrança', manutencao: 'Manutenção', aviso: 'Aviso', campanha: 'Campanha' };
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export async function telaCustos(ctx) {
  const abas = el('div', { class: 'abas' });
  const corpo = el('div');
  const TELAS = {
    conta: ['A conta da Meta', aConta],
    reguas: ['Réguas', asReguas],
    espera: ['Sala de espera', aEspera],
    controle: ['Orçamento e fechamento', oControle],
  };
  let atual = 'conta';
  const trocar = async (k) => {
    atual = k;
    limpar(abas, Object.entries(TELAS).map(([chave, [rotulo]]) => el('button', {
      class: `aba${chave === atual ? ' on' : ''}`, type: 'button', onclick: () => trocar(chave),
    }, rotulo)));
    limpar(corpo, el('p', { class: 'mudo' }, 'Carregando…'));
    try { await TELAS[k][1](ctx, corpo); } catch (err) { limpar(corpo, el('p', { class: 'mudo' }, err.message)); }
  };
  limpar(ctx.conteudo, abas, corpo);
  await trocar(atual);
}

// ---------- A conta ----------

async function aConta(ctx, alvo) {
  const { hojeLocal, somarDias } = await import('./ui.js');
  const estado = { de: somarDias(hojeLocal(), -29), ate: hojeLocal() };
  const conteudo = el('div');

  const desenhar = async () => {
    const [d, orc, espera] = await Promise.all([
      api.get(`/empresas/${ctx.empresaId}/reguas/custos/resumo${qs(estado)}`),
      api.get(`/empresas/${ctx.empresaId}/reguas/orcamento`),
      api.get(`/empresas/${ctx.empresaId}/reguas/pendencias`),
    ]);
    const p = d.projecao;
    const economiaPct = d.sem_otimizacao_milesimos ? (d.economia_milesimos / d.sem_otimizacao_milesimos) * 100 : 0;

    limpar(conteudo,
      el('div', { class: 'indicadores' },
        indicador('Gasto no período', reais(d.gasto_milesimos), `${inteiro(d.mensagens)} mensagem(ns) cobrada(s)`, 'dinheiro', 'azul'),
        indicador('Deixou de gastar', reais(d.economia_milesimos), `${porcento(economiaPct)} do que seria a conta cheia`, 'raio', 'verde'),
        indicador('Projeção do mês', reais(p.projecao_milesimos), `dia ${p.dia} de ${p.dias_no_mes}`, 'relogio', 'roxo'),
        indicador('Sem as economias', reais(d.sem_otimizacao_milesimos), 'se tudo virasse template', 'alerta', 'laranja')),

      barraOrcamento(orc),

      espera.esperando
        ? cartao('Esperando a janela abrir',
          el('div', { class: 'economia-origens' },
            origem(`${inteiro(espera.esperando)} aviso(s) na fila`, 'nada foi pago por eles ainda', espera.em_risco_milesimos,
              'Cada um desses avisos tem prazo. Se o cliente escrever antes, sai de graça pela janela de 24 h; '
              + 'se o prazo chegar sem ele escrever, aí paga o template. O valor ao lado é o que está em jogo.'),
            origem('Já salvos pela janela', `${inteiro(espera.salvas_pela_janela)} aviso(s)`, null,
              'Avisos que esperaram, o cliente escreveu e saíram sem custo.')))
        : null,

      cartao('De onde veio a economia',
        el('div', { class: 'economia-origens' },
          origem('Atendimento dentro da janela de 24 h',
            `${inteiro(d.economia.por_janela_de_servico.mensagens)} resposta(s) de serviço`,
            d.economia.por_janela_de_servico.milesimos,
            'Toda vez que a ZOE resolve no WhatsApp, a resposta sai de graça. Se o mesmo aviso tivesse que ir por template, '
            + 'cada um custaria o preço de utilidade.'),
          origem('Régua: usou a janela em vez de template',
            `${inteiro(d.economia.pela_regua.pela_janela)} mensagem(ns)`,
            d.economia.pela_regua.pela_janela_milesimos,
            'O cliente tinha falado nas últimas 24 h, então o aviso foi como texto livre — sem custo.'),
          origem('Régua: não disparou para quem não precisava',
            `${inteiro(d.economia.pela_regua.pulados)} pulada(s)`,
            d.economia.pela_regua.pulados_milesimos,
            'Já pagou, pediu para não receber, está em atendimento ou já tinha recebido.'))),

      cartao('Por categoria da Meta',
        tabela(['Categoria', 'O que é', '>Preço', '>Mensagens', '>Custo'], d.por_categoria.map((c) => el('tr', {},
          td(el('strong', {}, c.nome)),
          td(el('span', { class: 'pequeno' }, c.explicacao)),
          td(c.preco_milesimos ? reais(c.preco_milesimos) : el('span', { class: 'etiqueta ok' }, 'grátis'), 'dir'),
          td(inteiro(c.mensagens), 'dir num'),
          td(reais(c.custo_milesimos), 'dir num')))),
        el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' },
          'Os preços são os que o master cadastrou em Configurações. Confira a tabela do Brasil no painel da Meta: ela muda.')),

      d.por_regua.length
        ? cartao('Por régua', tabela(['Régua', 'Categoria', '>Enviadas', '>Pela janela', '>Puladas', '>Custo', '>Economia'],
          d.por_regua.map((r) => el('tr', {},
            td(el('strong', {}, r.nome)), td(r.categoria),
            td(inteiro(r.enviados), 'dir num'), td(inteiro(r.pela_janela), 'dir num'), td(inteiro(r.pulados), 'dir num'),
            td(reais(r.custo_milesimos), 'dir num'),
            td(el('strong', { class: 'ok-texto' }, reais(r.economia_milesimos)), 'dir num')))))
        : null);
  };

  limpar(alvo, filtroPeriodo(estado, () => desenhar().catch((e) => toast(e.message, true))), conteudo);
  await desenhar();
}

const origem = (titulo, quanto, milesimos, explicacao) => el('div', { class: 'origem-economia' },
  el('div', { class: 'linha entre' },
    el('strong', {}, titulo),
    milesimos === null ? null : el('span', { class: 'valor-economia' }, reais(milesimos))),
  el('div', { class: 'pequeno' }, quanto),
  el('div', { class: 'pequeno mudo' }, explicacao));

// ---------- Réguas ----------

async function asReguas(ctx, alvo) {
  const lista = el('div');

  const recarregar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/reguas`);
    limpar(lista, d.itens.length
      ? cartao(null, tabela(['Régua', 'Quando dispara', 'Categoria', '>Enviadas', '>Puladas', '>Custo', '>Economia', '^Ativa', ''],
        d.itens.map((r) => el('tr', {},
          td(el('div', {}, el('strong', {}, r.nome), el('div', { class: 'pequeno mudo' }, `${TIPOS[r.tipo]} · template ${r.template}`))),
          td(el('div', {},
            r.gatilho === 'manual' ? 'Manual' : `${GATILHOS[r.gatilho]}${r.gatilho === 'no_vencimento' ? '' : ` (${r.dias})`}`,
            el('div', { class: 'pequeno mudo' }, `${r.hora} · ${[...r.dias_semana].map((x, i) => (x === '1' ? DIAS[i].slice(0, 3) : null)).filter(Boolean).join(', ')}`))),
          td(el('span', { class: `etiqueta ${r.categoria === 'marketing' ? 'aviso' : ''}` }, r.categoria)),
          td(inteiro(r.enviados), 'dir num'),
          td(inteiro(r.pulados), 'dir num'),
          td(reais(r.custo_milesimos), 'dir num'),
          td(el('strong', { class: 'ok-texto' }, reais(r.economia_milesimos)), 'dir num'),
          td(r.ativa ? icone('ok') : el('span', { class: 'mudo' }, '—'), 'centro'),
          td(!ctx.pode('custos.editar') && !ctx.pode('custos.ver') ? null : el('div', { class: 'linha', style: 'gap:4px' },
            botaoIcone('teste', 'Simular (não envia nada)', () => simular(r)),
            ctx.pode('custos.editar') ? botaoIcone('enviar', 'Disparar agora', () => disparar(r)) : null,
            botaoIcone('relatorios', 'Histórico', () => historico(r)),
            ctx.pode('custos.editar') ? botaoIcone('editar', 'Editar', () => editar(r, d)) : null,
            ctx.pode('custos.editar') ? botaoIcone('lixo', 'Excluir', () => excluir(r), 'perigo') : null), 'dir')))))
      : vazio('Nenhuma régua cadastrada.',
        'A régua é o que dispara boleto, lembrete de atraso e aviso de manutenção — e é onde a conta da Meta é feita. '
        + 'Com ela, o aviso vai de graça para quem falou com você nas últimas 24 h e não vai para quem já pagou.'));
  };

  const form = (r = {}, d = {}) => [
    el('div', { class: 'aviso-caixa info' }, icone('dinheiro'), el('div', {},
      el('strong', {}, 'Como a régua economiza: '),
      'quem tem a janela de 24 h aberta recebe o texto livre (grátis); quem já pagou, pediu para não receber, '
      + 'está em atendimento ou já recebeu no período não recebe nada. O resto vai por template, e só esse custa.')),
    campo('Nome', { name: 'nome', value: r.nome ?? '', required: true, maxlength: 80, placeholder: 'Lembrete 3 dias antes' }),
    el('div', { class: 'grade-2' },
      escolha('Tipo', 'tipo', TIPOS, r.tipo ?? 'cobranca'),
      escolha('Categoria da Meta', 'categoria', Object.fromEntries(
        ['utilidade', 'marketing', 'autenticacao'].map((k) => [k, `${d.categorias?.[k]?.nome ?? k} — ${reais(d.precos?.[k] ?? 0)}`])), r.categoria ?? 'utilidade')),
    el('p', { class: 'pequeno mudo', style: 'margin:0' },
      'Cobrança e manutenção são UTILIDADE. Oferta e promoção são MARKETING, que custa cerca de nove vezes mais — '
      + 'mandar lembrete de fatura como marketing é jogar dinheiro fora.'),
    campo('Template aprovado na Meta', { name: 'template', value: r.template ?? '', required: true, placeholder: 'aviso_fatura' }),
    campo('Idioma', { name: 'idioma', value: r.idioma ?? 'pt_BR' }),
    area(`Parâmetros do template, um por linha (campos: ${(d.campos ?? []).join(', ')})`, { name: 'parametros', rows: 3, placeholder: 'primeiro_nome\nvencimento\nvalor' }, r.parametros ?? ''),
    area('Texto para quando a janela de 24 h estiver aberta (sai de graça)', { name: 'texto_janela', rows: 3, maxlength: 4096, placeholder: 'Oi {primeiro_nome}! Sua fatura de {valor} vence em {vencimento}. Quer que eu mande o PIX?' }, r.texto_janela ?? ''),
    el('div', { class: 'grade-2' },
      escolha('Quando dispara', 'gatilho', GATILHOS, r.gatilho ?? 'dias_antes_vencimento'),
      campo('Dias', { name: 'dias', type: 'number', value: r.dias ?? 3, min: 0, max: 180 })),
    el('div', { class: 'grade-2' },
      campo('Hora', { name: 'hora', type: 'time', value: r.hora ?? '09:00' }),
      campo('Teto de gasto por disparo (R$, 0 = sem teto)', { name: 'teto_reais', type: 'number', step: '0.01', min: 0, value: ((r.teto_milesimos ?? 0) / 1000).toFixed(2) })),
    el('label', { class: 'campo' }, 'Dias da semana',
      el('div', { class: 'escolha-dias' }, DIAS.map((dia, i) =>
        el('label', { class: 'marcar' }, el('input', { type: 'checkbox', name: `dia${i}`, checked: (r.dias_semana ?? '0111110')[i] === '1' }), dia.slice(0, 3))))),
    marcar('Usar a janela de 24 h quando ela estiver aberta (grátis)', { name: 'preferir_janela', checked: r.id ? r.preferir_janela : true }),
    marcar('Não disparar para quem já pagou (confere no IXC na hora)', { name: 'pular_se_pago', checked: r.id ? r.pular_se_pago : true }),
    marcar('Não atropelar quem está em atendimento', { name: 'pular_se_conversa_aberta', checked: r.id ? r.pular_se_conversa_aberta : true }),
    campo('Não repetir para o mesmo cliente por (dias)', { name: 'repetir_apos_dias', type: 'number', value: r.repetir_apos_dias ?? 5, min: 0, max: 365 }),
    marcar('Régua ligada', { name: 'ativa', checked: Boolean(r.ativa) }),
  ];

  const comDias = (d) => ({
    ...d,
    dias_semana: [0, 1, 2, 3, 4, 5, 6].map((i) => (d[`dia${i}`] ? '1' : '0')).join(''),
    teto_milesimos: Math.round(Number(String(d.teto_reais ?? '0').replace(',', '.')) * 1000),
  });

  const criar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/reguas`);
    formModal('Nova régua', () => form({}, d), async (dados) => {
      await api.post(`/empresas/${ctx.empresaId}/reguas`, comDias(dados));
      toast('Régua criada. Simule antes de ligar.');
      await recarregar();
    }, { largo: true });
  };

  const editar = (r, d) => formModal(`Editar ${r.nome}`, () => form(r, d), async (dados) => {
    await api.patch(`/empresas/${ctx.empresaId}/reguas/${r.id}`, comDias(dados));
    toast('Régua salva.');
    await recarregar();
  }, { largo: true });

  const excluir = async (r) => {
    if (!await confirmar('Excluir régua', `"${r.nome}" para de disparar. O histórico de disparos fica guardado.`, 'Excluir')) return;
    await api.del(`/empresas/${ctx.empresaId}/reguas/${r.id}`);
    toast('Régua excluída.');
    await recarregar();
  };

  const simular = async (r) => {
    const s = await api.post(`/empresas/${ctx.empresaId}/reguas/${r.id}/simular`, {});
    modal(`Simulação de "${r.nome}"`, (fechar) => [
      el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
        `Nada foi enviado. Faturas com vencimento em ${s.data_alvo.split('-').reverse().join('/')}.`),
      el('div', { class: 'indicadores' },
        indicador('Vão receber', inteiro(s.vao_receber), `${inteiro(s.por_template)} por template, ${inteiro(s.pela_janela)} pela janela`, 'enviar', 'azul'),
        indicador('Não vão receber', inteiro(s.pulados), 'e isso é economia', 'raio', 'verde'),
        indicador('Vai custar', reais(s.custo_milesimos), `sem as economias: ${reais(s.sem_otimizacao_milesimos)}`, 'dinheiro', 'laranja'),
        indicador('Economia', reais(s.economia_milesimos), s.teto_estourado ? 'ATENÇÃO: passa do teto' : 'neste disparo', 'ok', 'verde')),
      s.motivos.length
        ? cartao('Por que alguns não recebem', tabela(['Motivo', '>Clientes'], s.motivos.map((m) => el('tr', {}, td(m.motivo), td(inteiro(m.quantos), 'dir num')))))
        : null,
      el('div', { class: 'linha entre', style: 'margin-top:12px' },
        ctx.pode('custos.editar') ? botao('Disparar agora', 'primario', async () => { fechar(); await disparar(r); }) : el('span'),
        el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
    ], { largo: true });
  };

  const disparar = async (r) => {
    const s = await api.post(`/empresas/${ctx.empresaId}/reguas/${r.id}/simular`, {});
    if (!await confirmar('Disparar agora',
      `${inteiro(s.vao_receber)} cliente(s) vão receber e ${inteiro(s.pulados)} serão pulados. `
      + `Custo estimado: ${reais(s.custo_milesimos)}. Confirma?`, 'Disparar')) return;
    const x = await api.post(`/empresas/${ctx.empresaId}/reguas/${r.id}/executar`, {});
    toast(`${x.enviados} enviada(s), ${x.pela_janela} pela janela, ${x.pulados} pulada(s). `
      + `Custo ${reais(x.custo_milesimos)}, economia ${reais(x.economia_milesimos)}.`);
    await recarregar();
  };

  const historico = async (r) => {
    const d = await api.get(`/empresas/${ctx.empresaId}/reguas/${r.id}/historico`);
    modal(`Histórico de "${r.nome}"`, (fechar) => [
      cartao('Resumo', tabela(['Situação', 'Motivo', '>Clientes', '>Custo', '>Economia'],
        d.por_motivo.map((m) => el('tr', {},
          td(el('span', { class: `etiqueta ${m.status === 'enviado' ? 'ok' : m.status === 'falhou' ? 'erro' : ''}` }, m.status)),
          td(m.motivo), td(inteiro(m.quantos), 'dir num'),
          td(reais(m.custo), 'dir num'), td(reais(m.economia), 'dir num'))))),
      cartao('Últimos disparos', tabela(['Quando', 'Cliente', 'Situação', 'Motivo', '>Custo'],
        d.disparos.map((x) => el('tr', {},
          td(dataHora(x.criado_em)),
          td(x.contato_nome ?? x.telefone ?? '—'),
          td(el('span', { class: `etiqueta ${x.status === 'enviado' ? 'ok' : x.status === 'falhou' ? 'erro' : ''}` }, x.status)),
          td(el('span', { class: 'pequeno' }, x.motivo ?? '—')),
          td(reais(x.custo_milesimos), 'dir num'))), 'Esta régua ainda não disparou.')),
      el('div', { class: 'linha entre', style: 'margin-top:12px' }, el('span'), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
    ], { largo: true });
  };

  limpar(alvo, acoesTopo(el('span'), ctx.pode('custos.editar') ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Nova régua') : null), lista);
  await recarregar();
}

export { reais };

// ---------- Orçamento ----------

/** A barra do orçamento: o que foi aprovado, o que já foi e onde o mês termina nesse ritmo. */
function barraOrcamento(o) {
  if (!o.orcamento_milesimos) {
    return cartao('Orçamento do mês',
      el('p', { class: 'mudo' }, 'Nenhum teto definido. Sem teto, o gasto com a Meta não tem freio — defina um em "Orçamento e fechamento".'));
  }
  const cor = { ok: 'verde', atencao: 'laranja', critico: 'laranja', estourado: 'vermelho', sem_teto: 'azul' }[o.status] ?? 'azul';
  const largura = Math.min(100, o.percentual);
  return cartao('Orçamento do mês',
    el('div', { class: 'linha-orcamento' },
      el('div', {},
        el('strong', {}, reais(o.gasto_milesimos)),
        el('span', { class: 'mudo' }, ` de ${reais(o.orcamento_milesimos)} aprovados`)),
      el('span', { class: `etiqueta ${o.status === 'estourado' ? 'erro' : o.status === 'critico' || o.status === 'atencao' ? 'aviso' : 'ok'}` },
        `${porcento(o.percentual)} usado`)),
    el('div', { class: 'barra-orcamento' }, el('div', { class: `preenchida ${cor}`, style: `width:${largura}%` })),
    el('p', { class: 'pequeno mudo', style: 'margin:8px 0 0' },
      o.status === 'estourado'
        ? 'O teto foi atingido: até virar o mês, só sai mensagem grátis (janela de 24 h e serviço). A cobrança não para, ela espera a janela.'
        : o.projecao_estoura
          ? `Neste ritmo o mês fecha em ${reais(o.projecao_milesimos)} e estoura o teto no dia ${Math.max(1, Math.floor(o.dias_no_mes * (o.orcamento_milesimos / Math.max(1, o.projecao_milesimos))))}.`
          : `Neste ritmo o mês fecha em ${reais(o.projecao_milesimos)}, dentro do teto.`),
    o.avisos?.length
      ? el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' },
        `Marcos avisados: ${o.avisos.map((a) => `${a.marco}% em ${dataHora(a.criado_em).slice(0, 10)}`).join(' · ')}`)
      : null);
}

// ---------- Sala de espera ----------

async function aEspera(ctx, alvo) {
  const conteudo = el('div');
  const desenhar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/reguas/pendencias`);
    limpar(conteudo,
      el('div', { class: 'indicadores' },
        indicador('Esperando a janela', inteiro(d.esperando), 'avisos que ainda não custaram nada', 'relogio', 'azul'),
        indicador('Em jogo', reais(d.em_risco_milesimos), 'o que custaria se ninguém escrever', 'dinheiro', 'laranja'),
        indicador('Salvos pela janela', inteiro(d.salvas_pela_janela), 'avisos entregues de graça', 'raio', 'verde')),

      cartao('Como funciona',
        el('p', { class: 'mudo', style: 'margin:0' },
          'Um aviso de vencimento com três dias de folga não precisa ser pago hoje. Ele fica aqui com um prazo. '
          + 'Se o cliente escrever qualquer coisa antes do prazo, a janela de 24 h abre e o aviso sai junto da resposta, '
          + 'de graça. Se o prazo chegar sem ele escrever, aí o template é pago — no último momento útil, e só se '
          + 'ainda fizer sentido: fatura paga, contato bloqueado ou orçamento esgotado cancelam o envio.')),

      d.fila.length
        ? cartao('Na fila', tabela(['Cliente', 'Régua', 'Categoria', 'Prazo', '>Vale'], d.fila.map((x) => el('tr', {},
          td(el('div', {}, el('strong', {}, x.contato_nome ?? x.telefone), el('div', { class: 'pequeno mudo' }, x.telefone))),
          td(x.regua), td(x.categoria),
          td(el('div', {}, dataHora(x.prazo), el('div', { class: 'pequeno mudo' }, desde(x.criada_em) + ' esperando'))),
          td(reais(x.preco_milesimos), 'dir num')))))
        : cartao('Na fila', vazio('Nenhum aviso esperando agora.')),

      d.por_fim.length
        ? cartao('Como terminaram', tabela(['Desfecho', '>Quantos'], d.por_fim.map((x) => el('tr', {},
          td(({ janela: 'Saiu de graça pela janela', template: 'Pagou o template no fim do prazo' })[x.resolucao] ?? x.resolucao ?? '—'),
          td(inteiro(x.quantos), 'dir num')))))
        : null);
  };

  limpar(alvo,
    acoesTopo(botao('Varrer agora', 'primario', async () => {
      if (!await confirmar('Varrer a sala de espera', 'O que já passou do prazo será pago agora, se ainda fizer sentido. O resto continua esperando.')) return;
      const r = await api.post(`/empresas/${ctx.empresaId}/reguas/pendencias/varrer`, {});
      toast(`${r.pela_janela} saiu pela janela, ${r.pagas} pagou template, ${r.canceladas} cancelada(s).`);
      await desenhar();
    })),
    conteudo);
  await desenhar();
}

// ---------- Orçamento e fechamento ----------

/** Reais digitados ("300" ou "300,50") para milésimos de real. */
const paraMilesimos = (texto) => Math.round(lerNumero(texto) * 1000);
const paraCentavos = (texto) => Math.round(lerNumero(texto) * 100);
const emReais = (milesimos) => (Number(milesimos ?? 0) / 1000).toFixed(2).replace('.', ',');
const centavosEmReais = (centavos) => (Number(centavos ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
/** Total em reais: arredonda para centavos. Três casas só fazem sentido em preço unitário (R$ 0,035). */
const reaisTotal = (milesimos) => centavosEmReais(Math.round(Number(milesimos ?? 0) / 10));
const dolares = (centavos) => `US$ ${(Number(centavos ?? 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function oControle(ctx, alvo) {
  const conteudo = el('div');

  const desenhar = async () => {
    const [orc, fech, moeda] = await Promise.all([
      api.get(`/empresas/${ctx.empresaId}/reguas/orcamento`),
      api.get(`/empresas/${ctx.empresaId}/reguas/fechamentos`),
      api.get(`/empresas/${ctx.empresaId}/reguas/moeda`),
    ]);
    const emDolar = moeda.moeda === 'USD';
    const cotacaoTexto = (x10000) => (Number(x10000) / 10_000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

    limpar(conteudo,
      barraOrcamento(orc),

      cartao('Moeda da conta da Meta',
        el('div', { class: 'grade-2' },
          el('div', {},
            el('p', { class: 'pequeno mudo', style: 'margin:0 0 4px' }, 'A Meta cobra esta empresa em'),
            el('strong', { style: 'font-size:20px' }, emDolar ? 'Dólar (US$)' : 'Real (R$)'),
            el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' }, emDolar
              ? 'Cada mensagem paga guarda o custo exato em dólar, e o fechamento confere dólar contra dólar com a fatura.'
              : 'Os preços são os da tabela em reais cadastrada pela plataforma.')),
          emDolar ? el('div', {},
            el('p', { class: 'pequeno mudo', style: 'margin:0 0 4px' }, moeda.fonte === 'ptax' ? 'Dólar do dia' : 'Cotação usada'),
            el('strong', { style: 'font-size:20px' }, `R$ ${cotacaoTexto(moeda.cotacao_x10000)}`),
            el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' }, {
              ptax: `PTAX de venda do Banco Central, boletim de ${dataHora(moeda.boletim_em)}. Atualiza sozinho de hora em hora; `
                + 'cada mensagem é convertida pelo dólar do dia em que saiu, e o mês fecha pela média do mês.',
              manual: moeda.automatica
                ? 'O Banco Central ainda não respondeu: usando a cotação informada à mão até o primeiro boletim chegar.'
                : 'Cotação informada à mão pela empresa.',
              padrao: moeda.automatica
                ? 'O Banco Central ainda não respondeu: usando a cotação padrão da plataforma até o primeiro boletim chegar.'
                : 'Cotação padrão da plataforma. Informe a do mês para os valores em reais ficarem certos.',
            }[moeda.fonte])) : el('span')),
        emDolar ? tabela(['Categoria', '>Em dólar', '>Em reais, a esta cotação'], ['utilidade', 'autenticacao', 'marketing'].map((k) => el('tr', {},
          td({ utilidade: 'Utilidade', autenticacao: 'Autenticação', marketing: 'Marketing' }[k]),
          td(`US$ ${(moeda.precos_usd_micro[k] / 1_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`, 'dir num'),
          td(reais(moeda.precos_milesimos[k]), 'dir num')))) : null,
        ctx.pode('custos.editar') ? el('div', { class: 'linha', style: 'margin-top:12px;gap:8px' },
          botao('Mudar moeda e cotação', 'primario', () => formModal('Moeda da conta da Meta', () => [
            escolha('A Meta cobra esta empresa em', 'moeda', { BRL: 'Real (R$)', USD: 'Dólar (US$)' }, moeda.moeda),
            escolha('Cotação do dólar', 'automatica', {
              sim: 'Dólar do dia — PTAX do Banco Central, atualizada sozinha',
              nao: 'Informar à mão',
            }, moeda.automatica ? 'sim' : 'nao'),
            campo('Cotação à mão — quantos reais vale um dólar (no automático, vale só se o Banco Central não responder)', {
              name: 'cotacao', inputmode: 'decimal', placeholder: '5,45',
              value: moeda.fonte === 'manual' || (!moeda.automatica && !moeda.cotacao_padrao) ? cotacaoTexto(moeda.cotacao_x10000) : '',
            }),
            el('p', { class: 'pequeno mudo' }, 'A cotação vale para as próximas mensagens. Mês já fechado guarda a cotação daquele mês.'),
          ], async (d) => {
            await api.put(`/empresas/${ctx.empresaId}/reguas/moeda`, { moeda: d.moeda, automatica: d.automatica === 'sim', cotacao: d.cotacao || null });
            toast('Moeda salva.');
            await desenhar();
          })),
          emDolar && moeda.automatica ? botao('Buscar o dólar agora', '', async () => {
            const r = await api.post(`/empresas/${ctx.empresaId}/reguas/moeda/atualizar`, {});
            toast(r.dolar_do_dia ? `Dólar do dia: R$ ${cotacaoTexto(r.dolar_do_dia.venda_x10000)} (${r.dolar_do_dia.data.split('-').reverse().join('/')}).` : 'Sem boletim novo.');
            await desenhar();
          }) : null) : null),

      cartao('Teto de gasto',
        el('div', { class: 'grade-2' },
          el('div', {},
            el('p', { class: 'pequeno mudo', style: 'margin:0 0 4px' }, 'Orçamento do mês'),
            el('strong', { style: 'font-size:20px' }, orc.orcamento_milesimos ? reais(orc.orcamento_milesimos) : 'sem teto'),
            el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' }, 'Atingido o teto, só sai mensagem grátis.')),
          el('div', {},
            el('p', { class: 'pequeno mudo', style: 'margin:0 0 4px' }, 'Dentro dele, para marketing'),
            el('strong', { style: 'font-size:20px' }, orc.orcamento_marketing_milesimos ? reais(orc.orcamento_marketing_milesimos) : 'sem teto próprio'),
            el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' }, 'Marketing custa 9× uma utilidade: teto próprio evita que uma campanha coma a cobrança.'))),
        el('div', { style: 'margin-top:12px' },
          botao('Definir o teto', 'primario', () => formModal('Orçamento do mês', () => [
            campo('Quanto esta empresa aceita gastar por mês (R$)', { name: 'total', value: emReais(orc.orcamento_milesimos), placeholder: '0,00', inputmode: 'decimal' }),
            campo('Dentro disso, no máximo para marketing (R$)', { name: 'marketing', value: emReais(orc.orcamento_marketing_milesimos), placeholder: '0,00', inputmode: 'decimal' }),
            el('p', { class: 'pequeno mudo' }, 'Zero significa sem teto. O freio vale para mensagem paga; a janela de 24 h e o atendimento nunca param.'),
          ], async (d) => {
            await api.put(`/empresas/${ctx.empresaId}/reguas/orcamento`, {
              orcamento_milesimos: paraMilesimos(d.total || '0'),
              orcamento_marketing_milesimos: paraMilesimos(d.marketing || '0'),
            });
            toast('Orçamento definido.');
            await desenhar();
          })))),

      cartao('Mês a mês, conferido com a fatura da Meta',
        tabela(['Mês', '>Mensagens', '>Nossa conta', '>Fatura da Meta', '>Diferença', 'Situação', ''],
          fech.meses.map((m) => el('tr', m.divergente ? { class: 'linha-divergente' } : {},
            td(el('div', {},
              el('strong', {}, mesLongo(m.mes)),
              m.em_aberto ? el('div', { class: 'pequeno mudo' }, `em aberto · projeção ${reaisTotal(m.projecao_milesimos)}`) : null,
              m.observacao ? el('div', { class: 'pequeno mudo' }, m.observacao) : null)),
            td(inteiro(m.mensagens), 'dir num'),
            // Conta em dólar: a conferência é em dólar; o real aparece embaixo, como referência.
            td(m.moeda === 'USD'
              ? el('div', {}, dolares(m.gasto_usd_centavos), el('div', { class: 'pequeno mudo' }, `≈ ${reaisTotal(m.gasto_milesimos)}`))
              : reaisTotal(m.gasto_milesimos), 'dir num'),
            td(m.moeda === 'USD'
              ? (m.fatura_meta_usd_centavos === null || m.fatura_meta_usd_centavos === undefined ? el('span', { class: 'mudo' }, '—')
                : el('div', {}, dolares(m.fatura_meta_usd_centavos),
                  m.fatura_meta_centavos !== null && m.fatura_meta_centavos !== undefined
                    ? el('div', { class: 'pequeno mudo' }, `saiu ${centavosEmReais(m.fatura_meta_centavos)} · dólar a ${m.cambio_efetivo?.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) ?? '—'}`)
                    : null))
              : (m.fatura_meta_centavos === null ? el('span', { class: 'mudo' }, '—') : centavosEmReais(m.fatura_meta_centavos)), 'dir num'),
            td((() => {
              const dif = m.moeda === 'USD' ? m.diferenca_usd_centavos : m.diferenca_centavos;
              if (dif === null || dif === undefined) return el('span', { class: 'mudo' }, '—');
              const fmt = m.moeda === 'USD' ? dolares : centavosEmReais;
              return el('strong', { class: m.divergente ? 'erro-texto' : 'ok-texto' }, `${dif > 0 ? '+' : ''}${fmt(dif)}`);
            })(), 'dir num'),
            td(m.em_aberto ? el('span', { class: 'etiqueta' }, 'em aberto')
              : m.conferido_em ? el('span', { class: `etiqueta ${m.divergente ? 'erro' : 'ok'}` }, m.divergente ? 'divergente' : 'conferido')
                : el('span', { class: 'etiqueta aviso' }, 'fechado, não conferido')),
            td(el('div', { class: 'linha', style: 'gap:4px;justify-content:flex-end' },
              m.em_aberto
                ? botaoIcone('ok', 'Fechar este mês', async () => {
                  if (!await confirmar('Fechar o mês', `Fechar ${mesLongo(m.mes)} agora congela o número para conferência. Pode fechar de novo enquanto não houver fatura lançada.`)) return;
                  await api.post(`/empresas/${ctx.empresaId}/reguas/fechamentos/${m.mes}/fechar`, {});
                  toast('Mês fechado.');
                  await desenhar();
                })
                : m.conferido_em
                  ? botaoIcone('voltar', 'Reabrir para lançar de novo', async () => {
                    if (!await confirmar('Reabrir o mês', 'O valor da fatura lançado será apagado e a conta recalculada.')) return;
                    await api.post(`/empresas/${ctx.empresaId}/reguas/fechamentos/${m.mes}/reabrir`, {});
                    toast('Mês reaberto.');
                    await desenhar();
                  })
                  : botaoIcone('dinheiro', 'Lançar a fatura da Meta', () => formModal(`Fatura da Meta — ${mesLongo(m.mes)}`, () => (m.moeda === 'USD' ? [
                    el('p', { class: 'pequeno mudo' }, `Nossa conta para este mês: ${dolares(m.gasto_usd_centavos)} em ${inteiro(m.mensagens)} mensagem(ns).`),
                    campo('Valor da fatura da Meta (US$)', { name: 'valor_usd', required: true, placeholder: '0,00', inputmode: 'decimal' }),
                    campo('Quanto saiu da conta em reais (opcional, com IOF)', { name: 'valor', placeholder: '0,00', inputmode: 'decimal' }),
                    el('p', { class: 'pequeno mudo' }, 'A conferência é dólar contra dólar. O valor em reais mostra o câmbio que ficou pago de verdade.'),
                    area('Observação', { name: 'observacao', rows: 2, placeholder: 'Nota fiscal, ajuste…' }),
                  ] : [
                    el('p', { class: 'pequeno mudo' }, `Nossa conta para este mês: ${reais(m.gasto_milesimos)} em ${inteiro(m.mensagens)} mensagem(ns).`),
                    campo('Valor cobrado pela Meta (R$)', { name: 'valor', required: true, placeholder: '0,00', inputmode: 'decimal' }),
                    area('Observação', { name: 'observacao', rows: 2, placeholder: 'Nota fiscal, câmbio, ajuste…' }),
                  ]), async (d) => {
                    await api.post(`/empresas/${ctx.empresaId}/reguas/fechamentos/${m.mes}/fatura`, {
                      valor_centavos: d.valor ? paraCentavos(d.valor) : null,
                      valor_usd_centavos: d.valor_usd ? paraCentavos(d.valor_usd) : null,
                      observacao: d.observacao || null,
                    });
                    toast('Fatura lançada.');
                    await desenhar();
                  }))))))),
        el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' },
          'Diferença acima de 5% não é arredondamento: ou o preço cadastrado está velho, ou mensagem está saindo por fora do sistema. '
          + 'Nos dois casos vale conferir antes de pagar.')));
  };

  limpar(alvo, conteudo);
  await desenhar();
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const mesLongo = (mes) => `${MESES[Number(String(mes).slice(5, 7)) - 1] ?? mes} de ${String(mes).slice(0, 4)}`;
