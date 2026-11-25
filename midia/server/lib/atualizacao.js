'use strict';

/**
 * Atualizar o sistema pelo painel (inclusive pelo celular).
 *
 * O sistema roda como um usuário sem poder nenhum na máquina — de propósito. Então ele não se
 * atualiza sozinho: só deixa o pacote e um pedido numa pasta de dados, e quem faz a troca é um
 * serviço à parte do servidor (vaimidia-atualizar), que roda como root, vigia essa pasta, confere o
 * pacote, guarda uma cópia da versão no ar, instala a nova e, se ela não subir, volta a anterior.
 * O andamento volta pelo arquivo estado.json, que o painel lê.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { ErroNegocio } = require('./erros');

const MAX_BYTES = 80 * 1024 * 1024;
// Sem resposta do serviço do servidor nesse tempo, o painel avisa que ele não está instalado ou parado.
const SEM_RESPOSTA_MS = 2 * 60_000;

/** Número da atualização instalada (o arquivo VERSAO vem dentro do pacote). */
function versao() {
  try { return fs.readFileSync(path.join(__dirname, '..', '..', 'VERSAO'), 'utf8').trim().slice(0, 40) || null; } catch { return null; }
}

const pasta = () => process.env.MIDIA_ATUALIZACAO || path.join(path.dirname(config.dbFile), 'atualizacao');
const arquivo = (nome) => path.join(pasta(), nome);

function lerJson(caminho) {
  try { return JSON.parse(fs.readFileSync(caminho, 'utf8')); } catch { return null; }
}

/** Situação para o painel: o último resultado e se há um pedido esperando o servidor. */
function situacao() {
  const estado = lerJson(arquivo('estado.json'));
  const pedido = lerJson(arquivo('pedido'));
  let log = '';
  try { log = fs.readFileSync(arquivo('ultima.log'), 'utf8').split('\n').slice(-40).join('\n'); } catch { /* ainda não houve */ }
  const esperando = Boolean(pedido);
  const semResposta = esperando && Date.now() - Date.parse(pedido.pedido_em) > SEM_RESPOSTA_MS;
  return { versao: versao(), estado, pedido, esperando, sem_resposta: semResposta, log };
}

/** Guarda o pacote e deixa o pedido para o serviço do servidor. */
function pedir(corpo, usuario) {
  if (!Buffer.isBuffer(corpo) || !corpo.length) throw new ErroNegocio('Escolha o arquivo vaimidia.zip.', 422);
  if (corpo.length > MAX_BYTES) throw new ErroNegocio('O arquivo passa de 80 MB: não parece o pacote do sistema.', 422);
  // Todo .zip começa com "PK\x03\x04". O resto (se é mesmo o sistema) o serviço do servidor confere.
  if (corpo.readUInt32LE(0) !== 0x04034b50) throw new ErroNegocio('Este arquivo não é um .zip. Envie o vaimidia.zip.', 422);
  const s = situacao();
  if (s.esperando && !s.sem_resposta) throw new ErroNegocio('Já tem uma atualização em andamento. Espere ela terminar.', 409);
  if (s.estado?.etapa && !['concluida', 'falhou', 'revertida'].includes(s.estado.etapa)
    && Date.now() - Date.parse(s.estado.atualizado_em ?? 0) < 15 * 60_000) {
    throw new ErroNegocio('Já tem uma atualização em andamento. Espere ela terminar.', 409);
  }
  fs.mkdirSync(pasta(), { recursive: true });
  // Grava com outro nome e só depois troca: o serviço nunca pega um pacote pela metade.
  fs.writeFileSync(arquivo('pacote.zip.parcial'), corpo);
  fs.renameSync(arquivo('pacote.zip.parcial'), arquivo('pacote.zip'));
  const pedido = { pedido_em: new Date().toISOString(), por: usuario?.email ?? null, bytes: corpo.length };
  // O pedido é o gatilho: o serviço do servidor vigia este arquivo.
  fs.writeFileSync(arquivo('pedido'), JSON.stringify(pedido));
  return pedido;
}

module.exports = { versao, pasta, situacao, pedir, MAX_BYTES };
