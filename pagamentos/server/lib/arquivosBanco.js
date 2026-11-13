'use strict';

/*
 * Troca de arquivos com o banco, automática.
 *
 *   SAÍDA  — os títulos emitidos entram numa remessa e o arquivo é escrito na pasta de saída.
 *   ENTRADA — a pasta de entrada é varrida de tempos em tempos; cada retorno novo é lido e aplicado:
 *             entrada confirmada, liquidação (com split na hora), baixa ou rejeição com o motivo.
 *
 * Ninguém gera nem importa arquivo na mão. Quem leva e traz é o agente de transferência do banco,
 * apontado para essas pastas; se um dia for por SFTP, só o transporte muda — o resto continua igual.
 *
 * Nada é processado duas vezes: cada retorno é registrado pela impressão digital (SHA-256) do conteúdo,
 * e a liquidação em si já é idempotente.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const cnab = require('./cnab400');
const datas = require('./datas');
const boletosLib = require('./boletos');
const sincronismo = require('./sincronismo');

const hoje = () => datas.dataLocal(config.fusoPadrao);
const impressaoDigital = (texto) => crypto.createHash('sha256').update(texto).digest('hex');
const garantirPasta = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };

// ---------------------------------------------------------------- Remessa
/** Títulos esperando para ir ao banco: emitidos, ainda não confirmados e sem remessa. */
const pendentes = (db, contaId, limite) => db.prepare(`SELECT * FROM boletos
  WHERE conta_id = ? AND remessa_id IS NULL AND situacao IN ('registrando', 'registrado')
    AND confirmado_em IS NULL
  ORDER BY id LIMIT ?`).all(contaId, limite);

/**
 * Monta e grava a remessa dos títulos pendentes de uma conta.
 * @returns {{id, nome, titulos, caminho}|{vazia: true}}
 */
function gerarRemessa(db, conta, { usuario = null, automatica = true } = {}) {
  const novos = pendentes(db, conta.id, config.cnab.titulosPorRemessa);
  // Instruções já pedidas que ainda precisam ir ao banco (baixa, alteração de vencimento).
  const instrucoes = db.prepare(`SELECT * FROM boletos WHERE conta_id = ? AND comando_pendente IS NOT NULL ORDER BY id LIMIT ?`)
    .all(conta.id, config.cnab.titulosPorRemessa);
  const titulos = [
    ...novos.map((b) => ({ boleto: b, comando: cnab.COMANDO.registrar })),
    ...instrucoes.map((b) => ({ boleto: b, comando: b.comando_pendente })),
  ];
  if (!titulos.length) return { vazia: true, titulos: 0 };

  const sequencial = (db.prepare('SELECT IFNULL(MAX(sequencial), 0) AS s FROM remessas WHERE conta_id = ?').get(conta.id).s || 0) + 1;
  const arquivo = cnab.gerarRemessa({ conta, titulos, sequencial, hoje: hoje() });

  const pasta = garantirPasta(config.cnab.pastaRemessa);
  const caminho = path.join(pasta, arquivo.nome);

  return transacao(db, () => {
    const id = db.prepare(`INSERT INTO remessas (conta_id, sequencial, nome, titulos, valor_centavos, situacao, caminho, automatica, criado_em, criado_por)
      VALUES (?, ?, ?, ?, ?, 'gerada', ?, ?, ?, ?) RETURNING id`)
      .get(conta.id, sequencial, arquivo.nome, titulos.length,
        titulos.reduce((soma, t) => soma + t.boleto.valor_centavos, 0), caminho, automatica ? 1 : 0, agora(), usuario?.id ?? null).id;

    const marcar = db.prepare('UPDATE boletos SET remessa_id = ? WHERE id = ?');
    for (const b of novos) marcar.run(id, b.id);
    // A instrução foi embora: não vai de novo na próxima remessa.
    const limparComando = db.prepare('UPDATE boletos SET comando_pendente = NULL WHERE id = ?');
    for (const b of instrucoes) limparComando.run(b.id);

    // Grava só depois de o banco de dados aceitar: arquivo na pasta é arquivo que o banco vai buscar.
    fs.writeFileSync(caminho, arquivo.conteudo, 'latin1');
    db.prepare("UPDATE remessas SET situacao = 'entregue', entregue_em = ? WHERE id = ?").run(agora(), id);
    return { id, nome: arquivo.nome, titulos: titulos.length, novos: novos.length, instrucoes: instrucoes.length, caminho, sequencial };
  });
}

/** Conteúdo de uma remessa já gerada (para baixar pela tela). */
function conteudoRemessa(db, id) {
  const r = db.prepare('SELECT * FROM remessas WHERE id = ?').get(Number(id));
  if (!r || !r.caminho || !fs.existsSync(r.caminho)) return null;
  return { nome: r.nome, conteudo: fs.readFileSync(r.caminho, 'latin1') };
}

// ---------------------------------------------------------------- Retorno
/** Localiza o título de um registro do retorno pelo nosso número. */
const acharBoleto = (db, registro) => db.prepare('SELECT * FROM boletos WHERE nosso_numero = ? ORDER BY id DESC LIMIT 1')
  .get(String(registro.nosso_numero).padStart(11, '0'));

