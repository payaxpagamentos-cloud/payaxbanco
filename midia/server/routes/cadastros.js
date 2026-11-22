'use strict';

const { Router } = require('express');
const crypto = require('node:crypto');
const { agora, transacao, lerConfig } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { hashSenha } = require('../lib/senha');
const { estaOnline, pontoAberto, uptime } = require('../lib/monitor');
const { montarPorTela } = require('../lib/grade');
const config = require('../config');
const arquivos = require('../lib/arquivos');
const foto = require('../lib/comunicado-foto');
const { hoje } = require('../lib/datas');
const contratosLib = require('../lib/contratos');
const v = require('../lib/validacao');
const empresas = require('../lib/empresas');

const CATEGORIAS = v.CATEGORIAS;
const SENHA_ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const senhaProvisoria = () => Array.from(crypto.randomBytes(10), (b) => SENHA_ALFABETO[b % SENHA_ALFABETO.length]).join('');

/** Dados do ponto vindos do formulário. */
function lerLocal(c, cfg, parcial = false) {
  const d = {};
  const tem = (k) => c[k] !== undefined || !parcial;
  if (tem('nome')) d.nome = v.texto(c.nome, 'o nome do ponto', 120);
  if (tem('categoria')) d.categoria = v.opcao(c.categoria ?? 'outro', 'a categoria', CATEGORIAS);
  if (c.documento !== undefined) d.documento = c.documento === null || c.documento === '' ? null : v.documento(c.documento);
  if (c.administradora !== undefined) d.administradora = v.opcional(c.administradora, 'a administradora', 120);
  if (c.assinatura !== undefined) d.assinatura = v.opcional(c.assinatura, 'a assinatura do comunicado', 120);
  if (c.unidades !== undefined) d.unidades = v.inteiro(c.unidades, 'o número de unidades', { max: 100_000 });
  // Contrapartida ao ponto: comissão sobre a receita, valor fixo por mês ou nenhuma (caso comum em condomínio).
  if (c.repasse_tipo !== undefined) d.repasse_tipo = v.opcao(c.repasse_tipo, 'a forma de repasse', ['comissao', 'fixo', 'nenhum']);
  if (c.repasse_fixo_centavos !== undefined) d.repasse_fixo_centavos = v.inteiro(c.repasse_fixo_centavos, 'o valor fixo do repasse', { max: 100_000_000 });
  for (const [k, nome, max] of [['cep', 'o CEP', 9], ['logradouro', 'o endereço', 160], ['numero', 'o número', 20], ['bairro', 'o bairro', 80],
    ['responsavel', 'o responsável', 120], ['email', 'o e-mail', 160], ['observacao', 'a observação', 500]]) {
    if (c[k] !== undefined) d[k] = v.opcional(c[k], nome, max);
  }
  if (c.telefone !== undefined) d.telefone = c.telefone === null || c.telefone === '' ? null : v.telefone(c.telefone);
  if (tem('cidade')) d.cidade = v.texto(c.cidade, 'a cidade', 80);
  if (tem('uf')) d.uf = v.uf(c.uf);
  if (c.publico_dia !== undefined) d.publico_dia = v.inteiro(c.publico_dia, 'o público por dia', { max: 1_000_000 });
  if (c.comissao_percentual !== undefined) d.comissao_percentual = v.percentual(c.comissao_percentual, 'a comissão');
  else if (!parcial) d.comissao_percentual = cfg.comissao_local_percentual;
  if (c.status !== undefined) d.status = v.opcao(c.status, 'a situação', ['ativo', 'pausado', 'encerrado']);
  if (c.inicio_parceria !== undefined) d.inicio_parceria = c.inicio_parceria ? v.data(c.inicio_parceria, 'a data de início') : null;
  return d;
}

/** Horário de funcionamento: lista de { dia_semana, abre, fecha }. */
function gravarHorarios(db, localId, horarios) {
  if (!Array.isArray(horarios)) return;
  transacao(db, () => {
    db.prepare('DELETE FROM local_horarios WHERE local_id = ?').run(localId);
    for (const h of horarios) {
      const dia = v.inteiro(h.dia_semana, 'o dia da semana', { max: 6 });
      db.prepare('INSERT INTO local_horarios (local_id, dia_semana, abre, fecha) VALUES (?, ?, ?, ?)')
        .run(localId, dia, v.hora(h.abre, 'a hora de abertura'), v.hora(h.fecha, 'a hora de fechamento'));
    }
  });
}

