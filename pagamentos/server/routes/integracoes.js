'use strict';

const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { exigir } = require('../auth');
const { podeEquipe } = require('../lib/permissoes');
const { cifrar, decifrar } = require('../lib/cripto');
const v = require('../lib/validacao');
const sincronismo = require('../lib/sincronismo');
const boletosLib = require('../lib/boletos');
const { criarBanco } = require('../lib/bradesco');
const consultaDados = require('../lib/consultaDados');
const auditoria = require('../lib/auditoria');

/** Sistemas de gestão (ERP de provedor) homologados para importar títulos e dar baixa. Novos entram aqui. */
const SISTEMAS_HOMOLOGADOS = Object.freeze({ ixc: 'IXC Provedor' });

/** Guarda credenciais cifradas de um escopo. */
function gravar(db, { escopo, cliente_id = null, conta_id = null, credenciais, cfg, usuario, limpar = false }) {
  const existente = db.prepare('SELECT * FROM integracoes WHERE escopo = ? AND IFNULL(cliente_id, 0) = ? AND IFNULL(conta_id, 0) = ?')
    .get(escopo, cliente_id ?? 0, conta_id ?? 0);
  // credenciais null = mantém as que estão gravadas; limpar = apaga de propósito.
  const cifradas = limpar ? null : credenciais ? cifrar(JSON.stringify(credenciais)) : existente?.credenciais ?? null;
  if (existente) {
    db.prepare("UPDATE integracoes SET credenciais = ?, config = ?, estado = 'nao_configurada', atualizado_em = ?, atualizado_por = ? WHERE id = ?")
      .run(cifradas, JSON.stringify(cfg ?? {}), agora(), usuario.id, existente.id);
    return existente.id;
  }
  return db.prepare(`INSERT INTO integracoes (escopo, cliente_id, conta_id, credenciais, config, atualizado_em, atualizado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(escopo, cliente_id, conta_id, cifradas, JSON.stringify(cfg ?? {}), agora(), usuario.id).id;
}

/** Sem credenciais e sem o token do aviso do banco (quem tem o token consegue "avisar" um pagamento). */
const semSegredo = (i) => (i ? {
  id: i.id, escopo: i.escopo, cliente_id: i.cliente_id, conta_id: i.conta_id, estado: i.estado,
  configurada: Boolean(i.credenciais), config: (({ webhook_token: _token, ...publico }) => publico)(JSON.parse(i.config || '{}')),
  ultimo_teste: i.ultimo_teste, ultimo_erro: i.ultimo_erro, atualizado_em: i.atualizado_em,
} : null);

module.exports = (db) => {
  const r = express.Router();

  r.get('/', exigir('integracoes.ver', 'precos.ver'), (req, res) => {
    const banco = db.prepare("SELECT * FROM integracoes WHERE escopo = 'banco' ORDER BY id LIMIT 1").get();
    res.json({
      banco: {
        ...semSegredo(banco), modo: config.banco.modo, ambiente: config.banco.ambiente,
        // O endereço do aviso (com o token) só para o administrador, que é quem o cadastra no banco.
        webhook_caminho: banco && podeEquipe(req.usuario.perfil, '*') && JSON.parse(banco.config || '{}').webhook_token
          ? `${config.basePath}/api/publico/webhook/${JSON.parse(banco.config).webhook_token}` : undefined,
      },
      ixc: db.prepare(`SELECT i.*, c.razao_social, c.nome_fantasia FROM integracoes i JOIN clientes c ON c.id = i.cliente_id
        WHERE i.escopo = 'ixc' ORDER BY c.razao_social`).all().map((i) => ({ ...semSegredo(i), razao_social: i.razao_social, nome_fantasia: i.nome_fantasia })),
      sistemas: Object.entries(SISTEMAS_HOMOLOGADOS).map(([id, nome]) => ({ id, nome })),
      sincronismos: db.prepare(`SELECT s.*, c.razao_social FROM sincronismos s JOIN clientes c ON c.id = s.cliente_id
        ORDER BY s.id DESC LIMIT 30`).all(),
      dados: {
        ...semSegredo(db.prepare("SELECT * FROM integracoes WHERE escopo = 'dados' ORDER BY id LIMIT 1").get()),
        ...consultaDados.estado(db),
      },
    });
  });

  // ---------------------------------------------------------------- API Brasil (CEP e CNPJ)
  r.put('/dados', exigir('*'), (req, res) => {
    const token = req.body?.token ? v.texto(req.body.token, 'o token da API Brasil', 500) : null;
    // Token vazio = remover (como a tela promete): as consultas voltam para a fonte pública.
    const id = gravar(db, { escopo: 'dados', credenciais: token ? { token } : null, limpar: !token, cfg: {}, usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'integracao.dados.configurada', entidade: 'integracao', entidade_id: id });
    res.json({ ...semSegredo(db.prepare('SELECT * FROM integracoes WHERE id = ?').get(id)), ...consultaDados.estado(db) });
  });

  /** Testa consultando um CNPJ conhecido (o da própria Receita Federal). */
  r.post('/dados/testar', exigir('integracoes.ver', '*'), async (req, res) => {
    const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'dados' ORDER BY id LIMIT 1").get();
    try {
      // O teste consulta de verdade (sem cache): senão "passava" com uma resposta antiga.
      const cnpj = await consultaDados.consultarCnpj(db, req.body?.cnpj || '00394460000141', { semCache: true });
      const cep = await consultaDados.consultarCep(db, req.body?.cep || '70150900', { semCache: true });
      // Com token, o CNPJ precisa ter vindo da API Brasil: se caiu para a fonte pública, o teste não passou.
      const falhouApiBrasil = cnpj.aviso && i?.credenciais;
      if (i) db.prepare("UPDATE integracoes SET estado = ?, ultimo_teste = ?, ultimo_erro = ? WHERE id = ?")
        .run(falhouApiBrasil ? 'falha' : 'conectada', agora(), falhouApiBrasil ? cnpj.aviso : null, i.id);
      res.json({
        ok: !falhouApiBrasil,
        aviso: cnpj.aviso ?? null,
        mensagem: falhouApiBrasil ? cnpj.aviso : `CNPJ consultado pela fonte "${cnpj.fonte}" e CEP pela fonte "${cep.fonte}".`,
        cnpj: { razao_social: cnpj.razao_social, cidade: cnpj.cidade, uf: cnpj.uf, fonte: cnpj.fonte },
        cep: { cidade: cep.cidade, uf: cep.uf, fonte: cep.fonte },
      });
    } catch (err) {
      if (i) db.prepare("UPDATE integracoes SET estado = 'falha', ultimo_teste = ?, ultimo_erro = ? WHERE id = ?").run(agora(), err.message, i.id);
      throw err;
    }
  });

  // ---------------------------------------------------------------- Bradesco
  r.put('/banco', exigir('*'), (req, res) => {
    const b = req.body ?? {};
    const conta = b.conta_id ? db.prepare('SELECT id FROM contas_bancarias WHERE id = ?').get(Number(b.conta_id)) : null;
    const credenciais = b.client_id ? {
      client_id: v.texto(b.client_id, 'o client_id', 200),
      client_secret: v.opcional(b.client_secret, 'o client_secret', 400),
      certificado_pem: v.opcional(b.certificado_pem, 'o certificado', 20000),
      chave_privada_pem: v.opcional(b.chave_privada_pem, 'a chave privada', 20000),
      chave_senha: v.opcional(b.chave_senha, 'a senha da chave', 200),
    } : null;
    if (credenciais?.chave_privada_pem && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(credenciais.chave_privada_pem)) {
      throw new ErroNegocio('A chave privada precisa estar no formato PEM (-----BEGIN PRIVATE KEY-----).', 422);
    }
    const cfg = {
      ambiente: v.opcao(b.ambiente ?? config.banco.ambiente, 'o ambiente', ['homologacao', 'producao']),
      // O token do aviso já cadastrado no Bradesco se mantém: trocar a cada gravação invalidaria a URL lá.
      webhook_token: b.webhook_token ? v.texto(b.webhook_token, 'o token do webhook', 100)
        : (() => {
          const atual = db.prepare("SELECT config FROM integracoes WHERE escopo = 'banco' AND IFNULL(conta_id, 0) = ?").get(Number(b.conta_id) || 0);
          return JSON.parse(atual?.config || '{}').webhook_token || crypto.randomBytes(24).toString('base64url');
        })(),
    };
    const id = gravar(db, { escopo: 'banco', conta_id: conta?.id ?? null, credenciais, cfg, usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'integracao.banco.configurada', entidade: 'integracao', entidade_id: id, depois: { ambiente: cfg.ambiente, conta_id: conta?.id ?? null } });
    res.json({ ...semSegredo(db.prepare('SELECT * FROM integracoes WHERE id = ?').get(id)),
      webhook_caminho: `${config.basePath}/api/publico/webhook/${cfg.webhook_token}` });
  });

  r.post('/banco/testar', exigir('integracoes.ver', '*'), async (req, res) => {
    const conta = boletosLib.contaDe(db, req.body?.conta_id);
    const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'banco' ORDER BY id LIMIT 1").get();
    try {
      const banco = criarBanco(conta, boletosLib.credenciaisDaConta(db, conta.id));
      const out = await banco.testar();
      if (i) db.prepare("UPDATE integracoes SET estado = 'conectada', ultimo_teste = ?, ultimo_erro = NULL WHERE id = ?").run(agora(), i.id);
      res.json({ ...out, modo: banco.modo });
    } catch (err) {
      if (i) db.prepare("UPDATE integracoes SET estado = 'falha', ultimo_teste = ?, ultimo_erro = ? WHERE id = ?").run(agora(), err.message, i.id);
      // Credencial recusada pelo BANCO não é sessão nossa expirada: 502, para a tela não desconectar ninguém.
      throw new ErroNegocio(err.message, 502);
    }
  });

  // ---------------------------------------------------------------- IXC por cliente
  r.put('/ixc/:clienteId', exigir('integracoes.ixc', '*'), (req, res) => {
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(req.params.clienteId));
    if (!cliente) throw naoEncontrado('Cliente');
    const b = req.body ?? {};
    let credenciais = b.token ? { url: v.url(b.url, 'o endereço do IXC'), token: v.texto(b.token, 'o token', 200) } : null;
    // Endereço novo sem redigitar o token: a conexão usa o endereço guardado nas credenciais, então ele
    // é atualizado lá também (antes a tela mostrava o novo e a conexão seguia indo para o antigo).
    if (!credenciais && b.url) {
      const atual = db.prepare("SELECT credenciais FROM integracoes WHERE escopo = 'ixc' AND cliente_id = ?").get(cliente.id);
      if (atual?.credenciais) {
        const c = JSON.parse(decifrar(atual.credenciais));
        credenciais = { ...c, url: v.url(b.url, 'o endereço do IXC') };
      }
    }
    const cfg = {
      // Sistema de gestão do cliente: só os homologados pela PAY AX (hoje, o IXC).
      sistema: v.opcao(b.sistema || 'ixc', 'o sistema de gestão', Object.keys(SISTEMAS_HOMOLOGADOS)),
      url: b.url ? v.url(b.url, 'o endereço do IXC') : undefined,
      tipo_padrao: v.opcao(b.tipo_padrao ?? 'bolepix', 'o tipo padrão', ['boleto', 'bolepix']),
      // IDs da carteira de cobrança "PAY AX" no IXC: só os títulos dela viram boleto.
      carteiras: (() => {
        const ids = String(b.carteiras ?? '').split(/[\s,;]+/).filter(Boolean);
        if (ids.some((x) => !/^\d{1,10}$/.test(x))) throw new ErroNegocio('Informe o número (ID) da carteira de cobrança no IXC, ex.: 12 ou 12, 15.', 422);
        return [...new Set(ids)];
      })(),
      // Mesmos tetos da emissão: uma configuração fora da lei faria todo título importado falhar.
      ...(() => {
        const e = boletosLib.encargos({ juros_mes: b.juros_mes ?? 1, multa: b.multa ?? 2 });
        return { juros_mes: e.juros_mes_ppm / 10000, multa: e.multa_ppm / 10000 };
      })(),
      mensagem: v.opcional(b.mensagem, 'a mensagem do boleto', 160),
      anotar_no_ixc: b.anotar_no_ixc === undefined ? true : v.booleano(b.anotar_no_ixc),
      importacao_automatica: v.booleano(b.importacao_automatica),
      // Quem numera e monta o boleto que o assinante recebe: a PAY AX (ficha da PAY AX) ou o próprio IXC
      // (layout do IXC; a PAY AX só registra, com o nosso número que o IXC deu, numa faixa reservada).
      ...(() => {
        const numeracao = v.opcao(b.numeracao || 'payax', 'quem monta o boleto', ['payax', 'ixc']);
        if (numeracao === 'payax') return { numeracao };
        const conta = boletosLib.contaDe(db, b.conta_id || null);
        const ini = Number(String(b.faixa_inicio ?? '').replace(/\D/g, ''));
        const fim = Number(String(b.faixa_fim ?? '').replace(/\D/g, ''));
        if (!ini || !fim || fim < ini) throw new ErroNegocio('Informe a faixa de nosso número da carteira PAY AX no IXC (início e fim).', 422);
        if (ini < conta.nosso_numero_inicial || fim > conta.nosso_numero_final) {
          throw new ErroNegocio(`A faixa precisa estar dentro da faixa da conta no Bradesco (${conta.nosso_numero_inicial} a ${conta.nosso_numero_final}).`, 422);
        }
        if (ini <= conta.nosso_numero_atual) {
          throw new ErroNegocio(`A faixa precisa começar depois do último número já usado pela PAY AX nesta conta (${conta.nosso_numero_atual}).`, 422);
        }
        const outra = db.prepare("SELECT cliente_id, config FROM integracoes WHERE escopo = 'ixc' AND cliente_id <> ?").all(cliente.id)
          .map((i) => ({ id: i.cliente_id, c: JSON.parse(i.config || '{}') }))
          .find((i) => i.c.numeracao === 'ixc' && Number(i.c.conta_id ?? conta.id) === conta.id && !(fim < Number(i.c.faixa_inicio) || ini > Number(i.c.faixa_fim)));
        if (outra) throw new ErroNegocio('Esta faixa se sobrepõe à de outro cliente. Cada cliente precisa de uma faixa só dele.', 409);
        return { numeracao, conta_id: conta.id, faixa_inicio: ini, faixa_fim: fim };
      })(),
      dias_a_frente: v.inteiroOpcional(b.dias_a_frente, 'os dias à frente', { min: 1, max: 90 }) ?? 10,
    };
    // Com o IXC enviando o boleto, o título precisa estar registrado desde que a fatura é gerada:
    // por padrão, importa os vencimentos dos próximos 45 dias.
    if (cfg.numeracao === 'ixc' && (b.dias_a_frente === undefined || b.dias_a_frente === '')) cfg.dias_a_frente = 45;
    const id = gravar(db, { escopo: 'ixc', cliente_id: cliente.id, credenciais, cfg, usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'integracao.ixc.configurada', entidade: 'integracao', entidade_id: id, cliente_id: cliente.id, depois: cfg });
    res.json(semSegredo(db.prepare('SELECT * FROM integracoes WHERE id = ?').get(id)));
  });

  r.post('/ixc/:clienteId/testar', exigir('integracoes.ixc', '*'), async (req, res) => {
    res.json(await sincronismo.testar(db, Number(req.params.clienteId)));
  });

  r.post('/ixc/:clienteId/importar', exigir('boletos.emitir'), async (req, res) => {
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(req.params.clienteId));
    if (!cliente) throw naoEncontrado('Cliente');
    const hoje = sincronismo.hoje();
    const out = await sincronismo.importar(db, cliente, {
      de: req.body?.de ? v.data(req.body.de, 'a data inicial') : hoje,
      ate: req.body?.ate ? v.data(req.body.ate, 'a data final') : require('../lib/datas').somarDias(hoje, 10),
      limite: v.inteiroOpcional(req.body?.limite, 'o limite', { min: 1, max: 500 }) ?? 200,
      usuario: req.usuario,
    });
    auditoria.registrar(db, req, { acao: 'ixc.importacao', entidade: 'sincronismo', entidade_id: out.sincronismo_id, cliente_id: cliente.id,
      depois: { lidos: out.lidos, criados: out.criados, ignorados: out.ignorados, erros: out.erros } });
    res.json(out);
  });

  r.get('/ixc/:clienteId/credenciais', exigir('*'), (req, res) => {
    // Devolve só o endereço (nunca o token), para a tela mostrar o que está configurado.
    const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'ixc' AND cliente_id = ?").get(Number(req.params.clienteId));
    if (!i?.credenciais) return res.json({ configurada: false });
    try {
      const c = JSON.parse(decifrar(i.credenciais));
      res.json({ configurada: true, url: c.url, token_final: String(c.token ?? '').slice(-4) });
    } catch {
      res.json({ configurada: false, erro: 'Não foi possível decifrar as credenciais (a chave mudou?).' });
    }
  });

  return r;
};
