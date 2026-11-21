'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const portal = require('../server/lib/portal');
const { dataLocal } = require('../server/lib/datas');

const HOJE = dataLocal('America/Sao_Paulo');
const COMP = HOJE.slice(0, 7);

/** Dois assinantes com contrato e fatura, para o teste de isolamento ter de quem separar. */
async function cenario(api) {
  const admin = await api.login();
  const r = await api.post('/organizacao/usuarios', { nome: 'Fin', email: 'fin.portal@teste.local', senha: 'senha-teste-123', perfil: 'financeiro' }, admin);
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  const fin = await api.login('fin.portal@teste.local', 'senha-teste-123');
  const criar = async (caminho, corpo, tk = fin, esperado = 201) => {
    const resp = await api.post(caminho, corpo, tk);
    assert.equal(resp.status, esperado, `${caminho}: ${JSON.stringify(resp.dados)}`);
    return resp.dados;
  };
  const plano = await criar('/planos', { nome: 'Fibra 300', tipo: 'internet', tecnologia: 'fibra', download_mbps: 300, upload_mbps: 150, mensalidade: '99,90' });
  const conta = await criar('/cobrancas/contas', {
    nome: 'PIX', chave_pix: 'provedor@teste.com.br', chave_pix_tipo: 'email', emite_pix: true, emite_boleto: false, padrao: true,
    beneficiario_nome: 'Provedor Teste', beneficiario_documento: '11.222.333/0001-81', beneficiario_cidade: 'PERUIBE',
  }, admin);

  const pessoas = [];
  for (const [nome, documento] of [['Ana Portal', '390.533.447-05'], ['Bruno Portal', '528.713.260-37']]) {
    const a = await criar('/assinantes', { tipo: 'pf', nome, documento, telefone: '13999990000', email: `${nome.split(' ')[0].toLowerCase()}@exemplo.com` });
    const c = await criar('/contratos', { assinante_id: a.id, plano_id: plano.id, dia_vencimento: 10 });
    await criar(`/contratos/${c.id}/ativar`, { data: HOJE }, fin, 200);
    const f = await criar('/faturamento/faturas', { assinante_id: a.id, contrato_id: c.id, vencimento: `${COMP}-10`,
      itens: [{ descricao: 'Mensalidade', valor: '99,90' }] });
    pessoas.push({ assinante: a, contrato: c, fatura: f, documento });
  }
  return { admin, fin, criar, pessoas, conta };
}

/** Pega o convite e ativa, devolvendo o token do portal. */
async function entrarNoPortal(api, admin, pessoa, senha = 'senha-do-assinante') {
  const convite = (await api.post(`/assinantes/${pessoa.assinante.id}/portal/convite`, {}, admin)).dados;
  const r = await api.post('/portal/ativar', { documento: pessoa.documento, codigo: convite.codigo, senha });
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  return { token: r.dados.token, convite };
}

