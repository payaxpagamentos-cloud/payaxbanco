'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada } = require('../lib/http');
const { dataLocal } = require('../lib/datas');
const boleto = require('../lib/boleto');
const pix = require('../lib/pix');
const cob = require('../lib/cobrancas');
const cobranca = require('../lib/cobranca');
const bancos = require('../bancos');
const v = require('../lib/validacao');

const TAMANHO_RETORNO = 8 * 1024 * 1024;

/*
 * Cobrança bancária: contas, boletos, PIX, remessa e retorno.
 *
 * O retorno é a rota mais delicada daqui, e por isso é a única em dois passos: enviar o arquivo só LÊ e
 * guarda a prévia; aplicar é um segundo pedido, depois de o operador ver o que seria feito. Um layout com
 * posição errada vira valor sem sentido na prévia — nunca baixa errada no financeiro.
 */
module.exports = (db) => {
  const r = Router();
  const hoje = (req) => dataLocal(req.usuario.fuso);
  const conta = (req, id) => {
    const c = db.prepare('SELECT * FROM contas_cobranca WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!c) throw new ErroNegocio('Conta de cobrança não encontrada.', 404);
    return c;
  };

  // ---------------- Catálogo ----------------
  r.get('/bancos', exigir('faturamento.ver'), (req, res) => res.json({ bancos: boleto.bancos(), adaptadores: bancos.catalogo() }));

  // ---------------- Contas ----------------
  r.get('/contas', exigir('faturamento.ver'), (req, res) => {
    const itens = db.prepare('SELECT * FROM contas_cobranca WHERE organizacao_id = ? ORDER BY padrao DESC, nome').all(req.org);
    const emitidas = db.prepare("SELECT conta_id, COUNT(*) AS n FROM cobrancas WHERE organizacao_id = ? AND situacao IN ('emitida','registrada') GROUP BY conta_id").all(req.org);
    const mapa = new Map(emitidas.map((x) => [x.conta_id, x.n]));
    res.json(itens.map((c) => ({ ...c, em_aberto: mapa.get(c.id) ?? 0, banco_nome: boleto.BANCOS[boleto.zeros(c.banco ?? '', 3)]?.nome ?? null })));
  });

  function dadosConta(b, atual = {}) {
    const val = (k, f) => (b[k] !== undefined ? f(b[k]) : atual[k] ?? null);
    const d = {
      nome: val('nome', (x) => v.texto(x, 'o nome da conta', 80)),
      banco: val('banco', (x) => (x ? boleto.zeros(x, 3) : null)),
      agencia: val('agencia', (x) => v.opcional(x, 'a agência', 10)),
      agencia_dv: val('agencia_dv', (x) => v.opcional(x, 'o dígito da agência', 2)),
      conta: val('conta', (x) => v.opcional(x, 'a conta', 15)),
      conta_dv: val('conta_dv', (x) => v.opcional(x, 'o dígito da conta', 2)),
      carteira: val('carteira', (x) => v.opcional(x, 'a carteira', 5)),
      convenio: val('convenio', (x) => v.opcional(x, 'o convênio', 20)),
      codigo_beneficiario: val('codigo_beneficiario', (x) => v.opcional(x, 'o código do beneficiário', 20)),
      posto: val('posto', (x) => v.opcional(x, 'o posto', 5)),
      modalidade: val('modalidade', (x) => v.opcional(x, 'a modalidade', 5)),
      beneficiario_nome: val('beneficiario_nome', (x) => v.texto(x, 'o nome do beneficiário', 120)),
      beneficiario_documento: val('beneficiario_documento', (x) => {
        const t = v.digitos(x);
        v.exigir(v.cnpjValido(t) || v.cpfValido(t), 'CNPJ/CPF do beneficiário inválido.');
        return t;
      }),
      beneficiario_endereco: val('beneficiario_endereco', (x) => v.opcional(x, 'o endereço', 160)),
      beneficiario_cidade: val('beneficiario_cidade', (x) => v.opcional(x, 'a cidade', 60)),
      beneficiario_uf: val('beneficiario_uf', (x) => v.opcional(x, 'a UF', 2)),
      beneficiario_cep: val('beneficiario_cep', (x) => (x ? v.digitos(x) : null)),
      chave_pix: val('chave_pix', (x) => v.opcional(x, 'a chave PIX', 80)),
      chave_pix_tipo: val('chave_pix_tipo', (x) => (x ? v.opcao(x, 'o tipo da chave', ['cpf', 'cnpj', 'email', 'telefone', 'aleatoria']) : null)),
      emite_boleto: b.emite_boleto !== undefined ? (v.booleano(b.emite_boleto) ? 1 : 0) : atual.emite_boleto ?? 0,
      emite_pix: b.emite_pix !== undefined ? (v.booleano(b.emite_pix) ? 1 : 0) : atual.emite_pix ?? 1,
      ativa: b.ativa !== undefined ? (v.booleano(b.ativa) ? 1 : 0) : atual.ativa ?? 1,
      padrao: b.padrao !== undefined ? (v.booleano(b.padrao) ? 1 : 0) : atual.padrao ?? 0,
      observacoes: val('observacoes', (x) => v.opcional(x, 'as observações', 500)),
    };
    if (d.emite_pix) {
      v.exigir(d.chave_pix, 'Para emitir PIX, informe a chave da conta.');
      v.exigir(d.beneficiario_cidade, 'Para emitir PIX, informe a cidade do beneficiário (vai dentro do BR Code).');
    }
    if (d.emite_boleto) {
      v.exigir(d.banco, 'Para emitir boleto, informe o banco.');
      v.exigir(boleto.BANCOS[d.banco], `Ainda não há montagem de campo livre para o banco ${d.banco}. Bancos disponíveis: ${Object.keys(boleto.BANCOS).join(', ')}.`);
    }
    return d;
  }

  const colunas = ['nome', 'banco', 'agencia', 'agencia_dv', 'conta', 'conta_dv', 'carteira', 'convenio', 'codigo_beneficiario', 'posto', 'modalidade',
    'beneficiario_nome', 'beneficiario_documento', 'beneficiario_endereco', 'beneficiario_cidade', 'beneficiario_uf', 'beneficiario_cep',
    'chave_pix', 'chave_pix_tipo', 'emite_boleto', 'emite_pix', 'ativa', 'padrao', 'observacoes'];

  r.post('/contas', exigir('integracoes.editar'), (req, res) => {
    const d = dadosConta(req.body ?? {});
    const id = transacao(db, () => {
      if (d.padrao) db.prepare('UPDATE contas_cobranca SET padrao = 0 WHERE organizacao_id = ?').run(req.org);
      return Number(db.prepare(`INSERT INTO contas_cobranca (organizacao_id, ${colunas.join(', ')}, criado_por, criado_em)
        VALUES (?, ${colunas.map(() => '?').join(', ')}, ?, ?)`).run(req.org, ...colunas.map((k) => d[k]), req.usuario.id, agora()).lastInsertRowid);
    });
    registrar(db, req, 'conta_cobranca_criada', { recurso: 'conta_cobranca', recursoId: id, depois: d });
    res.status(201).json(db.prepare('SELECT * FROM contas_cobranca WHERE id = ?').get(id));
  });

  r.patch('/contas/:id', exigir('integracoes.editar'), (req, res) => {
    const atual = conta(req, req.params.id);
    const d = dadosConta(req.body ?? {}, atual);
    transacao(db, () => {
      if (d.padrao && !atual.padrao) db.prepare('UPDATE contas_cobranca SET padrao = 0 WHERE organizacao_id = ?').run(req.org);
      db.prepare(`UPDATE contas_cobranca SET ${colunas.map((k) => `${k} = ?`).join(', ')}, versao = versao + 1 WHERE id = ?`).run(...colunas.map((k) => d[k]), atual.id);
    });
    registrar(db, req, 'conta_cobranca_alterada', { recurso: 'conta_cobranca', recursoId: atual.id, antes: atual, depois: d });
    res.json(db.prepare('SELECT * FROM contas_cobranca WHERE id = ?').get(atual.id));
  });

  /** O provedor conferiu um boleto com o banco: o aviso de layout não validado para de aparecer. */
  r.post('/contas/:id/validar-layout', exigir('integracoes.editar'), (req, res) => {
    const c = conta(req, req.params.id);
    const confirmacao = v.texto(req.body?.confirmacao, 'a confirmação', 300);
    db.prepare('UPDATE contas_cobranca SET layout_validado = 1, layout_validado_em = ?, layout_validado_por = ?, versao = versao + 1 WHERE id = ?')
      .run(agora(), req.usuario.id, c.id);
    registrar(db, req, 'layout_boleto_validado', { recurso: 'conta_cobranca', recursoId: c.id, depois: { confirmacao } });
    res.json({ ...db.prepare('SELECT * FROM contas_cobranca WHERE id = ?').get(c.id), aviso: 'Layout marcado como conferido. O aviso de boleto não validado deixa de aparecer nesta conta.' });
  });

  // ---------------- Emissão ----------------
  r.post('/faturas/:id/emitir', exigir('faturamento.faturar'), (req, res) => {
    const fatura = db.prepare('SELECT * FROM faturas WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!fatura) throw new ErroNegocio('Fatura não encontrada.', 404);
    const tipo = v.opcao(req.body?.tipo ?? 'pix', 'o tipo', ['boleto', 'pix']);
    const c = cob.contaDe(db, req.org, req.body?.conta_id);
    const emitida = transacao(db, () => cob.emitir(db, { org: req.org, fatura, conta: c, tipo, usuarioId: req.usuario.id }));
    if (!emitida.ja_existia) registrar(db, req, 'cobranca_emitida', { recurso: 'fatura', recursoId: fatura.id, depois: { tipo, conta: c.nome, cobranca_id: emitida.id } });
    res.status(emitida.ja_existia ? 200 : 201).json({
      ...cob.publico(db, db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(emitida.id)),
      ja_existia: Boolean(emitida.ja_existia),
    });
  });

  r.get('/', exigir('faturamento.ver'), (req, res) => {
    const f = ['c.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.situacao) { f.push('c.situacao = ?'); p.push(String(req.query.situacao)); }
    if (req.query.tipo) { f.push('c.tipo = ?'); p.push(v.opcao(req.query.tipo, 'o tipo', ['boleto', 'pix'])); }
    if (req.query.fatura_id) { f.push('c.fatura_id = ?'); p.push(Number(req.query.fatura_id)); }
    const lista = listaPaginada(db, `SELECT c.*, fa.numero AS fatura_numero, a.nome AS assinante_nome, ct.nome AS conta_nome
      FROM cobrancas c JOIN faturas fa ON fa.id = c.fatura_id JOIN assinantes a ON a.id = fa.assinante_id
      JOIN contas_cobranca ct ON ct.id = c.conta_id WHERE ${f.join(' AND ')} ORDER BY c.id DESC`, p, req.query);
    lista.itens = lista.itens.map((x) => ({ ...x, linha_formatada: x.linha_digitavel ? boleto.formatarLinha(x.linha_digitavel) : null }));
    res.json(lista);
  });

  // ---------------- Remessa ----------------
  r.post('/remessas', exigir('faturamento.faturar'), (req, res) => {
    const c = conta(req, req.body?.conta_id ?? cob.contaDe(db, req.org).id);
    const gerada = cob.gerarRemessa(db, { org: req.org, conta: c, usuarioId: req.usuario.id });
    registrar(db, req, 'remessa_gerada', { recurso: 'remessa', recursoId: gerada.id, depois: { conta: c.nome, titulos: gerada.titulos, valor_centavos: gerada.valor_centavos } });
    res.status(201).json({
      ...gerada,
      conteudo: undefined,
      aviso: c.layout_validado
        ? null
        : 'O layout desta conta ainda não foi conferido com o banco. Envie este arquivo como teste e confirme a aceitação antes de usar a remessa na rotina.',
    });
  });

  r.get('/remessas', exigir('faturamento.ver'), (req, res) => {
    res.json(listaPaginada(db, `SELECT r.id, r.numero, r.layout, r.arquivo, r.titulos, r.valor_centavos, r.criado_em, c.nome AS conta_nome, u.nome AS criado_por_nome
      FROM remessas r JOIN contas_cobranca c ON c.id = r.conta_id LEFT JOIN usuarios u ON u.id = r.criado_por
      WHERE r.organizacao_id = ? ORDER BY r.id DESC`, [req.org], req.query));
  });

  r.get('/remessas/:id/arquivo', exigir('faturamento.ver'), (req, res) => {
    const x = db.prepare('SELECT * FROM remessas WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!x) throw new ErroNegocio('Remessa não encontrada.', 404);
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${x.arquivo}"` }).send(x.conteudo);
  });

  // ---------------- Retorno ----------------
  /** Passo 1: lê o arquivo e guarda a prévia. Nada é aplicado aqui. */
  r.post('/retornos', exigir('faturamento.baixar'), (req, res) => {
    const conteudo = typeof req.body === 'string' ? req.body : '';
    v.exigir(conteudo.trim(), 'Envie o arquivo de retorno do banco.');
    v.exigir(conteudo.length <= TAMANHO_RETORNO, 'Arquivo de retorno grande demais.');
    const nome = v.opcional(decodeURIComponent(req.get('x-nome-arquivo') ?? ''), 'o nome do arquivo', 120) ?? 'retorno.ret';
    const previa = cob.conferirRetorno(db, req.org, conteudo);
    const contaId = req.query.conta_id ? Number(req.query.conta_id) : (db.prepare('SELECT id FROM contas_cobranca WHERE organizacao_id = ? AND banco = ? ORDER BY padrao DESC LIMIT 1').get(req.org, previa.banco)?.id ?? null);
    const id = Number(db.prepare(`INSERT INTO retornos (organizacao_id, conta_id, arquivo, layout, banco, registros, pagamentos, valor_centavos,
      nao_encontrados, conteudo, resumo, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.org, contaId, nome, previa.layout, previa.banco, previa.registros, previa.pagamentos, previa.valor_centavos,
        previa.nao_encontrados, conteudo, JSON.stringify({ gerado_em: previa.gerado_em, a_aplicar: previa.a_aplicar, com_divergencia: previa.com_divergencia }), req.usuario.id, agora()).lastInsertRowid);
    registrar(db, req, 'retorno_recebido', { recurso: 'retorno', recursoId: id, depois: { arquivo: nome, layout: previa.layout, registros: previa.registros, a_aplicar: previa.a_aplicar } });
    res.status(201).json({ id, ...previa, situacao: 'conferindo',
      aviso: 'Nada foi aplicado ainda. Confira a prévia — principalmente os valores — e só então mande aplicar.' });
  });

  r.get('/retornos', exigir('faturamento.ver'), (req, res) => {
    res.json(listaPaginada(db, `SELECT r.id, r.arquivo, r.layout, r.banco, r.registros, r.pagamentos, r.valor_centavos, r.aplicados, r.nao_encontrados,
      r.situacao, r.criado_em, r.aplicado_em, c.nome AS conta_nome, u.nome AS criado_por_nome FROM retornos r
      LEFT JOIN contas_cobranca c ON c.id = r.conta_id LEFT JOIN usuarios u ON u.id = r.criado_por
      WHERE r.organizacao_id = ? ORDER BY r.id DESC`, [req.org], req.query));
  });

  r.get('/retornos/:id', exigir('faturamento.ver'), (req, res) => {
    const x = db.prepare('SELECT * FROM retornos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!x) throw new ErroNegocio('Retorno não encontrado.', 404);
    res.json({ ...x, conteudo: undefined, ...cob.conferirRetorno(db, req.org, x.conteudo) });
  });

  /** Passo 2: aplica o que a prévia mostrou. */
  r.post('/retornos/:id/aplicar', exigir('faturamento.baixar'), (req, res) => {
    const x = db.prepare('SELECT * FROM retornos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!x) throw new ErroNegocio('Retorno não encontrado.', 404);
    if (x.situacao !== 'conferindo') throw new ErroNegocio(`Este retorno já foi ${x.situacao === 'aplicado' ? 'aplicado' : 'descartado'}.`, 422);
    const d = hoje(req);
    const previa = cob.conferirRetorno(db, req.org, x.conteudo);
    const resultado = transacao(db, () => {
      const r2 = cob.aplicarRetorno(db, { org: req.org, previa, retornoId: x.id, hoje: d, usuarioId: req.usuario.id,
        // Quitar pelo retorno religa o serviço igual a uma baixa feita à mão: é o mesmo fato.
        aoQuitar: (contratoId) => {
          const contrato = db.prepare('SELECT * FROM contratos WHERE id = ?').get(contratoId);
          if (contrato) cobranca.aoQuitar(db, { contrato, hoje: d, usuarioId: req.usuario.id });
        } });
      db.prepare("UPDATE retornos SET situacao = 'aplicado', aplicados = ?, aplicado_em = ?, aplicado_por = ?, resumo = ? WHERE id = ?")
        .run(r2.baixados, agora(), req.usuario.id, JSON.stringify(r2), x.id);
      return r2;
    });
    registrar(db, req, 'retorno_aplicado', { recurso: 'retorno', recursoId: x.id, depois: resultado });
    res.json({ ...resultado, aviso: `${resultado.baixados} fatura(s) baixada(s)${resultado.erros.length ? `; ${resultado.erros.length} com erro` : ''}.` });
  });

  r.post('/retornos/:id/descartar', exigir('faturamento.baixar'), (req, res) => {
    const x = db.prepare("SELECT * FROM retornos WHERE id = ? AND organizacao_id = ? AND situacao = 'conferindo'").get(Number(req.params.id), req.org);
    if (!x) throw new ErroNegocio('Retorno não encontrado ou já tratado.', 404);
    const motivo = v.texto(req.body?.motivo, 'o motivo', 300);
    db.prepare("UPDATE retornos SET situacao = 'descartado', resumo = ? WHERE id = ?").run(JSON.stringify({ motivo }), x.id);
    registrar(db, req, 'retorno_descartado', { recurso: 'retorno', recursoId: x.id, depois: { motivo } });
    res.json({ id: x.id, situacao: 'descartado' });
  });

  // ---------------- Painel ----------------
  r.get('/resumo', exigir('faturamento.ver'), (req, res) => {
    const d = hoje(req);
    const porSituacao = db.prepare('SELECT situacao, tipo, COUNT(*) AS n, COALESCE(SUM(valor_centavos), 0) AS v FROM cobrancas WHERE organizacao_id = ? GROUP BY situacao, tipo').all(req.org);
    res.json({
      hoje: d,
      contas: db.prepare('SELECT COUNT(*) AS n FROM contas_cobranca WHERE organizacao_id = ? AND ativa = 1').get(req.org).n,
      contas_sem_layout_validado: db.prepare('SELECT COUNT(*) AS n FROM contas_cobranca WHERE organizacao_id = ? AND ativa = 1 AND emite_boleto = 1 AND layout_validado = 0').get(req.org).n,
      por_situacao: porSituacao,
      aguardando_remessa: db.prepare("SELECT COUNT(*) AS n FROM cobrancas WHERE organizacao_id = ? AND tipo = 'boleto' AND situacao = 'emitida' AND remessa_id IS NULL").get(req.org).n,
      retornos_conferindo: db.prepare("SELECT COUNT(*) AS n FROM retornos WHERE organizacao_id = ? AND situacao = 'conferindo'").get(req.org).n,
      prazo_medio_dias: cob.prazoMedioRecebimento(db, req.org),
      // Faturas em aberto que ainda não têm meio de pagamento emitido: é o que o assinante não consegue pagar.
      sem_cobranca: db.prepare(`SELECT COUNT(*) AS n FROM faturas f WHERE f.organizacao_id = ? AND f.situacao IN ('aberta','parcial')
        AND NOT EXISTS (SELECT 1 FROM cobrancas c WHERE c.fatura_id = f.id AND c.situacao IN ('emitida','registrada'))`).get(req.org).n,
    });
  });

  /** Confere um BR Code colado pelo operador (útil quando o assinante manda o comprovante). */
  r.post('/pix/conferir', exigir('faturamento.ver'), (req, res) => {
    const codigo = v.texto(req.body?.codigo, 'o código PIX', 1000);
    res.json(pix.ler(codigo));
  });

  return r;
};
