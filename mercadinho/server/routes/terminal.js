'use strict';

const QRCode = require('qrcode');
const { Router } = require('express');
const { lerConfig } = require('../db');
const { emitirTokenTerminal, autenticarTerminal } = require('../auth');
const terminalLib = require('../lib/terminal');
const vendas = require('../lib/vendas');
const produtos = require('../lib/produtos');
const maquininha = require('../lib/maquininha');
const pix = require('../lib/pix');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const v = require('../lib/validacao');

/**
 * Rotas do terminal do balcão — a única tela que o cliente usa.
 * Não há login de funcionário aqui: o aparelho é pareado uma vez e só consegue fazer o que a
 * compra exige (ler produtos, montar o carrinho, cobrar e fechar a própria venda).
 */
module.exports = (db) => {
  const r = Router();

  /** Pareamento: o aparelho troca o código da administração por um token só dele. */
  r.post('/parear', (req, res) => {
    const terminal = terminalLib.parear(db, req.body.codigo, req.ip);
    res.status(201).json({ token: emitirTokenTerminal(terminal), terminal: { id: terminal.id, nome: terminal.nome } });
  });

  // Daqui para baixo, só com o token do terminal.
  const terminal = autenticarTerminal(db);
  r.use(terminal);

  /** O que a tela precisa saber ao ligar: nome da loja, formas aceitas e maquininhas. */
  r.get('/inicio', (req, res) => {
    const cfg = lerConfig(db);
    res.json({
      terminal: { id: req.terminal.id, nome: req.terminal.nome },
      mercado: { nome: cfg.nome_mercado, condominio: cfg.condominio },
      formas: terminalLib.formasDisponiveis(db),
      maquininhas: db.prepare('SELECT id, nome FROM maquininhas WHERE ativa = 1 ORDER BY nome').all(),
      segundos_fim: cfg.terminal_segundos_fim,
    });
  });

  /** Busca de produto pelo código bipado ou pelo nome (só o que está à venda). */
  r.get('/produtos', (req, res) => res.json(produtos.buscarParaVenda(db, req.query.termo).map((p) => ({
    id: p.id, nome: p.nome, codigo_barras: p.codigo_barras, unidade: p.unidade, pesavel: p.pesavel, foto: p.foto,
    preco_centavos: p.preco_vigente_centavos, preco_cheio_centavos: p.em_oferta ? p.preco_centavos : null,
  }))));

  /** Produtos sem código de barras (hortifrúti, padaria, granel): o cliente escolhe na tela. */
  r.get('/produtos/sem-codigo', (_req, res) => res.json(db.prepare(`SELECT p.id, p.nome, p.unidade, p.pesavel, p.preco_centavos, p.foto,
      p.oferta_preco_centavos, p.oferta_ate, c.nome AS categoria, c.cor AS cor
    FROM produtos p LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.ativo = 1 AND (p.codigo_barras IS NULL OR p.codigo_barras = '') ORDER BY c.nome, p.nome LIMIT 80`).all()
    .map(({ oferta_preco_centavos, oferta_ate, ...p }) => {
      const oferta = produtos.emOferta({ ...p, oferta_preco_centavos, oferta_ate });
      return { ...p, preco_centavos: oferta ? oferta_preco_centavos : p.preco_centavos, preco_cheio_centavos: oferta ? p.preco_centavos : null };
    })));

  /** A venda em andamento neste terminal (o cliente pode ter dado um refresh sem querer). */
  const vendaDoTerminal = (req, { aberta = true } = {}) => {
    const id = v.inteiro(req.params.id, 'a compra', { min: 1 });
    const venda = vendas.obter(db, id);
    if (venda.terminal_id !== req.terminal.id) throw naoEncontrado('Compra');
    if (aberta && venda.status !== 'aberta') throw new ErroNegocio('Esta compra já foi encerrada.', 409);
    return venda;
  };

  r.get('/venda', (req, res) => {
    const aberta = db.prepare("SELECT id FROM vendas WHERE terminal_id = ? AND status = 'aberta' ORDER BY id DESC").get(req.terminal.id);
    res.json(aberta ? vendas.obter(db, aberta.id) : null);
  });

  r.post('/venda', (req, res) => res.status(201).json(vendas.abrir(db, { terminal_id: req.terminal.id, origem: 'autoatendimento' })));

  r.post('/venda/:id/itens', (req, res) => {
    const venda = vendaDoTerminal(req);
    const d = req.body;
    let produto_id = d.produto_id ? v.inteiro(d.produto_id, 'o produto', { min: 1 }) : null;
    if (!produto_id && d.codigo) {
      const achados = produtos.buscarParaVenda(db, d.codigo);
      if (achados.length !== 1) throw new ErroNegocio(achados.length ? 'Mais de um produto com esse nome: escolha na lista.' : 'Produto não encontrado. Chame a administração.', 404);
      produto_id = achados[0].id;
    }
    if (!produto_id) throw new ErroNegocio('Informe o produto.', 422);
    res.status(201).json(vendas.adicionarItem(db, venda.id, {
      produto_id,
      qtd_mil: d.quantidade === undefined ? 1000 : v.quantidade(d.quantidade),
    }));
  });

  r.patch('/venda/:id/itens/:item', (req, res) => {
    const venda = vendaDoTerminal(req);
    res.json(vendas.alterarItem(db, venda.id, Number(req.params.item), { qtd_mil: v.quantidade(req.body.quantidade) }));
  });

  r.delete('/venda/:id/itens/:item', (req, res) => {
    const venda = vendaDoTerminal(req);
    res.json(vendas.removerItem(db, venda.id, Number(req.params.item)));
  });

  /** O cliente desistiu: a compra é cancelada e a tela volta ao início. */
  r.post('/venda/:id/cancelar', (req, res) => {
    const venda = vendaDoTerminal(req);
    res.json(vendas.cancelar(db, venda.id, { motivo: 'Cancelada pelo cliente no terminal', usuario_id: null }));
  });

  /* ---------- conta do morador ---------- */

  /** Moradores de uma unidade: o cliente digita o apartamento, não escolhe numa lista de todo mundo. */
  r.get('/unidade/:unidade/moradores', (req, res) => res.json(terminalLib.moradoresDaUnidade(db, req.params.unidade, req.query.bloco || null)));

  /** Confere a senha do morador e deixa a compra pronta para ir na conta dele. */
  r.post('/venda/:id/conta', (req, res) => {
    const venda = vendaDoTerminal(req);
    if (!terminalLib.formasDisponiveis(db).fiado) throw new ErroNegocio('A compra na conta está desligada neste terminal.', 409);
    const morador = terminalLib.identificar(db, { morador_id: v.inteiro(req.body.morador_id, 'o morador', { min: 1 }), pin: req.body.pin });
    vendas.definirMorador(db, venda.id, morador.id);
    res.json({
      venda: vendas.obter(db, venda.id),
      morador: { id: morador.id, nome: morador.nome, bloco: morador.bloco, unidade: morador.unidade, disponivel_centavos: morador.disponivel_centavos },
    });
  });

  /* ---------- pagamento ---------- */

  r.post('/venda/:id/pix', async (req, res) => {
    const venda = vendaDoTerminal(req);
    const cfg = lerConfig(db);
    if (!terminalLib.formasDisponiveis(db).pix) throw new ErroNegocio('O PIX não está disponível neste terminal.', 409);
    const valor = venda.falta_centavos || venda.total_centavos;
    const codigo = pix.copiaECola({
      chave: cfg.pix_chave, recebedor: cfg.pix_recebedor, cidade: cfg.pix_cidade,
      valorCentavos: valor, txid: `VENDA${venda.id}`, descricao: `Compra ${venda.id}`,
    });
    res.json({ valor_centavos: valor, copia_e_cola: codigo, qrcode: await QRCode.toDataURL(codigo, { margin: 1, width: 420 }) });
  });

  r.post('/venda/:id/cartao', async (req, res) => {
    const venda = vendaDoTerminal(req);
    const forma = v.opcao(req.body.forma, 'a forma', ['debito', 'credito']);
    if (!terminalLib.formasDisponiveis(db)[forma]) throw new ErroNegocio('O cartão não está disponível neste terminal.', 409);
    const t = await maquininha.cobrar(db, {
      maquininha_id: v.inteiro(req.body.maquininha_id, 'a maquininha', { min: 1 }),
      venda_id: venda.id,
      forma,
      parcelas: v.inteiro(req.body.parcelas ?? 1, 'as parcelas', { min: 1, max: 12 }),
      valor_centavos: venda.falta_centavos || venda.total_centavos,
    });
    res.status(201).json(t);
  });

  r.get('/cartao/:id', async (req, res) => {
    const id = v.inteiro(req.params.id, 'a cobrança', { min: 1 });
    const t = maquininha.transacaoDe(db, id);
    const venda = t.venda_id ? vendas.obter(db, t.venda_id) : null;
    if (!venda || venda.terminal_id !== req.terminal.id) throw naoEncontrado('Cobrança');
    res.json(await maquininha.consultar(db, id));
  });

  /** Fecha a compra. O terminal nunca recebe dinheiro: não há quem dê troco. */
  r.post('/venda/:id/finalizar', (req, res) => {
    const venda = vendaDoTerminal(req);
    const disponiveis = terminalLib.formasDisponiveis(db);
    const lista = (Array.isArray(req.body.pagamentos) ? req.body.pagamentos : []).map((p) => {
      const forma = v.opcao(p.forma, 'a forma de pagamento', ['pix', 'debito', 'credito', 'fiado']);
      if (!disponiveis[forma]) throw new ErroNegocio('Esta forma de pagamento não está disponível no terminal.', 409);
      return {
        forma,
        valor_centavos: v.centavos(p.valor, 'o valor do pagamento', { min: 0.01 }),
        transacao_id: p.transacao_id ? v.inteiro(p.transacao_id, 'a cobrança no cartão', { min: 1 }) : null,
      };
    });
    res.json(vendas.finalizar(db, venda.id, { pagamentos: lista, usuario_id: null }));
  });

  r.get('/venda/:id/cupom', (req, res) => {
    const venda = vendaDoTerminal(req, { aberta: false });
    res.json(vendas.cupom(db, venda.id));
  });

  return r;
};
