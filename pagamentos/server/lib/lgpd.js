'use strict';

/*
 * LGPD (Lei 13.709/2018): o processo inteiro num lugar só.
 *
 *   INVENTÁRIO (art. 37) — a lista do que a PAY AX trata, de quem, para quê, com que base legal,
 *     com quem compartilha e por quanto tempo guarda. É a fonte única: o aviso de privacidade
 *     público e o registro das operações saem daqui, então não há como um dizer uma coisa e o
 *     sistema fazer outra.
 *   AVISO DE PRIVACIDADE (art. 9º) — página pública, ligada no boleto e na Área do Cliente.
 *   ENCARREGADO (art. 41) — nome e contato publicados no aviso.
 *   PEDIDOS DO TITULAR (arts. 18 e 19) — formulário público com protocolo; resposta completa em
 *     até 15 dias (art. 19, II). A identidade é conferida antes de responder: confirmar a um
 *     desconhecido que um CPF paga um provedor já seria vazar dado.
 *   RETENÇÃO (arts. 15 e 16) — os registros financeiros ficam 5 anos depois de concluído o título
 *     (Lei 9.613/1998, art. 10, § 2º, e prazos fiscais); passado isso, o sistema anonimiza sozinho.
 *     Endereço IP da auditoria: 6 meses (Marco Civil da Internet, art. 15), depois é apagado.
 *   INCIDENTES (art. 48) — registro e prazo de comunicação à ANPD e aos titulares (Resolução
 *     CD/ANPD nº 15/2024: 3 dias úteis a partir do conhecimento do incidente).
 *
 * Os textos para o titular são minuta técnica fiel ao que o sistema faz; a revisão jurídica é
 * acompanhamento na Conformidade.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const datas = require('./datas');
const { transacao, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');
const { parametro, gravarParametro } = require('./doisfatores');

const hoje = () => datas.dataLocal(config.fusoPadrao);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- Inventário (art. 37)
const INVENTARIO = Object.freeze([
  {
    id: 'pagadores',
    titulo: 'Quem paga um boleto emitido pela PAY AX',
    titulares: 'Assinantes dos provedores clientes da PAY AX (pagadores)',
    dados: ['nome', 'CPF ou CNPJ', 'endereço (quando o provedor informa)', 'e-mail e telefone (quando o provedor informa)',
      'valor, vencimento, data e forma de pagamento'],
    finalidade: 'Emitir, registrar no banco e receber a cobrança a pedido do provedor; avisar o provedor do pagamento; repassar o valor a ele.',
    base_legal: 'Execução do contrato entre o titular e o provedor (art. 7º, V) e cumprimento de obrigação legal ou regulatória (art. 7º, II): registro do boleto no banco e guarda dos registros financeiros.',
    compartilhamento: ['Banco Bradesco: registro e liquidação do boleto', 'O provedor que emitiu a cobrança (inclusive o sistema IXC dele)',
      'Coaf, quando a Lei 9.613/1998 obriga a comunicar'],
    retencao: '5 anos depois de pago, baixado ou cancelado o boleto; depois, anonimizado.',
    papel: 'A PAY AX processa a cobrança a pedido do provedor e cumpre obrigações legais próprias (registro bancário, guarda e prevenção à lavagem de dinheiro).',
  },
  {
    id: 'usuarios-clientes',
    titulo: 'Quem acessa a Área do Cliente',
    titulares: 'Pessoas indicadas pelos provedores clientes para acessar a Área do Cliente',
    dados: ['nome', 'e-mail', 'senha (guardada só como resumo criptográfico, irreversível)', 'segredo de verificação em duas etapas',
      'registros de acesso: data, hora e endereço IP'],
    finalidade: 'Dar acesso seguro à Área do Cliente e registrar quem fez cada operação.',
    base_legal: 'Execução do contrato com o provedor (art. 7º, V) e cumprimento de obrigação legal (art. 7º, II): guarda dos registros de acesso (Marco Civil da Internet, art. 15).',
    compartilhamento: ['Nenhum, salvo ordem judicial'],
    retencao: 'Enquanto o acesso existir. Endereço IP dos registros: 6 meses. Registro das operações: 5 anos.',
    papel: 'Controladora.',
  },
  {
    id: 'socios-representantes',
    titulo: 'Sócios e representantes dos provedores clientes',
    titulares: 'Sócios e representantes legais das empresas clientes da PAY AX',
    dados: ['nome', 'qualificação (sócio, administrador)', 'CPF dos representantes'],
    finalidade: 'Identificar o cliente e quem o representa, como exige a lei de prevenção à lavagem de dinheiro.',
    base_legal: 'Cumprimento de obrigação legal (art. 7º, II): Lei 9.613/1998, art. 10, I e § 1º.',
    compartilhamento: ['Coaf, quando a lei obriga a comunicar'],
    retencao: '5 anos depois do fim do relacionamento com o cliente (Lei 9.613/1998, art. 10, § 2º).',
    papel: 'Controladora.',
  },
  {
    id: 'contatos-clientes',
    titulo: 'Contatos das empresas clientes',
    titulares: 'Responsáveis e contatos indicados pelos provedores clientes',
    dados: ['nome do responsável', 'e-mail', 'telefone'],
    finalidade: 'Falar com o cliente sobre o serviço, a cobrança e os repasses.',
    base_legal: 'Execução do contrato com o provedor (art. 7º, V).',
    compartilhamento: ['Nenhum'],
    retencao: 'Enquanto durar o contrato e 5 anos depois.',
    papel: 'Controladora.',
  },
  {
    id: 'equipe',
    titulo: 'Equipe da PAY AX',
    titulares: 'Funcionários e colaboradores com acesso ao Backoffice',
    dados: ['nome', 'e-mail', 'senha (resumo criptográfico)', 'segredo de duas etapas', 'registros de acesso e de operações'],
    finalidade: 'Controle de acesso e trilha de auditoria das operações financeiras.',
    base_legal: 'Execução do contrato de trabalho ou prestação de serviço (art. 7º, V) e legítimo interesse na segurança (art. 7º, IX).',
    compartilhamento: ['Nenhum'],
    retencao: 'Enquanto o acesso existir. Endereço IP: 6 meses. Registro das operações: 5 anos.',
    papel: 'Controladora.',
  },
]);

const DIREITOS = Object.freeze([
  ['acesso', 'Confirmar se tratamos seus dados e ter acesso a eles', 'art. 18, I e II'],
  ['correcao', 'Corrigir dados incompletos, inexatos ou desatualizados', 'art. 18, III'],
  ['eliminacao', 'Anonimizar, bloquear ou eliminar dados desnecessários, excessivos ou tratados em desconformidade', 'art. 18, IV'],
  ['portabilidade', 'Levar seus dados a outro fornecedor', 'art. 18, V'],
  ['compartilhamento', 'Saber com quem compartilhamos seus dados', 'art. 18, VII'],
  ['oposicao', 'Opor-se a um tratamento que descumpra a lei', 'art. 18, § 2º'],
]);
const TIPOS = Object.fromEntries(DIREITOS.map(([k, t]) => [k, t]));

// ---------------------------------------------------------------- Controlador e encarregado (art. 41)
function controlador(db) {
  const c = db.prepare('SELECT beneficiario_nome, beneficiario_documento, beneficiario_endereco, beneficiario_cidade, beneficiario_uf FROM contas_bancarias WHERE ativa = 1 ORDER BY padrao DESC, id LIMIT 1').get();
  return {
    nome: c?.beneficiario_nome ?? 'PAY AX Brasil Ltda',
    documento: c?.beneficiario_documento ?? null,
    endereco: c ? [c.beneficiario_endereco, [c.beneficiario_cidade, c.beneficiario_uf].filter(Boolean).join('/')].filter(Boolean).join(' · ') : null,
  };
}

function encarregado(db) {
  return {
    nome: parametro(db, 'lgpd_encarregado_nome'),
    email: parametro(db, 'lgpd_encarregado_email'),
    telefone: parametro(db, 'lgpd_encarregado_telefone'),
  };
}

function gravarEncarregado(db, dados) {
  const nome = v.texto(dados.nome, 'o nome do encarregado', 120);
  const email = v.email(dados.email);
  const telefone = dados.telefone ? v.telefone(dados.telefone) : null;
  gravarParametro(db, 'lgpd_encarregado_nome', nome);
  gravarParametro(db, 'lgpd_encarregado_email', email);
  gravarParametro(db, 'lgpd_encarregado_telefone', telefone ?? '');
  return encarregado(db);
}

// ---------------------------------------------------------------- Pedidos do titular (arts. 18 e 19)
const PRAZO_RESPOSTA_DIAS = 15; // art. 19, II

function novoProtocolo(db) {
  const ano = hoje().slice(0, 4);
  const n = db.prepare("SELECT COUNT(*) AS n FROM lgpd_pedidos WHERE substr(criado_em, 1, 4) = ?").get(ano).n + 1;
  return `LGPD-${ano}-${String(n).padStart(6, '0')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function criarPedido(db, dados, { ip = null } = {}) {
  const tipo = v.opcao(dados.tipo, 'o tipo do pedido', Object.keys(TIPOS));
  const pedido = {
    tipo,
    titular_nome: v.texto(dados.nome, 'o seu nome', 120),
    titular_documento: v.documento(dados.documento, 'o seu CPF ou CNPJ'),
    titular_email: v.email(dados.email),
    mensagem: v.opcional(dados.mensagem, 'a mensagem', 2000),
  };
  return transacao(db, () => {
    const protocolo = novoProtocolo(db);
    const prazo = datas.somarDias(hoje(), PRAZO_RESPOSTA_DIAS);
    const id = db.prepare(`INSERT INTO lgpd_pedidos (protocolo, tipo, titular_nome, titular_documento, titular_email, mensagem,
        situacao, prazo, ip, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, 'recebido', ?, ?, ?, ?) RETURNING id`)
      .get(protocolo, tipo, pedido.titular_nome, pedido.titular_documento, pedido.titular_email, pedido.mensagem, prazo, ip, agora(), agora()).id;
    return { id, protocolo, prazo, tipo };
  });
}

function pedido(db, id) {
  const p = db.prepare(`SELECT p.*, u.nome AS atendente FROM lgpd_pedidos p LEFT JOIN usuarios u ON u.id = p.atendente_id WHERE p.id = ?`).get(id);
  if (!p) throw naoEncontrado('Pedido');
  return { ...p, tipo_nome: TIPOS[p.tipo] ?? p.tipo };
}

function listarPedidos(db, { abertos = false } = {}) {
  return db.prepare(`SELECT id, protocolo, tipo, titular_nome, situacao, prazo, criado_em, respondido_em FROM lgpd_pedidos
    ${abertos ? "WHERE situacao IN ('recebido','em_atendimento')" : ''}
    ORDER BY CASE WHEN situacao IN ('recebido','em_atendimento') THEN 0 ELSE 1 END, prazo, id DESC LIMIT 500`).all()
    .map((p) => ({ ...p, tipo_nome: TIPOS[p.tipo] ?? p.tipo, vencido: ['recebido', 'em_atendimento'].includes(p.situacao) && p.prazo < hoje() }));
}

/** A equipe confirmou que quem pediu é o titular (ex.: resposta pelo e-mail que consta nos boletos, documento com foto). */
function verificarIdentidade(db, id, { como }, usuario) {
  const p = pedido(db, id);
  if (p.situacao !== 'recebido') throw new ErroNegocio(`O pedido já está "${p.situacao}".`, 409);
  const texto = v.texto(como, 'como a identidade foi conferida', 300);
  db.prepare(`UPDATE lgpd_pedidos SET situacao = 'em_atendimento', identidade_verificada_em = ?, identidade_como = ?, atendente_id = ?, atualizado_em = ?
    WHERE id = ?`).run(agora(), texto, usuario.id, agora(), id);
  return pedido(db, id);
}

