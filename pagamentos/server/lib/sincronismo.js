'use strict';

/*
 * Integração com o IXC de cada cliente, nos dois sentidos:
 *   - importar: lê os títulos em aberto (fn_areceber) e emite um boleto para cada um;
 *   - avisar baixa: quando o boleto é liquidado, dá baixa no título de origem.
 *
 * Cada passo é registrado em `sincronismos`, com o que foi lido, criado, ignorado e o que falhou.
 */
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const { decifrar } = require('./cripto');
const { criarIxc } = require('./ixc');
const boletos = require('./boletos');
const datas = require('./datas');

const hoje = () => datas.dataLocal(config.fusoPadrao);

/** Configuração do IXC do cliente (credenciais decifradas). Devolve null se não houver. */
function ixcDoCliente(db, clienteId) {
  const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'ixc' AND cliente_id = ?").get(clienteId);
  if (!i?.credenciais || i.estado === 'desabilitada') return null;
  let cred;
  try { cred = JSON.parse(decifrar(i.credenciais)); } catch { return null; }
  if (!cred?.url || !cred?.token) return null;
  return { integracao: i, config: JSON.parse(i.config || '{}'), cliente: criarIxc({ url: cred.url, token: cred.token }) };
}

function marcarEstado(db, clienteId, estado, erro = null) {
  db.prepare("UPDATE integracoes SET estado = ?, ultimo_teste = ?, ultimo_erro = ? WHERE escopo = 'ixc' AND cliente_id = ?")
    .run(estado, agora(), erro, clienteId);
}

/** Testa a conexão com o IXC do cliente. */
async function testar(db, clienteId) {
  const ixc = ixcDoCliente(db, clienteId);
  if (!ixc) throw new ErroNegocio('O IXC deste cliente ainda não foi configurado.', 409);
  try {
    const r = await ixc.cliente.testar();
    marcarEstado(db, clienteId, 'conectada');
    return r;
  } catch (err) {
    marcarEstado(db, clienteId, 'falha', err.message);
    throw new ErroNegocio(`Não foi possível falar com o IXC: ${err.message}`, 502);
  }
}

/**
 * Importa os títulos em aberto do IXC e emite um boleto para cada um.
 * Títulos já importados são ignorados (controle por ixc_receber_id), então pode rodar quantas vezes quiser.
 */
async function importar(db, cliente, { de, ate, limite = 200, usuario = null } = {}) {
  const ixc = ixcDoCliente(db, cliente.id);
  if (!ixc) throw new ErroNegocio('O IXC deste cliente ainda não foi configurado.', 409);
  const inicio = agora();
  const sincId = db.prepare(`INSERT INTO sincronismos (cliente_id, tipo, inicio, disparado_por) VALUES (?, 'importacao', ?, ?) RETURNING id`)
    .get(cliente.id, inicio, usuario?.id ?? null).id;

  const resultado = { lidos: 0, criados: 0, ignorados: 0, erros: 0, detalhes: [] };
  try {
    const { titulos } = await ixc.cliente.titulosEmAberto({ de, ate, rp: limite });
    resultado.lidos = titulos.length;
    const cacheClientes = new Map();

    for (const t of titulos) {
      if (!t.vencimento || t.valor_centavos <= 0) { resultado.ignorados += 1; continue; }
      const jaTem = db.prepare("SELECT id FROM boletos WHERE cliente_id = ? AND ixc_receber_id = ? AND situacao NOT IN ('cancelado','falha')")
        .get(cliente.id, t.ixc_id);
      if (jaTem) { resultado.ignorados += 1; continue; }
      try {
        if (!cacheClientes.has(t.ixc_cliente_id)) cacheClientes.set(t.ixc_cliente_id, await ixc.cliente.clientePorId(t.ixc_cliente_id));
        const p = cacheClientes.get(t.ixc_cliente_id);
        if (!p?.documento) { resultado.ignorados += 1; resultado.detalhes.push({ ixc_id: t.ixc_id, motivo: 'pagador sem CPF/CNPJ no IXC' }); continue; }

        const out = await boletos.emitir(db, {
          cliente,
          origem: 'ixc',
          ixc: { receber_id: t.ixc_id, cliente_id: t.ixc_cliente_id },
          usuario,
          dados: {
            tipo: ixc.config.tipo_padrao === 'boleto' ? 'boleto' : 'bolepix',
            valor_centavos: t.valor_centavos,
            vencimento: t.vencimento,
            seu_numero: t.documento || `IXC-${t.ixc_id}`,
            pagador_nome: p.nome,
            pagador_documento: p.documento,
            pagador_email: p.email,
            pagador_telefone: p.telefone,
            pagador_cep: p.cep,
            pagador_endereco: p.endereco,
            pagador_numero: p.numero,
            pagador_bairro: p.bairro,
            pagador_cidade: p.cidade,
            pagador_uf: p.uf,
            juros_mes: ixc.config.juros_mes ?? 1,
            multa: ixc.config.multa ?? 2,
            mensagem: ixc.config.mensagem ?? null,
          },
        });
        if (out.ja_existia) { resultado.ignorados += 1; continue; }
        resultado.criados += 1;
        // Devolve ao IXC a linha digitável, para o provedor ver o boleto no título de origem.
        if (ixc.config.anotar_no_ixc !== false) {
          const b = db.prepare('SELECT linha_digitavel, nosso_numero, nosso_numero_dv FROM boletos WHERE id = ?').get(out.id);
          await ixc.cliente.anotarBoleto(t.ixc_id, { linha_digitavel: b.linha_digitavel, nosso_numero: `${b.nosso_numero}-${b.nosso_numero_dv}` })
            .catch((err) => resultado.detalhes.push({ ixc_id: t.ixc_id, aviso: `boleto emitido, mas não foi anotado no IXC: ${err.message}` }));
        }
      } catch (err) {
        resultado.erros += 1;
        resultado.detalhes.push({ ixc_id: t.ixc_id, erro: err.message });
      }
    }
    marcarEstado(db, cliente.id, 'conectada');
  } catch (err) {
    resultado.erros += 1;
    resultado.detalhes.push({ erro: err.message });
    marcarEstado(db, cliente.id, 'falha', err.message);
  }

  db.prepare('UPDATE sincronismos SET fim = ?, lidos = ?, criados = ?, ignorados = ?, erros = ?, detalhe = ? WHERE id = ?')
    .run(agora(), resultado.lidos, resultado.criados, resultado.ignorados, resultado.erros,
      JSON.stringify(resultado.detalhes.slice(0, 100)), sincId);
  return { sincronismo_id: sincId, ...resultado };
}

