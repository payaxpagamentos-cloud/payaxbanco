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
const servicos = require('./monitor-servicos');

const estado = {
  fonte: null, // fonte de arquivos para a integridade
  coletarServidor: null, // métricas do servidor (Node) ou nada (demonstração)
  bradesco: null,
  intervaloMin: Number(process.env.PAYAX_SEGURANCA_INTERVALO_MIN) || 60,
  pulsoMin: Number(process.env.PAYAX_MONITOR_INTERVALO_MIN) || 5,
  fazerBackup: null, // (db) => { arquivo, tamanho } — servidor: VACUUM INTO; demonstração: registro
  arquivos: null, // última listagem de arquivos (para os testes rápidos)
  timer: null,
  timerPulso: null,
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
function testar(id, nome, frente, fn) {
  const t0 = Date.now();
  try {
    const detalhe = fn();
    return { id, nome, frente, ok: true, ms: Date.now() - t0, detalhe: detalhe ?? 'OK' };
  } catch (err) {
    return { id, nome, frente, ok: false, ms: Date.now() - t0, detalhe: err.message };
  }
}

/** Arquivo existe na plataforma? Usa a fonte (disco) ou a última listagem feita. */
function existeArquivo(caminho) {
  if (estado.fonte?.existe) return estado.fonte.existe(caminho);
  if (!estado.arquivos && estado.fonte) estado.arquivos = new Set(estado.fonte.listar().map((f) => f.caminho));
  return Boolean(estado.arquivos?.has(caminho));
}

function verificarFuncoes(db, existe = existeArquivo) {
  const { criarDesafio } = require('./teclado');
  const { gerarBoletoBancario, lerBoleto } = require('./boleto');
  const { gerarBrCode } = require('../integracoes/bradesco/brcode');
  const { hashSenha, verificarSenha } = require('./senha');
  const alcadas = require('./alcadas');
  const ouvidoria = require('./ouvidoria');
  const limites = require('./limites');
  const tem = (caminho) => { if (!existe(caminho)) throw new Error(`Arquivo ausente: ${caminho}`); return 'Arquivos presentes'; };
  return [
    testar('banco', 'Banco de dados', 'Servidor', () => {
      const r = db.prepare('PRAGMA quick_check').get();
      const v = Object.values(r)[0];
      if (v !== 'ok') throw new Error(`Verificação do banco: ${v}`);
      return `Íntegro · ${db.prepare('SELECT COUNT(*) AS n FROM contas').get().n} contas`;
    }),
    testar('login_equipe', 'Login da equipe', 'Banqueiro', () => {
      const n = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE ativo = 1 AND perfil = 'admin'").get().n;
      if (!n) throw new Error('Nenhum administrador ativo.');
      const h = hashSenha('verificacao-de-seguranca');
      if (!verificarSenha('verificacao-de-seguranca', h)) throw new Error('Conferência de senha falhou.');
      return `${n} administrador(es) ativo(s)`;
    }),
    testar('alcadas', 'Alçadas e permissões', 'Banqueiro', () => `${Object.keys(alcadas.mapa(db, 'operador')).length} permissões avaliadas`),
    testar('ouvidoria', 'Ouvidoria', 'Banqueiro', () => `${ouvidoria.listarRegras(db).filter((r) => r.exige).length} ações exigem análise`),
    testar('teclado', 'Teclado virtual (login do cliente)', 'Internet Banking', () => {
      const d = criarDesafio(db);
      db.prepare('DELETE FROM desafios_teclado WHERE id = ?').run(d.id);
      if (d.teclas.length !== 5 || new Set(d.teclas.flat()).size !== 10) throw new Error('Teclado gerado com pares inválidos.');
      return 'Pares sorteados corretamente';
    }),
    testar('limites', 'Limites diários', 'Internet Banking', () => { limites.efetivarVencidos(db); return 'Pedidos de limite em dia'; }),
    testar('boletos', 'Leitura de boletos', 'Internet Banking', () => {
      const b = gerarBoletoBancario({ banco: '237', valorCentavos: 12345, vencimento: '2026-12-31', campoLivre: '1' });
      if (lerBoleto(b.linha_digitavel).valor_centavos !== 12345) throw new Error('Valor do boleto lido errado.');
      return 'Linha digitável conferida';
    }),
    testar('pix_qr', 'QR Code PIX (BR Code)', 'Internet Banking', () => {
      const c = gerarBrCode({ chave: 'teste@payax.com.br', nome: 'PAY AX', cidade: 'SAO PAULO', valorCentavos: 100, txid: 'VERIFICACAO' });
      if (!/6304[0-9A-F]{4}$/.test(c)) throw new Error('Código PIX sem verificador.');
      return 'Código gerado com CRC';
    }),
    testar('bradesco', 'Integração bancária', 'Servidor', () => {
      if (!estado.bradesco) return 'Serviço não iniciado';
      const s = estado.bradesco.status();
      return `Modo ${s.modo}${s.webhook_protegido ? ' · webhook protegido' : ''}`;
    }),
    testar('antifraude', 'Antifraude', 'Banqueiro', () => `${db.prepare("SELECT COUNT(*) AS n FROM alertas_fraude WHERE status = 'aberto'").get().n} alerta(s) aberto(s)`),
    testar('telas_banqueiro', 'Banqueiro (telas)', 'Banqueiro', () => tem('public/index.html') && tem('public/js/app.js')),
    testar('telas_ib', 'Internet Banking (telas)', 'Internet Banking', () => tem('public/ib/index.html') && tem('public/ib/js/app.js')),
    testar('telas_site', 'Site institucional', 'Site', () => tem('public/site/index.html') && tem('public/site/js/site.js')),
  ];
}

// ---------- Conexões e configuração ----------
const lerEstado = (db, chave) => db.prepare('SELECT valor FROM estado_sistema WHERE chave = ?').get(chave)?.valor ?? null;
const gravarEstado = (db, chave, valor) => db.prepare('INSERT INTO estado_sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(chave, valor);

/** Último backup: o mais recente entre a pasta de backups (servidor) e o registrado pelo sistema. */
function ultimoBackup(db, servidor) {
  const datas = [servidor?.ultimo_backup, lerEstado(db, 'ultimo_backup')].filter(Boolean);
  return datas.length ? datas.sort().at(-1) : null;
}

function verificarConexoes(db, servidor) {
  const producao = process.env.NODE_ENV === 'production';
  const segredoPadrao = !process.env.PAYAX_SECRET || process.env.PAYAX_SECRET === 'troque-este-segredo';
  const b = estado.bradesco?.status() ?? null;
  const um = (sql) => db.prepare(sql).get();
  const pix24 = um(`SELECT COUNT(*) AS total, SUM(status = 'falhou') AS falhas FROM pix_saidas WHERE criado_em >= datetime('now', '-1 day')`);
  const ultimoWebhook = um('SELECT MAX(recebido_em) AS em FROM pix_recebidos').em;
  const backupEm = ultimoBackup(db, servidor);
  const horasBackup = backupEm ? (Date.now() - Date.parse(backupEm)) / 3600_000 : null;
  const checagens = [
    { id: 'producao', item: 'Ambiente de produção', ok: producao, detalhe: producao ? 'NODE_ENV=production' : 'Rodando fora do modo produção' },
    { id: 'segredos', item: 'Chaves secretas definidas', ok: !segredoPadrao && Boolean(process.env.PAYAX_PEPPER), detalhe: segredoPadrao ? 'Use segredos próprios no .env' : 'Definidas (valores não exibidos)' },
    { id: 'webhook', item: 'Webhook do banco protegido por token', ok: Boolean(b?.webhook_protegido), detalhe: b?.webhook_protegido ? 'Token configurado' : 'Defina BRADESCO_WEBHOOK_TOKEN' },
    { id: 'bradesco_real', item: 'Integração bancária em modo real', ok: b ? b.modo !== 'simulador' : false, detalhe: b ? `Modo atual: ${b.modo}` : '—' },
    { id: 'https', item: 'HTTPS obrigatório (HSTS) e política de conteúdo (CSP)', ok: producao, detalhe: producao ? 'Cabeçalhos ativos' : 'Ativados apenas em produção' },
    { id: 'backup', item: 'Backup recente (até 26 h)', ok: horasBackup !== null && horasBackup <= 26, detalhe: horasBackup === null ? 'Nenhum backup encontrado' : `Último há ${Math.round(horasBackup)} h` },
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
  if (estado.fonte) estado.arquivos = new Set(lista.map((f) => f.caminho));
  const funcoes = verificarFuncoes(db);
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
  servicos.registrarPulso(db, servicos.avaliar(db, { funcoes, servidor, conexoes }));
  if (status === 'critico') registrar(db, { usuario: usuarioId ? { id: usuarioId } : undefined }, 'seguranca_critico', 'verificacao_seguranca', Number(r.lastInsertRowid), { integridade: integ.status, funcoes_com_falha: funcoes.filter((f) => !f.ok).map((f) => f.nome) });
  return detalhar(db, Number(r.lastInsertRowid));
}

/** Teste rápido dos serviços (sem a integridade do código), a cada PAYAX_MONITOR_INTERVALO_MIN minutos. */
function pulsar(db) {
  const funcoes = verificarFuncoes(db);
  let servidor = null;
  try { servidor = estado.coletarServidor ? estado.coletarServidor() : null; } catch (err) { servidor = { erro: err.message }; }
  const lista = servicos.avaliar(db, { funcoes, servidor, conexoes: verificarConexoes(db, servidor) });
  servicos.registrarPulso(db, lista);
  return lista;
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
  return {
    ultima, historico, intervalo_min: estado.intervaloMin, pulso_min: estado.pulsoMin, base: integridade.base(db), fonte: estado.fonte?.descricao ?? null,
    servicos: servicos.resumo(db),
    problemas: ultima ? require('./correcoes').problemas(db, ultima, servicos.resumo(db)) : [],
  };
}

function aprovarIntegridade(db, req, motivo) {
  if (!estado.fonte) throw new Error('Fonte de arquivos indisponível.');
  const n = integridade.aprovar(db, estado.fonte, req.usuario.id);
  registrar(db, req, 'aprovar_integridade', 'verificacao_seguranca', null, { arquivos: n, motivo });
  return n;
}

/** Executa uma correção (menu Segurança → Corrigir). */
const corrigir = (db, req, pedido) => require('./correcoes').corrigir(db, req, estado, pedido);

/** Informações e correções de um serviço (janela aberta ao clicar no cartão do serviço). */
function infoServico(db, chave) {
  const detalhe = servicos.detalhe(db, chave);
  if (!detalhe) return null;
  let servidor = null;
  try { servidor = estado.coletarServidor ? estado.coletarServidor() : null; } catch { /* sem métricas */ }
  const um = (sql) => db.prepare(sql).get();
  const ultima = formatar(db.prepare('SELECT * FROM verificacoes_seguranca ORDER BY id DESC LIMIT 1').get());
  const conexoes = ultima?.conexoes ?? verificarConexoes(db, servidor);
  const linhas = [];
  const add = (rotulo, valor, tipo = 'texto') => linhas.push({ rotulo, valor, tipo });
  const acoes = [];
  const prefixo = { banqueiro: (c) => c.startsWith('public/') && !c.startsWith('public/ib/') && !c.startsWith('public/site/'), internet_banking: (c) => c.startsWith('public/ib/'), site: (c) => c.startsWith('public/site/') }[chave];
  switch (chave) {
    case 'api':
      if (servidor?.ambiente === 'servidor') {
        add('Aplicação no ar há', servidor.ativo_ha_s, 'duracao');
        add('Servidor ligado há', servidor.servidor_ligado_ha_s, 'duracao');
        add('Memória em uso', `${Math.round((1 - servidor.memoria_livre_bytes / servidor.memoria_total_bytes) * 100)}%`);
        add('Memória da aplicação', servidor.processo_memoria_bytes, 'bytes');
        add('Carga (1 / 5 / 15 min)', servidor.carga.join(' / '));
        if (servidor.disco) add('Disco livre', servidor.disco.livre_bytes, 'bytes');
        add('Sistema', `${servidor.sistema} · Node ${servidor.node}`);
      } else {
        add('Ambiente', 'Demonstração no navegador (as métricas do servidor aparecem na versão instalada)');
        if (servidor?.ativo_ha_s !== undefined) add('Página aberta há', servidor.ativo_ha_s, 'duracao');
      }
      add('Requisições (última hora)', conexoes.requisicoes.total, 'numero');
      add('Erros do servidor (última hora)', conexoes.requisicoes.s5xx, 'numero');
      add('Acessos negados / bloqueios', `${conexoes.requisicoes.s401} / ${conexoes.requisicoes.s429}`);
      add('IPs distintos (última hora)', conexoes.requisicoes.ips_distintos, 'numero');
      break;
    case 'banco_dados':
      if (servidor?.banco_bytes) add('Tamanho', servidor.banco_bytes, 'bytes');
      add('Clientes', um('SELECT COUNT(*) AS n FROM clientes').n, 'numero');
      add('Contas', um('SELECT COUNT(*) AS n FROM contas').n, 'numero');
      add('Transações', um('SELECT COUNT(*) AS n FROM transacoes').n, 'numero');
      acoes.push({ acao: 'reparar_banco', rotulo: 'Reparar banco de dados' });
      break;
    case 'bradesco':
      add('Modo da integração', conexoes.banco.modo ?? '—');
      add('PIX enviados (24 h)', conexoes.banco.pix_enviados_24h, 'numero');
      add('PIX com falha (24 h)', conexoes.banco.pix_falhas_24h, 'numero');
      add('Último recebimento do banco', conexoes.banco.ultimo_recebimento, 'data');
      break;
    case 'backup': {
      const em = ultimoBackup(db, servidor);
      add('Último backup', em, 'data');
      if (em) add('Idade', Math.round((Date.now() - Date.parse(em)) / 1000), 'duracao');
      add('Cópias mantidas', `${Number(process.env.PAYAX_BACKUP_MANTER) || 14} mais recentes`);
      acoes.push({ acao: 'backup', rotulo: 'Fazer backup agora' });
      break;
    }
    case 'antifraude':
      add('Alertas abertos', um("SELECT COUNT(*) AS n FROM alertas_fraude WHERE status = 'aberto'").n, 'numero');
      add('Alertas de alto risco abertos', um("SELECT COUNT(*) AS n FROM alertas_fraude WHERE status = 'aberto' AND severidade = 'alta'").n, 'numero');
      add('Acessos com falha (24 h)', um("SELECT COUNT(*) AS n FROM tentativas_acesso WHERE sucesso = 0 AND criado_em >= datetime('now', '-1 day')").n, 'numero');
      acoes.push({ acao: 'analisar_antifraude', rotulo: 'Rodar a análise agora' });
      break;
    case 'internet_banking':
      acoes.push({ acao: 'limpar_teclado', rotulo: 'Limpar teclados vencidos' }, { acao: 'efetivar_limites', rotulo: 'Processar pedidos de limite' });
      break;
    default:
  }
  if (prefixo) {
    const base = db.prepare('SELECT caminho FROM integridade_base').all().filter((b) => prefixo(b.caminho)).length;
    const alterados = (ultima?.integridade?.alteracoes ?? []).filter((a) => prefixo(a.caminho));
    add('Arquivos monitorados', base, 'numero');
    add('Alterados desde a versão aprovada', alterados.length, 'numero');
    add('Versão aprovada em', integridade.base(db).aprovada_em, 'data');
    detalhe.alterados = alterados.map((a) => ({ caminho: a.caminho, tipo: a.tipo }));
  }
  acoes.push({ acao: 'retestar', rotulo: 'Testar agora' });
  return { ...detalhe, info: linhas, acoes };
}

/** Agenda a verificação periódica (servidor e demonstração). */
function agendar(db) {
  clearInterval(estado.timer);
  estado.timer = setInterval(() => { try { executar(db); } catch (err) { console.error('[PAY AX] Verificação de segurança falhou:', err.message); } }, estado.intervaloMin * 60_000);
  estado.timer.unref?.();
  clearInterval(estado.timerPulso);
  estado.timerPulso = setInterval(() => { try { pulsar(db); } catch (err) { console.error('[PAY AX] Monitoramento dos serviços falhou:', err.message); } }, estado.pulsoMin * 60_000);
  estado.timerPulso.unref?.();
}

module.exports = { corrigir, infoServico, configurar, contarRequisicoes, executar, pulsar, painel, detalhar, aprovarIntegridade, agendar, estado, verificarFuncoes, verificarConexoes, ultimoBackup, lerEstado, gravarEstado };