/** Campos do comunicado (usado pelo painel e pelo portal do ponto). */
function lerComunicado(db, c, parcial = false) {
  const d = {};
  const tem = (k) => c[k] !== undefined || !parcial;
  if (!parcial) {
    d.local_id = Number(c.local_id);
    if (!db.prepare('SELECT 1 FROM locais WHERE id = ?').get(d.local_id)) throw new ErroNegocio('Ponto não encontrado.', 422);
  }
  if (tem('titulo')) d.titulo = v.texto(c.titulo, 'o título', 80);
  if (tem('texto')) d.texto = v.texto(c.texto, 'o texto', 400);
  if (tem('tipo')) d.tipo = v.opcao(c.tipo ?? 'aviso', 'o tipo', ['aviso', 'manutencao', 'assembleia', 'entrega', 'urgente']);
  if (tem('inicio')) d.inicio = v.data(c.inicio ?? hoje(), 'a data de início');
  if (tem('fim')) d.fim = v.data(c.fim, 'a data de término');
  if (c.duracao_s !== undefined) d.duracao_s = v.inteiro(c.duracao_s, 'a duração', { min: 5, max: 60 });
  // Data do fato (assembleia, dedetização, entrega): alimenta a agenda na tela do condomínio.
  if (c.evento_em !== undefined) d.evento_em = c.evento_em ? v.data(c.evento_em, 'a data do evento') : null;
  if (c.evento_hora !== undefined) d.evento_hora = c.evento_hora ? v.hora(c.evento_hora, 'a hora do evento') : null;
  if (d.inicio && d.fim && d.fim < d.inicio) throw new ErroNegocio('O término não pode ser antes do início.', 422);
  return d;
}

