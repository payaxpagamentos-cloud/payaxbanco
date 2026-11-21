'use strict';

const crypto = require('node:crypto');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const { cifrar, decifrar } = require('./cripto');
const { diasEntre, dataLocal } = require('./datas');
const pkcs12 = require('./fiscal/pkcs12');

/*
 * Certificado digital e-CNPJ (A1).
 *
 * É a identidade da empresa em forma de arquivo: com ele se assina declaração, guia e nota fiscal em nome
 * do provedor. Por isso o arquivo e a senha ficam cifrados, nenhuma rota devolve nenhum dos dois, e o que
 * aparece na tela é só o que o próprio certificado declara sobre si — titular, CNPJ, emissor e validade,
 * lidos do arquivo, nunca digitados.
 *
 * O A3 (cartão ou token) fica de fora, e não por falta de vontade: a chave privada nunca sai do
 * dispositivo, e assinar exige o hardware presente na máquina de quem assina. Um servidor não guarda A3.
 */

// Um A1 tem alguns quilobytes. Arquivo muito maior não é certificado: é outra coisa.
const MAX_BYTES = 256 * 1024;

/** Um campo do assunto ou do emissor, no formato de várias linhas que o X509Certificate devolve. */
const campo = (texto, nome) => {
  const linha = String(texto ?? '').split('\n').find((l) => l.startsWith(`${nome}=`));
  return linha ? linha.slice(nome.length + 1).trim() : null;
};

/**
 * Lê o certificado sem nenhuma biblioteca externa.
 *
 * O arquivo é aberto pelo leitor próprio de PKCS#12 (lib/fiscal/pkcs12.js), que entende tanto a cifra
 * nova (PBES2/AES) quanto as antigas (3DES e RC2-40). As antigas importam: muito A1 brasileiro ainda vem
 * em RC2-40, que o OpenSSL 3 empurrou para o provedor legado e o Node recusa — abrir por conta própria é
 * o que faz esses certificados funcionarem em vez de o sistema mandar o cliente converter o arquivo.
 *
 * O mesmo leitor entrega a chave privada, que é o que permite assinar a nota fiscal. Por isso ele existe.
 */
function ler(pfx, senha) {
  if (!Buffer.isBuffer(pfx) || !pfx.length) throw new ErroNegocio('Envie o arquivo do certificado (.pfx ou .p12).', 422);
  if (pfx.length > MAX_BYTES) throw new ErroNegocio('Arquivo grande demais para ser um certificado A1.', 422);

  const { certificado } = pkcs12.abrir(pfx, String(senha ?? ''));

  /*
   * No padrão ICP-Brasil o nome comum traz "RAZÃO SOCIAL:CNPJ". Quando não traz, o CNPJ fica em branco em
   * vez de ser adivinhado — identificar a empresa errada num documento assinado é pior que não identificar.
   */
  const cn = campo(certificado.subject, 'CN') ?? '';
  const m = /^(.*?):(\d{11,14})$/.exec(cn);

  return {
    titular: (m ? m[1] : cn).trim() || null,
    documento: m ? m[2] : null,
    emissor: [campo(certificado.issuer, 'CN'), campo(certificado.issuer, 'O')].filter(Boolean).join(' · ') || null,
    valido_de: new Date(certificado.validFrom).toISOString(),
    valido_ate: new Date(certificado.validTo).toISOString(),
    serie: certificado.serialNumber ?? null,
    impressao: certificado.fingerprint256 ?? crypto.createHash('sha256').update(pfx).digest('hex'),
    bytes: pfx.length,
  };
}

/**
 * Abre o certificado ativo da organização e devolve o que assina: a chave privada e o certificado.
 * Fica aqui, e não em quem emite a nota, para a chave privada ter um só caminho de saída no sistema.
 */
function paraAssinar(db, org) {
  const { pfx, passphrase, dados } = usar(db, org);
  const aberto = pkcs12.abrir(pfx, passphrase);
  return { chave: aberto.chave, certificadoDer: aberto.certificadoDer, certificado: aberto.certificado, pfx, passphrase, dados };
}

