'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { limitar } = require('../lib/limitador');
const conversasLib = require('../lib/conversas');
const envio = require('../lib/envio');
const wa = require('../lib/whatsapp');
const v = require('../lib/validacao');

/**
 * API para o sistema da empresa (ERP, CRM, e-commerce): autenticação por chave própria, nunca por
 * sessão do painel. A chave vale só para a empresa dela — toda consulta já sai filtrada por empresa_id.
 */
module.exports = function rotasIntegracao(db) {
  const r = express.Router();
  r.use(limitar({ janelaMs: 60_000, maximo: 120 }));

  // ---------- Autenticação por chave ----------
  r.use((req, _res, next) => {
    const cabecalho = req.get('authorization') ?? '';
    const chave = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : String(req.get('x-api-key') ?? '').trim();
    if (!chave) return next(new ErroNegocio('Informe a chave de API em Authorization: Bearer <chave>.', 401));
    const hash = crypto.createHash('sha256').update(chave).digest('hex');
    const registro = db.prepare(`SELECT c.*, e.nome AS empresa_nome, e.status AS empresa_status FROM chaves_api c
      JOIN empresas e ON e.id = c.empresa_id WHERE c.chave_hash = ? AND c.ativa = 1`).get(hash);
    if (!registro) {
      db.prepare("INSERT INTO acessos_recusados (ip, motivo, criado_em) VALUES (?, 'integração: chave de API inválida', ?)").run(req.ip, agora());
      return next(new ErroNegocio('Chave de API inválida ou revogada.', 401));
    }
    if (registro.empresa_status !== 'ativa') return next(new ErroNegocio('Empresa bloqueada.', 403));
    db.prepare('UPDATE chaves_api SET ultimo_uso = ? WHERE id = ?').run(agora(), registro.id);
    req.empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(registro.empresa_id);
    return next();
  });

  // ---------- Conversas ----------
  r.get('/conversas', (req, res, next) => {
    try {
      res.json(conversasLib.listar(db, req.empresa.id, {
        caixa: req.query.caixa ? v.opcao(req.query.caixa, 'a caixa', ['abertas', 'aguardando', 'bot', 'encerradas']) : 'abertas',
        busca: String(req.query.telefone ?? req.query.busca ?? '').replace(/\D/g, '') || String(req.query.busca ?? '').trim(),
        pagina: Number(req.query.pagina) || 1,
        porPagina: Math.min(100, Number(req.query.por_pagina) || 30),
      }));
    } catch (err) { next(err); }
  });

  r.get('/conversas/:id', (req, res, next) => {
    try {
      const d = conversasLib.detalhe(db, req.empresa.id, Number(req.params.id));
      // A integração não precisa das notas internas da equipe.
      const { notas: _notas, eventos_ia: _eventos, ...publico } = d;
      res.json(publico);
    } catch (err) { next(err); }
  });

  // ---------- Contatos ----------
  r.post('/contatos', (req, res, next) => {
    try {
      const d = req.body ?? {};
      const telefone = v.whatsapp(d.telefone);
      const documento = d.documento ? v.digitos(d.documento) : null;
      if (documento) v.exigir((documento.length === 11 && v.cpfValido(documento)) || (documento.length === 14 && v.cnpjValido(documento)), 'CPF ou CNPJ inválido.');
      const contato = transacao(db, () => {
        const c = conversasLib.garantirContato(db, req.empresa.id, telefone, null);
        db.prepare('UPDATE contatos SET nome = COALESCE(?, nome), documento = COALESCE(?, documento), email = COALESCE(?, email), codigo_externo = COALESCE(?, codigo_externo) WHERE id = ?')
          .run(v.opcional(d.nome, 'o nome', 160), documento, d.email ? v.email(d.email) : null, v.opcional(d.codigo_externo, 'o código no sistema', 80), c.id);
        return db.prepare('SELECT * FROM contatos WHERE id = ?').get(c.id);
      });
      res.status(201).json(contato);
    } catch (err) { next(err); }
  });

  // ---------- Envio de mensagem ----------
  /**
   * Manda uma mensagem para um cliente. Dentro da janela de 24 h aceita texto livre; fora dela,
   * só template aprovado (regra da Meta). A conversa criada assim já nasce com a ZOE
   * desligada, a menos que `com_ia: true` — aviso automático não deve virar atendimento.
   */
  r.post('/mensagens', (req, res, next) => {
    try {
      const d = req.body ?? {};
      const telefone = v.whatsapp(d.telefone);
      const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ? AND ativo = 1 ORDER BY id LIMIT 1').get(req.empresa.id);
      if (!numero) throw new ErroNegocio('A empresa não tem número de WhatsApp ativo.');

      const resultado = transacao(db, () => {
        const contato = conversasLib.garantirContato(db, req.empresa.id, telefone, null);
        if (contato.bloqueado) throw new ErroNegocio('Contato bloqueado.');
        if (!contato.aceita_ativo) throw new ErroNegocio('Este contato pediu para não receber mensagens ativas.');
        const aberta = conversasLib.abertaDoContato(db, contato.id);
        const conversa = aberta ?? conversasLib.abrir(db, { empresa: req.empresa, numero, contato });
        if (!aberta) {
          const comIa = v.booleano(d.com_ia ?? false);
          db.prepare('UPDATE conversas SET estado = ?, assunto = ?, janela_expira_em = NULL WHERE id = ?')
            .run(comIa ? 'bot' : 'aguardando', v.opcional(d.assunto, 'o assunto', 160), conversa.id);
          if (!comIa) {
            const fila = require('../lib/filas').filaPadrao(db, req.empresa.id);
            if (fila) db.prepare('UPDATE conversas SET fila_id = ?, transferida_em = ? WHERE id = ?').run(fila.id, agora(), conversa.id);
          }
          envio.registrarSistema(db, conversa, 'Conversa iniciada pelo sistema da empresa (API de integração).');
        }
        const atual = db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);
        let mensagemId;
        if (d.template) {
          const corpo = wa.corpos.template('', v.texto(d.template, 'o nome do template', 120),
            v.opcional(d.idioma, 'o idioma', 10) ?? 'pt_BR', [].concat(d.parametros ?? []).map(String));
          const { to: _to, recipient_type: _rt, ...payload } = corpo;
          mensagemId = envio.enfileirar(db, atual, { autor: 'sistema', tipo: 'template', texto: `[template ${d.template}]`, payload });
        } else {
          v.exigir(wa.janelaAberta(atual),
            'Sem mensagem do cliente nas últimas 24 horas, o WhatsApp só aceita template aprovado. Informe "template" em vez de "texto".');
          mensagemId = envio.enfileirar(db, atual, { autor: 'sistema', tipo: 'texto', texto: v.texto(d.texto, 'o texto', 4096) });
        }
        return { conversa_id: atual.id, mensagem_id: mensagemId };
      });
      envio.girar(db);
      res.status(202).json({ ...resultado, situacao: 'na fila de envio' });
    } catch (err) { next(err); }
  });

  // ---------- Chamados ----------
  r.get('/chamados', (req, res, next) => {
    try {
      const onde = ['ch.empresa_id = ?'];
      const args = [req.empresa.id];
      if (req.query.status) { onde.push('ch.status = ?'); args.push(v.opcao(req.query.status, 'a situação', ['aberto', 'andamento', 'resolvido', 'cancelado'])); }
      if (req.query.desde) { onde.push('ch.criado_em >= ?'); args.push(v.data(req.query.desde, 'a data inicial')); }
      res.json({
        itens: db.prepare(`SELECT ch.protocolo, ch.assunto, ch.descricao, ch.status, ch.resolucao, ch.aberto_por, ch.criado_em, ch.atualizado_em,
            ct.telefone, ct.nome AS contato_nome, ct.documento, ct.codigo_externo, f.nome AS fila
          FROM chamados ch JOIN contatos ct ON ct.id = ch.contato_id LEFT JOIN filas f ON f.id = ch.fila_id
          WHERE ${onde.join(' AND ')} ORDER BY ch.id DESC LIMIT 200`).all(...args),
      });
    } catch (err) { next(err); }
  });

  r.patch('/chamados/:protocolo', (req, res, next) => {
    try {
      const ch = db.prepare('SELECT * FROM chamados WHERE empresa_id = ? AND protocolo = ?').get(req.empresa.id, String(req.params.protocolo).trim().toUpperCase());
      if (!ch) throw naoEncontrado('Chamado');
      const d = req.body ?? {};
      const status = d.status === undefined ? ch.status : v.opcao(d.status, 'a situação', ['aberto', 'andamento', 'resolvido', 'cancelado']);
      db.prepare('UPDATE chamados SET status = ?, resolucao = ?, atualizado_em = ? WHERE id = ?')
        .run(status, d.resolucao === undefined ? ch.resolucao : v.opcional(d.resolucao, 'a resolução', 4000), agora(), ch.id);

      // Avisar o cliente pelo WhatsApp, se a janela estiver aberta e o sistema pedir.
      let aviso = null;
      if (d.avisar_cliente && ch.conversa_id) {
        const conversa = db.prepare('SELECT * FROM conversas WHERE id = ?').get(ch.conversa_id);
        if (conversa && conversa.estado !== 'encerrada' && wa.janelaAberta(conversa)) {
          envio.enfileirar(db, conversa, { autor: 'sistema', tipo: 'texto', texto: v.texto(d.aviso ?? `Atualização do chamado ${ch.protocolo}: ${status}.`, 'o aviso', 1000) });
          envio.girar(db);
          aviso = 'na fila de envio';
        } else {
          aviso = 'não enviado: a conversa está encerrada ou fora da janela de 24 h';
        }
      }
      res.json({ ...db.prepare('SELECT protocolo, status, resolucao, atualizado_em FROM chamados WHERE id = ?').get(ch.id), aviso });
    } catch (err) { next(err); }
  });

  // ---------- Alertas de rede (é por aqui que a URA do PABX lê) ----------
  /**
   * Os alertas que valem para um cliente. A URA do telefone usa isto para dizer "já sabemos da
   * falha na sua região" em vez de abrir mais um chamado do mesmo problema.
   *
   * Os alertas são cadastrados aqui, no ZOE Atende, porque é aqui que a equipe os declara.
   * Quem precisa deles lê daqui, em vez de guardar uma cópia — duas cópias viram duas verdades.
   */
  r.get('/alertas', async (req, res, next) => {
    try {
      const alertas = require('../lib/alertas');
      const documento = String(req.query.documento ?? '').replace(/\D/g, '');
      const clienteId = String(req.query.cliente ?? '').trim();

      // Sem identificação, só os alertas que valem para a base inteira.
      if (!documento && !clienteId) {
        return res.json({ alertas: alertas.paraCliente(db, req.empresa.id, null).map(publicoDoAlerta) });
      }

      const ixc = require('../ia/ferramentas-ixc').clienteIxc(db, req.empresa.id);
      if (!ixc) return res.json({ alertas: alertas.paraCliente(db, req.empresa.id, null).map(publicoDoAlerta), aviso: 'IXC não configurado: só os alertas gerais.' });

      let cadastro = null;
      try {
        cadastro = clienteId ? await ixc.clientePorId(clienteId) : (await ixc.clientesPorDocumento(documento))[0] ?? null;
      } catch { cadastro = null; }
      if (!cadastro) return res.json({ alertas: alertas.paraCliente(db, req.empresa.id, null).map(publicoDoAlerta) });

      const dados = { cadastro, contratos: [], logins: [] };
      for (const [chave, buscar] of [['contratos', () => ixc.contratos(cadastro.id)], ['logins', () => ixc.logins(cadastro.id)]]) {
        try { const valor = await buscar(); if (Array.isArray(valor)) dados[chave] = valor; } catch { /* segue sem */ }
      }
      const aplicaveis = alertas.paraCliente(db, req.empresa.id, dados);
      alertas.marcarAvisado(db, aplicaveis.map((a) => a.id));
      res.json({ cliente: String(cadastro.id), alertas: aplicaveis.map(publicoDoAlerta) });
    } catch (err) { next(err); }
  });

  // Só o que quem avisa o cliente precisa saber — nada da configuração interna do alerta.
  const publicoDoAlerta = (a) => ({ tipo: a.tipo, tipo_nome: a.tipo_nome, mensagem: a.mensagem, previsao: a.previsao ?? null, desde: a.inicio, previsto_ate: a.fim, abre_chamado: a.abre_chamado });

  // ---------- Custo da conta da Meta (é por aqui que o Manager lê) ----------
  /**
   * O custo do WhatsApp num formato que a gestão consome direto: o mês corrente em aberto, os
   * meses fechados, o orçamento e a economia. Valores em milésimos de real (R$ 0,035 = 35) e
   * também em centavos, para quem só quer somar na planilha.
   */
  r.get('/custos', (req, res, next) => {
    try {
      const custo = require('../lib/custo');
      const orcamento = require('../lib/orcamento');
      const fechamento = require('../lib/fechamento');
      const pendencias = require('../lib/pendencias');
      const { hoje, inicioMes } = require('../lib/datas');

      const meses = Math.min(60, Math.max(1, Number(req.query.meses) || 12));
      const mesCorrente = custo.resumo(db, req.empresa.id, { de: inicioMes(), ate: hoje() });
      const o = orcamento.estado(db, req.empresa.id);
      const espera = pendencias.resumo(db, req.empresa.id);

      res.json({
        empresa: req.empresa.nome,
        gerado_em: agora(),
        moeda: 'BRL',
        // Preço por mensagem entregue, por categoria da Meta, como cadastrado na plataforma.
        precos_milesimos: custo.precos(db),
        mes_corrente: {
          mes: hoje().slice(0, 7),
          mensagens: mesCorrente.mensagens,
          por_categoria: mesCorrente.por_categoria,
          gasto_milesimos: mesCorrente.gasto_milesimos,
          gasto_centavos: Math.round(mesCorrente.gasto_milesimos / 10),
          economia_milesimos: mesCorrente.economia_milesimos,
          sem_otimizacao_milesimos: mesCorrente.sem_otimizacao_milesimos,
          projecao_milesimos: o.projecao_milesimos,
          projecao_centavos: Math.round(o.projecao_milesimos / 10),
        },
        orcamento: {
          mensal_milesimos: o.orcamento_milesimos,
          marketing_milesimos: o.orcamento_marketing_milesimos,
          gasto_milesimos: o.gasto_milesimos,
          restante_milesimos: o.restante_milesimos,
          percentual: o.percentual,
          status: o.status,
          projecao_estoura: o.projecao_estoura,
          avisos: orcamento.avisos(db, req.empresa.id),
        },
        economia_em_andamento: {
          avisos_esperando_a_janela: espera.esperando,
          valor_em_risco_milesimos: espera.em_risco_milesimos,
          avisos_salvos_pela_janela: espera.salvas_pela_janela,
        },
        meses: fechamento.serie(db, req.empresa.id, { meses }).meses,
      });
    } catch (err) { next(err); }
  });

  r.get('/saude', (req, res) => res.json({ ok: true, empresa: req.empresa.nome }));

  r.use((_req, _res, next) => next(new ErroNegocio('Rota da integração não encontrada.', 404)));
  return r;
};
