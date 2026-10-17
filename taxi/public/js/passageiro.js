import { api, sessao, usarSessao } from './api.js';
import { el, $, limpar, dinheiro, km, minutos, dataHora, iniciais, FORMAS, CATEGORIAS, etiquetaStatus, toast, acao, perguntar, marca, repetir, modal } from './ui.js';
import { criarMapa, camada, ICONES, enquadrar, minhaPosicao, configPublica } from './mapa.js';
import { telaEntrada } from './entrada.js';

usarSessao('passageiro');
const raiz = $('#app');

// Estado do pedido em montagem.
const pedido = { origem: null, destino: null, categoria: 'comum', forma: 'pix', estimativas: null, marcando: 'destino' };
let mapa, rotaCamada, carrosCamada, pararAtualizacao, corridaAtual = null, ultimoStatus = null;

window.addEventListener('taxi:sair', () => iniciar());

function iniciar() {
  pararAtualizacao?.();
  const s = sessao.get();
  if (!s?.token || s.usuario?.perfil !== 'passageiro') {
    telaEntrada(raiz, { titulo: 'Peça seu táxi', perfis: ['passageiro'], cadastro: 'passageiro', aoEntrar: iniciar });
    return;
  }
  montarApp(s.usuario);
}

async function montarApp(usuario) {
  const painel = el('div', { class: 'app-painel' });
  const divMapa = el('div', { class: 'mapa' });
  limpar(raiz, el('div', { class: 'app' },
    el('div', { class: 'app-topo' }, marca(), el('div', { class: 'linha' },
      el('button', { class: 'btn pequeno', onclick: historico }, 'Minhas corridas'),
      el('button', { class: 'btn pequeno', title: usuario.nome, onclick: () => { sessao.limpar(); iniciar(); } }, 'Sair'))),
    el('div', { class: 'app-mapa' }, divMapa),
    painel));
  mapa = await criarMapa(divMapa);
  rotaCamada = camada(mapa);
  carrosCamada = camada(mapa);
  mapa?.on('click', (e) => marcarNoMapa(e.latlng));
  pararAtualizacao = repetir(() => atualizar(painel), 3000);
  if (!pedido.origem) usarMinhaPosicao(true);
}

/** Origem padrão: a posição do aparelho, com o endereço buscado no servidor. */
async function usarMinhaPosicao(silencioso = false) {
  try {
    const p = await minhaPosicao();
    pedido.origem = { ...p, endereco: 'Minha localização' };
    try { pedido.origem.endereco = (await api.get(`/geo/reverso?lat=${p.lat}&lng=${p.lng}`)).endereco; } catch { /* mantém o texto genérico */ }
    mapa?.setView([p.lat, p.lng], 16);
    pedido.marcando = 'destino';
    await estimar();
  } catch (err) {
    if (!silencioso) toast(err.message, true);
    pedido.marcando = 'origem';
  }
  redesenharPedido();
}

async function marcarNoMapa(latlng) {
  if (corridaAtual) return;
  const ponto = { lat: latlng.lat, lng: latlng.lng, endereco: `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}` };
  try { ponto.endereco = (await api.get(`/geo/reverso?lat=${ponto.lat}&lng=${ponto.lng}`)).endereco; } catch { /* coordenadas */ }
  pedido[pedido.marcando] = ponto;
  pedido.marcando = pedido.marcando === 'origem' && !pedido.destino ? 'destino' : pedido.marcando;
  await estimar();
  redesenharPedido();
}

async function estimar() {
  pedido.estimativas = null;
  const { origem: o, destino: d } = pedido;
  if (!o || !d) return;
  try {
    pedido.estimativas = await api.get(`/passageiro/estimativa?olat=${o.lat}&olng=${o.lng}&dlat=${d.lat}&dlng=${d.lng}`);
  } catch (err) { toast(err.message, true); }
}

/** Campo de endereço com sugestões da busca (ou só a marcação no mapa, se a busca estiver desligada). */
function campoEndereco(tipo, rotulo) {
  const valor = pedido[tipo]?.endereco ?? '';
  const sugestoes = el('div', { class: 'sugestoes oculto' });
  const input = el('input', { value: valor, placeholder: rotulo, autocomplete: 'off', 'aria-label': rotulo,
    onfocus: () => { pedido.marcando = tipo; redesenharDicas(); } });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return sugestoes.classList.add('oculto');
    timer = setTimeout(async () => {
      try {
        const centro = mapa?.getCenter();
        const lista = await api.get(`/geo/buscar?q=${encodeURIComponent(q)}${centro ? `&lat=${centro.lat}&lng=${centro.lng}` : ''}`);
        limpar(sugestoes, lista.length ? lista.map((s) => el('button', { type: 'button', onclick: async () => {
          pedido[tipo] = s;
          sugestoes.classList.add('oculto');
          await estimar();
          redesenharPedido();
        } }, s.endereco)) : el('div', { class: 'pequeno mudo', style: 'padding:10px' }, 'Nada encontrado. Toque no mapa para marcar.'));
        sugestoes.classList.remove('oculto');
      } catch (err) { toast(err.message, true); }
    }, 450);
  });
  return el('div', { class: 'ponto' }, el('span', { class: `bola ${tipo}` }), el('div', { class: 'busca' }, input, sugestoes));
}

