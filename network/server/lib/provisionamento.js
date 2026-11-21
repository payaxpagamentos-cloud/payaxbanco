'use strict';

const crypto = require('node:crypto');
const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const { cifrar, decifrar } = require('./cripto');
const drivers = require('../drivers');
const { ErroEquipamento, novoErroId, limparSegredo } = require('../drivers/base');

/*
 * Provisionamento: a ponte entre o que foi vendido e o que está no equipamento.
 *
 * Decisões que valem para todo o módulo:
 * - O ESTADO DESEJADO é derivado do contrato e do plano toda vez que é preciso. Ninguém digita a velocidade
 *   duas vezes: mudou o plano, mudou o desejado. O que fica guardado no serviço é só o que o contrato não sabe
 *   (login, senha, IP, ONU, CPE).
 * - O ESTADO REAL é o que o equipamento respondeu na última leitura, guardado como veio e com o horário.
 *   A divergência entre os dois é calculada na hora e mostrada; nada é "corrigido" em silêncio.
 * - Toda escrita no equipamento passa pela fila. A tela e a régua PEDEM; quem executa é a fila, com tentativa,
 *   recuo progressivo, erro legível e histórico. Assim um equipamento fora do ar não trava o atendimento nem
 *   perde o pedido, e o corte por inadimplência continua existindo mesmo que a OLT esteja inacessível na hora.
 * - Ensaio (dry-run) percorre o mesmo caminho e descreve o que faria, sem escrever.
 * - A senha do acesso e a do Wi-Fi são cifradas e nunca saem em resposta de API, log ou auditoria.
 */

/** Situação que o serviço deve ter no equipamento, a partir da situação do contrato. */
const SITUACAO_POR_CONTRATO = {
  ativo: 'liberado',
  bloqueado: 'cortado',
  suspenso: 'cortado',
  cancelado: 'removido',
  em_implantacao: null,
};

const CAMPOS_PUBLICOS = `s.id, s.contrato_id, s.concentrador_id, s.tipo_acesso, s.login, s.ip_fixo, s.mac, s.olt_id, s.pon,
  s.onu_serial, s.onu_indice, s.cpe_serial, s.cpe_modelo, s.wifi_ssid, s.wifi_canal, s.estado_real, s.lido_em,
  s.aplicado_em, s.desejado_aplicado, s.observacoes, s.criado_em, s.versao`;

/** Serviço sem nenhum segredo, para API e tela. A senha vira só "definida" ou não. */
function publico(servico) {
  if (!servico) return null;
  const { senha_cifrada: s, wifi_senha_cifrada: w, ...resto } = servico;
  return {
    ...resto,
    senha_definida: Boolean(s),
    wifi_senha_definida: Boolean(w),
    estado_real: resto.estado_real ? JSON.parse(resto.estado_real) : null,
    desejado_aplicado: resto.desejado_aplicado ? JSON.parse(resto.desejado_aplicado) : null,
  };
}

/** Senha de acesso gerada quando ninguém informa uma: legível, sem caracteres que se confundem ao ditar. */
function senhaGerada(tamanho = 10) {
  const alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...crypto.randomBytes(tamanho)].map((b) => alfabeto[b % alfabeto.length]).join('');
}

/**
 * Estado desejado do serviço, derivado do contrato e do plano. `situacao: null` significa que o contrato
 * ainda não deve existir no equipamento (em implantação).
 */
function desejado(db, servico) {
  const contrato = db.prepare(`SELECT c.*, p.nome AS plano_nome, p.download_mbps, p.upload_mbps, p.perfil_equipamento, a.nome AS assinante_nome
    FROM contratos c JOIN planos p ON p.id = c.plano_id JOIN assinantes a ON a.id = c.assinante_id WHERE c.id = ?`).get(servico.contrato_id);
  if (!contrato) throw new ErroNegocio('Contrato do serviço não encontrado.', 404);
  return {
    contrato_id: contrato.id,
    contrato_numero: contrato.numero,
    assinante: contrato.assinante_nome,
    plano: contrato.plano_nome,
    tipo_acesso: servico.tipo_acesso,
    login: servico.login,
    senha: servico.senha_cifrada ? decifrar(servico.senha_cifrada) : null,
    ip_fixo: servico.ip_fixo,
    perfil: contrato.perfil_equipamento || null,
    download_kbps: contrato.download_mbps ? contrato.download_mbps * 1000 : null,
    upload_kbps: contrato.upload_mbps ? contrato.upload_mbps * 1000 : null,
    situacao: SITUACAO_POR_CONTRATO[contrato.situacao] ?? null,
    situacao_contrato: contrato.situacao,
  };
}

