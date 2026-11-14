'use strict';

/*
 * Aviso de privacidade (LGPD, art. 9º) e canal do titular (arts. 18 e 19). Página pública, sem
 * login e sem JavaScript: funciona aberta pelo link do boleto em qualquer celular.
 *
 * O texto sai do INVENTÁRIO em lib/lgpd.js — mudar o que o sistema trata é mudar ali, e o aviso
 * acompanha. Montada nas duas áreas: /privacidade e /cliente/privacidade.
 */
const express = require('express');
const lgpd = require('../lib/lgpd');
const { limitar } = require('../lib/limitador');

const esc = lgpd.esc;
const doc = (d) => {
  const t = String(d ?? '').replace(/\D/g, '');
  return t.length === 14 ? t.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : t;
};
const VERSAO = '14/11/2026';

function pagina({ titulo, corpo }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)} · PAY AX</title>
<style>
  :root { --marca: #0a1526; --azul: #0f5fbf; --texto: #0a1422; --texto-2: #495768; --borda: #e3e9f1; --fundo: #f4f7fb; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--texto); background: var(--fundo); }
  header { background: var(--marca); color: #fff; padding: 22px 16px; }
  header .dentro, main { max-width: 820px; margin: 0 auto; }
  header strong { font-size: 20px; letter-spacing: 0.04em; } header strong span { color: #6fd3fb; }
  header p { margin: 4px 0 0; color: #b7c4d6; font-size: 14px; }
  main { padding: 20px 16px 60px; }
  section { background: #fff; border: 1px solid var(--borda); border-radius: 14px; padding: 18px 20px; margin-bottom: 14px; }
  h1 { font-size: 24px; margin: 6px 0 14px; } h2 { font-size: 17px; margin: 0 0 8px; } h3 { font-size: 15px; margin: 14px 0 4px; }
  p, li { color: var(--texto-2); } ul { padding-left: 20px; margin: 6px 0; }
  dl { display: grid; grid-template-columns: 170px 1fr; gap: 6px 14px; margin: 8px 0 0; }
  dt { font-weight: 600; font-size: 13.5px; } dd { margin: 0; color: var(--texto-2); font-size: 14px; }
  @media (max-width: 600px) { dl { grid-template-columns: 1fr; } dt { margin-top: 6px; } }
  form { display: grid; gap: 12px; margin-top: 10px; }
  label { display: grid; gap: 4px; font-size: 13.5px; font-weight: 600; }
  input, select, textarea { font: inherit; padding: 10px 12px; border: 1px solid #ccd6e2; border-radius: 10px; width: 100%; }
  button { font: 600 15px/1 system-ui, sans-serif; background: var(--azul); color: #fff; border: 0; border-radius: 10px; padding: 13px 18px; cursor: pointer; }
  .escondido { position: absolute; left: -9999px; }
  .caixa { border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; }
  .ok { background: #e9f7e9; color: #0a5e3f; } .erro { background: #fdeded; color: #a52f2f; }
  .protocolo { font: 700 20px/1.3 ui-monospace, monospace; color: var(--texto); }
  small { color: var(--texto-2); }
</style>
</head>
<body>
<header><div class="dentro"><strong>PAY<span>AX</span></strong><p>Privacidade e proteção de dados</p></div></header>
<main>${corpo}</main>
</body>
</html>`;
}

function aviso(db, base, { mensagem = null, valores = {} } = {}) {
  const c = lgpd.controlador(db);
  const e = lgpd.encarregado(db);
  const contato = e.nome && e.email
    ? `<dl><dt>Encarregado</dt><dd>${esc(e.nome)}</dd><dt>E-mail</dt><dd><a href="mailto:${esc(e.email)}">${esc(e.email)}</a></dd>${e.telefone ? `<dt>Telefone</dt><dd>${esc(e.telefone)}</dd>` : ''}</dl>`
    : '<p>O encarregado está sendo designado. Enquanto isso, use o formulário abaixo: todo pedido recebe protocolo e é respondido no prazo da lei.</p>';
  const tipos = lgpd.DIREITOS.map(([k, t]) => `<option value="${k}"${valores.tipo === k ? ' selected' : ''}>${esc(t)}</option>`).join('');

  const corpo = `
<h1>Como a PAY AX trata os seus dados</h1>
${mensagem ? `<div class="caixa ${mensagem.tom}">${mensagem.html}</div>` : ''}
<section>
  <h2>Quem somos</h2>
  <dl><dt>Controladora</dt><dd>${esc(c.nome)}${c.documento ? ` — CNPJ ${esc(doc(c.documento))}` : ''}</dd>${c.endereco ? `<dt>Endereço</dt><dd>${esc(c.endereco)}</dd>` : ''}</dl>
  <h3>Encarregado pelo tratamento de dados pessoais (LGPD, art. 41)</h3>
  ${contato}
</section>
<section>
  <h2>Pagou um boleto emitido pela PAY AX?</h2>
  <p>A PAY AX processa cobranças para provedores de internet: o seu provedor emite o boleto pela PAY AX, o banco registra,
  e o valor pago vai para o provedor. Para isso tratamos os dados da cobrança — os mesmos que estão no boleto.
  <strong>Assuntos do seu contrato de internet (plano, valor, cancelamento) são com o seu provedor</strong>, cujo nome aparece no alto do boleto.</p>
</section>
${lgpd.INVENTARIO.map((x) => `
<section>
  <h2>${esc(x.titulo)}</h2>
  <dl>
    <dt>De quem</dt><dd>${esc(x.titulares)}</dd>
    <dt>Quais dados</dt><dd>${x.dados.map(esc).join('; ')}</dd>
    <dt>Para quê</dt><dd>${esc(x.finalidade)}</dd>
    <dt>Base legal</dt><dd>${esc(x.base_legal)}</dd>
    <dt>Com quem compartilhamos</dt><dd>${x.compartilhamento.map(esc).join('; ')}</dd>
    <dt>Por quanto tempo</dt><dd>${esc(x.retencao)}</dd>
  </dl>
</section>`).join('')}
<section>
  <h2>Segurança</h2>
  <p>Senhas guardadas só como resumo criptográfico; credenciais de acesso a bancos e sistemas cifradas; verificação em duas
  etapas para a equipe; registro de quem fez cada operação; cópias de segurança conferidas. Não usamos cookies de rastreamento
  nem publicidade: o navegador guarda só a sua sessão e preferências de tela.</p>
</section>
<section id="direitos">
  <h2>Os seus direitos (LGPD, art. 18)</h2>
  <ul>${lgpd.DIREITOS.map(([, t, art]) => `<li>${esc(t)} <small>(${esc(art)})</small></li>`).join('')}</ul>
  <p>O pedido é gratuito. Para proteger você, confirmamos a sua identidade antes de responder — por isso a resposta não sai na
  hora: a completa chega em até <strong>${lgpd.PRAZO_RESPOSTA_DIAS} dias</strong> (art. 19, II). Dados que a lei manda guardar
  (registros financeiros, por 5 anos) não podem ser apagados antes do prazo; nesse caso explicamos o motivo (art. 18, § 4º).
  Você também pode peticionar à Autoridade Nacional de Proteção de Dados — ANPD (art. 18, § 1º).</p>
  <form method="post" action="${esc(base)}/privacidade/pedido">
    <label>O que você quer<select name="tipo" required>${tipos}</select></label>
    <label>Seu nome<input name="nome" maxlength="120" required value="${esc(valores.nome)}"></label>
    <label>Seu CPF ou CNPJ<input name="documento" inputmode="numeric" maxlength="18" required value="${esc(valores.documento)}"></label>
    <label>Seu e-mail (é por ele que respondemos)<input name="email" type="email" maxlength="160" required value="${esc(valores.email)}"></label>
    <label>Detalhes (opcional)<textarea name="mensagem" rows="4" maxlength="2000">${esc(valores.mensagem)}</textarea></label>
    <label class="escondido" aria-hidden="true">Não preencha<input name="site" tabindex="-1" autocomplete="off"></label>
    <button type="submit">Enviar pedido</button>
  </form>
</section>
<p><small>Versão de ${VERSAO}. Este aviso descreve o que o sistema da PAY AX faz com os dados; quando isso mudar, ele muda junto.</small></p>`;
  return pagina({ titulo: 'Privacidade', corpo });
}

module.exports = (db) => {
  const r = express.Router();
  const limite = limitar({ janelaMs: 60_000, maximo: 5 });

  r.get('/privacidade', (req, res) => res.type('html').send(aviso(db, req.baseUrl)));

  r.post('/privacidade/pedido', limite, express.urlencoded({ extended: false, limit: '20kb' }), (req, res) => {
    const b = req.body ?? {};
    // Robô preenche o campo escondido: responde como se tivesse dado certo, sem gravar nada.
    if (b.site) return res.type('html').send(pagina({ titulo: 'Pedido recebido', corpo: '<h1>Pedido recebido</h1>' }));
    try {
      const p = lgpd.criarPedido(db, b, { ip: req.ip });
      const prazo = p.prazo.split('-').reverse().join('/');
      res.status(201).type('html').send(pagina({
        titulo: 'Pedido recebido',
        corpo: `<h1>Pedido recebido</h1>
<section><p>Anote o seu protocolo:</p><p class="protocolo">${esc(p.protocolo)}</p>
<p>Vamos confirmar a sua identidade pelo e-mail informado e responder até <strong>${esc(prazo)}</strong>.
Se precisar falar sobre o pedido, cite o protocolo.</p></section>
<p><a href="${esc(req.baseUrl)}/privacidade">Voltar ao aviso de privacidade</a></p>`,
      }));
    } catch (err) {
      res.status(err.status ?? 400).type('html').send(aviso(db, req.baseUrl, {
        mensagem: { tom: 'erro', html: `Não foi possível registrar o pedido: ${esc(err.message)}` },
        valores: { tipo: b.tipo, nome: b.nome, documento: b.documento, email: b.email, mensagem: b.mensagem },
      }));
    }
  });

  return r;
};
