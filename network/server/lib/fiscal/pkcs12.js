'use strict';

const crypto = require('node:crypto');
const asn1 = require('./asn1');
const rc2 = require('./rc2');
const { ErroNegocio } = require('../erros');

/*
 * Leitor de arquivo PKCS#12 (.pfx / .p12): tira de dentro a chave privada e o certificado.
 *
 * Para que serve: a NFCom precisa ser assinada com a chave privada do provedor, e essa chave vive dentro
 * do certificado A1. O Node sabe USAR um .pfx numa conexão TLS, mas não sabe ABRIR um para entregar a
 * chave — e sem a chave em mãos não há assinatura XML. Chamar o `openssl` por fora resolveria, ao preço
 * de a chave privada do cliente passar pela saída de um processo filho e pela linha de comando. Ela não
 * sai daqui de dentro.
 *
 * Cifras aceitas, que são as que aparecem em certificado brasileiro de verdade:
 *   - PBES2 (PBKDF2 + AES-128/192/256-CBC)  → emissão recente
 *   - pbeWithSHAAnd3-KeyTripleDES-CBC       → o mais comum até há pouco
 *   - pbeWithSHAAnd2-KeyTripleDES-CBC
 *   - pbeWithSHAAnd128BitRC2-CBC e pbeWithSHAAnd40BitRC2-CBC → os "legados", que o OpenSSL 3 recusa
 *
 * O RC2 está implementado aqui (lib/fiscal/rc2.js) justamente porque o OpenSSL 3 o moveu para o provedor
 * legado: sem isso, um A1 antigo — e há muitos — simplesmente não abriria.
 */

const OID = {
  dados: '1.2.840.113549.1.7.1',
  dadosCifrados: '1.2.840.113549.1.7.6',
  sacoChave: '1.2.840.113549.1.12.10.1.1',
  sacoChaveCifrada: '1.2.840.113549.1.12.10.1.2',
  sacoCertificado: '1.2.840.113549.1.12.10.1.3',
  certificadoX509: '1.2.840.113549.1.9.22.1',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
};

/* OID da cifra → como decifrar. `pkcs12` diz que a chave sai da derivação do PKCS#12, não do PBKDF2. */
const CIFRAS = {
  '1.2.840.113549.1.12.1.3': { tipo: 'pkcs12', cifra: 'des-ede3-cbc', chave: 24, iv: 8 },
  '1.2.840.113549.1.12.1.4': { tipo: 'pkcs12', cifra: 'des-ede-cbc', chave: 16, iv: 8 },
  '1.2.840.113549.1.12.1.5': { tipo: 'pkcs12', cifra: 'rc2', chave: 16, iv: 8, bits: 128 },
  '1.2.840.113549.1.12.1.6': { tipo: 'pkcs12', cifra: 'rc2', chave: 5, iv: 8, bits: 40 },
};
const AES = {
  '2.16.840.1.101.3.4.1.2': { cifra: 'aes-128-cbc', chave: 16 },
  '2.16.840.1.101.3.4.1.22': { cifra: 'aes-192-cbc', chave: 24 },
  '2.16.840.1.101.3.4.1.42': { cifra: 'aes-256-cbc', chave: 32 },
};
const PRF = {
  '1.2.840.113549.2.7': 'sha1',
  '1.2.840.113549.2.8': 'sha224',
  '1.2.840.113549.2.9': 'sha256',
  '1.2.840.113549.2.10': 'sha384',
  '1.2.840.113549.2.11': 'sha512',
};

/**
 * Derivação de chave do PKCS#12 (RFC 7292, apêndice B.2) com SHA-1.
 * `id` é 1 para a chave, 2 para o vetor de inicialização e 3 para o MAC.
 */
