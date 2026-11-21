'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, conferirVersao } = require('../lib/http');
const { cifrar } = require('../lib/cripto');
const drivers = require('../drivers');
const prov = require('../lib/provisionamento');
const v = require('../lib/validacao');

/*
 * Equipamentos, serviços provisionados e a fila de tarefas.
 *
 * Nada aqui escreve no equipamento de forma síncrona: a rota põe o pedido na fila e devolve a tarefa.
 * Assim o atendimento não fica preso esperando uma OLT, e o pedido não se perde se ela estiver fora do ar.
 * A única exceção é o ensaio e o teste de conexão, que o operador pediu para ver agora — e mesmo eles
 * passam pela fila, executada na hora, para o histórico ficar igual.
 */
module.exports = (db) => {
  const r = Router();
  /*
   * Quem vê o quê: o catálogo de drivers e a lista de equipamentos são planta de rede (rede.ver).
   * Serviços, fila e reconciliação mostram nome e login de assinante — são base de clientes, e por isso
   * exigem contratos.ver. O técnico de campo tem rede.ver e NÃO entra aqui: do atendimento dele vêm só os
   * dados daquele chamado.
   */

  const equipamento = (req, id) => {
    const x = db.prepare('SELECT * FROM equipamentos WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Equipamento não encontrado.', 404);
    return x;
  };
  const servico = (req, id) => {
    const x = db.prepare('SELECT * FROM servicos WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Serviço não encontrado.', 404);
    return x;
  };
  /** Equipamento sem o segredo, com o driver e o estado da conexão legíveis. */
  const equipamentoPublico = (x) => {
    const { segredo_cifrado: s, ...resto } = x;
    const d = x.driver ? drivers.obter(x.driver) : null;
    return { ...resto, credencial_configurada: Boolean(s), driver_rotulo: d?.rotulo ?? null, capacidades: d?.capacidades ?? [],
      identificacao: resto.identificacao ? JSON.parse(resto.identificacao) : null };
  };
  /** Executa a fila na hora, para o operador ver o resultado do que acabou de pedir. */
  const executarAgora = async (req, tarefa) => {
    const t = db.prepare('SELECT * FROM tarefas_equipamento WHERE id = ?').get(tarefa.id);
    if (t.situacao !== 'pendente') return t;
    await prov.executarTarefa(db, t);
    return db.prepare('SELECT * FROM tarefas_equipamento WHERE id = ?').get(tarefa.id);
  };
  const tarefaPublica = (t) => (t ? { ...t, pedido: t.pedido ? JSON.parse(t.pedido) : null, resultado: t.resultado ? JSON.parse(t.resultado) : null } : null);

  // ---------------- Catálogo de drivers ----------------
  r.get('/drivers', exigir('rede.ver'), (req, res) => res.json(drivers.catalogo()));

  // ---------------- Equipamentos ----------------
  r.get('/equipamentos', exigir('rede.ver'), (req, res) => {
    const f = ['organizacao_id = ?'];
    const p = [req.org];
    if (req.query.papel) { f.push('papel = ?'); p.push(String(req.query.papel)); }
    if (req.query.ativos !== '0') f.push('ativo = 1');
    const itens = db.prepare(`SELECT * FROM equipamentos WHERE ${f.join(' AND ')} ORDER BY nome`).all(...p);
    const clientes = db.prepare('SELECT concentrador_id, COUNT(*) AS n FROM servicos WHERE organizacao_id = ? GROUP BY concentrador_id').all(req.org);
    const mapa = new Map(clientes.map((x) => [x.concentrador_id, x.n]));
    res.json(itens.map((x) => ({ ...equipamentoPublico(x), servicos: mapa.get(x.id) ?? 0 })));
  });

  /** Define (ou troca) o acesso de gerência e o driver do equipamento. */
  r.put('/equipamentos/:id/acesso', exigir('integracoes.editar'), (req, res) => {
    const x = equipamento(req, req.params.id);
    const b = req.body ?? {};
    const driver = drivers.obter(v.texto(b.driver, 'o driver', 60));
    if (!driver) throw new ErroNegocio(`Driver desconhecido: ${b.driver}.`, 422);
    const papel = v.opcao(b.papel ?? driver.papeis[0], 'o papel', ['concentrador', 'olt', 'acs', 'outro']);
    if (!driver.papeis.includes(papel)) throw new ErroNegocio(`${driver.rotulo} não serve como ${papel}: ele cobre ${driver.papeis.join(', ')}.`, 422);
    const dados = {
      driver: driver.nome,
      papel,
      host: require('../drivers/base').validarHost(b.host),
      protocolo: b.protocolo ? v.opcao(b.protocolo, 'o protocolo', ['http', 'https', 'ssh', 'telnet', 'snmp']) : driver.protocolo ?? null,
      porta: b.porta ? v.inteiro(b.porta, 'a porta', { min: 1, max: 65535 }) : driver.portaPadrao ?? null,
      usuario: v.opcional(b.usuario, 'o usuário', 80),
      verificar_tls: v.booleano(b.verificar_tls) ? 1 : 0,
    };
    const segredo = b.senha ? cifrar(String(b.senha)) : x.segredo_cifrado;
    if (!segredo) throw new ErroNegocio('Informe a senha de gerência do equipamento.', 422);
    db.prepare(`UPDATE equipamentos SET driver = ?, papel = ?, host = ?, protocolo = ?, porta = ?, usuario = ?, verificar_tls = ?, segredo_cifrado = ?,
      estado_conexao = 'nao_configurado', ultimo_erro = NULL, erro_id = NULL WHERE id = ?`)
      .run(dados.driver, dados.papel, dados.host, dados.protocolo, dados.porta, dados.usuario, dados.verificar_tls, segredo, x.id);
    // A senha nunca entra na auditoria: só o fato de ter sido trocada.
    registrar(db, req, 'equipamento_acesso_definido', { recurso: 'equipamento', recursoId: x.id, antes: { driver: x.driver, host: x.host },
      depois: { ...dados, senha_trocada: Boolean(b.senha) } });
    res.json(equipamentoPublico(db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(x.id)));
  });

  /** Teste de conexão: fala com o equipamento agora e guarda o que ele respondeu sobre si. */
  r.post('/equipamentos/:id/testar', exigir('integracoes.editar'), async (req, res, next) => {
    try {
      const x = equipamento(req, req.params.id);
      const tarefa = prov.enfileirar(db, { org: req.org, equipamentoId: x.id, acao: 'identificar', origem: 'usuario', usuarioId: req.usuario.id, chave: `eq${x.id}:identificar` });
      const feita = await executarAgora(req, tarefa);
      registrar(db, req, 'equipamento_testado', { recurso: 'equipamento', recursoId: x.id, depois: { situacao: feita.situacao, erro_id: feita.erro_id } });
      res.json({ ...tarefaPublica(feita), equipamento: equipamentoPublico(db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(x.id)) });
    } catch (err) { next(err); }
  });

  // ---------------- Serviços ----------------
  r.get('/servicos', exigir('contratos.ver'), (req, res) => {
    const f = ['s.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.concentrador_id) { f.push('s.concentrador_id = ?'); p.push(Number(req.query.concentrador_id)); }
    if (req.query.contrato_id) { f.push('s.contrato_id = ?'); p.push(Number(req.query.contrato_id)); }
    const lista = listaPaginada(db, `SELECT s.*, c.numero AS contrato_numero, c.situacao AS contrato_situacao, a.nome AS assinante_nome, a.codigo AS assinante_codigo,
      e.nome AS concentrador_nome FROM servicos s JOIN contratos c ON c.id = s.contrato_id JOIN assinantes a ON a.id = c.assinante_id
      LEFT JOIN equipamentos e ON e.id = s.concentrador_id WHERE ${f.join(' AND ')} ORDER BY c.numero DESC`, p, req.query);
    lista.itens = lista.itens.map((x) => {
      const d = prov.desejado(db, x);
      const real = x.estado_real ? JSON.parse(x.estado_real) : null;
      return { ...prov.publico(x), desejado: prov.desejadoPublico(d), divergencias: prov.divergencias(d, real, x.lido_em) };
    });
    if (req.query.divergentes === '1') lista.itens = lista.itens.filter((x) => x.divergencias.some((d) => d.gravidade !== 'aviso'));
    res.json(lista);
  });

  r.get('/servicos/:id', exigir('contratos.ver'), (req, res) => {
    const x = servico(req, req.params.id);
    const d = prov.desejado(db, x);
    const real = x.estado_real ? JSON.parse(x.estado_real) : null;
    res.json({
      ...prov.publico(x),
      desejado: prov.desejadoPublico(d),
      divergencias: prov.divergencias(d, real, x.lido_em),
      concentrador: x.concentrador_id ? equipamentoPublico(db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(x.concentrador_id)) : null,
      tarefas: db.prepare(`SELECT t.*, u.nome AS usuario_nome FROM tarefas_equipamento t LEFT JOIN usuarios u ON u.id = t.usuario_id
        WHERE t.servico_id = ? ORDER BY t.id DESC LIMIT 30`).all(x.id).map(tarefaPublica),
    });
  });

  /** Cria ou atualiza o serviço de um contrato (um por contrato). */
  r.put('/contratos/:id/servico', exigir('contratos.editar'), (req, res) => {
    const contrato = db.prepare('SELECT * FROM contratos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!contrato) throw new ErroNegocio('Contrato não encontrado.', 404);
    if (contrato.situacao === 'cancelado') throw new ErroNegocio('Contrato cancelado não recebe provisionamento.', 422);
    const atual = db.prepare('SELECT * FROM servicos WHERE contrato_id = ?').get(contrato.id);
    const b = req.body ?? {};
    if (atual) conferirVersao(atual.versao, b.versao);

    const concentradorId = b.concentrador_id ? v.inteiro(b.concentrador_id, 'o concentrador', { min: 1 }) : atual?.concentrador_id ?? null;
    if (concentradorId) {
      const e = db.prepare("SELECT * FROM equipamentos WHERE id = ? AND organizacao_id = ? AND papel = 'concentrador'").get(concentradorId, req.org);
      if (!e) throw new ErroNegocio('Concentrador não encontrado nesta organização (confira o papel do equipamento).', 404);
    }
    const dados = {
      concentrador_id: concentradorId,
      tipo_acesso: b.tipo_acesso !== undefined ? v.opcao(b.tipo_acesso, 'o tipo de acesso', ['pppoe', 'ipoe', 'dhcp', 'ip_fixo']) : atual?.tipo_acesso ?? 'pppoe',
      login: b.login !== undefined ? v.opcional(b.login, 'o login', 60) : atual?.login ?? null,
      ip_fixo: b.ip_fixo !== undefined ? v.opcional(b.ip_fixo, 'o IP fixo', 45) : atual?.ip_fixo ?? null,
      mac: b.mac !== undefined ? v.opcional(b.mac, 'o MAC', 20) : atual?.mac ?? null,
      olt_id: b.olt_id !== undefined ? (b.olt_id ? v.inteiro(b.olt_id, 'a OLT', { min: 1 }) : null) : atual?.olt_id ?? null,
      pon: b.pon !== undefined ? v.opcional(b.pon, 'a PON', 40) : atual?.pon ?? null,
      onu_serial: b.onu_serial !== undefined ? v.opcional(b.onu_serial, 'o serial da ONU', 40) : atual?.onu_serial ?? null,
      cpe_serial: b.cpe_serial !== undefined ? v.opcional(b.cpe_serial, 'o serial do CPE', 60) : atual?.cpe_serial ?? null,
      observacoes: b.observacoes !== undefined ? v.opcional(b.observacoes, 'as observações', 500) : atual?.observacoes ?? null,
    };
    if (dados.login) v.exigir(/^[A-Za-z0-9._@-]{2,60}$/.test(dados.login), 'Login inválido (letras, números, ponto, traço, sublinhado ou arroba).');
    // Senha em branco num serviço novo é gerada: ninguém fica com acesso sem senha por esquecimento.
    const senha = b.senha ? String(b.senha) : (atual?.senha_cifrada ? null : prov.senhaGerada());
    if (senha) v.exigir(senha.length >= 6 && senha.length <= 60, 'A senha do acesso deve ter de 6 a 60 caracteres.');

    const id = transacao(db, () => {
      if (atual) {
        db.prepare(`UPDATE servicos SET concentrador_id = ?, tipo_acesso = ?, login = ?, ip_fixo = ?, mac = ?, olt_id = ?, pon = ?, onu_serial = ?,
          cpe_serial = ?, observacoes = ?, senha_cifrada = COALESCE(?, senha_cifrada), versao = versao + 1 WHERE id = ?`)
          .run(dados.concentrador_id, dados.tipo_acesso, dados.login, dados.ip_fixo, dados.mac, dados.olt_id, dados.pon, dados.onu_serial,
            dados.cpe_serial, dados.observacoes, senha ? cifrar(senha) : null, atual.id);
        return atual.id;
      }
      return Number(db.prepare(`INSERT INTO servicos (organizacao_id, contrato_id, concentrador_id, tipo_acesso, login, senha_cifrada, ip_fixo, mac,
        olt_id, pon, onu_serial, cpe_serial, observacoes, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.org, contrato.id, dados.concentrador_id, dados.tipo_acesso, dados.login, cifrar(senha), dados.ip_fixo, dados.mac,
          dados.olt_id, dados.pon, dados.onu_serial, dados.cpe_serial, dados.observacoes, req.usuario.id, agora()).lastInsertRowid);
    });
    registrar(db, req, atual ? 'servico_alterado' : 'servico_criado', { recurso: 'servico', recursoId: id,
      antes: atual ? { ...atual, senha_cifrada: undefined } : undefined, depois: { ...dados, senha_definida: true } });
    res.status(atual ? 200 : 201).json(prov.publico(db.prepare('SELECT * FROM servicos WHERE id = ?').get(id)));
  });

  // ---------------- Ações no equipamento ----------------
  const pedirAcao = (acao, permissao) => async (req, res, next) => {
    try {
      const x = servico(req, req.params.id);
      const ensaio = req.query.ensaio === '1' || v.booleano(req.body?.ensaio);
      const motivo = v.opcional(req.body?.motivo, 'o motivo', 300);
      const tarefa = acao === 'sincronizar'
        ? prov.sincronizar(db, { org: req.org, servico: x, origem: 'usuario', usuarioId: req.usuario.id, ensaio, motivo })
        : prov.enfileirar(db, { org: req.org, servicoId: x.id, acao, origem: 'usuario', usuarioId: req.usuario.id, ensaio,
          pedido: { motivo }, chave: ensaio ? null : prov.chaveDe(x.id, acao) });
      // O operador pediu agora e está olhando: a fila roda na hora para ele ver o resultado.
      const feita = await executarAgora(req, tarefa);
      if (!ensaio) registrar(db, req, `servico_${acao}`, { recurso: 'servico', recursoId: x.id, depois: { tarefa: feita.id, situacao: feita.situacao, motivo } });
      const atualizado = db.prepare('SELECT * FROM servicos WHERE id = ?').get(x.id);
      const d = prov.desejado(db, atualizado);
      res.json({
        tarefa: tarefaPublica(feita),
        ensaio,
        servico: prov.publico(atualizado),
        divergencias: prov.divergencias(d, atualizado.estado_real ? JSON.parse(atualizado.estado_real) : null, atualizado.lido_em),
      });
    } catch (err) { next(err); }
  };

  r.post('/servicos/:id/sincronizar', exigir('contratos.editar'), pedirAcao('sincronizar'));
  r.post('/servicos/:id/ler', exigir('contratos.ver'), pedirAcao('ler'));
  r.post('/servicos/:id/cortar', exigir('bloqueios.aplicar'), pedirAcao('cortar'));
  r.post('/servicos/:id/religar', exigir('bloqueios.liberar'), pedirAcao('religar'));
  r.post('/servicos/:id/remover', exigir('contratos.ciclo'), pedirAcao('remover'));

  // ---------------- Fila ----------------
  r.get('/tarefas', exigir('contratos.ver'), (req, res) => {
    const f = ['t.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.situacao) { f.push('t.situacao = ?'); p.push(String(req.query.situacao)); }
    if (req.query.pendentes === '1') f.push("t.situacao IN ('pendente','executando')");
    res.json(listaPaginada(db, `SELECT t.*, u.nome AS usuario_nome, e.nome AS equipamento_nome, c.numero AS contrato_numero, a.nome AS assinante_nome
      FROM tarefas_equipamento t LEFT JOIN usuarios u ON u.id = t.usuario_id LEFT JOIN equipamentos e ON e.id = t.equipamento_id
      LEFT JOIN servicos s ON s.id = t.servico_id LEFT JOIN contratos c ON c.id = s.contrato_id LEFT JOIN assinantes a ON a.id = c.assinante_id
      WHERE ${f.join(' AND ')} ORDER BY t.id DESC`, p, req.query));
  });

  r.post('/tarefas/processar', exigir('integracoes.editar'), async (req, res, next) => {
    try {
      const r2 = await prov.processarFila(db, req.org, { maximo: 30 });
      registrar(db, req, 'fila_equipamento_processada', { recurso: 'provisionamento', depois: { executadas: r2.executadas, pendentes: r2.pendentes } });
      res.json(r2);
    } catch (err) { next(err); }
  });

  r.post('/tarefas/:id/cancelar', exigir('integracoes.editar'), (req, res) => {
    const t = db.prepare("SELECT * FROM tarefas_equipamento WHERE id = ? AND organizacao_id = ? AND situacao IN ('pendente','falhou')").get(Number(req.params.id), req.org);
    if (!t) throw new ErroNegocio('Tarefa não encontrada ou já executada.', 404);
    db.prepare("UPDATE tarefas_equipamento SET situacao = 'cancelada', concluido_em = ? WHERE id = ?").run(agora(), t.id);
    registrar(db, req, 'tarefa_equipamento_cancelada', { recurso: 'servico', recursoId: t.servico_id, antes: tarefaPublica(t) });
    res.json(tarefaPublica(db.prepare('SELECT * FROM tarefas_equipamento WHERE id = ?').get(t.id)));
  });

  r.post('/tarefas/:id/repetir', exigir('integracoes.editar'), async (req, res, next) => {
    try {
      const t = db.prepare("SELECT * FROM tarefas_equipamento WHERE id = ? AND organizacao_id = ? AND situacao IN ('falhou','sem_suporte','cancelada')").get(Number(req.params.id), req.org);
      if (!t) throw new ErroNegocio('Tarefa não encontrada ou ainda em andamento.', 404);
      db.prepare("UPDATE tarefas_equipamento SET situacao = 'pendente', proxima_tentativa = ?, erro = NULL, erro_id = NULL WHERE id = ?").run(agora(), t.id);
      const feita = await executarAgora(req, t);
      res.json(tarefaPublica(feita));
    } catch (err) { next(err); }
  });

  r.get('/reconciliacao', exigir('contratos.ver', 'faturamento.ver'), (req, res) => {
    const horas = db.prepare('SELECT reconciliacao_horas FROM organizacoes WHERE id = ?').get(req.org).reconciliacao_horas;
    const servicos = db.prepare(`SELECT s.*, c.numero AS contrato_numero, c.situacao AS contrato_situacao, a.nome AS assinante_nome
      FROM servicos s JOIN contratos c ON c.id = s.contrato_id JOIN assinantes a ON a.id = c.assinante_id WHERE s.organizacao_id = ?`).all(req.org);
    const divergentes = [];
    for (const s of servicos) {
      const d = prov.desejado(db, s);
      const fora = prov.divergencias(d, s.estado_real ? JSON.parse(s.estado_real) : null, s.lido_em);
      const graves = fora.filter((x) => x.gravidade !== 'aviso');
      if (graves.length) {
        divergentes.push({ servico_id: s.id, contrato_id: s.contrato_id, contrato_numero: s.contrato_numero, assinante: s.assinante_nome,
          situacao_contrato: s.contrato_situacao, login: s.login, lido_em: s.lido_em, divergencias: graves });
      }
    }
    const ordem = { critica: 0, alta: 1, media: 2 };
    divergentes.sort((a, b) => ordem[a.divergencias[0].gravidade] - ordem[b.divergencias[0].gravidade]);
    res.json({
      reconciliacao_horas: horas,
      servicos: servicos.length,
      sem_leitura: servicos.filter((s) => !s.lido_em).length,
      divergentes,
      // O que mais dói: serviço liberado com contrato bloqueado (receita escapando) e o contrário.
      criticos: divergentes.filter((d) => d.divergencias.some((x) => x.gravidade === 'critica')).length,
    });
  });

  return r;
};
