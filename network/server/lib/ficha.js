'use strict';

const { diasEntre, somarDias, dataBr } = require('./datas');
const { pode } = require('./permissoes');
const fat = require('./faturamento');
const cob = require('./cobranca');
const prov = require('./provisionamento');

/*
 * Ficha do assinante: tudo que se sabe sobre um cliente, numa resposta só.
 *
 * Por que uma resposta só: quem atende precisa do todo ao mesmo tempo — "ele pagou?", "está cortado?",
 * "qual o login dele?", "abriu chamado?" são a mesma conversa. Buscar isso em seis telas faz o atendente
 * perder o fio e o assinante esperar. A tela troca de aba sem ir ao servidor de novo.
 *
 * O que entra depende do perfil de quem pediu: faturas e cobrança exigem as permissões do financeiro,
 * serviço e contrato as de contrato, chamados as de chamado. O que ficou de fora vem declarado em
 * `secoes_ocultas`, para a tela dizer "você não tem acesso a isso" em vez de mostrar uma aba vazia.
 */

const ABERTAS = ['aberta', 'parcial'];
const LIMITE_FATURAS = 60;
const LIMITE_LINHA = 120;

/** Evento da linha do tempo unificada. */
const evento = (em, tipo, titulo, detalhe = null, { origem = null, usuario = null, contrato = null, gravidade = null } = {}) =>
  ({ em, tipo, titulo, detalhe, origem, usuario, contrato, gravidade });

/**
 * Monta a ficha. `perfil` decide o que entra; `hoje` é a data no fuso da operação.
 */
function montar(db, { org, assinante, perfil, hoje }) {
  const organizacao = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(org);
  const podeContratos = pode(perfil, 'contratos.ver');
  const podeFaturas = pode(perfil, 'faturamento.ver');
  const podeCobranca = pode(perfil, 'cobranca.ver');
  const podeChamados = pode(perfil, 'chamados.ver');
  const ocultas = [];
  if (!podeContratos) ocultas.push('contratos');
  if (!podeFaturas) ocultas.push('financeiro');
  if (!podeCobranca) ocultas.push('cobranca');
  if (!podeChamados) ocultas.push('atendimentos');

  const linha = [];
  const contratos = podeContratos ? contratosDo(db, assinante, hoje, linha) : [];
  const financeiro = podeFaturas ? financeiroDo(db, assinante, organizacao, hoje, linha) : null;
  const cobranca = podeCobranca ? cobrancaDo(db, assinante, hoje, linha) : null;
  const chamados = podeChamados ? chamadosDo(db, org, assinante, contratos, linha) : [];

  return {
    ...assinante,
    resumo: resumo(db, { assinante, contratos, financeiro, hoje, podeContratos, podeFaturas }),
    contratos,
    financeiro,
    cobranca,
    chamados,
    linha_tempo: linha.filter((x) => x.em).sort((a, b) => String(b.em).localeCompare(String(a.em))).slice(0, LIMITE_LINHA),
    secoes_ocultas: ocultas,
  };
}

/** Indicadores do topo: o que decide a conversa nos primeiros cinco segundos. */
function resumo(db, { assinante, contratos, financeiro, hoje, podeContratos, podeFaturas }) {
  const vivos = contratos.filter((c) => c.situacao !== 'cancelado');
  const bloqueados = vivos.filter((c) => c.situacao === 'bloqueado');
  const r = {
    cliente_desde: contratos.length ? contratos.map((c) => c.ativacao ?? c.criado_em.slice(0, 10)).filter(Boolean).sort()[0] ?? null : null,
    contratos_vivos: podeContratos ? vivos.length : null,
    contratos_bloqueados: podeContratos ? bloqueados.length : null,
    contratos_cancelados: podeContratos ? contratos.length - vivos.length : null,
    mensalidade_centavos: podeContratos ? vivos.filter((c) => c.situacao !== 'suspenso').reduce((s, c) => s + c.mensalidade_centavos, 0) : null,
    servico: null,
  };
  if (podeContratos) {
    // Uma frase sobre o serviço: é o que o atendente precisa dizer antes de qualquer outra coisa.
    r.servico = !vivos.length ? 'Sem contrato em vigor'
      : bloqueados.length === vivos.length ? 'Serviço bloqueado'
        : bloqueados.length ? `${bloqueados.length} de ${vivos.length} contrato(s) bloqueado(s)`
          : vivos.every((c) => c.situacao === 'suspenso') ? 'Suspenso a pedido'
            : vivos.some((c) => c.situacao === 'em_implantacao') ? 'Em implantação'
              : 'Serviço ativo';
  }
  if (podeFaturas && financeiro) {
    r.saldo_centavos = financeiro.posicao.saldo_centavos;
    r.devido_centavos = financeiro.posicao.devido_centavos;
    r.vencidas = financeiro.posicao.vencidas;
    r.atraso_dias = financeiro.posicao.atraso_dias;
    r.ultimo_pagamento = financeiro.pagamentos.find((p) => !p.estornado_em) ?? null;
    r.proxima_fatura = financeiro.faturas.filter((f) => ABERTAS.includes(f.situacao) && f.vencimento >= hoje)
      .sort((a, b) => a.vencimento.localeCompare(b.vencimento))[0] ?? null;
  }
  return r;
}

