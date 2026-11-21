/** Rede física: as TVs (com pareamento e programação de cada uma) e os pontos onde elas estão. */
import { api } from './api.js';
import {
  el, limpar, $, icone, toast, acao, modal, formModal, confirmar, perguntar, campo, escolha, marcar, area, lerForm, repetir,
  inteiro, dinheiro, dataHora, duracao, percentual, dataBr, etiquetaDe, situacao, CATEGORIAS, ORIENTACOES, STATUS_TELA, STATUS_PONTO, DIAS,
} from './ui.js';
import { cartao, indicador, tabela, vazio, linhaDoLoop, itensDoLoop, resumoDoLoop, previa } from './comum.js';

// ---------------------------------------------------------------- TVs
export async function telasEquipe(ctx) {
  const filtro = { busca: '', local_id: '', status: '' };
  const corpo = el('div', { class: 'coluna' });
  const opcoes = await api.get('/painel/opcoes');

  const pintar = async () => {
    const q = new URLSearchParams(Object.entries(filtro).filter(([, v]) => v)).toString();
    const d = await api.get(`/painel/telas${q ? `?${q}` : ''}`);
    limpar(corpo,
      d.aguardando.length ? cartaoAguardando(d.aguardando, opcoes, pintar) : null,
      el('div', { class: 'telas' }, d.itens.map((t) => cartaoTela(t, pintar))),
      d.itens.length ? null : vazio('Nenhuma TV cadastrada. Cadastre a TV e pareie o aparelho, ou abra o player no aparelho para gerar um código.'));
  };

  const busca = el('input', { placeholder: 'Buscar por TV ou ponto', value: filtro.busca, oninput: (e) => { filtro.busca = e.target.value; agendar(); } });
  let timer;
  const agendar = () => { clearTimeout(timer); timer = setTimeout(pintar, 300); };
  const selPonto = escolha('Ponto', 'local_id', { '': 'Todos os pontos', ...Object.fromEntries(opcoes.locais.map((l) => [l.id, `${l.nome} — ${l.cidade}`])) }, '', {
    onchange: (e) => { filtro.local_id = e.target.value; pintar(); },
  });
  const selStatus = escolha('Situação', 'status', { '': 'Todas', ativa: 'Ativa', manutencao: 'Manutenção', inativa: 'Inativa' }, '', {
    onchange: (e) => { filtro.status = e.target.value; pintar(); },
  });

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' }, el('label', { class: 'campo' }, 'Buscar', busca), selPonto, selStatus,
      el('button', { class: 'btn', onclick: () => abrirPareamento(opcoes, pintar) }, icone('parear'), 'Parear aparelho'),
      el('button', { class: 'btn primario', onclick: () => novaTela(opcoes, pintar) }, icone('mais'), 'Nova TV')),
    corpo);
  await pintar();
  ctx.parar(repetir(pintar, 45_000));
}

function cartaoAguardando(lista, opcoes, recarregar) {
  return el('div', { class: 'cartao', style: 'border-color:var(--destaque-borda);background:var(--destaque-bg)' },
    el('h2', {}, `Aparelho aguardando pareamento (${lista.length})`),
    el('p', { class: 'mudo', style: 'margin-top:-8px' }, 'Um player abriu e está mostrando um código na TV. Escolha o ponto para ligar os dois.'),
    el('div', { class: 'fichas' }, lista.map((p) => el('button', {
      class: 'btn', onclick: () => abrirPareamento(opcoes, recarregar, p.codigo),
    }, icone('parear'), `${p.codigo} — ${p.aparelho ?? 'aparelho'} ${p.largura ? `(${p.largura}×${p.altura})` : ''}`))));
}

