import { api } from './api.js';
import { el, rotulo, dataHora, desde, placa } from './ui.js';

/*
 * Mapa do sistema: Google Maps JavaScript API.
 *
 * Há um adaptador só, usado por todas as telas que mostram mapa (Panorama, Visão geral, Rede óptica e
 * Rastreamento). Dois provedores de mapa no mesmo produto significariam dois comportamentos de zoom, dois
 * jeitos de desenhar marcador e dois lugares para corrigir cada defeito.
 *
 * Os marcadores são HTML, não imagens: desenhados por uma sobreposição própria (OverlayView), eles usam as
 * MESMAS classes de CSS do resto do sistema — a casinha do assinante no mapa é a mesma casinha da legenda.
 * Com ícone em imagem, cada cor viraria um arquivo e a legenda sairia do lugar na primeira mudança de tema.
 *
 * Quando há muitos pontos juntos, eles viram um agrupamento com a contagem. Milhares de elementos soltos no
 * documento travam o navegador, e um mapa travado não é mapa.
 */

let config = null;
let carregando = null;

async function configMapa() {
  config ??= (await api.get('/publico')).mapa;
  return config;
}

/**
 * Carrega a API do Google uma vez só.
 *
 * Falha com motivo legível em vez de deixar a tela em branco: sem chave, com chave recusada ou sem rede,
 * quem está olhando precisa saber qual dos três é — as providências são diferentes.
 */
function carregarGoogle(cfg) {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  if (carregando) return carregando;
  if (!cfg.chave) {
    return Promise.reject(new Error('Mapa não configurado: falta a chave do Google Maps (NETWORK_GOOGLE_MAPS_CHAVE).'));
  }
  carregando = new Promise((resolve, reject) => {
    const retorno = `__mapaPronto${Date.now()}`;
    const limite = setTimeout(() => reject(new Error('O Google Maps não respondeu a tempo. Verifique a conexão desta máquina.')), 20_000);
    window[retorno] = () => {
      clearTimeout(limite);
      delete window[retorno];
      resolve(window.google.maps);
    };
    // "gm_authFailure" é como o Google avisa que a chave foi recusada: sem isso, a tela só fica cinza.
    window.gm_authFailure = () => {
      clearTimeout(limite);
      reject(new Error('O Google recusou a chave deste mapa. Confira se a Maps JavaScript API está habilitada, '
        + 'se o faturamento está ativo e se o domínio desta página está na lista de referenciadores permitidos.'));
    };
    const s = document.createElement('script');
    const p = new URLSearchParams({
      key: cfg.chave,
      libraries: 'drawing',
      language: 'pt-BR',
      region: 'BR',
      loading: 'async',
      callback: retorno,
    });
    s.src = `https://maps.googleapis.com/maps/api/js?${p}`;
    s.async = true;
    s.onerror = () => { clearTimeout(limite); reject(new Error('Não foi possível carregar o Google Maps (a página não alcançou maps.googleapis.com).')); };
    document.head.append(s);
  }).catch((err) => { carregando = null; throw err; });
  return carregando;
}

/* ---------------- Marcador em HTML ---------------- */

let MarcadorHtml = null;
function definirMarcador(maps) {
  if (MarcadorHtml) return MarcadorHtml;
  MarcadorHtml = class extends maps.OverlayView {
    constructor({ lat, lng, conteudo, titulo, aoClicar, zIndex = 1 }) {
      super();
      this.posicao = new maps.LatLng(lat, lng);
      this.caixa = el('div', { class: 'marcador-mapa', title: titulo ?? null, tabindex: aoClicar ? '0' : null, role: aoClicar ? 'button' : null }, conteudo);
      this.caixa.style.zIndex = String(zIndex);
      if (aoClicar) {
        this.caixa.addEventListener('click', (e) => { e.stopPropagation(); aoClicar(); });
        this.caixa.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aoClicar(); } });
      }
    }

    onAdd() { this.getPanes().overlayMouseTarget.append(this.caixa); }

    draw() {
      const p = this.getProjection()?.fromLatLngToDivPixel(this.posicao);
      if (!p) return;
      this.caixa.style.left = `${p.x}px`;
      this.caixa.style.top = `${p.y}px`;
    }

    onRemove() { this.caixa.remove(); }
  };
  return MarcadorHtml;
}

