'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { transacao, agora, lerConfig } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { criarUsuario, alterarUsuario, criarChave } = require('../lib/contas');
const { TIPOS: TIPOS_ALERTA } = require('../lib/alertas');
const com = require('../lib/comandos');
const roubo = require('../lib/roubo');
const estacionado = require('../lib/estacionado');
const agendaLib = require('../lib/agenda');
const equip = require('../lib/equipamento');
const notif = require('../lib/notificacoes');
const zap = require('../lib/whatsapp');
const { hashSenha } = require('../lib/senha');
const desempenho = require('../lib/desempenho');
const pdf = require('../lib/pdf');
const progr = require('../lib/relatoriosProgramados');
const assistente = require('../lib/assistente');
const { situacao } = require('../lib/posicoes');
const rel = require('../lib/relatorios');
const { hoje, somarDias, intervalo, inicioDia } = require('../lib/datas');
const v = require('../lib/validacao');

const TIPOS_VEICULO = ['carro', 'moto', 'caminhao', 'van', 'onibus', 'maquina', 'outro'];
const PLATAFORMA_PERFIS = ['master', 'suporte'];
const PERFIS_EMPRESA = ['cliente', 'operador'];
const STATUS_ALERTA = ['pendentes', 'tratados', 'todos'];

/**
 * Painel da empresa (/empresas/:eid): mapa ao vivo, histórico, alertas, cadastros, comandos, manutenção, relatórios e configurações.
 * O operador só consulta e trata alertas (conferido em acessoEmpresa); o restante das alterações é do administrador da empresa e da plataforma.
 */
