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
const febraban = require('./febraban');
const bancos = require('./bancos');

/** Endereço do IXC normalizado, para saber se dois clientes usam o mesmo IXC. */
const mesmoIxc = (url) => String(url ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;

/**
 * Nosso número que o IXC deu ao título ("00000012345", "12345-P", "000000123456"), em 11 dígitos + DV.
 * Devolve null quando o IXC ainda não gerou o boleto (sem número).
 */
function nossoNumeroDoIxc(valor) {
  const bruto = String(valor ?? '').toUpperCase().trim();
  // Com separador ("12345-6", "0000012345-P"): o que vem depois do traço é o dígito.
  const sep = /^(\d{1,11})\s*[-/]\s*([0-9P])$/.exec(bruto);
  if (sep) return { numero: sep[1].padStart(11, '0'), dv: sep[2] };
  const t = bruto.replace(/[^0-9P]/g, '');
  if (!t) return null;
  if (/^\d{1,11}$/.test(t)) return { numero: t.padStart(11, '0'), dv: null };
  if (/^\d{1,11}[0-9P]$/.test(t) && t.length >= 2) return { numero: t.slice(0, -1).padStart(11, '0'), dv: t.slice(-1) };
  throw new ErroNegocio(`nosso número do IXC em formato desconhecido: ${valor}`, 422);
}
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
/** Clientes com importação em andamento: a manual e a automática nunca rodam juntas (registraria o título duas vezes). */
const importando = new Set();

async function importar(db, cliente, opcoes = {}) {
  if (importando.has(cliente.id)) throw new ErroNegocio('Já há uma importação deste cliente em andamento. Aguarde terminar.', 409);
  importando.add(cliente.id);
  try {
    return await importarAgora(db, cliente, opcoes);
  } finally {
    importando.delete(cliente.id);
  }
}

async function importarAgora(db, cliente, { de, ate, limite = 200, maxPaginas = 50, usuario = null } = {}) {
  const ixc = ixcDoCliente(db, cliente.id);
  if (!ixc) throw new ErroNegocio('O IXC deste cliente ainda não foi configurado.', 409);
  const inicio = agora();
  const sincId = db.prepare(`INSERT INTO sincronismos (cliente_id, tipo, inicio, disparado_por) VALUES (?, 'importacao', ?, ?) RETURNING id`)
    .get(cliente.id, inicio, usuario?.id ?? null).id;

  const resultado = { lidos: 0, criados: 0, ignorados: 0, erros: 0, detalhes: [] };
  try {
    // Todas as páginas do período (antes lia só a primeira: um provedor grande ficava sem boleto).
    const titulos = [];
    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
      const p = await ixc.cliente.titulosEmAberto({ de, ate, rp: limite, pagina });
      titulos.push(...p.titulos);
      if (!p.recebidos || p.recebidos < limite || pagina * limite >= p.total) break;
      if (pagina === maxPaginas) resultado.detalhes.push({ aviso: `mais de ${maxPaginas * limite} títulos no período: o restante entra na próxima rodada` });
    }
    resultado.lidos = titulos.length;
    const cacheClientes = new Map();

    // Só a(s) carteira(s) de cobrança da PAY AX no IXC: título de outra carteira (outro banco, gateway)
    // já tem boleto lá e não pode ganhar um segundo.
    const carteiras = (ixc.config.carteiras ?? []).map(String);
    if (!carteiras.length) {
      const urlDeste = mesmoIxc(ixc.config.url);
      const compartilhado = urlDeste && db.prepare("SELECT config FROM integracoes WHERE escopo = 'ixc' AND cliente_id <> ?").all(cliente.id)
        .some((i) => mesmoIxc(JSON.parse(i.config || '{}').url) === urlDeste);
      if (compartilhado) throw new ErroNegocio('Este IXC atende mais de um cliente da PAY AX: configure a carteira de cobrança deste cliente antes de importar.', 409);
    }
    for (const t of titulos) {
      if (carteiras.length && !carteiras.includes(t.carteira)) { resultado.ignorados += 1; continue; }
      if (!t.vencimento || t.valor_centavos <= 0) { resultado.ignorados += 1; continue; }
      const jaTem = db.prepare("SELECT id FROM boletos WHERE cliente_id = ? AND ixc_receber_id = ? AND situacao NOT IN ('cancelado','falha')")
        .get(cliente.id, t.ixc_id);
      if (jaTem) { resultado.ignorados += 1; continue; }
      try {
        if (!cacheClientes.has(t.ixc_cliente_id)) cacheClientes.set(t.ixc_cliente_id, await ixc.cliente.clientePorId(t.ixc_cliente_id));
        const p = cacheClientes.get(t.ixc_cliente_id);
        if (!p?.documento) { resultado.ignorados += 1; resultado.detalhes.push({ ixc_id: t.ixc_id, motivo: 'pagador sem CPF/CNPJ no IXC' }); continue; }

        // O IXC numera e imprime o boleto: registramos com o número dele, e só se o código que ele calculou
        // for exatamente o que vai para o banco (senão o pagador teria um boleto que o banco não reconhece).
        let nossoNumeroDefinido = null;
        if (ixc.config.numeracao === 'ixc') {
          const nn = nossoNumeroDoIxc(t.bruto?.nn_boleto ?? t.bruto?.nosso_numero);
          if (!nn) { resultado.ignorados += 1; resultado.detalhes.push({ ixc_id: t.ixc_id, motivo: 'o IXC ainda não gerou o boleto (sem nosso número): entra na próxima rodada' }); continue; }
          const n = Number(nn.numero);
          if (!(n >= Number(ixc.config.faixa_inicio) && n <= Number(ixc.config.faixa_fim))) {
            throw new ErroNegocio(`nosso número ${nn.numero} fora da faixa reservada para este cliente (${ixc.config.faixa_inicio} a ${ixc.config.faixa_fim}): confira a carteira PAY AX no IXC`, 422);
          }
          const conta = boletos.contaDe(db, ixc.config.conta_id ?? null);
          const esperado = bancos.calcularBoleto(conta, { nossoNumero: nn.numero, valorCentavos: t.valor_centavos, vencimento: t.vencimento });
          if (nn.dv && nn.dv !== esperado.nosso_numero_dv) {
            throw new ErroNegocio(`dígito do nosso número do IXC (${nn.dv}) diferente do calculado pelo banco (${esperado.nosso_numero_dv}): confira a carteira (09) no IXC`, 422);
          }
          const linhaIxc = String(t.bruto?.linha_digitavel ?? '').replace(/\D/g, '');
          if (linhaIxc && linhaIxc !== esperado.linha_digitavel.replace(/\D/g, '')) {
            throw new ErroNegocio('a linha digitável do boleto do IXC não bate com a do registro: confira agência, conta e carteira da carteira PAY AX no IXC (nada foi registrado)', 422);
          }
          nossoNumeroDefinido = nn.numero;
        }

        const out = await boletos.emitir(db, {
          cliente,
          origem: 'ixc',
          ixc: { receber_id: t.ixc_id, cliente_id: t.ixc_cliente_id },
          nossoNumeroDefinido,
          contaId: ixc.config.numeracao === 'ixc' ? ixc.config.conta_id ?? null : null,
          usuario,
          dados: {
            // Com o layout do IXC, o QR Code PIX do Bolepix não sairia no papel: registra como boleto comum.
            tipo: ixc.config.numeracao === 'ixc' || ixc.config.tipo_padrao === 'boleto' ? 'boleto' : 'bolepix',
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
            pagador_complemento: p.complemento,
            pagador_bairro: p.bairro,
            pagador_cidade: p.cidade,
            pagador_uf: p.uf,
            juros_mes: ixc.config.juros_mes ?? 1,
            multa: ixc.config.multa ?? 2,
            mensagem: ixc.config.mensagem ?? null,
          },
        });
        if (out.ja_existia) { resultado.ignorados += 1; continue; }
        // O banco não registrou: não conta como criado e não devolve ao IXC uma linha que não vale.
        if (out.situacao === 'falha') {
          resultado.erros += 1;
          resultado.detalhes.push({ ixc_id: t.ixc_id, erro: `o banco não registrou o título: ${out.erro ?? 'sem detalhe'}` });
          continue;
        }
        resultado.criados += 1;
        // Devolve ao IXC a linha digitável, para o provedor ver o boleto no título de origem.
        // Quando o IXC numera, o título já tem o número e a linha dele: nada a gravar de volta.
        if (ixc.config.anotar_no_ixc !== false && ixc.config.numeracao !== 'ixc') {
          const b = db.prepare('SELECT linha_digitavel, nosso_numero, nosso_numero_dv FROM boletos WHERE id = ?').get(out.id);
          await ixc.cliente.anotarBoleto(t.ixc_id, { nosso_numero: `${b.nosso_numero}-${b.nosso_numero_dv}` })
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
        AND s.erros = 0 AND (CASE WHEN json_valid(s.detalhe) THEN json_extract(s.detalhe, '$.boleto_id') END) = b.id)
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

module.exports = { mesmoIxc, nossoNumeroDoIxc, ixcDoCliente, testar, importar, avisarBaixa, reprocessarBaixas, hoje };
