'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { lerConfig } = require('../db');
const rel = require('./relatorios');
const desempenho = require('./desempenho');
const { endereco } = require('./geocodificacao');
const { TIPOS: TIPOS_ALERTA } = require('./alertas');
const { local, hoje, somarDias, intervalo, inicioDia } = require('./datas');
const { ErroNegocio } = require('./erros');

/**
 * Assistente da frota: responde perguntas em português sobre os dados da empresa ("onde estava o ABC1D23 ontem às 15h?",
 * "quem dirigiu pior este mês?", "quanto gastei de combustível?"). Só consulta: as ferramentas leem os dados da própria empresa
 * e nenhuma envia comando ao veículo. Usa a API da Anthropic com a chave de RASTREADOR_IA_CHAVE.
 */
const MAX_VOLTAS = 8;
const MAX_HISTORICO = 10;
const MAX_TEXTO = 2000;
const MAX_LISTA = 40;
// Se o modelo recusar um pedido, a API tenta de novo num modelo reserva indicado pela Anthropic.
const BETA_RESERVA = 'server-side-fallback-2026-07-01';

let clienteAtual = null;
const configurado = () => Boolean(config.ia.chave) || Boolean(clienteAtual);
function cliente() {
  if (!clienteAtual) clienteAtual = new Anthropic({ apiKey: config.ia.chave, timeout: 60_000, maxRetries: 2 });
  return clienteAtual;
}
/** Para os testes: troca o cliente da API por um falso. */
function definirCliente(c) { clienteAtual = c; }

// ---------- Datas no fuso da empresa ----------
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const DATA_HORA = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/;
function dataLocal(iso) {
  if (!iso) return null;
  const l = local(iso);
  const [a, m, d] = l.data.split('-');
  return `${d}/${m}/${a} ${String(l.hora).padStart(2, '0')}:${String(l.minuto).padStart(2, '0')}`;
}
function instante(texto) {
  const m = DATA_HORA.exec(String(texto ?? '').trim());
  if (!m) throw new ErroNegocio('Use data e hora no formato AAAA-MM-DD HH:MM.');
  return new Date(Date.parse(inicioDia(m[1])) + (Number(m[2]) * 60 + Number(m[3])) * 60_000).toISOString();
}
function periodo(entrada, maxDias) {
  const de = String(entrada.de ?? '');
  const ate = String(entrada.ate ?? de);
  if (!DATA.test(de) || !DATA.test(ate)) throw new ErroNegocio('Use datas no formato AAAA-MM-DD.');
  if (ate < de) throw new ErroNegocio('A data final vem antes da inicial.');
  if (somarDias(de, maxDias - 1) < ate) throw new ErroNegocio(`Período de até ${maxDias} dias.`);
  return [de, ate];
}
const kmh = (x) => (x == null ? null : Math.round(x));
const reais = (centavos) => (centavos == null ? null : `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`);
const duracao = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

const SITUACOES = {
  movimento: 'em movimento', ligado: 'ligado parado', parado: 'desligado', sem_sinal: 'sem sinal', sem_posicao: 'sem posição',
  sem_rastreador: 'sem rastreador', inativo: 'inativo',
};

