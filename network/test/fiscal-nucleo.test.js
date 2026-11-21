'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { criarCertificado, temOpenssl } = require('./certificado-falso');
const chave = require('../server/lib/fiscal/chave');
const tabelas = require('../server/lib/fiscal/tabelas');
const x = require('../server/lib/fiscal/xml');
const pkcs12 = require('../server/lib/fiscal/pkcs12');
const rc2 = require('../server/lib/fiscal/rc2');
const assinatura = require('../server/lib/fiscal/assinatura');

/*
 * Núcleo fiscal: o que precisa estar certo ANTES de existir qualquer nota.
 *
 * Tudo aqui é verificável sem a SEFAZ, e por isso é aqui que o erro tem de ser pego. Chave de acesso
 * errada, XML fora da forma canônica ou assinatura mal montada só aparecem, de outro modo, como uma
 * rejeição depois que a nota já foi emitida para o cliente.
 */

test('chave de acesso da NFCom', async (t) => {
  await t.test('o exemplo do manual confere: soma 644, resto 6, dígito 5', () => {
    /*
     * O MOC (Visão Geral, 5.3) traz esse cálculo como exemplo. Aqui se monta uma base de 43 dígitos cuja
     * soma ponderada é exatamente 644 e se cobra o dígito que o manual publica.
     */
    const peso = (i) => ((42 - i) % 8) + 2;
    const d = new Array(43).fill(0);
    let falta = 644;
    for (let i = 0; i < 43 && falta > 0; i++) {
      const usa = Math.min(9, Math.floor(falta / peso(i)));
      d[i] = usa;
      falta -= usa * peso(i);
    }
    assert.equal(falta, 0, 'a base de teste precisa somar 644 exatamente');
    const soma = d.reduce((s, v, i) => s + v * peso(i), 0);
    assert.equal(soma, 644);
    assert.equal(chave.digitoVerificador(d.join('')), 5, 'o manual publica 5 para esta soma');
  });

  await t.test('resto 0 e resto 1 dão dígito 0', () => {
    const peso = (i) => ((42 - i) % 8) + 2;
    for (const alvo of [11 * 60, 11 * 60 + 1]) {
      const d = new Array(43).fill(0);
      let falta = alvo;
      for (let i = 0; i < 43 && falta > 0; i++) {
        const usa = Math.min(9, Math.floor(falta / peso(i)));
        d[i] = usa; falta -= usa * peso(i);
      }
      assert.equal(falta, 0);
      assert.equal(chave.digitoVerificador(d.join('')), 0, `soma ${alvo}`);
    }
  });

  await t.test('O LEIAUTE É O DA NFCom, NÃO O DA NF-e: tem nSiteAutoriz e cNF de 7 dígitos', () => {
    /*
     * Esta é a armadilha do módulo. Quem copia o cálculo da NF-e põe cNF de 8 dígitos e não põe
     * nSiteAutoriz — a chave sai com 44 dígitos, passa em qualquer teste de formato, e é recusada
     * pela SEFAZ. O teste cobra as posições exatas.
     */
    const r = chave.montar({ cUF: 41, ano: 2026, mes: 11, cnpj: '45997418000153', serie: 1, numero: 123, tpEmis: 1, nSiteAutoriz: 0, cNF: '1234567' });
    assert.equal(r.chave.length, 44);
    const p = chave.ler(r.chave);
    assert.equal(p.cUF, '41');
    assert.equal(p.AAMM, '2611', 'ano com dois dígitos e mês com dois');
    assert.equal(p.CNPJ, '45997418000153');
    assert.equal(p.mod, '62', 'o modelo da NFCom é 62');
    assert.equal(p.serie, '001');
    assert.equal(p.nNF, '000000123');
    assert.equal(p.tpEmis, '1');
    assert.equal(p.nSiteAutoriz, '0', 'campo que a NF-e não tem');
    assert.equal(p.cNF, '1234567', 'sete dígitos, não oito');
    assert.ok(p.confere);
    // As posições, contadas como o manual conta.
    assert.equal(r.chave.slice(0, 2), '41');
    assert.equal(r.chave.slice(20, 22), '62');
    assert.equal(r.chave.slice(34, 35), '1', 'tpEmis é a 35ª posição');
    assert.equal(r.chave.slice(35, 36), '0', 'nSiteAutoriz é a 36ª posição');
    assert.equal(r.chave.slice(36, 43), '1234567', 'cNF ocupa da 37ª à 43ª');
  });

  await t.test('código numérico vem do gerador criptográfico e não se repete', () => {
    const vistos = new Set();
    for (let i = 0; i < 500; i++) {
      const c = chave.codigoNumerico();
      assert.match(c, /^\d{7}$/);
      vistos.add(c);
    }
    assert.ok(vistos.size > 480, `esperava variedade, veio ${vistos.size} valores distintos em 500`);
  });

  await t.test('chave adulterada não passa na conferência', () => {
    const r = chave.montar({ cUF: 35, ano: 2026, mes: 11, cnpj: '45997418000153', serie: 1, numero: 7 });
    assert.ok(chave.conferir(r.chave));
    for (let i = 0; i < 43; i++) {
      const trocado = r.chave.slice(0, i) + String((Number(r.chave[i]) + 1) % 10) + r.chave.slice(i + 1);
      assert.equal(chave.conferir(trocado), false, `trocar o dígito ${i} tinha de invalidar`);
    }
  });

  await t.test('a chave do DANFE sai em 11 blocos de 4', () => {
    const r = chave.montar({ cUF: 41, ano: 2026, mes: 11, cnpj: '45997418000153', serie: 1, numero: 1 });
    const f = chave.formatar(r.chave);
    assert.equal(f.split(' ').length, 11);
    assert.ok(f.split(' ').every((b) => b.length === 4));
    assert.equal(f.replace(/ /g, ''), r.chave);
  });
});