/**
 * Aplica um registro do retorno ao título. Devolve o que foi feito.
 * A liquidação usa o mesmo caminho do webhook — split, razão e baixa no IXC saem iguais.
 */
function aplicar(db, registro, { creditoEm }) {
  const b = acharBoleto(db, registro);
  if (!b) return { resultado: 'sem_titulo', nosso_numero: registro.nosso_numero };

  switch (registro.acao) {
    case 'confirmado': {
      db.prepare("UPDATE boletos SET situacao = CASE WHEN situacao = 'registrando' THEN 'registrado' ELSE situacao END, confirmado_em = ?, erro_registro = NULL WHERE id = ?")
        .run(agora(), b.id);
      return { resultado: 'confirmado', boleto_id: b.id };
    }
    case 'rejeitado': {
      const motivo = registro.motivos.map((m) => `${m.codigo} ${m.texto}`).join('; ') || `Ocorrência ${registro.ocorrencia}`;
      db.prepare("UPDATE boletos SET situacao = 'falha', erro_registro = ?, motivo_rejeicao = ? WHERE id = ?")
        .run(`O banco recusou o registro: ${motivo}`, motivo, b.id);
      return { resultado: 'rejeitado', boleto_id: b.id, motivo };
    }
    case 'liquidado': {
      const pago = registro.pago_centavos > 0 ? registro.pago_centavos : registro.valor_centavos || b.valor_centavos;
      const out = boletosLib.liquidar(db, b.id, {
        pago_em: registro.creditado_em ?? creditoEm ?? registro.ocorrido_em ?? hoje(),
        valor_pago_centavos: pago,
        juros_centavos: registro.juros_centavos ?? 0,
        desconto_centavos: registro.desconto_centavos ?? 0,
        meio: 'boleto',
      }, { origem: 'retorno' });
      return { resultado: out.ja_liquidado ? 'repetido' : 'liquidado', boleto_id: b.id, ...(out.ja_liquidado ? {} : { split: out }) };
    }
    case 'baixado': {
      if (b.situacao === 'liquidado') return { resultado: 'repetido', boleto_id: b.id };
      db.prepare("UPDATE boletos SET situacao = 'baixado', baixado_em = ?, motivo_baixa = ? WHERE id = ?")
        .run(agora(), registro.ocorrencia_texto, b.id);
      return { resultado: 'baixado', boleto_id: b.id };
    }
    case 'tarifa':
    case 'informativo':
      return { resultado: 'informativo', boleto_id: b.id, texto: registro.ocorrencia_texto };
    default:
      return { resultado: 'nao_tratado', boleto_id: b.id, ocorrencia: registro.ocorrencia };
  }
}

/**
 * Processa um arquivo de retorno inteiro. O mesmo arquivo duas vezes não faz nada na segunda.
 * @returns {{id, ja_processado?: boolean, liquidados, confirmados, baixados, rejeitados, ...}}
 */