let dicas;
function redesenharDicas() {
  if (dicas) dicas.textContent = `Toque no mapa para marcar ${pedido.marcando === 'origem' ? 'onde você está' : 'o destino'}.`;
}

function redesenharPedido() {
  if (corridaAtual) return;
  const painel = $('.app-painel');
  if (!painel) return;
  const { origem, destino, estimativas } = pedido;
  rotaCamada.atualizar([
    origem && { chave: 'origem', ...origem, icone: ICONES.origem() },
    destino && { chave: 'destino', ...destino, icone: ICONES.destino() },
  ].filter(Boolean));
  if (origem && destino) enquadrar(mapa, [[origem.lat, origem.lng], [destino.lat, destino.lng]]);
  dicas = el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' });
  redesenharDicas();

  const pedir = el('button', { class: 'btn primario grande', disabled: !estimativas }, estimativas ? 'Pedir táxi' : 'Escolha origem e destino');
  pedir.addEventListener('click', () => acao(pedir, async () => {
    await api.post('/passageiro/corridas', { origem, destino, categoria: pedido.categoria, forma_pagamento: pedido.forma });
    toast('Procurando o motorista mais próximo…');
    await atualizar(painel);
  }));

  limpar(painel, el('div', { class: 'alca' }),
    el('h2', {}, 'Para onde vamos?'),
    el('div', { class: 'coluna' },
      el('div', { class: 'linha' }, el('div', { style: 'flex:1' }, campoEndereco('origem', 'Onde você está')),
        el('button', { class: 'btn pequeno', type: 'button', title: 'Usar minha localização', onclick: () => usarMinhaPosicao() }, '📍')),
      campoEndereco('destino', 'Destino'),
      dicas),
    estimativas ? el('div', { class: 'coluna', style: 'margin-top:14px' },
      el('div', { class: 'opcoes' }, estimativas.map((e) => el('button', { type: 'button', class: `opcao${pedido.categoria === e.categoria ? ' on' : ''}`,
        onclick: () => { pedido.categoria = e.categoria; redesenharPedido(); } },
      el('span', { class: 'icone' }, e.categoria === 'executivo' ? '🚘' : '🚕'),
      el('span', { class: 'meio' }, el('strong', {}, CATEGORIAS[e.categoria]), el('br'),
        el('span', { class: 'pequeno mudo' }, `${km(e.distancia_m)} · ~${minutos(e.duracao_s)}${e.bandeira === 2 ? ' · bandeira 2' : ''}`)),
      el('span', { class: 'valor num' }, `~${dinheiro(e.valor_centavos)}`)))),
      el('div', {}, el('div', { class: 'pequeno mudo', style: 'margin-bottom:6px' }, 'Pagamento'),
        el('div', { class: 'pilulas' }, Object.entries(FORMAS).map(([k, rot]) => el('button', { type: 'button', class: pedido.forma === k ? 'on' : '',
          onclick: () => { pedido.forma = k; redesenharPedido(); } }, rot)))),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'O valor final segue o taxímetro: distância percorrida e tempo de viagem.')) : null,
    el('div', { style: 'margin-top:14px' }, pedir));
}

/** Consulta a corrida atual e redesenha o painel conforme a situação. */
async function atualizar(painel) {
  const c = await api.get('/passageiro/corridas/atual');
  corridaAtual = c;
  if (c && c.passageiro && ultimoStatus && ultimoStatus !== c.status) avisarMudanca(c);
  ultimoStatus = c?.status ?? null;
  if (!c) {
    carrosPerto();
    if (painel.dataset.modo !== 'pedido') {
      // Depois de uma corrida, o próximo pedido começa sem destino.
      if (painel.dataset.modo === 'corrida') Object.assign(pedido, { destino: null, estimativas: null, marcando: 'destino' });
      painel.dataset.modo = 'pedido';
      delete painel.dataset.corrida;
      redesenharPedido();
    }
    return;
  }
  painel.dataset.modo = 'corrida';
  carrosCamada.limpar();
  const pontos = [{ chave: 'origem', lat: c.origem_lat, lng: c.origem_lng, icone: ICONES.origem() }, { chave: 'destino', lat: c.destino_lat, lng: c.destino_lng, icone: ICONES.destino() }];
  if (c.motorista?.lat !== null && c.motorista?.lat !== undefined && ['aceita', 'chegou', 'em_andamento'].includes(c.status)) {
    pontos.push({ chave: 'carro', lat: c.motorista.lat, lng: c.motorista.lng, icone: ICONES.carro() });
  }
  rotaCamada.atualizar(pontos);
  if (painel.dataset.corrida !== `${c.id}:${c.status}`) {
    painel.dataset.corrida = `${c.id}:${c.status}`;
    enquadrar(mapa, pontos.map((p) => [p.lat, p.lng]));
  }
  await desenharCorrida(painel, c);
}