/** Quanto tempo ainda vale, e como a tela deve tratar isso. */
function situacao(cert, hoje = dataLocal('America/Sao_Paulo')) {
  if (!cert) return { estado: 'ausente', dias: null, texto: 'Nenhum certificado instalado.' };
  const fim = String(cert.valido_ate).slice(0, 10);
  const inicio = String(cert.valido_de).slice(0, 10);
  if (hoje < inicio) return { estado: 'futuro', dias: diasEntre(hoje, inicio), texto: `Este certificado só passa a valer em ${inicio.split('-').reverse().join('/')}.` };
  const dias = diasEntre(hoje, fim);
  if (dias < 0) {
    return { estado: 'vencido', dias, texto: `Certificado vencido há ${Math.abs(dias)} dia(s). Nenhuma obrigação pode ser assinada com ele.` };
  }
  if (dias <= 30) {
    return { estado: 'vencendo', dias, texto: `Vence em ${dias} dia(s). Renove antes: certificado vencido trava declaração, guia e nota fiscal de uma vez.` };
  }
  return { estado: 'valido', dias, texto: `Válido por mais ${dias} dia(s).` };
}

/** O que pode sair numa resposta: tudo menos o arquivo e a senha. */
const publico = (c) => (c ? {
  id: c.id, apelido: c.apelido, tipo: c.tipo, titular: c.titular, documento: c.documento, emissor: c.emissor,
  valido_de: c.valido_de, valido_ate: c.valido_ate, serie: c.serie, impressao: c.impressao, bytes: c.bytes,
  enviado_em: c.enviado_em, enviado_por_nome: c.enviado_por_nome ?? null, ultimo_uso_em: c.ultimo_uso_em,
  ativo: Boolean(c.ativo), removido_em: c.removido_em, motivo_remocao: c.motivo_remocao,
} : null);

const ativoDe = (db, org) => db.prepare(`SELECT c.*, u.nome AS enviado_por_nome FROM certificados c
  LEFT JOIN usuarios u ON u.id = c.enviado_por WHERE c.organizacao_id = ? AND c.ativo = 1`).get(org) ?? null;

/**
 * Instala o certificado. Só um fica ativo por organização: dois certificados válidos ao mesmo tempo
 * deixariam em aberto qual assinou o quê, que é a última coisa que se quer num documento fiscal.
 */
