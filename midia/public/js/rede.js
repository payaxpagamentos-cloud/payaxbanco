/** Rede física: as TVs (com pareamento e programação de cada uma) e os pontos onde elas estão. */
import { api, qs } from './api.js';
import {
  el, limpar, $, icone, toast, acao, modal, formModal, confirmar, perguntar, campo, escolha, marcar, area, lerForm, repetir,
  inteiro, dinheiro, dataHora, duracao, percentual, dataBr, etiqueta, etiquetaDe, situacao, centavos, reaisCampo, telefone, abrirWhatsApp,
  CATEGORIAS, PREDIOS, POSICOES, REPASSES, LAYOUTS, ORIENTACOES, STATUS_TELA, STATUS_PONTO, STATUS_COMUNICADO, TIPOS_COMUNICADO, DIAS,
} from './ui.js';
import { cartao, indicador, tabela, vazio, linhaDoLoop, itensDoLoop, resumoDoLoop, previa, imagemDaApi, enviarArquivo, BASE_API, campoFotoComunicado, campoEmpresa } from './comum.js';

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
      el('button', { class: 'btn', onclick: (e) => mandarComando(e.target, { desatualizadas: true, comando: 'recarregar' }, pintar) }, icone('relogio'), 'Atualizar players'),
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
    el('div', { class: 'coluna', style: 'gap:8px' }, lista.map((p) => el('div', { style: 'display:flex;gap:8px;align-items:stretch' },
      el('button', {
        class: 'btn', style: 'flex:1;min-width:0;justify-content:flex-start;text-align:left;white-space:normal', onclick: () => abrirPareamento(opcoes, recarregar, p.codigo),
      }, el('span', {}, el('strong', {}, p.codigo), ` — ${nomeDoAparelho(p.aparelho)}${p.largura ? ` (${p.largura}×${p.altura})` : ''}`)),
      el('button', {
        class: 'btn', title: 'Tirar da lista', 'aria-label': `Tirar ${p.codigo} da lista`,
        onclick: (e) => acao(e.currentTarget, async () => { await api.del(`/painel/telas/pareamentos/${p.id}`); recarregar(); }),
      }, '✕')))));
}

/** O navegador se apresenta com um texto comprido e técnico; aqui vira o nome do aparelho. */
function nomeDoAparelho(texto) {
  const t = String(texto ?? '');
  if (/Tizen|SMART-TV|SamsungBrowser.*TV/i.test(t)) return 'TV Samsung';
  if (/Web0S|webOS|NetCast/i.test(t)) return 'TV LG';
  if (/AFT|Fire TV|Silk/i.test(t)) return 'Fire TV';
  if (/Android TV|GoogleTV|BRAVIA|; TV\b|TV Box|SmartTV/i.test(t)) return 'Android TV / TV box';
  if (/iPhone/i.test(t)) return 'iPhone (celular)';
  if (/iPad/i.test(t)) return 'iPad';
  if (/Android/i.test(t)) return /Mobile/i.test(t) ? 'Celular Android' : 'Tablet ou TV box Android';
  if (/Windows/i.test(t)) return 'Computador Windows';
  if (/Macintosh/i.test(t)) return 'Computador Mac';
  if (/Linux|CrOS/i.test(t)) return 'Computador ou mini PC';
  return 'Aparelho';
}

