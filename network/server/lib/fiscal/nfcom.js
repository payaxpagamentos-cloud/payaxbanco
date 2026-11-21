'use strict';

const { agora } = require('../../db');
const { ErroNegocio } = require('../erros');
const chave = require('./chave');
const t = require('./tabelas');
const x = require('./xml');

/*
 * Montagem da NFCom a partir de uma fatura.
 *
 * O que este arquivo NÃO faz, de propósito: decidir tributação. Alíquota de ICMS sobre comunicação
 * depende do estado, de benefício fiscal e de como o serviço foi contratado; classificação de item
 * depende do plano. Nada disso se adivinha a partir do banco de dados. O que o sistema faz é partir das
 * tabelas oficiais, oferecer a sugestão ao provedor e deixar a contabilidade dele confirmar — e, até que
 * confirme, dizer em letras garrafais que a regra não foi conferida.
 *
 * O outro princípio é o da recusa útil: faltando um dado obrigatório, a emissão para AQUI, dizendo qual
 * campo falta e de quem é. Emitir com o campo em branco empurra o problema para a rejeição da SEFAZ, que
 * chega dias depois, em código, e já com a fatura na mão do cliente.
 */

const VER_PROC = 'Manager Provedor';

/* Origem do item da fatura → chave da regra fiscal. Pró-rata é mensalidade com outro período. */
const ORIGEM_PARA_REGRA = {
  mensalidade: 'mensalidade',
  pro_rata: 'mensalidade',
  instalacao: 'instalacao',
  sva: 'sva',
  equipamento: 'equipamento',
  ponto_adicional: 'ponto_adicional',
  desconto: 'desconto',
  avulso: 'avulso',
  outro: 'avulso',
  juros: 'juros',
  multa: 'multa',
};
const ORIGENS = Object.keys(t.PARA_O_PROVEDOR);

/* ------------------------------------------------------------------ *
 * Configuração e regras
 * ------------------------------------------------------------------ */

/** A configuração fiscal, criada com os padrões na primeira vez que alguém olha. */
function config(db, org) {
  let c = db.prepare('SELECT * FROM fiscal_config WHERE organizacao_id = ?').get(org);
  if (!c) {
    db.prepare('INSERT INTO fiscal_config (organizacao_id, atualizado_em) VALUES (?, ?)').run(org, agora());
    c = db.prepare('SELECT * FROM fiscal_config WHERE organizacao_id = ?').get(org);
  }
  return c;
}

/**
 * Semeia as regras a partir das tabelas oficiais. Todas nascem `conferida = 0`: são sugestão, e o
 * sistema não as trata como verdade enquanto a contabilidade do provedor não disser que são.
 */
function semearRegras(db, org) {
  const existentes = new Set(db.prepare('SELECT origem FROM fiscal_regras WHERE organizacao_id = ?').all(org).map((r) => r.origem));
  const inserir = db.prepare(`INSERT INTO fiscal_regras (organizacao_id, origem, cclass, cfop, u_med, cst_icms, p_icms,
    cst_pis, p_pis, cst_cofins, p_cofins, conferida, atualizado_em) VALUES (?, ?, ?, ?, 4, ?, '0.00', '01', '0.00', '01', '0.00', 0, ?)`);
  let criadas = 0;
  for (const origem of ORIGENS) {
    if (existentes.has(origem)) continue;
    const cclass = t.PARA_O_PROVEDOR[origem];
    // Dedução não tem CFOP nem ICMS: ela abate o total, não é prestação.
    const cfop = t.deduz(cclass) ? '' : '5307';
    const cst = t.deduz(cclass) ? '41' : '00';
    inserir.run(org, origem, cclass, cfop, cst, agora());
    criadas++;
  }
  return { criadas, total: ORIGENS.length };
}

const regras = (db, org) => Object.fromEntries(
  db.prepare('SELECT * FROM fiscal_regras WHERE organizacao_id = ?').all(org).map((r) => [r.origem, r]),
);

/* ------------------------------------------------------------------ *
 * Conferência do que é preciso para emitir
 * ------------------------------------------------------------------ */

const vazio = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * Tudo o que falta para emitir, numa lista só.
 *
 * De propósito devolve a lista inteira em vez de parar no primeiro problema: quem está configurando
 * prefere resolver os oito campos de uma vez a descobrir um por emissão.
 */
