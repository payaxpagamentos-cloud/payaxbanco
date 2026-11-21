'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada } = require('../lib/http');
const certificado = require('../lib/certificado');
const t = require('../lib/fiscal/tabelas');
const nfcom = require('../lib/fiscal/nfcom');
const emissao = require('../lib/fiscal/emissao');
const transmissao = require('../lib/fiscal/transmissao');
const v = require('../lib/validacao');

/*
 * Fiscal: NFCom (modelo 62).
 *
 * Duas coisas que esta camada garante, e que valem mais do que qualquer campo:
 *
 * 1. Nenhuma rota devolve "pronto" quando não está. `/pendencias` diz o que falta, por inteiro, antes de
 *    alguém tentar emitir — e a emissão repete a conferência, porque a tela pode estar desatualizada.
 * 2. A prévia não consome número de nota. Ver o XML, os tributos e o total antes de emitir é o que
 *    separa um erro de configuração corrigido em dois minutos de uma nota fiscal errada no mundo.
 */

/** Valida os endereços informados: só https, e só os quatro serviços que existem. */
function urlsDeServico(valor) {
  if (!valor || (typeof valor === 'object' && !Object.keys(valor).length)) return null;
  const fora = {};
  for (const [servico, url] of Object.entries(valor)) {
    v.opcao(servico, 'o serviço', ['recepcao', 'consulta', 'evento', 'status']);
    if (!url) continue;
    let alvo;
    try { alvo = new URL(String(url)); } catch { throw new ErroNegocio(`Endereço inválido para "${servico}".`, 422); }
    if (alvo.protocol !== 'https:') throw new ErroNegocio(`O endereço de "${servico}" precisa ser https.`, 422);
    fora[servico] = alvo.toString();
  }
  return Object.keys(fora).length ? JSON.stringify(fora) : null;
}

const SITUACOES = ['rascunho', 'assinada', 'enviando', 'autorizada', 'rejeitada', 'denegada', 'cancelada', 'contingencia'];

