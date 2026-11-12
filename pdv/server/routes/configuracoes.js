'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Router } = require('express');
const config = require('../config');
const { configPublica, salvarConfig, clienteIxc } = require('../lib/ixcEmpresa');
const { permitir } = require('../auth');
const { registrar } = require('../lib/auditoria');
const { ErroNegocio } = require('../lib/erros');

const ADMINISTRA = ['master', 'suporte', 'admin'];

/** Configurações da empresa (/api/empresas/:eid/configuracoes): IXC, regras de cobrança e comprovante. */
/** Confere o começo do arquivo: só entra imagem de verdade (PNG, JPEG ou WebP). */
function formatoDaImagem(b) {
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

module.exports = (db) => {
  const r = Router({ mergeParams: true });

  r.get('/', (req, res) => res.json(configPublica(db, req.empresa.id)));

  r.patch('/', permitir(...ADMINISTRA), (req, res) => {
    const c = salvarConfig(db, req.empresa.id, req.body);
    registrar(db, req, 'config_alterada', { campos: Object.keys(req.body ?? {}).filter((k) => k !== 'ixc_token') });
    res.json(c);
  });

  // Confere endereço e token do IXC antes de ligar a integração.
  r.post('/ixc/testar', permitir(...ADMINISTRA), async (req, res) => {
    const { ixc } = clienteIxc(db, req.empresa.id, { exigirAtivo: false });
    try {
      await ixc.testar();
    } catch (err) {
      throw new ErroNegocio(`Não foi possível falar com o IXC: ${err.message}`, 502);
    }
    registrar(db, req, 'ixc_testado', undefined);
    res.json({ ok: true, mensagem: 'Conexão com o IXC funcionando.' });
  });

  /**
   * Envio do logo e da imagem de fundo (propaganda) da tela do cliente.
   * Chega como o arquivo puro no corpo, com o Content-Type da imagem; o nome é sorteado aqui
   * e o endereço guardado na configuração (arquivos/empresa<id>/<nome>).
   */
  r.post('/imagens/:tipo',
    permitir(...ADMINISTRA),
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: `${config.arquivoMaxMb}mb` }),
    (req, res) => {
      const tipo = req.params.tipo === 'logo' ? 'logo' : req.params.tipo === 'fundo' ? 'fundo' : null;
      if (!tipo) throw new ErroNegocio('Tipo de imagem inválido (use logo ou fundo).', 422);
      const dados = Buffer.isBuffer(req.body) ? req.body : null;
      if (!dados?.length) throw new ErroNegocio('Envie a imagem no corpo da requisição (PNG, JPEG ou WebP).', 422);
      const extensao = formatoDaImagem(dados);
      if (!extensao) throw new ErroNegocio('Arquivo não é uma imagem PNG, JPEG ou WebP.', 422);

      const pasta = path.join(config.arquivosDir, `empresa${req.empresa.id}`);
      fs.mkdirSync(pasta, { recursive: true });
      const nome = `${tipo}-${crypto.randomBytes(8).toString('hex')}.${extensao}`;
      fs.writeFileSync(path.join(pasta, nome), dados);
      const endereco = `arquivos/empresa${req.empresa.id}/${nome}`;
      const anterior = configPublica(db, req.empresa.id)[tipo === 'logo' ? 'logo_url' : 'autoatendimento_fundo'];
      const c = salvarConfig(db, req.empresa.id, tipo === 'logo' ? { logo_url: endereco } : { autoatendimento_fundo: endereco });
      // Apaga a imagem anterior se ela também tinha sido enviada por aqui.
      if (anterior?.startsWith(`arquivos/empresa${req.empresa.id}/`)) {
        try { fs.unlinkSync(path.join(config.arquivosDir, anterior.replace('arquivos/', ''))); } catch { /* já não existe */ }
      }
      registrar(db, req, 'imagem_enviada', { tipo, arquivo: nome });
      res.status(201).json({ url: endereco, config: c });
    });

  r.get('/auditoria', permitir(...ADMINISTRA, 'supervisor'), (req, res) => {
    const itens = db.prepare(`SELECT a.*, u.nome AS usuario_nome FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.empresa_id = ? ORDER BY a.id DESC LIMIT ?`).all(req.empresa.id, Math.min(300, Number(req.query.limite) || 100));
    res.json({ itens: itens.map((x) => ({ ...x, detalhes: x.detalhes ? JSON.parse(x.detalhes) : null })) });
  });

  return r;
};
