'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const config = require('../config');
const { agora } = require('../db');
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

// path.resolve e não path.join: a rota do pedaço serve o arquivo por caminho absoluto.
const pastaDoCanal = (id) => path.resolve(config.aoVivo.pasta, String(id));
const listaDoCanal = (id) => path.join(pastaDoCanal(id), 'lista.m3u8');
/** Nome de pedaço que a rota aceita servir. Fora deste formato, nada é lido do disco. */
const NOME_PEDACO = /^p\d{6}\.ts$/;

/** Estado por canal: processo, tentativas, último erro. Só em memória — reinício recomeça limpo. */
const vivos = new Map();

/** Espera entre reconexões: 2s, 4s, 8s… até 60s. */
const esperaDaTentativa = (n) => Math.min(2000 * (2 ** Math.max(0, n - 1)), 60_000);

/** O endereço é de um sinal ao vivo que o ffmpeg sabe puxar? (Endereço interno é permitido: a
 * origem costuma ficar na rede do próprio provedor, e quem cadastra aqui é a operação.) */
function conferirEndereco(valor) {
  let u;
  try { u = new URL(String(valor)); } catch { throw new ErroNegocio('Endereço do sinal ao vivo inválido.', 422); }
  if (!PROTOCOLOS.includes(u.protocol)) {
    throw new ErroNegocio(`Endereço do sinal ao vivo deve começar com ${PROTOCOLOS.map((p) => `${p}//`).join(', ')}.`, 422);
  }
  return u.toString();
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
  if (atual?.processo) return atual;

  const estado = atual ?? { tentativas: 0, erro: null, desde: null, processo: null, parando: false, proxima: null };
  estado.parando = false;
  vivos.set(canal.id, estado);

  fs.mkdirSync(pastaDoCanal(canal.id), { recursive: true });

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    // Sobrescreve a lista de uma execução anterior. Sem isto o ffmpeg pergunta no terminal e,
    // sem terminal, morre na hora — o canal nunca subiria depois do primeiro reinício.
    '-y',
    // Silêncio da origem por este tempo: o processo cai e a reconexão entra em ação.
    '-rw_timeout', String(config.aoVivo.timeoutMs * 1000),   // em microssegundos
    '-i', canal.url_hls,
    // Só vídeo e áudio: dado e legenda embutidos de alguns sinais não cabem em MPEG-TS e
    // derrubariam a conversão no meio.
    '-map', '0:v:0', '-map', '0:a:0?',
    // Remux: sem recodificar. Se a origem não for H.264/AAC, falha aqui — e é o que queremos,
    // porque recodificar escondido derrubaria o servidor com poucos canais.
    '-c', 'copy',
    // Sinal ao vivo chega com relógio próprio; sem isto, pedaço com tempo estranho trava o player.
    '-fflags', '+genpts',
    '-f', 'hls',
    '-hls_time', String(config.aoVivo.segundosPorSegmento),
    '-hls_list_size', String(config.aoVivo.segmentosNaLista),
    // delete_segments apaga o que saiu da lista; omit_endlist mantém a lista como "ao vivo".
    '-hls_flags', 'delete_segments+omit_endlist+temp_file',
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
    estado.erro = `a conversão parou (${sinal ?? `código ${codigo}`})${ultima ? `: ${ultima}` : ''}`;
    if (db) anotar(db, canal.id, 'falha', estado.erro);
    const espera = esperaDaTentativa(estado.tentativas);
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
    let tentativas = 0;
    estado.confirmacao = setInterval(() => {
      tentativas += 1;
      if (!estado.processo || tentativas > 120) return clearInterval(estado.confirmacao);
      if (Date.now() - nasceu < 1500 || !temSinal(canal.id)) return undefined;
      clearInterval(estado.confirmacao);
      if (db) anotar(db, canal.id, 'ok', 'Conectado na origem, convertendo para HLS.');
      return undefined;
    }, 500);
    if (estado.confirmacao.unref) estado.confirmacao.unref();
  });

  return estado;
}

/** Desliga a conversão e apaga os pedaços do canal. */
function desligar(id) {
  const estado = vivos.get(id);
  if (!estado) return;
  estado.parando = true;
  clearTimeout(estado.relogio);
  clearInterval(estado.confirmacao);
  try { estado.processo?.kill('SIGTERM'); } catch { /* já morreu */ }
  vivos.delete(id);
  limparPasta(id);
}

/** Desliga tudo (parada do servidor). */
const desligarTudo = () => { for (const id of [...vivos.keys()]) desligar(id); };

/**
 * Acerta o que está convertendo com o que o banco diz: liga canal rtmp ativo, desliga o resto.
 * Chamado ao subir e sempre que a operação mexe nos canais.
 */
