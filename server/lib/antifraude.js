'use strict';

/*
 * Antifraude: regras que procuram transações fora do padrão e tentativas de acesso suspeitas.
 * A análise é incremental (guarda até onde já leu) e roda a cada abertura do painel, depois de cada
 * operação do cliente e de hora em hora junto com o monitoramento de segurança. Cada alerta tem uma
 * chave única, então rodar de novo nunca duplica alertas.
 */

const config = require('../config');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { registrar } = require('./auditoria');
const alcadas = require('./alcadas');
const v = require('./validacao');

const SAIDAS = "('pix_enviado','transferencia_enviada','pagamento')";
const F = config.fusoSqlite;
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const REGRAS = {
  valor_atipico: { rotulo: 'Valor fora do padrão do cliente', tipo: 'transacao' },
  horario_noturno: { rotulo: 'Operação de madrugada', tipo: 'transacao' },
  rajada: { rotulo: 'Muitas operações em poucos minutos', tipo: 'transacao' },
  destinatario_novo: { rotulo: 'Valor alto para destinatário novo', tipo: 'transacao' },
  conta_nova: { rotulo: 'Conta recém-aberta movimentando muito', tipo: 'transacao' },
  limite_quase_todo: { rotulo: 'Operação usando quase todo o limite diário', tipo: 'transacao' },
  senha_repetida: { rotulo: 'Senha errada várias vezes', tipo: 'acesso' },
  acesso_bloqueado: { rotulo: 'Acesso bloqueado por tentativas', tipo: 'acesso' },
  forca_bruta_ip: { rotulo: 'Muitas falhas de login do mesmo IP', tipo: 'acesso' },
  enumeracao_documentos: { rotulo: 'Tentativas com vários CPF/CNPJ sem acesso', tipo: 'acesso' },
  equipe_falhas: { rotulo: 'Falhas de login da equipe', tipo: 'acesso' },
  ip_novo: { rotulo: 'Acesso de um IP novo', tipo: 'acesso' },
};

// Parâmetros das regras (em centavos e minutos).
const P = {
  atipicoMinimo: 100_000, atipicoMultiplo: 5, atipicoMultiploAlto: 10, atipicoHistorico: 3,
  noturnoMinimo: 100_000, noturnoInicio: 22, noturnoFim: 6,
  rajadaQuantidade: 5, rajadaMinutos: 10,
  destinatarioNovoMinimo: 500_000,
  contaNovaDias: 7, contaNovaTotal: 1_000_000,
  limiteFracao: 0.9, limiteMinimo: 200_000,
  senhaFalhas: 3, senhaMinutos: 15, ipFalhas: 10, enumeracaoFalhas: 5, equipeFalhas: 5,
};

function mascararDocumento(d) {
  const x = String(d ?? '').replace(/\D/g, '');
  if (x.length === 11) return `***.${x.slice(3, 6)}.${x.slice(6, 9)}-**`;
  if (x.length === 14) return `${x.slice(0, 2)}.***.***/${x.slice(8, 12)}-**`;
  return x ? 'documento inválido' : '(vazio)';
}