/** Dá baixa no título do IXC que originou o boleto liquidado. Silencioso quando não há IXC configurado. */
async function avisarBaixa(db, boletoId) {
  const b = db.prepare('SELECT * FROM boletos WHERE id = ?').get(Number(boletoId));
  if (!b || b.origem !== 'ixc' || !b.ixc_receber_id || b.situacao !== 'liquidado') return { ignorado: true };
  const ixc = ixcDoCliente(db, b.cliente_id);
  if (!ixc) return { ignorado: true, motivo: 'IXC não configurado' };
  const inicio = agora();
  const sincId = db.prepare(`INSERT INTO sincronismos (cliente_id, tipo, inicio) VALUES (?, 'baixa', ?) RETURNING id`).get(b.cliente_id, inicio).id;
  try {
    await ixc.cliente.baixarTitulo(b.ixc_receber_id, {
      data_recebimento: b.pago_em,
      valor_centavos: b.pago_valor_centavos ?? b.valor_centavos,
      observacao: `Baixa automática PAY AX · boleto ${b.nosso_numero}-${b.nosso_numero_dv}`,
    });
    db.prepare("UPDATE sincronismos SET fim = ?, lidos = 1, criados = 1, detalhe = ? WHERE id = ?")
      .run(agora(), JSON.stringify({ boleto_id: b.id, ixc_id: b.ixc_receber_id }), sincId);
    return { ok: true, ixc_id: b.ixc_receber_id };
  } catch (err) {
    db.prepare("UPDATE sincronismos SET fim = ?, lidos = 1, erros = 1, detalhe = ? WHERE id = ?")
      .run(agora(), JSON.stringify({ boleto_id: b.id, erro: err.message }), sincId);
    return { ok: false, erro: err.message };
  }
}

/** Baixas pendentes: títulos liquidados cujo IXC ainda não foi avisado (rodam na rotina). */
async function reprocessarBaixas(db, limite = 50) {
  const pendentes = db.prepare(`SELECT b.id FROM boletos b
    WHERE b.situacao = 'liquidado' AND b.origem = 'ixc' AND b.ixc_receber_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM sincronismos s WHERE s.cliente_id = b.cliente_id AND s.tipo = 'baixa'
        AND s.erros = 0 AND s.detalhe LIKE '%"boleto_id":' || b.id || '%')
    ORDER BY b.liquidado_em DESC LIMIT ?`).all(limite);
  const out = { tentados: 0, ok: 0, falhas: 0 };
  for (const p of pendentes) {
    out.tentados += 1;
    const r = await avisarBaixa(db, p.id);
    if (r.ok) out.ok += 1;
    else if (r.erro) out.falhas += 1;
  }
  return out;
}

module.exports = { ixcDoCliente, testar, importar, avisarBaixa, reprocessarBaixas, hoje };