/** Contratos com tudo que pende deles: itens, serviço no equipamento, bloqueio, confiança e eventos. */
function contratosDo(db, assinante, hoje, linha) {
  const lista = db.prepare(`SELECT c.*, p.nome AS plano_nome, p.tipo AS plano_tipo, p.download_mbps, p.upload_mbps, p.fidelidade_meses,
      ar.codigo AS cto_codigo, ar.bairro AS cto_bairro, pr.numero AS porta_numero
    FROM contratos c JOIN planos p ON p.id = c.plano_id
    LEFT JOIN ativos_rede ar ON ar.id = c.cto_id LEFT JOIN portas_rede pr ON pr.id = c.porta_id
    WHERE c.assinante_id = ? ORDER BY (c.situacao = 'cancelado'), c.numero DESC`).all(assinante.id);

  return lista.map((c) => {
    const eventos = db.prepare(`SELECT e.*, u.nome AS usuario_nome FROM contrato_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id
      WHERE e.contrato_id = ? ORDER BY e.id DESC LIMIT 40`).all(c.id);
    for (const e of eventos) {
      linha.push(evento(e.criado_em, `contrato_${e.evento}`, rotuloEvento(e.evento), e.motivo,
        { origem: e.origem, usuario: e.usuario_nome, contrato: c.numero, gravidade: ['bloqueado', 'cancelado'].includes(e.evento) ? 'alta' : null }));
    }
    const servicoBruto = db.prepare('SELECT * FROM servicos WHERE contrato_id = ?').get(c.id);
    let servico = null;
    if (servicoBruto) {
      const d = prov.desejado(db, servicoBruto);
      const real = servicoBruto.estado_real ? JSON.parse(servicoBruto.estado_real) : null;
      servico = { ...prov.publico(servicoBruto), desejado: prov.desejadoPublico(d), divergencias: prov.divergencias(d, real, servicoBruto.lido_em),
        concentrador_nome: servicoBruto.concentrador_id ? db.prepare('SELECT nome FROM equipamentos WHERE id = ?').get(servicoBruto.concentrador_id)?.nome ?? null : null };
    }
    return {
      ...c,
      posicao: fat.posicaoDoContrato(db, c.id, hoje),
      bloqueio: cob.bloqueioAberto(db, c.id) ?? null,
      confianca: cob.confiancaVigente(db, c.id, hoje) ?? null,
      itens: db.prepare('SELECT * FROM contrato_itens WHERE contrato_id = ? ORDER BY id').all(c.id),
      servico,
      eventos,
      fidelidade_em_curso: Boolean(c.fidelidade_fim && c.fidelidade_fim > hoje && c.situacao !== 'cancelado'),
    };
  });
}

