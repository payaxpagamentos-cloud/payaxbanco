'use strict';

const { agora } = require('../db');
const { decifrar } = require('../lib/cifra');
const conversas = require('../lib/conversas');
const filas = require('../lib/filas');
const conhecimento = require('./conhecimento');
const ixc = require('./ferramentas-ixc');
const ouvidoriaLib = require('../lib/ouvidoria');
const cliente360 = require('../lib/cliente360');
const alertas = require('../lib/alertas');

/**
 * O que a ZOE pode fazer. Cada ferramenta é uma função do servidor: a IA escolhe e
 * preenche os parâmetros, mas a execução, as permissões e os dados são sempre nossos.
 *
 * Duas delas terminam o atendimento da IA e são o núcleo da regra do produto:
 *   - transferir_para_humano: o que ela não resolve vai para a equipe, com um resumo pronto.
 *   - encerrar_atendimento: o que ela resolve fecha ali, sem ocupar ninguém.
 *
 * A identidade do cliente NUNCA vem do modelo: telefone, documento e código do contato são lidos do
 * banco e injetados pelo servidor, tanto nas consultas internas quanto nas ferramentas da empresa.
 */

// Em `strict: true` todo campo declarado entra em `required`; o que é opcional aceita null.
const txt = (descricao) => ({ type: 'string', description: descricao });
const txtOuNulo = (descricao) => ({ type: ['string', 'null'], description: `${descricao} Use null se não se aplica.` });
const esquema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

// ---------- Ferramentas internas ----------

/** O alerta como a ZOE o recebe: o que dizer, não como ele foi configurado. */
const resumoAlerta = (a) => ({
  tipo: a.tipo_nome,
  mensagem: a.mensagem,
  previsao: a.previsao ?? null,
  desde: a.inicio,
  previsto_ate: a.fim,
});