function cartaoTela(t, recarregar) {
  const estado = t.online ? 'no ar' : (t.pareada ? 'sem contato' : 'aguardando pareamento');
  const selo = el('span', { class: `selo${t.online ? '' : (t.pareada ? ' off' : ' esperando')}` }, estado);
  const moldura = el('div', { class: `moldura${t.orientacao === 'retrato' ? ' retrato' : ''}` }, selo,
    el('div', { class: 'vazia' }, t.item_atual ? el('div', {}, el('div', { style: 'font-size:11px;opacity:.7' }, 'No ar agora'), el('strong', {}, t.item_atual)) : 'Sem informação do player'));
  return el('div', { class: 'tela-cartao' }, moldura,
    el('div', { class: 'corpo' },
      el('h3', {}, t.nome),
      el('div', { class: 'pequeno mudo' }, `${t.local_nome} · ${t.cidade ?? ''} · ${ORIENTACOES[t.orientacao]}`),
      el('div', { class: 'linha' }, etiquetaDe(STATUS_TELA, t.status),
        t.versao_player ? el('span', { class: 'pequeno mudo' }, `player ${t.versao_player}`) : null),
      el('div', { class: 'pequeno mudo' }, t.ultimo_contato ? `Último contato: ${dataHora(t.ultimo_contato)}` : 'Nunca falou com o servidor'),
      t.aviso ? el('p', { class: 'aviso', style: 'margin:0' }, `Aviso na faixa: “${t.aviso}”`) : null,
      el('div', { class: 'acoes' },
        el('button', { class: 'btn pequeno', onclick: () => abrirTela(t.id, recarregar) }, icone('olho'), 'Abrir'),
        el('button', { class: 'btn pequeno', onclick: () => editarAviso(t, recarregar) }, 'Aviso'),
        el('button', { class: 'btn pequeno', onclick: () => editarTela(t, recarregar) }, icone('editar'), 'Editar'))));
}

