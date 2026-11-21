'use strict';

const { agora } = require('../db');
const { dataLocal } = require('./datas');

/*
 * Estado de conexão do assinante.
 *
 * De onde vem o dado: da leitura do concentrador (tarefa "ler" do provisionamento), que responde se
 * existe sessão ativa para o login do serviço. Não há ping, não há adivinhação, não há "provavelmente".
 * Se ninguém leu, o estado é "não sei" — e é assim que a tela mostra.
 *
 * O histórico guarda TRANSIÇÕES, não leituras. Um assinante conectado, lido de 20 em 20 segundos, geraria
 * 4.320 linhas por dia dizendo a mesma coisa. O que interessa é quando mudou: caiu 14h02, voltou 14h19.
 * Dessas duas linhas saem o tempo fora do ar, a contagem de quedas do dia e o mapa de calor, todos exatos.
 */

/** Segundos entre dois instantes ISO, ou null se não dá para saber. */
function duracao(de, ate) {
  if (!de) return null;
  const s = Math.round((Date.parse(ate) - Date.parse(de)) / 1000);
  return Number.isFinite(s) && s >= 0 ? s : null;
}

/**
 * Lê o resultado de uma leitura do concentrador e devolve o que ela diz sobre a conexão.
 *
 * `presente: false` não é "desconectado": é o login não existir no equipamento, que é um problema de
 * provisionamento, não de link. Por isso vira "não sei" (null) e a divergência aparece onde deve.
 */
function daLeitura(resultado) {
  if (!resultado || typeof resultado !== 'object') return { conectado: null, ip: null };
  if (resultado.presente === false) return { conectado: null, ip: null, ausente: true };
  if (typeof resultado.conectado !== 'boolean') return { conectado: null, ip: null };
  return { conectado: resultado.conectado ? 1 : 0, ip: resultado.ip_atual ?? null };
}

/**
 * Registra o que a leitura disse sobre o serviço. Chamada dentro da transação que grava a leitura.
 * Devolve o evento gerado (ou null, quando nada mudou).
 */
