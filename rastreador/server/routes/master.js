'use strict';

const fs = require('node:fs');
const { Router } = require('express');
const config = require('../config');
const { transacao, agora, lerConfig, CONFIG_PADRAO, CONFIG_TEXTO } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { criarUsuario, alterarUsuario, criarChave } = require('../lib/contas');
const { veiculosMapa } = require('../lib/relatorios');
const { hoje, somarDias } = require('../lib/datas');
const v = require('../lib/validacao');

const TIPOS = ['frota', 'pessoa', 'locadora'];
const PROTOCOLOS = ['gt06', 'osmand', 'api'];
const PERFIS = ['master', 'suporte', 'cliente', 'operador'];
const iniciado = new Date().toISOString();

/**
 * Painel do master (equipe da plataforma): empresas, estoque de rastreadores, mapa de todas as frotas, usuários, configurações,
 * diagnóstico e integrações. O suporte consulta e cuida de empresas e rastreadores; usuários, configurações e exclusões são do master.
 */
module.exports = (db, extras = {}) => {
  const r = Router();
  r.use(permitir('master', 'suporte'));
  const soMaster = permitir('master');
  const nid = (req) => Number(req.params.id);
  const empresa = (id) => {
    const e = Number.isInteger(Number(id)) ? db.prepare("SELECT * FROM empresas WHERE id = ? AND status <> 'excluida'").get(Number(id)) : null;
    if (!e) throw naoEncontrado('Empresa');
    return e;
  };
  const rastreador = (id) => {
    const x = db.prepare('SELECT * FROM rastreadores WHERE id = ?').get(Number(id));
    if (!x) throw naoEncontrado('Rastreador');
    return x;
  };

  r.get('/dashboard', (_req, res) => {
    const cfg = lerConfig(db);
    const corte = new Date(Date.now() - cfg.online_min * 60_000).toISOString();
    const dHoje = hoje();
    const recepcao = db.prepare('SELECT data, SUM(mensagens) AS n FROM recepcao_diaria WHERE data >= ? GROUP BY data').all(somarDias(dHoje, -13));
    const porDia = new Map(recepcao.map((x) => [x.data, x.n]));
    res.json({
      empresas: Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM empresas WHERE status <> 'excluida' GROUP BY status").all().map((x) => [x.status, x.n])),
      veiculos: db.prepare(`SELECT COUNT(*) AS total, COUNT(CASE WHEN v.comunicacao_em >= ? THEN 1 END) AS online
        FROM veiculos v JOIN empresas e ON e.id = v.empresa_id WHERE v.ativo = 1 AND e.status <> 'excluida'`).get(corte),
      rastreadores: db.prepare(`SELECT COUNT(*) AS total, COUNT(CASE WHEN r.empresa_id IS NULL THEN 1 END) AS estoque,
        COUNT(CASE WHEN v.id IS NOT NULL THEN 1 END) AS instalados FROM rastreadores r LEFT JOIN veiculos v ON v.rastreador_id = r.id`).get(),
      desconhecidos: db.prepare('SELECT COUNT(*) AS n FROM desconhecidos').get().n,
      conexoes_gt06: extras.gt06 ? extras.gt06.conectados() : null,
      mensagens_hoje: porDia.get(dHoje) ?? 0,
      mensagens_por_dia: Array.from({ length: 14 }, (_, i) => somarDias(dHoje, i - 13)).map((d) => ({ data: d, mensagens: porDia.get(d) ?? 0 })),
      alertas_pendentes: db.prepare("SELECT COUNT(*) AS n FROM alertas a JOIN empresas e ON e.id = a.empresa_id WHERE a.tratado_em IS NULL AND e.status <> 'excluida'").get().n,
      faturamento_mensal_centavos: db.prepare(`SELECT COALESCE(SUM(e.mensalidade_centavos * (SELECT COUNT(*) FROM veiculos v WHERE v.empresa_id = e.id AND v.ativo = 1)),0) AS c
        FROM empresas e WHERE e.status = 'ativa'`).get().c,
      top_empresas: db.prepare(`SELECT e.id, e.nome, e.limite_veiculos, COUNT(v.id) AS veiculos, COUNT(CASE WHEN v.comunicacao_em >= ? THEN 1 END) AS online,
          (SELECT COUNT(*) FROM alertas a WHERE a.empresa_id = e.id AND a.tratado_em IS NULL) AS alertas_pendentes
        FROM empresas e LEFT JOIN veiculos v ON v.empresa_id = e.id AND v.ativo = 1 WHERE e.status <> 'excluida'
        GROUP BY e.id ORDER BY veiculos DESC, e.nome LIMIT 10`).all(corte),
    });
  });

  r.get('/mapa', (_req, res) => res.json({ veiculos: veiculosMapa(db) }));

  // ---------- Empresas ----------
  r.get('/empresas', (req, res) => {
    const q = req.query;
    const cfg = lerConfig(db);
    const onde = ["e.status <> 'excluida'"];
    const p = [];
    if (q.busca) { onde.push('(e.nome LIKE ? OR e.documento LIKE ?)'); p.push(`%${String(q.busca).trim()}%`, `%${v.digitos(q.busca) || String(q.busca).trim()}%`); }
    if (q.tipo) { onde.push('e.tipo = ?'); p.push(v.opcao(q.tipo, 'o tipo', TIPOS)); }
    if (q.status) { onde.push('e.status = ?'); p.push(v.opcao(q.status, 'o status', ['ativa', 'bloqueada'])); }
    res.json(db.prepare(`SELECT e.id, e.nome, e.documento, e.tipo, e.status, e.motivo_bloqueio, e.limite_veiculos, e.mensalidade_centavos, e.email, e.telefone,
        (SELECT COUNT(*) FROM veiculos v WHERE v.empresa_id = e.id AND v.ativo = 1) AS veiculos,
        (SELECT COUNT(*) FROM veiculos v WHERE v.empresa_id = e.id AND v.ativo = 1 AND v.comunicacao_em >= ?) AS online,
        (SELECT COUNT(*) FROM rastreadores r WHERE r.empresa_id = e.id) AS rastreadores,
        (SELECT COUNT(*) FROM alertas a WHERE a.empresa_id = e.id AND a.tratado_em IS NULL) AS alertas_pendentes
      FROM empresas e WHERE ${onde.join(' AND ')} ORDER BY e.nome LIMIT 1000`).all(new Date(Date.now() - cfg.online_min * 60_000).toISOString(), ...p));
  });

  r.get('/empresas/:id', (req, res) => {
    const e = empresa(req.params.id);
    res.json({ ...e, usuarios: db.prepare('SELECT id, nome, email, perfil, ativo, ultimo_acesso FROM usuarios WHERE empresa_id = ? ORDER BY nome').all(e.id) });
  });

  const dadosEmpresa = (d, atual) => {
    const cfg = lerConfig(db);
    const num = (k, nome, padrao, max) => (d[k] !== undefined && d[k] !== '' ? v.inteiro(d[k], nome, { min: 0, max }) : (atual?.[k] ?? padrao));
    const documento = d.documento !== undefined ? (v.digitos(d.documento) || null) : (atual?.documento ?? null);
    if (documento) v.exigir(v.cnpjValido(documento) || v.cpfValido(documento), 'CNPJ ou CPF inválido.');
    return {
      nome: v.texto(d.nome ?? atual?.nome, 'o nome da empresa', 160),
      documento,
      tipo: v.opcao(d.tipo ?? atual?.tipo ?? 'frota', 'o tipo', TIPOS),
      email: d.email !== undefined ? (d.email ? v.email(d.email) : null) : (atual?.email ?? null),
      telefone: d.telefone !== undefined ? (d.telefone ? v.telefone(d.telefone) : null) : (atual?.telefone ?? null),
      limite_veiculos: num('limite_veiculos', 'o limite de veículos', cfg.limite_veiculos_padrao, 100_000),
      mensalidade_centavos: num('mensalidade_centavos', 'a mensalidade por veículo', cfg.mensalidade_padrao_centavos, 10_000_000),
      sem_comunicacao_min: num('sem_comunicacao_min', 'o tempo sem comunicação', cfg.sem_comunicacao_padrao_min, 7 * 24 * 60),
    };
  };
  const CAMPOS = ['nome', 'documento', 'tipo', 'email', 'telefone', 'limite_veiculos', 'mensalidade_centavos', 'sem_comunicacao_min'];

  /** Nova empresa, com o primeiro administrador (opcional) já criado. */
  r.post('/empresas', (req, res) => {
    const d = dadosEmpresa(req.body);
    const id = transacao(db, () => {
      const eid = Number(db.prepare(`INSERT INTO empresas (${CAMPOS.join(', ')}, criada_em) VALUES (${CAMPOS.map(() => '?').join(', ')}, ?)`)
        .run(...CAMPOS.map((k) => d[k]), agora()).lastInsertRowid);
      if (req.body.administrador?.email) criarUsuario(db, { ...req.body.administrador, perfil: 'cliente' }, { perfis: ['cliente'], empresaId: eid });
      return eid;
    });
    registrar(db, req, 'empresa_criada', { nome: d.nome }, id);
    res.status(201).json({ id });
  });

  r.put('/empresas/:id', (req, res) => {
    const atual = empresa(req.params.id);
    const d = dadosEmpresa(req.body, atual);
    db.prepare(`UPDATE empresas SET ${CAMPOS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPOS.map((k) => d[k]), atual.id);
    registrar(db, req, 'empresa_alterada', { campos: CAMPOS.filter((k) => d[k] !== atual[k]) }, atual.id);
    res.status(204).end();
  });

  /** Empresa bloqueada: os usuários dela não entram e as posições dos veículos deixam de ser gravadas. */
  r.post('/empresas/:id/bloquear', (req, res) => {
    const e = empresa(req.params.id);
    const motivo = v.texto(req.body.motivo, 'o motivo do bloqueio', 300);
    db.prepare("UPDATE empresas SET status = 'bloqueada', motivo_bloqueio = ? WHERE id = ?").run(motivo, e.id);
    registrar(db, req, 'empresa_bloqueada', { motivo }, e.id);
    res.status(204).end();
  });
  r.post('/empresas/:id/desbloquear', (req, res) => {
    const e = empresa(req.params.id);
    db.prepare("UPDATE empresas SET status = 'ativa', motivo_bloqueio = NULL WHERE id = ?").run(e.id);
    registrar(db, req, 'empresa_desbloqueada', undefined, e.id);
    res.status(204).end();
  });

  /**
   * Exclusão: a empresa some das listas (usuários desativados, chaves revogadas, links cancelados) e os rastreadores voltam ao estoque.
   * O histórico fica guardado até a retenção apagar. Exige confirmar o nome.
   */
  r.delete('/empresas/:id', soMaster, (req, res) => {
    const e = empresa(req.params.id);
    v.exigir(String(req.body?.confirmacao ?? '').trim() === e.nome, 'Digite o nome da empresa para confirmar a exclusão.');
    transacao(db, () => {
      db.prepare("UPDATE empresas SET status = 'excluida' WHERE id = ?").run(e.id);
      db.prepare('UPDATE usuarios SET ativo = 0 WHERE empresa_id = ?').run(e.id);
      db.prepare('UPDATE chaves_api SET revogada_em = COALESCE(revogada_em, ?) WHERE empresa_id = ?').run(agora(), e.id);
      db.prepare('UPDATE compartilhamentos SET revogado_em = COALESCE(revogado_em, ?) WHERE empresa_id = ?').run(agora(), e.id);
      db.prepare('UPDATE veiculos SET ativo = 0, rastreador_id = NULL WHERE empresa_id = ?').run(e.id);
      db.prepare("UPDATE comandos SET status = 'cancelado', respondido_em = ? WHERE empresa_id = ? AND status IN ('pendente','enviado')").run(agora(), e.id);
      db.prepare('UPDATE rastreadores SET empresa_id = NULL WHERE empresa_id = ?').run(e.id);
    });
    registrar(db, req, 'empresa_excluida', { nome: e.nome }, e.id);
    res.status(204).end();
  });

  // ---------- Rastreadores (estoque e instalados) ----------
  r.get('/rastreadores', (req, res) => {
    const q = req.query;
    const onde = ['1 = 1'];
    const p = [];
    if (q.busca) { onde.push('(r.imei LIKE ? OR r.chip_numero LIKE ? OR r.modelo LIKE ? OR v.placa LIKE ?)'); p.push(...Array(4).fill(`%${String(q.busca).trim()}%`)); }
    if (q.situacao === 'estoque') onde.push('r.empresa_id IS NULL');
    if (q.situacao === 'empresa') onde.push('r.empresa_id IS NOT NULL AND v.id IS NULL');
    if (q.situacao === 'instalado') onde.push('v.id IS NOT NULL');
    if (q.empresa_id) { onde.push('r.empresa_id = ?'); p.push(Number(q.empresa_id)); }
    if (q.protocolo) { onde.push('r.protocolo = ?'); p.push(v.opcao(q.protocolo, 'o protocolo', PROTOCOLOS)); }
    res.json(db.prepare(`SELECT r.*, e.nome AS empresa, v.id AS veiculo_id, v.placa FROM rastreadores r LEFT JOIN empresas e ON e.id = r.empresa_id
      LEFT JOIN veiculos v ON v.rastreador_id = r.id WHERE ${onde.join(' AND ')} ORDER BY r.ultima_comunicacao IS NULL, r.imei LIMIT 2000`).all(...p)
      .map((x) => ({ ...x, conectado: x.protocolo === 'gt06' && extras.gt06 ? extras.gt06.conectado(x.imei) : null })));
  });

  const dadosRastreador = (d, atual) => ({
    imei: d.imei !== undefined || !atual ? v.imei(d.imei) : atual.imei,
    modelo: d.modelo !== undefined ? v.opcional(d.modelo, 'o modelo', 60) : atual?.modelo ?? null,
    protocolo: v.opcao(d.protocolo ?? atual?.protocolo ?? 'gt06', 'o protocolo', PROTOCOLOS),
    chip_numero: d.chip_numero !== undefined ? (v.digitos(d.chip_numero) || null) : atual?.chip_numero ?? null,
    chip_operadora: d.chip_operadora !== undefined ? v.opcional(d.chip_operadora, 'a operadora', 40) : atual?.chip_operadora ?? null,
    empresa_id: d.empresa_id !== undefined ? (d.empresa_id ? empresa(d.empresa_id).id : null) : atual?.empresa_id ?? null,
    observacoes: d.observacoes !== undefined ? v.opcional(d.observacoes, 'as observações', 300) : atual?.observacoes ?? null,
  });
  const CAMPOS_R = ['imei', 'modelo', 'protocolo', 'chip_numero', 'chip_operadora', 'empresa_id', 'observacoes'];

  r.post('/rastreadores', (req, res) => {
    const d = dadosRastreador(req.body);
    const id = transacao(db, () => {
      const x = Number(db.prepare(`INSERT INTO rastreadores (${CAMPOS_R.join(', ')}, criado_em) VALUES (${CAMPOS_R.map(() => '?').join(', ')}, ?)`)
        .run(...CAMPOS_R.map((k) => d[k]), agora()).lastInsertRowid);
      db.prepare('DELETE FROM desconhecidos WHERE imei = ?').run(d.imei);
      return x;
    });
    registrar(db, req, 'rastreador_criado', { imei: d.imei }, d.empresa_id);
    res.status(201).json({ id });
  });

  /** Trocar de empresa (ou devolver ao estoque) tira o rastreador do veículo em que estava. */
  r.put('/rastreadores/:id', (req, res) => {
    const atual = rastreador(req.params.id);
    const d = dadosRastreador(req.body, atual);
    transacao(db, () => {
      if (d.empresa_id !== atual.empresa_id) {
        db.prepare('UPDATE veiculos SET rastreador_id = NULL WHERE rastreador_id = ?').run(atual.id);
        db.prepare("UPDATE comandos SET status = 'cancelado', respondido_em = ? WHERE rastreador_id = ? AND status IN ('pendente','enviado')").run(agora(), atual.id);
      }
      db.prepare(`UPDATE rastreadores SET ${CAMPOS_R.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPOS_R.map((k) => d[k]), atual.id);
    });
    registrar(db, req, 'rastreador_alterado', { imei: d.imei, empresa_id: d.empresa_id }, d.empresa_id);
    res.status(204).end();
  });

  r.delete('/rastreadores/:id', soMaster, (req, res) => {
    const x = rastreador(req.params.id);
    v.exigir(!db.prepare('SELECT 1 FROM veiculos WHERE rastreador_id = ?').get(x.id), 'O rastreador está instalado num veículo: retire-o antes.');
    v.exigir(!db.prepare('SELECT 1 FROM comandos WHERE rastreador_id = ?').get(x.id), 'O rastreador já recebeu comandos: devolva ao estoque em vez de excluir.');
    db.prepare('DELETE FROM rastreadores WHERE id = ?').run(x.id);
    registrar(db, req, 'rastreador_excluido', { imei: x.imei });
    res.status(204).end();
  });

  r.get('/desconhecidos', (_req, res) => res.json(db.prepare('SELECT * FROM desconhecidos ORDER BY ultimo_contato DESC LIMIT 500').all()));
  r.delete('/desconhecidos/:imei', (req, res) => {
    db.prepare('DELETE FROM desconhecidos WHERE imei = ?').run(String(req.params.imei));
    res.status(204).end();
  });

  // ---------- Permissões e usuários ----------
  r.get('/usuarios', soMaster, (req, res) => {
    const q = req.query;
    const onde = ["(u.empresa_id IS NULL OR e.status <> 'excluida')"];
    const p = [];
    if (q.empresa_id === 'plataforma') onde.push('u.empresa_id IS NULL');
    else if (q.empresa_id) { onde.push('u.empresa_id = ?'); p.push(Number(q.empresa_id)); }
    if (q.perfil) { onde.push('u.perfil = ?'); p.push(v.opcao(q.perfil, 'o perfil', PERFIS)); }
    if (q.busca) { onde.push('(u.nome LIKE ? OR u.email LIKE ?)'); p.push(`%${q.busca}%`, `%${q.busca}%`); }
    res.json(db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.ativo, u.ultimo_acesso, u.criado_em, u.empresa_id, e.nome AS empresa_nome
      FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id WHERE ${onde.join(' AND ')} ORDER BY u.empresa_id IS NOT NULL, e.nome, u.nome LIMIT 1000`).all(...p));
  });
  r.post('/usuarios', soMaster, (req, res) => {
    const d = req.body;
    const daEmpresa = ['cliente', 'operador'].includes(d.perfil);
    const id = criarUsuario(db, d, { perfis: PERFIS, empresaId: daEmpresa ? empresa(d.empresa_id).id : null });
    registrar(db, req, 'usuario_criado', { id, perfil: d.perfil }, daEmpresa ? Number(d.empresa_id) : null);
    res.status(201).json({ id });
  });
  r.patch('/usuarios/:id', soMaster, (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(nid(req));
    if (!u) throw naoEncontrado('Usuário');
    const desativando = req.body.ativo !== undefined && !v.booleano(req.body.ativo);
    v.exigir(!(u.id === req.usuario.id && (desativando || (req.body.perfil && req.body.perfil !== 'master'))), 'Você não pode desativar nem rebaixar o seu próprio usuário.');
    transacao(db, () => {
      alterarUsuario(db, u, req.body, { perfis: PERFIS });
      // Sempre sobra ao menos um master ativo.
      if (!db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'master' AND ativo = 1").get()) throw new ErroNegocio('É preciso manter ao menos um master ativo.', 422);
    });
    registrar(db, req, 'usuario_alterado', { id: u.id, campos: Object.keys(req.body).filter((k) => k !== 'senha') }, u.empresa_id);
    res.status(204).end();
  });

  // ---------- Registro de atividades ----------
  r.get('/auditoria', soMaster, (req, res) => {
    const q = req.query;
    const onde = ['1 = 1'];
    const p = [];
    if (q.acao) { onde.push('a.acao = ?'); p.push(String(q.acao)); }
    if (q.empresa_id) { onde.push('a.empresa_id = ?'); p.push(Number(q.empresa_id)); }
    const pagina = Math.max(1, Number(q.pagina) || 1);
    res.json(db.prepare(`SELECT a.id, a.acao, a.detalhes, a.ip, a.criado_em, u.nome AS usuario, u.email, e.nome AS empresa
      FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id LEFT JOIN empresas e ON e.id = a.empresa_id
      WHERE ${onde.join(' AND ')} ORDER BY a.id DESC LIMIT 100 OFFSET ?`).all(...p, (pagina - 1) * 100).map((x) => ({ ...x, detalhes: x.detalhes ? JSON.parse(x.detalhes) : null })));
  });

  // ---------- Diagnóstico ----------
  r.get('/diagnostico', (_req, res) => {
    const cfg = lerConfig(db);
    let tamanho = null;
    try { tamanho = config.dbFile === ':memory:' ? null : fs.statSync(config.dbFile).size; } catch { /* sem arquivo */ }
    const umDia = new Date(Date.now() - 24 * 3600_000).toISOString();
    const ultima = db.prepare('SELECT MAX(ultima_comunicacao) AS t FROM rastreadores').get().t;
    const mudos = db.prepare(`SELECT COUNT(*) AS n FROM veiculos v JOIN empresas e ON e.id = v.empresa_id
      WHERE v.ativo = 1 AND e.status = 'ativa' AND v.rastreador_id IS NOT NULL AND (v.comunicacao_em IS NULL OR v.comunicacao_em < ?)`).get(umDia).n;
    const semRastreador = db.prepare(`SELECT COUNT(*) AS n FROM veiculos v JOIN empresas e ON e.id = v.empresa_id
      WHERE v.ativo = 1 AND e.status = 'ativa' AND v.rastreador_id IS NULL`).get().n;
    const parados = db.prepare("SELECT COUNT(*) AS n FROM comandos WHERE status IN ('pendente','enviado') AND criado_em < ?").get(new Date(Date.now() - 3600_000).toISOString()).n;
    const desconhecidos = db.prepare('SELECT COUNT(*) AS n FROM desconhecidos WHERE ultimo_contato >= ?').get(umDia).n;
    const lotadas = db.prepare(`SELECT COUNT(*) AS n FROM empresas e WHERE e.status = 'ativa'
      AND (SELECT COUNT(*) FROM veiculos v WHERE v.empresa_id = e.id AND v.ativo = 1) >= e.limite_veiculos`).get().n;
    const verificacoes = [
      ['Banco de dados', 'ok', `respondendo${tamanho ? ` · ${(tamanho / 1048576).toFixed(1)} MB` : ''}`],
      ['Servidor GT06 (TCP)', extras.gt06 ? 'ok' : 'aviso', extras.gt06 ? `porta ${config.portaGt06} · ${extras.gt06.conectados()} equipamento(s) conectado(s)` : 'desligado'],
      ['Recepção de posições', ultima && Date.now() - Date.parse(ultima) < cfg.online_min * 60_000 ? 'ok' : 'aviso',
        ultima ? `última mensagem em ${ultima}` : 'nenhum rastreador comunicou ainda'],
      ['Veículos sem comunicar há 24 h', mudos ? 'aviso' : 'ok', mudos ? `${mudos} veículo(s)` : 'nenhum'],
      ['Veículos sem rastreador', semRastreador ? 'aviso' : 'ok', semRastreador ? `${semRastreador} veículo(s) ativo(s) sem equipamento` : 'nenhum'],
      ['Comandos sem resposta há 1 h', parados ? 'aviso' : 'ok', parados ? `${parados} comando(s) (expiram em ${cfg.comando_expira_horas} h)` : 'nenhum'],
      ['Equipamentos não cadastrados', desconhecidos ? 'aviso' : 'ok', desconhecidos ? `${desconhecidos} se apresentaram nas últimas 24 h` : 'nenhum'],
      ['Empresas no limite de veículos', lotadas ? 'aviso' : 'ok', lotadas ? `${lotadas} empresa(s)` : 'nenhuma'],
    ].map(([nome, situacao, detalhe]) => ({ nome, situacao, detalhe }));
    res.json({
      verificacoes,
      servidor: {
        iniciado_em: iniciado, node: process.version, memoria_mb: Math.round(process.memoryUsage().rss / 1048576), fuso: config.fuso,
        posicoes: db.prepare('SELECT COUNT(*) AS n FROM posicoes').get().n, retencao_dias: cfg.retencao_dias,
      },
      recepcao: db.prepare('SELECT data, protocolo, mensagens FROM recepcao_diaria WHERE data >= ? ORDER BY data DESC, protocolo').all(somarDias(hoje(), -6)),
    });
  });

  // ---------- Configurações da plataforma ----------
  r.get('/configuracoes', soMaster, (_req, res) => res.json(lerConfig(db)));
  r.patch('/configuracoes', soMaster, (req, res) => {
    const d = req.body;
    const limites = {
      online_min: [1, 1440], parada_min: [1, 240], retencao_dias: [7, 3650], velocidade_max_plausivel_kmh: [50, 1000], comando_expira_horas: [1, 720],
      limite_veiculos_padrao: [0, 100_000], mensalidade_padrao_centavos: [0, 10_000_000], sem_comunicacao_padrao_min: [0, 7 * 24 * 60],
    };
    const novos = {};
    for (const k of Object.keys(d)) {
      v.exigir(k in CONFIG_PADRAO, `Configuração desconhecida: ${k}.`);
      novos[k] = CONFIG_TEXTO.includes(k)
        ? v.texto(d[k], k === 'nome_plataforma' ? 'o nome da plataforma' : 'o texto do comando', 60)
        : String(v.inteiro(d[k], k.replace(/_/g, ' '), { min: limites[k][0], max: limites[k][1] }));
    }
    transacao(db, () => {
      const up = db.prepare('UPDATE configuracoes SET valor = ? WHERE chave = ?');
      for (const [k, val] of Object.entries(novos)) up.run(val, k);
    });
    registrar(db, req, 'configuracoes', novos);
    res.status(204).end();
  });

  // ---------- Integrações (chaves de todas as empresas) ----------
  r.get('/chaves', (_req, res) => res.json(db.prepare(`SELECT k.id, k.nome, k.prefixo, k.criada_em, k.ultimo_uso, k.revogada_em, e.id AS empresa_id, e.nome AS empresa
    FROM chaves_api k JOIN empresas e ON e.id = k.empresa_id WHERE e.status <> 'excluida' ORDER BY k.id DESC LIMIT 1000`).all()));
  r.post('/chaves', soMaster, (req, res) => {
    const e = empresa(req.body.empresa_id);
    const k = criarChave(db, e.id, req.body.nome, req.usuario.id);
    registrar(db, req, 'chave_criada', { prefixo: k.prefixo }, e.id);
    res.status(201).json(k);
  });
  r.delete('/chaves/:id', soMaster, (req, res) => {
    const k = db.prepare('SELECT * FROM chaves_api WHERE id = ? AND revogada_em IS NULL').get(nid(req));
    if (!k) throw naoEncontrado('Chave');
    db.prepare('UPDATE chaves_api SET revogada_em = ? WHERE id = ?').run(agora(), k.id);
    registrar(db, req, 'chave_revogada', { prefixo: k.prefixo }, k.empresa_id);
    res.status(204).end();
  });

  return r;
};
