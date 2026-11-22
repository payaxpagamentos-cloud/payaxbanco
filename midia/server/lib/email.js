'use strict';

const fs = require('node:fs');
const nodemailer = require('nodemailer');
const config = require('../config');
const { ErroNegocio } = require('./erros');

/**
 * Envio de e-mails do sistema (tela fora do ar, fatura vencida, recuperação de senha).
 * Configuração por MIDIA_SMTP_*; sem servidor configurado, tudo fica desligado — nada quebra, o painel avisa.
 */
let transporte = null;
const caixaTeste = []; // no modo teste as mensagens ficam aqui, para os testes automáticos conferirem

// Sem provedor configurado, o servidor entrega direto ao destino — desde que tenha a assinatura DKIM
// (sem ela, quase tudo cairia no spam; por isso não se liga sozinho sem a chave).
const direto = () => config.smtp.modo !== 'teste' && !config.smtp.host && Boolean(config.dkim.dominio && config.dkim.chaveArquivo);
const configurado = () => config.smtp.modo === 'teste' || Boolean(config.smtp.host) || direto();

/*
 * Assinatura DKIM: a chave privada fica num arquivo PEM e a pública num registro TXT do domínio. É ela
 * que prova, para quem recebe, que a mensagem saiu mesmo de quem diz ter saído. Sem DKIM (e sem SPF),
 * provedor grande manda a mensagem direto para o spam — veja o README.
 */
function lerDkim() {
  const { dominio, seletor, chaveArquivo } = config.dkim;
  if (!dominio || !chaveArquivo) return undefined;
  try {
    return { domainName: dominio, keySelector: seletor, privateKey: fs.readFileSync(chaveArquivo, 'utf8') };
  } catch (err) {
    console.error('[Vai Mídia] Não consegui ler a chave DKIM:', err.message);
    return undefined;
  }
}

/**
 * O registro DKIM para colar no DNS (Registro.br): o nome, e o valor já cortado em pedaços de até 255
 * letras entre aspas. Só a chave PÚBLICA sai daqui — a privada nunca deixa o servidor.
 */
function registroDkim() {
  const { dominio, seletor, chaveArquivo } = config.dkim;
  if (!dominio || !chaveArquivo) return { configurado: false, motivo: 'A assinatura DKIM não está configurada no servidor.' };
  try {
    const publica = require('node:crypto').createPublicKey(fs.readFileSync(chaveArquivo, 'utf8'))
      .export({ type: 'spki', format: 'der' }).toString('base64');
    const valor = `v=DKIM1; k=rsa; p=${publica}`;
    const dados = valor.match(/.{1,255}/g).map((p) => `"${p}"`).join(' ');
    return { configurado: true, tipo: 'TXT', nome: `${seletor}._domainkey`, dominio, dados, nome_servidor: config.entrada.nome || null };
  } catch {
    return { configurado: false, motivo: 'Não consegui ler a chave DKIM no servidor.' };
  }
}

/**
 * Entrega direta: descobre no DNS o servidor de e-mail de cada destinatário (registro MX) e entrega lá,
 * na porta 25, apresentando-se com o nome desta máquina e assinando com DKIM. É o que um provedor faz;
 * funciona porque o domínio tem SPF, DKIM e o nome reverso do IP. Tenta cada servidor do destino em ordem.
 */
const transporteDireto = {
  async sendMail(mensagem) {
    const dns = require('node:dns').promises;
    const lista = [].concat(mensagem.to).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
    const origem = typeof mensagem.from === 'string' ? (/<([^>]+)>/.exec(mensagem.from)?.[1] ?? mensagem.from) : mensagem.from.address;
    const messageId = `<${require('node:crypto').randomUUID()}@${config.dkim.dominio}>`;
    const porDominio = new Map();
    for (const e of lista) {
      const d = e.split('@')[1]?.toLowerCase();
      if (!d) continue;
      porDominio.set(d, [...(porDominio.get(d) ?? []), e]);
    }
    const falhas = [];
    let entregues = 0;
    for (const [dominio, destinos] of porDominio) {
      let servidores = [];
      try { servidores = (await dns.resolveMx(dominio)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange).filter(Boolean); } catch { /* sem MX */ }
      if (!servidores.length) servidores = [dominio];
      let ok = false;
      let ultimo = 'sem servidor de e-mail';
      for (const host of servidores.slice(0, 4)) {
        const t = nodemailer.createTransport({
          host, port: config.smtp.portaDireta, secure: false, name: config.entrada.nome || config.dkim.dominio,
          // O certificado do servidor do destino nem sempre bate com o nome do MX: usa-se criptografia quando há, sem recusar por isso.
          tls: { rejectUnauthorized: false }, dkim: lerDkim(),
          connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 45_000,
        });
        try {
          await t.sendMail({ ...mensagem, messageId, envelope: { from: origem, to: destinos } });
          ok = true;
          break;
        } catch (err) { ultimo = err.message; } finally { t.close(); }
      }
      if (ok) entregues += destinos.length; else falhas.push(`${dominio}: ${ultimo}`);
    }
    if (!entregues) throw new Error(falhas.join('; ') || 'nenhum destinatário válido');
    if (falhas.length) console.error('[Vai Mídia] E-mail não entregue a parte dos destinos:', falhas.join('; '));
    return { messageId, envelope: { from: origem, to: lista } };
  },
};

