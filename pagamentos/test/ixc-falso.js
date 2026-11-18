'use strict';

/** IXC de mentira para os testes: responde ao /webservice/v1/ com alguns clientes e títulos em aberto. */
const http = require('node:http');

function criarIxcFalso({ titulos = null, clientes = null } = {}) {
  const chamadas = [];
  const baseTitulos = titulos ?? [
    { id: '101', id_carteira_cobranca: '1', filial_id: '1', id_conta: '5', id_cliente: '9001', documento: 'NF-5001', valor: '129,90', data_vencimento: '2026-12-15', status: 'A' },
    { id: '102', id_carteira_cobranca: '1', filial_id: '1', id_conta: '5', id_cliente: '9002', documento: 'NF-5002', valor: '89,90', data_vencimento: '2026-12-16', status: 'A' },
    { id: '103', id_carteira_cobranca: '1', filial_id: '1', id_conta: '5', id_cliente: '9001', documento: 'NF-5003', valor: '129,90', data_vencimento: '2026-12-20', status: 'R' },
    { id: '104', id_carteira_cobranca: '1', filial_id: '1', id_conta: '5', id_cliente: '9003', documento: 'NF-5004', valor: '59,90', data_vencimento: '2026-12-18', status: 'A' },
  ];
  const baseClientes = clientes ?? {
    9001: { id: '9001', razao: 'João da Silva', cnpj_cpf: '111.444.777-35', email: 'joao@teste.local', telefone_celular: '13991234567', cidade_nome: 'Santos', estado: 'SP', cep: '11010000', endereco: 'Rua A', numero: '10', bairro: 'Centro' },
    9002: { id: '9002', razao: 'Maria Souza', cnpj_cpf: '529.982.247-25', email: 'maria@teste.local', cidade_nome: 'Praia Grande', estado: 'SP' },
    9003: { id: '9003', razao: 'Sem Documento LTDA', cnpj_cpf: '', email: '' },
  };

  /** Data DD/MM/AAAA (como o IXC recebe) → AAAA-MM-DD (como ele devolve). */
  const guardar = (v) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})(.*)$/.exec(String(v ?? '')); return m ? `${m[3]}-${m[2]}-${m[1]}${m[4]}` : v; };
  const arquivos = [];
  const baixas = [];
  const opcoes = { aceitaArquivoNoTitulo: false, baixaSemEfeito: false, edicaoEstragaValor: false };

  const servidor = http.createServer((req, res) => {
    const pedacos = [];
    req.on('data', (c) => { pedacos.push(c); });
    req.on('end', () => {
      const bruto = Buffer.concat(pedacos);
      const multipart = /^multipart\/form-data/.test(String(req.headers['content-type'] ?? ''));
      let dados = {};
      if (multipart) {
        // Só o que os testes precisam: os campos de texto e o nome e o começo do arquivo.
        const texto = bruto.toString('latin1');
        for (const m of texto.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r\n]+\r\n)?\r\n([\s\S]*?)\r\n--/g)) {
          dados[m[1]] = m[2] !== undefined ? { nome: m[2], inicio: m[3].slice(0, 5), bytes: m[3].length } : m[3];
        }
      } else if (bruto.length) dados = JSON.parse(bruto.toString('utf8'));
      const partes = req.url.replace('/webservice/v1/', '').split('/');
      const recurso = partes[0];
      const idUrl = partes[1];
      chamadas.push({ metodo: req.method, recurso, url: req.url, dados, listar: req.headers.ixcsoft === 'listar', multipart });
      res.setHeader('Content-Type', 'application/json');

      if (!String(req.headers.authorization ?? '').startsWith('Basic ')) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ type: 'error', message: 'token inválido' }));
      }
      if (req.method === 'PUT') {
        // Alterar boleto (parcial) e editar título (completo): gravam no título o que vier.
        const t = baseTitulos.find((x) => String(x.id) === String(idUrl));
        if (t && (recurso === 'fn_areceber_altera' || recurso === 'fn_areceber')) {
          for (const [k, v] of Object.entries(dados)) if (k !== 'id') t[k] = guardar(v);
          // Para testar a trava de segurança: uma edição completa que mexe em campo que não devia.
          if (recurso === 'fn_areceber' && opcoes.edicaoEstragaValor) t.valor = '9999,00';
        }
        return res.end(JSON.stringify({ type: 'success', message: 'Registro alterado' }));
      }

      if (recurso === 'cliente') {
        const id = String(dados.query ?? '');
        if (dados.oper === '>') return res.end(JSON.stringify({ page: '1', total: 3, registros: [baseClientes[9001]] }));
        const c = baseClientes[id];
        return res.end(JSON.stringify({ page: '1', total: c ? 1 : 0, registros: c ? [c] : [] }));
      }
      if (recurso === 'fn_areceber') {
        if (dados.qtype === 'fn_areceber.id') {
          const t = baseTitulos.find((x) => String(x.id) === String(dados.query));
          return res.end(JSON.stringify({ page: '1', total: t ? 1 : 0, registros: t ? [t] : [] }));
        }
        const [de, ate] = String(dados.query ?? '').split(',');
        const lista = baseTitulos.filter((x) => (!de || x.data_vencimento >= de) && (!ate || x.data_vencimento <= ate));
        // Paginação como a do IXC: page (1, 2, ...) e rp (registros por página); total = todos os que casam.
        const rp = Number(dados.rp || 100); const page = Number(dados.page || 1);
        return res.end(JSON.stringify({ page: String(page), total: lista.length, registros: lista.slice((page - 1) * rp, page * rp) }));
      }
      if (recurso === 'fn_carteira_cobranca') {
        return res.end(JSON.stringify({ page: '1', total: 1, registros: [{ id: String(dados.query), id_conta: '77' }] }));
      }
      if (recurso === 'fn_areceber_recebimentos_baixas_novo') {
        const t = baseTitulos.find((x) => String(x.id) === String(dados.id_receber));
        if (!t) return res.end(JSON.stringify({ type: 'error', message: 'Título não encontrado' }));
        if (!dados.conta_ || !dados.id_conta) return res.end(JSON.stringify({ type: 'error', message: 'Preencha a conta e o planejamento' }));
        baixas.push(dados);
        if (!opcoes.baixaSemEfeito) { t.status = 'R'; t.valor_aberto = '0.00'; t.valor_recebido = String(dados.valor_total_recebido).replace(',', '.'); }
        return res.end(JSON.stringify({ type: 'success', message: 'Recebimento realizado', id: String(baixas.length) }));
      }
      if (recurso === 'cliente_arquivos' || (recurso === 'fn_areceber_arquivos' && opcoes.aceitaArquivoNoTitulo)) {
        arquivos.push({ recurso, ...dados });
        return res.end(JSON.stringify({ type: 'success', message: 'Registro inserido', id: String(arquivos.length) }));
      }
      // O IXC de verdade responde erro com HTTP 200.
      res.end(JSON.stringify({ type: 'error', message: 'Recurso não encontrado' }));
    });
  });

  return {
    chamadas, arquivos, baixas, opcoes, titulos: baseTitulos,
    async iniciar() {
      servidor.listen(0, '127.0.0.1');
      await new Promise((r) => servidor.once('listening', r));
      return `http://127.0.0.1:${servidor.address().port}`;
    },
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

module.exports = { criarIxcFalso };