/** Faturas com itens e baixas, posição consolidada e os pagamentos do assinante. */
function financeiroDo(db, assinante, organizacao, hoje, linha) {
  const faturas = db.prepare(`SELECT f.*, c.numero AS contrato_numero FROM faturas f LEFT JOIN contratos c ON c.id = f.contrato_id
    WHERE f.assinante_id = ? ORDER BY f.vencimento DESC, f.id DESC LIMIT ?`).all(assinante.id, LIMITE_FATURAS);
  const itens = db.prepare('SELECT * FROM fatura_itens WHERE fatura_id = ? ORDER BY id');
  const baixas = db.prepare(`SELECT pg.*, u.nome AS criado_por_nome, e.nome AS estornado_por_nome FROM pagamentos pg
    LEFT JOIN usuarios u ON u.id = pg.criado_por LEFT JOIN usuarios e ON e.id = pg.estornado_por WHERE pg.fatura_id = ? ORDER BY pg.id DESC`);

  const pagamentos = [];
  const completas = faturas.map((f) => {
    const pgs = baixas.all(f.id);
    for (const p of pgs) {
      pagamentos.push({ ...p, fatura_numero: f.numero });
      linha.push(evento(p.criado_em, p.estornado_em ? 'pagamento_estornado' : 'pagamento',
        p.estornado_em ? `Baixa estornada na fatura ${f.numero}` : `Pagamento da fatura ${f.numero}`,
        `R$ ${(p.valor_centavos / 100).toFixed(2).replace('.', ',')} · ${p.forma} · ${dataBr(p.data)}${p.motivo_estorno ? ` · ${p.motivo_estorno}` : ''}`,
        { usuario: p.criado_por_nome, origem: p.origem }));
    }
    linha.push(evento(f.criado_em, 'fatura', `Fatura ${f.numero} emitida`,
      `R$ ${(f.valor_centavos / 100).toFixed(2).replace('.', ',')} · vence ${dataBr(f.vencimento)}`, { contrato: f.contrato_numero }));
    return { ...f, encargos: fat.encargos(f, organizacao, hoje), itens: itens.all(f.id), pagamentos: pgs };
  });

  const abertas = completas.filter((f) => ABERTAS.includes(f.situacao));
  const vencidas = abertas.filter((f) => f.vencimento < hoje);
  return {
    faturas: completas,
    pagamentos: pagamentos.sort((a, b) => b.id - a.id),
    posicao: {
      saldo_centavos: abertas.reduce((s, f) => s + (f.valor_centavos - f.pago_centavos), 0),
      devido_centavos: abertas.reduce((s, f) => s + f.encargos.total_devido_centavos, 0),
      abertas: abertas.length,
      vencidas: vencidas.length,
      atraso_dias: vencidas.length ? Math.max(...vencidas.map((f) => diasEntre(f.vencimento, hoje))) : 0,
      pago_12_meses_centavos: pagamentos.filter((p) => !p.estornado_em && p.data >= somarDias(hoje, -365)).reduce((s, p) => s + p.valor_centavos, 0),
    },
    // Para a tela poder emitir avulsa e dar baixa sem sair daqui.
    tem_limite: completas.length >= LIMITE_FATURAS,
  };
}

/** Bloqueios, confianças e o que a régua já fez com este assinante. */
function cobrancaDo(db, assinante, hoje, linha) {
  const bloqueios = db.prepare(`SELECT b.*, c.numero AS contrato_numero, u.nome AS criado_por_nome, l.nome AS liberado_por_nome, rr.nome AS regra_nome,
      f.numero AS fatura_numero FROM bloqueios b JOIN contratos c ON c.id = b.contrato_id
    LEFT JOIN usuarios u ON u.id = b.criado_por LEFT JOIN usuarios l ON l.id = b.liberado_por
    LEFT JOIN regua_regras rr ON rr.id = b.regra_id LEFT JOIN faturas f ON f.id = b.fatura_id
    WHERE c.assinante_id = ? ORDER BY b.id DESC LIMIT 40`).all(assinante.id);
  const confiancas = db.prepare(`SELECT cf.*, c.numero AS contrato_numero, u.nome AS concedida_por_nome,
      CASE WHEN cf.encerrada_em IS NULL AND cf.ate >= ? THEN 'vigente' WHEN cf.encerrada_em IS NULL THEN 'vencendo' ELSE cf.encerramento END AS estado
    FROM confiancas cf JOIN contratos c ON c.id = cf.contrato_id LEFT JOIN usuarios u ON u.id = cf.concedida_por
    WHERE c.assinante_id = ? ORDER BY cf.id DESC LIMIT 20`).all(hoje, assinante.id);
  const avisos = db.prepare(`SELECT ev.*, rr.nome AS regra_nome, rr.texto AS regra_texto, f.numero AS fatura_numero, f.vencimento, f.situacao AS fatura_situacao,
      c.numero AS contrato_numero, u.nome AS enviado_por_nome
    FROM regua_eventos ev JOIN regua_regras rr ON rr.id = ev.regra_id JOIN faturas f ON f.id = ev.fatura_id
    LEFT JOIN contratos c ON c.id = ev.contrato_id LEFT JOIN usuarios u ON u.id = ev.enviado_por
    WHERE f.assinante_id = ? ORDER BY ev.id DESC LIMIT 60`).all(assinante.id);

  for (const c of confiancas) {
    linha.push(evento(c.criada_em, 'confianca', 'Desbloqueio de confiança concedido', `até ${dataBr(c.ate)}${c.motivo ? ` · ${c.motivo}` : ''}`,
      { usuario: c.concedida_por_nome, contrato: c.contrato_numero }));
  }
  for (const a of avisos) {
    /*
     * Bloqueio e indicação executados pela régua já entram na linha do tempo como evento do contrato: repetir
     * aqui mostraria o mesmo fato duas vezes. O que a régua acrescenta de próprio é o aviso (que não vira evento
     * de contrato) e a tentativa que NÃO foi executada — essa explica por que nada aconteceu.
     */
    if (a.acao !== 'avisar' && a.resultado === 'executada') continue;
    linha.push(evento(a.executado_em, `regua_${a.acao}`, `${rotuloAcao(a.acao)} · ${a.regra_nome}`,
      [`fatura ${a.fatura_numero}`, a.dias_atraso > 0 ? `${a.dias_atraso} dia(s) de atraso` : null, a.detalhe].filter(Boolean).join(' · '),
      { origem: 'regua', contrato: a.contrato_numero }));
  }
  return {
    bloqueios,
    confiancas,
    avisos,
    pendentes_envio: avisos.filter((a) => a.resultado === 'pendente_envio' && !a.enviado_em),
    confiancas_no_ano: confiancas.filter((c) => c.inicio >= `${hoje.slice(0, 4)}-01-01`).length,
  };
}

