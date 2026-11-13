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
const motor = require('./motor');
const ferramentasIxc = require('./ferramentas-ixc');
const alertas = require('../lib/alertas');
const ouvidoriaLib = require('../lib/ouvidoria');
const cliente360 = require('../lib/cliente360');
const prompt = require('./prompt');

/**
 * A ZOE. Recebe a mensagem que acabou de chegar e decide o que fazer, nesta ordem:
 *
 *   1. Regras  — pedido explícito de humano, escolha de menu, intenção por palavra-chave, despedida.
 *   2. IA      — o modelo de linguagem com as ferramentas (conhecimento, cadastro, chamado, API da empresa).
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
  // Quando o áudio não pôde ser transcrito: a ZOE precisa saber que existe um áudio que ela não
  // ouviu, para pedir com educação que a pessoa escreva — e não fingir que entendeu.
  audio: '[o cliente enviou um áudio que não foi possível transcrever — peça com gentileza para escrever]', video: '[o cliente enviou um vídeo]',
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
/**
 * O áudio transcrito entra como texto, marcado como transcrição. A marca importa: o whisper erra
 * nome próprio e palavra rara ("roteador" pode virar outra coisa), e a ZOE precisa saber que,
 * se algo não fizer sentido, o certo é confirmar com o cliente em vez de agir em cima do erro.
 */
const textoDoAudio = (m) => {
  if (m.transcricao_status === 'pronta' && m.transcricao) return `[áudio do cliente, transcrito automaticamente — pode ter erros]: ${m.transcricao}`;
  if (m.transcricao_status === 'longa') return '[o cliente enviou um áudio longo demais para transcrever — peça um resumo por escrito]';
  return null;
};