function avisarMudanca(c) {
  const msg = { aceita: 'Motorista a caminho!', chegou: 'Seu motorista chegou.', em_andamento: 'Boa viagem!', finalizada: 'Você chegou ao destino.', cancelada: 'Corrida cancelada.' }[c.status];
  if (msg) toast(msg);
  try { navigator.vibrate?.(200); } catch { /* sem vibração */ }
}

let ultimosCarros = 0;
async function carrosPerto() {
  const o = pedido.origem ?? (mapa ? { lat: mapa.getCenter().lat, lng: mapa.getCenter().lng } : null);
  if (!o || Date.now() - ultimosCarros < 10_000) return;
  ultimosCarros = Date.now();
  const lista = await api.get(`/passageiro/proximos?lat=${o.lat}&lng=${o.lng}`);
  carrosCamada.atualizar(lista.map((m, i) => ({ chave: `c${i}`, lat: m.lat, lng: m.lng, icone: ICONES.carro() })));
}

function blocoMotorista(c) {
  const m = c.motorista;
  if (!m) return null;
  return el('div', { class: 'cartao plano', style: 'margin-top:12px' }, el('div', { class: 'motorista-cartao' },
    el('div', { class: 'avatar' }, iniciais(m.nome)),
    el('div', { style: 'flex:1' }, el('strong', {}, m.nome), el('div', { class: 'pequeno mudo' }, `${m.marca_modelo} · ${m.cor}`),
      el('div', { class: 'pequeno' }, m.nota_media ? `★ ${m.nota_media.toLocaleString('pt-BR')} (${m.avaliacoes})` : 'Novo motorista')),
    el('div', { class: 'coluna', style: 'align-items:flex-end' }, el('span', { class: 'placa' }, m.placa),
      m.telefone ? el('a', { class: 'btn pequeno', href: `tel:${m.telefone}` }, 'Ligar') : null)));
}

