'use strict';

const express = require('express');
const { auditar } = require('../db');
const { exigirAdminEmpresa } = require('../auth');
const alertas = require('../lib/alertas');

/**
 * Alertas de rede da equipe.
 *
 * Consultar pode qualquer pessoa da empresa: o atendente precisa saber o que a ZOE está dizendo
 * aos clientes dele. Criar e desligar é do administrador — um alerta errado faz a ZOE afirmar
 * falha para quem está com a internet funcionando.
 */
module.exports = function rotasAlertas(db) {
  const r = express.Router();

  r.get('/', (req, res) => res.json({
    itens: alertas.listar(db, req.empresa.id),
    vigentes: alertas.vigentes(db, req.empresa.id).length,
    tipos: alertas.TIPOS,
    campos_padrao: alertas.CAMPOS_PADRAO,
  }));

  r.post('/', exigirAdminEmpresa, (req, res, next) => {
    try {
      const novo = alertas.salvar(db, req.empresa.id, req.body ?? {}, { usuario: req.usuario });
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'criou alerta de rede', alvo: novo.titulo,
        detalhe: { tipo: novo.tipo, abrangencia: novo.abrangencia, de: novo.inicio, ate: novo.fim }, ip: req.ip });
      res.status(201).json(novo);
    } catch (err) { next(err); }
  });

  r.patch('/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const x = alertas.salvar(db, req.empresa.id, req.body ?? {}, { id: Number(req.params.id), usuario: req.usuario });
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'alterou alerta de rede', alvo: x.titulo, detalhe: { ativo: x.ativo }, ip: req.ip });
      res.json(x);
    } catch (err) { next(err); }
  });

  r.delete('/:id', exigirAdminEmpresa, (req, res, next) => {
    try {
      const x = alertas.excluir(db, req.empresa.id, Number(req.params.id));
      auditar(db, { usuario: req.usuario, empresaId: req.empresa.id, acao: 'excluiu alerta de rede', alvo: x.titulo, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  /**
   * Prova em quem o alerta pega, antes de ligar.
   * Recebe o CPF/CNPJ ou o código do cliente no IXC e responde se ele está dentro — com os
   * valores que foram comparados, para quem configurou enxergar por que deu certo ou errado.
   */
  r.post('/:id/testar', exigirAdminEmpresa, async (req, res, next) => {
    try {
      const alerta = alertas.buscar(db, req.empresa.id, Number(req.params.id));
      const ixc = require('../ia/ferramentas-ixc').clienteIxc(db, req.empresa.id);
      if (!ixc) return res.json({ ok: false, erro: 'A integração com o IXC não está ligada: não há cadastro para comparar.' });

      const busca = String(req.body?.cliente ?? '').trim();
      if (!busca) return res.json({ ok: false, erro: 'Informe o CPF/CNPJ ou o código do cliente no IXC.' });

      const so = busca.replace(/\D/g, '');
      let cadastro = null;
      if (so.length === 11 || so.length === 14) {
        const achados = await ixc.clientesPorDocumento(so);
        cadastro = achados[0] ?? null;
      } else {
        cadastro = await ixc.clientePorId(busca);
      }
      if (!cadastro) return res.json({ ok: false, erro: 'Cliente não encontrado no IXC.' });

      const dados = { cadastro, contratos: [], logins: [] };
      for (const [chave, buscar] of [['contratos', () => ixc.contratos(cadastro.id)], ['logins', () => ixc.logins(cadastro.id)]]) {
        try { const valor = await buscar(); if (Array.isArray(valor)) dados[chave] = valor; } catch { /* segue sem */ }
      }

      const pegou = alertas.paraCliente(db, req.empresa.id, dados).some((a) => a.id === alerta.id);
      res.json({
        ok: true,
        cliente: cadastro.razao ?? cadastro.fantasia ?? String(cadastro.id),
        dentro_do_alerta: pegou,
        // Por que deu o que deu: os valores do cliente e as chaves do alerta, já normalizados.
        valores_do_cliente: [...alertas.valoresDoCliente(dados, alerta.campos)].sort().slice(0, 60),
        chaves_do_alerta: alerta.chaves.map(alertas.normalizar),
        vigente: alerta.vigente,
        aviso: alerta.vigente ? null : 'O alerta existe, mas não está em vigor agora (desligado ou fora do período).',
      });
    } catch (err) { next(err); }
  });

  return r;
};