/**
 * Chamados técnicos deste assinante. O chamado hoje se liga ao cliente pela referência de texto ou pela CTO
 * do contrato, então o que vier por CTO é marcado como "do mesmo ponto", não como "deste assinante".
 */
function chamadosDo(db, org, assinante, contratos, linha) {
  const numeros = contratos.map((c) => c.numero);
  const ctos = [...new Set(contratos.map((c) => c.cto_id).filter(Boolean))];
  const marcadores = numeros.map(() => '?');
  const porCliente = numeros.length
    ? db.prepare(`SELECT * FROM chamados WHERE organizacao_id = ? AND cliente_ref IN (${marcadores.join(',')}) ORDER BY id DESC LIMIT 30`)
      .all(org, ...numeros.map((n) => `contrato:${n}`))
    : [];
  const vistos = new Set(porCliente.map((x) => x.id));
  const porCto = ctos.length
    ? db.prepare(`SELECT * FROM chamados WHERE organizacao_id = ? AND ativo_id IN (${ctos.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 20`).all(org, ...ctos)
    : [];
  const lista = [
    ...porCliente.map((x) => ({ ...x, vinculo: 'assinante' })),
    ...porCto.filter((x) => !vistos.has(x.id)).map((x) => ({ ...x, vinculo: 'mesmo_ponto' })),
  ].sort((a, b) => b.id - a.id);
  for (const ch of lista.filter((x) => x.vinculo === 'assinante')) {
    linha.push(evento(ch.criado_em, 'chamado', `Chamado ${ch.numero} · ${ch.titulo}`, `${ch.tipo} · ${ch.status}`, { gravidade: ch.prioridade === 'critica' ? 'alta' : null }));
  }
  return lista;
}

const ROTULOS = { criado: 'Contrato criado', ativado: 'Serviço ativado', bloqueado: 'Serviço bloqueado', desbloqueado: 'Serviço liberado',
  suspenso: 'Suspenso a pedido', reativado: 'Contrato reativado', cancelado: 'Contrato cancelado', valor_alterado: 'Valor alterado',
  plano_alterado: 'Plano alterado', item_incluido: 'Item incluído', item_encerrado: 'Item encerrado', indicado_para_cancelamento: 'Indicado para cancelamento' };
const rotuloEvento = (e) => ROTULOS[e] ?? e.replaceAll('_', ' ');
const rotuloAcao = (a) => ({ avisar: 'Aviso de cobrança', bloquear: 'Corte pela régua', indicar_cancelamento: 'Indicação de cancelamento' }[a] ?? a);

module.exports = { montar, LIMITE_FATURAS };