function pendencias(db, org, { certificadoOk = null } = {}) {
  const c = config(db, org);
  const o = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(org);
  const faltas = [];
  const exigir = (valor, onde, campo) => { if (vazio(valor)) faltas.push({ onde, campo }); };

  exigir(o.documento, 'empresa', 'CNPJ');
  exigir(o.nome, 'empresa', 'razão social');
  exigir(c.inscricao_estadual ?? o.inscricao_estadual, 'empresa', 'inscrição estadual');
  exigir(o.logradouro, 'empresa', 'logradouro');
  exigir(o.numero_endereco, 'empresa', 'número do endereço');
  exigir(o.bairro, 'empresa', 'bairro');
  exigir(o.cidade, 'empresa', 'cidade');
  exigir(o.uf, 'empresa', 'UF');
  exigir(o.cep, 'empresa', 'CEP');
  exigir(o.codigo_municipio, 'empresa', 'código IBGE do município');
  exigir(c.resp_tec_cnpj, 'responsável técnico', 'CNPJ');
  exigir(c.resp_tec_contato, 'responsável técnico', 'contato');
  exigir(c.resp_tec_email, 'responsável técnico', 'e-mail');
  exigir(c.resp_tec_fone, 'responsável técnico', 'telefone');

  const r = regras(db, org);
  const semRegra = ORIGENS.filter((origem) => !r[origem]);
  const naoConferidas = ORIGENS.filter((origem) => r[origem] && !r[origem].conferida);

  if (o.uf && !t.CUF[String(o.uf).toUpperCase()]) faltas.push({ onde: 'empresa', campo: `UF "${o.uf}" não existe` });
  const autorizador = t.AUTORIZADORES[c.autorizador];
  const autorizadorOk = Boolean(autorizador?.confirmado);

  return {
    pronto: faltas.length === 0 && semRegra.length === 0 && certificadoOk !== false,
    faltas,
    sem_regra: semRegra,
    regras_nao_conferidas: naoConferidas,
    certificado: certificadoOk,
    ambiente: c.ambiente,
    layout_validado: Boolean(c.layout_validado),
    autorizador: c.autorizador,
    autorizador_confirmado: autorizadorOk,
  };
}

/** Transforma a lista de pendências numa recusa que diz o que fazer. */
function exigirPronto(p) {
  if (p.faltas.length) {
    const lista = p.faltas.map((f) => `${f.campo} (${f.onde})`).join(', ');
    throw new ErroNegocio(`Faltam dados para emitir a nota fiscal: ${lista}. Preencha em Organização e em Fiscal.`, 422);
  }
  if (p.sem_regra.length) {
    throw new ErroNegocio(`Sem regra fiscal para: ${p.sem_regra.join(', ')}. Abra Fiscal e gere as regras a partir da tabela oficial.`, 422);
  }
  if (p.certificado === false) {
    throw new ErroNegocio('Nenhum certificado digital válido instalado: sem ele a nota não pode ser assinada.', 422);
  }
}

/* ------------------------------------------------------------------ *
 * Montagem
 * ------------------------------------------------------------------ */

const centavosDe = (valor) => Math.round(Number(valor) || 0);
/** Tributo "por dentro": base × alíquota, arredondado ao centavo. */
const aplicar = (baseCentavos, percentual) => Math.round((baseCentavos * Number(percentual || 0)) / 100);

/**
 * CFOP conforme o destino.
 *
 * A regra guarda o CFOP da operação dentro do estado (5xxx). Quando o assinante está em outro estado, a
 * operação é interestadual e o código começa por 6. É a única correção automática que o sistema faz, e
 * ela é determinística — não é uma decisão de tributação.
 */
function cfopDo(regra, ufEmitente, ufDestino) {
  const base = String(regra.cfop ?? '').trim();
  if (!base) return null;
  if (!ufDestino || !ufEmitente) return base;
  const mesmoEstado = String(ufEmitente).toUpperCase() === String(ufDestino).toUpperCase();
  if (mesmoEstado || !base.startsWith('5')) return base;
  return `6${base.slice(1)}`;
}

