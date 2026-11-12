'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hoje } = require('./datas');
const { lerConfig, FORMAS } = require('./ixcEmpresa');
const { caixaDoOperador } = require('./caixa');
const v = require('./validacao');

const FORMAS_CARTAO = ['debito', 'credito'];

/**
 * Multa e juros de um título vencido, pelas regras da empresa (multa uma vez e juros por dia corrido no mês).
 * Devolve o acréscimo em centavos; zero quando o título não está vencido.
 */
function acrescimoAtraso(cfg, { valorCentavos, vencimento, data = hoje() }) {
  if (!vencimento || !/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) return { dias: 0, multa_centavos: 0, juros_centavos: 0, total_centavos: 0 };
  const dias = Math.floor((Date.parse(`${data}T12:00:00Z`) - Date.parse(`${vencimento}T12:00:00Z`)) / 86_400_000);
  if (dias <= 0) return { dias: 0, multa_centavos: 0, juros_centavos: 0, total_centavos: 0 };
  const multa = Math.round((valorCentavos * (cfg.multa_percentual ?? 0)) / 100);
  const juros = Math.round((valorCentavos * (cfg.juros_mes_percentual ?? 0) * dias) / 3000);
  return { dias, multa_centavos: multa, juros_centavos: juros, total_centavos: multa + juros };
}

/** Títulos do IXC já com o acréscimo calculado para hoje. */
function comAcrescimo(db, empresaId, faturas, data = hoje()) {
  const cfg = lerConfig(db, empresaId);
  return faturas.map((f) => {
    const a = acrescimoAtraso(cfg, { valorCentavos: f.aberto_centavos, vencimento: f.vencimento, data });
    return { ...f, atraso: a, total_centavos: f.aberto_centavos + a.total_centavos };
  });
}

