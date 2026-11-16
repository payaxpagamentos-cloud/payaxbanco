'use strict';

/*
 * Abertura de conta — CRM: do pedido feito no site (payax.com.br → "Abra sua conta") ou do contato
 * cadastrado pela equipe até a conta aberta, passando pelas etapas do funil, pela análise cadastral
 * (checklist) e pela proposta comercial (tarifas e limites), que é aplicada no cliente ao aprovar.
 *
 * O pedido NÃO vira cliente sozinho. Ele entra como "nova" e a equipe confere o contrato social e os
 * responsáveis — conheça seu cliente (Lei 9.613/1998, art. 10, I e § 1º) — antes de aprovar. Aprovado, o
 * cliente é criado "em implantação" com os mesmos dados e as mesmas regras do cadastro feito pela equipe
 * (conta e chave PIX da própria empresa) e o responsável financeiro ganha o acesso à Área do Cliente.
 *
 * Documentos: PDF, JPEG ou PNG conferidos pelo conteúdo (não só pelo nome), até 8 MB cada, guardados fora da
 * pasta pública, com o resumo SHA-256 para provar que não mudaram.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');
const ativacao = require('./ativacao');
const sms = require('./sms');
const contaInterna = require('./contaInterna');
const precos = require('./precos');
const datas = require('./datas');

const MAX_BYTES = 8 * 1024 * 1024;
const TIPOS_DOCUMENTO = {
  contrato_social: { rotulo: 'Contrato social (ou última alteração consolidada)', obrigatorio: true },
  documento_responsavel: { rotulo: 'Documento do responsável legal (RG ou CNH)', obrigatorio: false },
};
const FORMATOS = {
  'application/pdf': { ext: 'pdf', confere: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/png': { ext: 'png', confere: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', confere: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
};

const protocolo = (id) => `AB-${String(id).padStart(6, '0')}`;
const so = (x) => String(x ?? '').replace(/\D/g, '');

/** Lê um documento enviado como data URI (data:application/pdf;base64,...). */
function lerDocumento(entrada, tipo) {
  const def = TIPOS_DOCUMENTO[tipo];
  if (!entrada?.conteudo) {
    if (def.obrigatorio) throw new ErroNegocio(`Anexe o ${def.rotulo.toLowerCase()}.`, 422);
    return null;
  }
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(entrada.conteudo));
  const formato = m && FORMATOS[m[1]];
  if (!formato) throw new ErroNegocio(`${def.rotulo}: envie em PDF, JPG ou PNG.`, 422);
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_BYTES) throw new ErroNegocio(`${def.rotulo}: o arquivo passa de 8 MB.`, 422);
  if (!formato.confere(bytes)) throw new ErroNegocio(`${def.rotulo}: o arquivo não é um ${formato.ext.toUpperCase()} válido.`, 422);
  const nome = String(entrada.nome ?? `${tipo}.${formato.ext}`).replace(/[^\w.\- ]+/g, '_').slice(-80) || `${tipo}.${formato.ext}`;
  return { tipo, nome, mime: m[1], ext: formato.ext, bytes };
}

const pessoaDe = (x, quem, { cpf = false } = {}) => ({
  nome: v.texto(x?.nome, `o nome do ${quem}`, 120),
  ...(cpf ? { cpf: v.documento(x?.cpf, `o CPF do ${quem}`) } : {}),
  cargo: cpf ? v.opcional(x?.cargo, `o cargo do ${quem}`, 60) : undefined,
  email: v.email(x?.email),
  telefone: v.telefone(x?.telefone),
});

// ------------------------------------------------------------------ funil e análise
/** Etapas em aberto, na ordem do funil. */
const ETAPAS = [
  ['prospeccao', 'Prospecção'],
  ['nova', 'Novo pedido'],
  ['em_analise', 'Análise cadastral'],
  ['proposta', 'Proposta comercial'],
  ['aguardando_cliente', 'Aguardando o cliente'],
];
const ABERTAS = ETAPAS.map(([k]) => k);
const ROTULO = { ...Object.fromEntries(ETAPAS), aprovada: 'Conta aberta', recusada: 'Recusada' };

