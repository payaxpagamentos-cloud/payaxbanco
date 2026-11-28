'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const config = require('../config');
const { agora, lerConfig } = require('../db');
const { ErroNegocio } = require('./erros');

/**
 * Canais que chegam em RTMP: converte para HLS, que é o que toca em navegador, celular e TV.
 *
 * RTMP não é tocado por nenhum desses — era coisa do Flash. Então, para cada canal ligado com
 * fonte 'rtmp', o servidor mantém um ffmpeg conectado na origem escrevendo pedaços HLS numa
 * pasta local, e o player lê essa pasta pelo caminho de reprodução de sempre, com token assinado.
 *
 * A conversão é REMUX, não recodificação (`-c copy`): os mesmos quadros saem do outro lado, sem
 * perda de qualidade e gastando quase nada de processador. Exige que a origem já venha em
 * H.264 + AAC, que é o que se pede ao fornecedor. Sinal fora disso falha com recado claro, em vez
 * de recodificar escondido e derrubar o servidor com uma dúzia de canais.
 *
 * Um processo por canal ligado. Se a origem cair, ele reconecta sozinho, esperando cada vez um
 * pouco mais, para não martelar um sinal que está fora do ar.
 */

/** Protocolos de entrada aceitos. Nada de file:, http: ou concat: — nem por engano no painel. */
const PROTOCOLOS = ['rtmp:', 'rtmps:', 'srt:', 'rtsp:', 'udp:'];

/** Vídeo que o HLS entrega sem recodificar. H.265 toca em aparelho novo; H.264 toca em tudo. */
const VIDEO_COPIAVEL = ['h264', 'hevc'];

/**
 * Tratamento de imagem, por canal. Existe porque a operação pediu "melhorar a qualidade mesmo
 * recebendo mal". Antes de usar, saiba o que cada um faz DE VERDADE:
 *
 * - `limpar`  suaviza os quadradinhos da compressão. NÃO devolve detalhe: ele esconde defeito
 *             borrando. Numa cena parada quase não se nota; em cena de movimento tira um pouco
 *             da textura (cabelo, grama, camisa listrada).
 * - `fullhd`  faz o mesmo e ainda estica para 1920 de largura. Esticar 720p para 1080p não cria
 *             informação nenhuma — é a mesma imagem, maior. A TV do assinante já faz isso
 *             sozinha, e normalmente faz melhor, porque trabalha no painel e não perde nada
 *             recomprimindo. A largura nunca DIMINUI: canal que já venha em 1080p ou 4K passa
 *             intacto pelo redimensionamento.
 *
 * O custo, medido nesta plataforma com origem 720p (segundos de CPU por segundo de vídeo):
 *
 *     copiar (nenhuma)      0,5% de um núcleo     cabem ~768 canais em 4 núcleos
 *     limpar               69%   de um núcleo     cabem    ~5 canais em 4 núcleos
 *     fullhd              152%   de um núcleo     cabem    ~2 canais em 4 núcleos
 *
 * É por isso que isto é escolha POR CANAL e não um botão geral: ligar nos 116 precisaria de
 * umas 55 máquinas iguais a esta. E há um segundo custo, que não aparece no processador: o
 * canal recodificado sai com mais bits, então cada assinante assistindo consome mais banda.
 * Daí o teto de taxa em cada modo.
 */
const MELHORIAS = {
  nenhuma: null,
  limpar: {
    filtro: 'deblock=filter=weak:block=4,hqdn3d=2:1:3:3',
    teto: '4000k',
  },
  fullhd: {
    // `max(iw,1920)` garante que o filtro só ESTICA: um canal que já chegue maior passa como
    // está, em vez de ser reduzido para 1080p — que seria piorar o canal bom para "melhorar".
    // A barra antes da vírgula é obrigatória: dentro de um filtro, vírgula separa um filtro do
    // seguinte. Sem ela o ffmpeg lê "scale=max(iw" e "1920):-2:flags=lanczos" como dois filtros,
    // não entende nenhum dos dois e o canal não sobe. Em JavaScript isso exige DUAS barras,
    // senão a linguagem come a primeira e sobra a vírgula solta.
    filtro: 'deblock=filter=weak:block=4,hqdn3d=2:1:3:3,scale=max(iw\\,1920):-2:flags=lanczos,unsharp=5:5:0.5',
    teto: '6000k',
  },
};
/** Áudio que todo aparelho toca. AC-3, E-AC-3 e MP2 não entram: Android e Chrome saem mudos. */
const AUDIO_COPIAVEL = ['aac', 'mp3'];

/**
 * O que fazer com o sinal deste canal: copiar, ou converter o mínimo necessário.
 *
 * Copiar (`-c copy`) é o ideal — a qualidade é exatamente a da origem e o processador quase não
 * sente. Mas copiar CEGAMENTE, que era o que havia aqui, quebra canal que vem bom:
 *
 * - áudio em AC-3, E-AC-3 ou MP2 (comum em TV brasileira) é copiado e o canal sai MUDO no
 *   Android e no Chrome. Converter só o áudio para AAC custa cerca de 1% de um núcleo e faz o
 *   canal tocar em tudo. Não há motivo para não fazer.
 * - vídeo em MPEG-2 nem entra no HLS. Converter vídeo é outra conversa: custa quase um núcleo
 *   INTEIRO por canal, contra 1,8% do remux. Com 116 canais isso não cabe em servidor nenhum,
 *   então fica desligado por padrão e a operação liga se quiser, canal a canal.
 *
 * Sem informação de codec (canal nunca testado), copia — é o comportamento de sempre, e o teste
 * de sinal preenche isso na primeira passada.
 */
function modoDeConversao(canal) {
  const video = String(canal.sinal_video ?? '').toLowerCase();
  const audio = String(canal.sinal_audio ?? '').toLowerCase();

  // Valor desconhecido cai em `nenhuma`, que é copiar: na dúvida, não mexer na imagem e não
  // gastar processador. O painel já valida a escolha; isto é a rede de segurança.
  const melhoria = MELHORIAS[String(canal.melhoria ?? 'nenhuma')] ?? null;

  const args = [];
  if (melhoria) {
    // Pedido explícito da operação para este canal: recodifica, venha o vídeo no codec que vier.
    args.push(
      '-vf', melhoria.filtro,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      // Teto de taxa: sem ele, cena de movimento numa imagem esticada gera um pico de bits que
      // o assinante paga em travada, e a operação paga em banda.
      '-maxrate', melhoria.teto, '-bufsize', `${Number.parseInt(melhoria.teto, 10) * 2}k`,
      '-g', '50', '-pix_fmt', 'yuv420p',
    );
  } else if (video && !VIDEO_COPIAVEL.includes(video) && config.aoVivo.recodificarVideo) {
    // Preset rápido e qualidade constante: o que dá para sustentar ao vivo sem engasgar.
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '50', '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }
  if (audio && !AUDIO_COPIAVEL.includes(audio)) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  } else {
    args.push('-c:a', 'copy');
  }
  return args;
}

// path.resolve e não path.join: a rota do pedaço serve o arquivo por caminho absoluto.
const pastaDoCanal = (id) => path.resolve(config.aoVivo.pasta, String(id));
const listaDoCanal = (id) => path.join(pastaDoCanal(id), 'lista.m3u8');
/** Nome de pedaço que a rota aceita servir. Fora deste formato, nada é lido do disco. */
const NOME_PEDACO = /^p\d{6}\.ts$/;

