'use strict';

const { Router } = require('express');
const { agora, proximoNumero, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, like, conferirVersao } = require('../lib/http');
const { dataLocal, somarDias, dataBr, competenciaBr } = require('../lib/datas');
const { endereco } = require('../lib/enderecos');
const cob = require('../lib/cobranca');
const prov = require('../lib/provisionamento');
const fat = require('../lib/faturamento');
const v = require('../lib/validacao');

const TIPOS_ITEM = ['sva', 'equipamento', 'ponto_adicional', 'desconto', 'outro'];

/** Competência 'AAAA-MM' obrigatória. */
const competencia = (x, nome) => {
  v.exigir(fat.competenciaValida(x), `${nome[0].toUpperCase()}${nome.slice(1)} inválida (use AAAA-MM).`);
  return x;
};

/*
 * Contrato: o serviço de um assinante num endereço. É ele que fatura e é ele que bloqueia.
 *
 * Ciclo de vida, sempre com registro de quem fez e por quê:
 *   em_implantacao → ativo → (bloqueado | suspenso) → ativo → cancelado
 * Cancelado é final: voltar a atender o mesmo assinante no mesmo lugar é um contrato novo, para o histórico de
 * faturamento, de fidelidade e de rede continuar legível.
 */
module.exports = (db) => {
  const r = Router();
  const hoje = (req) => dataLocal(req.usuario.fuso);
  const organizacao = (req) => db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org);
  const buscar = (req, id) => {
    const x = db.prepare('SELECT * FROM contratos WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Contrato não encontrado.', 404);
    return x;
  };

  /** Ocupa a porta da CTO para este contrato (ou libera a que ele ocupava), com histórico na planta. */
  function marcarPorta(req, { portaId, contrato, situacao, motivo }) {
    if (!portaId) return;
    const p = db.prepare(`SELECT pr.*, ar.organizacao_id, ar.codigo AS cto_codigo FROM portas_rede pr JOIN ativos_rede ar ON ar.id = pr.ativo_id WHERE pr.id = ?`).get(portaId);
    if (!p || p.organizacao_id !== req.org) throw new ErroNegocio('Porta não encontrada nesta organização.', 404);
    if (situacao === 'ocupada') {
      v.exigir(p.em_uso === 1, `A porta ${p.numero} da ${p.cto_codigo} está fora de uso.`);
      if (p.situacao === 'defeito') throw new ErroNegocio(`A porta ${p.numero} da ${p.cto_codigo} está marcada com defeito.`, 409);
      const outro = db.prepare('SELECT numero FROM contratos WHERE porta_id = ? AND id <> ? AND situacao <> \'cancelado\'').get(portaId, contrato.id);
      if (outro) throw new ErroNegocio(`A porta ${p.numero} da ${p.cto_codigo} já é do contrato ${outro.numero}.`, 409);
    }
    const t = agora();
    db.prepare(`UPDATE portas_rede SET situacao = ?, cliente_ref = ?, reservado_por = NULL, reserva_expira_em = NULL, desde = ?, versao = versao + 1 WHERE id = ?`)
      .run(situacao, situacao === 'ocupada' ? `contrato:${contrato.numero}` : null, t, portaId);
    db.prepare('INSERT INTO porta_historico (porta_id, situacao_anterior, situacao, cliente_ref, motivo, usuario_id, em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(portaId, p.situacao, situacao, situacao === 'ocupada' ? `contrato:${contrato.numero}` : null, motivo, req.usuario.id, t);
  }

  function dados(b, atual = {}, req) {
    const val = (k, f) => (b[k] !== undefined ? f(b[k]) : atual[k] ?? null);
    const org = organizacao(req);
    const planoId = b.plano_id !== undefined ? v.inteiro(b.plano_id, 'o plano', { min: 1 }) : atual.plano_id;
    const plano = db.prepare('SELECT * FROM planos WHERE id = ? AND organizacao_id = ?').get(planoId, req.org);
    if (!plano) throw new ErroNegocio('Plano não encontrado.', 404);
    if (!atual.id && !plano.ativo) throw new ErroNegocio(`O plano ${plano.nome} está inativo: reative-o ou escolha outro.`, 422);
    return {
      plano_id: plano.id,
      // Sem valor informado, o contrato nasce com o valor do plano; depois ele é independente do plano.
      mensalidade_centavos: b.mensalidade !== undefined && b.mensalidade !== '' ? v.centavos(b.mensalidade, 'a mensalidade') : atual.mensalidade_centavos ?? plano.mensalidade_centavos,
      instalacao_centavos: b.instalacao !== undefined && b.instalacao !== '' ? v.centavos(b.instalacao, 'a taxa de instalação') : atual.instalacao_centavos ?? plano.instalacao_centavos,
      dia_vencimento: b.dia_vencimento !== undefined && b.dia_vencimento !== '' ? v.inteiro(b.dia_vencimento, 'o dia de vencimento', { min: 1, max: 28 })
        : atual.dia_vencimento ?? org.dia_vencimento_padrao,
      ...endereco(b, atual, 'numero_endereco'),
      cto_id: b.cto_id !== undefined ? (b.cto_id ? v.inteiro(b.cto_id, 'a CTO', { min: 1 }) : null) : atual.cto_id ?? null,
      porta_id: b.porta_id !== undefined ? (b.porta_id ? v.inteiro(b.porta_id, 'a porta', { min: 1 }) : null) : atual.porta_id ?? null,
      carencia_dias: b.carencia_dias !== undefined && b.carencia_dias !== '' ? v.inteiro(b.carencia_dias, 'a carência', { max: 180 }) : atual.carencia_dias ?? null,
      observacoes: val('observacoes', (x) => v.opcional(x, 'as observações', 1000)),
    };
  }

  const COLUNAS = `c.*, p.nome AS plano_nome, p.tipo AS plano_tipo, p.download_mbps, p.upload_mbps, p.fidelidade_meses, a.nome AS assinante_nome,
    a.codigo AS assinante_codigo, a.documento AS assinante_documento, a.telefone AS assinante_telefone, ar.codigo AS cto_codigo, pr.numero AS porta_numero`;
  const JUNCOES = `FROM contratos c JOIN planos p ON p.id = c.plano_id JOIN assinantes a ON a.id = c.assinante_id
    LEFT JOIN ativos_rede ar ON ar.id = c.cto_id LEFT JOIN portas_rede pr ON pr.id = c.porta_id`;

  r.get('/', exigir('contratos.ver'), (req, res) => {
    const f = ['c.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.assinante_id) { f.push('c.assinante_id = ?'); p.push(Number(req.query.assinante_id)); }
    if (req.query.situacao) { f.push('c.situacao = ?'); p.push(String(req.query.situacao)); }
    if (req.query.plano_id) { f.push('c.plano_id = ?'); p.push(Number(req.query.plano_id)); }
    if (req.query.cto_id) { f.push('c.cto_id = ?'); p.push(Number(req.query.cto_id)); }
    if (req.query.busca) {
      const t = String(req.query.busca).trim();
      f.push("(a.nome LIKE ? ESCAPE '\\' OR a.documento LIKE ? ESCAPE '\\' OR c.numero = ?)");
      p.push(like(t), like(v.digitos(t) || t), Number(t.replace(/\D/g, '')) || -1);
    }
    res.json(listaPaginada(db, `SELECT ${COLUNAS} ${JUNCOES} WHERE ${f.join(' AND ')} ORDER BY c.numero DESC`, p, req.query));
  });

  r.post('/', exigir('contratos.editar'), (req, res) => {
    const b = req.body ?? {};
    const assinante = db.prepare('SELECT * FROM assinantes WHERE id = ? AND organizacao_id = ?').get(Number(b.assinante_id), req.org);
    if (!assinante) throw new ErroNegocio('Assinante não encontrado.', 404);
    const d = dados(b, {}, req);
    const id = transacao(db, () => {
      const numero = proximoNumero(db, req.org, 'contrato');
      const novo = Number(db.prepare(`INSERT INTO contratos (organizacao_id, assinante_id, numero, plano_id, mensalidade_centavos, instalacao_centavos, dia_vencimento,
        cep, logradouro, numero_endereco, complemento, bairro, cidade, uf, codigo_municipio, latitude, longitude, cto_id, porta_id, carencia_dias, observacoes, criado_por, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.org, assinante.id, numero, d.plano_id, d.mensalidade_centavos, d.instalacao_centavos, d.dia_vencimento, d.cep, d.logradouro, d.numero_endereco,
          d.complemento, d.bairro, d.cidade, d.uf, d.codigo_municipio, d.latitude, d.longitude, d.cto_id, d.porta_id, d.carencia_dias, d.observacoes, req.usuario.id, agora()).lastInsertRowid);
      const contrato = db.prepare('SELECT * FROM contratos WHERE id = ?').get(novo);
      cob.registrarEvento(db, contrato, { evento: 'criado', para: 'em_implantacao', usuarioId: req.usuario.id });
      // O primeiro contrato transforma o prospecto em cliente.
      if (assinante.situacao === 'prospecto') db.prepare("UPDATE assinantes SET situacao = 'cliente', versao = versao + 1 WHERE id = ?").run(assinante.id);
      return novo;
    });
    registrar(db, req, 'contrato_criado', { recurso: 'contrato', recursoId: id, depois: d });
    res.status(201).json(db.prepare(`SELECT ${COLUNAS} ${JUNCOES} WHERE c.id = ?`).get(id));
  });

  r.get('/:id', exigir('contratos.ver'), (req, res) => {
    const c = buscar(req, req.params.id);
    const d = hoje(req);
    const org = organizacao(req);
    const faturas = db.prepare('SELECT * FROM faturas WHERE contrato_id = ? ORDER BY vencimento DESC, id DESC LIMIT 36').all(c.id);
    res.json({
      ...db.prepare(`SELECT ${COLUNAS} ${JUNCOES} WHERE c.id = ?`).get(c.id),
      posicao: fat.posicaoDoContrato(db, c.id, d),
      carencia_efetiva: cob.carenciaDe(c, org),
      bloqueio: cob.bloqueioAberto(db, c.id) ?? null,
      confianca: cob.confiancaVigente(db, c.id, d) ?? null,
      confiancas_no_ano: db.prepare('SELECT COUNT(*) AS n FROM confiancas WHERE contrato_id = ? AND inicio >= ?').get(c.id, `${d.slice(0, 4)}-01-01`).n,
      itens: db.prepare('SELECT * FROM contrato_itens WHERE contrato_id = ? ORDER BY id').all(c.id),
      faturas: faturas.map((f) => ({ ...f, encargos: fat.encargos(f, org, d) })),
      bloqueios: db.prepare(`SELECT b.*, u.nome AS criado_por_nome, l.nome AS liberado_por_nome, rr.nome AS regra_nome FROM bloqueios b
        LEFT JOIN usuarios u ON u.id = b.criado_por LEFT JOIN usuarios l ON l.id = b.liberado_por LEFT JOIN regua_regras rr ON rr.id = b.regra_id
        WHERE b.contrato_id = ? ORDER BY b.id DESC LIMIT 20`).all(c.id),
      eventos: db.prepare(`SELECT e.*, u.nome AS usuario_nome FROM contrato_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id
        WHERE e.contrato_id = ? ORDER BY e.id DESC LIMIT 50`).all(c.id),
      chamados: db.prepare('SELECT id, numero, titulo, status, agendado_para FROM chamados WHERE organizacao_id = ? AND ativo_id = ? ORDER BY id DESC LIMIT 10').all(req.org, c.cto_id ?? -1),
    });
  });

  r.patch('/:id', exigir('contratos.editar'), (req, res) => {
    const antes = buscar(req, req.params.id);
    conferirVersao(antes.versao, req.body?.versao);
    if (antes.situacao === 'cancelado') throw new ErroNegocio('Contrato cancelado não é mais alterado.', 422);
    const d = dados(req.body ?? {}, antes, req);
    transacao(db, () => {
      if (d.porta_id !== antes.porta_id) {
        if (antes.porta_id) marcarPorta(req, { portaId: antes.porta_id, contrato: antes, situacao: 'livre', motivo: `Contrato ${antes.numero} mudou de porta` });
        if (d.porta_id && antes.situacao !== 'em_implantacao') marcarPorta(req, { portaId: d.porta_id, contrato: antes, situacao: 'ocupada', motivo: `Contrato ${antes.numero}` });
      }
      db.prepare(`UPDATE contratos SET plano_id = ?, mensalidade_centavos = ?, instalacao_centavos = ?, dia_vencimento = ?, cep = ?, logradouro = ?, numero_endereco = ?,
        complemento = ?, bairro = ?, cidade = ?, uf = ?, codigo_municipio = ?, latitude = ?, longitude = ?, cto_id = ?, porta_id = ?, carencia_dias = ?, observacoes = ?, versao = versao + 1
        WHERE id = ?`).run(d.plano_id, d.mensalidade_centavos, d.instalacao_centavos, d.dia_vencimento, d.cep, d.logradouro, d.numero_endereco, d.complemento,
        d.bairro, d.cidade, d.uf, d.codigo_municipio, d.latitude, d.longitude, d.cto_id, d.porta_id, d.carencia_dias, d.observacoes, antes.id);
      if (d.mensalidade_centavos !== antes.mensalidade_centavos) {
        cob.registrarEvento(db, antes, { evento: 'valor_alterado', de: String(antes.mensalidade_centavos), para: String(d.mensalidade_centavos),
          motivo: v.opcional(req.body?.motivo, 'o motivo', 300), usuarioId: req.usuario.id });
      }
      if (d.plano_id !== antes.plano_id) {
        cob.registrarEvento(db, antes, { evento: 'plano_alterado', de: String(antes.plano_id), para: String(d.plano_id), usuarioId: req.usuario.id });
      }
    });
    registrar(db, req, 'contrato_alterado', { recurso: 'contrato', recursoId: antes.id, antes, depois: d });
    res.json(db.prepare(`SELECT ${COLUNAS} ${JUNCOES} WHERE c.id = ?`).get(antes.id));
  });

  // ---------------- Ciclo de vida ----------------
  r.post('/:id/ativar', exigir('contratos.ciclo'), (req, res) => {
    const c = buscar(req, req.params.id);
    if (c.situacao !== 'em_implantacao') throw new ErroNegocio(`Contrato já ${c.situacao === 'cancelado' ? 'cancelado' : 'ativado'}.`, 422);
    const plano = db.prepare('SELECT * FROM planos WHERE id = ?').get(c.plano_id);
    const ativacao = req.body?.ativacao ? v.data(req.body.ativacao, 'a data de ativação') : hoje(req);
    v.exigir(ativacao <= hoje(req), 'A ativação não pode ser no futuro: registre quando o serviço realmente entrou.');
    const portaId = req.body?.porta_id !== undefined && req.body.porta_id !== '' ? v.inteiro(req.body.porta_id, 'a porta', { min: 1 }) : c.porta_id;
    const fidelidade = plano.fidelidade_meses ? somarDias(ativacao, plano.fidelidade_meses * 30) : null;
    transacao(db, () => {
      if (portaId) marcarPorta(req, { portaId, contrato: c, situacao: 'ocupada', motivo: `Ativação do contrato ${c.numero}` });
      db.prepare("UPDATE contratos SET situacao = 'ativo', ativacao = ?, fidelidade_fim = ?, porta_id = ?, versao = versao + 1 WHERE id = ?")
        .run(ativacao, fidelidade, portaId, c.id);
      cob.registrarEvento(db, c, { evento: 'ativado', de: c.situacao, para: 'ativo', motivo: `Serviço ativado em ${dataBr(ativacao)}.`, usuarioId: req.usuario.id });
    });
    registrar(db, req, 'contrato_ativado', { recurso: 'contrato', recursoId: c.id, antes: c, depois: { ativacao, fidelidade_fim: fidelidade, porta_id: portaId } });
    res.json(db.prepare(`SELECT ${COLUNAS} ${JUNCOES} WHERE c.id = ?`).get(c.id));
  });

  r.post('/:id/suspender', exigir('contratos.ciclo'), (req, res) => {
    const c = buscar(req, req.params.id);
    if (c.situacao !== 'ativo') throw new ErroNegocio('Só um contrato ativo é suspenso a pedido.', 422);
    const motivo = v.texto(req.body?.motivo, 'o motivo da suspensão', 300);
    // Suspensão a pedido para de faturar; bloqueio por inadimplência continua faturando. São coisas diferentes.
    cob.mudarSituacao(db, c, { para: 'suspenso', evento: 'suspenso', motivo, usuarioId: req.usuario.id });
    prov.pedirCorte(db, { org: req.org, contratoId: c.id, cortar: true, origem: 'usuario', usuarioId: req.usuario.id, motivo: `Suspensão a pedido: ${motivo}` });
    registrar(db, req, 'contrato_suspenso', { recurso: 'contrato', recursoId: c.id, antes: c, depois: { motivo } });
    res.json({ ...db.prepare(`SELECT ${COLUNAS} ${JUNCOES} WHERE c.id = ?`).get(c.id), aviso: 'Contrato suspenso: não entra mais no faturamento mensal enquanto estiver assim.' });
  });

  r.post('/:id/reativar', exigir('contratos.ciclo'), (req, res) => {
    const c = buscar(req, req.params.id);
    if (c.situacao !== 'suspenso') throw new ErroNegocio('Só um contrato suspenso é reativado por aqui (bloqueio por inadimplência se resolve na cobrança).', 422);
    cob.mudarSituacao(db, c, { para: 'ativo', evento: 'reativado', motivo: v.opcional(req.body?.motivo, 'o motivo', 300), usuarioId: req.usuario.id });
    prov.pedirCorte(db, { org: req.org, contratoId: c.id, cortar: false, origem: 'usuario', usuarioId: req.usuario.id, motivo: 'Contrato reativado' });
    registrar(db, req, 'contrato_reativado', { recurso: 'contrato', recursoId: c.id, antes: c });
    res.json(db.prepare(`SELECT ${COLUNAS} ${JUNCOES} WHERE c.id = ?`).get(c.id));
  });

  r.post('/:id/cancelar', exigir('contratos.ciclo'), (req, res) => {
    const c = buscar(req, req.params.id);
    if (c.situacao === 'cancelado') throw new ErroNegocio('Contrato já cancelado.', 422);
    const motivo = v.texto(req.body?.motivo, 'o motivo do cancelamento', 300);
    const data = req.body?.data ? v.data(req.body.data, 'a data do cancelamento') : hoje(req);
    v.exigir(data <= hoje(req), 'A data do cancelamento não pode ser no futuro.');
    if (c.ativacao) v.exigir(data >= c.ativacao, 'O cancelamento não pode ser antes da ativação.');
    const posicao = fat.posicaoDoContrato(db, c.id, hoje(req));
    transacao(db, () => {
      if (c.porta_id) marcarPorta(req, { portaId: c.porta_id, contrato: c, situacao: 'livre', motivo: `Cancelamento do contrato ${c.numero}` });
      const aberto = cob.bloqueioAberto(db, c.id);
      if (aberto) db.prepare('UPDATE bloqueios SET fim = ?, motivo_liberacao = ?, liberado_por = ? WHERE id = ?').run(agora(), 'Contrato cancelado.', req.usuario.id, aberto.id);
      db.prepare('UPDATE confiancas SET encerrada_em = ?, encerramento = \'cancelada\' WHERE contrato_id = ? AND encerrada_em IS NULL').run(agora(), c.id);
      db.prepare("UPDATE contratos SET situacao = 'cancelado', cancelado_em = ?, motivo_cancelamento = ?, cancelado_por = ?, versao = versao + 1 WHERE id = ?")
        .run(data, motivo, req.usuario.id, c.id);
      cob.registrarEvento(db, c, { evento: 'cancelado', de: c.situacao, para: 'cancelado', motivo, usuarioId: req.usuario.id });
      // Contrato cancelado: o acesso sai do equipamento (aqui, sim, é remoção, não corte).
      const servico = db.prepare('SELECT * FROM servicos WHERE contrato_id = ?').get(c.id);
      if (servico?.concentrador_id) {
        prov.enfileirar(db, { org: req.org, servicoId: servico.id, acao: 'remover', origem: 'usuario', usuarioId: req.usuario.id,
          pedido: { motivo }, chave: prov.chaveDe(servico.id, 'remover') });
      }
      // Assinante sem nenhum contrato em vigor volta a ser inativo (as faturas em aberto continuam cobráveis).
      const vivos = db.prepare("SELECT COUNT(*) AS n FROM contratos WHERE assinante_id = ? AND situacao <> 'cancelado'").get(c.assinante_id).n;
      if (!vivos) db.prepare("UPDATE assinantes SET situacao = 'inativo', versao = versao + 1 WHERE id = ?").run(c.assinante_id);
    });
    registrar(db, req, 'contrato_cancelado', { recurso: 'contrato', recursoId: c.id, antes: c, depois: { motivo, data, saldo_centavos: posicao.saldo_centavos } });
    res.json({
      ...db.prepare(`SELECT ${COLUNAS} ${JUNCOES} WHERE c.id = ?`).get(c.id),
      aviso: posicao.saldo_centavos > 0
        ? `Contrato cancelado com R$ ${(posicao.saldo_centavos / 100).toFixed(2)} em aberto: as faturas continuam na cobrança.`
        : 'Contrato cancelado. A porta foi liberada na planta óptica.',
      fidelidade_em_curso: Boolean(c.fidelidade_fim && c.fidelidade_fim > data),
    });
  });

  // ---------------- Itens fixos do contrato ----------------
  r.post('/:id/itens', exigir('contratos.editar'), (req, res) => {
    const c = buscar(req, req.params.id);
    if (c.situacao === 'cancelado') throw new ErroNegocio('Contrato cancelado não recebe itens.', 422);
    const b = req.body ?? {};
    const tipo = v.opcao(b.tipo, 'o tipo', TIPOS_ITEM);
    let valor = v.centavos(b.valor, 'o valor', { min: 0 });
    v.exigir(valor > 0, 'Informe um valor maior que zero.');
    // Desconto é guardado negativo: o sinal é da regra, não do que a pessoa digita.
    if (tipo === 'desconto') valor = -valor;
    const d = {
      descricao: v.texto(b.descricao, 'a descrição', 160), tipo, valor_centavos: valor,
      inicio: b.inicio ? competencia(b.inicio, 'a competência inicial') : fat.competenciaDe(hoje(req)),
      fim: b.fim ? competencia(b.fim, 'a competência final') : null,
    };
    if (d.fim) v.exigir(d.fim >= d.inicio, 'A competência final não pode ser antes da inicial.');
    const id = Number(db.prepare(`INSERT INTO contrato_itens (organizacao_id, contrato_id, descricao, tipo, valor_centavos, inicio, fim, criado_por, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, c.id, d.descricao, d.tipo, d.valor_centavos, d.inicio, d.fim, req.usuario.id, agora()).lastInsertRowid);
    cob.registrarEvento(db, c, { evento: 'item_incluido', para: d.descricao, motivo: `${d.tipo} · R$ ${(Math.abs(d.valor_centavos) / 100).toFixed(2).replace('.', ',')} a partir de ${competenciaBr(d.inicio)}`, usuarioId: req.usuario.id });
    registrar(db, req, 'contrato_item_criado', { recurso: 'contrato', recursoId: c.id, depois: { item_id: id, ...d } });
    res.status(201).json({ id, ...d });
  });

  r.post('/:id/itens/:iid/encerrar', exigir('contratos.editar'), (req, res) => {
    const c = buscar(req, req.params.id);
    const item = db.prepare('SELECT * FROM contrato_itens WHERE id = ? AND contrato_id = ?').get(Number(req.params.iid), c.id);
    if (!item) throw new ErroNegocio('Item não encontrado neste contrato.', 404);
    if (item.fim) throw new ErroNegocio(`Este item já termina em ${item.fim}.`, 422);
    const fim = req.body?.fim ? competencia(req.body.fim, 'a competência final') : fat.competenciaDe(hoje(req));
    v.exigir(fim >= item.inicio, 'A competência final não pode ser antes da inicial.');
    // O item não é apagado: ganha competência final e continua explicando as faturas que já gerou.
    db.prepare('UPDATE contrato_itens SET fim = ? WHERE id = ?').run(fim, item.id);
    cob.registrarEvento(db, c, { evento: 'item_encerrado', para: item.descricao, motivo: `Vigência até ${competenciaBr(fim)}`, usuarioId: req.usuario.id });
    registrar(db, req, 'contrato_item_encerrado', { recurso: 'contrato', recursoId: c.id, antes: item, depois: { fim } });
    res.json({ ...item, fim });
  });

  return r;
};
