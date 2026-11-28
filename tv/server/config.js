'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.TV_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.TV_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[PLAY TECH VIP] TV_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes, fracos ou ainda com o valor de exemplo.
// (O .env.exemplo traz valores com "troque": subir com eles é o mesmo que não ter senha.)
const DE_EXEMPLO = /troque|exemplo|mude-?isto|changeme|senha123|admin123/i;
if (producao) {
  const faltando = ['TV_SECRET', 'TV_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[PLAY TECH VIP] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.TV_SECRET.length < 32) throw new Error('[PLAY TECH VIP] TV_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.TV_ADMIN_SENHA.length < 12) throw new Error('[PLAY TECH VIP] TV_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
  for (const k of ['TV_SECRET', 'TV_ADMIN_SENHA']) {
    if (DE_EXEMPLO.test(process.env[k])) {
      throw new Error(`[PLAY TECH VIP] ${k} ainda está com o valor de exemplo do .env. Troque antes de abrir ao público.`);
    }
  }
}

// Endereço em que a plataforma é publicada: '' (raiz do domínio) ou um caminho, como '/tv'.
const basePath = String(process.env.TV_BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');
const dbFile = process.env.TV_DB || path.join(__dirname, '..', 'data', 'tv.db');

module.exports = {
  producao,
  basePath,
  port: Number(process.env.PORT) || 3600,
  dbFile,
  secret,
  // Nome da plataforma nas telas, nos e-mails e no PIX.
  marca: process.env.TV_MARCA || 'PLAY TECH VIP',
  // Sessão do assinante dura mais que a da operação (a TV fica aberta na sala).
  tokenTtlSeconds: Number(process.env.TV_SESSAO_HORAS) * 3600 || 30 * 24 * 60 * 60,
  tokenOperacaoTtlSeconds: 8 * 60 * 60,
  trustProxy: process.env.TV_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.TV_LIMITE_LOGIN) || 10,
  fuso: process.env.TV_FUSO || 'America/Sao_Paulo',
  // Vídeos, artes e legendas enviados pelo painel. Ficam fora da pasta pública, com nome aleatório.
  // **Inclua esta pasta no backup** (o banco guarda só os registros).
  midiaDir: process.env.TV_MIDIA || path.join(path.dirname(dbFile), 'midia'),
  // Catálogo de filmes e séries (themoviedb.org): cartaz, banner, sinopse, elenco e classificação.
  // O token é gratuito e sai da conta do cliente; sem ele, a busca some do painel.
  tmdb: {
    token: process.env.TV_TMDB_TOKEN || '',
    idioma: process.env.TV_TMDB_IDIOMA || 'pt-BR',
  },
  // Conversão automática das versões menores (Full HD, HD e SD) a partir do arquivo enviado.
  ffmpeg: process.env.TV_FFMPEG || 'ffmpeg',
  ffprobe: process.env.TV_FFPROBE || 'ffprobe',
  conversao: {
    preset: process.env.TV_CONVERSAO_PRESET || 'veryfast',
    crf: Number(process.env.TV_CONVERSAO_CRF) || 23,
  },
  videoMaxBytes: (Number(process.env.TV_VIDEO_MAX_MB) || 8192) * 1024 * 1024,
  arteMaxBytes: (Number(process.env.TV_ARTE_MAX_MB) || 8) * 1024 * 1024,
  legendaMaxBytes: (Number(process.env.TV_LEGENDA_MAX_KB) || 512) * 1024,
  // Pedaço de cada envio do painel (o navegador fatia o arquivo): 8 MB por requisição.
  uploadParteMaxBytes: (Number(process.env.TV_UPLOAD_PARTE_MB) || 8) * 1024 * 1024,
  // Pacote de atualização enviado pelo painel. Hoje ele tem ~2,5 MB; o teto é folgado
  // para caber crescimento, e ainda assim pequeno o bastante para não virar porta de abuso.
  pacoteMaxBytes: (Number(process.env.TV_PACOTE_MAX_MB) || 64) * 1024 * 1024,
  // Token de reprodução: vale por algumas horas e é assinado para o perfil e o aparelho.
  playTokenSegundos: Number(process.env.TV_PLAY_TTL) || 6 * 60 * 60,
  // Link assinado de cada segmento do canal ao vivo (curto: o player renova a cada lista).
  segmentoTokenSegundos: Number(process.env.TV_SEGMENTO_TTL) || 60 * 60,
  // Telas simultâneas: a sessão do player morre sem sinal de vida por este tempo.
  sessaoPlayerSegundos: Number(process.env.TV_SESSAO_PLAYER_S) || 120,
  // Transmissão (CDN) dos canais ao vivo: o servidor busca a lista HLS na origem e entrega os segmentos
  // pelo nosso endereço. Protege a origem, resolve CORS e deixa a política de segurança das páginas fechada em 'self'.
  relay: {
    ligado: process.env.TV_RELAY !== '0',
    timeoutMs: Number(process.env.TV_RELAY_TIMEOUT_MS) || 12_000,
    // Cache do manifesto em memória (segundos). Segmentos não são guardados: são repassados em fluxo.
    cacheListaMs: Number(process.env.TV_RELAY_CACHE_MS) || 2000,
    segmentoMaxBytes: (Number(process.env.TV_RELAY_SEGMENTO_MAX_MB) || 32) * 1024 * 1024,
    userAgent: process.env.TV_RELAY_USER_AGENT || 'PLAYTECHVIP/1.0',
  },
  // Canais que chegam em RTMP (é como a maioria dos fornecedores entrega o sinal). RTMP não toca
  // em navegador, celular nem TV — virou coisa do Flash —, então o servidor mantém um ffmpeg por
  // canal convertendo para HLS. A conversão é remux (`-c copy`): nenhum quadro é recodificado,
  // a qualidade é a mesma da origem e o gasto de processador é quase zero.
  aoVivo: {
    ligado: process.env.TV_AO_VIVO !== '0',
    // Segmentos ficam aqui, ao lado do banco (fora da pasta pública). São apagados conforme saem
    // da lista: ao vivo não guarda histórico, e disco cheio derruba a plataforma inteira.
    pasta: process.env.TV_AO_VIVO_PASTA || path.join(path.dirname(dbFile), 'ao-vivo'),
    // 2s por pedaço e 12 na lista: os mesmos ~24s de janela, mas o canal frio entra no ar na
    // METADE do tempo. Medido nesta bancada: com pedaço de 4s, os três pedaços que o player
    // precisa para começar sem travar ficam prontos em 13,6s; com 2s, em 6,5s. Doze segundos
    // olhando tela preta é tempo demais para um canal de TV — e "não travar" não pode custar
    // isso. O preço é o dobro de requisições por assinante (uma a cada 2s em vez de 4s), que
    // o servidor atende do próprio disco.
    segundosPorSegmento: Number(process.env.TV_AO_VIVO_SEGMENTO_S) || 2,
    segmentosNaLista: Number(process.env.TV_AO_VIVO_LISTA) || 12,
    // Quando um canal frio é entregue ao assinante: assim que a lista tiver este tanto de
    // vídeo, em SEGUNDOS, e pelo menos `pedacosParaComecar` pedaços.
    //
    // Antes a regra era só "três pedaços". Com pedaço de 4 s isso dava 12 s de espera depois do
    // primeiro quadro, e com origem de quadro-chave espaçado (pedaço de 8 s) dava 24. Contar em
    // segundos faz a espera ser a mesma seja qual for o tamanho do pedaço. Oito segundos é a
    // folga com que o canal começa; com um pedaço só, o player grudava na ponta sem reserva e
    // travava na primeira oscilação — foi medido assim, e por isso o mínimo de dois pedaços.
    segundosParaComecar: Number(process.env.TV_AO_VIVO_SEGUNDOS_INICIO) || 8,
    pedacosParaComecar: Number(process.env.TV_AO_VIVO_PEDACOS_INICIO) || 2,
    // Tamanho dos PRIMEIROS pedaços de um canal que acabou de ligar. Menores que os de regime,
    // para a lista juntar os segundos de partida mais cedo e em passos mais finos: com pedaço de
    // 4 s o canal só podia ser entregue aos 4, 8 ou 12 s; com 2 s, entrega assim que dá.
    // Depois que a primeira lista enche, o ffmpeg volta sozinho ao tamanho de regime.
    segundosIniciais: Number(process.env.TV_AO_VIVO_SEGMENTO_INICIAL_S) || 2,
    // Análise curta do sinal na partida. Por padrão o ffmpeg lê até 5 MB do sinal antes de
    // começar a gravar, à espera de conhecer todas as faixas — e sinal de TV costuma declarar
    // faixa que não manda nada (dado, legenda, segundo áudio). Aí ele lê os 5 MB inteiros:
    // medido, 24 s até o primeiro pedaço, contra 14 s com a análise curta. Era a maior parte
    // dos "30 segundos para abrir um canal". Se a análise curta não bastar para um sinal, a
    // conversão falha na hora e a tentativa seguinte usa a análise completa (ver `ligar`).
    analiseRapida: process.env.TV_AO_VIVO_ANALISE_RAPIDA !== '0',
    // Recodificar o VÍDEO de canal que não vem em H.264 nem H.265 (MPEG-2, por exemplo).
    // Desligado por padrão, e com razão: o remux custa 1,8% de um núcleo por canal; recodificar
    // vídeo custa quase um núcleo inteiro. Com 116 canais, ligar isso para todos derruba o
    // servidor. O áudio é outra história — esse é convertido sempre que precisa, porque custa
    // cerca de 1% e é o que faz o canal ter som no Android e no Chrome.
    recodificarVideo: process.env.TV_AO_VIVO_RECODIFICAR_VIDEO === '1',
    // Pedaços mantidos em disco DEPOIS de saírem da lista, para quem ficou para trás não pedir
    // um arquivo apagado. O padrão do ffmpeg é 1, que é pouco: são ~1,5 MB cada.
    pedacosGuardados: Number(process.env.TV_AO_VIVO_PEDACOS_GUARDADOS) || 12,

    // Canais que ficam convertendo SEMPRE, mesmo sem ninguém assistindo — por número, separados
    // por vírgula. Ex.: TV_AO_VIVO_QUENTES=2,4,5,7,9,11,13 (a TV aberta).
    //
    // Existe porque "sob demanda" tem um preço que cai justamente nos canais mais vistos: quem
    // abre a Globo espera o canal subir, toda vez que ele estiver frio. Deixar um punhado de
    // canais quentes custa ~57 MB de memória cada e faz eles abrirem NA HORA. Com 116 canais
    // não dá para fazer isso com todos; com os sete da TV aberta, são 400 MB bem gastos.
    quentes: String(process.env.TV_AO_VIVO_QUENTES || '')
      .split(',').map((n) => Number(String(n).trim())).filter((n) => Number.isInteger(n) && n > 0),
    // Sem nada chegar da origem por este tempo, o ffmpeg desiste e a gente reconecta.
    timeoutMs: Number(process.env.TV_AO_VIVO_TIMEOUT_MS) || 15_000,
    // Teto de canais convertendo AO MESMO TEMPO. Cada um é um processo e um fluxo de rede;
    // o remux custa pouco (~2% de um núcleo), mas a memória não: ~60 MB por canal.
    maxCanais: Number(process.env.TV_AO_VIVO_MAX) || 60,
    // Converter só o canal que alguém está assistindo.
    //
    // Com 116 canais no contrato, deixar todos ligados o tempo todo seriam ~7 GB de memória e
    // centenas de Mbps ENTRANDO 24 horas por dia, mesmo de madrugada, sem ninguém assistindo.
    // Sob demanda, o servidor converte os que estão sendo vistos agora — que são poucos — e
    // desliga o resto. Quem abre um canal frio espera alguns segundos; quem volta num canal
    // ainda morno entra na hora.
    sobDemanda: process.env.TV_AO_VIVO_SOB_DEMANDA !== '0',
    // Quanto tempo um canal continua convertendo depois que a última tela fechou. Serve para
    // zapear: voltar ao canal anterior dentro desse tempo é instantâneo.
    // Quinze minutos: cobre o intervalo comercial, a ida à cozinha e o zapear de volta. Eram
    // cinco, e o canal esfriava justamente no tempo de um intervalo.
    ociosoSegundos: Number(process.env.TV_AO_VIVO_OCIOSO_S) || 900,
    // Canais mantidos quentes SOZINHOS: os mais assistidos dos últimos sete dias ficam
    // convertendo sempre, e abrem na hora. É o que mais muda a experiência — a maior parte das
    // aberturas cai em meia dúzia de canais — e dispensa a operação de adivinhar a lista.
    // Cada canal quente custa cerca de 1% de um núcleo e a banda do próprio sinal (3 a 6 Mbps)
    // entrando o dia inteiro. Zero desliga; a lista manual (TV_AO_VIVO_QUENTES) continua valendo.
    // 'todos' liga todos os que couberem. O painel (Configurações) manda nisto quando preenchido.
    quentesAutomaticos: process.env.TV_AO_VIVO_QUENTES_AUTO === undefined || process.env.TV_AO_VIVO_QUENTES_AUTO === ''
      ? 10
      : String(process.env.TV_AO_VIVO_QUENTES_AUTO).toLowerCase() === 'todos' ? 'todos'
        : Math.max(0, Number(process.env.TV_AO_VIVO_QUENTES_AUTO) || 0),
    // Memória que tem de continuar livre no servidor. Cada canal ligado ocupa ~60 MB (medido);
    // abaixo desta reserva a plataforma para de ligar canal quente, e abaixo da metade dela
    // desliga os que ninguém está vendo. É o que impede "todos ligados" de derrubar o servidor
    // por falta de memória — o sistema operacional mataria um processo qualquer, e podia ser o app.
    reservaMemoriaMB: Number(process.env.TV_AO_VIVO_RESERVA_MB) || 1024,
    // Quantos canais quentes sobem por rodada (uma rodada a cada 30 s). Subir cem de uma vez
    // seriam cem conexões simultâneas no fornecedor e um pico de processador; aos poucos, a
    // memória medida na rodada seguinte já conta os que acabaram de subir.
    quentesPorRodada: Number(process.env.TV_AO_VIVO_QUENTES_POR_RODADA) || 6,
    // Canal quente só é desligado para aliviar a memória se ninguém o abriu neste intervalo.
    alivioSemUsoMs: 2 * 60_000,
    // Quanto o assinante espera, ao abrir um canal frio, antes de a plataforma desistir.
    //
    // Precisa caber a conversão dos três pedaços iniciais, que ficam prontos lá pelos 12s: um
    // prazo de 12s ficaria exatamente na borda e estouraria em metade das tentativas. Estourando
    // o prazo com sinal já no ar, o canal é entregue mesmo assim — o prazo é para o caso de a
    // origem não responder, não para punir quem abriu um canal frio.
    esperaPrimeiroPedacoMs: Number(process.env.TV_AO_VIVO_ESPERA_MS) || 20_000,
  },
  // Canais marcados para tocar direto na origem (sem transmissão) precisam que o domínio da emissora
  // seja liberado na política de segurança das páginas. Lista separada por vírgula, ex.: 'cdn.emissora.com.br'.
  origensMidia: String(process.env.TV_ORIGENS_MIDIA || '').split(',').map((h) => h.trim()).filter(Boolean),
  // Cobrança: 'simulado' (testes: o assinante confirma o PIX na tela) ou 'manual'
  // (PIX na chave da plataforma, confirmado pela operação). A baixa automática exige um intermediador (PSP).
  pagamentos: process.env.TV_PAGAMENTOS || (producao ? 'manual' : 'simulado'),
  admin: {
    nome: process.env.TV_ADMIN_NOME || 'Operação PLAY TECH VIP',
    email: process.env.TV_ADMIN_EMAIL || 'admin@playtechvip.com.br',
    senha: process.env.TV_ADMIN_SENHA || 'admin123',
  },
};
