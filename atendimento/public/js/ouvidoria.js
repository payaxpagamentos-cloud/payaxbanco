/** Ouvidoria: reclamação, cancelamento, Procon e Anatel — com protocolo, prazo e desfecho. */
import {api, qs} from './api.js';
import {
  el, limpar, icone, toast, formModal, modal, campo, area, escolha, marcar, inteiro, porcento, dinheiro,
  dataHora, desde, repetir, centavos,
} from './ui.js';
import {cartao, indicador, tabela, td, botao, acoesTopo, vazio, campoBusca, seletor} from './comum.js';
import {corpoDaFicha} from './ficha.js';

const TIPOS = { reclamacao: 'Reclamação', cancelamento: 'Cancelamento', procon: 'Procon', anatel: 'Anatel', elogio: 'Elogio', sugestao: 'Sugestão' };
const STATUS = { aberta: ['Aberta', 'aviso'], em_tratativa: ['Em tratativa', 'info'], resolvida: ['Resolvida', 'ok'], improcedente: ['Improcedente', ''] };
const MOTIVOS = {
  preco: 'Preço', qualidade: 'Qualidade da internet', atendimento: 'Atendimento', mudanca: 'Mudança de endereço',
  concorrente: 'Oferta da concorrência', financeiro: 'Dificuldade financeira', sem_uso: 'Não usa mais', outro: 'Outro',
};
const OFERTAS = {
  desconto: 'Desconto na mensalidade', upgrade: 'Upgrade de velocidade', visita_tecnica: 'Visita técnica', isencao: 'Isenção de fatura',
  troca_equipamento: 'Troca de equipamento', downgrade: 'Plano mais barato', pausa: 'Pausa temporária', outro: 'Outra',
};
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
        [i.custo_retencao_centavos ? `custou ${dinheiro(i.custo_retencao_centavos)} em ofertas` : null,
          i.receita_perdida_centavos ? `${dinheiro(i.receita_perdida_centavos)} perdidos` : 'nada perdido'].filter(Boolean).join(' · '), 'dinheiro', 'verde'));

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

      quadroRetencao(o, fechar, encerrado),

      // A ficha do cliente é o que a pessoa precisa ler antes de falar com ele.
      o.ficha ? corpoDaFicha(o.ficha) : el('p', { class: 'mudo' }, o.ficha_restrita
        ? 'Seu acesso não inclui a ficha do cliente (risco, faturas e pagamentos).' : 'Não foi possível montar a ficha do cliente.'),

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

  /**
   * Retenção: o motivo de querer sair, as ofertas feitas e o que o cliente respondeu. Aparece em
   * todo caso em que ele ameaçou sair — não só no pedido de cancelamento.
   */
  function quadroRetencao(o, fecharPai, encerrado) {
    const pode = ctx.pode('ouvidoria.editar') && !encerrado;
    const reabrir = async () => { fecharPai(); await recarregar(); await abrirCaso(o.id); };
    if (!o.ameaca_saida) {
      return pode ? el('div', { class: 'linha', style: 'margin:0 0 12px' },
        botao('O cliente ameaçou sair', '', async () => {
          await api.patch(`/empresas/${ctx.empresaId}/ouvidoria/${o.id}`, { ameaca_saida: true });
          toast('Caso marcado como retenção.');
          await reabrir();
        })) : null;
    }
    return cartao('Retenção',
      el('div', { class: 'linha', style: 'gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px' },
        pode ? (() => {
          const s = escolha(null, 'motivo_saida', { '': '— por que quer sair? —', ...MOTIVOS }, o.motivo_saida ?? '');
          s.addEventListener('change', async () => {
            await api.patch(`/empresas/${ctx.empresaId}/ouvidoria/${o.id}`, { motivo_saida: s.value || null });
            toast('Motivo salvo.');
          });
          return el('label', { class: 'campo', style: 'min-width:240px' }, 'Motivo de querer sair', s);
        })() : el('div', {}, el('small', { class: 'mudo' }, 'Motivo de querer sair'), el('div', {}, o.motivo_nome ?? '—')),
        el('div', { class: 'pequeno mudo' }, `Em jogo: ${dinheiro(o.valor_anual_centavos)}/ano`),
        o.retido === null ? null : el('span', { class: `etiqueta ${o.retido ? 'ok' : 'erro'}` }, o.retido ? 'Ficou' : 'Saiu')),
      o.ofertas.length ? tabela(['Oferta', 'Custo', '^Resposta', ''], o.ofertas.map((f) => el('tr', {},
        td(el('div', {}, el('strong', {}, f.tipo_nome), f.descricao ? el('div', { class: 'pequeno mudo' }, f.descricao) : null)),
        td(f.custo_centavos ? `${dinheiro(f.valor_mensal_centavos)}/mês × ${f.meses}` : '—'),
        td(f.aceita === null ? el('span', { class: 'etiqueta aviso' }, 'aguardando') : el('span', { class: `etiqueta ${f.aceita ? 'ok' : ''}` }, f.aceita ? 'aceitou' : 'recusou'), 'centro'),
        td(pode && f.aceita === null ? el('div', { class: 'linha', style: 'gap:4px;justify-content:flex-end' },
          botao('Aceitou', 'pequeno', async () => { await api.patch(`/empresas/${ctx.empresaId}/ouvidoria/${o.id}/ofertas/${f.id}`, { aceita: true }); await reabrir(); }),
          botao('Recusou', 'pequeno', async () => { await api.patch(`/empresas/${ctx.empresaId}/ouvidoria/${o.id}/ofertas/${f.id}`, { aceita: false }); await reabrir(); })) : null, 'dir'))))
        : el('p', { class: 'mudo pequeno', style: 'margin:0' }, 'Nenhuma oferta feita ainda.'),
      pode ? el('div', { class: 'linha', style: 'margin-top:10px' }, botao('Registrar oferta', 'primario pequeno', () => ofertar(o, reabrir))) : null);
  }

  const ofertar = (o, depois) => formModal('Oferta para o cliente ficar', () => [
    escolha('O que foi oferecido', 'tipo', OFERTAS, 'desconto'),
    campo('Detalhe (opcional)', { name: 'descricao', maxlength: 300, placeholder: 'Ex.: 20% por 3 meses; 600 Mb pelo preço do 300' }),
    el('div', { class: 'grade-2' },
      campo('Custo por mês (R$)', { name: 'valor', inputmode: 'decimal', placeholder: '0,00' }),
      campo('Por quantos meses', { name: 'meses', type: 'number', min: 0, max: 36, placeholder: '0' })),
    el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'O custo entra no relatório de retenção: quanto custou segurar cada cliente. Visita e upgrade sem custo direto: deixe em branco.'),
  ], async (d) => {
    await api.post(`/empresas/${ctx.empresaId}/ouvidoria/${o.id}/ofertas`, {
      tipo: d.tipo, descricao: d.descricao || null, valor_mensal_centavos: d.valor ? centavos(d.valor) : 0, meses: d.meses ? Number(d.meses) : 0,
    });
    toast('Oferta registrada.');
    await depois();
  });

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

  const encerrar = (o, fecharPai) => formModal(`Encerrar ${o.protocolo}`, () => {
    const ameacou = o.ameaca_saida || o.tipo === 'cancelamento';
    const pendentes = o.ofertas.filter((f) => f.aceita === null);
    const retencao = el('div', { class: 'grupo-retencao' },
      escolha('O cliente ficou?', 'retido', { '': '— escolha —', sim: 'Ficou (foi retido)', nao: 'Saiu' }, ''),
      escolha('Por que queria sair', 'motivo_saida', { '': '— escolha —', ...MOTIVOS }, o.motivo_saida ?? ''),
      pendentes.length ? el('div', {}, el('small', { class: 'mudo' }, 'Ofertas sem resposta — marque as que ele aceitou'),
        ...pendentes.map((f) => marcar(`${f.tipo_nome}${f.descricao ? ` — ${f.descricao}` : ''}`, { name: `oferta_${f.id}` }))) : null,
      el('p', { class: 'pequeno mudo', style: 'margin:0' },
        `Alimenta a taxa de retenção, o relatório por motivo e oferta e os ${dinheiro(o.valor_anual_centavos)}/ano em jogo neste caso.`));
    retencao.hidden = !ameacou;
    return [
      escolha('Como terminou', 'status', { resolvida: 'Resolvida', improcedente: 'Improcedente' }, 'resolvida'),
      // Reclamação ou Procon em que o cliente falou em sair também é retenção.
      o.tipo === 'cancelamento' ? null : (() => {
        const m = marcar('O cliente ameaçou sair', { name: 'ameaca_saida', checked: Boolean(o.ameaca_saida) });
        m.querySelector('input').addEventListener('change', (e) => { retencao.hidden = !e.target.checked; });
        return m;
      })(),
      retencao,
      area('O que foi feito', { name: 'desfecho', rows: 4, required: true, maxlength: 4000 }),
    ];
  }, async (d) => {
    const ameacou = o.tipo === 'cancelamento' || d.ameaca_saida;
    const corpo = { status: d.status, desfecho: d.desfecho, ameaca_saida: ameacou };
    if (ameacou) {
      corpo.retido = d.retido === '' ? null : d.retido === 'sim';
      corpo.motivo_saida = d.motivo_saida || null;
      corpo.ofertas_aceitas = Object.entries(d).filter(([k, val]) => k.startsWith('oferta_') && val === true).map(([k]) => Number(k.slice(7)));
    }
    await api.post(`/empresas/${ctx.empresaId}/ouvidoria/${o.id}/encerrar`, corpo);
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
      marcar('O cliente falou em sair (cancelar, trocar de provedor)', { name: 'ameaca_saida' }),
      escolha('Por que quer sair (se disse)', 'motivo_saida', { '': '—', ...MOTIVOS }, ''),
    ], async (d) => {
      const r = await api.post(`/empresas/${ctx.empresaId}/ouvidoria`, { ...d, motivo_saida: d.motivo_saida || null });
      toast(r.ja_existia ? `Este cliente já tinha o caso ${r.protocolo} aberto: a nova fala foi registrada nele.` : `Caso ${r.protocolo} aberto.`);
      await recarregar();
    });
  };

  // Duas visões: os casos do dia a dia e o relatório da retenção.
  const casos = el('div');
  const relatorio = el('div');
  const abas = el('div', { class: 'abas' });
  const mostrar = (k) => {
    limpar(abas, [['casos', 'Casos'], ['retencao', 'Retenção']].map(([chave, rotulo]) => el('button', {
      class: `aba${chave === k ? ' on' : ''}`, type: 'button', onclick: () => mostrar(chave),
    }, rotulo)));
    casos.hidden = k !== 'casos';
    relatorio.hidden = k !== 'retencao';
    if (k === 'retencao') telaRetencao(ctx, relatorio).catch((e) => toast(e.message, true));
  };

  limpar(casos,
    indicadores,
    acoesTopo(
      el('div', { class: 'filtros livre' },
        seletor('Situação', { abertas: 'Em aberto', '': 'Todas', resolvida: 'Resolvidas', improcedente: 'Improcedentes' }, estado.status, (v) => { estado.status = v; recarregar(); }),
        seletor('Tipo', { '': 'Todos', ...TIPOS }, estado.tipo, (v) => { estado.tipo = v; recarregar(); }),
        campoBusca(estado.busca, (t) => { estado.busca = t; recarregar(); }, 'Protocolo, nome, telefone ou CPF')),
      !ctx.pode('ouvidoria.editar') ? null : el('button', { class: 'btn primario', onclick: criar }, icone('mais'), 'Abrir caso')),
    lista);
  limpar(ctx.conteudo, abas, casos, relatorio);
  mostrar('casos');

  await recarregar();
  ctx.parar(repetir(recarregar, 20_000));
}

