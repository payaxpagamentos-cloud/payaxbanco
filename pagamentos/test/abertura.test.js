'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
process.env.PAYAX_ARQUIVOS = fs.mkdtempSync(path.join(os.tmpdir(), 'payax-arquivos-'));
process.env.PAYAX_SITE_HOSTS = 'payax.com.br';
const { iniciar, CNPJ, CPF } = require('./helpers');
const abertura = require('../server/lib/abertura');

const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64')}`;
const pedido = (extra = {}) => ({
  aceite: true,
  empresa: { cnpj: '11.222.333/0001-81', razao_social: 'Provedor Exemplo Ltda', nome_fantasia: 'Exemplo Net', email: 'contato@exemplo.com.br',
    telefone: '(11) 3333-4444', cep: '01001-000', endereco: 'Praça da Sé', numero: '100', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP' },
  representante: { nome: 'Maria Sócia', cpf: CPF, cargo: 'Sócia-administradora', email: 'maria@exemplo.com.br', telefone: '11999998888' },
  financeiro: { nome: 'João Financeiro', email: 'financeiro@exemplo.com.br', telefone: '11988887777' },
  destino: { banco: '237', agencia: '1234', conta: '56789', conta_dv: '0', tipo: 'corrente', pix_tipo: 'cnpj', pix_chave: '11.222.333/0001-81' },
  documentos: { contrato_social: { nome: 'contrato.pdf', conteudo: PDF } },
  ...extra,
});

/** POST com Host do site (o fetch não deixa trocar o Host). */
function postarNoSite(raiz, caminho, corpo) {
  const u = new URL(raiz);
  const dados = Buffer.from(JSON.stringify(corpo));
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: caminho, method: 'POST',
      headers: { Host: 'payax.com.br', 'Content-Type': 'application/json', 'Content-Length': dados.length } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, dados: JSON.parse(t || '{}') }));
    });
    r.on('error', reject);
    r.end(dados);
  });
}