/**
 * Responde o pedido. "atendido" ou "recusado"; recusa exige o motivo (art. 18, § 4º) — o mais comum
 * é a guarda obrigatória por lei (art. 16, I) num pedido de eliminação.
 */
function responder(db, id, { resultado, resposta }, usuario) {
  const p = pedido(db, id);
  if (p.situacao !== 'em_atendimento') throw new ErroNegocio('Confira a identidade do titular antes de responder.', 409);
  const r = v.opcao(resultado, 'o resultado', ['atendido', 'recusado']);
  const texto = v.texto(resposta, 'a resposta', 4000);
  if (texto.length < 20) throw new ErroNegocio('Escreva a resposta ao titular (pelo menos 20 caracteres).', 422);
  db.prepare(`UPDATE lgpd_pedidos SET situacao = ?, resposta = ?, respondido_em = ?, atendente_id = COALESCE(atendente_id, ?), atualizado_em = ?
    WHERE id = ?`).run(r, texto, agora(), usuario.id, agora(), id);
  return pedido(db, id);
}

/**
 * Tudo o que o sistema guarda de um titular, para responder ao pedido de acesso (art. 19, II).
 *
 * Fica DE FORA o que estiver em análise de prevenção à lavagem de dinheiro: a Lei 9.613/1998
 * (art. 11, II) proíbe dar ciência dessas análises "inclusive àquela à qual se refira a informação".
 */