/** Estado por canal: processo, tentativas, último erro. Só em memória — reinício recomeça limpo. */
const vivos = new Map();
// A última partida de cada canal (mesmo depois de ele esfriar): quando ligou, com que análise,
// quanto levou até o primeiro pedaço e até poder ser entregue. É o que o painel mostra.
const partidas = new Map();
// Canais cujo sinal não se deixou ler pela análise curta: sobem direto com a completa.
const semAnaliseRapida = new Set();
// Canais mantidos quentes pela audiência (ver `maisVistos`), refeito a cada sincronização.
let quentesPorAudiencia = new Set();
// Quem estava na lista dos sempre ligados na rodada anterior, e quem saiu dela e ainda está de
// pé esperando para desligar (ver a rodada em `sincronizar`).
let quentesNaRodadaAnterior = new Set();
const esfriando = new Set();

/** Espera entre reconexões: 2s, 4s, 8s… até 60s. */
const esperaDaTentativa = (n) => Math.min(2000 * (2 ** Math.max(0, n - 1)), 60_000);

/**
 * Confere e acerta o endereço de um sinal ao vivo.
 *
 * NÃO usa `new URL()` de propósito. O endereço SRT de um fornecedor é assim:
 *
 *   srt://1.2.3.4:5000?streamid=#!::r=GLOBO_HD,m=request latency=2000
 *
 * e o `new URL()` joga tudo a partir do `#` para o fragmento, deixando `streamid=` vazio: o
 * canal nunca conectaria, e o erro apareceria lá na frente, como "a origem não respondeu".
 * Então aqui o endereço é conferido por partes e o que vem depois do `?` passa inteiro.
 *
 * Duas correções entram de graça, porque é onde a lista do fornecedor sempre vem errada:
 *
 *  - **espaço no lugar de `&`**: parâmetro separado por espaço vira parte do streamid, e o
 *    servidor da origem recusa a conexão por streamid desconhecido;
 *  - **latency em milissegundos**: o SRT conta em ms (2000 = 2 s), o ffmpeg conta em
 *    microssegundos. `latency=2000` ao pé da letra é 2 ms — buffer nenhum, e o canal pica a
 *    cada oscilação da rede. Valor que claramente está em ms é convertido.
 *
 * Endereço de rede interna é aceito: a origem costuma ficar na rede do próprio provedor, e
 * quem cadastra aqui é a operação, não o assinante.
 */
