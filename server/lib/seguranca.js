'use strict';

/*
 * Monitoramento de segurança da plataforma. De hora em hora (e quando o administrador pedir):
 *  - integridade do código: o que mudou desde a última versão aprovada;
 *  - funções: teste rápido de cada função essencial do Banqueiro, Internet Banking e site;
 *  - servidor: sistema, memória, disco, banco e backups;
 *  - conexões: requisições e erros da última hora, integração com o banco e configurações de segurança;
 *  - antifraude: analisa as transações e acessos novos.
 * O resultado fica em verificacoes_seguranca e aparece no menu Segurança do Banqueiro.
 */

const config = require('../config');
const integridade = require('./integridade');
const antifraude = require('./antifraude');
const { registrar } = require('./auditoria');

const estado = {
  fonte: null, // fonte de arquivos para a integridade
  coletarServidor: null, // métricas do servidor (Node) ou nada (demonstração)
  bradesco: null,
  intervaloMin: Number(process.env.PAYAX_SEGURANCA_INTERVALO_MIN) || 60,
  timer: null,
};

/** Contadores de requisições por hora (memória do processo). */
const requisicoes = new Map(); // 'AAAA-MM-DDTHH' -> { total, s4xx, s5xx, s429, s401, ips: Map }

function configurar(opcoes) {
  Object.assign(estado, Object.fromEntries(Object.entries(opcoes).filter(([, v]) => v !== undefined)));
}

/** Middleware que conta as respostas da API (servidor Node). */
function contarRequisicoes(req, res, next) {
  if (typeof res.on === 'function') {
    res.on('finish', () => {
      const hora = new Date().toISOString().slice(0, 13);
      if (!requisicoes.has(hora)) {
        requisicoes.set(hora, { total: 0, s4xx: 0, s5xx: 0, s429: 0, s401: 0, ips: new Map() });
        for (const k of [...requisicoes.keys()].sort().slice(0, -48)) requisicoes.delete(k);
      }
      const h = requisicoes.get(hora);
      h.total++;
      if (res.statusCode >= 500) h.s5xx++; else if (res.statusCode >= 400) h.s4xx++;
      if (res.statusCode === 429) h.s429++;
      if (res.statusCode === 401) h.s401++;
      h.ips.set(req.ip, (h.ips.get(req.ip) ?? 0) + 1);
    });
  }
  next();
}

function resumoRequisicoes() {
  const ultimaHora = new Date(Date.now() - 3600_000).toISOString().slice(0, 13);
  const atual = new Date().toISOString().slice(0, 13);
  const soma = { total: 0, s4xx: 0, s5xx: 0, s429: 0, s401: 0 };
  const ips = new Map();
  for (const k of [ultimaHora, atual]) {
    const h = requisicoes.get(k);
    if (!h) continue;
    for (const c of Object.keys(soma)) soma[c] += h[c];
    for (const [ip, n] of h.ips) ips.set(ip, (ips.get(ip) ?? 0) + n);
  }
  return { ...soma, ips_distintos: ips.size, top_ips: [...ips].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, n]) => ({ ip, n })) };
}

// ---------- Funções da plataforma ----------
function testar(nome, frente, fn) {
  const t0 = Date.now();
  try {
    const detalhe = fn();
    return { nome, frente, ok: true, ms: Date.now() - t0, detalhe: detalhe ?? 'OK' };
  } catch (err) {
    return { nome, frente, ok: false, ms: Date.now() - t0, detalhe: err.message };
  }
}