function cartaoTela(t, recarregar) {
  const estado = t.online ? 'no ar' : (t.pareada ? 'sem contato' : 'aguardando pareamento');
  const selo = el('span', { class: `selo${t.online ? '' : (t.pareada ? ' off' : ' esperando')}` }, estado);
  // Com a prova visual ligada, a moldura mostra a última foto que a própria TV mandou.
  const moldura = el('div', { class: `moldura${t.orientacao === 'retrato' ? ' retrato' : ''}` }, selo,
    t.foto_em
      ? imagemDaApi(`/painel/telas/${t.id}/foto`, { classe: 'foto', alt: `O que está na tela ${t.nome}`, vazio: 'Foto indisponível' })
      : el('div', { class: 'vazia' }, t.item_atual ? el('div', {}, el('div', { style: 'font-size:11px;opacity:.7' }, 'No ar agora'), el('strong', {}, t.item_atual)) : 'Sem informação do player'));
  return el('div', { class: 'tela-cartao' }, moldura,
    el('div', { class: 'corpo' },
      el('h3', {}, t.nome),
      el('div', { class: 'pequeno mudo' }, `${t.local_nome}${t.posicao ? ` · ${t.posicao}` : ''} · ${t.cidade ?? ''} · ${ORIENTACOES[t.orientacao]}`),
      el('div', { class: 'linha' }, etiquetaDe(STATUS_TELA, t.status),
        t.layout === 'dividida' ? etiqueta('Tela dividida', 'info') : null,
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
    d.foto_em
      ? el('div', {},
        el('h3', {}, 'O que está na tela'),
        el('div', { class: 'foto-tela' },
          imagemDaApi(`/painel/telas/${d.id}/foto`, { classe: 'quadro', alt: `Foto da tela ${d.nome}`, vazio: 'A foto ainda não chegou.' }),
          el('div', { class: 'legenda-foto' },
            el('strong', {}, d.foto_item ?? 'conteúdo em exibição'),
            el('span', { class: 'mudo pequeno' }, `foto enviada pela própria TV em ${dataHora(d.foto_em)}`))))
      : null,
    el('h3', {}, 'Programação agora'),
    linhaDoLoop(d.grade),
    d.grade?.itens?.length ? el('div', { style: 'margin-top:14px' }, resumoDoLoop(d.grade)) : null,
    d.grade?.itens?.length ? el('details', { style: 'margin-top:10px' }, el('summary', { class: 'mudo pequeno' }, 'Ver o loop item por item'), itensDoLoop(d.grade)) : null,
    el('h3', {}, 'Aparelho'),
    d.desatualizada
      ? el('p', { class: 'aviso' }, `Esta tela está com o player ${d.versao_player} e a versão publicada é a ${d.player_publicado}. `
        + 'Mande recarregar: a tela se atualiza sozinha na próxima batida.')
      : null,
    el('div', { class: 'linha', style: 'margin-bottom:12px' },
      el('button', { class: 'btn pequeno', onclick: (e) => mandarComando(e.target, { tela_id: d.id, comando: 'recarregar' }) }, icone('relogio'), 'Recarregar o player'),
      el('button', { class: 'btn pequeno', onclick: (e) => mandarComando(e.target, { tela_id: d.id, comando: 'limpar_cache' }) }, 'Limpar o cache e recarregar')),
    d.comandos?.length
      ? el('details', { style: 'margin-bottom:10px' }, el('summary', { class: 'mudo pequeno' }, 'Comandos enviados'),
        tabela([[(c) => c.comando.replace('_', ' '), 'Comando'], [(c) => dataHora(c.criado_em), 'Enviado'],
          [(c) => (c.entregue_em ? dataHora(c.entregue_em) : 'aguardando a tela'), 'Recebido']], d.comandos))
      : null,
    el('div', {}, [
      ['Aparelho', d.aparelho ?? '—'], ['Resolução', d.largura ? `${d.largura} × ${d.altura}` : '—'],
      ['Versão do player', `${d.versao_player ?? '—'} (publicada: ${d.player_publicado})`],
      ['Pareada em', d.pareada_em ? dataHora(d.pareada_em) : 'não pareada'], ['Último contato', d.ultimo_contato ? dataHora(d.ultimo_contato) : '—'],
      ['IP', d.ip ?? '—'], ['Legenda fixa', d.legenda ?? '—'],
    ].map(([k, v]) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, k), el('strong', {}, String(v))))),
    el('h3', {}, 'Últimos eventos'),
    tabela([[(e) => dataHora(e.criado_em), 'Quando'], [(e) => e.tipo, 'O que'], [(e) => e.detalhe ?? '—', 'Detalhe']],
      d.historico.eventos.slice(0, 12), { vazioTexto: 'Sem eventos registrados.' }),
    el('div', { class: 'linha entre', style: 'margin-top:18px;flex-wrap:wrap;gap:8px' },
      el('button', {
        class: 'btn perigo', onclick: async (ev) => acao(ev.target, async () => {
          if (!await confirmar('Desparear aparelho', 'O aparelho perde o acesso e passa a mostrar um novo código na TV. A programação não é apagada.', 'Desparear')) return;
          await api.post(`/painel/telas/${d.id}/desparear`);
          toast('Aparelho despareado.');
          fechar();
          recarregar();
        }),
      }, 'Desparear aparelho'),
      el('button', {
        class: 'btn perigo', onclick: async (ev) => acao(ev.target, async () => {
          if (!await confirmar('Excluir esta TV?', `"${d.nome}" sai do sistema de vez, com o histórico dela. O aparelho perde o acesso. Não dá para desfazer.`, 'Excluir TV')) return;
          await api.del(`/painel/telas/${d.id}`);
          toast('TV excluída.');
          fechar();
          recarregar();
        }),
      }, 'Excluir TV'),
      el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

const camposTela = (t = {}, opcoes) => [
  escolha('Ponto', 'local_id', Object.fromEntries(opcoes.locais.map((l) => [l.id, `${l.nome} — ${l.cidade}`])), t.local_id ?? '', { required: true }),
  campo('Nome da TV (ex.: TV do elevador 1)', { name: 'nome', value: t.nome ?? '', required: true, maxlength: 120 }),
  el('label', { class: 'campo' }, 'Onde fica dentro do ponto',
    el('input', { name: 'posicao', value: t.posicao ?? '', maxlength: 60, list: 'posicoes-tela', placeholder: 'Elevador social, hall, portaria…' }),
    el('datalist', { id: 'posicoes-tela' }, POSICOES.map((x) => el('option', { value: x })))),
  el('div', { class: 'duas' },
    escolha('Orientação', 'orientacao', ORIENTACOES, t.orientacao ?? 'paisagem'),
    t.id ? escolha('Situação', 'status', { ativa: 'Ativa', manutencao: 'Manutenção', inativa: 'Inativa' }, t.status ?? 'ativa') : null),
  escolha('Tela dividida?', 'layout', LAYOUTS, t.layout ?? 'cheia'),
  el('p', { class: 'pequeno mudo', style: 'margin:-6px 0 0' },
    'Sim: meio a meio — o recado do ponto com imagem de um lado e o anúncio do outro (bom para condomínio e elevador). '
    + 'Não: o anúncio ocupa a tela toda e o comunicado entra no meio dos anúncios.'),
  escolha('Na tela dividida, a metade do ponto mostra', 'zona', { comunicado: 'Comunicados do ponto', senha: 'Chamada de senha' }, t.zona ?? 'comunicado'),
  el('p', { class: 'pequeno mudo', style: 'margin:-6px 0 0' },
    'Chamada de senha: a senha e o guichê ficam num pedaço da tela e o anúncio no resto. Quem chama é o atendente, em Pontos › Senhas (ou no portal do ponto).'),
  escolha('Girar a imagem na TV', 'giro', { 0: 'Não girar (o normal)', 90: 'Girar para a direita', 270: 'Girar para a esquerda' }, t.giro ?? 0),
  el('p', { class: 'pequeno mudo', style: 'margin:-6px 0 0' },
    'Use quando a TV está pendurada em pé, mas a imagem aparece deitada (de lado). Se depois de girar ficar de cabeça para baixo, troque o lado.'),
  escolha('Quais artes passam nesta TV', 'so_formato', { 0: 'Todas as artes da campanha', 1: 'Só as artes no formato da TV' }, t.so_formato ? 1 : 0),
  el('p', { class: 'pequeno mudo', style: 'margin:-6px 0 0' },
    'Todas: passa tudo; arte de outro formato aparece inteira, menor, no meio. Só no formato da TV: útil quando o anúncio tem a versão em pé e a deitada.'),
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
    // O nome é o que faz o código ir junto no envio: sem ele, o formulário mandava o código vazio
    // e o servidor respondia "não encontrado" para qualquer código, mesmo o certo.
    const codigo = el('input', {
      class: 'codigo-pareamento', name: 'codigo', value: codigoInicial, maxlength: 7, placeholder: 'ABC234',
      required: true, autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
    });
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
    area('Avisos (um por linha; com mais de um, eles passam correndo no rodapé)', { name: 'aviso', rows: 4, maxlength: 1300, placeholder: 'Promoção de hoje: pão francês R$ 9,90\nElevador social em manutenção até as 18h' }, t.aviso ?? ''),
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
      indicador({ rotulo: 'Passagens por dia', valor: inteiro(d.publico_dia), ic: 'pessoas', cor: 'ciano', nota: d.unidades ? `${inteiro(d.unidades)} unidades` : null }),
      indicador({
        rotulo: 'Contrapartida', ic: 'dinheiro', cor: d.repasse_tipo === 'nenhum' ? 'azul' : 'verde',
        valor: d.repasse_tipo === 'fixo' ? dinheiro(d.repasse_fixo_centavos) : (d.repasse_tipo === 'nenhum' ? 'Comunicados' : percentual(d.comissao_percentual)),
        nota: REPASSES[d.repasse_tipo],
      })),
    el('h3', {}, 'Endereço e contato'),
    el('div', {}, [
      ['Ambiente', CATEGORIAS[d.categoria] ?? d.categoria], ['Administradora', d.administradora ?? '—'], ['Endereço', [d.logradouro, d.numero, d.bairro].filter(Boolean).join(', ') || '—'],
      ['Cidade', `${d.cidade}/${d.uf}`], ['CEP', d.cep ?? '—'], ['CNPJ/CPF', d.documento ?? '—'],
      ['Responsável', d.responsavel ?? '—'], ['Telefone / WhatsApp', d.telefone ? telefone(d.telefone) : '—'], ['E-mail', d.email ?? '—'],
      ['Parceria desde', d.inicio_parceria ? dataBr(d.inicio_parceria) : '—'], ['Agora', d.aberto ? 'aberto' : 'fechado'],
    ].map(([k, v]) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, k), el('strong', {}, String(v))))),
    (d.telefone || d.email)
      ? el('div', { class: 'linha', style: 'margin-top:10px' },
        d.telefone
          ? el('button', {
            class: 'btn pequeno',
            onclick: () => abrirWhatsApp(d.telefone, `Olá${d.responsavel ? `, ${d.responsavel}` : ''}! Aqui é da Vai Mídia, sobre a tela do ${d.nome}.`),
          }, icone('enviar'), 'Chamar no WhatsApp')
          : null,
        d.email ? el('a', { class: 'btn pequeno', href: `mailto:${d.email}`, target: '_blank', rel: 'noopener' }, 'Mandar e-mail') : null)
      : null,
    el('h3', {}, 'Funcionamento'),
    d.horarios.length
      ? el('div', { class: 'fichas' }, d.horarios.map((h) => el('span', { class: 'ficha' }, `${DIAS[h.dia_semana]} ${h.abre}–${h.fecha}`)))
      : vazio('Sem horário cadastrado: a TV conta como aberta o tempo todo.'),
    el('h3', {}, 'Identidade nos comunicados'),
    el('div', { class: 'linha' },
      d.logo_arquivo
        ? el('img', { src: `${BASE_API}/painel/locais/${d.id}/logo`, alt: 'Logo', style: 'max-height:54px;max-width:200px;object-fit:contain;background:#fff;border-radius:8px;padding:6px' })
        : el('span', { class: 'mudo pequeno' }, 'Sem logo. A tela mostra só o nome.'),
      el('button', { class: 'btn pequeno', onclick: () => { fechar(); enviarLogo(d, recarregar); } }, icone('enviar'), d.logo_arquivo ? 'Trocar logo' : 'Enviar logo'),
      d.logo_arquivo ? el('button', {
        class: 'btn pequeno perigo', onclick: (e) => acao(e.target, async () => {
          await api.del(`/painel/locais/${d.id}/logo`);
          toast('Logo removida.');
          fechar();
          recarregar();
        }),
      }, 'Remover') : null),
    el('p', { class: 'pequeno mudo' }, `Assinatura: ${d.assinatura ?? `Administração / Síndico — ${d.nome}`}`),
    el('h3', {}, 'Comunicados do ponto'),
    el('p', { class: 'pequeno mudo', style: 'margin:0 0 8px' }, 'Recados do ponto — prédio, loja, academia, clínica — que entram no carrossel entre os anúncios.'),
    tabela([
      [(c) => el('div', {}, el('div', {}, c.titulo), el('div', { class: 'pequeno mudo' }, c.texto.slice(0, 80))), 'Comunicado'],
      [(c) => TIPOS_COMUNICADO[c.tipo] ?? c.tipo, 'Tipo'],
      [(c) => `${dataBr(c.inicio)} a ${dataBr(c.fim)}`, 'Período'],
      [(c) => etiquetaDe(STATUS_COMUNICADO, c.status), 'Situação'],
    ], d.comunicados ?? [], { vazioTexto: 'Nenhum comunicado.' }),
    el('button', { class: 'btn', style: 'margin-top:10px', onclick: () => { fechar(); editarComunicado(null, d, recarregar); } }, icone('mais'), 'Novo comunicado'),
    el('h3', {}, 'TVs do ponto'),
    tabela([
      [(t) => el('div', {}, el('div', {}, t.nome), t.posicao ? el('div', { class: 'pequeno mudo' }, t.posicao) : null), 'TV'],
      [(t) => ORIENTACOES[t.orientacao], 'Orientação'],
      [(t) => situacao(t.online ? 'No ar' : 'Sem contato', t.online ? 'ok' : 'erro'), 'Agora'],
      [(t) => etiquetaDe(STATUS_TELA, t.status), 'Situação'],
    ], d.telas, { vazioTexto: 'Nenhuma TV neste ponto.' }),
    el('h3', {}, 'Repasses'),
    tabela([
      [(r) => r.competencia, 'Competência'], [(r) => dinheiro(r.base_centavos), 'Receita das TVs', 'num dir'],
      [(r) => percentual(r.comissao_percentual), 'Comissão', 'num dir'], [(r) => dinheiro(r.valor_centavos), 'Repasse', 'num dir'],
      [(r) => (r.status === 'pago' ? `pago em ${dataBr(r.pago_em)}` : 'a pagar'), 'Situação'],
    ], d.repasses, { vazioTexto: 'Sem repasses ainda.' }),
    el('h3', {}, 'Acesso do responsável ao portal'),
    d.usuarios.length
      ? el('div', {}, d.usuarios.map((u) => el('div', { class: 'chave' }, el('span', {}, `${u.nome} · ${u.email}`),
        el('span', { class: 'pequeno mudo' }, u.ultimo_acesso ? `último acesso ${dataHora(u.ultimo_acesso)}` : 'nunca acessou'))))
      : vazio('Sem acesso criado. Pelo portal, o responsável pelo ponto (lojista, síndico ou gerente) acompanha as TVs, publica comunicados e vê o repasse.'),
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
    p ? null : campoEmpresa(),
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
      campo('Telefone / WhatsApp', { name: 'telefone', value: p?.telefone ?? '', maxlength: 20 }),
      campo('E-mail', { name: 'email', value: p?.email ?? '', type: 'email', maxlength: 160 })),
    el('div', { class: 'tres' },
      campo('Administradora / rede (opcional)', { name: 'administradora', value: p?.administradora ?? '', maxlength: 120 }),
      campo('Unidades (apartamentos, salas ou lojas)', { name: 'unidades', value: p?.unidades ?? 0, type: 'number', min: 0 }),
      campo('Passagens de pessoas por dia', { name: 'publico_dia', value: p?.publico_dia ?? 0, type: 'number', min: 0, step: 10 })),
    campo('Assinatura dos comunicados (como aparece na tela)', {
      name: 'assinatura', value: p?.assinatura ?? '', maxlength: 120,
      placeholder: p ? `Administração / Síndico — ${p.nome}` : 'Administração / Síndico do Condomínio…',
    }),
    el('fieldset', {}, el('legend', {}, 'Contrapartida ao ponto'),
      el('p', { class: 'pequeno mudo', style: 'margin:0' },
        'Em comércio costuma ser comissão sobre a receita; em condomínio, muitas vezes não há dinheiro — '
        + 'a contrapartida é o espaço para os recados do ponto na própria tela.'),
      el('div', { class: 'tres' },
        escolha('Forma', 'repasse_tipo', REPASSES, p?.repasse_tipo ?? 'comissao'),
        campo('Comissão (%)', { name: 'comissao_percentual', value: p ? (p.comissao_percentual / 100) : '', type: 'number', min: 0, max: 100, step: 0.5 }),
        campo('Valor fixo por mês (R$)', { name: 'repasse_fixo', value: reaisCampo(p?.repasse_fixo_centavos), inputmode: 'decimal' }))),
    p ? escolha('Situação', 'status', { ativo: 'Ativo', pausado: 'Pausado', encerrado: 'Encerrado' }, p.status) : null,
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
    const corpo = { ...d, horarios, repasse_fixo_centavos: centavos(d.repasse_fixo) ?? 0 };
    delete corpo.repasse_fixo;
    for (const k of Object.keys(corpo)) if (/^(dia|abre|fecha)_\d$/.test(k)) delete corpo[k];
    if (p) await api.patch(`/painel/locais/${p.id}`, corpo);
    else await api.post('/painel/locais', corpo);
    toast(p ? 'Ponto atualizado.' : 'Ponto cadastrado.');
    recarregar();
  }, { largo: true });
}

