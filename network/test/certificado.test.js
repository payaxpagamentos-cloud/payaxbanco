'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const { criarCertificado, temOpenssl } = require('./certificado-falso');
const cert = require('../server/lib/certificado');

const CNPJ_DA_ORG = '11.222.333/0001-81';

/** Põe o CNPJ na organização, para o sistema poder conferir contra o do certificado. */
async function comCnpj(api, admin) {
  const r = await api.patch('/organizacao', { documento: CNPJ_DA_ORG }, admin);
  return r.status === 200;
}

test('certificado digital: leitura, validação e o formato antigo que o Node recusa', { skip: !temOpenssl() && 'openssl não disponível' }, async (t) => {
  await t.test('lê titular, CNPJ, emissor e validade do PRÓPRIO arquivo', () => {
    const c = criarCertificado({ nome: 'PROVEDOR EXEMPLO LTDA', cnpj: '11222333000181' });
    const d = cert.ler(c.bytes, c.senha);
    assert.equal(d.titular, 'PROVEDOR EXEMPLO LTDA');
    assert.equal(d.documento, '11222333000181', 'o CNPJ sai do nome comum, no padrão ICP-Brasil');
    assert.match(d.emissor, /ICP-Brasil/);
    assert.ok(d.valido_ate > d.valido_de);
    assert.ok(d.impressao.length > 40, 'impressão digital identifica o arquivo');
    assert.equal(d.bytes, c.bytes.length);
  });

  await t.test('certificado sem CNPJ no nome não ganha um inventado', () => {
    const c = criarCertificado({ nome: 'PESSOA SEM CNPJ', cnpj: '' });
    assert.equal(cert.ler(c.bytes, c.senha).documento, null);
  });

  await t.test('senha errada é recusada com a palavra "senha"', () => {
    const c = criarCertificado();
    assert.throws(() => cert.ler(c.bytes, 'nao-e-essa'), /[Ss]enha/);
  });

  await t.test('arquivo que não é certificado é recusado', () => {
    assert.throws(() => cert.ler(Buffer.from('isto não é um certificado'), 'x'), /certificado/i);
    assert.throws(() => cert.ler(Buffer.alloc(0), 'x'), /Envie o arquivo/);
  });

  await t.test('FORMATO ANTIGO (RC2-40) ABRE — é o formato de muito A1 brasileiro', () => {
    /*
     * Este é o caso que o OpenSSL 3 recusa: ele moveu o RC2 para o provedor legado e o Node não o liga.
     * O sistema abre o arquivo por conta própria (lib/fiscal/pkcs12.js + rc2.js), então o que antes era
     * uma recusa com instruções de conversão hoje é só um certificado que funciona.
     */
    const c = criarCertificado({ legado: true, nome: 'PROVEDOR ANTIGO LTDA', cnpj: '11222333000181' });
    const d = cert.ler(c.bytes, c.senha);
    assert.equal(d.titular, 'PROVEDOR ANTIGO LTDA');
    assert.equal(d.documento, '11222333000181');
    assert.ok(d.valido_ate > d.valido_de);
  });

  await t.test('senha errada diz que é senha errada, em qualquer formato de arquivo', () => {
    for (const legado of [false, true]) {
      const c = criarCertificado({ legado });
      assert.throws(() => cert.ler(c.bytes, 'senha-que-nao-e-a-dele'), /[Ss]enha do certificado incorreta/,
        `formato ${legado ? 'antigo' : 'novo'}`);
    }
  });

  await t.test('situação diz quanto tempo falta, e trata vencido como vencido', () => {
    const base = { valido_de: '2026-01-01T00:00:00.000Z', valido_ate: '2026-12-31T00:00:00.000Z' };
    assert.equal(cert.situacao(null).estado, 'ausente');
    assert.equal(cert.situacao(base, '2026-06-01').estado, 'valido');
    assert.equal(cert.situacao(base, '2026-12-20').estado, 'vencendo');
    assert.match(cert.situacao(base, '2026-12-20').texto, /Renove/);
    assert.equal(cert.situacao(base, '2027-01-05').estado, 'vencido');
    assert.match(cert.situacao(base, '2027-01-05').texto, /Nenhuma obrigação/);
    assert.equal(cert.situacao(base, '2025-12-01').estado, 'futuro');
  });
});

