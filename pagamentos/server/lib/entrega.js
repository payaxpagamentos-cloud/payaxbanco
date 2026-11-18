'use strict';

/*
 * Entrega do boleto emitido pela PAY AX para uma fatura do sistema de gestão do cliente (IXC).
 *
 * O sistema do cliente continua gerando a fatura e cobrando; o boleto (registrado no convênio da PAY AX, com
 * a PAY AX como beneficiário e o cliente como beneficiário final) é o da PAY AX. Este módulo faz o boleto
 * chegar a quem precisa, sem ninguém da PAY AX enviar nada à mão:
 *
 *   1. LINK ....... grava o link do PDF no campo "Link gateway" do título (para o atendimento abrir o boleto);
 *   2. PDF ........ anexa o PDF nos arquivos do cliente (ou da fatura) dentro do sistema dele;
 *   3. E-MAIL ..... manda o PDF anexado pelo servidor de e-mail do próprio cliente.
 *
 * E acompanha a fatura: se ela for cancelada, recebida por outro meio ou alterada lá, o boleto é baixado no
 * banco (e, se mudou valor ou vencimento, outro é emitido no lugar), para ninguém pagar um boleto que não vale.
 *
 * Cada passo é opcional (configuração do sistema do cliente) e nenhum derruba os outros: o que falhar fica
 * anotado no boleto e a rotina tenta de novo, até 5 vezes.
 */
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const datas = require('./datas');
const consultas = require('./consultas');
const boletos = require('./boletos');
const boletoPdf = require('./boletoPdf');
const linkBoleto = require('./linkBoleto');
const email = require('./email');
const sincronismo = require('./sincronismo');
const { paraCentavos, paraData } = require('./ixc');

const MAX_TENTATIVAS = 5;
const hoje = () => datas.dataLocal(config.fusoPadrao);
const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBr = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');

/** O que está ligado na configuração do cliente. */
function opcoes(cfg = {}) {
  return {
    link: cfg.gravar_link === true,
    pdf: ['cliente', 'titulo'].includes(cfg.anexar_pdf) ? cfg.anexar_pdf : null,
    email: cfg.email?.ativo === true,
    acompanhar: cfg.acompanhar !== false,
    desde: cfg.entrega_desde ?? null,
  };
}
const algumaEntrega = (o) => o.link || Boolean(o.pdf) || o.email;

const descricaoArquivo = (b) => `Boleto PAY AX - venc. ${dataBr(b.vencimento)} - R$ ${brl(b.valor_centavos)}${b.seu_numero ? ` - doc. ${b.seu_numero}` : ''}`;

/**
 * Faz os passos de entrega que faltam para um boleto. `forcar` refaz os que já foram feitos (botão da tela).
 * Devolve o que aconteceu em cada passo; nunca lança erro por falha de um passo.
 */
