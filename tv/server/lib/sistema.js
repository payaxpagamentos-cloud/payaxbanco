'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
const pacote = () => path.join(pasta(), 'pacote.tar.gz');
const pedidoEm = () => path.join(pasta(), 'pedido.json');
const estadoEm = () => path.join(pasta(), 'estado.json');
const registroEm = () => path.join(pasta(), 'registro.log');

const GZIP = Buffer.from([0x1f, 0x8b]);

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
 * Guarda o pacote enviado pelo painel e marca o pedido.
 * Confere a assinatura do gzip antes: arquivo trocado por engano para aqui, e a plataforma
 * ficaria fora do ar na próxima reconstrução.
 */
function guardarPacote(conteudo, { por }) {
  if (!Buffer.isBuffer(conteudo) || conteudo.length < 1024) {
    throw new Error('O arquivo chegou vazio ou pequeno demais para ser um pacote.');
  }
  if (!conteudo.subarray(0, 2).equals(GZIP)) {
    throw new Error('Isto não é um pacote .tar.gz da plataforma.');
  }
  fs.mkdirSync(pasta(), { recursive: true });
  // Grava ao lado e só então renomeia: o agente nunca enxerga um pacote pela metade.
  const destino = pacote();
  const temporario = `${destino}.parcial`;
  fs.writeFileSync(temporario, conteudo);
  fs.renameSync(temporario, destino);

  const pedido = {
    pedido_em: new Date().toISOString(),
    por,
    bytes: conteudo.length,
    sha256: crypto.createHash('sha256').update(conteudo).digest('hex'),
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

module.exports = { versao, estado, guardarPacote, agenteDisponivel, pasta };
