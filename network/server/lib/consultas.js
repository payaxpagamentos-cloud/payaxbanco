'use strict';

const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const { validarDestino } = require('../conectores/base');
const config = require('../config');
const v = require('./validacao');

/*
 * Consulta pública de CNPJ (base da Receita Federal) e de CEP, para o cadastro não ser digitado à mão.
 *
 * Decisões que valem para todo o módulo:
 * - A consulta é uma SUGESTÃO, nunca a verdade do cadastro: o que vale é o que a equipe confirmou e salvou.
 *   Por isso a resposta sempre diz a fonte e o horário, e a tela mostra isso antes de a pessoa salvar.
 * - Fonte que não responde não inventa dado nem trava o cadastro: devolve o motivo e o formulário segue à mão.
 * - Cada tipo tem uma lista de fontes em ordem; a primeira que responder vale, e o erro da anterior é guardado
 *   para a mensagem explicar o que aconteceu.
 * - O resultado fica em cache (CNPJ por 7 dias, CEP por 180), porque são bases públicas gratuitas com cota:
 *   repetir a mesma pergunta gastaria a cota de todo mundo. `forcar` ignora o cache quando a equipe quer o dado novo.
 * - Nenhum dado do provedor ou do assinante sai daqui: vai só o número consultado, com User-Agent genérico.
 */

const TTL_DIAS = { cnpj: 7, cep: 180 };
/** Teto de consultas por minuto, para o provedor não ser bloqueado pela fonte pública. */
const LIMITE_POR_MINUTO = 20;

const texto = (x) => {
  const t = String(x ?? '').trim();
  return t && t !== 'null' ? t : null;
};
/**
 * Nome próprio vindo em CAIXA ALTA da Receita, legível sem estragar o que já é sigla.
 * Cada trecho de letras ou números é tratado em separado, então "S/A" continua "S/A" e "LTDA" vira "Ltda";
 * preposições ficam minúsculas, exceto na primeira palavra. Texto que não veio em caixa alta não é mexido.
 */
function capitalizar(s) {
  const t = texto(s);
  if (!t || t !== t.toUpperCase()) return t;
  const minusculas = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'as', 'os', 'para', 'por', 'com']);
  return t.toLowerCase().split(/(\s+)/).map((palavra, i) => {
    if (!palavra.trim()) return palavra;
    if (i > 0 && minusculas.has(palavra)) return palavra;
    return palavra.replace(/[\p{L}\p{N}]+/gu, (parte) => (parte.length <= 2 ? parte.toUpperCase() : parte[0].toUpperCase() + parte.slice(1)));
  }).join('');
}
const juntar = (...partes) => partes.map(texto).filter(Boolean).join(' ') || null;
const telefone = (ddd, numero) => {
  const t = `${v.digitos(ddd)}${v.digitos(numero)}`;
  return t.length >= 10 && t.length <= 11 ? t : null;
};

/*
 * Fontes por tipo, na ordem de tentativa. `mapear` traduz a resposta para os campos do cadastro;
 * devolver null significa "esta fonte não tem o registro" (e a próxima é tentada).
 */
