'use strict';

const { Router } = require('express');
const { agora, transacao, lerConfig } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const arquivos = require('../lib/arquivos');
const grade = require('../lib/grade');
const { hoje, mes } = require('../lib/datas');
const { porCampanha, periodo, porDia } = require('../lib/relatorios');
const v = require('../lib/validacao');

const TIPOS_ALVO = ['tela', 'local', 'categoria', 'cidade'];

/** Campos da campanha vindos do formulário. */
function lerCampanha(db, c, cfg, parcial = false) {
  const d = {};
  const tem = (k) => c[k] !== undefined || !parcial;
  if (tem('nome')) d.nome = v.texto(c.nome, 'o nome da campanha', 140);
  if (tem('inicio')) d.inicio = v.data(c.inicio, 'a data de início');
  if (c.fim !== undefined) d.fim = c.fim === null || c.fim === '' ? null : v.data(c.fim, 'a data de término');
  if (tem('cobranca')) d.cobranca = v.opcao(c.cobranca ?? 'mensal', 'a forma de cobrança', ['mensal', 'cpm', 'cortesia']);
  if (c.valor_centavos !== undefined) d.valor_centavos = v.inteiro(c.valor_centavos, 'o valor', { max: 1_000_000_000 });
  if (c.cpm_centavos !== undefined) d.cpm_centavos = v.inteiro(c.cpm_centavos, 'o CPM', { max: 1_000_000 });
  if (tem('insercoes_hora')) d.insercoes_hora = v.inteiro(c.insercoes_hora ?? cfg.insercoes_hora_padrao, 'as inserções por hora', { min: 1, max: 120 });
  if (c.prioridade !== undefined) d.prioridade = v.inteiro(c.prioridade, 'a prioridade', { min: 1, max: 5 });
  if (c.dias_semana !== undefined) d.dias_semana = v.diasSemana(c.dias_semana);
  if (c.hora_inicio !== undefined) d.hora_inicio = v.hora(c.hora_inicio, 'a hora de início');
  if (c.hora_fim !== undefined) d.hora_fim = v.hora(c.hora_fim, 'a hora de término');
  if (c.limite_dia !== undefined) d.limite_dia = v.inteiro(c.limite_dia, 'o limite por dia', { max: 10_000 });
  if (c.pi !== undefined) d.pi = v.opcional(c.pi, 'o número do PI', 40);
  if (c.agencia_id !== undefined) {
    if (c.agencia_id === null || c.agencia_id === '') {
      d.agencia_id = null;
      d.comissao_agencia_percentual = 0;
    } else {
      const ag = db.prepare("SELECT * FROM agencias WHERE id = ? AND status = 'ativa'").get(Number(c.agencia_id));
      if (!ag) throw new ErroNegocio('Agência não encontrada ou inativa.', 422);
      d.agencia_id = ag.id;
      // A comissão da campanha começa na da agência e pode ser ajustada caso a caso.
      d.comissao_agencia_percentual = c.comissao_agencia_percentual !== undefined
        ? v.percentual(c.comissao_agencia_percentual, 'a comissão da agência') : ag.comissao_percentual;
    }
  } else if (c.comissao_agencia_percentual !== undefined) {
    d.comissao_agencia_percentual = v.percentual(c.comissao_agencia_percentual, 'a comissão da agência');
  }
  if (c.circuito_id !== undefined) {
    d.circuito_id = c.circuito_id === null || c.circuito_id === '' ? null : Number(c.circuito_id);
    if (d.circuito_id && !db.prepare('SELECT 1 FROM circuitos WHERE id = ?').get(d.circuito_id)) throw new ErroNegocio('Circuito não encontrado.', 422);
  }
  if (!parcial && c.anunciante_id !== undefined) {
    const a = db.prepare("SELECT 1 FROM anunciantes WHERE id = ? AND status = 'ativo'").get(Number(c.anunciante_id));
    if (!a) throw new ErroNegocio('Anunciante não encontrado ou inativo.', 422);
    d.anunciante_id = Number(c.anunciante_id);
  }
  if (d.cobranca === 'mensal' && !parcial && !d.valor_centavos) throw new ErroNegocio('Informe o valor mensal da campanha.', 422);
  if (d.cobranca === 'cpm' && !parcial && !d.cpm_centavos) throw new ErroNegocio('Informe o CPM (valor por mil impactos).', 422);
  return d;
}

