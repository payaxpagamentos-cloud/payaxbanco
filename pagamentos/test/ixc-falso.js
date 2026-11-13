'use strict';

/** IXC de mentira para os testes: responde ao /webservice/v1/ com alguns clientes e títulos em aberto. */
const http = require('node:http');

function criarIxcFalso({ titulos = null, clientes = null } = {}) {
  const chamadas = [];
  const baseTitulos = titulos ?? [
    { id: '101', id_cliente: '9001', documento: 'NF-5001', valor: '129,90', data_vencimento: '2026-12-15', status: 'A' },
    { id: '102', id_cliente: '9002', documento: 'NF-5002', valor: '89,90', data_vencimento: '2026-12-16', status: 'A' },
    { id: '103', id_cliente: '9001', documento: 'NF-5003', valor: '129,90', data_vencimento: '2026-12-20', status: 'R' },
    { id: '104', id_cliente: '9003', documento: 'NF-5004', valor: '59,90', data_vencimento: '2026-12-18', status: 'A' },
  ];
  const baseClientes = clientes ?? {
    9001: { id: '9001', razao: 'João da Silva', cnpj_cpf: '111.444.777-35', email: 'joao@teste.local', telefone_celular: '13991234567', cidade_nome: 'Santos', estado: 'SP', cep: '11010000', endereco: 'Rua A', numero: '10', bairro: 'Centro' },
    9002: { id: '9002', razao: 'Maria Souza', cnpj_cpf: '529.982.247-25', email: 'maria@teste.local', cidade_nome: 'Praia Grande', estado: 'SP' },
    9003: { id: '9003', razao: 'Sem Documento LTDA', cnpj_cpf: '', email: '' },
  };

  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const dados = corpo ? JSON.parse(corpo) : {};
      const recurso = req.url.replace('/webservice/v1/', '').split('/')[0];
      chamadas.push({ metodo: req.method, recurso, url: req.url, dados, listar: req.headers.ixcsoft === 'listar' });
      res.setHeader('Content-Type', 'application/json');

      if (!String(req.headers.authorization ?? '').startsWith('Basic ')) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ type: 'error', message: 'token inválido' }));
      }
      if (req.method === 'PUT') return res.end(JSON.stringify({ type: 'success', message: 'Registro alterado' }));

      if (recurso === 'cliente') {
        const id = String(dados.query ?? '');
        if (dados.oper === '>') return res.end(JSON.stringify({ page: '1', total: 3, registros: [baseClientes[9001]] }));
        const c = baseClientes[id];
        return res.end(JSON.stringify({ page: '1', total: c ? 1 : 0, registros: c ? [c] : [] }));
      }
      if (recurso === 'fn_areceber') {
        const [de, ate] = String(dados.query ?? '').split(',');
        const lista = baseTitulos.filter((x) => (!de || x.data_vencimento >= de) && (!ate || x.data_vencimento <= ate));
        return res.end(JSON.stringify({ page: '1', total: lista.length, registros: lista }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ type: 'error', message: 'recurso desconhecido' }));
    });
  });

  return {
    chamadas,
    async iniciar() {
      servidor.listen(0, '127.0.0.1');
      await new Promise((r) => servidor.once('listening', r));
      return `http://127.0.0.1:${servidor.address().port}`;
    },
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

module.exports = { criarIxcFalso };
