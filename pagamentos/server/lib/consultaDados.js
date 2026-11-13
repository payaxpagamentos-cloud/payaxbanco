'use strict';

/*
 * Consulta de CEP e CNPJ para preencher cadastros sozinho — conveniência de tela, nunca uma trava:
 * se a fonte estiver fora do ar, o usuário continua digitando à mão e a emissão segue normalmente.
 *
 * Duas fontes, escolhidas por tipo de consulta:
 *   - 'publica'   → ViaCEP (CEP) e BrasilAPI (CNPJ). Sem custo e sem token.
 *   - 'apibrasil' → gateway contratado da API Brasil. Consome crédito; traz o CNPJ mais completo.
 *
 * Padrão: CEP pela fonte pública (acontece em TODA emissão de boleto — não vale gastar crédito nisso)
 * e CNPJ pela API Brasil quando há token, caindo para a pública quando não há.
 *
 * Toda resposta é guardada em `consultas_cache`: o mesmo CEP ou CNPJ não é perguntado duas vezes
 * dentro da validade, o que economiza crédito e responde na hora.
 */
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const { decifrar } = require('./cripto');
const v = require('./validacao');

const so = (x) => String(x ?? '').replace(/\D/g, '');
const texto = (x) => {
  const t = String(x ?? '').trim();
  return t && t !== 'null' && t !== 'undefined' ? t : null;
};

/**
 * Monta a linha do logradouro. A base da Receita às vezes traz o número dentro do logradouro
 * ("AVENIDA PAULISTA 37" com numero "37"): nesse caso o número sai da linha, para o formulário não duplicar.
 */
function logradouro(tipo, nome, numero) {
  let linha = [texto(tipo), texto(nome)].filter(Boolean).join(' ').trim();
  const n = texto(numero);
  if (linha && n) linha = linha.replace(new RegExp(`[\\s,.-]*${n.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`), '').trim();
  return linha || null;
}

/** Token da API Brasil (cifrado na tabela de integrações). Null quando não configurado. */
function tokenApiBrasil(db) {
  const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'dados' ORDER BY id LIMIT 1").get();
  if (!i?.credenciais || i.estado === 'desabilitada') return null;
  try { return JSON.parse(decifrar(i.credenciais)).token || null; } catch { return null; }
}

/** Fonte efetiva: cai para a pública quando a API Brasil está escolhida mas sem token. */
function fonteDe(db, tipo) {
  const escolhida = tipo === 'cep' ? config.dados.cepFonte : config.dados.cnpjFonte;
  if (escolhida !== 'apibrasil') return { nome: 'publica', token: null };
  const token = tokenApiBrasil(db);
  return token ? { nome: 'apibrasil', token } : { nome: 'publica', token: null };
}

async function buscar(url, { metodo = 'GET', corpo, token } = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      method: metodo,
      headers: {
        Accept: 'application/json',
        // Algumas fontes recusam cliente sem identificação. Nome genérico do sistema: nenhum dado do cliente sai daqui.
        'User-Agent': 'PayAxPagamentos/1.0',
        ...(corpo ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(config.dados.timeoutMs),
    });
  } catch (err) {
    throw new ErroNegocio(
      err.name === 'TimeoutError' ? 'A consulta demorou demais. Preencha os campos à mão.' : 'Não foi possível consultar agora. Preencha os campos à mão.',
      502,
    );
  }
  if (resp.status === 404) throw new ErroNegocio('Não encontrado.', 404);
  if (resp.status === 402) throw new ErroNegocio('Sem saldo na API Brasil: recarregue a conta ou use a fonte pública.', 402);
  if (resp.status === 401 || resp.status === 403) throw new ErroNegocio('A API Brasil recusou o token (confira em Integrações).', 502);
  if (resp.status === 429) throw new ErroNegocio('Muitas consultas seguidas na fonte. Tente de novo em instantes.', 429);
  if (!resp.ok) throw new ErroNegocio(`A fonte respondeu com erro ${resp.status}.`, 502);
  const j = await resp.json().catch(() => null);
  // A API Brasil devolve erro com HTTP 200 e error=true.
  if (j?.error) throw new ErroNegocio(`API Brasil: ${j.message || 'a consulta falhou'}.`, 502);
  return j ?? {};
}