function conferirEndereco(valor) {
  const bruto = String(valor ?? '').trim();
  const partes = /^([a-z][a-z0-9+.-]*:)\/\/([^/?\s]+)(\/[^?\s]*)?(?:\?([\s\S]*))?$/i.exec(bruto);
  if (!partes) throw new ErroNegocio('Endereço do sinal ao vivo inválido.', 422);
  const [, protocolo, autoridade, caminho = '', consulta] = partes;
  if (!PROTOCOLOS.includes(protocolo.toLowerCase())) {
    throw new ErroNegocio(`Endereço do sinal ao vivo deve começar com ${PROTOCOLOS.map((x) => `${x}//`).join(', ')}.`, 422);
  }
  if (autoridade.includes('@')) throw new ErroNegocio('Não coloque usuário e senha no endereço do sinal.', 422);
  if (!/^[\w.-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/i.test(autoridade)) {
    throw new ErroNegocio('Endereço do sinal ao vivo inválido (confira o servidor e a porta).', 422);
  }
  if (!consulta) return `${protocolo}//${autoridade}${caminho}`;

  // Espaço entre parâmetros é erro de digitação em toda lista que chega: vira '&'.
  let q = consulta.trim().replace(/\s+(?=[A-Za-z_][\w.-]*=)/g, '&').replace(/\s+/g, '');
  q = q.replace(/(^|&)latency=(\d+)/gi, (todo, antes, n) => {
    const valorN = Number(n);
    // Até 100000 só pode ser milissegundos: 100000 µs seriam 0,1 s, que não é buffer de nada.
    return valorN > 0 && valorN <= 100_000 ? `${antes}latency=${valorN * 1000}` : todo;
  });
  return `${protocolo}//${autoridade}${caminho}?${q}`;
}

function limparPasta(id) {
  try { fs.rmSync(pastaDoCanal(id), { recursive: true, force: true }); } catch { /* já não existia */ }
}

/**
 * Anota no canal como está o sinal, para o painel mostrar sem perguntar nada a ninguém.
 * Os valores são os mesmos que a verificação dos canais HLS usa ('ok' e 'falha'): o painel já
 * sabe mostrar os dois, e o detalhe conta o resto.
 */
function anotar(db, id, status, detalhe) {
  try {
    db.prepare('UPDATE canais SET sinal_status = ?, sinal_detalhe = ?, sinal_em = ? WHERE id = ?').run(status, detalhe, agora(), id);
  } catch { /* banco fechando num reinício: a anotação não vale derrubar nada */ }
}

/**
 * Liga a conversão de um canal. Chamar de novo com o mesmo canal não duplica o processo.
 * @param {{id:number, nome:string, url_hls:string}} canal
 * @param {object} db banco, para anotar a situação do sinal
 */
function ligar(canal, db) {
  const atual = vivos.get(canal.id);
  if (atual?.processo) { atual.ultimoUso = Date.now(); return atual; }

  const estado = atual ?? { tentativas: 0, erro: null, desde: null, processo: null, parando: false, proxima: null };
  estado.parando = false;
  estado.ultimoUso = Date.now();
  // O número fica guardado porque é por ele que a operação marca um canal como sempre quente
  // (TV_AO_VIVO_QUENTES), e a limpeza de ociosos precisa saber quem não pode desligar.
  estado.numero = canal.numero;
  estado.nome = canal.nome;
  estado.melhoria = String(canal.melhoria ?? 'nenhuma');
  vivos.set(canal.id, estado);

  // Pasta limpa antes de começar. O processo anterior deste canal pode estar morrendo ainda, e
  // a limpeza dele não apaga mais a pasta quando o canal foi relançado (ver `desligar`): é aqui
  // que o pedaço velho sai, senão a lista nova nasceria com alguns segundos do que já passou.
  limparPasta(canal.id);
  fs.mkdirSync(pastaDoCanal(canal.id), { recursive: true });

  // Análise curta só na primeira tentativa, e só em canal que nunca precisou da completa.
  // Se ela não bastar para este sinal, o ffmpeg morre na hora (não acha a taxa do áudio, por
  // exemplo) e a tentativa seguinte, logo abaixo no `exit`, sobe com a análise de sempre.
  const rapida = config.aoVivo.analiseRapida && estado.tentativas === 0 && !semAnaliseRapida.has(canal.id);
  const iniciais = config.aoVivo.segundosIniciais;
  partidas.set(canal.id, { em: Date.now(), analise: rapida ? 'curta' : 'completa', primeiro_ms: null, pronto_ms: null, pedaco_s: null });

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    // Sobrescreve a lista de uma execução anterior. Sem isto o ffmpeg pergunta no terminal e,
    // sem terminal, morre na hora — o canal nunca subiria depois do primeiro reinício.
    '-y',
    // Silêncio da origem por este tempo: o processo cai e a reconexão entra em ação.
    '-rw_timeout', String(config.aoVivo.timeoutMs * 1000),   // em microssegundos
    // Quanto do sinal ler antes de começar a gravar (ver `analiseRapida` em config.js): 1 MB
    // ou 2 s, o que vier primeiro. Num canal de 3 a 6 Mbps isso é 1,5 a 3 s de vídeo — cabe
    // um quadro-chave e os primeiros quadros de áudio, que é o que o ffmpeg precisa conhecer.
    ...(rapida ? ['-analyzeduration', '2000000', '-probesize', '1000000'] : []),
    '-i', comAtrasoSrt(canal.url_hls, db),
    // Só vídeo e áudio: dado e legenda embutidos de alguns sinais não cabem em MPEG-TS e
    // derrubariam a conversão no meio.
    '-map', '0:v:0', '-map', '0:a:0?',
    // O que fazer com vídeo e áudio deste canal — ver `modoDeConversao`.
    ...modoDeConversao(canal),
    // Sinal ao vivo chega com relógio próprio; sem isto, pedaço com tempo estranho trava o player.
    '-fflags', '+genpts',
    '-f', 'hls',
    '-hls_time', String(config.aoVivo.segundosPorSegmento),
    // Os primeiros pedaços saem menores, até a primeira lista encher; depois valem os de regime.
    ...(iniciais > 0 && iniciais < config.aoVivo.segundosPorSegmento ? ['-hls_init_time', String(iniciais)] : []),
    '-hls_list_size', String(config.aoVivo.segmentosNaLista),
    // delete_segments apaga o que saiu da lista; omit_endlist mantém a lista como "ao vivo".
    '-hls_flags', 'delete_segments+omit_endlist+temp_file',
    // Por padrão o ffmpeg guarda UM pedaço além da lista. Medido: 6 na lista, 7 em disco. O
    // player fica 3 pedaços atrás da ponta; atrasando mais dois numa oscilação de rede de
    // celular, ele pede um arquivo já apagado, leva 404 e trava de vez. Guardar alguns a mais
    // custa poucos MB por canal e é a diferença entre engasgar e parar.
    '-hls_delete_threshold', String(config.aoVivo.pedacosGuardados),
    '-hls_segment_filename', path.join(pastaDoCanal(canal.id), 'p%06d.ts'),
    listaDoCanal(canal.id),
  ];

  const processo = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  estado.processo = processo;
  estado.desde = new Date().toISOString();

  let ultimasLinhas = '';
  processo.stderr.on('data', (d) => { ultimasLinhas = `${ultimasLinhas}${d}`.slice(-2000); });

  processo.on('error', (err) => {
    estado.erro = err.code === 'ENOENT' ? 'ffmpeg não encontrado no servidor.' : err.message;
  });

  processo.on('exit', (codigo, sinal) => {
    estado.processo = null;
    clearInterval(estado.confirmacao);
    if (estado.parando) return;
    estado.tentativas += 1;
    const ultima = ultimasLinhas.trim().split('\n').filter(Boolean).pop();
    // Plano B da análise curta: caiu antes de gravar qualquer pedaço. Não é falha do canal —
    // é este sinal precisando de mais leitura. Sobe de novo em seguida com a análise completa,
    // sem acusar erro para o assinante que está esperando nem marcar o canal no painel, e
    // lembra do canal para não repetir a tentativa perdida nas próximas aberturas.
    const planoB = rapida && !temSinal(canal.id);
    if (planoB) {
      semAnaliseRapida.add(canal.id);
      estado.erro = null;
    } else {
      estado.erro = `a conversão parou (${sinal ?? `código ${codigo}`})${ultima ? `: ${ultima}` : ''}`;
      if (db) anotar(db, canal.id, 'falha', estado.erro);
    }
    const espera = planoB ? 250 : esperaDaTentativa(estado.tentativas);
    estado.proxima = new Date(Date.now() + espera).toISOString();
    estado.relogio = setTimeout(() => {
      // O canal pode ter sido desligado ou apagado enquanto a gente esperava.
      if (!vivos.has(canal.id) || vivos.get(canal.id).parando) return;
      ligar(canal, db);
    }, espera);
    if (estado.relogio.unref) estado.relogio.unref();
  });

  processo.on('spawn', () => {
    estado.tentativas = 0;
    estado.erro = null;
    estado.proxima = null;
    // Subir o processo não quer dizer que o sinal chegou: um endereço errado conecta e cai logo
    // em seguida. O painel só mostra "ok" depois que o primeiro pedaço existe de verdade — por
    // isso a confirmação fica olhando, em vez de confiar no instante em que o processo nasceu.
    clearInterval(estado.confirmacao);
    const nasceu = Date.now();
    let confirmado = false;
    estado.confirmacao = setInterval(() => {
      // Um minuto e meio é mais que qualquer partida saudável; passou disso, para de olhar.
      if (!estado.processo || Date.now() - nasceu > 90_000) return clearInterval(estado.confirmacao);
      const p = partidas.get(canal.id);
      const r = resumoDaLista(canal.id);
      // O cronômetro da partida: quanto levou até o primeiro pedaço (conexão + análise do sinal
      // + o primeiro pedaço em si) e até o canal poder ser entregue. É o que diz, no painel, se
      // a demora de um canal está na origem ou na espera dos pedaços.
      if (p && r.pedacos >= 1 && p.primeiro_ms === null) p.primeiro_ms = Date.now() - p.em;
      if (!confirmado && Date.now() - nasceu >= 1500 && r.pedacos >= 1) {
        confirmado = true;
        if (db) anotar(db, canal.id, 'ok', 'Conectado na origem, convertendo para HLS.');
      }
      if (daParaAssistir(canal.id)) {
        if (p && p.pronto_ms === null) { p.pronto_ms = Date.now() - p.em; p.pedaco_s = Number((r.segundos / r.pedacos).toFixed(1)); }
        if (confirmado) clearInterval(estado.confirmacao);
      }
      return undefined;
    }, 250);
    if (estado.confirmacao.unref) estado.confirmacao.unref();
  });

  return estado;
}

/**
 * Aplica o teto de atraso do SRT escolhido no painel.
 *
 * O `latency` do SRT é quanto o receptor segura o sinal antes de entregar, para dar tempo de
 * repor pacote perdido. O fornecedor manda 2 s no endereço, que serve para atravessar a
 * internet; com a origem na mesma rede do servidor, meio segundo sobra — e esse tempo sai
 * inteiro da espera de quem abre um canal frio. Só DIMINUI: se o endereço já pede menos, fica.
 * (O valor de verdade é o maior entre os dois lados; se a origem exigir mais, vale o dela, e
 * baixar aqui simplesmente não tem efeito.)
 */
function comAtrasoSrt(url, db) {
  if (!/^srt:/i.test(String(url))) return url;
  let tetoMs = 0;
  try { tetoMs = Number(lerConfig(db).srt_atraso_ms) || 0; } catch { /* sem banco: fica como veio */ }
  if (!(tetoMs > 0)) return url;
  const tetoUs = Math.round(tetoMs * 1000);
  if (!/[?&]latency=\d+/i.test(url)) return `${url}${url.includes('?') ? '&' : '?'}latency=${tetoUs}`;
  return url.replace(/([?&]latency=)(\d+)/i, (_t, antes, n) => `${antes}${Math.min(Number(n), tetoUs)}`);
}

/**
 * Liga o canal "por intenção": o assinante parou o foco nele (controle remoto na TV, ponteiro
 * no computador) mas ainda não abriu.
 *
 * Entre parar no canal e apertar OK passam um, dois, três segundos — tempo em que a conversão
 * já pode estar subindo. Quando ele abre, parte da espera já foi paga.
 *
 * Com freios, porque isto liga processo sem ninguém ter pedido para assistir:
 * - só liga se couber (memória, processador e teto), e nunca tira lugar de quem está vendo;
 * - cada conta pode ter dois canais aquecendo por vez;
 * - o canal aquecido e não aberto cai sozinho em 45 s (`aquecidoSegundos`).
 * Devolve o que fez, para a rota responder sem mistério.
 */
const aquecendoPorConta = new Map();   // usuarioId -> Map(canalId -> até quando)
function aquecer(canal, db, usuarioId) {
  if (!config.aoVivo.ligado || !config.aoVivo.sobDemanda) return { aquecendo: false, motivo: 'desligado' };
  if (vivos.has(canal.id)) return { aquecendo: true, motivo: 'ja_ligado' };
  const agoraMs = Date.now();
  let meus = aquecendoPorConta.get(usuarioId);
  if (!meus) aquecendoPorConta.set(usuarioId, meus = new Map());
  for (const [id, ate] of meus) if (ate <= agoraMs || !vivos.has(id)) meus.delete(id);
  if (meus.size >= 2) return { aquecendo: false, motivo: 'limite_da_conta' };
  if (vivos.size >= tetoDeConversoes() - 2 || !cabeMaisUm().cabe) return { aquecendo: false, motivo: 'sem_folga' };
  const estado = ligar(canal, db);
  // "Usado" no passado, de modo que a limpeza de ociosos o desligue em `aquecidoSegundos` se
  // ninguém abrir. Abrir de verdade (`garantir`) marca o uso de agora e ele passa a valer normal.
  estado.ultimoUso = agoraMs - (config.aoVivo.ociosoSegundos - config.aoVivo.aquecidoSegundos) * 1000;
  meus.set(canal.id, agoraMs + config.aoVivo.aquecidoSegundos * 1000);
  if (aquecendoPorConta.size > 5000) for (const [u, m] of aquecendoPorConta) if (!m.size) aquecendoPorConta.delete(u);
  return { aquecendo: true, motivo: 'ligado' };
}

/**
 * Desliga a conversão e apaga os pedaços do canal.
 *
 * A limpeza espera o ffmpeg morrer de verdade. Apagar a pasta logo depois do SIGTERM parece
 * funcionar e não funciona: o processo ainda está vivo por alguns milissegundos e grava mais um
 * pedaço na pasta recém-apagada. Quando o canal voltasse ao ar, a lista nova começaria com um
 * pedaço velho dentro — e o assinante veria alguns segundos do que já passou.
 */
function desligar(id) {
  const estado = vivos.get(id);
  if (!estado) return;
  estado.parando = true;
  clearTimeout(estado.relogio);
  clearInterval(estado.confirmacao);
  vivos.delete(id);
  const processo = estado.processo;
  if (!processo) return limparPasta(id);

  let limpou = false;
  const limpar = () => {
    if (limpou) return;
    limpou = true;
    // O canal pode ter voltado a ligar enquanto o processo velho agonizava — a rota de editar
    // canal faz desligar + sincronizar, um atrás do outro. Nesse caso a pasta já é da conversão
    // NOVA, e apagá-la aqui derrubaria um canal que acabou de subir. Quem relançou limpa a
    // pasta antes de começar (ver `ligar`), então não fica pedaço velho para trás.
    if (vivos.has(id)) return;
    limparPasta(id);
  };
  processo.once('exit', limpar);
  try { processo.kill('SIGTERM'); } catch { limpar(); }
  // Processo que não atende ao pedido educado leva SIGKILL; a pasta sai de um jeito ou de outro.
  const prazo = setTimeout(() => {
    try { processo.kill('SIGKILL'); } catch { /* já morreu */ }
    limpar();
  }, 3000);
  if (prazo.unref) prazo.unref();
  processo.once('exit', () => clearTimeout(prazo));
  return undefined;
}

/**
 * Desliga tudo e espera os processos morrerem de verdade.
 *
 * `desligar` só PEDE para o ffmpeg sair; ele ainda fecha o pedaço que está escrevendo e leva
 * centenas de milissegundos. Quem encerra o servidor precisa esperar isso, senão o contêiner
 * morre com filhos vivos escrevendo em disco. Devolve uma promessa para quem quiser esperar;
 * quem não esperar continua funcionando como antes.
 */
function desligarTudo({ esperarMs = 5000 } = {}) {
  const processos = [...vivos.values()].map((e) => e.processo).filter(Boolean);
  for (const id of [...vivos.keys()]) desligar(id);
  // Desligou tudo: o que se sabia sobre partidas e canais quentes não vale para a próxima subida.
  partidas.clear();
  semAnaliseRapida.clear();
  quentesPorAudiencia = new Set();
  quentesNaRodadaAnterior = new Set();
  esfriando.clear();
  aquecendoPorConta.clear();
  resumoDosQuentes = { todos: false, canais: 0, alvo: 0, ligados: 0, limite: null };
  if (!processos.length) return Promise.resolve();
  return Promise.race([
    Promise.all(processos.map((p) => (p.exitCode !== null || p.signalCode !== null
      ? Promise.resolve()
      : new Promise((r) => p.once('exit', r))))),
    new Promise((r) => { const t = setTimeout(r, esperarMs); if (t.unref) t.unref(); }),
  ]);
}

/**
 * Acerta o que está convertendo com o que o banco diz: liga canal rtmp ativo, desliga o resto.
 * Chamado ao subir e sempre que a operação mexe nos canais.
 */
function sincronizar(db) {
  if (!config.aoVivo.ligado) { desligarTudo(); return { ligados: 0, limitados: 0 }; }
  let canais;
  try {
    // Os codecs vêm junto: é `modoDeConversao` quem decide, por canal, se copia o áudio ou
    // troca por AAC. Sem eles aqui, canal com áudio em AC-3 subiria copiado e sairia mudo.
    canais = db.prepare("SELECT id, numero, nome, url_hls, sinal_video, sinal_audio, melhoria FROM canais WHERE fonte = 'rtmp' AND ativo = 1 AND url_hls IS NOT NULL AND url_hls <> '' ORDER BY ordem, numero").all();
  } catch { return { ligados: 0, limitados: 0 }; }
  const podem = new Set(canais.map((c) => c.id));
  // Canal desligado, apagado ou que deixou de ser RTMP para de converter na hora.
  for (const id of [...vivos.keys()]) if (!podem.has(id)) desligar(id);

  if (config.aoVivo.sobDemanda) {
    // Sob demanda, quem liga o canal é o assinante que o abre (garantir). Aqui só se faz a
    // limpeza: ficar de pé convertendo 116 canais que ninguém está vendo não cabe em servidor
    // nenhum, e seria banda entrando de graça o dia inteiro.
    //
    // A exceção são os canais quentes: os mais vistos ficam convertendo sempre, para abrirem na
    // hora em vez de fazer o assinante esperar o canal subir toda vez que ele esfria.
    medirProcessador();
    const quentes = canaisQuentes(canais, db);
    const manuaisNumeros = new Set(config.aoVivo.quentes);
    const idsDeAgora = new Set(quentes.map((c) => c.id));

    // Saiu da lista dos sempre ligados (a operação diminuiu a quantidade, ou o canal ganhou
    // tratamento de imagem): desliga JÁ, se ninguém estiver assistindo. Sem isto, voltar atrás
    // de "todos" para "os 10 mais vistos" só fazia efeito 15 minutos depois, quando cada canal
    // esfriasse por conta própria — tempo demais para quem está com a plataforma engasgando.
    for (const id of quentesNaRodadaAnterior) if (!idsDeAgora.has(id)) esfriando.add(id);
    quentesNaRodadaAnterior = idsDeAgora;
    for (const id of [...esfriando]) {
      const e = vivos.get(id);
      if (!e || idsDeAgora.has(id)) { esfriando.delete(id); continue; }
      // Cada pedido de lista de um player marca o uso; um minuto sem isso é canal sem ninguém.
      if ((e.ultimoUso ?? 0) < Date.now() - config.aoVivo.esfriarSemUsoMs) { desligar(id); esfriando.delete(id); }
    }

    let limite = null;
    let subiram = 0;
    for (const c of quentes) {
      if (vivos.has(c.id)) continue;
      // Aos poucos: a memória e o processador medidos na próxima rodada já contam os desta.
      if (subiram >= config.aoVivo.quentesPorRodada) { limite = 'subindo aos poucos: mais canais na próxima rodada (30 s)'; break; }
      const cabe = cabeMaisUm();
      if (!cabe.cabe) { limite = cabe.motivo; break; }
      ligar(c, db);
      subiram += 1;
    }

    // Apertou de verdade — memória abaixo de metade da reserva, ou as conversões usando mais
    // processador do que há para elas: desliga por rodada um canal quente que ninguém está
    // vendo. Antes isso do que o sistema matar um processo por conta própria (podia ser o do
    // app), ou do que todos os canais picotarem por falta de processador.
    const r = recursos();
    const usando = processadorEmUso();
    const tetoCpu = Math.max(0, r.nucleos - 1) * 0.95;
    const semMemoria = r.memoriaLivreMB < config.aoVivo.reservaMemoriaMB / 2;
    const semProcessador = usando.total > tetoCpu;
    if (semMemoria || semProcessador) {
      const semUso = Date.now() - config.aoVivo.alivioSemUsoMs;
      const sacrificado = [...quentes].reverse().find((c) => vivos.has(c.id) && (vivos.get(c.id).ultimoUso ?? 0) < semUso && !manuaisNumeros.has(c.numero));
      if (sacrificado) {
        desligar(sacrificado.id);
        quentesPorAudiencia.delete(sacrificado.id);
        limite = `${semMemoria ? 'memória no fim' : `processador no limite (${br(usando.total)} de ${br(tetoCpu)} núcleo(s))`}: "${sacrificado.nome}" foi desligado para aliviar (volta a abrir sob demanda)`;
      }
    }
    limparOciosos();
    const ligadosQuentes = quentes.filter((c) => vivos.has(c.id)).length;
    const emUso = processadorEmUso();
    resumoDosQuentes = {
      ...resumoDosQuentes, alvo: quentes.length, ligados: ligadosQuentes, limite: ligadosQuentes < quentes.length ? limite : null,
      // O que as conversões estão usando agora, para o painel mostrar: é o número que explica
      // tanto "por que parou de ligar" quanto "por que está picotando".
      processador: { uso: Number(emUso.total.toFixed(2)), teto: Number((Math.max(0, recursos().nucleos - 1) * 0.85).toFixed(2)), maior: emUso.maior && emUso.maior.uso >= 0.3 ? { nome: emUso.maior.nome, uso: Number(emUso.maior.uso.toFixed(2)), melhoria: emUso.maior.melhoria } : null },
    };
    return { ligados: vivos.size, limitados: 0, sob_demanda: true, quentes: quentes.length };
  }
  const dentroDoTeto = canais.slice(0, config.aoVivo.maxCanais);
  for (const id of [...vivos.keys()]) if (!dentroDoTeto.some((c) => c.id === id)) desligar(id);
  for (const c of dentroDoTeto) ligar(c, db);
  for (const c of canais.slice(config.aoVivo.maxCanais)) {
    anotar(db, c.id, 'falha', `Passou do teto de ${config.aoVivo.maxCanais} canais ao vivo convertendo ao mesmo tempo.`);
  }
  return { ligados: dentroDoTeto.length, limitados: canais.length - dentroDoTeto.length, sob_demanda: false };
}

/** O player pediu a lista: o canal continua vivo mais um tempo. */
function marcarUso(id) {
  const e = vivos.get(id);
  if (e) e.ultimoUso = Date.now();
}

/** Desliga quem ninguém está assistindo há mais do que o tempo de folga. */
/** Os canais marcados para ficar sempre quentes, dentro do teto de memória. */
/**
 * Os canais mais assistidos dos últimos sete dias, do mais visto para o menos.
 *
 * É o que decide quais ficam quentes sozinhos. A conta é refeita a cada meia hora e fica
 * guardada por banco: audiência de uma semana não muda de um minuto para o outro, e a
 * sincronização dos canais roda a cada 30 segundos.
 *
 * Canal aberto meia dúzia de vezes na semana não entra: manter um canal convertendo o dia
 * inteiro só se paga quando há gente de verdade abrindo.
 */
/**
 * O que a máquina tem para dar: memória disponível e quantos núcleos o app pode usar.
 *
 * `MemAvailable` (e não a memória "livre") é o número certo: conta o que o sistema devolve na
 * hora se alguém pedir. Os núcleos vêm do limite do contêiner, não da máquina — o compose
 * libera 2 dos 4 por padrão (CPUS_APP), e é esse o teto de verdade.
 */
function recursos() {
  if (config.aoVivo.recursosFixos) return config.aoVivo.recursosFixos;   // só os testes usam
  let memoriaLivreMB = Math.round(os.freemem() / 1048576);
  try {
    const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) memoriaLivreMB = Math.round(Number(m[1]) / 1024);
  } catch { /* fora do Linux: vale o que o Node informa */ }
  let nucleos = os.cpus().length || 1;
  try {
    const [cota, periodo] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (cota !== 'max' && Number(periodo) > 0) nucleos = Math.min(nucleos, Number(cota) / Number(periodo));
  } catch { /* sem limite de contêiner */ }
  return { memoriaLivreMB, nucleos };
}

