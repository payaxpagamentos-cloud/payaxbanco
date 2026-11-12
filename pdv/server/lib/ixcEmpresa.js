'use strict';

const config = require('../config');
const { agora } = require('../db');
const { cifrar, decifrar } = require('./cripto');
const { criarIxc } = require('./ixc');
const { ErroNegocio } = require('./erros');
const v = require('./validacao');

const FORMAS = ['dinheiro', 'pix', 'debito', 'credito', 'transferencia', 'outro'];

/** Configuração da empresa (cria a linha com os padrões na primeira leitura). */
function lerConfig(db, empresaId) {
  let c = db.prepare('SELECT * FROM config_empresa WHERE empresa_id = ?').get(empresaId);
  if (!c) {
    db.prepare('INSERT INTO config_empresa (empresa_id, atualizado_em) VALUES (?, ?)').run(empresaId, agora());
    c = db.prepare('SELECT * FROM config_empresa WHERE empresa_id = ?').get(empresaId);
  }
  return c;
}

/** Configuração sem os segredos, para o painel. */
function configPublica(db, empresaId) {
  const c = lerConfig(db, empresaId);
  return {
    ixc_url: c.ixc_url,
    ixc_ativo: !!c.ixc_ativo,
    ixc_token_definido: !!c.ixc_token_cifrado,
    ixc_conta_id: c.ixc_conta_id,
    ixc_tipos_recebimento: tiposRecebimento(c),
    baixa_automatica: !!c.baixa_automatica,
    multa_percentual: c.multa_percentual,
    juros_mes_percentual: c.juros_mes_percentual,
    desconto_max_percentual: c.desconto_max_percentual,
    exigir_caixa: !!c.exigir_caixa,
    permitir_avulso: !!c.permitir_avulso,
    comprovante_cabecalho: c.comprovante_cabecalho,
    comprovante_rodape: c.comprovante_rodape,
    atualizado_em: c.atualizado_em,
  };
}

function tiposRecebimento(c) {
  try {
    const m = JSON.parse(c.ixc_tipos_recebimento || '{}');
    return Object.fromEntries(FORMAS.map((f) => [f, m[f] ? String(m[f]) : '']));
  } catch {
    return Object.fromEntries(FORMAS.map((f) => [f, '']));
  }
}

/** Grava a configuração. O token do IXC é cifrado e nunca volta para o painel. */
function salvarConfig(db, empresaId, d) {
  lerConfig(db, empresaId);
  const campos = [];
  const valores = [];
  const por = (coluna, valor) => { campos.push(`${coluna} = ?`); valores.push(valor); };

  if (d.ixc_url !== undefined) por('ixc_url', d.ixc_url ? v.url(d.ixc_url, 'o endereço do IXC', { permitirHttp: config.permitirHttp }) : null);
  if (d.ixc_token) por('ixc_token_cifrado', cifrar(v.texto(d.ixc_token, 'o token do IXC', 300)));
  if (d.ixc_token === null || d.ixc_token === '') por('ixc_token_cifrado', null);
  if (d.ixc_ativo !== undefined) por('ixc_ativo', v.booleano(d.ixc_ativo) ? 1 : 0);
  if (d.ixc_conta_id !== undefined) por('ixc_conta_id', v.opcional(d.ixc_conta_id, 'a conta do IXC', 20));
  if (d.ixc_tipos_recebimento !== undefined) {
    const m = d.ixc_tipos_recebimento ?? {};
    v.exigir(typeof m === 'object' && !Array.isArray(m), 'Tipos de recebimento inválidos.');
    const limpo = {};
    for (const f of FORMAS) if (m[f]) limpo[f] = String(m[f]).trim().slice(0, 20);
    por('ixc_tipos_recebimento', JSON.stringify(limpo));
  }
  if (d.baixa_automatica !== undefined) por('baixa_automatica', v.booleano(d.baixa_automatica) ? 1 : 0);
  if (d.multa_percentual !== undefined) por('multa_percentual', v.percentual(d.multa_percentual, 'a multa'));
  if (d.juros_mes_percentual !== undefined) por('juros_mes_percentual', v.percentual(d.juros_mes_percentual, 'os juros'));
  if (d.desconto_max_percentual !== undefined) por('desconto_max_percentual', v.percentual(d.desconto_max_percentual, 'o desconto máximo'));
  if (d.exigir_caixa !== undefined) por('exigir_caixa', v.booleano(d.exigir_caixa) ? 1 : 0);
  if (d.permitir_avulso !== undefined) por('permitir_avulso', v.booleano(d.permitir_avulso) ? 1 : 0);
  if (d.comprovante_cabecalho !== undefined) por('comprovante_cabecalho', v.opcional(d.comprovante_cabecalho, 'o cabeçalho do comprovante', 300));
  if (d.comprovante_rodape !== undefined) por('comprovante_rodape', v.opcional(d.comprovante_rodape, 'o rodapé do comprovante', 300));

  if (campos.length) {
    por('atualizado_em', agora());
    db.prepare(`UPDATE config_empresa SET ${campos.join(', ')} WHERE empresa_id = ?`).run(...valores, empresaId);
  }
  return configPublica(db, empresaId);
}

/** Cliente do IXC da empresa. Lança erro de negócio quando a integração não está configurada ou está desligada. */
function clienteIxc(db, empresaId, { exigirAtivo = true } = {}) {
  const c = lerConfig(db, empresaId);
  if (!c.ixc_url || !c.ixc_token_cifrado) throw new ErroNegocio('IXC não configurado. Informe o endereço e o token em Configurações.', 409);
  if (exigirAtivo && !c.ixc_ativo) throw new ErroNegocio('A integração com o IXC está desligada nas Configurações.', 409);
  let token;
  try { token = decifrar(c.ixc_token_cifrado); } catch { throw new ErroNegocio('Não foi possível ler o token do IXC (segredo do servidor mudou?). Cadastre o token de novo.', 409); }
  return { ixc: criarIxc({ url: c.ixc_url, token, timeoutMs: config.ixcTimeoutMs }), config: c };
}

/** Existe integração com o IXC pronta para uso? (não lança) */
function ixcPronto(db, empresaId) {
  const c = lerConfig(db, empresaId);
  return !!(c.ixc_url && c.ixc_token_cifrado && c.ixc_ativo);
}

module.exports = { FORMAS, lerConfig, configPublica, salvarConfig, clienteIxc, ixcPronto, tiposRecebimento };
