'use strict';

const { agora } = require('../db');
const filas = require('../lib/filas');
const ixc = require('./ferramentas-ixc');
const conhecimento = require('./conhecimento');
const { normalizar } = require('./regras');

/**
 * Fluxos prontos: os processos que se repetem todo dia (2ª via, "já paguei", internet lenta,
 * pergunta da base) resolvidos em código, sem IA — zero token, resposta em 1-2 s e sempre igual.
 *
 * Cada passo chama AS MESMAS ferramentas do IXC que a IA usaria, então o portão de identidade, os
 * limites de tentativa e a auditoria valem igual. Quando a conversa sai do trilho (o cliente
 * escreve outra coisa, algo falha de um jeito não previsto), o fluxo larga e a IA assume com o
 * histórico — ou, se não houver IA, segue o caminho normal das regras.
 */

// Textos padrão. A empresa troca qualquer um em "ZOE › Como ela atende › Fluxos prontos".
const TEXTOS = {
  pedir_documento: 'Claro! Para localizar sua conta, me informa o CPF ou CNPJ do titular, por favor.',
  documento_invalido: 'Não consegui ler um CPF ou CNPJ válido. Pode me mandar de novo, só os números?',
  nao_encontrado: 'Não encontrei cliente ativo com esse CPF/CNPJ. Confere e me manda de novo, por favor?',
  confirmar_titular: 'A conta está em nome de {titular}. Está correto?',
  responder_sim_nao: 'É só me responder *sim* ou *não*, por favor.',
  outro_titular: 'Sem problema. Me manda o CPF ou CNPJ de quem é o titular da conta?',
  segunda_via_enviada: 'Pronto! Te mandei a 2ª via aqui. Precisa de mais alguma coisa?',
  sem_fatura: 'Não encontrei nenhuma fatura em aberto na sua conta. Posso ajudar com mais alguma coisa?',
  desbloqueio_feito: 'Prontinho, liberei o seu acesso! Pode levar alguns minutos para voltar. Se não voltar em 10 minutos, '
    + 'desligue o roteador da tomada por 30 segundos e ligue de novo. Lembrando que a fatura continua em aberto.',
  acesso_liberado: 'Verifiquei aqui: a sua conta não tem bloqueio, o acesso está liberado.',
  bloqueado_fatura: 'Verifiquei aqui: o seu acesso está bloqueado por fatura em aberto. Te mandei a 2ª via acima; '
    + 'assim que o pagamento cair, o acesso volta sozinho. Se você já pagou, me responda *já paguei*.',
  conexao_online: 'Verifiquei aqui: o seu equipamento está conectado. Tenta isto, que resolve a maioria dos casos:\n'
    + '1) desligue o roteador da tomada por 30 segundos e ligue de novo;\n2) teste com o aparelho ligado no cabo, não pelo Wi-Fi;\n'
    + '3) veja quantos aparelhos estão usando a internet.\nSe continuar, me responda *continua* que eu abro um chamado técnico.',
  conexao_offline: 'Verifiquei aqui: o seu equipamento está *desconectado* da nossa rede. Confere se o roteador está ligado na tomada '
    + 'e se a luz da fibra está normal (sem luz vermelha). Se continuar sem internet, me responda *continua* que eu abro um chamado técnico.',
  chamado_aberto: 'Abri um chamado técnico para você. Protocolo: *{protocolo}*. O nosso time técnico vai entrar em contato. '
    + 'Precisa de mais alguma coisa?',
  resolvido: 'Que bom! Precisa de mais alguma coisa?',
};
const ROTULOS = {
  pedir_documento: 'Pedir o CPF/CNPJ', documento_invalido: 'CPF/CNPJ inválido', nao_encontrado: 'Cliente não encontrado',
  confirmar_titular: 'Confirmar o titular ({titular})', responder_sim_nao: 'Resposta que não é sim nem não', outro_titular: 'Titular errado',
  segunda_via_enviada: '2ª via enviada', sem_fatura: 'Sem fatura em aberto', desbloqueio_feito: 'Desbloqueio feito',
  acesso_liberado: 'Conta sem bloqueio', bloqueado_fatura: 'Bloqueado por fatura (manda a 2ª via)', conexao_online: 'Equipamento conectado (passo a passo)', conexao_offline: 'Equipamento desconectado',
  chamado_aberto: 'Chamado aberto ({protocolo})', resolvido: 'Cliente disse que resolveu',
};

