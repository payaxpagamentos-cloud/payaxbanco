/**
 * Mensagens ativas e a conta da Meta.
 *
 * A tela foi feita em torno de uma pergunta: quanto a gente deixou de gastar? Por isso a economia
 * aparece do lado do gasto, e cada régua mostra quantas mensagens ela não precisou mandar.
 */
import { api, qs } from './api.js';
import {
  el, limpar, icone, toast, acao, confirmar, formModal, modal, campo, area, escolha, marcar,
  inteiro, porcento, dataHora, desde, repetir,
} from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo, vazio, seletor, filtroPeriodo } from './comum.js';

const reais = (milesimos) => (Number(milesimos ?? 0) / 1000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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
  const TELAS = { conta: ['A conta da Meta', aConta], reguas: ['Réguas', asReguas] };
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
    const d = await api.get(`/empresas/${ctx.empresaId}/reguas/custos/resumo${qs(estado)}`);
    const p = d.projecao;
    const economiaPct = d.sem_otimizacao_milesimos ? (d.economia_milesimos / d.sem_otimizacao_milesimos) * 100 : 0;

    limpar(conteudo,
      el('div', { class: 'indicadores' },
        indicador('Gasto no período', reais(d.gasto_milesimos), `${inteiro(d.mensagens)} mensagem(ns) cobrada(s)`, 'dinheiro', 'azul'),
        indicador('Deixou de gastar', reais(d.economia_milesimos), `${porcento(economiaPct)} do que seria a conta cheia`, 'raio', 'verde'),
        indicador('Projeção do mês', reais(p.projecao_milesimos), `dia ${p.dia} de ${p.dias_no_mes}`, 'relogio', 'roxo'),
        indicador('Sem as economias', reais(d.sem_otimizacao_milesimos), 'se tudo virasse template', 'alerta', 'laranja')),

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
          td(ctx.somenteLeitura ? null : el('div', { class: 'linha', style: 'gap:4px' },
            botaoIcone('teste', 'Simular (não envia nada)', () => simular(r)),
            ctx.soAdmin ? botaoIcone('enviar', 'Disparar agora', () => disparar(r)) : null,
            botaoIcone('relatorios', 'Histórico', () => historico(r)),
            ctx.soAdmin ? botaoIcone('editar', 'Editar', () => editar(r, d)) : null,
            ctx.soAdmin ? botaoIcone('lixo', 'Excluir', () => excluir(r), 'perigo') : null), 'dir')))))
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
        ctx.soAdmin ? botao('Disparar agora', 'primario', async () => { fechar(); await disparar(r); }) : el('span'),
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

  limpar(alvo, acoesTopo(el('span'), ctx.soAdmin ? el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Nova régua') : null), lista);
  await recarregar();
}

export { reais };