function sincronizar(db) {
  if (!config.aoVivo.ligado) return { ligados: 0, limitados: 0 };
  let canais;
  try {
    canais = db.prepare("SELECT id, nome, url_hls FROM canais WHERE fonte = 'rtmp' AND ativo = 1 AND url_hls IS NOT NULL AND url_hls <> '' ORDER BY ordem, numero").all();
  } catch { return { ligados: 0, limitados: 0 }; }
  const dentroDoTeto = canais.slice(0, config.aoVivo.maxCanais);
  const devem = new Set(dentroDoTeto.map((c) => c.id));
  for (const id of [...vivos.keys()]) if (!devem.has(id)) desligar(id);
  for (const c of dentroDoTeto) ligar(c, db);
  for (const c of canais.slice(config.aoVivo.maxCanais)) {
    anotar(db, c.id, 'falha', `Passou do teto de ${config.aoVivo.maxCanais} canais ao vivo convertendo ao mesmo tempo.`);
  }
  return { ligados: dentroDoTeto.length, limitados: canais.length - dentroDoTeto.length };
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

/** Lê a lista HLS que o ffmpeg está escrevendo e aponta cada pedaço para o nosso endereço. */
function listaDoPlayer(canalId, { playToken, baseApi }) {
  let texto;
  try {
    texto = fs.readFileSync(listaDoCanal(canalId), 'utf8');
  } catch {
    throw new ErroNegocio('Este canal está entrando no ar. Tente de novo em alguns segundos.', 503, { motivo: 'aquecendo' });
  }
  const rota = `${baseApi}/play/canal/${canalId}/pedaco`;
  return texto.split(/\r?\n/).map((linha) => {
    const l = linha.trim();
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
        const motivo = err.killed ? 'A origem não respondeu no tempo esperado.' : String(erroSaida || err.message).trim().split('\n').pop();
        return resolve({ status: 'falha', detalhe: motivo?.slice(0, 300) || 'A origem não respondeu.', lido_de: local ? 'conversao' : 'origem' });
      }
      let fluxos = [];
      try { fluxos = JSON.parse(saida).streams ?? []; } catch { /* saída estranha: cai no recado abaixo */ }
      const video = fluxos.find((f) => f.codec_type === 'video');
      const audio = fluxos.find((f) => f.codec_type === 'audio');
      if (!video) return resolve({ status: 'falha', detalhe: 'A origem respondeu, mas não veio vídeo.', lido_de: local ? 'conversao' : 'origem' });

      const [num, den] = String(video.avg_frame_rate || '0/1').split('/').map(Number);
      const fps = den ? Math.round((num / den) * 100) / 100 : null;
      const videoOk = ['h264', 'hevc'].includes(video.codec_name);
      const audioOk = !audio || ['aac', 'mp3'].includes(audio.codec_name);
      const avisos = [];
      if (video.codec_name === 'hevc') avisos.push('O vídeo vem em H.265: toca em aparelho novo, mas Smart TV e iPhone antigos não abrem. O ideal é pedir H.264.');
      if (!videoOk) avisos.push(`O vídeo vem em ${video.codec_name}, que o HLS não aceita: precisaria recodificar (gasta processador e perde um pouco de qualidade).`);
      if (audio && !audioOk) avisos.push(`O áudio vem em ${audio.codec_name}: converta para AAC na origem, ou o canal sai sem som em parte dos aparelhos.`);
      if (!audio) avisos.push('A origem não trouxe áudio.');

      const ficha = `${video.codec_name.toUpperCase()} ${video.width}x${video.height}${fps ? ` ${fps}fps` : ''}${audio ? ` + ${audio.codec_name.toUpperCase()}` : ''}`;
      const bom = local ? `No ar agora, convertido sem perda: ${ficha}.` : `Sinal pronto para converter sem perda: ${ficha}.`;
      resolve({
        status: videoOk && audioOk ? 'ok' : 'falha',
        detalhe: avisos.length ? avisos.join(' ') : bom,
        // De onde veio a leitura: o que está no ar, ou a origem (canal ainda desligado).
        lido_de: local ? 'conversao' : 'origem',
        video: { codec: video.codec_name, largura: video.width ?? null, altura: video.height ?? null, fps },
        audio: audio ? { codec: audio.codec_name } : null,
        remux: videoOk && audioOk,
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
  };
}

module.exports = {
  PROTOCOLOS, conferirEndereco, conferir, ligar, desligar, desligarTudo, sincronizar, situacao, temSinal,
  listaDoPlayer, caminhoDoPedaco, pastaDoCanal, listaDoCanal,
};