/** Monta os itens com os tributos calculados. */
function montarItens(itens, r, { ufEmitente, ufDestino, ano }) {
  const rtc = t.aliquotasRTC(ano);
  const saida = [];
  let n = 0;
  for (const item of itens) {
    const regraChave = ORIGEM_PARA_REGRA[item.origem] ?? 'avulso';
    const regra = r[regraChave];
    if (!regra) throw new ErroNegocio(`Sem regra fiscal para itens de "${item.origem}".`, 422);

    const deduz = t.deduz(regra.cclass);
    // Desconto é guardado negativo na fatura; na nota ele é um item positivo marcado como dedução.
    const bruto = centavosDe(item.valor_centavos);
    const valor = Math.abs(bruto);
    if (valor === 0) continue;
    // Um item positivo numa regra de dedução (ou o contrário) é erro de configuração, não de dados.
    if (deduz !== (bruto < 0) && item.origem === 'desconto') {
      throw new ErroNegocio(`O item "${item.descricao}" tem sinal incompatível com a regra de dedução.`, 422);
    }

    const bcIcms = deduz ? 0 : valor;
    const icms = regra.cst_icms === '00' || regra.cst_icms === '20' ? aplicar(bcIcms, regra.p_icms) : 0;
    const pis = deduz ? 0 : aplicar(valor, regra.p_pis);
    const cofins = deduz ? 0 : aplicar(valor, regra.p_cofins);
    const fust = deduz ? 0 : aplicar(valor, regra.p_fust);
    const funttel = deduz ? 0 : aplicar(valor, regra.p_funttel);
    const ibs = deduz || !rtc ? 0 : aplicar(valor, Number(rtc.pIBSUF || 0) + Number(rtc.pIBSMun || 0));
    const cbs = deduz || !rtc?.pCBS ? 0 : aplicar(valor, rtc.pCBS);

    saida.push({
      n_item: ++n,
      descricao: x.texto(item.descricao, 120),
      origem: item.origem,
      regra,
      cclass: regra.cclass,
      cfop: deduz ? null : cfopDo(regra, ufEmitente, ufDestino),
      u_med: regra.u_med,
      quantidade: '1.0000',
      valor_unitario_centavos: valor,
      valor_centavos: valor,
      deduz,
      bc_icms_centavos: bcIcms,
      icms_centavos: icms,
      pis_centavos: pis,
      cofins_centavos: cofins,
      fust_centavos: fust,
      funttel_centavos: funttel,
      ibs_centavos: ibs,
      cbs_centavos: cbs,
    });
  }
  if (!saida.length) throw new ErroNegocio('A fatura não tem nenhum item com valor: não há o que declarar.', 422);
  return saida;
}

/** Soma os totais. Item de dedução subtrai do total da nota, como manda a tabela de cClass. */
function somar(itens) {
  const soma = (f, filtro = () => true) => itens.filter(filtro).reduce((s, i) => s + i[f], 0);
  const produtos = soma('valor_centavos', (i) => !i.deduz);
  const deducoes = soma('valor_centavos', (i) => i.deduz);
  return {
    produtos,
    deducoes,
    bc_icms: soma('bc_icms_centavos'),
    icms: soma('icms_centavos'),
    pis: soma('pis_centavos'),
    cofins: soma('cofins_centavos'),
    fust: soma('fust_centavos'),
    funttel: soma('funttel_centavos'),
    ibs: soma('ibs_centavos'),
    cbs: soma('cbs_centavos'),
    total: produtos - deducoes,
  };
}

/* ------------------------------------------------------------------ *
 * XML
 * ------------------------------------------------------------------ */

const IDENTIFICACAO = (doc) => {
  const n = x.digitos(doc);
  if (!n) return {};
  if (n.length === 14) return { CNPJ: n };
  if (n.length === 11) return { CPF: n };
  return { idOutros: n };
};

/** O grupo de endereço, igual para emitente e destinatário salvo o nome da tag. */
const endereco = (nome, e) => x.grupo(nome, [
  x.tag('xLgr', x.texto(e.logradouro, 60)),
  x.tag('nro', x.texto(e.numero, 60) ?? 'S/N'),
  x.tag('xCpl', x.texto(e.complemento, 60)),
  x.tag('xBairro', x.texto(e.bairro, 60)),
  x.tag('cMun', x.digitos(e.codigo_municipio, 7)),
  x.tag('xMun', x.texto(e.cidade, 60)),
  x.tag('CEP', x.digitos(e.cep, 8)),
  x.tag('UF', String(e.uf ?? '').toUpperCase() || null),
  x.tag('fone', x.digitos(e.telefone)?.slice(0, 12)),
  x.tag('email', x.texto(e.email, 60)),
]);