test('certificado digital: instalar, usar e remover pela API', { skip: !temOpenssl() && 'openssl não disponível' }, async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const admin = await api.login();
  const r = await api.post('/organizacao/usuarios', { nome: 'NOC', email: 'noc.cert@teste.local', senha: 'senha-teste-123', perfil: 'noc' }, admin);
  assert.equal(r.status, 201);
  const noc = await api.login('noc.cert@teste.local', 'senha-teste-123');
  const temCnpj = await comCnpj(api, admin);

  await t.test('sem certificado, a tela diz o que falta em cada integração', async () => {
    const d = (await api.get('/certificado', noc)).dados;
    assert.equal(d.certificado, null);
    assert.equal(d.situacao.estado, 'ausente');
    assert.equal(d.integracoes.length, 3);
    for (const i of d.integracoes) {
      assert.equal(i.certificado_ok, false);
      assert.equal(i.pronta, false);
      assert.ok(i.faltando.includes('Certificado e-CNPJ instalado'));
      assert.match(i.observacao, /ainda não está escrito/i, 'não promete integração que não existe');
    }
  });

  await t.test('só o administrador instala', async () => {
    const c = criarCertificado();
    assert.equal((await api.post('/certificado', { apelido: 'x', arquivo: c.base64, senha: c.senha }, noc)).status, 403);
  });

  let instalado;
  await t.test('instala e responde com o que o certificado diz de si — nunca com o arquivo', async () => {
    const c = criarCertificado({ nome: 'PROVEDOR DEMONSTRACAO LTDA', cnpj: '11222333000181' });
    const resp = await api.post('/certificado', { apelido: 'e-CNPJ 2026', arquivo: c.base64, senha: c.senha }, admin);
    assert.equal(resp.status, 201, JSON.stringify(resp.dados));
    instalado = resp.dados;
    assert.equal(instalado.titular, 'PROVEDOR DEMONSTRACAO LTDA');
    assert.equal(instalado.documento, '11222333000181');
    assert.equal(instalado.situacao.estado, 'valido');
    const texto = JSON.stringify(instalado);
    assert.ok(!texto.includes(c.senha), 'a senha não volta na resposta');
    assert.ok(!texto.includes(c.base64.slice(0, 60)), 'o arquivo não volta na resposta');
  });

  await t.test('o arquivo e a senha ficam CIFRADOS no banco', async () => {
    const linha = api.db.prepare('SELECT * FROM certificados WHERE ativo = 1').get();
    assert.ok(linha.arquivo_cifrado.startsWith('v1.'), 'o arquivo está no formato cifrado do cofre');
    assert.ok(linha.senha_cifrada.startsWith('v1.'));
    assert.ok(!linha.senha_cifrada.includes('senha-do-certificado'));
    assert.equal(linha.titular, 'PROVEDOR DEMONSTRACAO LTDA');
  });

  await t.test('GET nunca devolve arquivo nem senha', async () => {
    const d = (await api.get('/certificado', noc)).dados;
    const texto = JSON.stringify(d);
    assert.ok(!texto.includes('arquivo_cifrado'));
    assert.ok(!texto.includes('senha_cifrada'));
    assert.equal(d.certificado.titular, 'PROVEDOR DEMONSTRACAO LTDA');
    assert.ok(d.integracoes.every((i) => i.certificado_ok), 'com certificado válido, esse requisito sai da lista');
    assert.ok(d.integracoes.every((i) => !i.pronta), 'mas a integração continua não pronta, e a tela diz isso');
  });

  await t.test('a auditoria guarda o que identifica, não o conteúdo', async () => {
    const a = (await api.get('/organizacao/auditoria?acao=certificado_instalado', admin)).dados;
    const ev = a.itens[0];
    const texto = JSON.stringify(ev);
    assert.ok(texto.includes('PROVEDOR DEMONSTRACAO'), 'identifica o certificado');
    assert.ok(!texto.includes('senha-do-certificado'), 'mas não grava a senha');
  });

  await t.test('testar confere que o guardado ainda abre e é o mesmo', async () => {
    const d = (await api.post('/certificado/testar', {}, noc)).dados;
    assert.equal(d.ok, true);
    assert.equal(d.confere, true);
    assert.equal(d.estado, 'valido');
    assert.equal(d.aviso, null);
  });

  await t.test('usar() entrega o arquivo decifrado só para dentro do servidor', () => {
    const u = cert.usar(api.db, 1);
    assert.ok(Buffer.isBuffer(u.pfx));
    assert.equal(u.passphrase, 'senha-do-certificado');
    const relido = cert.ler(u.pfx, u.passphrase);
    assert.equal(relido.documento, '11222333000181', 'o que saiu do cofre é o mesmo que entrou');
    assert.ok(api.db.prepare('SELECT ultimo_uso_em FROM certificados WHERE ativo = 1').get().ultimo_uso_em, 'o uso fica registrado');
  });

  await t.test('instalar outro desativa o anterior: só um ativo por vez', async () => {
    const c = criarCertificado({ nome: 'PROVEDOR DEMONSTRACAO LTDA', cnpj: '11222333000181' });
    const resp = await api.post('/certificado', { apelido: 'e-CNPJ renovado', arquivo: c.base64, senha: c.senha }, admin);
    assert.equal(resp.status, 201, JSON.stringify(resp.dados));
    assert.equal(resp.dados.substituiu, 'e-CNPJ 2026');
    assert.match(resp.dados.aviso, /desativado/i);
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM certificados WHERE ativo = 1').get().n, 1);
    const h = (await api.get('/certificado', admin)).dados.historico;
    assert.equal(h.length, 2, 'o anterior continua no histórico, não é apagado');
    assert.match(h.find((x) => !x.ativo).motivo_remocao, /Substituído/);
  });

  await t.test('CERTIFICADO DE OUTRO CNPJ É RECUSADO', async (st) => {
    if (!temCnpj) return st.skip('a organização de teste não tem CNPJ cadastrado');
    const c = criarCertificado({ nome: 'OUTRA EMPRESA LTDA', cnpj: '19131243000197' });
    const resp = await api.post('/certificado', { apelido: 'errado', arquivo: c.base64, senha: c.senha }, admin);
    assert.equal(resp.status, 422);
    assert.match(resp.dados.erro, /outro CNPJ/i);
    assert.match(resp.dados.erro, /19131243000197/);
  });

  await t.test('certificado vencido não é instalado', () => {
    // Avaliado a partir de uma data depois da validade: é o mesmo caminho de código do dia a dia.
    const c = criarCertificado({ dias: 30 });
    const depoisDoVencimento = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
    assert.throws(
      () => cert.instalar(api.db, { org: 1, apelido: 'vencido', pfx: c.bytes, senha: c.senha, hoje: depoisDoVencimento }),
      /venceu/i,
      'instalar um certificado vencido só adiaria a descoberta do problema',
    );
  });

  await t.test('remover exige motivo e avisa a consequência', async () => {
    assert.equal((await api.req('DELETE', '/certificado', {}, admin)).status, 422);
    const d = await api.req('DELETE', '/certificado', { motivo: 'Certificado comprometido' }, admin);
    assert.equal(d.status, 200, JSON.stringify(d.dados));
    assert.match(d.dados.aviso, /nenhuma obrigação pode ser assinada/i);
    assert.equal((await api.get('/certificado', noc)).dados.certificado, null);
    assert.equal((await api.post('/certificado/testar', {}, noc)).status, 404);
  });

  await t.test('outra organização não enxerga o certificado desta', async () => {
    const c = criarCertificado();
    await api.post('/certificado', { apelido: 'ativo', arquivo: c.base64, senha: c.senha, conferir_cnpj: false }, admin);
    const outro = await api.outraOrganizacao();
    assert.equal((await api.get('/certificado', outro)).dados.certificado, null);
    assert.equal((await api.post('/certificado/testar', {}, outro)).status, 404);
  });
});
