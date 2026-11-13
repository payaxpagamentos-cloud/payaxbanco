'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

/**
 * Camada de IA da ZOE: Claude API (Messages) com as ferramentas do arquivo ferramentas.js.
 *
 * O laço de ferramentas é escrito aqui de propósito, em vez de usar o tool runner do SDK: cada passo é
 * gravado em `ia_eventos` (auditoria e custo), roda dentro da transação do atendimento e tem limite de
 * passos. Nada é enviado ao cliente por fora da fila de mensagens.
 *
 * Decisões que seguem a API atual:
 * - `claude-opus-5-5` não aceita desligar o pensamento nem `budget_tokens`: a profundidade é só o `effort`.
 * - `tool_choice` forçado ('any'/'tool') dá 400 neste modelo: as ferramentas são obrigadas pelo prompt + `strict: true`.
 * - Recusa de política vem como HTTP 200 com `stop_reason: 'refusal'`; por isso vai junto o `fallbacks`
 *   do servidor, que repete o pedido em outro modelo sem derrubar o atendimento.
 * - O prompt do sistema é estável por empresa e vai com `cache_control`, que derruba o custo das conversas longas.
 */

const BETA_FALLBACK = 'server-side-fallback-2026-07-01';
// Modelos em que o fallback do servidor existe. Em outros, o parâmetro é recusado.
const COM_FALLBACK = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1']);

let cliente = null;
function obterCliente() {
  if (!config.ia.chave) return null;
  if (!cliente) {
    const Construtor = Anthropic.default ?? Anthropic;
    cliente = new Construtor({
      apiKey: config.ia.chave,
      ...(config.ia.baseUrl ? { baseURL: config.ia.baseUrl } : {}),
      timeout: config.ia.timeoutMs,
      maxRetries: 2,
    });
  }
  return cliente;
}

const disponivel = () => Boolean(config.ia.chave);

/** Só para os testes: troca o cliente por um dublê. */
const usarCliente = (c) => { cliente = c; };