// Medido: um canal ligado (remux, sem recodificar) usa ~1,4% de um núcleo. Arredondado para cima.
const NUCLEO_POR_CANAL = 0.015;
// O que se supõe de um canal antes de haver medida dele (acabou de ligar). Canal com tratamento
// de imagem é recodificado, e aí a conta é outra: 0,7 de núcleo limpando, 1,6 esticando.
const SUPOSTO = { nenhuma: NUCLEO_POR_CANAL, limpar: 0.7, fullhd: 1.6 };

/**
 * Quanto de processador cada conversão está usando DE VERDADE, medido no próprio processo.
 *
 * A primeira versão desta proteção multiplicava o número de canais por 1,5% — uma estimativa
 * tirada de outra máquina, que ainda por cima ignorava o canal recodificado (tratamento de
 * imagem), que sozinho usa mais de um núcleo. Resultado, na operação: com "todos ligados" e um
 * canal em tratamento, a conta dizia que cabia e o processador já tinha acabado — áudio
 * picotando e tela preta em todos os canais.
 *
 * Agora o número vem de /proc: os tiques de CPU de cada ffmpeg entre uma rodada e a seguinte.
 * Vale para qualquer máquina, lenta ou rápida, e para qualquer canal, copiado ou recodificado.
 */
const TIQUES_POR_SEGUNDO = 100;   // USER_HZ, fixo em 100 no Linux
function medirProcessador() {
  const agoraMs = Date.now();
  for (const e of vivos.values()) {
    const pid = e.processo?.pid;
    if (!pid) { e.cpu = null; e.cpuLido = null; continue; }
    try {
      // Depois do ")" que fecha o nome do processo: o 12º e o 13º campos são os tiques em modo
      // usuário e em modo sistema.
      const campos = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ');
      const tiques = Number(campos[11]) + Number(campos[12]);
      if (e.cpuLido && e.cpuLido.pid === pid && agoraMs - e.cpuLido.em >= 5000) {
        e.cpu = Math.max(0, (tiques - e.cpuLido.tiques) / TIQUES_POR_SEGUNDO / ((agoraMs - e.cpuLido.em) / 1000));
        e.cpuLido = { pid, tiques, em: agoraMs };
      } else if (!e.cpuLido || e.cpuLido.pid !== pid) {
        e.cpu = null;                                   // processo novo: ainda sem medida
        e.cpuLido = { pid, tiques, em: agoraMs };
      }
    } catch { e.cpu = null; e.cpuLido = null; }         // fora do Linux, ou o processo acabou de sair
  }
}

