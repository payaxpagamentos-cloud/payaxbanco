'use strict';

const { Router } = require('express');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const cert = require('../lib/certificado');
const v = require('../lib/validacao');

/*
 * Certificado digital.
 *
 * Nenhuma rota aqui devolve o arquivo ou a senha, e o registro de auditoria guarda só o que identifica o
 * certificado (titular, CNPJ, validade, impressão digital) — nunca o conteúdo. Um certificado em log é um
 * certificado vazado.
 */
module.exports = (db) => {
  const r = Router();
  const org = (req) => db.prepare('SELECT documento FROM organizacoes WHERE id = ?').get(req.org);

  r.get('/', exigir('integracoes.ver'), (req, res) => {
    const c = cert.ativoDe(db, req.org);
    res.json({
      certificado: cert.publico(c),
      situacao: cert.situacao(c),
      integracoes: cert.pendenciasDe(db, req.org),
      historico: cert.historico(db, req.org),
    });
  });

  r.post('/', exigir('integracoes.editar'), (req, res) => {
    const b = req.body ?? {};
    const base64 = String(b.arquivo ?? '').replace(/^data:[^,]*,/, '');
    v.exigir(base64, 'Envie o arquivo do certificado (.pfx ou .p12).');
    const pfx = Buffer.from(base64, 'base64');
    v.exigir(pfx.length, 'O arquivo enviado está vazio ou não é base64 válido.');
    const senha = String(b.senha ?? '');
    v.exigir(senha, 'Informe a senha do certificado.');

    const instalado = cert.instalar(db, {
      org: req.org,
      apelido: v.texto(b.apelido, 'o apelido', 80),
      pfx,
      senha,
      usuarioId: req.usuario.id,
      documentoEsperado: b.conferir_cnpj === false ? null : org(req)?.documento,
    });
    // O que vai para a auditoria identifica o certificado; o arquivo e a senha ficam de fora.
    registrar(db, req, 'certificado_instalado', { recurso: 'certificado', recursoId: instalado.id,
      depois: { apelido: instalado.apelido, titular: instalado.titular, documento: instalado.documento,
        valido_ate: instalado.valido_ate, impressao: instalado.impressao, substituiu: instalado.substituiu } });
    res.status(201).json({
      ...instalado,
      situacao: cert.situacao(instalado),
      aviso: instalado.substituiu ? `O certificado "${instalado.substituiu}" foi desativado: só um fica ativo por vez.` : null,
    });
  });

  r.post('/testar', exigir('integracoes.ver'), (req, res) => {
    const r2 = cert.testar(db, req.org);
    registrar(db, req, 'certificado_testado', { recurso: 'certificado', depois: { confere: r2.confere, estado: r2.estado } });
    res.json({
      ...r2,
      aviso: r2.confere ? null : 'O certificado guardado abre, mas não é o mesmo que foi instalado. Avise imediatamente.',
    });
  });

  r.delete('/', exigir('integracoes.editar'), (req, res) => {
    const motivo = v.texto(req.body?.motivo, 'o motivo da remoção', 300);
    const r2 = cert.remover(db, { org: req.org, motivo, usuarioId: req.usuario.id });
    registrar(db, req, 'certificado_removido', { recurso: 'certificado', depois: { ...r2, motivo } });
    res.json({ ...r2, aviso: 'Sem certificado, nenhuma obrigação pode ser assinada em nome da empresa.' });
  });

  return r;
};