/** Versão do desejado sem a senha, para guardar, comparar e mostrar. */
const desejadoPublico = (d) => { const { senha, ...resto } = d; return { ...resto, senha_definida: Boolean(senha) }; };

/**
 * Diferenças entre o que o contrato manda e o que o equipamento respondeu na última leitura.
 * A mais importante vem primeiro: serviço liberado com contrato bloqueado é receita escapando;
 * serviço cortado com contrato ativo é assinante pagando sem serviço.
 */
function divergencias(d, real, lidoEm) {
  if (!real) return [{ gravidade: 'aviso', campo: 'leitura', texto: 'O equipamento ainda não foi lido: não dá para dizer o que está lá.' }];
  const fora = [];
  if (d.situacao === null) {
    if (real.presente) fora.push({ gravidade: 'alta', campo: 'existencia', texto: 'O contrato ainda está em implantação, mas já existe acesso no equipamento.' });
    return fora;
  }
  if (d.situacao === 'removido') {
    if (real.presente) fora.push({ gravidade: 'alta', campo: 'existencia', texto: 'Contrato cancelado e o acesso continua no equipamento.', esperado: 'sem acesso', real: real.login });
    return fora;
  }
  if (!real.presente) {
    fora.push({ gravidade: 'alta', campo: 'existencia', texto: real.motivo ?? 'O acesso não existe no equipamento.', esperado: d.login, real: 'ausente' });
    return fora;
  }
  if (real.situacao !== d.situacao) {
    fora.push(d.situacao === 'cortado'
      ? { gravidade: 'critica', campo: 'situacao', texto: 'O contrato está bloqueado e o serviço continua liberado no equipamento.', esperado: 'cortado', real: real.situacao }
      : { gravidade: 'critica', campo: 'situacao', texto: 'O contrato está ativo e o serviço está cortado no equipamento.', esperado: 'liberado', real: real.situacao });
  }
  if (d.perfil && real.perfil !== d.perfil) {
    fora.push({ gravidade: 'alta', campo: 'perfil', texto: 'O perfil de velocidade no equipamento não é o do plano.', esperado: d.perfil, real: real.perfil ?? '(nenhum)' });
  }
  if (!d.perfil && d.download_kbps && real.rate_limit !== undefined) {
    const esperado = `${Math.round(d.upload_kbps)}k/${Math.round(d.download_kbps)}k`;
    if ((real.rate_limit || '') !== esperado) {
      fora.push({ gravidade: 'alta', campo: 'velocidade', texto: 'A velocidade no equipamento não é a do plano.', esperado, real: real.rate_limit || '(sem limite)' });
    }
  }
  if (d.ip_fixo && real.ip_fixo !== d.ip_fixo) {
    fora.push({ gravidade: 'media', campo: 'ip_fixo', texto: 'O IP fixo no equipamento não é o do cadastro.', esperado: d.ip_fixo, real: real.ip_fixo ?? '(dinâmico)' });
  }
  if (lidoEm && Date.now() - Date.parse(lidoEm) > 48 * 3600_000) {
    fora.push({ gravidade: 'aviso', campo: 'leitura', texto: 'A última leitura do equipamento tem mais de 48 horas.' });
  }
  return fora;
}

// ---------------- Fila ----------------

/** Chave que torna o pedido idempotente: a mesma intenção pendente não entra duas vezes. */
const chaveDe = (servicoId, acao, extra = '') => `s${servicoId}:${acao}${extra ? `:${extra}` : ''}`;

/**
 * Põe uma tarefa na fila. Repetir o mesmo pedido com a tarefa ainda pendente devolve a que já existe,
 * em vez de empilhar duas escritas iguais no equipamento.
 */