/** Núcleos em uso pelas conversões: o medido de cada canal, ou o suposto para quem acabou de ligar. */
function processadorEmUso() {
  let total = 0;
  let maior = null;
  for (const [id, e] of vivos) {
    // (`cpuDeTeste` só existe nos testes: o ffmpeg de mentira não gasta processador nenhum.)
    const uso = config.aoVivo.cpuDeTeste?.(id, e) ?? e.cpu ?? SUPOSTO[e.melhoria] ?? NUCLEO_POR_CANAL;
    total += uso;
    if (!maior || uso > maior.uso) maior = { id, nome: e.nome, uso, melhoria: e.melhoria };
  }
  return { total, maior };
}

const br = (n, casas = 1) => Number(n.toFixed(casas)).toLocaleString('pt-BR');

/**
 * Dá para ligar mais um canal quente? Olha memória e processador, nessa ordem.
 *
 * No processador, um núcleo fica reservado para o app em si (é ele quem atende os assinantes),
 * e do que sobra as conversões podem usar até 85%.
 */
function cabeMaisUm(custo = NUCLEO_POR_CANAL) {
  const r = recursos();
  if (r.memoriaLivreMB < config.aoVivo.reservaMemoriaMB) {
    return { cabe: false, motivo: `memória: restam ${r.memoriaLivreMB} MB livres, e a reserva é de ${config.aoVivo.reservaMemoriaMB} MB` };
  }
  const teto = Math.max(0, r.nucleos - 1) * 0.85;
  const { total, maior } = processadorEmUso();
  if (total + custo > teto) {
    // Quando um canal sozinho responde por boa parte do uso, ele é dito pelo nome: quase
    // sempre é um canal com tratamento de imagem, e a saída é desligar o tratamento dele.
    const culpado = maior && maior.uso >= 0.3
      ? ` — só "${maior.nome}"${maior.melhoria && maior.melhoria !== 'nenhuma' ? ', com tratamento de imagem,' : ''} usa ${br(maior.uso)}`
      : '';
    return { cabe: false, motivo: `processador: as conversões usam ${br(total)} de ${br(teto)} núcleo(s) disponíveis para elas${culpado} (CPUS_APP no .env libera mais)` };
  }
  return { cabe: true, motivo: null };
}

