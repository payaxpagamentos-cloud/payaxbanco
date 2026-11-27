'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { iniciar } = require('./helpers');
const { abrir } = require('../server/db');
const relay = require('../server/lib/relay');
const epg = require('../server/lib/epg');
const { ErroNegocio } = require('../server/lib/erros');
const { hashSenha } = require('../server/lib/senha');

// Endereços públicos de mentira, em IP literal: assim a conferência não consulta DNS e o teste
// não depende de rede. Nada sai da máquina — `fetch` é trocado por um falso em cada teste.
const FORA = 'http://93.184.216.34';

/** Troca o `fetch` global por um falso durante `fn` e devolve os endereços que ele recebeu. */
async function comFetchFalso(responder, fn) {
  const original = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url, opcoes) => { pedidos.push(String(url)); return responder(String(url), opcoes); };
  try { await fn(pedidos); } finally { globalThis.fetch = original; }
  return pedidos;
}

const redireciona = (para, status = 302) => new Response(null, { status, headers: { location: para } });

test('redirecionamento para a rede interna é recusado antes de ser buscado', async () => {
  // O ataque: a origem (de terceiros) é pública e passa na conferência; a resposta dela manda o
  // servidor buscar dentro da rede do provedor. Com 'follow' isso passava direto.
  for (const interno of ['http://10.0.0.5/painel', 'http://127.0.0.1:3600/api/saude', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
    const pedidos = await comFetchFalso(
      (url) => (url.startsWith(FORA) ? redireciona(interno) : new Response('SEGREDO INTERNO')),
      async () => {
        await assert.rejects(relay.buscarSeguro(`${FORA}/lista.m3u8`), (e) => e instanceof ErroNegocio && e.status === 422,
          `redirecionar para ${interno} tinha de ser recusado`);
      },
    );
    // O ponto central: o endereço interno NUNCA foi pedido. Recusar depois de buscar não serve.
    assert.deepEqual(pedidos, [`${FORA}/lista.m3u8`], `${interno} não pode nem ser buscado`);
  }
});

test('redirecionamento entre endereços públicos continua funcionando', async () => {
  const pedidos = await comFetchFalso(
    (url) => (url === `${FORA}/a` ? redireciona('/b') : url === `${FORA}/b` ? redireciona('http://93.184.216.35/c', 307) : new Response('#EXTM3U')),
    async () => {
      const resp = await relay.buscarSeguro(`${FORA}/a`);
      assert.equal(resp.status, 200);
      assert.equal(await resp.text(), '#EXTM3U');
    },
  );
  // Destino relativo é resolvido contra o endereço do salto, como o navegador faz.
  assert.deepEqual(pedidos, [`${FORA}/a`, `${FORA}/b`, 'http://93.184.216.35/c']);
});

test('corrente de redirecionamentos tem fim', async () => {
  let n = 0;
  const pedidos = await comFetchFalso(() => redireciona(`${FORA}/volta${n += 1}`), async () => {
    await assert.rejects(relay.buscarSeguro(`${FORA}/inicio`), (e) => e instanceof ErroNegocio && e.status === 502);
  });
  assert.equal(pedidos.length, 6, 'o endereço inicial e mais cinco saltos, e para');
});

test('corpo maior que o teto é cortado, mesmo quando o tamanho declarado mente', async () => {
  // Tamanho declarado honesto e acima do teto: recusa sem ler nada.
  await assert.rejects(
    relay.lerCorpoLimitado(new Response('x'.repeat(50), { headers: { 'content-length': '5000' } }), 100),
    (e) => e instanceof ErroNegocio && e.status === 413,
  );
  // Sem tamanho declarado (ou mentindo para baixo): só se descobre lendo — e a leitura para no teto.
  let lidos = 0;
  const fluxo = new ReadableStream({
    pull(controle) {
      lidos += 1;
      // Fonte sem fim: se a leitura não parasse no teto, este teste nunca terminaria.
      controle.enqueue(new Uint8Array(64 * 1024));
    },
  });
  await assert.rejects(relay.lerCorpoLimitado(new Response(fluxo), 256 * 1024), (e) => e instanceof ErroNegocio && e.status === 413);
  assert.ok(lidos < 20, `parou de ler logo depois do teto (leu ${lidos} blocos)`);
  // Dentro do teto, devolve o conteúdo inteiro.
  assert.equal((await relay.lerCorpoLimitado(new Response('grade'), 100)).toString(), 'grade');
});

test('grade XMLTV: arquivo pequeno que abre enorme não derruba o servidor', async () => {
  const db = abrir(':memory:');
  // 8 MB de zeros cabem em poucos KB comprimidos: é a "bomba" em miniatura.
  const bomba = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024));
  assert.ok(bomba.length < 64 * 1024, 'a bomba chega pequena, é esse o truque');
  await comFetchFalso(() => new Response(bomba), async () => {
    await assert.rejects(
      epg.importarDeUrl(db, `${FORA}/grade.xml.gz`, { maxAbertoBytes: 1024 * 1024 }),
      (e) => e instanceof ErroNegocio && e.status === 413 && /descompactado/.test(e.message),
    );
  });
  // E o teto do download vale antes de qualquer descompressão.
  await comFetchFalso(() => new Response(Buffer.alloc(300 * 1024)), async () => {
    await assert.rejects(epg.importarDeUrl(db, `${FORA}/grade.xml`, { maxBytes: 100 * 1024 }), (e) => e.status === 413);
  });
  db.close();
});