test('tabelas oficiais', async (t) => {
  await t.test('o provedor de internet fatura mensalidade como 0400401', () => {
    assert.equal(tabelas.PARA_O_PROVEDOR.mensalidade, '0400401');
    assert.equal(tabelas.CCLASS['0400401'], 'Provimento à internet');
    assert.equal(tabelas.CCLASS[tabelas.PARA_O_PROVEDOR.equipamento], 'Roteador');
  });

  await t.test('todo cClass sugerido existe na tabela oficial', () => {
    for (const [tipo, codigo] of Object.entries(tabelas.PARA_O_PROVEDOR)) {
      assert.ok(tabelas.CCLASS[codigo], `${tipo} aponta para ${codigo}, que não está na tabela`);
      assert.match(codigo, /^\d{7}$/);
    }
  });

  await t.test('código iniciado em 5 DEDUZ do total; os demais somam', () => {
    assert.equal(tabelas.deduz('5900201'), true, 'dedução por ajuste de conta');
    assert.equal(tabelas.deduz('0400401'), false);
    assert.equal(tabelas.deduz('1000301'), false, 'juros somam');
    assert.equal(tabelas.deduz(tabelas.PARA_O_PROVEDOR.desconto), true, 'o desconto precisa deduzir');
  });

  await t.test('código de UF confere com o do IBGE, nos dois sentidos', () => {
    assert.equal(tabelas.CUF.SP, 35);
    assert.equal(tabelas.CUF.PR, 41);
    assert.equal(tabelas.CUF.RS, 43);
    assert.equal(Object.keys(tabelas.CUF).length, 27);
    for (const [uf, c] of Object.entries(tabelas.CUF)) assert.equal(tabelas.UF_DE[c], uf);
  });

  await t.test('MG, MS e MT autorizam por conta própria; o resto é SVRS', () => {
    assert.equal(tabelas.autorizadorDe('MG'), 'MG');
    assert.equal(tabelas.autorizadorDe('ms'), 'MS');
    assert.equal(tabelas.autorizadorDe('SP'), 'SVRS');
    assert.equal(tabelas.autorizadorDe('PR'), 'SVRS');
  });

  await t.test('ENDEREÇO NÃO CONFIRMADO FICA SEM ENDEREÇO', () => {
    // Inventar a URL de um autorizador seria pior do que não ter: a nota iria para lugar nenhum.
    assert.equal(tabelas.AUTORIZADORES.SVRS.confirmado, true);
    assert.ok(tabelas.AUTORIZADORES.SVRS[1].recepcao.startsWith('https://'));
    assert.ok(tabelas.AUTORIZADORES.SVRS[2].recepcao.includes('homologacao'));
    for (const uf of ['MG', 'MS', 'MT']) {
      assert.equal(tabelas.AUTORIZADORES[uf].confirmado, false);
      assert.equal(tabelas.AUTORIZADORES[uf][1], undefined, `${uf} não pode ter endereço inventado`);
    }
  });

  await t.test('alíquota de ano sem lei publicada é nula, não zero', () => {
    assert.equal(tabelas.aliquotasRTC(2026).pCBS, '0.90');
    assert.equal(tabelas.aliquotasRTC(2027).pCBS, null, 'ainda não publicada: nulo, para o sistema recusar');
    assert.equal(tabelas.aliquotasRTC(2035), null);
  });
});