function registrar(db, { servico, resultado, em = agora(), fuso = 'America/Sao_Paulo' }) {
  const lido = daLeitura(resultado);
  const anterior = db.prepare('SELECT conectado, conexao_desde, quedas_hoje, quedas_dia FROM servicos WHERE id = ?').get(servico.id) ?? {};
  const hoje = dataLocal(fuso, em);

  // Leitura que não sabe dizer nada sobre a sessão não apaga o que já se sabia: só não acrescenta.
  if (lido.conectado === null) {
    db.prepare('UPDATE servicos SET conexao_em = ? WHERE id = ?').run(em, servico.id);
    return null;
  }

  const antes = anterior.conectado;
  const mesmoEstado = antes === lido.conectado;
  // A virada do dia zera a contagem de quedas: "quedas hoje" tem de significar hoje.
  const quedasBase = anterior.quedas_dia === hoje ? anterior.quedas_hoje ?? 0 : 0;

  if (mesmoEstado) {
    db.prepare('UPDATE servicos SET conexao_em = ?, conexao_ip = ?, quedas_hoje = ?, quedas_dia = ? WHERE id = ?')
      .run(em, lido.ip, quedasBase, hoje, servico.id);
    return null;
  }

  const evento = antes === null || antes === undefined ? 'primeira_leitura' : lido.conectado ? 'voltou' : 'caiu';
  // Num 'voltou', a duração é o tempo que o assinante ficou SEM internet. É o número que importa para ele.
  const durou = duracao(anterior.conexao_desde, em);
  const quedas = quedasBase + (evento === 'caiu' ? 1 : 0);
  const contrato = db.prepare('SELECT id, latitude, longitude FROM contratos WHERE id = ?').get(servico.contrato_id);

  db.prepare('UPDATE servicos SET conectado = ?, conexao_em = ?, conexao_desde = ?, conexao_ip = ?, quedas_hoje = ?, quedas_dia = ? WHERE id = ?')
    .run(lido.conectado, em, em, lido.ip, quedas, hoje, servico.id);
  db.prepare(`INSERT INTO conexao_eventos (organizacao_id, servico_id, contrato_id, evento, conectado, duracao_s, ip, lat, lng, em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(servico.organizacao_id, servico.id, servico.contrato_id, evento, lido.conectado, durou, lido.ip,
      contrato?.latitude ?? null, contrato?.longitude ?? null, em);
  return { evento, conectado: lido.conectado, duracao_s: durou };
}

/**
 * Aplica, de uma vez, as sessões ativas lidas do concentrador a todos os serviços dele.
 *
 * Esta é a varredura que faz o mapa valer: uma chamada ao concentrador atualiza a carteira inteira.
 *
 * Dois cuidados que não podem faltar:
 *
 * 1. Se o concentrador NÃO respondeu, esta função não é chamada. Nunca. Equipamento mudo não é prova de
 *    que ninguém está conectado — marcar todo mundo de vermelho porque a gerência caiu seria inventar uma
 *    pane do tamanho do provedor. Sem resposta, o estado envelhece sozinho e a tela passa a dizer que a
 *    leitura está velha, que é a verdade.
 *
 * 2. Serviço cuja última leitura disse que o login NÃO EXISTE no concentrador fica de fora. Ele não está
 *    "sem sessão": ele não está provisionado, que é outro problema, de outra tela. Trocar um pelo outro
 *    mandaria a equipe técnica caçar queda de link onde falta cadastro.
 */
function varrer(db, { org, concentradorId, sessoes, em = agora(), fuso = 'America/Sao_Paulo' }) {
  const ativos = new Map();
  for (const s of sessoes ?? []) if (s?.login) ativos.set(String(s.login), s);

  const servicos = db.prepare(`SELECT s.* FROM servicos s JOIN contratos c ON c.id = s.contrato_id
    WHERE s.organizacao_id = ? AND s.concentrador_id = ? AND s.login IS NOT NULL AND c.situacao <> 'cancelado'`)
    .all(org, concentradorId);

  const resultado = { servicos: servicos.length, sessoes: ativos.size, caiu: 0, voltou: 0, primeira: 0, ignorados: 0, orfas: 0 };
  const vistos = new Set();
  for (const servico of servicos) {
    let estadoAnterior = null;
    try { estadoAnterior = servico.estado_real ? JSON.parse(servico.estado_real) : null; } catch { estadoAnterior = null; }
    if (estadoAnterior && estadoAnterior.presente === false) { resultado.ignorados += 1; continue; }

    const sessao = ativos.get(String(servico.login));
    if (sessao) vistos.add(String(servico.login));
    const evento = registrar(db, {
      servico,
      resultado: { presente: true, conectado: Boolean(sessao), ip_atual: sessao?.ip ?? null },
      em,
      fuso,
    });
    if (evento?.evento === 'caiu') resultado.caiu += 1;
    else if (evento?.evento === 'voltou') resultado.voltou += 1;
    else if (evento?.evento === 'primeira_leitura') resultado.primeira += 1;
  }
  // Sessão ativa sem serviço correspondente: alguém conectado que o sistema não conhece. Vale saber.
  resultado.orfas = [...ativos.keys()].filter((l) => !vistos.has(l)).length;
  return resultado;
}

/** Histórico de conexão de um serviço, do mais recente para o mais antigo. */
const historico = (db, servicoId, limite = 50) =>
  db.prepare('SELECT * FROM conexao_eventos WHERE servico_id = ? ORDER BY id DESC LIMIT ?').all(servicoId, Math.min(Number(limite) || 50, 500));

/** Quedas de um período, para o mapa de calor e para a contagem por região. */
const quedasNoPeriodo = (db, org, de, ate) =>
  db.prepare(`SELECT * FROM conexao_eventos WHERE organizacao_id = ? AND evento = 'caiu' AND em >= ? AND em < ?
    AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY em`).all(org, de, ate);

module.exports = { daLeitura, registrar, varrer, historico, quedasNoPeriodo, duracao };