function registrarTentativa(db, { canal, identificador, clienteId = null, usuarioId = null, sucesso, motivo = null, ip = null }) {
  db.prepare('INSERT INTO tentativas_acesso (canal, identificador, cliente_id, usuario_id, sucesso, motivo, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(canal, identificador, clienteId, usuarioId, sucesso ? 1 : 0, motivo, ip);
}

const ler = (db, chave) => Number(db.prepare('SELECT valor FROM estado_sistema WHERE chave = ?').get(chave)?.valor ?? 0);
const gravar = (db, chave, valor) => db.prepare('INSERT INTO estado_sistema (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor').run(chave, String(valor));

function alerta(db, a) {
  return db.prepare(`INSERT OR IGNORE INTO alertas_fraude (chave, regra, severidade, cliente_id, conta_id, transacao_id, valor_centavos, descricao, dados, ocorrido_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.chave, a.regra, a.severidade, a.clienteId ?? null, a.contaId ?? null, a.transacaoId ?? null,
    a.valor ?? null, a.descricao, a.dados ? JSON.stringify(a.dados) : null, a.ocorrido).changes;
}

/** Regras sobre uma saída de dinheiro feita no Internet Banking. */
function avaliarTransacao(db, t) {
  let novos = 0;
  const valor = -t.valor_centavos;
  const base = { clienteId: t.cliente_id, contaId: t.conta_id, transacaoId: t.id, valor, ocorrido: t.criado_em };

  const hist = db.prepare(`SELECT COUNT(*) AS n, AVG(-t2.valor_centavos) AS media FROM transacoes t2 JOIN contas c2 ON c2.id = t2.conta_id
    WHERE c2.cliente_id = ? AND t2.canal = 'internet_banking' AND t2.tipo IN ${SAIDAS} AND t2.id < ? AND t2.criado_em >= datetime(?, '-90 days')`)
    .get(t.cliente_id, t.id, t.criado_em);
  if (hist.n >= P.atipicoHistorico && valor >= P.atipicoMinimo && valor > P.atipicoMultiplo * hist.media) {
    const vezes = valor / hist.media;
    novos += alerta(db, { ...base, chave: `valor_atipico:${t.id}`, regra: 'valor_atipico', severidade: vezes >= P.atipicoMultiploAlto ? 'alta' : 'media',
      descricao: `${t.cliente_nome}: ${brl(valor)}, ${vezes.toFixed(1).replace('.', ',')}× a média das saídas (${brl(Math.round(hist.media))}).`,
      dados: { media_centavos: Math.round(hist.media), historico: hist.n } });
  }

  const hora = Number(db.prepare('SELECT strftime(\'%H\', ?, ?) AS h').get(t.criado_em, F).h);
  if ((hora >= P.noturnoInicio || hora < P.noturnoFim) && valor >= P.noturnoMinimo) {
    novos += alerta(db, { ...base, chave: `horario_noturno:${t.id}`, regra: 'horario_noturno', severidade: 'media',
      descricao: `${t.cliente_nome}: ${brl(valor)} às ${String(hora).padStart(2, '0')}h (horário de Brasília).` });
  }

  const rajada = db.prepare(`SELECT COUNT(*) AS n, SUM(-t2.valor_centavos) AS total FROM transacoes t2 JOIN contas c2 ON c2.id = t2.conta_id
    WHERE c2.cliente_id = ? AND t2.canal = 'internet_banking' AND t2.tipo IN ${SAIDAS} AND t2.id <= ?
      AND t2.criado_em >= datetime(?, '-${P.rajadaMinutos} minutes')`).get(t.cliente_id, t.id, t.criado_em);
  if (rajada.n >= P.rajadaQuantidade) {
    novos += alerta(db, { ...base, transacaoId: null, chave: `rajada:${t.cliente_id}:${t.criado_em.slice(0, 13)}`, regra: 'rajada', severidade: 'alta', valor: rajada.total,
      descricao: `${t.cliente_nome}: ${rajada.n} saídas em ${P.rajadaMinutos} minutos, somando ${brl(rajada.total)}.` });
  }

  if (valor >= P.destinatarioNovoMinimo && t.tipo !== 'pagamento') {
    let novo = false;
    let destino = '';
    if (t.contraparte_conta_id) {
      novo = !db.prepare(`SELECT 1 FROM transacoes t2 JOIN contas c2 ON c2.id = t2.conta_id WHERE c2.cliente_id = ? AND t2.contraparte_conta_id = ?
        AND t2.valor_centavos < 0 AND t2.id < ?`).get(t.cliente_id, t.contraparte_conta_id, t.id);
      destino = db.prepare('SELECT cl.nome FROM contas c JOIN clientes cl ON cl.id = c.cliente_id WHERE c.id = ?').get(t.contraparte_conta_id)?.nome ?? '';
    } else {
      const s = db.prepare('SELECT chave FROM pix_saidas WHERE transacao_id = ?').get(t.id);
      if (s) {
        novo = !db.prepare(`SELECT 1 FROM pix_saidas p JOIN contas c ON c.id = p.conta_id WHERE c.cliente_id = ? AND p.chave = ? AND p.transacao_id < ?`).get(t.cliente_id, s.chave, t.id);
        destino = `chave ${s.chave}`;
      }
    }
    if (novo) {
      novos += alerta(db, { ...base, chave: `destinatario_novo:${t.id}`, regra: 'destinatario_novo', severidade: 'media',
        descricao: `${t.cliente_nome}: primeiro envio para ${destino || 'este destinatário'}, de ${brl(valor)}.` });
    }
  }

  if (t.aberta_em >= db.prepare(`SELECT datetime(?, '-${P.contaNovaDias} days') AS d`).get(t.criado_em).d) {
    const { total } = db.prepare(`SELECT COALESCE(SUM(-valor_centavos), 0) AS total FROM transacoes WHERE conta_id = ? AND canal = 'internet_banking'
      AND tipo IN ${SAIDAS} AND id <= ? AND criado_em >= datetime(?, '-1 day')`).get(t.conta_id, t.id, t.criado_em);
    if (total >= P.contaNovaTotal) {
      novos += alerta(db, { ...base, transacaoId: null, chave: `conta_nova:${t.conta_id}:${t.criado_em.slice(0, 10)}`, regra: 'conta_nova', severidade: 'alta', valor: total,
        descricao: `${t.cliente_nome}: conta aberta em ${t.aberta_em.slice(0, 10).split('-').reverse().join('/')} já enviou ${brl(total)} em 24 horas.` });
    }
  }

  if (t.limite_diario && valor >= P.limiteMinimo && valor >= P.limiteFracao * t.limite_diario) {
    novos += alerta(db, { ...base, chave: `limite_quase_todo:${t.id}`, regra: 'limite_quase_todo', severidade: 'baixa',
      descricao: `${t.cliente_nome}: uma operação de ${brl(valor)} usou ${Math.round((valor / t.limite_diario) * 100)}% do limite diário.` });
  }
  return novos;
}

const bucket = (dataHora, minutos) => {
  const m = Number(dataHora.slice(14, 16));
  return `${dataHora.slice(0, 13)}:${String(Math.floor(m / minutos) * minutos).padStart(2, '0')}`;
};

/** Regras sobre tentativas de acesso. */
function avaliarTentativa(db, e) {
  let novos = 0;
  const conta = (sql, ...args) => db.prepare(sql).get(...args).n;
  if (e.canal === 'internet_banking' && !e.sucesso) {
    if (e.cliente_id) {
      const n = conta(`SELECT COUNT(*) AS n FROM tentativas_acesso WHERE canal = 'internet_banking' AND cliente_id = ? AND sucesso = 0
        AND id <= ? AND criado_em >= datetime(?, '-${P.senhaMinutos} minutes')`, e.cliente_id, e.id, e.criado_em);
      if (n >= P.senhaFalhas) {
        novos += alerta(db, { chave: `senha_repetida:${e.cliente_id}:${bucket(e.criado_em, P.senhaMinutos)}`, regra: 'senha_repetida', severidade: 'media',
          clienteId: e.cliente_id, ocorrido: e.criado_em, descricao: `${e.cliente_nome ?? e.identificador}: ${n} senhas erradas em ${P.senhaMinutos} minutos (IP ${e.ip ?? '—'}).`, dados: { ip: e.ip } });
      }
    }
    if (['senha_incorreta_bloqueou'].includes(e.motivo)) {
      novos += alerta(db, { chave: `acesso_bloqueado:t${e.id}`, regra: 'acesso_bloqueado', severidade: 'alta', clienteId: e.cliente_id, ocorrido: e.criado_em,
        descricao: `${e.cliente_nome ?? e.identificador}: acesso ao Internet Banking bloqueado por senha errada (IP ${e.ip ?? '—'}).`, dados: { ip: e.ip } });
    }
    if (e.motivo === 'documento_sem_acesso' && e.ip) {
      const n = conta(`SELECT COUNT(DISTINCT identificador) AS n FROM tentativas_acesso WHERE ip = ? AND motivo = 'documento_sem_acesso'
        AND id <= ? AND criado_em >= datetime(?, '-1 hour')`, e.ip, e.id, e.criado_em);
      if (n >= P.enumeracaoFalhas) {
        novos += alerta(db, { chave: `enumeracao_documentos:${e.ip}:${e.criado_em.slice(0, 13)}`, regra: 'enumeracao_documentos', severidade: 'media', ocorrido: e.criado_em,
          descricao: `IP ${e.ip}: ${n} CPF/CNPJ diferentes sem acesso testados em 1 hora.`, dados: { ip: e.ip } });
      }
    }
  }
  if (!e.sucesso && e.ip) {
    const n = conta(`SELECT COUNT(*) AS n FROM tentativas_acesso WHERE ip = ? AND sucesso = 0 AND id <= ? AND criado_em >= datetime(?, '-1 hour')`, e.ip, e.id, e.criado_em);
    if (n >= P.ipFalhas) {
      novos += alerta(db, { chave: `forca_bruta_ip:${e.ip}:${e.criado_em.slice(0, 13)}`, regra: 'forca_bruta_ip', severidade: 'alta', ocorrido: e.criado_em,
        descricao: `IP ${e.ip}: ${n} logins com falha em 1 hora.`, dados: { ip: e.ip } });
    }
  }
  if (e.canal === 'equipe' && !e.sucesso) {
    const n = conta(`SELECT COUNT(*) AS n FROM tentativas_acesso WHERE canal = 'equipe' AND identificador = ? AND sucesso = 0 AND id <= ?
      AND criado_em >= datetime(?, '-1 hour')`, e.identificador, e.id, e.criado_em);
    if (n >= P.equipeFalhas) {
      novos += alerta(db, { chave: `equipe_falhas:${e.identificador}:${e.criado_em.slice(0, 13)}`, regra: 'equipe_falhas', severidade: 'alta', ocorrido: e.criado_em,
        descricao: `Banqueiro: ${n} senhas erradas para ${e.identificador} em 1 hora (IP ${e.ip ?? '—'}).`, dados: { ip: e.ip } });
    }
  }
  if (e.canal === 'internet_banking' && e.sucesso && e.cliente_id && e.ip) {
    const anteriores = conta(`SELECT COUNT(*) AS n FROM tentativas_acesso WHERE cliente_id = ? AND sucesso = 1 AND id < ?`, e.cliente_id, e.id);
    const doIp = conta(`SELECT COUNT(*) AS n FROM tentativas_acesso WHERE cliente_id = ? AND sucesso = 1 AND ip = ? AND id < ?`, e.cliente_id, e.ip, e.id);
    if (anteriores >= 3 && doIp === 0) {
      novos += alerta(db, { chave: `ip_novo:t${e.id}`, regra: 'ip_novo', severidade: 'baixa', clienteId: e.cliente_id, ocorrido: e.criado_em,
        descricao: `${e.cliente_nome ?? e.identificador}: entrou de um IP novo (${e.ip}).`, dados: { ip: e.ip } });
    }
  }
  return novos;
}

/** Analisa o que entrou desde a última análise. Devolve quantos alertas novos foram criados. */
function analisar(db) {
  let novos = 0;
  const ultTx = ler(db, 'antifraude.transacao');
  const txs = db.prepare(`SELECT t.*, c.cliente_id, c.aberta_em, cl.nome AS cliente_nome, a.limite_diario_centavos AS limite_diario
    FROM transacoes t JOIN contas c ON c.id = t.conta_id JOIN clientes cl ON cl.id = c.cliente_id LEFT JOIN acessos_cliente a ON a.cliente_id = c.cliente_id
    WHERE t.id > ? AND t.canal = 'internet_banking' AND t.tipo IN ${SAIDAS} ORDER BY t.id LIMIT 5000`).all(ultTx);
  for (const t of txs) novos += avaliarTransacao(db, t);
  const maxTx = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM transacoes').get().m;
  gravar(db, 'antifraude.transacao', txs.length === 5000 ? txs.at(-1).id : maxTx);

  const ultT = ler(db, 'antifraude.tentativa');
  const ts = db.prepare(`SELECT t.*, cl.nome AS cliente_nome FROM tentativas_acesso t LEFT JOIN clientes cl ON cl.id = t.cliente_id
    WHERE t.id > ? ORDER BY t.id LIMIT 5000`).all(ultT);
  for (const e of ts) novos += avaliarTentativa(db, e);
  if (ts.length) gravar(db, 'antifraude.tentativa', ts.at(-1).id);

  // Bloqueio por senha de transação errada (registrado na auditoria).
  const ultA = ler(db, 'antifraude.auditoria');
  const aud = db.prepare(`SELECT a.id, a.cliente_id, a.ip, a.criado_em, cl.nome FROM auditoria a LEFT JOIN clientes cl ON cl.id = a.cliente_id
    WHERE a.id > ? AND a.acao = 'ib_bloqueio_pin' ORDER BY a.id`).all(ultA);
  for (const a of aud) {
    novos += alerta(db, { chave: `acesso_bloqueado:a${a.id}`, regra: 'acesso_bloqueado', severidade: 'alta', clienteId: a.cliente_id, ocorrido: a.criado_em,
      descricao: `${a.nome ?? 'Cliente'}: Internet Banking bloqueado por 3 senhas de transação erradas (IP ${a.ip ?? '—'}).`, dados: { ip: a.ip } });
  }
  gravar(db, 'antifraude.auditoria', db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM auditoria').get().m);
  return novos;
}

// ---------- Consultas do painel ----------
const SELECT_ALERTA = `SELECT a.*, cl.nome AS cliente_nome, cl.documento AS cliente_documento, c.numero || '-' || c.digito AS conta_numero, u.nome AS analisado_por_nome
  FROM alertas_fraude a LEFT JOIN clientes cl ON cl.id = a.cliente_id LEFT JOIN contas c ON c.id = a.conta_id LEFT JOIN usuarios u ON u.id = a.analisado_por`;
const formatar = (a) => (a ? { ...a, dados: a.dados ? JSON.parse(a.dados) : null, regra_rotulo: REGRAS[a.regra]?.rotulo ?? a.regra, tipo: REGRAS[a.regra]?.tipo } : a);

function listarAlertas(db, { status, severidade, limite = 200 } = {}) {
  const w = []; const p = [];
  if (status) { w.push('a.status = ?'); p.push(status); }
  if (severidade) { w.push('a.severidade = ?'); p.push(severidade); }
  return db.prepare(`${SELECT_ALERTA} ${w.length ? `WHERE ${w.join(' AND ')}` : ''}
    ORDER BY a.status = 'aberto' DESC, CASE a.severidade WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, a.ocorrido_em DESC LIMIT ?`).all(...p, limite).map(formatar);
}

function detalharAlerta(db, id) {
  const a = formatar(db.prepare(`${SELECT_ALERTA} WHERE a.id = ?`).get(id));
  if (!a) throw naoEncontrado('Alerta');
  a.transacao = a.transacao_id ? db.prepare('SELECT id, tipo, valor_centavos, descricao, criado_em, canal FROM transacoes WHERE id = ?').get(a.transacao_id) : null;
  a.outros_alertas = a.cliente_id ? db.prepare("SELECT COUNT(*) AS n FROM alertas_fraude WHERE cliente_id = ? AND id <> ?").get(a.cliente_id, a.id).n : 0;
  a.acessos = a.cliente_id ? db.prepare(`SELECT sucesso, motivo, ip, criado_em FROM tentativas_acesso WHERE cliente_id = ? ORDER BY id DESC LIMIT 10`).all(a.cliente_id) : [];
  a.ib = a.cliente_id ? db.prepare('SELECT status FROM acessos_cliente WHERE cliente_id = ?').get(a.cliente_id) ?? null : null;
  return a;
}

function painel(db, dias = 14) {
  const periodo = Math.min(Math.max(Number(dias) || 14, 1), 90);
  const um = (sql, ...a) => db.prepare(sql).get(...a);
  const abertos = um(`SELECT COUNT(*) AS n, SUM(severidade = 'alta') AS alta, COALESCE(SUM(valor_centavos), 0) AS valor FROM alertas_fraude WHERE status = 'aberto'`);
  const periodoAlertas = um(`SELECT COUNT(*) AS n, SUM(status = 'confirmado') AS confirmados, SUM(status = 'descartado') AS descartados
    FROM alertas_fraude WHERE ocorrido_em >= datetime('now', ?)`, `-${periodo} days`);
  const acessos24 = um(`SELECT COUNT(*) AS total, SUM(sucesso = 0) AS falhas, SUM(motivo IN ('senha_incorreta_bloqueou', 'acesso_bloqueado')) AS bloqueios,
    SUM(canal = 'equipe' AND sucesso = 0) AS falhas_equipe, COUNT(DISTINCT CASE WHEN sucesso = 0 THEN ip END) AS ips_falha
    FROM tentativas_acesso WHERE criado_em >= datetime('now', '-1 day')`);
  const tx24 = um(`SELECT COUNT(*) AS n, COALESCE(SUM(-valor_centavos), 0) AS valor FROM transacoes
    WHERE canal = 'internet_banking' AND tipo IN ${SAIDAS} AND criado_em >= datetime('now', '-1 day')`);

  const serie = [];
  const hoje = new Date();
  for (let i = periodo - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - i)).toISOString().slice(0, 10);
    serie.push({ dia: d, alta: 0, media: 0, baixa: 0 });
  }
  const idx = new Map(serie.map((s, i) => [s.dia, i]));
  for (const r of db.prepare(`SELECT date(ocorrido_em) AS dia, severidade, COUNT(*) AS n FROM alertas_fraude WHERE ocorrido_em >= datetime('now', ?) GROUP BY 1, 2`).all(`-${periodo} days`)) {
    const i = idx.get(r.dia);
    if (i !== undefined) serie[i][r.severidade] += r.n;
  }

  const horas = [];
  for (let i = 23; i >= 0; i--) horas.push({ hora: db.prepare(`SELECT strftime('%Y-%m-%d %H', 'now', ?) AS h`).get(`-${i} hours`).h, ib: 0, equipe: 0 });
  const idxH = new Map(horas.map((h, i) => [h.hora, i]));
  for (const r of db.prepare(`SELECT strftime('%Y-%m-%d %H', criado_em) AS h, canal, COUNT(*) AS n FROM tentativas_acesso
    WHERE sucesso = 0 AND criado_em >= datetime('now', '-24 hours') GROUP BY 1, 2`).all()) {
    const i = idxH.get(r.h);
    if (i !== undefined) horas[i][r.canal === 'equipe' ? 'equipe' : 'ib'] += r.n;
  }
  for (const h of horas) h.hora_local = Number(db.prepare('SELECT strftime(\'%H\', ? || \':00:00\', ?) AS h').get(h.hora, F).h);

  const porRegra = db.prepare(`SELECT regra, COUNT(*) AS total, SUM(status = 'aberto') AS abertos FROM alertas_fraude WHERE ocorrido_em >= datetime('now', ?)
    GROUP BY regra ORDER BY total DESC`).all(`-${periodo} days`).map((r) => ({ ...r, rotulo: REGRAS[r.regra]?.rotulo ?? r.regra, tipo: REGRAS[r.regra]?.tipo }));
  const clientes = db.prepare(`SELECT a.cliente_id, cl.nome, COUNT(*) AS alertas, SUM(a.status = 'aberto') AS abertos, SUM(a.severidade = 'alta') AS alta,
      MAX(a.ocorrido_em) AS ultimo FROM alertas_fraude a JOIN clientes cl ON cl.id = a.cliente_id WHERE a.ocorrido_em >= datetime('now', ?)
    GROUP BY a.cliente_id ORDER BY abertos DESC, alertas DESC LIMIT 8`).all(`-${periodo} days`);
  const tentativas = db.prepare(`SELECT t.id, t.canal, t.identificador, t.sucesso, t.motivo, t.ip, t.criado_em, cl.nome AS cliente_nome, u.nome AS usuario_nome
    FROM tentativas_acesso t LEFT JOIN clientes cl ON cl.id = t.cliente_id LEFT JOIN usuarios u ON u.id = t.usuario_id ORDER BY t.id DESC LIMIT 60`).all();

  return {
    dias: periodo,
    abertos: abertos.n, alta_abertos: abertos.alta ?? 0, valor_sob_suspeita_centavos: abertos.valor,
    alertas_periodo: periodoAlertas.n, confirmados: periodoAlertas.confirmados ?? 0, descartados: periodoAlertas.descartados ?? 0,
    acessos_24h: { total: acessos24.total, falhas: acessos24.falhas ?? 0, bloqueios: acessos24.bloqueios ?? 0, falhas_equipe: acessos24.falhas_equipe ?? 0, ips_falha: acessos24.ips_falha },
    transacoes_24h: { analisadas: tx24.n, valor_centavos: tx24.valor },
    serie, horas, por_regra: porRegra, clientes, tentativas,
  };
}

/**
 * Decisão sobre um alerta: descartar (falso positivo) ou confirmar fraude. Ao confirmar, pode bloquear o
 * acesso do cliente ao Internet Banking e pedir o bloqueio da conta (respeitando as regras da Ouvidoria).
 */
function decidir(db, req, id, { acao, parecer, bloquearIb = false, bloquearConta = false }) {
  alcadas.exigir(db, req, 'antifraude.analisar');
  const a = detalharAlerta(db, id);
  if (a.status !== 'aberto') throw new ErroNegocio('Este alerta já foi analisado.', 409);
  v.exigir(['descartar', 'confirmar'].includes(acao), 'Ação inválida.');
  const texto = v.texto(parecer, 1000);
  v.exigir(texto && texto.length >= 5, 'Escreva o parecer da análise.');
  const efeitos = [];
  if (acao === 'confirmar' && a.cliente_id) {
    // Carregados aqui para evitar dependência circular (ouvidoria → situacao → ...).
    const ouvidoria = require('./ouvidoria');
    const situacao = require('./situacao');
    if (bloquearIb && a.ib && a.ib.status === 'ativo') {
      if (ouvidoria.exigeAnalise(db, 'bloquear_ib')) {
        const s = ouvidoria.criar(db, req, { tipo: 'bloquear_ib', clienteId: a.cliente_id, dados: { status: 'bloqueado' }, motivo: `Antifraude (alerta #${a.id}): ${texto}`, origem: 'equipe' });
        efeitos.push(`Bloqueio do Internet Banking enviado à Ouvidoria (${s.protocolo})`);
      } else {
        situacao.alterarStatusIb(db, req, a.cliente_id, 'bloqueado', { alerta: a.id });
        efeitos.push('Acesso ao Internet Banking bloqueado');
      }
    }
    if (bloquearConta && a.conta_id) {
      const conta = db.prepare('SELECT status FROM contas WHERE id = ?').get(a.conta_id);
      if (conta?.status === 'ativa') {
        if (ouvidoria.exigeAnalise(db, 'bloquear_conta')) {
          const s = ouvidoria.criar(db, req, { tipo: 'bloquear_conta', clienteId: a.cliente_id, contaId: a.conta_id, dados: { status: 'bloqueada' },
            motivo: `Antifraude (alerta #${a.id}): ${texto}`, origem: 'equipe' });
          efeitos.push(`Bloqueio da conta enviado à Ouvidoria (${s.protocolo})`);
        } else {
          situacao.alterarStatusConta(db, req, a.conta_id, 'bloqueada', { alerta: a.id });
          efeitos.push('Conta bloqueada');
        }
      }
    }
  }
  db.prepare(`UPDATE alertas_fraude SET status = ?, parecer = ?, analisado_por = ?, analisado_em = datetime('now') WHERE id = ?`)
    .run(acao === 'confirmar' ? 'confirmado' : 'descartado', texto, req.usuario.id, a.id);
  registrar(db, req, acao === 'confirmar' ? 'fraude_confirmada' : 'alerta_descartado', 'alerta_fraude', a.id, { regra: a.regra, efeitos });
  return { ...detalharAlerta(db, a.id), efeitos };
}

module.exports = { REGRAS, PARAMETROS: P, mascararDocumento, registrarTentativa, analisar, painel, listarAlertas, detalharAlerta, decidir };
