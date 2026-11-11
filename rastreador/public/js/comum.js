/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
/** Peças usadas tanto no painel do master quanto no das empresas. */
import { api, BASE } from './api.js';
import { el, limpar, dataHora, desde, km, kmh, placa, telefone, toast, acao, campo, escolha, modal, formModal, confirmar, icone, repetir, etiquetaSituacao, etiqueta,
  SITUACOES, TIPOS_VEICULO } from './ui.js';
import { criarMapa, linkGoogle, linkStreetView, linkRota, enderecoDe } from './mapa.js';

export const cartao = (titulo, ...conteudo) => el('section', { class: 'cartao' }, titulo ? el('h2', {}, titulo) : null, conteudo);
// tom: '' (neutro), 'ok', 'aviso' ou 'erro' (só o número muda de cor). ic: nome do ícone ao lado do rótulo (opcional).
export const indicador = (rotulo, valor, nota, tom = '', ic = null) => el('div', { class: `cartao indicador${tom ? ` tom-${tom}` : ''}` },
  el('div', { class: 'rotulo' }, ic ? icone(ic) : null, rotulo),
  el('div', { class: 'valor num' }, valor), nota ? el('div', { class: 'nota' }, nota) : null);
export const td = (conteudo, classe = '') => el('td', { class: classe }, conteudo);
/**
 * Tabela com cabeçalho ('>' alinha à direita, '^' centraliza). Cada célula recebe o nome da coluna (data-rotulo) e o conteúdo
 * entra num <span class="celula">: no celular, as tabelas largas (4 colunas ou mais) empilham cada linha como um cartão.
 */
export function tabela(colunas, linhas, vazio = 'Nada por aqui.') {
  if (!linhas.length) return el('p', { class: 'mudo', style: 'margin:0' }, vazio);
  const rotulos = colunas.map((c) => c.replace(/^[>^]/, ''));
  for (const tr of linhas) {
    [...tr.children].forEach((cel, i) => {
      if (cel.tagName !== 'TD' || cel.querySelector(':scope > .celula')) return;
      cel.dataset.rotulo = rotulos[i] ?? '';
      const w = el('span', { class: 'celula' });
      w.append(...cel.childNodes);
      cel.append(w);
    });
  }
  return el('div', { class: 'rolagem' }, el('table', { class: `tabela${colunas.length >= 4 ? ' empilha' : ''}` },
    el('thead', {}, el('tr', {}, colunas.map((c) => el('th', { class: c.startsWith('>') ? 'dir' : c.startsWith('^') ? 'centro' : '' }, c.replace(/^[>^]/, ''))))),
    el('tbody', {}, linhas)));
}
export const botao = (texto, classe, fn) => {
  const b = el('button', { class: `btn pequeno ${classe}`, type: 'button' }, texto);
  b.addEventListener('click', (e) => { e.stopPropagation(); acao(b, fn); });
  return b;
};
export const botaoIcone = (nome, titulo, fn, classe = '') => {
  const b = el('button', { class: `icone-btn ${classe}`, type: 'button', title: titulo, 'aria-label': titulo }, icone(nome));
  b.addEventListener('click', (e) => { e.stopPropagation(); acao(b, fn); });
  return b;
};
export const acoesTopo = (...itens) => el('div', { class: 'linha entre', style: 'margin-bottom:16px' }, ...itens);
export const linhaDado = (r, v) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, r), el('strong', { style: 'text-align:right' }, v ?? '—'));
export const situacaoDiag = { ok: ['ok', 'OK'], aviso: ['aviso', 'Atenção'], erro: ['erro', 'Problema'] };

/** Campo de data que chama fn(valor) ao mudar. */
export function campoData(rotulo, valor, fn, attrs = {}) {
  const i = el('input', { type: 'date', value: valor, ...attrs });
  i.addEventListener('change', () => fn(i.value));
  return el('label', { class: 'campo' }, rotulo, i);
}

/**
 * Mapa ao vivo: lista de veículos com busca e filtro de situação ao lado do mapa, atualizando sozinho.
 * `caminho`: '/empresas/ID/mapa' ou '/master/mapa'. `detalhe(v, fechar)` monta o painel do veículo escolhido (só no painel da empresa).
 */