// O que dispara cada fluxo (texto já sem acento e em minúsculas). A ordem importa: "paguei o boleto
// e não voltou" é desbloqueio, não 2ª via.
const GATILHOS = [
  ['desbloqueio', /\b(ja paguei|paguei|desbloque\w*|liberar (a |o |minha |meu )?(internet|conexao|acesso|sinal)|bloquead\w*|cortad\w*|cortaram)\b/],
  ['segunda_via', /\b(boleto|boletos|segunda via|2a via|2 via|fatura|faturas|pix|codigo de barras|linha digitavel|conta para pagar|conta pra pagar)\b/],
  ['conexao', /\b(lent\w*|sem internet|sem conexao|sem sinal|caiu|caindo|cai toda hora|nao (esta |ta )?(funcionando|conectando|navegando|pegando)|internet ruim|oscilando|instavel)\b/],
];
const BOTOES = { segunda_via: 'segunda_via', ja_paguei: 'desbloqueio' };
// As ferramentas de que cada fluxo precisa (a sonda pode ter desligado alguma nesta instância).
const PRECISA = {
  segunda_via: ['identificar_cliente', 'confirmar_identidade', 'enviar_segunda_via'],
  desbloqueio: ['identificar_cliente', 'confirmar_identidade', 'situacao_do_contrato', 'desbloqueio_de_confianca'],
  conexao: ['identificar_cliente', 'confirmar_identidade', 'situacao_do_contrato', 'diagnostico_de_conexao'],
};
const SIM = /^\s*(sim|s|isso|isso mesmo|e isso|correto|certo|exato|confirmo|positivo|ok|okay|e|e sim|esta|ta|perfeito|pode ser|yes)\b/;
const NAO = /\b(nao|errado|incorreto|outro nome|n)\b/;
const CONTINUA = /\b(continua|continuou|nao resolveu|nao voltou|nao funcionou|ainda nao|nada|piorou|mesma coisa|nao deu)\b/;
const VOLTOU = /\b(voltou|resolveu|funcionou|deu certo|normalizou|ja esta|ja ta|obrigad\w*|valeu)\b/;
const EXPIRA_MS = 30 * 60_000;

function textosDa(cfg) {
  let proprios = {};
  try { proprios = cfg?.textos_fluxo ? JSON.parse(cfg.textos_fluxo) : {}; } catch { proprios = {}; }
  const t = { ...TEXTOS };
  for (const [k, v] of Object.entries(proprios)) if (k in TEXTOS && String(v ?? '').trim()) t[k] = String(v).trim();
  return t;
}
const preencher = (texto, dados) => texto.replace(/\{(\w+)\}/g, (m, k) => (dados[k] !== undefined && dados[k] !== null ? String(dados[k]) : m));

/** CPF (11) ou CNPJ (14) escrito em qualquer formato no meio do texto. */
function extrairDocumento(texto) {
  const candidatos = String(texto ?? '').match(/\d[\d.\-/\s]{9,20}\d/g) ?? [];
  for (const c of candidatos) {
    const d = c.replace(/\D/g, '');
    if (d.length === 11 || d.length === 14) return d;
  }
  return null;
}

const lerEstado = (conversa) => {
  try {
    const e = conversa.fluxo ? JSON.parse(conversa.fluxo) : null;
    return e && Date.now() - Date.parse(e.em) < EXPIRA_MS ? e : null;
  } catch { return null; }
};
const gravar = (db, conversa, estado) => {
  db.prepare('UPDATE conversas SET fluxo = ? WHERE id = ?').run(estado ? JSON.stringify({ ...estado, em: agora() }) : null, conversa.id);
};