test('abertura de conta pelo site', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();

  await t.test('o site tem a página e envia o pedido pelo próprio domínio', async () => {
    const pagina = await new Promise((ok) => http.get({ hostname: '127.0.0.1', port: new URL(api.raiz).port, path: '/abrir-conta', headers: { Host: 'payax.com.br' } },
      (res) => { let c = ''; res.on('data', (x) => { c += x; }); res.on('end', () => ok({ status: res.statusCode, corpo: c })); }));
    assert.equal(pagina.status, 200);
    assert.match(pagina.corpo, /Contrato social/);
    const r = await postarNoSite(api.raiz, '/api/publico/abertura', pedido());
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.match(r.dados.protocolo, /^AB-\d{6}$/);
  });

  await t.test('pedido repetido para o mesmo CNPJ não entra', async () => {
    const r = await api.post('/api/publico/abertura', pedido());
    assert.equal(r.status, 409);
  });

  await t.test('validações: aceite, contrato social, arquivo de verdade, conta da própria empresa, robô', async () => {
    const outro = (x) => pedido({ empresa: { ...pedido().empresa, cnpj: CNPJ.beta }, destino: { ...pedido().destino, pix_chave: CNPJ.beta }, ...x });
    assert.equal((await api.post('/api/publico/abertura', outro({ aceite: false }))).status, 422);
    assert.equal((await api.post('/api/publico/abertura', outro({ documentos: {} }))).status, 422);
    const falso = `data:application/pdf;base64,${Buffer.from('MZ isto não é PDF').toString('base64')}`;
    const r1 = await api.post('/api/publico/abertura', outro({ documentos: { contrato_social: { nome: 'x.pdf', conteudo: falso } } }));
    assert.equal(r1.status, 422);
    assert.match(r1.dados.erro, /não é um PDF válido/);
    const r2 = await api.post('/api/publico/abertura', outro({ destino: { ...pedido().destino, pix_tipo: 'cpf', pix_chave: CPF } }));
    assert.equal(r2.status, 422, 'chave PIX de CPF (pessoa física) não');
    const pixDeOutro = await api.post('/api/publico/abertura', outro({ destino: { ...pedido().destino, pix_chave: CNPJ.alfa } }));
    assert.match(pixDeOutro.dados.erro, /CNPJ do próprio cliente/, 'chave de CNPJ de outra empresa não');
    const semPix = await api.post('/api/publico/abertura', outro({ destino: { ...pedido().destino, pix_chave: '' } }));
    assert.equal(semPix.status, 422);
    assert.match(semPix.dados.erro, /chave PIX/);
    const semConta = await api.post('/api/publico/abertura', outro({ destino: { pix_tipo: 'cnpj', pix_chave: CNPJ.beta } }));
    assert.equal(semConta.status, 422);
    assert.match(semConta.dados.erro, /conta bancária/);
    assert.equal((await api.post('/api/publico/abertura', outro({ site: 'http://spam' }))).status, 400);
    const r3 = await api.post('/api/publico/abertura', outro({ representante: { ...pedido().representante, cpf: '12345678900' } }));
    assert.equal(r3.status, 422);
  });

  const id = api.db.prepare('SELECT id FROM solicitacoes_abertura ORDER BY id LIMIT 1').get().id;

  await t.test('a equipe vê o pedido, o documento e o alerta no painel', async () => {
    assert.equal((await api.get('/api/aberturas', tk.consulta)).status, 403);
    const l = await api.get('/api/aberturas', tk.operacao);
    assert.equal(l.status, 200);
    assert.equal(l.dados.itens.length, 1);
    assert.equal(l.dados.contagem.nova, 1);
    const d = (await api.get(`/api/aberturas/${id}`, tk.financeiro)).dados;
    assert.equal(d.representante.nome, 'Maria Sócia');
    assert.equal(d.arquivos[0].tipo, 'contrato_social');
    assert.equal(d.arquivos[0].arquivo, undefined, 'o caminho no disco não sai na API');
    const doc = await api.get(`/api/aberturas/${id}/arquivo/0`, tk.financeiro);
    assert.equal(doc.status, 200);
    assert.match(String(doc.dados), /^%PDF-/);
    assert.ok(api.db.prepare("SELECT 1 FROM auditoria WHERE acao = 'abertura.documento_aberto'").get());
    const painel = (await api.get('/api/painel', tk.admin)).dados;
    assert.ok(painel.alertas.some((a) => a.tipo === 'aberturas'));
  });

  await t.test('operação não aprova; financeiro aprova e cria cliente em implantação com acesso', async () => {
    assert.equal((await api.post(`/api/aberturas/${id}/aprovar`, {}, tk.operacao)).status, 403);
    assert.equal((await api.post(`/api/aberturas/${id}/analisar`, {}, tk.operacao)).status, 200);
    const r = await api.post(`/api/aberturas/${id}/aprovar`, {}, tk.financeiro);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    const c = api.db.prepare('SELECT * FROM clientes WHERE id = ?').get(r.dados.cliente_id);
    assert.equal(c.situacao, 'implantacao');
    assert.equal(c.cnpj, '11222333000181');
    assert.equal(c.destino_banco, '237');
    assert.equal(c.destino_documento, '11222333000181');
    assert.equal(c.pix_chave, '11222333000181');
    assert.equal(c.pix_tipo, 'cnpj');
    assert.ok(c.conta_interna, 'recebe o código do cliente');
    assert.equal(JSON.parse(c.kyc_representantes)[0].documento, CPF);
    assert.equal(r.dados.acesso.email, 'financeiro@exemplo.com.br');
    assert.match(r.dados.acesso.senha_provisoria, /^[a-z2-9]{6}-[a-z2-9]{4}$/);
    const login = await api.post('/cliente/api/auth/login', { email: 'financeiro@exemplo.com.br', senha: r.dados.acesso.senha_provisoria });
    assert.equal(login.status, 200);
    assert.equal((await api.post(`/api/aberturas/${id}/aprovar`, {}, tk.financeiro)).status, 409, 'não aprova duas vezes');
    // Já é cliente: o site não aceita novo pedido para o mesmo CNPJ.
    const de_novo = await api.post('/api/publico/abertura', pedido());
    assert.equal(de_novo.status, 409);
    assert.match(de_novo.dados.erro, /já é cliente/);
  });

  await t.test('recusa com motivo e, depois do prazo, documentos apagados e dados anonimizados', async () => {
    const r = await api.post('/api/publico/abertura', pedido({ empresa: { ...pedido().empresa, cnpj: CNPJ.beta, razao_social: 'Beta Ltda' },
      financeiro: { nome: 'Ana', email: 'ana@beta.com.br', telefone: '11977776666' },
      destino: { ...pedido().destino, pix_chave: CNPJ.beta } }));
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    const idB = Number(r.dados.protocolo.slice(3));
    assert.equal((await api.post(`/api/aberturas/${idB}/recusar`, {}, tk.financeiro)).status, 422, 'motivo obrigatório');
    assert.equal((await api.post(`/api/aberturas/${idB}/recusar`, { motivo: 'Contrato social ilegível' }, tk.financeiro)).status, 200);
    const pasta = path.join(process.env.PAYAX_ARQUIVOS, 'abertura', String(idB));
    assert.ok(fs.existsSync(pasta));
    api.db.prepare("UPDATE solicitacoes_abertura SET analisado_em = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(idB);
    assert.equal(abertura.aplicarRetencao(api.db), 1);
    assert.ok(!fs.existsSync(pasta));
    const s = api.db.prepare('SELECT * FROM solicitacoes_abertura WHERE id = ?').get(idB);
    assert.equal(s.dados, '{}');
    assert.equal(s.ip, null);
  });
});
