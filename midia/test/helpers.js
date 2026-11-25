'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

process.env.NODE_ENV = 'test';
process.env.MIDIA_SECRET = 'segredo-de-teste';
process.env.MIDIA_LIMITE_LOGIN = '1000';
// Os arquivos das mídias dos testes ficam numa pasta temporária, apagada no fim.
process.env.MIDIA_ARQUIVOS = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-teste-'));
process.env.MIDIA_BACKUPS = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-backup-'));
// Caixa de entrada: domínio da casa e uma pasta temporária para as mensagens originais (.eml).
process.env.MIDIA_EMAIL_DOMINIOS = process.env.MIDIA_EMAIL_DOMINIOS || 'vaimidia.com.br';
process.env.MIDIA_EMAIL_PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-emails-'));
// Porta 0 = o servidor de e-mail não sobe sozinho nos testes; cada teste abre o seu numa porta livre.
process.env.MIDIA_EMAIL_PORTA = '0';

const { abrir } = require('../server/db');
const { criarApp } = require('../server/app');
const config = require('../server/config');

const crc32 = (buf) => {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};
const bloco = (tipo, dados) => {
  const corpo = Buffer.concat([Buffer.from(tipo, 'latin1'), dados]);
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const soma = Buffer.alloc(4);
  soma.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, soma]);
};

/** PNG válido (cinza) do tamanho pedido, para testar o envio de criativo. */
function png(largura = 1920, altura = 1080) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 0; // tons de cinza
  const linhas = Buffer.concat(Array.from({ length: altura }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(largura, 200)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', ihdr), bloco('IDAT', zlib.deflateSync(linhas)), bloco('IEND', Buffer.alloc(0)),
  ]);
}

const caixa = (nome, dados) => {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length + 8);
  return Buffer.concat([tamanho, Buffer.from(nome, 'latin1'), dados]);
};

/** MP4 mínimo com a duração dentro do arquivo (ftyp + moov/mvhd + trak/tkhd), para testar a leitura da duração. */
function mp4(segundos = 15, largura = 1920, altura = 1080) {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(0, 0); // versão 0
  mvhd.writeUInt32BE(1000, 12); // escala de tempo
  mvhd.writeUInt32BE(segundos * 1000, 16); // duração
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(largura * 65536, 76);
  tkhd.writeUInt32BE(altura * 65536, 80);
  return Buffer.concat([
    caixa('ftyp', Buffer.from('isomiso2avc1mp41', 'latin1')),
    caixa('moov', Buffer.concat([caixa('mvhd', mvhd), caixa('trak', caixa('tkhd', tkhd))])),
    caixa('mdat', Buffer.alloc(2048, 7)),
  ]);
}

async function iniciar() {
  const db = abrir(':memory:');
  const servidor = criarApp(db).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = `http://127.0.0.1:${servidor.address().port}${config.basePath}/api`;

  async function req(metodo, caminho, corpo, tk, cabecalhos = {}) {
    const resp = await fetch(base + caminho, {
      method: metodo,
      headers: { ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }), ...(tk ? { Authorization: `Bearer ${tk}` } : {}), ...cabecalhos },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await resp.text();
    let dados = texto;
    try { dados = JSON.parse(texto); } catch { /* csv / vazio */ }
    return { status: resp.status, dados, headers: resp.headers };
  }

  /** Envio de arquivo (criativo): corpo bruto com os dados na URL. */
  async function enviarArquivo(caminho, conteudo, tk) {
    const resp = await fetch(base + caminho, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) }, body: conteudo });
    const texto = await resp.text();
    let dados = texto;
    try { dados = JSON.parse(texto); } catch { /* vazio */ }
    return { status: resp.status, dados };
  }

  async function login(email = 'master@midia.com.br', senha = 'master123') {
    const r = await req('POST', '/auth/login', { email, senha });
    if (r.status !== 200) throw new Error(`Login falhou para ${email}: ${JSON.stringify(r.dados)}`);
    return r.dados.token;
  }

  /** Simula um aparelho de TV: pede o código, espera o pareamento e depois usa o token do aparelho. */
  const aparelho = (token = null) => ({
    get token() { return token; },
    registrar: (dados = { aparelho: 'TV Box Teste', largura: 1920, altura: 1080, versao: '1.0' }) => req('POST', '/player/registrar', dados),
    pareamento: (codigo) => req('GET', `/player/pareamento?codigo=${codigo}`),
    usar: (t) => { token = t; },
    programacao: () => req('GET', '/player/programacao', undefined, token),
    batida: (corpo = {}) => req('POST', '/player/batida', corpo, token),
    exibicoes: (lista) => req('POST', '/player/exibicoes', { exibicoes: lista }, token),
    midia: (id) => fetch(`${base}/player/midia/${id}`, { headers: { Authorization: `Bearer ${token}` } }),
  });

  return {
    db,
    base,
    req,
    login,
    enviarArquivo,
    aparelho,
    get: (c, tk) => req('GET', c, undefined, tk),
    post: (c, b, tk) => req('POST', c, b ?? {}, tk),
    patch: (c, b, tk) => req('PATCH', c, b, tk),
    put: (c, b, tk) => req('PUT', c, b, tk),
    del: (c, b, tk) => req('DELETE', c, b, tk),
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

/**
 * Sobe o servidor de e-mail numa porta livre e devolve uma função que entrega uma mensagem nele,
 * falando SMTP de verdade — é assim que o Gmail, o Outlook e o provedor do cliente entregam.
 */
async function servidorDeEmail(db) {
  const net = require('node:net');
  const { criarServidor } = require('../server/lib/smtp-servidor');
  const servidor = criarServidor(db);
  servidor.listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  const porta = servidor.address().port;

  /** Conversa SMTP completa; devolve as respostas do servidor, em ordem. */
  const entregar = ({ de, para, mensagem, comandos = null }) => new Promise((resolve, reject) => {
    const socket = net.createConnection(porta, '127.0.0.1');
    const respostas = [];
    const passos = comandos ?? [
      'EHLO teste.exemplo.com',
      `MAIL FROM:<${de}>`,
      ...[].concat(para).map((p) => `RCPT TO:<${p}>`),
      'DATA',
      `${String(mensagem).replace(/\r?\n/g, '\r\n')}\r\n.`,
      'QUIT',
    ];
    let i = -1;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (p) => {
      buffer += p;
      let quebra = buffer.indexOf('\n');
      while (quebra !== -1) {
        const linha = buffer.slice(0, quebra).trim();
        buffer = buffer.slice(quebra + 1);
        // Resposta de várias linhas (250-...) ainda não terminou.
        if (!/^\d{3}-/.test(linha)) {
          respostas.push(linha);
          i += 1;
          if (i < passos.length) socket.write(`${passos[i]}\r\n`);
          else socket.end();
        }
        quebra = buffer.indexOf('\n');
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(respostas));
  });

  return { porta, entregar, fechar: () => new Promise((r) => servidor.close(r)) };
}

/** Data relativa a hoje no fuso do sistema ('AAAA-MM-DD'). */
const dia = (n = 0) => require('../server/lib/datas').somarDias(require('../server/lib/datas').hoje(), n);

function limparArquivos() {
  for (const pasta of [process.env.MIDIA_ARQUIVOS, process.env.MIDIA_BACKUPS, process.env.MIDIA_EMAIL_PASTA]) {
    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* já limpo */ }
  }
}

module.exports = { iniciar, png, mp4, dia, limparArquivos, servidorDeEmail };
