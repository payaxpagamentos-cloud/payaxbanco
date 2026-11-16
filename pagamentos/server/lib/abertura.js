'use strict';

/*
 * Abertura de conta pelo site (payax.com.br → "Abra sua conta").
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
const { hashSenha, senhaProvisoria } = require('./senha');
const contaInterna = require('./contaInterna');

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

/**
 * Valida o pedido inteiro. `validarCadastro` é a mesma validação do cadastro de cliente da equipe
 * (routes/clientes.js): o que passa aqui, passa na aprovação.
 */
function validar(b, validarCadastro) {
  if (b?.site) throw new ErroNegocio('Pedido recusado.', 400); // campo isca: só robô preenche
  if (!b?.aceite) throw new ErroNegocio('Confirme que leu o aviso de privacidade e que os dados são verdadeiros.', 422);
  const e = b.empresa ?? {};
  const destino = b.destino ?? {};
  const cadastro = {
    razao_social: e.razao_social, cnpj: e.cnpj, nome_fantasia: e.nome_fantasia, email: e.email, telefone: e.telefone,
    cep: e.cep, endereco: e.endereco, numero: e.numero, complemento: e.complemento, bairro: e.bairro, cidade: e.cidade, uf: e.uf,
    ...(destino.forma === 'pix'
      ? { pix_chave: destino.pix_chave, pix_tipo: destino.pix_tipo || undefined }
      : { destino_banco: destino.banco, destino_ispb: destino.ispb || undefined, destino_agencia: destino.agencia,
        destino_agencia_dv: destino.agencia_dv, destino_conta: destino.conta, destino_conta_dv: destino.conta_dv,
        destino_tipo: destino.tipo, destino_titular: e.razao_social }),
  };
  if (!e.email) throw new ErroNegocio('Informe o e-mail da empresa.', 422);
  if (!['pix', 'conta'].includes(destino.forma)) throw new ErroNegocio('Informe onde a empresa quer receber os valores: conta ou chave PIX.', 422);
  const empresa = validarCadastro(cadastro);
  const representante = pessoaDe(b.representante, 'responsável legal da empresa', { cpf: true });
  if (so(representante.cpf).length !== 11) throw new ErroNegocio('O responsável legal precisa ser pessoa física (CPF).', 422);
  const financeiro = pessoaDe(b.financeiro, 'responsável financeiro');
  return { empresa, representante, financeiro };
}

function pasta(id) {
  const p = path.join(config.arquivos, 'abertura', String(id));
  fs.mkdirSync(p, { recursive: true, mode: 0o750 });
  return p;
}

