'use strict';

const http = require('node:http');

/*
 * RouterOS de mentira para os testes: fala a API REST de verdade (caminhos, formato das respostas, o ".id"
 * com asterisco, "disabled" como texto) para o driver ser exercitado como ele vai rodar em campo.
 *
 * O que ele NÃO é: um emulador de RouterOS. Ele responde o que o driver usa e registra as chamadas, para o
 * teste poder afirmar não só o resultado, mas o que foi efetivamente escrito no equipamento.
 */
function criarRouterOsFalso({ usuario = 'admin', senha = 'senha-do-roteador', versao = '7.14.3', placa = 'CCR2004-1G-12S+2XS' } = {}) {
  const secrets = new Map();
  const ativos = new Map();
  const chamadas = [];
  let proximoId = 1;

  const servidor = http.createServer((req, res) => {
    const autorizacao = req.headers.authorization ?? '';
    const esperado = `Basic ${Buffer.from(`${usuario}:${senha}`).toString('base64')}`;
    const partes = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => {
      const corpo = partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : null;
      const url = new URL(req.url, 'http://x');
      chamadas.push({ metodo: req.method, caminho: url.pathname, busca: Object.fromEntries(url.searchParams), corpo });
      const responder = (status, dados) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(dados === undefined ? '' : JSON.stringify(dados));
      };
      if (autorizacao !== esperado) return responder(401, { error: 401, message: 'not authorized' });

      const caminho = url.pathname;
      if (caminho === '/rest/system/resource') return responder(200, [{ version: versao, 'board-name': placa, 'architecture-name': 'arm64', uptime: '3w2d' }]);
      if (caminho === '/rest/system/identity') return responder(200, { name: 'concentrador-01' });

      if (caminho === '/rest/ppp/secret' && req.method === 'GET') {
        const nome = url.searchParams.get('name');
        return responder(200, [...secrets.values()].filter((s) => !nome || s.name === nome));
      }
      if (caminho === '/rest/ppp/secret' && req.method === 'PUT') {
        if ([...secrets.values()].some((s) => s.name === corpo.name)) return responder(400, { message: 'failure: already have entry with such name' });
        const id = `*${(proximoId++).toString(16).toUpperCase()}`;
        const novo = { '.id': id, service: 'any', disabled: 'false', profile: 'default', ...corpo };
        secrets.set(id, novo);
        return responder(201, novo);
      }
      const secretId = caminho.startsWith('/rest/ppp/secret/') ? decodeURIComponent(caminho.slice('/rest/ppp/secret/'.length)) : null;
      if (secretId) {
        const s = secrets.get(secretId);
        if (!s) return responder(404, { message: 'no such item' });
        if (req.method === 'PATCH') { Object.assign(s, corpo); return responder(200, s); }
        if (req.method === 'DELETE') { secrets.delete(secretId); ativos.delete(s.name); return responder(204); }
      }
      if (caminho === '/rest/ppp/active' && req.method === 'GET') {
        const nome = url.searchParams.get('name');
        return responder(200, [...ativos.values()].filter((a) => !nome || a.name === nome));
      }
      const ativoId = caminho.startsWith('/rest/ppp/active/') ? decodeURIComponent(caminho.slice('/rest/ppp/active/'.length)) : null;
      if (ativoId && req.method === 'DELETE') {
        const alvo = [...ativos.values()].find((a) => a['.id'] === ativoId);
        if (!alvo) return responder(404, { message: 'no such item' });
        ativos.delete(alvo.name);
        return responder(204);
      }
      return responder(404, { message: 'no such command' });
    });
  });

  return {
    servidor,
    chamadas,
    secrets,
    /** Coloca o assinante como conectado, para exercitar a derrubada de sessão no corte. */
    conectar(login, address = '100.64.0.10') {
      ativos.set(login, { '.id': `*A${(proximoId++).toString(16).toUpperCase()}`, name: login, address, uptime: '2h13m', 'caller-id': 'AA:BB:CC:DD:EE:FF' });
    },
    conectado: (login) => ativos.has(login),
    secretDe: (login) => [...secrets.values()].find((s) => s.name === login) ?? null,
    /** Chamadas que escreveram no equipamento (o que o ensaio nunca pode produzir). */
    escritas: () => chamadas.filter((c) => c.metodo !== 'GET'),
    limparChamadas: () => { chamadas.length = 0; },
    async iniciar() {
      await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
      return { host: '127.0.0.1', porta: servidor.address().port };
    },
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

module.exports = { criarRouterOsFalso };
