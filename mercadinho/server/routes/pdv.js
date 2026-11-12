'use strict';

const QRCode = require('qrcode');
const { Router } = require('express');
const { lerConfig } = require('../db');
const vendas = require('../lib/vendas');
const produtos = require('../lib/produtos');
const maquininha = require('../lib/maquininha');
const pix = require('../lib/pix');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { intervalo } = require('../lib/datas');
const v = require('../lib/validacao');

/** Frente de caixa: carrinho, pagamentos, maquininha, PIX e cupom. */
module.exports = (db, { gestao }) => {
  const r = Router();
  const idDaRota = (req) => v.inteiro(req.params.id, 'a venda', { min: 1 });

  /** Venda em andamento do operador (o PDV reabre no mesmo carrinho se a página for recarregada). */
  r.get('/venda', (req, res) => {
    const aberta = db.prepare("SELECT id FROM vendas WHERE usuario_id = ? AND status = 'aberta' ORDER BY id DESC").get(req.usuario.id);
    res.json(aberta ? vendas.obter(db, aberta.id) : null);
  });

  r.post('/venda', (req, res) => res.status(201).json(vendas.abrir(db, {
    usuario_id: req.usuario.id,
    morador_id: req.body.morador_id ? v.inteiro(req.body.morador_id, 'o morador', { min: 1 }) : null,
  })));

  r.get('/vendas', (req, res) => {
    const [de, ate] = req.query.de && req.query.ate ? intervalo(v.data(req.query.de, 'a data inicial'), v.data(req.query.ate, 'a data final')) : [null, null];
    res.json(vendas.listar(db, {
      status: req.query.status || null,
      caixa_id: req.query.caixa_id ? Number(req.query.caixa_id) : null,
      morador_id: req.query.morador_id ? Number(req.query.morador_id) : null,
      de, ate,
      limite: Math.min(Number(req.query.limite) || 100, 500),
    }));
  });

  r.get('/vendas/:id', (req, res) => res.json(vendas.obter(db, idDaRota(req))));
  r.get('/vendas/:id/cupom', (req, res) => res.json(vendas.cupom(db, idDaRota(req))));

  /** Adiciona pelo id do produto ou pelo código bipado no leitor. */
  r.post('/vendas/:id/itens', (req, res) => {
    const d = req.body;
    let produto_id = d.produto_id ? v.inteiro(d.produto_id, 'o produto', { min: 1 }) : null;
    if (!produto_id && d.codigo) {
      const achados = produtos.buscarParaVenda(db, d.codigo);
      if (achados.length !== 1) throw new ErroNegocio(achados.length ? 'Mais de um produto encontrado: escolha na lista.' : 'Produto não encontrado.', 404);
      produto_id = achados[0].id;
    }
    if (!produto_id) throw new ErroNegocio('Informe o produto.', 422);
    res.status(201).json(vendas.adicionarItem(db, idDaRota(req), {
      produto_id,
      qtd_mil: d.quantidade === undefined ? 1000 : v.quantidade(d.quantidade),
      preco_centavos: v.centavosOpcional(d.preco, 'o preço'),
      desconto_centavos: v.centavosOpcional(d.desconto, 'o desconto') ?? 0,
    }));
  });

  r.patch('/vendas/:id/itens/:item', (req, res) => res.json(vendas.alterarItem(db, idDaRota(req), Number(req.params.item), {
    qtd_mil: req.body.quantidade === undefined ? null : v.quantidade(req.body.quantidade),
    preco_centavos: v.centavosOpcional(req.body.preco, 'o preço'),
    desconto_centavos: v.centavosOpcional(req.body.desconto, 'o desconto'),
  })));

  r.delete('/vendas/:id/itens/:item', (req, res) => res.json(vendas.removerItem(db, idDaRota(req), Number(req.params.item))));

  r.patch('/vendas/:id', (req, res) => {
    const id = idDaRota(req);
    if (req.body.morador_id !== undefined) vendas.definirMorador(db, id, req.body.morador_id ? v.inteiro(req.body.morador_id, 'o morador', { min: 1 }) : null);
    if (req.body.desconto !== undefined) vendas.aplicarDesconto(db, id, v.centavos(req.body.desconto, 'o desconto'));
    res.json(vendas.obter(db, id));
  });

  r.post('/vendas/:id/finalizar', (req, res) => {
    const lista = (Array.isArray(req.body.pagamentos) ? req.body.pagamentos : []).map((p) => ({
      forma: v.opcao(p.forma, 'a forma de pagamento', vendas.FORMAS),
      valor_centavos: v.centavos(p.valor, 'o valor do pagamento', { min: 0.01 }),
      recebido_centavos: v.centavosOpcional(p.recebido, 'o valor recebido'),
      transacao_id: p.transacao_id ? v.inteiro(p.transacao_id, 'a cobrança no cartão', { min: 1 }) : null,
    }));
    const venda = vendas.finalizar(db, idDaRota(req), { pagamentos: lista, usuario_id: req.usuario.id });
    registrar(db, req, 'venda_finalizada', `#${venda.id} total ${venda.total_centavos}`);
    res.json(venda);
  });

  r.post('/vendas/:id/cancelar', (req, res) => {
    const id = idDaRota(req);
    const venda = db.prepare('SELECT status FROM vendas WHERE id = ?').get(id);
    // Cancelar uma venda já paga mexe em estoque e em dinheiro: só a gestão pode.
    if (venda?.status === 'paga' && !['admin', 'gerente'].includes(req.usuario.perfil)) {
      throw new ErroNegocio('Só a gestão pode cancelar uma venda já finalizada.', 403);
    }
    const cancelada = vendas.cancelar(db, id, { motivo: v.texto(req.body.motivo, 'o motivo', 300), usuario_id: req.usuario.id });
    registrar(db, req, 'venda_cancelada', `#${cancelada.id}: ${cancelada.motivo_cancelamento}`);
    res.json(cancelada);
  });

  /** PIX "copia e cola" com o valor que falta na venda, e o QR Code em imagem. */
  r.post('/vendas/:id/pix', async (req, res) => {
    const venda = vendas.obter(db, idDaRota(req));
    const cfg = lerConfig(db);
    if (!cfg.pix_chave) throw new ErroNegocio('Cadastre a chave PIX do mercadinho nas configurações.', 409);
    const valor = v.centavosOpcional(req.body.valor, 'o valor') ?? (venda.falta_centavos || venda.total_centavos);
    const codigo = pix.copiaECola({
      chave: cfg.pix_chave, recebedor: cfg.pix_recebedor, cidade: cfg.pix_cidade,
      valorCentavos: valor, txid: `VENDA${venda.id}`, descricao: `Venda ${venda.id}`,
    });
    res.json({ valor_centavos: valor, copia_e_cola: codigo, qrcode: await QRCode.toDataURL(codigo, { margin: 1, width: 320 }) });
  });

  r.get('/maquininhas', (_req, res) => res.json(db.prepare('SELECT id, nome, provedor, identificador, taxa_debito_bp, taxa_credito_bp, taxa_parcelado_bp, prazo_debito_dias, prazo_credito_dias FROM maquininhas WHERE ativa = 1 ORDER BY nome').all()));

  /** Manda a cobrança para a maquininha. Com a ponte TEF ou o Mercado Pago, a resposta volta 'pendente': consulte depois. */
  r.post('/vendas/:id/cartao', async (req, res) => {
    const venda = vendas.obter(db, idDaRota(req));
    if (venda.status !== 'aberta') throw new ErroNegocio('Esta venda já foi finalizada.', 409);
    const forma = v.opcao(req.body.forma, 'a forma', ['debito', 'credito']);
    const t = await maquininha.cobrar(db, {
      maquininha_id: v.inteiro(req.body.maquininha_id, 'a maquininha', { min: 1 }),
      venda_id: venda.id,
      forma,
      parcelas: v.inteiro(req.body.parcelas ?? 1, 'as parcelas', { min: 1, max: 12 }),
      valor_centavos: v.centavosOpcional(req.body.valor, 'o valor') ?? (venda.falta_centavos || venda.total_centavos),
    });
    registrar(db, req, 'cartao_cobranca', `venda #${venda.id} ${forma} ${t.status}`);
    res.status(201).json(t);
  });

  r.get('/cartao/:id', async (req, res) => res.json(await maquininha.consultar(db, v.inteiro(req.params.id, 'a cobrança', { min: 1 }))));

  r.post('/cartao/:id/cancelar', async (req, res) => {
    const t = await maquininha.cancelar(db, v.inteiro(req.params.id, 'a cobrança', { min: 1 }), v.opcional(req.body.motivo, 'o motivo', 200) ?? 'Cancelada pelo caixa');
    registrar(db, req, 'cartao_cancelado', `#${t.id}`);
    res.json(t);
  });

  r.get('/cartao', gestao, (req, res) => res.json(maquininha.listar(db, { status: req.query.status || null, limite: Math.min(Number(req.query.limite) || 100, 500) })));

  return r;
};
