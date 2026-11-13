'use strict';

process.env.NODE_ENV = 'test';
process.env.ATEND_SECRET = process.env.ATEND_SECRET || 'segredo-de-teste-com-mais-de-32-caracteres';
process.env.ATEND_FUSO = process.env.ATEND_FUSO || 'America/Sao_Paulo';
process.env.ATEND_ARQUIVOS = process.env.ATEND_ARQUIVOS || require('node:path').join(require('node:os').tmpdir(), `atend-teste-${process.pid}`);

const crypto = require('node:crypto');
const { abrir, agora } = require('../server/db');
const empresas = require('../server/lib/empresas');
const claude = require('../server/ia/claude');

const APP_SECRET = 'segredo-do-app-de-teste';
const PHONE_ID = '123456789012345';
const TELEFONE_CLIENTE = '5511988887777';

/**
 * Ambiente pronto: uma empresa com número, filas, um atendente disponível e a atendente virtual ligada.
 * `semIa: true` deixa a empresa sem IA ligada (para testar o caminho das regras e do menu).
 */
function criarAmbiente({ comExemplos = false, iaAtiva = true, atendenteDisponivel = true, vinteQuatroHoras = true } = {}) {
  const db = abrir(':memory:');
  const empresa = empresas.criar(db, { nome: 'Fibra Mais', email: 'contato@fibramais.com.br' }, { comExemplos });
  const numero = empresas.salvarNumero(db, empresa.id, {
    nome: 'Principal', telefone: '1133334444', phone_number_id: PHONE_ID, token: 'EAAG-token-de-teste', app_secret: APP_SECRET,
  });
  const { usuario: atendente } = empresas.criarUsuario(db, empresa.id, { nome: 'Marina Souza', email: 'marina@fibramais.com.br', perfil: 'atendente', senha: 'senha12345' });
  const { usuario: admin } = empresas.criarUsuario(db, empresa.id, { nome: 'Carlos Lima', email: 'carlos@fibramais.com.br', perfil: 'cliente', senha: 'senha12345' });
  db.prepare('UPDATE usuarios SET disponivel = ? WHERE id = ?').run(atendenteDisponivel ? 1 : 0, atendente.id);
  db.prepare('UPDATE ia_config SET ativa = ? WHERE empresa_id = ?').run(iaAtiva ? 1 : 0, empresa.id);
  // Filas 24 h por padrão: assim o teste não depende da hora em que roda. O horário tem teste próprio.
  if (vinteQuatroHoras) db.prepare("UPDATE filas SET dias = '1111111', abre = '00:00', fecha = '23:59' WHERE empresa_id = ?").run(empresa.id);
  const filas = db.prepare('SELECT * FROM filas WHERE empresa_id = ? ORDER BY ordem').all(empresa.id);
  return { db, empresa, numero, atendente, admin, filas, master: db.prepare("SELECT * FROM usuarios WHERE perfil='master'").get() };
}

