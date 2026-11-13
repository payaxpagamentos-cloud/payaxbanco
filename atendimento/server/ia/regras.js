'use strict';

/**
 * Camada determinística da ZOE. Roda antes da IA e resolve o que não precisa de modelo:
 * saudação, pedido explícito de falar com uma pessoa, intenções por palavra-chave cadastradas pela empresa
 * e o menu de departamentos. É barata, previsível e fica registrada em `ia_eventos` como 'intencao'.
 */

/** Texto comparável: sem acento, sem maiúscula, sem pontuação e com espaço simples. */
const normalizar = (t) => String(t ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// O cliente está pedindo uma pessoa. Nesse caso a IA não insiste: transfere na hora.
const PEDE_HUMANO = [
  'atendente', 'atendente humano', 'falar com atendente', 'quero um atendente', 'me transfere', 'transferir',
  'falar com alguem', 'falar com uma pessoa', 'falar com humano', 'humano', 'pessoa de verdade', 'gente de verdade',
  'uma pessoa', 'com alguem', 'quero alguem', 'pessoa real', 'ser humano',
  'nao quero falar com robo', 'nao quero robo', 'sair do robo', 'chama alguem', 'chamar alguem',
  'preciso de ajuda de verdade', 'quero falar com o suporte', 'me liga', 'supervisor', 'reclamacao', 'reclamar',
  'cancelar contrato', 'cancelamento', 'procon', 'advogado',
];
// Encerramento pedido pelo cliente.
const DESPEDIDA = ['obrigado', 'obrigada', 'obg', 'vlw', 'valeu', 'era so isso', 'so isso', 'tchau', 'ate logo', 'resolvido', 'ja resolvi', 'nada mais'];
// Cumprimento sem pergunta: responde a saudação e espera o pedido.
const CUMPRIMENTO = ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'opa', 'eai', 'e ai', 'oii', 'alo', 'hey', 'oi tudo bem', 'ola tudo bem'];

const contem = (texto, termo) => {
  const t = ` ${texto} `;
  const alvo = ` ${normalizar(termo)} `;
  return alvo.trim() !== '' && t.includes(alvo);
};

/** O cliente pediu explicitamente para falar com uma pessoa? Devolve o termo que casou. */
function pedidoDeHumano(texto) {
  const t = normalizar(texto);
  if (!t) return null;
  // Do termo mais específico para o mais genérico, para o motivo sair bonito no painel.
  return [...PEDE_HUMANO].sort((a, b) => b.length - a.length).find((p) => contem(t, p)) ?? null;
}

// Palavras que acompanham o pedido de uma pessoa sem dizer o assunto ("quero falar com um
// atendente agora, por favor").
const SO_PEDIDO = new Set(('quero queria preciso gostaria pode poderia falar com um uma o a de da do me por favor pf pfv agora '
  + 'urgente rapido ja logo sim oi ola alo bom dia boa tarde noite moca moco amigo senhor senhora '
  + 'atendente atendimento humano pessoa alguem gente verdade real robo bot nao passa passar transfere transferir '
  + 'chama chamar ajuda ajudar suporte').split(' '));

/**
 * O cliente pediu uma pessoa E disse o assunto? ("quero falar com um atendente sobre a minha
 * fatura" tem assunto; "atendente, por favor" não tem.) Com assunto, a ZOE tenta resolver primeiro.
 */
function temAssuntoAlemDoPedido(texto) {
  const resto = normalizar(texto).split(' ').filter((p) => p.length >= 3 && !SO_PEDIDO.has(p));
  return resto.length >= 1 && resto.join('').length >= 4;
}

/**
 * Assuntos que são de OUVIDORIA, não de atendimento comum: viram caso com protocolo e prazo.
 * Do mais específico para o mais genérico — "quero cancelar" é cancelamento, não reclamação.
 */
const OUVIDORIA = [
  ['anatel', ['anatel', 'agencia nacional de telecomunicacoes']],
  ['procon', ['procon', 'advogado', 'processar', 'processo judicial', 'juizado', 'acao judicial', 'consumidor gov', 'reclame aqui']],
  ['cancelamento', ['cancelar', 'cancelamento', 'quero cancelar', 'encerrar contrato', 'rescisao', 'rescindir', 'desligar o servico',
    'tirar a internet', 'vou trocar de provedor', 'mudar de provedor', 'nao quero mais']],
  ['reclamacao', ['reclamacao', 'reclamar', 'quero reclamar', 'fazer uma reclamacao', 'registrar uma reclamacao', 'esta um absurdo',
    'descaso', 'pessimo atendimento', 'pessimo servico']],
  ['elogio', ['quero elogiar', 'fazer um elogio', 'parabenizar']],
  ['sugestao', ['tenho uma sugestao', 'quero sugerir', 'sugestao de melhoria']],
];

// O cliente falou em ir embora — numa reclamação ou no Procon também. Leva o caso para a retenção.
const SAIDA = ['cancelar', 'cancelamento', 'trocar de provedor', 'mudar de provedor', 'outro provedor', 'outra operadora',
  'vou sair', 'nao quero mais', 'rescindir', 'rescisao', 'concorrente', 'vou embora da', 'tirar a internet'];
const ameacaDeSaida = (texto) => { const t = normalizar(texto); return Boolean(t) && SAIDA.some((x) => contem(t, x)); };