const INTERNAS = {
  alertas_da_regiao: {
    descricao: 'Verifica se a equipe do provedor registrou falha em massa, manutenção programada ou aviso que atinja ESTE '
      + 'cliente agora. Chame SEMPRE antes de diagnostico_de_conexao e antes de abrir chamado técnico, em qualquer assunto '
      + 'de internet lenta, caindo ou sem conexão. O que vier daqui é a informação correta, acima do que o cadastro disser.',
    entrada: esquema({}, []),
    executar: async ({ db, conversa, contato }) => {
      const c = db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);

      // Sem cliente confirmado só dá para falar dos alertas que valem para a base inteira.
      // Dizer que alguém está numa área sem saber onde essa pessoa está é exatamente o erro
      // que estes alertas existem para evitar.
      if (!c.identidade_confirmada || !c.ixc_cliente_id) {
        const gerais = alertas.paraCliente(db, conversa.empresa_id, null);
        alertas.marcarAvisado(db, gerais.map((a) => a.id));
        return {
          ok: true, identificado: false, alertas: gerais.map(resumoAlerta),
          instrucao: gerais.length
            ? 'Estes alertas valem para todos os clientes, então pode contar. Para saber se há falha na ÁREA desta pessoa, '
              + 'identifique e confirme a identidade primeiro.'
            : 'Não há alerta geral em vigor. Para conferir a área desta pessoa, identifique e confirme a identidade primeiro.',
        };
      }

      // Com a identidade confirmada, junta o que o IXC sabe sobre onde o cliente está.
      // Endereço e bairro vêm do cadastro; OLT e caixa vivem no login, não no cliente.
      const dados = { cadastro: null, contratos: [], logins: [] };
      const buscas = [
        ['cadastro', (x) => x.clientePorId(c.ixc_cliente_id)],
        ['contratos', (x) => x.contratos(c.ixc_cliente_id)],
        ['logins', (x) => x.logins(c.ixc_cliente_id)],
      ];
      const cliente = ixc.clienteIxc(db, conversa.empresa_id);
      if (cliente) {
        for (const [chave, buscar] of buscas) {
          try {
            const valor = await buscar(cliente);
            if (chave === 'cadastro') dados.cadastro = valor;
            else if (Array.isArray(valor)) dados[chave] = valor;
          } catch { /* um recurso indisponível não impede os outros */ }
        }
      }

      const aplicaveis = alertas.paraCliente(db, conversa.empresa_id, dados.cadastro ? dados : null);
      alertas.marcarAvisado(db, aplicaveis.map((a) => a.id));
      ixc.registrar(db, { conversa, contato, tipo: 'alerta', detalhe: `${aplicaveis.length} alerta(s) para o cliente` });

      if (!aplicaveis.length) {
        return {
          ok: true, identificado: true, alertas: [],
          instrucao: 'Nenhum alerta atinge este cliente. Siga o atendimento normal: chame diagnostico_de_conexao e, se for o caso, '
            + 'abra o chamado. NÃO diga que existe falha na região — não há nenhuma registrada para ele.',
        };
      }
      const abreChamado = aplicaveis.some((a) => a.abre_chamado);
      return {
        ok: true, identificado: true, alertas: aplicaveis.map(resumoAlerta), abrir_chamado: abreChamado,
        instrucao: 'A equipe já registrou isto. Conte ao cliente com naturalidade, usando a mensagem acima, e diga a previsão se houver. '
          + (abreChamado
            ? 'Se o cliente quiser registrar assim mesmo, abra o chamado. '
            : 'NÃO abra chamado técnico por este motivo: seriam dezenas de chamados do mesmo problema. ')
          + 'Não invente detalhe que não esteja escrito no alerta.',
      };
    },
  },

  buscar_conhecimento: {
    descricao: 'Procura a resposta na base de conhecimento da empresa. Use SEMPRE antes de responder qualquer dúvida sobre produtos, '
      + 'prazos, preços, horários, procedimentos ou políticas. Nunca responda esse tipo de pergunta de memória.',
    entrada: esquema({ pergunta: txt('A dúvida do cliente, com as palavras dele.') }, ['pergunta']),
    executar: ({ db, conversa, entrada }) => {
      const achados = conhecimento.buscar(db, conversa.empresa_id, entrada.pergunta);
      if (achados.length) conhecimento.registrarUso(db, achados.map((a) => a.id));
      return {
        encontrou: achados.length > 0,
        artigos: achados.map((a) => ({ titulo: a.titulo, conteudo: a.resposta })),
        ...(achados.length ? {} : { aviso: 'Nada na base responde isso. Não invente: transfira para um atendente humano.' }),
      };
    },
  },

  dados_do_contato: {
    descricao: 'Mostra o que já sabemos deste cliente: nome, documento, e-mail, atendimentos anteriores e chamados abertos. '
      + 'Use no começo quando precisar identificar o cliente, antes de pedir dados que a gente já tem.',
    entrada: esquema({}, []),
    executar: ({ db, conversa, contato }) => {
      const anteriores = db.prepare(`SELECT id, assunto, intencao, resolvida_por, aberta_em, encerrada_em FROM conversas
        WHERE contato_id = ? AND id <> ? AND estado = 'encerrada' ORDER BY id DESC LIMIT 3`).all(contato.id, conversa.id);
      const chamados = db.prepare(`SELECT protocolo, assunto, status, criado_em FROM chamados
        WHERE contato_id = ? AND status IN ('aberto','andamento') ORDER BY id DESC LIMIT 5`).all(contato.id);
      return {
        nome: contato.nome ?? contato.nome_perfil ?? null,
        telefone: contato.telefone,
        documento: contato.documento ?? null,
        email: contato.email ?? null,
        codigo_no_sistema: contato.codigo_externo ?? null,
        cliente_novo: anteriores.length === 0,
        observacoes: contato.observacoes ?? null,
        atendimentos_anteriores: anteriores,
        chamados_em_aberto: chamados,
      };
    },
  },

  registrar_dados_do_contato: {
    descricao: 'Guarda no cadastro os dados que o cliente informar (nome, CPF/CNPJ, e-mail). Chame assim que ele informar, '
      + 'para a equipe não ter de pedir de novo.',
    entrada: esquema({
      nome: txtOuNulo('Nome completo do cliente.'),
      documento: txtOuNulo('CPF ou CNPJ, só os números.'),
      email: txtOuNulo('E-mail do cliente.'),
    }, ['nome', 'documento', 'email']),
    executar: ({ db, contato, entrada }) => {
      const v = require('../lib/validacao');
      const campos = [];
      const args = [];
      if (entrada.nome) { campos.push('nome = ?'); args.push(String(entrada.nome).trim().slice(0, 160)); }
      if (entrada.documento) {
        const d = v.digitos(entrada.documento);
        if (d.length === 11 && !v.cpfValido(d)) return { ok: false, erro: 'CPF inválido. Confirme o número com o cliente.' };
        if (d.length === 14 && !v.cnpjValido(d)) return { ok: false, erro: 'CNPJ inválido. Confirme o número com o cliente.' };
        if (d.length !== 11 && d.length !== 14) return { ok: false, erro: 'Documento deve ter 11 (CPF) ou 14 (CNPJ) dígitos.' };
        campos.push('documento = ?');
        args.push(d);
      }
      if (entrada.email) {
        if (!v.emailValido(entrada.email)) return { ok: false, erro: 'E-mail inválido. Confirme com o cliente.' };
        campos.push('email = ?');
        args.push(String(entrada.email).trim().toLowerCase().slice(0, 160));
      }
      if (!campos.length) return { ok: false, erro: 'Nenhum dado informado.' };
      db.prepare(`UPDATE contatos SET ${campos.join(', ')} WHERE id = ?`).run(...args, contato.id);
      return { ok: true, salvo: campos.length };
    },
  },

  abrir_chamado: {
    descricao: 'Abre um chamado com protocolo quando o pedido é legítimo mas não tem solução imediata nesta conversa '
      + '(precisa de análise, visita técnica, prazo ou outro setor). Informe o protocolo ao cliente depois.',
    entrada: esquema({
      assunto: txt('Resumo do pedido em até 80 caracteres.'),
      descricao: txt('O que o cliente relatou, com os detalhes que ele deu.'),
      fila: txtOuNulo('Nome do time que deve tratar, se souber.'),
    }, ['assunto', 'descricao', 'fila']),
    executar: ({ db, conversa, contato, entrada }) => {
      const fila = entrada.fila ? filas.porNome(db, conversa.empresa_id, entrada.fila) : null;
      const protocolo = gerarProtocolo(db, conversa.empresa_id);
      db.prepare(`INSERT INTO chamados (empresa_id, conversa_id, contato_id, protocolo, assunto, descricao, fila_id, aberto_por, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ia', ?)`)
        .run(conversa.empresa_id, conversa.id, contato.id, protocolo, String(entrada.assunto).slice(0, 80), String(entrada.descricao).slice(0, 2000),
          fila?.id ?? null, agora());
      return { ok: true, protocolo, mensagem: `Chamado aberto com o protocolo ${protocolo}. Informe este número ao cliente.` };
    },
  },

  consultar_chamado: {
    descricao: 'Consulta a situação de um chamado pelo protocolo. Só devolve chamados deste cliente.',
    entrada: esquema({ protocolo: txt('O protocolo informado pelo cliente.') }, ['protocolo']),
    executar: ({ db, conversa, contato, entrada }) => {
      const c = db.prepare('SELECT protocolo, assunto, status, resolucao, criado_em, atualizado_em FROM chamados WHERE empresa_id = ? AND contato_id = ? AND protocolo = ?')
        .get(conversa.empresa_id, contato.id, String(entrada.protocolo).trim().toUpperCase());
      return c ? { encontrou: true, chamado: c } : { encontrou: false, aviso: 'Nenhum chamado com esse protocolo neste cliente.' };
    },
  },

  transferir_para_humano: {
    descricao: 'Passa o atendimento para a equipe humana. Use quando: o cliente pedir uma pessoa; o assunto envolver '
      + 'cancelamento, reclamação formal, negociação, exceção de regra ou dado sensível; a base de conhecimento não responder; '
      + 'ou você já tentou duas vezes e o cliente continua insatisfeito. É melhor transferir do que arriscar uma resposta errada.',
    entrada: esquema({
      fila: txtOuNulo('Nome do time que deve atender.'),
      motivo: txt('Por que está transferindo, em uma frase (vai para o painel da equipe).'),
      resumo: txt('Resumo do caso para o atendente: quem é o cliente, o que ele quer, o que você já verificou e o que falta.'),
    }, ['fila', 'motivo', 'resumo']),
    terminal: true,
    executar: ({ db, conversa, entrada }) => {
      const fila = entrada.fila ? filas.porNome(db, conversa.empresa_id, entrada.fila) : null;
      const r = conversas.transferir(db, conversa, {
        fila, motivo: String(entrada.motivo).slice(0, 300), resumo: String(entrada.resumo).slice(0, 2000),
        assunto: conversa.assunto ?? String(entrada.motivo).slice(0, 120), por: 'ia',
      });
      return {
        controle: 'transferida',
        ok: true,
        fila: r.fila.nome,
        dentro_horario: r.dentro_horario,
        atendente: r.atendente?.nome ?? null,
        mensagem: 'O cliente já foi avisado da transferência. Não escreva mais nada.',
      };
    },
  },

  abrir_ouvidoria: {
    descricao: 'Abre um caso de OUVIDORIA e passa para quem trata isso. Use quando o cliente: pedir para CANCELAR o contrato; '
      + 'fizer uma reclamação formal (não uma dúvida, mas uma queixa sobre o serviço ou o atendimento); citar PROCON, Anatel, '
      + 'advogado ou processo; ou quando quiser registrar um elogio ou uma sugestão. '
      + 'Isso gera protocolo e prazo, e leva para a pessoa certa a ficha do cliente com o histórico e o risco já calculados. '
      + 'NÃO tente reverter o cancelamento você mesma e NÃO ofereça desconto: quem negocia é gente.',
    entrada: esquema({
      tipo: txt('Um destes: cancelamento, reclamacao, procon, anatel, elogio, sugestao.'),
      assunto: txt('O caso em uma frase, do jeito que a pessoa que for tratar precisa ler (até 200 caracteres).'),
      relato: txt('O que o cliente contou, com as palavras dele: o motivo, desde quando, o que já tentou.'),
    }, ['tipo', 'assunto', 'relato']),
    terminal: true,
    executar: async ({ db, empresa, conversa, contato, entrada }) => {
      const tipos = Object.keys(ouvidoriaLib.TIPOS);
      const tipo = tipos.includes(String(entrada.tipo).toLowerCase()) ? String(entrada.tipo).toLowerCase() : 'reclamacao';
      const atualConversa = db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);

      // A ficha é calculada ANTES de transferir: quem recebe já abre a conversa sabendo com quem fala.
      let ficha = null;
      try {
        ficha = await cliente360.ficha(db, empresa.id, contato.id, { ixcClienteId: atualConversa.ixc_cliente_id });
      } catch { ficha = null; }

      const { ouvidoria, ja_existia: jaExistia } = ouvidoriaLib.abrir(db, {
        empresa, contato, conversa: atualConversa, tipo,
        assunto: String(entrada.assunto).slice(0, 200), relato: entrada.relato, origem: 'ia', ficha,
      });

      // Elogio e sugestão não precisam ocupar ninguém: ficam registrados e o atendimento segue.
      if (['elogio', 'sugestao'].includes(tipo)) {
        return {
          controle: null, ok: true, protocolo: ouvidoria.protocolo, registrado: true,
          instrucao: `Agradeça de verdade e diga que o registro ficou com o protocolo ${ouvidoria.protocolo}. O atendimento continua normalmente.`,
        };
      }

      const r = ouvidoriaLib.encaminhar(db, { conversa: atualConversa, ouvidoria, ficha });
      if (!r) {
        return { ok: false, erro: 'A empresa não tem fila para receber a ouvidoria.', instrucao: 'Informe o protocolo ao cliente e chame transferir_para_humano.' };
      }
      return {
        controle: 'transferida',
        ok: true,
        protocolo: ouvidoria.protocolo,
        ja_existia: jaExistia,
        fila: r.fila.nome,
        dentro_horario: r.dentro_horario,
        instrucao: `Informe o protocolo ${ouvidoria.protocolo} ao cliente e diga que a ouvidoria vai tratar. A plataforma já avisou da transferência. Não escreva mais nada depois disso.`,
      };
    },
  },

  encerrar_atendimento: {
    descricao: 'Encerra o atendimento quando a dúvida foi resolvida e o cliente não precisa de mais nada. '
      + 'Não use se houver qualquer pendência, nem para se livrar de um pedido difícil — nesse caso transfira.',
    entrada: esquema({
      resumo: txt('O que o cliente queria e como foi resolvido, em uma ou duas frases.'),
      despedida: txtOuNulo('Mensagem final para o cliente. Use null para a mensagem padrão da empresa.'),
    }, ['resumo', 'despedida']),
    terminal: true,
    executar: ({ db, conversa, entrada }) => {
      db.prepare('UPDATE conversas SET resumo = COALESCE(?, resumo), assunto = COALESCE(assunto, ?) WHERE id = ?')
        .run(String(entrada.resumo).slice(0, 2000), String(entrada.resumo).slice(0, 120), conversa.id);
      conversas.encerrar(db, db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id), {
        resolvidaPor: 'ia', mensagem: entrada.despedida ?? null,
      });
      return { controle: 'encerrada', ok: true, mensagem: 'O atendimento foi encerrado e o cliente avisado. Não escreva mais nada.' };
    },
  },
};

