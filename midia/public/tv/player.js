/*
 * Player da TV (Vai Mídia).
 *
 * Roda em qualquer navegador de TV box, Fire Stick, mini PC, Chromecast com Google TV ou smart TV:
 * basta abrir este endereço em tela cheia. O aparelho mostra um código, a equipe confirma no painel
 * e a partir daí ele:
 *   1. baixa a programação e guarda os arquivos no cache do navegador;
 *   2. roda o loop em tela cheia (imagem com tempo e vídeo até o fim), já carregando o próximo item;
 *   3. anota cada exibição e envia em lote (a fila fica guardada quando a internet cai);
 *   4. avisa que está vivo de tempo em tempo e baixa a grade de novo quando ela muda.
 *
 * Sem internet, continua rodando o que está no cache — é o caso comum no comércio.
 */
'use strict';

const VERSAO = '2.2';
// Carimbo com que esta página foi carregada (vem no endereço do script; ver server/lib/carimbo-player.js).
const CARIMBO = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || ''; } catch { return ''; } })();
const API = new URL('../api/', location.href).href;
const CHAVES = { token: 'midia.tv.token', grade: 'midia.tv.grade', fila: 'midia.tv.fila', codigo: 'midia.tv.codigo', vistos: 'midia.tv.vistos' };
// Um arquivo que sumiu da programação (campanha só de manhã, por exemplo) ainda fica no cache por estes dias,
// para a TV não baixar tudo de novo a cada troca de faixa de horário.
const DIAS_NO_CACHE = 3;
const CACHE = 'midia-tv-v1';
const MAX_FILA = 400;

const $ = (id) => document.getElementById(id);
const guardar = (chave, valor) => { try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* sem armazenamento */ } };
const lido = (chave) => { try { return JSON.parse(localStorage.getItem(chave)); } catch { return null; } };
const apagar = (chave) => { try { localStorage.removeItem(chave); } catch { /* ignora */ } };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const estado = {
  // Quando a última foto da tela foi enviada (prova visual).
  ultimaFoto: 0,
  token: lido(CHAVES.token),
  programacao: lido(CHAVES.grade),
  fila: lido(CHAVES.fila) ?? [],
  indice: 0,
  camadaAtual: 'a',
  online: true,
  batidaS: 60,
  trocarPendente: false,
  parado: false,
  // Tela dividida: o comunicado fica parado na zona dele e troca no seu próprio ritmo.
  zonaIndice: 0,
  zonaTimer: null,
  logoUrl: null,
};

// Na tela dividida o comunicado fica parado: mesmo que o recado seja curto, ele permanece tempo suficiente para ler.
const MINIMO_NA_ZONA_S = 15;

// ---------------------------------------------------------------- Conversa com o servidor
/**
 * fetch com tempo limite. Internet de comércio trava sem cair: sem limite, um pedido ficava pendurado
 * por minutos e a TV parava na tela de espera. Com limite, ela desiste e segue com o que tem guardado.
 */
async function buscar(url, opcoes = {}, limiteMs = 20_000) {
  if (typeof AbortController !== 'function') return fetch(url, opcoes);
  const corte = new AbortController();
  const relogioDoCorte = setTimeout(() => corte.abort(), limiteMs);
  try { return await fetch(url, { ...opcoes, signal: corte.signal }); } finally { clearTimeout(relogioDoCorte); }
}
// Arquivo de anúncio (vídeo) pode ser grande: ganha mais tempo que uma consulta comum.
const LIMITE_ARQUIVO_MS = 180_000;
const cabecalhoToken = () => ({ Authorization: `Bearer ${estado.token}` });