/** O que a equipe confere antes de aprovar (conheça seu cliente — Lei 9.613/1998, art. 10). */
const CHECKLIST = [
  ['receita_ativa', 'CNPJ ativo na Receita Federal'],
  ['contrato_conferido', 'Contrato social conferido'],
  ['representante_confere', 'Responsável legal consta no contrato social'],
  ['socios_identificados', 'Sócios e beneficiários finais identificados'],
  ['conta_confere', 'Conta bancária e chave PIX em nome da empresa'],
  ['atividade_compativel', 'Atividade e volume esperado compatíveis com a empresa'],
];
const TIPOS_INTERACAO = ['nota', 'ligacao', 'email', 'whatsapp', 'reuniao'];
const SISTEMAS = ['nenhum', 'ixc', 'outro'];

const hoje = () => datas.dataLocal(config.fusoPadrao);
const texto = (x, max = 160) => String(x ?? '').trim().slice(0, max);
const json = (x, padrao) => { try { return x ? JSON.parse(x) : padrao; } catch { return padrao; } };

/** Os dados do pedido como vieram (cada campo limpo e com tamanho limitado): é o que a equipe edita. */
function normalizar(b = {}) {
  const pega = (o, campos, max) => Object.fromEntries(campos.map((c) => [c, texto(o?.[c], max)]));
  return {
    empresa: pega(b.empresa, ['cnpj', 'razao_social', 'nome_fantasia', 'email', 'telefone', 'cep', 'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf'], 160),
    representante: pega(b.representante, ['nome', 'cpf', 'cargo', 'email', 'telefone'], 160),
    financeiro: pega(b.financeiro, ['nome', 'email', 'telefone'], 160),
    destino: pega(b.destino, ['banco', 'ispb', 'tipo', 'agencia', 'agencia_dv', 'conta', 'conta_dv', 'pix_tipo', 'pix_chave'], 80),
  };
}

/**
 * Valida os dados completos. `validarCadastro` é a mesma validação do cadastro de cliente da equipe
 * (routes/clientes.js): o que passa aqui, passa na aprovação.
 */
function validarDados(dados, validarCadastro, extra = {}) {
  const e = dados.empresa ?? {};
  const destino = dados.destino ?? {};
  if (!e.email) throw new ErroNegocio('Informe o e-mail da empresa.', 422);
  if (!destino.banco || !destino.agencia || !destino.conta) throw new ErroNegocio('Informe a conta bancária da empresa (banco, agência e conta).', 422);
  if (!destino.pix_chave) throw new ErroNegocio('Informe a chave PIX da empresa.', 422);
  const empresa = validarCadastro({
    razao_social: e.razao_social, cnpj: e.cnpj, nome_fantasia: e.nome_fantasia, email: e.email, telefone: e.telefone,
    cep: e.cep, endereco: e.endereco, numero: e.numero, complemento: e.complemento, bairro: e.bairro, cidade: e.cidade, uf: e.uf,
    // Conta bancária E chave PIX, as duas da própria empresa (mesmo CNPJ): as duas são obrigatórias.
    destino_banco: destino.banco, destino_ispb: destino.ispb || undefined, destino_agencia: destino.agencia,
    destino_agencia_dv: destino.agencia_dv, destino_conta: destino.conta, destino_conta_dv: destino.conta_dv,
    destino_tipo: destino.tipo || undefined, destino_titular: e.razao_social,
    pix_chave: destino.pix_chave, pix_tipo: destino.pix_tipo || undefined,
    ...extra,
  });
  const representante = pessoaDe(dados.representante, 'responsável legal da empresa', { cpf: true });
  if (so(representante.cpf).length !== 11) throw new ErroNegocio('O responsável legal precisa ser pessoa física (CPF).', 422);
  const financeiro = pessoaDe(dados.financeiro, 'responsável financeiro');
  // O protocolo e os avisos da abertura vão por SMS para o responsável financeiro: precisa ser celular.
  if (!sms.celular(financeiro.telefone)) throw new ErroNegocio('Informe o celular do responsável financeiro, com DDD: é para ele que vai o SMS com o protocolo.', 422);
  return { empresa, representante, financeiro };
}

