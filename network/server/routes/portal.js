'use strict';

const { Router } = require('express');
const { transacao, agora, proximoNumero } = require('../db');
const { ErroNegocio } = require('../lib/erros');
const { limitar } = require('../lib/limitador');
const { dataLocal } = require('../lib/datas');
const portal = require('../lib/portal');
const fat = require('../lib/faturamento');
const cob = require('../lib/cobrancas');
const pano = require('../lib/panorama');
const config = require('../config');
const v = require('../lib/validacao');

/*
 * Portal do assinante.
 *
 * A regra que vale para TODA rota autenticada daqui: o assinante vem do token (`req.assinante`), nunca do
 * corpo nem da URL. É o que impede a falha clássica deste tipo de tela — trocar o número no endereço e
 * ver a conta do vizinho. Qualquer consulta que precise do id usa o do token e filtra pela organização.
 */
/*
 * O estado do serviço, dito para o CLIENTE.
 *
 * Por dentro o sistema distingue sete situações, úteis para a equipe: nunca lido, leitura antiga, login
 * ausente no concentrador, sem serviço provisionado. Nada disso é frase para o assinante ler — e três
 * delas são problema do provedor, não dele.
 *
 * O que não muda é a honestidade: quando o sistema não sabe, ele diz que não sabe, em vez de garantir que
 * está tudo bem. Dizer "no ar" para quem está sem internet é o jeito mais rápido de perder a confiança no
 * portal inteiro.
 */
const PARA_O_CLIENTE = {
  conectado: { situacao: 'no_ar', titulo: 'Seu serviço está no ar', detalhe: 'Conexão ativa agora.' },
  sem_conexao: { situacao: 'sem_sinal', titulo: 'Não estamos recebendo sinal do seu equipamento',
    detalhe: 'Tente desligar o roteador da tomada por 30 segundos. Se não voltar, abra um chamado aqui mesmo.', acao: 'chamado' },
  bloqueado: { situacao: 'suspenso_pagamento', titulo: 'Serviço suspenso por pendência',
    detalhe: 'Assim que o pagamento for identificado, a liberação é automática.', acao: 'pagar' },
  suspenso: { situacao: 'suspenso_pedido', titulo: 'Serviço suspenso a seu pedido', detalhe: 'Fale com o provedor para reativar.' },
  implantacao: { situacao: 'em_instalacao', titulo: 'Instalação em andamento', detalhe: 'Seu contrato ainda está sendo ativado.' },
  cancelado: { situacao: 'encerrado', titulo: 'Contrato encerrado', detalhe: null },
};
const DESCONHECIDO = { situacao: 'nao_confirmado', titulo: 'Não conseguimos confirmar agora',
  detalhe: 'Isso não quer dizer que o serviço esteja fora do ar — é o sistema que não tem leitura recente deste ponto.', acao: 'chamado' };

const paraOCliente = (estado) => PARA_O_CLIENTE[estado] ?? DESCONHECIDO;