module.exports = (db, extras = {}) => {
  const r = Router();
  const gestor = permitir('master', 'suporte', 'cliente');
  const eid = (req) => req.empresa.id;
  const nid = (req) => Number(req.params.id);
  const daEmpresa = (tabela, nome, masc = true) => (req, id) => {
    const x = Number.isInteger(Number(id)) ? db.prepare(`SELECT * FROM ${tabela} WHERE id = ? AND empresa_id = ?`).get(Number(id), eid(req)) : null;
    if (!x) throw new ErroNegocio(`${nome} não encontrad${masc ? 'o' : 'a'}.`, 404);
    return x;
  };
  const veiculo = daEmpresa('veiculos', 'Veículo');
  const motorista = daEmpresa('motoristas', 'Motorista');
  const cerca = daEmpresa('cercas', 'Cerca', false);
  const manutencao = daEmpresa('manutencoes', 'Manutenção', false);

  r.get('/', (req, res) => {
    const e = req.empresa;
    res.json({ id: e.id, nome: e.nome, tipo: e.tipo, status: e.status, limite_veiculos: e.limite_veiculos });
  });

  // ---------- Dashboard e mapa ----------
  r.get('/dashboard', (req, res) => {
    const id = eid(req);
    const veiculos = rel.veiculosMapa(db, id);
    const contar = (s) => veiculos.filter((x) => x.situacao === s).length;
    const dHoje = hoje();
    const uso = db.prepare(`SELECT u.data, SUM(u.distancia_m) AS distancia_m, SUM(u.ligado_s) AS ligado_s FROM uso_diario u JOIN veiculos v ON v.id = u.veiculo_id
      WHERE v.empresa_id = ? AND u.data >= ? GROUP BY u.data`).all(id, somarDias(dHoje, -13));
    const porDia = new Map(uso.map((x) => [x.data, x]));
    const manut = rel.manutencoes(db, id).filter((m) => m.situacao !== 'em_dia');
    res.json({
      empresa: { nome: req.empresa.nome, limite_veiculos: req.empresa.limite_veiculos },
      veiculos: {
        total: veiculos.length, movimento: contar('movimento'), ligado: contar('ligado'), parado: contar('parado'), sem_sinal: contar('sem_sinal'),
        sem_posicao: contar('sem_posicao'), sem_rastreador: contar('sem_rastreador'), bloqueados: veiculos.filter((x) => x.bloqueado).length,
      },
      hoje: { distancia_m: porDia.get(dHoje)?.distancia_m ?? 0, ligado_s: porDia.get(dHoje)?.ligado_s ?? 0 },
      km_por_dia: Array.from({ length: 14 }, (_, i) => somarDias(dHoje, i - 13)).map((d) => ({ data: d, distancia_m: porDia.get(d)?.distancia_m ?? 0 })),
      alertas_pendentes: db.prepare('SELECT COUNT(*) AS n FROM alertas WHERE empresa_id = ? AND tratado_em IS NULL').get(id).n,
      ultimos_alertas: db.prepare(`SELECT a.id, a.tipo, a.mensagem, a.ocorrido_em, a.tratado_em, v.placa FROM alertas a JOIN veiculos v ON v.id = a.veiculo_id
        WHERE a.empresa_id = ? ORDER BY a.ocorrido_em DESC LIMIT 8`).all(id),
      alertas_semana: db.prepare('SELECT tipo, COUNT(*) AS n FROM alertas WHERE empresa_id = ? AND ocorrido_em >= ? GROUP BY tipo ORDER BY n DESC')
        .all(id, inicioDia(somarDias(dHoje, -6))),
      ranking: db.prepare(`SELECT v.placa, v.descricao, SUM(u.distancia_m) AS distancia_m, MAX(u.velocidade_max_kmh) AS velocidade_max_kmh
        FROM uso_diario u JOIN veiculos v ON v.id = u.veiculo_id WHERE v.empresa_id = ? AND u.data >= ? GROUP BY v.id ORDER BY distancia_m DESC LIMIT 5`)
        .all(id, somarDias(dHoje, -6)),
      manutencoes: manut.slice(0, 8),
      cnh: db.prepare(`SELECT id, nome, cnh_validade FROM motoristas WHERE empresa_id = ? AND ativo = 1 AND cnh_validade IS NOT NULL AND cnh_validade <= ?
        ORDER BY cnh_validade`).all(id, somarDias(dHoje, 30)),
    });
  });

  r.get('/mapa', (req, res) => {
    res.json({
      veiculos: rel.veiculosMapa(db, eid(req)),
      cercas: db.prepare('SELECT id, nome, tipo, lat, lng, raio_m, pontos, cor FROM cercas WHERE empresa_id = ? AND ativa = 1').all(eid(req))
        .map((c) => ({ ...c, pontos: c.pontos ? JSON.parse(c.pontos) : null })),
    });
  });

  // ---------- Veículos ----------
  r.get('/veiculos', (req, res) => {
    const cfg = lerConfig(db);
    const lista = db.prepare(`SELECT v.*, r.imei, r.protocolo, r.modelo AS rastreador_modelo, m.nome AS motorista FROM veiculos v
      LEFT JOIN rastreadores r ON r.id = v.rastreador_id LEFT JOIN motoristas m ON m.id = v.motorista_id WHERE v.empresa_id = ? ORDER BY v.ativo DESC, v.placa`).all(eid(req));
    res.json(lista.map((x) => ({ ...x, situacao: !x.ativo ? 'inativo' : x.imei ? situacao(x, cfg.online_min) : 'sem_rastreador' })));
  });

  /** Rastreador disponível para a empresa: dela e sem veículo (ou o do próprio veículo). */
  const rastreadorLivre = (req, id, veiculoId = null) => {
    if (id === undefined || id === null || id === '') return null;
    const x = db.prepare('SELECT r.id, v.id AS veiculo_id FROM rastreadores r LEFT JOIN veiculos v ON v.rastreador_id = r.id WHERE r.id = ? AND r.empresa_id = ?')
      .get(Number(id), eid(req));
    v.exigir(x, 'Rastreador não encontrado nesta empresa.');
    v.exigir(!x.veiculo_id || x.veiculo_id === veiculoId, 'Este rastreador já está instalado em outro veículo.');
    return x.id;
  };
  const motoristaDaEmpresa = (req, id) => {
    if (id === undefined || id === null || id === '') return null;
    return motorista(req, id).id;
  };

  const dadosVeiculo = (req, d, atual) => {
    const val = (k, f) => (d[k] !== undefined ? f(d[k]) : atual?.[k] ?? null);
    const opc = (nome, max) => (x) => v.opcional(x, nome, max);
    return {
      placa: d.placa !== undefined || !atual ? v.placa(d.placa) : atual.placa,
      descricao: val('descricao', opc('a descrição', 120)),
      marca: val('marca', opc('a marca', 60)),
      modelo: val('modelo', opc('o modelo', 60)),
      cor: val('cor', opc('a cor', 30)),
      ano: val('ano', (x) => (x === '' || x === null ? null : v.inteiro(x, 'o ano', { min: 1950, max: new Date().getFullYear() + 1 }))),
      tipo: v.opcao(d.tipo ?? atual?.tipo ?? 'carro', 'o tipo', TIPOS_VEICULO),
      rastreador_id: d.rastreador_id !== undefined ? rastreadorLivre(req, d.rastreador_id, atual?.id ?? null) : atual?.rastreador_id ?? null,
      motorista_id: d.motorista_id !== undefined ? motoristaDaEmpresa(req, d.motorista_id) : atual?.motorista_id ?? null,
      limite_velocidade_kmh: d.limite_velocidade_kmh !== undefined && d.limite_velocidade_kmh !== ''
        ? v.inteiro(d.limite_velocidade_kmh, 'o limite de velocidade', { min: 0, max: 300 }) : atual?.limite_velocidade_kmh ?? 0,
      ativo: d.ativo !== undefined ? (v.booleano(d.ativo) ? 1 : 0) : atual?.ativo ?? 1,
      consumo_km_l: d.consumo_km_l !== undefined ? (d.consumo_km_l === '' || d.consumo_km_l === null ? null
        : v.numero(String(d.consumo_km_l).replace(',', '.'), 'o consumo médio', { min: 0.5, max: 80 })) : atual?.consumo_km_l ?? null,
      estacionado_auto: d.estacionado_auto !== undefined ? (v.booleano(d.estacionado_auto) ? 1 : 0) : atual?.estacionado_auto ?? 0,
    };
  };
  const CAMPOS_VEICULO = ['placa', 'descricao', 'marca', 'modelo', 'cor', 'ano', 'tipo', 'rastreador_id', 'motorista_id', 'limite_velocidade_kmh', 'ativo', 'consumo_km_l', 'estacionado_auto'];
  const exigirLimite = (req, extra = 1) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM veiculos WHERE empresa_id = ? AND ativo = 1').get(eid(req)).n;
    if (n + extra > req.empresa.limite_veiculos) throw new ErroNegocio(`Limite de ${req.empresa.limite_veiculos} veículos ativos do plano atingido. Fale com o suporte.`, 422);
  };

  r.post('/veiculos', gestor, (req, res) => {
    const d = dadosVeiculo(req, req.body);
    if (d.ativo) exigirLimite(req);
    const id = Number(db.prepare(`INSERT INTO veiculos (empresa_id, ${CAMPOS_VEICULO.join(', ')}, hodometro_m, criado_em) VALUES (?, ${CAMPOS_VEICULO.map(() => '?').join(', ')}, ?, ?)`)
      .run(eid(req), ...CAMPOS_VEICULO.map((k) => d[k]), Math.round(v.numero(req.body.hodometro_km || 0, 'o hodômetro', { min: 0, max: 10_000_000 }) * 1000), agora())
      .lastInsertRowid);
    registrar(db, req, 'veiculo_criado', { placa: d.placa });
    res.status(201).json({ id });
  });

  r.get('/veiculos/:id', (req, res) => {
    const x = veiculo(req, req.params.id);
    res.json({
      ...x,
      rastreador: x.rastreador_id ? db.prepare('SELECT id, imei, modelo, protocolo, chip_numero, chip_operadora, ultima_comunicacao FROM rastreadores WHERE id = ?')
        .get(x.rastreador_id) : null,
      conectado: x.rastreador_id && extras.gt06 ? extras.gt06.conectado(db.prepare('SELECT imei FROM rastreadores WHERE id = ?').get(x.rastreador_id).imei) : null,
      motorista: x.motorista_id ? db.prepare('SELECT id, nome, telefone FROM motoristas WHERE id = ?').get(x.motorista_id) : null,
      comandos: db.prepare(`SELECT c.id, c.tipo, c.status, c.criado_em, c.respondido_em, c.resposta, u.nome AS usuario FROM comandos c LEFT JOIN usuarios u ON u.id = c.criado_por
        WHERE c.veiculo_id = ? ORDER BY c.id DESC LIMIT 10`).all(x.id),
      compartilhamentos: db.prepare('SELECT id, expira_em, criado_em FROM compartilhamentos WHERE veiculo_id = ? AND revogado_em IS NULL AND expira_em > ? ORDER BY id DESC')
        .all(x.id, agora()),
    });
  });

  r.put('/veiculos/:id', gestor, (req, res) => {
    const atual = veiculo(req, req.params.id);
    const d = dadosVeiculo(req, req.body, atual);
    if (d.ativo && !atual.ativo) exigirLimite(req);
    // Desativado, o veículo libera o rastreador para outro.
    if (!d.ativo) d.rastreador_id = null;
    db.prepare(`UPDATE veiculos SET ${CAMPOS_VEICULO.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPOS_VEICULO.map((k) => d[k]), atual.id);
    registrar(db, req, 'veiculo_alterado', { placa: d.placa, campos: CAMPOS_VEICULO.filter((k) => d[k] !== atual[k]) });
    res.status(204).end();
  });

  /** Exclui o veículo e todo o histórico dele (posições, alertas, comandos). Pede a placa para confirmar. */
  r.delete('/veiculos/:id', gestor, (req, res) => {
    const x = veiculo(req, req.params.id);
    if (String(req.body?.confirmacao ?? '').toUpperCase().replace(/[\s-]/g, '') !== x.placa) throw new ErroNegocio('Digite a placa para confirmar a exclusão.', 422);
    transacao(db, () => {
      db.prepare('DELETE FROM manutencao_registros WHERE veiculo_id = ?').run(x.id);
      db.prepare('DELETE FROM veiculos WHERE id = ?').run(x.id);
    });
    registrar(db, req, 'veiculo_excluido', { placa: x.placa });
    res.status(204).end();
  });

  /** Ajuste do hodômetro (ex.: igualar ao painel do veículo). */
  r.post('/veiculos/:id/hodometro', gestor, (req, res) => {
    const x = veiculo(req, req.params.id);
    const novo = Math.round(v.numero(req.body.km, 'o hodômetro', { min: 0, max: 10_000_000 }) * 1000);
    db.prepare('UPDATE veiculos SET hodometro_m = ? WHERE id = ?').run(novo, x.id);
    registrar(db, req, 'hodometro_ajustado', { placa: x.placa, de_km: Math.floor(x.hodometro_m / 1000), para_km: Math.floor(novo / 1000) });
    res.status(204).end();
  });

  /** Trajeto do período (até 7 dias): posições, viagens, paradas e alertas. */
  r.get('/veiculos/:id/percurso', (req, res) => {
    const x = veiculo(req, req.params.id);
    const [de, ate] = rel.periodo(req.query, { maxDias: 7 });
    const [ini, fim] = intervalo(de, ate);
    res.json({ veiculo: { id: x.id, placa: x.placa, descricao: x.descricao, tipo: x.tipo }, de, ate, ...rel.percurso(db, x, ini, fim) });
  });

  // ---------- Comandos ----------
  r.post('/veiculos/:id/comandos', gestor, (req, res) => {
    const x = veiculo(req, req.params.id);
    // Todo corte passa pelo bloqueio inteligente: andando acima da velocidade segura, o corte espera.
    if (req.body.tipo === 'bloquear') {
      const oc = roubo.bloquearComSeguranca(db, x, req.body, req.usuario.id);
      if (oc) {
        registrar(db, req, 'bloqueio_inteligente', { placa: x.placa });
        return res.status(201).json({ ocorrencia_id: oc, status: 'aguardando_velocidade', velocidade_segura_kmh: roubo.limiteSeguro(db) });
      }
    }
    if (req.body.tipo === 'desbloquear' && roubo.desbloquearManual(db, x, req.usuario.id)) {
      registrar(db, req, 'comando_criado', { placa: x.placa, tipo: 'desbloquear' });
      return res.status(201).json({ tipo: 'desbloquear', status: 'pendente' });
    }
    const id = com.criar(db, x, req.body, req.usuario.id);
    registrar(db, req, 'comando_criado', { placa: x.placa, tipo: req.body.tipo });
    const c = db.prepare('SELECT id, tipo, status FROM comandos WHERE id = ?').get(id);
    res.status(201).json(c);
  });

  // ---------- Modo roubo (bloqueio inteligente) ----------
  const ocorrencia = daEmpresa('ocorrencias', 'Ocorrência', false);
  r.get('/roubo', (req, res) => res.json({ velocidade_segura_kmh: roubo.limiteSeguro(db), ocorrencias: roubo.listar(db, eid(req)) }));
  r.post('/veiculos/:id/roubo', gestor, (req, res) => {
    const x = veiculo(req, req.params.id);
    const id = roubo.abrir(db, x, req.body, req.usuario.id);
    registrar(db, req, 'modo_roubo_acionado', { placa: x.placa });
    res.status(201).json(db.prepare('SELECT id, status FROM ocorrencias WHERE id = ?').get(id));
  });
  r.post('/roubo/:id/forcar', gestor, (req, res) => {
    const oc = ocorrencia(req, req.params.id);
    roubo.forcar(db, oc, req.body);
    registrar(db, req, 'modo_roubo_corte_forcado', { ocorrencia: oc.id });
    res.status(204).end();
  });
  r.post('/roubo/:id/encerrar', gestor, (req, res) => {
    const oc = ocorrencia(req, req.params.id);
    roubo.encerrar(db, oc, { desbloquear: req.body.desbloquear === true }, req.usuario.id);
    registrar(db, req, 'modo_roubo_encerrado', { ocorrencia: oc.id, desbloquear: req.body.desbloquear === true });
    res.status(204).end();
  });

  r.get('/comandos', (req, res) => {
    const onde = ['c.empresa_id = ?'];
    const p = [eid(req)];
    if (req.query.veiculo_id) { onde.push('c.veiculo_id = ?'); p.push(Number(req.query.veiculo_id)); }
    res.json(db.prepare(`SELECT c.id, c.tipo, c.texto, c.status, c.criado_em, c.enviado_em, c.respondido_em, c.resposta, v.placa, u.nome AS usuario
      FROM comandos c JOIN veiculos v ON v.id = c.veiculo_id LEFT JOIN usuarios u ON u.id = c.criado_por WHERE ${onde.join(' AND ')} ORDER BY c.id DESC LIMIT 200`).all(...p));
  });

  r.post('/comandos/:id/cancelar', gestor, (req, res) => {
    const ok = db.prepare("UPDATE comandos SET status = 'cancelado', respondido_em = ? WHERE id = ? AND empresa_id = ? AND status = 'pendente'").run(agora(), nid(req), eid(req));
    if (!ok.changes) throw new ErroNegocio('Só um comando ainda não enviado pode ser cancelado.', 422);
    registrar(db, req, 'comando_cancelado', { id: nid(req) });
    res.status(204).end();
  });

  // ---------- Compartilhamento da localização ----------
  r.post('/veiculos/:id/compartilhar', gestor, (req, res) => {
    const x = veiculo(req, req.params.id);
    const horas = v.inteiro(req.body.horas ?? 24, 'a validade', { min: 1, max: 24 * 7 });
    const codigo = crypto.randomBytes(24).toString('base64url');
    const expira = new Date(Date.now() + horas * 3_600_000).toISOString();
    db.prepare('INSERT INTO compartilhamentos (empresa_id, veiculo_id, hash, expira_em, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(eid(req), x.id, crypto.createHash('sha256').update(codigo).digest('hex'), expira, req.usuario.id, agora());
    registrar(db, req, 'localizacao_compartilhada', { placa: x.placa, horas });
    res.status(201).json({ codigo, expira_em: expira });
  });

  r.delete('/compartilhamentos/:id', gestor, (req, res) => {
    const ok = db.prepare('UPDATE compartilhamentos SET revogado_em = ? WHERE id = ? AND empresa_id = ? AND revogado_em IS NULL').run(agora(), nid(req), eid(req));
    if (!ok.changes) throw naoEncontrado('Link');
    res.status(204).end();
  });

  // ---------- Rastreadores da empresa ----------
  r.get('/rastreadores', (req, res) => {
    res.json(db.prepare(`SELECT r.id, r.imei, r.modelo, r.protocolo, r.chip_numero, r.chip_operadora, r.ultima_comunicacao, v.id AS veiculo_id, v.placa
      FROM rastreadores r LEFT JOIN veiculos v ON v.rastreador_id = r.id WHERE r.empresa_id = ? ORDER BY r.imei`).all(eid(req)));
  });

  /** A empresa cadastra sozinha um celular como rastreador (app Traccar Client). Os equipamentos GT06 vêm do estoque do master. */
  r.post('/rastreadores', gestor, (req, res) => {
    const imei = req.body.imei ? v.imei(req.body.imei) : `app-${crypto.randomInt(10 ** 9, 10 ** 10)}`;
    const id = Number(db.prepare("INSERT INTO rastreadores (imei, modelo, protocolo, empresa_id, criado_em) VALUES (?, ?, 'osmand', ?, ?)")
      .run(imei, v.opcional(req.body.modelo, 'o modelo', 60) ?? 'Celular (Traccar Client)', eid(req), agora()).lastInsertRowid);
    db.prepare('DELETE FROM desconhecidos WHERE imei = ?').run(imei);
    registrar(db, req, 'rastreador_app_criado', { imei });
    res.status(201).json({ id, imei });
  });

  // ---------- Motoristas ----------
  r.get('/motoristas', (req, res) => {
    res.json(db.prepare(`SELECT m.*, (SELECT GROUP_CONCAT(v.placa, ', ') FROM veiculos v WHERE v.motorista_id = m.id AND v.ativo = 1) AS veiculos
      FROM motoristas m WHERE m.empresa_id = ? ORDER BY m.ativo DESC, m.nome`).all(eid(req))
      // O hash da senha do app não sai do servidor: só se o motorista tem acesso.
      .map(({ senha_hash: senha, ...m }) => ({ ...m, app: Boolean(senha) })));
  });

  const dadosMotorista = (d, atual) => {
    const cpf = d.cpf !== undefined ? (v.digitos(d.cpf) || null) : atual?.cpf ?? null;
    if (cpf) v.exigir(v.cpfValido(cpf), 'CPF inválido.');
    return {
      nome: v.texto(d.nome ?? atual?.nome, 'o nome', 120),
      cpf,
      cnh: d.cnh !== undefined ? (v.digitos(d.cnh) || null) : atual?.cnh ?? null,
      cnh_categoria: d.cnh_categoria !== undefined ? (String(d.cnh_categoria).trim().toUpperCase().slice(0, 3) || null) : atual?.cnh_categoria ?? null,
      cnh_validade: d.cnh_validade !== undefined ? (d.cnh_validade ? v.data(d.cnh_validade, 'a validade da CNH') : null) : atual?.cnh_validade ?? null,
      telefone: d.telefone !== undefined ? (d.telefone ? v.telefone(d.telefone) : null) : atual?.telefone ?? null,
      ativo: d.ativo !== undefined ? (v.booleano(d.ativo) ? 1 : 0) : atual?.ativo ?? 1,
    };
  };
  const CAMPOS_MOTORISTA = ['nome', 'cpf', 'cnh', 'cnh_categoria', 'cnh_validade', 'telefone', 'ativo'];

  r.post('/motoristas', gestor, (req, res) => {
    const d = dadosMotorista(req.body);
    const id = Number(db.prepare(`INSERT INTO motoristas (empresa_id, ${CAMPOS_MOTORISTA.join(', ')}, criado_em) VALUES (?, ${CAMPOS_MOTORISTA.map(() => '?').join(', ')}, ?)`)
      .run(eid(req), ...CAMPOS_MOTORISTA.map((k) => d[k]), agora()).lastInsertRowid);
    registrar(db, req, 'motorista_criado', { nome: d.nome });
    res.status(201).json({ id });
  });

  r.put('/motoristas/:id', gestor, (req, res) => {
    const atual = motorista(req, req.params.id);
    const d = dadosMotorista(req.body, atual);
    transacao(db, () => {
      db.prepare(`UPDATE motoristas SET ${CAMPOS_MOTORISTA.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPOS_MOTORISTA.map((k) => d[k]), atual.id);
      if (!d.ativo) db.prepare('UPDATE veiculos SET motorista_id = NULL WHERE motorista_id = ?').run(atual.id);
    });
    res.status(204).end();
  });

  r.delete('/motoristas/:id', gestor, (req, res) => {
    const x = motorista(req, req.params.id);
    transacao(db, () => {
      db.prepare('UPDATE veiculos SET motorista_id = NULL WHERE motorista_id = ?').run(x.id);
      db.prepare('DELETE FROM motoristas WHERE id = ?').run(x.id);
    });
    registrar(db, req, 'motorista_excluido', { nome: x.nome });
    res.status(204).end();
  });

  // ---------- Cercas ----------
  r.get('/cercas', (req, res) => {
    const vinc = db.prepare('SELECT veiculo_id FROM cerca_veiculos WHERE cerca_id = ?');
    res.json(db.prepare('SELECT * FROM cercas WHERE empresa_id = ? ORDER BY nome').all(eid(req))
      .map((c) => ({ ...c, pontos: c.pontos ? JSON.parse(c.pontos) : null, veiculos: vinc.all(c.id).map((x) => x.veiculo_id) })));
  });

  const dadosCerca = (req, d, atual) => {
    const tipo = v.opcao(d.tipo ?? atual?.tipo, 'o tipo da cerca', ['circulo', 'poligono']);
    const base = {
      nome: v.texto(d.nome ?? atual?.nome, 'o nome da cerca', 80),
      tipo,
      alertar_entrada: d.alertar_entrada !== undefined ? (v.booleano(d.alertar_entrada) ? 1 : 0) : atual?.alertar_entrada ?? 1,
      alertar_saida: d.alertar_saida !== undefined ? (v.booleano(d.alertar_saida) ? 1 : 0) : atual?.alertar_saida ?? 1,
      cor: d.cor !== undefined ? (/^#[0-9a-fA-F]{6}$/.test(String(d.cor)) ? d.cor : v.falhar('Cor inválida.')) : atual?.cor ?? '#1E88E5',
      ativa: d.ativa !== undefined ? (v.booleano(d.ativa) ? 1 : 0) : atual?.ativa ?? 1,
      horario_inicio: d.horario_inicio !== undefined ? (d.horario_inicio ? v.horario(d.horario_inicio, 'o início da vigência') : null) : atual?.horario_inicio ?? null,
      horario_fim: d.horario_fim !== undefined ? (d.horario_fim ? v.horario(d.horario_fim, 'o fim da vigência') : null) : atual?.horario_fim ?? null,
      acao_saida: v.opcao(d.acao_saida ?? atual?.acao_saida ?? 'avisar', 'a ação ao sair', ['avisar', 'roubo']),
      lat: null, lng: null, raio_m: null, pontos: null,
    };
    v.exigir(Boolean(base.horario_inicio) === Boolean(base.horario_fim), 'Informe o início e o fim da vigência (ou deixe os dois vazios).');
    if (tipo === 'circulo') {
      [base.lat, base.lng] = v.coordenadas(d.lat ?? atual?.lat, d.lng ?? atual?.lng);
      base.raio_m = v.inteiro(d.raio_m ?? atual?.raio_m, 'o raio', { min: 20, max: 200_000 });
    } else {
      const pontos = d.pontos ?? (atual?.pontos ? JSON.parse(atual.pontos) : null);
      v.exigir(Array.isArray(pontos) && pontos.length >= 3 && pontos.length <= 200, 'Desenhe a cerca com pelo menos 3 pontos (até 200).');
      base.pontos = JSON.stringify(pontos.map((p) => v.coordenadas(p?.[0], p?.[1]).map((n) => Number(n.toFixed(6)))));
    }
    const veiculos = d.veiculos !== undefined ? [...new Set([].concat(d.veiculos ?? []).map((x) => veiculo(req, x).id))] : null;
    return { base, veiculos };
  };
  const CAMPOS_CERCA = ['nome', 'tipo', 'alertar_entrada', 'alertar_saida', 'cor', 'ativa', 'horario_inicio', 'horario_fim', 'acao_saida', 'lat', 'lng', 'raio_m', 'pontos'];
  const gravarVinculos = (cercaId, veiculos) => {
    if (veiculos === null) return;
    db.prepare('DELETE FROM cerca_veiculos WHERE cerca_id = ?').run(cercaId);
    const ins = db.prepare('INSERT INTO cerca_veiculos (cerca_id, veiculo_id) VALUES (?, ?)');
    for (const x of veiculos) ins.run(cercaId, x);
  };

  r.post('/cercas', gestor, (req, res) => {
    const { base, veiculos } = dadosCerca(req, req.body);
    const id = transacao(db, () => {
      const cid = Number(db.prepare(`INSERT INTO cercas (empresa_id, ${CAMPOS_CERCA.join(', ')}, criada_em) VALUES (?, ${CAMPOS_CERCA.map(() => '?').join(', ')}, ?)`)
        .run(eid(req), ...CAMPOS_CERCA.map((k) => base[k]), agora()).lastInsertRowid);
      gravarVinculos(cid, veiculos);
      return cid;
    });
    registrar(db, req, 'cerca_criada', { nome: base.nome });
    res.status(201).json({ id });
  });

  r.put('/cercas/:id', gestor, (req, res) => {
    const atual = cerca(req, req.params.id);
    const { base, veiculos } = dadosCerca(req, req.body, atual);
    transacao(db, () => {
      db.prepare(`UPDATE cercas SET ${CAMPOS_CERCA.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPOS_CERCA.map((k) => base[k]), atual.id);
      gravarVinculos(atual.id, veiculos);
      // Mudou o desenho: o próximo ponto de cada veículo só registra se está dentro ou fora (sem alerta falso).
      if (base.lat !== atual.lat || base.lng !== atual.lng || base.raio_m !== atual.raio_m || base.pontos !== atual.pontos) {
        db.prepare('DELETE FROM cerca_estado WHERE cerca_id = ?').run(atual.id);
      }
    });
    registrar(db, req, 'cerca_alterada', { nome: base.nome });
    res.status(204).end();
  });

  r.delete('/cercas/:id', gestor, (req, res) => {
    const x = cerca(req, req.params.id);
    db.prepare('DELETE FROM cercas WHERE id = ?').run(x.id);
    registrar(db, req, 'cerca_excluida', { nome: x.nome });
    res.status(204).end();
  });

  // ---------- Alertas ----------
  const filtroAlertas = (req) => {
    const q = req.query;
    const onde = ['a.empresa_id = ?'];
    const p = [eid(req)];
    const status = q.status ? v.opcao(q.status, 'a situação', STATUS_ALERTA) : 'pendentes';
    if (status === 'pendentes') onde.push('a.tratado_em IS NULL');
    if (status === 'tratados') onde.push('a.tratado_em IS NOT NULL');
    if (q.tipo) { onde.push('a.tipo = ?'); p.push(v.opcao(q.tipo, 'o tipo', Object.keys(TIPOS_ALERTA))); }
    if (q.veiculo_id) { onde.push('a.veiculo_id = ?'); p.push(Number(q.veiculo_id)); }
    if (q.de || q.ate) {
      const [ini, fim] = intervalo(...rel.periodo(q, { maxDias: 366 }));
      onde.push('a.ocorrido_em >= ? AND a.ocorrido_em < ?');
      p.push(ini, fim);
    }
    return { onde, p };
  };

  r.get('/alertas', (req, res) => {
    const { onde, p } = filtroAlertas(req);
    const lista = db.prepare(`SELECT a.*, v.placa, v.descricao AS veiculo, u.nome AS tratado_por_nome FROM alertas a JOIN veiculos v ON v.id = a.veiculo_id
      LEFT JOIN usuarios u ON u.id = a.tratado_por WHERE ${onde.join(' AND ')} ORDER BY a.ocorrido_em DESC LIMIT ${req.query.csv ? 20_000 : 300}`).all(...p);
    if (req.query.csv) {
      return rel.enviarCsv(res, 'alertas.csv', rel.csv([['ocorrido_em', 'Quando'], ['placa', 'Placa'], [(l) => TIPOS_ALERTA[l.tipo], 'Tipo'], ['mensagem', 'Mensagem'],
        ['velocidade_kmh', 'Velocidade (km/h)'], ['lat', 'Latitude'], ['lng', 'Longitude'], ['tratado_em', 'Tratado em'], ['tratado_por_nome', 'Tratado por'],
        ['observacao', 'Observação']], lista));
    }
    res.json(lista);
  });

  r.post('/alertas/:id/tratar', (req, res) => {
    const ok = db.prepare('UPDATE alertas SET tratado_em = ?, tratado_por = ?, observacao = ? WHERE id = ? AND empresa_id = ? AND tratado_em IS NULL')
      .run(agora(), req.usuario.id, v.opcional(req.body.observacao, 'a observação', 300), nid(req), eid(req));
    if (!ok.changes) throw new ErroNegocio('Alerta não encontrado ou já tratado.', 404);
    res.status(204).end();
  });

  r.post('/alertas/tratar-todos', (req, res) => {
    const onde = ['empresa_id = ?', 'tratado_em IS NULL'];
    const p = [eid(req)];
    if (req.body.veiculo_id) { onde.push('veiculo_id = ?'); p.push(Number(req.body.veiculo_id)); }
    if (req.body.tipo) { onde.push('tipo = ?'); p.push(v.opcao(req.body.tipo, 'o tipo', Object.keys(TIPOS_ALERTA))); }
    const n = db.prepare(`UPDATE alertas SET tratado_em = ?, tratado_por = ?, observacao = ? WHERE ${onde.join(' AND ')}`)
      .run(agora(), req.usuario.id, v.opcional(req.body.observacao, 'a observação', 300), ...p).changes;
    registrar(db, req, 'alertas_tratados', { quantidade: n });
    res.json({ tratados: n });
  });

  // ---------- Manutenção ----------
  r.get('/manutencoes', (req, res) => {
    res.json({
      planos: rel.manutencoes(db, eid(req), req.query.veiculo_id ? veiculo(req, req.query.veiculo_id).id : null),
      registros: db.prepare(`SELECT r.*, v.placa, u.nome AS usuario FROM manutencao_registros r JOIN veiculos v ON v.id = r.veiculo_id
        LEFT JOIN usuarios u ON u.id = r.criado_por WHERE v.empresa_id = ? ORDER BY r.data DESC, r.id DESC LIMIT 200`).all(eid(req)),
    });
  });

  const dadosManutencao = (req, d, atual) => {
    const x = {
      veiculo_id: d.veiculo_id !== undefined ? veiculo(req, d.veiculo_id).id : atual?.veiculo_id ?? v.falhar('Escolha o veículo.'),
      descricao: v.texto(d.descricao ?? atual?.descricao, 'a descrição', 120),
      intervalo_km: d.intervalo_km !== undefined ? (d.intervalo_km === '' || d.intervalo_km === null ? null
        : v.inteiro(d.intervalo_km, 'o intervalo em km', { min: 1, max: 1_000_000 })) : atual?.intervalo_km ?? null,
      intervalo_dias: d.intervalo_dias !== undefined ? (d.intervalo_dias === '' || d.intervalo_dias === null ? null
        : v.inteiro(d.intervalo_dias, 'o intervalo em dias', { min: 1, max: 3650 })) : atual?.intervalo_dias ?? null,
      ultima_km: d.ultima_km !== undefined && d.ultima_km !== '' ? v.inteiro(d.ultima_km, 'o km da última', { min: 0, max: 10_000_000 }) : atual?.ultima_km ?? null,
      ultima_data: d.ultima_data ? v.data(d.ultima_data, 'a data da última') : atual?.ultima_data ?? hoje(),
    };
    v.exigir(x.intervalo_km || x.intervalo_dias, 'Informe o intervalo em km, em dias ou os dois.');
    if (x.ultima_km === null) x.ultima_km = Math.floor(db.prepare('SELECT hodometro_m FROM veiculos WHERE id = ?').get(x.veiculo_id).hodometro_m / 1000);
    return x;
  };
  const CAMPOS_MANUT = ['veiculo_id', 'descricao', 'intervalo_km', 'intervalo_dias', 'ultima_km', 'ultima_data'];

  r.post('/manutencoes', gestor, (req, res) => {
    const d = dadosManutencao(req, req.body);
    const id = Number(db.prepare(`INSERT INTO manutencoes (empresa_id, ${CAMPOS_MANUT.join(', ')}, criada_em) VALUES (?, ${CAMPOS_MANUT.map(() => '?').join(', ')}, ?)`)
      .run(eid(req), ...CAMPOS_MANUT.map((k) => d[k]), agora()).lastInsertRowid);
    res.status(201).json({ id });
  });

  r.put('/manutencoes/:id', gestor, (req, res) => {
    const atual = manutencao(req, req.params.id);
    const d = dadosManutencao(req, req.body, atual);
    db.prepare(`UPDATE manutencoes SET ${CAMPOS_MANUT.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPOS_MANUT.map((k) => d[k]), atual.id);
    res.status(204).end();
  });

  r.delete('/manutencoes/:id', gestor, (req, res) => {
    db.prepare('DELETE FROM manutencoes WHERE id = ?').run(manutencao(req, req.params.id).id);
    res.status(204).end();
  });

  /** Manutenção feita: entra no histórico e o plano recomeça a contar desse km e dessa data. */
  r.post('/manutencoes/:id/realizar', gestor, (req, res) => {
    const m = manutencao(req, req.params.id);
    const kmAtual = Math.floor(db.prepare('SELECT hodometro_m FROM veiculos WHERE id = ?').get(m.veiculo_id).hodometro_m / 1000);
    const data = req.body.data ? v.data(req.body.data, 'a data') : hoje();
    const kmFeita = req.body.km !== undefined && req.body.km !== '' ? v.inteiro(req.body.km, 'o km', { min: 0, max: 10_000_000 }) : kmAtual;
    const custo = req.body.custo_centavos !== undefined && req.body.custo_centavos !== '' ? v.inteiro(req.body.custo_centavos, 'o custo', { min: 0, max: 100_000_000 }) : 0;
    transacao(db, () => {
      db.prepare(`INSERT INTO manutencao_registros (manutencao_id, veiculo_id, descricao, data, km, custo_centavos, observacao, criado_por, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.id, m.veiculo_id, m.descricao, data, kmFeita, custo, v.opcional(req.body.observacao, 'a observação', 300),
        req.usuario.id, agora());
      db.prepare('UPDATE manutencoes SET ultima_km = ?, ultima_data = ? WHERE id = ?').run(kmFeita, data, m.id);
    });
    res.status(204).end();
  });

  // ---------- Relatórios ----------
  r.get('/relatorios/resumo', (req, res) => {
    const [de, ate] = rel.periodo(req.query, { padraoDias: 6, maxDias: 366 });
    const linhas = rel.resumo(db, eid(req), de, ate);
    if (req.query.csv) {
      return rel.enviarCsv(res, `resumo-${de}-a-${ate}.csv`, rel.csv([['placa', 'Placa'], ['descricao', 'Veículo'], ['motorista', 'Motorista'],
        [(l) => rel.km(l.distancia_m), 'Distância (km)'], [(l) => rel.horas(l.ligado_s), 'Tempo ligado (h:mm)'], ['velocidade_max_kmh', 'Velocidade máxima (km/h)'],
        ['dias_uso', 'Dias com uso'], ['excessos', 'Excessos de velocidade'], ['alertas', 'Alertas']], linhas));
    }
    res.json({ de, ate, linhas });
  });

  /** Viagens de um veículo no período (até 31 dias). */
  r.get('/relatorios/viagens', (req, res) => {
    const x = veiculo(req, req.query.veiculo_id);
    const [de, ate] = rel.periodo(req.query, { padraoDias: 0, maxDias: 31 });
    const [ini, fim] = intervalo(de, ate);
    const p = rel.percurso(db, x, ini, fim);
    if (req.query.csv) {
      return rel.enviarCsv(res, `viagens-${x.placa}-${de}-a-${ate}.csv`, rel.csv([['inicio', 'Início'], ['fim', 'Fim'], [(l) => rel.horas(l.duracao_s), 'Duração (h:mm)'],
        [(l) => rel.km(l.distancia_m), 'Distância (km)'], ['velocidade_media_kmh', 'Velocidade média (km/h)'], ['velocidade_max_kmh', 'Velocidade máxima (km/h)'],
        [(l) => `${l.origem.lat},${l.origem.lng}`, 'Saída (lat,lng)'], [(l) => `${l.destino.lat},${l.destino.lng}`, 'Chegada (lat,lng)']], p.viagens));
    }
    res.json({ veiculo: { id: x.id, placa: x.placa }, de, ate, viagens: p.viagens, paradas: p.paradas, distancia_m: p.distancia_m, velocidade_max_kmh: p.velocidade_max_kmh });
  });

  // ---------- Configurações e usuários da empresa ----------
  r.get('/configuracoes', (req, res) => {
    const e = req.empresa;
    res.json({
      empresa: { nome: e.nome, documento: e.documento, tipo: e.tipo, email: e.email, telefone: e.telefone, limite_veiculos: e.limite_veiculos,
        mensalidade_centavos: e.mensalidade_centavos, alertar_ignicao: Boolean(e.alertar_ignicao), horario_inicio: e.horario_inicio, horario_fim: e.horario_fim,
        dias_uso: e.dias_uso, sem_comunicacao_min: e.sem_comunicacao_min, preco_combustivel_centavos: e.preco_combustivel_centavos, ocioso_l_h: e.ocioso_l_h },
      veiculos_ativos: db.prepare('SELECT COUNT(*) AS n FROM veiculos WHERE empresa_id = ? AND ativo = 1').get(e.id).n,
      usuarios: db.prepare('SELECT id, nome, email, perfil, ativo, ultimo_acesso FROM usuarios WHERE empresa_id = ? ORDER BY nome').all(e.id),
    });
  });

  r.put('/configuracoes', gestor, (req, res) => {
    const d = req.body;
    const e = req.empresa;
    const comHorario = d.horario_inicio !== undefined ? Boolean(d.horario_inicio || d.horario_fim) : Boolean(e.horario_inicio);
    const x = {
      email: d.email !== undefined ? (d.email ? v.email(d.email) : null) : e.email,
      telefone: d.telefone !== undefined ? (d.telefone ? v.telefone(d.telefone) : null) : e.telefone,
      alertar_ignicao: d.alertar_ignicao !== undefined ? (v.booleano(d.alertar_ignicao) ? 1 : 0) : e.alertar_ignicao,
      horario_inicio: comHorario ? v.horario(d.horario_inicio ?? e.horario_inicio, 'o início do horário') : null,
      horario_fim: comHorario ? v.horario(d.horario_fim ?? e.horario_fim, 'o fim do horário') : null,
      dias_uso: d.dias_uso !== undefined ? [...new Set(String(d.dias_uso).replace(/[^0-6]/g, ''))].sort().join('') : e.dias_uso,
      sem_comunicacao_min: d.sem_comunicacao_min !== undefined && d.sem_comunicacao_min !== ''
        ? v.inteiro(d.sem_comunicacao_min, 'o tempo sem comunicação', { min: 0, max: 7 * 24 * 60 }) : e.sem_comunicacao_min,
      preco_combustivel_centavos: d.preco_combustivel_centavos !== undefined && d.preco_combustivel_centavos !== ''
        ? v.inteiro(d.preco_combustivel_centavos, 'o preço do combustível', { min: 0, max: 100_000 }) : e.preco_combustivel_centavos,
      ocioso_l_h: d.ocioso_l_h !== undefined && d.ocioso_l_h !== ''
        ? v.numero(String(d.ocioso_l_h).replace(',', '.'), 'o consumo parado', { min: 0, max: 20 }) : e.ocioso_l_h,
    };
    if (comHorario) v.exigir(x.horario_inicio !== x.horario_fim, 'O início e o fim do horário de uso devem ser diferentes.');
    const campos = Object.keys(x);
    db.prepare(`UPDATE empresas SET ${campos.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...campos.map((k) => x[k]), e.id);
    registrar(db, req, 'configuracoes_empresa', x);
    res.status(204).end();
  });

  r.post('/usuarios', gestor, (req, res) => {
    const id = criarUsuario(db, req.body, { perfis: PERFIS_EMPRESA, empresaId: eid(req) });
    registrar(db, req, 'usuario_criado', { email: req.body.email, perfil: req.body.perfil });
    res.status(201).json({ id });
  });

  r.put('/usuarios/:id', gestor, (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND empresa_id = ?').get(nid(req), eid(req));
    if (!u) throw naoEncontrado('Usuário');
    if (u.id === req.usuario.id && (req.body.ativo === false || (req.body.perfil && req.body.perfil !== u.perfil))) {
      throw new ErroNegocio('Você não pode desativar nem mudar o perfil da sua própria conta.', 422);
    }
    alterarUsuario(db, u, req.body, { perfis: PERFIS_EMPRESA });
    registrar(db, req, 'usuario_alterado', { email: u.email });
    res.status(204).end();
  });

  // ---------- Integrações (chaves de API da empresa) ----------
  r.get('/chaves', gestor, (req, res) => {
    res.json(db.prepare('SELECT id, nome, prefixo, criada_em, ultimo_uso, revogada_em FROM chaves_api WHERE empresa_id = ? ORDER BY id DESC').all(eid(req)));
  });
  r.post('/chaves', gestor, (req, res) => {
    const k = criarChave(db, eid(req), req.body.nome, req.usuario.id);
    registrar(db, req, 'chave_criada', { prefixo: k.prefixo });
    res.status(201).json(k);
  });
  r.delete('/chaves/:id', gestor, (req, res) => {
    const ok = db.prepare('UPDATE chaves_api SET revogada_em = ? WHERE id = ? AND empresa_id = ? AND revogada_em IS NULL').run(agora(), nid(req), eid(req));
    if (!ok.changes) throw naoEncontrado('Chave');
    registrar(db, req, 'chave_revogada', { id: nid(req) });
    res.status(204).end();
  });

  // ---------- Segurança: Estacionado, bloqueio programado e liberações ----------
  r.get('/seguranca', (req, res) => {
    const cfg = lerConfig(db);
    const ag = agendaLib.listar(db, eid(req));
    res.json({
      velocidade_segura_kmh: cfg.bloqueio_velocidade_segura_kmh, raio_estacionado_m: cfg.estacionado_raio_m,
      roubo: roubo.listar(db, eid(req), 'roubo').filter((o) => o.status !== 'encerrada').length,
      estacionados: estacionado.listar(db, eid(req)), agendas: ag.agendas, liberacoes: ag.liberacoes,
    });
  });
  r.post('/veiculos/:id/estacionar', gestor, (req, res) => {
    const x = veiculo(req, req.params.id);
    estacionado.armar(db, x, { raio_m: req.body.raio_m, usuarioId: req.usuario.id });
    registrar(db, req, 'estacionado_armado', { placa: x.placa });
    res.status(201).json({ ok: true });
  });
  r.post('/veiculos/:id/desarmar', gestor, (req, res) => {
    const x = veiculo(req, req.params.id);
    if (!estacionado.desarmar(db, x, req.usuario.id)) throw new ErroNegocio('O veículo não está estacionado.', 422);
    registrar(db, req, 'estacionado_desarmado', { placa: x.placa });
    res.status(204).end();
  });
  r.put('/veiculos/:id/agenda', gestor, (req, res) => {
    const x = veiculo(req, req.params.id);
    agendaLib.salvarAgenda(db, x, req.body);
    registrar(db, req, 'bloqueio_programado_salvo', { placa: x.placa, inicio: req.body.inicio, fim: req.body.fim });
    res.status(204).end();
  });
  r.delete('/veiculos/:id/agenda', gestor, (req, res) => {
    const x = veiculo(req, req.params.id);
    agendaLib.removerAgenda(db, x);
    registrar(db, req, 'bloqueio_programado_removido', { placa: x.placa });
    res.status(204).end();
  });
  r.post('/liberacoes/consultar', gestor, (req, res) => {
    const l = agendaLib.consultarCodigo(db, eid(req), req.body.codigo);
    res.json({ veiculo: l.placa, descricao: l.descricao, motorista: l.motorista, horas_pedidas: l.horas_pedidas, expira_em: l.expira_em });
  });
  r.post('/liberacoes/aplicar', gestor, (req, res) => {
    const r2 = agendaLib.aplicarCodigo(db, eid(req), req.body.codigo, req.body.horas, req.usuario.id);
    registrar(db, req, 'liberacao_aplicada', r2);
    res.json(r2);
  });
  r.post('/liberacoes/:id/encerrar', gestor, (req, res) => {
    const l = db.prepare("SELECT * FROM liberacoes WHERE id = ? AND empresa_id = ? AND status = 'ativa'").get(nid(req), eid(req));
    if (!l) throw new ErroNegocio('Liberação não encontrada ou já encerrada.', 404);
    transacao(db, () => agendaLib.encerrarLiberacao(db, l, req.usuario.id));
    agendaLib.verificar(db);
    res.status(204).end();
  });
  // Acesso do motorista ao app: senha numérica de 4 a 6 dígitos (o CPF é o usuário).
  r.put('/motoristas/:id/app', gestor, (req, res) => {
    const m = motorista(req, req.params.id);
    const senha = req.body.senha === null || req.body.senha === '' ? null : String(req.body.senha ?? '');
    if (senha !== null) {
      v.exigir(/^\d{4,6}$/.test(senha), 'A senha do app tem de 4 a 6 números.');
      v.exigir(m.cpf, 'Cadastre o CPF do motorista: é o usuário do app.');
    }
    db.prepare('UPDATE motoristas SET senha_hash = ? WHERE id = ?').run(senha ? hashSenha(senha) : null, m.id);
    registrar(db, req, senha ? 'motorista_app_liberado' : 'motorista_app_removido', { nome: m.nome });
    res.status(204).end();
  });

  // ---------- Notificações pelo WhatsApp ----------
  const contato = daEmpresa('contatos_notificacao', 'Contato');
  const dadosContato = (d, atual) => {
    const tipos = [].concat(d.tipos ?? (atual ? atual.tipos.split(',') : [])).map(String).filter((t) => notif.TIPOS_AVISO[t]);
    const silencio = d.silencio_inicio !== undefined ? Boolean(d.silencio_inicio || d.silencio_fim) : Boolean(atual?.silencio_inicio);
    const x = {
      nome: v.texto(d.nome ?? atual?.nome, 'o nome', 80),
      numero: zap.normalizarNumero(v.telefone(d.numero ?? atual?.numero)),
      tipos: [...new Set(tipos)].join(','),
      silencio_inicio: silencio ? v.horario(d.silencio_inicio ?? atual?.silencio_inicio, 'o início do silêncio') : null,
      silencio_fim: silencio ? v.horario(d.silencio_fim ?? atual?.silencio_fim, 'o fim do silêncio') : null,
      ativo: d.ativo !== undefined ? (v.booleano(d.ativo) ? 1 : 0) : atual?.ativo ?? 1,
    };
    v.exigir(x.tipos, 'Marque pelo menos um tipo de aviso.');
    return x;
  };
  const CAMPOS_CONTATO = ['nome', 'numero', 'tipos', 'silencio_inicio', 'silencio_fim', 'ativo'];
  r.get('/notificacoes', (req, res) => res.json({
    whatsapp: zap.configurado(), tipos: notif.TIPOS_AVISO, seguranca: [...notif.SEGURANCA],
    contatos: db.prepare('SELECT * FROM contatos_notificacao WHERE empresa_id = ? ORDER BY nome').all(eid(req)),
    mensagens: db.prepare(`SELECT id, numero, substr(texto, 1, 160) AS texto, arquivo_nome, origem, status, tentativas, erro, criado_em, enviado_em
      FROM mensagens WHERE empresa_id = ? ORDER BY id DESC LIMIT 60`).all(eid(req)),
  }));
  r.post('/contatos', gestor, (req, res) => {
    const x = dadosContato(req.body);
    const id = Number(db.prepare(`INSERT INTO contatos_notificacao (empresa_id, ${CAMPOS_CONTATO.join(', ')}, criado_em) VALUES (?, ${CAMPOS_CONTATO.map(() => '?').join(', ')}, ?)`)
      .run(eid(req), ...CAMPOS_CONTATO.map((k) => x[k]), agora()).lastInsertRowid);
    res.status(201).json({ id });
  });
  r.put('/contatos/:id', gestor, (req, res) => {
    const atual = contato(req, req.params.id);
    const x = dadosContato(req.body, atual);
    db.prepare(`UPDATE contatos_notificacao SET ${CAMPOS_CONTATO.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPOS_CONTATO.map((k) => x[k]), atual.id);
    res.status(204).end();
  });
  r.delete('/contatos/:id', gestor, (req, res) => {
    const atual = contato(req, req.params.id);
    db.prepare('DELETE FROM contatos_notificacao WHERE id = ?').run(atual.id);
    res.status(204).end();
  });
  r.post('/contatos/:id/testar', gestor, (req, res) => {
    const c = contato(req, req.params.id);
    v.exigir(zap.configurado(), 'O WhatsApp ainda não foi ligado no servidor. Fale com o suporte.');
    zap.enfileirar(db, { empresaId: eid(req), numero: c.numero, texto: `*Rastreador · ${req.empresa.nome}*\nMensagem de teste: os avisos vão chegar neste número.`, origem: 'teste' });
    res.status(202).json({ ok: true });
  });

  // ---------- Equipamento (J16): saúde, perfil de envio, alarmes e consultas ----------
  const rastreadorDo = (req) => {
    const x = veiculo(req, req.params.id);
    const rr = x.rastreador_id ? db.prepare('SELECT * FROM rastreadores WHERE id = ?').get(x.rastreador_id) : null;
    if (!rr) throw new ErroNegocio('O veículo não tem rastreador instalado.', 422);
    return { x, rr };
  };
  r.get('/veiculos/:id/equipamento', (req, res) => {
    const { x, rr } = rastreadorDo(req);
    res.json({
      veiculo: { id: x.id, placa: x.placa, tensao: x.tensao, ignicao: x.ignicao, bloqueado: x.bloqueado, comunicacao_em: x.comunicacao_em, limite_velocidade_kmh: x.limite_velocidade_kmh },
      rastreador: { id: rr.id, imei: rr.imei, modelo: rr.modelo, protocolo: rr.protocolo, chip_numero: rr.chip_numero, chip_operadora: rr.chip_operadora,
        sinal_gsm: rr.sinal_gsm, firmware: rr.firmware, perfil: rr.perfil, rele_invertido: rr.rele_invertido, saude: rr.saude ? JSON.parse(rr.saude) : null, saude_em: rr.saude_em,
        ultima_comunicacao: rr.ultima_comunicacao, conectado: Boolean(extras.gt06?.conectado?.(rr.imei)) },
      perfis: equip.PERFIS,
      comandos: db.prepare(`SELECT id, tipo, texto, rotulo, status, criado_em, respondido_em, resposta FROM comandos WHERE veiculo_id = ? AND (tipo = 'personalizado' OR tipo IN ('status','parametros','reiniciar'))
        ORDER BY id DESC LIMIT 30`).all(x.id),
    });
  });
  r.post('/veiculos/:id/equipamento', gestor, (req, res) => {
    const { x, rr } = rastreadorDo(req);
    v.exigir(rr.protocolo === 'gt06', 'Só rastreadores GT06 (como o J16) recebem estes ajustes.');
    const plataforma = PLATAFORMA_PERFIS.includes(req.usuario.perfil);
    const ajuste = String(req.body.ajuste ?? '');
    let ids = [];
    transacao(db, () => {
      if (ajuste === 'rele_invertido') {
        v.exigir(plataforma, 'Só a equipe da plataforma muda o sentido do relé.');
        db.prepare('UPDATE rastreadores SET rele_invertido = ? WHERE id = ?').run(v.booleano(req.body.valor) ? 1 : 0, rr.id);
        return;
      }
      if (equip.CONSULTAS[ajuste]) {
        const c = equip.CONSULTAS[ajuste];
        ids.push(com.criar(db, x, { tipo: 'personalizado', texto: c.texto, rotulo: c.rotulo }, req.usuario.id));
        return;
      }
      // A empresa consulta e reinicia; os ajustes (intervalos, alarmes, fuso, servidor) são da equipe da plataforma, porque um erro tira o aparelho do ar.
      const conhecido = equip.AJUSTES[ajuste] ?? equip.AJUSTES_PLATAFORMA[ajuste];
      if (!conhecido) throw new ErroNegocio('Ajuste desconhecido.', 422);
      if (!plataforma) throw new ErroNegocio('Só a equipe da plataforma faz este ajuste. Peça ao suporte.', 403);
      const f = conhecido;
      if (ajuste === 'fabrica') v.exigir(String(req.body.confirmacao ?? '').toUpperCase().replace(/[\s-]/g, '') === x.placa, 'Digite a placa para confirmar o padrão de fábrica.');
      if (ajuste === 'perfil') {
        v.exigir(equip.PERFIS[req.body.valor], 'Perfil desconhecido.');
        db.prepare('UPDATE rastreadores SET perfil = ? WHERE id = ?').run(req.body.valor, rr.id);
      }
      for (const c of f(req.body.valor ?? null)) ids.push(com.criar(db, x, { tipo: 'personalizado', ...c }, req.usuario.id));
    });
    registrar(db, req, 'equipamento_ajustado', { placa: x.placa, ajuste });
    res.status(201).json({ comandos: ids });
  });

  // ---------- Assistente com IA (só consulta os dados da empresa) ----------
  r.get('/assistente', (req, res) => res.json(assistente.situacao(db, eid(req))));
  r.post('/assistente', async (req, res, next) => {
    try { res.json(await assistente.perguntar(db, req.empresa, { pergunta: req.body?.pergunta, historico: req.body?.historico })); } catch (err) { next(err); }
  });

  // ---------- Nota do motorista, ranking e custos ----------
  r.get('/desempenho', (req, res) => {
    const [de, ate] = rel.periodo(req.query, { padraoDias: 29, maxDias: 93 });
    res.json(desempenho.calcular(db, eid(req), de, ate));
  });
  const enviarPdf = (res, nome, buffer) => res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${nome}"` }).send(buffer);
  r.get('/relatorios/periodo.pdf', async (req, res, next) => {
    try {
      const [de, ate] = rel.periodo(req.query, { padraoDias: 29, maxDias: 93 });
      const conteudo = String(req.query.conteudo || 'frota,seguranca,motoristas,custos').split(',').filter((c) => progr.CONTEUDOS[c]);
      enviarPdf(res, `relatorio-${de}-a-${ate}.pdf`, await pdf.relatorioPeriodo(db, eid(req), de, ate, conteudo, lerConfig(db).nome_plataforma));
    } catch (err) { next(err); }
  });
  r.get('/roubo/:id/relatorio.pdf', async (req, res, next) => {
    try {
      const oc = ocorrencia(req, req.params.id);
      enviarPdf(res, `ocorrencia-${oc.id}.pdf`, await pdf.relatorioOcorrencia(db, oc, lerConfig(db).nome_plataforma));
    } catch (err) { next(err); }
  });
  r.post('/roubo/:id/relatorio/whatsapp', gestor, async (req, res, next) => {
    try {
      const oc = ocorrencia(req, req.params.id);
      v.exigir(zap.configurado(), 'O WhatsApp ainda não foi ligado no servidor.');
      const c = contato(req, req.body.contato_id);
      const placaV = db.prepare('SELECT placa FROM veiculos WHERE id = ?').get(oc.veiculo_id).placa;
      zap.enfileirar(db, { empresaId: eid(req), numero: c.numero, texto: `*Ocorrência de roubo · ${placaV}*\nRelatório com o veículo, a linha do tempo e o trajeto.`,
        arquivo: await pdf.relatorioOcorrencia(db, oc, lerConfig(db).nome_plataforma), arquivoNome: `ocorrencia-${placaV}.pdf`, origem: 'roubo' });
      res.status(202).json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---------- Relatórios programados ----------
  const agendaRel = daEmpresa('relatorios_agenda', 'Agendamento');
  const dadosAgendaRel = (d, atual) => {
    const conteudo = [].concat(d.conteudo ?? (atual ? atual.conteudo.split(',') : Object.keys(progr.CONTEUDOS))).filter((c) => progr.CONTEUDOS[c]);
    v.exigir(conteudo.length, 'Escolha pelo menos um conteúdo.');
    const contatos = [].concat(d.contatos ?? (atual ? atual.contatos.split(',') : [])).map(Number).filter(Boolean)
      .filter((id) => db.prepare('SELECT 1 FROM contatos_notificacao WHERE id = ? AND empresa_id = ?').get(id, eid(d._req)));
    v.exigir(contatos.length, 'Escolha pelo menos um contato do WhatsApp (cadastre em Configurações → Notificações).');
    const frequencia = v.opcao(d.frequencia ?? atual?.frequencia, 'a frequência', Object.keys(progr.FREQUENCIAS));
    return { nome: v.texto(d.nome ?? atual?.nome ?? `Relatório ${progr.FREQUENCIAS[frequencia].toLowerCase()}`, 'o nome', 80), frequencia, conteudo: conteudo.join(','),
      contatos: [...new Set(contatos)].join(','), ativo: d.ativo !== undefined ? (v.booleano(d.ativo) ? 1 : 0) : atual?.ativo ?? 1 };
  };
  r.get('/relatorios-programados', (req, res) => res.json({
    frequencias: progr.FREQUENCIAS, conteudos: progr.CONTEUDOS, whatsapp: zap.configurado(),
    contatos: db.prepare('SELECT id, nome, numero FROM contatos_notificacao WHERE empresa_id = ? AND ativo = 1 ORDER BY nome').all(eid(req)),
    agendas: db.prepare('SELECT * FROM relatorios_agenda WHERE empresa_id = ? ORDER BY nome').all(eid(req)),
    envios: db.prepare('SELECT * FROM relatorios_envios WHERE empresa_id = ? ORDER BY id DESC LIMIT 40').all(eid(req)),
  }));
  r.post('/relatorios-programados', gestor, (req, res) => {
    const x = dadosAgendaRel({ ...req.body, _req: req });
    const id = Number(db.prepare(`INSERT INTO relatorios_agenda (empresa_id, nome, frequencia, conteudo, contatos, ativo, proximo_em, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eid(req), x.nome, x.frequencia, x.conteudo, x.contatos, x.ativo, progr.proximoEnvio(x.frequencia), agora()).lastInsertRowid);
    res.status(201).json({ id });
  });
  r.put('/relatorios-programados/:id', gestor, (req, res) => {
    const atual = agendaRel(req, req.params.id);
    const x = dadosAgendaRel({ ...req.body, _req: req }, atual);
    db.prepare('UPDATE relatorios_agenda SET nome = ?, frequencia = ?, conteudo = ?, contatos = ?, ativo = ?, proximo_em = ? WHERE id = ?')
      .run(x.nome, x.frequencia, x.conteudo, x.contatos, x.ativo, x.frequencia !== atual.frequencia ? progr.proximoEnvio(x.frequencia) : atual.proximo_em, atual.id);
    res.status(204).end();
  });
  r.delete('/relatorios-programados/:id', gestor, (req, res) => {
    const atual = agendaRel(req, req.params.id);
    db.prepare('DELETE FROM relatorios_agenda WHERE id = ?').run(atual.id);
    res.status(204).end();
  });
  r.post('/relatorios-programados/:id/enviar', gestor, async (req, res, next) => {
    try { res.json(await progr.enviar(db, agendaRel(req, req.params.id))); } catch (err) { next(err); }
  });

  return r;
};
