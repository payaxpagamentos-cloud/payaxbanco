'use strict';

/**
 * Camada determinística da atendente virtual. Roda antes da IA e resolve o que não precisa de modelo:
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

module.exports = { normalizar, contem, pedidoDeHumano, ehCumprimento, ehDespedida, casarIntencao, saudacao, primeiroNome, preencher, menu, escolhaDeMenu,
  PEDE_HUMANO, DESPEDIDA, CUMPRIMENTO };