const criarAcessoLojista = (p, recarregar) => formModal(`Acesso ao portal — ${p.nome}`, () => [
  el('p', { class: 'mudo', style: 'margin:0' }, 'O responsável vê as TVs do ponto, o que está no ar e o repasse, publica comunicados e envia conteúdo próprio.'),
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

/** Envio da logo da administradora (aparece no alto do comunicado na tela). */
function enviarLogo(ponto, recarregar) {
  return modal(`Logo — ${ponto.nome}`, (fechar) => {
    const arquivo = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', required: true });
    const ok = el('button', { class: 'btn primario largo' }, 'Enviar');
    const f = el('form', { class: 'form' },
      el('label', { class: 'campo' }, 'Imagem (PNG, JPG ou WEBP, até 3 MB)', arquivo),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Funciona melhor com fundo transparente ou claro, deitada. Ela aparece no alto do comunicado.'),
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), ok));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(ok, async () => {
        const alvo = arquivo.files?.[0];
        if (!alvo) throw new Error('Escolha a imagem.');
        await enviarArquivo(`painel/locais/${ponto.id}/logo`, alvo);
        toast('Logo enviada.');
        fechar();
        recarregar();
      });
    });
    return f;
  });
}

/** Envia o comando e avisa quantas telas vão receber (chega na próxima batida). */
const mandarComando = (botao, corpo, recarregar = null) => acao(botao, async () => {
  const r = await api.post('/painel/telas/comando', corpo);
  toast(`${r.comando.replace('_', ' ')} enviado para ${r.telas} tela(s). ${r.aviso}`);
  recarregar?.();
});

