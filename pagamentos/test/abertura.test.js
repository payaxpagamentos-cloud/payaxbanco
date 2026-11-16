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

let ativacaoAprovada = null;

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

  await t.test('CRM: etapa, responsável, histórico, checklist e proposta', async () => {
    assert.equal((await api.put(`/api/aberturas/${id}/etapa`, { etapa: 'em_analise' }, tk.consulta)).status, 403);
    const m = await api.put(`/api/aberturas/${id}/etapa`, { etapa: 'em_analise' }, tk.operacao);
    assert.equal(m.status, 200);
    assert.equal(m.dados.situacao, 'em_analise');
    assert.equal(m.dados.responsavel_nome, 'Usuário operacao', 'quem move primeiro vira o responsável');
    assert.equal((await api.put(`/api/aberturas/${id}/etapa`, { etapa: 'aprovada' }, tk.operacao)).status, 422, 'aprovar só pelo botão');
    const eq = (await api.get('/api/aberturas/equipe', tk.operacao)).dados;
    assert.ok(eq.some((u) => u.perfil === 'financeiro'));
    assert.equal((await api.put(`/api/aberturas/${id}/responsavel`, { usuario_id: tk.financeiro_id }, tk.operacao)).dados.responsavel_nome, 'Usuário financeiro');
    assert.equal((await api.post(`/api/aberturas/${id}/interacoes`, { tipo: 'ligacao', texto: 'Liguei para o João, vai mandar a alteração contratual.' }, tk.operacao)).status, 201);

    // Sem checklist e sem proposta, não aprova — e diz o que falta.
    const cedo = await api.post(`/api/aberturas/${id}/aprovar`, {}, tk.financeiro);
    assert.equal(cedo.status, 422);
    assert.match(cedo.dados.erro, /checklist/);
    assert.match(cedo.dados.erro, /Proposta comercial/);

    const d0 = (await api.get(`/api/aberturas/${id}`, tk.financeiro)).dados;
    for (const item of d0.checklist) {
      assert.equal((await api.put(`/api/aberturas/${id}/checklist/${item.chave}`, { feito: true }, tk.operacao)).status, 200);
    }
    // Proposta: tarifas e limites. Operação não mexe em preço.
    const proposta = { tarifa_emissao: '0,50', tarifa_fixa: 'R$ 1,99', percentual: '0', tarifa_repasse: '0,00', comissao_minima: '0',
      bolepix_proprio: '1', bolepix_tarifa_fixa: '2,49', limite_boleto: 'R$ 3.000,00', limite_mensal: 'R$ 150.000,00', entrega: 'pix',
      faturamento_mensal: 'R$ 200.000,00', boletos_mes: '1.500', sistema: 'ixc', observacao_proposta: 'Primeiros 3 meses sem tarifa de emissão.' };
    assert.equal((await api.put(`/api/aberturas/${id}/proposta`, proposta, tk.operacao)).status, 403);
    assert.equal((await api.put(`/api/aberturas/${id}/proposta`, { ...proposta, limite_mensal: '1.000,00' }, tk.financeiro)).status, 422, 'mensal menor que por boleto');
    const p = await api.put(`/api/aberturas/${id}/proposta`, proposta, tk.financeiro);
    assert.equal(p.status, 200, JSON.stringify(p.dados));
    assert.equal(p.dados.proposta.limite_boleto_centavos, 300000);
    assert.equal(p.dados.proposta.boletos_mes, 1500);
    assert.deepEqual(p.dados.pendencias, []);
    assert.ok(p.dados.interacoes.some((i) => i.tipo === 'ligacao'));
    assert.ok(p.dados.interacoes.some((i) => /Proposta definida/.test(i.texto)));
  });

  await t.test('operação não aprova; financeiro aprova e cria o cliente com a proposta e o acesso', async () => {
    assert.equal((await api.post(`/api/aberturas/${id}/aprovar`, {}, tk.operacao)).status, 403);
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
    assert.equal(c.limite_boleto_centavos, 300000);
    assert.equal(c.limite_mensal_centavos, 15000000);
    assert.equal(c.entrega, 'pix');
    const preco = api.db.prepare('SELECT * FROM precos WHERE cliente_id = ?').get(c.id);
    assert.equal(preco.tarifa_fixa_centavos, 199);
    assert.equal(preco.tarifa_emissao_centavos, 50);
    assert.equal(JSON.parse(preco.bolepix).tarifa_fixa_centavos, 249);
    assert.equal(JSON.parse(c.kyc_representantes)[0].documento, CPF);
    assert.equal(r.dados.acesso.email, 'financeiro@exemplo.com.br');
    assert.equal(r.dados.acesso.senha_provisoria, undefined, 'a equipe não recebe senha: o cliente cria pelo link');
    assert.match(r.dados.acesso.link, /\/ativar#t=[\w-]{40,}$/);
    assert.match(r.dados.protocolo, /^AB-\d{6}$/);
    assert.match(r.dados.conta, /\d/);
    ativacaoAprovada = r.dados.acesso.link.split('#t=')[1];
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
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM abertura_interacoes WHERE solicitacao_id = ?').get(idB).n, 0);
  });

  await t.test('ativação: o cliente cria a própria senha pelo link (acesso.payax.com.br)', async () => {
    const tok = ativacaoAprovada;
    const c = await api.post('/api/publico/ativacao/consultar', { token: tok });
    assert.equal(c.status, 200, JSON.stringify(c.dados));
    assert.match(c.dados.protocolo, /^AB-/);
    assert.equal(c.dados.codigo_usuario, 'financeiro@exemplo.com.br');
    assert.equal(c.dados.cnpj_mascarado, '11.***.***/****-81', 'o CNPJ inteiro não sai na consulta');
    assert.equal((await api.post('/api/publico/ativacao/consultar', { token: 'x'.repeat(43) })).status, 404);
    // CNPJ errado conta tentativa; senha fraca é recusada.
    const errado = await api.post('/api/publico/ativacao', { token: tok, cnpj: '19.131.243/0001-97', senha: 'SenhaForte2026' });
    assert.equal(errado.status, 422);
    assert.match(errado.dados.erro, /Restam 4/);
    assert.equal((await api.post('/api/publico/ativacao', { token: tok, cnpj: '11.222.333/0001-81', senha: 'curta1' })).status, 422);
    assert.equal((await api.post('/api/publico/ativacao', { token: tok, cnpj: '11.222.333/0001-81', senha: 'semnumeroaqui' })).status, 422);
    // Antes de ativar, nenhuma senha funciona.
    assert.equal((await api.post('/cliente/api/auth/login', { email: 'financeiro@exemplo.com.br', senha: 'Kp7m-Rx4t-Zq9w-Hs3d' })).status, 401);
    const ok = await api.post('/api/publico/ativacao', { token: tok, cnpj: '11.222.333/0001-81', senha: 'Kp7m-Rx4t-Zq9w-Hs3d' });
    assert.equal(ok.status, 200, JSON.stringify(ok.dados));
    assert.equal(ok.dados.codigo_usuario, 'financeiro@exemplo.com.br');
    const login = await api.post('/cliente/api/auth/login', { email: 'financeiro@exemplo.com.br', senha: 'Kp7m-Rx4t-Zq9w-Hs3d' });
    assert.equal(login.status, 200, JSON.stringify(login.dados));
    assert.equal(login.dados.usuario?.senha_provisoria ?? false, false, 'não pede troca: a senha já é do cliente');
    // Uso único; o token nunca é guardado em claro.
    assert.equal((await api.post('/api/publico/ativacao/consultar', { token: tok })).status, 410);
    assert.ok(!api.db.prepare('SELECT 1 FROM ativacoes_acesso WHERE token_hash = ?').get(tok));
    assert.ok(api.db.prepare("SELECT 1 FROM auditoria WHERE acao = 'acesso.ativado'").get());
    assert.ok(!JSON.stringify(api.db.prepare('SELECT * FROM auditoria').all()).includes(tok), 'o link não vai para a auditoria');
  });

  await t.test('novo link cancela o anterior; 5 CNPJs errados cancelam o link', async () => {
    const s = api.db.prepare("SELECT id FROM solicitacoes_abertura WHERE situacao = 'aprovada' LIMIT 1").get();
    const l1 = await api.post(`/api/aberturas/${s.id}/ativacao`, {}, tk.operacao);
    assert.equal(l1.status, 201, JSON.stringify(l1.dados));
    const l2 = await api.post(`/api/aberturas/${s.id}/ativacao`, {}, tk.operacao);
    const t1 = l1.dados.link.split('#t=')[1];
    const t2 = l2.dados.link.split('#t=')[1];
    assert.equal((await api.post('/api/publico/ativacao/consultar', { token: t1 })).status, 410);
    for (let i = 0; i < 4; i += 1) assert.equal((await api.post('/api/publico/ativacao', { token: t2, cnpj: '19131243000197', senha: 'OutraSenha123' })).status, 422);
    const ultimo = await api.post('/api/publico/ativacao', { token: t2, cnpj: '19131243000197', senha: 'OutraSenha123' });
    assert.equal(ultimo.status, 410);
    assert.equal((await api.post('/api/publico/ativacao/consultar', { token: t2 })).status, 410);
    // Pela ficha do cliente (aba Acessos) também sai o link.
    const u = api.db.prepare('SELECT id, cliente_id FROM usuarios_cliente WHERE email = ?').get('financeiro@exemplo.com.br');
    const l3 = await api.post(`/api/clientes/${u.cliente_id}/acessos/${u.id}/ativacao`, {}, tk.operacao);
    assert.equal(l3.status, 201);
    assert.equal((await api.post(`/api/clientes/${u.cliente_id}/acessos/${u.id}/ativacao`, {}, tk.consulta)).status, 403);
  });

  await t.test('contato pela equipe: prospecção, completar dados, anexar contrato', async () => {
    assert.equal((await api.post('/api/aberturas', { empresa: { cnpj: CNPJ.payax, razao_social: 'Gama Telecom' } }, tk.consulta)).status, 403);
    const c = await api.post('/api/aberturas', { empresa: { cnpj: CNPJ.payax, razao_social: 'Gama Telecom' },
      financeiro: { nome: 'Rui', email: 'rui@gama.com.br', telefone: '11966665555' }, observacao: 'Indicação do provedor Alfa.' }, tk.operacao);
    assert.equal(c.status, 201, JSON.stringify(c.dados));
    assert.equal(c.dados.situacao, 'prospeccao');
    assert.equal(c.dados.origem, 'equipe');
    assert.ok(c.dados.pendencias.some((x) => /Cadastro/.test(x)));
    assert.ok(c.dados.interacoes.some((i) => i.tipo === 'nota' && /Indicação/.test(i.texto)));
    const idC = c.dados.id;
    const e = await api.put(`/api/aberturas/${idC}/dados`, { ...pedido(), empresa: { ...pedido().empresa, cnpj: CNPJ.payax, razao_social: 'Gama Telecom Ltda' },
      destino: { ...pedido().destino, pix_chave: CNPJ.payax } }, tk.operacao);
    assert.equal(e.status, 200, JSON.stringify(e.dados));
    assert.equal(e.dados.razao_social, 'Gama Telecom Ltda');
    assert.ok(e.dados.pendencias.some((x) => /Contrato social/.test(x)));
    const a = await api.post(`/api/aberturas/${idC}/documentos`, { tipo: 'contrato_social', nome: 'contrato.pdf', conteudo: PDF }, tk.operacao);
    assert.equal(a.status, 201, JSON.stringify(a.dados));
    assert.ok(!a.dados.pendencias.some((x) => /Cadastro|Contrato social/.test(x)), JSON.stringify(a.dados.pendencias));
    const f = (await api.get('/api/aberturas/funil', tk.consulta)).status;
    assert.equal(f, 403);
    const funil = (await api.get('/api/aberturas/funil', tk.operacao)).dados;
    assert.ok(funil.itens.some((x) => x.id === idC && x.situacao === 'prospeccao'));
    assert.equal(funil.etapas[0].chave, 'prospeccao');
  });
});
