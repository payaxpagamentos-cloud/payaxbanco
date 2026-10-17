'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const { ErroNegocio } = require('./erros');

/**
 * Envio de e-mails do sistema (lembretes de cobrança, avisos de aprovação, acesso ao Portal,
 * relatório do mês). Configuração por variáveis BPO_SMTP_*; sem servidor configurado, fica desligado.
 */
let transporte = null;
const caixaTeste = []; // modo teste: mensagens ficam aqui (usado nos testes automáticos)

const configurado = () => config.smtp.modo === 'teste' || Boolean(config.smtp.host);

function obterTransporte() {
  if (transporte) return transporte;
  transporte = config.smtp.modo === 'teste'
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.porta, secure: config.smtp.seguro,
      auth: config.smtp.usuario ? { user: config.smtp.usuario, pass: config.smtp.senha } : undefined,
    });
  return transporte;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Corpo HTML com a identidade da Ativa. `linhas`: parágrafos (texto puro); `tabela`: [[rótulo, valor]]. */
function modelo({ titulo, linhas = [], tabela = [], botao, rodape }) {
  const tab = tabela.length ? `<table style="width:100%;border-collapse:collapse;margin:16px 0">${tabela.map(([a, b]) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #E1E8E4;color:#4A5A70">${esc(a)}</td><td style="padding:8px 0;border-bottom:1px solid #E1E8E4;text-align:right;font-weight:700;color:#0B1F3A">${esc(b)}</td></tr>`).join('')}</table>` : '';
  return `<!doctype html><html><body style="margin:0;background:#F6F7F4;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F4;padding:24px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden">
<tr><td style="background:#0B1F3A;padding:22px 28px"><span style="font-size:26px;font-weight:800;color:#fff;letter-spacing:-.5px">ativa</span>
<span style="display:block;font-size:10px;font-weight:700;letter-spacing:3px;color:#22C58B">BPO FINANCEIRO</span></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 14px;font-size:20px;color:#0B1F3A">${esc(titulo)}</h1>
${linhas.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#24334A">${esc(l)}</p>`).join('')}
${tab}
${botao ? `<p style="margin:22px 0 6px"><a href="${esc(botao.url)}" style="display:inline-block;background:#17A879;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px">${esc(botao.texto)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;background:#F3F6F4;font-size:12px;color:#7C8AA0">${esc(rodape || 'Mensagem automática da Ativa BPO Financeiro. Em caso de dúvida, responda para a equipe que atende a sua empresa.')}</td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * Envia e registra na tabela emails. Não lança erro de entrega (registra a falha) para não travar
 * a operação que gerou o e-mail; erros de configuração viram ErroNegocio quando `exigir` é true.
 */
async function enviar(db, { para, assunto, tipo, empresaId = null, referencia = null, texto, ...conteudo }, { exigir = false } = {}) {
  if (!configurado()) {
    if (exigir) throw new ErroNegocio('O envio de e-mails não está configurado (BPO_SMTP_HOST). Veja Segurança e backups.', 422);
    return { enviado: false, motivo: 'desligado' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(para ?? ''))) return { enviado: false, motivo: 'sem e-mail' };
  const registrar = (status, erro) => db.prepare('INSERT INTO emails (empresa_id, tipo, para, assunto, status, erro, referencia) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(empresaId, tipo, para, assunto, status, erro ?? null, referencia);
  try {
    const info = await obterTransporte().sendMail({ from: config.smtp.remetente, to: para, subject: assunto, text: texto || conteudo.linhas?.join('\n\n'), html: modelo(conteudo) });
    if (config.smtp.modo === 'teste') caixaTeste.push({ para, assunto, tipo, mensagem: JSON.parse(info.message) });
    registrar('enviado');
    return { enviado: true };
  } catch (err) {
    registrar('falhou', String(err.message).slice(0, 300));
    if (exigir) throw new ErroNegocio(`Falha ao enviar o e-mail: ${err.message}`, 502);
    return { enviado: false, motivo: err.message };
  }
}

/** Link absoluto para o Portal do Cliente (precisa de BPO_URL_PUBLICA para sair completo). */
const linkPortal = () => `${config.urlPublica}${config.portalPath}/`;
const linkEquipe = () => `${config.urlPublica}${config.basePath}/`;

module.exports = { configurado, enviar, modelo, linkPortal, linkEquipe, caixaTeste };
