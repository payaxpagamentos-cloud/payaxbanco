'use strict';

/*
 * Número da conta do cliente DENTRO da PayAx (a identidade da conta gráfica).
 *
 * ATENÇÃO — não confundir com a agência e a conta do Bradesco:
 *   - `contas_bancarias.agencia` / `.conta` são do banco, vão no código de barras e identificam o convênio;
 *   - `clientes.agencia_interna` / `.conta_interna` são nossas, servem para o cliente se identificar
 *     (Internet Bank, extrato, suporte) e NUNCA entram no boleto.
 *
 * Numeração sequencial: agência 001 com contas 0001, 0002, 0003… Ao chegar no limite da agência,
 * a próxima conta abre a agência 002, e assim por diante. O número é atribuído uma vez e não muda.
 */
const agora = () => new Date().toISOString();

const so = (x) => String(x ?? '').replace(/\D/g, '');

/**
 * Dígito verificador da conta: módulo 11 com pesos 2..7 da direita para a esquerda, sobre agência + conta.
 * Resto que daria 10 ou 11 vira 0, para o dígito ser sempre numérico.
 */
function dv(agencia, conta) {
  const base = `${so(agencia).padStart(3, '0')}${so(conta).padStart(4, '0')}`;
  let soma = 0;
  let peso = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    soma += Number(base[i]) * peso;
    peso = peso === 7 ? 2 : peso + 1;
  }
  const d = 11 - (soma % 11);
  return String(d > 9 ? 0 : d);
}

/** "001 · 0001-5" para a tela; `curto` devolve "001/0001-5". */
const formatar = (agencia, conta, digito, { curto = false } = {}) => {
  if (!agencia || !conta) return '—';
  const d = digito ?? dv(agencia, conta);
  return curto ? `${agencia}/${conta}-${d}` : `${agencia} · ${conta}-${d}`;
};

/** Confere um número informado (ex.: o cliente dita a conta no atendimento). */
function conferir(agencia, conta, digito) {
  return dv(agencia, conta) === String(digito ?? '').replace(/\D/g, '');
}

/**
 * Reserva o próximo número livre. Usa a agência aberta com vaga; se não houver, abre a seguinte.
 * Deve rodar dentro de uma transação — quem chama já está em uma.
 */
function proximoNumero(db) {
  let ag = db.prepare('SELECT * FROM contas_internas WHERE proxima <= limite ORDER BY agencia LIMIT 1').get();
  if (!ag) {
    const ultima = db.prepare('SELECT agencia FROM contas_internas ORDER BY agencia DESC LIMIT 1').get();
    const nova = String((Number(ultima?.agencia ?? 0) || 0) + 1).padStart(3, '0');
    if (Number(nova) > 999) throw new Error('As agências internas acabaram (999). Aumente o limite por agência.');
    db.prepare('INSERT INTO contas_internas (agencia, proxima, limite, criada_em) VALUES (?, 1, 9999, ?)').run(nova, agora());
    ag = db.prepare('SELECT * FROM contas_internas WHERE agencia = ?').get(nova);
  }
  const numero = String(ag.proxima).padStart(4, '0');
  db.prepare('UPDATE contas_internas SET proxima = proxima + 1 WHERE agencia = ?').run(ag.agencia);
  return { agencia: ag.agencia, conta: numero, dv: dv(ag.agencia, numero) };
}

/** Atribui o número a um cliente que ainda não tem. Idempotente: quem já tem, mantém. */
function atribuir(db, clienteId) {
  const c = db.prepare('SELECT id, agencia_interna, conta_interna, conta_interna_dv FROM clientes WHERE id = ?').get(clienteId);
  if (!c) return null;
  if (c.agencia_interna && c.conta_interna) {
    return { agencia: c.agencia_interna, conta: c.conta_interna, dv: c.conta_interna_dv };
  }
  const n = proximoNumero(db);
  db.prepare('UPDATE clientes SET agencia_interna = ?, conta_interna = ?, conta_interna_dv = ? WHERE id = ?')
    .run(n.agencia, n.conta, n.dv, clienteId);
  return n;
}

/**
 * Dá número a todos os clientes que ainda não têm, na ordem de cadastro.
 * Roda no start (cobre o banco que já existia antes desta numeração) e é barato quando não há pendência.
 */
function garantirTodos(db) {
  const pendentes = db.prepare('SELECT id FROM clientes WHERE agencia_interna IS NULL ORDER BY id').all();
  if (!pendentes.length) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of pendentes) atribuir(db, p.id);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* já desfeita */ }
    throw err;
  }
  return pendentes.length;
}

/** Procura o cliente por um número informado ("0001", "001/0001", "001 0001-5"). */
function clientePorNumero(db, texto) {
  const d = so(texto);
  if (!d) return null;
  if (d.length >= 7) {
    const ag = d.slice(0, 3);
    const conta = d.slice(3, 7);
    return db.prepare('SELECT * FROM clientes WHERE agencia_interna = ? AND conta_interna = ?').get(ag, conta) ?? null;
  }
  const conta = d.padStart(4, '0');
  const achados = db.prepare('SELECT * FROM clientes WHERE conta_interna = ?').all(conta);
  return achados.length === 1 ? achados[0] : null;
}

/** Resumo das agências, para a tela de configuração. */
const agencias = (db) => db.prepare(`SELECT ci.agencia, ci.proxima, ci.limite, ci.criada_em,
    (SELECT COUNT(*) FROM clientes c WHERE c.agencia_interna = ci.agencia) AS clientes,
    ci.limite - ci.proxima + 1 AS vagas
  FROM contas_internas ci ORDER BY ci.agencia`).all();

module.exports = { dv, formatar, conferir, proximoNumero, atribuir, garantirTodos, clientePorNumero, agencias };