/** Detalhe da TV: programação atual, histórico do aparelho e números do dia. */
async function abrirTela(id, recarregar) {
  const d = await api.get(`/painel/telas/${id}`);
  await modal(`${d.nome} — ${d.local_nome}`, (fechar) => [
    el('div', { class: 'grade', style: 'margin-bottom:16px' },
      indicador({ rotulo: 'Situação', valor: d.online ? 'No ar' : 'Sem contato', ic: 'telas', cor: d.online ? 'verde' : 'vermelho', nota: d.aberto ? 'Ponto aberto agora' : 'Ponto fechado agora' }),
      indicador({ rotulo: 'Inserções hoje', valor: inteiro(d.hoje.insercoes), ic: 'tocar', nota: `${inteiro(d.hoje.insercoes_pagas)} de publicidade` }),
      indicador({ rotulo: 'Tempo de tela hoje', valor: duracao(d.hoje.segundos), ic: 'relogio', cor: 'ciano' })),
    el('h3', {}, 'Programação agora'),
    linhaDoLoop(d.grade),
    d.grade?.itens?.length ? el('div', { style: 'margin-top:14px' }, resumoDoLoop(d.grade)) : null,
    d.grade?.itens?.length ? el('details', { style: 'margin-top:10px' }, el('summary', { class: 'mudo pequeno' }, 'Ver o loop item por item'), itensDoLoop(d.grade)) : null,
    el('h3', {}, 'Aparelho'),
    el('div', {}, [
      ['Aparelho', d.aparelho ?? '—'], ['Resolução', d.largura ? `${d.largura} × ${d.altura}` : '—'], ['Versão do player', d.versao_player ?? '—'],
      ['Pareada em', d.pareada_em ? dataHora(d.pareada_em) : 'não pareada'], ['Último contato', d.ultimo_contato ? dataHora(d.ultimo_contato) : '—'],
      ['IP', d.ip ?? '—'], ['Legenda fixa', d.legenda ?? '—'],
    ].map(([k, v]) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, k), el('strong', {}, String(v))))),
    el('h3', {}, 'Últimos eventos'),
    tabela([[(e) => dataHora(e.criado_em), 'Quando'], [(e) => e.tipo, 'O que'], [(e) => e.detalhe ?? '—', 'Detalhe']],
      d.historico.eventos.slice(0, 12), { vazioTexto: 'Sem eventos registrados.' }),
    el('div', { class: 'linha entre', style: 'margin-top:18px' },
      el('button', {
        class: 'btn perigo', onclick: async (ev) => acao(ev.target, async () => {
          if (!await confirmar('Desparear aparelho', 'O aparelho perde o acesso e passa a mostrar um novo código na TV. A programação não é apagada.', 'Desparear')) return;
          await api.post(`/painel/telas/${d.id}/desparear`);
          toast('Aparelho despareado.');
          fechar();
          recarregar();
        }),
      }, 'Desparear aparelho'),
      el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

const camposTela = (t = {}, opcoes) => [
  escolha('Ponto', 'local_id', Object.fromEntries(opcoes.locais.map((l) => [l.id, `${l.nome} — ${l.cidade}`])), t.local_id ?? '', { required: true }),
  campo('Nome da TV (ex.: TV do caixa)', { name: 'nome', value: t.nome ?? '', required: true, maxlength: 120 }),
  el('div', { class: 'duas' },
    escolha('Orientação', 'orientacao', ORIENTACOES, t.orientacao ?? 'paisagem'),
    t.id ? escolha('Situação', 'status', { ativa: 'Ativa', manutencao: 'Manutenção', inativa: 'Inativa' }, t.status ?? 'ativa') : null),
  campo('Legenda fixa na faixa (opcional)', { name: 'legenda', value: t.legenda ?? '', maxlength: 200, placeholder: 'Ex.: Bem-vindo à Padaria Pão Quente' }),
  el('div', { class: 'linha' }, marcar('Som ligado nos vídeos', { name: 'som', checked: Boolean(t.som) }), marcar('Mostrar o relógio', { name: 'relogio', checked: t.id ? Boolean(t.relogio) : true })),
  area('Observação (opcional)', { name: 'observacao', maxlength: 500 }, t.observacao ?? ''),
];

const novaTela = (opcoes, recarregar) => formModal('Nova TV', () => camposTela({}, opcoes), async (d) => {
  await api.post('/painel/telas', d);
  toast('TV cadastrada. Agora abra o player no aparelho e pareie com o código.');
  recarregar();
});

const editarTela = (t, recarregar) => api.get('/painel/opcoes').then((opcoes) => formModal(`Editar ${t.nome}`, () => camposTela(t, opcoes), async (d) => {
  await api.patch(`/painel/telas/${t.id}`, d);
  toast('TV atualizada.');
  recarregar();
}));

/** Pareamento: digita o código que está na TV e escolhe onde ela fica. */
function abrirPareamento(opcoes, recarregar, codigoInicial = '') {
  return modal('Parear aparelho', (fechar) => {
    const codigo = el('input', { class: 'codigo-pareamento', value: codigoInicial, maxlength: 7, placeholder: 'ABC234', required: true, autocapitalize: 'characters' });
    const modo = escolha('Onde esta TV fica', 'modo', { nova: 'Criar uma TV nova neste ponto', existente: 'Ligar a uma TV já cadastrada' }, 'nova');
    const ponto = escolha('Ponto', 'local_id', Object.fromEntries(opcoes.locais.map((l) => [l.id, `${l.nome} — ${l.cidade}`])), '');
    const nome = campo('Nome da TV', { name: 'nome', placeholder: 'TV do caixa', maxlength: 120 });
    const telaExistente = escolha('TV cadastrada', 'tela_id',
      Object.fromEntries(opcoes.telas.map((t) => [t.id, `${t.local_nome} — ${t.nome}`])), '');
    telaExistente.hidden = true;
    modo.querySelector('select').addEventListener('change', (e) => {
      const nova = e.target.value === 'nova';
      ponto.hidden = !nova;
      nome.hidden = !nova;
      telaExistente.hidden = nova;
    });
    const ok = el('button', { class: 'btn primario largo' }, 'Parear');
    const f = el('form', { class: 'form' },
      el('p', { class: 'mudo', style: 'margin:0' }, 'O código aparece na tela do aparelho ao abrir o player. Ele vale por 15 minutos.'),
      codigo, modo, ponto, nome, telaExistente,
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), ok));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(ok, async () => {
        const d = lerForm(f);
        const corpo = d.modo === 'nova'
          ? { codigo: d.codigo, local_id: d.local_id, nome: d.nome || undefined }
          : { codigo: d.codigo, tela_id: d.tela_id };
        const r = await api.post('/painel/telas/parear', corpo);
        toast(`TV "${r.nome}" pareada. A programação começa em alguns segundos.`);
        fechar();
        recarregar();
      });
    });
    return f;
  });
}

