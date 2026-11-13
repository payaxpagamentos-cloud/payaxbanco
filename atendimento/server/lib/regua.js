'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { local, hoje, somarDias } = require('./datas');
const conversas = require('./conversas');
const envio = require('./envio');
const custo = require('./custo');
const wa = require('./whatsapp');
const ixcTools = require('../ia/ferramentas-ixc');
const v = require('./validacao');

/**
 * A régua de mensagens ativas — e o lugar onde a conta da Meta é decidida.
 *
 * Toda mensagem que a empresa INICIA é cobrada. Então, antes de mandar qualquer uma, a régua
 * pergunta cinco coisas, nesta ordem, e cada "sim" economiza o preço de um template:
 *
 *   1. O cliente pediu para não receber mensagem ativa?           → pula
 *   2. Ele já pagou esta fatura?                                   → pula (confere no IXC na hora)
 *   3. Ele já está conversando com a equipe agora?                 → pula (não atropela o atendimento)
 *   4. Já mandamos isso para ele há poucos dias?                   → pula
 *   5. A janela de 24 h dele está aberta?                          → manda TEXTO LIVRE, de graça
 *   senão                                                          → manda o template, e aí sim paga
 *
 * Cada decisão vira uma linha em `disparos` com o quanto custou e o quanto deixou de custar, para a
 * empresa ver no fim do mês de onde veio a economia — e para ninguém precisar acreditar na promessa.
 */

