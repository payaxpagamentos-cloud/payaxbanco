'use strict';

const http = require('node:http');

/** IXC de mentira: responde aos recursos que o PDV usa (clientes, contratos, contas a receber e a baixa). */
async function ixcFalso() {
  const estado = {
    token: '7:segredo-do-ixc',
    lento: false,
    recusarBaixa: null, // mensagem de erro para a próxima baixa, quando se quer testar a falha
    clientes: [
      { id: '10', razao: 'MARIA DA SILVA', cnpj_cpf: '529.982.247-25', fone: '', telefone_celular: '(11) 98765-4321', email: 'maria@exemplo.com', ativo: 'S' },
      { id: '11', razao: 'JOAO SOUZA', cnpj_cpf: '111.444.777-35', fone: '(11) 3322-1100', telefone_celular: '', email: '', ativo: 'S' },
    ],
    contratos: [
      { id: '100', id_cliente: '10', contrato: '300 MEGA', status: 'A', status_internet: 'CA' },
      { id: '110', id_cliente: '11', contrato: '100 MEGA', status: 'A', status_internet: 'A' },
    ],
    faturas: [
      { id: '900', id_cliente: '10', id_contrato: '100', documento: '900/1', data_vencimento: '2026-10-10', valor: '99.90', valor_aberto: '99.90', status: 'A' },
      { id: '901', id_cliente: '10', id_contrato: '100', documento: '901/1', data_vencimento: '2026-11-10', valor: '99.90', valor_aberto: '99.90', status: 'A' },
      { id: '902', id_cliente: '11', id_contrato: '110', documento: '902/1', data_vencimento: '2026-11-10', valor: '150.00', valor_aberto: '150.00', status: 'A' },
    ],
    pedidos: [],
  };
  const campo = (q) => String(q ?? '').split('.').pop();
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const enviar = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== `Basic ${Buffer.from(estado.token).toString('base64')}`) return enviar(401, { type: 'error', message: 'Token inválido' });
      const caminho = req.url.replace('/webservice/v1/', '');
      const [recurso, id] = caminho.split('/');
      const b = JSON.parse(corpo || '{}');
      estado.pedidos.push({ recurso, id, metodo: req.method, corpo: b, listar: req.headers.ixcsoft === 'listar' });
      const responder = () => {
        if (req.method === 'PUT' && recurso === 'fn_areceber') {
          if (estado.recusarBaixa) {
            const msg = estado.recusarBaixa;
            estado.recusarBaixa = null;
            return enviar(200, { type: 'error', message: msg });
          }
          const f = estado.faturas.find((x) => x.id === String(id));
          if (!f) return enviar(200, { type: 'error', message: 'Registro não encontrado' });
          Object.assign(f, {
            status: b.status,
            data_pagamento: b.data_pagamento || '',
            valor_recebido: b.valor_recebido ?? '0.00',
            valor_aberto: b.valor_aberto ?? f.valor_aberto,
          });
          return enviar(200, { type: 'success', message: 'Registro alterado com sucesso' });
        }
        const tabela = { cliente: estado.clientes, cliente_contrato: estado.contratos, fn_areceber: estado.faturas }[recurso];
        if (tabela) {
          const k = campo(b.qtype);
          const q = String(b.query);
          const regs = tabela.filter((x) => {
            const valor = String(x[k] ?? '');
            if (b.oper === 'L') return valor.toUpperCase().includes(q.toUpperCase());
            if (b.oper === '>') return Number(valor) > Number(q);
            if (b.oper === 'B') { const [de, ate] = q.split(','); return valor >= de && valor <= ate; }
            return valor === q;
          });
          return enviar(200, { page: '1', total: String(regs.length), registros: regs.slice(0, Number(b.rp) || 20) });
        }
        return enviar(404, { type: 'error', message: 'Recurso não encontrado' });
      };
      if (estado.lento) setTimeout(responder, 9000); else responder();
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  return {
    estado,
    url: `http://127.0.0.1:${servidor.address().port}`,
    token: estado.token,
    fechar: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(r); }),
  };
}

module.exports = { ixcFalso };