function editarAviso(t, recarregar) {
  return formModal(`Aviso na faixa — ${t.nome}`, () => [
    el('p', { class: 'mudo', style: 'margin:0' }, 'O texto passa na faixa de baixo da TV, junto com o relógio. Deixe em branco para tirar.'),
    campo('Aviso', { name: 'aviso', value: t.aviso ?? '', maxlength: 200, placeholder: 'Ex.: Promoção de hoje: pão francês R$ 9,90' }),
    escolha('Por quanto tempo', 'horas', { 2: '2 horas', 6: '6 horas', 12: '12 horas', 24: '1 dia', 72: '3 dias', 168: '1 semana' }, t.aviso ? 12 : 12),
  ], async (d) => {
    await api.put(`/painel/telas/${t.id}/aviso`, { aviso: d.aviso || null, horas: Number(d.horas) });
    toast(d.aviso ? 'Aviso no ar.' : 'Aviso retirado.');
    recarregar();
  }, { rotulo: 'Salvar aviso' });
}

// ---------------------------------------------------------------- Pontos
export async function pontos(ctx) {
  const filtro = { busca: '', categoria: '', status: '' };
  const corpo = el('div', { class: 'cartao' });

  const pintar = async () => {
    const q = new URLSearchParams(Object.entries(filtro).filter(([, v]) => v)).toString();
    const d = await api.get(`/painel/locais${q ? `?${q}` : ''}`);
    limpar(corpo, tabela([
      [(l) => el('div', {}, el('div', {}, l.nome), el('div', { class: 'pequeno mudo' }, `${CATEGORIAS[l.categoria]} · ${l.bairro ? `${l.bairro}, ` : ''}${l.cidade}/${l.uf}`)), 'Ponto'],
      [(l) => el('span', {}, situacao(`${l.telas_online}/${l.telas} no ar`, l.telas && l.telas_online === l.telas ? 'ok' : (l.telas_online ? 'aviso' : 'erro'))), 'TVs'],
      [(l) => inteiro(l.publico_dia), 'Público/dia', 'num dir'],
      [(l) => percentual(l.comissao_percentual), 'Comissão', 'num dir'],
      [(l) => l.responsavel ?? '—', 'Responsável'],
      [(l) => etiquetaDe(STATUS_PONTO, l.status), 'Situação'],
      [(l) => el('div', { class: 'acoes' },
        el('button', { class: 'icone-btn', title: 'Abrir', onclick: (e) => { e.stopPropagation(); abrirPonto(l.id, pintar); } }, icone('olho')),
        el('button', { class: 'icone-btn', title: 'Editar', onclick: (e) => { e.stopPropagation(); editarPonto(l, pintar); } }, icone('editar'))), '', 'acoes'],
    ], d.itens, { aoClicar: (l) => abrirPonto(l.id, pintar), vazioTexto: 'Nenhum ponto cadastrado. Comece cadastrando o comércio onde a TV vai ficar.' }));
  };

  let timer;
  const busca = el('input', { placeholder: 'Nome, cidade ou bairro', oninput: (e) => { filtro.busca = e.target.value; clearTimeout(timer); timer = setTimeout(pintar, 300); } });
  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' }, el('label', { class: 'campo' }, 'Buscar', busca),
      escolha('Categoria', 'categoria', { '': 'Todas', ...CATEGORIAS }, '', { onchange: (e) => { filtro.categoria = e.target.value; pintar(); } }),
      escolha('Situação', 'status', { '': 'Todas', ativo: 'Ativo', pausado: 'Pausado', encerrado: 'Encerrado' }, '', { onchange: (e) => { filtro.status = e.target.value; pintar(); } }),
      el('button', { class: 'btn primario', onclick: () => editarPonto(null, pintar) }, icone('mais'), 'Novo ponto')),
    corpo);
  await pintar();
}

