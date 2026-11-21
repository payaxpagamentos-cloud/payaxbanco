'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { agora } = require('../db');
const { decifrar } = require('../lib/cripto');
const cwmp = require('../lib/cwmp');
const acs = require('../lib/acs');

/*
 * Endpoint do ACS: é aqui que o roteador do assinante liga.
 *
 * Diferente do resto da API, este caminho é PÚBLICO — quem chega é um aparelho na casa do cliente, sem
 * sessão de usuário. Por isso:
 *  - a autenticação é a credencial do ACS (HTTP Basic), comparada em tempo constante, e é ela que diz
 *    de qual organização é o aparelho;
 *  - o corpo é XML com tamanho limitado e sem DOCTYPE (ver lib/cwmp.js);
 *  - uma resposta vazia (204) encerra a sessão, que é como o TR-069 diz "não tenho mais nada para você".
 *
 * A conversa é sempre: Inform → InformResponse → POST vazio → comando → resposta do aparelho → ... → 204.
 */
module.exports = (db) => {
  const r = Router();

  /** Confere a credencial do ACS e devolve a organização do aparelho. */
  function autenticar(req) {
    const cabecalho = req.get('authorization') ?? '';
    if (!cabecalho.startsWith('Basic ')) return null;
    let usuario;
    let senha;
    try { [usuario, ...senha] = Buffer.from(cabecalho.slice(6), 'base64').toString('utf8').split(':'); } catch { return null; }
    senha = senha.join(':');
    const orgs = db.prepare('SELECT id, acs_usuario, acs_senha_cifrada FROM organizacoes WHERE acs_usuario IS NOT NULL AND acs_senha_cifrada IS NOT NULL').all();
    for (const o of orgs) {
      if (o.acs_usuario !== usuario) continue;
      let esperada;
      try { esperada = decifrar(o.acs_senha_cifrada); } catch { continue; }
      // Comparação em tempo constante: senha não se confere com ===.
      const a = Buffer.from(senha);
      const b = Buffer.from(esperada);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return o.id;
    }
    return null;
  }

  const pedirCredencial = (res) => res.status(401).set('WWW-Authenticate', 'Basic realm="ACS"').end();
  const envelope = (res, xml, cookie) => {
    if (cookie) res.set('Set-Cookie', `acs=${cookie}; Path=${req0(res)}; HttpOnly; SameSite=Strict`);
    res.status(200).type('text/xml; charset=utf-8').send(xml);
  };
  // O caminho do cookie acompanha onde a API está publicada.
  const req0 = (res) => (res.req.baseUrl || '/');
  const lerCookie = (req) => /(?:^|;\s*)acs=([a-f0-9]{32})/.exec(req.get('cookie') ?? '')?.[1] ?? null;

  r.post('/', async (req, res, next) => {
    try {
      const org = autenticar(req);
      if (!org) return pedirCredencial(res);
      const corpo = typeof req.body === 'string' ? req.body : '';
      const sessaoId = lerCookie(req);

      // POST vazio: o aparelho está perguntando se há algo para ele.
      if (!corpo.trim()) {
        const sessao = sessaoId ? acs.lerSessao(sessaoId) : null;
        if (!sessao || sessao.org !== org) return res.status(204).end();
        const cpe = db.prepare('SELECT * FROM cpes WHERE id = ?').get(sessao.cpeId);
        const tarefa = acs.proximaTarefa(db, cpe.id);
        if (!tarefa) { acs.fecharSessao(sessaoId); return res.status(204).end(); }
        acs.marcarEntregue(db, tarefa.id);
        return envelope(res, acs.envelopeDa(cpe, tarefa));
      }

      cwmp.conferir(corpo);
      const tipo = cwmp.mensagem(corpo);

      if (tipo === 'Inform') {
        const dados = cwmp.lerInform(corpo);
        const cpe = acs.registrar(db, org, dados, { ip: req.ip });
        // A sessão guarda de quem é o POST vazio que vem logo em seguida.
        const nova = acs.abrirSessao(cpe.id, org);
        acs.guardarParametros(db, cpe.id, dados.parametros);
        // Sem a credencial de chamada, o ACS só conseguiria falar quando o aparelho resolvesse ligar.
        acs.garantirChamado(db, org, cpe);
        return envelope(res, cwmp.informResponse(cwmp.valor(cwmp.conteudo(corpo, 'Header') ?? '', 'ID') ?? '1'), nova);
      }

      // Respostas do aparelho: o ID do CWMP é o id da tarefa, então a correlação não depende de cookie.
      const id = cwmp.valor(cwmp.conteudo(corpo, 'Header') ?? '', 'ID') ?? '';
      const tarefaId = /^t(\d+)$/.exec(id)?.[1];
      const tarefa = tarefaId ? db.prepare('SELECT * FROM cpe_tarefas WHERE id = ? AND organizacao_id = ?').get(Number(tarefaId), org) : null;

      if (tipo === 'Fault') {
        const falha = cwmp.lerFalha(corpo);
        if (tarefa) {
          acs.marcarFalha(db, tarefa.id, `${falha.codigo}: ${falha.mensagem}`);
          // A credencial de chamada não entrou no aparelho: a guardada aqui não vale mais.
          if (JSON.parse(tarefa.parametros ?? '{}').chamado) acs.esquecerChamado(db, tarefa.cpe_id);
        }
      } else if (tarefa) {
        if (tipo === 'SetParameterValuesResponse') {
          const status = cwmp.lerStatus(corpo);
          acs.marcarConcluida(db, tarefa.id, { status, aplicado: status === 0 ? 'na hora' : 'depois de reiniciar' });
          // O que foi escrito passa a valer no retrato do aparelho.
          const p = tarefa.parametros ? JSON.parse(tarefa.parametros) : {};
          acs.guardarParametros(db, tarefa.cpe_id, (p.pares ?? []).filter((x) => !/KeyPassphrase|Password/i.test(x.nome)));
        } else if (tipo === 'GetParameterValuesResponse') {
          const pares = cwmp.lerParametros(corpo);
          acs.guardarParametros(db, tarefa.cpe_id, pares);
          acs.marcarConcluida(db, tarefa.id, { lidos: pares.length });
        } else if (tipo === 'RebootResponse' || tipo === 'FactoryResetResponse') {
          acs.marcarConcluida(db, tarefa.id, { confirmado: true });
        } else {
          acs.marcarConcluida(db, tarefa.id, { resposta: tipo });
        }
      }

      // Continua a sessão enquanto houver fila; 204 encerra.
      const sessao = sessaoId ? acs.lerSessao(sessaoId) : null;
      const cpeId = tarefa?.cpe_id ?? sessao?.cpeId;
      if (!cpeId) return res.status(204).end();
      const cpe = db.prepare('SELECT * FROM cpes WHERE id = ?').get(cpeId);
      const proxima = acs.proximaTarefa(db, cpeId);
      if (!proxima) { if (sessaoId) acs.fecharSessao(sessaoId); return res.status(204).end(); }
      acs.marcarEntregue(db, proxima.id);
      return envelope(res, acs.envelopeDa(cpe, proxima));
    } catch (err) {
      return next(err);
    }
  });

  // Alguns aparelhos conferem o endereço com um GET antes de falar SOAP.
  r.get('/', (req, res) => (autenticar(req) ? res.status(204).end() : pedirCredencial(res)));

  return r;
};