function enfileirar(db, { org, servicoId = null, equipamentoId = null, acao, pedido = null, chave = null, origem = 'usuario', usuarioId = null, ensaio = false }) {
  if (!drivers.ACOES.includes(acao)) throw new ErroNegocio(`Ação de equipamento desconhecida: ${acao}.`, 422);
  const k = ensaio ? null : (chave ?? (servicoId ? chaveDe(servicoId, acao) : null));
  if (k) {
    const existente = db.prepare("SELECT * FROM tarefas_equipamento WHERE organizacao_id = ? AND chave = ? AND situacao IN ('pendente','executando')").get(org, k);
    if (existente) return { ...existente, ja_na_fila: true };
  }
  const id = Number(db.prepare(`INSERT INTO tarefas_equipamento (organizacao_id, servico_id, equipamento_id, acao, pedido, chave, ensaio, origem, usuario_id, criado_em, proxima_tentativa)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(org, servicoId, equipamentoId, acao, pedido ? JSON.stringify(pedido) : null, k, ensaio ? 1 : 0, origem, usuarioId, agora(), agora()).lastInsertRowid);
  return db.prepare('SELECT * FROM tarefas_equipamento WHERE id = ?').get(id);
}

/** Equipamento e credencial decifrada para o driver, sem nunca devolver a senha para fora daqui. */
function contexto(db, equipamentoId, { ensaio = false, trocarSenha = false } = {}) {
  const equipamento = db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(equipamentoId);
  if (!equipamento) throw new ErroEquipamento('Equipamento não encontrado.', 'nao_configurado', { permanente: true });
  if (!equipamento.ativo) throw new ErroEquipamento(`O equipamento ${equipamento.nome} está inativo.`, 'nao_configurado', { permanente: true });
  const driver = drivers.exigirDriver(equipamento);
  return {
    driver,
    ctx: { equipamento, credencial: equipamento.segredo_cifrado ? decifrar(equipamento.segredo_cifrado) : null, ensaio, trocarSenha },
  };
}

/*
 * Qual equipamento executa a ação deste serviço. Hoje é sempre o concentrador: as ações no aparelho do
 * assinante (Wi-Fi, reinício) NÃO passam por aqui, porque no TR-069 quem liga é o CPE — elas vivem no ACS
 * (lib/acs.js e routes/cpes.js), com fila própria, e por isso nenhum driver de discagem as declara.
 */
const equipamentoDa = (servico) => servico.concentrador_id ?? null;

/**
 * Executa uma tarefa da fila. Nunca lança: o resultado (sucesso, falha com nova tentativa, falha permanente ou
 * ação sem suporte no driver) fica gravado na própria tarefa e no equipamento.
 */
async function executarTarefa(db, tarefa) {
  const inicio = Date.now();
  db.prepare("UPDATE tarefas_equipamento SET situacao = 'executando', iniciado_em = ?, tentativas = tentativas + 1 WHERE id = ?").run(agora(), tarefa.id);
  const servico = tarefa.servico_id ? db.prepare('SELECT * FROM servicos WHERE id = ?').get(tarefa.servico_id) : null;
  const equipamentoId = tarefa.equipamento_id ?? (servico ? equipamentoDa(servico) : null);
  const pedido = tarefa.pedido ? JSON.parse(tarefa.pedido) : {};

  try {
    if (!equipamentoId) throw new ErroEquipamento('O serviço ainda não tem equipamento definido para esta ação.', 'nao_configurado', { permanente: true });
    const { driver, ctx } = contexto(db, equipamentoId, { ensaio: tarefa.ensaio === 1, trocarSenha: Boolean(pedido.trocar_senha) });
    const pode = drivers.suporta(driver, tarefa.acao);
    if (!pode.pode) {
      db.prepare("UPDATE tarefas_equipamento SET situacao = 'sem_suporte', erro = ?, concluido_em = ?, duracao_ms = ? WHERE id = ?")
        .run(pode.motivo, agora(), Date.now() - inicio, tarefa.id);
      return { ok: false, sem_suporte: true, motivo: pode.motivo };
    }

    // "identificar" é sobre o equipamento, não sobre um serviço: só as ações de serviço precisam do desejado.
    if (!servico && tarefa.acao !== 'identificar') throw new ErroEquipamento('A tarefa não tem serviço associado.', 'falha', { permanente: true });
    const alvo = servico ? desejado(db, servico) : null;
    let resultado;
    switch (tarefa.acao) {
      case 'identificar': resultado = await driver.identificar(ctx); break;
      case 'ler': resultado = await driver.ler(ctx, servico); break;
      case 'aplicar': resultado = await driver.aplicar(ctx, servico, alvo); break;
      case 'cortar': resultado = await driver.cortar(ctx, servico, { motivo: pedido.motivo }); break;
      case 'religar': resultado = await driver.religar(ctx, servico); break;
      case 'remover': resultado = await driver.remover(ctx, servico); break;
      default: throw new ErroEquipamento(`Ação não implementada: ${tarefa.acao}.`, 'falha', { permanente: true });
    }

    const t = agora();
    transacao(db, () => {
      db.prepare("UPDATE tarefas_equipamento SET situacao = 'concluida', resultado = ?, erro = NULL, erro_id = NULL, concluido_em = ?, duracao_ms = ? WHERE id = ?")
        .run(JSON.stringify(resultado ?? {}), t, Date.now() - inicio, tarefa.id);
      db.prepare("UPDATE equipamentos SET estado_conexao = 'conectado', ultimo_contato = ?, ultimo_erro = NULL, erro_id = NULL WHERE id = ?").run(t, equipamentoId);
      if (tarefa.acao === 'identificar' && resultado?.modelo) {
        db.prepare('UPDATE equipamentos SET identificacao = ? WHERE id = ?').run(JSON.stringify(resultado), equipamentoId);
      }
      if (servico && !tarefa.ensaio) {
        if (tarefa.acao === 'ler') db.prepare('UPDATE servicos SET estado_real = ?, lido_em = ?, versao = versao + 1 WHERE id = ?').run(JSON.stringify(resultado), t, servico.id);
        else db.prepare('UPDATE servicos SET aplicado_em = ?, desejado_aplicado = ?, versao = versao + 1 WHERE id = ?').run(t, JSON.stringify(desejadoPublico(alvo)), servico.id);
      }
    });
    // Depois de escrever, ler de volta: o que vale na tela é o que o equipamento responde, não o que mandamos.
    if (servico && !tarefa.ensaio && ['aplicar', 'cortar', 'religar'].includes(tarefa.acao)) {
      enfileirar(db, { org: tarefa.organizacao_id, servicoId: servico.id, acao: 'ler', origem: 'sistema', chave: chaveDe(servico.id, 'ler') });
    }
    return { ok: true, resultado };
  } catch (err) {
    const erroId = novoErroId();
    const mensagem = limparSegredo(err.message, '');
    const permanente = err instanceof ErroEquipamento ? err.permanente : false;
    const estado = err instanceof ErroEquipamento ? err.estado : 'falha';
    const tentativas = tarefa.tentativas + 1;
    // Falha permanente (credencial recusada, driver errado, serviço inexistente) não adianta repetir.
    const proxima = permanente || tentativas >= 6 ? null
      : new Date(Date.now() + Math.min(1800, 30 * 2 ** tentativas) * 1000 * (0.8 + Math.random() * 0.4)).toISOString();
    db.prepare(`UPDATE tarefas_equipamento SET situacao = ?, erro = ?, erro_id = ?, proxima_tentativa = ?, concluido_em = ?, duracao_ms = ? WHERE id = ?`)
      .run(proxima ? 'pendente' : 'falhou', mensagem, erroId, proxima, proxima ? null : agora(), Date.now() - inicio, tarefa.id);
    if (equipamentoId) {
      db.prepare('UPDATE equipamentos SET estado_conexao = ?, ultimo_erro = ?, erro_id = ? WHERE id = ?').run(estado, mensagem, erroId, equipamentoId);
    }
    if (!(err instanceof ErroEquipamento)) console.error(`[Network] Tarefa ${tarefa.id} (${tarefa.acao}) erro ${erroId}:`, err);
    return { ok: false, erro: mensagem, erro_id: erroId, nova_tentativa: proxima };
  }
}

/**
 * Executa as tarefas devidas da organização, em ordem de chegada e uma de cada vez — dois comandos ao mesmo
 * tempo no mesmo concentrador se atropelam. Quem garante que não há duas execuções simultâneas da fila é
 * quem a chama (o agendador segura uma trava; a rota manual executa só a tarefa que acabou de criar).
 */
async function processarFila(db, org, { maximo = 20 } = {}) {
  const devidas = db.prepare(`SELECT * FROM tarefas_equipamento WHERE organizacao_id = ? AND situacao = 'pendente'
    AND (proxima_tentativa IS NULL OR proxima_tentativa <= ?) ORDER BY id LIMIT ?`).all(org, agora(), maximo);
  const feitas = [];
  for (const t of devidas) feitas.push({ id: t.id, acao: t.acao, ...(await executarTarefa(db, t)) });
  return { executadas: feitas.length, pendentes: db.prepare("SELECT COUNT(*) AS n FROM tarefas_equipamento WHERE organizacao_id = ? AND situacao = 'pendente'").get(org).n, tarefas: feitas };
}

// ---------------- Pedidos de alto nível ----------------

/** Pede a sincronização do serviço com o contrato (cria, ajusta, corta ou religa, conforme o contrato manda). */
function sincronizar(db, { org, servico, origem = 'usuario', usuarioId = null, ensaio = false, motivo = null }) {
  const d = desejado(db, servico);
  if (d.situacao === null) throw new ErroNegocio('O contrato está em implantação: ative o serviço antes de provisionar.', 422);
  const acao = d.situacao === 'removido' ? 'remover' : 'aplicar';
  return enfileirar(db, { org, servicoId: servico.id, acao, origem, usuarioId, ensaio,
    pedido: { motivo, trocar_senha: false }, chave: ensaio ? null : chaveDe(servico.id, acao) });
}

/**
 * Corte e religação pedidos pela cobrança. Só entram na fila se a operação ligou o corte automático;
 * caso contrário fica registrado que o bloqueio é comercial e a execução na rede é manual.
 */
function pedirCorte(db, { org, contratoId, cortar, origem = 'regua', usuarioId = null, motivo = null }) {
  const organizacao = db.prepare('SELECT corte_automatico FROM organizacoes WHERE id = ?').get(org);
  const servico = db.prepare('SELECT * FROM servicos WHERE contrato_id = ?').get(contratoId);
  if (!servico) return { enfileirado: false, motivo: 'O contrato não tem serviço provisionado: o bloqueio é só comercial.' };
  if (!servico.concentrador_id) return { enfileirado: false, motivo: 'O serviço ainda não tem concentrador definido.' };
  if (!organizacao.corte_automatico) return { enfileirado: false, motivo: 'O corte automático no equipamento está desligado nos parâmetros da operação.' };
  const acao = cortar ? 'cortar' : 'religar';
  const t = enfileirar(db, { org, servicoId: servico.id, acao, origem, usuarioId, pedido: { motivo }, chave: chaveDe(servico.id, acao) });
  return { enfileirado: true, tarefa_id: t.id, acao, ja_na_fila: Boolean(t.ja_na_fila) };
}

/** Releitura periódica: enfileira a leitura dos serviços cujo estado real está velho. */
function reconciliar(db, org, { horas = 12, maximo = 200 } = {}) {
  if (!horas) return { enfileirados: 0 };
  const corte = new Date(Date.now() - horas * 3600_000).toISOString();
  const alvos = db.prepare(`SELECT s.id FROM servicos s JOIN contratos c ON c.id = s.contrato_id
    WHERE s.organizacao_id = ? AND s.concentrador_id IS NOT NULL AND c.situacao <> 'cancelado'
      AND (s.lido_em IS NULL OR s.lido_em < ?) ORDER BY COALESCE(s.lido_em, '') LIMIT ?`).all(org, corte, maximo);
  let n = 0;
  let jaNaFila = 0;
  for (const a of alvos) {
    const t = enfileirar(db, { org, servicoId: a.id, acao: 'ler', origem: 'reconciliacao', chave: chaveDe(a.id, 'ler') });
    if (t.ja_na_fila) jaNaFila += 1;
    else n += 1;
  }
  // "ja_na_fila" não é erro: é a reconciliação não duplicando uma leitura que já estava para acontecer.
  return { enfileirados: n, ja_na_fila: jaNaFila, candidatos: alvos.length };
}

module.exports = { SITUACAO_POR_CONTRATO, CAMPOS_PUBLICOS, publico, senhaGerada, desejado, desejadoPublico, divergencias,
  chaveDe, enfileirar, contexto, equipamentoDa, executarTarefa, processarFila, sincronizar, pedirCorte, reconciliar, cifrar };