// Pistas do motivo, pelas palavras do cliente. Na dúvida, fica sem motivo e a equipe preenche.
const PISTAS_MOTIVO = [
  ['mudanca', ['vou me mudar', 'mudar de cidade', 'mudar de endereco', 'mudando de casa', 'mudei de casa', 'vou mudar']],
  ['concorrente', ['concorrente', 'outro provedor', 'outra operadora', 'oferta melhor', 'mais barato em outro', 'vivo fibra', 'claro net', 'oi fibra']],
  ['preco', ['caro', 'muito caro', 'preco', 'valor alto', 'reajuste', 'aumentou']],
  ['qualidade', ['lenta', 'lento', 'caindo', 'cai toda', 'sem internet', 'instavel', 'nao funciona', 'oscilando', 'travando']],
  ['financeiro', ['nao consigo pagar', 'desempregado', 'sem dinheiro', 'apertado', 'dificuldade financeira']],
  ['atendimento', ['pessimo atendimento', 'ninguem resolve', 'descaso', 'atendimento ruim']],
  ['sem_uso', ['nao uso mais', 'nao estou usando', 'nao preciso mais']],
];
function motivoDeSaida(texto) {
  const t = normalizar(texto);
  return PISTAS_MOTIVO.find(([, termos]) => termos.some((x) => contem(t, x)))?.[0] ?? null;
}

/** O que o cliente escreveu é assunto de ouvidoria? Devolve { tipo, termo } ou null. */
function assuntoDeOuvidoria(texto) {
  const t = normalizar(texto);
  if (!t) return null;
  for (const [tipo, termos] of OUVIDORIA) {
    const achado = [...termos].sort((a, b) => b.length - a.length).find((termo) => contem(t, termo));
    if (achado) return { tipo, termo: achado };
  }
  return null;
}

const ehCumprimento = (texto) => { const t = normalizar(texto); return Boolean(t) && CUMPRIMENTO.includes(t); };
const ehDespedida = (texto) => { const t = normalizar(texto); return Boolean(t) && DESPEDIDA.some((d) => t === d || contem(t, d)) && t.split(' ').length <= 5; };

/**
 * Procura a intenção cadastrada que casa com a mensagem. Ganha a que tem o termo mais longo
 * (mais específico), respeitando a ordem definida pela empresa em caso de empate.
 */
function casarIntencao(intencoes, texto) {
  const t = normalizar(texto);
  if (!t) return null;
  let melhor = null;
  for (const i of intencoes) {
    if (!i.ativa) continue;
    for (const palavra of String(i.palavras ?? '').split(/[\n;]/).map((x) => x.trim()).filter(Boolean)) {
      if (!contem(t, palavra)) continue;
      const peso = normalizar(palavra).length;
      if (!melhor || peso > melhor.peso) melhor = { intencao: i, termo: palavra, peso };
    }
  }
  return melhor;
}

/** Saudação da empresa, com o nome do cliente quando a gente sabe. */
function saudacao(cfg, { nomeAssistente = 'ZOE', nomeEmpresa = '', nomeCliente = null } = {}) {
  const base = cfg?.saudacao?.trim();
  if (base) return preencher(base, { assistente: nomeAssistente, empresa: nomeEmpresa, cliente: nomeCliente ?? '' });
  const ola = nomeCliente ? `Olá, ${primeiroNome(nomeCliente)}!` : 'Olá!';
  return `${ola} Eu sou a ${nomeAssistente}${nomeEmpresa ? `, atendente virtual da ${nomeEmpresa}` : ''}. Como posso ajudar?`;
}

const primeiroNome = (n) => String(n ?? '').trim().split(/\s+/)[0] ?? '';

/** Troca {cliente}, {empresa}, {assistente}, {protocolo} e {fila} nas mensagens configuradas. */
const preencher = (texto, valores) => String(texto ?? '').replace(/\{(\w+)\}/g, (todo, k) => (valores[k] !== undefined && valores[k] !== null ? String(valores[k]) : todo));

/**
 * Menu de departamentos: usado quando a IA está desligada ou indisponível.
 * Até 3 filas vira botões; mais que isso, vira lista.
 */
function menu(filas, { titulo = 'Com qual time você quer falar?' } = {}) {
  const itens = filas.slice(0, 10).map((f) => ({ id: `fila:${f.id}`, titulo: f.nome.slice(0, 24), descricao: f.descricao ?? null }));
  if (!itens.length) return null;
  if (itens.length <= 3) return { tipo: 'botao', corpo: titulo, opcoes: itens.map((i) => ({ id: i.id, titulo: i.titulo })) };
  return { tipo: 'lista', corpo: titulo, botao: 'Ver opções', itens };
}

/**
 * O cliente respondeu ao menu? Aceita o id do botão/lista ('fila:3'), o número da opção ou o nome da fila.
 */
function escolhaDeMenu(filas, texto, { idResposta = null } = {}) {
  const porId = String(idResposta ?? '').match(/^fila:(\d+)$/);
  if (porId) return filas.find((f) => f.id === Number(porId[1])) ?? null;
  const t = normalizar(texto);
  if (/^\d{1,2}$/.test(t)) return filas[Number(t) - 1] ?? null;
  return filas.find((f) => normalizar(f.nome) === t) ?? null;
}

module.exports = { normalizar, contem, pedidoDeHumano, temAssuntoAlemDoPedido, ameacaDeSaida, motivoDeSaida, assuntoDeOuvidoria, ehCumprimento, ehDespedida, casarIntencao, saudacao, primeiroNome, preencher, menu,
  escolhaDeMenu, PEDE_HUMANO, DESPEDIDA, CUMPRIMENTO, OUVIDORIA };