function dadosDoTitular(db, documento) {
  const doc = v.documento(documento, 'o CPF ou CNPJ');
  const boletos = db.prepare(`SELECT b.nosso_numero, b.seu_numero, b.emissao, b.vencimento, b.valor_centavos, b.situacao, b.pago_em,
      b.pago_valor_centavos, b.pagador_nome, b.pagador_email, b.pagador_telefone, b.pagador_endereco, b.pagador_numero,
      b.pagador_bairro, b.pagador_cidade, b.pagador_uf, b.pagador_cep, b.anonimizado_em,
      COALESCE(c.nome_fantasia, c.razao_social) AS provedor, c.razao_social AS provedor_razao_social, c.cnpj AS provedor_cnpj
    FROM boletos b JOIN clientes c ON c.id = b.cliente_id WHERE b.pagador_documento = ? ORDER BY b.emissao`).all(doc);
  return {
    documento: doc,
    gerado_em: agora(),
    como_pagador: boletos,
    // Acessos à Área do Cliente são identificados por e-mail, não por CPF: quem pede sobre eles é
    // atendido pelo e-mail do pedido, na tela da LGPD, consultando Clientes → Acessos.
    compartilhamento: INVENTARIO.find((x) => x.id === 'pagadores').compartilhamento,
    observacao: 'Registros sob sigilo legal (Lei 9.613/1998, art. 11, II) não fazem parte deste relatório.',
  };
}