async function chamar(caminho, { metodo = 'GET', corpo, comToken = true } = {}) {
  const resp = await buscar(API + caminho, {
    method: metodo,
    headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(comToken && estado.token ? { Authorization: `Bearer ${estado.token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (resp.status === 401 && comToken) {
    // Aparelho despareado no painel: volta para a tela de código.
    apagar(CHAVES.token);
    apagar(CHAVES.grade);
    estado.token = null;
    estado.programacao = null;
    throw new Error('despareado');
  }
  // Tela desativada (ou ponto encerrado) no painel: para de exibir até ser reativada.
  if (resp.status === 403 && comToken) { estado.desativada = true; throw new Error('desativada'); }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (comToken) estado.desativada = false;
  acertarRelogio(resp);
  return resp.status === 204 ? null : resp.json();
}

// ---------------------------------------------------------------- Hora certa
// O relógio do aparelho não é confiável: TV box sai de fábrica com a hora errada ou em outro fuso.
// A TV usa a hora do servidor (o cabeçalho Date de cada resposta) e o fuso da rede.
function acertarRelogio(resp) {
  const data = Date.parse(resp.headers.get('date') ?? '');
  if (Number.isFinite(data)) estado.desvioRelogio = data - Date.now();
}
const agoraCerto = () => Date.now() + (estado.desvioRelogio ?? 0);
const fusoDaRede = () => estado.programacao?.fuso || 'America/Sao_Paulo';
function formatarHora(opcoes) {
  try { return new Date(agoraCerto()).toLocaleString('pt-BR', { ...opcoes, timeZone: fusoDaRede() }); } catch { return new Date(agoraCerto()).toLocaleString('pt-BR', opcoes); }
}

// Sem internet, a TV segue com o que está guardado e não avisa na tela: o espaço é do anunciante.
// Quem precisa saber é a equipe — o painel mostra a TV sem contato e o Diagnóstico acusa.
function marcarConexao(ok) {
  estado.online = ok;
}

// ---------------------------------------------------------------- Pareamento
async function parear() {
  mostrarEspera('Preparando a tela…', 'Falando com o servidor.');
  let guardado = lido(CHAVES.codigo);
  while (!estado.token) {
    try {
      // Pela hora do servidor: com o relógio do aparelho errado, o código "vencia" na hora e trocava sem parar.
      if (!guardado || Date.parse(guardado.expira_em) < agoraCerto()) {
        const r = await chamar('player/registrar', {
          metodo: 'POST',
          comToken: false,
          corpo: { aparelho: navigator.userAgent.slice(0, 160), largura: screen.width, altura: screen.height, versao: VERSAO },
        });
        guardado = r;
        guardar(CHAVES.codigo, r);
          if (r.plataforma) marcarPlataforma(r.plataforma, r.slogan);
      }
      marcarConexao(true);
      mostrarEspera('Vamos ligar esta TV', 'Esta tela ainda não está vinculada a um ponto.', guardado.codigo);
      const p = await chamar(`player/pareamento?codigo=${encodeURIComponent(guardado.codigo)}`, { comToken: false });
      if (p.expirado) { guardado = null; continue; }
      if (p.pareado) {
        estado.token = p.token;
        guardar(CHAVES.token, p.token);
        apagar(CHAVES.codigo);
        mostrarEspera('Pronto!', `Esta TV agora é "${p.tela.nome}". Baixando a programação…`);
        return;
      }
    } catch (err) {
      marcarConexao(false);
      mostrarEspera('Sem conexão', 'Confira a internet do local. A tela tenta de novo sozinha.', guardado?.codigo);
    }
    await dormir(5000);
  }
}

// ---------------------------------------------------------------- Programação e cache dos arquivos
async function baixarProgramacao() {
  const p = await chamar('player/programacao');
  estado.programacao = p;
  estado.batidaS = Math.max(15, Number(p.batida_s) || 60);
  marcarPlataforma(p.plataforma, p.slogan);
  guardar(CHAVES.grade, p);
  marcarConexao(true);
  await carregarLogo();
  await carregarFotosComunicados();
  rodarZonaComunicados();
  guardarArquivos(p.grade.itens).catch(() => {});
  return p;
}

const enderecoDoItem = (item) => new URL(`player/${item.url}`, API).href;

/** Guarda cada arquivo no cache do navegador e apaga só o que não aparece na programação há dias. */
async function guardarArquivos(itens) {
  if (!('caches' in window)) return;
  const cache = await caches.open(CACHE);
  const vistos = lido(CHAVES.vistos) ?? {};
  const agora = Date.now();
  // Comunicados e a tela da marca não têm arquivo: a própria TV desenha.
  for (const item of itens.filter((i) => i.url)) {
    const url = enderecoDoItem(item);
    vistos[url] = agora;
    if (await cache.match(url)) continue;
    try {
      const resp = await buscar(url, { headers: cabecalhoToken() }, LIMITE_ARQUIVO_MS);
      if (resp.ok) await cache.put(url, resp);
    } catch { /* tenta no próximo ciclo */ }
  }
  const corte = agora - DIAS_NO_CACHE * 86_400_000;
  for (const req of await cache.keys()) {
    if (!vistos[req.url] || vistos[req.url] < corte) {
      await cache.delete(req);
      delete vistos[req.url];
    }
  }
  for (const [url, quando] of Object.entries(vistos)) if (quando < corte) delete vistos[url];
  guardar(CHAVES.vistos, vistos);
}

/** Endereço local do arquivo: do cache, se já estiver guardado; direto do servidor, se não. */
async function origemDoItem(item) {
  const url = enderecoDoItem(item);
  if ('caches' in window) {
    try {
      const achado = await (await caches.open(CACHE)).match(url);
      if (achado) return { src: URL.createObjectURL(await achado.blob()), temporario: true };
    } catch { /* cache indisponível */ }
  }
  // Sem cache: busca com o token e transforma em blob (a tag <img>/<video> não manda cabeçalho).
  const resp = await buscar(url, { headers: cabecalhoToken() }, LIMITE_ARQUIVO_MS);
  if (!resp.ok) throw new Error(`arquivo ${item.midia_id}: HTTP ${resp.status}`);
  return { src: URL.createObjectURL(await resp.blob()), temporario: true };
}

// ---------------------------------------------------------------- Prova de exibição
function anotarExibicao(item, inicio, segundos) {
  estado.fila.push({
    midia_id: item.midia_id ?? null,
    comunicado_id: item.comunicado_id ?? null,
    // A tela da própria rede também é anotada: é tempo de tela não vendido, e entra na conta dos impactos.
    tipo: item.formato === 'marca' ? 'marca' : undefined,
    campanha_id: item.campanha_id,
    // Hora do servidor, não a do aparelho: a prova de exibição sai certa mesmo com a TV desacertada.
    exibida_em: new Date(inicio + (estado.desvioRelogio ?? 0)).toISOString(),
    duracao_s: Math.round(segundos),
  });
  if (estado.fila.length > MAX_FILA) estado.fila = estado.fila.slice(-MAX_FILA);
  guardar(CHAVES.fila, estado.fila);
}

async function enviarExibicoes() {
  if (!estado.fila.length || !estado.token) return;
  const lote = estado.fila.slice(0, 200);
  try {
    await chamar('player/exibicoes', { metodo: 'POST', corpo: { exibicoes: lote } });
    estado.fila = estado.fila.slice(lote.length);
    guardar(CHAVES.fila, estado.fila);
    marcarConexao(true);
  } catch (err) {
    if (err.message !== 'despareado') marcarConexao(false);
  }
}

// ---------------------------------------------------------------- Batida (a TV diz que está viva)
async function bater(erro) {
  if (!estado.token) return;
  const item = itemAtual();
  try {
    const r = await chamar('player/batida', {
      metodo: 'POST',
      corpo: { grade_versao: estado.programacao?.grade?.versao ?? null, versao: VERSAO, item_atual: item ? item.nome : null, erro: erro ?? null },
    });
    marcarConexao(true);
    // O sistema foi atualizado (os arquivos do player mudaram): recarrega para pegar a versão nova.
    if (r.player_arquivos && CARIMBO && r.player_arquivos !== CARIMBO) {
      await enviarExibicoes();
      estado.parado = true;
      location.reload();
      return;
    }
    if (r.recarregar) {
      estado.trocarPendente = true;
      // A lista de anúncios só troca na virada do loop (para não cortar ninguém no meio), mas o que é
      // do rodapé — aviso, legenda, relógio — entra na hora: um aviso não pode esperar o loop acabar.
      chamar('player/programacao').then((p) => {
        if (estado.programacao && p?.tela) { estado.programacao.tela = p.tela; desenharFaixa(); }
      }).catch(() => {});
    }
    if (r.comandos?.length) await obedecer(r.comandos);
  } catch (err) {
    if (err.message !== 'despareado' && err.message !== 'desativada') marcarConexao(false);
  }
}

/**
 * Comandos vindos do painel. É assim que uma versão nova do player entra nas telas já instaladas,
 * sem ninguém ir até o prédio.
 */
async function obedecer(comandos) {
  if (comandos.includes('limpar_cache')) {
    try {
      if ('caches' in window) await caches.delete(CACHE);
      apagar(CHAVES.vistos);
    } catch { /* segue para o recarregamento mesmo assim */ }
  }
  if (comandos.some((c) => ['recarregar', 'limpar_cache', 'reiniciar'].includes(c))) {
    // Manda a fila de exibições antes de recarregar, para nada se perder.
    await enviarExibicoes();
    if (comandos.includes('reiniciar')) {
      try { await chamar('player/reinicio', { metodo: 'POST', corpo: { motivo: 'Reinício pedido pelo painel' } }); } catch { /* segue */ }
    }
    estado.parado = true;
    location.reload();
  }
}

// ---------------------------------------------------------------- Exibição
const itens = () => estado.programacao?.grade?.itens ?? [];
const itemAtual = () => itens()[estado.indice % Math.max(1, itens().length)] ?? null;

function trocarCamada() {
  const sai = $(`camada-${estado.camadaAtual}`);
  estado.camadaAtual = estado.camadaAtual === 'a' ? 'b' : 'a';
  const entra = $(`camada-${estado.camadaAtual}`);
  entra.classList.add('no-ar');
  sai.classList.remove('no-ar');
  setTimeout(() => {
    for (const m of sai.querySelectorAll('video')) { m.pause(); m.removeAttribute('src'); m.load(); }
    for (const e of sai.querySelectorAll('[data-blob]')) URL.revokeObjectURL(e.dataset.blob);
    sai.replaceChildren();
  }, 600);
  return entra;
}

const TIPOS_COMUNICADO = { aviso: 'Aviso', manutencao: 'Manutenção', assembleia: 'Assembleia', entrega: 'Entrega', urgente: 'Urgente' };

/**
 * Comunicado do ponto: a própria TV desenha (não existe arquivo para baixar).
 * Leva a logo da administradora no alto e a assinatura embaixo, como nas telas de condomínio.
 */
function montarComunicado(item) {
  const ponto = estado.programacao?.grade?.ponto ?? {};
  const caixa = document.createElement('div');
  // Sempre com imagem cobrindo o espaço todo (a foto do ponto ou a ilustração do tipo), e o texto por cima.
  caixa.className = `comunicado com-visual ${item.tipo ?? 'aviso'}`;
  caixa.append(visualDoComunicado(item));

  if (estado.logoUrl || ponto.administradora) {
    const marca = document.createElement('div');
    marca.className = 'marca-adm';
    if (estado.logoUrl) {
      const img = document.createElement('img');
      img.src = estado.logoUrl;
      img.alt = '';
      marca.append(img);
    }
    if (ponto.administradora) {
      const nome = document.createElement('span');
      nome.textContent = ponto.administradora;
      marca.append(nome);
    }
    caixa.append(marca);
  }

  const topo = document.createElement('div');
  topo.className = 'cabeca';
  const selo = document.createElement('span');
  selo.className = 'selo-tipo';
  selo.textContent = TIPOS_COMUNICADO[item.tipo] ?? 'Aviso';
  const onde = document.createElement('span');
  onde.className = 'onde';
  onde.textContent = item.local ?? ponto.nome ?? '';
  topo.append(selo, onde);

  const titulo = document.createElement('h1');
  titulo.textContent = item.titulo ?? '';
  caixa.append(topo, titulo);

  // Parágrafos separados por linha em branco, como o responsável escreveu.
  for (const paragrafo of String(item.texto ?? '').split(/\n{2,}/)) {
    const p = document.createElement('p');
    p.textContent = paragrafo.trim();
    if (p.textContent) caixa.append(p);
  }

  const data = document.createElement('div');
  data.className = 'quando';
  // "sábado, 21 de novembro" com a primeira letra maiúscula (capitalize do CSS estragaria o "de").
  const hoje = formatarHora({ weekday: 'long', day: '2-digit', month: 'long' });
  data.textContent = hoje.charAt(0).toUpperCase() + hoje.slice(1);
  caixa.append(data);

  const assinatura = assinaturaDoPonto();
  if (assinatura) caixa.append(assinatura);
  return caixa;
}

/** "Atenciosamente, Administração / Síndico — Edifício X" (o mesmo pé nos quadros do condomínio). */
function assinaturaDoPonto() {
  const ponto = estado.programacao?.grade?.ponto ?? {};
  if (!ponto.assinatura) return null;
  const assinatura = document.createElement('div');
  assinatura.className = 'assinatura';
  const quem = document.createElement('strong');
  quem.textContent = ponto.assinatura;
  assinatura.append('Atenciosamente,', quem);
  return assinatura;
}

/**
 * Imagem pequena do ponto (logo, foto do comunicado): tenta a internet e guarda no cache da TV; sem
 * internet, usa a guardada. Assim o comunicado sai com a foto mesmo se a TV for ligada fora do ar.
 */
async function imagemDoPonto(url) {
  const cache = 'caches' in window ? await caches.open(CACHE).catch(() => null) : null;
  try {
    const resp = await buscar(url, { headers: cabecalhoToken() }, 30_000);
    if (resp.ok) {
      if (cache) await cache.put(url, resp.clone()).catch(() => {});
      marcarVisto(url);
      return URL.createObjectURL(await resp.blob());
    }
    // O servidor respondeu que não existe mais: não adianta mostrar a guardada.
    if (cache) await cache.delete(url).catch(() => {});
    return null;
  } catch {
    const achado = cache ? await cache.match(url).catch(() => null) : null;
    if (achado) marcarVisto(url);
    return achado ? URL.createObjectURL(await achado.blob()) : null;
  }
}
// A limpeza do cache apaga o que não é "visto" há dias: estas imagens também contam como vistas.
function marcarVisto(url) {
  const vistos = lido(CHAVES.vistos) ?? {};
  vistos[url] = Date.now();
  guardar(CHAVES.vistos, vistos);
}

/** Baixa a logo da administradora uma vez e guarda como blob (a tag <img> não manda cabeçalho). */
/** Fotos dos comunicados (as que o ponto anexou): baixadas uma vez e guardadas enquanto a TV estiver ligada. */
async function carregarFotosComunicados() {
  estado.fotosComunicado ??= {};
  const g = estado.programacao?.grade;
  const ids = new Set([...(g?.itens ?? []), ...(g?.comunicados ?? [])].filter((c) => c.imagem && c.comunicado_id).map((c) => c.comunicado_id));
  await Promise.all([...ids].filter((id) => !estado.fotosComunicado[id]).map(async (id) => {
    // Sem a foto, entra a ilustração do tipo.
    const foto = await imagemDoPonto(`${API}player/comunicados/${id}/imagem`).catch(() => null);
    if (foto) estado.fotosComunicado[id] = foto;
  }));
}

// Ilustração de cada tipo de recado, para quando o ponto não anexa foto: o espaço nunca fica só com texto.
const ILUSTRACOES = {
  aviso: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 9a3 3 0 0 1 0 6M18 6a7 7 0 0 1 0 12',
  manutencao: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  assembleia: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M17 11a2.5 2.5 0 1 0 0-5M21 20a5 5 0 0 0-4-4.9',
  entrega: 'M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10',
  urgente: 'M12 3l10 18H2zM12 10v5M12 18h.01',
};

/** A imagem que cobre o espaço do comunicado: a foto do ponto ou, sem ela, a ilustração do tipo. */
function visualDoComunicado(item) {
  const visual = document.createElement('div');
  const foto = item.imagem && estado.fotosComunicado?.[item.comunicado_id];
  if (foto) {
    visual.className = 'visual foto';
    const img = document.createElement('img');
    img.src = foto;
    img.alt = '';
    visual.append(img);
    return visual;
  }
  visual.className = `visual ilustracao ${item.tipo ?? 'aviso'}`;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const caminho = document.createElementNS(ns, 'path');
  caminho.setAttribute('d', ILUSTRACOES[item.tipo] ?? ILUSTRACOES.aviso);
  svg.append(caminho);
  visual.append(svg);
  return visual;
}

async function carregarLogo() {
  if (!estado.programacao?.grade?.ponto?.logo || estado.logoUrl) return;
  // Sem logo, o comunicado sai só com o nome.
  estado.logoUrl = await imagemDoPonto(`${API}player/logo`).catch(() => null);
}

/**
 * Zona do comunicado (tela dividida): mostra um recado de cada vez, no ritmo dele, sem mexer no carrossel.
 * Cada troca também entra na prova de exibição.
 */
function rodarZonaComunicados() {
  clearTimeout(estado.zonaTimer);
  const zona = $('zona-comunicado');
  const g = estado.programacao?.grade;
  // Além dos comunicados, a zona do ponto mostra a agenda do lugar e o clima do dia:
  // é o que as pessoas olham por vontade própria — e o que valoriza o anúncio ao lado.
  const extras = [
    ...(g?.agenda?.length ? [{ quadro: 'agenda', duracao_s: MINIMO_NA_ZONA_S }] : []),
    ...(g?.clima ? [{ quadro: 'clima', duracao_s: MINIMO_NA_ZONA_S }] : []),
  ];
  const lista = [...(g?.comunicados ?? []), ...extras];
  const dividida = g?.layout === 'dividida';
  document.body.classList.toggle('dividida', dividida && lista.length > 0);
  zona.hidden = !(dividida && lista.length);
  if (zona.hidden) return;

  const mostrar = () => {
    const item = lista[estado.zonaIndice % lista.length];
    const peca = item.quadro === 'agenda' ? montarAgenda(g.agenda) : (item.quadro === 'clima' ? montarClima(g.clima) : null);
    zona.replaceChildren(peca ?? montarComunicado({ ...item, local: g.ponto?.nome }));
    const inicio = Date.now();
    const segundos = Math.max(MINIMO_NA_ZONA_S, item.duracao_s || MINIMO_NA_ZONA_S);
    estado.zonaTimer = setTimeout(() => {
      // Agenda e clima não são comunicado nem publicidade: entram na prova como tempo do próprio ponto.
      anotarExibicao({ comunicado_id: item.comunicado_id ?? null, campanha_id: null }, inicio, segundos);
      estado.zonaIndice = (estado.zonaIndice + 1) % lista.length;
      mostrar();
    }, segundos * 1000);
  };
  mostrar();
}

const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** Agenda do ponto: o que vem pela frente, em ordem. */
function montarAgenda(agenda) {
  const ponto = estado.programacao?.grade?.ponto ?? {};
  const caixa = document.createElement('div');
  caixa.className = 'comunicado quadro-agenda';
  const topo = document.createElement('div');
  topo.className = 'cabeca';
  const selo = document.createElement('span');
  selo.className = 'selo-tipo';
  selo.textContent = 'Agenda';
  const onde = document.createElement('span');
  onde.className = 'onde';
  onde.textContent = ponto.nome ?? '';
  topo.append(selo, onde);
  const titulo = document.createElement('h1');
  titulo.textContent = 'O que vem por aí';
  caixa.append(topo, titulo);

  const itens = document.createElement('ul');
  itens.className = 'agenda';
  for (const a of agenda) {
    const data = new Date(`${a.em}T12:00:00`);
    const li = document.createElement('li');
    const quando = document.createElement('span');
    quando.className = 'quando';
    quando.textContent = `${String(data.getDate()).padStart(2, '0')}/${String(data.getMonth() + 1).padStart(2, '0')}`
      + ` ${DIAS_CURTOS[data.getDay()]}${a.hora ? ` · ${a.hora}` : ''}`;
    const oque = document.createElement('span');
    oque.textContent = a.titulo;
    li.append(quando, oque);
    itens.append(li);
  }
  caixa.append(itens);
  const pe = assinaturaDoPonto();
  if (pe) caixa.append(pe);
  return caixa;
}

/** Clima do dia, com a máxima e a mínima. */
function montarClima(clima) {
  const ponto = estado.programacao?.grade?.ponto ?? {};
  const caixa = document.createElement('div');
  caixa.className = 'comunicado quadro-clima';
  const topo = document.createElement('div');
  topo.className = 'cabeca';
  const selo = document.createElement('span');
  selo.className = 'selo-tipo';
  selo.textContent = 'Hoje';
  const onde = document.createElement('span');
  onde.className = 'onde';
  onde.textContent = clima.cidade ?? ponto.nome ?? '';
  topo.append(selo, onde);

  const grau = document.createElement('div');
  grau.className = 'grau';
  grau.textContent = `${clima.temperatura}°`;
  const desc = document.createElement('h1');
  desc.textContent = clima.descricao;
  caixa.append(topo, grau, desc);
  if (clima.maxima !== null && clima.minima !== null) {
    const faixa = document.createElement('p');
    faixa.textContent = `Máxima de ${clima.maxima}° e mínima de ${clima.minima}°.`;
    caixa.append(faixa);
  }
  return caixa;
}

/**
 * Tela da própria rede: logo, frase e o símbolo grande sangrando no canto. É o que aparece numa tela que
 * ainda não tem campanha e o que completa o loop quando sobra espaço — sem ninguém precisar subir arte.
 */
function montarMarca() {
  const nome = estado.programacao?.plataforma ?? 'Vai Mídia';
  const frase = estado.programacao?.slogan ?? '';
  const cartao = document.createElement('div');
  cartao.className = 'cartao-marca';

  const lockup = document.createElement('div');
  lockup.className = 'lockup';
  lockup.append(simboloSvg('v'));
  const texto = document.createElement('span');
  texto.className = 'nome';
  // Duas palavras ficam empilhadas, como no logotipo; mais do que isso, em uma linha só.
  const palavras = String(nome).trim().split(/\s+/);
  for (const palavra of (palavras.length === 2 ? palavras : [palavras.join(' ')])) {
    const linha = document.createElement('em');
    linha.textContent = palavra.toUpperCase();
    texto.append(linha);
  }
  lockup.append(texto);
  cartao.append(lockup);

  if (frase) {
    const p = document.createElement('p');
    p.className = 'frase';
    p.textContent = frase;
    cartao.append(p);
  }
  cartao.append(simboloSvg('v-gigante'));
  return cartao;
}

/** O símbolo da marca em SVG (o mesmo desenho do painel e do favicon). */
function simboloSvg(classe) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 138 111');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', classe);
  const caminho = document.createElementNS(ns, 'path');
  caminho.setAttribute('fill', 'currentColor');
  caminho.setAttribute('d', 'M57 0 H101 L138 51 L94 111 H57 L0 18 H39 L76 83 L94 51 Z');
  svg.append(caminho);
  return svg;
}

/** Prepara o elemento do item na camada que está fora do ar e devolve uma função que o põe no ar. */
async function prepararItem(item) {
  const alvoCamada = $(`camada-${estado.camadaAtual === 'a' ? 'b' : 'a'}`);
  if (item.formato === 'comunicado' || item.formato === 'marca') {
    const cartao = item.formato === 'marca' ? montarMarca() : montarComunicado(item);
    alvoCamada.replaceChildren(cartao);
    return cartao;
  }
  const origem = await origemDoItem(item);
  const alvo = alvoCamada;
  let elemento;
  if (item.tipo === 'video') {
    elemento = document.createElement('video');
    Object.assign(elemento, { src: origem.src, muted: !estado.programacao.tela.som, autoplay: false, loop: false, playsInline: true, preload: 'auto' });
    elemento.setAttribute('playsinline', '');
    if (!estado.programacao.tela.som) elemento.setAttribute('muted', '');
  } else {
    elemento = document.createElement('img');
    elemento.src = origem.src;
    elemento.alt = '';
  }
  if (origem.temporario) elemento.dataset.blob = origem.src;
  // Na tela dividida a peça cobre a metade inteira (object-fit: cover no CSS), sem barras nem fundo desfocado.
  alvo.replaceChildren(elemento);
  // Espera o arquivo estar pronto (com teto, para não travar o loop num arquivo ruim).
  await Promise.race([
    new Promise((pronto, falhou) => {
      if (item.tipo === 'video') {
        elemento.addEventListener('loadeddata', pronto, { once: true });
        elemento.addEventListener('error', () => falhou(new Error(`vídeo ${item.midia_id} não abriu`)), { once: true });
      } else if (elemento.complete) {
        pronto();
      } else {
        elemento.addEventListener('load', pronto, { once: true });
        elemento.addEventListener('error', () => falhou(new Error(`imagem ${item.midia_id} não abriu`)), { once: true });
      }
    }),
    dormir(20_000).then(() => { throw new Error(`${item.tipo === 'video' ? 'vídeo' : 'imagem'} ${item.midia_id} demorou demais para abrir`); }),
  ]);
  return elemento;
}

/** Roda um item: imagem pelo tempo contratado, vídeo até o fim (com teto de segurança). */
async function exibir(item) {
  const elemento = await prepararItem(item);
  trocarCamada();
  const inicio = Date.now();
  if (item.formato === 'midia' && item.tipo === 'video') {
    try {
      await elemento.play();
    } catch {
      // Navegador de TV costuma barrar vídeo COM som sem alguém ter tocado na tela: toca sem som.
      elemento.muted = true;
      elemento.setAttribute('muted', '');
      try { await elemento.play(); } catch { throw new Error(`vídeo ${item.midia_id} não tocou`); }
    }
    await Promise.race([
      new Promise((fim) => elemento.addEventListener('ended', fim, { once: true })),
      dormir((item.duracao_s + 5) * 1000),
    ]);
  } else {
    await dormir(item.duracao_s * 1000);
  }
  anotarExibicao(item, inicio, Math.min(item.duracao_s + 5, (Date.now() - inicio) / 1000));
  if (item.formato === 'midia') enviarFoto(elemento, item);
}

/**
 * Prova visual: de tempos em tempos a TV desenha num canvas o que está exibindo e manda ao servidor.
 * A equipe vê a última foto de cada tela no painel — é a diferença entre "a TV respondeu" e
 * "a TV está mesmo mostrando o anúncio certo". Só o conteúdo do próprio player é capturado;
 * não existe câmera nem leitura do que está em volta.
 */
async function enviarFoto(elemento, item) {
  const minutos = Number(estado.programacao?.foto_minutos ?? 0);
  if (!minutos || !elemento) return;
  if (estado.ultimaFoto && Date.now() - estado.ultimaFoto < minutos * 60_000) return;
  const ehVideo = elemento.tagName === 'VIDEO';
  const largura = ehVideo ? elemento.videoWidth : elemento.naturalWidth;
  const altura = ehVideo ? elemento.videoHeight : elemento.naturalHeight;
  if (!largura || !altura) return;
  estado.ultimaFoto = Date.now();
  try {
    const escala = Math.min(1, 640 / largura);
    const tela = document.createElement('canvas');
    tela.width = Math.round(largura * escala);
    tela.height = Math.round(altura * escala);
    tela.getContext('2d').drawImage(elemento, 0, 0, tela.width, tela.height);
    const foto = await new Promise((pronto) => tela.toBlob(pronto, 'image/jpeg', 0.6));
    if (!foto) return;
    await buscar(`${API}player/foto?item=${encodeURIComponent(item.nome ?? item.midia_id ?? '')}`, {
      method: 'POST',
      headers: { ...cabecalhoToken(), 'Content-Type': 'image/jpeg' },
      body: foto,
    }, 30_000);
  } catch { /* a foto é um extra: nunca pode atrapalhar a exibição */ }
}

function mostrarEspera(titulo, texto, codigo) {
  $('espera').hidden = false;
  $('espera-titulo').textContent = titulo;
  $('espera-texto').textContent = texto ?? '';
  $('codigo').hidden = !codigo;
  $('espera-ajuda').hidden = !codigo;
  if (codigo) $('codigo').textContent = codigo;
}
const esconderEspera = () => { $('espera').hidden = true; };

/** Faixa de baixo: aviso do ponto (prioridade), legenda fixa, clima e relógio. */
function desenharFaixa() {
  const t = estado.programacao?.tela;
  const clima = estado.programacao?.grade?.clima ?? null;
  const texto = t?.aviso || t?.legenda || '';
  const relogio = Boolean(t?.relogio);
  // O rodapé leva a marca da rede: aparece sempre que a tela tiver relógio, clima ou algum recado.
  const mostrar = Boolean(texto || relogio || clima);
  $('faixa').hidden = !mostrar;
  document.body.classList.toggle('com-faixa', mostrar);
  pintarAvisos(texto);
  $('clima').hidden = !clima;
  if (clima) {
    const estreita = t?.orientacao === 'retrato';
    $('clima').textContent = estreita ? `${clima.temperatura}°` : `${clima.temperatura}° · ${clima.descricao}`;
  }
  $('relogio').hidden = !relogio;
}

/**
 * Avisos do rodapé. Um aviso curto fica parado; com mais de um (ou um que não cabe), eles passam
 * correndo da direita para a esquerda, um atrás do outro, sem parar — como um letreiro.
 */
function pintarAvisos(texto) {
  const caixa = $('faixa-texto');
  // Chamado a cada anúncio: só mexe quando o texto muda, para o letreiro não recomeçar toda hora.
  if (caixa.dataset.texto === texto) return;
  caixa.dataset.texto = texto;
  const avisos = String(texto).split('\n').map((a) => a.trim()).filter(Boolean);
  caixa.classList.remove('trem');
  if (!avisos.length) { caixa.replaceChildren(); return; }
  const fila = document.createElement('span');
  fila.className = 'fila';
  avisos.forEach((a, i) => {
    if (i) { const ponto = document.createElement('i'); ponto.textContent = '•'; fila.append(ponto); }
    const item = document.createElement('span');
    item.textContent = a;
    fila.append(item);
  });
  caixa.replaceChildren(fila);
  // Mede depois de desenhar: se há mais de um aviso ou o texto passa da largura, vira letreiro.
  requestAnimationFrame(() => {
    const largura = caixa.clientWidth;
    const conteudo = fila.scrollWidth;
    if (avisos.length < 2 && conteudo <= largura) return;
    caixa.classList.add('trem');
    fila.style.setProperty('--entrada', `${largura}px`);
    // Velocidade constante (um sétimo da largura da tela por segundo), qualquer que seja o tamanho do texto.
    fila.style.animationDuration = `${Math.max(8, (largura + conteudo) / (window.innerWidth / 7))}s`;
  });
}

function desenharInfo() {
  const p = estado.programacao;
  const g = p?.grade;
  $('info').innerHTML = '';
  const linhas = [
    ['TV', p?.tela?.nome ?? '—'],
    ['Ponto', p?.tela?.local ?? '—'],
    ['Programação', g ? `${g.itens.length} itens · ${g.duracao_s}s · ${g.ocupacao}% vendido` : '—'],
    ['Layout', g ? (g.layout === 'dividida' ? `dividida · ${g.comunicados.length} comunicado(s) na zona` : 'tela cheia') : '—'],
    ['Versão da grade', g?.versao ?? '—'],
    ['No ar', itemAtual()?.nome ?? '—'],
    ['Fila para enviar', String(estado.fila.length)],
    ['Conexão', estado.online ? 'ok' : 'sem internet'],
    ['Player', VERSAO],
  ];
  for (const [rotulo, valor] of linhas) {
    const l = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = `${rotulo}: `;
    l.append(b, document.createTextNode(valor));
    $('info').append(l);
  }
}

// ---------------------------------------------------------------- Laço principal
async function rodar() {
  while (!estado.parado) {
    if (!estado.token) {
      await parear();
      continue;
    }
    if (estado.desativada) {
      mostrarEspera('Tela desativada', 'Esta TV foi desativada no painel. Ela volta a exibir sozinha quando for reativada.');
      await dormir(60_000);
      try { await baixarProgramacao(); } catch { /* continua desativada ou sem internet */ }
      continue;
    }
    if (!estado.programacao) {
      try {
        await baixarProgramacao();
        bater(); // avisa o painel na hora que esta TV entrou no ar
      } catch (err) {
        if (err.message === 'despareado' || err.message === 'desativada') continue;
        marcarConexao(false);
        mostrarEspera('Sem conexão', 'A tela volta a exibir assim que a internet voltar.');
        await dormir(10_000);
        continue;
      }
    }
    desenharFaixa();
    if (!itens().length) {
      mostrarEspera(estado.programacao.plataforma ?? 'Sem programação', 'Esta tela está no ar e aguardando conteúdo.');
      await dormir(30_000);
      estado.trocarPendente = true;
    } else {
      esconderEspera();
      const item = itemAtual();
      try {
        await exibir(item);
      } catch (err) {
        bater(String(err.message).slice(0, 200));
        await dormir(1500);
      }
      estado.indice = (estado.indice + 1) % itens().length;
    }
    // Troca a programação na virada do loop, para não cortar um anúncio no meio.
    if (estado.trocarPendente && estado.indice === 0) {
      estado.trocarPendente = false;
      try {
        await baixarProgramacao();
        estado.indice = 0;
        desenharFaixa();
      } catch { /* segue com a programação atual */ }
    }
  }
}

// ---------------------------------------------------------------- Rotinas de fundo
function relogio() {
  const marcar = () => { $('relogio').textContent = formatarHora({ hour: '2-digit', minute: '2-digit' }); };
  marcar();
  setInterval(marcar, 15_000);
}

async function manterTelaAcesa() {
  try {
    if ('wakeLock' in navigator) {
      let trava = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') { try { trava = await navigator.wakeLock.request('screen'); } catch { /* sem permissão */ } }
      });
    }
  } catch { /* aparelho sem a função: configure o descanso de tela no próprio aparelho */ }
}

// ---------------------------------------------------------------- Tela cheia
// O navegador só deixa uma página ocupar a tela inteira depois de um gesto de quem está na frente
// dela — é regra de segurança, não dá para pular por código. Então o player tenta sozinho ao abrir
// (navegador de quiosque e app instalado deixam) e, se não deu, transforma QUALQUER tecla do
// controle ou toque na tela em "tela cheia". Basta apertar OK uma vez.
const emTelaCheia = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);

// Um pedido só, sem opções — como na primeira versão, que maximizou com dois cliques na TV Samsung.
// Cuidado: navegador antigo devolve "undefined" em requestFullscreen (não uma promessa); encadear o
// pedido do WebKit depois dele (com ??) fazia um segundo pedido que cancelava o primeiro.
// Tela cheia exatamente como no teste que funcionou na TV Samsung (tv/teste-tela-cheia.html, botão 1):
// um pedido só, requestFullscreen() sem opções, feito DENTRO do clique do botão. Nada de pedir ao abrir a
// página nem em todo evento da tela: na Samsung, esses pedidos extras gastavam a permissão do clique.
const diagnosticoTela = { resposta: '' };
function pedirTelaCheia() {
  if (emTelaCheia()) return;
  const raiz = document.documentElement;
  try {
    if (raiz.requestFullscreen) {
      const pedido = raiz.requestFullscreen();
      diagnosticoTela.resposta = 'enviado';
      if (pedido && typeof pedido.then === 'function') {
        pedido.then(() => { diagnosticoTela.resposta = 'aceito'; }, (e) => { diagnosticoTela.resposta = `recusado: ${e?.message || e?.name || e}`; });
      }
    } else if (raiz.webkitRequestFullscreen) {
      raiz.webkitRequestFullscreen();
      diagnosticoTela.resposta = 'enviado (webkit)';
    } else {
      diagnosticoTela.resposta = 'navegador sem tela cheia';
    }
  } catch (e) {
    diagnosticoTela.resposta = `erro: ${e?.message || e}`;
  }
}

/** Botão "Clique aqui para maximizar": fica na tela enquanto a TV não estiver em tela cheia. */
function telaCheia() {
  const botao = $('aviso-tela-cheia');
  const texto = $('texto-tela-cheia');
  const instalado = matchMedia('(display-mode: fullscreen)').matches;
  let canto;
  let sumir;
  const ocupaTudo = () => emTelaCheia() || instalado;
  const atualizar = () => {
    clearTimeout(canto);
    clearTimeout(sumir);
    botao.hidden = ocupaTudo();
    if (!botao.hidden) {
      botao.classList.remove('canto', 'aviso');
      texto.textContent = 'Clique aqui para maximizar';
      // Grande no alto por 20 s; depois vai para o canto, menor; em 2 min sai (volta ao mexer no controle).
      canto = setTimeout(() => botao.classList.add('canto'), 20_000);
      sumir = setTimeout(() => { botao.hidden = true; }, 120_000);
    }
  };
  botao.addEventListener('click', () => {
    pedirTelaCheia();
    setTimeout(() => {
      if (ocupaTudo()) return;
      botao.classList.add('aviso');
      texto.textContent = `Não maximizou (${diagnosticoTela.resposta || 'sem resposta'}). Tente de novo ou mande uma foto para o suporte.`;
    }, 2000);
  });
  // Dois cliques em qualquer lugar também maximizam (um pedido só, no próprio duplo clique).
  document.addEventListener('dblclick', (e) => { if (e.target !== botao) pedirTelaCheia(); });
  // Mexeu no controle e a TV continua sem tela cheia: o botão volta, já selecionado (o OK cai nele).
  document.addEventListener('keydown', () => { if (botao.hidden && !ocupaTudo()) { atualizar(); botao.focus(); } });
  document.addEventListener('fullscreenchange', atualizar);
  document.addEventListener('webkitfullscreenchange', atualizar);
  atualizar();
  setTimeout(() => { if (!botao.hidden) botao.focus(); }, 300);
}

function atalhos() {
  document.addEventListener('keydown', (e) => {
    const tecla = e.key.toLowerCase();
    if (tecla === 'i') {
      const mostrar = $('info').hidden;
      $('info').hidden = !mostrar;
      if (mostrar) desenharInfo();
    }
    if (tecla === 'r') location.reload();
  });
}

/** Nome e frase da marca nas telas de espera e no rodapé. */
function marcarPlataforma(nome, slogan) {
  if (nome) {
    $('espera-plataforma').textContent = nome;
    $('faixa-plataforma').textContent = nome;
    document.title = `Player — ${nome}`;
  }
  if (slogan !== undefined) $('espera-slogan').textContent = slogan ?? '';
}

/** Guarda a página do player na TV (ver tv/sw.js): ligada sem internet, ela abre mesmo assim. */
function guardarPaginaNaTv() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js', { scope: '/' })
    .catch(() => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

async function iniciar() {
  guardarPaginaNaTv();
  marcarPlataforma(estado.programacao?.plataforma, estado.programacao?.slogan);
  mostrarEspera('Preparando a tela…', 'Carregando a programação guardada.');
  relogio();
  atalhos();
  telaCheia();
  manterTelaAcesa();
  // A batida segue o intervalo configurado na plataforma (o servidor informa a cada resposta).
  const baterSempre = async () => {
    await bater();
    setTimeout(baterSempre, estado.batidaS * 1000);
  };
  setTimeout(baterSempre, 5000);
  setInterval(enviarExibicoes, 30_000);
  setInterval(() => { if (!$('info').hidden) desenharInfo(); }, 5000);
  // Reaproveita a programação guardada para começar a exibir mesmo sem internet.
  if (estado.token && estado.programacao) {
    desenharFaixa();
    rodarZonaComunicados();
    baixarProgramacao().catch(() => marcarConexao(false));
  }
  // Não espera a internet para começar: sem rede, a TV abre direto no que está guardado.
  enviarExibicoes();
  rodar();
}

iniciar();