/* ---------------- Agrupamento ---------------- */

/**
 * Agrupa por grade de pixels no zoom atual. Pontos que cairiam um por cima do outro viram uma bolha com a
 * contagem; clicar nela aproxima naquele ponto, que é o gesto que todo mundo já espera de um mapa.
 */
function agrupar(maps, mapa, itens, lado = 56) {
  const projecao = mapa.getProjection();
  if (!projecao || itens.length < 2) return itens.map((x) => ({ itens: [x] }));
  const escala = 2 ** mapa.getZoom();
  const celulas = new Map();
  for (const item of itens) {
    const ponto = projecao.fromLatLngToPoint(new maps.LatLng(item.lat, item.lng));
    const chave = `${Math.floor((ponto.x * escala) / lado)}:${Math.floor((ponto.y * escala) / lado)}`;
    const atual = celulas.get(chave);
    if (atual) atual.itens.push(item);
    else celulas.set(chave, { itens: [item] });
  }
  return [...celulas.values()];
}

const media = (itens, campo) => itens.reduce((s, x) => s + x[campo], 0) / itens.length;

/* ---------------- Mapa ---------------- */

const COR_STATUS = { operacional: '#19724e', atencao: '#d58b3a', indisponivel: '#cf5b55', nao_avaliado: '#9aa691' };
const SVG_CASA = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 3 2.5 11h2.7v9h5.3v-5.6h3v5.6h5.3v-9h2.7z"/></svg>';
const SVG_ALERTA = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 2 1 21h22zm0 6 7 12H5zm-1 4v4h2v-4zm0 5v2h2v-2z"/></svg>';
const bloco = (html, classe) => { const d = el('div', { class: classe }); d.innerHTML = html; return d; };

/**
 * Cria o mapa em `alvo`. A interface é a mesma de antes, de propósito: as telas que já usavam mapa não
 * precisaram mudar uma linha para trocar de provedor.
 *
 * Se o mapa não puder carregar, devolve um objeto com os mesmos métodos, todos sem efeito, e escreve o
 * motivo na tela — a lista que acompanha o mapa continua funcionando, que é o que importa para trabalhar.
 */