// ---------------------------------------------------------------- Comunicados dos pontos
/**
 * Fila de aprovação dos recados dos pontos. Em condomínio é a contrapartida pelo espaço: o síndico escreve
 * no portal e a equipe confere antes de ir para a tela.
 */
export async function comunicados(ctx) {
  const corpo = el('div', { class: 'cartao' });
  const filtro = { status: '', local_id: '' };
  const opcoes = await api.get('/painel/opcoes');

  const pintar = async () => {
    const d = await api.get(`/painel/comunicados${qs(filtro)}`);
    limpar(corpo,
      d.pendentes ? el('p', { class: 'aviso' }, `${d.pendentes} comunicado(s) aguardando aprovação.`) : null,
      tabela([
        [(c) => el('div', {}, el('div', {}, c.titulo), el('div', { class: 'pequeno mudo' }, c.texto.slice(0, 90))), 'Comunicado'],
        [(c) => el('div', {}, el('div', {}, c.local_nome), el('div', { class: 'pequeno mudo' }, c.autor ? `por ${c.autor}` : 'pela equipe')), 'Ponto'],
        [(c) => TIPOS_COMUNICADO[c.tipo] ?? c.tipo, 'Tipo'],
        [(c) => `${dataBr(c.inicio)} a ${dataBr(c.fim)}`, 'No ar'],
        [(c) => `${c.duracao_s}s`, 'Duração', 'num dir'],
        [(c) => etiquetaDe(STATUS_COMUNICADO, c.status), 'Situação'],
        [(c) => el('div', { class: 'acoes' },
          c.status !== 'aprovado' ? el('button', {
            class: 'btn pequeno primario', onclick: (e) => acao(e.target, async () => {
              await api.post(`/painel/comunicados/${c.id}/aprovacao`, { decisao: 'aprovar' });
              toast('Comunicado no ar.');
              pintar();
            }),
          }, 'Aprovar') : null,
          c.status !== 'recusado' ? el('button', {
            class: 'btn pequeno', onclick: (e) => acao(e.target, async () => {
              const motivo = await perguntar('Recusar comunicado', 'Motivo (o responsável pelo ponto vê)');
              if (!motivo) return;
              await api.post(`/painel/comunicados/${c.id}/aprovacao`, { decisao: 'recusar', motivo });
              toast('Comunicado recusado.');
              pintar();
            }),
          }, 'Recusar') : null,
          el('button', { class: 'icone-btn', title: 'Editar', onclick: () => editarComunicado(c, null, pintar) }, icone('editar')),
          el('button', {
            class: 'icone-btn perigo', title: 'Excluir', onclick: (e) => acao(e.target, async () => {
              if (!await confirmar('Excluir comunicado', `Apagar "${c.titulo}"?`, 'Excluir')) return;
              await api.del(`/painel/comunicados/${c.id}`);
              toast('Comunicado excluído.');
              pintar();
            }),
          }, icone('lixo'))), '', 'acoes'],
      ], d.itens, { vazioTexto: 'Nenhum comunicado. Eles vêm do portal do ponto ou podem ser criados aqui.' }));
  };

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      escolha('Situação', 'status', { '': 'Todos', pendente: 'Aguardando aprovação', aprovado: 'No ar', recusado: 'Recusados' }, '',
        { onchange: (e) => { filtro.status = e.target.value; pintar(); } }),
      escolha('Ponto', 'local_id', { '': 'Todos', ...Object.fromEntries(opcoes.locais.map((l) => [l.id, l.nome])) }, '',
        { onchange: (e) => { filtro.local_id = e.target.value; pintar(); } }),
      el('button', { class: 'btn primario', onclick: () => editarComunicado(null, null, pintar, opcoes) }, icone('mais'), 'Novo comunicado')),
    corpo);
  await pintar();
}