/**
 * Quantos canais devem ficar sempre ligados: o que a operação escolheu no painel
 * (Configurações), ou o padrão do servidor. Devolve { todos, quantos }.
 */
function alvoDeQuentes(db) {
  let escolha = '';
  try { escolha = String(lerConfig(db).canais_quentes ?? '').trim().toLowerCase(); } catch { /* sem banco */ }
  const valor = escolha !== '' ? escolha : config.aoVivo.quentesAutomaticos;
  if (valor === 'todos') return { todos: true, quantos: Infinity };
  return { todos: false, quantos: Math.max(0, Number(valor) || 0) };
}

/** Teto de conversões simultâneas. Com "todos", o teto do .env sobe para caber todos os canais. */
const tetoDeConversoes = () => (resumoDosQuentes.todos ? Math.max(config.aoVivo.maxCanais, resumoDosQuentes.canais + 5) : config.aoVivo.maxCanais);

// O retrato da última rodada, para o painel: quantos deveriam estar quentes, quantos estão e,
// se faltou algum, por quê.
let resumoDosQuentes = { todos: false, canais: 0, alvo: 0, ligados: 0, limite: null };

const MINIMO_DE_ABERTURAS = 5;
const audienciaGuardada = new WeakMap();   // db -> { em, ids }
function maisVistos(db, quantos = alvoDeQuentes(db).quantos, { refazer = false, semMinimo = false } = {}) {
  if (!db || !(quantos > 0)) return [];
  let tem = audienciaGuardada.get(db);
  if (refazer || !tem || Date.now() - tem.em >= 30 * 60_000) {
    let linhas = [];
    try {
      linhas = db.prepare(`SELECT canal_id, COUNT(*) AS n FROM sessoes_player
        WHERE canal_id IS NOT NULL AND iniciada_em >= ? GROUP BY canal_id ORDER BY n DESC, canal_id LIMIT 500`)
        .all(new Date(Date.now() - 7 * 86_400_000).toISOString());
    } catch { /* banco fechando ou ainda sem a tabela: sem audiência, sem canal quente */ }
    tem = { em: Date.now(), linhas };
    audienciaGuardada.set(db, tem);
  }
  // O mínimo de aberturas vale para a lista dos "N mais vistos". Com "todos", a audiência só
  // decide a ORDEM em que os canais sobem (e em que seriam desligados, se a máquina apertar).
  return tem.linhas.filter((x) => semMinimo || x.n >= MINIMO_DE_ABERTURAS).map((x) => x.canal_id).slice(0, quantos);
}

/**
 * Os canais que ficam convertendo sempre: os que a operação marcou (TV_AO_VIVO_QUENTES) e os
 * mais assistidos (TV_AO_VIVO_QUENTES_AUTO). Os marcados à mão vêm primeiro — se o teto
 * apertar, é a escolha da operação que fica.
 */
function canaisQuentes(canais, db = null) {
  const numeros = new Set(config.aoVivo.quentes);
  const alvo = alvoDeQuentes(db);
  const porAudiencia = maisVistos(db, alvo.todos ? 500 : alvo.quantos, { semMinimo: alvo.todos });
  const ordem = new Map(porAudiencia.map((id, i) => [id, i]));
  // Canal com tratamento de imagem nunca fica sempre ligado, nem marcado à mão: recodificar
  // custa de 0,7 a 1,6 núcleo POR CANAL, e manter isso de pé sem ninguém assistindo tira o
  // processador de todos os outros. Ele continua abrindo normalmente, sob demanda.
  const tratado = (c) => c.melhoria && c.melhoria !== 'nenhuma';
  const manuais = canais.filter((c) => numeros.has(c.numero) && !tratado(c));
  const resto = canais.filter((c) => !numeros.has(c.numero) && !tratado(c));
  resumoDosQuentes = { ...resumoDosQuentes, tratados: canais.filter(tratado).length };
  // "Todos": os mais vistos primeiro e depois os demais, na ordem da grade. É a ordem em que
  // sobem — se a máquina não comportar todos, ficam de fora os que menos gente abre.
  const automaticos = alvo.todos
    ? [...resto.filter((c) => ordem.has(c.id)).sort((a, b) => ordem.get(a.id) - ordem.get(b.id)), ...resto.filter((c) => !ordem.has(c.id))]
    : resto.filter((c) => ordem.has(c.id)).sort((a, b) => ordem.get(a.id) - ordem.get(b.id));
  resumoDosQuentes = { ...resumoDosQuentes, todos: alvo.todos, canais: canais.length };
  // O teto vale para eles também: canal quente não pode comer a memória toda e deixar o
  // assinante que abriu um canal qualquer sem lugar. (Com "todos", o teto já sobe para caber
  // todos, e quem segura é a medição de memória e processador, na hora de ligar.)
  const escolhidos = [...manuais, ...automaticos].slice(0, alvo.todos ? canais.length : Math.max(0, config.aoVivo.maxCanais - 5));
  quentesPorAudiencia = new Set(escolhidos.filter((c) => !numeros.has(c.numero)).map((c) => c.id));
  return escolhidos;
}