const FONTES = {
  cep: [
    {
      nome: 'BrasilAPI',
      url: (cep) => `https://brasilapi.com.br/api/cep/v2/${cep}`,
      mapear: (d) => (d?.cep ? {
        cep: v.digitos(d.cep),
        logradouro: texto(d.street),
        bairro: texto(d.neighborhood),
        cidade: texto(d.city),
        uf: texto(d.state),
        latitude: Number(d.location?.coordinates?.latitude) || null,
        longitude: Number(d.location?.coordinates?.longitude) || null,
        ibge: texto(d.ibge?.city),
      } : null),
    },
    {
      nome: 'OpenCEP',
      url: (cep) => `https://opencep.com/v1/${cep}`,
      mapear: (d) => (d?.cep ? {
        cep: v.digitos(d.cep),
        logradouro: texto(d.logradouro),
        complemento: texto(d.complemento),
        bairro: texto(d.bairro),
        cidade: texto(d.localidade),
        uf: texto(d.uf),
        ibge: texto(d.ibge),
      } : null),
    },
  ],
  cnpj: [
    {
      nome: 'BrasilAPI',
      url: (cnpj) => `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
      mapear: (d) => (d?.cnpj ? {
        documento: v.digitos(d.cnpj),
        nome: capitalizar(d.razao_social),
        nome_fantasia: capitalizar(d.nome_fantasia),
        // O endereço da Receita vem com o tipo separado do nome: "PRAIA" + "DE BOTAFOGO".
        logradouro: capitalizar(juntar(d.descricao_tipo_de_logradouro, d.logradouro)),
        numero: texto(d.numero),
        complemento: capitalizar(d.complemento),
        bairro: capitalizar(d.bairro),
        cidade: capitalizar(d.municipio),
        uf: texto(d.uf),
        cep: v.digitos(d.cep) || null,
        telefone: telefone(String(d.ddd_telefone_1).slice(0, 2), String(d.ddd_telefone_1).slice(2)),
        email: texto(d.email)?.toLowerCase() ?? null,
        // Contexto que a equipe precisa ver antes de fechar contrato com uma empresa.
        situacao: texto(d.descricao_situacao_cadastral),
        situacao_desde: texto(d.data_situacao_cadastral),
        motivo_situacao: texto(d.descricao_motivo_situacao_cadastral),
        abertura: texto(d.data_inicio_atividade),
        atividade: texto(d.cnae_fiscal_descricao),
        natureza_juridica: texto(d.natureza_juridica),
        porte: texto(d.porte),
        simples: d.opcao_pelo_simples === true ? 'Optante pelo Simples' : d.opcao_pelo_mei === true ? 'MEI' : null,
      } : null),
    },
    {
      nome: 'CNPJ.ws',
      url: (cnpj) => `https://publica.cnpj.ws/cnpj/${cnpj}`,
      mapear: (d) => {
        const e = d?.estabelecimento;
        if (!e?.cnpj) return null;
        return {
          documento: v.digitos(e.cnpj),
          nome: capitalizar(d.razao_social),
          nome_fantasia: capitalizar(e.nome_fantasia),
          logradouro: capitalizar(juntar(e.tipo_logradouro, e.logradouro)),
          numero: texto(e.numero),
          complemento: capitalizar(e.complemento),
          bairro: capitalizar(e.bairro),
          cidade: capitalizar(e.cidade?.nome),
          uf: texto(e.estado?.sigla),
          cep: v.digitos(e.cep) || null,
          telefone: telefone(e.ddd1, e.telefone1),
          email: texto(e.email)?.toLowerCase() ?? null,
          situacao: texto(e.situacao_cadastral),
          situacao_desde: texto(e.data_situacao_cadastral),
          abertura: texto(e.data_inicio_atividade),
          atividade: texto(e.atividade_principal?.descricao),
          natureza_juridica: texto(d.natureza_juridica?.descricao),
          porte: texto(d.porte?.descricao),
          simples: d.simples?.simples === 'Sim' ? 'Optante pelo Simples' : null,
        };
      },
    },
  ],
};

/** Normaliza e valida o que foi pedido, com a mensagem que a pessoa precisa ler. */
function normalizar(tipo, valor) {
  const t = v.digitos(valor);
  if (tipo === 'cnpj') {
    v.exigir(t.length === 14, 'Informe os 14 dígitos do CNPJ.');
    v.exigir(v.cnpjValido(t), 'CNPJ inválido: confira os dígitos antes de consultar.');
  } else {
    v.exigir(t.length === 8, 'Informe os 8 dígitos do CEP.');
  }
  return t;
}

// Teto de consultas por minuto, por organização (protege a cota da fonte pública).
const janelas = new Map();
function dentroDoLimite(org) {
  const corte = Date.now() - 60_000;
  const marcas = (janelas.get(org) ?? []).filter((x) => x > corte);
  marcas.push(Date.now());
  janelas.set(org, marcas);
  return marcas.length <= LIMITE_POR_MINUTO;
}

const doCache = (db, tipo, chave) => db.prepare('SELECT * FROM consultas_cache WHERE tipo = ? AND chave = ?').get(tipo, chave);
const vencido = (x, tipo) => Date.now() - Date.parse(x.consultado_em) > TTL_DIAS[tipo] * 86400_000;