/** Detalhe completo da campanha: criativos, onde vai ao ar e desempenho. */
function detalhe(db, id) {
  const c = db.prepare(`SELECT c.*, a.nome AS anunciante, ag.nome AS agencia, ci.nome AS circuito
    FROM campanhas c JOIN anunciantes a ON a.id = c.anunciante_id
    LEFT JOIN agencias ag ON ag.id = c.agencia_id LEFT JOIN circuitos ci ON ci.id = c.circuito_id WHERE c.id = ?`).get(id);
  if (!c) throw naoEncontrado('Campanha');
  const criativos = db.prepare(`SELECT cm.id AS vinculo_id, cm.ordem, COALESCE(cm.duracao_s, m.duracao_s) AS duracao_s, cm.duracao_s AS duracao_propria,
      m.id, m.nome, m.tipo, m.mime, m.status, m.validade_ate, m.largura, m.altura, m.orientacao, m.bytes, m.duracao_s AS duracao_midia
    FROM campanha_midias cm JOIN midias m ON m.id = cm.midia_id WHERE cm.campanha_id = ? ORDER BY cm.ordem, cm.id`).all(id);
  const alvos = db.prepare('SELECT id, tipo, valor FROM campanha_alvos WHERE campanha_id = ? ORDER BY tipo, valor').all(id);
  const telas = telasDaCampanha(db, id, alvos);
  // Período já exibido: do início da campanha até hoje (ou até o fim, se já passou). Campanha futura ainda não tem nada.
  const ate = c.fim && c.fim < hoje() ? c.fim : hoje();
  const de = c.inicio < ate ? c.inicio : ate;
  return {
    ...c,
    criativos,
    alvos,
    telas_alcancadas: telas.length,
    telas,
    desempenho: porCampanha(db, { de, ate, campanhaId: id })[0] ?? { insercoes: 0, segundos: 0, telas: 0, impactos: 0 },
    por_dia: porDia(db, { de, ate, campanhaId: id }),
  };
}

/** Quais telas ativas a campanha alcança com os alvos atuais. */
function telasDaCampanha(db, campanhaId, alvos = db.prepare('SELECT tipo, valor FROM campanha_alvos WHERE campanha_id = ?').all(campanhaId)) {
  return db.prepare(`SELECT t.id, t.nome, t.orientacao, t.status, l.id AS local_id, l.nome AS local_nome, l.categoria, l.cidade, l.publico_dia
    FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.status = 'ativa' AND l.status = 'ativo'`).all()
    .filter((t) => grade.alvoBate(alvos, t));
}

