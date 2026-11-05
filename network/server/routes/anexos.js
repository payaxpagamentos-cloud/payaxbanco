'use strict';

const { Router } = require('express');
const { ErroNegocio } = require('../lib/erros');
const { pode } = require('../lib/permissoes');
const { registrar } = require('../lib/auditoria');
const anexos = require('../lib/anexos');

// Permissão de envio por recurso e a tabela onde o registro deve existir (na mesma organização).
const ENVIO = {
  chamado: { permissoes: ['chamados.executar', 'chamados.criar'], tabela: 'chamados' },
  abastecimento: { permissoes: ['combustivel.lancar'], tabela: 'abastecimentos' },
  veiculo_documento: { permissoes: ['frota.documentos'], tabela: 'veiculo_documentos' },
  manutencao: { permissoes: ['manutencao.editar'], tabela: 'manutencoes' },
  comissao_pagamento: { permissoes: ['comissoes.pagar'], tabela: 'comissao_pagamentos' },
  ativo: { permissoes: ['rede.editar'], tabela: 'ativos_rede' },
};

/**
 * Envio de arquivo: POST /anexos?recurso=chamado&recurso_id=12 com o arquivo no corpo e o nome em X-Nome-Arquivo.
 * Sem recurso_id, o anexo fica pendente e é associado na criação do registro (ex.: comprovante do abastecimento).
 */
module.exports = (db) => {
  const r = Router();

  r.post('/', (req, res) => {
    const recurso = String(req.query.recurso ?? '');
    const regra = ENVIO[recurso];
    if (!regra) throw new ErroNegocio('Recurso do anexo inválido.', 422);
    if (!regra.permissoes.some((p) => pode(req.usuario.perfil, p))) throw new ErroNegocio('Seu perfil não pode enviar este arquivo.', 403);
    const recursoId = req.query.recurso_id ? Number(req.query.recurso_id) : null;
    if (recursoId !== null) {
      const x = db.prepare(`SELECT * FROM ${regra.tabela} WHERE id = ? AND organizacao_id = ?`).get(recursoId, req.org);
      if (!x) throw new ErroNegocio('Registro não encontrado.', 404);
      if (recurso === 'chamado' && req.usuario.perfil === 'tecnico' && x.tecnico_id !== req.usuario.tecnico_id
        && !db.prepare('SELECT 1 FROM chamado_equipe WHERE chamado_id = ? AND tecnico_id = ?').get(x.id, req.usuario.tecnico_id ?? -1)) {
        throw new ErroNegocio('Chamado não encontrado.', 404);
      }
    }
    let nome = null;
    try { nome = decodeURIComponent(req.get('x-nome-arquivo') || ''); } catch { /* nome inválido: usa o padrão */ }
    const a = anexos.salvar(db, req, { recurso, recursoId, nome, conteudo: req.body });
    registrar(db, req, 'anexo_enviado', { recurso: 'anexo', recursoId: a.id, depois: { recurso, recurso_id: recursoId, nome: a.nome, tamanho: a.tamanho } });
    res.status(201).json(a);
  });

  /** Link temporário para abrir o arquivo (a permissão é verificada aqui e de novo ao abrir). */
  r.get('/:id/link', (req, res) => {
    const a = db.prepare('SELECT * FROM anexos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!a) throw new ErroNegocio('Anexo não encontrado.', 404);
    if (!anexos.podeVer(db, req.usuario, a)) throw new ErroNegocio('Seu perfil não tem acesso a este arquivo.', 403);
    res.json({ ...anexos.linkTemporario(a, req.usuario.id), nome: a.nome, mime: a.mime });
  });

  return r;
};
