'use strict';

const { transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const { daEmpresa } = require('./acesso');
const docs = require('./documentos');
const lanc = require('./lancamentos');
const v = require('./validacao');
const { somarDias } = require('./datas');

/**
 * Leitura do XML da NF-e (modelo 55, layout 4.00), com ou sem o protocolo de autorização (nfeProc).
 * Só lê os campos usados no financeiro; não consulta a SEFAZ.
 */
function tag(xml, nome) {
  const m = new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`).exec(xml);
  return m ? m[1].trim() : null;
}
const todas = (xml, nome) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`, 'g'))].map((m) => m[1]);
const texto = (s) => (s == null ? null : s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
const centavos = (s) => Math.round(Number(s) * 100);

function participante(bloco) {
  if (!bloco) return null;
  return { documento: tag(bloco, 'CNPJ') || tag(bloco, 'CPF'), nome: texto(tag(bloco, 'xNome')), fantasia: texto(tag(bloco, 'xFant')) };
}

function lerNfe(xml) {
  const s = String(xml ?? '');
  const inf = /<(?:\w+:)?infNFe[^>]*Id="NFe(\d{44})"/.exec(s);
  if (!inf) throw new ErroNegocio('Arquivo não é o XML de uma NF-e (falta a chave de acesso).', 422);
  const ide = tag(s, 'ide') ?? '';
  const total = tag(s, 'ICMSTot') ?? '';
  const emissao = (tag(ide, 'dhEmi') || tag(ide, 'dEmi') || '').slice(0, 10);
  const valor = centavos(tag(total, 'vNF'));
  if (!v.dataValida(emissao) || !(valor > 0)) throw new ErroNegocio('NF-e sem data de emissão ou valor total.', 422);
  const duplicatas = todas(tag(s, 'cobr') ?? '', 'dup').map((d) => ({
    numero: tag(d, 'nDup'), vencimento: tag(d, 'dVenc'), valor_centavos: centavos(tag(d, 'vDup')),
  })).filter((d) => v.dataValida(d.vencimento) && d.valor_centavos > 0);
  return {
    chave: inf[1],
    numero: tag(ide, 'nNF'),
    serie: tag(ide, 'serie'),
    emissao,
    natureza: texto(tag(ide, 'natOp')),
    emitente: participante(tag(s, 'emit')),
    destinatario: participante(tag(s, 'dest')),
    valor_centavos: valor,
    autorizada: /<(?:\w+:)?cStat>100<\//.test(s),
    duplicatas,
  };
}

/**
 * Lança a NF-e no financeiro da empresa. Destinatária → contas a pagar ao emitente; emitente →
 * contas a receber do destinatário. Uma conta por duplicata (ou uma só, com vencimento informado ou
 * em 30 dias). O fornecedor/cliente é criado se não existir e o XML fica anexado.
 * Com `previa`, só devolve o que seria lançado.
 */
function importar(db, req, empresa, corpo) {
  const nota = lerNfe(corpo.conteudo);
  const cnpj = empresa.cnpj;
  let tipo, outro;
  if (v.digitos(nota.destinatario?.documento) === cnpj) { tipo = 'pagar'; outro = nota.emitente; }
  else if (v.digitos(nota.emitente?.documento) === cnpj) { tipo = 'receber'; outro = nota.destinatario; }
  else throw new ErroNegocio('Esta NF-e não é desta empresa: o CNPJ não aparece como emitente nem como destinatário.', 422);
  const ja = db.prepare("SELECT id FROM lancamentos WHERE empresa_id = ? AND chave_nfe = ? AND status <> 'cancelado' LIMIT 1").get(empresa.id, nota.chave);
  const parcelas = nota.duplicatas.length ? nota.duplicatas
    : [{ numero: null, vencimento: corpo.vencimento || somarDias(nota.emissao, 30), valor_centavos: nota.valor_centavos }];
  const contato = outro?.documento && db.prepare('SELECT id, nome FROM contatos WHERE empresa_id = ? AND documento = ?').get(empresa.id, v.digitos(outro.documento));
  const previa = { ...nota, tipo, contato: outro, contato_existente: contato ?? null, ja_lancada: ja?.id ?? null, parcelas };
  if (corpo.previa) return previa;

  if (ja) throw new ErroNegocio(`Esta NF-e já foi lançada (lançamento #${ja.id}).`, 409);
  if (!nota.autorizada && !corpo.aceitar_sem_protocolo) {
    throw new ErroNegocio('O XML não traz o protocolo de autorização da SEFAZ (cStat 100). Confirme para lançar mesmo assim.', 422, { sem_protocolo: true });
  }
  const categoria = daEmpresa(db, 'categorias', v.id(corpo.categoria_id), empresa.id, 'Categoria');
  v.exigir(categoria, 'Escolha a categoria.');
  return transacao(db, () => {
    let contatoId = contato?.id;
    if (!contatoId && outro?.nome) {
      contatoId = Number(db.prepare('INSERT INTO contatos (empresa_id, tipo, nome, documento) VALUES (?, ?, ?, ?)')
        .run(empresa.id, tipo === 'pagar' ? 'fornecedor' : 'cliente', (outro.fantasia || outro.nome).slice(0, 160), v.digitos(outro.documento) || null).lastInsertRowid);
    }
    const doc = `NF ${nota.numero}${nota.serie ? `/${nota.serie}` : ''}`;
    const ids = parcelas.map((p, i) => {
      const [id] = lanc.criar(db, req, empresa.id, {
        tipo, descricao: `${doc} — ${(outro?.fantasia || outro?.nome || '').slice(0, 120)}${parcelas.length > 1 ? ` (${i + 1}/${parcelas.length})` : ''}`,
        valor_centavos: p.valor_centavos, vencimento: p.vencimento, competencia: nota.emissao, categoria_id: categoria.id, contato_id: contatoId ?? null,
        centro_custo_id: v.id(corpo.centro_custo_id), conta_bancaria_id: v.id(corpo.conta_bancaria_id), documento: p.numero ? `${doc} dup ${p.numero}` : doc,
        observacoes: `Importada da NF-e ${nota.chave}.`,
      });
      db.prepare('UPDATE lancamentos SET chave_nfe = ? WHERE id = ?').run(nota.chave, id);
      return id;
    });
    docs.salvar(db, empresa.id, Buffer.from(corpo.conteudo, 'utf8'), { nome: `NFe${nota.chave}.xml`, tipo: 'nota', lancamento_id: ids[0], descricao: doc },
      { usuario_id: req.usuario?.id, responsavel_id: req.responsavel?.id });
    return { ids, tipo, chave: nota.chave, contato_id: contatoId ?? null };
  });
}

module.exports = { lerNfe, importar };