const textoDe = (conteudo) => (conteudo ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
const ferramentasDe = (conteudo) => (conteudo ?? []).filter((b) => b.type === 'tool_use');

/** Mensagem de erro curta e em português para o painel e para a auditoria. */
function descreverErro(err) {
  const A = Anthropic.default ?? Anthropic;
  if (err instanceof A.AuthenticationError) return 'Chave da Claude API inválida ou sem permissão.';
  if (err instanceof A.RateLimitError) return 'Limite de uso da Claude API atingido. Tente de novo em instantes.';
  if (err instanceof A.NotFoundError) return `Modelo "${config.ia.modelo}" indisponível para esta chave.`;
  if (err instanceof A.BadRequestError) return `A Claude API recusou o pedido: ${err.message}`;
  if (err instanceof A.APIConnectionError) return 'Sem conexão com a Claude API (verifique a rede e o proxy do servidor).';
  if (err instanceof A.APIError) return `Claude API respondeu ${err.status}: ${err.message}`;
  return `Falha na IA: ${err.message}`;
}

/**
 * Conduz uma rodada de atendimento.
 *
 * `historico`: [{ role: 'user'|'assistant', content }] já no formato da API.
 * `aoPasso(evento)`: chamado em cada passo para gravar em ia_eventos.
 * `aoTexto(texto)`: chamado quando o modelo escreve algo para o cliente (vai para a fila de envio).
 * `executarFerramenta(nome, entrada)`: devolve { resultado, terminal }.
 *
 * Devolve { desfecho: 'respondeu'|'transferida'|'encerrada'|'sem_resposta'|'recusa'|'erro'|'limite_passos',
 *           textos, tokens, passos, erro }.
 */
async function conversar({ sistema, historico, tools, modelo, esforco, maxTokens, maxPassos, aoPasso, aoTexto, executarFerramenta }) {
  const c = obterCliente();
  if (!c) return { desfecho: 'erro', erro: 'IA não configurada no servidor.', textos: [], tokens: zero(), passos: 0 };

  const nomeModelo = modelo || config.ia.modelo;
  const corpoBase = {
    model: nomeModelo,
    max_tokens: maxTokens || config.ia.maxTokens,
    output_config: { effort: esforco || config.ia.esforco },
    // O prompt do sistema é o mesmo em toda a conversa: cacheado, custa ~10% nas rodadas seguintes.
    system: [{ type: 'text', text: sistema, cache_control: { type: 'ephemeral' } }],
    tools,
  };
  const comFallback = COM_FALLBACK.has(nomeModelo);

  const mensagens = [...historico];
  const tokens = zero();
  const textos = [];
  let passos = 0;

  while (passos < (maxPassos || config.ia.maxPassos)) {
    passos++;
    const comecou = Date.now();
    let resposta;
    try {
      resposta = comFallback
        ? await c.beta.messages.create({ ...corpoBase, messages: mensagens, betas: [BETA_FALLBACK], fallbacks: 'default' })
        : await c.messages.create({ ...corpoBase, messages: mensagens });
    } catch (err) {
      const motivo = descreverErro(err);
      aoPasso?.({ tipo: 'erro', nome: nomeModelo, detalhe: motivo, ms: Date.now() - comecou });
      return { desfecho: 'erro', erro: motivo, textos, tokens, passos };
    }
    const ms = Date.now() - comecou;
    somar(tokens, resposta.usage);

    // Recusa de política: não insiste nem mostra o motivo ao cliente — manda para uma pessoa.
    if (resposta.stop_reason === 'refusal') {
      aoPasso?.({ tipo: 'erro', nome: 'recusa', detalhe: resposta.stop_details?.category ?? 'refusal', ms, uso: resposta.usage });
      return { desfecho: 'recusa', textos, tokens, passos };
    }

    const texto = textoDe(resposta.content);
    const chamadas = ferramentasDe(resposta.content);

    // A ordem importa: o que o modelo escreveu sai antes do efeito da ferramenta.
    if (texto) {
      textos.push(texto);
      aoPasso?.({ tipo: 'resposta', nome: nomeModelo, detalhe: texto.slice(0, 500), ms, uso: resposta.usage });
      aoTexto?.(texto);
    }

    if (!chamadas.length) {
      if (resposta.stop_reason === 'max_tokens' && !texto) {
        aoPasso?.({ tipo: 'erro', nome: 'max_tokens', detalhe: 'A resposta passou do limite de tokens.', ms });
        return { desfecho: 'sem_resposta', textos, tokens, passos };
      }
      return { desfecho: texto ? 'respondeu' : 'sem_resposta', textos, tokens, passos };
    }

    mensagens.push({ role: 'assistant', content: resposta.content });
    const resultados = [];
    let terminal = null;
    for (const chamada of chamadas) {
      const t0 = Date.now();
      // `input` já vem desserializado pelo SDK; nunca comparar o JSON como texto.
      const { resultado, terminal: fim } = await executarFerramenta(chamada.name, chamada.input ?? {});
      aoPasso?.({ tipo: 'ferramenta', nome: chamada.name, detalhe: resumirFerramenta(chamada.input, resultado), ms: Date.now() - t0 });
      resultados.push({ type: 'tool_result', tool_use_id: chamada.id, content: JSON.stringify(resultado ?? {}), ...(resultado?.ok === false ? { is_error: true } : {}) });
      if (fim) terminal = resultado?.controle ?? 'encerrada';
    }
    // Todos os resultados voltam numa única mensagem: separar ensina o modelo a não paralelizar.
    mensagens.push({ role: 'user', content: resultados });
    if (terminal) return { desfecho: terminal, textos, tokens, passos };
  }
  return { desfecho: 'limite_passos', textos, tokens, passos };
}

const zero = () => ({ entrada: 0, saida: 0, cache_leitura: 0, cache_escrita: 0 });
function somar(acc, uso) {
  acc.entrada += Number(uso?.input_tokens ?? 0);
  acc.saida += Number(uso?.output_tokens ?? 0);
  acc.cache_leitura += Number(uso?.cache_read_input_tokens ?? 0);
  acc.cache_escrita += Number(uso?.cache_creation_input_tokens ?? 0);
  return acc;
}

const resumirFerramenta = (entrada, resultado) => JSON.stringify({ entrada, resultado }).slice(0, 1000);

module.exports = { disponivel, conversar, obterCliente, usarCliente, descreverErro, textoDe, BETA_FALLBACK, COM_FALLBACK };
