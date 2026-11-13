'use strict';

const fs = require('node:fs');
const { agora, transacao } = require('../db');
const envio = require('../lib/envio');
const conversas = require('../lib/conversas');
const filas = require('../lib/filas');
const midia = require('../lib/midia');
const regras = require('./regras');
const conhecimento = require('./conhecimento');
const ferramentas = require('./ferramentas');
const claude = require('./claude');
const prompt = require('./prompt');

/**
 * A atendente virtual. Recebe a mensagem que acabou de chegar e decide o que fazer, nesta ordem:
 *
 *   1. Regras  — pedido explícito de humano, escolha de menu, intenção por palavra-chave, despedida.
 *   2. IA      — Claude com as ferramentas (conhecimento, cadastro, chamado, API da empresa).
 *   3. Saída   — resolveu e encerra, ou transfere para a fila com um resumo pronto.
 *
 * Nada aqui envia mensagem direto para a Meta: tudo entra na fila de `mensagens` e sai no envio.js.
 */

// Quantas mensagens da conversa vão no histórico enviado ao modelo.
const HISTORICO_MAX = 24;
// Imagem até este tamanho vai para o modelo (ele lê foto de boleto, de equipamento, de tela de erro).
const IMAGEM_MAX_BYTES = 3 * 1024 * 1024;
const IMAGENS_ACEITAS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const DESCRICAO_MIDIA = {
  audio: '[o cliente enviou um áudio]', video: '[o cliente enviou um vídeo]',
  documento: '[o cliente enviou um documento]', figurinha: '[o cliente enviou uma figurinha]',
  localizacao: '[o cliente enviou uma localização]', contato: '[o cliente enviou um contato]',
  imagem: '[o cliente enviou uma imagem]', nao_suportado: '[o cliente enviou algo que não conseguimos abrir]',
};