test('PIN do perfil: cinco erros travam, e nem o PIN certo passa durante a trava', async (t) => {
  const s = await iniciar();
  t.after(() => s.fechar());
  const c = await s.assinante('pin@exemplo.com.br');
  // Põe PIN no perfil que a conta já tem (sem plano, ela só pode ter um).
  const id = c.perfilId;
  const posto = await s.patch(`/conta/perfis/${id}`, { pin: '4821' }, c.token);
  assert.equal(posto.status, 200, JSON.stringify(posto.dados));
  assert.equal(posto.dados.perfil.tem_pin, true);

  for (let i = 0; i < 5; i += 1) {
    const r = await s.post(`/conta/perfis/${id}/abrir`, { pin: String(1000 + i) }, c.token);
    assert.equal(r.status, 422, `erro ${i + 1} ainda é só "PIN incorreto"`);
  }
  // Sexta tentativa, com o PIN CERTO: tem de ser recusada. É isto que mata a força bruta — se o
  // acerto passasse durante a trava, bastava continuar tentando.
  const travado = await s.post(`/conta/perfis/${id}/abrir`, { pin: '4821' }, c.token);
  assert.equal(travado.status, 429);
  assert.match(travado.dados.erro, /minuto/);

  // A trava é do perfil, não da conta: outro perfil com PIN segue funcionando.
  // (Criado direto no banco: o limite de perfis do plano não é o que este teste confere.)
  const outroId = Number(s.db.prepare(`INSERT INTO perfis (usuario_id, nome, avatar, pin_hash, principal, criado_em)
    VALUES (?, 'Outro', 'gato', ?, 0, ?)`).run(c.usuario.id, hashSenha('7777'), new Date().toISOString()).lastInsertRowid);
  const abre = await s.post(`/conta/perfis/${outroId}/abrir`, { pin: '7777' }, c.token);
  assert.equal(abre.status, 200, JSON.stringify(abre.dados));
  assert.ok(abre.dados.chave);
});