function obterTransporte() {
  if (transporte) return transporte;
  if (direto()) return (transporte = transporteDireto);
  transporte = config.smtp.modo === 'teste'
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.porta,
      secure: config.smtp.seguro,
      auth: config.smtp.usuario ? { user: config.smtp.usuario, pass: config.smtp.senha } : undefined,
      dkim: lerDkim(),
    });
  return transporte;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/*
 * Corpo do e-mail no padrão do site: papel #F5F7FA, faixa de marca na tinta #18232A, cartão branco de
 * cantos arredondados e o botão em tinta com texto branco. Caixa de e-mail não carrega fonte de fora,
 * então aqui a tipografia é a do sistema de quem lê — o resto (cor, forma, hierarquia) é o do site.
 */
function modelo({ plataforma, titulo, linhas = [], tabela = [], botao, rodape, assinatura }) {
  const tab = tabela.length ? `<table style="width:100%;border-collapse:collapse;margin:16px 0">${tabela.map(([a, b]) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #D9DFE5;color:#58636B">${esc(a)}</td>`
    + `<td style="padding:8px 0;border-bottom:1px solid #D9DFE5;text-align:right;font-weight:700;color:#18232A">${esc(b)}</td></tr>`).join('')}</table>` : '';
  const simbolo = '<svg width="26" height="21" viewBox="0 0 138 111" style="vertical-align:middle">'
    + '<path fill="#C8FF31" d="M57 0 H101 L138 51 L94 111 H57 L0 18 H39 L76 83 L94 51 Z"/></svg>';
  return `<!doctype html><html><body style="margin:0;background:#F5F7FA;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FA;padding:24px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:18px;overflow:hidden">
<tr><td style="background:#18232A;padding:20px 28px">${simbolo}
<span style="font-size:20px;font-weight:800;color:#fff;letter-spacing:-.8px;margin-left:8px;text-transform:uppercase">${esc(plataforma)}</span></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 14px;font-size:21px;letter-spacing:-.6px;color:#18232A">${esc(titulo)}</h1>
${linhas.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#44525A">${esc(l)}</p>`).join('')}
${tab}
${assinatura ? `<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid #D9DFE5;font-size:14px;line-height:1.5;color:#18232A">${esc(assinatura).replace(/\r?\n/g, '<br>')}</p>` : ''}
${botao ? `<p style="margin:22px 0 6px"><a href="${esc(botao.url)}" style="display:inline-block;background:#18232A;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 24px;border-radius:10px">${esc(botao.texto)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;background:#EDF1F4;font-size:12px;color:#58636B">${esc(rodape || 'Mensagem automática. Não é preciso responder.')}</td></tr>
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

/**
 * Envio escrito por uma pessoa (a resposta da caixa de entrada do CRM), não um aviso automático.
 *
 * Vai como texto e também em HTML no padrão da marca; os identificadores de resposta mantêm a conversa
 * amarrada, então no programa de quem recebe a resposta aparece embaixo da mensagem original.
 */
async function enviarDireto({ para, assunto, texto, emRespostaA = null, referencias = [], de = null }) {
  if (!configurado()) return { enviado: false, motivo: 'o envio de e-mails não está configurado no servidor' };
  const corpo = String(texto ?? '').trim();
  const html = modelo({
    plataforma: 'Vai Mídia',
    titulo: assunto,
    linhas: corpo.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
    rodape: 'Pode responder a este e-mail: a resposta chega direto na nossa equipe.',
    assinatura: String(de?.assinatura ?? '').trim() || undefined,
  });
  try {
    const assinatura = String(de?.assinatura ?? '').trim();
    const origem = de ? { name: de.nome || 'Vai Mídia', address: de.endereco } : config.smtp.remetente;
    const info = await obterTransporte().sendMail({
      from: origem,
      to: para,
      subject: assunto,
      text: assinatura ? `${corpo}\n\n-- \n${assinatura}` : corpo,
      html,
      inReplyTo: emRespostaA ? `<${emRespostaA}>` : undefined,
      references: referencias.length ? referencias.map((r) => `<${r}>`).join(' ') : undefined,
    });
    if (config.smtp.modo === 'teste') caixaTeste.push({ para: [para], assunto, html, texto: assinatura ? `${corpo}\n\n-- \n${assinatura}` : corpo, info });
    const remetente = de?.endereco ?? /<([^>]+)>/.exec(config.smtp.remetente)?.[1] ?? config.smtp.remetente;
    return { enviado: true, de: remetente, message_id: String(info.messageId ?? '').replace(/^<|>$/g, '') || null };
  } catch (err) {
    console.error('[Vai Mídia] Falha ao enviar e-mail:', err.message);
    return { enviado: false, motivo: err.message };
  }
}

/** Endereço do painel para os links dos e-mails. */
const linkPainel = (caminho = '') => `${config.url || `http://localhost:${config.port}${config.basePath}`}/${String(caminho).replace(/^\/+/, '')}`;

module.exports = { direto, transporteDireto, registroDkim, enviar, enviarDireto, configurado, modelo, linkPainel, caixaTeste };
