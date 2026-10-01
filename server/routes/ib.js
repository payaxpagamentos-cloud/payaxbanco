'use strict';

/* API do Internet Banking: o próprio cliente consulta saldo e movimenta suas contas. */
const crypto = require('node:crypto');
const { Router } = require('express');
const config = require('../config');
const { emitirTokenCliente, autenticarCliente } = require('../auth');
const { hashNumerica, verificarNumerica } = require('../lib/senha');
const { criarDesafio, candidatos, senhaNumericaValida } = require('../lib/teclado');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const v = require('../lib/validacao');
const { registrar } = require('../lib/auditoria');
const { paginacao } = require('../lib/paginacao');
const { buscarConta, exigirContaOperavel } = require('../lib/conta');
const { localizarConta, buscarChaveInterna, transferir, enviarPix, fmt } = require('../lib/movimentos');
const { pagarParcela } = require('../lib/emprestimos');
const favorecidos = require('../lib/favorecidos');
const { lerBoleto, gerarBoletoBancario, gerarConvenio, formatarLinha } = require('../lib/boleto');

const MAX_TENTATIVAS = 5;
const MAX_TENTATIVAS_PIN = 3;
const SAIDAS = "('pix_enviado','transferencia_enviada','pagamento')";

// O cliente não vê o banco que liquida as operações da PAY AX (lançamentos antigos podiam citar o parceiro).
const limparDescricao = (d) => (d ? d.replace(/ via Bradesco/gi, '').replace(/ \(vinculado manualmente\)/i, '') : d);
const limparLancamentos = (itens) => itens.map((t) => ({ ...t, descricao: limparDescricao(t.descricao) }));