module.exports = (db) => {
  const r = Router();

  const config = (req) => nfcom.config(db, req.org);
  const publico = (c) => ({
    ...c,
    layout_validado: Boolean(c.layout_validado),
    emissao_automatica: Boolean(c.emissao_automatica),
    ambiente_nome: t.TP_AMB[c.ambiente],
    crt_nome: t.CRT[c.crt],
    tp_serv_util_nome: t.TP_SERV_UTIL[c.tp_serv_util],
    autorizador_nome: t.AUTORIZADORES[c.autorizador]?.nome ?? c.autorizador,
    autorizador_confirmado: Boolean(t.AUTORIZADORES[c.autorizador]?.confirmado),
  });

  /* ---------------- Configuração ---------------- */

  r.get('/config', exigir('fiscal.ver'), (req, res) => res.json(publico(config(req))));

  r.put('/config', exigir('fiscal.configurar'), (req, res) => {
    const antes = config(req);
    const b = req.body ?? {};
    const d = {
      ambiente: b.ambiente !== undefined ? v.inteiro(b.ambiente, 'o ambiente', { min: 1, max: 2 }) : antes.ambiente,
      serie: b.serie !== undefined ? v.inteiro(b.serie, 'a série', { max: 999 }) : antes.serie,
      crt: b.crt !== undefined ? v.inteiro(b.crt, 'o regime tributário', { min: 1, max: 4 }) : antes.crt,
      regime_ibscbs: b.regime_ibscbs !== undefined ? v.opcional(b.regime_ibscbs, 'o regime de IBS/CBS', 1) : antes.regime_ibscbs,
      inscricao_estadual: b.inscricao_estadual !== undefined ? v.opcional(b.inscricao_estadual, 'a inscrição estadual', 14) : antes.inscricao_estadual,
      autorizador: b.autorizador !== undefined ? v.opcao(b.autorizador, 'o autorizador', Object.keys(t.AUTORIZADORES)) : antes.autorizador,
      site_autorizador: b.site_autorizador !== undefined ? v.inteiro(b.site_autorizador, 'o site do autorizador', { max: 9 }) : antes.site_autorizador,
      tp_serv_util: b.tp_serv_util !== undefined ? v.inteiro(b.tp_serv_util, 'o tipo de serviço', { min: 1, max: 7 }) : antes.tp_serv_util,
      resp_tec_cnpj: b.resp_tec_cnpj !== undefined ? v.opcional(b.resp_tec_cnpj, 'o CNPJ do responsável técnico', 18) : antes.resp_tec_cnpj,
      resp_tec_contato: b.resp_tec_contato !== undefined ? v.opcional(b.resp_tec_contato, 'o contato do responsável técnico', 60) : antes.resp_tec_contato,
      resp_tec_email: b.resp_tec_email !== undefined ? v.opcional(b.resp_tec_email, 'o e-mail do responsável técnico', 60) : antes.resp_tec_email,
      resp_tec_fone: b.resp_tec_fone !== undefined ? v.opcional(b.resp_tec_fone, 'o telefone do responsável técnico', 20) : antes.resp_tec_fone,
      emissao_automatica: b.emissao_automatica !== undefined ? (v.booleano(b.emissao_automatica) ? 1 : 0) : antes.emissao_automatica,
      /*
       * Endereços próprios dos serviços. Existem para as UFs que autorizam por conta própria e cujos
       * endereços este sistema não conhece: é melhor o provedor informar o que a SEFAZ dele publicou do
       * que o sistema inventar uma URL. Só HTTPS: documento fiscal não trafega em claro.
       */
      urls: b.urls !== undefined ? urlsDeServico(b.urls) : antes.urls,
    };

    /*
     * Passar para produção é decisão com consequência: a partir dali toda nota vale perante o Fisco.
     * Exige que alguém tenha confirmado o leiaute em homologação — e a confirmação é um ato próprio,
     * registrado, não um efeito colateral de marcar uma caixa.
     */
    if (d.ambiente === 1 && antes.ambiente === 2 && !antes.layout_validado) {
      throw new ErroNegocio('Antes de ir para produção, emita uma nota em homologação, confira o retorno da SEFAZ '
        + 'e marque o leiaute como validado. Produção não é lugar de descobrir que um campo está errado.', 422);
    }

    db.prepare(`UPDATE fiscal_config SET ambiente = ?, serie = ?, crt = ?, regime_ibscbs = ?, inscricao_estadual = ?,
      autorizador = ?, site_autorizador = ?, tp_serv_util = ?, resp_tec_cnpj = ?, resp_tec_contato = ?, resp_tec_email = ?,
      resp_tec_fone = ?, emissao_automatica = ?, urls = ?, atualizado_em = ?, versao = versao + 1 WHERE organizacao_id = ?`)
      .run(d.ambiente, d.serie, d.crt, d.regime_ibscbs, d.inscricao_estadual, d.autorizador, d.site_autorizador,
        d.tp_serv_util, d.resp_tec_cnpj, d.resp_tec_contato, d.resp_tec_email, d.resp_tec_fone, d.emissao_automatica,
        d.urls, agora(), req.org);
    registrar(db, req, 'fiscal_config_alterada', { recurso: 'fiscal', recursoId: req.org, antes, depois: d });
    res.json(publico(config(req)));
  });

  /** Marca o leiaute como conferido com a SEFAZ. É um ato registrado, com nome e data. */
  r.post('/config/validar-layout', exigir('fiscal.configurar'), (req, res) => {
    const autorizadas = db.prepare("SELECT COUNT(*) AS n FROM nfcom WHERE organizacao_id = ? AND situacao = 'autorizada'").get(req.org).n;
    if (!autorizadas) {
      throw new ErroNegocio('Nenhuma nota desta organização foi autorizada ainda. Emita uma em homologação e só então '
        + 'marque o leiaute como validado — senão a marca não significa nada.', 422);
    }
    db.prepare('UPDATE fiscal_config SET layout_validado = 1, validado_em = ?, validado_por = ?, versao = versao + 1 WHERE organizacao_id = ?')
      .run(agora(), req.usuario.id, req.org);
    registrar(db, req, 'fiscal_layout_validado', { recurso: 'fiscal', recursoId: req.org, depois: { autorizadas } });
    res.json(publico(config(req)));
  });

  r.get('/pendencias', exigir('fiscal.ver'), (req, res) => {
    res.json(nfcom.pendencias(db, req.org, { certificadoOk: Boolean(certificado.ativoDe(db, req.org)) }));
  });

  /* ---------------- Regras fiscais ---------------- */

  r.get('/regras', exigir('fiscal.ver'), (req, res) => {
    const itens = db.prepare('SELECT * FROM fiscal_regras WHERE organizacao_id = ? ORDER BY origem').all(req.org)
      .map((x) => ({ ...x, conferida: Boolean(x.conferida), cclass_nome: t.CCLASS[x.cclass] ?? null, deduz: t.deduz(x.cclass) }));
    res.json({ itens, tabela: t.CCLASS, cfop: t.CFOP });
  });

  /** Gera as regras que faltam a partir da tabela oficial. Não toca nas que já existem. */
  r.post('/regras/padrao', exigir('fiscal.configurar'), (req, res) => {
    const resultado = nfcom.semearRegras(db, req.org);
    registrar(db, req, 'fiscal_regras_semeadas', { recurso: 'fiscal', recursoId: req.org, depois: resultado });
    res.status(201).json({
      ...resultado,
      aviso: 'As regras vieram da tabela oficial e valem como SUGESTÃO. Classificação de item e alíquota de ICMS '
        + 'dependem do estado e de como o serviço foi contratado: a contabilidade do provedor precisa conferir uma a uma.',
    });
  });

  r.patch('/regras/:origem', exigir('fiscal.configurar'), (req, res) => {
    const origem = v.opcao(req.params.origem, 'a origem', nfcom.ORIGENS);
    const antes = db.prepare('SELECT * FROM fiscal_regras WHERE organizacao_id = ? AND origem = ?').get(req.org, origem);
    if (!antes) throw new ErroNegocio('Regra não encontrada. Gere as regras padrão primeiro.', 404);
    const b = req.body ?? {};
    const pct = (k, rotulo) => (b[k] !== undefined ? (b[k] === '' || b[k] === null ? null : String(Number(v.numero(b[k], rotulo)).toFixed(2))) : antes[k]);
    const d = {
      cclass: b.cclass !== undefined ? v.opcao(String(b.cclass), 'o código de classificação', Object.keys(t.CCLASS)) : antes.cclass,
      cfop: b.cfop !== undefined ? (b.cfop ? v.opcao(String(b.cfop), 'o CFOP', Object.keys(t.CFOP)) : '') : antes.cfop,
      u_med: b.u_med !== undefined ? v.inteiro(b.u_med, 'a unidade', { min: 1, max: 4 }) : antes.u_med,
      cst_icms: b.cst_icms !== undefined ? v.opcao(String(b.cst_icms), 'o CST do ICMS', Object.keys(t.CST_ICMS)) : antes.cst_icms,
      p_icms: pct('p_icms', 'a alíquota do ICMS'),
      p_fcp: pct('p_fcp', 'a alíquota do FCP'),
      p_red_bc: pct('p_red_bc', 'a redução da base'),
      cst_pis: b.cst_pis !== undefined ? v.opcao(String(b.cst_pis), 'o CST do PIS', Object.keys(t.CST_PIS_COFINS)) : antes.cst_pis,
      p_pis: pct('p_pis', 'a alíquota do PIS'),
      cst_cofins: b.cst_cofins !== undefined ? v.opcao(String(b.cst_cofins), 'o CST do COFINS', Object.keys(t.CST_PIS_COFINS)) : antes.cst_cofins,
      p_cofins: pct('p_cofins', 'a alíquota do COFINS'),
      p_fust: pct('p_fust', 'a alíquota do FUST'),
      p_funttel: pct('p_funttel', 'a alíquota do FUNTTEL'),
      cst_ibscbs: b.cst_ibscbs !== undefined ? v.opcional(b.cst_ibscbs, 'o CST do IBS/CBS', 3) : antes.cst_ibscbs,
      cclass_trib: b.cclass_trib !== undefined ? v.opcional(b.cclass_trib, 'a classificação tributária', 6) : antes.cclass_trib,
    };
    /*
     * Mexer na regra desmarca a conferência, a menos que quem mexeu diga explicitamente que conferiu.
     * Regra alterada e ainda marcada como conferida é a forma mais silenciosa de errar imposto.
     */
    const conferida = b.conferida !== undefined ? (v.booleano(b.conferida) ? 1 : 0) : 0;
    db.prepare(`UPDATE fiscal_regras SET cclass = ?, cfop = ?, u_med = ?, cst_icms = ?, p_icms = ?, p_fcp = ?, p_red_bc = ?,
      cst_pis = ?, p_pis = ?, cst_cofins = ?, p_cofins = ?, p_fust = ?, p_funttel = ?, cst_ibscbs = ?, cclass_trib = ?,
      conferida = ?, conferida_em = ?, conferida_por = ?, atualizado_em = ? WHERE organizacao_id = ? AND origem = ?`)
      .run(d.cclass, d.cfop, d.u_med, d.cst_icms, d.p_icms, d.p_fcp, d.p_red_bc, d.cst_pis, d.p_pis, d.cst_cofins,
        d.p_cofins, d.p_fust, d.p_funttel, d.cst_ibscbs, d.cclass_trib, conferida,
        conferida ? agora() : null, conferida ? req.usuario.id : null, agora(), req.org, origem);
    registrar(db, req, 'fiscal_regra_alterada', { recurso: 'fiscal_regra', recursoId: antes.id, antes, depois: { ...d, conferida } });
    const depois = db.prepare('SELECT * FROM fiscal_regras WHERE organizacao_id = ? AND origem = ?').get(req.org, origem);
    res.json({ ...depois, conferida: Boolean(depois.conferida) });
  });

  /* ---------------- Notas ---------------- */

  r.get('/nfcom', exigir('fiscal.ver'), (req, res) => {
    const f = ['n.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.situacao) { f.push('n.situacao = ?'); p.push(v.opcao(req.query.situacao, 'a situação', SITUACOES)); }
    if (req.query.competencia) { f.push('n.competencia = ?'); p.push(String(req.query.competencia).slice(0, 7)); }
    if (req.query.assinante_id) { f.push('n.assinante_id = ?'); p.push(Number(req.query.assinante_id)); }
    if (req.query.chave) { f.push('n.chave = ?'); p.push(String(req.query.chave).replace(/\D/g, '')); }
    // A lista NÃO traz o XML: são dezenas de milhares de bytes por nota, e a tela não os usa.
    res.json(listaPaginada(db, `SELECT n.id, n.chave, n.serie, n.numero, n.situacao, n.ambiente, n.tp_emis, n.competencia,
      n.vencimento, n.emitida_em, n.valor_total_centavos, n.valor_icms_centavos, n.protocolo, n.c_stat, n.x_motivo,
      n.autorizada_em, n.aviso, n.fatura_id, n.assinante_id,
      a.nome AS assinante_nome, a.documento AS assinante_documento, f.numero AS fatura_numero
      FROM nfcom n JOIN assinantes a ON a.id = n.assinante_id LEFT JOIN faturas f ON f.id = n.fatura_id
      WHERE ${f.join(' AND ')} ORDER BY n.emitida_em DESC, n.id DESC`, p, req.query));
  });

  r.get('/nfcom/:id', exigir('fiscal.ver'), (req, res) => res.json(emissao.completa(db, req.org, Number(req.params.id))));

  /** O XML cru, como foi assinado. É o documento; tudo o mais é índice. */
  r.get('/nfcom/:id/xml', exigir('fiscal.ver'), (req, res) => {
    const nota = emissao.completa(db, req.org, Number(req.params.id));
    if (!nota.xml) throw new ErroNegocio('Esta nota ainda não tem XML.', 404);
    res.type('application/xml').set('Content-Disposition', `attachment; filename="NFCom-${nota.chave}.xml"`).send(nota.xml);
  });

  /** Prévia: monta tudo sem gravar e SEM consumir número de nota. */
  r.post('/nfcom/previa', exigir('fiscal.ver'), (req, res) => {
    const faturaId = v.inteiro(req.body?.fatura_id, 'a fatura', { min: 1 });
    const p = emissao.previa(db, req.org, faturaId);
    res.json({
      fatura: { id: p.fatura.id, numero: p.fatura.numero, competencia: p.fatura.competencia, vencimento: p.fatura.vencimento },
      assinante: { id: p.assinante.id, nome: p.assinante.nome, documento: p.assinante.documento },
      itens: p.itens.map((i) => ({ ...i, regra: undefined, cclass_nome: t.CCLASS[i.cclass] ?? null })),
      totais: p.totais,
      ambiente: p.cfg.ambiente,
      rtc: p.rtc,
      aviso: p.cfg.layout_validado ? null : emissao.AVISO_LEIAUTE,
      regras_nao_conferidas: p.pendencias.regras_nao_conferidas,
    });
  });

  r.post('/nfcom', exigir('fiscal.emitir'), (req, res) => {
    const faturaId = v.inteiro(req.body?.fatura_id, 'a fatura', { min: 1 });
    const contingencia = req.body?.contingencia
      ? { justificativa: v.texto(req.body.contingencia.justificativa, 'a justificativa da contingência', 256) }
      : null;
    if (contingencia) v.exigir(contingencia.justificativa.length >= 15, 'A justificativa da contingência precisa de pelo menos 15 caracteres.');
    const nota = emissao.emitir(db, req.org, faturaId, { usuarioId: req.usuario.id, contingencia });
    registrar(db, req, 'nfcom_emitida', { recurso: 'nfcom', recursoId: nota.id, depois: { chave: nota.chave, numero: nota.numero, total: nota.valor_total_centavos } });
    res.status(201).json(nota);
  });

  /* ---------------- SEFAZ ---------------- */

  /** Teste de conexão. É a primeira coisa a fazer depois de instalar o certificado. */
  r.post('/sefaz/testar', exigir('fiscal.ver'), async (req, res) => {
    res.json(await transmissao.testar(db, req.org));
  });

  r.post('/nfcom/:id/transmitir', exigir('fiscal.emitir'), async (req, res) => {
    const nota = await transmissao.transmitir(db, req.org, Number(req.params.id), { usuarioId: req.usuario.id });
    registrar(db, req, 'nfcom_transmitida', { recurso: 'nfcom', recursoId: nota.id, depois: { situacao: nota.situacao, c_stat: nota.c_stat, protocolo: nota.protocolo } });
    res.json(nota);
  });

  /** Pergunta à SEFAZ o que ela sabe. É como se resolve uma nota presa em "enviando". */
  r.post('/nfcom/:id/consultar', exigir('fiscal.ver'), async (req, res) => {
    res.json(await transmissao.consultar(db, req.org, Number(req.params.id)));
  });

  r.post('/nfcom/:id/cancelar', exigir('fiscal.cancelar'), async (req, res) => {
    const justificativa = v.texto(req.body?.justificativa, 'a justificativa', 255);
    const r2 = await transmissao.cancelar(db, req.org, Number(req.params.id), { justificativa, usuarioId: req.usuario.id });
    registrar(db, req, 'nfcom_cancelada', { recurso: 'nfcom', recursoId: Number(req.params.id), depois: { cancelada: r2.cancelada, c_stat: r2.c_stat, justificativa } });
    res.json(r2);
  });

  return r;
};