async function entregarBoleto(db, boletoId, { forcar = false } = {}) {
  const d = consultas.boletoCompleto(db, boletoId);
  if (!d) throw new ErroNegocio('Boleto não encontrado.', 404);
  const b = d.boleto;
  if (b.origem !== 'ixc' || !b.ixc_receber_id) return { ignorado: true, motivo: 'o boleto não veio do sistema do cliente' };
  const ixc = sincronismo.ixcDoCliente(db, b.cliente_id);
  if (!ixc) return { ignorado: true, motivo: 'sistema do cliente não configurado' };
  const o = opcoes(ixc.config);
  const passos = [];
  const erros = [];
  const marca = (coluna) => db.prepare(`UPDATE boletos SET ${coluna} = ? WHERE id = ?`).run(agora(), b.id);
  const aberto = ['registrando', 'registrado'].includes(b.situacao);

  // 1. Link do PDF no título (já na emissão: o link sempre mostra a situação do momento).
  if (o.link && aberto && (forcar || !b.ixc_link_em)) {
    try {
      const link = linkBoleto.url(b, { pdf: true });
      if (!link) throw new Error('o sistema não sabe o próprio endereço público (PAYAX_URL_PUBLICA)');
      const r = await ixc.cliente.gravarLink(b.ixc_receber_id, link);
      if (r.mudou.length) {
        // A edição completa mexeu em campo que não devia: para de gravar link neste cliente e avisa.
        const alerta = `Gravar o link mudou outros campos do título ${b.ixc_receber_id} (${r.mudou.map((m) => `${m.campo}: ${m.antes} → ${m.depois}`).join('; ')}). A gravação do link foi desligada em ${agora().slice(0, 10)}: confira o título no sistema do cliente.`;
        db.prepare('UPDATE integracoes SET config = ? WHERE id = ?').run(JSON.stringify({ ...ixc.config, gravar_link: false, entrega_alerta: alerta }), ixc.integracao.id);
        throw new Error(`o IXC alterou outros campos do título ao gravar o link (${r.mudou.map((m) => m.campo).join(', ')}): a gravação do link foi desligada e precisa de conferência`);
      }
      if (!r.gravado) throw new Error('o IXC aceitou a alteração, mas não guardou o link no título');
      marca('ixc_link_em');
      passos.push({ passo: 'link', ok: true, detalhe: link });
    } catch (err) {
      erros.push(`link: ${err.message}`);
      passos.push({ passo: 'link', ok: false, detalhe: err.message });
    }
  }

  // 2 e 3 só com o boleto confirmado pelo banco: um arquivo ou e-mail "em registro" ficaria velho para sempre.
  if (b.situacao === 'registrado') {
    if (o.pdf && (forcar || !b.ixc_pdf_em)) {
      try {
        if (o.pdf === 'cliente' && !b.ixc_cliente_id) throw new Error('o boleto não guarda o código do cliente no IXC');
        const pdf = await boletoPdf.gerar({ ...d, hoje: hoje() });
        await ixc.cliente.anexarArquivo({ onde: o.pdf, clienteId: b.ixc_cliente_id, tituloId: b.ixc_receber_id,
          descricao: descricaoArquivo(b), nome: boletoPdf.nomeArquivo(b), conteudo: pdf });
        marca('ixc_pdf_em');
        passos.push({ passo: 'pdf', ok: true, detalhe: o.pdf === 'titulo' ? 'anexado na fatura' : 'anexado nos arquivos do cliente' });
      } catch (err) {
        erros.push(`PDF: ${err.message}`);
        passos.push({ passo: 'pdf', ok: false, detalhe: err.message });
      }
    }
    if (o.email && (forcar || !b.email_enviado_em)) {
      if (!b.pagador_email) passos.push({ passo: 'email', ok: false, detalhe: 'o pagador não tem e-mail no cadastro', definitivo: true });
      else {
        try {
          const r = await email.enviarBoleto(db, { ...d, cfg: ixc.config.email, senha: ixc.segredos?.smtp_senha, hoje: hoje() });
          marca('email_enviado_em');
          passos.push({ passo: 'email', ok: true, detalhe: r.para });
        } catch (err) {
          erros.push(`e-mail: ${err.message}`);
          passos.push({ passo: 'email', ok: false, detalhe: err.message });
        }
      }
    }
  }

  if (erros.length) db.prepare('UPDATE boletos SET entrega_erro = ?, entrega_tentativas = entrega_tentativas + 1 WHERE id = ?').run(erros.join(' · ').slice(0, 500), b.id);
  else if (passos.some((p) => p.ok)) db.prepare('UPDATE boletos SET entrega_erro = NULL WHERE id = ?').run(b.id);
  return { boleto_id: b.id, passos };
}

/** Clientes com o sistema de gestão configurado e ativo. */
function clientesComIxc(db) {
  return db.prepare(`SELECT c.* FROM clientes c JOIN integracoes i ON i.cliente_id = c.id AND i.escopo = 'ixc'
    WHERE c.situacao = 'ativo' AND i.estado <> 'desabilitada' AND i.credenciais IS NOT NULL`).all();
}

