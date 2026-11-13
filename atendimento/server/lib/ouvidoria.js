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
function abrir(db, { empresa, contato, conversa = null, tipo, assunto, relato = null, origem = 'ia', usuario = null, ficha = null, prioridade = null }) {
  const t = v.opcao(tipo, 'o tipo da ouvidoria', Object.keys(TIPOS));
  return transacao(db, () => {
    // Um caso aberto do mesmo tipo por cliente: reclamar duas vezes não vira dois processos.
    const existente = db.prepare(`SELECT * FROM ouvidoria WHERE contato_id = ? AND tipo = ? AND status IN ('aberta','em_tratativa') ORDER BY id DESC LIMIT 1`)
      .get(contato.id, t);
    if (existente) {
      evento(db, existente.id, { tipo: 'tratativa', texto: `O cliente voltou a falar sobre o mesmo assunto: ${String(assunto).slice(0, 300)}`, usuarioId: usuario?.id ?? null });
      return { ouvidoria: existente, ja_existia: true };
    }

    const protocolo = gerarProtocolo(db, empresa.id);
    const mensalidade = ficha?.resumo?.mensalidade_centavos ?? 0;
    const id = Number(db.prepare(`INSERT INTO ouvidoria
        (empresa_id, protocolo, contato_id, conversa_id, ixc_cliente_id, tipo, origem, assunto, relato, prioridade, prazo_em,
         risco_na_abertura, valor_na_abertura, mensalidade_centavos, valor_anual_centavos, aberta_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(empresa.id, protocolo, contato.id, conversa?.id ?? null, conversa?.ixc_cliente_id ?? contato.codigo_externo ?? null,
        t, origem, v.texto(assunto, 'o assunto', 200), relato ? String(relato).slice(0, 4000) : null,
        prioridade ?? (FORMAIS.includes(t) || t === 'cancelamento' ? 'alta' : 'normal'),
        prazoDe(db, t), ficha?.risco?.nota ?? null, ficha?.valor?.classe ?? null,
        mensalidade, mensalidade * 12, agora()).lastInsertRowid);

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

/** Encerra o caso. Em cancelamento, `retido` diz se o cliente ficou — é o número que importa. */
function encerrar(db, empresaId, id, usuario, { status, desfecho, retido = null }) {
  const o = buscar(db, empresaId, id);
  const s = v.opcao(status, 'a situação', ['resolvida', 'improcedente']);
  const texto = v.texto(desfecho, 'o desfecho', 4000);
  const ficou = o.tipo === 'cancelamento' ? (retido === null ? null : (v.booleano(retido) ? 1 : 0)) : null;
  if (o.tipo === 'cancelamento' && ficou === null) throw new ErroNegocio('Em um caso de cancelamento, diga se o cliente foi retido ou não.');
  db.prepare('UPDATE ouvidoria SET status = ?, desfecho = ?, retido = ?, resolvida_em = ?, responsavel_id = COALESCE(responsavel_id, ?) WHERE id = ?')
    .run(s, texto, ficou, agora(), usuario.id, o.id);
  evento(db, o.id, {
    tipo: 'desfecho',
    texto: `${usuario.nome} encerrou como ${s === 'resolvida' ? 'resolvida' : 'improcedente'}${ficou === null ? '' : ficou ? ' — cliente RETIDO' : ' — cliente PERDIDO'}: ${texto}`,
    usuarioId: usuario.id,
  });
  return buscar(db, empresaId, id);
}

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
      SUM(CASE WHEN tipo = 'cancelamento' AND retido = 1 THEN 1 ELSE 0 END) AS retidos,
      SUM(CASE WHEN tipo = 'cancelamento' AND retido = 0 THEN 1 ELSE 0 END) AS perdidos,
      SUM(CASE WHEN tipo = 'cancelamento' AND retido = 1 THEN valor_anual_centavos ELSE 0 END) AS receita_salva,
      SUM(CASE WHEN tipo = 'cancelamento' AND retido = 0 THEN valor_anual_centavos ELSE 0 END) AS receita_perdida,
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

module.exports = { TIPOS, FORMAIS, STATUS, abrir, encaminhar, assumir, encerrar, buscar, listar, detalhe, indicadores, evento, gerarProtocolo, enriquecer };