const buscar = (db, empresaId, id) => {
  const r = db.prepare('SELECT * FROM recebimentos WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!r) throw naoEncontrado('Recebimento');
  return r;
};

/** Recebimento com títulos, pagamentos e os nomes de quem atendeu. */
function detalhe(db, empresaId, id) {
  const r = buscar(db, empresaId, id);
  const extra = db.prepare(`SELECT u.nome AS operador_nome, l.nome AS loja_nome, c.nome AS cancelado_por_nome, f.nome AS conferido_por_nome, p.nome AS pdv_nome
    FROM recebimentos x JOIN usuarios u ON u.id = x.operador_id JOIN lojas l ON l.id = x.loja_id
    LEFT JOIN usuarios c ON c.id = x.cancelado_por LEFT JOIN usuarios f ON f.id = x.conferido_por
    LEFT JOIN caixas k ON k.id = x.caixa_id LEFT JOIN pdvs p ON p.id = k.pdv_id WHERE x.id = ?`).get(id);
  return {
    ...r,
    ...extra,
    titulos: db.prepare('SELECT * FROM recebimento_titulos WHERE recebimento_id = ? ORDER BY id').all(id),
    pagamentos: db.prepare(`SELECT p.*, t.nome AS terminal_nome, x.referencia FROM pagamentos p
      LEFT JOIN terminais t ON t.id = p.terminal_id LEFT JOIN transacoes_cartao x ON x.id = p.transacao_id
      WHERE p.recebimento_id = ? ORDER BY p.id`).all(id),
    divergencias: db.prepare("SELECT * FROM divergencias WHERE recebimento_id = ? AND status = 'aberta' ORDER BY id").all(id),
  };
}

/**
 * Registra um recebimento no balcão: os títulos do IXC escolhidos (ou um recebimento avulso) e as formas de pagamento.
 * Tudo numa transação: ou entra inteiro, ou não entra. A baixa no IXC é feita depois, pela fila.
 */
function criar(db, { empresa, usuario, dados }) {
  const cfg = lerConfig(db, empresa.id);
  return transacao(db, () => {
    const caixa = resolverCaixa(db, empresa, usuario, cfg, dados.caixa_id);
    const titulos = (Array.isArray(dados.titulos) ? dados.titulos : []).map((t, i) => lerTitulo(t, i));
    const avulso = !titulos.length;
    if (avulso && !cfg.permitir_avulso) throw new ErroNegocio('Escolha pelo menos uma fatura. O recebimento avulso está desligado nas Configurações.', 422);
    if (avulso) {
      titulos.push({
        fatura_ixc_id: null,
        contrato_ixc_id: null,
        documento: null,
        descricao: v.texto(dados.descricao, 'a descrição do recebimento avulso', 200),
        vencimento: null,
        valor_centavos: v.centavos(dados.valor_centavos, 'o valor'),
        acrescimo_centavos: 0,
        desconto_centavos: 0,
      });
    }

    const valorTitulos = titulos.reduce((s, t) => s + t.valor_centavos, 0);
    const acrescimo = titulos.reduce((s, t) => s + t.acrescimo_centavos, 0);
    const desconto = titulos.reduce((s, t) => s + t.desconto_centavos, 0);
    const total = valorTitulos + acrescimo - desconto;
    v.exigir(total > 0, 'O total do recebimento deve ser maior que zero.');
    if (desconto > 0) {
      const maximo = Math.round((valorTitulos * (cfg.desconto_max_percentual ?? 0)) / 100);
      v.exigir(desconto <= maximo, cfg.desconto_max_percentual > 0
        ? `O desconto passa do limite de ${cfg.desconto_max_percentual}% (máximo ${(maximo / 100).toFixed(2)}).`
        : 'Desconto não permitido nesta empresa.');
    }
    for (const t of titulos) t.total_centavos = t.valor_centavos + t.acrescimo_centavos - t.desconto_centavos;
    conferirFaturasRepetidas(db, empresa.id, titulos);

    const pagamentos = lerPagamentos(db, empresa, dados.pagamentos, { total, caixa, usuario });
    const momento = agora();
    const numero = (db.prepare('SELECT COALESCE(MAX(numero), 0) AS n FROM recebimentos WHERE empresa_id = ?').get(empresa.id).n) + 1;
    const lojaId = caixa?.loja_id ?? usuario.loja_id ?? db.prepare('SELECT id FROM lojas WHERE empresa_id = ? AND ativa = 1 ORDER BY id LIMIT 1').get(empresa.id)?.id;
    if (!lojaId) throw new ErroNegocio('Cadastre uma loja antes de receber.', 409);

    const r = db.prepare(`INSERT INTO recebimentos (empresa_id, numero, caixa_id, loja_id, operador_id, data, cliente_ixc_id, cliente_nome, cliente_documento, contrato_ixc_id,
        valor_titulos_centavos, acrescimo_centavos, desconto_centavos, valor_centavos, recebido_centavos, troco_centavos, status, ixc_status, conferencia, observacao, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmado', ?, 'pendente', ?, ?)`)
      .run(empresa.id, numero, caixa?.id ?? null, lojaId, usuario.id, hoje(),
        v.opcional(dados.cliente_ixc_id, 'o cliente', 20), v.texto(dados.cliente_nome, 'o nome do cliente', 160),
        dados.cliente_documento ? v.digitos(dados.cliente_documento).slice(0, 14) : null,
        v.opcional(dados.contrato_ixc_id, 'o contrato', 20),
        valorTitulos, acrescimo, desconto, total, pagamentos.recebido, pagamentos.troco,
        avulso ? 'avulso' : 'pendente', v.opcional(dados.observacao, 'a observação', 300), momento);
    const id = Number(r.lastInsertRowid);

    const insTitulo = db.prepare(`INSERT INTO recebimento_titulos (recebimento_id, fatura_ixc_id, contrato_ixc_id, documento, descricao, vencimento,
        valor_centavos, acrescimo_centavos, desconto_centavos, total_centavos, ixc_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of titulos) {
      insTitulo.run(id, t.fatura_ixc_id, t.contrato_ixc_id, t.documento, t.descricao, t.vencimento,
        t.valor_centavos, t.acrescimo_centavos, t.desconto_centavos, t.total_centavos, t.fatura_ixc_id ? 'pendente' : 'avulso');
    }

    const insPagamento = db.prepare(`INSERT INTO pagamentos (recebimento_id, forma, valor_centavos, parcelas, terminal_id, transacao_id, bandeira, nsu, autorizacao, cartao_final, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of pagamentos.lista) {
      insPagamento.run(id, p.forma, p.valor_centavos, p.parcelas, p.terminal_id, p.transacao_id, p.bandeira, p.nsu, p.autorizacao, p.cartao_final, momento);
      if (p.transacao_id) db.prepare('UPDATE transacoes_cartao SET recebimento_id = ?, atualizado_em = ? WHERE id = ?').run(id, momento, p.transacao_id);
    }
    return detalhe(db, empresa.id, id);
  });
}

/** Caixa do recebimento: o aberto do operador (ou o informado). Sem caixa aberto, só recebe se a empresa não exigir. */
function resolverCaixa(db, empresa, usuario, cfg, caixaId) {
  const caixa = caixaId
    ? db.prepare('SELECT * FROM caixas WHERE id = ? AND empresa_id = ?').get(Number(caixaId), empresa.id)
    : caixaDoOperador(db, empresa.id, usuario.id);
  if (caixa) {
    if (caixa.status !== 'aberto') throw new ErroNegocio('O caixa informado já foi fechado.', 409);
    if (caixa.operador_id !== usuario.id) throw new ErroNegocio('Este caixa é de outro operador.', 403);
    return caixa;
  }
  if (cfg.exigir_caixa) throw new ErroNegocio('Abra o caixa antes de receber.', 409);
  return null;
}

/**
 * Trava a cobrança em dobro: uma fatura do IXC já recebida num recebimento confirmado não entra noutro
 * (clique duplicado no balcão, reenvio da mesma tela ou o cliente voltando com o mesmo boleto).
 * Se aquele recebimento foi cancelado, a fatura pode ser recebida de novo.
 */
function conferirFaturasRepetidas(db, empresaId, titulos) {
  const busca = db.prepare(`SELECT r.numero, r.data FROM recebimento_titulos t JOIN recebimentos r ON r.id = t.recebimento_id
    WHERE r.empresa_id = ? AND r.status = 'confirmado' AND t.fatura_ixc_id = ? ORDER BY r.id DESC LIMIT 1`);
  for (const t of titulos) {
    if (!t.fatura_ixc_id) continue;
    const antes = busca.get(empresaId, t.fatura_ixc_id);
    if (antes) {
      throw new ErroNegocio(`A fatura ${t.fatura_ixc_id} já foi recebida no PDV em ${antes.data.split('-').reverse().join('/')} (recebimento ${antes.numero}). Cancele aquele recebimento antes de receber de novo.`, 409);
    }
  }
}

function lerTitulo(t, i) {
  const onde = `do título ${i + 1}`;
  return {
    fatura_ixc_id: v.texto(t.fatura_ixc_id, `a fatura ${onde}`, 20),
    contrato_ixc_id: v.opcional(t.contrato_ixc_id, `o contrato ${onde}`, 20),
    documento: v.opcional(t.documento, `o documento ${onde}`, 60),
    descricao: v.opcional(t.descricao, `a descrição ${onde}`, 200),
    vencimento: t.vencimento ? v.data(t.vencimento, `o vencimento ${onde}`) : null,
    valor_centavos: v.centavos(t.valor_centavos, `o valor ${onde}`),
    acrescimo_centavos: t.acrescimo_centavos ? v.centavos(t.acrescimo_centavos, `o acréscimo ${onde}`, { min: 0 }) : 0,
    desconto_centavos: t.desconto_centavos ? v.centavos(t.desconto_centavos, `o desconto ${onde}`, { min: 0 }) : 0,
  };
}

/** Formas de pagamento: somam o total, cartão sempre ligado a uma cobrança aprovada e troco só em dinheiro. */
function lerPagamentos(db, empresa, entrada, { total, caixa, usuario }) {
  v.exigir(Array.isArray(entrada) && entrada.length, 'Informe ao menos uma forma de pagamento.');
  v.exigir(entrada.length <= 6, 'São aceitas no máximo 6 formas de pagamento por recebimento.');
  const lista = [];
  let soma = 0;
  let recebido = 0;
  let troco = 0;
  for (const [i, p] of entrada.entries()) {
    const onde = `do pagamento ${i + 1}`;
    const forma = v.opcao(p.forma, `a forma ${onde}`, FORMAS);
    const valor = v.centavos(p.valor_centavos, `o valor ${onde}`);
    soma += valor;
    const item = { forma, valor_centavos: valor, parcelas: 1, terminal_id: null, transacao_id: null, bandeira: null, nsu: null, autorizacao: null, cartao_final: null };
    if (forma === 'dinheiro') {
      const entregue = p.recebido_centavos ? v.centavos(p.recebido_centavos, `o valor em dinheiro ${onde}`) : valor;
      v.exigir(entregue >= valor, 'O dinheiro recebido é menor que o valor do pagamento.');
      recebido += entregue;
      troco += entregue - valor;
    } else {
      recebido += valor;
    }
    if (p.transacao_id) {
      const t = db.prepare('SELECT * FROM transacoes_cartao WHERE id = ? AND empresa_id = ?').get(Number(p.transacao_id), empresa.id);
      if (!t) throw naoEncontrado('Cobrança no cartão');
      if (t.status !== 'aprovada') throw new ErroNegocio(`A cobrança no cartão está como ${t.status}. Só uma cobrança aprovada vira recebimento.`, 409);
      if (t.recebimento_id) throw new ErroNegocio('Esta cobrança já foi usada em outro recebimento.', 409);
      v.exigir(t.valor_centavos === valor, 'O valor do pagamento é diferente do valor aprovado na maquininha.');
      v.exigir(t.forma === forma || (t.forma === 'pix' && forma === 'pix'), 'A forma do pagamento é diferente da cobrança aprovada na maquininha.');
      if (caixa && t.caixa_id && t.caixa_id !== caixa.id) throw new ErroNegocio('Esta cobrança foi feita em outro caixa.', 409);
      if (t.operador_id && t.operador_id !== usuario.id) throw new ErroNegocio('Esta cobrança foi feita por outro operador.', 409);
      Object.assign(item, {
        parcelas: t.parcelas, terminal_id: t.terminal_id, transacao_id: t.id, bandeira: t.bandeira, nsu: t.nsu, autorizacao: t.autorizacao, cartao_final: t.cartao_final,
      });
    } else if (FORMAS_CARTAO.includes(forma)) {
      throw new ErroNegocio('Pagamento no cartão exige a cobrança aprovada na maquininha (ou o lançamento manual com o NSU).', 422);
    } else if (forma === 'pix' || forma === 'transferencia' || forma === 'outro') {
      item.nsu = v.opcional(p.nsu, `a identificação ${onde}`, 30);
    }
    lista.push(item);
  }
  v.exigir(soma === total, `A soma das formas de pagamento (${(soma / 100).toFixed(2)}) é diferente do total (${(total / 100).toFixed(2)}).`);
  return { lista, recebido, troco };
}

/** Cancela o recebimento (supervisão). Quando já houve baixa no IXC, o estorno é tentado pela fila. */
function cancelar(db, { empresa, usuario, id, motivo }) {
  return transacao(db, () => {
    const r = buscar(db, empresa.id, id);
    if (r.status === 'cancelado') throw new ErroNegocio('Este recebimento já foi cancelado.', 409);
    const razao = v.texto(motivo, 'o motivo do cancelamento', 300);
    const momento = agora();
    const precisaEstorno = ['baixado', 'parcial', 'manual'].includes(r.ixc_status);
    db.prepare(`UPDATE recebimentos SET status = 'cancelado', cancelado_em = ?, cancelado_por = ?, motivo_cancelamento = ?,
        ixc_status = CASE WHEN ixc_status IN ('pendente','enviando','erro') THEN 'estornado' ELSE ixc_status END WHERE id = ?`)
      .run(momento, usuario.id, razao, r.id);
    if (precisaEstorno) {
      db.prepare(`INSERT OR IGNORE INTO divergencias (empresa_id, recebimento_id, titulo_id, data, tipo, detalhes, valor_pdv_centavos, valor_ixc_centavos, criado_em)
        VALUES (?, ?, NULL, ?, 'cancelado_com_baixa', ?, ?, ?, ?)`)
        .run(empresa.id, r.id, r.data, `Recebimento ${r.numero} cancelado depois da baixa no IXC. Confira o estorno das faturas.`, r.valor_centavos, r.valor_centavos, momento);
    }
    // A cobrança no cartão continua aprovada na operadora: o estorno é feito na maquininha ou no portal do adquirente.
    db.prepare("UPDATE transacoes_cartao SET status = 'estornada', atualizado_em = ? WHERE recebimento_id = ? AND status = 'aprovada'").run(momento, r.id);
    return { ...detalhe(db, empresa.id, r.id), estorno_ixc_necessario: precisaEstorno };
  });
}

/** Lista de recebimentos com filtros do dia a dia (data, caixa, operador, cliente, situação da baixa). */
function listar(db, empresaId, f = {}) {
  const where = ['r.empresa_id = ?'];
  const params = [empresaId];
  const add = (sql, valor) => { where.push(sql); params.push(valor); };
  if (f.de) add('r.data >= ?', v.data(f.de, 'a data inicial'));
  if (f.ate) add('r.data <= ?', v.data(f.ate, 'a data final'));
  if (f.caixa_id) add('r.caixa_id = ?', Number(f.caixa_id));
  if (f.loja_id) add('r.loja_id = ?', Number(f.loja_id));
  if (f.operador_id) add('r.operador_id = ?', Number(f.operador_id));
  if (f.cliente_ixc_id) add('r.cliente_ixc_id = ?', String(f.cliente_ixc_id));
  if (f.status) add('r.status = ?', v.opcao(f.status, 'a situação', ['confirmado', 'cancelado']));
  if (f.ixc_status) add('r.ixc_status = ?', v.opcao(f.ixc_status, 'a situação no IXC', ['pendente', 'enviando', 'baixado', 'parcial', 'erro', 'manual', 'avulso', 'estornado']));
  if (f.conferencia) add('r.conferencia = ?', v.opcao(f.conferencia, 'a conferência', ['pendente', 'conferido', 'divergente']));
  if (f.busca) {
    const t = `%${String(f.busca).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(r.cliente_nome LIKE ? ESCAPE '\\' OR r.cliente_documento LIKE ? ESCAPE '\\' OR CAST(r.numero AS TEXT) = ?)");
    params.push(t, t, String(f.busca).trim());
  }
  const limite = Math.min(500, Number(f.limite) || 100);
  const sql = `SELECT r.*, u.nome AS operador_nome, l.nome AS loja_nome,
      (SELECT GROUP_CONCAT(p.forma) FROM pagamentos p WHERE p.recebimento_id = r.id) AS formas
    FROM recebimentos r JOIN usuarios u ON u.id = r.operador_id JOIN lojas l ON l.id = r.loja_id
    WHERE ${where.join(' AND ')}`;
  const itens = db.prepare(`${sql} ORDER BY r.id DESC LIMIT ?`).all(...params, limite);
  const totais = db.prepare(`SELECT COUNT(*) AS quantidade,
      COALESCE(SUM(CASE WHEN r.status = 'confirmado' THEN r.valor_centavos END), 0) AS total_centavos,
      COALESCE(SUM(r.status = 'cancelado'), 0) AS cancelados FROM (${sql})  r`).get(...params);
  return { itens: itens.map((x) => ({ ...x, formas: x.formas ? [...new Set(x.formas.split(','))] : [] })), ...totais, limite };
}

module.exports = { criar, cancelar, listar, detalhe, buscar, acrescimoAtraso, comAcrescimo, lerPagamentos };