function derivar(senhaBmp, sal, iteracoes, tamanho, id) {
  const u = 20; // saída do SHA-1
  const v = 64; // bloco do SHA-1
  const D = Buffer.alloc(v, id);
  const esticar = (b) => {
    if (b.length === 0) return Buffer.alloc(0);
    const n = Math.ceil(b.length / v) * v;
    const fora = Buffer.alloc(n);
    for (let i = 0; i < n; i++) fora[i] = b[i % b.length];
    return fora;
  };
  const S = esticar(sal);
  const P = esticar(senhaBmp);
  let I = Buffer.concat([S, P]);

  const saida = [];
  const voltas = Math.ceil(tamanho / u);
  for (let c = 0; c < voltas; c++) {
    let A = Buffer.concat([D, I]);
    for (let r = 0; r < iteracoes; r++) A = crypto.createHash('sha1').update(A).digest();
    saida.push(A);
    if (c === voltas - 1) break;

    // B é A repetido até encher um bloco; cada bloco de I vira (I + B + 1), como inteiro grande.
    const B = Buffer.alloc(v);
    for (let i = 0; i < v; i++) B[i] = A[i % u];
    const novo = Buffer.alloc(I.length);
    for (let j = 0; j < I.length; j += v) {
      let carrega = 1;
      for (let i = v - 1; i >= 0; i--) {
        const soma = I[j + i] + B[i] + carrega;
        novo[j + i] = soma & 0xff;
        carrega = soma >> 8;
      }
    }
    I = novo;
  }
  return Buffer.concat(saida).subarray(0, tamanho);
}

/** A senha vira BMPString: UTF-16 big-endian terminada em dois zeros. */
const paraBmp = (senha) => {
  const s = String(senha ?? '');
  const b = Buffer.alloc(s.length * 2 + 2);
  for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
  return b;
};

/** Decifra um bloco segundo o AlgorithmIdentifier que o acompanha. */
function decifrar(algoritmo, cifrado, senha) {
  const partes = asn1.dentro(algoritmo);
  const alg = asn1.oid(partes[0].conteudo);

  if (alg === OID.pbes2) {
    const [kdf, esquema] = asn1.dentro(partes[1]);
    const kdfPartes = asn1.dentro(kdf);
    if (asn1.oid(kdfPartes[0].conteudo) !== OID.pbkdf2) throw new ErroNegocio('O certificado usa uma derivação de chave que este sistema não conhece.', 422);
    const p = asn1.dentro(kdfPartes[1]);
    const sal = p[0].conteudo;
    const iteracoes = asn1.inteiro(p[1].conteudo);
    const escPartes = asn1.dentro(esquema);
    const esc = AES[asn1.oid(escPartes[0].conteudo)];
    if (!esc) throw new ErroNegocio('O certificado usa uma cifra que este sistema não conhece (só AES-CBC é aceito em PBES2).', 422);
    // O tamanho da chave pode vir declarado; quando não vem, é o da própria cifra.
    const declarado = p.find((x, i) => i >= 2 && x.tag === asn1.TAG.INTEIRO);
    const tamanho = declarado ? asn1.inteiro(declarado.conteudo) : esc.chave;
    const prfId = p.find((x, i) => i >= 2 && x.tag === asn1.TAG.SEQUENCIA);
    const hash = prfId ? (PRF[asn1.oid(asn1.dentro(prfId)[0].conteudo)] ?? 'sha1') : 'sha1';
    const chave = crypto.pbkdf2Sync(Buffer.from(String(senha ?? ''), 'utf8'), sal, iteracoes, tamanho, hash);
    return abrirBloco(() => {
      const d = crypto.createDecipheriv(esc.cifra, chave, escPartes[1].conteudo);
      return Buffer.concat([d.update(cifrado), d.final()]);
    });
  }

  const c = CIFRAS[alg];
  if (!c) throw new ErroNegocio(`O certificado usa a cifra ${alg}, que este sistema não conhece.`, 422);
  const p = asn1.dentro(partes[1]);
  const sal = p[0].conteudo;
  const iteracoes = asn1.inteiro(p[1].conteudo);
  const bmp = paraBmp(senha);
  const chave = derivar(bmp, sal, iteracoes, c.chave, 1);
  const iv = derivar(bmp, sal, iteracoes, c.iv, 2);
  return abrirBloco(() => {
    if (c.cifra === 'rc2') return rc2.decifrarCBC(chave, iv, cifrado, c.bits);
    const d = crypto.createDecipheriv(c.cifra, chave, iv);
    return Buffer.concat([d.update(cifrado), d.final()]);
  });
}

/*
 * Senha errada e arquivo corrompido chegam aqui do mesmo jeito: a decifragem produz lixo e o enchimento
 * do último bloco não fecha. Não dá para distinguir os dois casos — é assim que a cifra funciona —, então
 * a mensagem diz o que é quase sempre verdade e o que a pessoa pode fazer, em vez de repassar o erro do
 * OpenSSL, que não ajuda ninguém.
 */
