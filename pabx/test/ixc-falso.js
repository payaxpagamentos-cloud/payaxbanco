'use strict';

const http = require('node:http');

/** IXC de mentira: responde aos recursos que a ZOE usa e guarda o que foi pedido. */
async function ixcFalso() {
  const estado = {
    token: '7:segredo-do-ixc',
    lento: false,
    clientes: [
      { id: '10', razao: 'MARIA DA SILVA', cnpj_cpf: '529.982.247-25', data_nascimento: '1990-03-05', fone: '', telefone_celular: '(11) 98765-4321', whatsapp: '', email: 'maria@exemplo.com', ativo: 'S' },
      { id: '11', razao: 'JOÃO SOUZA', cnpj_cpf: '111.444.777-35', data_nascimento: '0000-00-00', fone: '(11) 3322-1100', telefone_celular: '', whatsapp: '', email: '', ativo: 'S' },
    ],
    contratos: [
      { id: '100', id_cliente: '10', contrato: '300 MEGA', status: 'A', status_internet: 'CA' },
      { id: '110', id_cliente: '11', contrato: '100 MEGA', status: 'A', status_internet: 'A' },
    ],
    faturas: [
      { id: '900', id_cliente: '10', id_contrato: '100', data_vencimento: '2026-10-10', valor: '99.90', valor_aberto: '99.90', status: 'A' },
      { id: '901', id_cliente: '10', id_contrato: '100', data_vencimento: '2026-11-10', valor: '99.90', valor_aberto: '99.90', status: 'A' },
      { id: '899', id_cliente: '10', id_contrato: '100', data_vencimento: '2026-09-10', valor: '99.90', valor_aberto: '0', status: 'R' },
    ],
    pedidos: [],
  };
  const campo = (q) => q.split('.').pop();
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const enviar = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== `Basic ${Buffer.from(estado.token).toString('base64')}`) return enviar(401, { type: 'error', message: 'Token inválido' });
      const recurso = req.url.replace('/webservice/v1/', '');
      const b = JSON.parse(corpo || '{}');
      estado.pedidos.push({ recurso, corpo: b, listar: req.headers.ixcsoft === 'listar' });
      const responder = () => {
        const tabela = { cliente: estado.clientes, cliente_contrato: estado.contratos, fn_areceber: estado.faturas }[recurso];
        if (tabela) {
          const k = campo(b.qtype);
          const q = String(b.query);
          const regs = tabela.filter((x) => (b.oper === 'L' ? String(x[k] ?? '').includes(q) : b.oper === '>' ? Number(x[k]) > Number(q) : String(x[k]) === q));
          return enviar(200, { page: '1', total: String(regs.length), registros: regs.slice(0, Number(b.rp)) });
        }
        if (recurso === 'get_boleto') return enviar(200, b.tipo_boleto === 'arquivo' ? { base64: 'JVBERi0x' } : { tipo: 'sucesso', mensagem: 'Enviado' });
        if (recurso === 'desbloqueio_confianca') {
          const c = estado.contratos.find((x) => x.id === b.id);
          if (!c || c.status_internet !== 'CA') return enviar(200, { tipo: 'erro', mensagem: 'Contrato não pode ser desbloqueado.' });
          c.status_internet = 'A';
          return enviar(200, { tipo: 'sucesso', mensagem: 'Desbloqueio efetuado por 3 dias.' });
        }
        return enviar(404, { type: 'error', message: 'Recurso não encontrado' });
      };
      if (estado.lento) setTimeout(responder, 3500); else responder();
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  return { estado, url: `http://127.0.0.1:${servidor.address().port}`, fechar: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(r); }) };
}

module.exports = { ixcFalso };
