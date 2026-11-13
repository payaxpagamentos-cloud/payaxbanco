'use strict';

const fs = require('node:fs');
const { Router } = require('express');
const config = require('../config');
const { transacao, agora, lerConfig, CONFIG_PADRAO } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('./auditoria');
const { criarChaveApi } = require('../lib/empresas');
const { dashboard, relatorio } = require('./painel');
const { periodo, listarChamadas, csv, reais, enviarCsv, COLUNAS_CHAMADAS } = require('./consultas');
const { hoje, intervalo } = require('../lib/datas');
const v = require('../lib/validacao');

const TIPOS = ['pabx', 'discador', 'callcenter'];
const iniciado = new Date().toISOString();

/**
 * Telefonia no painel do master (/api/master/telefonia): a telefonia de cada empresa (ligada, limites,
 * tarifas, rota), as rotas de saída (troncos), o estoque de números, as chamadas de todas as empresas
 * e a chave da central. Empresas, usuários e segurança são os da ZOE.
 */
module.exports = (db) => {
  const r = Router();
  r.use(permitir('master', 'suporte'));
  const soMaster = permitir('master');
  const nid = (req) => Number(req.params.id);
  const empresa = (id) => {
    const e = db.prepare("SELECT * FROM empresas WHERE id = ? AND status <> 'excluida'").get(Number(id));
    if (!e) throw naoEncontrado('Empresa');
    return e;
  };
  const tronco = (id) => {
    if (id === null || id === undefined || id === '') return null;
    v.exigir(db.prepare('SELECT 1 FROM pabx_troncos WHERE id = ?').get(Number(id)), 'Rota de terminação não encontrada.');
    return Number(id);
  };

  r.get('/dashboard', (_req, res) => {
    const [ini, fim] = intervalo(hoje(), hoje());
    res.json({
      ...dashboard(db),
      empresas: Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM empresas WHERE status <> 'excluida' GROUP BY status").all().map((x) => [x.status, x.n])),
      top_empresas: db.prepare(`SELECT e.id, e.nome, COUNT(c.id) AS chamadas, COALESCE(SUM(c.custo_centavos),0) AS custo_centavos,
          (SELECT COUNT(*) FROM pabx_chamadas x WHERE x.empresa_id = e.id AND x.fim IS NULL) AS em_curso
        FROM empresas e JOIN pabx_chamadas c ON c.empresa_id = e.id AND c.inicio >= ? AND c.inicio < ?
        WHERE e.status <> 'excluida' GROUP BY e.id ORDER BY chamadas DESC LIMIT 10`).all(ini, fim),
    });
  });

  // ---------- Empresas ----------
  r.get('/empresas', (req, res) => {
    const q = req.query;
    const onde = ["e.status <> 'excluida'"];
    const p = [];
    if (q.busca) { onde.push('(e.nome LIKE ? OR e.documento LIKE ?)'); p.push(`%${String(q.busca).trim()}%`, `%${v.digitos(q.busca) || String(q.busca).trim()}%`); }
    if (q.tipo) { onde.push('e.telefonia_tipo = ?'); p.push(v.opcao(q.tipo, 'o tipo', TIPOS)); }
    if (q.status) { onde.push('e.status = ?'); p.push(v.opcao(q.status, 'o status', ['ativa', 'bloqueada'])); }
    const [ini, fim] = intervalo(hoje(), hoje());
    res.json(db.prepare(`SELECT e.id, e.nome, e.documento, e.telefonia_ativa, e.telefonia_tipo AS tipo, e.status, e.motivo_bloqueio, e.limite_ramais, e.limite_canais, e.disco_mb,
        e.tts_limite, e.stt_limite, e.tarifa_fixo_centavos, e.tarifa_movel_centavos, e.tarifa_internacional_centavos, e.tronco_id, e.gravar_chamadas,
        (SELECT COUNT(*) FROM chaves_api k WHERE k.empresa_id = e.id AND k.escopo = 'central' AND k.ativa = 1) AS chaves_central,
        (SELECT COUNT(*) FROM pabx_ramais r WHERE r.empresa_id = e.id AND r.ativo = 1) AS ramais,
        (SELECT COUNT(*) FROM pabx_ramais r WHERE r.empresa_id = e.id AND r.ativo = 1 AND r.online = 1) AS ramais_online,
        (SELECT COUNT(*) FROM pabx_chamadas c WHERE c.empresa_id = e.id AND c.fim IS NULL) AS chamadas_online,
        (SELECT COUNT(*) FROM pabx_chamadas c WHERE c.empresa_id = e.id AND c.inicio >= ? AND c.inicio < ?) AS chamadas_hoje,
        (SELECT COALESCE(SUM(c.gravacao_bytes),0) FROM pabx_chamadas c WHERE c.empresa_id = e.id) AS disco_bytes
      FROM empresas e WHERE ${onde.join(' AND ')} ORDER BY e.nome LIMIT 1000`).all(ini, fim, ...p));
  });


  const dadosEmpresa = (d, atual) => {
    const cfg = lerConfig(db);
    const num = (k, nome, padrao, max = 1_000_000) => (d[k] !== undefined && d[k] !== '' ? v.inteiro(d[k], nome, { min: 0, max }) : (atual?.[k] ?? padrao));
    return {
      telefonia_ativa: d.telefonia_ativa !== undefined ? (v.booleano(d.telefonia_ativa) ? 1 : 0) : (atual?.telefonia_ativa ?? 0),
      telefonia_tipo: v.opcao(d.tipo ?? d.telefonia_tipo ?? atual?.telefonia_tipo ?? 'pabx', 'o tipo', TIPOS),
      limite_ramais: num('limite_ramais', 'o limite de ramais', cfg.limite_ramais_padrao, 10_000),
      limite_canais: num('limite_canais', 'o limite de chamadas simultâneas', cfg.limite_canais_padrao, 10_000),
      disco_mb: num('disco_mb', 'o espaço em disco', cfg.disco_mb_padrao, 10_000_000),
      tts_limite: num('tts_limite', 'o limite de TTS', 0),
      stt_limite: num('stt_limite', 'o limite de STT', 0),
      tarifa_fixo_centavos: num('tarifa_fixo_centavos', 'a tarifa para fixo', cfg.tarifa_fixo_centavos, 100_000),
      tarifa_movel_centavos: num('tarifa_movel_centavos', 'a tarifa para móvel', cfg.tarifa_movel_centavos, 100_000),
      tarifa_internacional_centavos: num('tarifa_internacional_centavos', 'a tarifa internacional', cfg.tarifa_internacional_centavos, 100_000),
      tronco_id: d.tronco_id !== undefined ? tronco(d.tronco_id) : (atual?.tronco_id ?? null),
      gravar_chamadas: d.gravar_chamadas !== undefined ? (v.booleano(d.gravar_chamadas) ? 1 : 0) : (atual?.gravar_chamadas ?? 1),
    };
  };
  const CAMPOS = ['telefonia_ativa', 'telefonia_tipo', 'limite_ramais', 'limite_canais', 'disco_mb', 'tts_limite', 'stt_limite',
    'tarifa_fixo_centavos', 'tarifa_movel_centavos', 'tarifa_internacional_centavos', 'tronco_id', 'gravar_chamadas'];

  r.put('/empresas/:id', (req, res) => {
    const atual = empresa(req.params.id);
    const d = dadosEmpresa(req.body, atual);
    db.prepare(`UPDATE empresas SET ${CAMPOS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPOS.map((k) => d[k]), atual.id);
    registrar(db, req, 'empresa_alterada', { campos: CAMPOS.filter((k) => d[k] !== atual[k]) }, atual.id);
    res.status(204).end();
  });

  // ---------- Chamadas (todas as empresas) ----------
  r.get('/chamadas', (req, res) => res.json(listarChamadas(db, null, req.query)));
  r.get('/chamadas.csv', (req, res) => {
    const l = listarChamadas(db, null, req.query, { limite: 50_000 });
    enviarCsv(res, `chamadas-${l.de}-a-${l.ate}.csv`, csv(COLUNAS_CHAMADAS, l.itens));
  });

  // ---------- Relatórios ----------
  r.get('/relatorios', (req, res) => {
    const [de, ate] = periodo(req.query, 29);
    res.json(relatorio(db, req.query.empresa_id ? empresa(req.query.empresa_id).id : null, de, ate));
  });
  r.get('/relatorios.csv', (req, res) => {
    const [de, ate] = periodo(req.query, 29);
    const rel = relatorio(db, null, de, ate);
    enviarCsv(res, `relatorio-empresas-${de}-a-${ate}.csv`, csv([['nome', 'Empresa'], ['chamadas', 'Chamadas'], ['recebidas', 'Recebidas'], ['realizadas', 'Realizadas'],
      ['atendidas', 'Atendidas'], ['perdidas', 'Não atendidas'], ['duracao_s', 'Duração (s)'], ['tarifado_s', 'Tarifado (s)'], [(l) => reais(l.custo_centavos), 'Valor (R$)']], rel.por_empresa));
  });

  // ---------- Terminação: rotas (troncos) e estoque de números ----------
  const dadosTronco = (d, atual) => ({
    nome: v.texto(d.nome ?? atual?.nome, 'o nome da rota', 80),
    host: v.texto(d.host ?? atual?.host, 'o endereço (host) da operadora', 200),
    porta: v.inteiro(d.porta ?? atual?.porta ?? 5060, 'a porta', { min: 1, max: 65535 }),
    usuario: d.usuario !== undefined ? v.opcional(d.usuario, 'o usuário', 120) : (atual?.usuario ?? null),
    // Senha vazia na edição mantém a atual.
    senha: d.senha ? v.texto(d.senha, 'a senha', 200) : (atual?.senha ?? null),
    prefixo: d.prefixo !== undefined ? (v.digitos(d.prefixo) || null) : (atual?.prefixo ?? null),
    canais: v.inteiro(d.canais ?? atual?.canais ?? 30, 'o número de canais', { min: 1, max: 100_000 }),
    custo_fixo_centavos: v.inteiro(d.custo_fixo_centavos ?? atual?.custo_fixo_centavos ?? 0, 'o custo para fixo', { max: 100_000 }),
    custo_movel_centavos: v.inteiro(d.custo_movel_centavos ?? atual?.custo_movel_centavos ?? 0, 'o custo para móvel', { max: 100_000 }),
    custo_internacional_centavos: v.inteiro(d.custo_internacional_centavos ?? atual?.custo_internacional_centavos ?? 0, 'o custo internacional', { max: 100_000 }),
    ativo: d.ativo !== undefined ? (v.booleano(d.ativo) ? 1 : 0) : (atual?.ativo ?? 1),
  });
  const CAMPOS_TRONCO = ['nome', 'host', 'porta', 'usuario', 'senha', 'prefixo', 'canais', 'custo_fixo_centavos', 'custo_movel_centavos', 'custo_internacional_centavos', 'ativo'];
  r.get('/troncos', (_req, res) => {
    const [ini, fim] = intervalo(hoje(), hoje());
    res.json(db.prepare(`SELECT t.id, t.nome, t.host, t.porta, t.usuario, t.prefixo, t.canais, t.custo_fixo_centavos, t.custo_movel_centavos, t.custo_internacional_centavos,
        t.ativo, t.senha IS NOT NULL AS tem_senha,
        (SELECT COUNT(*) FROM empresas e WHERE e.tronco_id = t.id AND e.status <> 'excluida') AS empresas,
        (SELECT COUNT(*) FROM pabx_chamadas c WHERE c.tronco_id = t.id AND c.fim IS NULL) AS em_curso,
        (SELECT COUNT(*) FROM pabx_chamadas c WHERE c.tronco_id = t.id AND c.inicio >= ? AND c.inicio < ?) AS chamadas_hoje
      FROM pabx_troncos t ORDER BY t.nome`).all(ini, fim));
  });
  r.post('/troncos', soMaster, (req, res) => {
    const d = dadosTronco(req.body);
    const id = Number(db.prepare(`INSERT INTO pabx_troncos (${CAMPOS_TRONCO.join(', ')}, criado_em) VALUES (${CAMPOS_TRONCO.map(() => '?').join(', ')}, ?)`)
      .run(...CAMPOS_TRONCO.map((k) => d[k]), agora()).lastInsertRowid);
    registrar(db, req, 'tronco_criado', { id, nome: d.nome });
    res.status(201).json({ id });
  });
  r.put('/troncos/:id', soMaster, (req, res) => {
    const t = db.prepare('SELECT * FROM pabx_troncos WHERE id = ?').get(nid(req));
    if (!t) throw naoEncontrado('Rota');
    const d = dadosTronco(req.body, t);
    db.prepare(`UPDATE pabx_troncos SET ${CAMPOS_TRONCO.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPOS_TRONCO.map((k) => d[k]), t.id);
    registrar(db, req, 'tronco_alterado', { id: t.id });
    res.status(204).end();
  });
  r.delete('/troncos/:id', soMaster, (req, res) => {
    const t = db.prepare('SELECT * FROM pabx_troncos WHERE id = ?').get(nid(req));
    if (!t) throw naoEncontrado('Rota');
    v.exigir(!db.prepare("SELECT 1 FROM empresas WHERE tronco_id = ? AND status <> 'excluida'").get(t.id), 'Há empresas usando esta rota: troque a rota delas antes.');
    v.exigir(!db.prepare('SELECT 1 FROM pabx_chamadas WHERE tronco_id = ?').get(t.id), 'A rota já tem chamadas: desative em vez de excluir.');
    transacao(db, () => {
      db.prepare('UPDATE pabx_numeros SET tronco_id = NULL WHERE tronco_id = ?').run(t.id);
      db.prepare('UPDATE empresas SET tronco_id = NULL WHERE tronco_id = ?').run(t.id);
      db.prepare('DELETE FROM pabx_troncos WHERE id = ?').run(t.id);
    });
    registrar(db, req, 'tronco_excluido', { id: t.id, nome: t.nome });
    res.status(204).end();
  });

  r.get('/numeros', (req, res) => {
    const livres = req.query.livres === '1';
    res.json(db.prepare(`SELECT n.id, n.numero, n.descricao, n.tronco_id, t.nome AS tronco, n.empresa_id, e.nome AS empresa, n.destino_tipo
      FROM pabx_numeros n LEFT JOIN pabx_troncos t ON t.id = n.tronco_id LEFT JOIN empresas e ON e.id = n.empresa_id
      ${livres ? 'WHERE n.empresa_id IS NULL' : ''} ORDER BY n.numero LIMIT 5000`).all());
  });
  r.post('/numeros', soMaster, (req, res) => {
    const d = req.body;
    // Vários números de uma vez: um por linha (ou separados por vírgula).
    const lista = [...new Set(String(d.numeros ?? d.numero ?? '').split(/[\s,;]+/).filter(Boolean).map((n) => v.numeroTelefone(n)))];
    v.exigir(lista.length && lista.length <= 1000, 'Informe de 1 a 1000 números.');
    const empresaId = d.empresa_id ? empresa(d.empresa_id).id : null;
    const tid = tronco(d.tronco_id);
    const descricao = v.opcional(d.descricao, 'a descrição', 120);
    const ins = db.prepare('INSERT OR IGNORE INTO pabx_numeros (numero, descricao, tronco_id, empresa_id, criado_em) VALUES (?, ?, ?, ?, ?)');
    const criados = transacao(db, () => lista.reduce((n, num) => n + Number(ins.run(num, descricao, tid, empresaId, agora()).changes), 0));
    registrar(db, req, 'numeros_criados', { quantidade: criados }, empresaId);
    res.status(201).json({ criados, repetidos: lista.length - criados });
  });
  /** Atribui o número a uma empresa (ou devolve ao estoque) e troca a rota de entrada. Mudar de empresa limpa o destino. */
  r.patch('/numeros/:id', soMaster, (req, res) => {
    const n = db.prepare('SELECT * FROM pabx_numeros WHERE id = ?').get(nid(req));
    if (!n) throw naoEncontrado('Número');
    const d = req.body;
    const empresaId = d.empresa_id !== undefined ? (d.empresa_id ? empresa(d.empresa_id).id : null) : n.empresa_id;
    const mudou = empresaId !== n.empresa_id;
    db.prepare('UPDATE pabx_numeros SET empresa_id = ?, tronco_id = ?, descricao = ?, destino_tipo = ?, destino_id = ? WHERE id = ?').run(
      empresaId, d.tronco_id !== undefined ? tronco(d.tronco_id) : n.tronco_id,
      d.descricao !== undefined ? v.opcional(d.descricao, 'a descrição', 120) : n.descricao,
      mudou ? null : n.destino_tipo, mudou ? null : n.destino_id, n.id);
    registrar(db, req, 'numero_alterado', { numero: n.numero, empresa_id: empresaId }, empresaId);
    res.status(204).end();
  });
  r.delete('/numeros/:id', soMaster, (req, res) => {
    const n = db.prepare('SELECT * FROM pabx_numeros WHERE id = ?').get(nid(req));
    if (!n) throw naoEncontrado('Número');
    v.exigir(!db.prepare('SELECT 1 FROM pabx_chamadas WHERE numero_id = ?').get(n.id), 'O número já recebeu chamadas: devolva ao estoque em vez de excluir.');
    db.prepare('DELETE FROM pabx_numeros WHERE id = ?').run(n.id);
    registrar(db, req, 'numero_excluido', { numero: n.numero });
    res.status(204).end();
  });

  // ---------- Diagnóstico ----------
  r.get('/diagnostico', (_req, res) => {
    const cfg = lerConfig(db);
    let tamanho = null;
    try { tamanho = config.dbFile === ':memory:' ? null : fs.statSync(config.dbFile).size; } catch { /* sem arquivo */ }
    const ultima = db.prepare('SELECT MAX(inicio) AS t FROM pabx_chamadas').get().t;
    const ultimoUso = db.prepare('SELECT MAX(ultimo_uso) AS t FROM chaves_api').get().t;
    const ultimoRegistro = db.prepare('SELECT MAX(registro_em) AS t FROM pabx_ramais').get().t;
    const presas = db.prepare('SELECT COUNT(*) AS n FROM pabx_chamadas WHERE fim IS NULL AND inicio < ?').get(new Date(Date.now() - 2 * 3600_000).toISOString()).n;
    const semRota = db.prepare("SELECT COUNT(*) AS n FROM empresas WHERE status = 'ativa' AND telefonia_ativa = 1 AND tronco_id IS NULL").get().n;
    const semDestino = db.prepare('SELECT COUNT(*) AS n FROM pabx_numeros WHERE empresa_id IS NOT NULL AND destino_tipo IS NULL').get().n;
    const acimaDisco = db.prepare(`SELECT COUNT(*) AS n FROM empresas e WHERE e.status = 'ativa'
      AND (SELECT COALESCE(SUM(gravacao_bytes),0) FROM pabx_chamadas c WHERE c.empresa_id = e.id) >= e.disco_mb * 1048576`).get().n;
    const lotadas = db.prepare(`SELECT COUNT(*) AS n FROM empresas e WHERE e.status = 'ativa'
      AND (SELECT COUNT(*) FROM pabx_chamadas c WHERE c.empresa_id = e.id AND c.fim IS NULL) >= e.limite_canais AND e.limite_canais > 0`).get().n;
    const verificacoes = [
      ['Banco de dados', 'ok', `respondendo${tamanho ? ` · ${(tamanho / 1048576).toFixed(1)} MB` : ''}`],
      ['Central telefônica (integração)', ultimoUso && Date.now() - Date.parse(ultimoUso) < 3600_000 ? 'ok' : 'aviso',
        ultimoUso ? `último contato pela API em ${ultimoUso}` : 'nenhuma chamada à API de integração ainda'],
      ['Registro de ramais', ultimoRegistro && Date.now() - Date.parse(ultimoRegistro) < cfg.registro_expira_min * 60_000 ? 'ok' : 'aviso',
        ultimoRegistro ? `último registro em ${ultimoRegistro}` : 'nenhum ramal registrado ainda'],
      ['Chamadas presas', presas ? 'aviso' : 'ok', presas ? `${presas} chamada(s) em curso há mais de 2 h (encerradas sozinhas após ${cfg.chamada_max_horas} h)` : 'nenhuma'],
      ['Empresas sem rota de saída', semRota ? 'aviso' : 'ok', semRota ? `${semRota} empresa(s) ativa(s) sem terminação` : 'todas com rota'],
      ['Números sem destino', semDestino ? 'aviso' : 'ok', semDestino ? `${semDestino} número(s) de empresas sem destino configurado` : 'todos configurados'],
      ['Disco das gravações', acimaDisco ? 'erro' : 'ok', acimaDisco ? `${acimaDisco} empresa(s) sem espaço (as novas chamadas não são gravadas)` : 'todas dentro do limite'],
      ['Chamadas simultâneas', lotadas ? 'aviso' : 'ok', lotadas ? `${lotadas} empresa(s) no limite de canais agora` : 'nenhuma empresa no limite'],
    ].map(([nome, situacao, detalhe]) => ({ nome, situacao, detalhe }));
    res.json({
      verificacoes,
      servidor: {
        iniciado_em: iniciado, node: process.version, memoria_mb: Math.round(process.memoryUsage().rss / 1048576), fuso: config.fuso,
        ultima_chamada: ultima,
      },
      troncos: db.prepare(`SELECT t.nome, t.ativo, t.canais, (SELECT COUNT(*) FROM pabx_chamadas c WHERE c.tronco_id = t.id AND c.fim IS NULL) AS em_curso,
        (SELECT MAX(inicio) FROM pabx_chamadas c WHERE c.tronco_id = t.id) AS ultima_chamada FROM pabx_troncos t ORDER BY t.nome`).all(),
    });
  });

  // ---------- Configurações da plataforma ----------
  const CHAVES_CONFIG = ['cadencia_inicial_s', 'cadencia_s', 'tarifa_fixo_centavos', 'tarifa_movel_centavos', 'tarifa_internacional_centavos',
    'limite_ramais_padrao', 'limite_canais_padrao', 'disco_mb_padrao', 'chamada_max_horas', 'registro_expira_min'];
  r.get('/configuracoes', soMaster, (_req, res) => {
    const cfg = lerConfig(db);
    res.json(Object.fromEntries(CHAVES_CONFIG.map((k) => [k, cfg[k]])));
  });
  r.patch('/configuracoes', soMaster, (req, res) => {
    const d = req.body;
    const limites = {
      cadencia_inicial_s: [1, 600], cadencia_s: [1, 600], tarifa_fixo_centavos: [0, 100_000], tarifa_movel_centavos: [0, 100_000],
      tarifa_internacional_centavos: [0, 100_000], limite_ramais_padrao: [0, 10_000], limite_canais_padrao: [0, 10_000], disco_mb_padrao: [0, 10_000_000],
      chamada_max_horas: [1, 48], registro_expira_min: [1, 1440],
    };
    const novos = {};
    for (const k of Object.keys(d)) {
      v.exigir(CHAVES_CONFIG.includes(k), `Configuração desconhecida: ${k}.`);
      novos[k] = String(v.inteiro(d[k], k.replace(/_/g, ' '), { min: limites[k][0], max: limites[k][1] }));
    }
    transacao(db, () => {
      const up = db.prepare('UPDATE configuracoes SET valor = ? WHERE chave = ?');
      for (const [k, val] of Object.entries(novos)) up.run(val, k);
    });
    registrar(db, req, 'configuracoes', novos);
    res.status(204).end();
  });

  // ---------- Chave da central telefônica (uma por empresa ou por central) ----------
  r.get('/chaves', (_req, res) => res.json(db.prepare(`SELECT k.id, k.nome, k.prefixo, k.criada_em, k.ultimo_uso, k.ativa, e.id AS empresa_id, e.nome AS empresa
    FROM chaves_api k JOIN empresas e ON e.id = k.empresa_id WHERE k.escopo = 'central' AND e.status <> 'excluida' ORDER BY k.id DESC LIMIT 1000`).all()
    .map((k) => ({ ...k, ativa: Boolean(k.ativa) }))));
  r.post('/chaves', soMaster, (req, res) => {
    const e = empresa(req.body.empresa_id);
    const k = criarChaveApi(db, e.id, req.body.nome || 'Central telefônica', { escopo: 'central', usuarioId: req.usuario.id });
    registrar(db, req, 'chave_central_criada', { id: k.id, prefixo: k.prefixo }, e.id);
    res.status(201).json(k);
  });
  r.delete('/chaves/:id', soMaster, (req, res) => {
    const k = db.prepare("SELECT * FROM chaves_api WHERE id = ? AND escopo = 'central'").get(nid(req));
    if (!k) throw naoEncontrado('Chave');
    db.prepare('UPDATE chaves_api SET ativa = 0 WHERE id = ?').run(k.id);
    registrar(db, req, 'chave_central_revogada', { id: k.id, prefixo: k.prefixo }, k.empresa_id);
    res.status(204).end();
  });

  return r;
};