const mascararDocumento = (d) => (String(d).length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-**`);
const REGRA_SENHA = 'deve ter 6 números e não pode ser sequência (123456) nem repetição (111111)';

module.exports = (db, bradesco) => {
  const r = Router();
  const F = config.fusoSqlite;
  const acessoPorDocumento = db.prepare(`SELECT a.*, c.nome, c.status AS cliente_status FROM acessos_cliente a
    JOIN clientes c ON c.id = a.cliente_id WHERE c.documento = ?`);

  // ---------- Login ----------
  // Teclado virtual: cada desafio sorteia novos pares e vale para uma única digitação.
  r.post('/auth/teclado', (_req, res) => res.json(criarDesafio(db)));

  r.post('/auth/login', async (req, res) => {
    const documento = v.digitos(req.body?.documento);
    const a = documento && acessoPorDocumento.get(documento);
    const possiveis = candidatos(db, req.body); // consome o desafio mesmo se o documento não existir
    const negar = () => { throw new ErroNegocio('CPF/CNPJ ou senha incorretos.', 401); };
    if (!a) negar();
    if (a.status !== 'ativo' || a.cliente_status !== 'ativo') throw new ErroNegocio('Acesso bloqueado. Procure a PAY AX para desbloquear.', 403);
    if (a.bloqueado_ate && a.bloqueado_ate > db.prepare("SELECT datetime('now') AS n").get().n) {
      throw new ErroNegocio('Muitas tentativas incorretas. Tente novamente em alguns minutos.', 429);
    }
    if (!(await verificarNumerica(possiveis, a.senha_hash))) {
      const t = a.tentativas + 1;
      if (t >= MAX_TENTATIVAS) {
        db.prepare("UPDATE acessos_cliente SET tentativas = 0, bloqueado_ate = datetime('now', '+15 minutes') WHERE id = ?").run(a.id);
        registrar(db, { cliente: { id: a.cliente_id }, ip: req.ip }, 'ib_login_bloqueado', 'cliente', a.cliente_id);
      } else {
        db.prepare('UPDATE acessos_cliente SET tentativas = ? WHERE id = ?').run(t, a.id);
      }
      negar();
    }
    db.prepare("UPDATE acessos_cliente SET tentativas = 0, bloqueado_ate = NULL, ultimo_acesso = datetime('now') WHERE id = ?").run(a.id);
    registrar(db, { cliente: { id: a.cliente_id }, ip: req.ip }, 'ib_login', 'cliente', a.cliente_id);
    res.json({ token: emitirTokenCliente(a.cliente_id), cliente: { nome: a.nome }, precisa_trocar_senha: Boolean(a.precisa_trocar_senha) });
  });

  r.use(autenticarCliente(db));

  // Sem concluir o primeiro acesso (senha definitiva + PIN), só estas rotas ficam liberadas.
  r.use((req, _res, next) => {
    if (req.acesso.precisa_trocar_senha && !['/me', '/auth/primeiro-acesso'].includes(req.path)) {
      return next(new ErroNegocio('Conclua o primeiro acesso: defina sua senha e sua senha de transação.', 403));
    }
    next();
  });

  const acesso = (req) => db.prepare('SELECT * FROM acessos_cliente WHERE id = ?').get(req.acesso.id);

  /** Confere a senha de transação (teclado virtual em req.body.pin). Três erros seguidos bloqueiam o acesso. */
  async function confirmarPin(req) {
    const a = acesso(req);
    if (!a.pin_hash) throw new ErroNegocio('Cadastre sua senha de transação.', 403);
    if (await verificarNumerica(candidatos(db, req.body?.pin), a.pin_hash)) {
      if (a.tentativas_pin) db.prepare('UPDATE acessos_cliente SET tentativas_pin = 0 WHERE id = ?').run(a.id);
      return;
    }
    const t = a.tentativas_pin + 1;
    if (t >= MAX_TENTATIVAS_PIN) {
      db.prepare("UPDATE acessos_cliente SET tentativas_pin = 0, status = 'bloqueado' WHERE id = ?").run(a.id);
      registrar(db, req, 'ib_bloqueio_pin', 'cliente', req.cliente.id);
      throw new ErroNegocio('Senha de transação incorreta 3 vezes. Seu acesso foi bloqueado; procure a PAY AX.', 403);
    }
    db.prepare('UPDATE acessos_cliente SET tentativas_pin = ? WHERE id = ?').run(t, a.id);
    throw new ErroNegocio(`Senha de transação incorreta. Restam ${MAX_TENTATIVAS_PIN - t} tentativa(s).`, 422);
  }

  /** Confere a senha de acesso digitada no teclado virtual (usada para trocar senhas). */
  async function confirmarSenhaAtual(req, entrada) {
    if (!(await verificarNumerica(candidatos(db, entrada), acesso(req).senha_hash))) throw new ErroNegocio('Senha de acesso incorreta.', 422);
  }

  function usoDiario(req) {
    const { usado } = db.prepare(`SELECT COALESCE(-SUM(t.valor_centavos),0) AS usado FROM transacoes t JOIN contas c ON c.id = t.conta_id
      WHERE c.cliente_id = ? AND t.canal = 'internet_banking' AND t.tipo IN ${SAIDAS} AND t.estornada_em IS NULL
        AND date(t.criado_em, ?) = date('now', ?)`).get(req.cliente.id, F, F);
    const { limite_diario_centavos: limite } = acesso(req);
    return { limite_centavos: limite, usado_centavos: usado, disponivel_centavos: Math.max(0, limite - usado) };
  }

  function exigirLimite(req, valor) {
    const u = usoDiario(req);
    if (valor > u.disponivel_centavos) {
      throw new ErroNegocio(`Valor acima do seu limite diário. Disponível hoje: R$ ${(u.disponivel_centavos / 100).toFixed(2).replace('.', ',')}.`, 422);
    }
  }

  /** Conta do próprio cliente; contas de outros clientes respondem como inexistentes. */
  function minhaConta(req, id) {
    const c = db.prepare("SELECT id FROM contas WHERE id = ? AND cliente_id = ? AND status <> 'encerrada'").get(id, req.cliente.id);
    if (!c) throw naoEncontrado('Conta');
    return buscarConta(db, c.id);
  }

  /** Validações comuns a toda saída de dinheiro: conta própria, valor, limite diário e PIN. */
  function prepararSaida(req) {
    const origem = minhaConta(req, req.body?.conta_id);
    exigirContaOperavel(origem);
    const valor = req.body?.valor_centavos === undefined ? null : v.valorCentavos(req.body.valor_centavos);
    return { origem, valor };
  }

  // ---------- Perfil e credenciais ----------
  r.get('/me', (req, res) => {
    const a = acesso(req);
    res.json({
      ...req.cliente,
      documento_mascarado: mascararDocumento(req.cliente.documento),
      precisa_trocar_senha: Boolean(a.precisa_trocar_senha),
      tem_pin: Boolean(a.pin_hash),
      ultimo_acesso: a.ultimo_acesso,
      ambiente_teste: bradesco.status().modo === 'simulador',
    });
  });

  // Senhas novas chegam em dígitos (teclado simples embaralhado), sempre por HTTPS.
  r.post('/auth/primeiro-acesso', async (req, res) => {
    const { nova_senha, pin } = req.body ?? {};
    v.exigir(senhaNumericaValida(nova_senha), `A senha de acesso ${REGRA_SENHA}.`);
    v.exigir(senhaNumericaValida(pin), `A senha de transação ${REGRA_SENHA}.`);
    v.exigir(nova_senha !== pin, 'A senha de transação deve ser diferente da senha de acesso.');
    v.exigir(!(await verificarNumerica([nova_senha], acesso(req).senha_hash)), 'Escolha uma senha diferente da provisória.');
    db.prepare('UPDATE acessos_cliente SET senha_hash = ?, pin_hash = ?, precisa_trocar_senha = 0 WHERE id = ?')
      .run(hashNumerica(nova_senha), hashNumerica(pin), req.acesso.id);
    registrar(db, req, 'ib_primeiro_acesso', 'cliente', req.cliente.id);
    res.json({ ok: true });
  });

  r.post('/auth/senha', async (req, res) => {
    await confirmarSenhaAtual(req, req.body?.senha_atual);
    const nova = req.body?.nova_senha;
    v.exigir(senhaNumericaValida(nova), `A senha de acesso ${REGRA_SENHA}.`);
    v.exigir(!(await verificarNumerica([nova], acesso(req).pin_hash)), 'A senha de acesso deve ser diferente da senha de transação.');
    db.prepare('UPDATE acessos_cliente SET senha_hash = ? WHERE id = ?').run(hashNumerica(nova), req.acesso.id);
    registrar(db, req, 'ib_alterar_senha', 'cliente', req.cliente.id);
    res.json({ ok: true });
  });

  r.post('/auth/pin', async (req, res) => {
    await confirmarSenhaAtual(req, req.body?.senha);
    const novo = req.body?.novo_pin;
    v.exigir(senhaNumericaValida(novo), `A senha de transação ${REGRA_SENHA}.`);
    v.exigir(!(await verificarNumerica([novo], acesso(req).senha_hash)), 'A senha de transação deve ser diferente da senha de acesso.');
    db.prepare('UPDATE acessos_cliente SET pin_hash = ?, tentativas_pin = 0 WHERE id = ?').run(hashNumerica(novo), req.acesso.id);
    registrar(db, req, 'ib_alterar_pin', 'cliente', req.cliente.id);
    res.json({ ok: true });
  });

  // ---------- Saldo e extrato ----------
  r.get('/resumo', (req, res) => {
    const contas = db.prepare("SELECT * FROM contas WHERE cliente_id = ? AND status <> 'encerrada' ORDER BY id").all(req.cliente.id);
    const emprestimos = db.prepare(`SELECT e.id, e.valor_centavos, e.num_parcelas, e.valor_parcela_centavos,
        (SELECT COUNT(*) FROM parcelas p WHERE p.emprestimo_id = e.id AND p.status = 'paga') AS pagas,
        (SELECT MIN(vencimento) FROM parcelas p WHERE p.emprestimo_id = e.id AND p.status = 'aberta') AS proximo_vencimento
      FROM emprestimos e WHERE e.cliente_id = ? AND e.status = 'ativo'`).all(req.cliente.id);
    res.json({ contas, emprestimos, limite: usoDiario(req) });
  });

  r.get('/contas/:id/extrato', (req, res) => {
    const conta = minhaConta(req, req.params.id);
    const { limite, offset, pagina } = paginacao(req.query);
    const filtros = ['t.conta_id = ?'];
    const params = [conta.id];
    if (req.query.inicio) { v.exigir(v.dataValida(req.query.inicio), 'Data inicial inválida.'); filtros.push('date(t.criado_em, ?) >= ?'); params.push(F, req.query.inicio); }
    if (req.query.fim) { v.exigir(v.dataValida(req.query.fim), 'Data final inválida.'); filtros.push('date(t.criado_em, ?) <= ?'); params.push(F, req.query.fim); }
    if (req.query.sentido === 'entradas') filtros.push('t.valor_centavos > 0');
    if (req.query.sentido === 'saidas') filtros.push('t.valor_centavos < 0');
    const where = filtros.join(' AND ');
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM transacoes t WHERE ${where}`).get(...params);
    const itens = db.prepare(`SELECT t.id, t.tipo, t.valor_centavos, t.saldo_apos_centavos, t.descricao, t.criado_em, t.estornada_em,
        clp.nome AS contraparte_nome FROM transacoes t LEFT JOIN contas cp ON cp.id = t.contraparte_conta_id
        LEFT JOIN clientes clp ON clp.id = cp.cliente_id WHERE ${where} ORDER BY t.id DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
    res.json({ conta, itens: limparLancamentos(itens), total, pagina, limite });
  });

  r.get('/comprovantes/:id', (req, res) => {
    const t = db.prepare(`SELECT t.*, c.agencia, c.numero, c.digito, c.cliente_id FROM transacoes t JOIN contas c ON c.id = t.conta_id WHERE t.id = ?`).get(req.params.id);
    if (!t || t.cliente_id !== req.cliente.id) throw naoEncontrado('Comprovante');
    const cp = t.contraparte_conta_id ? buscarConta(db, t.contraparte_conta_id) : null;
    const pixSaida = db.prepare('SELECT chave, end_to_end_id, status FROM pix_saidas WHERE transacao_id = ?').get(t.id);
    const pixEntrada = db.prepare('SELECT end_to_end_id, pagador_nome, pagador_documento FROM pix_recebidos WHERE transacao_id = ?').get(t.id);
    const pagamento = db.prepare('SELECT tipo, linha_digitavel, vencimento, autenticacao FROM pagamentos WHERE transacao_id = ?').get(t.id);
    res.json({
      id: t.id, tipo: t.tipo, valor_centavos: t.valor_centavos, descricao: limparDescricao(t.descricao), criado_em: t.criado_em, estornada_em: t.estornada_em,
      conta: fmt(t), titular: req.cliente.nome, documento: mascararDocumento(req.cliente.documento),
      contraparte: cp ? { nome: cp.cliente_nome, documento: mascararDocumento(cp.cliente_documento), conta: fmt(cp), instituicao: 'PAY AX' } : null,
      pix_saida: pixSaida ? { chave: pixSaida.chave, status: pixSaida.status } : null,
      pix_entrada: pixEntrada ? { pagador_nome: pixEntrada.pagador_nome, pagador_documento: pixEntrada.pagador_documento ? mascararDocumento(pixEntrada.pagador_documento) : null } : null,
      pagamento: pagamento ? { tipo: pagamento.tipo, vencimento: pagamento.vencimento, linha_formatada: formatarLinha(pagamento.linha_digitavel) } : null,
      // Autenticação própria da PAY AX (os identificadores do banco liquidante ficam só com a equipe).
      autenticacao: `PAYAX-${t.grupo.replace(/-/g, '').slice(0, 24).toUpperCase()}`,
    });
  });

  // ---------- Favorecidos (somente consulta; o cadastro é feito pela equipe PAY AX) ----------
  r.get('/favorecidos', (req, res) => {
    res.json(favorecidos.listar(db, req.cliente.id).map((f) => ({
      id: f.id, tipo: f.tipo, apelido: f.apelido, nome: f.nome, chave: f.chave,
      agencia: f.agencia, numero: f.numero ? `${f.numero}-${f.digito}` : null, conta: f.conta,
      documento: f.documento ? mascararDocumento(f.documento) : null,
    })));
  });

  // ---------- PIX ----------
  r.get('/pix/chaves', (req, res) => {
    res.json(db.prepare(`SELECT p.*, c.numero, c.digito FROM chaves_pix p JOIN contas c ON c.id = p.conta_id
      WHERE c.cliente_id = ? ORDER BY p.criado_em`).all(req.cliente.id));
  });

  r.post('/pix/chaves', (req, res) => {
    const conta = minhaConta(req, req.body?.conta_id);
    exigirContaOperavel(conta);
    res.status(201).json(criarChave(req, conta));
  });

  function criarChave(req, conta) {
    const tipo = req.body?.tipo;
    v.exigir(['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'].includes(tipo), 'Tipo de chave inválido.');
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM chaves_pix WHERE conta_id = ?').get(conta.id);
    if (total >= 5) throw new ErroNegocio('Limite de 5 chaves por conta atingido.', 409);
    let chave;
    if (tipo === 'cpf' || tipo === 'cnpj') {
      v.exigir(conta.cliente_documento.length === (tipo === 'cpf' ? 11 : 14), `Você não possui ${tipo.toUpperCase()} como documento.`);
      chave = conta.cliente_documento;
    } else if (tipo === 'email') {
      chave = String(req.body?.chave ?? '').trim().toLowerCase();
      v.exigir(v.emailValido(chave), 'E-mail inválido.');
    } else if (tipo === 'telefone') {
      chave = v.digitos(req.body?.chave);
      v.exigir(chave.length >= 10 && chave.length <= 11, 'Telefone deve ter DDD + número.');
    } else {
      chave = crypto.randomUUID();
    }
    if (db.prepare('SELECT 1 FROM chaves_pix WHERE chave = ?').get(chave)) throw new ErroNegocio('Esta chave já está cadastrada.', 409);
    const ins = db.prepare('INSERT INTO chaves_pix (conta_id, tipo, chave) VALUES (?, ?, ?)').run(conta.id, tipo, chave);
    registrar(db, req, 'ib_criar_chave_pix', 'chave_pix', Number(ins.lastInsertRowid), { tipo, conta_id: conta.id });
    return db.prepare('SELECT * FROM chaves_pix WHERE id = ?').get(ins.lastInsertRowid);
  }

  r.delete('/pix/chaves/:id', (req, res) => {
    const k = db.prepare('SELECT p.* FROM chaves_pix p JOIN contas c ON c.id = p.conta_id WHERE p.id = ? AND c.cliente_id = ?').get(req.params.id, req.cliente.id);
    if (!k) throw naoEncontrado('Chave PIX');
    db.prepare('DELETE FROM chaves_pix WHERE id = ?').run(k.id);
    registrar(db, req, 'ib_excluir_chave_pix', 'chave_pix', k.id);
    res.status(204).end();
  });

  r.post('/pix/destinatario', (req, res) => {
    const chave = String(req.body?.chave ?? '').trim();
    v.exigir(chave, 'Informe a chave PIX.');
    const k = buscarChaveInterna(db, chave);
    if (k) {
      const c = buscarConta(db, k.conta_id);
      return res.json({ interno: true, nome: c.cliente_nome, documento: mascararDocumento(c.cliente_documento), instituicao: 'PAY AX', chave: k.chave });
    }
    const externa = bradesco.normalizarChaveExterna(chave);
    if (!externa) throw new ErroNegocio('Chave PIX inválida. Confira CPF/CNPJ, e-mail, celular ou chave aleatória.', 422);
    res.json({ interno: false, chave: externa, instituicao: 'Outro banco' });
  });

  r.post('/pix', async (req, res) => {
    const { origem, valor } = prepararSaida(req);
    v.exigir(valor, 'Informe o valor.');
    await confirmarPin(req);
    exigirLimite(req, valor); // sem await entre a checagem e o débito
    const { end_to_end_id: _e2e, ...r2 } = await enviarPix(db, bradesco, req, origem, req.body?.chave, valor, v.texto(req.body?.descricao, 140));
    res.status(201).json(r2);
  });

  r.post('/pix/cobrancas', async (req, res) => {
    const conta = minhaConta(req, req.body?.conta_id);
    res.status(201).json(await bradesco.gerarCobranca(req, conta.id, req.body?.valor_centavos));
  });

  const minhaCobranca = (req) => {
    const c = db.prepare('SELECT p.txid FROM cobrancas_pix p JOIN contas c ON c.id = p.conta_id WHERE p.txid = ? AND c.cliente_id = ?').get(req.params.txid, req.cliente.id);
    if (!c) throw naoEncontrado('Cobrança');
    return c.txid;
  };
  r.get('/pix/cobrancas/:txid', async (req, res) => res.json(await bradesco.detalharCobranca(minhaCobranca(req))));
  r.post('/pix/cobrancas/:txid/simular-pagamento', (req, res) => res.json(bradesco.simularPagamento(req, minhaCobranca(req))));

  // ---------- Transferências entre contas PAY AX ----------
  r.post('/transferencias/destinatario', (req, res) => {
    const c = localizarConta(db, { agencia: req.body?.agencia, numero: req.body?.numero });
    res.json({ nome: c.cliente_nome, documento: mascararDocumento(c.cliente_documento), conta: fmt(c), status: c.status });
  });

  r.post('/transferencias', async (req, res) => {
    const { origem, valor } = prepararSaida(req);
    v.exigir(valor, 'Informe o valor.');
    const destino = localizarConta(db, { agencia: req.body?.destino_agencia, numero: req.body?.destino_numero });
    await confirmarPin(req);
    exigirLimite(req, valor); // sem await entre a checagem e o débito
    const descricao = v.texto(req.body?.descricao, 140) || `Transferência para ${destino.cliente_nome}`;
    res.status(201).json(transferir(db, req, origem, destino, valor, descricao, 'transferencia_enviada', 'transferencia_recebida'));
  });

  // ---------- Pagamentos ----------
  r.post('/pagamentos/consultar', (req, res) => {
    const b = lerBoleto(req.body?.linha);
    res.json({ ...b, linha_formatada: formatarLinha(b.linha_digitavel), vencido: Boolean(b.vencimento && b.vencimento < new Date().toISOString().slice(0, 10)) });
  });

  r.post('/pagamentos', async (req, res) => {
    const { origem } = prepararSaida(req);
    const b = lerBoleto(req.body?.linha);
    const valor = b.valor_centavos || v.valorCentavos(req.body?.valor_centavos, 'valor do pagamento');
    await confirmarPin(req);
    exigirLimite(req, valor); // sem await entre a checagem e o débito
    const { autenticacao: _aut, codigo_barras: _cb, ...r2 } = await bradesco.pagarBoleto(req, origem, b.linha_digitavel, valor);
    res.status(201).json(r2);
  });

  r.get('/pagamentos', (req, res) => {
    res.json(db.prepare(`SELECT p.id, p.tipo, p.linha_digitavel, p.valor_centavos, p.vencimento, p.status, p.erro, p.criado_em, p.transacao_id
      FROM pagamentos p JOIN contas c ON c.id = p.conta_id WHERE c.cliente_id = ? ORDER BY p.id DESC LIMIT 50`).all(req.cliente.id));
  });

  // Boletos de exemplo para testar no simulador.
  r.get('/pagamentos/exemplos', (_req, res) => {
    if (bradesco.status().modo !== 'simulador') throw naoEncontrado('Recurso');
    const venc = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const boleto = gerarBoletoBancario({ banco: '237', valorCentavos: 18990, vencimento: venc, campoLivre: '4521000012345678' });
    const conta = gerarConvenio({ segmento: '2', valorCentavos: 13472, empresa: '0057', livre: '20261001' });
    res.json([
      { rotulo: 'Boleto · Loja Exemplo · R$ 189,90', linha: formatarLinha(boleto.linha_digitavel) },
      { rotulo: 'Conta de luz · R$ 134,72', linha: formatarLinha(conta.linha_digitavel) },
    ]);
  });

  // ---------- Empréstimos ----------
  r.get('/emprestimos', (req, res) => {
    const lista = db.prepare(`SELECT e.*, c.numero, c.digito FROM emprestimos e JOIN contas c ON c.id = e.conta_id
      WHERE e.cliente_id = ? ORDER BY e.id DESC`).all(req.cliente.id);
    for (const e of lista) e.parcelas = db.prepare('SELECT numero, vencimento, valor_centavos, status, paga_em FROM parcelas WHERE emprestimo_id = ? ORDER BY numero').all(e.id);
    res.json(lista);
  });

  r.post('/emprestimos/:id/parcelas/:numero/pagar', async (req, res) => {
    await confirmarPin(req);
    res.json(pagarParcela(db, req, req.params.id, req.params.numero));
  });

  return r;
};