function pasta(id) {
  const p = path.join(config.arquivos, 'abertura', String(id));
  fs.mkdirSync(p, { recursive: true, mode: 0o750 });
  return p;
}

/** Grava os documentos no disco e devolve a lista para a coluna `arquivos` (somada à que já existe). */
function guardarDocumentos(id, documentos, existentes = []) {
  const dir = pasta(id);
  return [...existentes, ...documentos.map((d, i) => {
    const nome = `${existentes.length + i + 1}-${d.tipo}-${Date.now().toString(36)}.${d.ext}`;
    fs.writeFileSync(path.join(dir, nome), d.bytes, { mode: 0o640 });
    return { tipo: d.tipo, nome_original: d.nome, mime: d.mime, tamanho: d.bytes.length,
      sha256: crypto.createHash('sha256').update(d.bytes).digest('hex'), arquivo: nome, enviado_em: agora() };
  })];
}

function registrar(db, id, tipo, textoInteracao, usuarioId = null) {
  db.prepare('INSERT INTO abertura_interacoes (solicitacao_id, tipo, texto, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(id, tipo, textoInteracao, usuarioId, agora());
  db.prepare('UPDATE solicitacoes_abertura SET atualizado_em = ? WHERE id = ?').run(agora(), id);
}

function semDuplicata(db, cnpj, idAtual = null) {
  if (db.prepare('SELECT 1 FROM clientes WHERE cnpj = ?').get(cnpj)) {
    throw new ErroNegocio('Esta empresa já é cliente PAY AX. Fale com o seu gerente de conta para o acesso.', 409);
  }
  if (db.prepare(`SELECT 1 FROM solicitacoes_abertura WHERE cnpj = ? AND situacao IN (${ABERTAS.map(() => '?').join(',')}) AND id IS NOT ?`)
    .get(cnpj, ...ABERTAS, idAtual)) {
    throw new ErroNegocio('Já existe um pedido de abertura em andamento para este CNPJ. A equipe PAY AX vai entrar em contato.', 409);
  }
}

/** Registra o pedido vindo do site. Devolve o protocolo. */
function solicitar(db, body, { ip, validarCadastro }) {
  if (body?.site) throw new ErroNegocio('Pedido recusado.', 400); // campo isca: só robô preenche
  if (!body?.aceite) throw new ErroNegocio('Confirme que leu o aviso de privacidade e que os dados são verdadeiros.', 422);
  const dados = normalizar(body);
  const { empresa } = validarDados(dados, validarCadastro);
  semDuplicata(db, empresa.cnpj);
  const documentos = Object.keys(TIPOS_DOCUMENTO).map((t) => lerDocumento(body.documentos?.[t], t)).filter(Boolean);
  dados.empresa.cnpj = empresa.cnpj;

  const id = db.prepare(`INSERT INTO solicitacoes_abertura (cnpj, razao_social, dados, ip, criado_em, atualizado_em, origem)
    VALUES (?, ?, ?, ?, ?, ?, 'site') RETURNING id`)
    .get(empresa.cnpj, empresa.razao_social, JSON.stringify(dados), ip ?? null, agora(), agora()).id;
  try {
    db.prepare('UPDATE solicitacoes_abertura SET arquivos = ? WHERE id = ?').run(JSON.stringify(guardarDocumentos(id, documentos)), id);
  } catch (err) {
    db.prepare('DELETE FROM solicitacoes_abertura WHERE id = ?').run(id);
    throw err;
  }
  registrar(db, id, 'sistema', 'Pedido recebido pelo site (Abra sua conta).');
  return { id, protocolo: protocolo(id) };
}

/** Contato cadastrado pela equipe (prospecção): basta CNPJ e razão social; o resto se completa depois. */
function criarContato(db, b, usuario) {
  const dados = normalizar(b);
  const cnpj = v.cnpj(dados.empresa.cnpj);
  const razao = v.texto(dados.empresa.razao_social, 'a razão social', 120);
  if (dados.empresa.email) v.email(dados.empresa.email);
  dados.empresa.cnpj = cnpj;
  semDuplicata(db, cnpj);
  const id = db.prepare(`INSERT INTO solicitacoes_abertura (situacao, origem, cnpj, razao_social, dados, criado_em, atualizado_em, responsavel_id)
    VALUES ('prospeccao', 'equipe', ?, ?, ?, ?, ?, ?) RETURNING id`).get(cnpj, razao, JSON.stringify(dados), agora(), agora(), usuario.id).id;
  registrar(db, id, 'sistema', `Contato cadastrado pela equipe por ${usuario.nome}.`, usuario.id);
  const obs = texto(b.observacao, 1000);
  if (obs) registrar(db, id, 'nota', obs, usuario.id);
  return buscar(db, id);
}

/**
 * SMS com o número do protocolo para o celular do responsável financeiro. Não falha a operação: o resultado
 * entra no histórico do pedido (e a equipe pode reenviar pela ficha).
 */
async function avisarProtocolo(db, id, usuario = null) {
  const s = buscar(db, id);
  const d = json(s.dados, {});
  const nome = String(d.empresa?.nome_fantasia || s.razao_social).slice(0, 40);
  const r = await sms.enviar(db, {
    telefone: d.financeiro?.telefone,
    texto: `PAY AX: recebemos o pedido de abertura de conta de ${nome}. Protocolo ${protocolo(s.id)}. Nossa equipe vai analisar e entrar em contato.`,
    finalidade: 'abertura.protocolo', referenciaTipo: 'abertura', referenciaId: s.id,
  });
  registrar(db, s.id, 'sistema', r.situacao === 'enviado'
    ? `SMS com o protocolo enviado para ${r.destino_mascarado}${usuario ? ` (reenviado por ${usuario.nome})` : ''}.`
    : `SMS com o protocolo não enviado: ${r.erro}.`, usuario?.id ?? null);
  return r;
}

// ------------------------------------------------------------------ leitura
function buscar(db, id) {
  const s = db.prepare(`SELECT s.*, u.nome AS analisado_por_nome, r.nome AS responsavel_nome FROM solicitacoes_abertura s
    LEFT JOIN usuarios u ON u.id = s.analisado_por LEFT JOIN usuarios r ON r.id = s.responsavel_id WHERE s.id = ?`).get(Number(id));
  if (!s) throw naoEncontrado('Pedido de abertura');
  return s;
}

const aberta = (s) => ABERTAS.includes(s.situacao);
function exigirAberta(s) {
  if (!aberta(s)) throw new ErroNegocio(`Este pedido já foi concluído (${ROTULO[s.situacao]}).`, 409);
}

/** O que ainda falta para aprovar. Vazio = pode aprovar. */
function pendencias(s, validarCadastro) {
  const lista = [];
  const dados = json(s.dados, {});
  try { validarDados(normalizar(dados), validarCadastro); } catch (err) { lista.push(`Cadastro: ${err.message}`); }
  if (!json(s.arquivos, []).some((a) => a.tipo === 'contrato_social')) lista.push('Contrato social não anexado.');
  const marcados = json(s.checklist, {});
  const faltam = CHECKLIST.filter(([k]) => !marcados[k]);
  if (faltam.length) lista.push(`Análise: falta conferir ${faltam.length} item(ns) do checklist.`);
  if (!s.proposta) lista.push('Proposta comercial (tarifas e limites) não definida.');
  return lista;
}

/** Pedido no formato da tela (sem caminho de arquivo). */
function formatar(s, { validarCadastro = null } = {}) {
  const marcados = json(s.checklist, {});
  return {
    id: s.id, protocolo: protocolo(s.id), situacao: s.situacao, etapa: ROTULO[s.situacao] ?? s.situacao, origem: s.origem ?? 'site',
    cnpj: s.cnpj, razao_social: s.razao_social, criado_em: s.criado_em, atualizado_em: s.atualizado_em ?? s.criado_em,
    responsavel_id: s.responsavel_id ?? null, responsavel_nome: s.responsavel_nome ?? null,
    analisado_em: s.analisado_em, analisado_por_nome: s.analisado_por_nome ?? null, motivo: s.motivo, cliente_id: s.cliente_id,
    ...normalizar(json(s.dados, {})),
    checklist: CHECKLIST.map(([chave, rotulo]) => ({ chave, rotulo, feito: Boolean(marcados[chave]), por: marcados[chave]?.por ?? null, em: marcados[chave]?.em ?? null })),
    proposta: json(s.proposta, null),
    pendencias: validarCadastro && aberta(s) ? pendencias(s, validarCadastro) : undefined,
    arquivos: json(s.arquivos, []).map((a, i) => ({ indice: i, tipo: a.tipo, rotulo: TIPOS_DOCUMENTO[a.tipo]?.rotulo ?? a.tipo,
      nome: a.nome_original, mime: a.mime, tamanho: a.tamanho, sha256: a.sha256, enviado_em: a.enviado_em ?? s.criado_em })),
  };
}

function interacoes(db, id) {
  return db.prepare(`SELECT i.id, i.tipo, i.texto, i.criado_em, u.nome AS usuario_nome FROM abertura_interacoes i
    LEFT JOIN usuarios u ON u.id = i.usuario_id WHERE i.solicitacao_id = ? ORDER BY i.id DESC`).all(Number(id));
}

function arquivo(db, id, indice) {
  const s = buscar(db, id);
  const a = json(s.arquivos, [])[Number(indice)];
  if (!a) throw naoEncontrado('Documento');
  const caminho = path.join(config.arquivos, 'abertura', String(s.id), path.basename(a.arquivo));
  if (!fs.existsSync(caminho)) throw new ErroNegocio('O documento não está mais guardado (prazo de guarda vencido).', 410);
  return { caminho, nome: a.nome_original, mime: a.mime };
}

// ------------------------------------------------------------------ ações da equipe
/** Corrige ou completa os dados (CNPJ e razão social sempre obrigatórios; o resto é cobrado ao aprovar). */
function editarDados(db, id, b, usuario) {
  const s = buscar(db, id);
  exigirAberta(s);
  const dados = normalizar(b);
  const cnpj = v.cnpj(dados.empresa.cnpj);
  const razao = v.texto(dados.empresa.razao_social, 'a razão social', 120);
  if (cnpj !== s.cnpj) semDuplicata(db, cnpj, s.id);
  dados.empresa.cnpj = cnpj;
  db.prepare('UPDATE solicitacoes_abertura SET cnpj = ?, razao_social = ?, dados = ? WHERE id = ?').run(cnpj, razao, JSON.stringify(dados), s.id);
  registrar(db, s.id, 'sistema', `Dados do cadastro atualizados por ${usuario.nome}.`, usuario.id);
  return buscar(db, id);
}

function anexar(db, id, b, usuario) {
  const s = buscar(db, id);
  exigirAberta(s);
  const tipo = v.opcao(b?.tipo, 'o tipo do documento', Object.keys(TIPOS_DOCUMENTO));
  const doc = lerDocumento({ nome: b?.nome, conteudo: b?.conteudo ?? '' }, tipo);
  if (!doc) throw new ErroNegocio('Escolha o arquivo.', 422);
  const lista = guardarDocumentos(s.id, [doc], json(s.arquivos, []));
  db.prepare('UPDATE solicitacoes_abertura SET arquivos = ? WHERE id = ?').run(JSON.stringify(lista), s.id);
  registrar(db, s.id, 'sistema', `${TIPOS_DOCUMENTO[tipo].rotulo} anexado por ${usuario.nome} (${doc.nome}).`, usuario.id);
  return buscar(db, id);
}

function mover(db, id, etapa, usuario) {
  const s = buscar(db, id);
  exigirAberta(s);
  const nova = v.opcao(etapa, 'a etapa', ABERTAS);
  if (nova === s.situacao) return s;
  db.prepare('UPDATE solicitacoes_abertura SET situacao = ?, responsavel_id = IFNULL(responsavel_id, ?) WHERE id = ?').run(nova, usuario.id, s.id);
  registrar(db, s.id, 'sistema', `Etapa: ${ROTULO[s.situacao]} → ${ROTULO[nova]} (${usuario.nome}).`, usuario.id);
  return buscar(db, id);
}

function atribuir(db, id, usuarioId, usuario) {
  const s = buscar(db, id);
  exigirAberta(s);
  const alvo = db.prepare('SELECT id, nome FROM usuarios WHERE id = ? AND ativo = 1').get(Number(usuarioId));
  if (!alvo) throw new ErroNegocio('Usuário não encontrado ou inativo.', 422);
  db.prepare('UPDATE solicitacoes_abertura SET responsavel_id = ? WHERE id = ?').run(alvo.id, s.id);
  registrar(db, s.id, 'sistema', `Responsável: ${alvo.nome} (definido por ${usuario.nome}).`, usuario.id);
  return buscar(db, id);
}

function interagir(db, id, b, usuario) {
  const s = buscar(db, id);
  const tipo = v.opcao(b?.tipo || 'nota', 'o tipo do contato', TIPOS_INTERACAO);
  const t = v.texto(b?.texto, 'o texto', 2000);
  registrar(db, s.id, tipo, t, usuario.id);
  return interacoes(db, s.id);
}

function marcar(db, id, chave, feito, usuario) {
  const s = buscar(db, id);
  exigirAberta(s);
  const item = CHECKLIST.find(([k]) => k === chave);
  if (!item) throw new ErroNegocio('Item do checklist desconhecido.', 422);
  const marcados = json(s.checklist, {});
  if (feito) marcados[chave] = { por: usuario.nome, em: agora() };
  else delete marcados[chave];
  db.prepare('UPDATE solicitacoes_abertura SET checklist = ? WHERE id = ?').run(JSON.stringify(marcados), s.id);
  registrar(db, s.id, 'sistema', `${feito ? 'Conferido' : 'Desmarcado'}: ${item[1]} (${usuario.nome}).`, usuario.id);
  return buscar(db, id);
}

/**
 * Proposta comercial: a tabela de preços (as mesmas regras da tela de preços), os limites e as condições.
 * É o que vale para o cliente quando a conta for aberta.
 */
function definirProposta(db, id, b, usuario) {
  const s = buscar(db, id);
  exigirAberta(s);
  const preco = precos.validarPreco(b);
  const limiteBoleto = v.centavos(b.limite_boleto, 'o limite por boleto');
  if (limiteBoleto <= 0) throw new ErroNegocio('O limite por boleto precisa ser maior que zero.', 422);
  const limiteMensal = v.centavosOpcional(b.limite_mensal, 'o limite mensal de emissão') || null;
  if (limiteMensal !== null && limiteMensal < limiteBoleto) throw new ErroNegocio('O limite mensal não pode ser menor que o limite por boleto.', 422);
  const proposta = {
    preco,
    limite_boleto_centavos: limiteBoleto,
    limite_mensal_centavos: limiteMensal,
    entrega: v.opcao(b.entrega || 'padrao', 'como o cliente recebe', ['padrao', 'pix']),
    faturamento_mensal_centavos: v.centavosOpcional(b.faturamento_mensal, 'o faturamento mensal') || null,
    boletos_mes: b.boletos_mes === undefined || b.boletos_mes === '' ? null : v.inteiro(String(b.boletos_mes).replace(/\D/g, ''), 'a quantidade de boletos por mês', { min: 0, max: 10_000_000 }),
    sistema: v.opcao(b.sistema || 'nenhum', 'o sistema de gestão', SISTEMAS),
    observacao: v.opcional(b.observacao_proposta, 'a observação da proposta', 500),
    definida_por: usuario.nome,
    definida_em: agora(),
  };
  db.prepare('UPDATE solicitacoes_abertura SET proposta = ? WHERE id = ?').run(JSON.stringify(proposta), s.id);
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  registrar(db, s.id, 'sistema', `Proposta definida por ${usuario.nome}: ${precos.tarifaTexto(preco)}; limite por boleto ${brl(limiteBoleto)}`
    + `${limiteMensal ? `; limite mensal ${brl(limiteMensal)}` : ''}.`, usuario.id);
  return buscar(db, id);
}

/**
 * Aprova: cria o cliente "em implantação" com os dados do pedido, a proposta (tabela de preços, limites e
 * forma de recebimento), o responsável legal no conheça seu cliente e o acesso do responsável financeiro
 * (administrador da Área do Cliente). Devolve a senha provisória, mostrada uma vez só.
 */
function aprovar(db, id, usuario, { validarCadastro }) {
  const s = buscar(db, id);
  exigirAberta(s);
  const falta = pendencias(s, validarCadastro);
  if (falta.length) throw new ErroNegocio(`Ainda não dá para aprovar: ${falta.join(' ')}`, 422, { pendencias: falta });
  const dados = normalizar(json(s.dados, {}));
  const proposta = json(s.proposta, null);
  const { empresa: d, representante, financeiro: fin } = validarDados(dados, validarCadastro, { situacao: 'implantacao' });
  if (db.prepare('SELECT 1 FROM clientes WHERE cnpj = ?').get(d.cnpj)) throw new ErroNegocio('Já existe um cliente com este CNPJ.', 409);
  const emailEmUso = db.prepare('SELECT 1 FROM usuarios_cliente WHERE email = ?').get(fin.email);

  return transacao(db, () => {
    d.responsavel = fin.nome;
    d.limite_boleto_centavos = proposta.limite_boleto_centavos;
    d.limite_mensal_centavos = proposta.limite_mensal_centavos;
    d.entrega = proposta.entrega;
    d.observacoes = `Conta aberta pelo CRM (pedido ${protocolo(s.id)}, origem: ${s.origem === 'equipe' ? 'equipe' : 'site'}). `
      + `Responsável legal: ${representante.nome} (${representante.cargo || 'sem cargo informado'}). Financeiro: ${fin.nome}, ${fin.email}, ${fin.telefone}.`
      + `${proposta.sistema === 'ixc' ? ' Sistema de gestão: IXC (configurar na ficha do cliente).' : ''}`;
    const campos = Object.keys(d);
    const clienteId = db.prepare(`INSERT INTO clientes (${campos.join(', ')}, criado_em, criado_por) VALUES (${campos.map(() => '?').join(', ')}, ?, ?) RETURNING id`)
      .get(...campos.map((k) => d[k]), agora(), usuario.id).id;
    contaInterna.atribuir(db, clienteId);
    precos.gravarPreco(db, clienteId, proposta.preco, hoje(), usuario.id, agora());
    // Conheça seu cliente: o responsável legal já entra como representante; os sócios a equipe completa no PLD.
    db.prepare('UPDATE clientes SET kyc_representantes = ? WHERE id = ?').run(JSON.stringify([{
      nome: representante.nome, qualificacao: representante.cargo || 'Responsável legal (informado na abertura)', documento: so(representante.cpf),
    }]), clienteId);
    // O acesso nasce sem senha utilizável: o próprio cliente cria a dele pelo link de ativação.
    let acesso = null;
    if (!emailEmUso) {
      const acessoId = db.prepare(`INSERT INTO usuarios_cliente (cliente_id, nome, email, senha_hash, perfil, senha_provisoria, criado_em)
        VALUES (?, ?, ?, ?, 'admin', 1, ?) RETURNING id`).get(clienteId, fin.nome, fin.email, ativacao.senhaInutil(), agora()).id;
      acesso = { id: acessoId, nome: fin.nome, email: fin.email };
    }
    db.prepare("UPDATE solicitacoes_abertura SET situacao = 'aprovada', analisado_por = ?, analisado_em = ?, cliente_id = ? WHERE id = ?")
      .run(usuario.id, agora(), clienteId, s.id);
    registrar(db, s.id, 'sistema', `Conta aberta por ${usuario.nome}: cliente criado em implantação com a proposta.`, usuario.id);
    if (acesso) {
      Object.assign(acesso, ativacao.gerar(db, acesso.id, { criadoPor: usuario.id, solicitacaoId: s.id }));
      registrar(db, s.id, 'sistema', `Link de ativação do acesso gerado para ${fin.email} (vale até ${acesso.expira_em.slice(0, 10).split('-').reverse().join('/')}).`, usuario.id);
    }
    const cli = db.prepare('SELECT agencia_interna, conta_interna, conta_interna_dv FROM clientes WHERE id = ?').get(clienteId);
    return { cliente_id: clienteId, protocolo: protocolo(s.id), conta: contaInterna.formatar(cli.agencia_interna, cli.conta_interna, cli.conta_interna_dv), acesso, aviso_acesso: emailEmUso ? `O e-mail ${fin.email} já tem acesso a outro cliente: crie o acesso com outro e-mail.` : null };
  });
}

function recusar(db, id, motivo, usuario) {
  const s = buscar(db, id);
  exigirAberta(s);
  const m = v.texto(motivo, 'o motivo da recusa', 300);
  db.prepare("UPDATE solicitacoes_abertura SET situacao = 'recusada', analisado_por = ?, analisado_em = ?, motivo = ? WHERE id = ?")
    .run(usuario.id, agora(), m, s.id);
  registrar(db, s.id, 'sistema', `Recusado por ${usuario.nome}: ${m}`, usuario.id);
  return buscar(db, id);
}

/**
 * Guarda (LGPD): pedido recusado tem os documentos e o histórico apagados e os dados pessoais trocados por
 * vazio depois de `dias` (padrão 180). Aprovado vira cadastro de cliente e segue a guarda dele.
 */
function aplicarRetencao(db, { dias = 180 } = {}) {
  const corte = new Date(Date.now() - dias * 86_400_000).toISOString();
  const lista = db.prepare("SELECT id FROM solicitacoes_abertura WHERE situacao = 'recusada' AND analisado_em < ? AND dados <> '{}'").all(corte);
  for (const { id } of lista) {
    fs.rmSync(path.join(config.arquivos, 'abertura', String(id)), { recursive: true, force: true });
    db.prepare("UPDATE solicitacoes_abertura SET dados = '{}', arquivos = '[]', ip = NULL, checklist = '{}' WHERE id = ?").run(id);
    db.prepare('DELETE FROM abertura_interacoes WHERE solicitacao_id = ?').run(id);
  }
  return lista.length;
}

module.exports = {
  TIPOS_DOCUMENTO, MAX_BYTES, ETAPAS, ABERTAS, ROTULO, CHECKLIST, TIPOS_INTERACAO, SISTEMAS,
  protocolo, normalizar, solicitar, avisarProtocolo, criarContato, formatar, buscar, interacoes, arquivo, pendencias,
  editarDados, anexar, mover, atribuir, interagir, marcar, definirProposta, aprovar, recusar, aplicarRetencao,
};
