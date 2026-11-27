'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

/**
 * Atualização da plataforma pelo painel.
 *
 * O contêiner NÃO se atualiza sozinho: para isso ele precisaria do Docker do servidor, e quem
 * invadisse o app viraria root na máquina. Então o papel aqui é só **depositar** o pacote numa
 * pasta compartilhada com o servidor; um agente do lado de fora (scripts/atualizador.sh, no
 * cron) é que extrai e reconstrói. Esta pasta é o único ponto de contato entre os dois.
 *
 *   /atualizacao/pacote.tar.gz   pacote enviado pelo painel
 *   /atualizacao/pedido.json     marca que há algo a aplicar (o agente apaga ao começar)
 *   /atualizacao/estado.json     escrito pelo agente: o que aconteceu na última tentativa
 *   /atualizacao/registro.log    saída da última atualização, para aparecer no painel
 */

// Lida na hora do uso, e não na carga do módulo: assim dá para apontar para outra pasta em
// teste sem recarregar meio servidor, e uma troca em produção vale no próximo pedido.
const pasta = () => process.env.TV_ATUALIZACAO || '/atualizacao';
const pedidoEm = () => path.join(pasta(), 'pedido.json');
const estadoEm = () => path.join(pasta(), 'estado.json');
const registroEm = () => path.join(pasta(), 'registro.log');

const GZIP = Buffer.from([0x1f, 0x8b]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);   // "PK\x03\x04"

/**
 * .tar.gz, .zip ou .tar? Decidido pelos primeiros bytes, não pelo nome do arquivo.
 *
 * O tar puro entra na lista porque o Safari do iPhone descompacta `.tar.gz` sozinho ao baixar:
 * quem envia do celular acaba mandando um `.tar`, que é o pacote certo, só que já aberto uma
 * camada. Recusar isso seria recusar o arquivo certo por um detalhe do navegador.
 */
const formatoDe = (b) => {
  if (!Buffer.isBuffer(b) || b.length < 4) return null;
  if (b.subarray(0, 2).equals(GZIP)) return 'tar.gz';
  if (b.subarray(0, 4).equals(ZIP)) return 'zip';
  if (b.length >= 512 && b.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  return null;
};

const lerJson = (arquivo) => {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return null; }
};

/** Versão desta instalação, gravada no pacote no momento em que ele foi montado. */
function versao() {
  const v = lerJson(path.join(__dirname, '..', '..', 'versao.json'));
  return v ?? { versao: 'desconhecida', gerado_em: null, commit: null };
}

/** A pasta compartilhada existe e dá para escrever? Sem ela, o painel não oferece a atualização. */
function agenteDisponivel() {
  try {
    fs.accessSync(pasta(), fs.constants.W_OK);
    return true;
  } catch { return false; }
}

/**
 * Lê os nomes dentro de um .zip pelo diretório central — a lista que fica no fim do arquivo e
 * é a fonte confiável (nos cabeçalhos locais o tamanho pode vir zerado quando o zip foi feito
 * em fluxo).
 */
function nomesNoZip(buf) {
  // O fim do diretório central ("PK\x05\x06") fica nos últimos 64 KB, depois do comentário.
  let fim = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x0605_4b50) { fim = i; break; }
  }
  if (fim < 0) throw new Error('nao-e-zip');
  const quantos = buf.readUInt16LE(fim + 10);
  let i = buf.readUInt32LE(fim + 16);
  const nomes = [];
  for (let n = 0; n < quantos && i + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(i) !== 0x0201_4b50) break;
    const tamNome = buf.readUInt16LE(i + 28);
    const tamExtra = buf.readUInt16LE(i + 30);
    const tamComentario = buf.readUInt16LE(i + 32);
    nomes.push(buf.subarray(i + 46, i + 46 + tamNome).toString('utf8'));
    i += 46 + tamNome + tamExtra + tamComentario;
  }
  return nomes;
}

/**
 * Lê os nomes dentro do .tar.gz sem gravar nada no disco.
 *
 * Um tar é uma sequência de blocos de 512 bytes; o nome do arquivo são os primeiros 100 bytes
 * do bloco de cabeçalho, e o tamanho vem em octal no campo seguinte, que diz quantos blocos de
 * conteúdo pular até o próximo cabeçalho.
 */