/** Os ids que estão sempre quentes agora. Usado para não desligá-los por ociosidade. */
function idsQuentes() {
  const numeros = new Set(config.aoVivo.quentes);
  const ids = new Set();
  for (const [id, e] of vivos) {
    if ((e.numero !== undefined && numeros.has(e.numero)) || quentesPorAudiencia.has(id)) ids.add(id);
  }
  return ids;
}

function limparOciosos() {
  if (!config.aoVivo.sobDemanda) return 0;
  const corte = Date.now() - config.aoVivo.ociosoSegundos * 1000;
  const quentes = idsQuentes();
  let desligados = 0;
  for (const [id, e] of vivos) {
    // Canal quente nunca sai por ociosidade: é justamente para ele estar de pé quando alguém
    // abrir que ele está aí.
    if (quentes.has(id)) continue;
    if ((e.ultimoUso ?? 0) < corte) { desligar(id); desligados += 1; }
  }
  return desligados;
}

/**
 * Garante que um canal está no ar, ligando a conversão se preciso, e espera o primeiro pedaço.
 * É o que o assinante dispara ao abrir o canal.
 *
 * Devolve true quando há sinal. Falso quer dizer que a origem não respondeu a tempo — e aí o
 * assinante recebe um recado, não uma tela preta.
 */
async function garantir(canal, db, { esperarMs = config.aoVivo.esperaPrimeiroPedacoMs } = {}) {
  if (!config.aoVivo.ligado) return false;
  if (daParaAssistir(canal.id)) { marcarUso(canal.id); return true; }
  // Teto de canais simultâneos: antes de subir mais um, tenta abrir espaço no que está ocioso.
  if (!vivos.has(canal.id) && vivos.size >= tetoDeConversoes()) {
    limparOciosos();
    if (vivos.size >= tetoDeConversoes()) {
      throw new ErroNegocio(`O servidor já está convertendo ${tetoDeConversoes()} canais ao mesmo tempo. Tente em instantes.`, 503, { motivo: 'teto' });
    }
  }
  const estado = ligar(canal, db);
  const fim = Date.now() + esperarMs;
  while (Date.now() < fim) {
    await new Promise((r) => { setTimeout(r, 200); });
    if (daParaAssistir(canal.id)) { marcarUso(canal.id); return true; }
    // A origem recusou a conexão: não adianta esperar o resto do prazo.
    if (!estado.processo && estado.erro) return false;
  }
  // Acabou o prazo. Se há sinal, mesmo com menos folga do que o ideal, é melhor entregar o canal
  // com o que existe do que dizer ao assinante que a origem não respondeu: ela respondeu.
  if (temSinal(canal.id)) { marcarUso(canal.id); return true; }
  return false;
}

/** O pedaço mais recente já escrito pela conversão (para conferir o sinal sem tocar na origem). */
function pedacoMaisNovo(id) {
  try {
    const nomes = fs.readdirSync(pastaDoCanal(id)).filter((n) => NOME_PEDACO.test(n)).sort();
    // O penúltimo, não o último: o último pode estar sendo escrito neste instante.
    const escolhido = nomes.length > 1 ? nomes[nomes.length - 2] : nomes[0];
    return escolhido ? path.join(pastaDoCanal(id), escolhido) : null;
  } catch { return null; }
}

/** A lista do canal já existe em disco? É o que diz se o sinal está realmente no ar. */
function temSinal(id) {
  try { return fs.statSync(listaDoCanal(id)).size > 0; } catch { return false; }
}

/**
 * Quantos pedaços a lista já anuncia.
 *
 * "Tem sinal" e "dá para assistir" não são a mesma coisa, e confundir os dois era o motivo de o
 * canal travar: o ffmpeg escreve a lista assim que fecha o PRIMEIRO pedaço, com 4 segundos de
 * vídeo dentro. Quem entrasse ali ficava colado na ponta, sem reserva nenhuma, correndo atrás de
 * um processo que produz 4 segundos a cada 4 segundos — qualquer oscilação da rede travava.
 * O próprio hls.js quer ficar três pedaços atrás da ponta (liveSyncDurationCount: 3) e não tinha
 * de onde tirar isso.
 */
function pedacosNaLista(id) {
  try {
    return (fs.readFileSync(listaDoCanal(id), 'utf8').match(/^p\d{6}\.ts$/gm) ?? []).length;
  } catch { return 0; }
}