// ---------- Ferramentas (só leitura, sempre da empresa) ----------
const FERRAMENTAS = [
  {
    name: 'situacao_frota',
    description: 'Situação agora de todos os veículos da empresa: placa, descrição, motorista, situação (em movimento, ligado parado, desligado, sem sinal), velocidade, bloqueio, modo roubo, última posição e alertas pendentes. Use para perguntas sobre o momento atual e para descobrir as placas.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'posicao_em',
    description: 'Onde um veículo estava num dia e hora (horário de Brasília): a posição gravada mais próxima, com endereço, velocidade e ignição.',
    input_schema: {
      type: 'object',
      properties: {
        placa: { type: 'string', description: 'Placa do veículo, como aparece na situação da frota.' },
        quando: { type: 'string', description: 'Data e hora no formato AAAA-MM-DD HH:MM, horário de Brasília.' },
      },
      required: ['placa', 'quando'],
      additionalProperties: false,
    },
  },
  {
    name: 'trajeto',
    description: 'Viagens e paradas de um veículo num período de até 7 dias: horário de saída e chegada, km, duração, velocidade máxima, onde parou e por quanto tempo, e os alertas do período.',
    input_schema: {
      type: 'object',
      properties: {
        placa: { type: 'string' },
        de: { type: 'string', description: 'Data inicial AAAA-MM-DD.' },
        ate: { type: 'string', description: 'Data final AAAA-MM-DD (inclusive). Igual à inicial para um dia só.' },
      },
      required: ['placa', 'de', 'ate'],
      additionalProperties: false,
    },
  },
  {
    name: 'alertas',
    description: `Alertas da empresa num período de até 93 dias, com a contagem por tipo e os mais recentes. Tipos: ${Object.entries(TIPOS_ALERTA).map(([k, x]) => `${k} (${x})`).join(', ')}.`,
    input_schema: {
      type: 'object',
      properties: {
        de: { type: 'string', description: 'Data inicial AAAA-MM-DD.' },
        ate: { type: 'string', description: 'Data final AAAA-MM-DD (inclusive).' },
        tipo: { type: 'string', enum: Object.keys(TIPOS_ALERTA) },
        placa: { type: 'string', description: 'Só deste veículo (opcional).' },
      },
      required: ['de', 'ate'],
      additionalProperties: false,
    },
  },
  {
    name: 'desempenho',
    description: 'Nota dos motoristas (0 a 100), ranking, km rodados, excessos de velocidade, uso fora do horário, motor ligado parado, variações bruscas de velocidade e custo de combustível em reais por veículo, num período de até 93 dias.',
    input_schema: {
      type: 'object',
      properties: { de: { type: 'string', description: 'Data inicial AAAA-MM-DD.' }, ate: { type: 'string', description: 'Data final AAAA-MM-DD (inclusive).' } },
      required: ['de', 'ate'],
      additionalProperties: false,
    },
  },
  {
    name: 'manutencoes',
    description: 'Planos de manutenção dos veículos (troca de óleo, revisão, pneus...) com a situação: em dia, próxima ou vencida, e quanto falta em km ou dias.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ocorrencias',
    description: 'Ocorrências de roubo e bloqueios dos últimos 90 dias: veículo, situação (aguardando velocidade segura, bloqueio enviado, bloqueado, encerrada), quando abriu e fechou.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function veiculoPorPlaca(db, empresaId, placa) {
  const p = String(placa ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const x = p && db.prepare("SELECT * FROM veiculos WHERE empresa_id = ? AND REPLACE(UPPER(placa), '-', '') = ?").get(empresaId, p);
  if (!x) throw new ErroNegocio(`Não há veículo com a placa ${placa} nesta empresa.`);
  return x;
}

const EXECUTAR = {
  situacao_frota(db, empresaId) {
    return rel.veiculosMapa(db, empresaId).map((x) => ({
      placa: x.placa, descricao: x.descricao, tipo: x.tipo, motorista: x.motorista, situacao: SITUACOES[x.situacao] ?? x.situacao,
      velocidade_kmh: kmh(x.velocidade_kmh), ignicao: x.ignicao === null ? null : Boolean(x.ignicao), bloqueado: Boolean(x.bloqueado),
      modo_roubo: x.roubo ?? null, alertas_pendentes: x.alertas_pendentes, ultima_posicao: dataLocal(x.posicao_em),
      lat: x.lat, lng: x.lng, hodometro_km: Math.round((x.hodometro_m ?? 0) / 1000),
    }));
  },

  async posicao_em(db, empresaId, e) {
    const veiculo = veiculoPorPlaca(db, empresaId, e.placa);
    const alvo = instante(e.quando);
    const sql = (op, ordem) => db.prepare(`SELECT lat, lng, velocidade_kmh, ignicao, gps_em FROM posicoes WHERE veiculo_id = ? AND gps_em ${op} ? ORDER BY gps_em ${ordem} LIMIT 1`);
    const antes = sql('<=', 'DESC').get(veiculo.id, alvo);
    const depois = sql('>', 'ASC').get(veiculo.id, alvo);
    const dist = (p) => (p ? Math.abs(Date.parse(p.gps_em) - Date.parse(alvo)) : Infinity);
    const p = dist(antes) <= dist(depois) ? antes : depois;
    if (!p) return { placa: veiculo.placa, encontrado: false, motivo: 'Nenhuma posição gravada para este veículo.' };
    let end = null;
    try { end = await endereco(p.lat, p.lng); } catch { /* sem endereço */ }
    return {
      placa: veiculo.placa, encontrado: true, horario_da_posicao: dataLocal(p.gps_em),
      diferenca_min: Math.round(dist(p) / 60_000), lat: p.lat, lng: p.lng, endereco: end?.completo || end?.endereco || null,
      velocidade_kmh: kmh(p.velocidade_kmh), ignicao: p.ignicao === null ? null : Boolean(p.ignicao),
      link_mapa: `https://www.google.com/maps?q=${p.lat},${p.lng}`,
    };
  },

  trajeto(db, empresaId, e) {
    const veiculo = veiculoPorPlaca(db, empresaId, e.placa);
    const [de, ate] = periodo(e, 7);
    const [ini, fim] = intervalo(de, ate);
    const t = rel.percurso(db, veiculo, ini, fim);
    return {
      placa: veiculo.placa, de, ate, km_total: Math.round(t.distancia_m / 100) / 10, velocidade_max_kmh: t.velocidade_max_kmh,
      viagens: t.viagens.slice(0, MAX_LISTA).map((x) => ({
        saida: dataLocal(x.inicio), chegada: dataLocal(x.fim), km: Math.round(x.distancia_m / 100) / 10,
        duracao: duracao(x.duracao_s), velocidade_max_kmh: kmh(x.velocidade_max_kmh),
      })),
      viagens_omitidas: Math.max(0, t.viagens.length - MAX_LISTA),
      paradas: t.paradas.slice(0, MAX_LISTA).map((x) => ({
        de: dataLocal(x.inicio), ate: dataLocal(x.fim), duracao: duracao(x.duracao_s), lat: x.lat, lng: x.lng,
      })),
      alertas: t.alertas.slice(0, MAX_LISTA).map((a) => ({ tipo: TIPOS_ALERTA[a.tipo] ?? a.tipo, mensagem: a.mensagem, quando: dataLocal(a.ocorrido_em) })),
    };
  },

  alertas(db, empresaId, e) {
    const [de, ate] = periodo(e, 93);
    const [ini, fim] = intervalo(de, ate);
    const filtros = ['a.empresa_id = ?', 'a.ocorrido_em >= ?', 'a.ocorrido_em < ?'];
    const valores = [empresaId, ini, fim];
    if (e.tipo) {
      if (!TIPOS_ALERTA[e.tipo]) throw new ErroNegocio('Tipo de alerta desconhecido.');
      filtros.push('a.tipo = ?'); valores.push(e.tipo);
    }
    if (e.placa) { filtros.push('a.veiculo_id = ?'); valores.push(veiculoPorPlaca(db, empresaId, e.placa).id); }
    const onde = filtros.join(' AND ');
    const porTipo = db.prepare(`SELECT a.tipo, COUNT(*) AS n FROM alertas a WHERE ${onde} GROUP BY a.tipo ORDER BY n DESC`).all(...valores);
    const recentes = db.prepare(`SELECT a.tipo, a.mensagem, a.ocorrido_em, a.tratado_em, v.placa FROM alertas a JOIN veiculos v ON v.id = a.veiculo_id
      WHERE ${onde} ORDER BY a.ocorrido_em DESC LIMIT ${MAX_LISTA}`).all(...valores);
    return {
      de, ate, total: porTipo.reduce((s, x) => s + x.n, 0),
      por_tipo: porTipo.map((x) => ({ tipo: TIPOS_ALERTA[x.tipo] ?? x.tipo, quantidade: x.n })),
      recentes: recentes.map((a) => ({ placa: a.placa, tipo: TIPOS_ALERTA[a.tipo] ?? a.tipo, mensagem: a.mensagem, quando: dataLocal(a.ocorrido_em), tratado: Boolean(a.tratado_em) })),
    };
  },

  desempenho(db, empresaId, e) {
    const [de, ate] = periodo(e, 93);
    const d = desempenho.calcular(db, empresaId, de, ate);
    return {
      de, ate, preco_combustivel: reais(d.preco_combustivel_centavos) ?? 'não informado',
      totais: { km: d.totais.km, custo: reais(d.totais.custo_centavos), custo_motor_ligado_parado: reais(d.totais.custo_ocioso_centavos), nota_media: d.totais.nota_media, veiculos_sem_consumo_cadastrado: d.totais.sem_consumo },
      ranking_motoristas: d.ranking.map((m, i) => ({ posicao: i + 1, motorista: m.nome, nota: m.nota, descontos: m.descontos, veiculos: m.veiculos, km: m.km, excessos: m.excessos, fora_horario: m.fora_horario, motor_ligado_parado: duracao(m.ocioso_s), bruscos: m.bruscos })),
      veiculos: d.veiculos.map((x) => ({ placa: x.placa, motorista: x.motorista, nota: x.nota, km: x.km, litros: x.litros, custo: reais(x.custo_centavos), excessos: x.excessos, velocidade_max_kmh: kmh(x.velocidade_max_kmh), motor_ligado_parado: duracao(x.ocioso_s), bruscos: x.bruscos })),
      observacao: 'Variações bruscas são estimadas pela mudança de velocidade entre posições próximas (o aparelho não mede a freada). Sem consumo (km/l) cadastrado, o custo do veículo não é calculado.',
    };
  },

  manutencoes(db, empresaId) {
    return rel.manutencoes(db, empresaId).map((m) => ({
      placa: m.placa, servico: m.descricao, situacao: { em_dia: 'em dia', proxima: 'próxima', vencida: 'vencida' }[m.situacao], km_atual: m.km_atual,
      proxima_km: m.proxima_km, faltam_km: m.faltam_km, proxima_data: m.proxima_data,
    }));
  },

  ocorrencias(db, empresaId) {
    const STATUS = { aguardando: 'aguardando velocidade segura', bloqueio_enviado: 'bloqueio enviado', bloqueado: 'bloqueado', encerrada: 'encerrada' };
    return db.prepare(`SELECT o.tipo, o.status, o.criada_em, o.encerrada_em, o.observacao, v.placa FROM ocorrencias o JOIN veiculos v ON v.id = o.veiculo_id
      WHERE o.empresa_id = ? AND o.criada_em >= ? ORDER BY o.criada_em DESC LIMIT ${MAX_LISTA}`)
      .all(empresaId, new Date(Date.now() - 90 * 86_400_000).toISOString())
      .map((o) => ({ placa: o.placa, tipo: o.tipo === 'agenda' ? 'bloqueio programado' : 'roubo', situacao: STATUS[o.status] ?? o.status, observacao: o.observacao, aberta: dataLocal(o.criada_em), encerrada: dataLocal(o.encerrada_em) }));
  },
};

async function executarFerramenta(db, empresaId, nome, entrada) {
  const f = EXECUTAR[nome];
  if (!f) return { erro: true, texto: `Ferramenta desconhecida: ${nome}.` };
  try {
    return { erro: false, texto: JSON.stringify(await f(db, empresaId, entrada && typeof entrada === 'object' ? entrada : {})) };
  } catch (err) {
    if (err instanceof ErroNegocio) return { erro: true, texto: err.message };
    console.error('[Rastreador] Assistente: falha na ferramenta', nome, err);
    return { erro: true, texto: 'Falha ao consultar os dados.' };
  }
}

function instrucoes(db, empresa) {
  const l = local();
  const semana = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'][l.diaSemana];
  return `Você é o assistente da frota no ${lerConfig(db).nome_plataforma}, um sistema de rastreamento de veículos. Você atende a empresa "${empresa.nome}".
Agora: ${semana}, ${dataLocal(new Date().toISOString())} (horário de Brasília; hoje é ${hoje()}).

Responda em português do Brasil, de forma curta e direta, como um colega que conhece bem a frota. Busque os fatos com as ferramentas: elas leem os dados reais desta empresa. Nunca invente placas, horários, endereços ou números; se a ferramenta não trouxer o dado, diga que não há registro. Quando a pergunta citar um veículo pelo nome, pelo motorista ou por parte da placa, consulte a situação da frota para achar a placa. Converta "ontem", "semana passada", "este mês" em datas a partir de hoje.

Você só consulta. Não consegue bloquear, desbloquear, mandar comandos ao rastreador nem alterar cadastros. Se pedirem isso, diga onde fazer no painel: bloqueio e Modo Roubo ficam no Mapa geral (painel do veículo) e em Segurança; comandos do aparelho em Configurações › Comandos; cercas em Cercas; relatórios em PDF em Relatórios.

Formato: texto simples, frases curtas, listas com "- " quando houver vários itens, valores em reais como R$ 1.234,56, distâncias em km. Pode usar **negrito** para destacar a resposta principal. Ao dar uma posição, inclua o endereço e o link do mapa quando houver.`;
}

/** Quantas perguntas a empresa ainda pode fazer hoje. */
function situacao(db, empresaId) {
  const limite = Number(lerConfig(db).ia_limite_dia) || 0;
  const usadas = db.prepare('SELECT perguntas FROM ia_uso WHERE empresa_id = ? AND data = ?').get(empresaId, hoje())?.perguntas ?? 0;
  return { ligado: configurado() && limite > 0, limite, usadas, restantes: Math.max(0, limite - usadas) };
}

function historicoSeguro(historico) {
  if (!Array.isArray(historico)) return [];
  const msgs = historico.slice(-MAX_HISTORICO * 2)
    .filter((h) => h && (h.papel === 'usuario' || h.papel === 'assistente') && typeof h.texto === 'string' && h.texto.trim())
    .map((h) => ({ role: h.papel === 'usuario' ? 'user' : 'assistant', content: h.texto.slice(0, MAX_TEXTO) }));
  // A conversa precisa começar pelo usuário e alternar os papéis.
  const saida = [];
  for (const m of msgs) {
    if (!saida.length && m.role !== 'user') continue;
    if (saida.length && saida[saida.length - 1].role === m.role) saida[saida.length - 1] = m;
    else saida.push(m);
  }
  if (saida.length && saida[saida.length - 1].role === 'user') saida.pop();
  return saida;
}

const textoDe = (resposta) => resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/** Responde uma pergunta da empresa. `historico`: as mensagens anteriores da conversa, [{ papel: 'usuario'|'assistente', texto }]. */
async function perguntar(db, empresa, { pergunta, historico } = {}) {
  const texto = String(pergunta ?? '').trim();
  if (!texto) throw new ErroNegocio('Escreva a pergunta.');
  if (texto.length > MAX_TEXTO) throw new ErroNegocio(`A pergunta pode ter até ${MAX_TEXTO} caracteres.`);
  if (!configurado()) throw new ErroNegocio('O assistente ainda não foi ligado no servidor.', 503);
  const s = situacao(db, empresa.id);
  if (s.limite <= 0) throw new ErroNegocio('O assistente está desligado pela plataforma.', 403);
  if (s.restantes <= 0) throw new ErroNegocio(`Limite de ${s.limite} perguntas por dia atingido. Volta amanhã.`, 429);
  db.prepare(`INSERT INTO ia_uso (empresa_id, data, perguntas) VALUES (?, ?, 1)
    ON CONFLICT (empresa_id, data) DO UPDATE SET perguntas = perguntas + 1`).run(empresa.id, hoje());

  const messages = [...historicoSeguro(historico), { role: 'user', content: texto }];
  const system = instrucoes(db, empresa);
  const usadas = [];
  const uso = { entrada: 0, saida: 0 };
  let resposta;
  try {
    for (let volta = 0; volta < MAX_VOLTAS; volta++) {
      resposta = await cliente().beta.messages.create({
        model: config.ia.modelo,
        max_tokens: 16000,
        betas: [BETA_RESERVA],
        fallbacks: 'default',
        system,
        tools: FERRAMENTAS,
        messages,
      });
      uso.entrada += resposta.usage?.input_tokens ?? 0;
      uso.saida += resposta.usage?.output_tokens ?? 0;
      if (resposta.stop_reason === 'refusal') break;
      if (resposta.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: resposta.content }); continue; }
      if (resposta.stop_reason !== 'tool_use') break;
      messages.push({ role: 'assistant', content: resposta.content });
      const resultados = [];
      for (const bloco of resposta.content.filter((b) => b.type === 'tool_use')) {
        usadas.push(bloco.name);
        const r = await executarFerramenta(db, empresa.id, bloco.name, bloco.input);
        resultados.push({ type: 'tool_result', tool_use_id: bloco.id, content: r.texto, ...(r.erro ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: resultados });
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error('[Rastreador] Assistente: a chave da IA foi recusada (confira RASTREADOR_IA_CHAVE).');
      throw new ErroNegocio('O assistente está com a chave recusada. Avise o suporte.', 503);
    }
    if (err instanceof Anthropic.RateLimitError) throw new ErroNegocio('Muitas perguntas ao mesmo tempo. Tente de novo em instantes.', 429);
    if (err instanceof Anthropic.APIError) {
      console.error('[Rastreador] Assistente: erro da API', err.status, err.message);
      throw new ErroNegocio('O assistente não respondeu agora. Tente de novo em instantes.', 502);
    }
    throw err;
  }
  registrarTokens(db, empresa.id, uso);
  if (resposta.stop_reason === 'refusal') {
    return { resposta: 'Não posso ajudar com esse pedido. Pergunte sobre a frota: posições, trajetos, alertas, motoristas, custos ou manutenção.', ferramentas: usadas, ...situacao(db, empresa.id) };
  }
  let final = textoDe(resposta);
  if (resposta.stop_reason === 'tool_use') final = final || 'A pergunta pediu consultas demais. Tente algo mais específico, como um veículo ou um dia.';
  if (resposta.stop_reason === 'max_tokens') final = `${final}\n\n(A resposta ficou longa demais e foi cortada.)`.trim();
  return { resposta: final || 'Não encontrei uma resposta. Tente perguntar de outro jeito.', ferramentas: usadas, ...situacao(db, empresa.id) };
}

function registrarTokens(db, empresaId, uso) {
  db.prepare('UPDATE ia_uso SET tokens_entrada = tokens_entrada + ?, tokens_saida = tokens_saida + ? WHERE empresa_id = ? AND data = ?')
    .run(uso.entrada, uso.saida, empresaId, hoje());
}

module.exports = { FERRAMENTAS, EXECUTAR, configurado, definirCliente, perguntar, situacao, historicoSeguro, instante, executarFerramenta };
