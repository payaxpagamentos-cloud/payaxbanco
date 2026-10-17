'use strict';

const email = require('./email');
const cob = require('./cobranca');
const rel = require('./relatorios');
const { resumoEmpresa } = require('./resumo');
const { cabe } = require('./aprovacao');
const { ErroNegocio } = require('./erros');
const { hoje, diferencaDias, fimMes } = require('./datas');

const reais = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (d) => d.split('-').reverse().join('/');
const nomeEmpresa = (e) => e.nome_fantasia || e.razao_social;
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1).replace('.', ',')}%`);

/** Pagamento conferido pela equipe: avisa os responsáveis da empresa que podem aprová-lo pelo Portal. */
async function avisarAprovacao(db, empresaId, lancamentoId) {
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId);
  const l = db.prepare('SELECT l.*, c.nome AS contato_nome FROM lancamentos l LEFT JOIN contatos c ON c.id = l.contato_id WHERE l.id = ?').get(lancamentoId);
  if (!e || !l) return [];
  const aprovadores = db.prepare(`SELECT * FROM responsaveis WHERE empresa_id = ? AND acesso_portal = 1 AND pode_aprovar = 1 AND ativo = 1
    AND email IS NOT NULL`).all(empresaId).filter((r) => cabe(r.limite_aprovacao_centavos, l.valor_centavos));
  return Promise.all(aprovadores.map((r) => email.enviar(db, {
    para: r.email, tipo: 'aprovacao', empresaId, referencia: String(l.id),
    assunto: `Pagamento aguardando sua aprovação — ${reais(l.valor_centavos)}`,
    titulo: 'Pagamento aguardando sua aprovação',
    linhas: [`Olá, ${r.nome}. A equipe Ativa conferiu um pagamento de ${nomeEmpresa(e)} que precisa da sua autorização.`],
    tabela: [['Pagamento', l.descricao], ['Fornecedor', l.contato_nome ?? '—'], ['Valor', reais(l.valor_centavos)], ['Vencimento', br(l.vencimento)]],
    botao: { texto: 'Aprovar no Portal do Cliente', url: email.linkPortal() },
  })));
}

/** Envia ao responsável o endereço do Portal e a senha provisória (que ele troca no primeiro acesso). */
function enviarAcessoPortal(db, responsavel, senha) {
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(responsavel.empresa_id);
  return email.enviar(db, {
    para: responsavel.email, tipo: 'acesso_portal', empresaId: e.id, referencia: String(responsavel.id),
    assunto: `Seu acesso ao Portal do Cliente — ${nomeEmpresa(e)}`,
    titulo: 'Seu acesso ao Portal do Cliente',
    linhas: [`Olá, ${responsavel.nome}. Pelo Portal você acompanha o financeiro de ${nomeEmpresa(e)}, aprova pagamentos, envia documentos e conversa com a equipe Ativa.`,
      'No primeiro acesso, o Portal pede para você criar uma senha só sua.'],
    tabela: [['E-mail de acesso', responsavel.email], ['Senha provisória', senha]],
    botao: { texto: 'Acessar o Portal', url: email.linkPortal() },
  }, { exigir: true });
}

/** Envia por e-mail o lembrete de um título a receber e registra no histórico de cobrança. */
async function enviarLembrete(db, req, empresa, lancamentoId) {
  const item = cob.lembretes(db, empresa, 30).find((x) => x.id === Number(lancamentoId));
  if (!item) throw new ErroNegocio('Título não encontrado entre os vencidos ou a vencer em 30 dias.', 404);
  if (!item.email) throw new ErroNegocio('O cliente não tem e-mail no cadastro.', 422);
  const r = await email.enviar(db, {
    para: item.email, tipo: 'lembrete', empresaId: empresa.id, referencia: String(item.id),
    assunto: item.atraso > 0 ? `Pagamento em aberto — ${nomeEmpresa(empresa)}` : `Lembrete de vencimento — ${nomeEmpresa(empresa)}`,
    titulo: item.atraso > 0 ? 'Pagamento em aberto' : 'Lembrete de vencimento',
    linhas: [item.texto],
    tabela: [['Referência', item.descricao], ['Valor', reais(item.valor_centavos)], ['Vencimento', br(item.vencimento)], ...(item.documento ? [['Documento', item.documento]] : [])],
    rodape: `Enviado em nome de ${nomeEmpresa(empresa)} pela Ativa BPO Financeiro.`,
  }, { exigir: true });
  db.prepare("INSERT INTO cobranca_registros (empresa_id, contato_id, lancamento_id, canal, descricao, usuario_id) VALUES (?, ?, ?, 'lembrete', ?, ?)")
    .run(empresa.id, item.contato_id, item.id, `Lembrete enviado por e-mail para ${item.email}.`, req?.usuario?.id ?? null);
  return r;
}

/**
 * Lembretes automáticos (uma vez por dia, para empresas com a opção ligada): N dias antes do
 * vencimento, no dia, e com 1, 7, 15 e 30 dias de atraso. Cada título recebe no máximo um por dia.
 */
async function lembretesAutomaticos(db, dia = hoje()) {
  if (!email.configurado()) return { enviados: 0 };
  let enviados = 0;
  for (const e of db.prepare("SELECT * FROM empresas WHERE lembrete_auto = 1 AND status IN ('ativa','implantacao')").all()) {
    const marcos = new Set([-e.lembrete_dias_antes, 0, 1, 7, 15, 30]);
    const titulos = cob.lembretes(db, e, e.lembrete_dias_antes).filter((t) => t.email && marcos.has(diferencaDias(dia, t.vencimento)));
    for (const t of titulos) {
      const ja = db.prepare("SELECT 1 FROM cobranca_registros WHERE lancamento_id = ? AND canal = 'lembrete' AND date(criado_em, '-3 hours') = ?").get(t.id, dia);
      if (ja) continue;
      try { await enviarLembrete(db, null, e, t.id); enviados++; } catch { /* falha fica registrada na tabela emails */ }
    }
  }
  return { enviados };
}

/** Relatório do mês para os responsáveis que recebem relatórios; conclui a etapa "envio" do fechamento. */
async function enviarRelatorioMes(db, req, empresa, mes) {
  const de = `${mes}-01`;
  const ate = fimMes(de);
  const d = rel.dre(db, empresa.id, { de, ate });
  const linha = (rot) => d.linhas.find((l) => l.rotulo === rot)?.total ?? 0;
  const r = resumoEmpresa(db, empresa.id);
  const destinos = db.prepare('SELECT * FROM responsaveis WHERE empresa_id = ? AND recebe_relatorios = 1 AND ativo = 1 AND email IS NOT NULL').all(empresa.id);
  if (!destinos.length) throw new ErroNegocio('Nenhum responsável com e-mail marcado para receber relatórios (Contrato e responsáveis).', 422);
  const [ano, m] = mes.split('-');
  const nomeMes = new Date(Date.UTC(Number(ano), Number(m) - 1, 1)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const resultados = [];
  for (const p of destinos) {
    resultados.push(await email.enviar(db, {
      para: p.email, tipo: 'relatorio', empresaId: empresa.id, referencia: mes,
      assunto: `Relatório financeiro de ${nomeMes} — ${nomeEmpresa(empresa)}`,
      titulo: `Relatório financeiro de ${nomeMes}`,
      linhas: [`Olá, ${p.nome}. Segue o resumo do fechamento de ${nomeMes} de ${nomeEmpresa(empresa)}. O detalhe por categoria está no Portal, em Relatórios.`],
      tabela: [
        ['Receita bruta', reais(linha('Receita bruta'))], ['Lucro bruto', reais(linha('Lucro bruto'))], ['Resultado operacional', reais(linha('Resultado operacional'))],
        ['Lucro líquido', reais(linha('Lucro líquido'))], ['Margem líquida', pct(d.indicadores.margem_liquida)], ['Saldo atual em contas', reais(r.saldo_total_centavos)],
        ['A receber vencido', reais(r.receber.vencidos.total_centavos)], ['A pagar nos próximos 7 dias', reais(r.pagar.hoje.total_centavos + r.pagar.semana.total_centavos)],
      ],
      botao: { texto: 'Ver no Portal do Cliente', url: email.linkPortal() },
    }, { exigir: true }));
  }
  const nomes = destinos.map((p) => p.email).join(', ');
  db.prepare(`INSERT INTO fechamentos (empresa_id, mes, etapa, usuario_id, observacao) VALUES (?, ?, 'envio', ?, ?)
    ON CONFLICT (empresa_id, mes, etapa) DO UPDATE SET usuario_id = excluded.usuario_id, observacao = excluded.observacao, concluido_em = datetime('now')`)
    .run(empresa.id, mes, req.usuario.id, `Relatório enviado por e-mail para ${nomes}.`.slice(0, 500));
  return { enviados: resultados.filter((x) => x.enviado).length, destinatarios: destinos.map((p) => p.email) };
}

module.exports = { avisarAprovacao, enviarAcessoPortal, enviarLembrete, lembretesAutomaticos, enviarRelatorioMes };