/** O grupo de ICMS muda de nome conforme o CST — não é um campo, é a tag inteira. */
function grupoIcms(item) {
  const { regra } = item;
  // Item sem relação com o ICMS (dedução, por exemplo) declara isso explicitamente, em vez de omitir.
  if (item.deduz || !item.cfop) return x.tag('indSemCST', 1);
  const cst = String(regra.cst_icms);
  if (cst === '00') {
    return x.grupo('ICMS00', [
      x.tag('CST', '00'),
      x.tag('vBC', x.valor(item.bc_icms_centavos)),
      x.tag('pICMS', x.percentual(regra.p_icms)),
      x.tag('vICMS', x.valor(item.icms_centavos)),
      x.tag('pFCP', x.percentual(regra.p_fcp)),
      x.tag('vFCP', regra.p_fcp ? x.valor(aplicar(item.bc_icms_centavos, regra.p_fcp)) : null),
    ]);
  }
  if (cst === '20') {
    return x.grupo('ICMS20', [
      x.tag('CST', '20'),
      x.tag('pRedBC', x.percentual(regra.p_red_bc)),
      x.tag('vBC', x.valor(item.bc_icms_centavos)),
      x.tag('pICMS', x.percentual(regra.p_icms)),
      x.tag('vICMS', x.valor(item.icms_centavos)),
    ]);
  }
  if (cst === '40' || cst === '41') return x.grupo('ICMS40', [x.tag('CST', cst)]);
  if (cst === '51') return x.grupo('ICMS51', [x.tag('CST', '51')]);
  return x.grupo('ICMS90', [
    x.tag('CST', '90'),
    x.tag('vBC', x.valor(item.bc_icms_centavos)),
    x.tag('pICMS', x.percentual(regra.p_icms)),
    x.tag('vICMS', x.valor(item.icms_centavos)),
  ]);
}

/** Grupo da Reforma Tributária. Só entra quando há alíquota publicada para o ano. */
function grupoRTC(item, rtc) {
  if (!rtc || !item.regra.cst_ibscbs || item.deduz) return '';
  const ibsUF = aplicar(item.valor_centavos, rtc.pIBSUF);
  const ibsMun = aplicar(item.valor_centavos, rtc.pIBSMun);
  return x.grupo('IBSCBS', [
    x.tag('CST', item.regra.cst_ibscbs),
    x.tag('cClassTrib', item.regra.cclass_trib),
    x.grupo('gIBSCBS', [
      x.tag('vBC', x.valor(item.valor_centavos)),
      x.grupo('gIBSUF', [x.tag('pIBSUF', x.percentual(rtc.pIBSUF)), x.tag('vIBSUF', x.valor(ibsUF))]),
      x.grupo('gIBSMun', [x.tag('pIBSMun', x.percentual(rtc.pIBSMun)), x.tag('vIBSMun', x.valor(ibsMun))]),
      x.tag('vIBS', x.valor(ibsUF + ibsMun)),
      rtc.pCBS ? x.grupo('gCBS', [x.tag('pCBS', x.percentual(rtc.pCBS)), x.tag('vCBS', x.valor(item.cbs_centavos))]) : '',
    ]),
  ]);
}

/**
 * Monta o XML inteiro.
 *
 * Devolve duas formas do infNFCom: a que vai no documento e a CANÔNICA (com o namespace escrito nela),
 * que é a que se assina. São diferentes de propósito — ver lib/fiscal/assinatura.js.
 */