/** Já há vídeo suficiente na lista para o player começar com folga? */
/** Quantos pedaços a lista tem agora, quantos segundos eles somam e o maior deles. */
function resumoDaLista(id) {
  let texto;
  try { texto = fs.readFileSync(listaDoCanal(id), 'utf8'); } catch { return { pedacos: 0, segundos: 0, maior: 0 }; }
  const pedacos = (texto.match(/^p\d{6}\.ts$/gm) ?? []).length;
  const duracoes = (texto.match(/^#EXTINF:[\d.]+/gm) ?? []).map((l) => Number(l.slice(8)) || 0);
  return { pedacos, segundos: duracoes.reduce((a, b) => a + b, 0), maior: Math.max(0, ...duracoes) };
}

/**
 * O canal já pode ser entregue? Vale o que a lista tem em SEGUNDOS, com um mínimo de pedaços
 * (ver `segundosParaComecar` em config.js).
 */
const daParaAssistir = (id) => {
  const r = resumoDaLista(id);
  return r.pedacos >= config.aoVivo.pedacosParaComecar && r.segundos >= config.aoVivo.segundosParaComecar;
};

/** Lê a lista HLS que o ffmpeg está escrevendo e aponta cada pedaço para o nosso endereço. */
function listaDoPlayer(canalId, { playToken, baseApi }) {
  let texto;
  try {
    texto = fs.readFileSync(listaDoCanal(canalId), 'utf8');
  } catch {
    throw new ErroNegocio('Este canal está entrando no ar. Tente de novo em alguns segundos.', 503, { motivo: 'aquecendo' });
  }
  const rota = `${baseApi}/play/canal/${canalId}/pedaco`;
  // A duração-alvo não pode mudar no meio de uma transmissão, e o ffmpeg a escreve pelo maior
  // pedaço visto ATÉ ALI: com os pedaços iniciais menores, ela começaria em 2 e viraria 4 um
  // pouco depois. O hls.js tolera; o player nativo do iPhone não tem por que tolerar. Então a
  // lista entregue declara desde o começo o tamanho de regime (pedaço menor que o alvo é
  // válido), ou o que o ffmpeg mediu, se a origem estiver mandando pedaços maiores que isso.
  const alvo = Math.ceil(config.aoVivo.segundosPorSegmento);
  return texto.split(/\r?\n/).map((linha) => {
    const l = linha.trim();
    if (l.startsWith('#EXT-X-TARGETDURATION:')) return `#EXT-X-TARGETDURATION:${Math.max(alvo, Number(l.slice(22)) || 0)}`;
    if (!l || l.startsWith('#')) return linha;
    return `${rota}/${l}?t=${encodeURIComponent(playToken)}`;
  }).join('\n');
}

/** Caminho de um pedaço, já conferido. Devolve null para qualquer nome fora do formato. */
function caminhoDoPedaco(canalId, nome) {
  if (!NOME_PEDACO.test(String(nome ?? ''))) return null;
  return path.join(pastaDoCanal(canalId), nome);
}

/**
 * Conferência do sinal antes de colocar o canal no ar: conecta na origem, lê os codecs e diz se
 * dá para remuxar. É o que a operação clica depois de cadastrar o endereço que o fornecedor passou.
 *
 * Responde o que importa decidir: H.264 + AAC passa direto (sem recodificar, qualidade intacta);
 * H.265 toca em aparelho novo, mas não em Smart TV e iPhone antigos; outro codec de áudio
 * (MP3, AC-3) não cabe no HLS e precisa ser convertido.
 */
function conferir(canal) {
  // Canal já no ar: lê o pedaço que a nossa conversão acabou de escrever, e não a origem.
  // Muito fornecedor só aceita UMA conexão por sinal — abrir uma segunda para conferir
  // derrubaria o canal que está no ar, exatamente no momento em que a operação quer olhar.
  const local = temSinal(canal.id) ? pedacoMaisNovo(canal.id) : null;
  const url = local ?? conferirEndereco(canal.url_hls);
  return new Promise((resolve) => {
    execFile(config.ffprobe, [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_entries', 'stream=codec_name,codec_type,width,height,avg_frame_rate',
      // Lê só alguns segundos: é sinal ao vivo, não acaba nunca.
      '-rw_timeout', String(config.aoVivo.timeoutMs * 1000), '-analyzeduration', '3000000', '-probesize', '5000000',
      url,
    ], { timeout: config.aoVivo.timeoutMs + 10_000, maxBuffer: 2 * 1024 * 1024 }, (err, saida, erroSaida) => {
      if (err) {
        let motivo = err.killed ? 'A origem não respondeu no tempo esperado.' : String(erroSaida || err.message).trim().split('\n').pop();
        // O ffprobe repete o endereço inteiro antes do erro. Numa lista de 116 canais isso enche
        // a tela de endereço e esconde o que importa — e endereço de sinal não precisa ficar
        // espalhado por registro nenhum.
        // O ":" tem de vir seguido de espaço: a porta e o streamid do endereço também têm ":",
        // e sem essa exigência o corte parava em "srt://1.2.3.4:" e deixava o resto na mensagem.
        motivo = String(motivo ?? '').replace(/^(?:srt|rtmp|rtmps|rtsp|udp):\/\/.*?:\s+/i, '').trim();
        resolve({ status: 'falha', detalhe: motivo.slice(0, 300) || 'A origem não respondeu.', lido_de: local ? 'conversao' : 'origem' });
        return;
      }
      let fluxos = [];
      try { fluxos = JSON.parse(saida).streams ?? []; } catch { /* saída estranha: cai no recado abaixo */ }
      const video = fluxos.find((f) => f.codec_type === 'video');
      const audio = fluxos.find((f) => f.codec_type === 'audio');
      if (!video) return resolve({ status: 'falha', detalhe: 'A origem respondeu, mas não veio vídeo.', lido_de: local ? 'conversao' : 'origem' });

      const [num, den] = String(video.avg_frame_rate || '0/1').split('/').map(Number);
      const fps = den ? Math.round((num / den) * 100) / 100 : null;
      const videoCopia = VIDEO_COPIAVEL.includes(video.codec_name);
      const audioCopia = !audio || AUDIO_COPIAVEL.includes(audio.codec_name);
      // Áudio que não dá para copiar NÃO é mais falha: a conversão troca só o áudio por AAC, a
      // 1% de um núcleo, e o canal passa a tocar em tudo. Antes isto reprovava o canal, e o
      // "testar e ligar" o DESLIGAVA — canal bom fora do ar por um detalhe que a plataforma
      // resolve sozinha.
      const videoOk = videoCopia || config.aoVivo.recodificarVideo;
      const avisos = [];
      if (video.codec_name === 'hevc') avisos.push('O vídeo vem em H.265: toca em aparelho novo, mas Smart TV e iPhone antigos não abrem. O ideal é pedir H.264.');
      if (!videoCopia && !config.aoVivo.recodificarVideo) {
        avisos.push(`O vídeo vem em ${video.codec_name}, que o HLS não aceita. Dá para recodificar (TV_AO_VIVO_RECODIFICAR_VIDEO=1), mas custa quase um núcleo por canal, contra 1,8% do remux — o ideal é pedir H.264 à origem.`);
      } else if (!videoCopia) {
        avisos.push(`O vídeo vem em ${video.codec_name} e será recodificado para H.264: funciona, mas custa quase um núcleo só deste canal.`);
      }
      if (audio && !audioCopia) avisos.push(`O áudio vem em ${audio.codec_name} e será convertido para AAC na hora (custa cerca de 1% de um núcleo). Sem isso o canal sairia mudo no Android e no Chrome.`);
      if (!audio) avisos.push('A origem não trouxe áudio.');

      const ficha = `${video.codec_name.toUpperCase()} ${video.width}x${video.height}${fps ? ` ${fps}fps` : ''}${audio ? ` + ${audio.codec_name.toUpperCase()}` : ''}`;
      const semPerda = videoCopia && audioCopia;
      const bom = local
        ? `No ar agora, convertido sem perda: ${ficha}.`
        : `Sinal pronto para converter ${semPerda ? 'sem perda' : 'com ajuste de áudio'}: ${ficha}.`;
      resolve({
        status: videoOk ? 'ok' : 'falha',
        detalhe: avisos.length ? `${ficha}. ${avisos.join(' ')}` : bom,
        // De onde veio a leitura: o que está no ar, ou a origem (canal ainda desligado).
        lido_de: local ? 'conversao' : 'origem',
        video: { codec: video.codec_name, largura: video.width ?? null, altura: video.height ?? null, fps },
        audio: audio ? { codec: audio.codec_name } : null,
        remux: semPerda,
      });
    });
  });
}

/** Situação de um canal, para o painel mostrar. */
function situacao(id) {
  const e = vivos.get(id);
  return {
    convertendo: Boolean(e?.processo),
    no_ar: temSinal(id),
    desde: e?.desde ?? null,
    tentativas: e?.tentativas ?? 0,
    erro: e?.erro ?? null,
    proxima_tentativa: e?.proxima ?? null,
    // A última partida deste canal, mesmo que ele já tenha esfriado: quanto demorou e por quê.
    partida: partidas.get(id) ?? null,
    quente: idsQuentes().has(id),
  };
}

module.exports = {
  PROTOCOLOS, VIDEO_COPIAVEL, AUDIO_COPIAVEL, MELHORIAS, modoDeConversao,
  conferirEndereco, conferir, ligar, desligar, desligarTudo, sincronizar, situacao, temSinal,
  pedacosNaLista, resumoDaLista, daParaAssistir, maisVistos, canaisQuentes, partidas, recursos, cabeMaisUm, alvoDeQuentes,
  resumoDosQuentes: () => ({ ...resumoDosQuentes }),
  aquecer, comAtrasoSrt, medirProcessador, processadorEmUso,
  garantir, marcarUso, limparOciosos,
  listaDoPlayer, caminhoDoPedaco, pastaDoCanal, listaDoCanal,
};
