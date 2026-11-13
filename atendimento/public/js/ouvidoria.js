/** Ouvidoria: reclamação, cancelamento, Procon e Anatel — com protocolo, prazo e desfecho. */
import {api, qs} from './api.js';
import {
  el, limpar, icone, toast, formModal, modal, campo, area, escolha, marcar, inteiro, porcento, dinheiro,
  dataHora, desde, repetir,
} from './ui.js';
import {cartao, indicador, tabela, td, botao, acoesTopo, vazio, campoBusca, seletor} from './comum.js';
import {corpoDaFicha} from './ficha.js';

const TIPOS = { reclamacao: 'Reclamação', cancelamento: 'Cancelamento', procon: 'Procon', anatel: 'Anatel', elogio: 'Elogio', sugestao: 'Sugestão' };
const STATUS = { aberta: ['Aberta', 'aviso'], em_tratativa: ['Em tratativa', 'info'], resolvida: ['Resolvida', 'ok'], improcedente: ['Improcedente', ''] };
const etiquetaStatus = (s) => el('span', { class: `etiqueta ${STATUS[s]?.[1] ?? ''}` }, STATUS[s]?.[0] ?? s);

export async function telaOuvidoria(ctx) {
  const estado = { status: 'abertas', tipo: '', busca: '' };
  const indicadores = el('div', { class: 'indicadores' });
  const lista = el('div');

  const recarregar = async () => {
    const d = await api.get(`/empresas/${ctx.empresaId}/ouvidoria${qs(estado)}`);
    const i = d.indicadores;
    limpar(indicadores,
      indicador('Casos no mês', inteiro(i.casos), `${inteiro(i.em_aberto)} em aberto`, 'alerta', i.em_aberto ? 'laranja' : 'azul'),
      indicador('Fora do prazo', inteiro(i.atrasadas), i.horas_medias === null ? 'sem casos encerrados' : `média de ${i.horas_medias}h para resolver`,
        'relogio', i.atrasadas ? 'vermelho' : 'verde'),
      indicador('Retenção', i.taxa_retencao === null ? '—' : porcento(i.taxa_retencao),
        `${inteiro(i.retidos)} retido(s), ${inteiro(i.perdidos)} perdido(s)`, 'pessoa', 'roxo'),
      indicador('Receita salva', dinheiro(i.receita_salva_centavos),
        i.receita_perdida_centavos ? `${dinheiro(i.receita_perdida_centavos)} perdidos` : 'nada perdido', 'dinheiro', 'verde'));

    limpar(lista, cartao(null, d.itens.length
      ? tabela(['Protocolo', 'Cliente', 'Tipo', 'Assunto', '^Risco', '^Classe', 'Prazo', '^Situação', 'Responsável'],
        d.itens.map((o) => el('tr', { class: 'clicavel', onclick: () => abrirCaso(o.id) },
          td(el('code', {}, o.protocolo)),
          td(el('div', {}, el('strong', {}, o.contato_nome ?? o.telefone), el('div', { class: 'pequeno mudo' }, desde(o.aberta_em)))),
          td(el('span', { class: `etiqueta ${['procon', 'anatel'].includes(o.tipo) ? 'erro' : o.tipo === 'cancelamento' ? 'aviso' : ''}` }, o.tipo_nome)),
          td(el('span', { class: 'pequeno' }, String(o.assunto).slice(0, 70))),
          td(o.risco_na_abertura === null ? '—' : el('span', { class: `etiqueta ${o.risco_na_abertura >= 60 ? 'erro' : o.risco_na_abertura >= 30 ? 'aviso' : 'ok'}` }, inteiro(o.risco_na_abertura)), 'centro'),
          td(o.valor_na_abertura ?? '—', 'centro'),
          td(o.resolvida_em ? el('span', { class: 'mudo' }, 'encerrado')
            : o.atrasada ? el('span', { class: 'etiqueta erro' }, `${Math.abs(o.horas_para_o_prazo)}h atrasado`)
              : el('span', { class: o.horas_para_o_prazo <= 6 ? 'situacao aviso' : 'situacao' }, `${o.horas_para_o_prazo}h`)),
          td(etiquetaStatus(o.status), 'centro'),
          td(o.responsavel_nome ?? el('span', { class: 'mudo' }, 'ninguém')))))
      : vazio('Nenhum caso aqui.', 'A ZOE abre o caso sozinha quando o cliente fala em cancelar, reclamar ou acionar o Procon.')));
  };

  const abrirCaso = async (id) => {
    const o = await api.get(`/empresas/${ctx.empresaId}/ouvidoria/${id}`);
    const minha = o.responsavel_id === ctx.usuario.id;
    const encerrado = ['resolvida', 'improcedente'].includes(o.status);
    modal(`${o.protocolo} — ${o.tipo_nome}`, (fechar) => [
      el('div', { class: 'linha entre', style: 'margin-bottom:12px' },
        el('div', {},
          el('strong', {}, o.assunto),
          el('div', { class: 'pequeno mudo' }, `Aberta ${dataHora(o.aberta_em)} · ${o.origem === 'ia' ? 'pela ZOE' : 'pela equipe'}`
            + `${o.responsavel_nome ? ` · com ${o.responsavel_nome}` : ''}`)),
        el('div', { class: 'linha', style: 'gap:6px' },
          etiquetaStatus(o.status),
          o.atrasada ? el('span', { class: 'etiqueta erro' }, 'fora do prazo') : null)),

      o.relato ? el('div', { class: 'aviso-caixa info' }, icone('conversa'), el('div', {}, el('strong', {}, 'O que o cliente disse: '), o.relato)) : null,

      !ctx.pode('ouvidoria.editar') || encerrado ? null : el('div', { class: 'linha', style: 'gap:8px;margin:12px 0' },
        minha ? null : botao('Assumir o caso', 'primario', async () => {
          await api.post(`/empresas/${ctx.empresaId}/ouvidoria/${o.id}/assumir`);
          toast('Caso assumido.');
          fechar();
          await recarregar();
          await abrirCaso(o.id);
        }),
        botao('Registrar tratativa', '', () => registrarTratativa(o, fechar)),
        botao('Encerrar', 'perigo', () => encerrar(o, fechar)),
        o.conversa_id ? botao('Ver a conversa', '', () => { fechar(); location.hash = `#/empresa/${ctx.empresaId}/caixa?conversa=${o.conversa_id}`; }) : null),

      // A ficha do cliente é o que a pessoa precisa ler antes de falar com ele.
      o.ficha ? corpoDaFicha(o.ficha) : el('p', { class: 'mudo' }, 'Não foi possível montar a ficha do cliente.'),

      cartao('Tratativas', o.eventos.length
        ? el('ol', { class: 'linha-tempo' }, o.eventos.map((ev) => el('li', { class: `evento ${ev.tipo}` },
          el('span', { class: 'ponto' }, icone(ev.tipo === 'desfecho' ? 'ok' : ev.tipo === 'proposta' ? 'dinheiro' : 'nota')),
          el('div', { class: 'conteudo-evento' },
            el('div', { class: 'linha entre' }, el('strong', {}, ev.usuario_nome ?? 'Sistema'), el('small', { class: 'mudo' }, dataHora(ev.criado_em))),
            el('div', {}, ev.texto)))))
        : el('p', { class: 'mudo', style: 'margin:0' }, 'Nenhuma tratativa.')),

      el('div', { class: 'linha entre', style: 'margin-top:14px' }, el('span'), el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
    ], { largo: true });
  };

  const registrarTratativa = (o, fecharPai) => formModal('Registrar tratativa', () => [
    escolha('Tipo', 'tipo', { tratativa: 'Andamento', contato: 'Falei com o cliente', proposta: 'Proposta feita', prazo: 'Mudança de prazo' }, 'tratativa'),
    area('O que aconteceu', { name: 'texto', rows: 4, required: true, maxlength: 4000 }),
  ], async (d) => {
    await api.post(`/empresas/${ctx.empresaId}/ouvidoria/${o.id}/tratativas`, d);
    toast('Tratativa registrada.');
    fecharPai();
    await recarregar();
    await abrirCaso(o.id);
  });

  const encerrar = (o, fecharPai) => formModal(`Encerrar ${o.protocolo}`, () => [
    escolha('Como terminou', 'status', { resolvida: 'Resolvida', improcedente: 'Improcedente' }, 'resolvida'),
    o.tipo === 'cancelamento'
      ? el('div', {},
        marcar('O cliente FICOU (foi retido)', { name: 'retido', checked: true }),
        el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' },
          `É este campo que alimenta a taxa de retenção e os ${dinheiro(o.valor_anual_centavos)}/ano em jogo neste caso.`))
      : null,
    area('O que foi feito', { name: 'desfecho', rows: 4, required: true, maxlength: 4000 }),
  ], async (d) => {
    await api.post(`/empresas/${ctx.empresaId}/ouvidoria/${o.id}/encerrar`, d);
    toast('Caso encerrado.');
    fecharPai();
    await recarregar();
  }, { rotulo: 'Encerrar' });

  const criar = async () => {
    const contatos = (await api.get(`/empresas/${ctx.empresaId}/contatos`)).itens;
    formModal('Abrir caso na ouvidoria', () => [
      escolha('Cliente', 'contato_id', Object.fromEntries(contatos.map((c) => [c.id, `${c.nome ?? c.nome_perfil ?? c.telefone} · ${c.telefone}`])), contatos[0]?.id ?? ''),
      escolha('Tipo', 'tipo', TIPOS, 'reclamacao'),
      campo('Assunto', { name: 'assunto', required: true, maxlength: 200 }),
      area('O que o cliente relatou', { name: 'relato', rows: 4, maxlength: 4000 }),
      escolha('Prioridade', 'prioridade', { baixa: 'Baixa', normal: 'Normal', alta: 'Alta' }, 'normal'),
    ], async (d) => {
      const r = await api.post(`/empresas/${ctx.empresaId}/ouvidoria`, d);
      toast(r.ja_existia ? `Este cliente já tinha o caso ${r.protocolo} aberto: a nova fala foi registrada nele.` : `Caso ${r.protocolo} aberto.`);
      await recarregar();
    });
  };

  limpar(ctx.conteudo,
    indicadores,
    acoesTopo(
      el('div', { class: 'filtros livre' },
        seletor('Situação', { abertas: 'Em aberto', '': 'Todas', resolvida: 'Resolvidas', improcedente: 'Improcedentes' }, estado.status, (v) => { estado.status = v; recarregar(); }),
        seletor('Tipo', { '': 'Todos', ...TIPOS }, estado.tipo, (v) => { estado.tipo = v; recarregar(); }),
        campoBusca(estado.busca, (t) => { estado.busca = t; recarregar(); }, 'Protocolo, nome, telefone ou CPF')),
      !ctx.pode('ouvidoria.editar') ? null : el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Abrir caso')),
    lista);

  await recarregar();
  ctx.parar(repetir(recarregar, 20_000));
}

export { TIPOS, STATUS };
