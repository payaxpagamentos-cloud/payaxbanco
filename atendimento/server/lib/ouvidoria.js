'use strict';

const { agora, transacao, lerConfig } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const conversasLib = require('./conversas');
const filasLib = require('./filas');
const envio = require('./envio');
const cliente360 = require('./cliente360');
const v = require('./validacao');

/**
 * Ouvidoria: o caminho do que não pode se perder numa conversa de WhatsApp — reclamação formal,
 * pedido de cancelamento, Procon e Anatel.
 *
 * A diferença para um atendimento comum: o caso tem protocolo, prazo, responsável, histórico de
 * tratativas e um desfecho que diz se o cliente ficou ou foi embora — e quanto isso vale por ano.
 * A ZOE abre o caso sozinha quando reconhece o assunto e entrega para a pessoa com a
 * ficha e o score já calculados, em vez de passar um "cliente quer cancelar" sem contexto.
 */

const TIPOS = {
  reclamacao: 'Reclamação',
  cancelamento: 'Cancelamento',
  procon: 'Procon',
  anatel: 'Anatel',
  elogio: 'Elogio',
  sugestao: 'Sugestão',
};
// Por que o cliente queria sair. Fecha a pergunta "por que perdemos clientes?" com número.
const MOTIVOS_SAIDA = {
  preco: 'Preço',
  qualidade: 'Qualidade da internet',
  atendimento: 'Atendimento',
  mudanca: 'Mudança de endereço',
  concorrente: 'Oferta da concorrência',
  financeiro: 'Dificuldade financeira',
  sem_uso: 'Não usa mais',
  outro: 'Outro',
};
// O que a equipe pode oferecer para o cliente ficar.
const OFERTAS = {
  desconto: 'Desconto na mensalidade',
  upgrade: 'Upgrade de velocidade',
  visita_tecnica: 'Visita técnica',
  isencao: 'Isenção de fatura',
  troca_equipamento: 'Troca de equipamento',
  downgrade: 'Plano mais barato',
  pausa: 'Pausa temporária',
  outro: 'Outra',
};

// Procon e Anatel têm prazo legal de resposta; aqui fica o alerta interno, mais curto.
const FORMAIS = ['procon', 'anatel'];
const STATUS = ['aberta', 'em_tratativa', 'resolvida', 'improcedente'];

/** Protocolo da ouvidoria: OUV-AAAAMM-0001, por empresa. */
function gerarProtocolo(db, empresaId) {
  const prefixo = `OUV-${new Date().toISOString().slice(0, 7).replace('-', '')}`;
  const usados = Number(db.prepare('SELECT COUNT(*) AS n FROM ouvidoria WHERE empresa_id = ? AND protocolo LIKE ?').all(empresaId, `${prefixo}-%`)[0].n);
  for (let i = 1; i <= 50; i++) {
    const p = `${prefixo}-${String(usados + i).padStart(4, '0')}`;
    if (!db.prepare('SELECT 1 FROM ouvidoria WHERE empresa_id = ? AND protocolo = ?').get(empresaId, p)) return p;
  }
  return `${prefixo}-${Date.now().toString().slice(-5)}`;
}

const prazoDe = (db, tipo) => {
  const cfg = lerConfig(db);
  const horas = FORMAIS.includes(tipo) ? cfg.ouvidoria_prazo_horas_formal : cfg.ouvidoria_prazo_horas;
  return new Date(Date.now() + horas * 3_600_000).toISOString();
};

