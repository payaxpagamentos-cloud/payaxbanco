'use strict';

const http = require('node:http');

/**
 * Agente TEF de mentira: responde como a ponte instalada no caixa deveria responder.
 * Serve para testar o caminho completo sem pinpad de verdade.
 */
function pontefalsa({ aprovarEm = 1 } = {}) {
  const pagamentos = new Map();
  let proximo = 1;
  const servidor = http.createServer((req, res) => {
    const partes = req.url.split('/').filter(Boolean);
    const responder = (codigo, corpo) => {
      res.writeHead(codigo, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(corpo));
    };
    let corpo = '';
    req.on('data', (p) => { corpo += p; });
    req.on('end', () => {
      if (req.method === 'GET' && partes[0] === 'status') return responder(200, { status: 'ok', mensagem: 'Pinpad conectado' });
      if (req.method === 'POST' && partes[0] === 'pagamento' && partes.length === 1) {
        const pedido = JSON.parse(corpo || '{}');
        const id = String(proximo++);
        // Guarda quantas consultas faltam até a maquininha "ler o cartão".
        pagamentos.set(id, { id, restam: aprovarEm, pedido, status: 'pendente' });
        return responder(201, { id, status: 'pendente' });
      }
      if (partes[0] === 'pagamento' && partes[2] === 'cancelar' && req.method === 'POST') {
        const p = pagamentos.get(partes[1]);
        if (!p) return responder(404, { erro: 'não encontrado' });
        p.status = 'cancelada';
        return responder(200, { status: 'cancelada', mensagem: 'Operação cancelada no pinpad' });
      }
      if (req.method === 'GET' && partes[0] === 'pagamento') {
        const p = pagamentos.get(partes[1]);
        if (!p) return responder(404, { erro: 'não encontrado' });
        if (p.status === 'pendente' && --p.restam <= 0) {
          p.status = p.pedido.valor_centavos === 666 ? 'negada' : 'aprovada';
          p.nsu = '998877';
          p.autorizacao = '123456';
          p.bandeira = 'Mastercard';
        }
        return responder(200, { id: p.id, status: p.status, nsu: p.nsu, autorizacao: p.autorizacao, bandeira: p.bandeira, mensagem: p.mensagem });
      }
      return responder(404, { erro: 'rota desconhecida' });
    });
  });
  return servidor;
}

module.exports = { pontefalsa };