/** Formulário do comunicado. `ponto` fixa o local (quando vem do detalhe do ponto). */
function editarComunicado(c, ponto, recarregar, opcoes = null) {
  const hoje = new Date().toLocaleDateString('en-CA');
  const emDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
  const foto = campoFotoComunicado(c, 'painel');
  const montar = (op) => formModal(c ? 'Editar comunicado' : 'Novo comunicado', () => [
    el('p', { class: 'mudo', style: 'margin:0' }, 'O recado aparece nas TVs do ponto com uma imagem cobrindo o espaço dele e o texto por cima.'),
    c || ponto ? null : escolha('Ponto', 'local_id', Object.fromEntries(op.locais.map((l) => [l.id, `${l.nome} — ${l.cidade}`])), '', { required: true }),
    campo('Título', { name: 'titulo', value: c?.titulo ?? '', required: true, maxlength: 80, placeholder: 'Ex.: Assembleia dia 12' }),
    area('Texto', { name: 'texto', required: true, maxlength: 400, placeholder: 'Ex.: Às 19h no salão de festas. Pauta: previsão orçamentária.' }, c?.texto ?? ''),
    el('div', { class: 'tres' },
      escolha('Tipo', 'tipo', TIPOS_COMUNICADO, c?.tipo ?? 'aviso'),
      campo('No ar de', { name: 'inicio', type: 'date', value: c?.inicio ?? hoje, required: true }),
      campo('até', { name: 'fim', type: 'date', value: c?.fim ?? emDias(7), required: true })),
    el('div', { class: 'duas' },
      campo('Data do evento (opcional)', { name: 'evento_em', type: 'date', value: c?.evento_em ?? '' }),
      campo('Hora', { name: 'evento_hora', type: 'time', value: c?.evento_hora ?? '' })),
    el('p', { class: 'pequeno mudo', style: 'margin:-4px 0 0' },
      'Com a data preenchida, o recado também entra na agenda da tela — o quadro "O que vem por aí" que quem passa acompanha.'),
    campo('Tempo na tela (segundos)', { name: 'duracao_s', type: 'number', min: 5, max: 60, value: c?.duracao_s ?? 10 }),
    foto.campo,
  ], async (d) => {
    const corpo = { ...d, local_id: ponto?.id ?? c?.local_id ?? d.local_id };
    const salvo = c ? await api.patch(`/painel/comunicados/${c.id}`, corpo) : await api.post('/painel/comunicados', corpo);
    await foto.salvar(salvo.id);
    toast(c ? 'Comunicado atualizado.' : 'Comunicado criado e no ar.');
    recarregar();
  });
  return opcoes ? montar(opcoes) : api.get('/painel/opcoes').then(montar);
}