/** Protocolo do chamado: AAAAMM-00001 por empresa. */
function gerarProtocolo(db, empresaId) {
  const prefixo = new Date().toISOString().slice(0, 7).replace('-', '');
  const usados = Number(db.prepare("SELECT COUNT(*) AS n FROM chamados WHERE empresa_id = ? AND protocolo LIKE ?").all(empresaId, `${prefixo}-%`)[0].n);
  for (let i = 1; i <= 50; i++) {
    const p = `${prefixo}-${String(usados + i).padStart(5, '0')}`;
    if (!db.prepare('SELECT 1 FROM chamados WHERE empresa_id = ? AND protocolo = ?').get(empresaId, p)) return p;
  }
  return `${prefixo}-${Date.now().toString().slice(-6)}`;
}

// ---------- Ferramentas da empresa (HTTP) ----------

/**
 * Chama a API do cliente (ERP, CRM, central de faturas). Os parâmetros vêm do modelo; o bloco `contato`
 * é montado aqui, do banco, para o sistema da empresa saber de quem se trata sem depender do modelo.
 */
async function executarExterna(ferramenta, { contato, conversa, entrada }) {
  const cabecalhos = JSON.parse(decifrar(ferramenta.cabecalhos_cifrados, 'ferramenta') ?? '{}');
  const corpo = {
    ...entrada,
    contato: {
      telefone: contato.telefone,
      nome: contato.nome ?? contato.nome_perfil ?? null,
      documento: contato.documento ?? null,
      email: contato.email ?? null,
      codigo_externo: contato.codigo_externo ?? null,
    },
    conversa_id: conversa.id,
  };
  let url = ferramenta.url;
  let body;
  if (ferramenta.metodo === 'GET') {
    const u = new URL(url);
    for (const [k, val] of Object.entries(entrada ?? {})) if (val !== null && val !== undefined) u.searchParams.set(k, String(val));
    u.searchParams.set('telefone', contato.telefone);
    if (contato.documento) u.searchParams.set('documento', contato.documento);
    url = u.toString();
  } else {
    body = JSON.stringify(corpo);
  }
  let resp;
  try {
    resp = await fetch(url, {
      method: ferramenta.metodo,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...cabecalhos },
      body,
      signal: AbortSignal.timeout(ferramenta.timeout_ms),
    });
  } catch (err) {
    return { ok: false, erro: `O sistema da empresa não respondeu (${err.name === 'TimeoutError' ? 'tempo esgotado' : err.message}). Avise o cliente e transfira para um atendente.` };
  }
  const texto = (await resp.text()).slice(0, 8000);
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { resposta: texto }; }
  if (!resp.ok) return { ok: false, status: resp.status, erro: dados?.erro ?? dados?.error ?? `O sistema da empresa respondeu ${resp.status}.`, dados };
  return { ok: true, dados: dados ?? {} };
}