function montarXml(dados) {
  const { cfg, org, assinante, contrato, fatura, itens, totais, ide, rtc } = dados;

  const corpoIde = x.grupo('ide', [
    x.tag('cUF', t.CUF[String(org.uf).toUpperCase()]),
    x.tag('tpAmb', cfg.ambiente),
    x.tag('mod', chave.MODELO),
    x.tag('serie', ide.serie),
    x.tag('nNF', ide.numero),
    x.tag('cNF', ide.cNF),
    x.tag('cDV', ide.cDV),
    x.tag('dhEmi', ide.dhEmi),
    x.tag('tpEmis', ide.tpEmis),
    x.tag('nSiteAutoriz', cfg.site_autorizador),
    x.tag('cMunFG', x.digitos(org.codigo_municipio, 7)),
    x.tag('finNFCom', ide.finNFCom),
    x.tag('tpFat', 0),
    x.tag('verProc', VER_PROC),
    ide.tpEmis === 2 ? x.tag('dhCont', ide.dhCont) : '',
    ide.tpEmis === 2 ? x.tag('xJust', x.texto(ide.xJust, 256)) : '',
  ]);

  const corpoEmit = x.grupo('emit', [
    x.tag('CNPJ', x.digitos(org.documento, 14)),
    x.tag('IE', x.digitos(cfg.inscricao_estadual ?? org.inscricao_estadual)),
    x.tag('CRT', cfg.crt),
    x.tag('xNome', x.texto(org.nome, 60)),
    x.tag('xFant', x.texto(org.nome_fantasia, 60)),
    endereco('enderEmit', {
      logradouro: org.logradouro, numero: org.numero_endereco, complemento: org.complemento,
      bairro: org.bairro, codigo_municipio: org.codigo_municipio, cidade: org.cidade,
      cep: org.cep, uf: org.uf, telefone: org.telefone, email: org.email,
    }),
  ]);

  const ident = IDENTIFICACAO(assinante.documento);
  const corpoDest = x.grupo('dest', [
    x.tag('xNome', x.texto(assinante.nome, 60)),
    x.tag('CNPJ', ident.CNPJ),
    x.tag('CPF', ident.CPF),
    x.tag('idOutros', ident.idOutros),
    x.tag('indIEDest', dados.indIEDest),
    x.tag('IE', dados.indIEDest === 2 ? 'ISENTO' : x.digitos(assinante.identidade)),
    endereco('enderDest', {
      logradouro: assinante.logradouro, numero: assinante.numero, complemento: assinante.complemento,
      bairro: assinante.bairro, codigo_municipio: dados.codigoMunicipioDest, cidade: assinante.cidade,
      cep: assinante.cep, uf: assinante.uf, telefone: assinante.telefone, email: assinante.email,
    }),
  ]);

  const corpoAssinante = x.grupo('assinante', [
    x.tag('iCodAssinante', x.texto(assinante.codigo, 15)),
    x.tag('tpAssinante', dados.tpAssinante),
    x.tag('tpServUtil', cfg.tp_serv_util),
    x.tag('nContrato', contrato ? x.texto(String(contrato.numero), 20) : null),
    x.tag('dContratoIni', contrato?.ativacao ?? null),
  ]);

  const corpoDet = itens.map((item) => x.grupo('det', [
    x.grupo('prod', [
      x.tag('cProd', `${item.origem}-${item.n_item}`),
      x.tag('xProd', item.descricao),
      x.tag('cClass', item.cclass),
      x.tag('CFOP', item.cfop),
      x.tag('uMed', item.u_med),
      x.tag('qFaturada', item.quantidade),
      x.tag('vItem', x.valor(item.valor_unitario_centavos)),
      x.tag('vProd', x.valor(item.valor_centavos)),
    ]),
    x.grupo('imposto', [
      grupoIcms(item),
      item.deduz ? '' : x.grupo('PIS', [
        x.tag('CST', item.regra.cst_pis), x.tag('vBC', x.valor(item.valor_centavos)),
        x.tag('pPIS', x.percentual(item.regra.p_pis)), x.tag('vPIS', x.valor(item.pis_centavos)),
      ]),
      item.deduz ? '' : x.grupo('COFINS', [
        x.tag('CST', item.regra.cst_cofins), x.tag('vBC', x.valor(item.valor_centavos)),
        x.tag('pCOFINS', x.percentual(item.regra.p_cofins)), x.tag('vCOFINS', x.valor(item.cofins_centavos)),
      ]),
      item.fust_centavos ? x.grupo('FUST', [
        x.tag('vBC', x.valor(item.valor_centavos)), x.tag('pFUST', x.percentual(item.regra.p_fust)),
        x.tag('vFUST', x.valor(item.fust_centavos)),
      ]) : '',
      item.funttel_centavos ? x.grupo('FUNTTEL', [
        x.tag('vBC', x.valor(item.valor_centavos)), x.tag('pFUNTTEL', x.percentual(item.regra.p_funttel)),
        x.tag('vFUNTTEL', x.valor(item.funttel_centavos)),
      ]) : '',
      grupoRTC(item, rtc),
    ]),
  ], { attrs: { nItem: String(item.n_item) } })).join('');

  const corpoTotal = x.grupo('total', [
    x.tag('vProd', x.valor(totais.produtos)),
    x.grupo('ICMSTot', [
      x.tag('vBC', x.valor(totais.bc_icms)), x.tag('vICMS', x.valor(totais.icms)),
      x.tag('vICMSDeson', x.valor(0)), x.tag('vFCP', x.valor(0)),
    ]),
    x.tag('vCOFINS', x.valor(totais.cofins)),
    x.tag('vPIS', x.valor(totais.pis)),
    x.tag('vFUNTTEL', x.valor(totais.funttel)),
    x.tag('vFUST', x.valor(totais.fust)),
    x.grupo('vRetTribTot', [
      x.tag('vRetPIS', x.valor(0)), x.tag('vRetCofins', x.valor(0)),
      x.tag('vRetCSLL', x.valor(0)), x.tag('vIRRF', x.valor(0)),
    ]),
    x.tag('vDesc', x.valor(totais.deducoes)),
    x.tag('vOutro', x.valor(0)),
    x.tag('vNF', x.valor(totais.total)),
  ]);

  /*
   * CompetFat é obrigatório no grupo da fatura. Cobrança avulsa não tem competência própria, e nesse
   * caso vale a do vencimento — que é o mês a que a cobrança se refere na prática. Deixar o campo vazio
   * seria rejeição certa.
   */
  const competencia = fatura.competencia ?? String(fatura.vencimento).slice(0, 7);
  const corpoFat = x.grupo('gFat', [
    x.tag('CompetFat', competencia.replace('-', '')),
    x.tag('dVencFat', fatura.vencimento),
    x.tag('codBarras', dados.linhaDigitavel ?? null),
  ]);

  const corpoRespTec = x.grupo('gRespTec', [
    x.tag('CNPJ', x.digitos(cfg.resp_tec_cnpj, 14)),
    x.tag('xContato', x.texto(cfg.resp_tec_contato, 60)),
    x.tag('email', x.texto(cfg.resp_tec_email, 60)),
    x.tag('fone', x.digitos(cfg.resp_tec_fone)?.slice(0, 12)),
  ]);

  const interior = corpoIde + corpoEmit + corpoDest + corpoAssinante + corpoDet + corpoTotal + corpoFat + corpoRespTec;
  const attrs = { Id: `NFCom${ide.chave}`, versao: t.VERSAO_LEIAUTE };

  return {
    // O que vai no documento: o namespace está no <NFCom> pai e não se repete aqui.
    infNFCom: x.grupo('infNFCom', [interior], { attrs }),
    // O que se assina: a forma canônica do mesmo trecho, com o namespace herdado escrito nele.
    canonico: x.grupo('infNFCom', [interior], { attrs: { xmlns: t.NAMESPACE, ...attrs } }),
  };
}

/** O texto do QR Code da consulta pública. */
const qrCode = (cfg, chaveAcesso) => {
  const base = t.AUTORIZADORES[cfg.autorizador]?.[cfg.ambiente]?.qrcode;
  return base ? `${base}?chNFCom=${chaveAcesso}&tpAmb=${cfg.ambiente}` : null;
};

/** Fecha o documento com o suplemento e a assinatura. */
const documento = (infNFCom, qr, sig) => x.documento(
  x.grupo('NFCom', [infNFCom, x.grupo('infNFComSupl', [x.tag('qrCodNFCom', qr)]), sig ?? ''], { attrs: { xmlns: t.NAMESPACE } }),
);

module.exports = {
  VER_PROC, ORIGENS, ORIGEM_PARA_REGRA,
  config, semearRegras, regras, pendencias, exigirPronto,
  montarItens, somar, montarXml, documento, qrCode, cfopDo, aplicar,
};
