'use strict';

/**
 * Comandos do servidor pelo painel (Configurações › Sistema › Comandos), para resolver pelo celular.
 *
 * O painel não roda nada na máquina e não aceita texto de comando: ele só deixa o NOME de um item
 * desta lista numa pasta de dados. Um serviço à parte do servidor (vaimidia-comando, root) vigia a
 * pasta, confere se o nome está na lista dele e roda. A resposta volta por saida.log.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { ErroNegocio } = require('./erros');

const LISTA = [
  { id: 'conferir', nome: 'Conferir o servidor', descricao: 'Mostra o que está certo e o que falta: domínio, e-mail, portas e serviços. Não muda nada.' },
  { id: 'dns', nome: 'Ver os registros de DNS', descricao: 'Mostra tudo o que o Registro.br precisa ter, pronto para copiar. Não muda nada.' },
  { id: 'seguranca', nome: 'Conferir a segurança do servidor', descricao: 'Mostra como está o acesso remoto, o firewall e as atualizações. Não muda nada.' },
  { id: 'reforcar', nome: 'Reforçar a segurança do servidor', descricao: 'Liga o bloqueio de quem erra a senha do acesso remoto 5 vezes, fecha a porta 8080 sem uso e deixa o sistema atendendo só por dentro da máquina.', muda: true },
  { id: 'erros', nome: 'Ver os últimos registros do sistema', descricao: 'As últimas 80 linhas do registro, para achar um erro. Não muda nada.' },
  { id: 'email-nome', nome: 'Ajustar o nome do servidor de e-mail', descricao: 'Acrescenta MIDIA_EMAIL_NOME na configuração, se faltar, e reinicia.', muda: true },
  { id: 'email-web', nome: 'Abrir o e-mail em mail.(seu domínio)', descricao: 'Faz o endereço mail.vaimidia.com.br abrir a caixa de e-mail do sistema, com cadeado (HTTPS).', muda: true },
  { id: 'certificado', nome: 'Renovar o cadeado (HTTPS) com todos os endereços', descricao: 'Inclui www, midia e tv no certificado do site.', muda: true },
  { id: 'reiniciar', nome: 'Reiniciar o sistema', descricao: 'O painel e as TVs ficam alguns segundos sem resposta e voltam sozinhos.', muda: true },
];

const SEM_RESPOSTA_MS = 60_000;
const pasta = () => process.env.MIDIA_COMANDOS || path.join(path.dirname(config.dbFile), 'comandos');
const arquivo = (nome) => path.join(pasta(), nome);
const lerJson = (c) => { try { return JSON.parse(fs.readFileSync(c, 'utf8')); } catch { return null; } };

function situacao() {
  const pedido = lerJson(arquivo('pedido'));
  const estado = lerJson(arquivo('estado.json'));
  let saida = '';
  try { saida = fs.readFileSync(arquivo('saida.log'), 'utf8'); } catch { /* ainda não houve */ }
  const semResposta = Boolean(pedido) && Date.now() - Date.parse(pedido.pedido_em) > SEM_RESPOSTA_MS;
  // "Rodando" que não muda há mais de 6 minutos é sobra de um comando interrompido.
  const emCurso = estado?.etapa === 'rodando' && Date.now() - Date.parse(estado.atualizado_em) < 6 * 60_000;
  const rodando = Boolean(pedido) || emCurso;
  return { lista: LISTA, estado, rodando, saida: rodando ? '' : saida, sem_resposta: semResposta };
}

function pedir(id, usuario) {
  const item = LISTA.find((c) => c.id === id);
  if (!item) throw new ErroNegocio('Comando desconhecido.', 422);
  const s = situacao();
  if (s.rodando && !s.sem_resposta) {
    throw new ErroNegocio('Já tem um comando rodando. Espere ele terminar.', 409);
  }
  fs.mkdirSync(pasta(), { recursive: true });
  fs.writeFileSync(arquivo('pedido'), JSON.stringify({ id: item.id, pedido_em: new Date().toISOString(), por: usuario?.email ?? null }));
  return item;
}

module.exports = { LISTA, situacao, pedir, pasta };