module.exports = (db) => {
  const r = Router();
  const autenticado = portal.autenticar(db);
  const hoje = (req) => dataLocal(req.assinante?.fuso ?? 'America/Sao_Paulo');

  // Entrar e ativar são as portas abertas: limite por IP, além do bloqueio por conta.
  const limiteEntrada = limitar({ janelaMs: 60_000, maximo: config.limiteLoginPorMinuto });

  r.post('/entrar', limiteEntrada, (req, res) => {
    const r2 = portal.entrar(db, { documento: req.body?.documento, senha: req.body?.senha, ip: req.ip });
    const a = db.prepare('SELECT nome FROM assinantes WHERE id = ?').get(r2.assinante_id);
    res.json({ token: r2.token, nome: a.nome });
  });

  r.post('/ativar', limiteEntrada, (req, res) => {
    const r2 = portal.ativar(db, { documento: req.body?.documento, codigo: req.body?.codigo, senha: req.body?.senha, ip: req.ip });
    const a = db.prepare('SELECT nome FROM assinantes WHERE id = ?').get(r2.assinante_id);
    res.status(201).json({ token: r2.token, nome: a.nome, primeiro_acesso: r2.primeiro_acesso });
  });

  r.use(autenticado);

  /** Tudo o que a tela inicial do assinante mostra, numa resposta só. */
  r.get('/me', (req, res) => {
    const a = req.assinante;
    const contratos = db.prepare(`SELECT c.id, c.numero, c.situacao, c.mensalidade_centavos, c.dia_vencimento, c.ativacao,
        p.nome AS plano_nome, p.download_mbps, p.upload_mbps, p.tecnologia,
        s.id AS servico_id, s.conectado, s.conexao_em, s.conexao_desde, s.lido_em
      FROM contratos c JOIN planos p ON p.id = c.plano_id LEFT JOIN servicos s ON s.contrato_id = c.id
      WHERE c.assinante_id = ? AND c.situacao <> 'cancelado' ORDER BY c.id`).all(a.id);
    const org = db.prepare('SELECT sessoes_minutos, reconciliacao_horas FROM organizacoes WHERE id = ?').get(req.org);
    const validadeMin = org.sessoes_minutos ? org.sessoes_minutos * 3 : (org.reconciliacao_horas || 12) * 60;

    const faturas = db.prepare(`SELECT id, numero, competencia, vencimento, valor_centavos, pago_centavos, situacao
      FROM faturas WHERE assinante_id = ? AND situacao IN ('aberta','parcial') ORDER BY vencimento`).all(a.id);
    const d = hoje(req);
    res.json({
      assinante: { nome: a.nome, documento: a.documento, email: a.email, telefone: a.telefone, codigo: a.codigo },
      provedor: a.organizacao_nome,
      contratos: contratos.map((c) => {
        const estado = pano.estadoDo({ contrato_situacao: c.situacao, servico_id: c.servico_id, conectado: c.conectado,
          conexao_em: c.conexao_em, lido_em: c.lido_em }, { validadeMin });
        return {
          id: c.id, numero: c.numero, situacao: c.situacao, plano: c.plano_nome,
          download_mbps: c.download_mbps, upload_mbps: c.upload_mbps, tecnologia: c.tecnologia,
          mensalidade_centavos: c.mensalidade_centavos, dia_vencimento: c.dia_vencimento,
          // A honestidade é a mesma da tela interna; a LINGUAGEM é a do cliente. "interno" fica para o
          // suporte conseguir casar o que o assinante vê com o que a equipe vê, sem ter de adivinhar.
          conexao: { ...paraOCliente(estado.estado), interno: estado.estado, desde: c.conexao_desde, lido_em: c.conexao_em ?? c.lido_em },
        };
      }),
      em_aberto: {
        faturas: faturas.length,
        valor_centavos: faturas.reduce((s, f) => s + (f.valor_centavos - f.pago_centavos), 0),
        vencidas: faturas.filter((f) => f.vencimento < d).length,
      },
      hoje: d,
    });
  });

  /** Faturas do assinante. O filtro é pelo id do token: não há como pedir a de outro. */
  r.get('/faturas', (req, res) => {
    const org = db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org);
    const d = hoje(req);
    const faturas = db.prepare(`SELECT * FROM faturas WHERE assinante_id = ? AND situacao <> 'cancelada'
      ORDER BY vencimento DESC, id DESC LIMIT 24`).all(req.assinante.id);
    res.json(faturas.map((f) => ({
      id: f.id, numero: f.numero, competencia: f.competencia, vencimento: f.vencimento,
      valor_centavos: f.valor_centavos, pago_centavos: f.pago_centavos, situacao: f.situacao, pago_em: f.pago_em,
      // Multa e juros calculados para hoje, como na tela interna: o valor da fatura não muda.
      encargos: fat.encargos(f, org, d),
    })));
  });

  /**
   * Segunda via: devolve o PIX (e o boleto, se houver). Emite se ainda não existir — é a conta do próprio
   * assinante, e é exatamente para isso que ele entrou aqui.
   */
  r.post('/faturas/:id/segunda-via', (req, res) => {
    const f = db.prepare(`SELECT * FROM faturas WHERE id = ? AND assinante_id = ? AND organizacao_id = ?`)
      .get(Number(req.params.id), req.assinante.id, req.org);
    if (!f) throw new ErroNegocio('Fatura não encontrada.', 404);
    if (f.situacao === 'paga') throw new ErroNegocio('Esta fatura já está paga.', 422);
    if (f.situacao === 'cancelada') throw new ErroNegocio('Esta fatura foi cancelada.', 422);

    const existentes = db.prepare(`SELECT * FROM cobrancas WHERE fatura_id = ? AND situacao IN ('emitida','registrada')`).all(f.id);
    let pix = existentes.find((c) => c.tipo === 'pix');
    if (!pix) {
      const conta = cob.contaDe(db, req.org);
      if (!conta.emite_pix) throw new ErroNegocio('O PIX não está disponível. Fale com o seu provedor para receber a segunda via.', 422);
      pix = transacao(db, () => cob.emitir(db, { org: req.org, fatura: f, conta, tipo: 'pix' }));
      pix = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(pix.id);
    }
    const boleto = existentes.find((c) => c.tipo === 'boleto');
    res.json({
      fatura: { numero: f.numero, vencimento: f.vencimento, valor_centavos: f.valor_centavos - f.pago_centavos },
      pix: pix ? { brcode: pix.pix_brcode, txid: pix.pix_txid, valor_centavos: pix.valor_centavos } : null,
      boleto: boleto ? { linha_digitavel: boleto.linha_digitavel, codigo_barras: boleto.codigo_barras, valor_centavos: boleto.valor_centavos } : null,
    });
  });

  /** Contratos do assinante, no formato que o sistema já usa para ligar chamado a cliente. */
  const refsDoAssinante = (req) => db.prepare("SELECT numero FROM contratos WHERE assinante_id = ?").all(req.assinante.id)
    .map((c) => `contrato:${c.numero}`);

  /** Chamados do assinante. A lista sai dos contratos DELE, não de um id vindo do pedido. */
  r.get('/chamados', (req, res) => {
    const refs = refsDoAssinante(req);
    if (!refs.length) return res.json([]);
    res.json(db.prepare(`SELECT id, numero, tipo, titulo, status, prioridade, descricao, agendado_para, criado_em, concluido_em, origem
      FROM chamados WHERE organizacao_id = ? AND cliente_ref IN (${refs.map(() => '?').join(',')})
      ORDER BY id DESC LIMIT 30`).all(req.org, ...refs));
  });

  r.post('/chamados', (req, res) => {
    const b = req.body ?? {};
    const contrato = b.contrato_id
      ? db.prepare('SELECT * FROM contratos WHERE id = ? AND assinante_id = ?').get(Number(b.contrato_id), req.assinante.id)
      : db.prepare("SELECT * FROM contratos WHERE assinante_id = ? AND situacao <> 'cancelado' ORDER BY id LIMIT 1").get(req.assinante.id);
    if (!contrato) throw new ErroNegocio('Não encontrei um contrato ativo para abrir o chamado.', 422);
    const descricao = v.texto(b.descricao, 'a descrição', 1000);
    // O assinante abre sempre como "reparo" e prioridade média: classificar é decisão da operação, não dele.
    const criado = transacao(db, () => {
      const numero = proximoNumero(db, req.org, 'chamado');
      const t = agora();
      const id = Number(db.prepare(`INSERT INTO chamados (organizacao_id, numero, tipo, titulo, descricao, cliente_ref,
        bairro, endereco, lat, lng, prioridade, status, origem, criado_em, atualizado_em)
        VALUES (?, ?, 'reparo', ?, ?, ?, ?, ?, ?, ?, 'media', 'aberto', 'portal', ?, ?)`)
        .run(req.org, numero, `Solicitação do assinante · ${req.assinante.nome}`, descricao, `contrato:${contrato.numero}`,
          contrato.bairro, [contrato.logradouro, contrato.numero_endereco].filter(Boolean).join(', ') || null,
          contrato.latitude, contrato.longitude, t, t).lastInsertRowid);
      return { id, numero };
    });
    res.status(201).json({ ...criado, aviso: 'Chamado aberto. A equipe entra em contato.' });
  });

  /** O assinante mantém o próprio contato. Endereço não: mudar o ponto de atendimento é visita técnica. */
  r.patch('/contato', (req, res) => {
    const email = req.body?.email === null || req.body?.email === '' ? null : v.email(req.body?.email);
    const telefone = req.body?.telefone ? v.telefone(req.body.telefone) : null;
    db.prepare('UPDATE assinantes SET email = ?, telefone = COALESCE(?, telefone), versao = versao + 1 WHERE id = ?')
      .run(email, telefone, req.assinante.id);
    res.json({ email, telefone: telefone ?? req.assinante.telefone });
  });

  r.post('/senha', (req, res) => {
    portal.trocarSenha(db, { assinanteId: req.assinante.id, atual: req.body?.atual, nova: req.body?.nova });
    res.status(204).end();
  });

  return r;
};
