'use strict';

const net = require('node:net');
const os = require('node:os');
const config = require('../config');
const caixa = require('./caixa');

/**
 * O servidor de e-mail da plataforma: é ele que RECEBE as mensagens.
 *
 * Fala SMTP como qualquer servidor de e-mail do mundo: o servidor de quem enviou se apresenta (EHLO),
 * diz de quem é (MAIL FROM), para quem é (RCPT TO) e despeja a mensagem (DATA, terminada por um ponto
 * sozinho numa linha). O que chega endereçado aos nossos domínios entra na caixa do CRM.
 *
 * O que ele NÃO é: um servidor para o mundo mandar e-mail através da gente. Não há retransmissão —
 * mensagem para domínio que não é nosso é recusada na porta (550). Sem isso, o endereço vira "relay
 * aberto" em minutos, serve de trampolim para spam e entra em lista negra na mesma semana.
 *
 * Os limites são deliberados: tamanho máximo da mensagem, número de destinatários, tamanho de linha,
 * tempo parado e número de conexões por minuto por IP. Porta 25 na internet recebe varredura o dia
 * inteiro; sem limite, qualquer um ocupa a memória do processo.
 *
 * Fora do ar não quebra nada: o CRM continua funcionando, só não entra mensagem nova.
 */

const MAX_LINHA = 4096;
const MAX_DESTINOS = 25;
const OCIOSO_MS = 60_000;
const POR_IP_MINUTO = 30;

const dominioDe = (endereco) => String(endereco).split('@')[1]?.toLowerCase() ?? '';
const nosso = (endereco) => config.entrada.dominios.includes(dominioDe(endereco));

/** "<fulano@exemplo.com> SIZE=123" vira "fulano@exemplo.com". */
function endereco(resto) {
  const dentro = resto.match(/<([^>]*)>/);
  const bruto = (dentro ? dentro[1] : resto.split(/\s+/)[0] || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bruto) ? bruto : '';
}

/** Conexões por IP por minuto: trava a varredura sem atrapalhar quem manda e-mail de verdade. */
function criarContador() {
  const vistos = new Map();
  return (ip) => {
    const minuto = Math.floor(Date.now() / 60_000);
    const atual = vistos.get(ip);
    if (!atual || atual.minuto !== minuto) {
      vistos.set(ip, { minuto, n: 1 });
      if (vistos.size > 5000) for (const [k, v] of vistos) if (v.minuto !== minuto) vistos.delete(k);
      return 1;
    }
    atual.n += 1;
    return atual.n;
  };
}