test('portal: primeiro acesso por convite, e nada de autocadastro', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const c = await cenario(api);
  const ana = c.pessoas[0];

  await t.test('sem convite, ninguém cria acesso só sabendo o CPF', async () => {
    const r = await api.post('/portal/ativar', { documento: ana.documento, codigo: 'ABCD2345', senha: 'qualquer-senha' });
    assert.equal(r.status, 401);
    assert.match(r.dados.erro, /Código inválido/i);
  });

  await t.test('entrar antes de ativar falha com a MESMA mensagem de senha errada', async () => {
    const semConta = await api.post('/portal/entrar', { documento: ana.documento, senha: 'tentativa' });
    const inexistente = await api.post('/portal/entrar', { documento: '111.444.777-35', senha: 'tentativa' });
    assert.equal(semConta.status, 401);
    assert.equal(inexistente.status, 401);
    assert.equal(semConta.dados.erro, inexistente.dados.erro,
      'mensagem igual para CPF inexistente e senha errada: a tela não pode virar verificador de quem é cliente');
  });

  let convite;
  await t.test('o código aparece UMA vez e fica em hash no banco', async () => {
    const r = await api.post(`/assinantes/${ana.assinante.id}/portal/convite`, {}, c.admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    convite = r.dados;
    assert.match(convite.codigo, /^[A-Z0-9]{8}$/);
    assert.ok(!/[IO01]/.test(convite.codigo), 'sem I, O, 0 e 1: o código é ditado por telefone');
    const linha = api.db.prepare('SELECT codigo_hash FROM assinante_convites WHERE id = ?').get(convite.id);
    assert.notEqual(linha.codigo_hash, convite.codigo);
    assert.equal(linha.codigo_hash.length, 64, 'guardado como sha256');
  });

  await t.test('a auditoria registra que o convite foi gerado, mas NÃO o código', async () => {
    const a = (await api.get('/organizacao/auditoria?acao=portal_convite_gerado', c.admin)).dados.itens[0];
    assert.ok(a, 'o fato ficou registrado');
    assert.ok(!JSON.stringify(a).includes(convite.codigo), 'o código não está na auditoria');
  });

  await t.test('ativa com o código e entra', async () => {
    const r = await api.post('/portal/ativar', { documento: ana.documento, codigo: convite.codigo, senha: 'senha-do-assinante' });
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.ok(r.dados.token);
    assert.equal(r.dados.nome, 'Ana Portal');
    assert.equal(r.dados.primeiro_acesso, true);
  });

  await t.test('o mesmo código NÃO serve duas vezes', async () => {
    const r = await api.post('/portal/ativar', { documento: ana.documento, codigo: convite.codigo, senha: 'outra-senha-123' });
    assert.equal(r.status, 401);
  });

  await t.test('gerar um convite novo cancela o anterior', async () => {
    const primeiro = (await api.post(`/assinantes/${ana.assinante.id}/portal/convite`, { motivo: 'redefinir' }, c.admin)).dados;
    const segundo = (await api.post(`/assinantes/${ana.assinante.id}/portal/convite`, { motivo: 'redefinir' }, c.admin)).dados;
    assert.notEqual(primeiro.codigo, segundo.codigo);
    assert.equal((await api.post('/portal/ativar', { documento: ana.documento, codigo: primeiro.codigo, senha: 'nova-senha-123' })).status, 401,
      'dois códigos vivos dobrariam a janela de ataque');
    assert.equal((await api.post('/portal/ativar', { documento: ana.documento, codigo: segundo.codigo, senha: 'senha-do-assinante' })).status, 201);
  });

  await t.test('convite expirado não vale', async () => {
    const r = (await api.post(`/assinantes/${ana.assinante.id}/portal/convite`, {}, c.admin)).dados;
    api.db.prepare('UPDATE assinante_convites SET expira_em = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', r.id);
    assert.equal((await api.post('/portal/ativar', { documento: ana.documento, codigo: r.codigo, senha: 'x1234567' })).status, 401);
  });

  await t.test('a senha do assinante fica em hash, nunca em claro', () => {
    const acesso = api.db.prepare('SELECT senha_hash FROM assinante_acessos WHERE assinante_id = ?').get(ana.assinante.id);
    assert.ok(acesso.senha_hash);
    assert.ok(!acesso.senha_hash.includes('senha-do-assinante'));
  });
});

test('portal: UM ASSINANTE NÃO ALCANÇA OS DADOS DE OUTRO', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const c = await cenario(api);
  const [ana, bruno] = c.pessoas;
  const { token: tkAna } = await entrarNoPortal(api, c.admin, ana);
  const { token: tkBruno } = await entrarNoPortal(api, c.admin, bruno, 'senha-do-bruno');

  await t.test('cada um vê só as próprias faturas', async () => {
    const dAna = (await api.get('/portal/faturas', tkAna)).dados;
    const dBruno = (await api.get('/portal/faturas', tkBruno)).dados;
    assert.equal(dAna.length, 1);
    assert.equal(dBruno.length, 1);
    assert.equal(dAna[0].numero, ana.fatura.numero);
    assert.equal(dBruno[0].numero, bruno.fatura.numero);
    assert.notEqual(dAna[0].numero, dBruno[0].numero);
  });

  await t.test('TROCAR O NÚMERO NA URL NÃO ABRE A FATURA DO VIZINHO', async () => {
    const r = await api.post(`/portal/faturas/${bruno.fatura.id}/segunda-via`, {}, tkAna);
    assert.equal(r.status, 404, 'a fatura do Bruno não existe para a Ana');
    const ok = await api.post(`/portal/faturas/${ana.fatura.id}/segunda-via`, {}, tkAna);
    assert.equal(ok.status, 200, 'a dela, sim');
  });

  await t.test('o "me" devolve o assinante do token, e o corpo do pedido não muda isso', async () => {
    const r = await api.post('/portal/senha', { assinante_id: bruno.assinante.id, atual: 'errada', nova: 'x1234567' }, tkAna);
    assert.equal(r.status, 422, 'o id no corpo é ignorado: a senha conferida é a da Ana');
    const me = (await api.get('/portal/me', tkAna)).dados;
    assert.equal(me.assinante.nome, 'Ana Portal');
  });

  await t.test('cada um vê só os próprios chamados', async () => {
    await api.post('/portal/chamados', { descricao: 'Internet caindo à noite' }, tkAna);
    const dAna = (await api.get('/portal/chamados', tkAna)).dados;
    const dBruno = (await api.get('/portal/chamados', tkBruno)).dados;
    assert.equal(dAna.length, 1);
    assert.equal(dBruno.length, 0, 'o chamado da Ana não aparece para o Bruno');
    assert.equal(dAna[0].origem, 'portal', 'a equipe vê que veio do assinante, sem triagem');
  });
});

