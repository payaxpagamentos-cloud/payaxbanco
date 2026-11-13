'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');

/**
 * Alertas de rede escritos pela equipe.
 *
 * O problema que isto resolve: o cadastro do IXC nem sempre está atualizado. Se a ZOE decidir
 * sozinha, pelo cadastro, que existe falha na região do cliente, ela vai afirmar coisa errada —
 * e afirmar errado com confiança é pior do que não saber. Então quem declara a falha é a equipe,
 * que sabe o que está acontecendo, e a ZOE só repassa para quem está dentro da área declarada.
 *
 * Isso também é a ponte até a correlação automática de massiva: enquanto o provedor arruma o
 * cadastro, o alerta manual já entrega o comportamento certo ao cliente.
 *
 * A comparação é por texto normalizado (sem acento, sem caixa, sem espaço sobrando) e exata.
 * Exata de propósito: "Centro" não pode pegar "Centro Novo", e um bairro a mais no alerta manda
 * a ZOE mentir para quem está com a internet funcionando.
 */

const TIPOS = {
  massiva: { nome: 'Falha em massa', explicacao: 'Já identificamos uma falha que atinge vários clientes da mesma área.' },
  manutencao: { nome: 'Manutenção programada', explicacao: 'Serviço planejado, com hora para começar e para terminar.' },
  aviso: { nome: 'Aviso', explicacao: 'Qualquer outra coisa que o cliente daquela área precise saber.' },
};

// Os campos do cadastro do IXC normalmente usados para dizer "onde" o cliente está.
// Nem toda instalação tem todos; os que não existirem são simplesmente ignorados.
const CAMPOS_PADRAO = [
  'bairro', 'cidade', 'endereco', 'condominio', 'referencia', 'cep',
  'id_transmissor', 'transmissor', 'id_caixa', 'caixa', 'olt', 'pop', 'id_condominio',
];

