'use strict';

const express = require('express');
const { agora, auditar } = require('../db');
const { exigirAdminEmpresa } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { cifrar, decifrar } = require('../lib/cifra');
const filasLib = require('../lib/filas');
const ixcLib = require('../ia/ixc');
const ixcTools = require('../ia/ferramentas-ixc');
const v = require('../lib/validacao');

/** Integração com o IXC Provedor: configuração, sonda de capacidades e auditoria do que o bot fez lá. */
module.exports = function rotasIxc(db) {
  const r = express.Router();

  const ler = (empresaId) => db.prepare('SELECT * FROM ixc_config WHERE empresa_id = ?').get(empresaId) ?? null;

  const publica = (c, empresaId) => ({
    ativo: Boolean(c?.ativo),
    url: c?.url ?? null,
    token_configurado: Boolean(decifrar(c?.token_cifrado, 'ixc')),
    timeout_ms: c?.timeout_ms ?? 8000,
    recursos: c?.recursos ? JSON.parse(c.recursos) : {},
    recursos_padrao: ixcLib.RECURSOS,
    confirmar_por: c?.confirmar_por ?? 'cpf3',
    max_tentativas: c?.max_tentativas ?? 3,
    desbloqueio_ativo: Boolean(c?.desbloqueio_ativo ?? 1),
    desbloqueio_limite: c?.desbloqueio_limite ?? 1,
    desbloqueio_periodo_dias: c?.desbloqueio_periodo_dias ?? 30,
    chamado_ativo: Boolean(c?.chamado_ativo ?? 1),
    assunto_chamado_id: c?.assunto_chamado_id ?? null,
    fila_financeira_id: c?.fila_financeira_id ?? null,
    fila_tecnica_id: c?.fila_tecnica_id ?? null,
    capacidades: c?.capacidades ? JSON.parse(c.capacidades) : null,
    testado_em: c?.testado_em ?? null,
    // O que a ZOE ganha hoje com esta configuração.
    ferramentas: ixcTools.montar(db, empresaId).tools.map((t) => t.name),
  });

  r.get('/', (req, res) => res.json(publica(ler(req.empresa.id), req.empresa.id)));

  r.patch('/', exigirAdminEmpresa, (req, res, next) => {
    try {
      const atual = ler(req.empresa.id) ?? {};
      const d = req.body ?? {};
      const bool = (k, padrao) => (d[k] === undefined ? (atual[k] ?? padrao) : (v.booleano(d[k]) ? 1 : 0));
      const url = d.url === undefined ? atual.url : (d.url ? v.endereco(d.url, 'o endereço do IXC').replace(/\/webservice\/v1\/?$/i, '').replace(/\/+$/, '') : null);
      const token = d.token ? cifrar(v.texto(d.token, 'o token do IXC', 300), 'ixc') : (atual.token_cifrado ?? null);

      // O token do IXC é "id:hash": confere o formato antes de guardar, para o erro aparecer aqui e não no atendimento.
      if (d.token) v.exigir(/^\d+:[A-Za-z0-9]{8,}$/.test(String(d.token).trim()), 'Token do IXC inválido. Ele tem o formato "id:hash" (Configurações > Usuários > Token, no IXC).');

      const recursos = d.recursos === undefined ? atual.recursos
        : (() => {
          const o = v.objeto(d.recursos, 'os recursos') ?? {};
          for (const k of Object.keys(o)) v.exigir(k in ixcLib.RECURSOS, `Recurso "${k}" não existe. Use: ${Object.keys(ixcLib.RECURSOS).join(', ')}.`);
          return Object.keys(o).length ? JSON.stringify(o) : null;
        })();

      const fila = (k) => (d[k] === undefined ? atual[k] : (d[k] ? (filasLib.buscar(db, req.empresa.id, d[k])?.id ?? null) : null));

      const campos = {
        ativo: bool('ativo', 0),
        url,
        token_cifrado: token,
        timeout_ms: d.timeout_ms === undefined ? (atual.timeout_ms ?? 8000) : v.inteiro(d.timeout_ms, 'o tempo limite', { min: 1000, max: 30_000 }),
        recursos,
        confirmar_por: d.confirmar_por === undefined ? (atual.confirmar_por ?? 'cpf3') : v.opcao(d.confirmar_por, 'a forma de confirmar', ['cpf3', 'nascimento']),
        max_tentativas: d.max_tentativas === undefined ? (atual.max_tentativas ?? 3) : v.inteiro(d.max_tentativas, 'o máximo de tentativas', { min: 1, max: 6 }),
        desbloqueio_ativo: bool('desbloqueio_ativo', 1),
        desbloqueio_limite: d.desbloqueio_limite === undefined ? (atual.desbloqueio_limite ?? 1) : v.inteiro(d.desbloqueio_limite, 'o limite de desbloqueios', { min: 0, max: 20 }),
        desbloqueio_periodo_dias: d.desbloqueio_periodo_dias === undefined ? (atual.desbloqueio_periodo_dias ?? 30) : v.inteiro(d.desbloqueio_periodo_dias, 'o período do limite', { min: 1, max: 365 }),
        chamado_ativo: bool('chamado_ativo', 1),
        assunto_chamado_id: d.assunto_chamado_id === undefined ? (atual.assunto_chamado_id ?? null) : v.opcional(d.assunto_chamado_id, 'o assunto do chamado', 20),
        fila_financeira_id: fila('fila_financeira_id'),
        fila_tecnica_id: fila('fila_tecnica_id'),
      };
      if (campos.ativo) {
        v.exigir(campos.url, 'Informe o endereço do IXC antes de ligar a integração.');
        v.exigir(campos.token_cifrado, 'Informe o token do IXC antes de ligar a integração.');
      }

      const colunas = Object.keys(campos);
      db.prepare(`INSERT INTO ixc_config (empresa_id, ${colunas.join(', ')}, atualizado_em)
        VALUES (?, ${colunas.map(() => '?').join(', ')}, ?)
        ON CONFLICT(empresa_id) DO UPDATE SET ${colunas.map((k) => `${k} = excluded.${k}`).join(', ')}, atualizado_em = excluded.atualizado_em`)
        .run(req.empresa.id, ...colunas.map((k) => campos[k]), agora());

      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'alterou a integração com o IXC', alvo: campos.url, ip: req.ip });
      res.json(publica(ler(req.empresa.id), req.empresa.id));
    } catch (err) { next(err); }
  });

  /**
   * Sonda: só de leitura. Testa cada capacidade nesta instância do IXC e guarda o resultado —
   * a ZOE passa a receber apenas as ferramentas que funcionam aqui.
   */
  r.post('/sonda', exigirAdminEmpresa, async (req, res, next) => {
    try {
      const c = ler(req.empresa.id);
      const token = decifrar(c?.token_cifrado, 'ixc');
      if (!c?.url || !token) throw new ErroNegocio('Informe o endereço e o token do IXC antes de testar.');
      let recursos = {};
      try { recursos = c.recursos ? JSON.parse(c.recursos) : {}; } catch { recursos = {}; }

      const comecou = Date.now();
      let resultado;
      try {
        resultado = await ixcLib.criarIxc({ url: c.url, token, timeoutMs: c.timeout_ms, recursos }).diagnosticar();
      } catch (err) {
        throw ixcLib.comoErroNegocio(err);
      }
      db.prepare('UPDATE ixc_config SET capacidades = ?, testado_em = ? WHERE empresa_id = ?')
        .run(JSON.stringify(resultado.capacidades), agora(), req.empresa.id);
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'testou a integração com o IXC', detalhe: resultado.resumo.join(', '), ip: req.ip });
      res.json({ ...resultado, ms: Date.now() - comecou, ferramentas: ixcTools.montar(db, req.empresa.id).tools.map((t) => t.name) });
    } catch (err) { next(err); }
  });

  /** Assuntos de chamado cadastrados no IXC do provedor (para escolher o padrão). */
  r.get('/assuntos', async (req, res, next) => {
    try {
      const ixc = ixcTools.clienteIxc(db, req.empresa.id);
      if (!ixc) throw new ErroNegocio('A integração com o IXC não está ligada.');
      res.json({ itens: await ixc.assuntos() });
    } catch (err) { next(ixcLib.comoErroNegocio(err)); }
  });

  /** O que a ZOE fez no IXC: a auditoria que o provedor precisa ter. */
  r.get('/acoes', (req, res) => {
    const onde = ['a.empresa_id = ?'];
    const args = [req.empresa.id];
    if (req.query.tipo) { onde.push('a.tipo = ?'); args.push(String(req.query.tipo)); }
    if (req.query.so_falhas === '1') onde.push('a.sucesso = 0');
    res.json({
      itens: db.prepare(`SELECT a.id, a.conversa_id, a.ixc_cliente_id, a.tipo, a.sucesso, a.detalhe, a.ms, a.criado_em,
          ct.telefone, COALESCE(ct.nome, ct.nome_perfil) AS contato_nome
        FROM ixc_acoes a LEFT JOIN contatos ct ON ct.id = a.contato_id
        WHERE ${onde.join(' AND ')} ORDER BY a.id DESC LIMIT 200`).all(...args)
        .map((x) => ({ ...x, sucesso: Boolean(x.sucesso) })),
      resumo: db.prepare(`SELECT tipo, COUNT(*) AS total, SUM(CASE WHEN sucesso = 0 THEN 1 ELSE 0 END) AS falhas
        FROM ixc_acoes WHERE empresa_id = ? AND criado_em >= ? GROUP BY tipo ORDER BY total DESC`)
        .all(req.empresa.id, new Date(Date.now() - 30 * 86_400_000).toISOString()),
    });
  });

  return r;
};
