'use strict';

const express = require('express');
const fs = require('node:fs');
const { agora, auditar, transacao } = require('../db');
const { exigirAdminEmpresa, administraEmpresa } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const conversasLib = require('../lib/conversas');
const filasLib = require('../lib/filas');
const envio = require('../lib/envio');
const empresasLib = require('../lib/empresas');
const relatorios = require('../lib/relatorios');
const midia = require('../lib/midia');
const wa = require('../lib/whatsapp');
const { hoje, inicioMes, intervalo } = require('../lib/datas');
const v = require('../lib/validacao');

/**
 * Painel da empresa: a caixa de entrada dos atendentes e a administração do atendimento.
 * `acessoEmpresa` já garantiu que o usuário pode entrar aqui e que o supervisor só faz GET.
 */
module.exports = function rotasEmpresa(db) {
  const r = express.Router();

  const conversaDa = (req) => {
    const c = db.prepare('SELECT * FROM conversas WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
    if (!c) throw naoEncontrado('Conversa');
    return c;
  };
  /** O atendente só mexe na conversa que é dele; o administrador mexe em qualquer uma. */
  const exigirDono = (req, c) => {
    if (administraEmpresa(req.usuario)) return;
    if (c.atendente_id && c.atendente_id !== req.usuario.id) throw new ErroNegocio('Esta conversa está com outro atendente.', 403);
  };
  const periodo = (req) => ({
    de: req.query.de ? v.data(req.query.de, 'a data inicial') : inicioMes(),
    ate: req.query.ate ? v.data(req.query.ate, 'a data final') : hoje(),
  });

  // ---------- Empresa e painel ----------
  r.get('/', (req, res) => res.json({
    id: req.empresa.id, nome: req.empresa.nome, documento: req.empresa.documento, email: req.empresa.email, telefone: req.empresa.telefone,
    status: req.empresa.status, limite_atendentes: req.empresa.limite_atendentes, limite_ia_mes: req.empresa.limite_ia_mes,
  }));

  r.get('/painel', (req, res) => res.json(relatorios.painel(db, req.empresa.id)));

  // ---------- Caixa de entrada ----------
  r.get('/conversas', (req, res) => res.json(conversasLib.listar(db, req.empresa.id, {
    caixa: req.query.caixa ?? 'abertas',
    usuario: req.usuario,
    filaId: req.query.fila_id || null,
    atendenteId: req.query.atendente_id || null,
    resolvidaPor: req.query.resolvida_por || null,
    busca: String(req.query.busca ?? '').trim(),
    ...(req.query.de ? { de: intervalo(v.data(req.query.de, 'a data inicial'), v.data(req.query.ate ?? req.query.de, 'a data final'))[0] } : {}),
    ...(req.query.ate ? { ate: intervalo(v.data(req.query.de ?? req.query.ate, 'a data inicial'), v.data(req.query.ate, 'a data final'))[1] } : {}),
    pagina: Number(req.query.pagina) || 1,
    porPagina: Math.min(100, Number(req.query.por_pagina) || 30),
  })));

  r.get('/conversas/:id', (req, res) => res.json(conversasLib.detalhe(db, req.empresa.id, Number(req.params.id))));

  /** Envia uma mensagem como atendente. Fora da janela de 24 h, só com template aprovado. */
  r.post('/conversas/:id/mensagens', (req, res, next) => {
    try {
      const c = conversaDa(req);
      exigirDono(req, c);
      if (c.estado === 'encerrada') throw new ErroNegocio('Esta conversa já foi encerrada. Abra uma nova para falar com o cliente.');
      const d = req.body ?? {};
      const resultado = transacao(db, () => {
        // Atalho de resposta rápida: "/boleto" vira o texto cadastrado.
        let texto = String(d.texto ?? '').trim();
        const atalho = texto.match(/^\/([\w-]+)\s*$/);
        if (atalho) {
          const rr = db.prepare('SELECT * FROM respostas_rapidas WHERE empresa_id = ? AND atalho = ? AND ativa = 1').get(req.empresa.id, atalho[1].toLowerCase());
          if (!rr) throw new ErroNegocio(`Resposta rápida "/${atalho[1]}" não encontrada.`);
          texto = rr.texto;
          db.prepare('UPDATE respostas_rapidas SET usos = usos + 1 WHERE id = ?').run(rr.id);
        }

        let mensagemId;
        if (d.template) {
          const nome = v.texto(d.template, 'o nome do template', 120);
          const corpo = wa.corpos.template('', nome, v.opcional(d.idioma, 'o idioma', 10) ?? 'pt_BR', [].concat(d.parametros ?? []).map(String));
          const { to, recipient_type: _rt, ...payload } = corpo;
          mensagemId = envio.enfileirar(db, c, {
            autor: 'atendente', usuarioId: req.usuario.id, tipo: 'template',
            texto: `[template ${nome}${d.parametros?.length ? `: ${[].concat(d.parametros).join(' | ')}` : ''}]`, payload,
          });
        } else {
          v.exigir(texto, 'Escreva a mensagem.');
          v.exigir(texto.length <= 4096, 'A mensagem deve ter até 4096 caracteres.');
          if (!wa.janelaAberta(c)) {
            throw new ErroNegocio('Passaram-se mais de 24 horas desde a última mensagem do cliente. Nesse caso o WhatsApp só aceita um template aprovado pela Meta.', 409);
          }
          mensagemId = envio.enfileirar(db, c, {
            autor: 'atendente', usuarioId: req.usuario.id, tipo: 'texto', texto,
            respondeWaId: v.opcional(d.responde_wa_id, 'a mensagem respondida', 120),
          });
        }
        // Quem respondeu assume a conversa, se ainda estava na fila ou com a IA.
        if (c.estado !== 'humano') {
          db.prepare("UPDATE conversas SET estado = 'humano', atendente_id = ?, assumida_em = COALESCE(assumida_em, ?) WHERE id = ?")
            .run(req.usuario.id, agora(), c.id);
        }
        db.prepare('UPDATE conversas SET primeira_resposta_humana_em = COALESCE(primeira_resposta_humana_em, ?) WHERE id = ?').run(agora(), c.id);
        return mensagemId;
      });
      envio.girar(db);
      res.status(201).json(db.prepare('SELECT id, tipo, texto, status, criada_em FROM mensagens WHERE id = ?').get(resultado));
    } catch (err) { next(err); }
  });

  r.post('/conversas/:id/assumir', (req, res, next) => {
    try {
      const c = conversasLib.assumir(db, req.empresa.id, Number(req.params.id), req.usuario);
      res.json(conversasLib.resumo(db, req.empresa.id, c.id));
    } catch (err) { next(err); }
  });

  r.post('/conversas/:id/devolver', (req, res, next) => {
    try {
      const c = conversaDa(req);
      exigirDono(req, c);
      const quem = transacao(db, () => conversasLib.devolver(db, c, req.usuario, v.opcional(req.body?.motivo, 'o motivo', 300)));
      envio.girar(db);
      res.json({ ok: true, atendente: quem?.nome ?? null });
    } catch (err) { next(err); }
  });

  r.post('/conversas/:id/transferir', (req, res, next) => {
    try {
      const c = conversaDa(req);
      exigirDono(req, c);
      const d = req.body ?? {};
      const resultado = transacao(db, () => {
        // Transferência direta para um atendente da equipe.
        if (d.atendente_id) {
          const alvo = db.prepare("SELECT * FROM usuarios WHERE id = ? AND empresa_id = ? AND ativo = 1 AND perfil IN ('atendente','cliente')")
            .get(Number(d.atendente_id), req.empresa.id);
          if (!alvo) throw naoEncontrado('Atendente');
          db.prepare("UPDATE conversas SET estado = 'humano', atendente_id = ?, assumida_em = ? WHERE id = ?").run(alvo.id, agora(), c.id);
          envio.registrarSistema(db, c, `${req.usuario.nome} transferiu o atendimento para ${alvo.nome}${d.motivo ? `: ${d.motivo}` : '.'}`, { usuarioId: req.usuario.id });
          return { atendente: alvo.nome };
        }
        const fila = filasLib.buscar(db, req.empresa.id, v.inteiro(d.fila_id, 'a fila', { min: 1 }));
        if (!fila) throw naoEncontrado('Fila');
        const t = conversasLib.transferir(db, c, {
          fila, por: 'humano', usuario: req.usuario, avisar: v.booleano(d.avisar_cliente ?? false),
          motivo: v.opcional(d.motivo, 'o motivo', 300), resumo: v.opcional(d.resumo, 'o resumo', 2000),
        });
        return { fila: t.fila.nome, atendente: t.atendente?.nome ?? null };
      });
      envio.girar(db);
      res.json({ ok: true, ...resultado });
    } catch (err) { next(err); }
  });

  /** Devolve a conversa para a atendente virtual. */
  r.post('/conversas/:id/voltar-ia', (req, res, next) => {
    try {
      const c = conversaDa(req);
      exigirDono(req, c);
      res.json(transacao(db, () => conversasLib.voltarParaIa(db, c, req.usuario)));
    } catch (err) { next(err); }
  });

  r.post('/conversas/:id/encerrar', (req, res, next) => {
    try {
      const c = conversaDa(req);
      exigirDono(req, c);
      const d = req.body ?? {};
      const fechada = transacao(db, () => {
        if (d.assunto) db.prepare('UPDATE conversas SET assunto = ? WHERE id = ?').run(v.texto(d.assunto, 'o assunto', 160), c.id);
        if (d.resumo) db.prepare('UPDATE conversas SET resumo = ? WHERE id = ?').run(v.texto(d.resumo, 'o resumo', 2000), c.id);
        return conversasLib.encerrar(db, db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id), {
          resolvidaPor: 'humano', usuario: req.usuario, mensagem: v.opcional(d.mensagem, 'a mensagem de encerramento', 1000),
          avisar: v.booleano(d.avisar_cliente ?? true), pedirCsat: d.pedir_csat === undefined ? null : v.booleano(d.pedir_csat),
        });
      });
      envio.girar(db);
      res.json(fechada);
    } catch (err) { next(err); }
  });

  r.patch('/conversas/:id', (req, res, next) => {
    try {
      const c = conversaDa(req);
      exigirDono(req, c);
      const d = req.body ?? {};
      if (d.prioridade !== undefined) {
        db.prepare('UPDATE conversas SET prioridade = ? WHERE id = ?').run(v.opcao(d.prioridade, 'a prioridade', ['baixa', 'normal', 'alta']), c.id);
      }
      if (d.assunto !== undefined) db.prepare('UPDATE conversas SET assunto = ? WHERE id = ?').run(v.opcional(d.assunto, 'o assunto', 160), c.id);
      res.json(db.prepare('SELECT id, prioridade, assunto FROM conversas WHERE id = ?').get(c.id));
    } catch (err) { next(err); }
  });

  // Notas internas.
  r.post('/conversas/:id/notas', (req, res, next) => {
    try {
      const c = conversaDa(req);
      const id = Number(db.prepare('INSERT INTO notas (conversa_id, usuario_id, texto, criada_em) VALUES (?, ?, ?, ?)')
        .run(c.id, req.usuario.id, v.texto(req.body?.texto, 'a nota', 2000), agora()).lastInsertRowid);
      res.status(201).json(db.prepare(`SELECT n.id, n.texto, n.criada_em, u.nome AS usuario_nome FROM notas n LEFT JOIN usuarios u ON u.id = n.usuario_id WHERE n.id = ?`).get(id));
    } catch (err) { next(err); }
  });

  // Etiquetas da conversa.
  r.put('/conversas/:id/etiquetas', (req, res, next) => {
    try {
      const c = conversaDa(req);
      const ids = [].concat(req.body?.etiquetas ?? []).map((x) => Number(x)).filter(Number.isInteger);
      transacao(db, () => {
        db.prepare('DELETE FROM conversa_etiquetas WHERE conversa_id = ?').run(c.id);
        for (const id of ids) {
          const e = db.prepare('SELECT id FROM etiquetas WHERE id = ? AND empresa_id = ?').get(id, req.empresa.id);
          if (e) db.prepare('INSERT OR IGNORE INTO conversa_etiquetas (conversa_id, etiqueta_id) VALUES (?, ?)').run(c.id, e.id);
        }
      });
      res.json({ etiquetas: db.prepare(`SELECT e.id, e.nome, e.cor FROM conversa_etiquetas ce JOIN etiquetas e ON e.id = ce.etiqueta_id WHERE ce.conversa_id = ?`).all(c.id) });
    } catch (err) { next(err); }
  });

  r.post('/mensagens/:id/reenviar', (req, res, next) => {
    try { res.json(envio.reenviar(db, Number(req.params.id), req.empresa.id)); } catch (err) { next(err); }
  });

  /** Baixa a mídia que o cliente mandou. Sempre como anexo, nunca executada pelo navegador. */
  r.get('/mensagens/:id/midia', (req, res, next) => {
    try {
      const m = db.prepare('SELECT * FROM mensagens WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!m?.midia_arquivo) throw naoEncontrado('Arquivo');
      const caminho = midia.caminho(m.midia_arquivo);
      if (!caminho || !fs.existsSync(caminho)) throw naoEncontrado('Arquivo');
      const nome = (m.midia_nome ?? `arquivo${midia.extensaoDe(m.midia_mime)}`).replace(/[^\w.\- ]/g, '_');
      res.set({
        'Content-Type': m.midia_mime || 'application/octet-stream',
        'Content-Disposition': `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${nome}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=86400',
      });
      fs.createReadStream(caminho).pipe(res);
    } catch (err) { next(err); }
  });

  // ---------- Contatos ----------
  r.get('/contatos', (req, res) => {
    const busca = String(req.query.busca ?? '').trim();
    const args = [req.empresa.id];
    let onde = 'ct.empresa_id = ?';
    if (busca) { onde += ' AND (ct.telefone LIKE ? OR ct.nome LIKE ? OR ct.nome_perfil LIKE ? OR ct.documento LIKE ?)'; args.push(`%${busca}%`, `%${busca}%`, `%${busca}%`, `%${busca}%`); }
    res.json({
      itens: db.prepare(`SELECT ct.*, (SELECT COUNT(*) FROM conversas c WHERE c.contato_id = ct.id) AS conversas,
          (SELECT COUNT(*) FROM conversas c WHERE c.contato_id = ct.id AND c.estado <> 'encerrada') AS abertas
        FROM contatos ct WHERE ${onde} ORDER BY COALESCE(ct.ultimo_contato_em, ct.primeiro_contato_em) DESC LIMIT 200`).all(...args),
    });
  });

  r.patch('/contatos/:id', (req, res, next) => {
    try {
      const c = db.prepare('SELECT * FROM contatos WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!c) throw naoEncontrado('Contato');
      const d = req.body ?? {};
      const documento = d.documento === undefined ? c.documento : (d.documento ? v.digitos(d.documento) : null);
      if (documento) v.exigir((documento.length === 11 && v.cpfValido(documento)) || (documento.length === 14 && v.cnpjValido(documento)), 'CPF ou CNPJ inválido.');
      db.prepare('UPDATE contatos SET nome = ?, documento = ?, email = ?, codigo_externo = ?, observacoes = ?, bloqueado = ?, aceita_ativo = ? WHERE id = ?')
        .run(d.nome === undefined ? c.nome : v.opcional(d.nome, 'o nome', 160), documento,
          d.email === undefined ? c.email : (d.email ? v.email(d.email) : null),
          d.codigo_externo === undefined ? c.codigo_externo : v.opcional(d.codigo_externo, 'o código no sistema', 80),
          d.observacoes === undefined ? c.observacoes : v.opcional(d.observacoes, 'as observações', 2000),
          d.bloqueado === undefined ? c.bloqueado : (v.booleano(d.bloqueado) ? 1 : 0),
          d.aceita_ativo === undefined ? c.aceita_ativo : (v.booleano(d.aceita_ativo) ? 1 : 0), c.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'alterou o contato', alvo: c.telefone, ip: req.ip });
      res.json(db.prepare('SELECT * FROM contatos WHERE id = ?').get(c.id));
    } catch (err) { next(err); }
  });

  /**
   * Inicia uma conversa com o cliente (mensagem ativa). Fora da janela de 24 h é obrigatório
   * um template aprovado — regra da Meta, não nossa.
   */
  r.post('/contatos/:id/conversar', (req, res, next) => {
    try {
      const contato = db.prepare('SELECT * FROM contatos WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!contato) throw naoEncontrado('Contato');
      if (contato.bloqueado) throw new ErroNegocio('Este contato está bloqueado.');
      if (!contato.aceita_ativo) throw new ErroNegocio('Este contato pediu para não receber mensagens ativas.');
      const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ? AND ativo = 1 ORDER BY id LIMIT 1').get(req.empresa.id);
      if (!numero) throw new ErroNegocio('A empresa não tem número de WhatsApp ativo.');
      const d = req.body ?? {};
      const resultado = transacao(db, () => {
        const aberta = conversasLib.abertaDoContato(db, contato.id);
        const conversa = aberta ?? conversasLib.abrir(db, { empresa: req.empresa, numero, contato });
        if (!aberta) {
          // Conversa iniciada pela equipe: já nasce com o atendente, sem passar pela IA.
          db.prepare("UPDATE conversas SET estado = 'humano', atendente_id = ?, assumida_em = ?, janela_expira_em = NULL, assunto = ? WHERE id = ?")
            .run(req.usuario.id, agora(), v.opcional(d.assunto, 'o assunto', 160), conversa.id);
          envio.registrarSistema(db, conversa, `${req.usuario.nome} iniciou a conversa com o cliente.`, { usuarioId: req.usuario.id });
        }
        const atual = db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);
        if (d.template) {
          const corpo = wa.corpos.template('', v.texto(d.template, 'o nome do template', 120), v.opcional(d.idioma, 'o idioma', 10) ?? 'pt_BR', [].concat(d.parametros ?? []).map(String));
          const { to, recipient_type: _rt, ...payload } = corpo;
          envio.enfileirar(db, atual, { autor: 'atendente', usuarioId: req.usuario.id, tipo: 'template', texto: `[template ${d.template}]`, payload });
        } else {
          v.exigir(wa.janelaAberta(atual), 'Sem uma mensagem do cliente nas últimas 24 horas, o WhatsApp só aceita template aprovado. Informe o nome do template.');
          envio.enfileirar(db, atual, { autor: 'atendente', usuarioId: req.usuario.id, tipo: 'texto', texto: v.texto(d.texto, 'a mensagem', 4096) });
        }
        return atual;
      });
      envio.girar(db);
      res.status(201).json({ conversa_id: resultado.id });
    } catch (err) { next(err); }
  });

  // ---------- Filas ----------
  r.get('/filas', (req, res) => res.json({
    itens: filasLib.listar(db, req.empresa.id, { todas: true }).map((f) => ({
      ...f, ativa: Boolean(f.ativa), dentro_horario: filasLib.dentroHorario(f),
      atendentes: db.prepare(`SELECT u.id, u.nome, u.disponivel FROM fila_usuarios fu JOIN usuarios u ON u.id = fu.usuario_id
        WHERE fu.fila_id = ? AND u.ativo = 1 ORDER BY u.nome`).all(f.id).map((u) => ({ ...u, disponivel: Boolean(u.disponivel) })),
      aguardando: Number(db.prepare("SELECT COUNT(*) AS n FROM conversas WHERE fila_id = ? AND estado = 'aguardando'").all(f.id)[0].n),
    })),
    espera: filasLib.espera(db, req.empresa.id),
  }));

  const dadosFila = (d, atual = {}) => ({
    nome: d.nome === undefined ? atual.nome : v.texto(d.nome, 'o nome da fila', 60),
    descricao: d.descricao === undefined ? atual.descricao : v.opcional(d.descricao, 'a descrição', 300),
    quando_usar: d.quando_usar === undefined ? atual.quando_usar : v.opcional(d.quando_usar, 'quando usar', 500),
    dias: d.dias === undefined ? (atual.dias ?? '0111110') : v.diasSemana(d.dias),
    abre: d.abre === undefined ? (atual.abre ?? '08:00') : v.horario(d.abre, 'o horário de abertura'),
    fecha: d.fecha === undefined ? (atual.fecha ?? '18:00') : v.horario(d.fecha, 'o horário de fechamento'),
    ordem: d.ordem === undefined ? (atual.ordem ?? 0) : v.inteiro(d.ordem, 'a ordem', { min: 0, max: 999 }),
    ativa: d.ativa === undefined ? (atual.ativa ?? 1) : (v.booleano(d.ativa) ? 1 : 0),
  });

  r.post('/filas', exigirAdminEmpresa, (req, res, next) => {
    try {
      const f = dadosFila(req.body ?? {});
      const id = Number(db.prepare('INSERT INTO filas (empresa_id, nome, descricao, quando_usar, dias, abre, fecha, ordem, ativa, criada_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.empresa.id, f.nome, f.descricao, f.quando_usar, f.dias, f.abre, f.fecha, f.ordem, f.ativa, agora()).lastInsertRowid);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'criou a fila', alvo: f.nome, ip: req.ip });
      res.status(201).json(db.prepare('SELECT * FROM filas WHERE id = ?').get(id));
    } catch (err) { next(err); }
  });

  r.patch('/filas/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const atual = filasLib.buscar(db, req.empresa.id, req.params.id);
      if (!atual) throw naoEncontrado('Fila');
      const f = dadosFila(req.body ?? {}, atual);
      db.prepare('UPDATE filas SET nome = ?, descricao = ?, quando_usar = ?, dias = ?, abre = ?, fecha = ?, ordem = ?, ativa = ? WHERE id = ?')
        .run(f.nome, f.descricao, f.quando_usar, f.dias, f.abre, f.fecha, f.ordem, f.ativa, atual.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'alterou a fila', alvo: f.nome, detalhe: { antes: atual, depois: f }, ip: req.ip });
      res.json(db.prepare('SELECT * FROM filas WHERE id = ?').get(atual.id));
    } catch (err) { next(err); }
  });

  r.delete('/filas/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const fila = filasLib.buscar(db, req.empresa.id, req.params.id);
      if (!fila) throw naoEncontrado('Fila');
      const emUso = Number(db.prepare("SELECT COUNT(*) AS n FROM conversas WHERE fila_id = ? AND estado <> 'encerrada'").all(fila.id)[0].n);
      if (emUso) throw new ErroNegocio(`A fila tem ${emUso} conversa(s) em aberto. Mova ou encerre antes de excluir.`);
      transacao(db, () => {
        db.prepare('UPDATE ia_config SET fila_padrao_id = NULL WHERE fila_padrao_id = ?').run(fila.id);
        db.prepare('UPDATE intencoes SET fila_id = NULL WHERE fila_id = ?').run(fila.id);
        db.prepare('UPDATE conversas SET fila_id = NULL WHERE fila_id = ?').run(fila.id);
        db.prepare('UPDATE chamados SET fila_id = NULL WHERE fila_id = ?').run(fila.id);
        db.prepare('DELETE FROM filas WHERE id = ?').run(fila.id);
      });
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'excluiu a fila', alvo: fila.nome, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  r.put('/filas/:id/atendentes', exigirAdminEmpresa, (req, res, next) => {
    try {
      const fila = filasLib.buscar(db, req.empresa.id, req.params.id);
      if (!fila) throw naoEncontrado('Fila');
      const ids = [].concat(req.body?.atendentes ?? []).map((x) => Number(x)).filter(Number.isInteger);
      transacao(db, () => {
        db.prepare('DELETE FROM fila_usuarios WHERE fila_id = ?').run(fila.id);
        for (const id of ids) {
          const u = db.prepare("SELECT id FROM usuarios WHERE id = ? AND empresa_id = ? AND ativo = 1 AND perfil IN ('atendente','cliente')").get(id, req.empresa.id);
          if (u) db.prepare('INSERT OR IGNORE INTO fila_usuarios (fila_id, usuario_id) VALUES (?, ?)').run(fila.id, u.id);
        }
      });
      res.json({ atendentes: db.prepare('SELECT usuario_id FROM fila_usuarios WHERE fila_id = ?').all(fila.id).map((x) => x.usuario_id) });
    } catch (err) { next(err); }
  });

  // ---------- Equipe da empresa ----------
  r.get('/usuarios', (req, res) => res.json({
    itens: db.prepare(`SELECT id, nome, email, perfil, ativo, disponivel, max_simultaneas, visto_em, ultimo_acesso, criado_em,
        (SELECT COUNT(*) FROM conversas c WHERE c.atendente_id = usuarios.id AND c.estado = 'humano') AS em_atendimento
      FROM usuarios WHERE empresa_id = ? ORDER BY ativo DESC, nome`).all(req.empresa.id)
      .map((u) => ({ ...u, ativo: Boolean(u.ativo), disponivel: Boolean(u.disponivel) })),
  }));

  r.post('/usuarios', exigirAdminEmpresa, (req, res, next) => {
    try {
      const criado = empresasLib.criarUsuario(db, req.empresa.id, req.body ?? {});
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'criou usuário', alvo: criado.usuario.email, detalhe: criado.usuario.perfil, ip: req.ip });
      res.status(201).json(criado);
    } catch (err) { next(err); }
  });

  r.patch('/usuarios/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND empresa_id = ?').get(Number(req.params.id), req.empresa.id);
      if (!u) throw naoEncontrado('Usuário');
      const d = req.body ?? {};
      const ativo = d.ativo === undefined ? u.ativo : (v.booleano(d.ativo) ? 1 : 0);
      if (u.perfil === 'cliente' && !ativo) {
        const outros = Number(db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE empresa_id = ? AND perfil = 'cliente' AND ativo = 1 AND id <> ?").all(req.empresa.id, u.id)[0].n);
        if (!outros) throw new ErroNegocio('É preciso manter pelo menos um administrador ativo na empresa.');
      }
      db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ?, max_simultaneas = ? WHERE id = ?')
        .run(d.nome === undefined ? u.nome : v.texto(d.nome, 'o nome', 160),
          d.perfil === undefined ? u.perfil : v.opcao(d.perfil, 'o perfil', ['cliente', 'supervisor', 'atendente']), ativo,
          d.max_simultaneas === undefined ? u.max_simultaneas : v.inteiro(d.max_simultaneas, 'o máximo de conversas', { min: 1, max: 50 }), u.id);
      if (d.senha) db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(require('../lib/senha').hashSenha(v.senha(d.senha)), u.id);
      // Desativado ou sem ser mais atendente: devolve as conversas dele para a fila.
      if (!ativo) {
        for (const c of db.prepare("SELECT * FROM conversas WHERE atendente_id = ? AND estado = 'humano'").all(u.id)) {
          transacao(db, () => conversasLib.devolver(db, c, req.usuario, `${u.nome} foi desativado.`));
        }
      }
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'alterou usuário', alvo: u.email, ip: req.ip });
      res.json(db.prepare('SELECT id, nome, email, perfil, ativo, max_simultaneas FROM usuarios WHERE id = ?').get(u.id));
    } catch (err) { next(err); }
  });

  r.use('/ia', require('./ia')(db));
  r.use('/', require('./cadastros')(db));

  // ---------- Relatórios ----------
  r.get('/relatorios', (req, res) => {
    const { de, ate } = periodo(req);
    const empresaId = req.empresa.id;
    res.json({
      periodo: { de, ate },
      resumo: relatorios.resumo(db, { empresaId, de, ate }),
      por_dia: relatorios.porDia(db, { empresaId, de, ate }),
      por_hora: relatorios.porHora(db, { empresaId, de, ate }),
      por_fila: relatorios.porFila(db, { empresaId, de, ate }),
      por_atendente: relatorios.porAtendente(db, { empresaId, de, ate }),
      motivos: relatorios.motivosTransferencia(db, { empresaId, de, ate }),
      ia: relatorios.usoDaIa(db, { empresaId, de, ate }),
    });
  });

  r.get('/relatorios/conversas.csv', (req, res) => {
    const { de, ate } = periodo(req);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="conversas-${de}-a-${ate}.csv"` });
    res.send(`﻿${relatorios.csvConversas(db, { empresaId: req.empresa.id, de, ate })}`);
  });

  return r;
};