module.exports = (db) => {
  const r = Router();
  const cfg = () => lerConfig(db);

  // ----------------------------------------------------------------- Pontos (comércios onde as TVs ficam)
  r.get('/locais', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.busca) { onde.push('(l.nome LIKE ? OR l.cidade LIKE ? OR l.bairro LIKE ?)'); p.push(`%${req.query.busca}%`, `%${req.query.busca}%`, `%${req.query.busca}%`); }
    if (req.query.categoria) { onde.push('l.categoria = ?'); p.push(req.query.categoria); }
    if (req.query.cidade) { onde.push('l.cidade = ?'); p.push(req.query.cidade); }
    if (req.query.status) { onde.push('l.status = ?'); p.push(req.query.status); }
    const [doEmp, pe] = empresas.filtro(req, 'l.empresa_id');
    if (doEmp) { onde.push(doEmp.replace(' AND ', '')); p.push(...pe); }
    const itens = db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM telas t WHERE t.local_id = l.id AND t.status <> 'inativa') AS telas,
        (SELECT COUNT(*) FROM telas t WHERE t.local_id = l.id AND t.ultimo_contato > ?) AS telas_online
      FROM locais l ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''} ORDER BY l.nome`)
      .all(new Date(Date.now() - cfg().offline_minutos * 60_000).toISOString(), ...p);
    res.json({ itens, categorias: CATEGORIAS, cidades: db.prepare(`SELECT DISTINCT cidade FROM locais l WHERE cidade <> ''${doEmp} ORDER BY cidade`).all(...pe).map((x) => x.cidade) });
  });

  r.get('/locais/:id', (req, res) => {
    const l = db.prepare('SELECT * FROM locais WHERE id = ?').get(Number(req.params.id));
    if (!l) throw naoEncontrado('Ponto');
    const limite = new Date(Date.now() - cfg().offline_minutos * 60_000).toISOString();
    res.json({
      ...l,
      aberto: pontoAberto(db, l.id),
      horarios: db.prepare('SELECT dia_semana, abre, fecha FROM local_horarios WHERE local_id = ? ORDER BY dia_semana').all(l.id),
      telas: db.prepare('SELECT * FROM telas WHERE local_id = ? ORDER BY nome').all(l.id).map((t) => ({ ...t, online: t.ultimo_contato > limite })),
      usuarios: db.prepare("SELECT id, nome, email, ativo, ultimo_acesso FROM usuarios WHERE local_id = ? AND perfil = 'lojista'").all(l.id),
      repasses: db.prepare('SELECT * FROM repasses WHERE local_id = ? ORDER BY competencia DESC LIMIT 12').all(l.id),
      comunicados: db.prepare("SELECT * FROM comunicados WHERE local_id = ? ORDER BY (status = 'pendente') DESC, fim DESC LIMIT 20").all(l.id),
    });
  });

  r.post('/locais', (req, res) => {
    const d = lerLocal(req.body, cfg());
    const campos = Object.keys(d);
    const id = Number(db.prepare(`INSERT INTO locais (${campos.join(', ')}, empresa_id, criado_em) VALUES (${campos.map(() => '?').join(', ')}, ?, ?)`)
      .run(...campos.map((k) => d[k]), empresas.empresaParaGravar(db, req, req.body.empresa_id), agora()).lastInsertRowid);
    if (req.body.horarios) gravarHorarios(db, id, req.body.horarios);
    registrar(db, req, 'local_criado', { id, nome: d.nome });
    res.status(201).json({ id, ...d });
  });

  r.patch('/locais/:id', (req, res) => {
    const id = Number(req.params.id);
    const antes = db.prepare('SELECT * FROM locais WHERE id = ?').get(id);
    if (!antes) throw naoEncontrado('Ponto');
    const d = lerLocal(req.body, cfg(), true);
    if (Object.keys(d).length) {
      db.prepare(`UPDATE locais SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    }
    if (req.body.horarios) gravarHorarios(db, id, req.body.horarios);
    registrar(db, req, 'local_alterado', { id, antes: Object.fromEntries(Object.keys(d).map((k) => [k, antes[k]])), depois: d });
    res.json(db.prepare('SELECT * FROM locais WHERE id = ?').get(id));
  });

  r.delete('/locais/:id', permitir('master', 'administrador'), (req, res) => {
    const id = Number(req.params.id);
    const l = db.prepare('SELECT * FROM locais WHERE id = ?').get(id);
    if (!l) throw naoEncontrado('Ponto');
    if (db.prepare('SELECT 1 FROM exibicoes WHERE local_id = ? LIMIT 1').get(id)) {
      throw new ErroNegocio('Este ponto já tem histórico de exibições. Marque como encerrado em vez de excluir.', 409);
    }
    transacao(db, () => {
      db.prepare("DELETE FROM usuarios WHERE local_id = ? AND perfil = 'lojista'").run(id);
      db.prepare('DELETE FROM telas WHERE local_id = ?').run(id);
      db.prepare('DELETE FROM locais WHERE id = ?').run(id);
    });
    registrar(db, req, 'local_excluido', { id, nome: l.nome });
    res.status(204).end();
  });

  /**
   * Logo da administradora (ou do próprio ponto): aparece no alto do comunicado na tela.
   * Envio com o arquivo no corpo: POST /locais/:id/logo
   */
  r.post('/locais/:id/logo', (req, res) => {
    const l = db.prepare('SELECT * FROM locais WHERE id = ?').get(Number(req.params.id));
    if (!l) throw naoEncontrado('Ponto');
    const img = arquivos.salvarImagem(req.body);
    const anterior = l.logo_arquivo;
    db.prepare('UPDATE locais SET logo_arquivo = ?, logo_mime = ? WHERE id = ?').run(img.arquivo, img.mime, l.id);
    if (anterior) arquivos.remover({ arquivo: anterior });
    registrar(db, req, 'logo_do_ponto', { local_id: l.id, bytes: img.bytes });
    res.status(201).json({ ok: true, largura: img.largura ?? null, altura: img.altura ?? null });
  });

  r.get('/locais/:id/logo', (req, res) => {
    const l = db.prepare('SELECT logo_arquivo, logo_mime FROM locais WHERE id = ?').get(Number(req.params.id));
    if (!l?.logo_arquivo) throw naoEncontrado('Logo');
    res.set({ 'Content-Type': l.logo_mime, 'Cache-Control': 'private, max-age=86400' });
    require('node:fs').createReadStream(arquivos.caminho({ arquivo: l.logo_arquivo })).pipe(res);
  });

  r.delete('/locais/:id/logo', (req, res) => {
    const l = db.prepare('SELECT * FROM locais WHERE id = ?').get(Number(req.params.id));
    if (!l?.logo_arquivo) throw naoEncontrado('Logo');
    db.prepare('UPDATE locais SET logo_arquivo = NULL, logo_mime = NULL WHERE id = ?').run(l.id);
    arquivos.remover({ arquivo: l.logo_arquivo });
    registrar(db, req, 'logo_do_ponto_removida', { local_id: l.id });
    res.status(204).end();
  });

  /** Acesso do lojista ao portal do próprio ponto (senha provisória que ele troca depois). */
  r.post('/locais/:id/acesso', (req, res) => {
    const l = db.prepare('SELECT * FROM locais WHERE id = ?').get(Number(req.params.id));
    if (!l) throw naoEncontrado('Ponto');
    const senha = senhaProvisoria();
    const id = Number(db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, local_id, criado_em) VALUES (?, ?, ?, 'lojista', ?, ?)")
      .run(v.texto(req.body.nome, 'o nome do responsável', 120), v.email(req.body.email), hashSenha(senha), l.id, agora()).lastInsertRowid);
    registrar(db, req, 'acesso_lojista_criado', { local_id: l.id, usuario_id: id });
    res.status(201).json({ id, senha_provisoria: senha });
  });

  // ----------------------------------------------------------------- TVs
  r.get('/telas', (req, res) => {
    const limite = new Date(Date.now() - cfg().offline_minutos * 60_000).toISOString();
    const onde = [];
    const p = [];
    if (req.query.local_id) { onde.push('t.local_id = ?'); p.push(Number(req.query.local_id)); }
    if (req.query.status) { onde.push('t.status = ?'); p.push(req.query.status); }
    if (req.query.busca) { onde.push('(t.nome LIKE ? OR l.nome LIKE ?)'); p.push(`%${req.query.busca}%`, `%${req.query.busca}%`); }
    const [doEmp, pe] = empresas.filtro(req, 'l.empresa_id');
    if (doEmp) { onde.push(doEmp.replace(' AND ', '')); p.push(...pe); }
    const itens = db.prepare(`SELECT t.*, l.nome AS local_nome, l.cidade, l.uf, l.categoria FROM telas t JOIN locais l ON l.id = t.local_id
      ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''} ORDER BY l.nome, t.nome`).all(...p)
      .map((t) => ({ ...t, online: Boolean(t.ultimo_contato && t.ultimo_contato > limite), pareada: Boolean(t.pareada_em) }));
    res.json({
      itens,
      // Com mais de uma empresa, só o master vê os códigos esperando: os demais digitam o código que está na TV.
      aguardando: (!empresas.empresaDe(req) || db.prepare('SELECT COUNT(*) AS n FROM empresas').get().n <= 1)
        ? db.prepare('SELECT id, codigo, aparelho, largura, altura, versao, criado_em, expira_em FROM pareamentos WHERE tela_id IS NULL AND expira_em > ? ORDER BY id DESC').all(agora())
        : [],
    });
  });

  r.get('/telas/:id', (req, res) => {
    const t = db.prepare(`SELECT t.*, l.nome AS local_nome, l.cidade, l.uf, l.categoria, l.publico_dia FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.id = ?`)
      .get(Number(req.params.id));
    if (!t) throw naoEncontrado('Tela');
    res.json({
      ...t,
      online: estaOnline(t, cfg()),
      aberto: pontoAberto(db, t.local_id),
      grade: montarPorTela(db, t.id),
      historico: uptime(db, t.id, 7),
      player_publicado: config.playerVersao,
      desatualizada: Boolean(t.pareada_em && t.versao_player && t.versao_player !== config.playerVersao),
      comandos: db.prepare('SELECT comando, criado_em, entregue_em FROM tela_comandos WHERE tela_id = ? ORDER BY id DESC LIMIT 5').all(t.id),
      hoje: db.prepare(`SELECT COALESCE(SUM(insercoes), 0) AS insercoes, COALESCE(SUM(segundos), 0) AS segundos,
        COALESCE(SUM(CASE WHEN campanha_id <> 0 THEN insercoes ELSE 0 END), 0) AS insercoes_pagas
        FROM resumo_dia WHERE tela_id = ? AND data = ?`).get(t.id, hoje()),
    });
  });

  /** A última foto que a TV mandou do que estava na tela (prova visual). */
  r.get('/telas/:id/foto', (req, res) => {
    const t = db.prepare('SELECT foto_arquivo, foto_em FROM telas WHERE id = ?').get(Number(req.params.id));
    if (!t?.foto_arquivo) throw naoEncontrado('Foto da tela');
    const caminho = arquivos.caminho({ arquivo: t.foto_arquivo });
    if (!require('node:fs').existsSync(caminho)) throw naoEncontrado('Arquivo da foto');
    const tipos = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    res.set({ 'Content-Type': tipos[t.foto_arquivo.split('.').pop()] ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=60' });
    require('node:fs').createReadStream(caminho).pipe(res);
  });

  r.post('/telas', (req, res) => {
    const local = db.prepare('SELECT * FROM locais WHERE id = ?').get(Number(req.body.local_id));
    if (!local) throw new ErroNegocio('Ponto não encontrado.', 422);
    const d = {
      local_id: local.id,
      nome: v.texto(req.body.nome, 'o nome da tela', 120),
      posicao: v.posicao(req.body.posicao),
      layout: v.opcao(req.body.layout ?? 'cheia', 'o layout', ['cheia', 'dividida']),
      orientacao: v.opcao(req.body.orientacao ?? 'paisagem', 'a orientação', ['paisagem', 'retrato']),
      som: v.booleano(req.body.som) ? 1 : 0,
      relogio: req.body.relogio === undefined ? 1 : (v.booleano(req.body.relogio) ? 1 : 0),
      legenda: v.opcional(req.body.legenda, 'a legenda', 200),
      observacao: v.opcional(req.body.observacao, 'a observação', 500),
    };
    const id = Number(db.prepare(`INSERT INTO telas (${Object.keys(d).join(', ')}, criado_em) VALUES (${Object.keys(d).map(() => '?').join(', ')}, ?)`)
      .run(...Object.values(d), agora()).lastInsertRowid);
    registrar(db, req, 'tela_criada', { id, nome: d.nome, local_id: local.id });
    res.status(201).json({ id, ...d });
  });

  r.patch('/telas/:id', (req, res) => {
    const id = Number(req.params.id);
    const t = db.prepare('SELECT * FROM telas WHERE id = ?').get(id);
    if (!t) throw naoEncontrado('Tela');
    const d = {};
    if (req.body.nome !== undefined) d.nome = v.texto(req.body.nome, 'o nome da tela', 120);
    if (req.body.posicao !== undefined) d.posicao = v.posicao(req.body.posicao);
    if (req.body.layout !== undefined) d.layout = v.opcao(req.body.layout, 'o layout', ['cheia', 'dividida']);
    if (req.body.orientacao !== undefined) d.orientacao = v.opcao(req.body.orientacao, 'a orientação', ['paisagem', 'retrato']);
    if (req.body.status !== undefined) d.status = v.opcao(req.body.status, 'a situação', ['ativa', 'manutencao', 'inativa']);
    if (req.body.som !== undefined) d.som = v.booleano(req.body.som) ? 1 : 0;
    if (req.body.relogio !== undefined) d.relogio = v.booleano(req.body.relogio) ? 1 : 0;
    if (req.body.legenda !== undefined) d.legenda = v.opcional(req.body.legenda, 'a legenda', 200);
    if (req.body.observacao !== undefined) d.observacao = v.opcional(req.body.observacao, 'a observação', 500);
    if (req.body.local_id !== undefined) {
      const local = db.prepare('SELECT 1 FROM locais WHERE id = ?').get(Number(req.body.local_id));
      if (!local) throw new ErroNegocio('Ponto não encontrado.', 422);
      d.local_id = Number(req.body.local_id);
    }
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    db.prepare(`UPDATE telas SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'tela_alterada', { id, depois: d });
    res.json(db.prepare('SELECT * FROM telas WHERE id = ?').get(id));
  });

  /** Aviso que passa na faixa da TV por algumas horas (promoção do dia, recado do ponto). */
  r.put('/telas/:id/aviso', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM telas WHERE id = ?').get(id)) throw naoEncontrado('Tela');
    const texto = v.avisos(req.body.aviso, 200);
    const horas = texto ? v.inteiro(req.body.horas ?? 12, 'as horas', { min: 1, max: 720 }) : 0;
    db.prepare('UPDATE telas SET aviso = ?, aviso_ate = ? WHERE id = ?')
      .run(texto, texto ? new Date(Date.now() + horas * 3_600_000).toISOString() : null, id);
    registrar(db, req, 'tela_aviso', { id, aviso: texto, horas });
    res.json(db.prepare('SELECT id, aviso, aviso_ate FROM telas WHERE id = ?').get(id));
  });

  /**
   * Pareamento: a equipe digita o código que apareceu na TV. Pode ligar numa tela já cadastrada
   * ou criar a tela na hora (informando o ponto).
   */
  r.post('/telas/parear', (req, res) => {
    const codigo = String(req.body.codigo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const p = db.prepare('SELECT * FROM pareamentos WHERE codigo = ?').get(codigo);
    if (!p) throw new ErroNegocio('Código não encontrado. Confira o que está na TV.', 404);
    if (p.expira_em < agora()) throw new ErroNegocio('Código expirado. Recarregue a tela do player para gerar outro.', 410);
    if (p.tela_id) throw new ErroNegocio('Este código já foi usado.', 409);

    const resultado = transacao(db, () => {
      let telaId = req.body.tela_id ? Number(req.body.tela_id) : null;
      if (telaId) {
        if (!db.prepare('SELECT 1 FROM telas WHERE id = ?').get(telaId)) throw naoEncontrado('Tela');
      } else {
        const local = db.prepare('SELECT * FROM locais WHERE id = ?').get(Number(req.body.local_id));
        if (!local) throw new ErroNegocio('Informe o ponto onde esta TV está instalada.', 422);
        const orientacao = req.body.orientacao ? v.opcao(req.body.orientacao, 'a orientação', ['paisagem', 'retrato'])
          : (p.altura && p.largura && p.altura > p.largura ? 'retrato' : 'paisagem');
        telaId = Number(db.prepare('INSERT INTO telas (local_id, nome, orientacao, criado_em) VALUES (?, ?, ?, ?)')
          .run(local.id, v.texto(req.body.nome ?? `TV ${local.nome}`, 'o nome da tela', 120), orientacao, agora()).lastInsertRowid);
      }
      db.prepare(`UPDATE telas SET token_versao = token_versao + 1, pareada_em = ?, aparelho = ?, largura = ?, altura = ?, versao_player = ?, grade_versao = NULL
        WHERE id = ?`).run(agora(), p.aparelho, p.largura, p.altura, p.versao, telaId);
      db.prepare('UPDATE pareamentos SET tela_id = ?, pareado_em = ? WHERE id = ?').run(telaId, agora(), p.id);
      db.prepare("INSERT INTO telas_eventos (tela_id, tipo, detalhe, criado_em) VALUES (?, 'pareada', ?, ?)")
        .run(telaId, `Aparelho pareado pelo código ${codigo}${p.aparelho ? ` — ${p.aparelho}` : ''}`, agora());
      return telaId;
    });
    registrar(db, req, 'tela_pareada', { tela_id: resultado, codigo });
    res.status(201).json(db.prepare(`SELECT t.*, l.nome AS local_nome FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.id = ?`).get(resultado));
  });

  /**
   * Comando remoto para as telas: recarregar o player (para subir versão nova), limpar o cache dos
   * arquivos ou reiniciar. Vai na próxima batida, que acontece de minuto em minuto.
   */
  r.post('/telas/comando', (req, res) => {
    const comando = v.opcao(req.body.comando, 'o comando', ['recarregar', 'limpar_cache', 'reiniciar']);
    let onde = 'AND t.pareada_em IS NOT NULL';
    const p = [];
    if (req.body.tela_id) { onde += ' AND t.id = ?'; p.push(Number(req.body.tela_id)); }
    else if (req.body.local_id) { onde += ' AND t.local_id = ?'; p.push(Number(req.body.local_id)); }
    else if (req.body.desatualizadas) { onde += ' AND (t.versao_player IS NULL OR t.versao_player <> ?)'; p.push(config.playerVersao); }
    const [doEmp, pe] = empresas.filtro(req, 'l.empresa_id');
    const telas = db.prepare(`SELECT t.id FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.status <> 'inativa' ${onde}${doEmp}`).all(...p, ...pe);
    if (!telas.length) throw new ErroNegocio('Nenhuma tela pareada para receber o comando.', 422);
    transacao(db, () => {
      for (const t of telas) {
        db.prepare('INSERT INTO tela_comandos (tela_id, comando, criado_por, criado_em) VALUES (?, ?, ?, ?)').run(t.id, comando, req.usuario.id, agora());
        db.prepare("INSERT INTO telas_eventos (tela_id, tipo, detalhe, criado_em) VALUES (?, 'comando', ?, ?)").run(t.id, `Comando enviado: ${comando}`, agora());
      }
    });
    registrar(db, req, 'telas_comando', { comando, telas: telas.length });
    res.status(201).json({ comando, telas: telas.length, aviso: 'Chega na próxima batida de cada tela (até um minuto).' });
  });

  /** Desparear: o aparelho atual perde o acesso e precisa de um código novo. */
  r.post('/telas/:id/desparear', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM telas WHERE id = ?').get(id)) throw naoEncontrado('Tela');
    db.prepare('UPDATE telas SET token_versao = token_versao + 1, pareada_em = NULL, ultimo_contato = NULL, grade_versao = NULL, item_atual = NULL WHERE id = ?').run(id);
    db.prepare('DELETE FROM pareamentos WHERE tela_id = ?').run(id);
    db.prepare("INSERT INTO telas_eventos (tela_id, tipo, detalhe, criado_em) VALUES (?, 'desparear', ?, ?)").run(id, 'Aparelho despareado no painel', agora());
    registrar(db, req, 'tela_despareada', { id });
    res.status(204).end();
  });

  r.delete('/telas/:id', permitir('master', 'administrador'), (req, res) => {
    const id = Number(req.params.id);
    const t = db.prepare('SELECT * FROM telas WHERE id = ?').get(id);
    if (!t) throw naoEncontrado('Tela');
    if (db.prepare('SELECT 1 FROM exibicoes WHERE tela_id = ? LIMIT 1').get(id)) {
      throw new ErroNegocio('Esta tela já tem histórico de exibições. Marque como inativa em vez de excluir.', 409);
    }
    db.prepare('DELETE FROM telas WHERE id = ?').run(id);
    registrar(db, req, 'tela_excluida', { id, nome: t.nome });
    res.status(204).end();
  });

  // ----------------------------------------------------------------- Comunicados do ponto
  /**
   * Comunicado é o recado do próprio ponto na tela ("assembleia dia 12", "elevador em manutenção").
   * Em condomínio, costuma ser a contrapartida pelo espaço. O síndico escreve no portal; a equipe aprova aqui.
   */
  r.get('/comunicados', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.local_id) { onde.push('c.local_id = ?'); p.push(Number(req.query.local_id)); }
    if (req.query.status) { onde.push('c.status = ?'); p.push(req.query.status); }
    const [doEmp, pe] = empresas.filtro(req, 'l.empresa_id');
    if (doEmp) { onde.push(doEmp.replace(' AND ', '')); p.push(...pe); }
    res.json({
      itens: db.prepare(`SELECT c.*, l.nome AS local_nome, l.cidade, u.nome AS autor FROM comunicados c
        JOIN locais l ON l.id = c.local_id LEFT JOIN usuarios u ON u.id = c.criado_por
        ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''}
        ORDER BY (c.status = 'pendente') DESC, c.fim DESC, c.id DESC`).all(...p),
      pendentes: db.prepare(`SELECT COUNT(*) AS n FROM comunicados c JOIN locais l ON l.id = c.local_id WHERE c.status = 'pendente'${doEmp}`).get(...pe).n,
    });
  });

  r.post('/comunicados', (req, res) => {
    const d = lerComunicado(db, req.body);
    // Lista de colunas montada do que veio: campos opcionais (duração, data do evento) ficam no padrão do banco.
    const campos = { ...d, status: 'aprovado', criado_por: req.usuario.id, aprovado_por: req.usuario.id, aprovado_em: agora(), criado_em: agora() };
    const id = Number(db.prepare(`INSERT INTO comunicados (${Object.keys(campos).join(', ')})
      VALUES (${Object.keys(campos).map(() => '?').join(', ')})`).run(...Object.values(campos)).lastInsertRowid);
    registrar(db, req, 'comunicado_criado', { id, local_id: d.local_id });
    res.status(201).json(db.prepare('SELECT * FROM comunicados WHERE id = ?').get(id));
  });

  r.patch('/comunicados/:id', (req, res) => {
    const id = Number(req.params.id);
    const atual = db.prepare('SELECT * FROM comunicados WHERE id = ?').get(id);
    if (!atual) throw naoEncontrado('Comunicado');
    const d = lerComunicado(db, { local_id: atual.local_id, ...req.body }, true);
    delete d.local_id;
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    db.prepare(`UPDATE comunicados SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'comunicado_alterado', { id });
    res.json(db.prepare('SELECT * FROM comunicados WHERE id = ?').get(id));
  });

  r.post('/comunicados/:id/aprovacao', (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare('SELECT * FROM comunicados WHERE id = ?').get(id);
    if (!c) throw naoEncontrado('Comunicado');
    const aprovar = v.opcao(req.body.decisao, 'a decisão', ['aprovar', 'recusar']) === 'aprovar';
    db.prepare('UPDATE comunicados SET status = ?, motivo = ?, aprovado_por = ?, aprovado_em = ? WHERE id = ?')
      .run(aprovar ? 'aprovado' : 'recusado', aprovar ? null : v.texto(req.body.motivo, 'o motivo da recusa', 300), req.usuario.id, agora(), id);
    registrar(db, req, aprovar ? 'comunicado_aprovado' : 'comunicado_recusado', { id, local_id: c.local_id });
    res.json(db.prepare('SELECT * FROM comunicados WHERE id = ?').get(id));
  });

  // Foto do comunicado (arquivo no corpo): cobre o espaço do recado na TV.
  const comunicado = (id) => db.prepare('SELECT * FROM comunicados WHERE id = ?').get(Number(id));
  r.post('/comunicados/:id/imagem', (req, res) => res.status(201).json(foto.salvar(db, req, comunicado(req.params.id), 'comunicado_foto')));
  r.get('/comunicados/:id/imagem', (req, res) => foto.enviar(res, comunicado(req.params.id)));
  r.delete('/comunicados/:id/imagem', (req, res) => { foto.remover(db, req, comunicado(req.params.id), 'comunicado_foto_removida'); res.status(204).end(); });

  r.delete('/comunicados/:id', (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare('SELECT imagem_arquivo FROM comunicados WHERE id = ?').get(id);
    if (!c) throw naoEncontrado('Comunicado');
    db.prepare('UPDATE exibicoes SET comunicado_id = NULL WHERE comunicado_id = ?').run(id);
    db.prepare('DELETE FROM comunicados WHERE id = ?').run(id);
    if (c.imagem_arquivo) arquivos.remover({ arquivo: c.imagem_arquivo });
    registrar(db, req, 'comunicado_excluido', { id });
    res.status(204).end();
  });

  // ----------------------------------------------------------------- Anunciantes
  r.get('/anunciantes', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.busca) { onde.push('(a.nome LIKE ? OR a.documento LIKE ?)'); p.push(`%${req.query.busca}%`, `%${req.query.busca}%`); }
    if (req.query.status) { onde.push('a.status = ?'); p.push(req.query.status); }
    const [doEmp, pe] = empresas.filtro(req, 'a.empresa_id');
    if (doEmp) { onde.push(doEmp.replace(' AND ', '')); p.push(...pe); }
    res.json({
      itens: db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM campanhas c WHERE c.anunciante_id = a.id AND c.status = 'ativa') AS campanhas_ativas,
          (SELECT COUNT(*) FROM campanhas c WHERE c.anunciante_id = a.id) AS campanhas,
          (SELECT COALESCE(SUM(f.valor_centavos), 0) FROM faturas f WHERE f.anunciante_id = a.id AND f.status = 'aberta') AS aberto_centavos
        FROM anunciantes a ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''} ORDER BY a.nome`).all(...p),
    });
  });

  r.get('/anunciantes/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM anunciantes WHERE id = ?').get(Number(req.params.id));
    if (!a) throw naoEncontrado('Anunciante');
    const data = hoje();
    const faturas = db.prepare('SELECT * FROM faturas WHERE anunciante_id = ? ORDER BY competencia DESC').all(a.id);
    const soma = (f) => faturas.filter(f).reduce((t, x) => t + x.valor_centavos, 0);
    res.json({
      ...a,
      // Contratos e financeiro do cliente ficam na ficha dele: é onde se procura quando o telefone toca.
      contratos: db.prepare(`SELECT c.*, ag.nome AS agencia, (SELECT COUNT(*) FROM campanhas x WHERE x.contrato_id = c.id) AS campanhas
        FROM contratos c LEFT JOIN agencias ag ON ag.id = c.agencia_id WHERE c.anunciante_id = ?
        ORDER BY CASE c.status WHEN 'ativo' THEN 0 WHEN 'suspenso' THEN 1 WHEN 'rascunho' THEN 2 ELSE 3 END, c.inicio DESC`).all(a.id)
        .map((c) => contratosLib.comCiclo(c)),
      financeiro: {
        aberto_centavos: soma((f) => f.status === 'aberta'),
        atrasado_centavos: soma((f) => f.status === 'aberta' && f.vencimento < data),
        recebido_centavos: soma((f) => f.status === 'paga'),
        faturas_abertas: faturas.filter((f) => f.status === 'aberta').length,
        proxima: faturas.filter((f) => f.status === 'aberta').sort((x, y) => x.vencimento.localeCompare(y.vencimento))[0] ?? null,
        ultimo_pagamento: faturas.filter((f) => f.status === 'paga' && f.pago_em).sort((x, y) => y.pago_em.localeCompare(x.pago_em))[0] ?? null,
      },
      // Histórico de pagamento, do mais recente para o mais antigo.
      pagamentos: faturas.filter((f) => f.status === 'paga').slice(0, 24)
        .map((f) => ({ competencia: f.competencia, valor_centavos: f.valor_centavos, vencimento: f.vencimento, pago_em: f.pago_em })),
      campanhas: db.prepare(`SELECT c.id, c.nome, c.status, c.inicio, c.fim, c.cobranca, c.valor_centavos, c.cpm_centavos, ct.numero AS contrato
        FROM campanhas c LEFT JOIN contratos ct ON ct.id = c.contrato_id WHERE c.anunciante_id = ? ORDER BY c.inicio DESC`).all(a.id),
      midias: db.prepare('SELECT id, nome, tipo, status, duracao_s, validade_ate, criado_em FROM midias WHERE anunciante_id = ? ORDER BY id DESC').all(a.id),
      faturas: faturas.slice(0, 12),
      usuarios: db.prepare("SELECT id, nome, email, ativo, ultimo_acesso FROM usuarios WHERE anunciante_id = ? AND perfil = 'anunciante'").all(a.id),
    });
  });

  const lerAnunciante = (c, parcial = false) => {
    const d = {};
    if (c.nome !== undefined || !parcial) d.nome = v.texto(c.nome, 'o nome do anunciante', 120);
    if (c.documento !== undefined) d.documento = c.documento === null || c.documento === '' ? null : v.documento(c.documento);
    if (c.contato !== undefined) d.contato = v.opcional(c.contato, 'o contato', 120);
    if (c.email !== undefined) d.email = c.email === null || c.email === '' ? null : v.email(c.email);
    if (c.telefone !== undefined) d.telefone = c.telefone === null || c.telefone === '' ? null : v.telefone(c.telefone);
    if (c.status !== undefined) d.status = v.opcao(c.status, 'a situação', ['ativo', 'inativo']);
    if (c.observacao !== undefined) d.observacao = v.opcional(c.observacao, 'a observação', 500);
    return d;
  };

  r.post('/anunciantes', (req, res) => {
    const d = lerAnunciante(req.body);
    d.empresa_id = empresas.empresaParaGravar(db, req, req.body.empresa_id);
    const id = Number(db.prepare(`INSERT INTO anunciantes (${Object.keys(d).join(', ')}, criado_em) VALUES (${Object.keys(d).map(() => '?').join(', ')}, ?)`)
      .run(...Object.values(d), agora()).lastInsertRowid);
    registrar(db, req, 'anunciante_criado', { id, nome: d.nome });
    res.status(201).json({ id, ...d });
  });

  r.patch('/anunciantes/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM anunciantes WHERE id = ?').get(id)) throw naoEncontrado('Anunciante');
    const d = lerAnunciante(req.body, true);
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    db.prepare(`UPDATE anunciantes SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'anunciante_alterado', { id, depois: d });
    res.json(db.prepare('SELECT * FROM anunciantes WHERE id = ?').get(id));
  });

  r.delete('/anunciantes/:id', permitir('master', 'administrador'), (req, res) => {
    const id = Number(req.params.id);
    const a = db.prepare('SELECT * FROM anunciantes WHERE id = ?').get(id);
    if (!a) throw naoEncontrado('Anunciante');
    if (db.prepare('SELECT 1 FROM campanhas WHERE anunciante_id = ? LIMIT 1').get(id)) {
      throw new ErroNegocio('Este anunciante tem campanhas. Marque como inativo em vez de excluir.', 409);
    }
    transacao(db, () => {
      db.prepare("DELETE FROM usuarios WHERE anunciante_id = ? AND perfil = 'anunciante'").run(id);
      db.prepare('DELETE FROM anunciantes WHERE id = ?').run(id);
    });
    registrar(db, req, 'anunciante_excluido', { id, nome: a.nome });
    res.status(204).end();
  });

  /** Acesso do anunciante ao portal (vê onde a campanha dele rodou e as faturas). */
  r.post('/anunciantes/:id/acesso', (req, res) => {
    const a = db.prepare('SELECT * FROM anunciantes WHERE id = ?').get(Number(req.params.id));
    if (!a) throw naoEncontrado('Anunciante');
    const senha = senhaProvisoria();
    const id = Number(db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, anunciante_id, criado_em) VALUES (?, ?, ?, 'anunciante', ?, ?)")
      .run(v.texto(req.body.nome, 'o nome da pessoa', 120), v.email(req.body.email), hashSenha(senha), a.id, agora()).lastInsertRowid);
    registrar(db, req, 'acesso_anunciante_criado', { anunciante_id: a.id, usuario_id: id });
    res.status(201).json({ id, senha_provisoria: senha });
  });

  return r;
};

module.exports.lerComunicado = lerComunicado;