export async function painelMapa(ctx, caminho, { detalhe, mostrarEmpresa = false } = {}) {
  ctx.telaCheia();
  const divMapa = el('div', { class: 'mapa' });
  const lista = el('div', { class: 'lista-veiculos' });
  const painel = el('div', { class: 'painel-veiculo oculto' });
  const contagem = el('div', { class: 'contagem' });
  const estado = { busca: '', situacao: '', selecionado: null, enquadrado: false };
  const busca = el('input', { type: 'search', placeholder: 'Placa, descrição ou motorista', 'aria-label': 'Buscar veículo' });
  busca.addEventListener('input', () => { estado.busca = busca.value.trim().toLowerCase(); desenharLista(); });
  limpar(ctx.conteudo, el('div', { class: 'tela-mapa' },
    el('aside', { class: 'lado' }, busca, contagem, lista),
    el('div', { class: 'area-mapa' }, divMapa, painel)));
  // A lista de veículos é pedida junto com a montagem do mapa (antes era uma coisa depois da outra).
  let primeira = api.get(caminho);
  primeira.catch(() => {});
  const mapa = await criarMapa(divMapa);
  const marcadores = new Map();
  const camadasCercas = [];
  let veiculos = [];
  let ultimoDetalhe = null;

  const visivel = (v) => (!estado.situacao || v.situacao === estado.situacao)
    && (!estado.busca || [v.placa, placa(v.placa), v.descricao, v.motorista, v.empresa].some((x) => String(x ?? '').toLowerCase().includes(estado.busca)));

  function desenharLista() {
    const cont = {};
    for (const v of veiculos) cont[v.situacao] = (cont[v.situacao] ?? 0) + 1;
    limpar(contagem, el('button', { class: `filtro-sit${estado.situacao ? '' : ' on'}`, onclick: () => { estado.situacao = ''; desenharLista(); } }, `Todos ${veiculos.length}`),
      Object.entries(cont).map(([s, n]) => el('button', { class: `filtro-sit${estado.situacao === s ? ' on' : ''}`, onclick: () => { estado.situacao = estado.situacao === s ? '' : s; desenharLista(); } },
        el('i', { class: `bolinha s-${s}` }), `${SITUACOES[s]?.[0] ?? s} ${n}`)));
    const vis = veiculos.filter(visivel);
    limpar(lista, vis.length ? vis.map((v) => el('button', { class: `item-veiculo${estado.selecionado === v.id ? ' on' : ''}`, onclick: () => escolher(v, true) },
      el('div', { class: 'linha entre' }, el('strong', {}, placa(v.placa)), etiquetaSituacao(v.situacao)),
      el('div', { class: 'pequeno mudo' }, [v.descricao, mostrarEmpresa ? v.empresa : v.motorista].filter(Boolean).join(' · ') || TIPOS_VEICULO[v.tipo]),
      el('div', { class: 'pequeno fraco linha entre' }, el('span', {}, v.posicao_em ? `${kmh(v.velocidade_kmh)} · ${v.ignicao === 1 ? 'ligado' : v.ignicao === 0 ? 'desligado' : 'ignição ?'}` : 'sem posição'),
        el('span', {}, desde(v.comunicacao_em))),
      v.alertas_pendentes || v.bloqueado ? el('div', { class: 'marcas' },
        v.bloqueado ? el('span', { class: 'texto-erro' }, '● Bloqueado') : null,
        v.alertas_pendentes ? el('span', { class: 'texto-aviso' }, `● ${v.alertas_pendentes} ${v.alertas_pendentes === 1 ? 'alerta' : 'alertas'}`) : null) : null))
      : el('p', { class: 'mudo pequeno', style: 'padding:8px' }, veiculos.length ? 'Nenhum veículo com esse filtro.' : 'Nenhum veículo cadastrado.'));
    for (const [id, mk] of marcadores) mk.selecionar(id === estado.selecionado);
  }

  function escolher(v, centralizar) {
    estado.selecionado = v.id;
    desenharLista();
    if (!detalhe) {
      limpar(painel, faixaVeiculo(v, {
        titulo: [v.descricao, v.empresa].filter(Boolean).join(' · '), etiquetas: [etiquetaSituacao(v.situacao), v.bloqueado ? etiqueta('bloqueado', 'erro') : null],
        acoes: [mostrarEmpresa ? el('a', { class: 'btn pequeno', href: `#/empresa/${v.empresa_id}/mapa` }, 'Abrir no painel da empresa') : null], fechar: fecharPainel,
      }));
    } else {
      ultimoDetalhe = v.id;
      detalhe(v, painel, fecharPainel);
    }
    painel.classList.remove('oculto');
    // Centraliza o veículo na parte do mapa que a faixa não cobre.
    // No celular a lista fica embaixo do mapa: ao tocar num veículo, a tela sobe até o mapa.
    if (centralizar && window.matchMedia('(max-width: 860px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
    if (centralizar && mapa && v.lat !== null) mapa.ir(v.lat, v.lng, undefined, { cobertoEmbaixo: painel.offsetHeight + 12 });
  }
  function fecharPainel() {
    estado.selecionado = null;
    ultimoDetalhe = null;
    painel.classList.add('oculto');
    desenharLista();
  }

  async function carregar() {
    const pedido = primeira ?? api.get(caminho);
    primeira = null;
    const r = await pedido;
    veiculos = r.veiculos;
    if (mapa && r.cercas && !camadasCercas.length) for (const c of r.cercas) camadasCercas.push(mapa.cerca(c));
    if (mapa) {
      const vistos = new Set();
      for (const v of veiculos.filter((x) => x.lat !== null)) {
        vistos.add(v.id);
        const mk = marcadores.get(v.id);
        if (mk) mk.atualizar(v);
        else marcadores.set(v.id, mapa.veiculo(v, { aoClicar: (x) => escolher(x, false) }));
      }
      for (const [id, mk] of marcadores) if (!vistos.has(id)) { mk.remover(); marcadores.delete(id); }
      if (!estado.enquadrado && vistos.size) {
        mapa.enquadrar(veiculos.filter((x) => x.lat !== null).map((x) => [x.lat, x.lng]), 15);
        estado.enquadrado = true;
      }
    }
    desenharLista();
    // O painel aberto acompanha a atualização (velocidade, situação, comandos).
    const sel = veiculos.find((x) => x.id === ultimoDetalhe);
    if (sel && detalhe) detalhe(sel, painel, fecharPainel, { atualizacao: true });
  }
  const pararAtualizacao = repetir(carregar, 10_000);
  ctx.parar(() => { pararAtualizacao(); mapa?.remover(); });
}

/** Dados de leitura do veículo (posição, velocidade, ignição, comunicação, hodômetro). */
/** Endereço de onde o veículo está (preenchido quando a busca responde), com o link para abrir no Google Maps. */
export function enderecoVeiculo(v) {
  if (v.lat === null) return el('div', { class: 'local-veiculo' }, 'Aguardando a primeira posição');
  const texto = el('span', {}, 'buscando endereço…');
  enderecoDe(v.lat, v.lng).then((e) => { texto.textContent = e?.completo || 'endereço não encontrado'; });
  const google = (rotulo, href) => el('a', { href, target: '_blank', rel: 'noopener', class: 'btn pequeno' }, rotulo);
  return el('div', { class: 'local-veiculo' }, icone('cercas'), el('div', {}, texto,
    el('span', { class: 'pequeno fraco coords' }, `${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}`),
    // O próprio Google Maps, numa aba nova (no celular, abre o aplicativo).
    el('div', { class: 'links-google' }, google('Google Maps', linkGoogle(v.lat, v.lng)), google('Street View', linkStreetView(v.lat, v.lng)),
      google('Rota até o veículo', linkRota(v.lat, v.lng)))));
}

/** Dados do veículo em blocos pequenos (velocidade, ignição, posição, comunicação, motorista, hodômetro, bateria). */
export function resumoVeiculo(v) {
  const bloco = (rotulo, valor) => el('div', { class: 'dado' }, el('span', {}, rotulo), el('strong', {}, valor ?? '—'));
  return el('div', { class: 'dados-veiculo' },
    bloco('Velocidade', v.posicao_em ? kmh(v.velocidade_kmh) : null),
    bloco('Ignição', v.ignicao === 1 ? 'Ligada' : v.ignicao === 0 ? 'Desligada' : '—'),
    bloco('Última posição', v.posicao_em ? desde(v.posicao_em) : null),
    bloco('Comunicação', v.comunicacao_em ? desde(v.comunicacao_em) : 'nunca'),
    bloco('Hodômetro', km(v.hodometro_m)),
    v.tensao !== null && v.tensao !== undefined ? bloco('Bateria', `${Number(v.tensao).toFixed(1)} V`) : null,
    v.motorista ? bloco('Motorista', v.motorista_telefone ? `${v.motorista} · ${telefone(v.motorista_telefone)}` : v.motorista) : null);
}

/**
 * Faixa do veículo escolhido, embaixo do mapa (como nos aplicativos de mapa): placa e endereço, os dados e as ações.
 * O botão recolher deixa só a primeira linha. `acoes` são os botões (podem não existir).
 */
export function faixaVeiculo(v, { titulo, etiquetas = [], acoes = [], fechar }) {
  const faixa = el('div', { class: 'faixa' });
  let recolhida = false;
  try { recolhida = localStorage.getItem('rastreador.faixa') === 'recolhida'; } catch { /* padrão: aberta */ }
  const alternar = el('button', { class: 'icone-btn', type: 'button', title: 'Recolher / abrir', 'aria-label': 'Recolher ou abrir os dados do veículo' }, icone('seta'));
  const aplicar = () => { faixa.classList.toggle('recolhida', recolhida); };
  alternar.addEventListener('click', () => {
    recolhida = !recolhida;
    aplicar();
    try { localStorage.setItem('rastreador.faixa', recolhida ? 'recolhida' : 'aberta'); } catch { /* só nesta tela */ }
  });
  faixa.append(
    el('div', { class: 'faixa-topo' },
      el('div', { class: 'faixa-titulo' }, el('h2', {}, placa(v.placa)), el('span', { class: 'pequeno mudo' }, titulo), ...etiquetas),
      el('div', { class: 'linha', style: 'gap:2px' }, alternar, botaoIcone('fechar', 'Fechar', fechar, 'fechar-faixa'))),
    el('div', { class: 'faixa-corpo' }, enderecoVeiculo(v), resumoVeiculo(v), acoes.filter(Boolean).length ? el('div', { class: 'acoes-veiculo' }, acoes) : null));
  aplicar();
  return faixa;
}

// ---------- Integrações ----------
/** Chaves da API e o guia de como ligar os rastreadores (GT06, celular) e outros sistemas. */
export function painelIntegracoes(alvo, { listar, criar, revogar, empresas = null, podeCriar = true, portaGt06 = 5023 }) {
  const lista = el('div');
  const carregar = async () => {
    const chaves = await listar();
    limpar(lista, tabela([empresas ? 'Empresa' : null, 'Nome', 'Chave', 'Criada', 'Último uso', 'Situação', '^Ações'].filter(Boolean), chaves.map((k) => el('tr', {},
      empresas ? td(k.empresa) : null, td(k.nome), td(el('span', { class: 'mono' }, `rst_${k.prefixo}_…`)), td(dataHora(k.criada_em)), td(dataHora(k.ultimo_uso)),
      td(k.revogada_em ? el('span', { class: 'etiqueta erro' }, 'revogada') : el('span', { class: 'etiqueta ok' }, 'ativa')),
      el('td', { class: 'acoes' }, !k.revogada_em && podeCriar ? botao('Revogar', 'perigo', async () => {
        if (!await confirmar('Revogar chave', `O sistema que usa "${k.nome}" perde o acesso na hora. Continuar?`, 'Revogar')) return;
        await revogar(k.id);
        toast('Chave revogada.');
        carregar();
      }) : null))), 'Nenhuma chave criada.'));
  };
  const nova = podeCriar ? el('button', { class: 'btn primario', onclick: async () => {
    const r = await formModal('Nova chave de API', () => [
      empresas ? escolha('Empresa', 'empresa_id', Object.fromEntries(empresas.map((e) => [e.id, e.nome])), empresas[0]?.id, { required: true }) : null,
      campo('Nome (onde será usada)', { name: 'nome', required: true, maxlength: 80, placeholder: 'Ex.: ERP da transportadora' }),
    ], (d) => criar(d));
    if (!r || r === true) return;
    carregar();
    modal('Chave criada', (fechar) => [
      el('p', { class: 'mudo' }, 'Copie agora: por segurança, a chave completa não aparece de novo.'),
      el('div', { class: 'segredo' }, r.chave),
      el('div', { class: 'linha entre', style: 'margin-top:14px' },
        el('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(r.chave).then(() => toast('Copiada.'), () => toast('Não foi possível copiar.', true)) }, 'Copiar'),
        el('button', { class: 'btn primario', onclick: () => fechar() }, 'Pronto')),
    ]);
  } }, 'Nova chave') : null;

  const base = `${location.origin}${BASE}/api`;
  const doc = cartao('Como ligar os rastreadores',
    el('h3', {}, '1. Rastreador J16 4G (Indica Planos) e outros GT06'),
    el('p', { class: 'mudo' }, 'Cadastre o IMEI da etiqueta em Rastreadores (modelo J16 4G) e mande estes SMS para o número do chip do rastreador, um por vez, esperando a resposta "SET OK":'),
    el('pre', { class: 'codigo' }, [
      'SZCS#IMEI=IMEI_DA_ETIQUETA#TERIID=IMEI_DA_ETIQUETA#   (sincroniza o IMEI)',
      'APN,indica.br,indica,indica#            (chip Vivo da Indica; Algar: APN,indica.algar.br,algar,1212#)',
      `SERVER,1,${location.hostname},${portaGt06},0#        (1 = por domínio; com IP use SERVER,0,IP,${portaGt06},0#)`,
      'TIMER,30,3600#                          (posição a cada 30 s ligado e a cada 1 h desligado)',
      'GMT,W,0,0#                              (hora em UTC: o sistema converte para o fuso de Brasília)',
      'SZCS#GPS_DISSLP=1                       (GPS sempre ligado)',
      'SZCS#SLPDISCONNECT=0                    (continua conectado ao servidor quando dorme: recebe bloqueio parado)',
      'STATUS#                                 (confere: GPRS conectado e GPS posicionando)',
    ].join('\n')),
    el('p', { class: 'pequeno mudo' }, 'Ligação do J16: positivo e negativo na bateria (12/24 V), o fio da ignição no pós-chave (sem ele o rastreador fica em espera) e o relé de bloqueio no fio da bomba de combustível. Feche bem a tampa e deixe o lado do LED para cima, longe de metal. Use chip M2M com plano de dados.'),
    el('h3', {}, '2. Celular como rastreador (app Traccar Client, Android e iPhone)'),
    el('pre', { class: 'codigo' }, [`Endereço do servidor: ${base}/osmand`, 'Identificador do dispositivo: o mesmo cadastrado no rastreador (ex.: app-1234567890)',
      'Frequência: 30 s · Precisão: alta'].join('\n')),
    el('h3', {}, '3. Outros sistemas (chave da empresa no cabeçalho X-Api-Key)'),
    el('pre', { class: 'codigo' }, [
      `GET  ${base}/integracao/veiculos                      frota com a última posição`,
      `GET  ${base}/integracao/veiculos/ABC1D23/posicoes?de=2026-10-24T00:00:00Z&ate=2026-10-24T23:59:59Z`,
      `GET  ${base}/integracao/alertas?desde=2026-10-24T00:00:00Z`,
      `POST ${base}/integracao/posicoes                      [{ "imei": "...", "lat": -23.55, "lng": -46.63, "velocidade_kmh": 42, "ignicao": true, "gps_em": "2026-10-24T12:00:00Z" }]`,
      `GET  ${base}/integracao/comandos                      comandos dos rastreadores do tipo "API" a entregar`,
      `POST ${base}/integracao/comandos/15                   { "sucesso": true, "resposta": "OK" }`,
    ].join('\n')));
  limpar(alvo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Chaves que outros sistemas usam para consultar a frota e enviar posições.'), nova), cartao(null, lista),
    el('div', { style: 'height:18px' }), doc);
  return carregar().catch((err) => toast(err.message, true));
}

/**
 * Bloco de destaque dos dashboards (gradiente fluido, órbita e o ponto que pulsa). Fica fixo na página e só troca os textos a
 * cada atualização, para a animação não recomeçar. `atualizar({ rotulo, vivo, titulo, destaque, texto })`: o ponto só pulsa quando
 * `vivo` vem dos dados reais (por exemplo, veículos em movimento agora).
 */
export function blocoDestaque(...acoes) {
  const ponto = el('span', { class: 'ponto parado', 'aria-hidden': 'true' });
  const rotulo = el('span', {});
  const titulo = el('span', {});
  const destaque = el('span', { class: 'linha-destaque' });
  const texto = el('p', {});
  const raiz = el('section', { class: 'destaque' },
    el('div', { class: 'destaque-aura', 'aria-hidden': 'true' }), el('div', { class: 'destaque-grao', 'aria-hidden': 'true' }),
    el('div', { class: 'destaque-orbita', 'aria-hidden': 'true' }, el('div', { class: 'destaque-rastro' }, el('div', { class: 'destaque-ponto' }))),
    el('div', { class: 'destaque-texto' }, el('div', { class: 'destaque-rotulo' }, ponto, rotulo), el('h2', {}, titulo, ' ', destaque), texto),
    acoes.length ? el('div', { class: 'destaque-acoes' }, acoes) : null);
  return {
    raiz,
    atualizar(d) {
      ponto.className = `ponto ${d.vivo ? 'vivo' : 'parado'}`;
      rotulo.textContent = d.rotulo;
      titulo.textContent = d.titulo;
      destaque.textContent = d.destaque;
      texto.textContent = d.texto;
    },
  };
}
