'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const { ErroNegocio } = require('./erros');

/**
 * Envio de e-mails do sistema (tela fora do ar, fatura vencida, recuperação de senha).
 * Configuração por MIDIA_SMTP_*; sem servidor configurado, tudo fica desligado — nada quebra, o painel avisa.
 */
let transporte = null;
const caixaTeste = []; // no modo teste as mensagens ficam aqui, para os testes automáticos conferirem

const configurado = () => config.smtp.modo === 'teste' || Boolean(config.smtp.host);

function obterTransporte() {
  if (transporte) return transporte;
  transporte = config.smtp.modo === 'teste'
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.porta,
      secure: config.smtp.seguro,
      auth: config.smtp.usuario ? { user: config.smtp.usuario, pass: config.smtp.senha } : undefined,
    });
  return transporte;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Corpo do e-mail na identidade da marca (preto, lime e o símbolo). */
function modelo({ plataforma, titulo, linhas = [], tabela = [], botao, rodape }) {
  const tab = tabela.length ? `<table style="width:100%;border-collapse:collapse;margin:16px 0">${tabela.map(([a, b]) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #E4E7EC;color:#5A6170">${esc(a)}</td>`
    + `<td style="padding:8px 0;border-bottom:1px solid #E4E7EC;text-align:right;font-weight:700;color:#111417">${esc(b)}</td></tr>`).join('')}</table>` : '';
  const simbolo = '<svg width="26" height="21" viewBox="0 0 138 111" style="vertical-align:middle">'
    + '<path fill="#C8FF31" d="M57 0 H101 L138 51 L94 111 H57 L0 18 H39 L76 83 L94 51 Z"/></svg>';
  return `<!doctype html><html><body style="margin:0;background:#F7F8FA;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F8FA;padding:24px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden">
<tr><td style="background:#111417;padding:20px 28px">${simbolo}
<span style="font-size:20px;font-weight:800;color:#fff;letter-spacing:-.3px;margin-left:8px;text-transform:uppercase">${esc(plataforma)}</span></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 14px;font-size:20px;color:#111417">${esc(titulo)}</h1>
${linhas.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#24262B">${esc(l)}</p>`).join('')}
${tab}
${botao ? `<p style="margin:22px 0 6px"><a href="${esc(botao.url)}" style="display:inline-block;background:#C8FF31;color:#111417;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px">${esc(botao.texto)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;background:#F1F3F6;font-size:12px;color:#6B7280">${esc(rodape || 'Mensagem automática. Não é preciso responder.')}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Envia e devolve o que aconteceu. Nunca lança erro de entrega, para não travar a rotina que gerou o aviso. */
async function enviar({ para, assunto, texto, ...conteudo }, { exigir = false } = {}) {
  if (!configurado()) {
    if (exigir) throw new ErroNegocio('O envio de e-mails não está configurado (MIDIA_SMTP_HOST). Veja o Diagnóstico.', 422);
    return { enviado: false, motivo: 'desligado' };
  }
  const destinos = [].concat(para).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e ?? '')));
  if (!destinos.length) return { enviado: false, motivo: 'sem e-mail' };
  const html = modelo(conteudo);
  try {
    const info = await obterTransporte().sendMail({
      from: config.smtp.remetente, to: destinos.join(', '), subject: assunto, text: texto ?? conteudo.linhas?.join('\n\n') ?? assunto, html,
    });
    if (config.smtp.modo === 'teste') caixaTeste.push({ para: destinos, assunto, html, texto, info });
    return { enviado: true, destinos };
  } catch (err) {
    console.error('[Vai Mídia] Falha ao enviar e-mail:', err.message);
    return { enviado: false, motivo: err.message };
  }
}

/** Endereço do painel para os links dos e-mails. */
const linkPainel = (caminho = '') => `${config.url || `http://localhost:${config.port}${config.basePath}`}/${String(caminho).replace(/^\/+/, '')}`;

module.exports = { enviar, configurado, modelo, linkPainel, caixaTeste };