// ---------------------------------------------------------------- Incidentes (art. 48)
const PRAZO_INCIDENTE_DIAS_UTEIS = 3; // Resolução CD/ANPD nº 15/2024

function registrarIncidente(db, dados, usuario) {
  const descoberto = v.data(dados.descoberto_em ?? hoje(), 'a data em que o incidente foi descoberto');
  const inc = {
    descricao: v.texto(dados.descricao, 'o que aconteceu', 4000),
    dados_afetados: v.texto(dados.dados_afetados, 'quais dados foram afetados', 1000),
    titulares_estimados: v.inteiroOpcional(dados.titulares_estimados, 'quantos titulares', { min: 0, max: 100_000_000 }),
    risco: v.opcao(dados.risco ?? 'em_avaliacao', 'o risco', ['em_avaliacao', 'relevante', 'nao_relevante']),
    medidas: v.opcional(dados.medidas, 'as medidas tomadas', 4000),
  };
  // O prazo conta da descoberta, não da conclusão sobre o risco: 3 dias úteis a partir do dia seguinte
  // (descoberto na sexta, o prazo é a quarta).
  const prazo = datas.somarDiasUteis(datas.somarDias(descoberto, 1), PRAZO_INCIDENTE_DIAS_UTEIS - 1);
  return db.prepare(`INSERT INTO lgpd_incidentes (descoberto_em, descricao, dados_afetados, titulares_estimados, risco, medidas,
      prazo_comunicacao, registrado_por, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(descoberto, inc.descricao, inc.dados_afetados, inc.titulares_estimados, inc.risco, inc.medidas, prazo, usuario.id, agora(), agora());
}

function atualizarIncidente(db, id, dados) {
  const i = db.prepare('SELECT * FROM lgpd_incidentes WHERE id = ?').get(id);
  if (!i) throw naoEncontrado('Incidente');
  const n = { ...i };
  if (dados.risco !== undefined) n.risco = v.opcao(dados.risco, 'o risco', ['em_avaliacao', 'relevante', 'nao_relevante']);
  if (dados.medidas !== undefined) n.medidas = v.opcional(dados.medidas, 'as medidas', 4000);
  if (dados.anpd_protocolo !== undefined && dados.anpd_protocolo !== '') {
    n.anpd_protocolo = v.texto(dados.anpd_protocolo, 'o protocolo da ANPD', 80);
    n.anpd_comunicada_em = n.anpd_comunicada_em ?? agora();
  }
  if (v.booleano(dados.titulares_comunicados ?? false)) n.titulares_comunicados_em = n.titulares_comunicados_em ?? agora();
  if (v.booleano(dados.encerrar ?? false)) {
    if (n.risco === 'em_avaliacao') throw new ErroNegocio('Conclua a avaliação de risco antes de encerrar.', 409);
    if (n.risco === 'relevante' && !(n.anpd_comunicada_em && n.titulares_comunicados_em)) {
      throw new ErroNegocio('Incidente com risco relevante só se encerra depois de comunicar a ANPD e os titulares (art. 48).', 409);
    }
    n.encerrado_em = agora();
  }
  db.prepare(`UPDATE lgpd_incidentes SET risco = ?, medidas = ?, anpd_protocolo = ?, anpd_comunicada_em = ?, titulares_comunicados_em = ?,
      encerrado_em = ?, atualizado_em = ? WHERE id = ?`)
    .run(n.risco, n.medidas, n.anpd_protocolo, n.anpd_comunicada_em, n.titulares_comunicados_em, n.encerrado_em, agora(), id);
  return db.prepare('SELECT * FROM lgpd_incidentes WHERE id = ?').get(id);
}

function listarIncidentes(db) {
  return db.prepare('SELECT i.*, u.nome AS registrado_por_nome FROM lgpd_incidentes i LEFT JOIN usuarios u ON u.id = i.registrado_por ORDER BY i.id DESC').all()
    .map((i) => ({ ...i, comunicacao_atrasada: incidenteAtrasado(i) }));
}

/** Risco relevante ou ainda em avaliação, sem a comunicação à ANPD, depois do prazo. */
const incidenteAtrasado = (i, data = hoje()) => !i.encerrado_em && i.risco !== 'nao_relevante' && !i.anpd_comunicada_em && i.prazo_comunicacao < data;

// ---------------------------------------------------------------- Retenção (arts. 15 e 16)
const ANONIMO = 'Titular anonimizado';

/**
 * Anonimiza o que passou do prazo de guarda. Roda todo dia. Nunca toca em título em aberto.
 *   - pagador do boleto concluído há mais de N anos (padrão 5, nunca menos): nome, documento,
 *     contato e endereço; a descrição dos lançamentos daquele boleto; o corpo do aviso do banco;
 *     a descrição dos alertas de PLD daquele cliente concluídos no mesmo prazo;
 *   - pedidos de titular respondidos há mais de N anos;
 *   - endereço IP da auditoria com mais de 6 meses;
 *   - cache de consulta de CEP/CNPJ vencido;
 *   - arquivos CNAB (remessa e retorno processado) mais antigos que N anos.
 */
function aplicarRetencao(db, { data = hoje() } = {}) {
  const anos = Math.max(5, Number(parametro(db, 'lgpd_retencao_anos', 5)));
  const corte = datas.somarDias(data, -Math.round(anos * 365.25));
  const corteIp = datas.somarDias(data, -183);
  const out = { anos, corte, boletos: 0, lancamentos: 0, eventos: 0, pld: 0, pedidos: 0, ips: 0, cache: 0, arquivos: 0 };

  transacao(db, () => {
    const vencidos = db.prepare(`SELECT id FROM boletos WHERE anonimizado_em IS NULL AND situacao NOT IN ('registrando', 'registrado')
      AND COALESCE(pago_em, substr(baixado_em, 1, 10), substr(criado_em, 1, 10)) < ?`).all(corte).map((x) => x.id);
    for (const id of vencidos) {
      db.prepare(`UPDATE boletos SET pagador_nome = ?, pagador_documento = 'anonimizado', pagador_email = NULL, pagador_telefone = NULL,
          pagador_cep = NULL, pagador_endereco = NULL, pagador_numero = NULL, pagador_bairro = NULL, pagador_cidade = NULL, pagador_uf = NULL,
          anonimizado_em = ? WHERE id = ?`).run(ANONIMO, agora(), id);
      out.lancamentos += db.prepare("UPDATE lancamentos SET descricao = 'Lançamento de título anonimizado (prazo de guarda vencido)' WHERE boleto_id = ?").run(id).changes;
      out.boletos += 1;
    }
    out.eventos = db.prepare(`UPDATE eventos_banco SET payload = '{"anonimizado":true}' WHERE recebido_em < ? AND payload <> '{"anonimizado":true}'`).run(corte).changes;
    out.pld = db.prepare(`UPDATE pld_alertas SET descricao = 'Alerta anonimizado (prazo de guarda vencido)', detalhes = NULL
      WHERE situacao IN ('arquivado', 'comunicado') AND substr(atualizado_em, 1, 10) < ? AND descricao NOT LIKE 'Alerta anonimizado%'`).run(corte).changes;
    out.pedidos = db.prepare(`UPDATE lgpd_pedidos SET titular_nome = ?, titular_documento = 'anonimizado', titular_email = 'anonimizado', mensagem = NULL, ip = NULL
      WHERE situacao IN ('atendido', 'recusado') AND substr(respondido_em, 1, 10) < ? AND titular_documento <> 'anonimizado'`).run(ANONIMO, corte).changes;
    out.ips = db.prepare('UPDATE auditoria SET ip = NULL WHERE ip IS NOT NULL AND substr(criado_em, 1, 10) < ?').run(corteIp).changes;
    out.cache = db.prepare('DELETE FROM consultas_cache WHERE substr(consultado_em, 1, 10) < ?')
      .run(datas.somarDias(data, -Math.max(config.dados.cacheCnpjDias ?? 30, 30))).changes;
  });

  // Arquivos CNAB carregam nome e documento dos pagadores.
  const limite = Date.parse(`${corte}T00:00:00Z`);
  for (const pasta of [config.cnab.pastaRemessa, config.cnab.pastaProcessados]) {
    if (!pasta || !fs.existsSync(pasta)) continue;
    for (const nome of fs.readdirSync(pasta)) {
      const arq = path.join(pasta, nome);
      const st = fs.statSync(arq);
      if (st.isFile() && st.mtimeMs < limite) { fs.unlinkSync(arq); out.arquivos += 1; }
    }
  }
  gravarParametro(db, 'lgpd_ultima_retencao', JSON.stringify({ em: agora(), ...out }));
  return out;
}

/** O que já devia ter sido anonimizado e não foi (a Conformidade vigia). */
function retencaoPendente(db, data = hoje()) {
  const anos = Math.max(5, Number(parametro(db, 'lgpd_retencao_anos', 5)));
  const corte = datas.somarDias(data, -Math.round(anos * 365.25) - 2);
  return db.prepare(`SELECT COUNT(*) AS n FROM boletos WHERE anonimizado_em IS NULL AND situacao NOT IN ('registrando', 'registrado')
    AND COALESCE(pago_em, substr(baixado_em, 1, 10), substr(criado_em, 1, 10)) < ?`).get(corte).n;
}

const ultimaRetencao = (db) => { try { return JSON.parse(parametro(db, 'lgpd_ultima_retencao') ?? 'null'); } catch { return null; } };

// ---------------------------------------------------------------- Resumo
function resumo(db) {
  const pedidos = listarPedidos(db);
  const incidentes = listarIncidentes(db);
  return {
    encarregado: encarregado(db),
    controlador: controlador(db),
    pedidos: {
      abertos: pedidos.filter((p) => ['recebido', 'em_atendimento'].includes(p.situacao)).length,
      vencidos: pedidos.filter((p) => p.vencido).length,
      total: pedidos.length,
    },
    incidentes: { abertos: incidentes.filter((i) => !i.encerrado_em).length, atrasados: incidentes.filter((i) => i.comunicacao_atrasada).length },
    retencao: { ultima: ultimaRetencao(db), pendente: retencaoPendente(db), anos: Math.max(5, Number(parametro(db, 'lgpd_retencao_anos', 5))) },
  };
}

module.exports = {
  INVENTARIO, DIREITOS, TIPOS, PRAZO_RESPOSTA_DIAS, controlador, encarregado, gravarEncarregado, criarPedido, pedido,
  listarPedidos, verificarIdentidade, responder, dadosDoTitular, registrarIncidente, atualizarIncidente, listarIncidentes,
  incidenteAtrasado, aplicarRetencao, retencaoPendente, ultimaRetencao, resumo, esc,
};
