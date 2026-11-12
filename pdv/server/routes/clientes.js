'use strict';

const { Router } = require('express');
const { clienteIxc } = require('../lib/ixcEmpresa');
const { comAcrescimo } = require('../lib/recebimentos');
const { ErroNegocio } = require('../lib/erros');
const { digitos } = require('../lib/ixc');
const v = require('../lib/validacao');

/** Busca de clientes e faturas no IXC (/api/empresas/:eid/clientes). É só leitura: o balcão consulta o IXC ao vivo. */
module.exports = (db) => {
  const r = Router({ mergeParams: true });

  // /clientes?busca=...&tipo=auto|documento|nome|telefone|codigo
  r.get('/', async (req, res) => {
    const busca = v.texto(req.query.busca, 'o que procurar', 120);
    const tipo = v.opcao(req.query.tipo ?? 'auto', 'o tipo de busca', ['auto', 'documento', 'nome', 'telefone', 'codigo']);
    const { ixc } = clienteIxc(db, req.empresa.id);
    const d = digitos(busca);
    let clientes = [];
    if (tipo === 'documento' || (tipo === 'auto' && (d.length === 11 || d.length === 14))) {
      clientes = await ixc.clientesPorDocumento(d);
    } else if (tipo === 'codigo' || (tipo === 'auto' && /^\d{1,9}$/.test(busca.trim()) && d.length < 10)) {
      const c = await ixc.clientePorId(busca.trim());
      clientes = c ? [c] : [];
    } else if (tipo === 'telefone' || (tipo === 'auto' && d.length >= 10 && d.length <= 13)) {
      clientes = await ixc.clientesPorTelefone(d);
    } else {
      v.exigir(busca.trim().length >= 3, 'Digite pelo menos 3 letras do nome.');
      clientes = await ixc.clientesPorNome(busca);
    }
    res.json({ clientes: clientes.slice(0, 30) });
  });

  // Cliente escolhido: contratos, faturas em aberto (já com multa e juros) e o que ele pagou no PDV.
  r.get('/:id', async (req, res) => {
    const id = v.texto(req.params.id, 'o código do cliente', 20);
    const { ixc } = clienteIxc(db, req.empresa.id);
    const cliente = await ixc.clientePorId(id);
    if (!cliente) throw new ErroNegocio('Cliente não encontrado no IXC.', 404);
    const [contratos, faturas] = await Promise.all([ixc.contratos(id), ixc.faturasAbertas(id)]);
    res.json({
      cliente,
      contratos,
      faturas: comAcrescimo(db, req.empresa.id, faturas),
      ultimos_recebimentos: db.prepare(`SELECT id, numero, data, valor_centavos, status, ixc_status FROM recebimentos
        WHERE empresa_id = ? AND cliente_ixc_id = ? ORDER BY id DESC LIMIT 10`).all(req.empresa.id, id),
    });
  });

  return r;
};