/** O fluxo que esta mensagem dispara, se algum. */
function gatilho(texto, idResposta) {
  const botao = /^zoe:(\w+):/.exec(String(idResposta ?? ''))?.[1];
  if (botao && BOTOES[botao]) return BOTOES[botao];
  const t = normalizar(texto);
  return GATILHOS.find(([, re]) => re.test(t))?.[0] ?? null;
}

/**
 * Conduz a mensagem por um fluxo pronto. Devolve o resultado (como o atender) ou null para seguir
 * o caminho normal (regras e IA). `ajuda`: as funções do atendente (responder, transferir, registrar).
 */
async function conduzir(db, { empresa, conversa, contato, texto, idResposta, cfg, ajuda }) {
  if (cfg?.fluxos_ativos === 0 || conversa.canal === 'telefone') return null;
  const t = textosDa(cfg);
  const responder = (chave, dados = {}) => ajuda.responder(db, conversa, preencher(t[chave], dados));
  const evento = (nome, detalhe = 'sem IA') => ajuda.registrarEvento(db, conversa, { tipo: 'intencao', nome: `fluxo: ${nome}`, detalhe });
  const atual = () => db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);
  const usar = async (nome, entrada = {}) => {
    const r = await ixc.executar(ixc.FERRAMENTAS[nome], { db, empresa, conversa: atual(), contato, entrada });
    ajuda.registrarEvento(db, conversa, { tipo: 'ferramenta', nome, detalhe: JSON.stringify({ entrada, resultado: r }).slice(0, 1000) });
    return r;
  };
  const cfgIxc = ixc.lerConfig(db, empresa.id);
  const transferir = (motivo, { tecnico = false } = {}) => {
    gravar(db, conversa, null);
    const filaId = tecnico ? cfgIxc?.fila_tecnica_id : cfgIxc?.fila_financeira_id;
    try {
      const r = ajuda.transferir(db, conversa, {
        fila: filaId ? filas.buscar(db, empresa.id, filaId) : undefined,
        motivo, resumo: `O cliente escreveu: "${String(estadoInicial?.pedido ?? texto).slice(0, 300)}". ${motivo}`,
        lacuna: { categoria: 'sistema_falhou' },
      });
      return { acao: 'transferida', detalhe: r?.fila?.nome ?? 'fila' };
    } catch {
      // Empresa sem fila cadastrada: a IA (ou as regras) seguem com o cliente.
      return null;
    }
  };
  const fim = (detalhe) => { gravar(db, conversa, null); return { acao: 'respondeu', detalhe: `fluxo: ${detalhe}` }; };
  const largar = (porque) => { evento('largou para a IA', porque); gravar(db, conversa, null); return null; };

  let estado = lerEstado(conversa);
  const estadoInicial = estado;

  // ---------- Começo ----------
  if (!estado) {
    const nome = gatilho(texto, idResposta);
    const kit = ixc.configurado(db, empresa.id) ? ixc.montar(db, empresa.id).porNome : new Map();
    const pronto = nome && ixc.metodoConfirmacao(db, empresa.id) === 'titular_pendente' && PRECISA[nome].every((f) => kit.has(f));
    if (!pronto) return perguntaDaBase(db, { empresa, conversa, texto, ajuda, evento });
    const pagou = /^zoe:ja_paguei:/.test(String(idResposta ?? '')) || /\b(paguei|ja paguei|pago|vou pagar|pagarei|ja foi pago)\b/.test(normalizar(texto));
    estado = { nome, etapa: 'documento', falhas: 0, pagou, pedido: String(texto ?? '').slice(0, 300) };
    evento(nome, 'começou');
    if (atual().identidade_confirmada) return executar(estado);
    const doc = extrairDocumento(texto);
    if (doc) return receberDocumento(doc);
    gravar(db, conversa, estado);
    responder('pedir_documento');
    return { acao: 'respondeu', detalhe: `fluxo: ${nome} (pediu o documento)` };
  }

  // ---------- Etapas ----------
  const norm = normalizar(texto);
  if (estado.etapa === 'documento') {
    const doc = extrairDocumento(texto);
    if (doc) return receberDocumento(doc);
    if (++estado.falhas >= 2) return largar('o cliente não mandou um CPF/CNPJ');
    gravar(db, conversa, estado);
    responder('documento_invalido');
    return { acao: 'respondeu', detalhe: 'fluxo: documento inválido' };
  }
  if (estado.etapa === 'confirmar') {
    const nao = NAO.test(norm);
    const sim = SIM.test(norm) && !nao;
    if (!sim && !nao) {
      if (++estado.falhas >= 2) return largar('não respondeu sim ou não');
      gravar(db, conversa, estado);
      responder('responder_sim_nao');
      return { acao: 'respondeu', detalhe: 'fluxo: pediu sim ou não' };
    }
    const r = await usar('confirmar_identidade', { resposta: sim ? 'sim' : 'não' });
    if (r.confere || r.ja_confirmada) return executar(estado);
    if (r.bloqueado || /transferir/.test(r.instrucao ?? '')) return transferir(r.erro ?? 'Não foi possível confirmar o titular.');
    estado = { ...estado, etapa: 'documento', falhas: 0 };
    gravar(db, conversa, estado);
    responder('outro_titular');
    return { acao: 'respondeu', detalhe: 'fluxo: titular errado' };
  }
  if (estado.etapa === 'conexao_retorno') {
    if (CONTINUA.test(norm)) return abrirChamado(estado);
    if (VOLTOU.test(norm) || SIM.test(norm)) { responder('resolvido'); return fim('conexão resolvida'); }
    return largar('resposta fora do trilho depois do passo a passo');
  }
  return largar(`etapa desconhecida ${estado.etapa}`);

  // ---------- Passos ----------
  async function receberDocumento(doc) {
    const r = await usar('identificar_cliente', { documento: doc });
    if (r.ok && r.encontrou && r.pode_confirmar) {
      estado = { ...estado, etapa: 'confirmar', falhas: 0 };
      gravar(db, conversa, estado);
      responder('confirmar_titular', { titular: r.titular ?? 'titular' });
      return { acao: 'respondeu', detalhe: 'fluxo: confirmar titular' };
    }
    if (r.bloqueado) return transferir(r.erro);
    if (r.encontrou === false || /inválido/i.test(r.erro ?? '')) {
      if (++estado.falhas >= 3) return transferir('O cliente não conseguiu informar um CPF/CNPJ que esteja no cadastro.');
      gravar(db, conversa, { ...estado, etapa: 'documento' });
      responder(r.encontrou === false ? 'nao_encontrado' : 'documento_invalido');
      return { acao: 'respondeu', detalhe: 'fluxo: documento não encontrado' };
    }
    return transferir(r.erro ?? 'Não consegui identificar o cliente no sistema do provedor.');
  }

  async function executar(e) {
    if (e.nome === 'segunda_via') {
      const r = await usar('enviar_segunda_via', { fatura_id: null });
      if (r.enviado) { responder('segunda_via_enviada'); return fim('2ª via enviada'); }
      if (r.ok && r.quantidade === 0) { responder('sem_fatura'); return fim('sem fatura'); }
      return transferir(r.erro ?? 'Não consegui gerar a 2ª via.');
    }
    // "Já paguei" e "internet": antes de tudo, o contrato — bloqueio financeiro é a causa mais comum.
    const s = await usar('situacao_do_contrato');
    if (!s.ok) return transferir(s.erro ?? 'Não consegui consultar o contrato.', { tecnico: e.nome === 'conexao' });
    const acessos = (s.contratos ?? []).map((c) => c.acesso);
    if (acessos.includes('bloqueio_manual')) return transferir('O acesso está com bloqueio manual do provedor.');
    const bloqueado = acessos.some((a) => ['bloqueio_automatico', 'financeiro_em_atraso'].includes(a));
    if (bloqueado && e.pagou) {
      // Desbloqueio de confiança só quando o cliente diz que pagou (ou tocou em "Já paguei").
      const d = await usar('desbloqueio_de_confianca', { contrato_id: null, motivo: e.pedido || 'cliente informou que pagou' });
      if (d.liberado) { responder('desbloqueio_feito'); return fim('desbloqueio'); }
      return transferir(d.erro ?? 'Não foi possível fazer o desbloqueio de confiança.');
    }
    if (bloqueado) {
      // Reclamou da internet, mas o motivo é fatura: manda a 2ª via e explica como liberar.
      const r = await usar('enviar_segunda_via', { fatura_id: null });
      if (!r.enviado) return transferir('O acesso está bloqueado por financeiro e não consegui enviar a 2ª via.');
      responder('bloqueado_fatura');
      return fim('bloqueado por fatura (2ª via enviada)');
    }
    if (e.nome === 'desbloqueio') {
      // Sem bloqueio: o problema é de conexão. Avisa e já confere o equipamento.
      responder('acesso_liberado');
    }
    const d = await usar('diagnostico_de_conexao');
    if (!d.ok) return transferir(d.erro ?? 'Não consegui consultar a conexão.', { tecnico: true });
    if (d.encontrou === false) return transferir('O cadastro não tem login de conexão para verificar.', { tecnico: true });
    const online = Boolean(d.online_agora);
    gravar(db, conversa, { ...e, etapa: 'conexao_retorno', falhas: 0, online });
    responder(online ? 'conexao_online' : 'conexao_offline');
    return { acao: 'respondeu', detalhe: `fluxo: conexão ${online ? 'online' : 'offline'}` };
  }

  async function abrirChamado(e) {
    const kit = ixc.montar(db, empresa.id).porNome;
    if (!kit.has('abrir_chamado_tecnico')) return transferir('O cliente continua sem conexão depois do passo a passo.', { tecnico: true });
    const c = await usar('abrir_chamado_tecnico', {
      titulo: e.online === false ? 'Cliente sem conexão' : 'Cliente com lentidão / instabilidade',
      relato: `Cliente relatou: "${e.pedido}". Equipamento ${e.online === false ? 'DESCONECTADO' : 'conectado'} na consulta da ZOE. `
        + 'Recebeu o passo a passo (reiniciar o roteador, testar no cabo) e disse que continua.',
    });
    if (c.ok) { responder('chamado_aberto', { protocolo: c.protocolo ?? '—' }); return fim('chamado aberto'); }
    return transferir(c.erro ?? 'Não consegui abrir o chamado técnico.', { tecnico: true });
  }
}

/** Pergunta que bate forte com UM artigo da base: responde com o texto do artigo, sem IA. */
function perguntaDaBase(db, { empresa, conversa, texto, ajuda, evento }) {
  if (!texto || texto.length > 200) return null;
  const achados = conhecimento.buscar(db, empresa.id, texto, { limite: 2, minimo: 3 });
  const [melhor, segundo] = achados;
  if (!melhor || (segundo && segundo.pontos >= melhor.pontos * 0.75)) return null;
  conhecimento.registrarUso(db, melhor.id);
  ajuda.registrarEvento(db, conversa, { tipo: 'conhecimento', nome: melhor.titulo, detalhe: `${melhor.pontos} ponto(s), sem IA` });
  void evento;
  ajuda.responder(db, conversa, melhor.resposta);
  return { acao: 'respondeu', detalhe: `fluxo: base (${melhor.titulo})` };
}

module.exports = { conduzir, TEXTOS, ROTULOS, extrairDocumento, gatilho };
