'use strict';

/**
 * ZOE Core: conduz a ligação (identificar, confirmar, resolver ou transferir) e fala com o IXC.
 *
 * A central telefônica (URA por teclas na fase 1, voz com IA depois) chama estas etapas pela API de integração.
 * Cada resposta traz a `etapa` seguinte e uma `fala` pronta para tocar em texto para voz.
 *
 * Regras (do projeto da ZOE):
 * - Nada do contrato é dito antes de confirmar quem ligou: número cadastrado + 3 primeiros dígitos do CPF/CNPJ;
 *   número desconhecido: CPF/CNPJ completo + data de nascimento.
 * - Boleto só vai para contatos já cadastrados no IXC, nunca para um número informado na hora.
 * - Desbloqueio de confiança só para contrato bloqueado por atraso, com limite por cliente no período.
 * - Se o IXC não responder, a ZOE avisa e transfere.
 */

const crypto = require('node:crypto');
const config = require('../config');
const { agora, transacao } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const v = require('../lib/validacao');
const { criarIxc, ErroIxc } = require('./ixc');

const MOTIVOS = ['financeiro', 'suporte', 'comercial', 'outro'];
const CANAIS = ['whatsapp', 'sms', 'email'];
const MAX_TENTATIVAS_DOCUMENTO = 2;
const MAX_TENTATIVAS_CONFIRMACAO = 3;