test('XML na forma canônica', async (t) => {
  await t.test('elemento vazio nunca vira <a/>', () => {
    assert.equal(x.grupo('a', [], { sempre: true }), '<a></a>');
    assert.equal(x.grupo('a', [], { attrs: { b: '1' }, sempre: true }), '<a b="1"></a>');
  });

  await t.test('campo sem valor some; zero fica', () => {
    assert.equal(x.tag('a', null), '');
    assert.equal(x.tag('a', undefined), '');
    assert.equal(x.tag('a', ''), '');
    assert.equal(x.tag('a', 0), '<a>0</a>', 'zero é um valor, não um vazio');
    assert.equal(x.tag('a', '0'), '<a>0</a>');
  });

  await t.test('escape de texto inclui o ">", como a C14N exige', () => {
    assert.equal(x.tag('a', 'PÃO & CIA <LTDA> "x"'), '<a>PÃO &amp; CIA &lt;LTDA&gt; "x"</a>');
    assert.equal(x.escapar('a\rb'), 'a&#xD;b');
  });

  await t.test('escape de atributo NÃO escapa ">" e escapa as aspas e os brancos', () => {
    assert.equal(x.escaparAtributo('a>b"c&d<e'), 'a>b&quot;c&amp;d&lt;e');
    assert.equal(x.escaparAtributo('a\tb\nc'), 'a&#x9;b&#xA;c');
  });

  await t.test('atributos saem em ordem: namespace primeiro, depois por nome', () => {
    const ordem = x.ordenarAtributos({ versao: '1.00', Id: 'NFCom1', xmlns: 'u' }).map(([k]) => k);
    assert.deepEqual(ordem, ['xmlns', 'Id', 'versao']);
    assert.deepEqual(x.ordenarAtributos({ c: 1, a: 2, b: 3 }).map(([k]) => k), ['a', 'b', 'c']);
  });

  await t.test('valores saem com ponto decimal e duas casas', () => {
    assert.equal(x.valor(8990), '89.90');
    assert.equal(x.valor(100000), '1000.00');
    assert.equal(x.valor(5), '0.05');
    assert.equal(x.valor(0), '0.00');
    assert.equal(x.valor(-1050), '-10.50');
    assert.equal(x.valor(null), null);
    assert.equal(x.percentual(18), '18.00');
    assert.equal(x.quantidade(1), '1.0000');
  });

  await t.test('data e hora saem com fuso em horas cheias', () => {
    assert.equal(x.dataHora('2026-11-21T15:30:00.000Z', -3), '2026-11-21T12:30:00-03:00');
    assert.equal(x.dataHora('2026-01-01T01:00:00.000Z', -3), '2025-12-31T22:00:00-03:00');
  });

  await t.test('texto livre perde quebra de linha e espaço sobrando, e é cortado no limite', () => {
    assert.equal(x.texto('  João  da \n Silva  '), 'João da Silva');
    assert.equal(x.texto('abcdefghij', 4), 'abcd');
    assert.equal(x.texto('   '), null);
  });

  await t.test('dígitos saem com zeros à esquerda', () => {
    assert.equal(x.digitos('45.997.418/0001-53', 14), '45997418000153');
    assert.equal(x.digitos('1', 3), '001');
    assert.equal(x.digitos('', 3), null);
  });
});

