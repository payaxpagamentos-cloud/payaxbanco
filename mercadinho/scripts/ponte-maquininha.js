'use strict';

/**
 * Ponte TEF — exemplo de agente para rodar NO COMPUTADOR DO CAIXA, junto da maquininha/pinpad.
 *
 * O sistema do mercadinho (provedor "ponte") conversa com este agente por HTTP:
 *
 *   POST /pagamento                   { valor_centavos, forma, parcelas, referencia }
 *        -> { id, status: "pendente" }
 *   GET  /pagamento/{id}              -> { id, status, nsu, autorizacao, bandeira, mensagem }
 *   POST /pagamento/{id}/cancelar     -> { status: "cancelada" }
 *   GET  /status                      -> { status: "ok", mensagem }
 *
 * status pode ser: pendente, aprovada, negada ou cancelada.
 *
 * Onde entra a maquininha de verdade: troque o conteúdo das funções
 * iniciarNoPinpad / consultarNoPinpad / cancelarNoPinpad pelas chamadas do SDK da sua
 * adquirente (PayGo/Elgin, Stone, Cielo LIO, Getnet...). O resto não muda.
 *
 * Uso:   node scripts/ponte-maquininha.js            (porta 9090)
 *        PORTA=9100 TOKEN=segredo node scripts/ponte-maquininha.js
 *
 * No sistema: Configurações > Maquininhas > tipo "Ponte TEF", endereço http://127.0.0.1:9090
 * e, se usar TOKEN, o mesmo valor no campo Token.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const PORTA = Number(process.env.PORTA) || 9090;
const TOKEN = process.env.TOKEN || '';
const pagamentos = new Map();

/* ------------------------------------------------------------------ *
 * Aqui entra o SDK do pinpad. Este exemplo apenas simula a leitura do
 * cartão depois de alguns segundos, para o fluxo poder ser testado.
 * ------------------------------------------------------------------ */
function iniciarNoPinpad(pedido) {
  const id = crypto.randomUUID();
  const registro = { id, pedido, status: 'pendente', criado_em: Date.now() };
  pagamentos.set(id, registro);
  console.log(`[ponte] cobrança ${id}: ${(pedido.valor_centavos / 100).toFixed(2)} em ${pedido.forma} (${pedido.parcelas}x)`);
  return registro;
}

function consultarNoPinpad(registro) {
  // Troque por: leitura do estado da transação no SDK.
  if (registro.status === 'pendente' && Date.now() - registro.criado_em > 6000) {
    registro.status = 'aprovada';
    registro.nsu = String(crypto.randomInt(100_000, 999_999));
    registro.autorizacao = String(crypto.randomInt(100_000, 999_999));
    registro.bandeira = 'Visa';
    console.log(`[ponte] cobrança ${registro.id} aprovada (NSU ${registro.nsu})`);
  }
  return registro;
}

function cancelarNoPinpad(registro) {
  // Troque por: cancelamento/abortar operação no SDK.
  if (registro.status === 'pendente') registro.status = 'cancelada';
  return registro;
}
/* ------------------------------------------------------------------ */

const responder = (res, codigo, corpo) => {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
};

const publico = (r) => ({ id: r.id, status: r.status, nsu: r.nsu, autorizacao: r.autorizacao, bandeira: r.bandeira, mensagem: r.mensagem });

const servidor = http.createServer((req, res) => {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return responder(res, 401, { erro: 'Token inválido.' });
  const partes = req.url.split('?')[0].split('/').filter(Boolean);
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    try {
      if (req.method === 'GET' && partes[0] === 'status') return responder(res, 200, { status: 'ok', mensagem: 'Pinpad conectado' });

      if (req.method === 'POST' && partes[0] === 'pagamento' && partes.length === 1) {
        const pedido = JSON.parse(corpo || '{}');
        if (!pedido.valor_centavos || pedido.valor_centavos <= 0) return responder(res, 400, { erro: 'Valor inválido.' });
        return responder(res, 201, publico(iniciarNoPinpad(pedido)));
      }

      const registro = partes[0] === 'pagamento' ? pagamentos.get(partes[1]) : null;
      if (partes[0] === 'pagamento' && !registro) return responder(res, 404, { erro: 'Cobrança não encontrada.' });

      if (req.method === 'GET' && partes[0] === 'pagamento') return responder(res, 200, publico(consultarNoPinpad(registro)));
      if (req.method === 'POST' && partes[2] === 'cancelar') return responder(res, 200, publico(cancelarNoPinpad(registro)));

      return responder(res, 404, { erro: 'Rota desconhecida.' });
    } catch (err) {
      return responder(res, 500, { erro: err.message });
    }
  });
});

servidor.listen(PORTA, '127.0.0.1', () => {
  console.log(`[ponte] ouvindo em http://127.0.0.1:${PORTA}${TOKEN ? ' (com token)' : ''}`);
  console.log('[ponte] cadastre este endereço em Configurações > Maquininhas, tipo "Ponte TEF".');
});