function verificarFuncoes(db, arquivos) {
  const { criarDesafio } = require('./teclado');
  const { gerarBoletoBancario, lerBoleto } = require('./boleto');
  const { gerarBrCode } = require('../integracoes/bradesco/brcode');
  const { hashSenha, verificarSenha } = require('./senha');
  const alcadas = require('./alcadas');
  const ouvidoria = require('./ouvidoria');
  const limites = require('./limites');
  const tem = (caminho) => { if (!arquivos.has(caminho)) throw new Error(`Arquivo ausente: ${caminho}`); return 'Arquivos presentes'; };
  return [
    testar('Banco de dados', 'Servidor', () => {
      const r = db.prepare('PRAGMA quick_check').get();
      const v = Object.values(r)[0];
      if (v !== 'ok') throw new Error(`Verificação do banco: ${v}`);
      return `Íntegro · ${db.prepare('SELECT COUNT(*) AS n FROM contas').get().n} contas`;
    }),
    testar('Login da equipe', 'Banqueiro', () => {
      const n = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE ativo = 1 AND perfil = 'admin'").get().n;
      if (!n) throw new Error('Nenhum administrador ativo.');
      const h = hashSenha('verificacao-de-seguranca');
      if (!verificarSenha('verificacao-de-seguranca', h)) throw new Error('Conferência de senha falhou.');
      return `${n} administrador(es) ativo(s)`;
    }),
    testar('Alçadas e permissões', 'Banqueiro', () => `${Object.keys(alcadas.mapa(db, 'operador')).length} permissões avaliadas`),
    testar('Ouvidoria', 'Banqueiro', () => `${ouvidoria.listarRegras(db).filter((r) => r.exige).length} ações exigem análise`),
    testar('Teclado virtual (login do cliente)', 'Internet Banking', () => {
      const d = criarDesafio(db);
      db.prepare('DELETE FROM desafios_teclado WHERE id = ?').run(d.id);
      if (d.teclas.length !== 5 || new Set(d.teclas.flat()).size !== 10) throw new Error('Teclado gerado com pares inválidos.');
      return 'Pares sorteados corretamente';
    }),
    testar('Limites diários', 'Internet Banking', () => { limites.efetivarVencidos(db); return 'Pedidos de limite em dia'; }),
    testar('Leitura de boletos', 'Internet Banking', () => {
      const b = gerarBoletoBancario({ banco: '237', valorCentavos: 12345, vencimento: '2026-12-31', campoLivre: '1' });
      if (lerBoleto(b.linha_digitavel).valor_centavos !== 12345) throw new Error('Valor do boleto lido errado.');
      return 'Linha digitável conferida';
    }),
    testar('QR Code PIX (BR Code)', 'Internet Banking', () => {
      const c = gerarBrCode({ chave: 'teste@payax.com.br', nome: 'PAY AX', cidade: 'SAO PAULO', valorCentavos: 100, txid: 'VERIFICACAO' });
      if (!/6304[0-9A-F]{4}$/.test(c)) throw new Error('Código PIX sem verificador.');
      return 'Código gerado com CRC';
    }),
    testar('Integração bancária', 'Servidor', () => {
      if (!estado.bradesco) return 'Serviço não iniciado';
      const s = estado.bradesco.status();
      return `Modo ${s.modo}${s.webhook_protegido ? ' · webhook protegido' : ''}`;
    }),
    testar('Antifraude', 'Banqueiro', () => `${db.prepare("SELECT COUNT(*) AS n FROM alertas_fraude WHERE status = 'aberto'").get().n} alerta(s) aberto(s)`),
    testar('Banqueiro (telas)', 'Banqueiro', () => tem('public/index.html') && tem('public/js/app.js')),
    testar('Internet Banking (telas)', 'Internet Banking', () => tem('public/ib/index.html') && tem('public/ib/js/app.js')),
    testar('Site institucional', 'Site', () => tem('public/site/index.html') && tem('public/site/js/site.js')),
  ];
}

// ---------- Conexões e configuração ----------
function verificarConexoes(db, servidor) {
  const producao = process.env.NODE_ENV === 'production';
  const segredoPadrao = !process.env.PAYAX_SECRET || process.env.PAYAX_SECRET === 'troque-este-segredo';
  const b = estado.bradesco?.status() ?? null;
  const um = (sql) => db.prepare(sql).get();
  const pix24 = um(`SELECT COUNT(*) AS total, SUM(status = 'falhou') AS falhas FROM pix_saidas WHERE criado_em >= datetime('now', '-1 day')`);
  const ultimoWebhook = um('SELECT MAX(recebido_em) AS em FROM pix_recebidos').em;
  const horasBackup = servidor?.ultimo_backup ? (Date.now() - Date.parse(servidor.ultimo_backup)) / 3600_000 : null;
  const checagens = [
    { item: 'Ambiente de produção', ok: producao, detalhe: producao ? 'NODE_ENV=production' : 'Rodando fora do modo produção' },
    { item: 'Chaves secretas definidas', ok: !segredoPadrao && Boolean(process.env.PAYAX_PEPPER), detalhe: segredoPadrao ? 'Use segredos próprios no .env' : 'Definidas (valores não exibidos)' },
    { item: 'Webhook do banco protegido por token', ok: Boolean(b?.webhook_protegido), detalhe: b?.webhook_protegido ? 'Token configurado' : 'Defina BRADESCO_WEBHOOK_TOKEN' },
    { item: 'Integração bancária em modo real', ok: b ? b.modo !== 'simulador' : false, detalhe: b ? `Modo atual: ${b.modo}` : '—' },
    { item: 'HTTPS obrigatório (HSTS) e política de conteúdo (CSP)', ok: producao, detalhe: producao ? 'Cabeçalhos ativos' : 'Ativados apenas em produção' },
    { item: 'Backup recente (até 26 h)', ok: horasBackup !== null && horasBackup <= 26, detalhe: horasBackup === null ? 'Nenhum backup encontrado' : `Último há ${Math.round(horasBackup)} h` },
  ];
  return {
    requisicoes: resumoRequisicoes(),
    banco: { modo: b?.modo ?? null, pix_enviados_24h: pix24.total, pix_falhas_24h: pix24.falhas ?? 0, ultimo_recebimento: ultimoWebhook },
    checagens,
  };
}