test('portal: o token do portal e o da equipe não se misturam', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const c = await cenario(api);
  const { token: tkPortal } = await entrarNoPortal(api, c.admin, c.pessoas[0]);

  await t.test('TOKEN DO ASSINANTE NÃO ABRE NADA DO SISTEMA', async () => {
    for (const rota of ['/assinantes', '/faturamento/faturas', '/contabil/plano', '/panorama/pontos', '/organizacao/auditoria', '/certificado']) {
      const r = await api.get(rota, tkPortal);
      assert.equal(r.status, 401, `${rota} aceitou um token de assinante`);
    }
  });

  await t.test('TOKEN DA EQUIPE NÃO ABRE O PORTAL', async () => {
    for (const rota of ['/portal/me', '/portal/faturas', '/portal/chamados']) {
      const r = await api.get(rota, c.admin);
      assert.equal(r.status, 401, `${rota} aceitou um token da equipe`);
    }
  });

  await t.test('token adulterado é recusado', async () => {
    const partes = tkPortal.split('.');
    const corpo = JSON.parse(Buffer.from(partes[0], 'base64url').toString());
    corpo.sub = c.pessoas[1].assinante.id;
    const forjado = `${Buffer.from(JSON.stringify(corpo)).toString('base64url')}.${partes[1]}`;
    assert.equal((await api.get('/portal/me', forjado)).status, 401, 'trocar o assinante no token invalida a assinatura');
    assert.equal((await api.get('/portal/me', `${partes[0]}.xxxx`)).status, 401);
  });

  await t.test('token expirado é recusado', () => {
    const vencido = portal.emitirToken({ assinante_id: 1, organizacao_id: 1 });
    const [corpo] = vencido.split('.');
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    assert.ok(dados.exp > Date.now() / 1000, 'nasce válido');
    assert.equal(dados.aud, 'portal');
    // Um token com validade no passado não passa, mesmo assinado por nós.
    assert.equal(portal.lerToken(vencido.replace(corpo, Buffer.from(JSON.stringify({ ...dados, exp: 1 })).toString('base64url'))), null);
  });
});

test('portal: bloqueio por tentativas', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const c = await cenario(api);
  const ana = c.pessoas[0];
  await entrarNoPortal(api, c.admin, ana);

  await t.test('CPF é usuário conhecido: errar a senha seguidamente bloqueia', async () => {
    let ultima;
    for (let i = 0; i < portal.MAX_TENTATIVAS; i++) {
      ultima = await api.post('/portal/entrar', { documento: ana.documento, senha: `errada-${i}` });
      assert.equal(ultima.status, 401);
    }
    const bloqueada = await api.post('/portal/entrar', { documento: ana.documento, senha: 'senha-do-assinante' });
    assert.equal(bloqueada.status, 429, 'nem com a senha certa entra durante o bloqueio');
    assert.match(bloqueada.dados.erro, /Muitas tentativas/i);
    assert.match(bloqueada.dados.erro, /minuto/i, 'diz quanto tempo falta, para não gerar ligação ao suporte');
  });

  await t.test('passado o bloqueio, a senha certa entra e o contador zera', async () => {
    api.db.prepare('UPDATE assinante_acessos SET bloqueado_ate = NULL WHERE assinante_id = ?').run(ana.assinante.id);
    const r = await api.post('/portal/entrar', { documento: ana.documento, senha: 'senha-do-assinante' });
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(api.db.prepare('SELECT tentativas FROM assinante_acessos WHERE assinante_id = ?').get(ana.assinante.id).tentativas, 0);
  });

  await t.test('a ficha do assinante mostra o acesso sem nunca mostrar o código', async () => {
    const f = (await api.get(`/assinantes/${ana.assinante.id}`, c.admin)).dados;
    assert.equal(f.portal.tem_acesso, true, 'a aba Cadastro precisa disso sem uma segunda chamada');
    assert.equal(f.portal.ativo, true);
    assert.ok(f.portal.ultimo_acesso, 'quem atende precisa saber se o cliente já usou o portal');
    // O convite só existe em claro no instante em que é gerado: nem a ficha nem a situação o devolvem.
    assert.ok(!JSON.stringify(f.portal).includes('codigo'));
    const nova = (await api.post(`/assinantes/${ana.assinante.id}/portal/convite`, { motivo: 'redefinir' }, c.admin)).dados;
    const depois = (await api.get(`/assinantes/${ana.assinante.id}`, c.admin)).dados;
    assert.ok(depois.portal.convite_aberto, 'a ficha avisa que há um convite em aberto');
    assert.ok(!JSON.stringify(depois.portal).includes(nova.codigo), 'o código gerado não volta em consulta nenhuma');
  });

  await t.test('a equipe desativa o acesso, e o assinante para de entrar', async () => {
    const d = await api.req('DELETE', `/assinantes/${ana.assinante.id}/portal`, {}, c.admin);
    assert.equal(d.status, 200);
    assert.equal((await api.post('/portal/entrar', { documento: ana.documento, senha: 'senha-do-assinante' })).status, 401);
    const situacao = (await api.get(`/assinantes/${ana.assinante.id}/portal`, c.admin)).dados;
    assert.equal(situacao.ativo, false);
    assert.equal(situacao.convite_aberto, null, 'convites em aberto foram cancelados junto');
  });
});