const evento = (db, ouvidoriaId, { tipo = 'tratativa', texto, usuarioId = null }) =>
  db.prepare('INSERT INTO ouvidoria_eventos (ouvidoria_id, usuario_id, tipo, texto, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(ouvidoriaId, usuarioId, tipo, String(texto).slice(0, 4000), agora());

/**
 * Abre o caso. `ficha` é opcional: quando vem, o risco e o valor ficam gravados como estavam no
 * momento da abertura — o cliente muda depois, mas a decisão foi tomada com estes números.
 */
function abrir(db, { empresa, contato, conversa = null, tipo, assunto, relato = null, origem = 'ia', usuario = null, ficha = null, prioridade = null,
  ameacaSaida = false, motivoSaida = null }) {
  const t = v.opcao(tipo, 'o tipo da ouvidoria', Object.keys(TIPOS));
  // Pedido de cancelamento é sempre retenção; reclamação e Procon são quando o cliente falou em sair.
  const ameaca = t === 'cancelamento' || Boolean(ameacaSaida);
  const motivo = motivoSaida && MOTIVOS_SAIDA[motivoSaida] ? motivoSaida : null;
  return transacao(db, () => {
    // Um caso aberto do mesmo tipo por cliente: reclamar duas vezes não vira dois processos.
    const existente = db.prepare(`SELECT * FROM ouvidoria WHERE contato_id = ? AND tipo = ? AND status IN ('aberta','em_tratativa') ORDER BY id DESC LIMIT 1`)
      .get(contato.id, t);
    if (existente) {
      if (ameaca && !existente.ameaca_saida) db.prepare('UPDATE ouvidoria SET ameaca_saida = 1, motivo_saida = COALESCE(motivo_saida, ?) WHERE id = ?').run(motivo, existente.id);
      evento(db, existente.id, { tipo: 'tratativa', texto: `O cliente voltou a falar sobre o mesmo assunto: ${String(assunto).slice(0, 300)}`, usuarioId: usuario?.id ?? null });
      return { ouvidoria: existente, ja_existia: true };
    }

    const protocolo = gerarProtocolo(db, empresa.id);
    const mensalidade = ficha?.resumo?.mensalidade_centavos ?? 0;
    const id = Number(db.prepare(`INSERT INTO ouvidoria
        (empresa_id, protocolo, contato_id, conversa_id, ixc_cliente_id, tipo, origem, assunto, relato, prioridade, prazo_em,
         risco_na_abertura, valor_na_abertura, mensalidade_centavos, valor_anual_centavos, ameaca_saida, motivo_saida, aberta_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(empresa.id, protocolo, contato.id, conversa?.id ?? null, conversa?.ixc_cliente_id ?? contato.codigo_externo ?? null,
        t, origem, v.texto(assunto, 'o assunto', 200), relato ? String(relato).slice(0, 4000) : null,
        prioridade ?? (FORMAIS.includes(t) || t === 'cancelamento' ? 'alta' : 'normal'),
        prazoDe(db, t), ficha?.risco?.nota ?? null, ficha?.valor?.classe ?? null,
        mensalidade, mensalidade * 12, ameaca ? 1 : 0, motivo, agora()).lastInsertRowid);

    evento(db, id, {
      tipo: 'abertura',
      texto: origem === 'ia' ? `Caso aberto pela ZOE: ${assunto}` : `Caso aberto por ${usuario?.nome ?? 'a equipe'}: ${assunto}`,
      usuarioId: usuario?.id ?? null,
    });
    if (ficha) {
      evento(db, id, {
        tipo: 'abertura',
        texto: `Na abertura: risco ${ficha.risco.nota}/100 (${ficha.risco.faixa}), cliente classe ${ficha.valor.classe}. `
          + `${ficha.recomendacao.texto}${ficha.risco.aumentam.length ? ` Pesaram: ${ficha.risco.aumentam.map((f) => f.nome.toLowerCase()).join(', ')}.` : ''}`,
      });
    }
    if (conversa) envio.registrarSistema(db, conversa, `Ouvidoria ${protocolo} aberta: ${TIPOS[t]}.`, { usuarioId: usuario?.id ?? null });
    return { ouvidoria: db.prepare('SELECT * FROM ouvidoria WHERE id = ?').get(id), ja_existia: false };
  });
}

/** Encaminha a conversa para quem trata ouvidoria, com o resumo pronto. */
function encaminhar(db, { conversa, ouvidoria, ficha = null, fila = null }) {
  const destino = fila ?? filasLib.porNome(db, conversa.empresa_id, 'Retenção') ?? filasLib.porNome(db, conversa.empresa_id, 'Ouvidoria') ?? filasLib.filaPadrao(db, conversa.empresa_id);
  if (!destino) return null;
  const linhas = [`Ouvidoria ${ouvidoria.protocolo} — ${TIPOS[ouvidoria.tipo]}.`, ouvidoria.assunto];
  if (ficha) {
    linhas.push(`Risco ${ficha.risco.nota}/100 (${ficha.risco.faixa}), classe ${ficha.valor.classe}, ${ficha.resumo.mensalidade}/mês, ${ficha.resumo.tempo_casa_meses ?? '?'} meses de casa.`);
    if (ficha.risco.aumentam.length) linhas.push(`Pesa contra: ${ficha.risco.aumentam.map((f) => `${f.nome.toLowerCase()} (${f.detalhe})`).join('; ')}.`);
    linhas.push(ficha.recomendacao.texto);
  }
  return conversasLib.transferir(db, conversa, {
    fila: destino,
    motivo: `Ouvidoria ${ouvidoria.protocolo}: ${TIPOS[ouvidoria.tipo]}.`,
    resumo: linhas.join(' '),
    assunto: `${TIPOS[ouvidoria.tipo]} — ${ouvidoria.assunto}`.slice(0, 160),
    por: 'ia',
    // Cancelamento, Procon e reclamação formal ficam com a equipe por regra: não é falta de conhecimento.
    lacuna: { categoria: ['elogio', 'sugestao'].includes(ouvidoria.tipo) ? 'outro' : 'precisa_de_pessoa', tema: TIPOS[ouvidoria.tipo] },
  });
}

function assumir(db, empresaId, id, usuario) {
  const o = buscar(db, empresaId, id);
  if (['resolvida', 'improcedente'].includes(o.status)) throw new ErroNegocio('Este caso já está encerrado.');
  db.prepare("UPDATE ouvidoria SET responsavel_id = ?, status = CASE WHEN status = 'aberta' THEN 'em_tratativa' ELSE status END, assumida_em = COALESCE(assumida_em, ?) WHERE id = ?")
    .run(usuario.id, agora(), o.id);
  evento(db, o.id, { tipo: 'tratativa', texto: `${usuario.nome} assumiu o caso.`, usuarioId: usuario.id });
  return buscar(db, empresaId, id);
}

/**
 * Encerra o caso. Quando o cliente ameaçou sair (cancelamento, ou reclamação/Procon com "vou
 * trocar de provedor"), três coisas são obrigatórias, porque são os números da retenção: se ele
 * ficou, por que queria sair e o que aconteceu com cada oferta feita.
 */
function encerrar(db, empresaId, id, usuario, { status, desfecho, retido = null, ameaca_saida = undefined, motivo_saida = undefined,
  motivo_detalhe = undefined, ofertas_aceitas = undefined }) {
  const o = buscar(db, empresaId, id);
  const s = v.opcao(status, 'a situação', ['resolvida', 'improcedente']);
  const texto = v.texto(desfecho, 'o desfecho', 4000);
  const ameaca = o.tipo === 'cancelamento' || (ameaca_saida === undefined ? Boolean(o.ameaca_saida) : v.booleano(ameaca_saida));
  const ficou = ameaca ? (retido === null || retido === undefined || retido === '' ? null : (v.booleano(retido) ? 1 : 0)) : null;
  if (ameaca && ficou === null) throw new ErroNegocio('O cliente ameaçou sair: diga se ele ficou (foi retido) ou não.');
  const motivo = motivo_saida === undefined || motivo_saida === '' ? o.motivo_saida : v.opcao(motivo_saida, 'o motivo da saída', Object.keys(MOTIVOS_SAIDA));
  if (ameaca && !motivo) throw new ErroNegocio('Diga por que o cliente queria sair: é o que mostra onde a empresa perde clientes.');

  // As ofertas sem resposta: as marcadas como aceitas viram aceitas; as outras, recusadas.
  if (ofertas_aceitas !== undefined) {
    const aceitas = new Set([].concat(ofertas_aceitas ?? []).map(Number));
    for (const of of db.prepare('SELECT id FROM ouvidoria_ofertas WHERE ouvidoria_id = ? AND aceita IS NULL').all(o.id)) {
      db.prepare('UPDATE ouvidoria_ofertas SET aceita = ?, respondida_em = ? WHERE id = ?').run(aceitas.has(of.id) ? 1 : 0, agora(), of.id);
    }
  } else if (ficou === 0) {
    // Foi embora: nenhuma oferta pendente foi aceita.
    db.prepare('UPDATE ouvidoria_ofertas SET aceita = 0, respondida_em = ? WHERE ouvidoria_id = ? AND aceita IS NULL').run(agora(), o.id);
  }

  db.prepare(`UPDATE ouvidoria SET status = ?, desfecho = ?, retido = ?, ameaca_saida = ?, motivo_saida = ?, motivo_detalhe = COALESCE(?, motivo_detalhe),
      resolvida_em = ?, responsavel_id = COALESCE(responsavel_id, ?) WHERE id = ?`)
    .run(s, texto, ficou, ameaca ? 1 : 0, motivo ?? null, motivo_detalhe ? v.texto(motivo_detalhe, 'o detalhe do motivo', 500) : null,
      agora(), usuario.id, o.id);
  evento(db, o.id, {
    tipo: 'desfecho',
    texto: `${usuario.nome} encerrou como ${s === 'resolvida' ? 'resolvida' : 'improcedente'}${ficou === null ? '' : ficou ? ' — cliente RETIDO' : ' — cliente PERDIDO'}`
      + `${motivo && ameaca ? ` (motivo: ${MOTIVOS_SAIDA[motivo].toLowerCase()})` : ''}: ${texto}`,
    usuarioId: usuario.id,
  });
  return buscar(db, empresaId, id);
}

/** Marca (ou desmarca) que o cliente ameaçou sair, e por quê. */
function marcarAmeaca(db, empresaId, id, { ameaca_saida, motivo_saida, motivo_detalhe }, usuario) {
  const o = buscar(db, empresaId, id);
  const ameaca = o.tipo === 'cancelamento' || v.booleano(ameaca_saida ?? o.ameaca_saida);
  const motivo = motivo_saida === undefined ? o.motivo_saida : (motivo_saida ? v.opcao(motivo_saida, 'o motivo da saída', Object.keys(MOTIVOS_SAIDA)) : null);
  db.prepare('UPDATE ouvidoria SET ameaca_saida = ?, motivo_saida = ?, motivo_detalhe = ? WHERE id = ?')
    .run(ameaca ? 1 : 0, motivo, motivo_detalhe === undefined ? o.motivo_detalhe : (motivo_detalhe ? String(motivo_detalhe).slice(0, 500) : null), o.id);
  if (ameaca && !o.ameaca_saida) evento(db, o.id, { tipo: 'tratativa', texto: `${usuario.nome} marcou: o cliente ameaçou sair.`, usuarioId: usuario.id });
  return buscar(db, empresaId, id);
}

/** Registra uma oferta feita ao cliente. Fazer oferta já é tratar como retenção. */
function ofertar(db, empresaId, id, { tipo, descricao = null, valor_mensal_centavos = 0, meses = 0 }, usuario) {
  const o = buscar(db, empresaId, id);
  if (['resolvida', 'improcedente'].includes(o.status)) throw new ErroNegocio('Este caso já está encerrado.');
  const t = v.opcao(tipo, 'a oferta', Object.keys(OFERTAS));
  const valor = valor_mensal_centavos ? v.inteiro(valor_mensal_centavos, 'o valor da oferta', { min: 0, max: 10_000_000 }) : 0;
  const m = meses ? v.inteiro(meses, 'os meses da oferta', { min: 0, max: 36 }) : 0;
  const ofertaId = Number(db.prepare(`INSERT INTO ouvidoria_ofertas (ouvidoria_id, tipo, descricao, valor_mensal_centavos, meses, usuario_id, criada_em)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(o.id, t, descricao ? v.texto(descricao, 'a descrição da oferta', 300) : null, valor, m, usuario.id, agora()).lastInsertRowid);
  if (!o.ameaca_saida) db.prepare('UPDATE ouvidoria SET ameaca_saida = 1 WHERE id = ?').run(o.id);
  const custo = valor && m ? ` (R$ ${(valor / 100).toFixed(2).replace('.', ',')}/mês por ${m} mês(es))` : '';
  evento(db, o.id, { tipo: 'proposta', texto: `${usuario.nome} ofereceu: ${OFERTAS[t]}${descricao ? ` — ${descricao}` : ''}${custo}.`, usuarioId: usuario.id });
  return ofertaId;
}

/** O cliente respondeu à oferta. */
function responderOferta(db, empresaId, id, ofertaId, aceita, usuario) {
  const o = buscar(db, empresaId, id);
  const of = db.prepare('SELECT * FROM ouvidoria_ofertas WHERE id = ? AND ouvidoria_id = ?').get(Number(ofertaId), o.id);
  if (!of) throw naoEncontrado('Oferta');
  const sim = v.booleano(aceita);
  db.prepare('UPDATE ouvidoria_ofertas SET aceita = ?, respondida_em = ? WHERE id = ?').run(sim ? 1 : 0, agora(), of.id);
  evento(db, o.id, { tipo: 'proposta', texto: `O cliente ${sim ? 'ACEITOU' : 'recusou'}: ${OFERTAS[of.tipo]}${of.descricao ? ` — ${of.descricao}` : ''}.`, usuarioId: usuario.id });
}

const ofertasDo = (db, ouvidoriaId) => db.prepare(`SELECT f.*, u.nome AS usuario_nome FROM ouvidoria_ofertas f
  LEFT JOIN usuarios u ON u.id = f.usuario_id WHERE f.ouvidoria_id = ? ORDER BY f.id`).all(ouvidoriaId)
  .map((f) => ({ ...f, aceita: f.aceita === null ? null : Boolean(f.aceita), tipo_nome: OFERTAS[f.tipo] ?? f.tipo, custo_centavos: f.valor_mensal_centavos * f.meses }));

const buscar = (db, empresaId, id) => {
  const o = db.prepare('SELECT * FROM ouvidoria WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!o) throw naoEncontrado('Caso de ouvidoria');
  return o;
};

const COLUNAS = `o.*, ct.telefone, COALESCE(ct.nome, ct.nome_perfil) AS contato_nome, ct.documento, u.nome AS responsavel_nome`;
const JUNCOES = `FROM ouvidoria o JOIN contatos ct ON ct.id = o.contato_id LEFT JOIN usuarios u ON u.id = o.responsavel_id`;

const enriquecer = (o) => ({
  ...o,
  retido: o.retido === null ? null : Boolean(o.retido),
  ameaca_saida: Boolean(o.ameaca_saida),
  motivo_nome: o.motivo_saida ? MOTIVOS_SAIDA[o.motivo_saida] : null,
  tipo_nome: TIPOS[o.tipo] ?? o.tipo,
  atrasada: Boolean(o.prazo_em && !o.resolvida_em && Date.parse(o.prazo_em) < Date.now()),
  horas_para_o_prazo: o.prazo_em && !o.resolvida_em ? Math.round((Date.parse(o.prazo_em) - Date.now()) / 3_600_000) : null,
});

function listar(db, empresaId, { status = '', tipo = '', responsavelId = '', busca = '', de = null, ate = null, pagina = 1, porPagina = 40 } = {}) {
  const onde = ['o.empresa_id = ?'];
  const args = [empresaId];
  if (status === 'abertas') onde.push("o.status IN ('aberta','em_tratativa')");
  else if (status) { onde.push('o.status = ?'); args.push(v.opcao(status, 'a situação', STATUS)); }
  if (tipo) { onde.push('o.tipo = ?'); args.push(v.opcao(tipo, 'o tipo', Object.keys(TIPOS))); }
  if (responsavelId) { onde.push('o.responsavel_id = ?'); args.push(Number(responsavelId)); }
  if (de) { onde.push('o.aberta_em >= ?'); args.push(de); }
  if (ate) { onde.push('o.aberta_em < ?'); args.push(ate); }
  if (busca) {
    onde.push('(o.protocolo LIKE ? OR o.assunto LIKE ? OR ct.telefone LIKE ? OR ct.nome LIKE ? OR ct.documento LIKE ?)');
    const t = `%${busca}%`;
    args.push(t, t, t, t, t);
  }
  const filtro = onde.join(' AND ');
  const total = Number(db.prepare(`SELECT COUNT(*) AS n ${JUNCOES} WHERE ${filtro}`).all(...args)[0].n);
  const p = Math.max(1, Number(pagina) || 1);
  const itens = db.prepare(`SELECT ${COLUNAS} ${JUNCOES} WHERE ${filtro}
    ORDER BY CASE o.status WHEN 'aberta' THEN 0 WHEN 'em_tratativa' THEN 1 ELSE 2 END,
      CASE o.prioridade WHEN 'alta' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, o.prazo_em
    LIMIT ? OFFSET ?`).all(...args, porPagina, (p - 1) * porPagina).map(enriquecer);
  return { itens, total, pagina: p, por_pagina: porPagina };
}

/** O caso com as tratativas e a ficha do cliente calculada agora. */
async function detalhe(db, empresaId, id) {
  const o = buscar(db, empresaId, id);
  return {
    ...enriquecer(db.prepare(`SELECT ${COLUNAS} ${JUNCOES} WHERE o.id = ?`).get(o.id)),
    ofertas: ofertasDo(db, o.id),
    eventos: db.prepare(`SELECT e.id, e.tipo, e.texto, e.criado_em, u.nome AS usuario_nome
      FROM ouvidoria_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE e.ouvidoria_id = ? ORDER BY e.id`).all(o.id),
    ficha: await cliente360.ficha(db, empresaId, o.contato_id, { ixcClienteId: o.ixc_cliente_id }),
  };
}

/** Os números que a diretoria pergunta: quanto a ouvidoria resolve e quanto de receita ela salva. */
function indicadores(db, empresaId, { de, ate }) {
  const { intervalo } = require('./datas');
  const [inicio, fim] = intervalo(de, ate);
  const base = db.prepare(`SELECT
      COUNT(*) AS casos,
      SUM(CASE WHEN status IN ('aberta','em_tratativa') THEN 1 ELSE 0 END) AS em_aberto,
      SUM(CASE WHEN status = 'resolvida' THEN 1 ELSE 0 END) AS resolvidas,
      SUM(CASE WHEN tipo = 'cancelamento' THEN 1 ELSE 0 END) AS cancelamentos,
      SUM(ameaca_saida) AS ameacas,
      SUM(CASE WHEN ameaca_saida = 1 AND retido = 1 THEN 1 ELSE 0 END) AS retidos,
      SUM(CASE WHEN ameaca_saida = 1 AND retido = 0 THEN 1 ELSE 0 END) AS perdidos,
      SUM(CASE WHEN ameaca_saida = 1 AND retido = 1 THEN valor_anual_centavos ELSE 0 END) AS receita_salva,
      SUM(CASE WHEN ameaca_saida = 1 AND retido = 0 THEN valor_anual_centavos ELSE 0 END) AS receita_perdida,
      SUM(CASE WHEN prazo_em IS NOT NULL AND resolvida_em IS NULL AND prazo_em < ? THEN 1 ELSE 0 END) AS atrasadas,
      AVG(CASE WHEN resolvida_em IS NOT NULL THEN (julianday(resolvida_em) - julianday(aberta_em)) * 24 END) AS horas_medias
    FROM ouvidoria WHERE empresa_id = ? AND aberta_em >= ? AND aberta_em < ?`).get(agora(), empresaId, inicio, fim);

  const decididos = Number(base.retidos ?? 0) + Number(base.perdidos ?? 0);
  return {
    casos: Number(base.casos ?? 0),
    em_aberto: Number(base.em_aberto ?? 0),
    resolvidas: Number(base.resolvidas ?? 0),
    atrasadas: Number(base.atrasadas ?? 0),
    horas_medias: base.horas_medias === null ? null : Number(Number(base.horas_medias).toFixed(1)),
    cancelamentos: Number(base.cancelamentos ?? 0),
    ameacas: Number(base.ameacas ?? 0),
    // O que custou segurar: as ofertas aceitas pelos clientes que ficaram (desconto × meses, isenção...).
    custo_retencao_centavos: Number(db.prepare(`SELECT COALESCE(SUM(f.valor_mensal_centavos * f.meses), 0) AS n
      FROM ouvidoria_ofertas f JOIN ouvidoria o ON o.id = f.ouvidoria_id
      WHERE o.empresa_id = ? AND o.aberta_em >= ? AND o.aberta_em < ? AND o.retido = 1 AND f.aceita = 1`).get(empresaId, inicio, fim).n),
    retidos: Number(base.retidos ?? 0),
    perdidos: Number(base.perdidos ?? 0),
    taxa_retencao: decididos ? Number(((Number(base.retidos) / decididos) * 100).toFixed(1)) : null,
    receita_salva_centavos: Number(base.receita_salva ?? 0),
    receita_perdida_centavos: Number(base.receita_perdida ?? 0),
    por_tipo: db.prepare(`SELECT tipo, COUNT(*) AS total FROM ouvidoria
      WHERE empresa_id = ? AND aberta_em >= ? AND aberta_em < ? GROUP BY tipo ORDER BY total DESC`).all(empresaId, inicio, fim)
      .map((x) => ({ ...x, nome: TIPOS[x.tipo] ?? x.tipo })),
  };
}

/**
 * O relatório da retenção: por que os clientes querem sair, qual oferta segura cada motivo e quanto
 * custou. Conta só casos encerrados com ameaça de saída — os que têm resultado.
 */
function retencao(db, empresaId, { de, ate }) {
  const { intervalo } = require('./datas');
  const [inicio, fim] = intervalo(de, ate);
  const casos = db.prepare(`SELECT id, motivo_saida, retido, valor_anual_centavos FROM ouvidoria
    WHERE empresa_id = ? AND ameaca_saida = 1 AND retido IS NOT NULL AND aberta_em >= ? AND aberta_em < ?`).all(empresaId, inicio, fim);
  const ids = casos.map((c) => c.id);
  const ofertas = ids.length
    ? db.prepare(`SELECT * FROM ouvidoria_ofertas WHERE ouvidoria_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  const casoDe = new Map(casos.map((c) => [c.id, c]));
  const taxa = (a, b) => (b ? Number(((a / b) * 100).toFixed(1)) : null);

  const porMotivo = Object.entries(MOTIVOS_SAIDA).map(([k, nome]) => {
    const doMotivo = casos.filter((c) => (c.motivo_saida ?? 'outro') === k);
    const retidos = doMotivo.filter((c) => c.retido).length;
    return {
      motivo: k, nome, casos: doMotivo.length, retidos, perdidos: doMotivo.length - retidos, taxa: taxa(retidos, doMotivo.length),
      receita_perdida_centavos: doMotivo.filter((c) => !c.retido).reduce((t, c) => t + c.valor_anual_centavos, 0),
    };
  }).filter((m) => m.casos).sort((a, b) => b.casos - a.casos);

  // Uma oferta "segurou" quando foi aceita e o cliente ficou.
  const agrega = (lista) => {
    const aceitas = lista.filter((f) => f.aceita === 1);
    const seguraram = aceitas.filter((f) => casoDe.get(f.ouvidoria_id)?.retido);
    return {
      oferecidas: lista.length, aceitas: aceitas.length, seguraram: seguraram.length,
      taxa_aceite: taxa(aceitas.length, lista.length), taxa_sucesso: taxa(seguraram.length, lista.length),
      custo_centavos: seguraram.reduce((t, f) => t + f.valor_mensal_centavos * f.meses, 0),
      receita_salva_centavos: [...new Set(seguraram.map((f) => f.ouvidoria_id))].reduce((t, id) => t + casoDe.get(id).valor_anual_centavos, 0),
    };
  };
  const porOferta = Object.entries(OFERTAS).map(([k, nome]) => ({ oferta: k, nome, ...agrega(ofertas.filter((f) => f.tipo === k)) }))
    .filter((o) => o.oferecidas).sort((a, b) => b.seguraram - a.seguraram || b.oferecidas - a.oferecidas);

  const cruzamento = [];
  for (const m of porMotivo) {
    for (const [k, nome] of Object.entries(OFERTAS)) {
      const lista = ofertas.filter((f) => f.tipo === k && (casoDe.get(f.ouvidoria_id).motivo_saida ?? 'outro') === m.motivo);
      if (lista.length) cruzamento.push({ motivo: m.motivo, motivo_nome: m.nome, oferta: k, oferta_nome: nome, ...agrega(lista) });
    }
  }
  // A melhor oferta de cada motivo: a que mais segurou proporcionalmente (com pelo menos 2 tentativas
  // quando houver, para um acerto isolado não virar "regra").
  const melhorPorMotivo = porMotivo.map((m) => {
    const linhas = cruzamento.filter((c) => c.motivo === m.motivo);
    const confiaveis = linhas.filter((c) => c.oferecidas >= 2);
    const melhor = (confiaveis.length ? confiaveis : linhas).sort((a, b) => b.taxa_sucesso - a.taxa_sucesso || b.oferecidas - a.oferecidas)[0];
    return melhor ? { motivo: m.motivo, motivo_nome: m.nome, oferta: melhor.oferta, oferta_nome: melhor.oferta_nome,
      taxa_sucesso: melhor.taxa_sucesso, oferecidas: melhor.oferecidas, pouca_amostra: melhor.oferecidas < 2 } : null;
  }).filter(Boolean);

  const semOferta = casos.filter((c) => !ofertas.some((f) => f.ouvidoria_id === c.id));
  // Cada cliente conta uma vez, mesmo tendo aceitado duas ofertas (visita e isenção, por exemplo).
  const total = agrega(ofertas);
  return {
    casos: casos.length,
    retidos: casos.filter((c) => c.retido).length,
    taxa: taxa(casos.filter((c) => c.retido).length, casos.length),
    // Quem saiu sem que ninguém oferecesse nada: dinheiro deixado na mesa.
    receita_salva_com_oferta_centavos: total.receita_salva_centavos,
    custo_centavos: total.custo_centavos,
    perdidos_sem_oferta: semOferta.filter((c) => !c.retido).length,
    retidos_sem_oferta: semOferta.filter((c) => c.retido).length,
    por_motivo: porMotivo,
    por_oferta: porOferta,
    cruzamento,
    melhor_por_motivo: melhorPorMotivo,
  };
}

module.exports = { TIPOS, FORMAIS, STATUS, MOTIVOS_SAIDA, OFERTAS, abrir, encaminhar, assumir, encerrar, marcarAmeaca, ofertar, responderOferta,
  retencao, buscar, listar, detalhe, indicadores, evento, gerarProtocolo, enriquecer };