/** Rotina: entrega o que está pendente (link, PDF, e-mail) dos boletos em aberto. */
async function entregarPendentes(db, { limite = 200 } = {}) {
  const out = { tentados: 0, ok: 0, falhas: 0 };
  for (const c of clientesComIxc(db)) {
    const ixc = sincronismo.ixcDoCliente(db, c.id);
    const o = ixc ? opcoes(ixc.config) : null;
    if (!o || !algumaEntrega(o)) continue;
    const falta = [
      o.link ? 'ixc_link_em IS NULL' : null,
      o.pdf ? "(situacao = 'registrado' AND ixc_pdf_em IS NULL)" : null,
      o.email ? "(situacao = 'registrado' AND email_enviado_em IS NULL AND pagador_email IS NOT NULL AND pagador_email <> '')" : null,
    ].filter(Boolean).join(' OR ');
    // Só boletos emitidos depois de a entrega ser ligada: ligar o e-mail não dispara mensagem para a carteira antiga inteira.
    const pendentes = db.prepare(`SELECT id FROM boletos WHERE cliente_id = ? AND origem = 'ixc' AND ixc_receber_id IS NOT NULL
        AND situacao IN ('registrando','registrado') AND substituido_em IS NULL AND entrega_tentativas < ?
        AND criado_em >= ? AND (${falta}) ORDER BY id LIMIT ?`).all(c.id, MAX_TENTATIVAS, o.desde ?? '9999', limite - out.tentados);
    for (const p of pendentes) {
      out.tentados += 1;
      try {
        const r = await entregarBoleto(db, p.id);
        if ((r.passos ?? []).some((x) => !x.ok && !x.definitivo)) out.falhas += 1; else out.ok += 1;
      } catch { out.falhas += 1; }
    }
    if (out.tentados >= limite) break;
  }
  return out;
}

/**
 * Rotina: confere, no sistema do cliente, as faturas dos boletos em aberto.
 *   - cancelada lá, recebida por outro meio ou movida para outra carteira → pede a baixa do boleto no banco;
 *   - valor ou vencimento alterados (quando é a PAY AX que monta o boleto) → baixa e emite outro no lugar.
 * Fatura que o IXC não devolveu NÃO baixa nada: pode ser falha passageira da consulta.
 */
async function acompanhar(db, { limitePorCliente = 200 } = {}) {
  const out = { conferidos: 0, baixados: 0, reemitidos: 0, avisos: [] };
  for (const c of clientesComIxc(db)) {
    const ixc = sincronismo.ixcDoCliente(db, c.id);
    if (!ixc || !opcoes(ixc.config).acompanhar) continue;
    const carteiras = (ixc.config.carteiras ?? []).map(String);
    const abertos = db.prepare(`SELECT * FROM boletos WHERE cliente_id = ? AND origem = 'ixc' AND ixc_receber_id IS NOT NULL
        AND situacao IN ('registrando','registrado') AND substituido_em IS NULL
        ORDER BY ixc_conferido_em IS NOT NULL, ixc_conferido_em, id LIMIT ?`).all(c.id, limitePorCliente);
    const ctx = { resultado: { lidos: 0, criados: 0, ignorados: 0, erros: 0, detalhes: [] }, cacheClientes: new Map(), carteiras };
    for (const b of abertos) {
      let t;
      try { t = await ixc.cliente.tituloBruto(b.ixc_receber_id); } catch (err) { out.avisos.push({ cliente_id: c.id, erro: err.message }); break; }
      db.prepare('UPDATE boletos SET ixc_conferido_em = ? WHERE id = ?').run(agora(), b.id);
      out.conferidos += 1;
      if (!t) { out.avisos.push({ boleto_id: b.id, aviso: `o IXC não devolveu a fatura ${b.ixc_receber_id}: nada foi baixado, confira` }); continue; }
      const status = String(t.status ?? '');
      const carteira = String(t.id_carteira_cobranca ?? '');
      const valor = paraCentavos(t.valor);
      const vencimento = paraData(t.data_vencimento);
      let motivo = null;
      let reemitir = false;
      if (status === 'C') motivo = 'Fatura cancelada no sistema do cliente';
      else if (status === 'R') motivo = 'Fatura recebida por outro meio no sistema do cliente';
      else if (carteiras.length && carteira && !carteiras.includes(carteira)) motivo = 'Fatura movida para outra carteira no sistema do cliente';
      else if (ixc.config.numeracao !== 'ixc' && valor > 0 && vencimento && (valor !== b.valor_centavos || vencimento !== b.vencimento)) {
        motivo = `Fatura alterada no sistema do cliente (era R$ ${brl(b.valor_centavos)} para ${dataBr(b.vencimento)})`;
        reemitir = true;
      }
      if (!motivo) continue;
      try {
        await boletos.baixar(db, b.id, motivo);
        out.baixados += 1;
        if (reemitir) {
          // O antigo sai do caminho (o título pode ganhar outro boleto) e o novo é emitido já com o valor e a data novos.
          db.prepare('UPDATE boletos SET substituido_em = ? WHERE id = ?').run(agora(), b.id);
          const antes = ctx.resultado.criados;
          await sincronismo.emitirParaTitulo(db, c, ixc, { ixc_id: String(t.id), ixc_cliente_id: String(t.id_cliente ?? ''), documento: String(t.documento ?? ''),
            valor_centavos: valor, vencimento, status, carteira, bruto: t }, ctx);
          if (ctx.resultado.criados > antes) out.reemitidos += 1;
          else out.avisos.push({ boleto_id: b.id, aviso: `a fatura ${b.ixc_receber_id} mudou e o boleto antigo foi baixado, mas o novo não foi emitido: ${ctx.resultado.detalhes.at(-1)?.erro ?? 'confira a importação'}` });
        }
      } catch (err) {
        out.avisos.push({ boleto_id: b.id, erro: err.message });
      }
    }
  }
  return out;
}