/** Texto comparável: sem acento, sem caixa, sem espaço duplicado. */
const normalizar = (x) => String(x ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

const linhas = (texto) => String(texto ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

/** Os alertas ligados e dentro do período agora. */
const vigentes = (db, empresaId, instante = agora()) => db.prepare(`SELECT * FROM alertas
  WHERE empresa_id = ? AND ativo = 1 AND inicio <= ? AND fim >= ? ORDER BY tipo, inicio DESC`)
  .all(empresaId, instante, instante).map(publico);

const listar = (db, empresaId, { incluirEncerrados = true } = {}) => db.prepare(`SELECT * FROM alertas
  WHERE empresa_id = ? ${incluirEncerrados ? '' : 'AND fim >= ?'} ORDER BY ativo DESC, fim DESC LIMIT 200`)
  .all(...(incluirEncerrados ? [empresaId] : [empresaId, agora()])).map(publico);

function publico(a) {
  if (!a) return null;
  const vigente = Boolean(a.ativo) && a.inicio <= agora() && a.fim >= agora();
  return {
    ...a,
    ativo: Boolean(a.ativo),
    abre_chamado: Boolean(a.abre_chamado),
    campos: linhas(a.campos),
    chaves: linhas(a.chaves),
    clientes: linhas(a.clientes),
    vigente,
    situacao: !a.ativo ? 'desligado' : a.fim < agora() ? 'encerrado' : a.inicio > agora() ? 'agendado' : 'vigente',
    tipo_nome: TIPOS[a.tipo]?.nome ?? a.tipo,
  };
}

const buscar = (db, empresaId, id) => {
  const a = db.prepare('SELECT * FROM alertas WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!a) throw naoEncontrado('Alerta');
  return publico(a);
};

/**
 * Junta os valores do cliente que podem casar com uma chave de alerta.
 * Olha o cadastro, os contratos e os logins, porque a OLT e a caixa vivem no login, não no cliente.
 */
function valoresDoCliente({ cadastro = null, contratos = [], logins = [] } = {}, campos = []) {
  const quais = campos.length ? campos.map(normalizar) : CAMPOS_PADRAO;
  const achados = new Set();
  for (const registro of [cadastro, ...contratos, ...logins]) {
    if (!registro || typeof registro !== 'object') continue;
    for (const [chave, valor] of Object.entries(registro)) {
      if (valor === null || valor === undefined || valor === '') continue;
      if (typeof valor === 'object') continue;
      const nome = normalizar(chave);
      // Casa o nome do campo exatamente ou como sufixo: 'bairro' pega 'bairro' e 'id_bairro'.
      if (!quais.some((q) => nome === q || nome.endsWith(`_${q}`) || nome === `id_${q}`)) continue;
      achados.add(normalizar(valor));
    }
  }
  achados.delete('');
  return achados;
}

/** Os códigos que identificam este cliente (cliente e contratos), para a abrangência por lista. */
function codigosDoCliente({ cadastro = null, contratos = [] } = {}) {
  const c = new Set();
  if (cadastro?.id) c.add(String(cadastro.id).trim());
  for (const ct of contratos) {
    if (ct?.id) c.add(String(ct.id).trim());
    if (ct?.id_contrato) c.add(String(ct.id_contrato).trim());
  }
  c.delete('');
  return c;
}

/**
 * Quais alertas valem para este cliente agora.
 *
 * `dados` traz o que já foi lido do IXC (cadastro, contratos, logins). Sem nada disso, só os
 * alertas de abrangência "todos" são devolvidos — não dá para afirmar que alguém está numa área
 * sem saber onde essa pessoa está, e chutar aqui é exatamente o erro que se quer evitar.
 */
function paraCliente(db, empresaId, dados = null, { instante = agora() } = {}) {
  const lista = vigentes(db, empresaId, instante);
  if (!dados) return lista.filter((a) => a.abrangencia === 'todos');

  const codigos = codigosDoCliente(dados);
  return lista.filter((a) => {
    if (a.abrangencia === 'todos') return true;
    if (a.abrangencia === 'clientes') return a.clientes.some((x) => codigos.has(String(x).trim()));
    const valores = valoresDoCliente(dados, a.campos);
    return a.chaves.some((k) => valores.has(normalizar(k)));
  });
}

/** Conta que o alerta foi usado numa conversa — serve para ver se ele está pegando gente mesmo. */
const marcarAvisado = (db, ids = []) => {
  for (const id of ids) db.prepare('UPDATE alertas SET avisados = avisados + 1 WHERE id = ?').run(Number(id));
};

/** O texto que a ZOE recebe sobre os alertas que valem para esta conversa. */
function nota(aplicaveis = []) {
  if (!aplicaveis.length) return null;
  const partes = aplicaveis.map((a) => {
    const linha = [`${TIPOS[a.tipo]?.nome ?? a.tipo}: ${a.mensagem}`];
    if (a.previsao) linha.push(`Previsão de normalização: ${a.previsao}.`);
    linha.push(a.abre_chamado
      ? 'Mesmo assim, abra o chamado se o cliente quiser registrar.'
      : 'NÃO abra chamado técnico por este motivo: a equipe já está tratando.');
    return `- ${linha.join(' ')}`;
  });
  return 'Alertas de rede em vigor para ESTE cliente, informados pela equipe do provedor '
    + '(são a informação correta, acima do que o cadastro disser):\n'
    + `${partes.join('\n')}\n`
    + 'Conte isso ao cliente com naturalidade quando ele falar de conexão, lentidão ou queda. '
    + 'Não invente detalhe que não esteja escrito aqui.';
}

function salvar(db, empresaId, dados, { id = null, usuario = null } = {}) {
  const atual = id ? db.prepare('SELECT * FROM alertas WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId) : {};
  if (id && !atual) throw naoEncontrado('Alerta');
  const d = dados ?? {};
  // Num alerta novo `atual` é {}, então o campo ausente tem de virar null, não undefined:
  // undefined não se liga a um parâmetro de SQL e o INSERT quebraria.
  const texto = (k, rotulo, max) => (d[k] === undefined ? (atual[k] ?? null) : (v.opcional(d[k], rotulo, max) ?? null));
  const lista = (k) => (d[k] === undefined ? (atual[k] ?? null)
    : (Array.isArray(d[k]) ? d[k] : String(d[k] ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 500).join('\n') || null);

  const campos = {
    titulo: d.titulo === undefined ? atual.titulo : v.texto(d.titulo, 'o título', 120),
    mensagem: d.mensagem === undefined ? atual.mensagem : v.texto(d.mensagem, 'a mensagem para o cliente', 1000),
    tipo: d.tipo === undefined ? (atual.tipo ?? 'massiva') : v.opcao(d.tipo, 'o tipo', Object.keys(TIPOS)),
    abrangencia: d.abrangencia === undefined ? (atual.abrangencia ?? 'chave') : v.opcao(d.abrangencia, 'a abrangência', ['todos', 'chave', 'clientes']),
    campos: lista('campos'),
    chaves: lista('chaves'),
    clientes: lista('clientes'),
    previsao: texto('previsao', 'a previsão', 200),
    abre_chamado: d.abre_chamado === undefined ? (atual.abre_chamado ?? 0) : (v.booleano(d.abre_chamado) ? 1 : 0),
    inicio: d.inicio === undefined ? atual.inicio : v.dataHora(d.inicio, 'o início'),
    fim: d.fim === undefined ? atual.fim : v.dataHora(d.fim, 'o fim'),
    ativo: d.ativo === undefined ? (atual.ativo ?? 1) : (v.booleano(d.ativo) ? 1 : 0),
  };

  v.exigir(campos.titulo && campos.mensagem, 'Informe o título e a mensagem que a ZOE vai dizer.');
  v.exigir(campos.fim > campos.inicio, 'O fim do alerta tem de ser depois do início.');
  if (campos.abrangencia === 'chave') {
    v.exigir(linhas(campos.chaves).length, 'Informe pelo menos uma chave (bairro, cidade, OLT, caixa) que define a área afetada.');
  }
  if (campos.abrangencia === 'clientes') {
    v.exigir(linhas(campos.clientes).length, 'Informe pelo menos um código de cliente ou contrato.');
  }

  const colunas = Object.keys(campos);
  return transacao(db, () => {
    if (id) {
      db.prepare(`UPDATE alertas SET ${colunas.map((k) => `${k} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`)
        .run(...colunas.map((k) => campos[k]), agora(), atual.id);
      return buscar(db, empresaId, atual.id);
    }
    const novo = Number(db.prepare(`INSERT INTO alertas (empresa_id, ${colunas.join(', ')}, criado_por, criado_em)
      VALUES (?, ${colunas.map(() => '?').join(', ')}, ?, ?)`)
      .run(empresaId, ...colunas.map((k) => campos[k]), usuario?.nome ?? null, agora()).lastInsertRowid);
    return buscar(db, empresaId, novo);
  });
}

const excluir = (db, empresaId, id) => {
  const a = buscar(db, empresaId, id);
  db.prepare('DELETE FROM alertas WHERE id = ?').run(a.id);
  return a;
};

module.exports = {
  TIPOS, CAMPOS_PADRAO, normalizar, vigentes, listar, buscar, salvar, excluir,
  paraCliente, valoresDoCliente, codigosDoCliente, nota, marcarAvisado, publico,
};