test('trocar a senha derruba as outras sessões e mantém a de quem trocou', async (t) => {
  const s = await iniciar();
  t.after(() => s.fechar());
  const c = await s.assinante('sessoes@exemplo.com.br');
  // Um segundo aparelho na mesma conta — o que ficaria com o invasor.
  const outroAparelho = await s.login('sessoes@exemplo.com.br', 'senha12345');
  assert.equal((await s.get('/auth/me', outroAparelho)).status, 200);

  const troca = await s.post('/auth/senha', { atual: 'senha12345', nova: 'outra-senha-99' }, c.token);
  assert.equal(troca.status, 200);
  assert.ok(troca.dados.token, 'quem trocou recebe um token novo');

  assert.equal((await s.get('/auth/me', outroAparelho)).status, 401, 'o outro aparelho cai');
  assert.equal((await s.get('/auth/me', c.token)).status, 401, 'o token antigo de quem trocou também não vale mais');
  assert.equal((await s.get('/auth/me', troca.dados.token)).status, 200, 'o token novo vale');
  // E entrar de novo com a senha nova funciona normalmente.
  assert.equal((await s.get('/auth/me', await s.login('sessoes@exemplo.com.br', 'outra-senha-99'))).status, 200);
});

test('senha trocada pela operação derruba a sessão do assinante', async (t) => {
  const s = await iniciar();
  t.after(() => s.fechar());
  const admin = await s.adminLogin();
  const c = await s.assinante('suporte@exemplo.com.br');
  assert.equal((await s.get('/auth/me', c.token)).status, 200);

  const r = await s.patch(`/admin/assinantes/${c.usuario.id}`, { senha: 'senha-do-suporte-1' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  assert.equal((await s.get('/auth/me', c.token)).status, 401);
  // A sessão da operação, que é de outra conta, não é afetada.
  assert.equal((await s.get('/auth/me', admin)).status, 200);
});

test('SVG é servido em caixa de areia: aberto direto, não roda script nem enxerga a sessão', async (t) => {
  const s = await iniciar();
  t.after(() => s.fechar());
  const admin = await s.adminLogin();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
  const envio = await s.req('POST', '/admin/midias/imagem?nome=logo.svg', svg, admin, { headers: { 'Content-Type': 'image/svg+xml' } });
  assert.equal(envio.status, 201, JSON.stringify(envio.dados));

  const arte = await s.get(`/arte/${envio.dados.midia.id}`);
  assert.equal(arte.status, 200);
  assert.match(arte.headers.get('content-type'), /image\/svg\+xml/);
  const csp = arte.headers.get('content-security-policy');
  assert.match(csp, /sandbox/, 'sem sandbox, o SVG aberto numa aba roda na origem da plataforma');
  assert.match(csp, /default-src 'none'/);

  // Imagem comum não precisa disso e segue com a política normal das páginas.
  const png = await s.get(`/arte/${await s.enviarImagem(admin)}`);
  assert.doesNotMatch(png.headers.get('content-security-policy') ?? '', /sandbox/);
});

test('trocar o e-mail da conta pede a senha atual', async (t) => {
  const s = await iniciar();
  t.after(() => s.fechar());
  const c = await s.assinante('dono@exemplo.com.br');

  // O ataque: alguém com o aparelho logado troca o e-mail e o dono não entra mais.
  const semSenha = await s.patch('/auth/me', { email: 'invasor@exemplo.com.br' }, c.token);
  assert.equal(semSenha.status, 422);
  const errada = await s.patch('/auth/me', { email: 'invasor@exemplo.com.br', senha_atual: 'chute12345' }, c.token);
  assert.equal(errada.status, 422);
  assert.equal(s.db.prepare('SELECT email FROM usuarios WHERE id = ?').get(c.usuario.id).email, 'dono@exemplo.com.br');

  // Salvar nome e celular reenviando o MESMO e-mail (é o que a tela faz) não pede senha.
  const mesmo = await s.patch('/auth/me', { nome: 'Novo Nome', email: 'Dono@Exemplo.com.br' }, c.token);
  assert.equal(mesmo.status, 200, JSON.stringify(mesmo.dados));
  assert.equal(mesmo.dados.usuario.nome, 'Novo Nome');

  // Com a senha certa, troca.
  const certa = await s.patch('/auth/me', { email: 'novo@exemplo.com.br', senha_atual: 'senha12345' }, c.token);
  assert.equal(certa.status, 200);
  assert.equal(certa.dados.usuario.email, 'novo@exemplo.com.br');
});