// ---------------------------------------------------------------- CEP
function lerCepPublico(j) {
  if (j?.erro) throw new ErroNegocio('CEP não encontrado.', 404);
  return {
    cep: so(j.cep),
    endereco: texto(j.logradouro ?? j.street),
    complemento: texto(j.complemento),
    bairro: texto(j.bairro ?? j.neighborhood),
    cidade: texto(j.localidade ?? j.city),
    uf: texto(j.uf ?? j.state),
    ibge: texto(j.ibge?.city ?? j.ibge),
  };
}

function lerCepApiBrasil(j) {
  const d = j?.data ?? j?.response ?? j ?? {};
  return {
    cep: so(d.cep),
    endereco: texto(d.logradouro ?? d.street ?? d.address),
    complemento: texto(d.complemento),
    bairro: texto(d.bairro ?? d.district ?? d.neighborhood),
    cidade: texto(d.cidade ?? d.localidade ?? d.city),
    uf: texto(d.uf ?? d.estado ?? d.state),
    ibge: texto(d.ibge),
  };
}

// ---------------------------------------------------------------- CNPJ
/** Só o que o cadastro precisa. Quadro societário e demais dados pessoais não são guardados. */
function lerCnpjPublico(j) {
  const situacao = texto(j.descricao_situacao_cadastral ?? j.situacao);
  return {
    cnpj: so(j.cnpj),
    razao_social: texto(j.razao_social ?? j.nome),
    nome_fantasia: texto(j.nome_fantasia ?? j.fantasia),
    situacao,
    ativa: !situacao || /ativa/i.test(situacao),
    abertura: texto(j.data_inicio_atividade ?? j.abertura),
    porte: texto(j.porte ?? j.descricao_porte),
    atividade: texto(j.cnae_fiscal_descricao ?? j.atividade_principal?.[0]?.text),
    cep: so(j.cep) || null,
    endereco: logradouro(j.descricao_tipo_de_logradouro, j.logradouro, j.numero),
    numero: texto(j.numero),
    complemento: texto(j.complemento),
    bairro: texto(j.bairro),
    cidade: texto(j.municipio ?? j.cidade),
    uf: texto(j.uf),
    email: texto(j.email),
    telefone: so(j.ddd_telefone_1 ?? j.telefone) || null,
  };
}

function lerCnpjApiBrasil(j) {
  const d = j?.data ?? j?.response ?? j ?? {};
  const e = d.estabelecimento ?? d.endereco ?? d;
  const situacao = texto(d.situacao_cadastral ?? d.situacao ?? e.situacao_cadastral);
  return {
    cnpj: so(d.cnpj ?? e.cnpj),
    razao_social: texto(d.razao_social ?? d.nome ?? d.company?.name),
    nome_fantasia: texto(d.nome_fantasia ?? e.nome_fantasia ?? d.fantasia),
    situacao,
    ativa: !situacao || /ativa|02/i.test(situacao),
    abertura: texto(d.data_inicio_atividade ?? e.data_inicio_atividade ?? d.abertura),
    porte: texto(d.porte?.descricao ?? d.porte),
    atividade: texto(e.atividade_principal?.descricao ?? d.atividade_principal?.descricao),
    cep: so(e.cep) || null,
    endereco: logradouro(e.tipo_logradouro, e.logradouro, e.numero),
    numero: texto(e.numero),
    complemento: texto(e.complemento),
    bairro: texto(e.bairro),
    cidade: texto(e.cidade?.nome ?? e.municipio ?? e.cidade),
    uf: texto(e.estado?.sigla ?? e.uf),
    email: texto(e.email ?? d.email),
    telefone: so(`${e.ddd1 ?? ''}${e.telefone1 ?? ''}`) || so(d.telefone) || null,
  };
}

// ---------------------------------------------------------------- Cache
function doCache(db, tipo, chave, validadeDias) {
  const c = db.prepare("SELECT * FROM consultas_cache WHERE tipo = ? AND chave = ? AND consultado_em > datetime('now', ?)")
    .get(tipo, chave, `-${validadeDias} days`);
  if (!c) return null;
  try { return { ...JSON.parse(c.dados), fonte: c.fonte, do_cache: true, consultado_em: c.consultado_em }; } catch { return null; }
}