function abrirBloco(fn) {
  try { return fn(); } catch (err) {
    if (err instanceof ErroNegocio) throw err;
    throw new ErroNegocio('Senha do certificado incorreta (ou o arquivo está corrompido). Confira a senha e envie de novo.', 422);
  }
}

/** Percorre um SafeContents e recolhe a chave e os certificados que estiverem nele. */
function lerSacos(der, senha, achado) {
  for (const saco of asn1.dentro(asn1.lerValor(der))) {
    const partes = asn1.dentro(saco);
    const tipo = asn1.oid(partes[0].conteudo);
    const valor = asn1.lerValor(partes[1].conteudo);

    if (tipo === OID.sacoChave) {
      achado.chaveDer ??= Buffer.from(partes[1].conteudo);
    } else if (tipo === OID.sacoChaveCifrada) {
      const [algoritmo, dados] = asn1.dentro(valor);
      achado.chaveDer ??= decifrar(algoritmo, dados.conteudo, senha);
    } else if (tipo === OID.sacoCertificado) {
      const dentro = asn1.dentro(valor);
      if (asn1.oid(dentro[0].conteudo) === OID.certificadoX509) {
        achado.certificados.push(Buffer.from(asn1.lerValor(dentro[1].conteudo).conteudo));
      }
    }
  }
}

/**
 * Abre o arquivo e devolve a chave privada e o certificado, já em PEM.
 *
 * A ordem dos certificados dentro do arquivo não é confiável, então o do titular é escolhido por prova:
 * é o único cuja chave pública casa com a chave privada que veio junto. Os demais são a cadeia.
 */
function abrir(pfx, senha) {
  let raiz;
  // Qualquer falha já na casca externa significa a mesma coisa para quem enviou: o arquivo não é um .pfx.
  try { raiz = asn1.dentro(asn1.lerValor(pfx)); } catch {
    throw new ErroNegocio('Este arquivo não é um certificado PKCS#12 (.pfx ou .p12) válido.', 422);
  }
  const conteudo = asn1.dentro(raiz[1]);
  if (asn1.oid(conteudo[0].conteudo) !== OID.dados) throw new ErroNegocio('Formato de certificado inesperado: o conteúdo externo não é "data".', 422);
  const autenticado = asn1.lerValor(conteudo[1].conteudo).conteudo;

  const achado = { chaveDer: null, certificados: [] };
  for (const pedaco of asn1.dentro(asn1.lerValor(autenticado))) {
    const partes = asn1.dentro(pedaco);
    const tipo = asn1.oid(partes[0].conteudo);
    if (tipo === OID.dados) {
      lerSacos(asn1.lerValor(partes[1].conteudo).conteudo, senha, achado);
    } else if (tipo === OID.dadosCifrados) {
      const info = asn1.dentro(asn1.dentro(asn1.lerValor(partes[1].conteudo))[1]);
      // O conteúdo cifrado vem em [0] implícito, então o conteúdo bruto já é o texto cifrado.
      lerSacos(decifrar(info[1], info[2].conteudo, senha), senha, achado);
    }
  }

  if (!achado.chaveDer) throw new ErroNegocio('O arquivo não traz chave privada — é um certificado só com a parte pública, e não serve para assinar.', 422);
  if (!achado.certificados.length) throw new ErroNegocio('O arquivo não traz certificado.', 422);

  let chave;
  try {
    chave = crypto.createPrivateKey({ key: achado.chaveDer, format: 'der', type: 'pkcs8' });
  } catch {
    throw new ErroNegocio('A senha abriu o arquivo, mas a chave privada de dentro não pôde ser lida.', 422);
  }
  const publica = crypto.createPublicKey(chave).export({ type: 'spki', format: 'der' });
  const certs = achado.certificados.map((der) => new crypto.X509Certificate(der));
  const titular = certs.find((c) => c.publicKey.export({ type: 'spki', format: 'der' }).equals(publica));
  if (!titular) throw new ErroNegocio('O arquivo traz uma chave privada que não corresponde a nenhum dos certificados dentro dele.', 422);

  return {
    chave,
    chavePem: chave.export({ type: 'pkcs8', format: 'pem' }),
    certificado: titular,
    certificadoPem: titular.toString(),
    certificadoDer: Buffer.from(titular.raw),
    cadeiaPem: certs.filter((c) => c !== titular).map((c) => c.toString()),
  };
}

module.exports = { abrir, derivar, paraBmp };