// ---------- Token do IXC cifrado com o segredo do servidor ----------
const chaveCifra = () => crypto.createHash('sha256').update(`zoe-ixc:${config.secret}`).digest();
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chaveCifra(), iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), dados].map((b) => b.toString('base64url')).join('.');
}
function decifrar(guardado) {
  try {
    const [iv, tag, dados] = String(guardado).split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', chaveCifra(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(dados), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Endereço externo (IXC, webhook do WhatsApp): https; http só em teste ou com PABX_ZOE_HTTP=1 (rede interna do provedor). */
function endereco(valor, nome) {
  const t = v.texto(valor, nome, 300);
  let u;
  try { u = new URL(t); } catch { v.falhar(`${nome[0].toUpperCase()}${nome.slice(1)} inválido.`); }
  const http = process.env.NODE_ENV === 'test' || process.env.PABX_ZOE_HTTP === '1';
  v.exigir(u.protocol === 'https:' || (http && u.protocol === 'http:'), `${nome[0].toUpperCase()}${nome.slice(1)} deve começar com https://.`);
  v.exigir(!u.username && !u.password, `${nome[0].toUpperCase()}${nome.slice(1)} não pode ter usuário e senha.`);
  return u.toString().replace(/\/+$/, '');
}

/** Endereço do IXC sem o /webservice/v1 do final (a ZOE acrescenta). */
const enderecoIxc = (valor) => endereco(valor, 'o endereço do IXC').replace(/\/webservice\/v1$/i, '');

// ---------- Configuração ----------
const PADRAO = {
  ativo: 0, ixc_url: null, ixc_token_cifrado: null, desbloqueio_ativo: 1, desbloqueio_limite: 1, desbloqueio_periodo_dias: 30,
  canal_email: 1, canal_sms: 1, canal_whatsapp: 0, whatsapp_webhook: null, fila_financeiro_id: null, fila_suporte_id: null, fila_comercial_id: null,
  alertas_url: null, alertas_chave_cifrada: null,
};
const lerConfigZoe = (db, empresaId) => ({ ...PADRAO, ...(db.prepare('SELECT * FROM zoe_config WHERE empresa_id = ?').get(empresaId) ?? {}), empresa_id: empresaId });

/** Configuração para o painel (sem o token). */
function configPublica(db, empresaId) {
  const c = lerConfigZoe(db, empresaId);
  const { ixc_token_cifrado: tk, alertas_chave_cifrada: ak, ...resto } = c;
  return {
    ...resto,
    ativo: Boolean(c.ativo), desbloqueio_ativo: Boolean(c.desbloqueio_ativo),
    canal_email: Boolean(c.canal_email), canal_sms: Boolean(c.canal_sms), canal_whatsapp: Boolean(c.canal_whatsapp),
    token_configurado: Boolean(tk && decifrar(tk)),
    alertas_chave_configurada: Boolean(ak && decifrar(ak)),
  };
}

function salvarConfig(db, empresaId, d) {
  const a = lerConfigZoe(db, empresaId);
  const bool = (k) => (d[k] !== undefined ? (v.booleano(d[k]) ? 1 : 0) : a[k]);
  const fila = (k) => {
    if (d[k] === undefined) return a[k];
    if (!d[k]) return null;
    const f = db.prepare('SELECT id FROM filas WHERE id = ? AND empresa_id = ?').get(Number(d[k]), empresaId);
    v.exigir(f, 'Fila não encontrada nesta empresa.');
    return f.id;
  };
  const n = {
    ativo: bool('ativo'),
    ixc_url: d.ixc_url !== undefined ? (d.ixc_url ? enderecoIxc(d.ixc_url) : null) : a.ixc_url,
    ixc_token_cifrado: d.ixc_token ? cifrar(v.texto(d.ixc_token, 'o token do IXC', 300)) : a.ixc_token_cifrado,
    desbloqueio_ativo: bool('desbloqueio_ativo'),
    desbloqueio_limite: d.desbloqueio_limite !== undefined ? v.inteiro(d.desbloqueio_limite, 'o limite de desbloqueios', { min: 0, max: 10 }) : a.desbloqueio_limite,
    desbloqueio_periodo_dias: d.desbloqueio_periodo_dias !== undefined
      ? v.inteiro(d.desbloqueio_periodo_dias, 'o período dos desbloqueios', { min: 1, max: 365 }) : a.desbloqueio_periodo_dias,
    canal_email: bool('canal_email'),
    canal_sms: bool('canal_sms'),
    canal_whatsapp: bool('canal_whatsapp'),
    whatsapp_webhook: d.whatsapp_webhook !== undefined ? (d.whatsapp_webhook ? endereco(d.whatsapp_webhook, 'o endereço do envio por WhatsApp') : null) : a.whatsapp_webhook,
    fila_financeiro_id: fila('fila_financeiro_id'),
    fila_suporte_id: fila('fila_suporte_id'),
    fila_comercial_id: fila('fila_comercial_id'),
    // Alertas de rede lidos do ZOE Atende (endereço + chave de API de lá, cifrada como o token do IXC).
    // Chave vazia não apaga a guardada (o painel não a mostra de volta); null apaga.
    alertas_url: d.alertas_url !== undefined ? (d.alertas_url ? endereco(d.alertas_url, 'o endereço do ZOE Atende') : null) : a.alertas_url,
    alertas_chave_cifrada: d.alertas_chave === null ? null
      : d.alertas_chave ? cifrar(v.texto(d.alertas_chave, 'a chave do ZOE Atende', 300)) : a.alertas_chave_cifrada,
  };
  v.exigir(!n.canal_whatsapp || n.whatsapp_webhook, 'Para enviar boleto por WhatsApp, informe o endereço do envio (webhook do seu WhatsApp).');
  v.exigir(!n.ativo || (n.ixc_url && n.ixc_token_cifrado), 'Para ligar a ZOE, informe o endereço e o token do IXC.');
  const cols = Object.keys(n);
  db.prepare(`INSERT INTO zoe_config (empresa_id, ${cols.join(', ')}, atualizado_em) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)
    ON CONFLICT (empresa_id) DO UPDATE SET ${cols.map((k) => `${k} = excluded.${k}`).join(', ')}, atualizado_em = excluded.atualizado_em`)
    .run(empresaId, ...cols.map((k) => n[k]), agora());
}

// Um cliente do IXC por empresa (e por endereço/token), para o cache curto valer durante a ligação.
const clientes = new Map();
function ixcDa(cfg, uid) {
  const token = cfg.ixc_token_cifrado && decifrar(cfg.ixc_token_cifrado);
  if (!cfg.ixc_url || !token) throw new ErroNegocio('A ZOE ainda não está ligada ao IXC desta empresa.', 409);
  const chave = `${cfg.empresa_id}|${cfg.ixc_url}|${crypto.createHash('sha256').update(token).digest('hex')}`;
  if (!clientes.has(chave)) {
    for (const k of clientes.keys()) if (k.startsWith(`${cfg.empresa_id}|`)) clientes.delete(k);
    clientes.set(chave, criarIxc({ url: cfg.ixc_url, token }));
  }
  return uid === undefined ? clientes.get(chave) : clientes.get(chave).ligacao(uid);
}

/** Testa endereço e token (os informados agora ou os já salvos). */
async function testarIxc(db, empresaId, d = {}) {
  const cfg = lerConfigZoe(db, empresaId);
  const url = d.ixc_url ? enderecoIxc(d.ixc_url) : cfg.ixc_url;
  const token = d.ixc_token || (cfg.ixc_token_cifrado && decifrar(cfg.ixc_token_cifrado));
  v.exigir(url && token, 'Informe o endereço e o token do IXC.');
  try {
    await criarIxc({ url, token, timeoutMs: 5000, cacheMs: 0 }).testar();
  } catch (err) {
    if (err instanceof ErroIxc) throw new ErroNegocio(err.message, 502);
    throw err;
  }
  return { ok: true };
}

// ---------- Textos falados ----------
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const falarData = (iso) => {
  const [, m, d] = String(iso).split('-').map(Number);
  return m ? `${d} de ${MESES[m - 1]}` : String(iso);
};
function falarValor(centavos) {
  const r = Math.floor(centavos / 100);
  const c = centavos % 100;
  const reais = r ? `${r.toLocaleString('pt-BR')} ${r === 1 ? 'real' : 'reais'}` : '';
  const cent = c ? `${c} ${c === 1 ? 'centavo' : 'centavos'}` : '';
  return [reais, cent].filter(Boolean).join(' e ') || 'zero reais';
}
const primeiroNome = (nome) => String(nome ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/^./, (x) => x.toUpperCase()) ?? '';

function mascararEmail(e) {
  const [u, dominio] = String(e).trim().split('@');
  if (!dominio) return null;
  return `${u.slice(0, 1)}***@${dominio}`;
}
const finalTelefone = (t) => v.digitos(t).slice(-4);

/** Canais em que este cliente pode receber o boleto: só os ligados na ZOE e cadastrados no IXC. */
function canaisDoCliente(cfg, c) {
  const lista = [];
  const celular = v.digitos(c.telefone_celular).length >= 10 ? c.telefone_celular : null;
  const whats = v.digitos(c.whatsapp).length >= 10 ? c.whatsapp : celular;
  if (cfg.canal_whatsapp && cfg.whatsapp_webhook && whats) lista.push({ canal: 'whatsapp', destino: `WhatsApp final ${finalTelefone(whats)}`, _para: v.digitos(whats) });
  if (cfg.canal_sms && celular) lista.push({ canal: 'sms', destino: `celular final ${finalTelefone(celular)}`, _para: v.digitos(celular) });
  const email = String(c.email ?? '').trim();
  if (cfg.canal_email && v.emailValido(email)) lista.push({ canal: 'email', destino: `e-mail ${mascararEmail(email)}`, _para: email });
  return lista;
}
const semPara = (canais) => canais.map(({ _para, ...x }) => x);

// ---------- Atendimento ----------
function carregar(db, empresa, uid) {
  const at = db.prepare('SELECT * FROM zoe_atendimentos WHERE empresa_id = ? AND uid = ?').get(empresa.id, String(uid));
  if (!at) throw new ErroNegocio('Atendimento da ZOE não encontrado para esta ligação.', 404);
  return at;
}
const atualizar = (db, at, campos) => {
  const ks = Object.keys(campos);
  db.prepare(`UPDATE zoe_atendimentos SET ${ks.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...ks.map((k) => campos[k]), at.id);
  Object.assign(at, campos);
};
const acao = (db, at, tipo, detalhes, sucesso = true) => db.prepare(`INSERT INTO zoe_acoes (empresa_id, atendimento_id, cliente_id, tipo, sucesso, detalhes, criado_em)
  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(at.empresa_id, at.id, at.cliente_id, tipo, sucesso ? 1 : 0, detalhes === undefined ? null : JSON.stringify(detalhes), agora());

const FILA_DO_MOTIVO = { financeiro: 'fila_financeiro_id', suporte: 'fila_suporte_id', comercial: 'fila_comercial_id', outro: 'fila_suporte_id' };
const filaPublica = (db, id) => (id ? db.prepare('SELECT id, nome FROM filas WHERE id = ?').get(id) ?? null : null);

/** Resposta padrão de cada etapa. */
function estado(db, at, fala, extra = {}) {
  return {
    uid: at.uid,
    etapa: at.etapa,
    ...(at.etapa === 'confirmar' ? { metodo: at.metodo_confirmacao } : {}),
    ...(at.etapa === 'menu' ? { cliente: { nome: primeiroNome(at.cliente_nome) } } : {}),
    ...(at.etapa === 'transferir' ? { fila: filaPublica(db, at.fila_id), resumo: at.resumo } : {}),
    fala,
    ...extra,
  };
}

/** Resumo para o atendente que recebe a ligação. */
function montarResumo(db, at, motivo) {
  const partes = [];
  partes.push(at.cliente_nome ? `Cliente ${at.cliente_nome} (IXC ${at.cliente_id})` : at.telefone ? `Ligação de ${at.telefone}, cliente não identificado` : 'Cliente não identificado');
  if (at.cliente_nome && at.etapa !== 'menu') partes.push('identidade não confirmada');
  const acoes = db.prepare('SELECT tipo, sucesso, detalhes FROM zoe_acoes WHERE atendimento_id = ? ORDER BY id').all(at.id);
  for (const a of acoes) {
    const d = a.detalhes ? JSON.parse(a.detalhes) : {};
    if (a.tipo === 'faturas') partes.push(d.quantidade ? `${d.quantidade} fatura(s) em aberto, total ${(d.total_centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}` : 'sem faturas em aberto');
    if (a.tipo === 'boleto') partes.push(a.sucesso ? `boleto enviado por ${d.canal}` : `boleto não enviado (${d.erro ?? 'erro'})`);
    if (a.tipo === 'desbloqueio') partes.push(a.sucesso ? 'desbloqueio de confiança concedido' : `desbloqueio negado (${d.motivo ?? d.erro ?? 'erro'})`);
    if (a.tipo === 'erro') partes.push(`falha no IXC: ${d.erro}`);
  }
  partes.push(`pediu: ${motivo}`);
  return partes.join('; ');
}

function transferirAgora(db, at, cfg, motivo, fala) {
  const m = MOTIVOS.includes(motivo) ? motivo : 'outro';
  const filaId = cfg[FILA_DO_MOTIVO[m]] ?? null;
  const resumo = montarResumo(db, at, m);
  atualizar(db, at, { etapa: 'transferir', motivo: at.motivo ?? m, resultado: 'transferido', fila_id: filaId, resumo });
  acao(db, at, 'transferencia', { motivo: m, fila_id: filaId });
  return estado(db, at, fala ?? 'Vou transferir sua ligação para um atendente. Aguarde um instante.');
}

/** Executa uma consulta ao IXC; se ele falhar, registra e transfere (a ZOE nunca deixa o cliente sem resposta). */
async function comIxc(db, at, cfg, fn) {
  try {
    return { ok: true, valor: await fn(ixcDa(cfg, at.uid)) };
  } catch (err) {
    if (!(err instanceof ErroIxc)) throw err;
    acao(db, at, 'erro', { erro: err.message }, false);
    return { ok: false, resposta: transferirAgora(db, at, cfg, at.motivo ?? 'outro', 'Estou com dificuldade para consultar seu cadastro agora. Vou transferir para um atendente.') };
  }
}

function configAtiva(db, empresa) {
  if (empresa.status !== 'ativa') throw new ErroNegocio('Empresa bloqueada.', 403);
  const cfg = lerConfigZoe(db, empresa.id);
  if (!cfg.ativo) throw new ErroNegocio('A ZOE está desligada nesta empresa.', 409);
  return cfg;
}

const AVISO = 'Olá! Eu sou a ZOE, assistente virtual. Esta ligação é gravada.';

async function iniciar(db, empresa, d) {
  const cfg = configAtiva(db, empresa);
  const uid = v.texto(d.uid, 'o uid da ligação', 120);
  const existente = db.prepare('SELECT * FROM zoe_atendimentos WHERE empresa_id = ? AND uid = ?').get(empresa.id, uid);
  if (existente) return { ...estado(db, existente, null), repetida: true };
  const telefone = v.digitos(d.telefone).slice(0, 20) || null;
  const r = db.prepare('INSERT INTO zoe_atendimentos (empresa_id, uid, telefone, inicio) VALUES (?, ?, ?, ?)').run(empresa.id, uid, telefone, agora());
  const at = db.prepare('SELECT * FROM zoe_atendimentos WHERE id = ?').get(Number(r.lastInsertRowid));

  if (telefone && telefone.length >= 8) {
    const x = await comIxc(db, at, cfg, (ixc) => ixc.clientesPorTelefone(telefone));
    if (!x.ok) return x.resposta;
    if (x.valor.length === 1) {
      // Número cadastrado: guarda quem é, mas só fala do contrato depois da confirmação.
      atualizar(db, at, { cliente_id: String(x.valor[0].id), etapa: 'confirmar', metodo_confirmacao: 'cpf3' });
      acao(db, at, 'identificacao', { por: 'telefone' });
      return estado(db, at, `${AVISO} Para sua segurança, digite os três primeiros números do CPF ou CNPJ do titular.`);
    }
    acao(db, at, 'identificacao', { por: 'telefone', encontrados: x.valor.length }, false);
  }
  atualizar(db, at, { etapa: 'documento' });
  return estado(db, at, `${AVISO} Digite o CPF ou o CNPJ do titular do contrato, só os números.`);
}

async function informarDocumento(db, empresa, uid, d) {
  const cfg = configAtiva(db, empresa);
  const at = carregar(db, empresa, uid);
  if (at.etapa !== 'documento') throw new ErroNegocio('Esta ligação não está esperando o CPF/CNPJ.', 409);
  const doc = v.digitos(d.documento);
  const valido = (doc.length === 11 && v.cpfValido(doc)) || (doc.length === 14 && v.cnpjValido(doc));
  let lista = [];
  if (valido) {
    const x = await comIxc(db, at, cfg, (ixc) => ixc.clientesPorDocumento(doc));
    if (!x.ok) return x.resposta;
    lista = x.valor;
  }
  if (lista.length === 1) {
    const c = lista[0];
    acao(db, at, 'identificacao', { por: 'documento' });
    atualizar(db, at, { cliente_id: String(c.id), tentativas: 0 });
    if (!nascimento(c)) return transferirAgora(db, at, cfg, 'outro', 'Não consigo confirmar seus dados por aqui. Vou transferir para um atendente.');
    atualizar(db, at, { etapa: 'confirmar', metodo_confirmacao: 'nascimento' });
    return estado(db, at, 'Agora digite a data de nascimento do titular, com dia, mês e ano. Por exemplo: zero cinco, zero três, mil novecentos e noventa.');
  }
  acao(db, at, 'identificacao', { por: 'documento', valido, encontrados: lista.length }, false);
  atualizar(db, at, { tentativas: at.tentativas + 1 });
  if (lista.length > 1 || at.tentativas >= MAX_TENTATIVAS_DOCUMENTO) {
    return transferirAgora(db, at, cfg, 'outro', 'Não encontrei seu cadastro. Vou transferir para um atendente.');
  }
  return estado(db, at, valido ? 'Não encontrei esse CPF ou CNPJ. Digite de novo, só os números.' : 'Esse número não parece um CPF ou CNPJ válido. Digite de novo, só os números.');
}

/** Data de nascimento do cadastro como DDMMAAAA (ou null se não houver). */
function nascimento(c) {
  const m = String(c.data_nascimento ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || m[1] === '0000') return null;
  return `${m[3]}${m[2]}${m[1]}`;
}

/**
 * O código digitado confere com o cadastro do IXC? `cpf3`: três primeiros do CPF/CNPJ;
 * `nascimento`: DDMMAAAA. Comparação em tempo constante. Usado pela ZOE e pela URA inteligente.
 */
function codigoConfere(cliente, metodo, codigoDigitado) {
  if (!cliente) return false;
  const codigo = v.digitos(codigoDigitado);
  const esperado = metodo === 'cpf3' ? v.digitos(cliente.cnpj_cpf).slice(0, 3) : metodo === 'nascimento' ? nascimento(cliente) : null;
  return Boolean(esperado && esperado.length && codigo.length === esperado.length
    && crypto.timingSafeEqual(Buffer.from(codigo), Buffer.from(esperado)));
}

async function confirmar(db, empresa, uid, d) {
  const cfg = configAtiva(db, empresa);
  const at = carregar(db, empresa, uid);
  if (at.etapa !== 'confirmar') throw new ErroNegocio('Esta ligação não está esperando a confirmação.', 409);
  const x = await comIxc(db, at, cfg, (ixc) => ixc.clientePorId(at.cliente_id));
  if (!x.ok) return x.resposta;
  const c = x.valor;
  const ok = codigoConfere(c, at.metodo_confirmacao, d.codigo);
  acao(db, at, 'confirmacao', { metodo: at.metodo_confirmacao }, ok);
  if (ok) {
    atualizar(db, at, { etapa: 'menu', cliente_nome: String(c.razao ?? c.fantasia ?? '').trim().slice(0, 160) || null, tentativas: 0 });
    return estado(db, at, `Obrigada, ${primeiroNome(at.cliente_nome)}. Para segunda via de boleto, tecle 1. Para liberar sua internet, tecle 2. `
      + 'Para suporte técnico, tecle 3. Para contratar, tecle 4. Para falar com um atendente, tecle 0.');
  }
  atualizar(db, at, { tentativas: at.tentativas + 1 });
  if (at.tentativas >= MAX_TENTATIVAS_CONFIRMACAO) {
    return transferirAgora(db, at, cfg, 'outro', 'Não consegui confirmar seus dados. Vou transferir para um atendente.');
  }
  return estado(db, at, 'Os números não conferem. Tente de novo.');
}

function exigirMenu(at) {
  if (at.etapa !== 'menu') throw new ErroNegocio('Confirme a identidade do cliente antes.', 409);
}

async function faturas(db, empresa, uid) {
  const cfg = configAtiva(db, empresa);
  const at = carregar(db, empresa, uid);
  exigirMenu(at);
  if (!at.motivo) atualizar(db, at, { motivo: 'financeiro' });
  const x = await comIxc(db, at, cfg, async (ixc) => ({ lista: await ixc.faturasAbertas(at.cliente_id), cliente: await ixc.clientePorId(at.cliente_id) }));
  if (!x.ok) return x.resposta;
  const { lista } = x.valor;
  const total = lista.reduce((s, f) => s + f.valor_centavos, 0);
  acao(db, at, 'faturas', { quantidade: lista.length, total_centavos: total });
  const canais = x.valor.cliente ? canaisDoCliente(cfg, x.valor.cliente) : [];
  let fala;
  if (!lista.length) {
    fala = 'Você não tem faturas em aberto. Obrigada por ligar!';
  } else {
    const f = lista[0];
    fala = `${lista.length === 1 ? 'Você tem uma fatura em aberto' : `Você tem ${lista.length} faturas em aberto`}. `
      + `${lista.length === 1 ? 'Ela' : 'A mais antiga'} vence em ${falarData(f.vencimento)}, no valor de ${falarValor(f.valor_centavos)}.`;
    if (canais.length) fala += ` ${canais.map((c, i) => `Para receber o boleto e o PIX por ${c.destino}, tecle ${i + 1}.`).join(' ')}`;
    else fala += ' Não encontrei um celular ou e-mail cadastrado para enviar o boleto. Vou transferir para o financeiro.';
  }
  return estado(db, at, fala, { faturas: lista, total_centavos: total, canais: semPara(canais) });
}

async function enviarBoleto(db, empresa, uid, d) {
  const cfg = configAtiva(db, empresa);
  const at = carregar(db, empresa, uid);
  exigirMenu(at);
  const canal = v.opcao(d.canal, 'o canal', CANAIS);
  const x = await comIxc(db, at, cfg, async (ixc) => ({ lista: await ixc.faturasAbertas(at.cliente_id), cliente: await ixc.clientePorId(at.cliente_id) }));
  if (!x.ok) return x.resposta;
  const { lista, cliente } = x.valor;
  const fatura = d.fatura_id ? lista.find((f) => f.id === String(d.fatura_id)) : lista[0];
  if (!fatura) throw new ErroNegocio(d.fatura_id ? 'Fatura não encontrada entre as abertas deste cliente.' : 'O cliente não tem faturas em aberto.', 422);
  const destino = cliente && canaisDoCliente(cfg, cliente).find((c) => c.canal === canal);
  if (!destino) throw new ErroNegocio('Este canal não está disponível para este cliente (desligado na ZOE ou sem contato cadastrado no IXC).', 422);
  try {
    const ixc = ixcDa(cfg, at.uid);
    if (canal === 'email') await ixc.boleto(fatura.id, 'mail');
    else if (canal === 'sms') await ixc.boleto(fatura.id, 'sms');
    else {
      const arquivo = await ixc.boleto(fatura.id, 'arquivo');
      const pdf = typeof arquivo === 'string' ? arquivo : (arquivo?.base64 ?? arquivo?.arquivo ?? null);
      await enviarWhatsapp(cfg.whatsapp_webhook, {
        evento: 'zoe.boleto', empresa_id: empresa.id, uid: at.uid, telefone: destino._para, cliente_nome: at.cliente_nome,
        fatura: { id: fatura.id, vencimento: fatura.vencimento, valor_centavos: fatura.valor_centavos }, pdf_base64: pdf,
      });
    }
  } catch (err) {
    if (!(err instanceof ErroIxc)) throw err;
    acao(db, at, 'boleto', { canal, fatura_id: fatura.id, erro: err.message }, false);
    return transferirAgora(db, at, cfg, 'financeiro', 'Não consegui enviar o boleto agora. Vou transferir para o financeiro.');
  }
  acao(db, at, 'boleto', { canal, fatura_id: fatura.id, destino: destino.destino });
  return estado(db, at, `Pronto! Enviei o boleto e o PIX para o seu ${destino.destino}. Obrigada por ligar!`,
    { enviado: true, canal, destino: destino.destino, fatura: { id: fatura.id, vencimento: fatura.vencimento, valor_centavos: fatura.valor_centavos } });
}

async function enviarWhatsapp(url, corpo) {
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(5000) });
  } catch {
    throw new ErroIxc('O envio por WhatsApp não respondeu.');
  }
  if (!resp.ok) throw new ErroIxc(`O envio por WhatsApp respondeu com erro ${resp.status}.`);
}

const BLOQUEIO_POR_ATRASO = ['bloqueio_automatico', 'financeiro_em_atraso'];

async function desbloquear(db, empresa, uid) {
  const cfg = configAtiva(db, empresa);
  const at = carregar(db, empresa, uid);
  exigirMenu(at);
  if (!at.motivo) atualizar(db, at, { motivo: 'financeiro' });
  const negar = (motivo, fala) => {
    acao(db, at, 'desbloqueio', { motivo }, false);
    return estado(db, at, fala, { liberado: false, motivo });
  };
  if (!cfg.desbloqueio_ativo) return negar('desligado', 'O desbloqueio pelo telefone não está disponível. Para falar com o financeiro, tecle 0.');

  const x = await comIxc(db, at, cfg, (ixc) => ixc.contratos(at.cliente_id));
  if (!x.ok) return x.resposta;
  const ativos = x.valor.filter((c) => c.ativo);
  const contrato = ativos.find((c) => BLOQUEIO_POR_ATRASO.includes(c.acesso));
  if (!contrato) {
    if (ativos.some((c) => c.acesso === 'bloqueio_manual')) return negar('bloqueio_manual', 'Seu contrato tem um bloqueio que precisa de um atendente. Tecle 0 para falar com o financeiro.');
    if (ativos.some((c) => c.acesso === 'liberado')) return negar('ja_liberado', 'Seu acesso já está liberado. Se a internet não funciona, tecle 3 para o suporte técnico.');
    return negar('sem_contrato', 'Não encontrei um contrato que possa ser liberado por aqui. Tecle 0 para falar com um atendente.');
  }

  // Limite de desbloqueios por cliente no período (contados pela ZOE; o IXC também aplica as regras dele).
  const desde = new Date(Date.now() - cfg.desbloqueio_periodo_dias * 86_400_000).toISOString();
  const usados = db.prepare(`SELECT COUNT(*) AS n FROM zoe_acoes WHERE empresa_id = ? AND cliente_id = ? AND tipo = 'desbloqueio' AND sucesso = 1
    AND criado_em >= ?`).get(empresa.id, at.cliente_id, desde).n;
  if (usados >= cfg.desbloqueio_limite) {
    return negar('limite', 'Você já usou o desbloqueio de confiança neste período. Para segunda via do boleto, tecle 1. Para falar com o financeiro, tecle 0.');
  }

  let mensagem;
  try {
    mensagem = await ixcDa(cfg, at.uid).desbloqueioConfianca(contrato.id);
  } catch (err) {
    if (!(err instanceof ErroIxc)) throw err;
    // O IXC recusou (regra dele) ou não respondeu.
    acao(db, at, 'desbloqueio', { contrato_id: contrato.id, erro: err.message }, false);
    if (err.status || err.tempoEsgotado || /conex/i.test(err.message)) {
      return transferirAgora(db, at, cfg, 'financeiro', 'Não consegui liberar agora. Vou transferir para o financeiro.');
    }
    return estado(db, at, 'Não foi possível liberar seu acesso pelo telefone. Tecle 0 para falar com o financeiro.', { liberado: false, motivo: 'recusado_ixc', mensagem_ixc: err.message });
  }
  acao(db, at, 'desbloqueio', { contrato_id: contrato.id, mensagem_ixc: mensagem });
  return estado(db, at, 'Pronto! Liberei sua internet em confiança. Pode levar alguns minutos para voltar. Lembre de pagar a fatura para não bloquear de novo. '
    + 'Para receber o boleto agora, tecle 1.', { liberado: true, contrato_id: contrato.id });
}

async function transferir(db, empresa, uid, d) {
  const cfg = lerConfigZoe(db, empresa.id);
  const at = carregar(db, empresa, uid);
  if (at.etapa === 'encerrado') throw new ErroNegocio('Esta ligação já foi encerrada.', 409);
  const motivo = d.motivo === undefined ? 'outro' : v.opcao(d.motivo, 'o motivo', MOTIVOS);
  return transferirAgora(db, at, cfg, motivo, motivo === 'comercial'
    ? 'Vou transferir para o nosso time comercial. Aguarde um instante.'
    : undefined);
}

function encerrar(db, empresa, uid) {
  return transacao(db, () => {
    const at = carregar(db, empresa, uid);
    if (at.etapa === 'encerrado') return { uid: at.uid, etapa: at.etapa, resultado: at.resultado };
    let resultado = at.resultado;
    if (resultado === 'em_curso') {
      const resolveu = db.prepare(`SELECT 1 FROM zoe_acoes WHERE atendimento_id = ? AND sucesso = 1 AND tipo IN ('boleto','desbloqueio','faturas') LIMIT 1`).get(at.id);
      resultado = resolveu ? 'resolvido' : 'abandonado';
    }
    atualizar(db, at, { etapa: 'encerrado', resultado, fim: agora() });
    return { uid: at.uid, etapa: at.etapa, resultado };
  });
}

/** A config com os segredos já decifrados, para quem precisa chamar o IXC e o ZOE Atende. */
const configComSegredos = (db, empresaId) => {
  const c = lerConfigZoe(db, empresaId);
  return { ...c, alertas_chave: c.alertas_chave_cifrada ? decifrar(c.alertas_chave_cifrada) : null };
};

/** O cliente do IXC desta empresa, ou null quando a integração não está ligada. */
const ixcOuNulo = (cfg, uid) => { try { return ixcDa(cfg, uid); } catch { return null; } };

module.exports = {
  lerConfigZoe, configComSegredos, ixcDa, ixcOuNulo, configPublica, salvarConfig, testarIxc,
  iniciar, informarDocumento, confirmar, faturas, enviarBoleto, desbloquear, transferir, encerrar,
  falarValor, falarData, MOTIVOS, codigoConfere, MAX_TENTATIVAS_CONFIRMACAO,
};