const registrarEvento = (db, conversa, { tipo, nome = null, detalhe = null, uso = null, ms = 0 }) =>
  db.prepare(`INSERT INTO ia_eventos (empresa_id, conversa_id, tipo, nome, detalhe, tokens_entrada, tokens_saida, tokens_cache, ms, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversa.empresa_id, conversa.id, tipo, nome, detalhe === null || typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe),
      Number(uso?.input_tokens ?? 0), Number(uso?.output_tokens ?? 0),
      Number(uso?.cache_read_input_tokens ?? 0) + Number(uso?.cache_creation_input_tokens ?? 0), ms, agora());

/** Conteúdo de uma mensagem do cliente no formato da API (texto e, quando dá, a imagem). */
function conteudoDoCliente(m) {
  const blocos = [];
  if (m.tipo === 'imagem' && m.midia_arquivo && IMAGENS_ACEITAS.has(String(m.midia_mime).split(';')[0]) && Number(m.midia_bytes) <= IMAGEM_MAX_BYTES) {
    const caminho = midia.caminho(m.midia_arquivo);
    if (caminho && fs.existsSync(caminho)) {
      blocos.push({ type: 'image', source: { type: 'base64', media_type: String(m.midia_mime).split(';')[0], data: fs.readFileSync(caminho).toString('base64') } });
    }
  }
  const texto = [m.texto?.trim(), !blocos.length && m.tipo !== 'texto' ? DESCRICAO_MIDIA[m.tipo] : null].filter(Boolean).join('\n');
  if (texto) blocos.push({ type: 'text', text: texto });
  return blocos.length ? blocos : [{ type: 'text', text: DESCRICAO_MIDIA[m.tipo] ?? '[mensagem vazia]' }];
}

/**
 * Histórico no formato da Claude API. O cliente é 'user'; a atendente virtual e os atendentes humanos
 * são 'assistant' (para a IA, o que a equipe já disse também é contexto). Mensagens de sistema ficam fora.
 */
function historico(db, conversa) {
  const linhas = db.prepare(`SELECT direcao, autor, tipo, texto, midia_arquivo, midia_mime, midia_bytes, usuario_id,
      (SELECT nome FROM usuarios WHERE id = mensagens.usuario_id) AS usuario_nome
    FROM mensagens WHERE conversa_id = ? AND tipo <> 'sistema' AND NOT (direcao = 'saida' AND status = 'falhou')
    ORDER BY id DESC LIMIT ?`).all(conversa.id, HISTORICO_MAX).reverse();

  const msgs = [];
  for (const m of linhas) {
    const papel = m.direcao === 'entrada' ? 'user' : 'assistant';
    const conteudo = papel === 'user'
      ? conteudoDoCliente(m)
      : [{ type: 'text', text: (m.autor === 'atendente' ? `(${m.usuario_nome ?? 'atendente'}) ` : '') + (m.texto ?? '[mensagem sem texto]') }];
    const ultimo = msgs.at(-1);
    // Junta mensagens seguidas do mesmo lado: o cliente costuma mandar três linhas em três mensagens.
    if (ultimo?.role === papel) ultimo.content.push(...conteudo);
    else msgs.push({ role: papel, content: conteudo });
  }
  // A API exige começar por 'user'.
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

// ---------- Saídas ----------

const responder = (db, conversa, texto, { responde = null } = {}) =>
  envio.enfileirar(db, conversa, { autor: 'ia', tipo: 'texto', texto, respondeWaId: responde });

/** Manda o menu de departamentos (usado quando a IA está desligada ou indisponível). */
function mandarMenu(db, conversa, lista, titulo) {
  const m = regras.menu(lista, titulo ? { titulo } : {});
  if (!m) return false;
  const wa = require('../lib/whatsapp');
  const payload = m.tipo === 'botao'
    ? wa.corpos.botoes('', m.corpo, m.opcoes)
    : wa.corpos.listaOpcoes('', m.corpo, m.botao, m.itens);
  const { to, recipient_type: _r, ...corpo } = payload;
  envio.enfileirar(db, conversa, { autor: 'ia', tipo: 'botao', texto: m.corpo, payload: corpo });
  return true;
}

const transferirCom = (db, conversa, dados) => transacao(db, () => conversas.transferir(db, conversa, { por: 'ia', ...dados }));

// ---------- Fluxo ----------

/**
 * Atende a mensagem que chegou. `mensagem`: a linha gravada em `mensagens` (ou um objeto com tipo/texto/wa_id).
 * Devolve { acao, detalhe } para o log do webhook e para os testes.
 */
async function atender(db, { empresa, numero, contato, conversa, mensagem, idResposta = null }) {
  // Quem está com a conversa é uma pessoa: a IA não fala por cima.
  if (conversa.estado === 'humano') return { acao: 'humano_atendendo' };

  const cfg = conversas.cfgIa(db, empresa.id);
  const lista = filas.listar(db, empresa.id);
  const texto = mensagem?.texto ?? '';
  const primeira = Number(db.prepare("SELECT COUNT(*) AS n FROM mensagens WHERE conversa_id = ? AND direcao = 'entrada'").all(conversa.id)[0].n) <= 1;

  // Na fila esperando gente: só confirma a espera uma vez e não deixa a IA responder.
  if (conversa.estado === 'aguardando') {
    const jaAvisou = db.prepare("SELECT 1 FROM mensagens WHERE conversa_id = ? AND direcao = 'saida' AND autor = 'ia' AND criada_em >= ?")
      .get(conversa.id, conversa.transferida_em ?? conversa.aberta_em);
    if (!jaAvisou) responder(db, conversa, conversas.mensagemDe(cfg, 'transferencia'));
    // Alguém pode ter ficado disponível desde a transferência.
    filas.atribuir(db, conversa);
    return { acao: 'na_fila' };
  }

  if (contato.bloqueado) return { acao: 'contato_bloqueado' };

  // ---------- 1. Regras ----------

  // Saudação: só na primeira mensagem da conversa.
  if (primeira) {
    const saudacao = prompt.saudacaoDe(cfg, { empresa, contato, nomeCliente: contato.nome ?? contato.nome_perfil })
      || regras.saudacao(cfg, { nomeAssistente: cfg.nome_assistente, nomeEmpresa: empresa.nome, nomeCliente: contato.nome ?? contato.nome_perfil });
    responder(db, conversa, saudacao);
    // Só cumprimento, sem pedido: espera o cliente dizer o que quer.
    if (regras.ehCumprimento(texto)) {
      registrarEvento(db, conversa, { tipo: 'intencao', nome: 'saudação', detalhe: 'cumprimento sem pedido' });
      return { acao: 'saudacao' };
    }
  }

  // O cliente respondeu ao menu de departamentos.
  const escolhida = lista.length ? regras.escolhaDeMenu(lista, texto, { idResposta }) : null;
  if (escolhida && ultimaFoiMenu(db, conversa)) {
    registrarEvento(db, conversa, { tipo: 'intencao', nome: 'menu', detalhe: escolhida.nome });
    const r = transferirCom(db, conversa, { fila: escolhida, motivo: `O cliente escolheu ${escolhida.nome} no menu.`, assunto: escolhida.nome });
    return { acao: 'transferida', detalhe: r.fila.nome };
  }

  // Pediu uma pessoa: transfere na hora, sem insistir.
  const pedido = regras.pedidoDeHumano(texto);
  if (pedido && lista.length) {
    registrarEvento(db, conversa, { tipo: 'intencao', nome: 'pedido de humano', detalhe: pedido });
    const r = transferirCom(db, conversa, {
      motivo: `O cliente pediu atendimento humano ("${pedido}").`,
      resumo: conversa.resumo ?? `O cliente escreveu: "${String(texto).slice(0, 300)}".`,
    });
    return { acao: 'transferida', detalhe: r.fila.nome };
  }

  // Intenção cadastrada pela empresa.
  const casou = regras.casarIntencao(db.prepare('SELECT * FROM intencoes WHERE empresa_id = ? ORDER BY ordem, id').all(empresa.id), texto);
  if (casou) {
    const { intencao, termo } = casou;
    db.prepare('UPDATE intencoes SET usos = usos + 1 WHERE id = ?').run(intencao.id);
    db.prepare('UPDATE conversas SET intencao = COALESCE(intencao, ?) WHERE id = ?').run(intencao.nome, conversa.id);
    registrarEvento(db, conversa, { tipo: 'intencao', nome: intencao.nome, detalhe: `casou com "${termo}"` });
    if (intencao.acao === 'transferir' && lista.length) {
      const r = transferirCom(db, conversa, {
        fila: filas.buscar(db, empresa.id, intencao.fila_id), assunto: intencao.nome,
        motivo: `Intenção "${intencao.nome}" (o cliente escreveu "${termo}").`,
        resumo: `O cliente escreveu: "${String(texto).slice(0, 300)}".`,
      });
      return { acao: 'transferida', detalhe: r.fila.nome };
    }
    if (intencao.acao === 'encerrar') {
      if (intencao.resposta?.trim()) responder(db, conversa, intencao.resposta.trim());
      conversas.encerrar(db, conversa, { resolvidaPor: 'ia', avisar: !intencao.resposta?.trim() });
      return { acao: 'encerrada', detalhe: intencao.nome };
    }
    if (intencao.resposta?.trim()) {
      responder(db, conversa, regras.preencher(intencao.resposta.trim(), { cliente: regras.primeiroNome(conversas.nomeContato(contato)), empresa: empresa.nome }));
      return { acao: 'respondeu', detalhe: `intenção ${intencao.nome}` };
    }
  }

  // Despedida depois de a conversa já ter andado: encerra.
  if (!primeira && regras.ehDespedida(texto)) {
    conversas.encerrar(db, conversa, { resolvidaPor: 'cliente' });
    return { acao: 'encerrada', detalhe: 'despedida do cliente' };
  }

  // ---------- 2. Limites ----------

  if (!cfg.ativa) {
    registrarEvento(db, conversa, { tipo: 'desligada', nome: 'ia desligada' });
    return semIa(db, { empresa, conversa, contato, cfg, lista, texto, motivo: 'A atendente virtual está desligada nesta empresa.' });
  }

  if (Number(conversa.mensagens_ia) >= Number(cfg.max_turnos)) {
    registrarEvento(db, conversa, { tipo: 'limite', nome: 'max_turnos', detalhe: `${conversa.mensagens_ia} mensagens` });
    if (lista.length) {
      const r = transferirCom(db, conversa, {
        motivo: `A atendente virtual chegou ao limite de ${cfg.max_turnos} mensagens sem resolver.`,
        resumo: conversa.resumo ?? 'A conversa passou do limite de mensagens da atendente virtual sem chegar a uma solução.',
      });
      return { acao: 'transferida', detalhe: r.fila.nome };
    }
  }

  const gastoMes = Number(db.prepare(`SELECT COUNT(*) AS n FROM ia_eventos WHERE empresa_id = ? AND tipo = 'resposta' AND criado_em >= ?`)
    .all(empresa.id, `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`)[0].n);
  if (empresa.limite_ia_mes > 0 && gastoMes >= empresa.limite_ia_mes) {
    registrarEvento(db, conversa, { tipo: 'limite', nome: 'limite_ia_mes', detalhe: `${gastoMes}/${empresa.limite_ia_mes} no mês` });
    return semIa(db, { empresa, conversa, contato, cfg, lista, texto, motivo: 'A empresa chegou ao limite de mensagens da IA no mês.' });
  }

  if (!claude.disponivel()) {
    registrarEvento(db, conversa, { tipo: 'desligada', nome: 'sem chave', detalhe: 'ATEND_IA_CHAVE não configurada no servidor' });
    return semIa(db, { empresa, conversa, contato, cfg, lista, texto, motivo: 'O servidor está sem chave da Claude API.' });
  }

  // ---------- 3. IA ----------

  const kit = ferramentas.montar(db, { empresaId: empresa.id, semTransferencia: lista.length === 0 });
  const contexto = { db, empresa, numero, conversa, contato, ferramentas: kit };
  let desfecho;
  try {
    desfecho = await claude.conversar({
      sistema: prompt.montar(db, { empresa, cfg, contato }),
      historico: historico(db, conversa),
      tools: kit.tools,
      modelo: cfg.modelo || undefined,
      esforco: cfg.esforco || undefined,
      maxPassos: undefined,
      aoPasso: (e) => registrarEvento(db, conversa, e),
      aoTexto: (t) => { responder(db, conversa, t); },
      executarFerramenta: (nome, entrada) => ferramentas.executar(nome, entrada, {
        ...contexto, conversa: db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id), contato: db.prepare('SELECT * FROM contatos WHERE id = ?').get(contato.id),
      }),
    });
  } catch (err) {
    registrarEvento(db, conversa, { tipo: 'erro', nome: 'laço da IA', detalhe: err.message });
    desfecho = { desfecho: 'erro', erro: err.message, textos: [] };
  }

  db.prepare('UPDATE conversas SET mensagens_ia = mensagens_ia + 1 WHERE id = ?').run(conversa.id);

  if (desfecho.desfecho === 'respondeu') return { acao: 'respondeu', detalhe: `${desfecho.passos} passo(s)` };
  if (desfecho.desfecho === 'transferida') return { acao: 'transferida', detalhe: 'pela ferramenta da IA' };
  if (desfecho.desfecho === 'encerrada') return { acao: 'encerrada', detalhe: 'resolvida pela IA' };

  // Recusa, erro, resposta vazia ou limite de passos: não enrola o cliente, manda para uma pessoa.
  const motivos = {
    recusa: 'A IA recusou responder esta mensagem (política de uso).',
    erro: `Falha na IA: ${desfecho.erro ?? 'desconhecida'}.`,
    sem_resposta: 'A IA não produziu resposta.',
    limite_passos: 'A IA não concluiu dentro do limite de passos.',
  };
  const motivo = motivos[desfecho.desfecho] ?? 'A IA não conseguiu concluir.';
  if (lista.length && cfg.transferir_sem_resposta) {
    const r = transferirCom(db, conversa, { motivo, resumo: conversa.resumo ?? `O cliente escreveu: "${String(texto).slice(0, 300)}".`, avisar: desfecho.textos.length === 0 });
    return { acao: 'transferida', detalhe: motivo };
  }
  return semIa(db, { empresa, conversa, contato, cfg, lista, texto, motivo });
}

/**
 * Caminho sem IA: tenta a base de conhecimento direto e, não achando, oferece o menu de departamentos
 * (ou transfere para a fila padrão quando não há menu possível).
 */
function semIa(db, { empresa, conversa, contato, cfg, lista, texto, motivo }) {
  const achados = conhecimento.buscar(db, empresa.id, texto, { limite: 1, minimo: 3 });
  if (achados.length) {
    conhecimento.registrarUso(db, achados[0].id);
    registrarEvento(db, conversa, { tipo: 'conhecimento', nome: achados[0].titulo, detalhe: `${achados[0].pontos} ponto(s), sem IA` });
    responder(db, conversa, achados[0].resposta);
    if (lista.length) mandarMenu(db, conversa, lista, 'Isso resolveu? Se precisar de mais alguma coisa, escolha um time:');
    return { acao: 'respondeu', detalhe: `conhecimento: ${achados[0].titulo}` };
  }
  if (!lista.length) {
    responder(db, conversa, 'Vou registrar o seu pedido e a equipe entra em contato. Obrigado pela paciência!');
    return { acao: 'sem_saida', detalhe: motivo };
  }
  if (mandarMenu(db, conversa, lista)) {
    registrarEvento(db, conversa, { tipo: 'transferencia', nome: 'menu', detalhe: motivo });
    return { acao: 'menu', detalhe: motivo };
  }
  const r = transferirCom(db, conversa, { motivo, resumo: `O cliente escreveu: "${String(texto).slice(0, 300)}".` });
  return { acao: 'transferida', detalhe: r.fila.nome };
}

/** A última coisa que a atendente mandou foi o menu? (para interpretar "1", "2" como escolha). */
const ultimaFoiMenu = (db, conversa) => {
  const m = db.prepare("SELECT tipo FROM mensagens WHERE conversa_id = ? AND direcao = 'saida' AND tipo <> 'sistema' ORDER BY id DESC LIMIT 1").get(conversa.id);
  return m?.tipo === 'botao';
};

module.exports = { atender, historico, semIa, mandarMenu, registrarEvento, HISTORICO_MAX };