const guardar = (db, tipo, chave, fonte, dados) => db.prepare(`INSERT INTO consultas_cache (tipo, chave, fonte, dados, consultado_em)
  VALUES (?, ?, ?, ?, ?) ON CONFLICT(tipo, chave) DO UPDATE SET fonte = excluded.fonte, dados = excluded.dados, consultado_em = excluded.consultado_em`)
  .run(tipo, chave, fonte, JSON.stringify(dados), agora());

// ---------------------------------------------------------------- Públicas
/** Endereço pelo CEP. */
async function consultarCep(db, entrada) {
  const cep = so(entrada);
  v.exigir(cep.length === 8, 'CEP inválido: informe os 8 dígitos.');
  const cacheado = doCache(db, 'cep', cep, config.dados.cacheCepDias);
  if (cacheado) return cacheado;

  const fonte = fonteDe(db, 'cep');
  const dados = fonte.nome === 'apibrasil'
    ? lerCepApiBrasil(await buscar(`${config.dados.urlApiBrasil}/cep`, { metodo: 'POST', corpo: { cep }, token: fonte.token }))
    : lerCepPublico(await buscar(`${config.dados.urlViaCep}/${cep}/json/`));

  if (!dados.cidade) throw new ErroNegocio('CEP não encontrado.', 404);
  const saida = { ...dados, cep: dados.cep || cep };
  guardar(db, 'cep', cep, fonte.nome, saida);
  return { ...saida, fonte: fonte.nome, do_cache: false };
}

/** Dados cadastrais pelo CNPJ. */
async function consultarCnpj(db, entrada) {
  const cnpj = so(entrada);
  v.exigir(cnpj.length === 14 && v.cnpjValido(cnpj), 'CNPJ inválido.');
  const cacheado = doCache(db, 'cnpj', cnpj, config.dados.cacheCnpjDias);
  if (cacheado) return cacheado;

  const fonte = fonteDe(db, 'cnpj');
  let dados;
  try {
    dados = fonte.nome === 'apibrasil'
      ? lerCnpjApiBrasil(await buscar(`${config.dados.urlApiBrasil}/cnpj`, { metodo: 'POST', corpo: { cnpj }, token: fonte.token }))
      : lerCnpjPublico(await buscar(`${config.dados.urlBrasilApi}/cnpj/v1/${cnpj}`));
  } catch (err) {
    // Falha na API Brasil (saldo, token, instabilidade) não impede o cadastro: tenta a fonte pública.
    if (fonte.nome !== 'apibrasil' || err.status === 404) throw err;
    dados = lerCnpjPublico(await buscar(`${config.dados.urlBrasilApi}/cnpj/v1/${cnpj}`));
    const alternativa = { ...dados, cnpj: dados.cnpj || cnpj };
    guardar(db, 'cnpj', cnpj, 'publica', alternativa);
    return { ...alternativa, fonte: 'publica', do_cache: false, aviso: `A API Brasil não respondeu (${err.message}); os dados vieram da fonte pública.` };
  }

  if (!dados.razao_social) throw new ErroNegocio('CNPJ não encontrado na Receita.', 404);
  const saida = { ...dados, cnpj: dados.cnpj || cnpj };
  guardar(db, 'cnpj', cnpj, fonte.nome, saida);
  return { ...saida, fonte: fonte.nome, do_cache: false };
}

/** Estado das fontes, para a tela de Integrações. */
const estado = (db) => ({
  cep: { fonte: fonteDe(db, 'cep').nome, escolhida: config.dados.cepFonte },
  cnpj: { fonte: fonteDe(db, 'cnpj').nome, escolhida: config.dados.cnpjFonte },
  apibrasil_configurada: Boolean(tokenApiBrasil(db)),
  cache: db.prepare('SELECT tipo, COUNT(*) AS n FROM consultas_cache GROUP BY tipo').all(),
});

module.exports = { consultarCep, consultarCnpj, estado, tokenApiBrasil, fonteDe,
  lerCepPublico, lerCepApiBrasil, lerCnpjPublico, lerCnpjApiBrasil };