async function abrirPonto(id, recarregar) {
  const d = await api.get(`/painel/locais/${id}`);
  await modal(d.nome, (fechar) => [
    el('div', { class: 'grade', style: 'margin-bottom:16px' },
      indicador({ rotulo: 'TVs', valor: inteiro(d.telas.length), ic: 'telas', nota: `${d.telas.filter((t) => t.online).length} no ar` }),
      indicador({ rotulo: 'Público por dia', valor: inteiro(d.publico_dia), ic: 'pessoas', cor: 'ciano' }),
      indicador({ rotulo: 'Comissão do lojista', valor: percentual(d.comissao_percentual), ic: 'dinheiro', cor: 'verde' })),
    el('h3', {}, 'Endereço e contato'),
    el('div', {}, [
      ['Categoria', CATEGORIAS[d.categoria]], ['Endereço', [d.logradouro, d.numero, d.bairro].filter(Boolean).join(', ') || '—'],
      ['Cidade', `${d.cidade}/${d.uf}`], ['CEP', d.cep ?? '—'], ['CNPJ/CPF', d.documento ?? '—'],
      ['Responsável', d.responsavel ?? '—'], ['Telefone', d.telefone ?? '—'], ['E-mail', d.email ?? '—'],
      ['Parceria desde', d.inicio_parceria ? dataBr(d.inicio_parceria) : '—'], ['Agora', d.aberto ? 'aberto' : 'fechado'],
    ].map(([k, v]) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, k), el('strong', {}, String(v))))),
    el('h3', {}, 'Funcionamento'),
    d.horarios.length
      ? el('div', { class: 'fichas' }, d.horarios.map((h) => el('span', { class: 'ficha' }, `${DIAS[h.dia_semana]} ${h.abre}–${h.fecha}`)))
      : vazio('Sem horário cadastrado: a TV conta como aberta o tempo todo.'),
    el('h3', {}, 'TVs do ponto'),
    tabela([
      [(t) => t.nome, 'TV'], [(t) => ORIENTACOES[t.orientacao], 'Orientação'],
      [(t) => situacao(t.online ? 'No ar' : 'Sem contato', t.online ? 'ok' : 'erro'), 'Agora'],
      [(t) => etiquetaDe(STATUS_TELA, t.status), 'Situação'],
    ], d.telas, { vazioTexto: 'Nenhuma TV neste ponto.' }),
    el('h3', {}, 'Repasses'),
    tabela([
      [(r) => r.competencia, 'Competência'], [(r) => dinheiro(r.base_centavos), 'Receita das TVs', 'num dir'],
      [(r) => percentual(r.comissao_percentual), 'Comissão', 'num dir'], [(r) => dinheiro(r.valor_centavos), 'Repasse', 'num dir'],
      [(r) => (r.status === 'pago' ? `pago em ${dataBr(r.pago_em)}` : 'a pagar'), 'Situação'],
    ], d.repasses, { vazioTexto: 'Sem repasses ainda.' }),
    el('h3', {}, 'Acesso do lojista ao portal'),
    d.usuarios.length
      ? el('div', {}, d.usuarios.map((u) => el('div', { class: 'chave' }, el('span', {}, `${u.nome} · ${u.email}`),
        el('span', { class: 'pequeno mudo' }, u.ultimo_acesso ? `último acesso ${dataHora(u.ultimo_acesso)}` : 'nunca acessou'))))
      : vazio('Sem acesso criado. O lojista pode acompanhar as TVs e o repasse pelo portal.'),
    el('div', { class: 'linha entre', style: 'margin-top:18px' },
      el('button', { class: 'btn', onclick: () => { fechar(); criarAcessoLojista(d, recarregar); } }, icone('pessoas'), 'Criar acesso do lojista'),
      el('div', { class: 'linha' },
        el('button', { class: 'btn', onclick: () => { fechar(); editarPonto(d, recarregar); } }, icone('editar'), 'Editar'),
        el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar'))),
  ], { largo: true });
}