module.exports = (db) => {
  const r = Router();
  const cfg = () => lerConfig(db);

  // ----------------------------------------------------------------- Campanhas
  r.get('/campanhas', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.anunciante_id) { onde.push('c.anunciante_id = ?'); p.push(Number(req.query.anunciante_id)); }
    if (req.query.status) { onde.push('c.status = ?'); p.push(req.query.status); }
    if (req.query.busca) { onde.push('(c.nome LIKE ? OR a.nome LIKE ?)'); p.push(`%${req.query.busca}%`, `%${req.query.busca}%`); }
    const itens = db.prepare(`SELECT c.*, a.nome AS anunciante, ag.nome AS agencia, ci.nome AS circuito,
        (SELECT COUNT(*) FROM campanha_midias cm WHERE cm.campanha_id = c.id) AS criativos,
        (SELECT COUNT(*) FROM campanha_midias cm JOIN midias m ON m.id = cm.midia_id WHERE cm.campanha_id = c.id AND m.status = 'aprovada') AS criativos_ok,
        (SELECT COUNT(*) FROM campanha_alvos ca WHERE ca.campanha_id = c.id) AS alvos,
        (SELECT COALESCE(SUM(insercoes), 0) FROM resumo_dia rd WHERE rd.campanha_id = c.id AND rd.data = ?) AS insercoes_hoje
      FROM campanhas c JOIN anunciantes a ON a.id = c.anunciante_id LEFT JOIN agencias ag ON ag.id = c.agencia_id LEFT JOIN circuitos ci ON ci.id = c.circuito_id
      ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''} ORDER BY CASE c.status WHEN 'ativa' THEN 0 WHEN 'aguardando' THEN 1 WHEN 'pausada' THEN 2 WHEN 'rascunho' THEN 3 ELSE 4 END,
      c.inicio DESC`).all(hoje(), ...p);
    res.json({ itens, padroes: { insercoes_hora: cfg().insercoes_hora_padrao, mensalidade_tela_centavos: cfg().mensalidade_tela_centavos, cpm_centavos: cfg().cpm_centavos } });
  });

  r.get('/campanhas/:id', (req, res) => res.json(detalhe(db, Number(req.params.id))));

  r.post('/campanhas', (req, res) => {
    const d = lerCampanha(db, { cobranca: 'mensal', ...req.body }, cfg());
    if (!d.anunciante_id) throw new ErroNegocio('Informe o anunciante.', 422);
    const id = transacao(db, () => {
      const novo = Number(db.prepare(`INSERT INTO campanhas (${Object.keys(d).join(', ')}, criada_por, criado_em)
        VALUES (${Object.keys(d).map(() => '?').join(', ')}, ?, ?)`).run(...Object.values(d), req.usuario.id, agora()).lastInsertRowid);
      for (const m of req.body.criativos ?? []) {
        const midia = db.prepare('SELECT * FROM midias WHERE id = ?').get(Number(m.midia_id ?? m));
        if (!midia) throw new ErroNegocio('Criativo não encontrado.', 422);
        db.prepare('INSERT INTO campanha_midias (campanha_id, midia_id, duracao_s, ordem) VALUES (?, ?, ?, ?)')
          .run(novo, midia.id, m.duracao_s ? v.inteiro(m.duracao_s, 'a duração', { min: 1, max: 600 }) : null, Number(m.ordem) || 0);
      }
      for (const a of req.body.alvos ?? []) {
        db.prepare('INSERT OR IGNORE INTO campanha_alvos (campanha_id, tipo, valor) VALUES (?, ?, ?)')
          .run(novo, v.opcao(a.tipo, 'o tipo de alvo', TIPOS_ALVO), v.texto(a.valor, 'o alvo', 80));
      }
      return novo;
    });
    registrar(db, req, 'campanha_criada', { id, nome: d.nome });
    res.status(201).json(detalhe(db, id));
  });

  r.patch('/campanhas/:id', (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare('SELECT * FROM campanhas WHERE id = ?').get(id);
    if (!c) throw naoEncontrado('Campanha');
    const d = lerCampanha(db, req.body, cfg(), true);
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    const fim = d.fim !== undefined ? d.fim : c.fim;
    const inicio = d.inicio ?? c.inicio;
    if (fim && fim < inicio) throw new ErroNegocio('O término não pode ser antes do início.', 422);
    db.prepare(`UPDATE campanhas SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'campanha_alterada', { id, depois: d });
    res.json(detalhe(db, id));
  });

  /** Mudança de situação: enviar para aprovação, aprovar (vai ao ar), pausar, retomar, encerrar. */
  r.post('/campanhas/:id/status', (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare('SELECT * FROM campanhas WHERE id = ?').get(id);
    if (!c) throw naoEncontrado('Campanha');
    const acao = v.opcao(req.body.acao, 'a ação', ['enviar', 'aprovar', 'recusar', 'pausar', 'retomar', 'encerrar', 'reabrir']);
    const aprovados = db.prepare(`SELECT COUNT(*) AS n FROM campanha_midias cm JOIN midias m ON m.id = cm.midia_id
      WHERE cm.campanha_id = ? AND m.status = 'aprovada'`).get(id).n;

    const mudar = (status, extra = {}) => {
      const campos = { status, ...extra };
      db.prepare(`UPDATE campanhas SET ${Object.keys(campos).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(campos), id);
    };
    switch (acao) {
      case 'enviar':
        if (!['rascunho', 'encerrada'].includes(c.status)) throw new ErroNegocio('Só um rascunho pode ser enviado para aprovação.', 409);
        if (!db.prepare('SELECT COUNT(*) AS n FROM campanha_midias WHERE campanha_id = ?').get(id).n) throw new ErroNegocio('Adicione pelo menos um criativo antes de enviar.', 422);
        mudar('aguardando', { motivo: null });
        break;
      case 'aprovar': {
        if (!aprovados) throw new ErroNegocio('A campanha precisa de pelo menos um criativo aprovado para ir ao ar.', 422);
        const data = hoje();
        const noPrazo = c.inicio <= data && (!c.fim || c.fim >= data);
        mudar(noPrazo ? 'ativa' : 'aguardando', { aprovada_por: req.usuario.id, aprovada_em: agora(), motivo: null });
        break;
      }
      case 'recusar':
        mudar('rascunho', { motivo: v.texto(req.body.motivo, 'o motivo', 300), aprovada_por: null, aprovada_em: null });
        break;
      case 'pausar':
        if (!['ativa', 'aguardando'].includes(c.status)) throw new ErroNegocio('Só uma campanha no ar pode ser pausada.', 409);
        mudar('pausada', { motivo: v.opcional(req.body.motivo, 'o motivo', 300) });
        break;
      case 'retomar': {
        if (c.status !== 'pausada') throw new ErroNegocio('A campanha não está pausada.', 409);
        if (!aprovados) throw new ErroNegocio('A campanha não tem criativo aprovado.', 422);
        const data = hoje();
        mudar(c.inicio <= data && (!c.fim || c.fim >= data) ? 'ativa' : 'aguardando', { motivo: null });
        break;
      }
      case 'encerrar':
        mudar('encerrada', { fim: c.fim ?? hoje(), motivo: v.opcional(req.body.motivo, 'o motivo', 300) });
        break;
      case 'reabrir':
        if (c.status !== 'encerrada') throw new ErroNegocio('A campanha não está encerrada.', 409);
        mudar('rascunho', { motivo: null });
        break;
      default:
        break;
    }
    registrar(db, req, 'campanha_status', { id, acao, de: c.status });
    res.json(detalhe(db, id));
  });

  /** Criativos da campanha. */
  r.post('/campanhas/:id/criativos', (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare('SELECT * FROM campanhas WHERE id = ?').get(id);
    if (!c) throw naoEncontrado('Campanha');
    const m = db.prepare('SELECT * FROM midias WHERE id = ?').get(Number(req.body.midia_id));
    if (!m) throw new ErroNegocio('Criativo não encontrado.', 422);
    if (m.uso !== 'campanha') throw new ErroNegocio('Esta mídia é institucional: ela preenche a grade e não entra em campanha.', 422);
    if (m.anunciante_id && m.anunciante_id !== c.anunciante_id) throw new ErroNegocio('Este criativo é de outro anunciante.', 422);
    db.prepare('INSERT INTO campanha_midias (campanha_id, midia_id, duracao_s, ordem) VALUES (?, ?, ?, ?)')
      .run(id, m.id, req.body.duracao_s ? v.inteiro(req.body.duracao_s, 'a duração', { min: 1, max: 600 }) : null,
        Number(req.body.ordem) || db.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM campanha_midias WHERE campanha_id = ?').get(id).n);
    registrar(db, req, 'campanha_criativo_add', { campanha_id: id, midia_id: m.id });
    res.status(201).json(detalhe(db, id));
  });

  r.delete('/campanhas/:id/criativos/:midiaId', (req, res) => {
    const id = Number(req.params.id);
    const ok = db.prepare('DELETE FROM campanha_midias WHERE campanha_id = ? AND midia_id = ?').run(id, Number(req.params.midiaId)).changes;
    if (!ok) throw naoEncontrado('Criativo da campanha');
    registrar(db, req, 'campanha_criativo_rem', { campanha_id: id, midia_id: Number(req.params.midiaId) });
    res.json(detalhe(db, id));
  });

  /** Onde a campanha vai ao ar (telas, pontos, categorias ou cidades). Sem alvos: todas as telas. */
  r.put('/campanhas/:id/alvos', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM campanhas WHERE id = ?').get(id)) throw naoEncontrado('Campanha');
    const alvos = Array.isArray(req.body.alvos) ? req.body.alvos : [];
    transacao(db, () => {
      db.prepare('DELETE FROM campanha_alvos WHERE campanha_id = ?').run(id);
      for (const a of alvos) {
        const tipo = v.opcao(a.tipo, 'o tipo de alvo', TIPOS_ALVO);
        const valor = v.texto(a.valor, 'o alvo', 80);
        if (tipo === 'tela' && !db.prepare('SELECT 1 FROM telas WHERE id = ?').get(Number(valor))) throw new ErroNegocio('Tela do alvo não encontrada.', 422);
        if (tipo === 'local' && !db.prepare('SELECT 1 FROM locais WHERE id = ?').get(Number(valor))) throw new ErroNegocio('Ponto do alvo não encontrado.', 422);
        db.prepare('INSERT OR IGNORE INTO campanha_alvos (campanha_id, tipo, valor) VALUES (?, ?, ?)').run(id, tipo, valor);
      }
    });
    registrar(db, req, 'campanha_alvos', { campanha_id: id, alvos: alvos.length });
    res.json(detalhe(db, id));
  });

  /** Aplica um circuito na campanha: os alvos do circuito viram os alvos dela (e o preço de tabela é sugerido). */
  r.post('/campanhas/:id/circuito', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM campanhas WHERE id = ?').get(id)) throw naoEncontrado('Campanha');
    const circuito = db.prepare('SELECT * FROM circuitos WHERE id = ?').get(Number(req.body.circuito_id));
    if (!circuito) throw new ErroNegocio('Circuito não encontrado.', 422);
    transacao(db, () => {
      db.prepare('DELETE FROM campanha_alvos WHERE campanha_id = ?').run(id);
      for (const a of db.prepare('SELECT tipo, valor FROM circuito_alvos WHERE circuito_id = ?').all(circuito.id)) {
        db.prepare('INSERT OR IGNORE INTO campanha_alvos (campanha_id, tipo, valor) VALUES (?, ?, ?)').run(id, a.tipo, a.valor);
      }
      db.prepare('UPDATE campanhas SET circuito_id = ?, insercoes_hora = ? WHERE id = ?').run(circuito.id, circuito.insercoes_hora, id);
    });
    registrar(db, req, 'campanha_circuito', { campanha_id: id, circuito_id: circuito.id });
    res.json(detalhe(db, id));
  });

  r.delete('/campanhas/:id', permitir('master'), (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare('SELECT * FROM campanhas WHERE id = ?').get(id);
    if (!c) throw naoEncontrado('Campanha');
    if (db.prepare('SELECT 1 FROM exibicoes WHERE campanha_id = ? LIMIT 1').get(id)) {
      throw new ErroNegocio('Esta campanha já foi exibida. Encerre em vez de excluir (o histórico precisa ficar).', 409);
    }
    db.prepare('DELETE FROM campanhas WHERE id = ?').run(id);
    registrar(db, req, 'campanha_excluida', { id, nome: c.nome });
    res.status(204).end();
  });

  // ----------------------------------------------------------------- Criativos (mídias)
  r.get('/midias', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.anunciante_id) { onde.push('m.anunciante_id = ?'); p.push(Number(req.query.anunciante_id)); }
    if (req.query.status) { onde.push('m.status = ?'); p.push(req.query.status); }
    if (req.query.uso) { onde.push('m.uso = ?'); p.push(req.query.uso); }
    if (req.query.local_id) { onde.push('m.local_id = ?'); p.push(Number(req.query.local_id)); }
    if (req.query.busca) { onde.push('m.nome LIKE ?'); p.push(`%${req.query.busca}%`); }
    res.json({
      itens: db.prepare(`SELECT m.*, a.nome AS anunciante, l.nome AS local_nome,
          (SELECT COUNT(*) FROM campanha_midias cm WHERE cm.midia_id = m.id) AS campanhas
        FROM midias m LEFT JOIN anunciantes a ON a.id = m.anunciante_id LEFT JOIN locais l ON l.id = m.local_id
        ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''} ORDER BY m.id DESC`).all(...p),
      pendentes: db.prepare("SELECT COUNT(*) AS n FROM midias WHERE status = 'pendente'").get().n,
      disco_bytes: arquivos.tamanhoNoDisco(),
    });
  });

  /**
   * Envio do arquivo: POST /midias com o arquivo no corpo e os dados nos parâmetros da URL
   * (?nome=...&anunciante_id=...&uso=campanha&duracao_s=12&validade_ate=AAAA-MM-DD).
   * O tipo é reconhecido pelo conteúdo do arquivo; a duração do vídeo sai do próprio arquivo.
   */
  r.post('/midias', (req, res) => {
    const q = req.query;
    const c = cfg();
    const uso = v.opcao(q.uso ?? 'campanha', 'o uso', ['campanha', 'institucional']);
    let anuncianteId = null;
    if (uso === 'campanha') {
      anuncianteId = Number(q.anunciante_id);
      if (!db.prepare('SELECT 1 FROM anunciantes WHERE id = ?').get(anuncianteId)) throw new ErroNegocio('Informe o anunciante do criativo.', 422);
    }
    let localId = null;
    if (q.local_id) {
      localId = Number(q.local_id);
      if (!db.prepare('SELECT 1 FROM locais WHERE id = ?').get(localId)) throw new ErroNegocio('Ponto não encontrado.', 422);
    }
    const lido = arquivos.salvar(req.body, {
      duracaoInformada: q.duracao_s ? v.inteiro(q.duracao_s, 'a duração', { min: 1, max: 600 }) : null,
      duracaoImagemPadrao: c.duracao_imagem_s,
    });
    const nome = v.texto(q.nome ?? `Criativo ${hoje()}`, 'o nome do criativo', 140);
    const validade = q.validade_ate ? v.data(q.validade_ate, 'a validade') : null;
    try {
      const id = Number(db.prepare(`INSERT INTO midias (anunciante_id, local_id, nome, uso, tipo, arquivo, mime, bytes, sha256, largura, altura, duracao_s, orientacao,
          status, validade_ate, enviada_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?)`)
        .run(anuncianteId, localId, nome, uso, lido.tipo, lido.arquivo, lido.mime, lido.bytes, lido.sha256, lido.largura, lido.altura, lido.duracao_s, lido.orientacao,
          validade, req.usuario.id, agora()).lastInsertRowid);
      registrar(db, req, 'midia_enviada', { id, nome, bytes: lido.bytes, tipo: lido.tipo });
      res.status(201).json(db.prepare('SELECT * FROM midias WHERE id = ?').get(id));
    } catch (err) {
      arquivos.remover(lido);
      throw err;
    }
  });

  r.patch('/midias/:id', (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare('SELECT * FROM midias WHERE id = ?').get(id);
    if (!m) throw naoEncontrado('Criativo');
    const d = {};
    if (req.body.nome !== undefined) d.nome = v.texto(req.body.nome, 'o nome do criativo', 140);
    if (req.body.duracao_s !== undefined) d.duracao_s = v.inteiro(req.body.duracao_s, 'a duração', { min: 1, max: 600 });
    if (req.body.validade_ate !== undefined) d.validade_ate = req.body.validade_ate ? v.data(req.body.validade_ate, 'a validade') : null;
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    if (d.duracao_s && m.tipo === 'video') throw new ErroNegocio('A duração do vídeo vem do próprio arquivo; ajuste a duração dentro da campanha.', 422);
    db.prepare(`UPDATE midias SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'midia_alterada', { id, depois: d });
    res.json(db.prepare('SELECT * FROM midias WHERE id = ?').get(id));
  });

  /** Aprovação do criativo: nada vai ao ar sem passar por aqui. */
  r.post('/midias/:id/aprovacao', (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare('SELECT * FROM midias WHERE id = ?').get(id);
    if (!m) throw naoEncontrado('Criativo');
    const aprovar = v.opcao(req.body.decisao, 'a decisão', ['aprovar', 'recusar']) === 'aprovar';
    db.prepare('UPDATE midias SET status = ?, motivo = ?, aprovada_por = ?, aprovada_em = ? WHERE id = ?')
      .run(aprovar ? 'aprovada' : 'recusada', aprovar ? null : v.texto(req.body.motivo, 'o motivo da recusa', 300), req.usuario.id, agora(), id);
    registrar(db, req, aprovar ? 'midia_aprovada' : 'midia_recusada', { id, nome: m.nome });
    res.json(db.prepare('SELECT * FROM midias WHERE id = ?').get(id));
  });

  /** Arquivo do criativo para a equipe ver no painel (a TV usa a rota do player). */
  r.get('/midias/:id/arquivo', (req, res) => {
    const m = db.prepare('SELECT * FROM midias WHERE id = ?').get(Number(req.params.id));
    if (!m) throw naoEncontrado('Criativo');
    res.set({ 'Content-Type': m.mime, 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': 'inline' });
    require('node:fs').createReadStream(arquivos.caminho(m)).pipe(res);
  });

  r.delete('/midias/:id', (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare('SELECT * FROM midias WHERE id = ?').get(id);
    if (!m) throw naoEncontrado('Criativo');
    if (db.prepare('SELECT 1 FROM exibicoes WHERE midia_id = ? LIMIT 1').get(id)) {
      throw new ErroNegocio('Este criativo já foi exibido: ele fica no histórico. Recuse-o para tirar do ar.', 409);
    }
    transacao(db, () => {
      db.prepare('DELETE FROM campanha_midias WHERE midia_id = ?').run(id);
      db.prepare('DELETE FROM midias WHERE id = ?').run(id);
    });
    arquivos.remover(m);
    registrar(db, req, 'midia_excluida', { id, nome: m.nome });
    res.status(204).end();
  });

  /** Simulação: como fica a grade de uma tela agora (ou num dia e hora escolhidos). */
  r.get('/grade/:telaId', (req, res) => {
    const tela = db.prepare(`SELECT t.*, l.categoria, l.cidade, l.nome AS local_nome FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.id = ?`)
      .get(Number(req.params.telaId));
    if (!tela) throw naoEncontrado('Tela');
    let instante = new Date();
    if (req.query.data || req.query.hora) {
      const data = req.query.data ? v.data(req.query.data, 'a data') : hoje();
      const hora = req.query.hora ? v.hora(req.query.hora, 'a hora') : '12:00';
      // Monta o instante no fuso configurado: a meia-noite local do dia mais a hora pedida.
      const { inicioDia, minutosDe } = require('../lib/datas');
      instante = new Date(Date.parse(inicioDia(data)) + minutosDe(hora) * 60_000);
    }
    res.json({ tela: { id: tela.id, nome: tela.nome, local: tela.local_nome, orientacao: tela.orientacao }, simulado_em: instante.toISOString(), ...grade.montar(db, tela, instante) });
  });

  /** Ocupação das telas: quanto do loop está vendido em cada uma (ajuda a saber onde ainda cabe campanha). */
  r.get('/ocupacao', (_req, res) => {
    const telas = db.prepare(`SELECT t.*, l.categoria, l.cidade, l.nome AS local_nome, l.publico_dia FROM telas t JOIN locais l ON l.id = t.local_id
      WHERE t.status = 'ativa' AND l.status = 'ativo' ORDER BY l.nome, t.nome`).all();
    const itens = telas.map((t) => {
      const g = grade.montar(db, t);
      return {
        tela_id: t.id, tela: t.nome, local: t.local_nome, cidade: t.cidade, orientacao: t.orientacao, publico_dia: t.publico_dia,
        duracao_s: g.duracao_s, vendido_s: g.vendido_s, ocupacao: g.ocupacao, campanhas: g.campanhas.length, sem_conteudo: g.sem_conteudo,
      };
    });
    res.json({ competencia: mes(), itens });
  });

  return r;
};