function nomesNoPacote(conteudo, { jaAberto = false } = {}) {
  const tar = jaAberto ? conteudo : zlib.gunzipSync(conteudo, { maxOutputLength: 512 * 1024 * 1024 });
  // Todo tar moderno traz "ustar" no byte 257 do primeiro cabeçalho. Sem isso, o que veio é
  // um gzip de outra coisa qualquer — e não adianta tentar ler nomes dali.
  if (tar.length < 512 || tar.subarray(257, 262).toString('latin1') !== 'ustar') {
    throw new Error('nao-e-tar');
  }
  const nomes = [];
  for (let i = 0; i + 512 <= tar.length && nomes.length < 4000;) {
    const nome = tar.subarray(i, i + 100).toString('utf8').replace(/\0.*$/, '').trim();
    if (!nome) break;                       // dois blocos zerados marcam o fim do arquivo
    const tamanho = parseInt(tar.subarray(i + 124, i + 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    nomes.push(nome);
    i += 512 + Math.ceil(tamanho / 512) * 512;
  }
  return nomes;
}

/**
 * Confere que o arquivo é mesmo o pacote da plataforma, no momento do envio — e não lá adiante,
 * no agente. Assim quem está no celular descobre na hora, e com o conteúdo do que mandou.
 */
/** Para a mensagem de erro: quantos MB chegaram, dito de um jeito que a operação entende. */
const emMB = (n) => `${(n / 1048576).toFixed(2)} MB`;

function conferirPacote(conteudo) {
  // O corpo pode nem ser um arquivo: se o navegador mandou um tipo que a rota não esperava, o
  // Express entrega um objeto vazio em vez dos bytes. Dizer isso é melhor que estourar com
  // "subarray is not a function", que não ajuda ninguém no celular.
  if (!Buffer.isBuffer(conteudo) || conteudo.length === 0) {
    throw new Error('O navegador não enviou o conteúdo do arquivo. Escolha o arquivo de novo e tente outra vez.');
  }
  const formato = formatoDe(conteudo);
  if (!formato) {
    throw new Error(`Isto não é um .tar.gz, um .tar nem um .zip (chegaram ${emMB(conteudo.length)}). `
      + 'Escolha o arquivo PLAYTECHVIP-servidor.tar.gz que você recebeu, sem abrir nem renomear.');
  }
  let nomes;
  try {
    nomes = formato === 'zip' ? nomesNoZip(conteudo) : nomesNoPacote(conteudo, { jaAberto: formato === 'tar' });
  } catch {
    throw new Error(`O arquivo chegou inteiro (${emMB(conteudo.length)}, ${formato}) mas não deu para abrir: `
      + 'está corrompido ou foi cortado no meio do envio. Baixe de novo e tente outra vez.');
  }
  // Aceita tanto "./server/index.js" quanto "server/index.js": muda conforme como o tar foi feito.
  if (!nomes.some((n) => /(^|\/)server\/index\.js$/.test(n))) {
    // Só nomes legíveis entram na mensagem: um arquivo estranho não pode despejar binário na tela.
    const amostra = [...new Set(nomes.map((n) => n.replace(/^\.\//, '').split('/')[0]))]
      .filter((n) => /^[\w.][\w.\- ]{0,38}$/.test(n)).slice(0, 6);
    // Sem a parte do "dentro dele há", a mensagem antiga não dizia nada e a operação ficava sem
    // saber se mandou o arquivo errado ou se a plataforma é que estava recusando o certo.
    const dentro = amostra.length
      ? `dentro dele há: ${amostra.join(', ')}`
      : `não consegui ler nenhum nome de arquivo lá dentro (${nomes.length} entrada(s))`;
    throw new Error(`Este arquivo não é o pacote da plataforma — ${emMB(conteudo.length)}, ${formato}, ${dentro}. `
      + 'O pacote certo chama-se PLAYTECHVIP-servidor.tar.gz e tem a pasta "server" dentro.');
  }
  return nomes.length;
}

/**
 * Guarda o pacote enviado pelo painel e marca o pedido.
 * Confere a assinatura do gzip antes: arquivo trocado por engano para aqui, e a plataforma
 * ficaria fora do ar na próxima reconstrução.
 */
function guardarPacote(conteudo, { por }) {
  if (!Buffer.isBuffer(conteudo) || conteudo.length < 1024) {
    throw new Error('O arquivo chegou vazio ou pequeno demais para ser um pacote.');
  }
  // Confere antes de gravar qualquer coisa, e é ele quem dá o recado quando o arquivo é outro.
  const arquivos = conferirPacote(conteudo);
  let formato = formatoDe(conteudo);
  let bytes = conteudo;
  // Tar puro (o Safari do iPhone descompacta sozinho ao baixar) volta a ser .tar.gz aqui. O
  // agente lá fora só conhece `pacote.tar.gz` e `pacote.zip`; um `pacote.tar` ficaria esquecido
  // na pasta para sempre, e a operação veria "enviado" sem nada acontecer.
  if (formato === 'tar') {
    bytes = zlib.gzipSync(conteudo);
    formato = 'tar.gz';
  }
  fs.mkdirSync(pasta(), { recursive: true });
  // Um pedido de cada vez: o formato anterior não pode ficar para trás e confundir o agente.
  for (const antigo of ['pacote.tar.gz', 'pacote.zip']) {
    try { fs.unlinkSync(path.join(pasta(), antigo)); } catch { /* não existia */ }
  }
  // Grava ao lado e só então renomeia: o agente nunca enxerga um pacote pela metade.
  const destino = path.join(pasta(), `pacote.${formato}`);
  const temporario = `${destino}.parcial`;
  fs.writeFileSync(temporario, bytes);
  fs.renameSync(temporario, destino);

  const pedido = {
    pedido_em: new Date().toISOString(),
    por,
    bytes: bytes.length,
    formato,
    arquivos,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  fs.writeFileSync(pedidoEm(), JSON.stringify(pedido, null, 2));
  return pedido;
}

/** O que o painel mostra: versão, se há pedido na fila e como terminou a última tentativa. */
function estado() {
  const pedido = lerJson(pedidoEm());
  const ultimo = lerJson(estadoEm());
  let registro = null;
  try { registro = fs.readFileSync(registroEm(), 'utf8').slice(-4000); } catch { /* ainda não houve */ }
  return {
    versao: versao(),
    agente: agenteDisponivel(),
    na_fila: pedido ? { pedido_em: pedido.pedido_em, por: pedido.por, bytes: pedido.bytes } : null,
    ultima: ultimo,
    registro,
  };
}

module.exports = { versao, estado, guardarPacote, conferirPacote, formatoDe, agenteDisponivel, pasta };