/**
 * Relatório da retenção: por que os clientes querem sair, qual oferta segura cada motivo, quanto
 * custou e quanto ficou. É a resposta para "qual oferta eu faço para quem diz que está caro?".
 */
async function telaRetencao(ctx, alvo) {
  const { hojeLocal, somarDias } = await import('./ui.js');
  const { filtroPeriodo } = await import('./comum.js');
  const estado = { de: somarDias(hojeLocal(), -89), ate: hojeLocal() };
  const conteudo = el('div');
  const taxa = (x) => (x === null || x === undefined ? '—' : porcento(x));

  const desenhar = async () => {
    const r = await api.get(`/empresas/${ctx.empresaId}/ouvidoria/retencao${qs(estado)}`);
    const salva = r.receita_salva_com_oferta_centavos;
    const custo = r.custo_centavos;
    limpar(conteudo,
      el('div', { class: 'indicadores' },
        indicador('Ficaram', taxa(r.taxa), `${inteiro(r.retidos)} de ${inteiro(r.casos)} que ameaçaram sair`, 'pessoa', 'verde'),
        indicador('Receita salva com ofertas', dinheiro(salva), custo ? `custou ${dinheiro(custo)}` : 'sem custo de oferta', 'dinheiro', 'roxo'),
        indicador('Saíram sem oferta', inteiro(r.perdidos_sem_oferta), 'ninguém ofereceu nada', 'alerta', r.perdidos_sem_oferta ? 'vermelho' : 'verde'),
        indicador('Ficaram sem oferta', inteiro(r.retidos_sem_oferta), 'resolvido na conversa', 'ok', 'azul')),

      r.melhor_por_motivo.length ? cartao('A oferta que mais segura, por motivo',
        el('div', { class: 'melhores-ofertas' }, r.melhor_por_motivo.map((m) => el('div', { class: 'melhor-oferta' },
          el('small', {}, m.motivo_nome),
          el('strong', {}, m.oferta_nome),
          el('span', { class: 'pequeno mudo' }, `segurou ${taxa(m.taxa_sucesso)} de ${inteiro(m.oferecidas)} oferta(s)${m.pouca_amostra ? ' — pouca amostra ainda' : ''}`))))) : null,

      el('div', { class: 'grade-2' },
        cartao('Por que querem sair',
          tabela(['Motivo', '>Casos', '>Ficaram', '>Taxa', '>Receita perdida'], r.por_motivo.map((m) => el('tr', {},
            td(m.nome), td(inteiro(m.casos), 'dir num'), td(inteiro(m.retidos), 'dir num'), td(taxa(m.taxa), 'dir num'),
            td(dinheiro(m.receita_perdida_centavos), 'dir num'))), 'Nenhum caso de retenção encerrado no período')),
        cartao('Como cada oferta funcionou',
          tabela(['Oferta', '>Feitas', '>Aceitas', '>Seguraram', '>Custo'], r.por_oferta.map((o) => el('tr', {},
            td(o.nome), td(inteiro(o.oferecidas), 'dir num'), td(`${inteiro(o.aceitas)} (${taxa(o.taxa_aceite)})`, 'dir num'),
            td(`${inteiro(o.seguraram)} (${taxa(o.taxa_sucesso)})`, 'dir num'), td(dinheiro(o.custo_centavos), 'dir num'))), 'Nenhuma oferta registrada no período'))),

      r.cruzamento.length ? cartao('Motivo × oferta',
        tabela(['Motivo', 'Oferta', '>Feitas', '>Seguraram', '>Taxa'], r.cruzamento.map((c) => el('tr', {},
          td(c.motivo_nome), td(c.oferta_nome), td(inteiro(c.oferecidas), 'dir num'), td(inteiro(c.seguraram), 'dir num'), td(taxa(c.taxa_sucesso), 'dir num')))),
        el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' },
          '"Segurou" é oferta aceita por cliente que ficou. Poucos casos ainda dizem pouco: a tendência aparece com o tempo.')) : null);
  };
  limpar(alvo, filtroPeriodo(estado, () => desenhar().catch((e) => toast(e.message, true))), conteudo);
  await desenhar();
}

export { TIPOS, STATUS };