function processarRetorno(db, conteudo, { nome, origem = 'pasta', usuario = null } = {}) {
  const impressao = impressaoDigital(conteudo);
  const jaVisto = db.prepare('SELECT * FROM retornos WHERE impressao = ?').get(impressao);
  if (jaVisto) return { id: jaVisto.id, nome: jaVisto.nome, ja_processado: true };

  let lido;
  try {
    lido = cnab.lerRetorno(conteudo);
  } catch (err) {
    const id = db.prepare(`INSERT INTO retornos (nome, impressao, origem, erro, criado_em, criado_por)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(nome ?? 'sem nome', impressao, origem, err.message, agora(), usuario?.id ?? null).id;
    throw new ErroNegocio(`${err.message} (arquivo registrado para conferência, nº ${id})`, 422);
  }

  const contagem = { liquidados: 0, confirmados: 0, baixados: 0, rejeitados: 0, nao_tratados: 0, sem_titulo: 0 };
  const detalhe = [];
  const liquidadosIds = [];

  for (const registro of lido.registros) {
    let r;
    try {
      r = aplicar(db, registro, { creditoEm: lido.header.credito_em });
    } catch (err) {
      r = { resultado: 'erro', nosso_numero: registro.nosso_numero, erro: err.message };
    }
    if (r.resultado === 'liquidado') { contagem.liquidados += 1; liquidadosIds.push(r.boleto_id); }
    else if (r.resultado === 'confirmado') contagem.confirmados += 1;
    else if (r.resultado === 'baixado') contagem.baixados += 1;
    else if (r.resultado === 'rejeitado') contagem.rejeitados += 1;
    else if (r.resultado === 'sem_titulo') contagem.sem_titulo += 1;
    else if (r.resultado === 'nao_tratado' || r.resultado === 'erro') contagem.nao_tratados += 1;
    if (['rejeitado', 'sem_titulo', 'nao_tratado', 'erro'].includes(r.resultado)) {
      detalhe.push({ nosso_numero: registro.nosso_numero, ocorrencia: registro.ocorrencia, ...r });
    }
  }

  const id = db.prepare(`INSERT INTO retornos (nome, impressao, origem, gerado_em, credito_em, registros,
      liquidados, confirmados, baixados, rejeitados, nao_tratados, sem_titulo, detalhe, processado_em, criado_em, criado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(nome ?? 'sem nome', impressao, origem, lido.header.gerado_em, lido.header.credito_em, lido.registros.length,
      contagem.liquidados, contagem.confirmados, contagem.baixados, contagem.rejeitados, contagem.nao_tratados,
      contagem.sem_titulo, detalhe.length ? JSON.stringify(detalhe.slice(0, 200)) : null, agora(), agora(), usuario?.id ?? null).id;

  // Avisa o IXC de cada título liquidado — é o que faz a baixa aparecer no sistema do cliente.
  for (const boletoId of liquidadosIds) sincronismo.avisarBaixa(db, boletoId).catch(() => null);

  return { id, nome, registros: lido.registros.length, credito_em: lido.header.credito_em, ...contagem, detalhe };
}

/** Varre a pasta de entrada e processa o que for novo, movendo o arquivo para a pasta de processados. */
function varrerRetornos(db, { usuario = null } = {}) {
  // A pasta é criada mesmo vazia: o agente de transferência do banco precisa de onde depositar.
  const pasta = garantirPasta(config.cnab.pastaRetorno);
  const processados = [];
  for (const nome of fs.readdirSync(pasta).sort()) {
    const origem = path.join(pasta, nome);
    if (!fs.statSync(origem).isFile()) continue;
    let conteudo;
    try { conteudo = fs.readFileSync(origem, 'latin1'); } catch { continue; }
    if (!cnab.pareceRetorno(conteudo)) continue;
    try {
      const r = processarRetorno(db, conteudo, { nome, origem: 'pasta', usuario });
      processados.push(r);
      // Arquivo entendido sai da pasta de entrada, para a varredura seguinte não reler.
      const destino = path.join(garantirPasta(config.cnab.pastaProcessados), nome);
      fs.renameSync(origem, fs.existsSync(destino) ? `${destino}.${Date.now()}` : destino);
    } catch (err) {
      processados.push({ nome, erro: err.message });
    }
  }
  return { arquivos: processados.length, processados };
}

/** Situação da troca de arquivos, para a tela e para os alertas. */
function situacao(db) {
  const conta = db.prepare('SELECT * FROM contas_bancarias WHERE ativa = 1 ORDER BY padrao DESC, id LIMIT 1').get();
  const aguardando = conta ? db.prepare(`SELECT COUNT(*) AS n, IFNULL(SUM(valor_centavos), 0) AS v FROM boletos
    WHERE conta_id = ? AND remessa_id IS NULL AND confirmado_em IS NULL AND situacao IN ('registrando','registrado')`).get(conta.id) : { n: 0, v: 0 };
  const ultimaRemessa = db.prepare('SELECT * FROM remessas ORDER BY id DESC LIMIT 1').get();
  const ultimoRetorno = db.prepare('SELECT * FROM retornos WHERE erro IS NULL ORDER BY id DESC LIMIT 1').get();
  garantirPasta(config.cnab.pastaRetorno);
  garantirPasta(config.cnab.pastaRemessa);
  const naFila = fs.readdirSync(config.cnab.pastaRetorno)
    .filter((n) => fs.statSync(path.join(config.cnab.pastaRetorno, n)).isFile()).length;
  return {
    modo: config.banco.modo,
    pasta_remessa: config.cnab.pastaRemessa,
    pasta_retorno: config.cnab.pastaRetorno,
    aguardando_remessa: { titulos: aguardando.n, valor_centavos: aguardando.v },
    ultima_remessa: ultimaRemessa ?? null,
    ultimo_retorno: ultimoRetorno ?? null,
    retornos_na_fila: naFila,
    nao_confirmados: db.prepare(`SELECT COUNT(*) AS n FROM boletos WHERE remessa_id IS NOT NULL AND confirmado_em IS NULL
      AND situacao IN ('registrando','registrado') AND criado_em < datetime('now', '-2 days')`).get().n,
  };
}

/** Rotina: manda o que está esperando e lê o que chegou. */
async function rodar(db) {
  const out = { remessa: null, retorno: null };
  try {
    out.retorno = varrerRetornos(db);
  } catch (err) {
    out.retorno = { erro: err.message };
  }
  if (config.cnab.remessaAutomatica && config.banco.modo === 'cnab' && datas.ehDiaUtil(hoje())) {
    try {
      const conta = db.prepare('SELECT * FROM contas_bancarias WHERE ativa = 1 ORDER BY padrao DESC, id LIMIT 1').get();
      if (conta) out.remessa = gerarRemessa(db, conta, { automatica: true });
    } catch (err) {
      out.remessa = { erro: err.message };
    }
  }
  return out;
}

module.exports = { gerarRemessa, conteudoRemessa, processarRetorno, varrerRetornos, situacao, rodar, aplicar, impressaoDigital, pendentes };