/** Artigo na base de conhecimento. */
const comConhecimento = (db, empresaId, titulo, resposta, perguntas = null) =>
  Number(db.prepare('INSERT INTO conhecimento (empresa_id, titulo, resposta, perguntas, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(empresaId, titulo, resposta, perguntas, agora()).lastInsertRowid);

// ---------- Dublê da Meta ----------

/**
 * Troca o fetch global por um dublê da Graph API. Devolve { enviadas, chamadas, restaurar }.
 * `enviadas` recebe { tipo, texto, para, corpo } de cada mensagem que a plataforma tentou mandar.
 */
function fingirMeta({ falharEm = () => null } = {}) {
  const original = global.fetch;
  const enviadas = [];
  const chamadas = [];
  let sequencia = 0;
  const config = require('../server/config');
  global.fetch = async (url, opcoes = {}) => {
    const endereco = String(url);
    // Só a Graph API é dublada: chamadas ao próprio servidor (nos testes de HTTP) seguem de verdade.
    if (!endereco.startsWith(config.whatsapp.graph) && !endereco.includes('exemplo/midia')) return original(url, opcoes);
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    chamadas.push({ url: endereco, metodo: opcoes.method ?? 'GET', corpo });
    const falha = falharEm({ url: endereco, corpo });
    if (falha) {
      return new Response(JSON.stringify({ error: { message: falha.mensagem ?? 'erro', code: falha.codigo ?? 131000 } }),
        { status: falha.status ?? 400, headers: { 'content-type': 'application/json' } });
    }
    if (endereco.includes('/messages')) {
      if (corpo?.status === 'read') return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      sequencia++;
      const waId = `wamid.saida.${sequencia}`;
      enviadas.push({ wa_id: waId, para: corpo.to, tipo: corpo.type, texto: corpo.text?.body ?? corpo.interactive?.body?.text ?? null, corpo });
      return new Response(JSON.stringify({ messages: [{ id: waId }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Consulta de mídia e do número.
    if (/\/\d+$|fields=/.test(endereco)) {
      return new Response(JSON.stringify({ url: 'https://exemplo/midia.bin', mime_type: 'image/jpeg', file_size: 1024, display_phone_number: '+55 11 3333-4444' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(Buffer.from('conteudo-binario'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  return { enviadas, chamadas, restaurar: () => { global.fetch = original; } };
}

// ---------- Dublê da Claude API ----------

/**
 * Dublê do cliente da Claude API. `roteiro` é uma lista de respostas, uma por chamada:
 *   { texto }                                  → o modelo só escreveu
 *   { ferramenta: 'nome', entrada: {...} }     → o modelo chamou uma ferramenta
 *   { recusa: 'cyber' }                        → recusa de política
 *   { erro: Error }                            → falha da API
 * Devolve { pedidos, restaurar }: `pedidos` guarda cada corpo enviado à API.
 */
function fingirClaude(roteiro) {
  const pedidos = [];
  let i = 0;
  const responder = async (corpo) => {
    pedidos.push(corpo);
    const passo = roteiro[Math.min(i, roteiro.length - 1)];
    i++;
    if (passo.erro) throw passo.erro;
    if (passo.recusa) {
      return { stop_reason: 'refusal', stop_details: { type: 'refusal', category: passo.recusa }, content: [], usage: { input_tokens: 10, output_tokens: 0 } };
    }
    if (passo.ferramenta) {
      return {
        stop_reason: 'tool_use',
        content: [
          ...(passo.texto ? [{ type: 'text', text: passo.texto }] : []),
          { type: 'tool_use', id: `tool_${i}`, name: passo.ferramenta, input: passo.entrada ?? {} },
        ],
        usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: i > 1 ? 100 : 0 },
      };
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: passo.texto ?? '' }], usage: { input_tokens: 120, output_tokens: 30 } };
  };
  claude.usarCliente({ messages: { create: responder }, beta: { messages: { create: responder } } });
  process.env.ATEND_IA_CHAVE = 'sk-ant-teste';
  require('../server/config').ia.chave = 'sk-ant-teste';
  return { pedidos, restaurar: () => { claude.usarCliente(null); require('../server/config').ia.chave = null; delete process.env.ATEND_IA_CHAVE; } };
}

/** Desliga a IA no servidor (sem chave): a atendente cai nas regras e no menu. */
function semIa() {
  const antes = require('../server/config').ia.chave;
  require('../server/config').ia.chave = null;
  return { restaurar: () => { require('../server/config').ia.chave = antes; } };
}

// ---------- Dublê do IXC ----------

const IXC_URL = 'https://ixc.provedor.teste';

/** Liga a integração com o IXC nesta empresa e devolve a configuração aplicada. */
function comIxc(db, empresaId, extra = {}) {
  const { cifrar } = require('../server/lib/cifra');
  const campos = {
    ativo: 1, url: IXC_URL, token_cifrado: cifrar('99:tokendeteste', 'ixc'), confirmar_por: 'cpf3',
    max_tentativas: 3, desbloqueio_ativo: 1, desbloqueio_limite: 1, desbloqueio_periodo_dias: 30, chamado_ativo: 1,
    ...extra,
  };
  const colunas = Object.keys(campos);
  db.prepare(`INSERT OR REPLACE INTO ixc_config (empresa_id, ${colunas.join(', ')}, atualizado_em)
    VALUES (?, ${colunas.map(() => '?').join(', ')}, ?)`).run(empresaId, ...colunas.map((k) => campos[k]), agora());
  return campos;
}

/**
 * Dublê da API do IXC. `dados` define o que a instância responde:
 *   { clientes: [...], contratos: [...], faturas: [...], logins: [...], chamados: [...] }
 * `falhar: true` faz toda chamada cair (para testar a degradação).
 * Devolve { chamadas, restaurar } — `chamadas` tem { recurso, corpo } de cada requisição.
 */
function fingirIxc(dados = {}, { falhar = false, demorar = false } = {}) {
  const original = global.fetch;
  const chamadas = [];
  const registros = (lista) => new Response(JSON.stringify({ page: '1', total: lista.length, registros: lista }),
    { status: 200, headers: { 'content-type': 'application/json' } });

  global.fetch = async (url, opcoes = {}) => {
    const endereco = String(url);
    if (!endereco.startsWith(IXC_URL)) return original(url, opcoes);
    const recurso = endereco.split('/webservice/v1/')[1];
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : {};
    chamadas.push({ recurso, corpo });
    if (falhar) throw new TypeError('fetch failed');
    if (demorar) { const e = new Error('tempo'); e.name = 'TimeoutError'; throw e; }

    const lista = (chave) => dados[chave] ?? [];
    const filtrar = (itens, campo) => {
      const alvo = String(corpo.query ?? '');
      if (corpo.oper === 'L') return itens.filter((x) => String(x[campo] ?? '').replace(/\D/g, '').includes(alvo.replace(/\D/g, '')));
      if (corpo.oper === '>') return itens;
      return itens.filter((x) => String(x[campo] ?? '') === alvo || String(x[campo] ?? '').replace(/\D/g, '') === alvo.replace(/\D/g, ''));
    };

    switch (recurso) {
      case 'cliente': {
        const campo = String(corpo.qtype ?? '').split('.')[1] ?? 'id';
        return registros(filtrar(lista('clientes'), campo));
      }
      case 'cliente_contrato': return registros(filtrar(lista('contratos'), String(corpo.qtype ?? '').split('.')[1] ?? 'id'));
      case 'fn_areceber': return registros(filtrar(lista('faturas'), String(corpo.qtype ?? '').split('.')[1] ?? 'id'));
      case 'radusuarios': return registros(filtrar(lista('logins'), String(corpo.qtype ?? '').split('.')[1] ?? 'id'));
      case 'su_oss_chamado':
        // Sem qtype é abertura de chamado; com qtype é consulta.
        if (!corpo.qtype) return new Response(JSON.stringify({ type: 'success', id: 9001, protocolo: '2026110001', mensagem: 'Chamado aberto com sucesso.' }),
          { status: 200, headers: { 'content-type': 'application/json' } });
        return registros(filtrar(lista('chamados'), String(corpo.qtype ?? '').split('.')[1] ?? 'id'));
      case 'su_oss_assunto': return registros(lista('assuntos'));
      case 'get_boleto':
        return new Response(JSON.stringify({ base64: Buffer.from('%PDF-1.4 boleto de teste'.repeat(10)).toString('base64'), linha_digitavel: '34191790010104351004791020150008291070026000' }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      case 'desbloqueio_confianca':
        return new Response(JSON.stringify({ type: 'success', mensagem: 'Desbloqueio de confiança liberado por 3 dias.' }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      default:
        return new Response(JSON.stringify({ type: 'error', message: `recurso ${recurso} não existe nesta instância` }),
          { status: 200, headers: { 'content-type': 'application/json' } });
    }
  };
  return { chamadas, restaurar: () => { global.fetch = original; } };
}

/** Cadastro de exemplo coerente: cliente, contrato bloqueado por atraso, fatura vencida e login offline. */
const CADASTRO = {
  clientes: [{ id: '501', razao: 'Ana Clara Ribeiro', cnpj_cpf: '123.456.789-09', data_nascimento: '1990-03-05', ativo: 'S',
    telefone_celular: '(11) 98888-7777', fone: '', whatsapp: '', email: 'ana@exemplo.com.br' }],
  contratos: [{ id: '77', id_cliente: '501', contrato: 'Fibra 600 Mega', status: 'A', status_internet: 'CA', endereco: 'Rua das Flores', numero: '100', bairro: 'Centro', cidade: 'São Paulo' }],
  faturas: [{ id: '9001', id_cliente: '501', id_contrato: '77', status: 'A', data_vencimento: '2026-10-10', valor_aberto: '129.90' },
    { id: '9002', id_cliente: '501', id_contrato: '77', status: 'A', data_vencimento: '2026-11-10', valor_aberto: '129.90' }],
  logins: [{ id: '301', id_cliente: '501', id_contrato: '77', login: 'ana.ribeiro', online: 'N', ip: '', ultima_conexao_inicial: '2026-11-12 22:14:00' }],
  chamados: [],
  assuntos: [{ id: '4', assunto: 'Sem conexão', ativo: 'S' }],
};

// ---------- Webhook ----------

/** Monta o corpo de um webhook de mensagem recebida, igual ao da Meta. */
function corpoWebhook(mensagens, { phoneId = PHONE_ID, nomePerfil = 'Cliente Teste', telefone = TELEFONE_CLIENTE, statuses = null } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '551133334444', phone_number_id: phoneId },
          ...(nomePerfil ? { contacts: [{ profile: { name: nomePerfil }, wa_id: telefone }] } : {}),
          ...(mensagens ? { messages: [].concat(mensagens).map((m) => ({ from: telefone, timestamp: String(Math.floor(Date.now() / 1000)), ...m })) } : {}),
          ...(statuses ? { statuses } : {}),
        },
      }],
    }],
  };
}

const mensagemTexto = (texto, id = `wamid.${crypto.randomBytes(6).toString('hex')}`) => ({ id, type: 'text', text: { body: texto } });

const assinar = (corpo, segredo = APP_SECRET) => `sha256=${crypto.createHmac('sha256', segredo).update(Buffer.from(JSON.stringify(corpo))).digest('hex')}`;

/** Chama o webhook pela própria função de recepção (sem HTTP), já com os números do ambiente. */
function entregar(db, corpo) {
  const recepcao = require('../server/lib/recepcao');
  return recepcao.processar(db, corpo, {
    numeroPorPhoneId: (id) => {
      const numero = db.prepare('SELECT * FROM numeros WHERE phone_number_id = ?').get(String(id));
      if (!numero) return null;
      const empresa = db.prepare("SELECT * FROM empresas WHERE id = ? AND status = 'ativa'").get(numero.empresa_id);
      return empresa && numero.ativo ? { numero, empresa } : null;
    },
  });
}

/** Entrega a mensagem e espera a fila de envio esvaziar. */
async function conversar(db, texto, opcoes = {}) {
  const r = await entregar(db, corpoWebhook(mensagemTexto(texto), opcoes));
  await require('../server/lib/envio').processarFila(db);
  return r;
}

const conversaDoCliente = (db, telefone = TELEFONE_CLIENTE) =>
  db.prepare('SELECT c.* FROM conversas c JOIN contatos ct ON ct.id = c.contato_id WHERE ct.telefone = ? ORDER BY c.id DESC LIMIT 1').get(telefone);

const mensagensDe = (db, conversaId) =>
  db.prepare('SELECT direcao, autor, tipo, texto, status FROM mensagens WHERE conversa_id = ? ORDER BY id').all(conversaId);

module.exports = {
  APP_SECRET, PHONE_ID, TELEFONE_CLIENTE, IXC_URL, CADASTRO,
  criarAmbiente, comConhecimento, fingirMeta, fingirClaude, semIa, comIxc, fingirIxc,
  corpoWebhook, mensagemTexto, assinar, entregar, conversar, conversaDoCliente, mensagensDe,
};