/** Cadastro/edição do ponto, com o horário de funcionamento por dia da semana. */
function editarPonto(p, recarregar) {
  const existentes = new Map((p?.horarios ?? []).map((h) => [h.dia_semana, h]));
  return formModal(p ? `Editar ${p.nome}` : 'Novo ponto', () => [
    campo('Nome do comércio', { name: 'nome', value: p?.nome ?? '', required: true, maxlength: 120 }),
    el('div', { class: 'duas' },
      escolha('Categoria', 'categoria', CATEGORIAS, p?.categoria ?? 'outro'),
      campo('CNPJ/CPF (opcional)', { name: 'documento', value: p?.documento ?? '', maxlength: 20 })),
    el('div', { class: 'tres' },
      campo('CEP', { name: 'cep', value: p?.cep ?? '', maxlength: 9 }),
      campo('Cidade', { name: 'cidade', value: p?.cidade ?? '', required: true, maxlength: 80 }),
      campo('UF', { name: 'uf', value: p?.uf ?? 'SP', required: true, maxlength: 2, style: 'text-transform:uppercase' })),
    el('div', { class: 'tres' },
      campo('Endereço', { name: 'logradouro', value: p?.logradouro ?? '', maxlength: 160 }),
      campo('Número', { name: 'numero', value: p?.numero ?? '', maxlength: 20 }),
      campo('Bairro', { name: 'bairro', value: p?.bairro ?? '', maxlength: 80 })),
    el('div', { class: 'tres' },
      campo('Responsável', { name: 'responsavel', value: p?.responsavel ?? '', maxlength: 120 }),
      campo('Telefone', { name: 'telefone', value: p?.telefone ?? '', maxlength: 20 }),
      campo('E-mail', { name: 'email', value: p?.email ?? '', type: 'email', maxlength: 160 })),
    el('div', { class: 'tres' },
      campo('Público por dia (estimativa)', { name: 'publico_dia', value: p?.publico_dia ?? 0, type: 'number', min: 0, step: 10 }),
      campo('Comissão do lojista (%)', { name: 'comissao_percentual', value: p ? (p.comissao_percentual / 100) : '', type: 'number', min: 0, max: 100, step: 0.5 }),
      p ? escolha('Situação', 'status', { ativo: 'Ativo', pausado: 'Pausado', encerrado: 'Encerrado' }, p.status) : null),
    el('fieldset', {}, el('legend', {}, 'Funcionamento'),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Marque os dias em que o comércio abre. Sem nenhum dia marcado, a TV conta como aberta sempre.'),
      ...DIAS.map((nome, d) => {
        const h = existentes.get(d);
        return el('div', { class: 'linha', style: 'gap:8px' },
          marcar(nome, { name: `dia_${d}`, checked: Boolean(h), style: 'min-width:86px' }),
          el('input', { name: `abre_${d}`, type: 'time', value: h?.abre ?? '08:00', style: 'max-width:130px' }),
          el('span', { class: 'mudo' }, 'às'),
          el('input', { name: `fecha_${d}`, type: 'time', value: h?.fecha ?? '18:00', style: 'max-width:130px' }));
      })),
    area('Observação', { name: 'observacao', maxlength: 500 }, p?.observacao ?? ''),
  ], async (d) => {
    const horarios = DIAS.map((_, i) => (d[`dia_${i}`] ? { dia_semana: i, abre: d[`abre_${i}`], fecha: d[`fecha_${i}`] } : null)).filter(Boolean);
    const corpo = { ...d, horarios };
    for (const k of Object.keys(corpo)) if (/^(dia|abre|fecha)_\d$/.test(k)) delete corpo[k];
    if (p) await api.patch(`/painel/locais/${p.id}`, corpo);
    else await api.post('/painel/locais', corpo);
    toast(p ? 'Ponto atualizado.' : 'Ponto cadastrado.');
    recarregar();
  }, { largo: true });
}

const criarAcessoLojista = (p, recarregar) => formModal(`Acesso ao portal — ${p.nome}`, () => [
  el('p', { class: 'mudo', style: 'margin:0' }, 'O lojista vê as TVs dele, o que está no ar, o repasse e pode enviar conteúdo da loja.'),
  campo('Nome da pessoa', { name: 'nome', value: p.responsavel ?? '', required: true, maxlength: 120 }),
  campo('E-mail (será o login)', { name: 'email', type: 'email', value: p.email ?? '', required: true }),
], async (d) => {
  const r = await api.post(`/painel/locais/${p.id}/acesso`, d);
  recarregar();
  await modal('Acesso criado', (fechar) => [
    el('p', {}, 'Entregue estes dados ao lojista. Ele troca a senha no primeiro acesso.'),
    el('div', { class: 'segredo' }, `Endereço: ${location.origin}${location.pathname}\nE-mail: ${d.email}\nSenha provisória: ${r.senha_provisoria}`),
    el('div', { class: 'linha entre' }, el('span', {}), el('button', { class: 'btn primario', onclick: () => fechar() }, 'Entendi')),
  ]);
});