/** Registra o pedido vindo do site. Devolve o protocolo. */
function solicitar(db, body, { ip, validarCadastro }) {
  const { empresa, representante, financeiro } = validar(body, validarCadastro);
  if (db.prepare('SELECT 1 FROM clientes WHERE cnpj = ?').get(empresa.cnpj)) {
    throw new ErroNegocio('Esta empresa já é cliente PAY AX. Fale com o seu gerente de conta para o acesso.', 409);
  }
  if (db.prepare("SELECT 1 FROM solicitacoes_abertura WHERE cnpj = ? AND situacao IN ('nova','em_analise')").get(empresa.cnpj)) {
    throw new ErroNegocio('Já recebemos um pedido para este CNPJ e ele está em análise. A equipe PAY AX vai entrar em contato.', 409);
  }
  const documentos = Object.keys(TIPOS_DOCUMENTO).map((t) => lerDocumento(body.documentos?.[t], t)).filter(Boolean);

  const id = db.prepare(`INSERT INTO solicitacoes_abertura (cnpj, razao_social, dados, ip, criado_em)
    VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .get(empresa.cnpj, empresa.razao_social, JSON.stringify({ empresa, representante, financeiro }), ip ?? null, agora()).id;
  try {
    const dir = pasta(id);
    const arquivos = documentos.map((d, i) => {
      const nome = `${i + 1}-${d.tipo}.${d.ext}`;
      fs.writeFileSync(path.join(dir, nome), d.bytes, { mode: 0o640 });
      return { tipo: d.tipo, nome_original: d.nome, mime: d.mime, tamanho: d.bytes.length,
        sha256: crypto.createHash('sha256').update(d.bytes).digest('hex'), arquivo: nome };
    });
    db.prepare('UPDATE solicitacoes_abertura SET arquivos = ? WHERE id = ?').run(JSON.stringify(arquivos), id);
  } catch (err) {
    db.prepare('DELETE FROM solicitacoes_abertura WHERE id = ?').run(id);
    throw err;
  }
  return { id, protocolo: protocolo(id) };
}

/** Pedido no formato da tela (sem caminho de arquivo). */
function formatar(s) {
  const dados = JSON.parse(s.dados);
  return {
    id: s.id, protocolo: protocolo(s.id), situacao: s.situacao, cnpj: s.cnpj, razao_social: s.razao_social,
    criado_em: s.criado_em, analisado_em: s.analisado_em, analisado_por_nome: s.analisado_por_nome ?? null,
    motivo: s.motivo, cliente_id: s.cliente_id, ...dados,
    arquivos: JSON.parse(s.arquivos || '[]').map((a, i) => ({ indice: i, tipo: a.tipo, rotulo: TIPOS_DOCUMENTO[a.tipo]?.rotulo ?? a.tipo,
      nome: a.nome_original, mime: a.mime, tamanho: a.tamanho, sha256: a.sha256 })),
  };
}

function buscar(db, id) {
  const s = db.prepare(`SELECT s.*, u.nome AS analisado_por_nome FROM solicitacoes_abertura s
    LEFT JOIN usuarios u ON u.id = s.analisado_por WHERE s.id = ?`).get(Number(id));
  if (!s) throw naoEncontrado('Pedido de abertura');
  return s;
}

function arquivo(db, id, indice) {
  const s = buscar(db, id);
  const a = JSON.parse(s.arquivos || '[]')[Number(indice)];
  if (!a) throw naoEncontrado('Documento');
  const caminho = path.join(config.arquivos, 'abertura', String(s.id), path.basename(a.arquivo));
  if (!fs.existsSync(caminho)) throw new ErroNegocio('O documento não está mais guardado (prazo de guarda vencido).', 410);
  return { caminho, nome: a.nome_original, mime: a.mime };
}

function emAnalise(db, id, usuario) {
  const s = buscar(db, id);
  if (s.situacao !== 'nova') return formatar(s);
  db.prepare("UPDATE solicitacoes_abertura SET situacao = 'em_analise', analisado_por = ?, analisado_em = ? WHERE id = ?").run(usuario.id, agora(), s.id);
  return formatar(buscar(db, id));
}

/**
 * Aprova: cria o cliente "em implantação" com os dados do pedido, o responsável legal no conheça seu cliente
 * e o acesso do responsável financeiro (administrador da Área do Cliente). Devolve a senha provisória, mostrada
 * uma vez só, para a equipe entregar.
 */
function aprovar(db, id, usuario, { validarCadastro }) {
  const s = buscar(db, id);
  if (!['nova', 'em_analise'].includes(s.situacao)) throw new ErroNegocio('Este pedido já foi analisado.', 409);
  const dados = JSON.parse(s.dados);
  const d = validarCadastro({ ...dados.empresa, situacao: 'implantacao' });
  if (db.prepare('SELECT 1 FROM clientes WHERE cnpj = ?').get(d.cnpj)) throw new ErroNegocio('Já existe um cliente com este CNPJ.', 409);
  const fin = dados.financeiro;
  const emailEmUso = db.prepare('SELECT 1 FROM usuarios_cliente WHERE email = ?').get(fin.email);
  const provisoria = senhaProvisoria();

  return transacao(db, () => {
    d.responsavel = fin.nome;
    d.observacoes = `Conta aberta pelo site (pedido ${protocolo(s.id)}). Responsável legal: ${dados.representante.nome}`
      + ` (${dados.representante.cargo || 'sem cargo informado'}). Financeiro: ${fin.nome}, ${fin.email}, ${fin.telefone}.`;
    const campos = Object.keys(d);
    const clienteId = db.prepare(`INSERT INTO clientes (${campos.join(', ')}, criado_em, criado_por) VALUES (${campos.map(() => '?').join(', ')}, ?, ?) RETURNING id`)
      .get(...campos.map((k) => d[k]), agora(), usuario.id).id;
    contaInterna.atribuir(db, clienteId);
    // Conheça seu cliente: o responsável legal já entra como representante; os sócios a equipe completa no PLD.
    db.prepare('UPDATE clientes SET kyc_representantes = ? WHERE id = ?').run(JSON.stringify([{
      nome: dados.representante.nome, qualificacao: dados.representante.cargo || 'Responsável legal (informado na abertura)',
      documento: so(dados.representante.cpf),
    }]), clienteId);
    let acesso = null;
    if (!emailEmUso) {
      const acessoId = db.prepare(`INSERT INTO usuarios_cliente (cliente_id, nome, email, senha_hash, perfil, senha_provisoria, criado_em)
        VALUES (?, ?, ?, ?, 'admin', 1, ?) RETURNING id`).get(clienteId, fin.nome, fin.email, hashSenha(provisoria), agora()).id;
      acesso = { id: acessoId, nome: fin.nome, email: fin.email, senha_provisoria: provisoria };
    }
    db.prepare("UPDATE solicitacoes_abertura SET situacao = 'aprovada', analisado_por = ?, analisado_em = ?, cliente_id = ? WHERE id = ?")
      .run(usuario.id, agora(), clienteId, s.id);
    return { cliente_id: clienteId, acesso, aviso_acesso: emailEmUso ? `O e-mail ${fin.email} já tem acesso a outro cliente: crie o acesso com outro e-mail.` : null };
  });
}

function recusar(db, id, motivo, usuario) {
  const s = buscar(db, id);
  if (!['nova', 'em_analise'].includes(s.situacao)) throw new ErroNegocio('Este pedido já foi analisado.', 409);
  const m = v.texto(motivo, 'o motivo da recusa', 300);
  db.prepare("UPDATE solicitacoes_abertura SET situacao = 'recusada', analisado_por = ?, analisado_em = ?, motivo = ? WHERE id = ?")
    .run(usuario.id, agora(), m, s.id);
  return formatar(buscar(db, id));
}

/**
 * Guarda (LGPD): pedido recusado tem os documentos apagados e os dados pessoais trocados por "anonimizado"
 * depois de `dias` (padrão 180). Aprovado vira cadastro de cliente e segue a guarda dele.
 */
function aplicarRetencao(db, { dias = 180 } = {}) {
  const corte = new Date(Date.now() - dias * 86_400_000).toISOString();
  const lista = db.prepare("SELECT id FROM solicitacoes_abertura WHERE situacao = 'recusada' AND analisado_em < ? AND dados <> '{}'").all(corte);
  for (const { id } of lista) {
    fs.rmSync(path.join(config.arquivos, 'abertura', String(id)), { recursive: true, force: true });
    db.prepare("UPDATE solicitacoes_abertura SET dados = '{}', arquivos = '[]', ip = NULL WHERE id = ?").run(id);
  }
  return lista.length;
}

module.exports = { TIPOS_DOCUMENTO, MAX_BYTES, protocolo, solicitar, formatar, buscar, arquivo, emAnalise, aprovar, recusar, aplicarRetencao };