/** Busca JSON tolerando o 404 como resposta de negócio ("não existe") em vez de falha da fonte. */
async function buscar(url) {
  await validarDestino(url);
  let resp;
  try {
    resp = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ManagerNetwork/1.0' }, redirect: 'manual',
      signal: AbortSignal.timeout(config.conectorTimeoutMs) });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? 'a fonte demorou para responder' : `sem conexão com a fonte (${err.cause?.code || err.message})`);
  }
  if (resp.status === 404) return null;
  if (resp.status === 429) throw new Error('a fonte atingiu o limite de consultas');
  if (!resp.ok) throw new Error(`a fonte respondeu HTTP ${resp.status}`);
  const corpo = await resp.text();
  if (corpo.length > 2_000_000) throw new Error('a fonte respondeu um corpo grande demais');
  try { return JSON.parse(corpo); } catch { throw new Error('a fonte não respondeu JSON'); }
}

/**
 * Consulta um CNPJ ou um CEP. Devolve sempre { encontrado, dados, fonte, consultado_em, do_cache, aviso }:
 * `encontrado: false` com `aviso` é resposta normal (não existe, ou nenhuma fonte respondeu) e não é erro.
 */
async function consultar(db, tipo, valor, { forcar = false, org = 0 } = {}) {
  const chave = normalizar(tipo, valor);
  if (!forcar) {
    const c = doCache(db, tipo, chave);
    if (c && !vencido(c, tipo)) {
      return { encontrado: true, tipo, chave, dados: JSON.parse(c.dados), fonte: c.fonte, consultado_em: c.consultado_em, do_cache: true, aviso: null };
    }
  }
  if (!dentroDoLimite(org)) {
    const c = doCache(db, tipo, chave);
    if (c) return { encontrado: true, tipo, chave, dados: JSON.parse(c.dados), fonte: c.fonte, consultado_em: c.consultado_em, do_cache: true,
      aviso: 'Muitas consultas neste minuto: este resultado veio do cache, que pode estar desatualizado.' };
    throw new ErroNegocio(`Muitas consultas de ${tipo.toUpperCase()} neste minuto. Aguarde e tente de novo, ou preencha à mão.`, 429);
  }

  const problemas = [];
  for (const fonte of FONTES[tipo]) {
    let bruto;
    try {
      bruto = await buscar(fonte.url(chave));
    } catch (err) {
      problemas.push(`${fonte.nome}: ${err.message}`);
      continue;
    }
    const dados = bruto === null ? null : fonte.mapear(bruto);
    if (!dados) {
      // A fonte respondeu e não tem o registro: isso é uma resposta, não uma falha.
      return { encontrado: false, tipo, chave, dados: null, fonte: fonte.nome, consultado_em: agora(), do_cache: false,
        aviso: tipo === 'cnpj' ? 'CNPJ não encontrado na base da Receita. Confira o número ou preencha à mão.' : 'CEP não encontrado. Confira o número ou preencha o endereço à mão.' };
    }
    const em = agora();
    db.prepare(`INSERT INTO consultas_cache (tipo, chave, dados, fonte, consultado_em) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tipo, chave) DO UPDATE SET dados = excluded.dados, fonte = excluded.fonte, consultado_em = excluded.consultado_em`)
      .run(tipo, chave, JSON.stringify(dados), fonte.nome, em);
    return { encontrado: true, tipo, chave, dados, fonte: fonte.nome, consultado_em: em, do_cache: false,
      aviso: problemas.length ? `A primeira fonte falhou (${problemas[0]}); o dado veio de ${fonte.nome}.` : null };
  }

  // Nenhuma fonte respondeu: o cache vencido ainda é melhor que nada, desde que dito com todas as letras.
  const c = doCache(db, tipo, chave);
  if (c) {
    return { encontrado: true, tipo, chave, dados: JSON.parse(c.dados), fonte: c.fonte, consultado_em: c.consultado_em, do_cache: true,
      aviso: `Nenhuma fonte respondeu agora (${problemas.join('; ')}). Este resultado é de ${c.consultado_em.slice(0, 10).split('-').reverse().join('/')} e pode estar desatualizado.` };
  }
  return { encontrado: false, tipo, chave, dados: null, fonte: null, consultado_em: null, do_cache: false,
    aviso: `Nenhuma fonte de consulta respondeu (${problemas.join('; ')}). Preencha à mão — o cadastro não depende da consulta.` };
}

module.exports = { consultar, normalizar, capitalizar, FONTES, TTL_DIAS, LIMITE_POR_MINUTO };