export async function criarMapa(alvo) {
  const cfg = await configMapa();
  let maps;
  try {
    maps = await carregarGoogle(cfg);
  } catch (err) {
    alvo.replaceChildren(el('div', { class: 'vazio mapa-indisponivel' },
      el('strong', {}, 'Mapa indisponível'),
      err.message,
      el('div', { class: 'fraco', style: 'margin-top:8px' }, 'Use a lista abaixo do mapa: ela não depende do mapa.')));
    const nada = () => {};
    return { mapa: null, indisponivel: true, motivo: err.message, mostrarRede: nada, mostrarFrota: nada, mostrarPanorama: () => 0,
      camadasApoio: () => ({ rede: null, chamados: null }), alternarCamada: nada, desenhar: () => ({ concluir: nada, cancelar: nada }),
      limparArea: nada, mostrarCalor: nada, trajeto: nada, focar: nada, enquadrar: nada, destruir: nada };
  }

  const Marcador = definirMarcador(maps);
  const reduzir = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('sem-efeitos');
  const mapa = new maps.Map(alvo, {
    center: { lat: cfg.centro[0], lng: cfg.centro[1] },
    zoom: cfg.zoom ?? 13,
    mapId: cfg.id_mapa || undefined,
    mapTypeControl: true,
    mapTypeControlOptions: { style: maps.MapTypeControlStyle.DROPDOWN_MENU, position: maps.ControlPosition.TOP_RIGHT },
    streetViewControl: true,
    fullscreenControl: false,
    // A rolagem da página não pode virar zoom sem querer: com Ctrl (ou dois dedos) o zoom funciona.
    gestureHandling: 'cooperative',
    clickableIcons: false,
    // Sem animação quando o sistema pede movimento reduzido.
    ...(reduzir ? { disableDefaultUI: false } : {}),
  });

  const janela = new maps.InfoWindow();
  let marcadores = [];
  let formas = [];
  let apoio = [];
  let areaDesenhada = null;
  let ouvintes = [];
  let agrupamentoAtual = null;
  let vivo = true;

  const limparMarcadores = () => { for (const m of marcadores) m.setMap(null); marcadores = []; };
  const limparFormas = () => { for (const f of formas) f.setMap(null); formas = []; };

  function enquadrar(pontos) {
    const validos = (pontos ?? []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!validos.length) return;
    if (validos.length === 1) { mapa.setCenter({ lat: validos[0][0], lng: validos[0][1] }); mapa.setZoom(16); return; }
    const limites = new maps.LatLngBounds();
    for (const [lat, lng] of validos) limites.extend({ lat, lng });
    mapa.fitBounds(limites, 48);
  }

  const abrirJanela = (marcador, conteudo) => {
    janela.setContent(conteudo);
    janela.setPosition(marcador.posicao);
    janela.open({ map: mapa });
  };

  /** Põe um marcador no mapa e guarda para a limpeza. */
  function pôr(opcoes) {
    const m = new Marcador(opcoes);
    m.setMap(mapa);
    marcadores.push(m);
    return m;
  }

  return {
    mapa,
    maps,
    indisponivel: false,

    mostrarRede({ ativos, ligacoes }, aoAbrir) {
      if (!vivo) return;
      limparMarcadores();
      limparFormas();
      for (const l of ligacoes ?? []) {
        formas.push(new maps.Polyline({
          map: mapa,
          path: [{ lat: l.origem_lat, lng: l.origem_lng }, { lat: l.destino_lat, lng: l.destino_lng }],
          strokeColor: '#6f9f7c', strokeOpacity: 0.85, strokeWeight: 4,
        }));
      }
      for (const a of ativos ?? []) {
        const m = pôr({
          lat: a.lat, lng: a.lng, titulo: `${a.codigo} · ${rotulo('statusAtivo', a.status_operacional)}`,
          conteudo: el('div', { class: `pino ${a.tipo === 'pop' ? 'pop ' : ''}${a.status_operacional}` }),
          aoClicar: () => abrirJanela(m, el('div', {}, el('strong', {}, a.codigo),
            el('div', {}, `${rotulo('tipoAtivo', a.tipo)}${a.bairro ? ` · ${a.bairro}` : ''}`),
            el('div', { style: `color:${COR_STATUS[a.status_operacional]}` }, `${rotulo('statusAtivo', a.status_operacional)} (${rotulo('origemStatus', a.status_origem)})`),
            a.portas ? el('div', {}, `${a.portas.ocupadas ?? a.portas.ocupada ?? 0}/${a.portas.total} portas ocupadas`) : null,
            aoAbrir ? el('button', { class: 'botao pequeno', style: 'margin-top:8px', onclick: () => aoAbrir(a) }, 'Abrir detalhe') : null)),
        });
        m.chave = `a${a.id}`;
      }
      enquadrar((ativos ?? []).map((a) => [a.lat, a.lng]));
    },

    mostrarFrota(veiculos, aoAbrir) {
      if (!vivo) return;
      limparMarcadores();
      limparFormas();
      const com = (veiculos ?? []).filter((v) => v.lat !== null && v.lat !== undefined);
      for (const v of com) {
        const m = pôr({
          lat: v.lat, lng: v.lng, titulo: `${placa(v.placa)} · ${rotulo('situacaoRastreio', v.situacao)}`,
          conteudo: el('div', { class: `pino veiculo ${v.situacao}` }),
          aoClicar: () => abrirJanela(m, el('div', {}, el('strong', {}, `${placa(v.placa)} · ${v.modelo}`),
            el('div', {}, rotulo('situacaoRastreio', v.situacao)),
            el('div', {}, `Posição de ${dataHora(v.observado_em)} (${desde(v.observado_em)})`),
            el('div', {}, `Ignição: ${v.ignicao}`),
            v.velocidade_kmh !== null && v.velocidade_kmh !== undefined ? el('div', {}, `${Math.round(v.velocidade_kmh)} km/h`) : null,
            aoAbrir ? el('button', { class: 'botao pequeno', style: 'margin-top:8px', onclick: () => aoAbrir(v) }, 'Abrir veículo') : null)),
        });
        m.chave = `v${v.id}`;
      }
      enquadrar(com.map((v) => [v.lat, v.lng]));
    },

    /** Casinhas dos assinantes, agrupadas enquanto o zoom não separa os pontos. */
    mostrarPanorama(pontos, { aoAbrir = null, enquadrarAgora = true } = {}) {
      if (!vivo) return 0;
      const lista = (pontos ?? []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      const desenharAgrupado = () => {
        if (!vivo) return;
        limparMarcadores();
        for (const grupo of agrupar(maps, mapa, lista)) {
          if (grupo.itens.length === 1) {
            const p = grupo.itens[0];
            pôr({
              lat: p.lat, lng: p.lng, titulo: `${p.assinante_nome} · ${rotulo('estadoConexao', p.estado)}`,
              zIndex: p.atencao ? 3 : 1,
              conteudo: bloco(SVG_CASA, `casa ${p.estado}${p.atencao ? ' atencao' : ''}`),
              aoClicar: () => aoAbrir?.(p),
            });
            continue;
          }
          // A bolha herda a cor do caso mais grave que está dentro dela: o vermelho não pode sumir no agrupamento.
          const atencao = grupo.itens.filter((x) => x.atencao).length;
          const grupoLat = media(grupo.itens, 'lat');
          const grupoLng = media(grupo.itens, 'lng');
          pôr({
            lat: grupoLat, lng: grupoLng, zIndex: atencao ? 3 : 2,
            titulo: `${grupo.itens.length} assinantes${atencao ? ` · ${atencao} precisando de atenção` : ''}`,
            conteudo: el('div', { class: `agrupamento${atencao ? ' atencao' : ''}` },
              el('strong', {}, String(grupo.itens.length)), atencao ? el('small', {}, String(atencao)) : null),
            aoClicar: () => { mapa.setCenter({ lat: grupoLat, lng: grupoLng }); mapa.setZoom(Math.min(19, mapa.getZoom() + 3)); },
          });
        }
      };
      if (agrupamentoAtual) maps.event.removeListener(agrupamentoAtual);
      agrupamentoAtual = maps.event.addListener(mapa, 'idle', desenharAgrupado);
      if (enquadrarAgora) enquadrar(lista.map((p) => [p.lat, p.lng]));
      desenharAgrupado();
      return lista.length;
    },

    /** Camadas de apoio ligáveis à parte. Devolve objetos com .setMap, para alternarCamada acender e apagar. */
    camadasApoio({ rede: ativos = [], chamados: oss = [] } = {}, { aoAbrirAtivo = null, aoAbrirChamado = null } = {}) {
      if (!vivo) return { rede: null, chamados: null };
      const criar = (itens, montar) => {
        const marcas = itens.map(montar);
        apoio.push(...marcas);
        return {
          setMap: (m) => { for (const x of marcas) x.setMap(m); },
          marcas,
        };
      };
      const rede = criar(ativos.filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lng)), (a) => {
        const m = new Marcador({
          lat: a.lat, lng: a.lng, titulo: a.codigo,
          conteudo: el('div', { class: `pino ${a.tipo === 'pop' ? 'pop ' : ''}${a.status_operacional}` }),
          aoClicar: () => abrirJanela(m, el('div', {}, el('strong', {}, a.codigo),
            el('div', {}, `${rotulo('tipoAtivo', a.tipo)}${a.bairro ? ` · ${a.bairro}` : ''}`),
            a.portas ? el('div', {}, `${a.portas.livre ?? 0} porta(s) livre(s) de ${a.portas.total}`) : el('div', { class: 'fraco' }, 'Sem portas cadastradas'),
            aoAbrirAtivo ? el('button', { class: 'botao pequeno', style: 'margin-top:8px', onclick: () => aoAbrirAtivo(a) }, 'Abrir na rede') : null)),
        });
        return m;
      });
      const chamados = criar(oss.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng)), (c) => {
        const m = new Marcador({
          lat: c.lat, lng: c.lng, titulo: `OS ${c.numero}`, zIndex: 2,
          conteudo: bloco(SVG_ALERTA, `pino chamado ${c.prioridade}`),
          aoClicar: () => abrirJanela(m, el('div', {}, el('strong', {}, `OS ${c.numero}`),
            el('div', {}, rotulo('tipoChamado', c.tipo)), el('div', {}, rotulo('statusChamado', c.status)),
            c.tecnico_nome ? el('div', {}, c.tecnico_nome) : null,
            aoAbrirChamado ? el('button', { class: 'botao pequeno', style: 'margin-top:8px', onclick: () => aoAbrirChamado(c) }, 'Abrir chamado') : null)),
        });
        return m;
      });
      return { rede, chamados };
    },

    alternarCamada(camada, ligada) { if (vivo && camada) camada.setMap(ligada ? mapa : null); },

    /** Desenho de área com a ferramenta do próprio Google: um polígono, fechado com duplo clique. */
    desenhar({ aoFechar }) {
      if (!vivo) return { concluir: () => {}, cancelar: () => {} };
      alvo.classList.add('desenhando');
      const gerente = new maps.drawing.DrawingManager({
        map: mapa,
        drawingMode: maps.drawing.OverlayType.POLYGON,
        drawingControl: false,
        polygonOptions: { fillColor: '#19724e', fillOpacity: 0.14, strokeColor: '#19724e', strokeWeight: 2, clickable: false },
      });
      const encerrar = () => { gerente.setDrawingMode(null); gerente.setMap(null); alvo.classList.remove('desenhando'); };
      const ouvinte = maps.event.addListener(gerente, 'polygoncomplete', (poligono) => {
        encerrar();
        maps.event.removeListener(ouvinte);
        areaDesenhada?.setMap(null);
        areaDesenhada = poligono;
        aoFechar(poligono.getPath().getArray().map((p) => ({ lat: p.lat(), lng: p.lng() })));
      });
      return {
        concluir: () => { /* o polígono fecha no duplo clique: a ferramenta do Google não fecha por fora */ },
        cancelar: () => { encerrar(); maps.event.removeListener(ouvinte); aoFechar(null); },
      };
    },

    limparArea() { if (vivo) { areaDesenhada?.setMap(null); areaDesenhada = null; } },

    /** Grade de calor: retângulos com a contagem real, não um borrão. */
    mostrarCalor(celulas, aoAbrirCelula) {
      if (!vivo) return;
      limparFormas();
      for (const c of celulas ?? []) {
        const r = new maps.Rectangle({
          map: mapa,
          bounds: { south: c.sul, west: c.oeste, north: c.norte, east: c.leste },
          strokeColor: '#cf5b55', strokeWeight: 1, strokeOpacity: 0.45 + c.intensidade * 0.35,
          fillColor: '#cf5b55', fillOpacity: 0.12 + c.intensidade * 0.45,
          clickable: Boolean(aoAbrirCelula),
        });
        if (aoAbrirCelula) maps.event.addListener(r, 'click', () => aoAbrirCelula(c));
        formas.push(r);
      }
      const todos = (celulas ?? []).flatMap((c) => [[c.sul, c.oeste], [c.norte, c.leste]]);
      if (todos.length) enquadrar(todos);
    },

    trajeto(pontos) {
      if (!vivo) return;
      limparFormas();
      if (!pontos?.length) return;
      const caminho = pontos.map((p) => ({ lat: p.lat, lng: p.lng }));
      formas.push(new maps.Polyline({ map: mapa, path: caminho, strokeColor: '#19724e', strokeWeight: 4, strokeOpacity: 0.9 }));
      const ponta = (p, cor, texto) => {
        const m = pôr({ lat: p.lat, lng: p.lng, titulo: texto, conteudo: el('div', { class: 'ponta-trajeto', style: `--cor:${cor}` }) });
        return m;
      };
      ponta(pontos[0], '#19724e', `Início ${dataHora(pontos[0].observado_em)}`);
      ponta(pontos.at(-1), '#15261e', `Fim ${dataHora(pontos.at(-1).observado_em)}`);
      enquadrar(caminho.map((p) => [p.lat, p.lng]));
    },

    focar(chave) {
      if (!vivo) return;
      const m = marcadores.find((x) => x.chave === chave);
      if (!m) return;
      mapa.setCenter(m.posicao);
      mapa.setZoom(Math.max(mapa.getZoom(), 17));
      m.caixa.click();
    },

    enquadrar,

    destruir() {
      vivo = false;
      try {
        if (agrupamentoAtual) maps.event.removeListener(agrupamentoAtual);
        for (const o of ouvintes) maps.event.removeListener(o);
        ouvintes = [];
        janela.close();
        limparMarcadores();
        limparFormas();
        for (const a of apoio) a.setMap(null);
        apoio = [];
        areaDesenhada?.setMap(null);
        maps.event.clearInstanceListeners(mapa);
      } catch { /* já desmontado */ }
    },
  };
}