test('portal: o que o assinante vê e faz', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const c = await cenario(api);
  const ana = c.pessoas[0];
  const { token } = await entrarNoPortal(api, c.admin, ana);

  await t.test('a tela inicial traz contrato, plano e o que está em aberto', async () => {
    const d = (await api.get('/portal/me', token)).dados;
    assert.equal(d.assinante.nome, 'Ana Portal');
    assert.equal(d.contratos.length, 1);
    assert.equal(d.contratos[0].plano, 'Fibra 300');
    assert.equal(d.contratos[0].download_mbps, 300);
    assert.equal(d.em_aberto.faturas, 1);
    assert.equal(d.em_aberto.valor_centavos, 9990);
  });

  await t.test('o estado do serviço é honesto E em linguagem de cliente', async () => {
    const d = (await api.get('/portal/me', token)).dados;
    const c2 = d.contratos[0].conexao;
    // Nada foi lido no equipamento: o portal NÃO pode dizer "está no ar" por otimismo.
    assert.equal(c2.situacao, 'nao_confirmado');
    assert.match(c2.titulo, /não conseguimos confirmar/i);
    assert.match(c2.detalhe, /não quer dizer que o serviço esteja fora/i, 'e também não alarma sem motivo');
    // Nenhum jargão interno chega ao cliente, mas o suporte consegue casar as duas visões.
    assert.equal(c2.interno, 'sem_servico');
    for (const texto of [c2.titulo, c2.detalhe]) {
      assert.ok(!/provisionad|concentrador|login/i.test(texto), `jargão interno vazou para o cliente: "${texto}"`);
    }
  });

  await t.test('segunda via emite o PIX da PRÓPRIA fatura e repete o mesmo depois', async () => {
    const r = (await api.post(`/portal/faturas/${ana.fatura.id}/segunda-via`, {}, token)).dados;
    assert.ok(r.pix.brcode.startsWith('0002'), 'é um BR Code de verdade');
    assert.equal(r.pix.valor_centavos, 9990);
    const denovo = (await api.post(`/portal/faturas/${ana.fatura.id}/segunda-via`, {}, token)).dados;
    assert.equal(denovo.pix.txid, r.pix.txid, 'não gera uma cobrança nova a cada clique');
  });

  await t.test('fatura paga não gera segunda via', async () => {
    await api.post(`/faturamento/faturas/${ana.fatura.id}/pagamentos`, { valor: '99,90', forma: 'pix', data: HOJE }, c.fin);
    const r = await api.post(`/portal/faturas/${ana.fatura.id}/segunda-via`, {}, token);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /já está paga/i);
  });

  await t.test('o assinante atualiza o próprio contato, mas não o endereço', async () => {
    const r = await api.patch('/portal/contato', { email: 'ana.nova@exemplo.com', telefone: '13988887777' }, token);
    assert.equal(r.status, 200);
    assert.equal(api.db.prepare('SELECT email FROM assinantes WHERE id = ?').get(ana.assinante.id).email, 'ana.nova@exemplo.com');
    // Endereço não entra: mudar o ponto de atendimento é visita técnica, não edição de cadastro.
    const antes = api.db.prepare('SELECT logradouro FROM assinantes WHERE id = ?').get(ana.assinante.id).logradouro;
    await api.patch('/portal/contato', { logradouro: 'Rua Inventada', email: 'ana.nova@exemplo.com' }, token);
    assert.equal(api.db.prepare('SELECT logradouro FROM assinantes WHERE id = ?').get(ana.assinante.id).logradouro, antes);
  });

  await t.test('troca a própria senha, exigindo a atual', async () => {
    assert.equal((await api.post('/portal/senha', { atual: 'chute', nova: 'nova-senha-forte' }, token)).status, 422);
    assert.equal((await api.post('/portal/senha', { atual: 'senha-do-assinante', nova: 'nova-senha-forte' }, token)).status, 204);
    assert.equal((await api.post('/portal/entrar', { documento: ana.documento, senha: 'nova-senha-forte' })).status, 200);
  });
});