let pixCache = null;
async function desenharCorrida(painel, c) {
  const partes = [el('div', { class: 'alca' }), el('div', { class: 'linha entre' }, etiquetaStatus(c.status), el('span', { class: 'pequeno mudo' }, `Corrida #${c.id}`))];
  const trajeto = el('div', { class: 'coluna pequeno', style: 'margin-top:10px' },
    el('div', { class: 'ponto' }, el('span', { class: 'bola origem', style: 'margin-top:4px' }), el('span', {}, c.origem_endereco)),
    el('div', { class: 'ponto' }, el('span', { class: 'bola destino', style: 'margin-top:4px' }), el('span', {}, c.destino_endereco)));
  const cancelar = el('button', { class: 'btn perigo grande', style: 'margin-top:12px' }, 'Cancelar corrida');
  cancelar.addEventListener('click', async () => {
    const motivo = await perguntar('Cancelar corrida', 'Motivo (opcional)', { obrigatorio: false });
    if (motivo === null) return;
    await acao(cancelar, () => api.post(`/passageiro/corridas/${c.id}/cancelar`, { motivo }));
    await atualizar(painel);
  });

  if (c.status === 'solicitada') {
    partes.push(el('h2', { style: 'margin-top:12px' }, 'Procurando motorista…'), el('p', { class: 'mudo' }, `${CATEGORIAS[c.categoria]} · estimativa ${dinheiro(c.valor_estimado_centavos)} · ${FORMAS[c.forma_pagamento]}`), trajeto, cancelar);
  } else if (c.status === 'aceita' || c.status === 'chegou') {
    partes.push(el('h2', { style: 'margin-top:12px' }, c.status === 'chegou' ? 'Seu motorista chegou!' : `Chega em ~${minutos(c.motorista?.chegada_s ?? 60)}`),
      blocoMotorista(c), trajeto, cancelar);
  } else if (c.status === 'em_andamento') {
    partes.push(el('h2', { style: 'margin-top:12px' }, 'Em viagem'), blocoMotorista(c), trajeto,
      el('p', { class: 'pequeno mudo' }, `Percorrido: ${km(c.distancia_percorrida_m)} · estimativa ${dinheiro(c.valor_estimado_centavos)}`));
  } else if (c.status === 'finalizada') {
    partes.push(el('div', { style: 'text-align:center;margin:10px 0' }, el('div', { class: 'mudo' }, 'Valor da corrida'),
      el('div', { class: 'grande-valor num' }, dinheiro(c.valor_final_centavos)),
      el('div', { class: 'pequeno mudo' }, `${km(c.distancia_percorrida_m)} · ${minutos(c.duracao_real_s)} · ${FORMAS[c.forma_pagamento]}`)));
    if (c.pagamento_status === 'pendente') {
      if (c.forma_pagamento === 'pix') {
        if (pixCache?.id !== c.id) {
          try { pixCache = { id: c.id, ...(await api.get(`/passageiro/corridas/${c.id}/pix`)) }; } catch (err) { pixCache = { id: c.id, erro: err.message }; }
        }
        if (pixCache.erro) partes.push(el('div', { class: 'aviso' }, pixCache.erro));
        else {
          const qr = el('div', { class: 'qr' });
          qr.innerHTML = pixCache.qr_svg; // SVG gerado pelo servidor a partir do código PIX
          partes.push(el('p', { class: 'pequeno', style: 'text-align:center' }, 'Pague com o PIX abaixo e mostre o comprovante ao motorista.'), qr,
            el('div', { class: 'copiar', style: 'margin-top:10px' }, pixCache.copia_e_cola),
            el('button', { class: 'btn grande', style: 'margin-top:8px', onclick: () => navigator.clipboard?.writeText(pixCache.copia_e_cola).then(() => toast('Código PIX copiado.'), () => toast('Copie o código manualmente.', true)) }, 'Copiar código PIX'));
        }
      } else {
        partes.push(el('div', { class: 'aviso' }, `Pague ${dinheiro(c.valor_final_centavos)} ao motorista em ${FORMAS[c.forma_pagamento].toLowerCase()}.`));
      }
    } else {
      partes.push(el('div', { class: 'aviso ok' }, 'Pagamento confirmado. Obrigado!'));
    }
    if (c.nota_do_passageiro === null) partes.push(avaliacao(c, painel));
  }
  limpar(painel, partes);
}

function avaliacao(c, painel) {
  let nota = 5;
  const estrelas = el('div', { class: 'estrelas', role: 'radiogroup', 'aria-label': 'Nota' });
  const desenhar = () => limpar(estrelas, [1, 2, 3, 4, 5].map((n) => el('button', { type: 'button', class: n <= nota ? 'on' : '', 'aria-label': `${n} estrelas`,
    onclick: () => { nota = n; desenhar(); } }, '★')));
  desenhar();
  const comentario = el('input', { placeholder: 'Comentário (opcional)', maxlength: 500 });
  const enviar = el('button', { class: 'btn primario grande' }, 'Avaliar motorista');
  enviar.addEventListener('click', () => acao(enviar, async () => {
    await api.post(`/passageiro/corridas/${c.id}/avaliar`, { nota, comentario: comentario.value });
    toast('Obrigado pela avaliação!');
    await atualizar(painel);
  }));
  return el('div', { class: 'coluna', style: 'margin-top:14px;align-items:center' }, el('strong', {}, `Como foi a viagem com ${c.motorista?.nome?.split(' ')[0] ?? 'o motorista'}?`), estrelas, comentario, enviar);
}

async function historico() {
  const lista = await api.get('/passageiro/corridas').catch((err) => { toast(err.message, true); return null; });
  if (!lista) return;
  modal('Minhas corridas', (fechar) => [
    lista.length ? el('div', { class: 'coluna' }, lista.map((c) => el('div', { class: 'cartao plano' },
      el('div', { class: 'linha entre' }, etiquetaStatus(c.status), el('strong', { class: 'num' }, dinheiro(c.valor_final_centavos ?? c.valor_estimado_centavos))),
      el('div', { class: 'pequeno', style: 'margin-top:6px' }, `${c.origem_endereco} → ${c.destino_endereco}`),
      el('div', { class: 'pequeno mudo' }, `${dataHora(c.solicitada_em)} · ${FORMAS[c.forma_pagamento]}${c.motorista_nome ? ` · ${c.motorista_nome}` : ''}`))))
      : el('p', { class: 'mudo' }, 'Você ainda não fez corridas.'),
    el('button', { class: 'btn grande', style: 'margin-top:12px', onclick: () => fechar() }, 'Fechar'),
  ]);
}

configPublica().catch(() => {});
iniciar();