function conteudoDoCliente(m) {
  const blocos = [];
  if (m.tipo === 'audio') {
    const t = textoDoAudio(m);
    if (t) return [{ type: 'text', text: t }];
  }
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
 * Histórico no formato da API de IA. O cliente é 'user'; a ZOE e os atendentes humanos
 * são 'assistant' (para a IA, o que a equipe já disse também é contexto). Mensagens de sistema ficam fora.
 */
function historico(db, conversa) {
  const linhas = db.prepare(`SELECT direcao, autor, tipo, texto, transcricao, transcricao_status, midia_arquivo, midia_mime, midia_bytes, usuario_id,
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

/**
 * A nota de estado desta conversa: o que a ZOE precisa saber e que não cabe no prompt fixo.
 *
 * São duas coisas: em que pé está a identificação do cliente no IXC, e se a equipe declarou
 * algum alerta de rede. O alerta aparece aqui apenas como lembrete de conferir — o conteúdo vem
 * da ferramenta, depois de saber quem é o cliente, porque alerta de área só vale para quem está
 * na área, e afirmar isso por engano é pior do que não dizer nada.
 */
function notaDaConversa(db, conversa) {
  const partes = [];
  if (conversa.estado === 'bot' && jaPediuPessoa(db, conversa)) {
    partes.push('O cliente pediu para falar com uma pessoa nesta conversa. Tente resolver agora, de forma direta, em no máximo '
      + 'duas trocas — e diga que, se não resolver, já passa para alguém. Se ele pedir uma pessoa de novo, ou não quiser '
      + 'tentar, chame transferir_para_humano na hora, sem argumentar.');
  }
  if (conversa.canal === 'telefone') partes.push(...notaDaLigacao(db, conversa));
  const doIxc = ferramentasIxc.notaDeEstado(db, conversa);
  if (doIxc) partes.push(doIxc);

  const vigentes = alertas.vigentes(db, conversa.empresa_id);
  if (vigentes.length) {
    const gerais = vigentes.filter((a) => a.abrangencia === 'todos');
    partes.push(`A equipe do provedor tem ${vigentes.length} alerta(s) de rede em vigor agora. `
      + 'Em QUALQUER assunto de internet lenta, caindo ou sem conexão, chame alertas_da_regiao ANTES de '
      + 'diagnostico_de_conexao e antes de abrir chamado.'
      + (gerais.length ? ` ${gerais.length} deles vale(m) para todos os clientes.` : ''));
  }
  return partes.length ? partes.join('\n\n') : null;
}

/**
 * O que muda quando a conversa é uma ligação. O prompt da ZOE é o mesmo nos dois canais (e fica
 * em cache); o canal entra aqui, na nota, porque é dado desta conversa e não da empresa.
 */
function notaDaLigacao(db, conversa) {
  // Por teclas, o cliente não fala: só aperta números. A ZOE pergunta de um jeito que dê para responder assim.
  const porTeclas = conversas.cfgIa(db, conversa.empresa_id).voz_modo === 'teclas';
  const teclado = porTeclas
    ? ['O cliente responde SÓ pelo teclado do telefone, não fala. Quando oferecer escolhas, numere e diga '
      + '"digite 1 para…, 2 para…" (no máximo quatro opções). Para sim ou não, "digite 1 para sim ou 2 para não". '
      + 'Ao pedir números (CPF, data de nascimento), diga quantos dígitos são. Nunca peça para o cliente falar. '
      + 'A resposta dele chega como os números que ele digitou.']
    : [];
  const partes = [...teclado, 'Canal: LIGAÇÃO TELEFÔNICA. Tudo o que você escrever será FALADO por voz para o cliente. '
    + 'Frases curtas e naturais, uma pergunta por vez. Nada de listas, links, emojis, asteriscos ou formatação. '
    + 'Não peça para o cliente clicar, ler ou abrir nada na tela. '
    + (porTeclas ? '' : 'A fala do cliente chega transcrita automaticamente e pode ter erros: confirme números (CPF, datas, valores) repetindo-os. '
      + 'Para os três primeiros números do CPF, ele pode falar ou digitar no teclado do telefone. ')
    + 'A segunda via não aparece na ligação: enviar_segunda_via manda pelo WhatsApp dele ou por SMS e e-mail — diga por onde foi.'];

  // Mesma pessoa, outro canal: se ela falou com a gente pelo WhatsApp há pouco, a ZOE já sabe.
  // Ninguém deveria ter de explicar de novo no telefone o que acabou de escrever.
  const ontem = new Date(Date.now() - 24 * 3600_000).toISOString();
  const recente = db.prepare(`SELECT id, assunto, resumo, estado, ultima_mensagem_em FROM conversas
    WHERE contato_id = ? AND canal = 'whatsapp' AND ultima_mensagem_em >= ? ORDER BY ultima_mensagem_em DESC LIMIT 1`)
    .get(conversa.contato_id, ontem);
  if (recente) {
    const ultimas = db.prepare(`SELECT direcao, COALESCE(texto, transcricao) AS t FROM mensagens
      WHERE conversa_id = ? AND tipo NOT IN ('sistema') AND COALESCE(texto, transcricao) IS NOT NULL ORDER BY id DESC LIMIT 4`)
      .all(recente.id).reverse().map((m) => `${m.direcao === 'entrada' ? 'Cliente' : 'Empresa'}: ${String(m.t).slice(0, 200)}`);
    partes.push(`Este mesmo cliente conversou pelo WhatsApp nas últimas 24 horas`
      + `${recente.assunto ? ` (assunto: ${recente.assunto})` : ''}${recente.resumo ? `. Resumo: ${recente.resumo}` : ''}.`
      + (ultimas.length ? ` Últimas mensagens de lá:\n${ultimas.join('\n')}` : '')
      + '\nUse isso para não fazer o cliente repetir o que já contou.');
  }
  return partes;
}

/**
 * Acrescenta a nota de estado como mensagem de sistema, logo depois da ÚLTIMA mensagem do cliente.
 * A API exige que ela siga uma mensagem de usuário, e é por isso que a posição importa.
 *
 * Nem sempre a última mensagem da lista é do cliente: quando a ZOE manda a saudação antes de
 * pensar, o histórico termina com uma fala dela. Se a nota só entrasse no fim, ela sumiria
 * calada justo na primeira mensagem de cada conversa — que é quando a instrução de identidade
 * mais faz falta.
 */
function comEstado(mensagens, nota) {
  if (!nota || !mensagens.length) return mensagens;
  const ultimoDoCliente = mensagens.map((m) => m.role).lastIndexOf('user');
  if (ultimoDoCliente < 0) return mensagens;
  return [
    ...mensagens.slice(0, ultimoDoCliente + 1),
    { role: 'system', content: nota },
    ...mensagens.slice(ultimoDoCliente + 1),
  ];
}

/** O resumo para quem vai atender: "escreveu" no WhatsApp, "disse" na ligação. */
const oQueDisse = (conversa, texto) =>
  `O cliente ${conversa.canal === 'telefone' ? 'disse na ligação' : 'escreveu'}: "${String(texto).trim().slice(0, 300)}".`;

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
  // O áudio transcrito passa pelas mesmas regras do texto: "quero falar com um atendente"
  // dito em voz alta tem de valer igual ao escrito.
  const texto = mensagem?.texto ?? (mensagem?.transcricao_status === 'pronta' ? mensagem.transcricao : null) ?? '';
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

  // Saudação: só na primeira mensagem da conversa. Na ligação a ZOE já cumprimentou ao atender.
  if (primeira && conversa.canal !== 'telefone') {
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
    // O menu só aparece quando a ZOE não achou resposta: escolher um time ali é uma lacuna dela.
    const r = transferirCom(db, conversa, { fila: escolhida, motivo: `O cliente escolheu ${escolhida.nome} no menu.`, assunto: escolhida.nome,
      lacuna: { categoria: 'nao_sabia' } });
    return { acao: 'transferida', detalhe: r.fila.nome };
  }

  // Assunto de ouvidoria (cancelamento, Procon, reclamação formal): vira caso com protocolo.
  // Com a IA ligada, deixa ela conduzir e chamar abrir_ouvidoria — ela escreve um relato de verdade.
  // Sem IA, as regras abrem o caso aqui mesmo, para o assunto não se perder.
  const daOuvidoria = regras.assuntoDeOuvidoria(texto);
  if (daOuvidoria && lista.length && !(cfg.ativa && motor.disponivel())) {
    const r = await abrirOuvidoriaPelasRegras(db, { empresa, conversa, contato, tipo: daOuvidoria.tipo, texto, termo: daOuvidoria.termo });
    if (r) return r;
  }

  // Pediu uma pessoa. A ZOE tenta resolver antes — mas uma vez só: pediu de novo, transfere na
  // hora, sem discutir. Falar com um atendente é direito do consumidor (Decreto do SAC); o que ela
  // faz é poupar a espera de quem tem um pedido simples.
  const pedido = regras.pedidoDeHumano(texto);
  if (pedido && !daOuvidoria && lista.length) {
    const jaPediu = jaPediuPessoa(db, conversa);
    // No telefone por teclas, o "0 para falar com um atendente" é escolha explícita: não pergunta nada.
    const teclado = conversa.canal === 'telefone' && cfg.voz_modo === 'teclas';
    // O cliente já tinha contado o problema e a ZOE já tentou: agora pedir uma pessoa é insistir.
    const jaTentou = jaDisseOAssunto(db, conversa, mensagem?.id);
    if (cfg.tentar_antes && !jaPediu && !teclado && !jaTentou) {
      if (!regras.temAssuntoAlemDoPedido(texto)) {
        registrarEvento(db, conversa, { tipo: 'intencao', nome: 'pedido de humano: perguntou o assunto', detalhe: pedido });
        responder(db, conversa, conversa.canal === 'telefone'
          ? 'Claro, eu te passo para uma pessoa. Antes, me diz em poucas palavras o que você precisa? Muita coisa eu resolvo na hora, e se não der, quem te atender já fica sabendo de tudo.'
          : 'Claro, eu te passo para uma pessoa. Antes, me conta em poucas palavras o que você precisa? Muita coisa eu resolvo na hora — e se não der, quem te atender já recebe tudo o que você me disse.');
        return { acao: 'perguntou_assunto' };
      }
      // Disse o assunto junto: segue para as regras e a IA tentarem, já avisadas do pedido.
      registrarEvento(db, conversa, { tipo: 'intencao', nome: 'pedido de humano: vai tentar', detalhe: pedido });
    } else {
      registrarEvento(db, conversa, { tipo: 'intencao', nome: 'pedido de humano', detalhe: pedido });
      const r = transferirCom(db, conversa, {
        motivo: jaPediu ? `O cliente pediu atendimento humano de novo ("${pedido}").` : `O cliente pediu atendimento humano ("${pedido}").`,
        resumo: conversa.resumo ?? oQueDisse(conversa, texto),
        lacuna: { categoria: 'cliente_pediu' },
      });
      return { acao: 'transferida', detalhe: r.fila.nome };
    }
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
        resumo: oQueDisse(conversa, texto),
        lacuna: { categoria: 'regra_da_empresa', tema: intencao.nome },
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
    return semIa(db, { empresa, conversa, contato, cfg, lista, texto, motivo: 'A ZOE está desligada nesta empresa.' });
  }

  if (Number(conversa.mensagens_ia) >= Number(cfg.max_turnos)) {
    registrarEvento(db, conversa, { tipo: 'limite', nome: 'max_turnos', detalhe: `${conversa.mensagens_ia} mensagens` });
    if (lista.length) {
      const r = transferirCom(db, conversa, {
        motivo: `A ZOE chegou ao limite de ${cfg.max_turnos} mensagens sem resolver.`,
        resumo: conversa.resumo ?? 'A conversa passou do limite de mensagens da ZOE sem chegar a uma solução.',
        lacuna: { categoria: 'limite' },
      });
      return { acao: 'transferida', detalhe: r.fila.nome };
    }
  }

  const gastoMes = Number(db.prepare(`SELECT COUNT(*) AS n FROM ia_eventos WHERE empresa_id = ? AND tipo = 'resposta' AND criado_em >= ?`)
    .all(empresa.id, require('../lib/datas').inicioDia(require('../lib/datas').inicioMes()))[0].n);
  if (empresa.limite_ia_mes > 0 && gastoMes >= empresa.limite_ia_mes) {
    registrarEvento(db, conversa, { tipo: 'limite', nome: 'limite_ia_mes', detalhe: `${gastoMes}/${empresa.limite_ia_mes} no mês` });
    return semIa(db, { empresa, conversa, contato, cfg, lista, texto, motivo: 'A empresa chegou ao limite de mensagens da IA no mês.' });
  }

  if (!motor.disponivel()) {
    registrarEvento(db, conversa, { tipo: 'desligada', nome: 'sem chave', detalhe: 'ATEND_IA_CHAVE não configurada no servidor' });
    return semIa(db, { empresa, conversa, contato, cfg, lista, texto, motivo: 'O servidor está sem a chave de IA da ZOE.' });
  }

  // ---------- 3. IA ----------

  // Antes de pensar: a plataforma procura o telefone no sistema do provedor. Não confirma nada —
  // só descobre quem provavelmente é, para a IA pedir 3 dígitos em vez do CPF inteiro.
  if (ferramentasIxc.configurado(db, empresa.id)) {
    try { await ferramentasIxc.identificarPeloTelefone(db, { conversa, contato }); } catch { /* o IXC fora do ar não trava o atendimento */ }
  }

  const kit = ferramentas.montar(db, { empresaId: empresa.id, semTransferencia: lista.length === 0 });
  const contexto = { db, empresa, numero, conversa, contato, ferramentas: kit };
  let desfecho;
  try {
    desfecho = await motor.conversar({
      sistema: prompt.montar(db, { empresa, cfg, contato }),
      // A nota de estado do IXC vai como mensagem de sistema no meio da conversa: é o canal que a
      // API de IA indica para instrução de operador, e não derruba o cache do prompt.
      historico: comEstado(historico(db, conversa), notaDaConversa(db, conversa)),
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
    const r = transferirCom(db, conversa, { motivo, resumo: conversa.resumo ?? oQueDisse(conversa, texto), avisar: desfecho.textos.length === 0,
      lacuna: { categoria: desfecho.desfecho === 'limite_passos' ? 'limite' : 'sistema_falhou' } });
    return { acao: 'transferida', detalhe: motivo };
  }
  return semIa(db, { empresa, conversa, contato, cfg, lista, texto, motivo });
}

/**
 * Abre a ouvidoria pelas regras, quando a IA não está disponível para escrever o relato.
 * O relato fica sendo o que o cliente escreveu — menos rico, mas o caso não se perde.
 */
async function abrirOuvidoriaPelasRegras(db, { empresa, conversa, contato, tipo, texto, termo }) {
  let ficha = null;
  try { ficha = await cliente360.ficha(db, empresa.id, contato.id, { ixcClienteId: conversa.ixc_cliente_id }); } catch { ficha = null; }
  const ligacao = conversa.canal === 'telefone';
  const { ouvidoria } = ouvidoriaLib.abrir(db, {
    empresa, contato, conversa, tipo, origem: 'ia', ficha,
    assunto: `${ouvidoriaLib.TIPOS[tipo]} ${ligacao ? 'por telefone' : 'pelo WhatsApp'}`,
    relato: `O cliente ${ligacao ? 'disse na ligação' : 'escreveu'}: "${String(texto).slice(0, 500)}".`,
    // "Claro" e "vivo" são palavras comuns: o motivo só é lido quando o cliente falou em sair.
    ameacaSaida: regras.ameacaDeSaida(texto), motivoSaida: regras.ameacaDeSaida(texto) || tipo === 'cancelamento' ? regras.motivoDeSaida(texto) : null,
  });
  registrarEvento(db, conversa, { tipo: 'intencao', nome: `ouvidoria: ${tipo}`, detalhe: `casou com "${termo}"` });

  if (['elogio', 'sugestao'].includes(tipo)) {
    responder(db, conversa, `Obrigado pelo retorno! Registrei com o protocolo ${ouvidoria.protocolo} e vou encaminhar para a equipe.`);
    return { acao: 'respondeu', detalhe: `ouvidoria ${ouvidoria.protocolo}` };
  }
  // Só o protocolo: a transferência logo em seguida já diz "vou te transferir". Dizer as duas
  // coisas soava repetido no WhatsApp e, na ligação, era a mesma frase falada duas vezes.
  responder(db, conversa, `Registrei sua solicitação com o protocolo ${ouvidoria.protocolo}.`);
  const r = transacao(db, () => ouvidoriaLib.encaminhar(db, { conversa, ouvidoria, ficha }));
  return r ? { acao: 'transferida', detalhe: `ouvidoria ${ouvidoria.protocolo} → ${r.fila.nome}` } : null;
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
  const r = transferirCom(db, conversa, { motivo, resumo: oQueDisse(conversa, texto), lacuna: { categoria: 'nao_sabia' } });
  return { acao: 'transferida', detalhe: r.fila.nome };
}

/** Antes desta mensagem, o cliente já tinha dito o que queria (e a ZOE respondeu)? */
function jaDisseOAssunto(db, conversa, mensagemId) {
  const respondeu = db.prepare("SELECT 1 FROM mensagens WHERE conversa_id = ? AND direcao = 'saida' AND autor = 'ia' AND tipo <> 'sistema' LIMIT 1").get(conversa.id);
  if (!respondeu) return false;
  return db.prepare(`SELECT texto, transcricao, transcricao_status FROM mensagens
    WHERE conversa_id = ? AND direcao = 'entrada' AND id <> ? ORDER BY id`).all(conversa.id, mensagemId ?? -1)
    .some((m) => {
      const t = String(m.texto || (m.transcricao_status === 'pronta' ? m.transcricao : '') || '').trim();
      return t && !/^\d{1,14}$/.test(t) && !regras.ehCumprimento(t) && (!regras.pedidoDeHumano(t) || regras.temAssuntoAlemDoPedido(t));
    });
}

/** O cliente já pediu uma pessoa nesta conversa (e a ZOE tentou antes)? */
const jaPediuPessoa = (db, conversa) => Boolean(db.prepare(`SELECT 1 FROM ia_eventos
  WHERE conversa_id = ? AND tipo = 'intencao' AND nome LIKE 'pedido de humano%' LIMIT 1`).get(conversa.id));

/** A última coisa que a atendente mandou foi o menu? (para interpretar "1", "2" como escolha). */
const ultimaFoiMenu = (db, conversa) => {
  const m = db.prepare("SELECT tipo FROM mensagens WHERE conversa_id = ? AND direcao = 'saida' AND tipo <> 'sistema' ORDER BY id DESC LIMIT 1").get(conversa.id);
  return m?.tipo === 'botao';
};

module.exports = { atender, historico, comEstado, semIa, mandarMenu, registrarEvento, HISTORICO_MAX };