/** Converte a ferramenta cadastrada no formato de tool da Claude API. */
function comoTool(f) {
  let parametros;
  try { parametros = JSON.parse(f.parametros); } catch { parametros = null; }
  if (!parametros || parametros.type !== 'object') parametros = { type: 'object', properties: {}, required: [] };
  return {
    name: f.nome,
    description: f.descricao,
    input_schema: { ...parametros, additionalProperties: false, required: parametros.required ?? Object.keys(parametros.properties ?? {}) },
    strict: true,
  };
}

// ---------- Montagem ----------

/**
 * Lista das ferramentas disponíveis nesta conversa, no formato da Claude API, e o executor.
 * `semTransferencia` tira a transferência quando a empresa não tem fila cadastrada.
 */
function montar(db, { empresaId, semTransferencia = false }) {
  const externas = db.prepare('SELECT * FROM ferramentas WHERE empresa_id = ? AND ativa = 1 ORDER BY nome').all(empresaId);
  // Sem alerta em vigor, a ferramenta de alertas sai do kit: ela só responderia "não há nada",
  // e toda descrição de ferramenta custa token em toda conversa.
  const temAlerta = alertas.vigentes(db, empresaId).length > 0;
  const internas = Object.entries(INTERNAS).filter(([nome]) => {
    if (semTransferencia && nome === 'transferir_para_humano') return false;
    if (nome === 'alertas_da_regiao' && !temAlerta) return false;
    return true;
  });
  // As do IXC entram quando a integração está ligada; só as capacidades que a sonda aprovou na instância.
  const doIxc = ixc.montar(db, empresaId);
  const tools = [
    ...internas.map(([nome, f]) => ({ name: nome, description: f.descricao, input_schema: f.entrada, strict: true })),
    ...doIxc.tools,
    ...externas.map(comoTool),
  ];
  const porNome = new Map([
    ...internas.map(([nome, f]) => [nome, { tipo: 'interna', def: f }]),
    ...doIxc.porNome,
    ...externas.map((f) => [f.nome, { tipo: 'externa', def: f }]),
  ]);
  return { tools, porNome };
}

/** Executa a ferramenta escolhida pelo modelo. Devolve { resultado, terminal, erro }. */
async function executar(nome, entrada, contexto) {
  const alvo = contexto.ferramentas.porNome.get(nome);
  if (!alvo) return { resultado: { ok: false, erro: `Ferramenta "${nome}" não existe.` }, terminal: false };
  try {
    if (alvo.tipo === 'interna') {
      const resultado = await alvo.def.executar({ ...contexto, entrada });
      return { resultado, terminal: Boolean(alvo.def.terminal) && resultado?.ok !== false };
    }
    if (alvo.tipo === 'ixc') {
      return { resultado: await ixc.executar(alvo.def, { ...contexto, entrada }), terminal: false };
    }
    contexto.db.prepare('UPDATE ferramentas SET usos = usos + 1 WHERE id = ?').run(alvo.def.id);
    return { resultado: await executarExterna(alvo.def, { ...contexto, entrada }), terminal: false };
  } catch (err) {
    return { resultado: { ok: false, erro: `Falha ao executar ${nome}: ${err.message}` }, terminal: false, erro: err };
  }
}

module.exports = { INTERNAS, montar, executar, comoTool, executarExterna, gerarProtocolo, ixc };