// ---------- Execução ----------
function executar(db, { origem = 'agendada', usuarioId = null } = {}) {
  const t0 = Date.now();
  let integ;
  let lista = [];
  try {
    lista = estado.fonte ? estado.fonte.listar() : [];
    integ = estado.fonte ? integridade.verificar(db, { listar: () => lista }) : { status: 'indisponivel', arquivos: 0, alteracoes: [] };
  } catch (err) {
    integ = { status: 'erro', arquivos: 0, alteracoes: [], erro: err.message };
  }
  const arquivos = new Set(lista.map((f) => f.caminho));
  const funcoes = verificarFuncoes(db, arquivos);
  let servidor = null;
  try { servidor = estado.coletarServidor ? estado.coletarServidor() : null; } catch (err) { servidor = { erro: err.message }; }
  const conexoes = verificarConexoes(db, servidor);
  let alertasNovos = 0;
  try { alertasNovos = antifraude.analisar(db); } catch { /* o resultado da análise aparece no próprio menu Antifraude */ }
  const altosAbertos = db.prepare("SELECT COUNT(*) AS n FROM alertas_fraude WHERE status = 'aberto' AND severidade = 'alta'").get().n;
  const critico = integ.status === 'alterado' || integ.status === 'erro' || funcoes.some((f) => !f.ok);
  const atencao = conexoes.checagens.some((c) => !c.ok) || altosAbertos > 0 || (conexoes.requisicoes.s5xx ?? 0) > 0;
  const status = critico ? 'critico' : atencao ? 'atencao' : 'ok';
  const r = db.prepare(`INSERT INTO verificacoes_seguranca (status, integridade, funcoes, servidor, conexoes, alertas_novos, duracao_ms, origem)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(status, JSON.stringify(integ), JSON.stringify(funcoes), JSON.stringify(servidor), JSON.stringify(conexoes),
    alertasNovos, Date.now() - t0, origem);
  db.prepare("DELETE FROM verificacoes_seguranca WHERE id NOT IN (SELECT id FROM verificacoes_seguranca ORDER BY id DESC LIMIT 1000)").run();
  if (status === 'critico') registrar(db, { usuario: usuarioId ? { id: usuarioId } : undefined }, 'seguranca_critico', 'verificacao_seguranca', Number(r.lastInsertRowid), { integridade: integ.status, funcoes_com_falha: funcoes.filter((f) => !f.ok).map((f) => f.nome) });
  return detalhar(db, Number(r.lastInsertRowid));
}

function formatar(v) {
  if (!v) return v;
  return { ...v, integridade: JSON.parse(v.integridade), funcoes: JSON.parse(v.funcoes), servidor: JSON.parse(v.servidor), conexoes: JSON.parse(v.conexoes) };
}
const detalhar = (db, id) => formatar(db.prepare('SELECT * FROM verificacoes_seguranca WHERE id = ?').get(id));

function painel(db) {
  const ultima = formatar(db.prepare('SELECT * FROM verificacoes_seguranca ORDER BY id DESC LIMIT 1').get());
  const historico = db.prepare('SELECT id, status, integridade, funcoes, alertas_novos, duracao_ms, origem, criado_em FROM verificacoes_seguranca ORDER BY id DESC LIMIT 48').all()
    .map((v) => {
      const i = JSON.parse(v.integridade);
      const f = JSON.parse(v.funcoes);
      return { id: v.id, status: v.status, origem: v.origem, criado_em: v.criado_em, duracao_ms: v.duracao_ms, alertas_novos: v.alertas_novos,
        integridade: i.status, arquivos_alterados: i.alteracoes?.length ?? 0, funcoes_ok: f.filter((x) => x.ok).length, funcoes_total: f.length };
    });
  return { ultima, historico, intervalo_min: estado.intervaloMin, base: integridade.base(db), fonte: estado.fonte?.descricao ?? null };
}

function aprovarIntegridade(db, req, motivo) {
  if (!estado.fonte) throw new Error('Fonte de arquivos indisponível.');
  const n = integridade.aprovar(db, estado.fonte, req.usuario.id);
  registrar(db, req, 'aprovar_integridade', 'verificacao_seguranca', null, { arquivos: n, motivo });
  return n;
}

/** Agenda a verificação periódica (servidor e demonstração). */
function agendar(db) {
  clearInterval(estado.timer);
  estado.timer = setInterval(() => { try { executar(db); } catch (err) { console.error('[PAY AX] Verificação de segurança falhou:', err.message); } }, estado.intervaloMin * 60_000);
  estado.timer.unref?.();
}

module.exports = { configurar, contarRequisicoes, executar, painel, detalhar, aprovarIntegridade, agendar, estado };
