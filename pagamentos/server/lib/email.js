'use strict';

/*
 * E-mail com o boleto em PDF ANEXADO, saindo pelo servidor de e-mail do próprio cliente (o provedor): o
 * assinante recebe de quem ele já conhece, com o arquivo, sem link para clicar. O servidor (SMTP), o usuário
 * e o remetente ficam na configuração do sistema do cliente; a senha fica cifrada com as outras credenciais.
 *
 * O texto é fixo e curto: quem cobra, o valor, o vencimento, a linha digitável e o PIX copia e cola. Ele
 * explica por que o aplicativo do banco mostra o nome de quem processa a cobrança.
 */
const dns = require('node:dns').promises;
const net = require('node:net');
const nodemailer = require('nodemailer');
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const v = require('./validacao');
const boletoPdf = require('./boletoPdf');
const febraban = require('./febraban');
const { valorAtualizado } = require('./boletos');

const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const data = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Nos testes nada sai para a rede: as mensagens ficam aqui. */
const caixaDeTeste = [];
const emTeste = () => process.env.PAYAX_EMAIL_TESTE === '1';

/** Lê e confere a configuração de e-mail vinda da tela. Devolve { cfg, senha } (senha undefined = manter). */
function lerConfiguracao(b = {}) {
  const ativo = v.booleano(b.email_ativo);
  if (!ativo && !b.email_host) return { cfg: { ativo: false }, senha: undefined };
  const host = String(b.email_host ?? '').trim().toLowerCase();
  if (!/^[a-z0-9.-]{3,120}$/.test(host)) throw new ErroNegocio('Informe o servidor de e-mail (SMTP), ex.: smtp.provedor.com.br.', 422);
  const porta = Number(b.email_porta || 587);
  if (![25, 465, 587, 2525].includes(porta)) throw new ErroNegocio('A porta do servidor de e-mail deve ser 587, 465, 2525 ou 25.', 422);
  const remetente = String(b.email_remetente ?? '').trim().toLowerCase();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/.test(remetente)) throw new ErroNegocio('Informe o e-mail remetente (ex.: financeiro@provedor.com.br).', 422);
  const nome = v.opcional(b.email_nome, 'o nome do remetente', 80);
  if (nome && /[\r\n<>"]/.test(nome)) throw new ErroNegocio('O nome do remetente não pode ter aspas nem sinais de menor e maior.', 422);
  const senha = b.email_senha ? String(b.email_senha) : undefined;
  return {
    cfg: { ativo, host, porta, usuario: v.opcional(b.email_usuario, 'o usuário do e-mail', 160) || remetente, remetente, nome: nome || null },
    senha,
  };
}

/** Recusa servidor de e-mail na rede interna do servidor da PAY AX. */
async function conferirHost(host) {
  if (config.ixc.redeInterna) return;
  const enderecos = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  const interno = (ip) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip === '::1' || /^f[cd]/i.test(ip);
  if (enderecos.some(interno)) throw new ErroNegocio('O servidor de e-mail aponta para a rede interna e foi recusado.', 422);
}

async function transporte(cfg, senha) {
  if (emTeste()) return nodemailer.createTransport({ jsonTransport: true });
  if (!senha) throw new ErroNegocio('Falta a senha do e-mail na configuração.', 409);
  await conferirHost(cfg.host);
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.porta, secure: cfg.porta === 465, requireTLS: cfg.porta !== 465 && cfg.porta !== 25,
    auth: { user: cfg.usuario, pass: senha },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
}

const remetente = (cfg, fantasia) => ({ name: cfg.nome || fantasia, address: cfg.remetente });

/** Monta a mensagem do boleto (assunto, texto e anexo). */
async function mensagemDoBoleto({ boleto, conta, cliente, hoje }) {
  const fantasia = boleto.beneficiario_final_fantasia || cliente.nome_fantasia || cliente.razao_social;
  const valor = valorAtualizado(boleto, hoje).valor_centavos;
  const linha = febraban.formatarLinha(boleto.linha_digitavel ?? '');
  const pdf = await boletoPdf.gerar({ boleto, conta, cliente, hoje });
  const assunto = `${fantasia}: boleto de R$ ${brl(valor)} com vencimento em ${data(boleto.vencimento)}`;
  const partes = [
    `Olá, ${boleto.pagador_nome}.`,
    `Segue em anexo (PDF) o boleto da sua fatura com ${fantasia}.`,
    `Valor: R$ ${brl(valor)}\nVencimento: ${data(boleto.vencimento)}${boleto.seu_numero ? `\nDocumento: ${boleto.seu_numero}` : ''}`,
    `Linha digitável:\n${linha}`,
    boleto.pix_emv ? `PIX copia e cola:\n${boleto.pix_emv}` : null,
    `No aplicativo do seu banco, o beneficiário aparece como ${conta.beneficiario_nome}: é a empresa que processa os pagamentos de ${fantasia}.`,
    `Em caso de dúvida, responda a este e-mail.\n${fantasia}`,
  ].filter(Boolean);
  const html = `<div style="font:15px/1.5 Arial,Helvetica,sans-serif;color:#111">${partes.map((p, i) => {
    const corpo = esc(p).replace(/\n/g, '<br>');
    return i === 3 || (i === 4 && boleto.pix_emv)
      ? `<p style="margin:0 0 14px"><span style="font-family:Consolas,Menlo,monospace;font-size:13px;word-break:break-all">${corpo}</span></p>`
      : `<p style="margin:0 0 14px">${corpo}</p>`;
  }).join('')}</div>`;
  return { assunto, texto: partes.join('\n\n'), html, anexo: { filename: boletoPdf.nomeArquivo(boleto), content: pdf, contentType: 'application/pdf' }, fantasia };
}

/**
 * Envia o boleto por e-mail e registra o resultado. Lança erro se falhar (quem chama decide se tenta de novo).
 */
async function enviarBoleto(db, { boleto, conta, cliente, cfg, senha, hoje, para = null }) {
  const destino = String(para ?? boleto.pagador_email ?? '').trim();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/.test(destino)) throw new ErroNegocio('O pagador não tem e-mail válido cadastrado.', 422);
  const m = await mensagemDoBoleto({ boleto, conta, cliente, hoje });
  let erro = null;
  try {
    const t = await transporte(cfg, senha);
    const info = await t.sendMail({ from: remetente(cfg, m.fantasia), replyTo: cfg.remetente, to: destino, subject: m.assunto, text: m.texto, html: m.html, attachments: [m.anexo] });
    if (emTeste()) caixaDeTeste.push({ para: destino, assunto: m.assunto, texto: m.texto, anexo: m.anexo.filename, bytes: m.anexo.content.length, bruto: info.message });
  } catch (err) {
    erro = err instanceof ErroNegocio ? err.message : `o servidor de e-mail recusou: ${String(err.message).slice(0, 200)}`;
  }
  db.prepare('INSERT INTO emails_enviados (cliente_id, boleto_id, destino, assunto, situacao, erro, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(cliente.id, boleto.id, destino, m.assunto, erro ? 'falha' : 'enviado', erro, agora());
  if (erro) throw new ErroNegocio(erro, 502);
  return { para: destino, assunto: m.assunto };
}

/** Confere usuário, senha e servidor sem mandar mensagem. */
async function testar(cfg, senha) {
  if (emTeste()) return { ok: true };
  const t = await transporte(cfg, senha);
  try { await t.verify(); } catch (err) { throw new ErroNegocio(`O servidor de e-mail não aceitou a conexão: ${String(err.message).slice(0, 200)}`, 502); }
  return { ok: true };
}

module.exports = { lerConfiguracao, enviarBoleto, mensagemDoBoleto, testar, caixaDeTeste };