function instalar(db, { org, apelido, pfx, senha, usuarioId = null, documentoEsperado = null, hoje = dataLocal('America/Sao_Paulo') }) {
  const dados = ler(pfx, senha);
  if (String(dados.valido_ate).slice(0, 10) < hoje) {
    throw new ErroNegocio(`Este certificado venceu em ${String(dados.valido_ate).slice(0, 10).split('-').reverse().join('/')}. `
      + 'Instalar um certificado vencido só adiaria a descoberta do problema.', 422);
  }
  /*
   * O CNPJ do certificado tem de ser o da organização. Assinar em nome de outra empresa é problema
   * grave — e normalmente é só o arquivo errado, enviado por engano.
   */
  if (documentoEsperado && dados.documento && String(documentoEsperado).replace(/\D/g, '') !== dados.documento) {
    throw new ErroNegocio(`O certificado é de outro CNPJ (${dados.documento}), diferente do cadastrado nesta organização. `
      + 'Confira se enviou o arquivo certo.', 422);
  }

  const t = agora();
  const anterior = ativoDe(db, org);
  if (anterior) {
    db.prepare("UPDATE certificados SET ativo = 0, removido_em = ?, removido_por = ?, motivo_remocao = 'Substituído por outro certificado' WHERE id = ?")
      .run(t, usuarioId, anterior.id);
  }
  const id = Number(db.prepare(`INSERT INTO certificados (organizacao_id, apelido, tipo, arquivo_cifrado, senha_cifrada, bytes,
    titular, documento, emissor, valido_de, valido_ate, serie, impressao, enviado_por, enviado_em)
    VALUES (?, ?, 'A1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(org, apelido, cifrar(pfx.toString('base64')), cifrar(String(senha)), dados.bytes,
      dados.titular, dados.documento, dados.emissor, dados.valido_de, dados.valido_ate, dados.serie, dados.impressao, usuarioId, t).lastInsertRowid);
  return { ...publico(db.prepare('SELECT * FROM certificados WHERE id = ?').get(id)), substituiu: anterior ? anterior.apelido : null };
}

function remover(db, { org, motivo, usuarioId = null }) {
  const c = ativoDe(db, org);
  if (!c) throw new ErroNegocio('Não há certificado instalado.', 404);
  db.prepare('UPDATE certificados SET ativo = 0, removido_em = ?, removido_por = ?, motivo_remocao = ? WHERE id = ?')
    .run(agora(), usuarioId, motivo, c.id);
  return { removido: c.apelido };
}

/**
 * Entrega o certificado pronto para uso — só para quem vai realmente assinar ou abrir conexão mTLS.
 * Nunca é chamada por uma rota: o conteúdo não pode sair do servidor.
 */
function usar(db, org) {
  const c = ativoDe(db, org);
  if (!c) throw new ErroNegocio('Nenhum certificado digital instalado nesta organização.', 422);
  const s = situacao(c);
  if (s.estado === 'vencido') throw new ErroNegocio(s.texto, 422);
  if (s.estado === 'futuro') throw new ErroNegocio(s.texto, 422);
  db.prepare('UPDATE certificados SET ultimo_uso_em = ? WHERE id = ?').run(agora(), c.id);
  return { pfx: Buffer.from(decifrar(c.arquivo_cifrado), 'base64'), passphrase: decifrar(c.senha_cifrada), dados: publico(c) };
}

/** Confere se o certificado guardado ainda abre com a senha guardada. */
function testar(db, org) {
  const c = ativoDe(db, org);
  if (!c) throw new ErroNegocio('Não há certificado instalado.', 404);
  const dados = ler(Buffer.from(decifrar(c.arquivo_cifrado), 'base64'), decifrar(c.senha_cifrada));
  return { ok: true, confere: dados.impressao === c.impressao, ...situacao(c), titular: dados.titular, documento: dados.documento };
}

const historico = (db, org, limite = 20) => db.prepare(`SELECT c.*, u.nome AS enviado_por_nome, r.nome AS removido_por_nome
  FROM certificados c LEFT JOIN usuarios u ON u.id = c.enviado_por LEFT JOIN usuarios r ON r.id = c.removido_por
  WHERE c.organizacao_id = ? ORDER BY c.id DESC LIMIT ?`).all(org, limite)
  .map((c) => ({ ...publico(c), removido_por_nome: c.removido_por_nome }));

/*
 * O que cada integração ainda precisa além do certificado.
 *
 * Está escrito aqui, e não só no README, porque é a pergunta que a pessoa faz na hora em que instala o
 * certificado e não vê nada acontecer. Dizer "falta o certificado" quando o certificado já está lá seria
 * esconder o que realmente falta.
 */
const INTEGRACOES = [
  { chave: 'receita', nome: 'Receita Federal (e-CAC / Integra Contador)', exige: ['Certificado e-CNPJ instalado', 'Procuração eletrônica no e-CAC para o responsável', 'Contratação do Integra Contador (Serpro) para acesso por API'], faz: 'DCTFWeb, PGDAS-D, DARF e consulta de situação fiscal.' },
  { chave: 'fgts', nome: 'FGTS Digital', exige: ['Certificado e-CNPJ instalado', 'Procuração eletrônica para o FGTS Digital', 'Cadastro do empregador no sistema'], faz: 'Guias de FGTS e consulta de débitos.' },
  { chave: 'esocial', nome: 'eSocial', exige: ['Certificado e-CNPJ instalado', 'Cadastro no ambiente de produção restrita antes do real', 'Eventos S-1000 em diante já enviados'], faz: 'Envio de eventos trabalhistas e retorno de recibos.' },
];

const pendenciasDe = (db, org) => {
  const c = ativoDe(db, org);
  const s = situacao(c);
  const ok = c && ['valido', 'vencendo'].includes(s.estado);
  return INTEGRACOES.map((i) => ({
    ...i,
    certificado_ok: Boolean(ok),
    // Marca só o que o sistema consegue conferir: o resto depende de providência do provedor nos órgãos.
    faltando: ok ? i.exige.slice(1) : i.exige,
    pronta: false,
    observacao: 'O conector ainda não está escrito. O certificado é o primeiro requisito, não o único.',
  }));
};

module.exports = { MAX_BYTES, ler, situacao, publico, ativoDe, instalar, remover, usar, paraAssinar, testar, historico, INTEGRACOES, pendenciasDe };
