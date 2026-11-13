'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { agora, auditar, transacao } = require('../db');
const { exigirAdminEmpresa } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { cifrar, decifrar } = require('../lib/cifra');
const conversasLib = require('../lib/conversas');
const filasLib = require('../lib/filas');
const conhecimentoLib = require('../ia/conhecimento');
const ferramentasLib = require('../ia/ferramentas');
const promptLib = require('../ia/prompt');
const claude = require('../ia/claude');
const config = require('../config');
const v = require('../lib/validacao');

/** A ZOE: configuração, base de conhecimento, intenções, ferramentas e o teste. */
module.exports = function rotasIa(db) {
  const r = express.Router();

  const cfgDa = (empresaId) => db.prepare('SELECT * FROM ia_config WHERE empresa_id = ?').get(empresaId) ?? {};

  const comoPublica = (cfg) => ({
    ...cfg,
    ativa: Boolean(cfg.ativa),
    transferir_sem_resposta: Boolean(cfg.transferir_sem_resposta),
    pedir_csat: Boolean(cfg.pedir_csat),
    // O que vale de fato, somando o que está no servidor.
    modelo_efetivo: cfg.modelo || config.ia.modelo,
    esforco_efetivo: cfg.esforco || config.ia.esforco,
    chave_no_servidor: claude.disponivel(),
    padroes: conversasLib.MSG,
  });

  r.get('/', (req, res) => res.json(comoPublica(cfgDa(req.empresa.id))));

  r.patch('/', exigirAdminEmpresa, (req, res, next) => {
    try {
      const atual = cfgDa(req.empresa.id);
      const d = req.body ?? {};
      const bool = (k) => (d[k] === undefined ? atual[k] : (v.booleano(d[k]) ? 1 : 0));
      const texto = (k, nome, max) => (d[k] === undefined ? atual[k] : v.opcional(d[k], nome, max));
      const fila = d.fila_padrao_id === undefined ? atual.fila_padrao_id
        : (d.fila_padrao_id ? (filasLib.buscar(db, req.empresa.id, d.fila_padrao_id)?.id ?? null) : null);
      if (d.fila_padrao_id && !fila) throw naoEncontrado('Fila');

      db.prepare(`UPDATE ia_config SET ativa = ?, nome_assistente = ?, saudacao = ?, tom = ?, regras = ?, max_turnos = ?,
          transferir_sem_resposta = ?, fila_padrao_id = ?, pedir_csat = ?, encerrar_apos_min = ?,
          mensagem_transferencia = ?, mensagem_fora_horario = ?, mensagem_encerramento = ?, mensagem_csat = ?,
          modelo = ?, esforco = ?, atualizada_em = ? WHERE empresa_id = ?`)
        .run(bool('ativa'),
          d.nome_assistente === undefined ? atual.nome_assistente : v.texto(d.nome_assistente, 'o nome da atendente', 40),
          texto('saudacao', 'a saudação', 1000), texto('tom', 'o tom de voz', 3000), texto('regras', 'as regras da empresa', 5000),
          d.max_turnos === undefined ? atual.max_turnos : v.inteiro(d.max_turnos, 'o limite de mensagens da IA', { min: 1, max: 60 }),
          bool('transferir_sem_resposta'), fila, bool('pedir_csat'),
          d.encerrar_apos_min === undefined ? atual.encerrar_apos_min : v.inteiro(d.encerrar_apos_min, 'o tempo para encerrar por abandono', { min: 0, max: 10_080 }),
          texto('mensagem_transferencia', 'a mensagem de transferência', 1000), texto('mensagem_fora_horario', 'a mensagem de fora do horário', 1000),
          texto('mensagem_encerramento', 'a mensagem de encerramento', 1000), texto('mensagem_csat', 'a mensagem da avaliação', 1000),
          d.modelo === undefined ? atual.modelo : v.opcional(d.modelo, 'o modelo', 60),
          d.esforco === undefined ? atual.esforco : (d.esforco ? v.opcao(d.esforco, 'o esforço', ['low', 'medium', 'high', 'xhigh', 'max']) : null),
          agora(), req.empresa.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'alterou a ZOE', detalhe: { antes: atual, depois: d }, ip: req.ip });
      res.json(comoPublica(cfgDa(req.empresa.id)));
    } catch (err) { next(err); }
  });

  /** O prompt do sistema exatamente como a IA recebe: dá para a empresa auditar o que foi combinado. */
  r.get('/prompt', (req, res) => {
    const contato = db.prepare('SELECT * FROM contatos WHERE empresa_id = ? ORDER BY id DESC LIMIT 1').get(req.empresa.id);
    const kit = ferramentasLib.montar(db, { empresaId: req.empresa.id, semTransferencia: filasLib.listar(db, req.empresa.id).length === 0 });
    res.json({
      sistema: promptLib.montar(db, { empresa: req.empresa, cfg: cfgDa(req.empresa.id), contato: contato ?? { telefone: '55DDXXXXXXXXX' } }),
      ferramentas: kit.tools.map((t) => ({ nome: t.name, descricao: t.description, parametros: Object.keys(t.input_schema?.properties ?? {}) })),
    });
  });

  // ---------- Base de conhecimento ----------
  r.get('/conhecimento', (req, res) => res.json({ itens: conhecimentoLib.listar(db, req.empresa.id, { todos: true }).map((a) => ({ ...a, ativo: Boolean(a.ativo) })) }));

  r.post('/conhecimento', exigirAdminEmpresa, (req, res, next) => {
    try {
      const d = req.body ?? {};
      const id = conhecimentoLib.salvar(db, req.empresa.id, {
        titulo: v.texto(d.titulo, 'o título', 160), resposta: v.texto(d.resposta, 'a resposta', 4000),
        perguntas: v.opcional(d.perguntas, 'as perguntas de exemplo', 2000), ativo: d.ativo === undefined ? true : v.booleano(d.ativo),
      });
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'criou artigo na base', alvo: d.titulo, ip: req.ip });
      res.status(201).json(db.prepare('SELECT * FROM conhecimento WHERE id = ?').get(id));
    } catch (err) { next(err); }
  });

  r.patch('/conhecimento/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const atual = db.prepare('SELECT * FROM conhecimento WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!atual) throw naoEncontrado('Artigo');
      const d = req.body ?? {};
      conhecimentoLib.salvar(db, req.empresa.id, {
        id: atual.id,
        titulo: d.titulo === undefined ? atual.titulo : v.texto(d.titulo, 'o título', 160),
        resposta: d.resposta === undefined ? atual.resposta : v.texto(d.resposta, 'a resposta', 4000),
        perguntas: d.perguntas === undefined ? atual.perguntas : v.opcional(d.perguntas, 'as perguntas de exemplo', 2000),
        ativo: d.ativo === undefined ? Boolean(atual.ativo) : v.booleano(d.ativo),
      });
      res.json(db.prepare('SELECT * FROM conhecimento WHERE id = ?').get(atual.id));
    } catch (err) { next(err); }
  });

  r.delete('/conhecimento/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const a = db.prepare('SELECT * FROM conhecimento WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!a) throw naoEncontrado('Artigo');
      db.prepare('DELETE FROM conhecimento WHERE id = ?').run(a.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'excluiu artigo da base', alvo: a.titulo, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  /** Testa a busca: mostra o que a IA acharia para uma pergunta, com a pontuação. */
  r.get('/conhecimento/buscar', (req, res, next) => {
    try {
      res.json({ achados: conhecimentoLib.buscar(db, req.empresa.id, v.texto(req.query.pergunta, 'a pergunta', 500), { limite: 5, minimo: 0.5 }) });
    } catch (err) { next(err); }
  });

  // ---------- Intenções ----------
  r.get('/intencoes', (req, res) => res.json({
    itens: db.prepare(`SELECT i.*, f.nome AS fila_nome FROM intencoes i LEFT JOIN filas f ON f.id = i.fila_id
      WHERE i.empresa_id = ? ORDER BY i.ordem, i.nome`).all(req.empresa.id).map((i) => ({ ...i, ativa: Boolean(i.ativa) })),
  }));

  const dadosIntencao = (db2, empresaId, d, atual = {}) => {
    const acao = d.acao === undefined ? (atual.acao ?? 'responder') : v.opcao(d.acao, 'a ação', ['responder', 'transferir', 'encerrar']);
    const resposta = d.resposta === undefined ? atual.resposta : v.opcional(d.resposta, 'a resposta', 4000);
    if (acao === 'responder') v.exigir(resposta, 'Para a ação "responder", escreva a resposta.');
    const filaId = d.fila_id === undefined ? atual.fila_id : (d.fila_id ? (filasLib.buscar(db2, empresaId, d.fila_id)?.id ?? null) : null);
    if (d.fila_id && !filaId) throw naoEncontrado('Fila');
    return {
      nome: d.nome === undefined ? atual.nome : v.texto(d.nome, 'o nome da intenção', 80),
      palavras: (d.palavras === undefined ? v.lista(atual.palavras, 'as palavras-chave') : v.lista(d.palavras, 'as palavras-chave')).join('\n'),
      acao, resposta, fila_id: filaId,
      ordem: d.ordem === undefined ? (atual.ordem ?? 0) : v.inteiro(d.ordem, 'a ordem', { min: 0, max: 999 }),
      ativa: d.ativa === undefined ? (atual.ativa ?? 1) : (v.booleano(d.ativa) ? 1 : 0),
    };
  };

  r.post('/intencoes', exigirAdminEmpresa, (req, res, next) => {
    try {
      const i = dadosIntencao(db, req.empresa.id, req.body ?? {});
      v.exigir(i.palavras, 'Informe pelo menos uma palavra-chave.');
      const id = Number(db.prepare('INSERT INTO intencoes (empresa_id, nome, palavras, acao, resposta, fila_id, ordem, ativa, criada_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.empresa.id, i.nome, i.palavras, i.acao, i.resposta, i.fila_id, i.ordem, i.ativa, agora()).lastInsertRowid);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'criou intenção', alvo: i.nome, ip: req.ip });
      res.status(201).json(db.prepare('SELECT * FROM intencoes WHERE id = ?').get(id));
    } catch (err) { next(err); }
  });

  r.patch('/intencoes/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const atual = db.prepare('SELECT * FROM intencoes WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!atual) throw naoEncontrado('Intenção');
      const i = dadosIntencao(db, req.empresa.id, req.body ?? {}, atual);
      db.prepare('UPDATE intencoes SET nome = ?, palavras = ?, acao = ?, resposta = ?, fila_id = ?, ordem = ?, ativa = ? WHERE id = ?')
        .run(i.nome, i.palavras, i.acao, i.resposta, i.fila_id, i.ordem, i.ativa, atual.id);
      res.json(db.prepare('SELECT * FROM intencoes WHERE id = ?').get(atual.id));
    } catch (err) { next(err); }
  });

  r.delete('/intencoes/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const i = db.prepare('SELECT * FROM intencoes WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!i) throw naoEncontrado('Intenção');
      db.prepare('DELETE FROM intencoes WHERE id = ?').run(i.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'excluiu intenção', alvo: i.nome, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---------- Ferramentas da empresa (API do cliente) ----------
  const ferramentaPublica = (f) => ({
    id: f.id, nome: f.nome, descricao: f.descricao, parametros: f.parametros, metodo: f.metodo, url: f.url,
    timeout_ms: f.timeout_ms, ativa: Boolean(f.ativa), usos: f.usos, criada_em: f.criada_em,
    cabecalhos_nomes: Object.keys(JSON.parse(decifrar(f.cabecalhos_cifrados, 'ferramenta') ?? '{}')),
  });

  r.get('/ferramentas', (req, res) => res.json({
    itens: db.prepare('SELECT * FROM ferramentas WHERE empresa_id = ? ORDER BY nome').all(req.empresa.id).map(ferramentaPublica),
    internas: Object.entries(ferramentasLib.INTERNAS).map(([nome, f]) => ({ nome, descricao: f.descricao, interna: true })),
  }));

  const dadosFerramenta = (d, atual = {}) => {
    const parametros = d.parametros === undefined ? JSON.parse(atual.parametros ?? '{}') : (v.objeto(d.parametros, 'os parâmetros') ?? { type: 'object', properties: {}, required: [] });
    v.exigir(parametros.type === 'object' && parametros.properties && typeof parametros.properties === 'object',
      'Os parâmetros devem ser um JSON Schema de objeto, com "type": "object" e "properties".');
    v.exigir(Object.keys(parametros.properties).length <= 15, 'No máximo 15 parâmetros por ferramenta.');
    return {
      nome: d.nome === undefined ? atual.nome : v.nomeFerramenta(d.nome),
      descricao: d.descricao === undefined ? atual.descricao : v.texto(d.descricao, 'a descrição (é o que a IA lê para decidir usar)', 1000),
      parametros: JSON.stringify({
        type: 'object', properties: parametros.properties,
        required: Array.isArray(parametros.required) ? parametros.required : Object.keys(parametros.properties),
        additionalProperties: false,
      }),
      metodo: d.metodo === undefined ? (atual.metodo ?? 'POST') : v.opcao(String(d.metodo).toUpperCase(), 'o método', ['GET', 'POST']),
      url: d.url === undefined ? atual.url : v.endereco(d.url, 'o endereço da ferramenta'),
      timeout_ms: d.timeout_ms === undefined ? (atual.timeout_ms ?? 10_000) : v.inteiro(d.timeout_ms, 'o tempo limite', { min: 1000, max: 30_000 }),
      ativa: d.ativa === undefined ? (atual.ativa ?? 1) : (v.booleano(d.ativa) ? 1 : 0),
    };
  };

  const cabecalhosDe = (d, atual) => {
    if (d.cabecalhos === undefined) return atual?.cabecalhos_cifrados ?? null;
    const o = v.objeto(d.cabecalhos, 'os cabeçalhos') ?? {};
    for (const [k, val] of Object.entries(o)) {
      v.exigir(/^[A-Za-z0-9-]{1,60}$/.test(k), `Cabeçalho "${k}" inválido.`);
      v.exigir(typeof val === 'string' && val.length <= 500, `O valor do cabeçalho "${k}" deve ser texto de até 500 caracteres.`);
    }
    return Object.keys(o).length ? cifrar(JSON.stringify(o), 'ferramenta') : null;
  };

  r.post('/ferramentas', exigirAdminEmpresa, (req, res, next) => {
    try {
      const d = req.body ?? {};
      const f = dadosFerramenta(d);
      v.exigir(!ferramentasLib.INTERNAS[f.nome], `"${f.nome}" é o nome de uma ferramenta nativa da plataforma. Escolha outro.`);
      const id = Number(db.prepare(`INSERT INTO ferramentas (empresa_id, nome, descricao, parametros, metodo, url, cabecalhos_cifrados, timeout_ms, ativa, criada_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.empresa.id, f.nome, f.descricao, f.parametros, f.metodo, f.url, cabecalhosDe(d, null), f.timeout_ms, f.ativa, agora()).lastInsertRowid);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'criou ferramenta da IA', alvo: f.nome, detalhe: f.url, ip: req.ip });
      res.status(201).json(ferramentaPublica(db.prepare('SELECT * FROM ferramentas WHERE id = ?').get(id)));
    } catch (err) { next(err); }
  });

  r.patch('/ferramentas/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const atual = db.prepare('SELECT * FROM ferramentas WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!atual) throw naoEncontrado('Ferramenta');
      const d = req.body ?? {};
      const f = dadosFerramenta(d, atual);
      db.prepare('UPDATE ferramentas SET nome = ?, descricao = ?, parametros = ?, metodo = ?, url = ?, cabecalhos_cifrados = ?, timeout_ms = ?, ativa = ? WHERE id = ?')
        .run(f.nome, f.descricao, f.parametros, f.metodo, f.url, cabecalhosDe(d, atual), f.timeout_ms, f.ativa, atual.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'alterou ferramenta da IA', alvo: f.nome, ip: req.ip });
      res.json(ferramentaPublica(db.prepare('SELECT * FROM ferramentas WHERE id = ?').get(atual.id)));
    } catch (err) { next(err); }
  });

  r.delete('/ferramentas/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const f = db.prepare('SELECT * FROM ferramentas WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!f) throw naoEncontrado('Ferramenta');
      db.prepare('DELETE FROM ferramentas WHERE id = ?').run(f.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'excluiu ferramenta da IA', alvo: f.nome, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  /** Chama a ferramenta da empresa com os parâmetros de teste, para conferir a integração. */
  r.post('/ferramentas/:id/testar', exigirAdminEmpresa, async (req, res, next) => {
    try {
      const f = db.prepare('SELECT * FROM ferramentas WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!f) throw naoEncontrado('Ferramenta');
      const contato = db.prepare('SELECT * FROM contatos WHERE empresa_id = ? ORDER BY id DESC LIMIT 1').get(req.empresa.id)
        ?? { telefone: '5511999999999', nome: 'Contato de teste', documento: null, email: null, codigo_externo: null };
      const comecou = Date.now();
      const resultado = await ferramentasLib.executarExterna(f, { contato, conversa: { id: 0 }, entrada: v.objeto(req.body?.entrada, 'os parâmetros') ?? {} });
      res.json({ ms: Date.now() - comecou, resultado });
    } catch (err) { next(err); }
  });

  // ---------- Teste da ZOE ----------
  /**
   * Conversa de teste: roda a atendente de verdade (mesmo prompt, mesmas ferramentas) contra um
   * contato de teste, sem mandar nada para o WhatsApp. As mensagens ficam numa conversa marcada no histórico.
   */
  r.post('/testar', exigirAdminEmpresa, async (req, res, next) => {
    try {
      const texto = v.texto(req.body?.texto, 'a mensagem de teste', 1000);
      const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ? ORDER BY id LIMIT 1').get(req.empresa.id);
      if (!numero) throw new ErroNegocio('Cadastre o número de WhatsApp antes de testar (o teste usa a mesma configuração).');
      const telefone = `teste-${req.usuario.id}`;

      const preparo = transacao(db, () => {
        const contato = conversasLib.garantirContato(db, req.empresa.id, telefone, `Teste · ${req.usuario.nome}`);
        // Cada teste começa limpo, a menos que o usuário peça para continuar a conversa.
        if (!v.booleano(req.body?.continuar ?? false)) {
          const aberta = conversasLib.abertaDoContato(db, contato.id);
          if (aberta) db.prepare("UPDATE conversas SET estado = 'encerrada', encerrada_em = ?, resolvida_por = 'humano' WHERE id = ?").run(agora(), aberta.id);
        }
        const conversa = conversasLib.abrirOuRetomar(db, { empresa: req.empresa, numero, contato });
        conversasLib.tocarJanela(db, conversa);
        conversasLib.registrarEntrada(db, conversa, { tipo: 'texto', texto, waId: `teste.${crypto.randomBytes(8).toString('hex')}` });
        return { conversa: db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id), contato };
      });

      const antes = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM mensagens WHERE conversa_id = ?').all(preparo.conversa.id)[0].m);
      const resultado = await require('../ia/atendente').atender(db, {
        empresa: req.empresa, numero, contato: preparo.contato, conversa: preparo.conversa,
        mensagem: db.prepare('SELECT * FROM mensagens WHERE conversa_id = ? ORDER BY id DESC LIMIT 1').get(preparo.conversa.id),
      });
      // Nada de teste vai para o WhatsApp: as mensagens ficam marcadas como enviadas no histórico.
      db.prepare("UPDATE mensagens SET status = 'enviada', enviada_em = ? WHERE conversa_id = ? AND status = 'fila'").run(agora(), preparo.conversa.id);

      const conversa = db.prepare('SELECT * FROM conversas WHERE id = ?').get(preparo.conversa.id);
      res.json({
        acao: resultado.acao,
        detalhe: resultado.detalhe ?? null,
        estado: conversa.estado,
        fila: conversa.fila_id ? filasLib.buscar(db, req.empresa.id, conversa.fila_id)?.nome : null,
        motivo_transferencia: conversa.motivo_transferencia,
        resumo: conversa.resumo,
        conversa_id: conversa.id,
        respostas: db.prepare("SELECT autor, tipo, texto FROM mensagens WHERE conversa_id = ? AND id > ? AND direcao = 'saida' ORDER BY id").all(preparo.conversa.id, antes),
        eventos: db.prepare('SELECT tipo, nome, detalhe, tokens_entrada, tokens_saida, ms FROM ia_eventos WHERE conversa_id = ? ORDER BY id').all(preparo.conversa.id),
      });
    } catch (err) { next(err); }
  });

  return r;
};