/** PDF de uma página só, para testar o envio de arquivo sem depender de um boleto. */
async function pdfDeTeste() {
  const PDFDocument = require('pdfkit');
  const pdf = new PDFDocument({ size: 'A4', margin: 50 });
  const partes = [];
  pdf.on('data', (x) => partes.push(x));
  const pronto = new Promise((r) => pdf.on('end', () => r(Buffer.concat(partes))));
  pdf.fontSize(16).text('Arquivo de teste da PAY AX').moveDown().fontSize(11)
    .text('Este arquivo foi enviado só para testar o anexo no sistema de gestão. Pode ser apagado.');
  pdf.end();
  return pronto;
}

/**
 * Diagnóstico da ligação com o IXC, num título escolhido (use um título de TESTE): diz, passo a passo, o que
 * o IXC deste cliente aceita. Só grava o que for pedido.
 */
async function diagnosticar(db, clienteId, { titulo_id, gravar_nosso_numero = false, gravar_link = false, anexar_cliente = false, anexar_titulo = false } = {}) {
  const ixc = sincronismo.ixcDoCliente(db, clienteId);
  if (!ixc) throw new ErroNegocio('O sistema deste cliente ainda não foi configurado.', 409);
  const id = String(titulo_id ?? '').replace(/\D/g, '');
  if (!id) throw new ErroNegocio('Informe o número (ID) do título de teste no sistema do cliente.', 422);
  const passos = [];
  const passo = async (nome, fazer) => {
    try { passos.push({ passo: nome, ok: true, ...(await fazer()) }); } catch (err) { passos.push({ passo: nome, ok: false, detalhe: err.message }); }
  };

  let titulo = null;
  await passo('Ler o título', async () => {
    titulo = await ixc.cliente.tituloBruto(id);
    if (!titulo) throw new Error('título não encontrado (confira o ID e a permissão do usuário do token)');
    const campos = ['status', 'valor', 'valor_aberto', 'data_vencimento', 'id_carteira_cobranca', 'id_cliente', 'id_contrato', 'filial_id', 'id_conta',
      'liberado', 'tipo_recebimento', 'nn_boleto', 'linha_digitavel', 'gateway_link', 'titulo_importado', 'pix_txid'];
    return { detalhe: `situação ${titulo.status}, R$ ${titulo.valor}, vencimento ${titulo.data_vencimento}, carteira ${titulo.id_carteira_cobranca}`,
      dados: Object.fromEntries(campos.map((k) => [k, titulo[k] ?? null])) };
  });
  if (!titulo) return { passos };

  await passo('Ler a carteira de cobrança', async () => {
    const r = await ixc.cliente.carteiraBruta(titulo.id_carteira_cobranca);
    if (!r) throw new Error('carteira não encontrada (o usuário do token pode não ter permissão em Carteira de cobrança)');
    const campos = ['descricao', 'tipo_recebimento', 'id_conta', 'gateway_nome', 'importado_gateway', 'gateway_tipo_impressao', 'imprimir_beneficiario_gateway',
      'imp_nome_beneficiario', 'imprimir_filial_conta', 'layout_impressao', 'contador_nn'];
    const configuradas = (ixc.config.carteiras ?? []).map(String);
    return { detalhe: `"${r.descricao ?? ''}", tipo ${r.tipo_recebimento ?? '?'}, conta ${r.id_conta ?? '?'}${r.gateway_nome ? `, gateway ${r.gateway_nome}` : ''}${r.importado_gateway ? `, importado gateway = ${r.importado_gateway}` : ''}`
      + (configuradas.length && !configuradas.includes(String(titulo.id_carteira_cobranca)) ? ' — ATENÇÃO: esta carteira não é a configurada para este cliente na PAY AX' : ''),
    dados: Object.fromEntries(campos.map((k) => [k, r[k] ?? null])) };
  });

  const boleto = db.prepare("SELECT * FROM boletos WHERE cliente_id = ? AND ixc_receber_id = ? AND situacao NOT IN ('cancelado','falha') AND substituido_em IS NULL ORDER BY id DESC LIMIT 1").get(clienteId, id);
  passos.push({ passo: 'Boleto PAY AX deste título', ok: Boolean(boleto), detalhe: boleto
    ? `boleto ${boleto.id}, nosso número ${boleto.nosso_numero}-${boleto.nosso_numero_dv}, situação ${boleto.situacao}`
    : 'ainda não há boleto PAY AX para este título (importe antes); os testes de gravação usam dados de teste' });

  if (gravar_nosso_numero) {
    await passo('Gravar o nosso número (Alterar boleto)', async () => {
      const nn = boleto ? `${boleto.nosso_numero}-${boleto.nosso_numero_dv}` : String(titulo.nn_boleto || '');
      if (!nn) throw new Error('sem boleto PAY AX e sem nosso número no título: nada para gravar');
      await ixc.cliente.anotarBoleto(id, { nosso_numero: nn });
      const d = await ixc.cliente.tituloBruto(id);
      if (String(d?.liberado ?? '') === 'N') throw new Error('a fatura ficou oculta (liberado = N) depois da alteração: avise a PAY AX antes de continuar');
      if (String(d?.nn_boleto ?? '') !== nn) throw new Error(`o IXC respondeu "alterado", mas o nosso número lido é "${d?.nn_boleto ?? ''}"`);
      return { detalhe: `gravado e conferido: ${nn}` };
    });
  }

  if (gravar_link) {
    await passo('Gravar o link no campo "Link gateway" (edição completa)', async () => {
      const link = boleto ? linkBoleto.url(boleto, { pdf: true }) : `${config.urlPublica || 'https://payax.com.br'}/teste-de-link`;
      if (!link) throw new Error('o sistema não sabe o próprio endereço público (PAYAX_URL_PUBLICA)');
      const r = await ixc.cliente.gravarLink(id, link);
      if (r.mudou.length) throw new Error(`o link ${r.gravado ? 'foi' : 'NÃO foi'} gravado e OUTROS CAMPOS MUDARAM: ${r.mudou.map((m) => `${m.campo}: "${m.antes}" → "${m.depois}"`).join('; ')}. Não ligue a gravação de link e corrija o título no IXC.`);
      if (!r.gravado) throw new Error(`o IXC aceitou a alteração, mas o link lido depois é "${r.link_lido}"`);
      return { detalhe: `gravado e conferido, sem mudar valor, vencimento nem situação: ${link}` };
    });
  }

  const anexar = async (onde) => {
    const pdf = boleto ? await boletoPdf.gerar({ ...consultas.boletoCompleto(db, boleto.id), hoje: hoje() }) : await pdfDeTeste();
    const r = await ixc.cliente.anexarArquivo({ onde, clienteId: titulo.id_cliente, tituloId: id,
      descricao: boleto ? descricaoArquivo(boleto) : 'Teste de anexo PAY AX (pode apagar)', nome: boleto ? boletoPdf.nomeArquivo(boleto) : 'teste-payax.pdf', conteudo: pdf });
    return { detalhe: `arquivo aceito${r.id ? ` (registro ${r.id})` : ''}: confira na tela do IXC` };
  };
  if (anexar_cliente) await passo('Anexar o PDF nos arquivos do cliente', () => anexar('cliente'));
  if (anexar_titulo) await passo('Anexar o PDF nos arquivos da fatura', () => anexar('titulo'));

  return { passos };
}

module.exports = { entregarBoleto, entregarPendentes, acompanhar, diagnosticar, opcoes, algumaEntrega, MAX_TENTATIVAS };