function criarServidor(db, { aoReceber } = {}) {
  const contar = criarContador();
  const nomeDoServidor = config.entrada.dominios[0] || os.hostname();

  const servidor = net.createServer((socket) => {
    const ip = socket.remoteAddress ?? '';
    if (contar(ip) > POR_IP_MINUTO) {
      socket.end('421 4.7.0 Muitas conexões deste endereço. Tente mais tarde.\r\n');
      return;
    }
    socket.setTimeout(OCIOSO_MS);
    socket.setEncoding('binary');

    let buffer = '';
    let emDados = false;
    let linhasDaMensagem = [];
    let bytes = 0;
    let remetente = null;
    let destinos = [];
    let excedeu = false;

    const responder = (linha) => socket.write(`${linha}\r\n`);
    const zerar = () => { remetente = null; destinos = []; linhasDaMensagem = []; bytes = 0; excedeu = false; };

    responder(`220 ${nomeDoServidor} Vai Mídia pronto`);

    const comando = (linha) => {
      const [verbo, ...resto] = linha.trim().split(/\s+/);
      const argumento = linha.trim().slice(verbo.length).trim();
      switch (String(verbo).toUpperCase()) {
        case 'EHLO':
          responder(`250-${nomeDoServidor}`);
          responder(`250-SIZE ${config.entrada.maxBytes}`);
          responder('250 8BITMIME');
          return;
        case 'HELO': return responder(`250 ${nomeDoServidor}`);
        case 'MAIL': {
          if (!/^from:/i.test(argumento)) return responder('501 5.5.4 Use MAIL FROM:<endereço>');
          zerar();
          remetente = endereco(argumento.slice(5));
          // Aviso de entrega devolvida ("bounce") vem sem remetente: é legítimo e passa.
          return responder('250 2.1.0 Remetente aceito');
        }
        case 'RCPT': {
          if (!remetente && remetente !== '') return responder('503 5.5.1 Mande MAIL FROM antes');
          if (!/^to:/i.test(argumento)) return responder('501 5.5.4 Use RCPT TO:<endereço>');
          const destino = endereco(argumento.slice(3));
          if (!destino) return responder('501 5.1.3 Endereço inválido');
          if (!nosso(destino)) return responder('550 5.7.1 Não entregamos para fora deste domínio');
          if (destinos.length >= MAX_DESTINOS) return responder('452 4.5.3 Destinatários demais');
          destinos.push(destino);
          return responder('250 2.1.5 Destinatário aceito');
        }
        case 'DATA':
          if (!destinos.length) return responder('503 5.5.1 Nenhum destinatário aceito');
          emDados = true;
          linhasDaMensagem = [];
          bytes = 0;
          return responder('354 Pode mandar; termine com um ponto numa linha só');
        case 'RSET': zerar(); return responder('250 2.0.0 Limpo');
        case 'NOOP': return responder('250 2.0.0 Ok');
        case 'VRFY': return responder('252 2.5.2 Não confirmamos endereços');
        case 'QUIT':
          responder('221 2.0.0 Até logo');
          return socket.end();
        case 'STARTTLS': return responder('454 4.7.0 TLS não disponível nesta porta');
        default: return responder('502 5.5.2 Comando não reconhecido');
      }
    };

    const fimDaMensagem = () => {
      emDados = false;
      if (excedeu) {
        responder(`552 5.3.4 Mensagem maior que o limite de ${Math.round(config.entrada.maxBytes / 1024 / 1024)} MB`);
        return zerar();
      }
      const bruto = Buffer.from(linhasDaMensagem.join('\r\n'), 'binary');
      try {
        const guardado = caixa.receber(db, { bruto, de: remetente, para: destinos, ip });
        responder(`250 2.0.0 Recebido (${guardado.id})`);
        aoReceber?.(guardado);
      } catch (err) {
        console.error('[Vai Mídia] Falha ao guardar e-mail recebido:', err.message);
        // 451 é temporário: quem mandou tenta de novo, e a mensagem não se perde por um erro nosso.
        responder('451 4.3.0 Não consegui guardar a mensagem agora');
      }
      zerar();
    };

    socket.on('data', (pedaco) => {
      buffer += pedaco;
      if (!emDados && buffer.length > MAX_LINHA) {
        responder('500 5.5.2 Linha longa demais');
        return socket.end();
      }
      let quebra = buffer.indexOf('\n');
      while (quebra !== -1) {
        const linha = buffer.slice(0, quebra).replace(/\r$/, '');
        buffer = buffer.slice(quebra + 1);
        if (emDados) {
          if (linha === '.') { fimDaMensagem(); } else {
            bytes += linha.length + 2;
            if (bytes > config.entrada.maxBytes) {
              excedeu = true;
              linhasDaMensagem = [];
            } else {
              // Ponto no começo da linha vem dobrado pelo protocolo: desfaz.
              linhasDaMensagem.push(linha.startsWith('..') ? linha.slice(1) : linha);
            }
          }
        } else {
          comando(linha);
        }
        quebra = buffer.indexOf('\n');
      }
    });

    socket.on('timeout', () => { responder('421 4.4.2 Tempo esgotado'); socket.end(); });
    socket.on('error', () => socket.destroy());
  });

  return servidor;
}

/** Liga o servidor, se houver domínio configurado. Devolve o servidor ou null. */
function iniciar(db, { aoReceber } = {}) {
  if (!config.entrada.dominios.length || !config.entrada.porta) {
    caixa.registrarEstado({ ouvindo: false, porta: null, erro: null });
    return null;
  }
  const servidor = criarServidor(db, { aoReceber });
  servidor.on('error', (err) => {
    caixa.registrarEstado({ ouvindo: false, erro: err.message });
    console.error(`[Vai Mídia] Servidor de e-mail não subiu na porta ${config.entrada.porta}: ${err.message}`
      + (err.code === 'EACCES' ? ' (porta abaixo de 1024 precisa de permissão; veja o README)' : ''));
  });
  servidor.listen(config.entrada.porta, config.entrada.host, () => {
    caixa.registrarEstado({ ouvindo: true, porta: config.entrada.porta, erro: null });
    console.log(`[Vai Mídia] Servidor de e-mail ouvindo na porta ${config.entrada.porta}`
      + ` para ${config.entrada.dominios.join(', ')}`);
  });
  servidor.unref?.();
  return servidor;
}

module.exports = { iniciar, criarServidor };