test('PKCS#12: abrir o certificado e tirar a chave', { skip: !temOpenssl() && 'openssl não disponível' }, async (t) => {
  await t.test('abre o formato novo e o antigo, e a chave assina de verdade', () => {
    for (const legado of [false, true]) {
      const c = criarCertificado({ legado, nome: 'PROVEDOR TESTE LTDA', cnpj: '45997418000153' });
      const r = pkcs12.abrir(c.bytes, c.senha);
      const texto = Buffer.from('conteúdo que será assinado');
      const assinado = crypto.sign('sha1', texto, r.chave);
      assert.ok(crypto.verify('sha1', texto, r.certificado.publicKey, assinado),
        `a chave aberta precisa casar com o certificado (formato ${legado ? 'antigo' : 'novo'})`);
      assert.match(r.certificadoPem, /BEGIN CERTIFICATE/);
      assert.match(r.chavePem, /BEGIN PRIVATE KEY/);
      assert.ok(r.certificadoDer.length > 100);
    }
  });

  await t.test('RC2 confere com todos os vetores da RFC 2268', () => {
    const vetores = [
      ['0000000000000000', 63, '0000000000000000', 'ebb773f993278eff'],
      ['ffffffffffffffff', 64, 'ffffffffffffffff', '278b27e42e2f0d49'],
      ['3000000000000000', 64, '1000000000000001', '30649edf9be7d2c2'],
      ['88', 64, '0000000000000000', '61a8a244adacccf0'],
      ['88bca90e90875a', 64, '0000000000000000', '6ccf4308974c267f'],
      ['88bca90e90875a7f0f79c384627bafb2', 64, '0000000000000000', '1a807d272bbe5db1'],
      ['88bca90e90875a7f0f79c384627bafb2', 128, '0000000000000000', '2269552ab0f85ca6'],
      ['88bca90e90875a7f0f79c384627bafb216f80a6f85920584c42fceb0be255daf1e', 129, '0000000000000000', '5b78d3a43dfff1f1'],
    ];
    for (const [k, bits, claro, cifrado] of vetores) {
      const saida = rc2.decifrarBruto(Buffer.from(k, 'hex'), Buffer.alloc(8), Buffer.from(cifrado, 'hex'), bits);
      assert.equal(saida.toString('hex'), claro, `vetor de ${k.length / 2} bytes, ${bits} bits`);
    }
  });

  await t.test('senha errada não entrega lixo: recusa com motivo', () => {
    const c = criarCertificado({ legado: true });
    assert.throws(() => pkcs12.abrir(c.bytes, 'outra senha'), /[Ss]enha do certificado incorreta/);
  });

  await t.test('arquivo que não é certificado é recusado', () => {
    assert.throws(() => pkcs12.abrir(Buffer.from('nem de longe um pfx'), 'x'), /não é um certificado PKCS#12/);
  });
});

test('assinatura XML da NFCom', { skip: !temOpenssl() && 'openssl não disponível' }, async (t) => {
  const c = criarCertificado({ nome: 'PROVEDOR TESTE LTDA', cnpj: '45997418000153' });
  const { chave: privada, certificadoDer, certificado } = pkcs12.abrir(c.bytes, c.senha);
  const id = 'NFCom41261145997418000153620010000001231012345678';
  const canonico = `<infNFCom xmlns="${tabelas.NAMESPACE}" Id="${id}" versao="1.00"><ide><cUF>41</cUF></ide></infNFCom>`;
  const sig = assinatura.assinar({ canonicoAssinado: canonico, id, chave: privada, certificadoDer });

  await t.test('usa os algoritmos que a SEFAZ exige, não os que seriam melhores', () => {
    assert.match(sig, /Algorithm="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#rsa-sha1"/);
    assert.match(sig, /Algorithm="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#sha1"/);
    assert.match(sig, /Algorithm="http:\/\/www\.w3\.org\/TR\/2001\/REC-xml-c14n-20010315"/);
    assert.match(sig, /Algorithm="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#enveloped-signature"/);
  });

  await t.test('aponta para o Id do infNFCom', () => {
    assert.ok(sig.includes(`URI="#${id}"`), 'a referência é a tralha mais o Id');
  });

  await t.test('KeyInfo leva só o certificado — nada de SubjectName, IssuerSerial ou KeyValue', () => {
    assert.match(sig, /<KeyInfo><X509Data><X509Certificate>/);
    for (const proibido of ['X509SubjectName', 'X509IssuerSerial', 'X509IssuerName', 'X509SerialNumber', 'X509SKI', 'KeyValue', 'RSAKeyValue']) {
      assert.ok(!sig.includes(proibido), `${proibido} não pode aparecer`);
    }
  });

  await t.test('o namespace da assinatura é declarado no Signature, e só nele', () => {
    assert.match(sig, /^<Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/);
    assert.equal(sig.match(/xmlns=/g).length, 1);
  });

  await t.test('o resumo é do conteúdo assinado, e muda se o conteúdo mudar', () => {
    const esperado = crypto.createHash('sha1').update(canonico, 'utf8').digest('base64');
    assert.ok(sig.includes(`<DigestValue>${esperado}</DigestValue>`));
    const r = assinatura.conferir({ xmlAssinado: sig, canonicoAssinado: canonico });
    assert.equal(r.ok, true, r.motivo);
    const adulterado = canonico.replace('<cUF>41</cUF>', '<cUF>35</cUF>');
    const r2 = assinatura.conferir({ xmlAssinado: sig, canonicoAssinado: adulterado });
    assert.equal(r2.ok, false);
    assert.match(r2.motivo, /mudou depois de assinado/);
  });

  await t.test('assinatura trocada não passa', () => {
    const outro = criarCertificado({ nome: 'OUTRO PROVEDOR LTDA', cnpj: '11222333000181' });
    const o = pkcs12.abrir(outro.bytes, outro.senha);
    const sigOutro = assinatura.assinar({ canonicoAssinado: canonico, id, chave: o.chave, certificadoDer });
    // Assinado com a chave de um, com o certificado de outro anexado: tem de ser recusado.
    const r = assinatura.conferir({ xmlAssinado: sigOutro, canonicoAssinado: canonico });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /não confere com o certificado/);
  });

  await t.test('O OPENSSL, POR FORA, CONFIRMA A ASSINATURA', () => {
    /*
     * A conferência de dentro usa o mesmo código que assinou — se a montagem do SignedInfo estivesse
     * errada, ela não perceberia. Aqui quem valida é o openssl, que não sabe nada deste sistema: ele
     * recebe o certificado, os bytes do SignedInfo canônico e a assinatura, e diz se fecham.
     */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsig-'));
    try {
      const signedInfo = /<SignedInfo>([\s\S]*?)<\/SignedInfo>/.exec(sig)[1];
      const bytes = Buffer.from(`<SignedInfo xmlns="${assinatura.NS_DSIG}">${signedInfo}</SignedInfo>`, 'utf8');
      const valor = /<SignatureValue>([^<]*)<\/SignatureValue>/.exec(sig)[1];
      fs.writeFileSync(path.join(dir, 'signedinfo.xml'), bytes);
      fs.writeFileSync(path.join(dir, 'sig.bin'), Buffer.from(valor, 'base64'));
      fs.writeFileSync(path.join(dir, 'pub.pem'), certificado.publicKey.export({ type: 'spki', format: 'pem' }));
      const saida = execFileSync('openssl', ['dgst', '-sha1', '-verify', path.join(dir, 'pub.pem'),
        '-signature', path.join(dir, 'sig.bin'), path.join(dir, 'signedinfo.xml')], { encoding: 'utf8' });
      assert.match(saida, /Verified OK/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