const CAMPOS = {
  nome: (d) => d.nome ?? '',
  primeiro_nome: (d) => String(d.nome ?? '').trim().split(/\s+/)[0] ?? '',
  vencimento: (d) => (d.vencimento ? d.vencimento.split('-').reverse().join('/') : ''),
  valor: (d) => ((d.valor_centavos ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
  dias_atraso: (d) => String(d.dias_atraso ?? 0),
  plano: (d) => d.plano ?? '',
  empresa: (d) => d.empresa ?? '',
  protocolo: (d) => d.protocolo ?? '',
};

const listarCampos = () => Object.keys(CAMPOS);

/** Preenche os parâmetros do template (um campo por linha) com os dados do destinatário. */
const montarParametros = (regua, dados) => String(regua.parametros ?? '')
  .split('\n').map((x) => x.trim()).filter(Boolean)
  .map((campo) => (CAMPOS[campo] ? CAMPOS[campo](dados) : campo));

/** Troca {campo} no texto da janela pelos mesmos dados. */
const preencherTexto = (texto, dados) => String(texto ?? '').replace(/\{(\w+)\}/g, (todo, c) => (CAMPOS[c] ? CAMPOS[c](dados) : todo));

const buscar = (db, empresaId, id) => {
  const r = db.prepare('SELECT * FROM reguas WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!r) throw naoEncontrado('Régua');
  return r;
};

const listar = (db, empresaId) => db.prepare(`SELECT r.*,
    (SELECT COUNT(*) FROM disparos d WHERE d.regua_id = r.id AND d.status = 'enviado') AS enviados,
    (SELECT COUNT(*) FROM disparos d WHERE d.regua_id = r.id AND d.status = 'pulado') AS pulados,
    (SELECT COALESCE(SUM(custo_milesimos), 0) FROM disparos d WHERE d.regua_id = r.id) AS custo_milesimos,
    (SELECT COALESCE(SUM(economia_milesimos), 0) FROM disparos d WHERE d.regua_id = r.id) AS economia_milesimos
  FROM reguas r WHERE r.empresa_id = ? ORDER BY r.ativa DESC, r.nome`).all(empresaId)
  .map((r) => ({ ...r, ativa: Boolean(r.ativa), preferir_janela: Boolean(r.preferir_janela),
    pular_se_conversa_aberta: Boolean(r.pular_se_conversa_aberta), pular_se_pago: Boolean(r.pular_se_pago) }));

/** A data de vencimento que esta régua procura hoje. */
function dataAlvo(regua, referencia = hoje()) {
  if (regua.gatilho === 'no_vencimento') return referencia;
  if (regua.gatilho === 'dias_antes_vencimento') return somarDias(referencia, Number(regua.dias));
  if (regua.gatilho === 'dias_apos_vencimento') return somarDias(referencia, -Number(regua.dias));
  return null;
}

/** Já mandamos esta régua para este contato nos últimos N dias? */
function jaMandou(db, regua, contatoId) {
  if (!regua.repetir_apos_dias) return false;
  const corte = new Date(Date.now() - Number(regua.repetir_apos_dias) * 86_400_000).toISOString();
  return Boolean(db.prepare(`SELECT 1 FROM disparos WHERE regua_id = ? AND contato_id = ? AND status = 'enviado' AND criado_em >= ?`)
    .get(regua.id, contatoId, corte));
}

/**
 * Busca no IXC quem a régua deve alcançar hoje e junta os dados de cada um.
 * Devolve [{ cliente_id, fatura_id, nome, telefone, vencimento, valor_centavos, ... }].
 */
async function destinatarios(db, empresa, regua, { referencia = hoje(), limite = 5000 } = {}) {
  if (regua.gatilho === 'manual') return [];
  const ixc = ixcTools.clienteIxc(db, empresa.id);
  if (!ixc) throw new ErroNegocio('A régua de cobrança precisa da integração com o IXC ligada.');
  const data = dataAlvo(regua, referencia);
  const faturas = (await ixc.faturasComVencimento(data)).slice(0, limite);

  const lista = [];
  for (const f of faturas) {
    // O cadastro traz o telefone; o cache do cliente IXC evita repetir a consulta do mesmo cliente.
    let cadastro = null;
    try { cadastro = await ixc.clientePorId(f.cliente_id); } catch { cadastro = null; }
    if (!cadastro) continue;
    const telefone = ['telefone_celular', 'whatsapp', 'fone']
      .map((k) => require('../ia/ixc').telefoneNacional(cadastro[k]))
      .find((t) => t.length >= 10);
    if (!telefone) continue;
    lista.push({
      fatura_id: f.id,
      cliente_id: f.cliente_id,
      nome: cadastro.razao ?? cadastro.fantasia ?? null,
      telefone: telefone.length <= 11 ? `55${telefone}` : telefone,
      vencimento: f.vencimento,
      valor_centavos: f.valor_centavos,
      dias_atraso: regua.gatilho === 'dias_apos_vencimento' ? Number(regua.dias) : 0,
      empresa: empresa.nome,
    });
  }
  return lista;
}

/**
 * Decide o que fazer com um destinatário, SEM mandar nada.
 * É a mesma função usada na simulação e no envio de verdade — o que o painel mostra é o que acontece.
 */
function decidir(db, empresa, regua, alvo, { precos }) {
  const contato = db.prepare('SELECT * FROM contatos WHERE empresa_id = ? AND telefone = ?').get(empresa.id, alvo.telefone);
  const precoTemplate = precos[regua.categoria] ?? 0;

  if (contato?.bloqueado) return { acao: 'pular', motivo: 'contato bloqueado', economia: precoTemplate, contato };
  if (contato && !contato.aceita_ativo) return { acao: 'pular', motivo: 'o cliente pediu para não receber mensagens ativas', economia: precoTemplate, contato };
  if (contato && jaMandou(db, regua, contato.id)) {
    return { acao: 'pular', motivo: `já recebeu esta régua nos últimos ${regua.repetir_apos_dias} dias`, economia: precoTemplate, contato };
  }
  const aberta = contato ? conversas.abertaDoContato(db, contato.id) : null;
  if (regua.pular_se_conversa_aberta && aberta && aberta.estado !== 'bot') {
    return { acao: 'pular', motivo: 'o cliente já está em atendimento com a equipe', economia: precoTemplate, contato, conversa: aberta };
  }
  // A janela de 24 h aberta é a economia mais limpa que existe: o mesmo aviso, de graça.
  if (regua.preferir_janela && aberta && wa.janelaAberta(aberta) && regua.texto_janela?.trim()) {
    return { acao: 'janela', motivo: 'a janela de 24 h está aberta: vai como serviço, sem custo', economia: precoTemplate, contato, conversa: aberta };
  }
  return { acao: 'template', motivo: null, custo: precoTemplate, contato, conversa: aberta };
}

/**
 * Simula a régua: quantos seriam alcançados, quanto custaria e quanto a régua economiza.
 * Nada é enviado e nada é gravado.
 */
async function simular(db, empresa, regua, { referencia = hoje(), limite = 5000 } = {}) {
  const precos = custo.precos(db);
  const alvos = await destinatarios(db, empresa, regua, { referencia, limite });
  const contagem = { template: 0, janela: 0, pular: 0 };
  const motivos = new Map();
  let gasto = 0;
  let economia = 0;
  for (const alvo of alvos) {
    const d = decidir(db, empresa, regua, alvo, { precos });
    contagem[d.acao]++;
    gasto += d.custo ?? 0;
    economia += d.economia ?? 0;
    if (d.motivo) motivos.set(d.motivo, (motivos.get(d.motivo) ?? 0) + 1);
  }
  return {
    data_alvo: dataAlvo(regua, referencia),
    alcancaveis: alvos.length,
    vao_receber: contagem.template + contagem.janela,
    por_template: contagem.template,
    pela_janela: contagem.janela,
    pulados: contagem.pular,
    motivos: [...motivos.entries()].map(([motivo, quantos]) => ({ motivo, quantos })).sort((a, b) => b.quantos - a.quantos),
    custo_milesimos: gasto,
    economia_milesimos: economia,
    // O que custaria mandar template para todo mundo, sem nenhuma das decisões.
    sem_otimizacao_milesimos: alvos.length * (precos[regua.categoria] ?? 0),
    teto_estourado: Boolean(regua.teto_milesimos && gasto > regua.teto_milesimos),
  };
}

/** Executa a régua de verdade: envia, grava cada decisão e respeita o teto de gasto. */
async function executar(db, empresa, regua, { referencia = hoje(), limite = 5000, usuario = null } = {}) {
  if (!regua.ativa && !usuario) throw new ErroNegocio('Esta régua está desligada.');
  const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ? AND ativo = 1 ORDER BY id LIMIT 1').get(empresa.id);
  if (!numero) throw new ErroNegocio('A empresa não tem número de WhatsApp ativo.');

  const precos = custo.precos(db);
  const ixc = ixcTools.clienteIxc(db, empresa.id);
  const alvos = await destinatarios(db, empresa, regua, { referencia, limite });
  const resultado = { enviados: 0, pela_janela: 0, pulados: 0, falhas: 0, custo_milesimos: 0, economia_milesimos: 0, teto_atingido: false };

  for (const alvo of alvos) {
    // Confere no IXC se a fatura continua em aberto: cobrar quem já pagou custa dinheiro e irrita.
    if (regua.pular_se_pago && alvo.fatura_id) {
      let aberta = null;
      try { aberta = await ixc.faturaEmAberto(alvo.fatura_id); } catch { aberta = null; }
      if (aberta === false) {
        registrar(db, { empresa, regua, alvo, status: 'pulado', motivo: 'a fatura já foi paga', economia: precos[regua.categoria] ?? 0 });
        resultado.pulados++;
        resultado.economia_milesimos += precos[regua.categoria] ?? 0;
        continue;
      }
    }

    const d = decidir(db, empresa, regua, alvo, { precos });
    if (d.acao === 'pular') {
      registrar(db, { empresa, regua, alvo, contato: d.contato, status: 'pulado', motivo: d.motivo, economia: d.economia });
      resultado.pulados++;
      resultado.economia_milesimos += d.economia;
      continue;
    }

    // Teto de gasto: para antes de estourar, em vez de avisar depois.
    const vaiCustar = d.acao === 'template' ? (precos[regua.categoria] ?? 0) : 0;
    if (regua.teto_milesimos && resultado.custo_milesimos + vaiCustar > regua.teto_milesimos) {
      resultado.teto_atingido = true;
      break;
    }

    try {
      const enviado = transacao(db, () => {
        const contato = d.contato ?? conversas.garantirContato(db, empresa.id, alvo.telefone, null);
        db.prepare('UPDATE contatos SET codigo_externo = COALESCE(codigo_externo, ?), nome = COALESCE(nome, ?) WHERE id = ?')
          .run(alvo.cliente_id, alvo.nome, contato.id);
        const conversa = d.conversa ?? conversas.abertaDoContato(db, contato.id) ?? abrirParaAviso(db, { empresa, numero, contato, regua });
        const atual = db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);

        const mensagemId = d.acao === 'janela'
          ? envio.enfileirar(db, atual, { autor: 'sistema', tipo: 'texto', texto: preencherTexto(regua.texto_janela, alvo) })
          : (() => {
            const corpo = wa.corpos.template('', regua.template, regua.idioma, montarParametros(regua, alvo));
            const { to: _to, recipient_type: _rt, ...payload } = corpo;
            return envio.enfileirar(db, atual, {
              autor: 'sistema', tipo: 'template', texto: `[${regua.nome}] template ${regua.template}`,
              payload, categoriaTemplate: regua.categoria,
            });
          })();
        return { contato, conversa: atual, mensagemId };
      });

      const categoria = db.prepare('SELECT categoria, custo_milesimos FROM mensagens WHERE id = ?').get(enviado.mensagemId);
      registrar(db, {
        empresa, regua, alvo, contato: enviado.contato, conversa: enviado.conversa, mensagemId: enviado.mensagemId,
        status: 'enviado', categoria: categoria.categoria, custo: categoria.custo_milesimos,
        motivo: d.acao === 'janela' ? d.motivo : null,
        economia: d.acao === 'janela' ? d.economia : 0,
      });
      resultado.enviados++;
      if (d.acao === 'janela') { resultado.pela_janela++; resultado.economia_milesimos += d.economia; }
      resultado.custo_milesimos += Number(categoria.custo_milesimos);
    } catch (err) {
      registrar(db, { empresa, regua, alvo, contato: d.contato, status: 'falhou', motivo: String(err.message).slice(0, 300) });
      resultado.falhas++;
    }
  }

  db.prepare('UPDATE reguas SET ultima_execucao_em = ? WHERE id = ?').run(agora(), regua.id);
  envio.girar(db);
  return resultado;
}

/** Conversa aberta só para o aviso: nasce com a equipe, não com a ZOE (aviso não é atendimento). */
function abrirParaAviso(db, { empresa, numero, contato, regua }) {
  const c = conversas.abrir(db, { empresa, numero, contato });
  db.prepare("UPDATE conversas SET estado = 'aguardando', janela_expira_em = NULL, assunto = ? WHERE id = ?").run(regua.nome.slice(0, 160), c.id);
  const fila = require('./filas').filaPadrao(db, empresa.id);
  if (fila) db.prepare('UPDATE conversas SET fila_id = ?, transferida_em = ? WHERE id = ?').run(fila.id, agora(), c.id);
  envio.registrarSistema(db, c, `Conversa aberta pela régua "${regua.nome}".`);
  return db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id);
}

const registrar = (db, { empresa, regua, alvo, contato = null, conversa = null, mensagemId = null, status, motivo = null, categoria = null, custo: c = 0, economia = 0 }) =>
  db.prepare(`INSERT INTO disparos (empresa_id, regua_id, contato_id, conversa_id, mensagem_id, referencia, categoria, status, motivo, custo_milesimos, economia_milesimos, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(empresa.id, regua.id, contato?.id ?? null, conversa?.id ?? null, mensagemId, alvo?.fatura_id ?? null,
      categoria, status, motivo, c, economia, agora());

/** As réguas que devem rodar agora (hora e dia da semana batendo, e ainda não rodaram hoje). */
function devemRodar(db, instante = new Date()) {
  const l = local(instante);
  const agoraMin = l.hora * 60 + l.minuto;
  return db.prepare(`SELECT r.*, e.nome AS empresa_nome FROM reguas r JOIN empresas e ON e.id = r.empresa_id
    WHERE r.ativa = 1 AND e.status = 'ativa' AND r.gatilho <> 'manual'`).all()
    .filter((r) => {
      if (r.dias_semana[l.diaSemana] !== '1') return false;
      const [h, m] = r.hora.split(':').map(Number);
      const alvoMin = h * 60 + m;
      // Janela de 10 minutos a partir da hora marcada, e só uma vez por dia.
      if (agoraMin < alvoMin || agoraMin > alvoMin + 10) return false;
      return !r.ultima_execucao_em || r.ultima_execucao_em.slice(0, 10) < l.data;
    });
}

/** Relatório de uma régua: o que ela fez e o que ela poupou. */
function historico(db, empresaId, reguaId, { limite = 200 } = {}) {
  const r = buscar(db, empresaId, reguaId);
  return {
    regua: r,
    disparos: db.prepare(`SELECT d.*, ct.telefone, COALESCE(ct.nome, ct.nome_perfil) AS contato_nome
      FROM disparos d LEFT JOIN contatos ct ON ct.id = d.contato_id
      WHERE d.regua_id = ? ORDER BY d.id DESC LIMIT ?`).all(r.id, limite),
    por_motivo: db.prepare(`SELECT status, COALESCE(motivo, '—') AS motivo, COUNT(*) AS quantos,
        SUM(custo_milesimos) AS custo, SUM(economia_milesimos) AS economia
      FROM disparos WHERE regua_id = ? GROUP BY status, motivo ORDER BY quantos DESC`).all(r.id),
  };
}

function salvar(db, empresaId, dados, { id = null } = {}) {
  const atual = id ? buscar(db, empresaId, id) : {};
  const d = dados ?? {};
  const bool = (k, padrao) => (d[k] === undefined ? (atual[k] ?? padrao) : (v.booleano(d[k]) ? 1 : 0));
  const campos = {
    nome: d.nome === undefined ? atual.nome : v.texto(d.nome, 'o nome da régua', 80),
    tipo: d.tipo === undefined ? (atual.tipo ?? 'cobranca') : v.opcao(d.tipo, 'o tipo', ['cobranca', 'manutencao', 'aviso', 'campanha']),
    categoria: d.categoria === undefined ? (atual.categoria ?? 'utilidade') : v.opcao(d.categoria, 'a categoria', ['utilidade', 'marketing', 'autenticacao']),
    template: d.template === undefined ? atual.template : v.texto(d.template, 'o nome do template', 120),
    idioma: d.idioma === undefined ? (atual.idioma ?? 'pt_BR') : v.texto(d.idioma, 'o idioma', 10),
    parametros: d.parametros === undefined ? atual.parametros : (v.lista(d.parametros, 'os parâmetros', { max: 10 }).join('\n') || null),
    texto_janela: d.texto_janela === undefined ? atual.texto_janela : v.opcional(d.texto_janela, 'o texto da janela', 4096),
    gatilho: d.gatilho === undefined ? (atual.gatilho ?? 'dias_antes_vencimento') : v.opcao(d.gatilho, 'o gatilho', ['dias_antes_vencimento', 'no_vencimento', 'dias_apos_vencimento', 'manual']),
    dias: d.dias === undefined ? (atual.dias ?? 3) : v.inteiro(d.dias, 'os dias', { min: 0, max: 180 }),
    hora: d.hora === undefined ? (atual.hora ?? '09:00') : v.horario(d.hora, 'a hora do disparo'),
    dias_semana: d.dias_semana === undefined ? (atual.dias_semana ?? '0111110') : v.diasSemana(d.dias_semana),
    preferir_janela: bool('preferir_janela', 1),
    pular_se_conversa_aberta: bool('pular_se_conversa_aberta', 1),
    pular_se_pago: bool('pular_se_pago', 1),
    repetir_apos_dias: d.repetir_apos_dias === undefined ? (atual.repetir_apos_dias ?? 5) : v.inteiro(d.repetir_apos_dias, 'o intervalo entre repetições', { min: 0, max: 365 }),
    teto_milesimos: d.teto_milesimos === undefined ? (atual.teto_milesimos ?? 0) : v.inteiro(d.teto_milesimos, 'o teto de gasto', { min: 0, max: 100_000_000 }),
    ativa: bool('ativa', 0),
  };
  v.exigir(campos.nome && campos.template, 'Informe o nome da régua e o template aprovado na Meta.');
  if (campos.preferir_janela) v.exigir(campos.texto_janela, 'Para usar a janela de 24 h, escreva o texto livre equivalente — é ele que sai de graça.');

  const colunas = Object.keys(campos);
  if (id) {
    db.prepare(`UPDATE reguas SET ${colunas.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...colunas.map((k) => campos[k]), atual.id);
    return buscar(db, empresaId, atual.id);
  }
  const novo = Number(db.prepare(`INSERT INTO reguas (empresa_id, ${colunas.join(', ')}, criada_em) VALUES (?, ${colunas.map(() => '?').join(', ')}, ?)`)
    .run(empresaId, ...colunas.map((k) => campos[k]), agora()).lastInsertRowid);
  return buscar(db, empresaId, novo);
}

module.exports = { CAMPOS, listarCampos, listar, buscar, salvar, simular, executar, decidir, destinatarios, dataAlvo, devemRodar, historico, montarParametros, preencherTexto };
